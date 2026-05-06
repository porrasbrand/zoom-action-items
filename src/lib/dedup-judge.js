/**
 * LLM-as-judge for the dedup gray zone.
 *
 * Per OpenAI/GPT-5.2 consult — used ONLY in the cosine 0.86–0.90 band, where
 * lexical/embedding scores can't decide cleanly. Returns a structured judgment;
 * caller folds the verdict into bestAnchors and adjusts dedup_classification.
 *
 * Graceful: returns null on missing API key, parse failure, or any error.
 * Caller must handle null and fall back to threshold-only classification.
 *
 * Cost: gpt-5.4-mini ~$0.0002/call. Bounded — only fires for ~5–10% of
 * candidates per backfill data. Override model via DEDUP_JUDGE_MODEL.
 */

import OpenAI from 'openai';

let _client = null;
function getClient() {
  if (_client) return _client;
  if (!process.env.OPENAI_API_KEY) return null;
  _client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _client;
}

const SYSTEM_PROMPT = `You decide whether a B3X verifier candidate duplicates an existing action item.

Two commitments are the SAME when ALL hold:
- Same target outcome (the thing that must happen — discuss / decide / send / review / update / create)
- Same primary object/topic (synonyms OK: 'ad budget' ≈ 'ad spend' ≈ 'budget increase')
- Same time window OR both undated
- Owner differences are ALLOWED — speaker vs executor mismatches still dedup
- Granularity counts: 'discuss X' and 'decide X' are NOT duplicates if both appear distinctly

Bias toward NOT duplicate when uncertain — silent suppression of a real miss is worse than a false positive in the panel.

Output STRICT JSON only:
{
  "same_as_existing_item_id": <integer id or null>,
  "confidence": "HIGH" | "MEDIUM" | "LOW",
  "rationale": "<one sentence>"
}`;

/**
 * @param {object} candidate     verifier missed_item or client_commitment
 * @param {Array}  topMatches    top-k existing items, each {id, title, description, owner_name}
 * @returns {Promise<object|null>} {same_as_existing_item_id, confidence, rationale} or null on failure
 */
export async function judgeDedup(candidate, topMatches) {
  const client = getClient();
  if (!client) return null;
  if (!Array.isArray(topMatches) || topMatches.length === 0) return null;

  const userMsg = JSON.stringify({
    candidate: {
      title: candidate.title || '',
      owner: candidate.owner || '',
      evidence_summary: candidate.evidence?.summary || '',
    },
    existing_items: topMatches.slice(0, 3).map(e => ({
      id: e.id,
      title: e.title,
      description: e.description,
      owner: e.owner_name || e.owner || '',
    })),
  });

  try {
    const res = await client.chat.completions.create({
      model: process.env.DEDUP_JUDGE_MODEL || 'gpt-5.4-mini',
      temperature: 0.1,
      max_completion_tokens: 300,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMsg },
      ],
    });
    const text = res?.choices?.[0]?.message?.content || '';
    const parsed = JSON.parse(text);
    // Normalize: null OR an int id
    if (parsed.same_as_existing_item_id != null && typeof parsed.same_as_existing_item_id !== 'number') {
      const n = parseInt(parsed.same_as_existing_item_id, 10);
      parsed.same_as_existing_item_id = Number.isFinite(n) ? n : null;
    }
    return parsed;
  } catch (err) {
    console.warn('[dedup-judge] failed:', err.message);
    return null;
  }
}
