#!/usr/bin/env node
/**
 * Verifier model shootout — Phase A of the verifier-upgrade spec.
 *
 * Test 4 Gemini models against the existing ADVERSARIAL_PROMPT on a
 * 12-meeting corpus. Read-only — does NOT modify any production code,
 * does NOT touch /api/, does NOT change any prompt. Only writes the
 * comparison reports to ~/super-agent-shared/.
 *
 * Output:
 *   ~/super-agent-shared/verifier-shootout.json
 *   ~/super-agent-shared/verifier-shootout.md
 *
 * Cost ceiling: ~$0.50–$2.00. Tier 1+ Gemini billing is active.
 */

import 'dotenv/config';
import Database from 'better-sqlite3';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'zoom-action-items.db');
const OUT_DIR = join(process.env.HOME || '/home/ubuntu', 'super-agent-shared');
const OUT_JSON = join(OUT_DIR, 'verifier-shootout.json');
const OUT_MD = join(OUT_DIR, 'verifier-shootout.md');

const MODELS = [
  { id: 'M1', api: 'gemini-2.0-flash',         label: 'Gemini 2.0 Flash (current baseline)' },
  { id: 'M2', api: 'gemini-3.1-pro-preview',   label: 'Gemini 3.1 Pro Preview' },
  { id: 'M3', api: 'gemini-3-flash-preview',   label: 'Gemini 3 Flash Preview' },
  { id: 'M4', api: 'gemini-2.5-flash',         label: 'Gemini 2.5 Flash' },
];

// Approx public Gemini pricing per 1M tokens (paid tier, USD).
// Substitute pricing if a model resolves to a different stable equivalent.
const PRICING = {
  'gemini-2.0-flash':           { in: 0.10/1e6, out: 0.40/1e6 },
  'gemini-2.5-flash':           { in: 0.30/1e6, out: 2.50/1e6 },
  'gemini-2.5-pro':             { in: 1.25/1e6, out: 10.00/1e6 },
  'gemini-3-flash-preview':     { in: 0.30/1e6, out: 2.50/1e6 },
  'gemini-3.1-pro-preview':     { in: 1.25/1e6, out: 10.00/1e6 },
};

// Verbatim copy of the ADVERSARIAL_PROMPT from src/lib/adversarial-verifier.js
// (do NOT edit during Phase A — we're isolating model effect from prompt effect).
const ADVERSARIAL_PROMPT = `You are a skeptical auditor reviewing action item extraction from a business meeting.
Your job is to find what was MISSED, not to validate what was found.

EXTRACTED ITEMS (treat these as potentially incomplete):
{extracted_items}

ORIGINAL TRANSCRIPT:
{transcript}

Your task:
1. Read the ENTIRE transcript carefully, not just the parts around extracted items
2. Look specifically for:
   - Verbal commitments using casual language ("I'll take care of that", "lemme handle", "sure thing", "yeah I'll knock that out")
   - Implied commitments ("that shouldn't be a problem" = someone will do something)
   - Client requests that weren't captured as action items
   - Time-sensitive items ("before the call tomorrow", "by end of week")
   - Conditional commitments ("if X happens, we'll need to Y")
   - Agreements or promises made during discussion
   - "I need to..." or "We should..." statements that indicate tasks

3. For each potentially missed item, provide:
   {
     "title": "what needs to be done (clear, actionable)",
     "owner": "who is responsible (use exact name from transcript)",
     "source_quote": "exact 2-4 lines from transcript where this was discussed - VERBATIM with speaker names",
     "confidence": "HIGH/MEDIUM/LOW",
     "reasoning": "why this is a commitment/task that should be tracked"
   }

4. HIGH confidence: Explicit verbal commitment ("I will do X", "I'll handle that")
   MEDIUM confidence: Implied commitment or request that should probably be tracked
   LOW confidence: Vague or uncertain - might be a task, might be casual discussion

Return JSON:
{
  "missed_items": [...],
  "verification_notes": "brief summary of your review process and what you checked",
  "completeness_assessment": "complete|mostly_complete|incomplete",
  "sections_with_possible_commitments": ["line/timestamp ranges or quotes that seemed like they could contain commitments but were too vague to extract confidently"]
}

CRITICAL RULES:
- Do NOT re-extract items that are already in the EXTRACTED ITEMS list (even if worded differently)
- Only return genuinely NEW items that were missed
- Finding nothing missed is FINE if the extraction is thorough - say "completeness_assessment": "complete"
- If you find items, explain WHY they were likely missed (casual language, implied commitment, etc.)
- LOW confidence items should only be included if there's reasonable doubt they're real tasks`;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Try to salvage a truncated JSON by trimming back to the last complete entry
// in missed_items[], closing the array, and supplying minimal sibling fields.
function tryRepairTruncatedJson(text) {
  const start = text.indexOf('"missed_items"');
  if (start < 0) return null;
  const arrStart = text.indexOf('[', start);
  if (arrStart < 0) return null;
  // Walk forward, tracking brace depth, and remember the last position where
  // we just closed an array element ('}' at object depth 1 inside the array).
  let depth = 0;
  let lastSafe = -1;
  for (let i = arrStart; i < text.length; i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) lastSafe = i; }
    else if (c === ']' && depth === 0) { lastSafe = i; break; }
    else if (c === '"') {
      // skip strings (handle escapes)
      i++;
      while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++; }
    }
  }
  if (lastSafe < 0) return null;
  const trimmed = text.slice(0, lastSafe + 1);
  const closed = trimmed.endsWith(']') ? trimmed : trimmed + ']';
  return '{"missed_items":' + closed.slice(closed.indexOf('[')) + ',"completeness_assessment":"unknown","verification_notes":"(truncated, repaired)"}';
}

