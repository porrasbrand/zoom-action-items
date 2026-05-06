#!/usr/bin/env node
/**
 * Phase 1 of the Path-C verifier upgrade — offset-based evidence shootout.
 *
 * Re-runs the 4-Gemini-model bake-off from scripts/verifier-shootout.js but
 * imports the NEW offset-schema ADVERSARIAL_PROMPT from the production verifier
 * module, validates start_char/end_char from each missed_item against the actual
 * transcript, and slices the evidence text deterministically. No verbatim grep —
 * paraphrase no longer punishes models. Per OpenAI/GPT-5.2 consult.
 *
 * Decision rule (auto):
 *   Pick model with highest valid-offset HIGH-confidence missed-item count,
 *   subject to malformed-offset rate ≤ 15%. Tiebreaker: lower malformed rate,
 *   then lower median latency, then lower cost.
 *
 * Output:
 *   ~/super-agent-shared/verifier-shootout-offsets.json
 *   ~/super-agent-shared/verifier-shootout-offsets.md
 */

import 'dotenv/config';
import Database from 'better-sqlite3';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { ADVERSARIAL_PROMPT } from '../src/lib/adversarial-verifier.js';
import { sliceEvidence, canonicalCandidateHash } from '../src/lib/transcript-utils.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'zoom-action-items.db');
const OUT_DIR = join(process.env.HOME || '/home/ubuntu', 'super-agent-shared');
const OUT_JSON = join(OUT_DIR, 'verifier-shootout-offsets.json');
const OUT_MD = join(OUT_DIR, 'verifier-shootout-offsets.md');

const MODELS = [
  { id: 'M1', api: 'gemini-2.0-flash',         label: 'Gemini 2.0 Flash (current baseline)' },
  { id: 'M2', api: 'gemini-3.1-pro-preview',   label: 'Gemini 3.1 Pro Preview' },
  { id: 'M3', api: 'gemini-3-flash-preview',   label: 'Gemini 3 Flash Preview' },
  { id: 'M4', api: 'gemini-2.5-flash',         label: 'Gemini 2.5 Flash' },
];

const PRICING = {
  'gemini-2.0-flash':           { in: 0.10/1e6, out: 0.40/1e6 },
  'gemini-2.5-flash':           { in: 0.30/1e6, out: 2.50/1e6 },
  'gemini-3-flash-preview':     { in: 0.30/1e6, out: 2.50/1e6 },
  'gemini-3.1-pro-preview':     { in: 1.25/1e6, out: 10.00/1e6 },
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function tryRepairTruncatedJson(text) {
  const start = text.indexOf('"missed_items"');
  if (start < 0) return null;
  const arrStart = text.indexOf('[', start);
  if (arrStart < 0) return null;
  let depth = 0;
  let lastSafe = -1;
  for (let i = arrStart; i < text.length; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) lastSafe = i; }
    else if (c === ']' && depth === 0) { lastSafe = i; break; }
    else if (c === '"') {
      i++;
      while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++; }
    }
  }
  if (lastSafe < 0) return null;
  const trimmed = text.slice(0, lastSafe + 1);
  const closed = trimmed.endsWith(']') ? trimmed : trimmed + ']';
  return '{"missed_items":' + closed.slice(closed.indexOf('[')) + ',"client_commitments":[],"completeness_assessment":"unknown","verification_notes":"(truncated, repaired)"}';
}

async function callModel(genAI, apiName, transcript, extractedItems) {
  const generationConfig = {
    temperature: 0.3,
    maxOutputTokens: 8192,
    responseMimeType: 'application/json',
  };
  if (/2\.5-flash|3-flash-preview|3\.1-flash/.test(apiName)) {
    generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }
  const m = genAI.getGenerativeModel({ model: apiName, generationConfig });

  const itemsList = extractedItems.map((item, i) =>
    `${i + 1}. "${item.title}" (Owner: ${item.owner_name || 'TBD'})`
  ).join('\n') || '(No items were extracted)';

  // We must include the SAME transcript slice the prompt offsets will be measured against.
  const transcriptSliced = transcript.slice(0, 80_000);
  const prompt = ADVERSARIAL_PROMPT
    .replace('{extracted_items}', itemsList)
    .replace('{transcript}', transcriptSliced);

  const start = Date.now();
  try {
    const result = await m.generateContent(prompt);
    const latencyMs = Date.now() - start;
    const response = result.response;
    const text = response.text();
    const usage = response.usageMetadata || {};
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (e) {
      const repaired = tryRepairTruncatedJson(text);
      if (repaired) {
        try { parsed = JSON.parse(repaired); }
        catch { return { ok: false, error: 'JSON parse (after repair): ' + e.message, latencyMs, raw: text.slice(0, 500) }; }
      } else {
        return { ok: false, error: 'JSON parse: ' + e.message, latencyMs, raw: text.slice(0, 500) };
      }
    }
    return {
      ok: true,
      latencyMs,
      input_tokens: usage.promptTokenCount || 0,
      output_tokens: usage.candidatesTokenCount || 0,
      transcriptSliced,
      missed_items: Array.isArray(parsed.missed_items) ? parsed.missed_items : [],
      client_commitments: Array.isArray(parsed.client_commitments) ? parsed.client_commitments : [],
      completeness_assessment: parsed.completeness_assessment || 'unknown',
      verification_notes: parsed.verification_notes || '',
    };
  } catch (err) {
    return { ok: false, error: err.message, latencyMs: Date.now() - start };
  }
}

