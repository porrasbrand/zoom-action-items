/**
 * Dedup matcher — feature-based + embedding similarity, two-tier classification.
 *
 * Per OpenAI/GPT-5.2 (~/super-agent-shared/dedup-openai-response.md):
 *   - Treat dedup as a matching problem with multiple independent signals.
 *   - Two-tier thresholds: auto-hide only on extreme confidence + ≥2 anchors.
 *   - Always persist match metadata (matched id, similarity, anchors, version)
 *     so render-time UI policy can change without re-running the LLM.
 *   - Bias toward NOT duplicate when uncertain — silent suppression is the worst failure.
 */

import { generateEmbedding, cosineSimilarity } from './embedding-cache.js';
import { fingerprint, jaccard } from './commitment-fingerprint.js';
import { judgeDedup } from './dedup-judge.js';

export const ALGORITHM_VERSION = 'v1-features-embeddings';

// Tunables — start conservative per OpenAI methodology. Will be tightened
// once truth_labels has enough data to optimize for false_dedup_rate < 1%.
const HIGH_COSINE = 0.93;
const HIGH_MIN_ANCHORS = 2;
const MEDIUM_COSINE = 0.85;
// Gray-zone band where the LLM-as-judge runs to break ties. Below 0.86 is
// clearly not_duplicate; ≥0.93 with anchors is auto-hide; the band in between
// is where embedding/feature scores can't decide cleanly.
const JUDGE_LOW = 0.86;
const JUDGE_HIGH = 0.93;

const TEMPLATE = (item) => `Owner: ${item?.owner_name || item?.owner || 'unknown'}
Due: ${item?.due_date || 'none'}
Title: ${item?.title || ''}
Description: ${item?.description || item?.evidence?.summary || ''}`;

/**
 * For a list of action items, attach .embedding + .fingerprint inline.
 * Embeddings come from the cache (text-embedding via embedding-cache.js).
 * On embedding API failure, .embedding=null and the matcher will fall back
 * to feature-only scoring for that item.
 */
export async function embedActionItems(items) {
  const out = [];
  for (const it of items) {
    let emb = null;
    try { emb = await generateEmbedding(TEMPLATE(it)); }
    catch (e) { /* graceful: matcher will fallback to features */ }
    out.push({ ...it, embedding: emb, fingerprint: fingerprint(it) });
  }
  return out;
}

function datesIntersect(a, b) {
  if (!a?.length || !b?.length) return false;
  for (const x of a) if (b.includes(x)) return true;
  return false;
}

function entitiesOverlap(a, b) {
  if (!a?.length || !b?.length) return false;
  // Require at least one shared entity that's not a single short word
  for (const x of a) {
    if (x.length < 4) continue;
    if (b.includes(x)) return true;
    // also accept partial: shared 2-word substring
    for (const y of b) {
      if (y.length < 4) continue;
      if (x === y || (x.includes(' ') && y.includes(' ') && x === y)) return true;
    }
  }
  return false;
}

function amountsMatch(a, b) {
  if (!a?.length || !b?.length) return false;
  for (const x of a) if (b.includes(x)) return true;
  return false;
}

/**
 * For one verifier candidate against a list of existing action_items in the
 * SAME meeting (intra-meeting dedup only), return the best match + classification.
 *
 * @param {object} candidate     — verifier missed_item or client_commitment
 * @param {Array}  existing      — existing items, each with .embedding + .fingerprint
 * @returns {object} {
 *   matched_action_item_id, match_similarity, match_anchors,
 *   dedup_classification: 'duplicate_high' | 'duplicate_medium' | 'not_duplicate',
 *   algorithm_version,
 * }
 */