function fuzzyContains(haystack, needle, minProbeLen = 30) {
  if (!needle) return false;
  const h = String(haystack).replace(/\s+/g, ' ').toLowerCase();
  const n = String(needle).replace(/\s+/g, ' ').toLowerCase().trim();
  if (!n) return false;
  // Try the full needle first
  if (h.includes(n)) return true;
  // Then try a sliding probe of the longest distinctive substring
  const probeLen = Math.min(n.length, Math.max(minProbeLen, Math.floor(n.length * 0.7)));
  const probe = n.slice(0, probeLen);
  return h.includes(probe);
}

async function callModel(genAI, apiName, transcript, extractedItems) {
  // 2.5-flash and 3-flash-preview use chain-of-thought by default which consumes
  // the maxOutputTokens budget before any visible output reaches the client —
  // truncating the JSON. Disable thinking on those families and bump max
  // output tokens to 8192 so longer missed-item lists fit.
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

  const prompt = ADVERSARIAL_PROMPT
    .replace('{extracted_items}', itemsList)
    .replace('{transcript}', transcript.slice(0, 80_000));

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
      // Attempt one repair pass for truncated output: trim back to the last
      // complete missed_items array we can salvage and close the JSON.
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
      missed_items: Array.isArray(parsed.missed_items) ? parsed.missed_items : [],
      completeness_assessment: parsed.completeness_assessment || 'unknown',
      verification_notes: parsed.verification_notes || '',
      sections_with_possible_commitments: parsed.sections_with_possible_commitments || [],
    };
  } catch (err) {
    return { ok: false, error: err.message, latencyMs: Date.now() - start };
  }
}

function pickCorpus(db) {
  const long = db.prepare(`
    SELECT id, topic, transcript_raw, confidence_signal, length(transcript_raw) AS chars
    FROM meetings WHERE transcript_raw IS NOT NULL AND length(transcript_raw) > 50000
    ORDER BY length(transcript_raw) DESC LIMIT 3
  `).all();
  const medium = db.prepare(`
    SELECT id, topic, transcript_raw, confidence_signal, length(transcript_raw) AS chars
    FROM meetings WHERE transcript_raw IS NOT NULL
      AND length(transcript_raw) BETWEEN 20000 AND 30000
    ORDER BY id DESC LIMIT 3
  `).all();
  const short = db.prepare(`
    SELECT id, topic, transcript_raw, confidence_signal, length(transcript_raw) AS chars
    FROM meetings WHERE transcript_raw IS NOT NULL
      AND length(transcript_raw) < 10000 AND length(transcript_raw) > 500
    ORDER BY id DESC LIMIT 3
  `).all();
  const red = db.prepare(`
    SELECT id, topic, transcript_raw, confidence_signal, length(transcript_raw) AS chars
    FROM meetings WHERE confidence_signal='red' AND transcript_raw IS NOT NULL
    ORDER BY id DESC LIMIT 1
  `).all();
  const green = db.prepare(`
    SELECT id, topic, transcript_raw, confidence_signal, length(transcript_raw) AS chars
    FROM meetings WHERE confidence_signal='green' AND transcript_raw IS NOT NULL
    ORDER BY id DESC LIMIT 1
  `).all();
  const huddle = db.prepare(`
    SELECT id, topic, transcript_raw, confidence_signal, length(transcript_raw) AS chars
    FROM meetings WHERE id=199
  `).all();

  const seen = new Set();
  const corpus = [];
  const tag = (arr, profile) => arr.forEach(m => {
    if (seen.has(m.id)) return;
    seen.add(m.id);
    corpus.push({ ...m, profile });
  });
  tag(long, 'long');
  tag(medium, 'medium');
  tag(short, 'short');
  tag(red, 'red-flagged');
  tag(green, 'green');
  tag(huddle, 'huddle-id-199');

  // If we don't have enough buckets filled, top up from medium.
  if (corpus.length < 12) {
    const filler = db.prepare(`
      SELECT id, topic, transcript_raw, confidence_signal, length(transcript_raw) AS chars
      FROM meetings WHERE transcript_raw IS NOT NULL AND id NOT IN (${[...seen].join(',') || 'NULL'})
      ORDER BY id DESC LIMIT ?
    `).all(12 - corpus.length);
    tag(filler, 'filler');
  }
  return corpus.slice(0, 12);
}

