/**
 * Phil-style title generator (Path X — post-extraction styler).
 *
 * Transforms the LLM's first-draft action-item title into the Phil voice formula
 * before insertion. Does NOT touch the existing extraction prompt.
 *
 * Feature-flagged via TITLE_STYLER_ENABLED env var. Default: disabled.
 *
 * Architecture: re-uses the same Gemini model as ai-extractor.js.
 * Cost: ~1 extra call per action item (~$0.001 / meeting).
 */

import { GoogleGenerativeAI } from '@google/generative-ai';

let _model = null;
function getModel() {
  if (!_model) {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error('Missing GOOGLE_API_KEY');
    const genAI = new GoogleGenerativeAI(apiKey);
    // Stable production model. The main extractor uses gemini-3-flash-preview which
    // is rate-limited and 503-prone on free tier; gemini-2.5-flash is the reliable
    // sibling and well-suited for short structured rewrites like this.
    //
    // thinkingBudget=0 disables Gemini-2.5's default chain-of-thought, which would
    // otherwise eat the maxOutputTokens budget and produce truncated outputs like
    // "Phil - Mike McV" instead of full styled titles.
    const modelId = process.env.TITLE_STYLER_MODEL || 'gemini-2.5-flash';
    _model = genAI.getGenerativeModel({
      model: modelId,
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 1024,
        thinkingConfig: { thinkingBudget: 0 },
      },
    });
  }
  return _model;
}

// Phil's formula encoded as the system prompt + 6 verbatim few-shot examples
// pulled from ~/super-agent-shared/phil-edits-analysis.json (structural title
// rewrites covering the cases owner+client, self-task, B3X-internal, multi-owner,
// owner+client with specifics).
const SYSTEM_PROMPT = `You rewrite B3X action item titles into Phil's voice for ProofHub.

Rules:
1. Default formula: "<Owner_First> - <Client> - <Verb_Object> [<Specifics>]"
2. Self-task (owner = Phil / Philip / "B3x lead"): "Phil - <Client> - <Verb_Object>"
3. B3X-internal (no specific assignee, or B3X is the actor): "B3x - <Verb_Object>" or "B3x To <Verb_Object>"
4. Multiple owners: "<Owner1> & <Owner2> - <Client> - <Verb_Object>"
5. Title Case throughout. 5-15 words.
6. NEVER invent numbers, dates, platforms, or named entities not in the transcript_excerpt.
7. If the input title already follows the formula or is already specific to client+context, return it UNCHANGED.
8. Output ONLY the styled title. No preamble, no quotes, no explanation.

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
transcript_excerpt: ${JSON.stringify((transcriptExcerpt || '').slice(0, 2000))}

styled:`;
    const model = getModel();
    const result = await model.generateContent({
      contents: [{ role: 'user', parts: [{ text: SYSTEM_PROMPT + '\n\n' + userMsg }] }],
    });
    const text = result?.response?.text?.() || '';
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
