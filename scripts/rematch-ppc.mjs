#!/usr/bin/env node
/**
 * Re-run PPC → ProofHub matching with improved prompt.
 *
 * Usage:
 *   node scripts/rematch-ppc.mjs              # Re-match all tasks
 *   node scripts/rematch-ppc.mjs --dry-run    # Preview without writing
 *   node scripts/rematch-ppc.mjs --id 41      # Re-match single task
 */

import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
dotenv.config({ path: join(ROOT, '.env') });

// Dynamic import the ESM modules from src/lib
const { matchProofHub } = await import(join(ROOT, 'src', 'lib', 'ppc-task-tracker.js'));

const db = new Database(join(ROOT, 'data', 'zoom-action-items.db'));

const DRY_RUN = process.argv.includes('--dry-run');
const idArgIdx = process.argv.indexOf('--id');
const SINGLE_ID = idArgIdx !== -1 ? parseInt(process.argv[idArgIdx + 1]) : null;

async function main() {
  console.log(`[Rematch PPC] ${DRY_RUN ? 'DRY RUN — ' : ''}Starting...`);
  if (SINGLE_ID) console.log(`  Targeting task ID: ${SINGLE_ID}`);

  // Get tasks to re-match
  let tasks;
  if (SINGLE_ID) {
    tasks = db.prepare('SELECT * FROM ppc_task_tracking WHERE id = ?').all(SINGLE_ID);
  } else {
    tasks = db.prepare('SELECT * FROM ppc_task_tracking').all();
  }

  console.log(`[Rematch PPC] Found ${tasks.length} tasks to re-match\n`);

  const results = { high: 0, medium: 0, low: 0, no_match: 0, changed: 0, errors: 0 };
  const changes = [];

  for (const task of tasks) {
    const oldMatch = task.proofhub_match;
    const oldConfidence = task.proofhub_confidence;
    const oldTaskId = task.proofhub_task_id;
    const oldTitle = task.proofhub_task_title;

    // Look up transcript_excerpt from ai_extraction
    let transcriptExcerpt = null;
    const meeting = db.prepare('SELECT ai_extraction FROM meetings WHERE id = ?').get(task.meeting_id);
    if (meeting?.ai_extraction) {
      try {
        const extraction = JSON.parse(meeting.ai_extraction);
        const items = extraction.action_items || (Array.isArray(extraction) ? extraction[0]?.action_items : null) || [];
        const item = items[task.action_item_index];
        transcriptExcerpt = item?.transcript_excerpt || null;
      } catch {}
    }

    // Build task object for matchProofHub
    const taskObj = {
      title: task.task_title,
      description: task.task_description,
      owner: task.owner,
      client_name: task.client_name,
      transcript_excerpt: transcriptExcerpt
    };

    try {
      const result = await matchProofHub(taskObj, task.client_id, task.meeting_date, db);

      const newMatch = result.match_found ? 1 : 0;
      const newConfidence = result.proofhub_confidence || null;
      const newTaskId = result.proofhub_task_id || null;
      const newTitle = result.proofhub_task_title || null;

      // Track confidence distribution
      if (result.match_found) {
        if (newConfidence === 'high') results.high++;
        else if (newConfidence === 'medium') results.medium++;
        else results.low++;
      } else {
        results.no_match++;
      }

      // Detect changes
      const changed = oldMatch !== newMatch || oldTaskId !== newTaskId || oldConfidence !== newConfidence;
      if (changed) results.changed++;

      const label = changed ? '⚡ CHANGED' : '  same';
      console.log(`${label} | Task ${task.id}: "${task.task_title.slice(0, 50)}"`);
      if (changed) {
        console.log(`    Old: match=${oldMatch}, confidence=${oldConfidence}, ph="${oldTitle || 'none'}"`);
        console.log(`    New: match=${newMatch}, confidence=${newConfidence}, ph="${newTitle || 'none'}"`);
        console.log(`    Reasoning: ${result.proofhub_reasoning || 'N/A'}`);
        changes.push({ id: task.id, title: task.task_title, oldMatch, newMatch, oldConfidence, newConfidence, oldTitle, newTitle });
      }

      // Write to DB
      if (!DRY_RUN && changed) {
        if (result.match_found) {
          db.prepare(`
            UPDATE ppc_task_tracking SET
              proofhub_match = 1,
              proofhub_task_id = ?,
              proofhub_task_title = ?,
              proofhub_status = ?,
              proofhub_created = ?,
              proofhub_assignee = ?,
              proofhub_confidence = ?,
              proofhub_reasoning = ?,
              completion_score = ?,
              days_to_proofhub = ?,
              last_checked = datetime('now')
            WHERE id = ?
          `).run(
            result.proofhub_task_id,
            result.proofhub_task_title,
            result.proofhub_status,
            result.proofhub_created,
            result.proofhub_assignee,
            result.proofhub_confidence,
            result.proofhub_reasoning,
            result.match_found ? 60 + (result.days_to_proofhub <= 3 ? 40 : result.days_to_proofhub <= 7 ? 20 : 0) : 0,
            result.days_to_proofhub,
            task.id
          );
        } else {
          db.prepare(`
            UPDATE ppc_task_tracking SET
              proofhub_match = 0,
              proofhub_task_id = NULL,
              proofhub_task_title = NULL,
              proofhub_status = NULL,
              proofhub_created = NULL,
              proofhub_assignee = NULL,
              proofhub_confidence = ?,
              proofhub_reasoning = ?,
              completion_score = 0,
              days_to_proofhub = NULL,
              last_checked = datetime('now')
            WHERE id = ?
          `).run(
            result.proofhub_confidence,
            result.proofhub_reasoning,
            task.id
          );
        }
      }

      // Rate limit: 2 seconds between GPT calls
      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      console.error(`  ❌ Error on task ${task.id}: ${err.message}`);
      results.errors++;
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Re-match Results:`);
  console.log(`  HIGH matches:   ${results.high}`);
  console.log(`  MEDIUM matches: ${results.medium}`);
  console.log(`  LOW matches:    ${results.low}`);
  console.log(`  No match:       ${results.no_match}`);
  console.log(`  Changed:        ${results.changed} tasks got different results`);
  if (results.errors) console.log(`  Errors:         ${results.errors}`);
  if (DRY_RUN) console.log(`  (DRY RUN — no changes written)`);

  if (changes.length > 0) {
    const falsePositivesRemoved = changes.filter(c => c.oldMatch === 1 && c.newMatch === 0).length;
    if (falsePositivesRemoved) {
      console.log(`  False positives removed: ${falsePositivesRemoved}`);
    }
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
