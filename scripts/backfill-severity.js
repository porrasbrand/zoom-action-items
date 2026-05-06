#!/usr/bin/env node
/**
 * One-shot severity backfill for Path-C-3.
 *
 * For every v2-offsets meeting, takes the existing missed_items +
 * client_commitments and asks gpt-5.4-mini to assign severity per item
 * (catastrophic / important / nice-to-have). Cheaper than re-running
 * the full verifier — we just need 1 small LLM call per meeting that
 * returns a severity per item title.
 *
 * Falls back to 'important' for items the call fails to classify.
 *
 * Idempotent: re-running re-classifies. Safe.
 *
 * Usage: node scripts/backfill-severity.js [--limit 30]
 */

import 'dotenv/config';
import Database from 'better-sqlite3';
import OpenAI from 'openai';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'zoom-action-items.db');

const argv = process.argv.slice(2);
let limit = 30;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--limit' && argv[i + 1]) limit = parseInt(argv[++i], 10) || 30;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const SYSTEM_PROMPT = `You assign severity tags to B3X action item commitments.

Severity definitions:
  catastrophic — Missing this would directly damage the client relationship OR cost B3X significant revenue. Examples: missed contract review, unpaid invoice follow-up, broken promise about a deliverable, commitment with money/contract/legal stakes.
  important    — Missing this would cause friction, delay, or rework. Most operational commitments fall here.
  nice-to-have — Discussed but low-stakes. Casual mentions, ideas-to-explore, informal "we should look into X".

Be CONSERVATIVE with 'catastrophic'. When in doubt, choose 'important'.

Output strict JSON:
{
  "items": [
    { "id": <integer index>, "severity": "catastrophic" | "important" | "nice-to-have" }
  ]
}

(Use the integer 'id' field exactly as provided in the input list.)`;

async function classifyMeeting(client, items) {
  if (!items.length) return [];
  const userMsg = JSON.stringify({
    items: items.map((it, i) => ({
      id: i,
      title: it.title || '',
      owner: it.owner || '',
      reasoning: it.reasoning || '',
      evidence_summary: it?.evidence?.summary || '',
    })),
  });
  try {
    const res = await client.chat.completions.create({
      model: process.env.SEVERITY_MODEL || 'gpt-5.4-mini',
      temperature: 0.1,
      max_completion_tokens: 1200,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMsg },
      ],
    });
    const parsed = JSON.parse(res.choices[0].message.content);
    return Array.isArray(parsed.items) ? parsed.items : [];
  } catch (err) {
    console.warn('  severity LLM failed:', err.message);
    return [];
  }
}

function applySeverity(items, sevList) {
  const byId = new Map();
  for (const s of sevList) {
    if (Number.isFinite(s.id) && ['catastrophic','important','nice-to-have'].includes(s.severity)) {
      byId.set(s.id, s.severity);
    }
  }
  return items.map((it, i) => ({ ...it, severity: byId.get(i) || it.severity || 'important' }));
}

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error('Missing OPENAI_API_KEY');
    process.exit(1);
  }
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const db = new Database(DB_PATH);
  const meetings = db.prepare(`
    SELECT id, topic, adversarial_result, client_commitments
    FROM meetings WHERE verifier_version='v2-offsets' AND adversarial_result IS NOT NULL
    ORDER BY id DESC LIMIT ?
  `).all(limit);

  console.log(`=== Severity backfill (${meetings.length} meetings) ===`);
  const totals = { catastrophic: 0, important: 0, 'nice-to-have': 0, processed: 0 };
  for (let i = 0; i < meetings.length; i++) {
    const m = meetings[i];
    let adv; try { adv = JSON.parse(m.adversarial_result); } catch { console.log(`[${i+1}/${meetings.length}] ${m.id}: skip (bad JSON)`); continue; }
    let clientArr; try { clientArr = JSON.parse(m.client_commitments || '[]'); } catch { clientArr = []; }
    const missed = adv.missed_items || [];
    const all = [...missed, ...clientArr];
    if (!all.length) {
      console.log(`[${i+1}/${meetings.length}] ${m.id}: 0 candidates, skip`);
      continue;
    }
    const sevList = await classifyMeeting(client, all);
    const enrichedAll = applySeverity(all, sevList);
    const enrichedMissed = enrichedAll.slice(0, missed.length);
    const enrichedClient = enrichedAll.slice(missed.length);
    adv.missed_items = enrichedMissed;
    db.prepare(`UPDATE meetings SET adversarial_result = ?, client_commitments = ?, updated_at = datetime('now') WHERE id = ?`).run(
      JSON.stringify(adv), JSON.stringify(enrichedClient), m.id,
    );
    const counts = { catastrophic: 0, important: 0, 'nice-to-have': 0 };
    for (const it of enrichedAll) counts[it.severity || 'important']++;
    totals.catastrophic += counts.catastrophic;
    totals.important += counts.important;
    totals['nice-to-have'] += counts['nice-to-have'];
    totals.processed++;
    console.log(`[${i+1}/${meetings.length}] meeting ${m.id}: ${enrichedAll.length} items → ${counts.catastrophic} cat / ${counts.important} imp / ${counts['nice-to-have']} nice`);
    await sleep(500);
  }
  db.close();
  console.log();
  console.log('=== Summary ===');
  console.log(`Meetings processed: ${totals.processed}`);
  const total = totals.catastrophic + totals.important + totals['nice-to-have'];
  console.log(`Total items tagged: ${total}`);
  console.log(`  catastrophic: ${totals.catastrophic} (${total ? (100*totals.catastrophic/total).toFixed(1) : 0}%)`);
  console.log(`  important:    ${totals.important} (${total ? (100*totals.important/total).toFixed(1) : 0}%)`);
  console.log(`  nice-to-have: ${totals['nice-to-have']} (${total ? (100*totals['nice-to-have']/total).toFixed(1) : 0}%)`);
  if (total > 0) {
    const catPct = 100 * totals.catastrophic / total;
    if (catPct > 50) console.log(`  ESCALATION: ${catPct.toFixed(1)}% catastrophic > 50% threshold`);
  }
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