function pickCorpus(db) {
  const long = db.prepare(`
    SELECT id, topic, transcript_raw, confidence_signal, length(transcript_raw) AS chars
    FROM meetings WHERE transcript_raw IS NOT NULL AND length(transcript_raw) > 50000
    ORDER BY length(transcript_raw) DESC LIMIT 3`).all();
  const medium = db.prepare(`
    SELECT id, topic, transcript_raw, confidence_signal, length(transcript_raw) AS chars
    FROM meetings WHERE transcript_raw IS NOT NULL
      AND length(transcript_raw) BETWEEN 20000 AND 30000
    ORDER BY id DESC LIMIT 3`).all();
  const short = db.prepare(`
    SELECT id, topic, transcript_raw, confidence_signal, length(transcript_raw) AS chars
    FROM meetings WHERE transcript_raw IS NOT NULL
      AND length(transcript_raw) < 10000 AND length(transcript_raw) > 500
    ORDER BY id DESC LIMIT 3`).all();
  const red = db.prepare(`
    SELECT id, topic, transcript_raw, confidence_signal, length(transcript_raw) AS chars
    FROM meetings WHERE confidence_signal='red' AND transcript_raw IS NOT NULL
    ORDER BY id DESC LIMIT 1`).all();
  const green = db.prepare(`
    SELECT id, topic, transcript_raw, confidence_signal, length(transcript_raw) AS chars
    FROM meetings WHERE confidence_signal='green' AND transcript_raw IS NOT NULL
    ORDER BY id DESC LIMIT 1`).all();
  const huddle = db.prepare(`
    SELECT id, topic, transcript_raw, confidence_signal, length(transcript_raw) AS chars
    FROM meetings WHERE id=199`).all();

  const seen = new Set();
  const out = [];
  const tag = (arr, profile) => arr.forEach(m => {
    if (seen.has(m.id)) return; seen.add(m.id); out.push({ ...m, profile });
  });
  tag(long, 'long'); tag(medium, 'medium'); tag(short, 'short');
  tag(red, 'red-flagged'); tag(green, 'green'); tag(huddle, 'huddle-id-199');
  if (out.length < 12) {
    const filler = db.prepare(`
      SELECT id, topic, transcript_raw, confidence_signal, length(transcript_raw) AS chars
      FROM meetings WHERE transcript_raw IS NOT NULL AND id NOT IN (${[...seen].join(',') || 'NULL'})
      ORDER BY id DESC LIMIT ?`).all(12 - out.length);
    tag(filler, 'filler');
  }
  return out.slice(0, 12);
}

