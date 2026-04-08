#!/usr/bin/env node
/**
 * Universal matching — 3-step funnel for all trackable non-PPC action items.
 * Step 1: SQL date filter (does client have PH tasks in window?)
 * Step 2: Embedding similarity (>= 0.65 threshold)
 * Step 3: GPT-5.4 semantic matching (only plausible candidates)
 *
 * Usage:
 *   node scripts/match-all-tasks.mjs                # Match all unmatched trackable items
 *   node scripts/match-all-tasks.mjs --dry-run      # Preview without writing
 *   node scripts/match-all-tasks.mjs --client <id>  # Match one client only
 *   node scripts/match-all-tasks.mjs --meeting <id> # Match one meeting only
 *   node scripts/match-all-tasks.mjs --stats        # Show funnel stats without running
 */

import Database from 'better-sqlite3';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
dotenv.config({ path: join(ROOT, '.env') });

const db = new Database(join(ROOT, 'data', 'zoom-action-items.db'));

const { matchProofHub } = await import(join(ROOT, 'src', 'lib', 'ppc-task-tracker.js'));
const { cachePhTaskEmbeddings, findPlausibleMatches, initEmbeddingCache } = await import(join(ROOT, 'src', 'lib', 'embedding-cache.js'));

const DRY_RUN = process.argv.includes('--dry-run');
const STATS_ONLY = process.argv.includes('--stats');
const clientArgIdx = process.argv.indexOf('--client');
const CLIENT_FILTER = clientArgIdx !== -1 ? process.argv[clientArgIdx + 1] : null;
const meetingArgIdx = process.argv.indexOf('--meeting');
const MEETING_FILTER = meetingArgIdx !== -1 ? parseInt(process.argv[meetingArgIdx + 1]) : null;

