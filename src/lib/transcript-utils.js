/**
 * Helpers for working with transcripts + verifier offset evidence.
 *
 * sliceEvidence: deterministic slice from char offsets, with sanity bounds.
 * canonicalCandidateHash: dedup key for missed_item candidates so the same
 *   commitment phrased differently across models collapses to one row.
 */

/**
 * Slice a transcript by 0-based character offsets. Returns null if the
 * range is invalid or the resulting span is suspiciously short/long.
 */
export function sliceEvidence(transcript, startChar, endChar) {
  if (typeof transcript !== 'string') return null;
  const s = Number(startChar);
  const e = Number(endChar);
  if (!Number.isInteger(s) || !Number.isInteger(e)) return null;
  const start = Math.max(0, Math.min(s, transcript.length));
  const end = Math.max(start, Math.min(e, transcript.length));
  const len = end - start;
  if (len < 5 || len > 600) return null;
  return transcript.slice(start, end);
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
