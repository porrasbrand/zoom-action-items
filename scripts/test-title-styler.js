#!/usr/bin/env node
/**
 * Replay-validation harness for the Phil-style title generator.
 *
 * Read-only — does NOT modify any DB rows. For each historical title-edit,
 * we re-run the styler against the snapshot title + context and compare the
 * styler's output to Phil's actual rewrite. We then bucket the result as:
 *
 *   HIT     — styled string is a (case-insensitive) exact match
 *   PARTIAL — styled string is within 30% of Phil's by Levenshtein distance
 *   MISS    — anything else
 *
 * Decision rule (per spec): ship enabled iff HIT+PARTIAL >= 60%.
 *
 * Output:
 *   ~/super-agent-shared/title-styler-replay.json
 *   ~/super-agent-shared/title-styler-replay.md
 *
 * Usage:
 *   node scripts/test-title-styler.js [--limit 30]
 */

import 'dotenv/config';
import Database from 'better-sqlite3';
import { writeFileSync, readFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { styleTitleForce, looksLikePhilFormula } from '../src/lib/title-styler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'zoom-action-items.db');
const CLIENTS_PATH = join(__dirname, '..', 'src', 'config', 'clients.json');
const OUT_DIR = join(process.env.HOME || '/home/ubuntu', 'super-agent-shared');
const OUT_JSON = join(OUT_DIR, 'title-styler-replay.json');
const OUT_MD = join(OUT_DIR, 'title-styler-replay.md');

const argv = process.argv.slice(2);
let limit = 30;
// Free-tier Gemini = 5 RPM. Pace ourselves at ~14s/call with extra slack on retry.
let perCallDelayMs = 14000;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--limit' && argv[i + 1]) limit = parseInt(argv[++i], 10) || 30;
  if (argv[i] === '--delay-ms' && argv[i + 1]) perCallDelayMs = parseInt(argv[++i], 10) || 14000;
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a) return b ? b.length : 0;
  if (!b) return a.length;
  const al = a.length, bl = b.length;
  let v0 = new Array(bl + 1);
  let v1 = new Array(bl + 1);
  for (let j = 0; j <= bl; j++) v0[j] = j;
  for (let i = 0; i < al; i++) {
    v1[0] = i + 1;
    for (let j = 0; j < bl; j++) {
      const cost = a.charCodeAt(i) === b.charCodeAt(j) ? 0 : 1;
      v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
    }
    [v0, v1] = [v1, v0];
  }
  return v0[bl];
}

