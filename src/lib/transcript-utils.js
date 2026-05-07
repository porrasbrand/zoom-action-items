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
