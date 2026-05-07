#!/usr/bin/env node
/**
 * Pattern A backfill — re-runs the verifier on every v2-offsets meeting under
 * the new prompt (anchor_quote contract instead of char offsets), then locates
 * each anchor in the transcript via findAnchorRange.
 *
 * Replaces the existing adversarial_result + client_commitments JSON with the
 * new schema. Severity / dedup classifications are recomputed downstream by
 * the existing classifyDedup + severity loops in poll.js — but here we just
 * re-run the verifier; the auto-run-style enrichment isn't strictly needed
 * for backfill purposes since the dashboard re-renders on read.
 *
 * Cost: ~30 calls × $0.01 = ~$0.30. Throttled 1s between meetings.
 *
 * Usage: node scripts/backfill-anchor-quotes.js [--limit 30]
 */

import 'dotenv/config';
import Database from 'better-sqlite3';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { verifyExtraction } from '../src/lib/adversarial-verifier.js';
import { findAnchorRange, sliceEvidence, canonicalCandidateHash } from '../src/lib/transcript-utils.js';
import { embedActionItems, classifyDedup } from '../src/lib/dedup-matcher.js';

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
    SELECT id, topic, transcript_raw
    FROM meetings
    WHERE verifier_version='v2-offsets' AND transcript_raw IS NOT NULL
    ORDER BY id DESC LIMIT ?
  `).all(limit);

  console.log(`=== Pattern A backfill (${meetings.length} meetings) ===`);
  const totals = { exact: 0, fuzzy: 0, ambiguous: 0, not_found: 0, processed: 0, totalCandidates: 0, jsonFails: 0 };

  for (let i = 0; i < meetings.length; i++) {
    const m = meetings[i];
    const items = db.prepare('SELECT id, title, owner_name FROM action_items WHERE meeting_id = ? ORDER BY id ASC').all(m.id);
    process.stdout.write(`[${i+1}/${meetings.length}] meeting ${m.id} (${items.length} items)  `);
    let result;
    try { result = await verifyExtraction(m.transcript_raw, items); }
    catch (e) { console.log(`FAIL — ${e.message.slice(0, 100)}`); totals.jsonFails++; await sleep(1000); continue; }

    if (result.error || !result.completeness_assessment) {
      console.log(`SKIP — ${result.error || 'no assessment'}`);
      totals.jsonFails++;
      await sleep(1000);
      continue;
    }

    const tx = m.transcript_raw.slice(0, 80_000);

    const buildEvidence = (mi) => {
      const ev = mi.evidence || {};
      const range = findAnchorRange(tx, ev.anchor_quote || '');
      const slice = (range.anchor_match_quality === 'not_found') ? null : sliceEvidence(tx, range.start_char, range.end_char);
      const out = {
        ...mi,
        evidence: {
          ...ev,
          start_char: range.start_char,
          end_char: range.end_char,
          anchor_match_quality: range.anchor_match_quality,
          anchor_match_count: range.anchor_match_count,
        },
        evidence_text: slice,
        evidence_valid: slice !== null,
        candidate_hash: canonicalCandidateHash(mi),
      };
      totals[range.anchor_match_quality] = (totals[range.anchor_match_quality] || 0) + 1;
      totals.totalCandidates++;
      return out;
    };

    const baseMissed = (result.missed_items || []).map(buildEvidence);
    const baseClient = (result.client_commitments || []).map(buildEvidence);

    // Re-run dedup classification under the existing matcher (offsets are now derived from anchors but the matching
    // signal — fingerprint + embeddings — still operates on titles + descriptions + summaries, unchanged).
    let existingWithEmb = [];
    try { existingWithEmb = await embedActionItems(items); }
    catch (e) { /* ok — dedup falls back to feature-only */ }
    const enrichedMissed = [];
    for (const c of baseMissed) {
      let dedup = { matched_action_item_id: null, match_similarity: 0, match_anchors: [], dedup_classification: 'not_duplicate', algorithm_version: 'v1-features-embeddings' };
      try { dedup = await classifyDedup(c, existingWithEmb); } catch {}
      enrichedMissed.push({ ...c, ...dedup });
    }
    const enrichedClient = [];
    for (const c of baseClient) {
      let dedup = { matched_action_item_id: null, match_similarity: 0, match_anchors: [], dedup_classification: 'not_duplicate', algorithm_version: 'v1-features-embeddings' };
      try { dedup = await classifyDedup(c, existingWithEmb); } catch {}
      enrichedClient.push({ ...c, ...dedup });
    }

    db.prepare(`
      UPDATE meetings
      SET adversarial_result = ?, client_commitments = ?,
          adversarial_run_at = datetime('now'),
          completeness_assessment = ?,
          verifier_model = ?, verifier_version = 'v2-offsets',
          updated_at = datetime('now')
      WHERE id = ?
    `).run(
      JSON.stringify({ ...result, missed_items: enrichedMissed }),
      JSON.stringify(enrichedClient),
      result.completeness_assessment || 'unknown',
      process.env.VERIFIER_MODEL || 'gemini-2.5-flash',
      m.id,
    );
    totals.processed++;
    const counts = { exact: 0, fuzzy: 0, ambiguous: 0, not_found: 0 };
    for (const e of [...enrichedMissed, ...enrichedClient]) counts[e.evidence.anchor_match_quality]++;
    console.log(`OK  ${result.completeness_assessment} | missed=${enrichedMissed.length} + client=${enrichedClient.length} | ${counts.exact}E/${counts.fuzzy}F/${counts.ambiguous}A/${counts.not_found}N`);
    await sleep(1000);
  }
  db.close();

  const total = totals.totalCandidates || 1;
  console.log();
  console.log('=== Pattern A backfill summary ===');
  console.log(`Meetings processed: ${totals.processed} / ${meetings.length}  (verifier failures: ${totals.jsonFails})`);
  console.log(`Total candidates: ${totals.totalCandidates}`);
  console.log(`Match-quality distribution:`);
  console.log(`  exact:      ${totals.exact}      (${(100*totals.exact/total).toFixed(1)}%)`);
  console.log(`  fuzzy:      ${totals.fuzzy}      (${(100*totals.fuzzy/total).toFixed(1)}%)`);
  console.log(`  ambiguous:  ${totals.ambiguous}  (${(100*totals.ambiguous/total).toFixed(1)}%)`);
  console.log(`  not_found:  ${totals.not_found}  (${(100*totals.not_found/total).toFixed(1)}%)`);
  // Escalation triggers per spec
  const nfPct = 100 * totals.not_found / total;
  const ambPct = 100 * totals.ambiguous / total;
  if (nfPct > 5) console.log(`  ⚠ ESCALATION: not_found ${nfPct.toFixed(1)}% > 5%`);
  if (ambPct > 20) console.log(`  ⚠ ESCALATION: ambiguous ${ambPct.toFixed(1)}% > 20%`);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
