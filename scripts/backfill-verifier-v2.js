#!/usr/bin/env node
/**
 * Path-C backfill — re-run the verifier on the last N meetings under the
 * new offset evidence schema. Updates meetings.adversarial_result + .client_commitments
 * + .completeness_assessment + .confidence_signal + .verifier_model + .verifier_version.
 *
 * Usage:
 *   node scripts/backfill-verifier-v2.js [--limit 30] [--include-verified]
 *
 * Defaults to processing the most recent 30 meetings that don't already have
 * verifier_version='v2-offsets'. Throttles 1s between meetings (Tier-1+ Gemini
 * has plenty of headroom but we don't want to bombard).
 */

import 'dotenv/config';
import Database from 'better-sqlite3';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { verifyExtraction } from '../src/lib/adversarial-verifier.js';
import { sliceEvidence, canonicalCandidateHash } from '../src/lib/transcript-utils.js';
import { calculateConfidence } from '../src/lib/confidence-calculator.js';
import { scanTranscript } from '../src/lib/keyword-scanner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'zoom-action-items.db');

const argv = process.argv.slice(2);
let limit = 30;
let includeVerified = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--limit' && argv[i + 1]) limit = parseInt(argv[++i], 10) || 30;
  if (argv[i] === '--include-verified') includeVerified = true;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function main() {
  const db = new Database(DB_PATH);
  const where = includeVerified
    ? `transcript_raw IS NOT NULL AND length(transcript_raw) > 500`
    : `transcript_raw IS NOT NULL AND length(transcript_raw) > 500 AND (verifier_version IS NULL OR verifier_version != 'v2-offsets')`;
  const meetings = db.prepare(`
    SELECT id, topic, transcript_raw, confidence_signal AS old_signal
    FROM meetings WHERE ${where}
    ORDER BY id DESC LIMIT ?
  `).all(limit);

  console.log(`=== Backfill (${meetings.length} meetings) ===`);
  let processed = 0, totalMissed = 0, totalValid = 0, totalHigh = 0, totalClient = 0;
  const flips = [];
  for (let i = 0; i < meetings.length; i++) {
    const m = meetings[i];
    const items = db.prepare('SELECT id, title, owner_name FROM action_items WHERE meeting_id = ? ORDER BY id').all(m.id);
    process.stdout.write(`[${i+1}/${meetings.length}] meeting id=${m.id} (${items.length} items)  `);
    try {
      const result = await verifyExtraction(m.transcript_raw, items);
      const missed = (result.missed_items || []).map(mi => {
        const ev = mi.evidence || {};
        const slice = sliceEvidence(m.transcript_raw, ev.start_char, ev.end_char);
        return { ...mi, evidence_text: slice, evidence_valid: slice !== null, candidate_hash: canonicalCandidateHash(mi) };
      });
      const clientComm = (result.client_commitments || []).map(mi => {
        const ev = mi.evidence || {};
        const slice = sliceEvidence(m.transcript_raw, ev.start_char, ev.end_char);
        return { ...mi, evidence_text: slice, evidence_valid: slice !== null, candidate_hash: canonicalCandidateHash(mi) };
      });
      const valid = missed.filter(x => x.evidence_valid).length;
      const high = missed.filter(x => x.confidence === 'HIGH' && x.evidence_valid).length;
      const scan = scanTranscript(m.transcript_raw);
      const confidence = calculateConfidence(scan, items.length, m.transcript_raw, 'completed', {
        completeness_assessment: result.completeness_assessment,
        missed_items: missed,
      });
      db.prepare(`
        UPDATE meetings
        SET adversarial_result = ?, client_commitments = ?,
            adversarial_run_at = datetime('now'),
            completeness_assessment = ?, confidence_signal = ?,
            verifier_model = ?, verifier_version = 'v2-offsets',
            updated_at = datetime('now')
        WHERE id = ?
      `).run(
        JSON.stringify({ ...result, missed_items: missed }),
        JSON.stringify(clientComm),
        result.completeness_assessment || 'unknown',
        confidence.signal,
        process.env.VERIFIER_MODEL || 'gemini-2.0-flash',
        m.id,
      );
      totalMissed += missed.length;
      totalValid += valid;
      totalHigh += high;
      totalClient += clientComm.length;
      processed++;
      if (m.old_signal !== confidence.signal) flips.push({ id: m.id, before: m.old_signal, after: confidence.signal });
      console.log(`OK  ${result.completeness_assessment} | missed=${missed.length} (${valid} grounded, ${high} HIGH) | client=${clientComm.length} | signal ${m.old_signal||'?'} → ${confidence.signal}`);
    } catch (err) {
      console.log(`FAIL — ${err.message.slice(0, 120)}`);
    }
    if (i < meetings.length - 1) await sleep(1000);
  }
  db.close();

  console.log();
  console.log(`=== Backfill summary ===`);
  console.log(`Processed: ${processed} / ${meetings.length}`);
  console.log(`Total missed_items: ${totalMissed}  (valid offsets: ${totalValid}, HIGH: ${totalHigh})`);
  console.log(`Total client_commitments: ${totalClient}`);
  console.log(`Signal flips: ${flips.length}`);
  for (const f of flips) console.log(`  meeting ${f.id}: ${f.before||'-'} → ${f.after}`);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
