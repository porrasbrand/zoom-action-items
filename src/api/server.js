#!/usr/bin/env node
/**
 * Zoom Dashboard API Server
 * Express server serving meeting data from SQLite.
 */

import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import dotenv from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '..', '.env') });

import routes from './routes.js';
import { createWebhookHandler } from './webhook-handler.js';

const PORT = process.env.DASHBOARD_PORT || 3875;
const BASE_PATH = '/zoom';

const app = express();

// Middleware
app.use(express.json());

// CORS headers for development
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
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

// Mount API routes at /zoom/api/

// Zoom webhook endpoint
const webhookHandler = createWebhookHandler({
  secretToken: process.env.ZOOM_WEBHOOK_SECRET,
  onRecordingCompleted: async ({ meetingId, topic }) => {
    console.log("[Webhook] Triggering pipeline for:", topic);
    try {
      const { pollOnce } = await import("../poll.js");
      await pollOnce();
      console.log("[Webhook] Pipeline run complete");
    } catch (err) {
      console.error("[Webhook] Pipeline error:", err.message);
    }
  }
});
app.post(BASE_PATH + "/webhook", webhookHandler);
app.use(`${BASE_PATH}/api`, routes);

// Serve static files from public/ at /zoom/
const publicPath = join(__dirname, '..', '..', 'public');
app.use(BASE_PATH, express.static(publicPath));

// SPA fallback - serve index.html for all non-API /zoom routes
// Express 5 uses different path syntax, use regex instead
app.get(/^\/zoom(?:\/.*)?$/, (req, res, next) => {
  // Skip if this is an API route
  if (req.path.startsWith('/zoom/api')) {
    return next();
  }
  res.sendFile(join(publicPath, 'index.html'));
});

// Root redirect to /zoom/
app.get('/', (req, res) => {
  res.redirect(BASE_PATH + '/');
});

// Health check at root level
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'zoom-dashboard' });
});

// Start server
app.listen(PORT, () => {
  console.log(`[${new Date().toISOString()}] Zoom Dashboard API running on port ${PORT}`);
  console.log(`  Local:    http://localhost:${PORT}${BASE_PATH}/`);
  console.log(`  API:      http://localhost:${PORT}${BASE_PATH}/api/`);
  console.log(`  Health:   http://localhost:${PORT}${BASE_PATH}/api/health`);
});
