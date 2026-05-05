#!/usr/bin/env node
/**
 * A/B replay: Gemini gemini-2.5-flash vs OpenAI gpt-5.4-mini on the same
 * 19 historical title-edit replay set.
 *
 * Production styler stays on OpenAI (per commit 30f0a3f). This script is a
 * standalone read-only comparison run after Gemini billing was activated, to
 * see whether switching back is worth it.
 *
 * Imports SYSTEM_PROMPT + sanitize + looksLikePhilFormula from the production
 * styler module so the prompt + helpers are guaranteed identical to live.
 */

import 'dotenv/config';
import Database from 'better-sqlite3';
import { writeFileSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenerativeAI } from '@google/generative-ai';
import {
  SYSTEM_PROMPT,
  sanitize,
  looksLikePhilFormula,
} from '../src/lib/title-styler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'zoom-action-items.db');
const CLIENTS_PATH = join(__dirname, '..', 'src', 'config', 'clients.json');
const OPENAI_BASELINE = join(process.env.HOME || '/home/ubuntu', 'super-agent-shared', 'title-styler-replay.json');
const OUT_JSON = join(process.env.HOME || '/home/ubuntu', 'super-agent-shared', 'title-styler-gemini-replay.json');
const OUT_MD = join(process.env.HOME || '/home/ubuntu', 'super-agent-shared', 'title-styler-gemini-replay.md');

const argv = process.argv.slice(2);
let limit = 30;
let perCallDelayMs = 200; // Gemini billing tier should easily handle this
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--limit' && argv[i + 1]) limit = parseInt(argv[++i], 10) || 30;
  if (argv[i] === '--delay-ms' && argv[i + 1]) perCallDelayMs = parseInt(argv[++i], 10) || 200;
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
  } catch { return []; }
}

function buildWideExcerpt(rawTranscript, narrowExcerpt, windowChars = 8000) {
  if (!rawTranscript) return narrowExcerpt || '';
  const half = Math.floor(windowChars / 2);
  if (narrowExcerpt) {
    const probe = String(narrowExcerpt).slice(0, 80).trim();
    const idx = probe ? rawTranscript.indexOf(probe) : -1;
    if (idx >= 0) {
      const start = Math.max(0, idx - half);
      const end = Math.min(rawTranscript.length, idx + half);
      return rawTranscript.slice(start, end);
    }
  }
  return rawTranscript.slice(0, windowChars);
}

// ─── Gemini client (standalone, mirrors production styler config) ───
const geminiKey = process.env.GOOGLE_API_KEY;
if (!geminiKey) { console.error('Missing GOOGLE_API_KEY'); process.exit(1); }
const genAI = new GoogleGenerativeAI(geminiKey);
const modelId = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const gemini = genAI.getGenerativeModel({
  model: modelId,
  generationConfig: {
    temperature: 0.2,
    maxOutputTokens: 1024,
    thinkingConfig: { thinkingBudget: 0 },
  },
});

async function styleWithGemini({ rawTitle, ownerName, clientName, transcriptExcerpt, taskType }) {
  if (!rawTitle || String(rawTitle).trim().length < 3) return { styled: rawTitle, usage: null };
  if (looksLikePhilFormula(rawTitle)) return { styled: rawTitle, usage: null, passthrough: true };

  const userMsg = `raw_title: ${JSON.stringify(rawTitle)}
owner: ${JSON.stringify(ownerName || '')}
client: ${JSON.stringify(clientName || '')}
task_type: ${JSON.stringify(taskType || '')}
transcript_excerpt: ${JSON.stringify((transcriptExcerpt || '').slice(0, 8000))}

styled:`;
  const result = await gemini.generateContent({
    contents: [{ role: 'user', parts: [{ text: SYSTEM_PROMPT + '\n\n' + userMsg }] }],
  });
  const text = result?.response?.text?.() || '';
  const cleaned = sanitize(text);
  const usage = result?.response?.usageMetadata || null;
  if (!cleaned || cleaned.length < 5 || cleaned.length > 200) {
    return { styled: rawTitle, usage, outOfBounds: true };
  }
  return { styled: cleaned, usage };
}

