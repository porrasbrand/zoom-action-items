#!/usr/bin/env node
// Apply migration 004 — daily AI↔PH matcher worker schema delta.
// Idempotent: column-add is guarded by pragma_table_info; table+indexes use IF NOT EXISTS.
// Usage:
//   node scripts/migrate-004-ai-ph-matcher.mjs                     # default DB
//   ZOOM_DB_PATH=/tmp/foo.db node scripts/migrate-004-ai-ph-matcher.mjs

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = path.resolve(__dirname, '..', 'data', 'zoom-action-items.db');
const MIGRATION_SQL = path.resolve(__dirname, '..', 'migrations', '004-ai-ph-matcher.sql');

const NEW_AI_COLUMNS = [
  { name: 'link_source',     ddl: 'TEXT DEFAULT NULL' },
  { name: 'link_confidence', ddl: 'TEXT DEFAULT NULL' },
  { name: 'linked_by',       ddl: 'TEXT DEFAULT NULL' },
  { name: 'linked_at',       ddl: 'TEXT DEFAULT NULL' },
];

export function applyMigration004(dbPath = DEFAULT_DB) {
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');

  const existing = new Set(
    db.prepare("PRAGMA table_info('action_items')").all().map(r => r.name)
  );
  const added = [];
  const skipped = [];
  for (const c of NEW_AI_COLUMNS) {
    if (existing.has(c.name)) { skipped.push(c.name); continue; }
    db.exec(`ALTER TABLE action_items ADD COLUMN ${c.name} ${c.ddl};`);
    added.push(c.name);
  }

  const sql = fs.readFileSync(MIGRATION_SQL, 'utf8');
  db.exec(sql);

  db.close();
  return { added, skipped, tablesAndIndexesApplied: true, dbPath };
}

// Default entry point.
if (import.meta.url === `file://${process.argv[1]}`) {
  const result = applyMigration004();
  console.log(`[migrate-004] DB: ${result.dbPath}`);
  console.log(`[migrate-004] added columns: ${result.added.join(', ') || '(none — all present)'}`);
  console.log(`[migrate-004] skipped columns (already present): ${result.skipped.join(', ') || '(none)'}`);
  console.log(`[migrate-004] match_candidates table + indexes: applied (IF NOT EXISTS)`);
}
