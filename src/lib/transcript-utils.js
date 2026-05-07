/**
 * Helpers for working with transcripts + verifier offset evidence.
 *
 * sliceEvidence: deterministic slice from char offsets, with sanity bounds.
 * canonicalCandidateHash: dedup key for missed_item candidates so the same
 *   commitment phrased differently across models collapses to one row.
 */

/**
 * Slice a transcript by 0-based character offsets, with word-boundary
 * snapping and minimum-context expansion.
 *
 * The verifier sometimes emits very short spans (15–40 chars), which
 * produced fragments like "ient. I think thats really cool." in the UI.
 * To make every rendered evidence chunk readable in isolation:
 *
 *   1. Snap both ends OUTWARD to the nearest whitespace (no mid-word cuts).
 *   2. If the resulting span is < 150 chars, expand outward symmetrically
 *      until ≥150 chars OR a transcript boundary is hit, then re-snap to
 *      whitespace.
 *   3. Hard cap at 600 chars max.
 *
 * Returns null only if the input offsets are wholly invalid (non-integer,
 * negative, or producing a zero-length span at the start of the string).
 */
const MIN_SPAN = 150;
const MAX_SPAN = 600;

export function sliceEvidence(transcript, startChar, endChar) {
  if (typeof transcript !== 'string') return null;
  const s = Number(startChar);
  const e = Number(endChar);
  if (!Number.isInteger(s) || !Number.isInteger(e)) return null;
  let start = Math.max(0, Math.min(s, transcript.length));
  let end = Math.max(start, Math.min(e, transcript.length));
  if (end - start < 1) return null;

  // 1. Snap outward to whitespace boundaries (no mid-word cuts)
  start = snapBackwardToWS(transcript, start);
  end = snapForwardToWS(transcript, end);

  // 2. If too short, expand symmetrically until we reach MIN_SPAN
  while (end - start < MIN_SPAN) {
    const moreLeft = start > 0;
    const moreRight = end < transcript.length;
    if (!moreLeft && !moreRight) break;
    // Expand both sides by ~half the deficit each pass
    const deficit = MIN_SPAN - (end - start);
    const step = Math.max(20, Math.floor(deficit / 2));
    if (moreLeft) start = Math.max(0, start - step);
    if (moreRight) end = Math.min(transcript.length, end + step);
  }

  // Re-snap to whitespace after the expansion
  start = snapBackwardToWS(transcript, start);
  end = snapForwardToWS(transcript, end);

  // 3. Hard cap at MAX_SPAN
  if (end - start > MAX_SPAN) {
    end = snapForwardToWS(transcript, start + MAX_SPAN);
    if (end - start > MAX_SPAN) end = start + MAX_SPAN;
  }

  return transcript.slice(start, end).trim();
}

// Walk backwards until we hit whitespace OR transcript start. The returned
// position is the index of the whitespace itself (so slice() starts AFTER it).
function snapBackwardToWS(text, idx) {
  let i = idx;
  while (i > 0 && !/\s/.test(text[i - 1])) i--;
  return i;
}

// Walk forwards until we hit whitespace OR transcript end. The returned
// position is the index of the whitespace itself (so slice() stops BEFORE it).
function snapForwardToWS(text, idx) {
  let i = idx;
  while (i < text.length && !/\s/.test(text[i])) i++;
  return i;
}

/**
 * Canonical dedup key for a missed-item candidate. Lowercased first-name
 * owner, crude verb stem, plus a 30-char prefix of the evidence summary
 * (or title fallback). Matches across models that phrase the same
 * commitment differently.
 */
export function canonicalCandidateHash(item) {
  const owner = (item?.owner || '').toString().toLowerCase().trim().split(/\s+/)[0] || 'unknown';
  const verbStem = extractVerbStem(item?.title || '');
  const summary = item?.evidence?.summary || item?.title || '';
  const evidencePrefix = summary.toLowerCase().replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 30);
  return `${owner}::${verbStem}::${evidencePrefix}`;
}

function extractVerbStem(title) {
  const words = title.toLowerCase().split(/[^a-z]+/).filter(Boolean);
  return words[0] || 'unknown';
}

/**
 * Locate an LLM-emitted verbatim anchor quote in the full transcript.
 *
 * Pattern A (per ~/super-agent-shared/evidence-slicing-gemini-response.md):
 * the LLM emits a 10–20 word verbatim snippet of the commitment, and the
 * backend deterministically finds it via string search. Replaces the
 * earlier char-offset contract which was unreliable for long transcripts.
 *
 * Match tiers (try in order):
 *   1. EXACT — single occurrence of trimmed anchor → 'exact'
 *   2. AMBIGUOUS — multiple exact occurrences → pick the closest to opts.hintCenter
 *      (or the first one) and flag 'ambiguous'
 *   3. FUZZY — whitespace+punct-normalized substring match → 'fuzzy'
 *   4. WORD-SET — windowed search where ≥80% of anchor words appear → 'fuzzy'
 *   5. NOT_FOUND — anchor isn't recognizable → caller marks evidence_valid=false
 *
 * Returns: { start_char, end_char, anchor_match_quality, anchor_match_count }
 *   start_char/end_char are RAW match positions (caller still applies sliceEvidence
 *   to expand to ≥150 chars + word-snap).
 */
