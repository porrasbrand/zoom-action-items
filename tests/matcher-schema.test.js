// tests/matcher-schema.test.js — verify migration 004 is idempotent and
// produces the expected schema delta on action_items + match_candidates.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyMigration004 } from '../scripts/migrate-004-ai-ph-matcher.mjs';

let fails = 0;
function ok(c, label) { if (c) console.log(`PASS: ${label}`); else { console.error(`FAIL: ${label}`); fails++; } }

function freshDb() {
  const p = path.join(os.tmpdir(), `matcher-schema-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
  const db = new Database(p);
  db.exec(`
    CREATE TABLE meetings (
      id INTEGER PRIMARY KEY,
      client_id TEXT,
      start_time TEXT
    );
    CREATE TABLE action_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id INTEGER NOT NULL REFERENCES meetings(id),
      client_id TEXT,
      title TEXT NOT NULL,
      description TEXT,
      ph_task_id TEXT,
      ph_project_id TEXT,
      ph_task_list_id TEXT,
      pushed_at TEXT,
      status TEXT DEFAULT 'open',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.close();
  return p;
}

const dbPath = freshDb();
try {
  // 1. First apply adds all 4 columns + creates match_candidates + indexes.
  const r1 = applyMigration004(dbPath);
  ok(r1.added.length === 4, `1a all 4 columns added on first apply (got ${r1.added.length})`);
  ok(r1.skipped.length === 0, `1b zero skipped on first apply`);

  const db = new Database(dbPath);
  const cols = new Set(db.prepare("PRAGMA table_info('action_items')").all().map(r => r.name));
  ok(cols.has('link_source'), '1c link_source column exists');
  ok(cols.has('link_confidence'), '1d link_confidence column exists');
  ok(cols.has('linked_by'), '1e linked_by column exists');
  ok(cols.has('linked_at'), '1f linked_at column exists');

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='match_candidates'").get();
  ok(!!tables, '1g match_candidates table exists');

  const indexes = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='match_candidates'").all().map(r => r.name);
  ok(indexes.includes('idx_match_candidates_action_item'), '1h idx_match_candidates_action_item exists');
  ok(indexes.includes('idx_match_candidates_status'), '1i idx_match_candidates_status exists');

  db.close();

  // 2. Second apply is a no-op (idempotency).
  const r2 = applyMigration004(dbPath);
  ok(r2.added.length === 0, `2a no columns added on re-apply (got ${r2.added.length})`);
  ok(r2.skipped.length === 4, `2b all 4 columns skipped on re-apply (got ${r2.skipped.length})`);
} finally {
  try { fs.unlinkSync(dbPath); } catch {}
}

if (fails === 0) console.log('\nMATCHER-SCHEMA: all checks passed.');
else { console.error(`\nMATCHER-SCHEMA: ${fails} failures.`); process.exit(1); }
