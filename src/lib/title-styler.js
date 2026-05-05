/**
 * Phil-style title generator (Path X — post-extraction styler).
 *
 * Transforms the LLM's first-draft action-item title into the Phil voice formula
 * before insertion. Does NOT touch the existing extraction prompt.
 *
 * Feature-flagged via TITLE_STYLER_ENABLED env var. Default: disabled.
 *
 * Architecture: OpenAI gpt-5.4-mini (override via TITLE_STYLER_MODEL).
 * Switched from Gemini after free-tier daily quotas (20 RPD on gemini-2.5-flash)
 * blocked the replay validation gate. OpenAI Tier-1 = 500 RPM, Tier-2 = 5000 RPM.
 * Cost: ~1 extra call per action item (~$0.001 / meeting).
 */

import OpenAI from 'openai';

let _client = null;
function getClient() {
  if (!_client) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('Missing OPENAI_API_KEY');
    _client = new OpenAI({ apiKey });
  }
  return _client;
}

const MODEL_ID = () => process.env.TITLE_STYLER_MODEL || 'gpt-5.4-mini';

// Phil's formula encoded as the system prompt + 6 verbatim few-shot examples
// pulled from ~/super-agent-shared/phil-edits-analysis.json (structural title
// rewrites covering the cases owner+client, self-task, B3X-internal, multi-owner,
// owner+client with specifics).
export const SYSTEM_PROMPT = `You rewrite B3X action item titles into Phil's voice for ProofHub.

Rules:
1. Default formula: "<Owner_First> - <Client> - <Verb_Object> [<Specifics>]"
2. Self-task (owner = Phil / Philip / "B3x lead"): "Phil - <Client> - <Verb_Object>"
3. B3X-internal (no specific assignee, or B3X is the actor): "B3x - <Verb_Object>" or "B3x To <Verb_Object>"
4. Multiple owners: "<Owner1> & <Owner2> - <Client> - <Verb_Object>"
5. Title Case throughout. 5-15 words.
6. NEVER invent numbers, dates, platforms, or named entities not in the transcript_excerpt.
7. If the input title already follows the formula or is already specific to client+context, return it UNCHANGED.
8. Output ONLY the styled title. No preamble, no quotes, no explanation.

Rule A (owner cross-check): Cross-check Owner_First against the transcript. If the transcript clearly indicates a DIFFERENT person commits to or is assigned to do this work (e.g. "Bill is going to handle that", "Richard will take this one"), use that person's first name as Owner_First instead of the input owner_name. Default to the input owner_name only if the transcript is silent or ambiguous.

Rule B (clean client names): Output the client name EXACTLY as provided. NEVER splice with slashes (e.g. NOT "Jay Conner / Conner Marketing"). NEVER embed redundant company names. If client_name has parenthetical or comma-separated suffixes, drop them.

Rule C (append vs restructure): If the raw title is already verb-led, ≥4 words, and contains specific objects (counts, dates, named entities), APPEND specifics with a hyphen rather than restructure to formula. Example: raw="Edit and upload Q1 analysis video" + transcript="once received by client" → output="Edit and upload Q1 analysis video - Once Received By Client" (NOT "<Owner> - <Client> - Edit and upload Q1..."). Apply formula prefix ONLY when the raw title is generic/vague.

Few-shot examples (real Phil rewrites, verbatim):

Example 1 (owner+client):
  raw_title: "Update Estimate Complete Automation"
  owner: "Bill"
  client: "Vision Flooring"
  styled: "Bill - Vision Flooring - Update Estimate Complete Automation Emails"

Example 2 (owner+client+specifics):
  raw_title: "Write affiliate promo emails"
  owner: "Bill"
  client: "Jay Conner"
  styled: "Bill - Jay Conner - Write 3 Affiliate Promo Emails For June 10th - 12th In Person Event"

Example 3 (self-task with client):
  raw_title: "Re-check GoHighLevel for sales call links"
  owner: "Philip Mutrie"
  client: "Jay Conner"
  styled: "Phil - Jay Conner - Review 1 - 2 of Chaffee's Sales Calls"

Example 4 (B3X-internal):
  raw_title: "Execute Raise Hand email campaigns"
  owner: ""
  client: "Regen Profits"
  styled: "B3x To Takeover Raise Hand Emailing in GHL"

Example 5 (multi-owner):
  raw_title: "Create competitor-targeted landing pages"
  owner: "Richard & Manuel"
  client: "Vision Flooring"
  styled: "Richard & Manuel - Vision Flooring - Create Competitor-Targeted Landing Pages For GS-Ads"

Example 6 (owner+client+deadline):
  raw_title: "Update Raise Hand emails with financing offer"
  owner: "Bill"
  client: "Vision Flooring"
  styled: "Bill - Vision Flooring - May Raise Hand Emails - Include Financing Offer"

Now style the new input.`;

