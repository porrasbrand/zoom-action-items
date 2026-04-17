#!/usr/bin/env node
/**
 * Zoom Dashboard API Server
 * Express server serving meeting data from SQLite.
 * Now with Google OAuth authentication.
 */

import express from 'express';
import cookieParser from 'cookie-parser';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '..', '.env') });

import routes from './routes.js';
import { createWebhookHandler } from './webhook-handler.js';
import { runMigrations } from './db-queries.js';
import {
  runAuthMigrations,
  getGoogleAuthURL,
  getGoogleTokens,
  getGoogleUser,
  isEmailWhitelisted,
  updateLastLogin,
  createSession,
  validateSession,
  deleteSession,
  authMiddleware,
  apiAuthMiddleware
} from '../lib/auth.js';

import { getPendingPushItems, updatePushQueueSuccess, updatePushQueueFailed, getActionItemById } from './db-queries.js';
import * as proofhub from '../lib/proofhub-client.js';
import { resolvePersonSync as resolvePerson } from '../lib/people-resolver.js';

// Run DB migrations on startup
runMigrations();
runAuthMigrations();

// Auto-retry pending pushes from push_queue
async function retryPendingPushes() {
  try {
    const pending = getPendingPushItems();
    console.log(`[Startup] Found ${pending.length} pending push items in queue`);

    const hour = new Date().getUTCHours();
    if (hour >= 13 && hour <= 23) {
      console.log('[Startup] Warning: running during business hours (13:00-23:00 UTC)');
    }

    if (pending.length === 0) return;

    if (!proofhub.isProofhubConfigured()) {
      console.log('[Startup] ProofHub not configured, skipping push retries');
      return;
    }

    for (const queueItem of pending) {
      try {
        console.log(`[Startup Retry] Pushing item ${queueItem.action_item_id}: ${queueItem.item_title}`);

        const item = getActionItemById(queueItem.action_item_id);
        if (!item) {
          console.log(`[Startup Retry] Item ${queueItem.action_item_id} not found, skipping`);
          updatePushQueueFailed(queueItem.action_item_id, 'Action item not found');
          continue;
        }

        // Skip if already pushed
        if (item.ph_task_id) {
          console.log(`[Startup Retry] Item ${queueItem.action_item_id} already pushed, marking complete`);
          updatePushQueueSuccess(queueItem.action_item_id);
          continue;
        }

        // Resolve assignee
        let assigneeId = null;
        if (item.owner_name) {
          const resolved = resolvePerson(item.owner_name);
          if (resolved?.ph_id) assigneeId = resolved.ph_id;
        }

        const taskData = {
          title: item.title,
          description: (item.description || '').replace(/\n/g, '<br>')
        };
        if (assigneeId) taskData.assigned = [parseInt(assigneeId)];
        if (item.due_date) taskData.due_date = item.due_date.slice(0, 10);

        const task = await proofhub.createTask(queueItem.ph_project_id, queueItem.ph_task_list_id, taskData);
        console.log(`[Startup Retry] Success for item ${queueItem.action_item_id}, ph_task_id: ${task.id}`);
        updatePushQueueSuccess(queueItem.action_item_id);

        // Update action item record
        const { updateActionItem, setPushedAt } = await import('./db-queries.js');
        updateActionItem(queueItem.action_item_id, {
          ph_task_id: task.id.toString(),
          ph_project_id: queueItem.ph_project_id,
          ph_task_list_id: queueItem.ph_task_list_id || null,
          ph_assignee_id: assigneeId?.toString() || null,
          status: 'pushed'
        });
        setPushedAt(queueItem.action_item_id);
      } catch (err) {
        console.error(`[Startup Retry] FAILED for item ${queueItem.action_item_id}:`, err.message);
        updatePushQueueFailed(queueItem.action_item_id, err.message);
      }
    }
  } catch (err) {
    console.error('[Startup] Push queue retry error:', err.message);
  }
}

// Run retry after migrations complete
retryPendingPushes();

const PORT = process.env.DASHBOARD_PORT || 3875;
const BASE_PATH = '/zoom';

const app = express();

// Middleware
app.use(express.json());
app.use(cookieParser());