function loadItems(db, meetingId) {
  return db.prepare('SELECT id, title, owner_name FROM action_items WHERE meeting_id = ? ORDER BY id').all(meetingId);
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) { console.error('Missing GOOGLE_API_KEY'); process.exit(1); }
  const genAI = new GoogleGenerativeAI(apiKey);

  const db = new Database(DB_PATH, { readonly: true });
  const corpus = pickCorpus(db);
  console.log(`=== Corpus (${corpus.length} meetings) ===`);
  for (const m of corpus) console.log(`  id=${m.id}  ${m.profile.padEnd(14)}  chars=${m.chars}  ${(m.topic||'').slice(0,60)}`);
  console.log();

  const perMeeting = [];
  const perModel = {};
  for (const M of MODELS) perModel[M.api] = {
    calls_completed: 0, calls_failed: 0,
    sum_latency: 0, latencies: [],
    sum_input_tokens: 0, sum_output_tokens: 0,
    missed_total: 0, missed_high: 0, missed_medium: 0, missed_low: 0,
    valid_offsets: 0, malformed_offsets: 0, missing_offsets: 0,
    valid_high_conf: 0,
    client_commitments_total: 0,
    completeness: { complete: 0, mostly_complete: 0, incomplete: 0, unknown: 0 },
  };

  for (let i = 0; i < corpus.length; i++) {
    const meeting = corpus[i];
    const items = loadItems(db, meeting.id);
    console.log(`[${i+1}/${corpus.length}] meeting id=${meeting.id} (${meeting.profile}) — ${items.length} extracted items`);

    const byModel = {};
    for (const M of MODELS) {
      process.stdout.write(`  ${M.api}: `);
      const r = await callModel(genAI, M.api, meeting.transcript_raw, items);
      if (!r.ok) {
        console.log(`FAIL (${(r.error||'').slice(0,80)})`);
        perModel[M.api].calls_failed++;
        byModel[M.api] = { ok: false, error: r.error, latency_ms: r.latencyMs };
        continue;
      }
      const annotated = (r.missed_items || []).map(mi => {
        const ev = mi.evidence || {};
        const start = ev.start_char, end = ev.end_char;
        const slice = sliceEvidence(r.transcriptSliced, start, end);
        const validOffset = slice !== null && Number.isInteger(start) && Number.isInteger(end);
        return {
          title: mi.title,
          owner: mi.owner,
          evidence: { start_char: start, end_char: end, speaker: ev.speaker, summary: ev.summary },
          evidence_text: slice,
          evidence_valid: validOffset,
          missing_offset: typeof start !== 'number' || typeof end !== 'number',
          confidence: mi.confidence,
          reasoning: mi.reasoning,
          candidate_hash: canonicalCandidateHash(mi),
        };
      });
      const annotatedClient = (r.client_commitments || []).map(mi => {
        const ev = mi.evidence || {};
        const slice = sliceEvidence(r.transcriptSliced, ev.start_char, ev.end_char);
        return {
          title: mi.title, owner: mi.owner,
          evidence: ev, evidence_text: slice, evidence_valid: slice !== null,
          confidence: mi.confidence, reasoning: mi.reasoning,
        };
      });

      const validOff = annotated.filter(a => a.evidence_valid).length;
      const missingOff = annotated.filter(a => a.missing_offset).length;
      const malformedOff = annotated.length - validOff - missingOff;
      const validHighConf = annotated.filter(a => a.evidence_valid && a.confidence === 'HIGH').length;
      console.log(`OK  missed=${annotated.length} (${validOff} valid / ${malformedOff} malformed / ${missingOff} missing-offset)  client=${annotatedClient.length}  ${r.completeness_assessment}  ${r.latencyMs}ms`);

      const pm = perModel[M.api];
      pm.calls_completed++;
      pm.sum_latency += r.latencyMs;
      pm.latencies.push(r.latencyMs);
      pm.sum_input_tokens += r.input_tokens;
      pm.sum_output_tokens += r.output_tokens;
      pm.missed_total += annotated.length;
      pm.missed_high   += annotated.filter(a => a.confidence === 'HIGH').length;
      pm.missed_medium += annotated.filter(a => a.confidence === 'MEDIUM').length;
      pm.missed_low    += annotated.filter(a => a.confidence === 'LOW').length;
      pm.valid_offsets += validOff;
      pm.malformed_offsets += malformedOff;
      pm.missing_offsets += missingOff;
      pm.valid_high_conf += validHighConf;
      pm.client_commitments_total += annotatedClient.length;
      pm.completeness[r.completeness_assessment] = (pm.completeness[r.completeness_assessment] || 0) + 1;

      byModel[M.api] = {
        ok: true,
        latency_ms: r.latencyMs,
        input_tokens: r.input_tokens, output_tokens: r.output_tokens,
        completeness_assessment: r.completeness_assessment,
        verification_notes: r.verification_notes,
        missed_items: annotated,
        client_commitments: annotatedClient,
      };
      await sleep(300);
    }
    perMeeting.push({
      meeting_id: meeting.id, profile: meeting.profile,
      topic: meeting.topic, transcript_chars: meeting.chars,
      regex_signal: meeting.confidence_signal,
      extracted_items_count: items.length,
      by_model: byModel,
    });
  }
  db.close();

  // Cross-model agreement (canonical-hash bucket per meeting)
  const agreement = { four: 0, three: 0, two: 0, one: 0, total_unique: 0, details: [] };
  for (const m of perMeeting) {
    const hashesByModel = {};
    for (const [api, res] of Object.entries(m.by_model)) {
      hashesByModel[api] = new Set();
      if (res.ok) for (const mi of res.missed_items) if (mi.candidate_hash) hashesByModel[api].add(mi.candidate_hash);
    }
    const allHashes = new Set();
    for (const set of Object.values(hashesByModel)) for (const h of set) allHashes.add(h);
    const buckets = { 4: 0, 3: 0, 2: 0, 1: 0 };
    for (const h of allHashes) {
      const flaggers = Object.entries(hashesByModel).filter(([, s]) => s.has(h)).map(([k]) => k);
      const n = Math.min(4, flaggers.length);
      buckets[n] = (buckets[n] || 0) + 1;
    }
    agreement.four += buckets[4]; agreement.three += buckets[3];
    agreement.two += buckets[2];   agreement.one += buckets[1];
    agreement.total_unique += allHashes.size;
    agreement.details.push({ meeting_id: m.meeting_id, profile: m.profile, unique: allHashes.size, buckets });
  }

  // Per-model summary
  const summary = {};
  for (const M of MODELS) {
    const pm = perModel[M.api];
    const callsOk = pm.calls_completed || 1;
    const avgIn = pm.sum_input_tokens / callsOk;
    const avgOut = pm.sum_output_tokens / callsOk;
    const price = PRICING[M.api] || PRICING['gemini-2.5-flash'];
    const cost = avgIn * price.in + avgOut * price.out;
    const malformedRate = pm.missed_total ? 100 * pm.malformed_offsets / pm.missed_total : 0;
    const missingRate = pm.missed_total ? 100 * pm.missing_offsets / pm.missed_total : 0;
    const validRate = pm.missed_total ? 100 * pm.valid_offsets / pm.missed_total : 0;
    const sortedLat = [...pm.latencies].sort((a,b) => a-b);
    const median = sortedLat.length ? sortedLat[Math.floor(sortedLat.length/2)] : 0;
    summary[M.api] = {
      label: M.label,
      calls_completed: pm.calls_completed, calls_failed: pm.calls_failed,
      avg_latency_ms: Math.round(pm.sum_latency / callsOk),
      median_latency_ms: median,
      avg_input_tokens: Math.round(avgIn), avg_output_tokens: Math.round(avgOut),
      cost_per_call_usd: Number(cost.toFixed(6)),
      cost_300_calls_per_month_usd: Number((cost * 300).toFixed(2)),
      missed_total: pm.missed_total,
      missed_high: pm.missed_high, missed_medium: pm.missed_medium, missed_low: pm.missed_low,
      valid_offsets: pm.valid_offsets,
      malformed_offsets: pm.malformed_offsets,
      missing_offsets: pm.missing_offsets,
      valid_high_conf: pm.valid_high_conf,
      malformed_offset_rate_pct: Number(malformedRate.toFixed(1)),
      missing_offset_rate_pct: Number(missingRate.toFixed(1)),
      valid_offset_rate_pct: Number(validRate.toFixed(1)),
      client_commitments_total: pm.client_commitments_total,
      completeness_distribution: pm.completeness,
    };
  }

  // Decision rule
  const decision = pickWinner(summary);

  const out = {
    generated_at: new Date().toISOString(),
    schema_version: 'v2-offsets',
    models_tested: MODELS.map(m => m.api),
    meetings_tested: corpus.length,
    per_model_summary: summary,
    cross_model_agreement: agreement,
    per_meeting_detail: perMeeting,
    chosen_model: decision.api,
    decision_reasoning: decision.reasoning,
  };
  writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));
  writeFileSync(OUT_MD, renderMarkdown(out));

  console.log();
  console.log('=== Per-model summary (offset schema) ===');
  for (const [api, s] of Object.entries(summary)) {
    console.log(`  ${api}: ok=${s.calls_completed}/${s.calls_completed+s.calls_failed}  missed=${s.missed_total}  valid=${s.valid_offsets} (${s.valid_offset_rate_pct}%)  malformed=${s.malformed_offsets} (${s.malformed_offset_rate_pct}%)  validHigh=${s.valid_high_conf}  $${s.cost_per_call_usd}/call  median ${s.median_latency_ms}ms`);
  }
  console.log();
  console.log(`CHOSEN MODEL: ${decision.api}`);
  console.log(`Reasoning: ${decision.reasoning}`);
  console.log();
  console.log(`Wrote: ${OUT_JSON}`);
  console.log(`Wrote: ${OUT_MD}`);
}

