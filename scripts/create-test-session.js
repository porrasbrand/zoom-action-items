#!/usr/bin/env node
/**
 * Create a test session for Playwright authentication
 * Usage: node scripts/create-test-session.js
 * Output: SESSION_ID=<hex string>
 */

import Database from 'better-sqlite3';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Auth uses the main zoom-action-items.db database
const dbPath = join(__dirname, '../data/zoom-action-items.db');
const authDb = new Database(dbPath);

// Ensure auth tables exist (run migrations)
authDb.exec(`
  CREATE TABLE IF NOT EXISTS auth_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    name TEXT,
    role TEXT DEFAULT 'user',
    created_at TEXT DEFAULT (datetime('now')),
    last_login TEXT
  )
`);

authDb.exec(`
  CREATE TABLE IF NOT EXISTS auth_sessions (
    sid TEXT PRIMARY KEY,
    user_id INTEGER REFERENCES auth_users(id),
    email TEXT,
    name TEXT,
    expires_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

// Generate session ID
const sid = crypto.randomBytes(32).toString('hex');
const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

// Get or create a test user
let user = authDb.prepare("SELECT id FROM auth_users WHERE email = 'test@playwright.local'").get();
if (!user) {
  authDb.prepare("INSERT INTO auth_users (email, name, role) VALUES (?, ?, ?)").run('test@playwright.local', 'Playwright Bot', 'admin');
  user = authDb.prepare("SELECT id FROM auth_users WHERE email = 'test@playwright.local'").get();
  console.error('Created test user: test@playwright.local');
}

// Create session
authDb.prepare("INSERT INTO auth_sessions (sid, user_id, email, name, expires_at) VALUES (?, ?, ?, ?, ?)")
  .run(sid, user.id, 'test@playwright.local', 'Playwright Bot', expiresAt);

console.log('SESSION_ID=' + sid);