export function isEnabled() {
  return String(process.env.TITLE_STYLER_ENABLED || '').toLowerCase() === 'true';
}

export function looksLikePhilFormula(t) {
  if (!t) return false;
  // Starts with "<Word> - <Word> - " (formula) OR "B3x..." (internal) OR "Phil - ..." (self).
  // Tightened: require BOTH dashes for formula-detection so single-name titles aren't mistakenly skipped.
  if (/^B3x\s+(-\s+|To\s+)/i.test(t)) return true;
  if (/^Phil\s+-\s+/i.test(t)) return true;
  // Generic: "Word [& Word2] - Word - "  (multi-segment formula)
  if (/^[A-Z][a-zA-Z'-]+(\s+&\s+[A-Z][a-zA-Z'-]+)?\s+-\s+[A-Z][a-zA-Z0-9'\s-]+\s+-\s+/.test(t)) return true;
  return false;
}

export function sanitize(s) {
  if (!s) return '';
  return String(s)
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/^[*-]+\s*/, '')        // strip leading bullets / markdown leftovers
    .replace(/\s+/g, ' ')
    .split('\n')[0]                   // first line only
    .trim();
}

/**
 * Style a single action-item title in Phil's voice.
 * Graceful: returns rawTitle unchanged on any error or feature-flag-off.
 */
export async function styleTitle({ rawTitle, ownerName, clientName, transcriptExcerpt, taskType }) {
  if (!isEnabled()) return rawTitle;
  if (!rawTitle || String(rawTitle).trim().length < 3) return rawTitle;
  if (looksLikePhilFormula(rawTitle)) return rawTitle;

  try {
    const userMsg = `raw_title: ${JSON.stringify(rawTitle)}
owner: ${JSON.stringify(ownerName || '')}
client: ${JSON.stringify(clientName || '')}
task_type: ${JSON.stringify(taskType || '')}
transcript_excerpt: ${JSON.stringify((transcriptExcerpt || '').slice(0, 8000))}

styled:`;
    const client = getClient();
    const response = await client.chat.completions.create({
      model: MODEL_ID(),
      temperature: 0.2,
      max_completion_tokens: 1024,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMsg },
      ],
    });
    const text = response?.choices?.[0]?.message?.content || '';
    const cleaned = sanitize(text);
    if (!cleaned || cleaned.length < 5 || cleaned.length > 200) {
      console.warn('[title-styler] output out of bounds, falling back:', JSON.stringify(cleaned).slice(0, 100));
      return rawTitle;
    }
    return cleaned;
  } catch (err) {
    console.warn('[title-styler] failed, falling back:', err.message);
    return rawTitle;
  }
}

// Test-only override — bypasses isEnabled() so the replay script can validate
// the styler without flipping the live env flag.
export async function styleTitleForce(args) {
  const prev = process.env.TITLE_STYLER_ENABLED;
  process.env.TITLE_STYLER_ENABLED = 'true';
  try {
    return await styleTitle(args);
  } finally {
    if (prev === undefined) delete process.env.TITLE_STYLER_ENABLED;
    else process.env.TITLE_STYLER_ENABLED = prev;
  }
}