export function findAnchorRange(transcript, anchorQuote, opts = {}) {
  if (typeof transcript !== 'string' || !transcript.length) {
    return { start_char: null, end_char: null, anchor_match_quality: 'not_found', anchor_match_count: 0 };
  }
  if (typeof anchorQuote !== 'string' || !anchorQuote.length) {
    return { start_char: null, end_char: null, anchor_match_quality: 'not_found', anchor_match_count: 0 };
  }
  const cleaned = anchorQuote.trim();
  if (cleaned.length < 5) {
    return { start_char: null, end_char: null, anchor_match_quality: 'not_found', anchor_match_count: 0 };
  }

  // 1. Exact match (count all occurrences)
  const exactMatches = [];
  let idx = transcript.indexOf(cleaned);
  while (idx !== -1) {
    exactMatches.push(idx);
    if (exactMatches.length >= 50) break; // sanity bound
    idx = transcript.indexOf(cleaned, idx + 1);
  }
  if (exactMatches.length === 1) {
    return {
      start_char: exactMatches[0],
      end_char: exactMatches[0] + cleaned.length,
      anchor_match_quality: 'exact',
      anchor_match_count: 1,
    };
  }
  if (exactMatches.length > 1) {
    const pick = Number.isFinite(opts.hintCenter)
      ? exactMatches.reduce((best, x) =>
          Math.abs(x - opts.hintCenter) < Math.abs(best - opts.hintCenter) ? x : best,
          exactMatches[0])
      : exactMatches[0];
    return {
      start_char: pick,
      end_char: pick + cleaned.length,
      anchor_match_quality: 'ambiguous',
      anchor_match_count: exactMatches.length,
    };
  }

  // 2. Whitespace+punct-normalized substring fuzzy match
  const normAnchor = normalizeForFuzzy(cleaned);
  if (normAnchor.length >= 5) {
    const normTranscript = normalizeForFuzzy(transcript);
    const fuzzyIdx = normTranscript.indexOf(normAnchor);
    if (fuzzyIdx !== -1) {
      const approxStart = mapNormalizedIndexToOriginal(transcript, fuzzyIdx);
      // Estimate end: fuzzy normalization may have collapsed chars; bound to anchor length × 1.6
      const approxEnd = Math.min(transcript.length, approxStart + Math.ceil(cleaned.length * 1.4));
      return {
        start_char: approxStart,
        end_char: approxEnd,
        anchor_match_quality: 'fuzzy',
        anchor_match_count: 1,
      };
    }
  }

  // 3. Word-set fallback — windowed search; require ≥80% of anchor's words present
  const anchorWords = cleaned.toLowerCase().match(/[a-z][a-z0-9-']*/g) || [];
  const meaningful = anchorWords.filter(w => w.length > 2);
  if (meaningful.length >= 5) {
    const windowSize = Math.max(200, cleaned.length * 2);
    const step = Math.max(50, Math.floor(windowSize / 4));
    let bestStart = null;
    let bestScore = 0;
    const txLower = transcript.toLowerCase();
    for (let i = 0; i < transcript.length; i += step) {
      const window = txLower.slice(i, i + windowSize);
      let matched = 0;
      for (const w of meaningful) if (window.includes(w)) matched++;
      const score = matched / meaningful.length;
      if (score > bestScore && score >= 0.8) {
        bestScore = score;
        bestStart = i;
      }
    }
    if (bestStart !== null) {
      return {
        start_char: bestStart,
        end_char: Math.min(transcript.length, bestStart + Math.ceil(cleaned.length * 1.5)),
        anchor_match_quality: 'fuzzy',
        anchor_match_count: 1,
      };
    }
  }

  // 4. Not found
  return { start_char: null, end_char: null, anchor_match_quality: 'not_found', anchor_match_count: 0 };
}

function normalizeForFuzzy(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\[\d{2}:\d{2}:\d{2}(\.\d+)?\]/g, '')
    .replace(/[…]/g, '')
    .replace(/\.\.\./g, '')
    .replace(/[""'']/g, "'")
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Map an index in the normalized transcript back to an approximate position
// in the original transcript. We walk the original and tick a normalized
// counter for every meaningful char we'd have emitted in normalizeForFuzzy.
function mapNormalizedIndexToOriginal(original, normIdx) {
  let normCounter = 0;
  let lastEmittedSpace = true;
  for (let i = 0; i < original.length; i++) {
    const c = original[i];
    const isWs = /\s/.test(c);
    const isWordCh = /[a-zA-Z0-9']/.test(c);
    if (isWs) {
      if (!lastEmittedSpace) {
        if (normCounter >= normIdx) return i;
        normCounter++;
        lastEmittedSpace = true;
      }
    } else if (isWordCh) {
      if (normCounter >= normIdx) return i;
      normCounter++;
      lastEmittedSpace = false;
    } else {
      // punctuation / brackets — collapse to single space
      if (!lastEmittedSpace) {
        if (normCounter >= normIdx) return i;
        normCounter++;
        lastEmittedSpace = true;
      }
    }
  }
  return Math.max(0, original.length - 1);
}
