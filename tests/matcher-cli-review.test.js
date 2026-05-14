// tests/matcher-cli-review.test.js — exercise the interactive CLI review
// surface with mocked stdin (Readable) + stdout (Writable). Covers
// y(accept), n(reject), s(skip), q(quit) responses.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { applyMigration004 } from '../scripts/migrate-004-ai-ph-matcher.mjs';
import { runCliReview } from '../scripts/cli-review-matches.mjs';

let fails = 0;
function ok(c, label) { if (c) console.log(`PASS: ${label}`); else { console.error(`FAIL: ${label}`); fails++; } }

const tmpDb = path.join(os.tmpdir(), `matcher-cli-${Date.now()}.db`);
const db = new Database(tmpDb);
db.exec(`
  CREATE TABLE meetings (id INTEGER PRIMARY KEY);
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
  INSERT INTO meetings (id) VALUES (1);
  INSERT INTO action_items (id, meeting_id, client_id, title, status)
    VALUES (10, 1, 'echelon', 'AI 10', 'open'),
           (11, 1, 'echelon', 'AI 11', 'open'),
           (12, 1, 'echelon', 'AI 12', 'open'),
           (13, 1, 'echelon', 'AI 13', 'open');
`);
db.close();
applyMigration004(tmpDb);
const db2 = new Database(tmpDb);
db2.prepare(`INSERT INTO match_candidates (action_item_id, ph_task_id, ph_project_id, ph_task_list_id, similarity_score, topic_overlap_count, rationale)
             VALUES (?, ?, ?, ?, ?, ?, ?)`).run(10, 'ph-10', 'P1', 'L1', 0.72, 1, 'r10');
db2.prepare(`INSERT INTO match_candidates (action_item_id, ph_task_id, ph_project_id, ph_task_list_id, similarity_score, topic_overlap_count, rationale)
             VALUES (?, ?, ?, ?, ?, ?, ?)`).run(11, 'ph-11', 'P1', 'L1', 0.68, 0, 'r11');
db2.prepare(`INSERT INTO match_candidates (action_item_id, ph_task_id, ph_project_id, ph_task_list_id, similarity_score, topic_overlap_count, rationale)
             VALUES (?, ?, ?, ?, ?, ?, ?)`).run(12, 'ph-12', 'P1', 'L1', 0.66, 1, 'r12');
db2.prepare(`INSERT INTO match_candidates (action_item_id, ph_task_id, ph_project_id, ph_task_list_id, similarity_score, topic_overlap_count, rationale)
             VALUES (?, ?, ?, ?, ?, ?, ?)`).run(13, 'ph-13', 'P1', 'L1', 0.71, 1, 'r13');
db2.close();

// Inject answers array directly (deterministic; bypasses readline timing).
let stdoutBuf = '';
const output = new Writable({ write(chunk, _enc, cb) { stdoutBuf += chunk.toString(); cb(); } });
const counts = await runCliReview({
  dbPath: tmpDb, reviewer: 'test-user', output,
  answers: ['y', 'n', 's', 'q'],
});

ok(counts.accepted === 1, `1 accepted=1 (y answer applied) — got ${counts.accepted}`);
ok(counts.rejected === 1, `2 rejected=1 (n answer applied)`);
ok(counts.skipped === 1, `3 skipped=1 (s answer applied)`);
ok(counts.quit === true, `4 quit flag set on 'q' (stops further iterations)`);
ok(counts.reviewed === 3, `5 reviewed=3 (y/n/s before q) — got ${counts.reviewed}`);

const db3 = new Database(tmpDb);
const ai10 = db3.prepare('SELECT ph_task_id, link_source, linked_by FROM action_items WHERE id=10').get();
ok(ai10.ph_task_id === 'ph-10', `6a accepted candidate writes AI ph_task_id`);
ok(ai10.link_source === 'matched', `6b link_source=matched`);
ok(ai10.linked_by === 'test-user', `6c linked_by=reviewer`);
const ai11 = db3.prepare('SELECT ph_task_id FROM action_items WHERE id=11').get();
ok(!ai11.ph_task_id, `7 rejected candidate leaves AI ph_task_id null`);
const cand12 = db3.prepare("SELECT status FROM match_candidates WHERE action_item_id=12").get();
ok(cand12.status === 'pending', `8 skipped candidate still pending`);
const cand13 = db3.prepare("SELECT status FROM match_candidates WHERE action_item_id=13").get();
ok(cand13.status === 'pending', `9 quit-before candidate still pending`);
db3.close();
try { fs.unlinkSync(tmpDb); } catch {}

if (fails === 0) console.log('\nMATCHER-CLI-REVIEW: all checks passed.');
else { console.error(`\nMATCHER-CLI-REVIEW: ${fails} failures.`); process.exit(1); }
