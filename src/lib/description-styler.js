/**
 * Phil-voice description-styler (push-time path).
 *
 * Generates ONLY the middle paragraph(s) of the action-item description
 * scaffold. Greeting (`<owner_first> - Happy <weekday>!`) and closer
 * (`Thanks...`) are assembled deterministically by the caller, NOT by the
 * LLM — so we don't waste tokens or risk weekday/name hallucinations on
 * the parts we already know exactly.
 *
 * Feature-flagged via PUSH_TIME_STYLER_ENABLED env var. Default: enabled.
 * Override model via PUSH_TIME_STYLER_MODEL (default gpt-5.4-mini).
 *
 * Returns null on disabled / error / empty input. Caller treats null as
 * "fall back to raw" (no scaffold).
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

const SYSTEM_PROMPT = `You write the MIDDLE paragraph(s) of a B3X action item description in Phil's voice.

Context: a deterministic greeting "\${owner_first} - Happy \${weekday}!" will be prepended.
A deterministic closer "Thanks..." will be appended. You produce ONLY the middle.

Style rules:
1. Address the assignee directly ("Could you...", "Can I get you to...", "Just posting this...")
2. Conversational, slightly informal — Phil's actual voice, not corporate.
3. Reference specific objects, names, dates, platforms ONLY if they appear in transcript_excerpt or raw_description.
4. NEVER invent specifics not present in the input.
5. 1-3 sentences total. Multiple sentences separated by line breaks if natural.
6. NO greeting line. NO closing/sign-off. Output ONLY the middle.

Few-shot examples (real Phil rewrites — middle paragraphs only):

Example A (Marie / Incontrera sales call review):
input.raw_description = ""
input.transcript_excerpt = "...Bill, can you review Marie's sales call and give us feedback on what worked and what could be better..."
output:
Can I get you to review Marie's Successful Sales Call for client feedback..?

Ideally, what was performed well and what was missing that could have made it even better...

Example B (Regen Profits hand-raiser emails):
input.raw_description = "B3X to take over sending hand-raiser emails via GoHighLevel; Ed to provide inclusion/exclusion lists."
input.transcript_excerpt = "...so moving forward, we'll have Rayz handle the raise-hand email scheduling, the client gives us the lists in GHL..."
output:
Just posting this - that moving forward, we will be having Rayz set up and schedule the raise hand emails we provide to the client...

The client will be providing the lists to send them to in GHL.

Example C (Vision Flooring estimate automation):
input.raw_description = "Pull, review, and update the 5 emails in the ActiveCampaign 'Estimate Complete Automation'."
input.transcript_excerpt = "...for Vision Flooring, the 5 emails in the estimate complete automation flow need a refresh..."
output:
Just setting up this ProofHub project for Vision Flooring's Active Campaign Estimate Complete Automation.

Need to pull, review, and update the 5 emails in the automation flow.

Now generate ONLY the middle paragraph(s) for the user's input. No greeting, no closer, no quotes.`;

export function isEnabled() {
  return String(process.env.PUSH_TIME_STYLER_ENABLED || 'true').toLowerCase() !== 'false';
}

export function sanitize(s) {
  return String(s || '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function styleDescription({ rawDescription, ownerFirst, clientName, transcriptExcerpt }) {
  if (!isEnabled()) return null;
  if (!ownerFirst && !rawDescription && !transcriptExcerpt) return null;

  try {
    const userMsg = JSON.stringify({
      raw_description: rawDescription || '',
      owner_first: ownerFirst || '',
      client_name: clientName || '',
      transcript_excerpt: (transcriptExcerpt || '').slice(0, 8000),
    });
    const res = await getClient().chat.completions.create({
      model: process.env.PUSH_TIME_STYLER_MODEL || 'gpt-5.4-mini',
      temperature: 0.2,
      max_completion_tokens: 600,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMsg },
      ],
    });
    const middle = sanitize(res.choices?.[0]?.message?.content || '');
    if (!middle || middle.length < 5) return null;
    return middle;
  } catch (err) {
    console.warn('[description-styler] failed:', err.message);
    return null;
  }
}
