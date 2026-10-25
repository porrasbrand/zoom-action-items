#!/usr/bin/env node
/**
 * One-shot backfill: re-render evidence_text on every v2-offsets meeting
 * using the new sliceEvidence (word-snap + min-150-char expansion). The
 * original start_char/end_char offsets persisted in adversarial_result and
 * client_commitments are reused — NO LLM call.
 *
 * Idempotent. Safe to re-run if sliceEvidence changes again later.
 *
 * Usage: node scripts/backfill-evidence-rerender.js [--limit 30]
 */

import 'dotenv/config';
import Database from 'better-sqlite3';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { sliceEvidence } from '../src/lib/transcript-utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'zoom-action-items.db');

const argv = process.argv.slice(2);
let limit = 30;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--limit' && argv[i + 1]) limit = parseInt(argv[++i], 10) || 30;
}

const db = new Database(DB_PATH);
const meetings = db.prepare(`
  SELECT id, transcript_raw, adversarial_result, client_commitments
  FROM meetings
  WHERE verifier_version='v2-offsets' AND adversarial_result IS NOT NULL
  ORDER BY id DESC LIMIT ?
`).all(limit);

console.log(`=== Evidence-rerender backfill (${meetings.length} meetings) ===`);

const lengths = { before: [], after: [] };
let totalItems = 0;
let processed = 0;
let validBefore = 0, validAfter = 0;

const transcriptForSlicing = (raw) => (raw || '').slice(0, 80_000);

const rerender = (item, transcriptSlice) => {
  const ev = item.evidence || {};
  const beforeText = item.evidence_text || '';
  const afterText = sliceEvidence(transcriptSlice, ev.start_char, ev.end_char);
  lengths.before.push(beforeText.length);
  lengths.after.push((afterText || '').length);
  if ((beforeText || '').length >= 5) validBefore++;
  if ((afterText || '').length >= 5) validAfter++;
  return {
    ...item,
    evidence_text: afterText,
    evidence_valid: afterText !== null,
  };
};

for (let i = 0; i < meetings.length; i++) {
  const m = meetings[i];
  const tx = transcriptForSlicing(m.transcript_raw);
  let adv;  try { adv = JSON.parse(m.adversarial_result); } catch { console.log(`[${i+1}/${meetings.length}] ${m.id}: skip (bad adv JSON)`); continue; }
  let client; try { client = JSON.parse(m.client_commitments || '[]'); } catch { client = []; }

  const newMissed = (adv.missed_items || []).map(it => rerender(it, tx));
  const newClient = client.map(it => rerender(it, tx));
  totalItems += newMissed.length + newClient.length;

  adv.missed_items = newMissed;
  db.prepare(`UPDATE meetings SET adversarial_result = ?, client_commitments = ?, updated_at = datetime('now') WHERE id = ?`).run(
    JSON.stringify(adv), JSON.stringify(newClient), m.id,
  );
  processed++;
  console.log(`[${i+1}/${meetings.length}] meeting ${m.id}: ${newMissed.length} missed + ${newClient.length} client re-rendered`);
}

db.close();

const stats = (arr) => {
  if (!arr.length) return { mean: 0, median: 0, min: 0, max: 0 };
  const sorted = [...arr].sort((a,b)=>a-b);
  return {
    mean: Math.round(arr.reduce((s,x)=>s+x,0) / arr.length),
    median: sorted[Math.floor(sorted.length/2)],
    min: sorted[0],
    max: sorted[sorted.length-1],
  };
};

console.log();
console.log('=== Summary ===');
console.log(`Meetings processed: ${processed}`);
console.log(`Total candidates re-rendered: ${totalItems}`);
console.log(`Length stats (chars):`);
console.log(`  BEFORE: ${JSON.stringify(stats(lengths.before))}`);
console.log(`  AFTER:  ${JSON.stringify(stats(lengths.after))}`);
console.log(`Items with non-null evidence_text — before: ${validBefore}, after: ${validAfter}`);
const under150Before = lengths.before.filter(n => n > 0 && n < 150).length;
const under150After  = lengths.after.filter(n => n > 0 && n < 150).length;
console.log(`Items shorter than 150 chars — before: ${under150Before}, after: ${under150After}`);
