/**
 * Google OAuth2 Authentication
 * Simple raw flow without passport - just redirect/callback/token exchange
 */

import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import crypto from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', '..', 'data', 'zoom-action-items.db');

let db = null;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH, { readonly: false });
    db.pragma('journal_mode = WAL');
  }
  return db;
}

// Run auth migrations
export function runAuthMigrations() {
  const d = getDb();

  // Create auth_users table
  d.exec(`
    CREATE TABLE IF NOT EXISTS auth_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      name TEXT,
      role TEXT DEFAULT 'user',
      created_at TEXT DEFAULT (datetime('now')),
      last_login TEXT
    )
  `);

  // Create auth_sessions table
  d.exec(`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      sid TEXT PRIMARY KEY,
      user_id INTEGER REFERENCES auth_users(id),
      email TEXT,
      name TEXT,
      expires_at TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Create api_tokens table for token-based auth
  d.exec(`
    CREATE TABLE IF NOT EXISTS api_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT UNIQUE NOT NULL,
      name TEXT,
      email TEXT NOT NULL,
      role TEXT DEFAULT 'user',
      created_at TEXT DEFAULT (datetime('now')),
      expires_at TEXT
    )
  `);

  // Insert initial whitelist (ignore if exists)
  const insertUser = d.prepare(`
    INSERT OR IGNORE INTO auth_users (email, name, role) VALUES (?, ?, ?)
  `);

  insertUser.run('phil@breakthrough3x.com', 'Phil Mutrie', 'admin');
  insertUser.run('manuel@breakthrough3x.com', 'Manuel Porras', 'admin');
  insertUser.run('richard@breakthrough3x.com', 'Richard Bonn', 'user');

  console.log('[Auth] Database migrations complete');
}

// OAuth configuration - getter function to access env vars after they're loaded
function getOAuthConfig() {
  return {
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    redirectUri: process.env.GOOGLE_OAUTH_REDIRECT_URI || 'https://www.manuelporras.com/zoom/auth/callback',
    scopes: ['email', 'profile']
  };
}

/**
 * Generate Google OAuth consent URL
 */
export function getGoogleAuthURL(redirectUri = null) {
  const config = getOAuthConfig();
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: redirectUri || config.redirectUri,
    response_type: 'code',
    scope: config.scopes.join(' '),
    access_type: 'offline',
    prompt: 'select_account'
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

/**
 * Exchange authorization code for tokens
 */
export async function getGoogleTokens(code, redirectUri = null) {
  const config = getOAuthConfig();
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: redirectUri || config.redirectUri,
      grant_type: 'authorization_code'
    })
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token exchange failed: ${error}`);
  }

  return response.json();
}

/**
 * Get user info from Google
 */