async function main() {
  console.log(`[Match All Tasks] ${DRY_RUN ? 'DRY RUN — ' : ''}${STATS_ONLY ? 'STATS ONLY — ' : ''}Starting...`);

  // Step 0: Ensure PH embeddings are cached
  console.log('\n--- Caching PH task embeddings ---');
  initEmbeddingCache(db);
  const cacheResult = await cachePhTaskEmbeddings(db);
  console.log(`  PH embeddings: ${cacheResult.cached} new, ${cacheResult.skipped} cached, ${cacheResult.total} total`);

  // Get items to match: trackable, not already matched via GPT, non-PPC (platform IS NULL)
  let whereClause = 'WHERE trackable = 1 AND (proofhub_match IS NULL OR match_method IS NULL)';
  const params = [];

  // Also include items that were PPC but haven't been matched with the new method
  // Actually, we only want non-PPC items that haven't been matched yet
  whereClause = `WHERE trackable = 1 AND match_method IS NULL AND (platform IS NULL OR platform = '')`;

  if (CLIENT_FILTER) {
    whereClause += ' AND client_id = ?';
    params.push(CLIENT_FILTER);
  }
  if (MEETING_FILTER) {
    whereClause += ' AND meeting_id = ?';
    params.push(MEETING_FILTER);
  }

  const items = db.prepare(`SELECT * FROM ppc_task_tracking ${whereClause} ORDER BY meeting_date DESC`).all(...params);

  // Get total stats
  const totalAll = db.prepare('SELECT COUNT(*) as c FROM ppc_task_tracking').get().c;
  const totalPPC = db.prepare("SELECT COUNT(*) as c FROM ppc_task_tracking WHERE platform IS NOT NULL AND platform != ''").get().c;
  const totalTrackable = db.prepare('SELECT COUNT(*) as c FROM ppc_task_tracking WHERE trackable = 1').get().c;
  const totalNA = db.prepare('SELECT COUNT(*) as c FROM ppc_task_tracking WHERE trackable = 0').get().c;
  const totalUnclassified = db.prepare('SELECT COUNT(*) as c FROM ppc_task_tracking WHERE trackable IS NULL').get().c;

  console.log(`\n--- Task Overview ---`);
  console.log(`  Total action items:       ${totalAll}`);
  console.log(`  PPC (already tracked):    ${totalPPC}`);
  console.log(`  Trackable (non-PPC):      ${totalTrackable - totalPPC}`);
  console.log(`  Not applicable:           ${totalNA}`);
  console.log(`  Unclassified:             ${totalUnclassified}`);
  console.log(`  Items to process now:     ${items.length}`);

  if (STATS_ONLY || items.length === 0) {
    if (items.length === 0) console.log('\nNothing to match!');
    // Show existing match stats
    const matchStats = db.prepare('SELECT match_method, COUNT(*) as c FROM ppc_task_tracking WHERE match_method IS NOT NULL GROUP BY match_method').all();
    if (matchStats.length) {
      console.log('\n--- Existing Match Methods ---');
      matchStats.forEach(s => console.log(`  ${s.match_method}: ${s.c}`));
    }
    process.exit(0);
  }

  // Funnel stats
  const funnel = { no_candidates: 0, embedding_skip: 0, gpt_called: 0, high: 0, medium: 0, low: 0, no_match: 0, errors: 0 };

  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    const progress = `[${idx + 1}/${items.length}]`;

    // Look up transcript_excerpt
    let transcriptExcerpt = null;
    const meeting = db.prepare('SELECT ai_extraction FROM meetings WHERE id = ?').get(item.meeting_id);
    if (meeting?.ai_extraction) {
      try {
        const extraction = JSON.parse(meeting.ai_extraction);
        const actionItems = extraction.action_items || (Array.isArray(extraction) ? extraction[0]?.action_items : null) || [];
        transcriptExcerpt = actionItems[item.action_item_index]?.transcript_excerpt || null;
      } catch {}
    }

    // STEP 1: SQL — Does this client have PH tasks in the window?
    const meetingDate = new Date(item.meeting_date);
    const windowStart = new Date(meetingDate);
    windowStart.setDate(windowStart.getDate() - 2);
    const windowEnd = new Date(meetingDate);
    windowEnd.setDate(windowEnd.getDate() + 10);

    const candidates = db.prepare(`
      SELECT ph_task_id, title, scope_summary, description_text,
             completed, start_date, assigned_names
      FROM ph_task_cache
      WHERE client_id = ? AND start_date BETWEEN ? AND ?
    `).all(item.client_id, windowStart.toISOString().split('T')[0], windowEnd.toISOString().split('T')[0]);

    if (candidates.length === 0) {
      funnel.no_candidates++;
      if (!DRY_RUN) {
        db.prepare('UPDATE ppc_task_tracking SET proofhub_match = 0, match_method = ? WHERE id = ?')
          .run('no_candidates', item.id);
      }
      process.stdout.write(`${progress} ${item.task_title.slice(0, 45).padEnd(45)} → no PH candidates\n`);
      continue;
    }

    // STEP 2: Embedding similarity
    try {
      const actionText = `${item.task_title} — ${item.task_description || ''}`;
      const { matches: plausible, bestScore } = await findPlausibleMatches(
        actionText,
        candidates.map(c => c.ph_task_id),
        db,
        0.65
      );

      if (plausible.length === 0) {
        funnel.embedding_skip++;
        if (!DRY_RUN) {
          db.prepare('UPDATE ppc_task_tracking SET proofhub_match = 0, match_method = ?, embedding_score = ? WHERE id = ?')
            .run('embedding_skip', bestScore, item.id);
        }
        process.stdout.write(`${progress} ${item.task_title.slice(0, 45).padEnd(45)} → embedding < 0.65 (best: ${bestScore.toFixed(3)})\n`);
        continue;
      }

      // STEP 3: GPT-5.4 — semantic matching with plausible candidates only
      funnel.gpt_called++;

      // Build candidate objects matching the format matchProofHub expects
      const plausibleCandidates = candidates
        .filter(c => plausible.some(p => p.ph_task_id === c.ph_task_id))
        .map(c => ({
          id: c.ph_task_id,
          title: c.title,
          created_at: c.start_date,
          responsible_name: c.assigned_names || 'unassigned',
          completed: c.completed === 1
        }));

      const taskObj = {
        title: item.task_title,
        description: item.task_description,
        owner: item.owner,
        client_name: item.client_name,
        transcript_excerpt: transcriptExcerpt
      };

      const result = await matchProofHub(taskObj, item.client_id, item.meeting_date, db, plausibleCandidates);

      if (result.match_found) {
        const conf = result.proofhub_confidence || 'low';
        if (conf === 'high') funnel.high++;
        else if (conf === 'medium') funnel.medium++;
        else funnel.low++;

        const topEmbedding = plausible[0]?.similarity || 0;

        if (!DRY_RUN) {
          const days = result.days_to_proofhub || 0;
          const score = 60 + (days <= 3 ? 40 : days <= 7 ? 20 : 0);
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
              match_method = 'gpt-5.4',
              embedding_score = ?,
              last_checked = datetime('now')
            WHERE id = ?
          `).run(
            result.proofhub_task_id, result.proofhub_task_title,
            result.proofhub_status, result.proofhub_created,
            result.proofhub_assignee, result.proofhub_confidence,
            result.proofhub_reasoning, score, result.days_to_proofhub,
            topEmbedding, item.id
          );
        }

        process.stdout.write(`${progress} ${item.task_title.slice(0, 45).padEnd(45)} → ✅ ${conf.toUpperCase()} match: "${result.proofhub_task_title?.slice(0, 40)}"\n`);
      } else {
        funnel.no_match++;
        if (!DRY_RUN) {
          db.prepare(`
            UPDATE ppc_task_tracking SET
              proofhub_match = 0,
              proofhub_confidence = ?,
              proofhub_reasoning = ?,
              match_method = 'gpt-5.4',
              embedding_score = ?,
              last_checked = datetime('now')
            WHERE id = ?
          `).run(
            result.proofhub_confidence, result.proofhub_reasoning,
            plausible[0]?.similarity || 0, item.id
          );
        }

        process.stdout.write(`${progress} ${item.task_title.slice(0, 45).padEnd(45)} → no match (GPT)\n`);
      }

      // Rate limit GPT calls
      await new Promise(r => setTimeout(r, 2000));

    } catch (err) {
      funnel.errors++;
      console.error(`${progress} Error on task ${item.id}: ${err.message}`);
    }
  }

  // Print summary
  console.log(`\n${'='.repeat(60)}`);
  console.log(`=== Universal Matching Results ===`);
  console.log(`Total items processed:     ${items.length}`);
  console.log(`\nMatching funnel:`);
  console.log(`  Step 1 — No PH candidates:  ${funnel.no_candidates} (${Math.round(funnel.no_candidates / items.length * 100)}% filtered)`);
  console.log(`  Step 2 — Embedding < 0.65:  ${funnel.embedding_skip} (${Math.round(funnel.embedding_skip / items.length * 100)}% filtered)`);
  console.log(`  Step 3 — GPT-5.4 called:    ${funnel.gpt_called} (${Math.round(funnel.gpt_called / items.length * 100)}% reached GPT)`);
  console.log(`    HIGH match:               ${funnel.high}`);
  console.log(`    MEDIUM match:             ${funnel.medium}`);
  console.log(`    No match:                 ${funnel.no_match}`);
  if (funnel.errors) console.log(`  Errors:                     ${funnel.errors}`);
  console.log(`\nFinal: ${funnel.high} confirmed + ${funnel.medium} needs review + ${funnel.no_candidates + funnel.embedding_skip + funnel.no_match} missing`);
  console.log(`Cost: ~${funnel.gpt_called} GPT calls, ~${items.length} embeddings`);
  if (DRY_RUN) console.log(`\n(DRY RUN — no changes written)`);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
