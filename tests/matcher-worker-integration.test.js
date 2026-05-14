// tests/matcher-worker-integration.test.js — integration test for the full
// runMatcherWorker pipeline. Uses fake embeddings + an in-process sqlite to
// verify each AI ends up in EITHER action_items (auto-link) OR match_candidates
// (candidate) OR neither (no-match) — never both.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { applyMigration004 } from '../scripts/migrate-004-ai-ph-matcher.mjs';
import { runMatcherWorker } from '../src/lib/ai-ph-matcher.js';

let fails = 0;
function ok(c, label) { if (c) console.log(`PASS: ${label}`); else { console.error(`FAIL: ${label}`); fails++; } }

const tmpDb = path.join(os.tmpdir(), `matcher-integ-${Date.now()}.db`);
const db = new Database(tmpDb);
db.exec(`
  CREATE TABLE meetings (id INTEGER PRIMARY KEY, client_id TEXT, start_time TEXT);
  CREATE TABLE action_items (
    id INTEGER PRIMARY KEY,
    meeting_id INTEGER NOT NULL REFERENCES meetings(id),
    client_id TEXT,
    title TEXT NOT NULL,
    description TEXT,
    ph_task_id TEXT, ph_project_id TEXT, ph_task_list_id TEXT,
    pushed_at TEXT,
    status TEXT DEFAULT 'open',
    created_at TEXT DEFAULT (datetime('now'))
  );
  INSERT INTO meetings (id, client_id, start_time) VALUES (1, 'echelon', '2026-05-01');
  -- AI #1: open + matches a PH task with LSA + high cosine + date proximity → auto-link
  INSERT INTO action_items (id, meeting_id, client_id, title, description, status)
    VALUES (1, 1, 'echelon', 'Fix LSA mailer for HVAC technician hiring', 'Echelon mailer update', 'open');
  -- AI #2: open + medium-score, no overlap → candidate
  INSERT INTO action_items (id, meeting_id, client_id, title, description, status)
    VALUES (2, 1, 'echelon', 'Random topic X', 'no shared tags', 'open');
  -- AI #3: low score → no-match
  INSERT INTO action_items (id, meeting_id, client_id, title, description, status)
    VALUES (3, 1, 'echelon', 'Replace coffee machine', '', 'open');
  -- AI #4: already linked → must be skipped
  INSERT INTO action_items (id, meeting_id, client_id, title, ph_task_id, status)
    VALUES (4, 1, 'echelon', 'Already linked', 'ph-existing', 'open');
  -- AI #5: wrong client → must be skipped (echelon-only filter)
  INSERT INTO meetings (id, client_id, start_time) VALUES (2, 'wagner-chiro', '2026-05-01');
  INSERT INTO action_items (id, meeting_id, client_id, title, status)
    VALUES (5, 2, 'wagner-chiro', 'Wagner only — should not match echelon PH', 'open');
`);
db.close();
applyMigration004(tmpDb);

const phTasks = [
  { id: 'ph-1', project_id: 'P1', list_id: 'L1', title: 'LSA hiring email', description: 'HVAC technician', created_at: '2026-05-05' },
  { id: 'ph-2', project_id: 'P1', list_id: 'L2', title: 'Random PH task X', description: 'no tags match', created_at: '2026-05-05' },
];

// Fake embeddings — return identical vectors for "LSA" / "HVAC" texts (cosine
// ≈ 1.0). For other texts return orthogonal vectors so cosine → 0.
async function fakeEmbed(text) {
  const lower = String(text || '').toLowerCase();
  if (lower.includes('lsa') || lower.includes('hvac') || lower.includes('mailer')) {
    return [1, 0, 0, 0];  // "LSA cluster"
  }
  if (lower.includes('random') || lower.includes('topic x')) {
    return [0.65, 0.65, 0.65, 0.65];  // mid-band — cosine ~0.5 vs LSA cluster
  }
  return [0, 0, 0, 1];  // orthogonal
}

const dbW = new Database(tmpDb);
const summary = await runMatcherWorker({
  db: dbW, clientSlug: 'echelon', phTasks,
  embedAi: fakeEmbed, embedPh: fakeEmbed, dryRun: false,
});

ok(summary.scanned === 3, `1 scanned 3 (echelon open + unlinked) — got ${summary.scanned}`);
ok(summary.autoLinked === 1, `2 autoLinked=1 (AI #1 → ph-1)`);
ok(summary.candidates >= 0 && summary.candidates <= 1, `3 candidates 0-1 (AI #2 fake-mid-band)`);
ok(summary.noMatch >= 1, `4 ≥1 no-match (AI #3 unrelated)`);

// AI #1 should now have ph_task_id=ph-1 + link_source=matched.
const ai1 = dbW.prepare('SELECT * FROM action_items WHERE id=1').get();
ok(ai1.ph_task_id === 'ph-1', `5a AI #1 ph_task_id=ph-1`);
ok(ai1.link_source === 'matched', `5b link_source=matched`);
ok(ai1.linked_by === 'daily-matcher', `5c linked_by=daily-matcher`);
ok(!!ai1.pushed_at, `5d pushed_at populated`);

// AI #1 should NOT also have a match_candidates row.
const cand1 = dbW.prepare('SELECT COUNT(*) AS n FROM match_candidates WHERE action_item_id=1').get();
ok(cand1.n === 0, `6 AI #1 has NO candidate row (never both)`);

// AI #4 (already linked) must be untouched.
const ai4 = dbW.prepare('SELECT * FROM action_items WHERE id=4').get();
ok(ai4.ph_task_id === 'ph-existing', `7 AI #4 ph_task_id preserved`);

// AI #5 (wagner-chiro) must NOT have been scanned by the echelon worker.
const ai5 = dbW.prepare('SELECT * FROM action_items WHERE id=5').get();
ok(!ai5.ph_task_id, `8 AI #5 (wagner) ph_task_id still null`);

dbW.close();
try { fs.unlinkSync(tmpDb); } catch {}

if (fails === 0) console.log('\nMATCHER-WORKER-INTEGRATION: all checks passed.');
else { console.error(`\nMATCHER-WORKER-INTEGRATION: ${fails} failures.`); process.exit(1); }
