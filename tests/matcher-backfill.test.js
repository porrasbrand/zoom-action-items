// tests/matcher-backfill.test.js — verify the JSON-driven backfill of
// action_items.ph_task_id is correct AND idempotent.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyMigration004 } from '../scripts/migrate-004-ai-ph-matcher.mjs';
import { runBackfill } from '../scripts/backfill-ai-ph-matches.mjs';

let fails = 0;
function ok(c, label) { if (c) console.log(`PASS: ${label}`); else { console.error(`FAIL: ${label}`); fails++; } }

const tmpDb = path.join(os.tmpdir(), `matcher-backfill-${Date.now()}.db`);
const tmpJson = path.join(os.tmpdir(), `matcher-backfill-${Date.now()}.json`);

// Build fixture DB with action_items rows 100/101/102 + 103 (pre-linked) + 104 (missing).
const db = new Database(tmpDb);
db.exec(`
  CREATE TABLE meetings (id INTEGER PRIMARY KEY);
  CREATE TABLE action_items (
    id INTEGER PRIMARY KEY,
    meeting_id INTEGER NOT NULL REFERENCES meetings(id),
    title TEXT NOT NULL,
    ph_task_id TEXT,
    ph_project_id TEXT,
    ph_task_list_id TEXT
  );
  INSERT INTO meetings (id) VALUES (1);
  INSERT INTO action_items (id, meeting_id, title) VALUES (100, 1, 'AI 100');
  INSERT INTO action_items (id, meeting_id, title) VALUES (101, 1, 'AI 101');
  INSERT INTO action_items (id, meeting_id, title) VALUES (102, 1, 'AI 102');
  INSERT INTO action_items (id, meeting_id, title, ph_task_id) VALUES (103, 1, 'AI 103', 'existing-ph');
`);
db.close();
applyMigration004(tmpDb);

const fixture = {
  client_slug: 'echelon-services', project_id: 'P1', generated_at: '2026-05-14T00:00:00Z',
  linked_by: 'xprt:echelon',
  links: [
    { action_item_id: 100, ph_task_id: 'ph-100', ph_project_id: 'P1', ph_task_list_id: 'L1', link_source: 'matched', link_confidence: 'high' },
    { action_item_id: 101, ph_task_id: 'ph-101', ph_project_id: 'P1', ph_task_list_id: 'L2', link_source: 'matched', link_confidence: 'medium' },
    { action_item_id: 102, ph_task_id: 'ph-102', ph_project_id: 'P1', ph_task_list_id: 'L1', link_source: 'matched', link_confidence: 'high' },
    { action_item_id: 103, ph_task_id: 'ph-103-different', ph_project_id: 'P1', ph_task_list_id: 'L1', link_source: 'matched', link_confidence: 'high' },
    { action_item_id: 999, ph_task_id: 'ph-999', ph_project_id: 'P1', ph_task_list_id: 'L1', link_source: 'matched', link_confidence: 'low' },
  ],
};
fs.writeFileSync(tmpJson, JSON.stringify(fixture));

try {
  // First run: update 3, conflict 1, missing 1.
  const r1 = runBackfill({ dbPath: tmpDb, jsonPath: tmpJson });
  ok(r1.updated.length === 3, `1a updated 3 fresh rows (got ${r1.updated.length})`);
  ok(r1.updated.includes(100) && r1.updated.includes(101) && r1.updated.includes(102),
     `1b updated ids include {100,101,102}`);
  ok(r1.conflicts.length === 1 && r1.conflicts[0].action_item_id === 103,
     `1c row 103 flagged as conflict (existing != proposed)`);
  ok(r1.missing_action_items.length === 1 && r1.missing_action_items[0] === 999,
     `1d AI 999 (missing) reported`);

  // Verify SQL state after first run.
  const db2 = new Database(tmpDb);
  const r100 = db2.prepare('SELECT * FROM action_items WHERE id=100').get();
  ok(r100.ph_task_id === 'ph-100', '2a row 100 ph_task_id set');
  ok(r100.link_source === 'matched', '2b row 100 link_source=matched');
  ok(r100.link_confidence === 'high', '2c row 100 link_confidence=high');
  ok(r100.linked_by === 'xprt:echelon', '2d row 100 linked_by=xprt:echelon');
  ok(!!r100.linked_at, '2e row 100 linked_at populated');
  const r103 = db2.prepare('SELECT * FROM action_items WHERE id=103').get();
  ok(r103.ph_task_id === 'existing-ph', '2f row 103 untouched (conflict preserved)');
  db2.close();

  // Second run: should be a no-op (all 3 already correct, conflict still flagged).
  const r2 = runBackfill({ dbPath: tmpDb, jsonPath: tmpJson });
  ok(r2.updated.length === 0, `3a re-run updates 0 rows (got ${r2.updated.length})`);
  ok(r2.already_correct.length === 3, `3b re-run flags 3 as already_correct (got ${r2.already_correct.length})`);
  ok(r2.conflicts.length === 1, `3c conflicts persist`);
} finally {
  try { fs.unlinkSync(tmpDb); } catch {}
  try { fs.unlinkSync(tmpJson); } catch {}
}

if (fails === 0) console.log('\nMATCHER-BACKFILL: all checks passed.');
else { console.error(`\nMATCHER-BACKFILL: ${fails} failures.`); process.exit(1); }