function pickWinner(summary) {
  // Eligible: malformed_offset_rate_pct ≤ 15%
  const eligible = Object.entries(summary).filter(([, s]) => s.malformed_offset_rate_pct <= 15);
  if (!eligible.length) {
    // ALL models exceed 15% malformed — escalation case per spec
    const fallback = Object.entries(summary).sort((a, b) => a[1].malformed_offset_rate_pct - b[1].malformed_offset_rate_pct)[0];
    return {
      api: fallback[0],
      reasoning: `ESCALATION-CANDIDATE: every model exceeds the 15% malformed-offset threshold. Lowest is ${fallback[0]} at ${fallback[1].malformed_offset_rate_pct}%. Recommend shipping with quote-based prompt + gemini-2.0-flash and re-evaluating after prompt-tuning the offset instructions.`,
    };
  }
  // Pick highest valid_high_conf, then tiebreakers
  eligible.sort((a, b) => {
    const A = a[1], B = b[1];
    if (B.valid_high_conf !== A.valid_high_conf) return B.valid_high_conf - A.valid_high_conf;
    if (A.malformed_offset_rate_pct !== B.malformed_offset_rate_pct) return A.malformed_offset_rate_pct - B.malformed_offset_rate_pct;
    if (A.median_latency_ms !== B.median_latency_ms) return A.median_latency_ms - B.median_latency_ms;
    return A.cost_per_call_usd - B.cost_per_call_usd;
  });
  const [api, s] = eligible[0];
  return {
    api,
    reasoning: `Highest valid-offset HIGH-confidence missed-item count (${s.valid_high_conf}) under the ≤15% malformed-offset gate (actual ${s.malformed_offset_rate_pct}%). Median latency ${s.median_latency_ms}ms, cost \$${s.cost_per_call_usd}/call. Per Results > Cost rubric.`,
  };
}