export async function getGoogleUser(accessToken) {
  const response = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` }
  });

  if (!response.ok) {
    throw new Error('Failed to get user info');
  }

  return response.json();
}

/**
 * Check if email is in whitelist
 */
export function isEmailWhitelisted(email) {
  const d = getDb();
  const normalizedEmail = email.toLowerCase();
  const user = d.prepare('SELECT * FROM auth_users WHERE email = ?').get(normalizedEmail);
  if (user) return user;

  // Auto-allow any @breakthrough3x.com email
  if (normalizedEmail.endsWith('@breakthrough3x.com')) {
    const namePart = normalizedEmail.split('@')[0].replace(/[._]/g, ' ');
    const name = namePart.charAt(0).toUpperCase() + namePart.slice(1);
    d.prepare('INSERT OR IGNORE INTO auth_users (email, name, role) VALUES (?, ?, ?)').run(normalizedEmail, name, 'user');
    return d.prepare('SELECT * FROM auth_users WHERE email = ?').get(normalizedEmail);
  }

  return null;
}

/**
 * Update last login time
 */
export function updateLastLogin(userId) {
  const d = getDb();
  d.prepare("UPDATE auth_users SET last_login = datetime('now') WHERE id = ?").run(userId);
}

/**
 * Create a new session
 */
export function createSession(userId, email, name) {
  const d = getDb();
  const sid = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(); // 7 days

  d.prepare(`
    INSERT INTO auth_sessions (sid, user_id, email, name, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(sid, userId, email, name, expiresAt);

  return sid;
}

/**
 * Validate session and return user if valid
 */
export function validateSession(sessionId) {
  if (!sessionId) return null;

  const d = getDb();
  const session = d.prepare(`
    SELECT s.*, u.role
    FROM auth_sessions s
    JOIN auth_users u ON s.user_id = u.id
    WHERE s.sid = ? AND s.expires_at > datetime('now')
  `).get(sessionId);

  if (!session) {
    // Debug: check if session exists but is expired
    const expired = d.prepare('SELECT sid, expires_at FROM auth_sessions WHERE sid = ?').get(sessionId);
    if (expired) {
      console.log('[Auth] Session expired for sid:', sessionId?.substring(0, 8), '- expired at:', expired.expires_at);
    } else {
      console.log('[Auth] Session not found for sid:', sessionId?.substring(0, 8));
    }
    return null;
  }

  // Sliding window: extend session by 7 days on each valid use
  const newExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
  d.prepare('UPDATE auth_sessions SET expires_at = ? WHERE sid = ?').run(newExpiry, sessionId);

  return session;
}

/**
 * Delete session
 */
export function deleteSession(sessionId) {
  const d = getDb();
  d.prepare('DELETE FROM auth_sessions WHERE sid = ?').run(sessionId);
}

/**
 * Clean up expired sessions
 */
export function cleanExpiredSessions() {
  const d = getDb();
  const result = d.prepare("DELETE FROM auth_sessions WHERE expires_at <= datetime('now')").run();
  return result.changes;
}

/**
 * Validate API token and return user info if valid
 */
export function validateApiToken(token) {
  if (!token) return null;

  const d = getDb();
  const tokenRecord = d.prepare(`
    SELECT * FROM api_tokens
    WHERE token = ?
    AND (expires_at IS NULL OR expires_at > datetime('now'))
  `).get(token);

  if (!tokenRecord) return null;

  return {
    id: tokenRecord.id,
    email: tokenRecord.email,
    name: tokenRecord.name,
    role: tokenRecord.role,
    isApiToken: true
  };
}

/**
 * Create a new API token
 */
export function createApiToken(email, name, role = 'user', expiresAt = null) {
  const d = getDb();
  const token = crypto.randomBytes(32).toString('hex'); // 64-char hex

  d.prepare(`
    INSERT INTO api_tokens (token, name, email, role, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(token, name, email.toLowerCase(), role, expiresAt);

  return token;
}

/**
 * List all API tokens
 */
export function listApiTokens() {
  const d = getDb();
  return d.prepare('SELECT id, name, email, role, created_at, expires_at FROM api_tokens ORDER BY id').all();
}

/**
 * Delete an API token
 */
export function deleteApiToken(tokenId) {
  const d = getDb();
  const result = d.prepare('DELETE FROM api_tokens WHERE id = ?').run(tokenId);
  return result.changes > 0;
}

/**
 * Auth middleware - checks session cookie and validates
 */
export function authMiddleware(req, res, next) {
  // Get session ID from cookie
  const sessionId = req.cookies?.zoom_session;

  if (!sessionId) {
    return res.redirect('/zoom/login');
  }

  const session = validateSession(sessionId);

  if (!session) {
    // Clear invalid cookie
    res.clearCookie('zoom_session', { path: '/zoom' });
    return res.redirect('/zoom/login');
  }

  // Attach user to request
  req.user = {
    id: session.user_id,
    email: session.email,
    name: session.name,
    role: session.role
  };

  next();
}

/**
 * API auth middleware - returns 401 instead of redirect
 * Supports: cookie session, Bearer token, or token query param
 */
export function apiAuthMiddleware(req, res, next) {
  // Check for Bearer token in Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    const user = validateApiToken(token);
    if (user) {
      req.user = user;
      return next();
    }
    return res.status(401).json({ error: 'Invalid or expired API token' });
  }

  // Check for token query parameter
  const tokenParam = req.query.token;
  if (tokenParam) {
    const user = validateApiToken(tokenParam);
    if (user) {
      req.user = user;
      return next();
    }
    return res.status(401).json({ error: 'Invalid or expired API token' });
  }

  // Fall back to cookie-based session
  const sessionId = req.cookies?.zoom_session;

  if (!sessionId) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const session = validateSession(sessionId);

  if (!session) {
    return res.status(401).json({ error: 'Invalid or expired session' });
  }

  req.user = {
    id: session.user_id,
    email: session.email,
    name: session.name,
    role: session.role
  };

  next();
}

// User management functions for CLI
export function listUsers() {
  const d = getDb();
  return d.prepare('SELECT id, email, name, role, created_at, last_login FROM auth_users ORDER BY id').all();
}

export function addUser(email, name, role = 'user') {
  const d = getDb();
  try {
    d.prepare('INSERT INTO auth_users (email, name, role) VALUES (?, ?, ?)').run(email.toLowerCase(), name, role);
    return true;
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      throw new Error('User already exists');
    }
    throw err;
  }
}

export function removeUser(email) {
  const d = getDb();
  // Delete user's sessions first
  d.prepare('DELETE FROM auth_sessions WHERE email = ?').run(email.toLowerCase());
  const result = d.prepare('DELETE FROM auth_users WHERE email = ?').run(email.toLowerCase());
  return result.changes > 0;
}

export default {
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
  apiAuthMiddleware,
  listUsers,
  addUser,
  removeUser,
  validateApiToken,
  createApiToken,
  listApiTokens,
  deleteApiToken
};
