/**
 * Confidence Calculator - Determines green/yellow/red confidence signal
 * Based on keyword ratio and extraction quality
 */

/**
 * Calculate confidence signal for a meeting's extraction
 * @param {Object} scanResult - Result from keyword scanner
 * @param {number} actionItemCount - Number of extracted action items
 * @param {string} transcriptRaw - Raw transcript text
 * @param {string} meetingStatus - Meeting processing status
 * @returns {Object} Confidence assessment
 */
export function calculateConfidence(scanResult, actionItemCount, transcriptRaw, meetingStatus = 'completed') {
  const keywordCount = scanResult?.totalPhrases || 0;
  const transcriptLength = transcriptRaw?.length || 0;

  // Handle edge cases first
  if (meetingStatus === 'error' || meetingStatus === 'failed') {
    return {
      signal: 'red',
      ratio: 0,
      reason: 'Extraction failed — manual review required',
      keywordCount,
      itemCount: actionItemCount
    };
  }

  if (!transcriptRaw || transcriptLength < 100) {
    return {
      signal: 'red',
      ratio: 0,
      reason: 'No transcript available — cannot validate',
      keywordCount,
      itemCount: actionItemCount
    };
  }

  // Calculate ratio
  const ratio = actionItemCount > 0 ? (keywordCount / actionItemCount) : (keywordCount > 0 ? Infinity : 0);

  // Determine signal based on thresholds
  let signal, reason;

  if (ratio > 10 || (keywordCount > 20 && actionItemCount === 0)) {
    // Red: Very high ratio or many keywords with no items
    signal = 'red';
    reason = `High keyword ratio (${ratio === Infinity ? '∞' : ratio.toFixed(1)}:1) — manual review required`;
  } else if (ratio > 5 || actionItemCount === 0 || transcriptLength < 500) {
    // Yellow: Moderate concern
    signal = 'yellow';
    if (actionItemCount === 0 && keywordCount > 0) {
      reason = `${keywordCount} commitment phrases but no items extracted — review recommended`;
    } else if (transcriptLength < 500) {
      reason = `Short transcript (${transcriptLength} chars) — may be incomplete`;
    } else {
      reason = `Elevated keyword ratio (${ratio.toFixed(1)}:1) — review recommended`;
    }
  } else {
    // Green: Normal extraction
    signal = 'green';
    reason = `Keywords align with items (ratio ${ratio.toFixed(1)}:1)`;
  }

  return {
    signal,
    ratio: ratio === Infinity ? -1 : parseFloat(ratio.toFixed(2)),
    reason,
    keywordCount,
    itemCount: actionItemCount,
    categories: scanResult?.categories || {}
  };
}

export default { calculateConfidence };
