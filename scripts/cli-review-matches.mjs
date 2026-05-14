#!/usr/bin/env node
// scripts/cli-review-matches.mjs — Option A reviewer for the match_candidates
// queue. Interactive: lists each pending candidate with rationale + options:
//   y  accept (writes action_items.ph_task_id + marks candidate accepted)
//   n  reject (marks candidate rejected; no AI write)
//   s  skip   (leave pending for next session)
//   q  quit
//
// Stdin can be redirected for batch / test runs:
//   echo "y\nn\ns" | node scripts/cli-review-matches.mjs
//
// Idempotent: re-running only shows still-pending candidates.

import Database from 'better-sqlite3';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = path.resolve(__dirname, '..', 'data', 'zoom-action-items.db');

// If `answers` is provided, the prompt iteration consumes from it instead of
// reading stdin. Indexed left-to-right; once exhausted, treats further prompts
// as 'q' (quit). Designed for deterministic test injection.
export async function runCliReview({
  dbPath = DEFAULT_DB,
  reviewer = 'cli-review',
  input = process.stdin,
  output = process.stdout,
  answers = null,
} = {}) {
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');

  const pending = db.prepare(`
    SELECT c.id, c.action_item_id, c.ph_task_id, c.ph_project_id, c.ph_task_list_id,
           c.similarity_score, c.topic_overlap_count, c.rationale, c.created_at,
           ai.title AS ai_title, ai.description AS ai_description,
           ai.client_id AS ai_client_id, ai.status AS ai_status
      FROM match_candidates c
      LEFT JOIN action_items ai ON ai.id = c.action_item_id
     WHERE c.status = 'pending'
     ORDER BY c.created_at ASC
  `).all();

  output.write(`[cli-review] ${pending.length} pending candidates\n`);
  if (pending.length === 0) { db.close(); return { reviewed: 0, accepted: 0, rejected: 0, skipped: 0, quit: false }; }

  // Two prompt modes:
  //   - injected `answers[]` (deterministic, no stream — used by tests)
  //   - readline over `input` (interactive — used by humans)
  let rl = null;
  let answersIdx = 0;
  const ask = (q) => {
    if (Array.isArray(answers)) {
      output.write(q);
      if (answersIdx >= answers.length) return Promise.resolve('q');
      const a = answers[answersIdx++];
      output.write(`${a}\n`);
      return Promise.resolve(a);
    }
    if (!rl) rl = readline.createInterface({ input, output, terminal: false });
    return new Promise(r => { try { rl.question(q, r); } catch { r('q'); } });
  };

  const stmtAcceptCand = db.prepare(`
    UPDATE match_candidates SET status='accepted', reviewed_by=?, reviewed_at=datetime('now')
     WHERE id=? AND status='pending'
  `);
  const stmtRejectCand = db.prepare(`
    UPDATE match_candidates SET status='rejected', reviewed_by=?, reviewed_at=datetime('now')
     WHERE id=? AND status='pending'
  `);
  const stmtLinkAi = db.prepare(`
    UPDATE action_items
       SET ph_task_id=?, ph_project_id=?, ph_task_list_id=?,
           link_source='matched', link_confidence='medium',
           linked_by=?, linked_at=datetime('now'),
           pushed_at=COALESCE(pushed_at, datetime('now'))
     WHERE id=? AND ph_task_id IS NULL
  `);

  const counts = { reviewed: 0, accepted: 0, rejected: 0, skipped: 0, quit: false };

  for (const c of pending) {
    output.write(`\n── candidate #${c.id} ────────────────────────────────────────\n`);
    output.write(`AI (#${c.action_item_id}): ${c.ai_title || '(no title)'}\n`);
    if (c.ai_description) output.write(`  desc: ${c.ai_description.slice(0, 200)}\n`);
    output.write(`PH task: ${c.ph_task_id} (project=${c.ph_project_id} list=${c.ph_task_list_id})\n`);
    output.write(`score=${c.similarity_score?.toFixed?.(3) || c.similarity_score} overlap=${c.topic_overlap_count}\n`);
    output.write(`rationale: ${c.rationale}\n`);

    const answer = (await ask('  [y]ccept / [n]reject / [s]kip / [q]uit: ')).trim().toLowerCase();
    if (answer === 'q') { counts.quit = true; break; }
    if (answer === 'y') {
      stmtAcceptCand.run(reviewer, c.id);
      stmtLinkAi.run(
        String(c.ph_task_id),
        c.ph_project_id ? String(c.ph_project_id) : null,
        c.ph_task_list_id ? String(c.ph_task_list_id) : null,
        reviewer,
        c.action_item_id,
      );
      counts.accepted++;
      output.write(`  → accepted; AI ${c.action_item_id} linked to PH ${c.ph_task_id}\n`);
    } else if (answer === 'n') {
      stmtRejectCand.run(reviewer, c.id);
      counts.rejected++;
      output.write(`  → rejected\n`);
    } else {
      counts.skipped++;
      output.write(`  → skipped (still pending)\n`);
    }
    counts.reviewed++;
  }

  if (rl) rl.close();
  db.close();
  output.write(`\n[cli-review] done — reviewed=${counts.reviewed} accepted=${counts.accepted} rejected=${counts.rejected} skipped=${counts.skipped}${counts.quit ? ' (quit)' : ''}\n`);
  return counts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCliReview().catch(e => { console.error('[cli-review] error:', e); process.exit(1); });
}