// ─── 1. Sample call to confirm billing tier ───
console.log('=== STEP 1: Gemini billing-tier sample call ===');
let billingOk = false;
let sampleErr = null;
try {
  const r = await gemini.generateContent({
    contents: [{ role: 'user', parts: [{ text: 'Reply with exactly: ok' }] }],
  });
  const txt = r?.response?.text?.() || '';
  const usage = r?.response?.usageMetadata || {};
  console.log(`status: 200 | model: ${modelId} | reply: ${JSON.stringify(txt.trim())}`);
  console.log(`usage: prompt=${usage.promptTokenCount} candidate=${usage.candidatesTokenCount} total=${usage.totalTokenCount}`);
  billingOk = true;
} catch (e) {
  sampleErr = e.message;
  console.log(`status: ERROR | ${sampleErr}`);
  if (/free_tier/.test(sampleErr)) {
    console.log('  → still on FREE TIER. Billing not active.');
  }
}
console.log();

if (!billingOk) {
  console.log('Aborting replay — Gemini billing not confirmed.');
  writeFileSync(OUT_JSON, JSON.stringify({ billingOk: false, sampleErr }, null, 2));
  process.exit(2);
}

// ─── 2. Read replay set (same query as test-title-styler.js) ───
const db = new Database(DB_PATH, { readonly: true });
const clients = loadClients();
const clientNameById = new Map(clients.map(c => [c.id, c.name]));
const rows = db.prepare(`
  SELECT
    e.id              AS edit_id,
    e.action_item_id,
    e.field,
    e.new_value       AS phil_actual_title,
    e.edit_classification,
    ai.snapshot_title AS snapshot_title,
    ai.owner_name     AS owner_name,
    ai.client_id      AS client_id,
    ai.task_type      AS task_type,
    ai.transcript_excerpt AS transcript_excerpt,
    ai.meeting_id     AS meeting_id,
    m.transcript_raw  AS meeting_transcript_raw
  FROM action_item_edits e
  JOIN action_items ai ON ai.id = e.action_item_id
  LEFT JOIN meetings m ON m.id = ai.meeting_id
  WHERE e.field = 'title'
    AND e.edit_classification IN ('structural','tonal','unknown')
    AND ai.snapshot_title IS NOT NULL
    AND length(trim(ai.snapshot_title)) > 0
    AND e.new_value IS NOT NULL
    AND length(trim(e.new_value)) > 0
  ORDER BY e.captured_at DESC
  LIMIT ?
`).all(limit);

console.log(`=== STEP 2: Gemini replay (${rows.length} items) ===`);

let countHit = 0, countPartial = 0, countMiss = 0;
let totalPromptTokens = 0, totalCompletionTokens = 0;
const results = [];

for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  const clientName = clientNameById.get(r.client_id) || r.client_id || '';
  const rawTitle = r.snapshot_title || '';
  const passthroughExpected = looksLikePhilFormula(rawTitle);
  const wideExcerpt = buildWideExcerpt(r.meeting_transcript_raw, r.transcript_excerpt, 8000);
  let styled = '';
  let usage = null;
  let error = null;
  try {
    const out = await styleWithGemini({
      rawTitle,
      ownerName: r.owner_name || '',
      clientName,
      transcriptExcerpt: wideExcerpt,
      taskType: r.task_type || '',
    });
    styled = out.styled;
    usage = out.usage;
    if (usage) {
      totalPromptTokens += usage.promptTokenCount || 0;
      totalCompletionTokens += usage.candidatesTokenCount || 0;
    }
  } catch (e) {
    error = e.message;
    styled = rawTitle;
  }

  const philActual = decodeEntities(decodeEntities(r.phil_actual_title || ''));
  const cls = classify(styled, philActual);
  if (cls.tier === 'HIT') countHit++;
  else if (cls.tier === 'PARTIAL') countPartial++;
  else countMiss++;

  results.push({
    idx: i + 1,
    action_item_id: r.action_item_id,
    raw: rawTitle,
    phil: philActual,
    styled,
    tier: cls.tier,
    distance: cls.distance,
    ratio: Number(cls.ratio.toFixed(3)),
    passthrough: passthroughExpected,
    usage,
    error,
  });

  process.stdout.write(`  [${i + 1}/${rows.length}] ${cls.tier}  ai=${r.action_item_id}\n`);
  if (i < rows.length - 1) await sleep(perCallDelayMs);
}
db.close();

const total = results.length;
const pctHit = (100 * countHit / total).toFixed(1);
const pctPartial = (100 * countPartial / total).toFixed(1);
const pctMiss = (100 * countMiss / total).toFixed(1);
const pctHitPlusPartial = (100 * (countHit + countPartial) / total).toFixed(1);

