#!/usr/bin/env node
/**
 * Path-C-2 backfill: re-classify the missed_items + client_commitments in
 * adversarial_result for every meeting that has v2-offsets data, attaching
 * dedup_classification + matched_action_item_id + match_similarity + match_anchors.
 *
 * Idempotent. Safe to re-run with new thresholds (just reads existing JSON,
 * recomputes dedup, writes back).
 *
 * Usage: node scripts/backfill-dedup-classifications.js [--limit 30]
 */

import 'dotenv/config';
import Database from 'better-sqlite3';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { embedActionItems, classifyDedup, ALGORITHM_VERSION } from '../src/lib/dedup-matcher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'zoom-action-items.db');

const argv = process.argv.slice(2);
let limit = 30;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--limit' && argv[i + 1]) limit = parseInt(argv[++i], 10) || 30;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  const db = new Database(DB_PATH);
  const meetings = db.prepare(`
    SELECT id, topic, adversarial_result, client_commitments
    FROM meetings
    WHERE verifier_version = 'v2-offsets' AND adversarial_result IS NOT NULL
    ORDER BY id DESC LIMIT ?
  `).all(limit);

  console.log(`=== Dedup backfill (${meetings.length} meetings) ===`);
  let total = { high: 0, medium: 0, none: 0, processed: 0 };
  const perMeeting = [];

  for (let i = 0; i < meetings.length; i++) {
    const m = meetings[i];
    let advParsed; try { advParsed = JSON.parse(m.adversarial_result); } catch { console.log(`[${i+1}/${meetings.length}] ${m.id}: skip (bad adv JSON)`); continue; }
    let clientParsed; try { clientParsed = JSON.parse(m.client_commitments || '[]'); } catch { clientParsed = []; }
    const items = db.prepare('SELECT * FROM action_items WHERE meeting_id = ? AND (status IS NULL OR status NOT IN (?,?)) ORDER BY id ASC').all(m.id, 'superseded', 'rejected');

    let existingWithEmb = [];
    try { existingWithEmb = await embedActionItems(items); }
    catch (e) { console.log(`  [${m.id}] embed failed: ${e.message}`); }

    const annotateAll = async (arr) => {
      const out = [];
      let h = 0, med = 0, n = 0;
      for (const c of arr) {
        let dedup = { matched_action_item_id: null, match_similarity: 0, match_anchors: [], dedup_classification: 'not_duplicate', algorithm_version: ALGORITHM_VERSION };
        try { dedup = await classifyDedup(c, existingWithEmb); }
        catch { /* keep default */ }
        if (dedup.dedup_classification === 'duplicate_high') h++;
        else if (dedup.dedup_classification === 'duplicate_medium') med++;
        else n++;
        out.push({ ...c, ...dedup });
      }
      return { items: out, h, med, n };
    };
    const missedRes = await annotateAll(advParsed.missed_items || []);
    const clientRes = await annotateAll(clientParsed);

    advParsed.missed_items = missedRes.items;
    db.prepare(`UPDATE meetings SET adversarial_result = ?, client_commitments = ?, updated_at = datetime('now') WHERE id = ?`).run(
      JSON.stringify(advParsed), JSON.stringify(clientRes.items), m.id,
    );

    total.high += missedRes.h + clientRes.h;
    total.medium += missedRes.med + clientRes.med;
    total.none += missedRes.n + clientRes.n;
    total.processed++;
    perMeeting.push({ id: m.id, missed: missedRes, client: clientRes });
    console.log(`[${i+1}/${meetings.length}] meeting ${m.id}: missed ${missedRes.h}H/${missedRes.med}M/${missedRes.n}N · client ${clientRes.h}H/${clientRes.med}M/${clientRes.n}N`);
    await sleep(500);
  }
  db.close();

  console.log(`\n=== Summary ===`);
  console.log(`Meetings processed: ${total.processed}`);
  console.log(`Total candidates: ${total.high + total.medium + total.none}`);
  console.log(`  duplicate_high (auto-hidden):   ${total.high}`);
  console.log(`  duplicate_medium (soft-suggest): ${total.medium}`);
  console.log(`  not_duplicate (visible):         ${total.none}`);
  const totalCands = total.high + total.medium + total.none;
  if (totalCands > 0) {
    const highPct = (100 * total.high / totalCands).toFixed(1);
    console.log(`  duplicate_high rate: ${highPct}% (escalation if > 30%)`);
  }
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