function decodeEntities(s) {
  if (!s) return '';
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

function normalize(s) {
  if (!s) return '';
  let t = decodeEntities(String(s));
  if (t.includes('&amp;') || t.includes('&lt;')) t = decodeEntities(t);
  return t.replace(/\s+/g, ' ').trim().toLowerCase();
}

function classify(styled, philActual) {
  const ns = normalize(styled);
  const np = normalize(philActual);
  if (!ns || !np) return { tier: 'MISS', distance: -1, ratio: 1 };
  if (ns === np) return { tier: 'HIT', distance: 0, ratio: 0 };
  const d = levenshtein(ns, np);
  const maxLen = Math.max(ns.length, np.length);
  const ratio = d / maxLen;
  if (ratio < 0.30) return { tier: 'PARTIAL', distance: d, ratio };
  return { tier: 'MISS', distance: d, ratio };
}

function loadClients() {
  try {
    const data = JSON.parse(readFileSync(CLIENTS_PATH, 'utf8'));
    return data.clients || [];
  } catch {
    return [];
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });

  const db = new Database(DB_PATH, { readonly: true });
  const clients = loadClients();
  const clientNameById = new Map(clients.map(c => [c.id, c.name]));

  const rows = db.prepare(`
    SELECT
      e.id          AS edit_id,
      e.action_item_id,
      e.field,
      e.new_value   AS phil_actual_title,
      e.edit_classification,
      ai.title           AS db_current_title,
      ai.snapshot_title  AS snapshot_title,
      ai.owner_name      AS owner_name,
      ai.client_id       AS client_id,
      ai.task_type       AS task_type,
      ai.transcript_excerpt AS transcript_excerpt,
      ai.ph_task_id      AS ph_task_id
    FROM action_item_edits e
    JOIN action_items ai ON ai.id = e.action_item_id
    WHERE e.field = 'title'
      AND e.edit_classification IN ('structural','tonal','unknown')
      AND ai.snapshot_title IS NOT NULL
      AND length(trim(ai.snapshot_title)) > 0
      AND e.new_value IS NOT NULL
      AND length(trim(e.new_value)) > 0
    ORDER BY e.captured_at DESC
    LIMIT ?
  `).all(limit);

  if (!rows.length) {
    console.error('No title edits found — cannot run replay test.');
    process.exit(2);
  }

  console.log(`Replaying ${rows.length} historical title edits…`);

  const results = [];
  let countHit = 0, countPartial = 0, countMiss = 0;
  let countPassthrough = 0;

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const clientName = clientNameById.get(r.client_id) || r.client_id || '';
    const rawTitle = r.snapshot_title || '';

    const passthroughExpected = looksLikePhilFormula(rawTitle);
    let styled = '';
    let error = null;
    let attempts = 0;
    let succeeded = false;
    while (attempts < 3 && !succeeded) {
      attempts++;
      try {
        styled = await styleTitleForce({
          rawTitle,
          ownerName: r.owner_name || '',
          clientName,
          transcriptExcerpt: r.transcript_excerpt || '',
          taskType: r.task_type || '',
        });
        // styleTitle returns rawTitle on internal LLM failure; detect 429 by re-checking equality + a known signal would be tricky.
        // Heuristic: on first attempt only, if the returned value === rawTitle AND passthroughExpected is false,
        // assume the styler internally swallowed an error; retry after backoff.
        if (styled === rawTitle && !passthroughExpected && attempts === 1) {
          await sleep(60000);
          continue;
        }
        succeeded = true;
      } catch (e) {
        error = e.message;
        styled = rawTitle;
        if (attempts < 3) await sleep(60000);
      }
    }

    const philActual = decodeEntities(decodeEntities(r.phil_actual_title || ''));
    const cls = classify(styled, philActual);

    if (cls.tier === 'HIT') countHit++;
    else if (cls.tier === 'PARTIAL') countPartial++;
    else countMiss++;
    if (passthroughExpected && styled === rawTitle) countPassthrough++;

    results.push({
      idx: i + 1,
      action_item_id: r.action_item_id,
      ph_task_id: r.ph_task_id,
      classification_in_db: r.edit_classification,
      raw_snapshot_title: rawTitle,
      owner_name: r.owner_name,
      client_id: r.client_id,
      client_name: clientName,
      phil_actual: philActual,
      styled,
      tier: cls.tier,
      distance: cls.distance,
      ratio: Number(cls.ratio.toFixed(3)),
      passthrough_expected: passthroughExpected,
      error,
    });

    process.stdout.write(`  [${i + 1}/${rows.length}] ${cls.tier}  ai=${r.action_item_id} (attempts=${attempts})\n`);
    if (i < rows.length - 1) await sleep(perCallDelayMs);
  }
  db.close();

  const total = results.length;
  const pctHit = (100 * countHit / total).toFixed(1);
  const pctPartial = (100 * countPartial / total).toFixed(1);
  const pctMiss = (100 * countMiss / total).toFixed(1);
  const hitPlusPartial = countHit + countPartial;
  const pctHitPlusPartial = (100 * hitPlusPartial / total).toFixed(1);
  const decision = hitPlusPartial / total >= 0.6
    ? 'SHIP-ENABLED'
    : 'HOLD-OFF';

  const json = {
    generated_at: new Date().toISOString(),
    total,
    counts: { HIT: countHit, PARTIAL: countPartial, MISS: countMiss },
    pct: { HIT: +pctHit, PARTIAL: +pctPartial, MISS: +pctMiss, HIT_PLUS_PARTIAL: +pctHitPlusPartial },
    threshold: 60,
    decision,
    passthrough_count: countPassthrough,
    results,
  };
  writeFileSync(OUT_JSON, JSON.stringify(json, null, 2));

  const hits = results.filter(r => r.tier === 'HIT').slice(0, 5);
  const partials = results.filter(r => r.tier === 'PARTIAL').slice(0, 5);
  const misses = results.filter(r => r.tier === 'MISS').slice(0, 5);

  const md = [
    `# Title-Styler Replay Test`,
    ``,
    `_Generated: ${new Date().toISOString()}_`,
    ``,
    `## Headline`,
    ``,
    `- Total: **${total}** historical title edits replayed`,
    `- HIT: **${countHit}** (${pctHit}%)`,
    `- PARTIAL: **${countPartial}** (${pctPartial}%)`,
    `- MISS: **${countMiss}** (${pctMiss}%)`,
    `- HIT+PARTIAL: **${pctHitPlusPartial}%** vs threshold **60%**`,
    `- Decision: **${decision}**`,
    ``,
    `## Top hits`,
    ``,
    ...hits.flatMap(h => [
      `### ai=${h.action_item_id} (${h.classification_in_db})`,
      ``,
      `- raw: ${JSON.stringify(h.raw_snapshot_title)}`,
      `- phil: ${JSON.stringify(h.phil_actual)}`,
      `- styled: ${JSON.stringify(h.styled)}`,
      `- distance=${h.distance}  ratio=${h.ratio}`,
      ``,
    ]),
    `## Top partials`,
    ``,
    ...partials.flatMap(h => [
      `### ai=${h.action_item_id} (${h.classification_in_db})`,
      ``,
      `- raw: ${JSON.stringify(h.raw_snapshot_title)}`,
      `- phil: ${JSON.stringify(h.phil_actual)}`,
      `- styled: ${JSON.stringify(h.styled)}`,
      `- distance=${h.distance}  ratio=${h.ratio}`,
      ``,
    ]),
    `## Top misses`,
    ``,
    ...misses.flatMap(h => [
      `### ai=${h.action_item_id} (${h.classification_in_db})`,
      ``,
      `- raw: ${JSON.stringify(h.raw_snapshot_title)}`,
      `- phil: ${JSON.stringify(h.phil_actual)}`,
      `- styled: ${JSON.stringify(h.styled)}`,
      `- distance=${h.distance}  ratio=${h.ratio}`,
      ``,
    ]),
  ].join('\n');
  writeFileSync(OUT_MD, md);

  console.log(`\n=== Replay summary ===`);
  console.log(`HIT: ${countHit} (${pctHit}%)`);
  console.log(`PARTIAL: ${countPartial} (${pctPartial}%)`);
  console.log(`MISS: ${countMiss} (${pctMiss}%)`);
  console.log(`HIT+PARTIAL: ${pctHitPlusPartial}% (threshold 60%)`);
  console.log(`Decision: ${decision}`);
  console.log(`Wrote: ${OUT_JSON}`);
  console.log(`Wrote: ${OUT_MD}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