// ─── 3. Cost estimate ───
// Gemini 2.5 Flash (paid): $0.30 / 1M input tokens, $2.50 / 1M output tokens (approx, public list)
// OpenAI gpt-5.4-mini: $0.25 / 1M input tokens, $2.00 / 1M output tokens (approx)
const GEMINI_IN = 0.30 / 1_000_000;
const GEMINI_OUT = 2.50 / 1_000_000;
const OPENAI_IN = 0.25 / 1_000_000;
const OPENAI_OUT = 2.00 / 1_000_000;

// OpenAI baseline tokens — pull from baseline JSON if it has them; else assume similar to Gemini
let openaiBaseline = null;
try { openaiBaseline = JSON.parse(readFileSync(OPENAI_BASELINE, 'utf8')); } catch {}

const geminiCostPerCall = ((totalPromptTokens / Math.max(1, results.length)) * GEMINI_IN +
                          (totalCompletionTokens / Math.max(1, results.length)) * GEMINI_OUT);
// Approximate OpenAI cost-per-call using same input/output token averages (we don't capture per-call usage in the prior baseline)
const openaiCostPerCallEstimate = ((totalPromptTokens / Math.max(1, results.length)) * OPENAI_IN +
                                   (totalCompletionTokens / Math.max(1, results.length)) * OPENAI_OUT);

// ─── 4. Side-by-side ───
console.log();
console.log('=== STEP 3: Side-by-side ===');
console.log(`Gemini-2.5-flash (this run):  HIT ${countHit} (${pctHit}%) | PARTIAL ${countPartial} (${pctPartial}%) | MISS ${countMiss} (${pctMiss}%) | HIT+PARTIAL ${pctHitPlusPartial}%`);
if (openaiBaseline) {
  const ob = openaiBaseline.pct;
  console.log(`OpenAI gpt-5.4-mini (baseline): HIT ${openaiBaseline.counts.HIT} (${ob.HIT}%) | PARTIAL ${openaiBaseline.counts.PARTIAL} (${ob.PARTIAL}%) | MISS ${openaiBaseline.counts.MISS} (${ob.MISS}%) | HIT+PARTIAL ${ob.HIT_PLUS_PARTIAL}%`);
}

console.log();
console.log('=== STEP 4: Cost estimate ===');
console.log(`Gemini avg tokens: in=${(totalPromptTokens/total).toFixed(0)} out=${(totalCompletionTokens/total).toFixed(0)} → ~$${geminiCostPerCall.toFixed(6)}/call`);
console.log(`OpenAI estimate (assuming similar token counts): ~$${openaiCostPerCallEstimate.toFixed(6)}/call`);

const out = {
  generated_at: new Date().toISOString(),
  billing_ok: true,
  total,
  gemini: {
    counts: { HIT: countHit, PARTIAL: countPartial, MISS: countMiss },
    pct: { HIT: +pctHit, PARTIAL: +pctPartial, MISS: +pctMiss, HIT_PLUS_PARTIAL: +pctHitPlusPartial },
    avg_tokens_in: Math.round(totalPromptTokens / total),
    avg_tokens_out: Math.round(totalCompletionTokens / total),
    cost_per_call_usd: Number(geminiCostPerCall.toFixed(6)),
  },
  openai_baseline: openaiBaseline ? {
    counts: openaiBaseline.counts,
    pct: openaiBaseline.pct,
    cost_per_call_usd_estimate: Number(openaiCostPerCallEstimate.toFixed(6)),
  } : null,
  results,
};
writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));

const md = [
  `# Gemini vs OpenAI A/B Replay`,
  ``,
  `_${out.generated_at}_`,
  ``,
  `## Headline`,
  ``,
  `- Gemini gemini-2.5-flash:  HIT+PARTIAL **${pctHitPlusPartial}%**`,
  openaiBaseline ? `- OpenAI gpt-5.4-mini:        HIT+PARTIAL **${openaiBaseline.pct.HIT_PLUS_PARTIAL}%**` : '',
  ``,
  `## Cost / call`,
  ``,
  `- Gemini: ~$${geminiCostPerCall.toFixed(6)}`,
  `- OpenAI estimate: ~$${openaiCostPerCallEstimate.toFixed(6)}`,
  ``,
  `## Hits + partials (Gemini side)`,
  ...results.filter(r => r.tier !== 'MISS').slice(0, 10).flatMap(r => [
    `- ai=${r.action_item_id} (${r.tier}): styled=${JSON.stringify(r.styled)} | phil=${JSON.stringify(r.phil)}`,
  ]),
].filter(Boolean).join('\n');
writeFileSync(OUT_MD, md);

console.log();
console.log(`Wrote: ${OUT_JSON}`);
console.log(`Wrote: ${OUT_MD}`);