function loadItems(db, meetingId) {
  return db.prepare('SELECT id, title, owner_name FROM action_items WHERE meeting_id = ? ORDER BY id').all(meetingId);
}

async function verifyModelsAvailable(genAI) {
  console.log('=== Verifying model IDs ===');
  const verified = [];
  for (const m of MODELS) {
    try {
      const t = genAI.getGenerativeModel({ model: m.api });
      const r = await t.generateContent('Reply with exactly: ok');
      const txt = (r?.response?.text?.() || '').trim();
      console.log(`  ${m.api}: OK (${txt.slice(0, 30)})`);
      verified.push({ ...m, available: true });
    } catch (err) {
      console.log(`  ${m.api}: FAIL — ${err.message.slice(0, 120)}`);
      verified.push({ ...m, available: false, error: err.message });
    }
  }
  console.log();
  return verified;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const apiKey = process.env.GOOGLE_API_KEY;
  if (!apiKey) { console.error('Missing GOOGLE_API_KEY'); process.exit(1); }
  const genAI = new GoogleGenerativeAI(apiKey);

  const verifiedModels = await verifyModelsAvailable(genAI);
  const usable = verifiedModels.filter(m => m.available);
  if (!usable.length) { console.error('No usable models. Aborting.'); process.exit(2); }

  const db = new Database(DB_PATH, { readonly: true });
  const corpus = pickCorpus(db);
  console.log(`=== Corpus (${corpus.length} meetings) ===`);
  for (const m of corpus) {
    console.log(`  id=${m.id}  ${m.profile.padEnd(14)}  chars=${m.chars}  signal=${m.confidence_signal||'-'}  ${(m.topic||'').slice(0, 60)}`);
  }
  console.log();

  // Per-meeting per-model results
  const perMeeting = [];
  const perModel = {};
  for (const m of usable) perModel[m.api] = {
    calls_completed: 0, calls_failed: 0,
    sum_latency: 0, sum_input_tokens: 0, sum_output_tokens: 0,
    missed_items_total: 0, missed_items_high: 0, missed_items_medium: 0, missed_items_low: 0,
    hallucinated_quotes: 0, grounded_quotes: 0,
    completeness: { complete: 0, mostly_complete: 0, incomplete: 0, unknown: 0, error: 0 },
  };

  for (let i = 0; i < corpus.length; i++) {
    const meeting = corpus[i];
    const items = loadItems(db, meeting.id);
    console.log(`[${i+1}/${corpus.length}] meeting id=${meeting.id} (${meeting.profile}) — ${items.length} extracted items`);

    const byModel = {};
    for (const M of usable) {
      process.stdout.write(`  ${M.api}: `);
      const r = await callModel(genAI, M.api, meeting.transcript_raw, items);
      if (!r.ok) {
        console.log(`FAIL (${r.error?.slice(0, 80)})`);
        perModel[M.api].calls_failed++;
        byModel[M.api] = { ok: false, error: r.error, latency_ms: r.latencyMs };
        continue;
      }
      // Verify each missed_item's source_quote against the transcript
      const annotated = r.missed_items.map(mi => ({
        title: mi.title, owner: mi.owner, source_quote: mi.source_quote,
        confidence: mi.confidence, reasoning: mi.reasoning,
        source_quote_grounded: fuzzyContains(meeting.transcript_raw, mi.source_quote || ''),
      }));
      const grounded = annotated.filter(a => a.source_quote_grounded).length;
      const hallucinated = annotated.length - grounded;
      console.log(`OK  missed=${annotated.length} (${grounded} grounded / ${hallucinated} hallucinated)  ${r.completeness_assessment}  ${r.latencyMs}ms  ${r.input_tokens}in/${r.output_tokens}out`);

      const pm = perModel[M.api];
      pm.calls_completed++;
      pm.sum_latency += r.latencyMs;
      pm.sum_input_tokens += r.input_tokens;
      pm.sum_output_tokens += r.output_tokens;
      pm.missed_items_total += annotated.length;
      pm.missed_items_high   += annotated.filter(a => a.confidence === 'HIGH').length;
      pm.missed_items_medium += annotated.filter(a => a.confidence === 'MEDIUM').length;
      pm.missed_items_low    += annotated.filter(a => a.confidence === 'LOW').length;
      pm.hallucinated_quotes += hallucinated;
      pm.grounded_quotes     += grounded;
      pm.completeness[r.completeness_assessment] = (pm.completeness[r.completeness_assessment] || 0) + 1;

      byModel[M.api] = {
        ok: true,
        latency_ms: r.latencyMs,
        input_tokens: r.input_tokens,
        output_tokens: r.output_tokens,
        completeness_assessment: r.completeness_assessment,
        verification_notes: r.verification_notes,
        missed_items: annotated,
      };
      // Tiny inter-call pacing — generous since Tier 1+
      await sleep(300);
    }
    perMeeting.push({
      meeting_id: meeting.id,
      profile: meeting.profile,
      topic: meeting.topic,
      transcript_chars: meeting.chars,
      regex_signal: meeting.confidence_signal,
      extracted_items_count: items.length,
      by_model: byModel,
    });
  }
  db.close();

  // Cross-model agreement (per meeting): bucketize each missed item's title (first 40 normalized chars) and count flag-hits across models
  const agreement = {
    all_models_flagged: 0, three_of_four: 0, two_of_four: 0, only_one: 0, total_unique_titles: 0,
    details_per_meeting: [],
  };
  function titleKey(s) {
    return String(s || '').replace(/\s+/g, ' ').toLowerCase().trim().slice(0, 60);
  }
  for (const m of perMeeting) {
    const titlesByModel = {};
    for (const [api, res] of Object.entries(m.by_model)) {
      titlesByModel[api] = new Set();
      if (res.ok) for (const mi of res.missed_items) titlesByModel[api].add(titleKey(mi.title));
    }
    const allTitles = new Set();
    for (const set of Object.values(titlesByModel)) for (const t of set) allTitles.add(t);
    const buckets = { 4: 0, 3: 0, 2: 0, 1: 0 };
    const detail = [];
    for (const t of allTitles) {
      const flaggers = Object.entries(titlesByModel).filter(([, set]) => set.has(t)).map(([api]) => api);
      const n = Math.min(4, flaggers.length);
      buckets[n] = (buckets[n] || 0) + 1;
      detail.push({ title_key: t, flagged_by: flaggers, count: flaggers.length });
    }
    agreement.all_models_flagged += buckets[4] || 0;
    agreement.three_of_four += buckets[3] || 0;
    agreement.two_of_four += buckets[2] || 0;
    agreement.only_one += buckets[1] || 0;
    agreement.total_unique_titles += allTitles.size;
    agreement.details_per_meeting.push({
      meeting_id: m.meeting_id, profile: m.profile, unique_titles: allTitles.size,
      buckets, detail: detail.slice(0, 30),
    });
  }

  // Per-model summary with cost computation
  const perModelSummary = {};
  for (const M of usable) {
    const pm = perModel[M.api];
    const callsOk = pm.calls_completed || 1;
    const avgIn = pm.sum_input_tokens / callsOk;
    const avgOut = pm.sum_output_tokens / callsOk;
    const price = PRICING[M.api] || PRICING['gemini-2.5-flash']; // default to flash if unknown
    const costPerCall = avgIn * price.in + avgOut * price.out;
    const halluc = pm.missed_items_total ? (100 * pm.hallucinated_quotes / pm.missed_items_total) : 0;
    perModelSummary[M.api] = {
      label: M.label,
      calls_completed: pm.calls_completed, calls_failed: pm.calls_failed,
      avg_latency_ms: Math.round(pm.sum_latency / callsOk),
      avg_input_tokens: Math.round(avgIn),
      avg_output_tokens: Math.round(avgOut),
      cost_per_call_usd: Number(costPerCall.toFixed(6)),
      cost_300_calls_per_month_usd: Number((costPerCall * 300).toFixed(2)),
      missed_items_total: pm.missed_items_total,
      missed_items_high: pm.missed_items_high,
      missed_items_medium: pm.missed_items_medium,
      missed_items_low: pm.missed_items_low,
      grounded_quotes: pm.grounded_quotes,
      hallucinated_quotes: pm.hallucinated_quotes,
      hallucination_rate_pct: Number(halluc.toFixed(1)),
      completeness_distribution: pm.completeness,
    };
  }

  const out = {
    generated_at: new Date().toISOString(),
    models_tested: MODELS.map(m => m.api),
    models_available: usable.map(m => m.api),
    models_unavailable: verifiedModels.filter(m => !m.available).map(m => ({ api: m.api, error: m.error })),
    meetings_tested: corpus.length,
    per_model_summary: perModelSummary,
    cross_model_agreement: agreement,
    per_meeting_detail: perMeeting,
  };
  writeFileSync(OUT_JSON, JSON.stringify(out, null, 2));

  // Markdown summary
  const md = renderMarkdown(out);
  writeFileSync(OUT_MD, md);

  console.log();
  console.log('=== Per-model summary ===');
  for (const [api, s] of Object.entries(perModelSummary)) {
    console.log(`  ${api}: ${s.calls_completed}/${s.calls_completed + s.calls_failed} ok, missed=${s.missed_items_total} (H=${s.missed_items_high}/M=${s.missed_items_medium}/L=${s.missed_items_low}), halluc=${s.hallucination_rate_pct}%, $${s.cost_per_call_usd}/call, ${s.avg_latency_ms}ms`);
  }
  console.log();
  console.log(`Wrote: ${OUT_JSON}`);
  console.log(`Wrote: ${OUT_MD}`);
}

