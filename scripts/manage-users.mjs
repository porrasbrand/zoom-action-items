#!/usr/bin/env node
/**
 * User Management CLI for Zoom Dashboard Auth
 *
 * Usage:
 *   node scripts/manage-users.mjs list
 *   node scripts/manage-users.mjs add email@example.com "Full Name" [role]
 *   node scripts/manage-users.mjs remove email@example.com
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'zoom-action-items.db');

const db = new Database(DB_PATH, { readonly: false });

function listUsers() {
  const users = db.prepare(`
    SELECT id, email, name, role, created_at, last_login
    FROM auth_users
    ORDER BY id
  `).all();

  if (users.length === 0) {
    console.log('No users found.');
    return;
  }

  console.log('\nAuthorized Users:');
  console.log('─'.repeat(80));
  console.log('ID  | Email                          | Name              | Role   | Last Login');
  console.log('─'.repeat(80));

  for (const user of users) {
    const email = user.email.padEnd(30);
    const name = (user.name || '').padEnd(17);
    const role = (user.role || 'user').padEnd(6);
    const lastLogin = user.last_login ? user.last_login.slice(0, 16) : 'Never';
    console.log(`${String(user.id).padStart(3)} | ${email} | ${name} | ${role} | ${lastLogin}`);
  }

  console.log('─'.repeat(80));
  console.log(`Total: ${users.length} users\n`);
}

function addUser(email, name, role = 'user') {
  if (!email) {
    console.error('Error: Email is required');
    process.exit(1);
  }

  try {
    db.prepare(`
      INSERT INTO auth_users (email, name, role)
      VALUES (?, ?, ?)
    `).run(email.toLowerCase(), name || null, role);

    console.log(`Added user: ${email} (${name || 'no name'}) as ${role}`);
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      console.error(`Error: User ${email} already exists`);
      process.exit(1);
    }
    throw err;
  }
}

function removeUser(email) {
  if (!email) {
    console.error('Error: Email is required');
    process.exit(1);
  }

  // Delete sessions first
  db.prepare('DELETE FROM auth_sessions WHERE email = ?').run(email.toLowerCase());

  const result = db.prepare('DELETE FROM auth_users WHERE email = ?').run(email.toLowerCase());

  if (result.changes > 0) {
    console.log(`Removed user: ${email}`);
  } else {
    console.error(`Error: User ${email} not found`);
    process.exit(1);
  }
}

// Parse command line arguments
const [,, command, ...args] = process.argv;

switch (command) {
  case 'list':
    listUsers();
    break;

  case 'add':
    addUser(args[0], args[1], args[2]);
    break;

  case 'remove':
    removeUser(args[0]);
    break;

  default:
    console.log(`
Zoom Dashboard User Management

Usage:
  node scripts/manage-users.mjs list
    List all authorized users

  node scripts/manage-users.mjs add <email> [name] [role]
    Add a new user. Role can be 'admin' or 'user' (default: user)

  node scripts/manage-users.mjs remove <email>
    Remove a user and their sessions

Examples:
  node scripts/manage-users.mjs add john@example.com "John Doe" admin
  node scripts/manage-users.mjs remove john@example.com
    `);
    break;
}

db.close();
