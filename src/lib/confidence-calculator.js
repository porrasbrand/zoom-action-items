/**
 * Confidence Calculator — green/yellow/red dashboard signal.
 *
 * Path-C upgrade (2026-05-06): the AI adversarial verifier's
 * completeness_assessment is now the PRIMARY signal source. The regex
 * keyword ratio is fallback-only and no longer escalates to red on
 * ratio alone (that rule produced the false positive on the 88k-char
 * 2-Part Huddle).
 */

/**
 * @param {Object}  scanResult       — keyword-scanner output (fallback only)
 * @param {number}  actionItemCount  — # extracted action items
 * @param {string}  transcriptRaw    — raw transcript text
 * @param {string}  meetingStatus    — meeting processing status
 * @param {Object?} verifierResult   — optional adversarial-verifier output
 *                                     { completeness_assessment, missed_items: [{evidence_valid, confidence}, …] }
 */
export function calculateConfidence(scanResult, actionItemCount, transcriptRaw, meetingStatus = 'completed', verifierResult = null) {
  const keywordCount = scanResult?.totalPhrases || 0;
  const transcriptLength = transcriptRaw?.length || 0;
  const baseFields = { keywordCount, itemCount: actionItemCount, categories: scanResult?.categories || {} };

  // Edge cases first
  if (meetingStatus === 'error' || meetingStatus === 'failed') {
    return { signal: 'red', ratio: 0, reason: 'Extraction failed — manual review required', source: 'edge', ...baseFields };
  }
  if (!transcriptRaw || transcriptLength < 100) {
    return { signal: 'red', ratio: 0, reason: 'No transcript available — cannot validate', source: 'edge', ...baseFields };
  }

  // PRIMARY: AI verifier assessment
  if (verifierResult?.completeness_assessment) {
    const a = verifierResult.completeness_assessment;
    const allMissed = Array.isArray(verifierResult.missed_items) ? verifierResult.missed_items : [];
    // Items with explicit evidence_valid=false are dropped from the count;
    // legacy rows without that flag are treated as valid.
    const validMissed = allMissed.filter(m => m.evidence_valid !== false);
    const highConf = validMissed.filter(m => m.confidence === 'HIGH').length;
    // Severity override (Path-C-3): 1+ catastrophic missed item → red regardless
    // of completeness_assessment. Hard rule. Per spec: 'these are the misses
    // that would lose us a client'.
    const catastrophic = validMissed.filter(m => m.severity === 'catastrophic').length;
    if (catastrophic > 0) {
      return {
        signal: 'red', ratio: 0,
        reason: `${catastrophic} CATASTROPHIC missed item${catastrophic > 1 ? 's' : ''} — review urgently`,
        source: 'verifier_severity_override',
        suggestedCount: validMissed.length,
        catastrophicCount: catastrophic,
        ...baseFields,
      };
    }

    if (a === 'complete') {
      return { signal: 'green', ratio: 0, reason: 'Verified complete by AI auditor', source: 'verifier', suggestedCount: 0, ...baseFields };
    }
    if (a === 'mostly_complete') {
      return {
        signal: 'yellow',
        ratio: 0,
        reason: highConf > 0 ? `${highConf} possible missed items — review` : 'Minor verifier notes — see panel',
        source: 'verifier',
        suggestedCount: validMissed.length,
        ...baseFields,
      };
    }
    // 'incomplete' or anything else
    return {
      signal: highConf > 0 ? 'red' : 'yellow',
      ratio: 0,
      reason: highConf > 0 ? `${highConf} likely missed items — review required` : `Verifier flagged ${validMissed.length} possible items`,
      source: 'verifier',
      suggestedCount: validMissed.length,
      ...baseFields,
    };
  }

  // FALLBACK: regex (verifier hasn't run yet / failed)
  // Drop the >10:1 ratio rule — caused the 88k Huddle / 23.5:1 false positive.
  // Only keep the 'lots of phrases but 0 items' yellow flag.
  const ratio = actionItemCount > 0 ? (keywordCount / actionItemCount) : (keywordCount > 0 ? Infinity : 0);
  const ratioOut = ratio === Infinity ? -1 : parseFloat(ratio.toFixed(2));

  if (actionItemCount === 0 && keywordCount > 20) {
    return {
      signal: 'yellow', ratio: ratioOut,
      reason: `${keywordCount} commitment phrases but 0 items — review`,
      source: 'regex_fallback', ...baseFields,
    };
  }
  if (transcriptLength < 500) {
    return {
      signal: 'yellow', ratio: ratioOut,
      reason: `Short transcript (${transcriptLength} chars) — may be incomplete`,
      source: 'regex_fallback', ...baseFields,
    };
  }
  // No verifier result yet → pending, not red. Verifier auto-run usually catches up within ~30s.
  return {
    signal: 'pending', ratio: ratioOut,
    reason: 'Awaiting AI verification', source: 'regex_fallback', ...baseFields,
  };
}

export default { calculateConfidence };