function renderMarkdown(out) {
  const rows = Object.entries(out.per_model_summary).map(([api, s]) =>
    `| ${api} | ${s.calls_completed}/${s.calls_completed+s.calls_failed} | ${s.missed_total} | ${s.valid_offsets} (${s.valid_offset_rate_pct}%) | ${s.malformed_offsets} (${s.malformed_offset_rate_pct}%) | ${s.valid_high_conf} | $${s.cost_per_call_usd.toFixed(6)} | ${s.median_latency_ms} ms |`
  ).join('\n');
  return [
    `# Verifier Shootout — Offset Evidence Schema (v2)`,
    ``,
    `_Generated: ${out.generated_at}_  _Schema: ${out.schema_version}_`,
    ``,
    `Per OpenAI/GPT-5.2 consult (~/super-agent-shared/verifier-methodology-openai-response.md), this run replaces verbatim source_quote grounding with offset-based evidence. Model returns start_char/end_char/speaker/summary; backend slices the transcript deterministically. Paraphrase no longer counts as hallucination.`,
    ``,
    `## Verdict table (offset schema)`,
    ``,
    `| Model | OK calls | Missed total | Valid offsets | Malformed | Valid HIGH-conf | $/call | Median latency |`,
    `|---|---|---|---|---|---|---|---|`,
    rows,
    ``,
    `## Decision rule applied`,
    ``,
    `Eligibility gate: malformed-offset rate ≤ 15%. Among eligible models, pick highest valid-offset HIGH-confidence count. Tiebreakers: lower malformed rate → lower median latency → lower cost. Apply Results > Cost rubric.`,
    ``,
    `## Chosen model: \`${out.chosen_model}\``,
    ``,
    `${out.decision_reasoning}`,
    ``,
    `## Cross-model agreement (canonical-hash dedup, owner+verb+evidence-prefix)`,
    ``,
    `- All 4 models flagged the same canonical commitment: **${out.cross_model_agreement.four}**`,
    `- 3 of 4 agreed: **${out.cross_model_agreement.three}**`,
    `- 2 of 4 agreed: **${out.cross_model_agreement.two}**`,
    `- Only 1 model flagged: **${out.cross_model_agreement.one}**`,
    `- Total unique candidate hashes: **${out.cross_model_agreement.total_unique}**`,
    ``,
    `## Notes`,
    ``,
    `- "Valid offset" = sliceEvidence returned a non-null span (5–600 chars, integer offsets in range).`,
    `- "Malformed" = offsets present but invalid (out of range, inverted, non-integer, span too short/long).`,
    `- "Missing offset" = item returned without an evidence object or with non-numeric start/end.`,
    `- The full per-meeting per-model output (including evidence_text slices and reasoning) is in the JSON sibling file.`,
    ``,
  ].join('\n');
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