// CORS headers for development
app.use((req, res, next) => {
  const origin = req.headers.origin; const allowedOrigins = ['https://www.breakthrough3x.com', 'https://breakthrough3x.com', 'https://www.manuelporras.com']; if (allowedOrigins.includes(origin)) { res.header('Access-Control-Allow-Origin', origin); res.header('Access-Control-Allow-Credentials', 'true'); } else { res.header('Access-Control-Allow-Origin', '*'); }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// Cache-Control for API responses
app.use(`${BASE_PATH}/api`, (req, res, next) => {
  res.header('Cache-Control', 'no-store');
  next();
});

const publicPath = join(__dirname, '..', '..', 'public');

// ============ PUBLIC ROUTES (no auth) ============

// Zoom webhook endpoint - must be unauthenticated
const webhookHandler = createWebhookHandler({
  secretToken: process.env.ZOOM_WEBHOOK_SECRET,
  onRecordingCompleted: async ({ meetingId, topic }) => {
    console.log("[Webhook] Triggering pipeline for:", topic);
    try {
      const { pollOnce } = await import("../poll.js");
      await pollOnce();
      console.log("[Webhook] Pipeline run complete");
      // Backfill any gaps (catches eval/summary failures)
      try {
        const { runBackfill } = await import('../lib/pipeline-backfill.js');
        await runBackfill('data/zoom-action-items.db', { maxEvals: 5, quiet: false });
        console.log("[Webhook] Backfill complete");
      } catch (bfErr) {
        console.error("[Webhook] Backfill error:", bfErr.message);
      }
    } catch (err) {
      console.error("[Webhook] Pipeline error:", err.message);
    }
  }
});
app.post(BASE_PATH + "/webhook", webhookHandler);

// Login page
app.get(BASE_PATH + '/login', (req, res) => {
  res.sendFile(join(publicPath, 'login.html'));
});

// Start Google OAuth flow
app.get(BASE_PATH + '/auth/google', (req, res) => {
  const returnTo = req.query.return_to || '';
  const authUrl = getGoogleAuthURL();
  // Store return_to in a cookie so callback can read it
  if (returnTo) res.cookie('zoom_return_to', returnTo, { maxAge: 300000, path: '/zoom', sameSite: 'none', secure: true });
  res.redirect(authUrl);
});

// Google OAuth callback
app.get(BASE_PATH + '/auth/callback', async (req, res) => {
  try {
    const { code, error } = req.query;

    if (error) {
      console.error('[Auth] OAuth error:', error);
      return res.redirect(BASE_PATH + '/login?error=oauth_failed');
    }

    if (!code) {
      return res.redirect(BASE_PATH + '/login?error=no_code');
    }

    // Exchange code for tokens
    const tokens = await getGoogleTokens(code);

    // Get user info
    const googleUser = await getGoogleUser(tokens.access_token);
    const email = googleUser.email.toLowerCase();
    const name = googleUser.name || googleUser.email;

    console.log(`[Auth] Login attempt: ${email}`);

    // Check whitelist
    const user = isEmailWhitelisted(email);

    if (!user) {
      console.log(`[Auth] Access denied for: ${email}`);
      return res.redirect(BASE_PATH + `/login?error=access_denied&email=${encodeURIComponent(email)}`);
    }

    // Update last login
    updateLastLogin(user.id);

    // Create session
    const sessionId = createSession(user.id, email, name);

    // Set cookie
    res.cookie('zoom_session', sessionId, {
      httpOnly: true,
      secure: true, // was: process.env.NODE_ENV === 'production' || req.secure,
      sameSite: 'none',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
      path: '/zoom'
    });

    console.log(`[Auth] Login successful: ${email}`);

    // Redirect to return_to or dashboard
    const returnTo = req.cookies?.zoom_return_to;
    if (returnTo) res.clearCookie('zoom_return_to', { path: '/zoom' });
    const redirectUrl = (returnTo && returnTo.startsWith('https://')) ? returnTo : BASE_PATH + '/';
    res.redirect(redirectUrl);
  } catch (err) {
    console.error('[Auth] Callback error:', err);
    res.redirect(BASE_PATH + '/login?error=callback_failed');
  }
});

// Logout
app.get(BASE_PATH + '/auth/logout', (req, res) => {
  const sessionId = req.cookies?.zoom_session;

  if (sessionId) {
    deleteSession(sessionId);
  }

  res.clearCookie('zoom_session', { path: '/zoom' });
  res.redirect(BASE_PATH + '/login');
});

// Health check (unauthenticated)
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'zoom-dashboard' });
});

app.get(BASE_PATH + '/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'zoom-dashboard' });
});

// ============ PROTECTED ROUTES (require auth) ============

// Get current user info (for frontend header)
app.get(BASE_PATH + '/api/auth/me', apiAuthMiddleware, (req, res) => {
  res.json({
    authenticated: true,
    user: req.user
  });
});

// Apply auth middleware to all other API routes
app.use(`${BASE_PATH}/api`, apiAuthMiddleware);

// Mount API routes
app.use(`${BASE_PATH}/api`, routes);

// Serve static files (CSS, JS, images) without auth for login page to work
// index: false prevents auto-serving index.html, letting authMiddleware handle /zoom/
app.use(BASE_PATH, express.static(publicPath, { index: false }));

// Protected dashboard routes - require auth for index.html
app.get(BASE_PATH + '/', authMiddleware, (req, res) => {
  res.sendFile(join(publicPath, 'index.html'));
});

// SPA fallback - serve index.html for all non-API /zoom routes (protected)
app.get(/^\/zoom(?:\/.*)?$/, (req, res, next) => {
  // Skip if this is a public route
  if (req.path === '/zoom/login' ||
      req.path.startsWith('/zoom/auth/') ||
      req.path.startsWith('/zoom/api/')) {
    return next();
  }

  // Apply auth middleware
  authMiddleware(req, res, () => {
    res.sendFile(join(publicPath, 'index.html'));
  });
});

// Root redirect to /zoom/
app.get('/', (req, res) => {
  res.redirect(BASE_PATH + '/');
});

// Start server
// Preload PH people cache
import { refreshPeopleCache } from '../lib/people-resolver.js';
refreshPeopleCache().catch(e => console.warn('[Startup] People cache preload:', e.message));

app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] Zoom Dashboard API running on port ${PORT}`);
  console.log(`  Local:    http://localhost:${PORT}${BASE_PATH}/`);
  console.log(`  API:      http://localhost:${PORT}${BASE_PATH}/api/`);
  console.log(`  Login:    http://localhost:${PORT}${BASE_PATH}/login`);
  console.log(`  Health:   http://localhost:${PORT}${BASE_PATH}/api/health`);
});