export async function classifyDedup(candidate, existing) {
  if (!existing || existing.length === 0) {
    return {
      matched_action_item_id: null,
      match_similarity: 0,
      match_anchors: [],
      dedup_classification: 'not_duplicate',
      algorithm_version: ALGORITHM_VERSION,
    };
  }

  const candFp = fingerprint(candidate);
  let candEmb = null;
  try { candEmb = await generateEmbedding(TEMPLATE({ ...candidate, owner_name: candidate.owner })); }
  catch (e) { /* fall back to features */ }

  // Compute scores for every existing item; we'll need top-k for the LLM-as-judge.
  const scored = [];
  for (const ex of existing) {
    let sim = 0;
    if (candEmb && ex.embedding) {
      sim = cosineSimilarity(candEmb, ex.embedding);
    } else {
      // No-embedding fallback: average of bigram-Jaccard + entity-Jaccard.
      sim = 0.5 * jaccard(candFp.bigrams, ex.fingerprint.bigrams)
          + 0.5 * jaccard(candFp.entities, ex.fingerprint.entities);
    }
    const anchors = [];
    if (datesIntersect(candFp.dates, ex.fingerprint.dates)) anchors.push('date');
    if (entitiesOverlap(candFp.entities, ex.fingerprint.entities)) anchors.push('entity');
    if (amountsMatch(candFp.amounts, ex.fingerprint.amounts)) anchors.push('amount');
    if (candFp.client_id && candFp.client_id === ex.fingerprint.client_id) anchors.push('client');
    if (candFp.verb !== 'unknown' && candFp.verb === ex.fingerprint.verb) anchors.push('verb');
    scored.push({ ex, sim, anchors });
  }
  scored.sort((a, b) => b.sim - a.sim);
  let best = scored[0];

  if (!best || best.sim <= 0) {
    return {
      matched_action_item_id: null,
      match_similarity: 0,
      match_anchors: [],
      dedup_classification: 'not_duplicate',
      algorithm_version: ALGORITHM_VERSION,
    };
  }

  let classification = 'not_duplicate';
  // Tier A (auto-hide): extreme cosine AND ≥2 independent anchors confirming the match.
  if (best.sim >= HIGH_COSINE && best.anchors.length >= HIGH_MIN_ANCHORS) {
    classification = 'duplicate_high';
  } else if (best.sim >= MEDIUM_COSINE) {
    // Tier B (soft): show as pre-selected Already captured + traceability line.
    classification = 'duplicate_medium';
  }

  // LLM-as-judge for the cosine 0.86–0.93 gray zone (Path C polish).
  // Bounded scope; bounded cost. Failure is graceful — we keep the
  // threshold-only verdict if the judge is unavailable or errors out.
  let judgeAnchors = [];
  let judgeUsed = false;
  if (best.sim >= JUDGE_LOW && best.sim < JUDGE_HIGH) {
    const top3 = scored.slice(0, 3).map(s => s.ex);
    const judgment = await judgeDedup(candidate, top3);
    if (judgment) {
      judgeUsed = true;
      if (judgment.same_as_existing_item_id) {
        const matched = top3.find(e => e.id === judgment.same_as_existing_item_id) || best.ex;
        // Update best to match the judge's picked item if different
        const judgedScore = scored.find(s => s.ex.id === matched.id);
        if (judgedScore) best = judgedScore;
        // Per GPT-5.2: 'never silently hide unless confidence is extremely high
        // AND ≥2 independent anchors'. The judge confirming a dupe is ONE
        // signal — keep these items VISIBLE in the medium tier (pre-selected
        // Already captured + 'Show anyway' override) rather than auto-hiding.
        classification = 'duplicate_medium';
        judgeAnchors.push('llm-judge');
      } else {
        // Judge says NOT a duplicate → demote to not_duplicate (override threshold).
        classification = 'not_duplicate';
        judgeAnchors.push('llm-judge-rejected');
      }
    }
  }

  const finalAnchors = [...best.anchors, ...judgeAnchors];

  return {
    matched_action_item_id: classification === 'not_duplicate' ? null : best.ex.id,
    match_similarity: parseFloat(best.sim.toFixed(3)),
    match_anchors: finalAnchors,
    dedup_classification: classification,
    algorithm_version: ALGORITHM_VERSION,
    judge_used: judgeUsed,
  };
}