function renderMarkdown(out) {
  const rows = Object.entries(out.per_model_summary).map(([api, s]) =>
    `| ${api} | ${s.calls_completed}/${s.calls_completed+s.calls_failed} | ${s.missed_items_high}H / ${s.missed_items_medium}M / ${s.missed_items_low}L | ${s.hallucination_rate_pct}% | $${s.cost_per_call_usd.toFixed(6)} | $${s.cost_300_calls_per_month_usd.toFixed(2)} | ${s.avg_latency_ms} ms |`
  ).join('\n');

  const illustrative = out.per_meeting_detail.slice(0, 3).map(m => {
    const sections = Object.entries(m.by_model).map(([api, r]) => {
      if (!r.ok) return `**${api}**: FAIL — ${r.error}\n`;
      const items = (r.missed_items || []).slice(0, 5).map(mi => `  - [${mi.confidence}${mi.source_quote_grounded?'':' ⚠ HALLUCINATED'}] ${mi.title} _(owner: ${mi.owner})_`).join('\n');
      return `**${api}** — ${r.completeness_assessment} (${r.missed_items?.length||0} missed)\n${items || '  _(none)_'}\n`;
    }).join('\n');
    return `### Meeting ${m.meeting_id} (${m.profile}, ${m.transcript_chars} chars, regex=${m.regex_signal||'-'}) — ${m.extracted_items_count} extracted\n\n${sections}`;
  }).join('\n');

  return [
    `# Verifier Model Shootout — Phase A`,
    ``,
    `_Generated: ${out.generated_at}_`,
    ``,
    `## Verdict table`,
    ``,
    `| Model | OK calls | Missed (H/M/L) | Hallucination | $/call | $/month (300) | Avg latency |`,
    `|---|---|---|---|---|---|---|`,
    rows,
    ``,
    `## Cross-model agreement (across all meetings)`,
    ``,
    `- All 4 models flagged the same item: **${out.cross_model_agreement.all_models_flagged}**`,
    `- 3 of 4 agreed: **${out.cross_model_agreement.three_of_four}**`,
    `- 2 of 4 agreed: **${out.cross_model_agreement.two_of_four}**`,
    `- Only 1 model flagged: **${out.cross_model_agreement.only_one}**`,
    `- Total unique missed-item titles across all models × meetings: **${out.cross_model_agreement.total_unique_titles}**`,
    ``,
    `## Illustrative meetings (first 3)`,
    ``,
    illustrative,
    ``,
    `## Notes`,
    ``,
    `- Source-quote grounding is a fuzzy substring match against \`transcript_raw\` after whitespace normalization. Items flagged ⚠ HALLUCINATED have a source_quote that does NOT appear in the transcript — those are the model inventing a quote.`,
    `- LOW-confidence items are kept in the per-model totals but the production verifier filters to HIGH+MEDIUM only.`,
    `- Cost projection assumes ~10 meetings/day × 30 days = 300 verifier calls/month.`,
    `- All inputs/outputs and per-meeting per-model detail in the JSON sibling file.`,
    ``,
  ].join('\n');
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
