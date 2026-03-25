/**
 * Summary Section Detector
 * Pattern-based detection of end-of-meeting action item recaps.
 *
 * B3X meetings consistently end with Dan Kuschell or Phil Mutrie
 * delivering a verbal summary of action items.
 */

// Known summary-givers
const KNOWN_SPEAKERS = [
  'dan kuschell',
  'dan',
  'philip mutrie',
  'phil mutrie',
  'phil',
  'philip'
];

// Trigger phrases that indicate the start of a summary
const SUMMARY_TRIGGERS = [
  /(?:action\s+(?:steps|items)|recap|to summarize|quick summary)/i,
  /(?:here'?s?\s+what\s+we\s+(?:need|have))/i,
  /(?:implementation\s+items|tasks\s+from\s+this)/i,
  /(?:number\s+one|first\s+thing|so,?\s+number\s+one)/i,
  /(?:let\s+me\s+(?:just\s+)?(?:summarize|recap))/i,
  /(?:to\s+wrap\s+up|wrapping\s+up)/i,
  /(?:key\s+(?:takeaways|action\s+items))/i
];

/**
 * Parse a transcript line to extract timestamp, speaker, and text
 * Handles VTT format: [00:14:23.970] Speaker Name: text
 */
function parseLine(line) {
  // Match VTT format: [HH:MM:SS.mmm] Speaker: text or [HH:MM:SS] Speaker: text
  const vttMatch = line.match(/^\[(\d{2}):(\d{2}):(\d{2})(?:\.\d{3})?\]\s*([^:]+):\s*(.*)$/);
  if (vttMatch) {
    return {
      hours: parseInt(vttMatch[1]),
      mins: parseInt(vttMatch[2]),
      secs: parseInt(vttMatch[3]),
      speaker: vttMatch[4].trim(),
      text: vttMatch[5].trim(),
      raw: line
    };
  }

  // Simple format: Speaker: text
  const simpleMatch = line.match(/^([^:]+):\s*(.*)$/);
  if (simpleMatch) {
    return {
      speaker: simpleMatch[1].trim(),
      text: simpleMatch[2].trim(),
      raw: line
    };
  }

  return { text: line.trim(), raw: line };
}

/**
 * Check if a speaker is a known summary-giver
 */
function isKnownSpeaker(speaker) {
  if (!speaker) return false;
  const normalized = speaker.toLowerCase().trim();
  return KNOWN_SPEAKERS.some(known => normalized.includes(known));
}

/**
 * Check if text contains a summary trigger phrase
 */
function hasSummaryTrigger(text) {
  if (!text) return false;
  return SUMMARY_TRIGGERS.some(pattern => pattern.test(text));
}

/**
 * Detect the summary section in a transcript
 *
 * @param {string} transcript - Full transcript text
 * @returns {object} Detection result with startLine, endLine, summaryText, speaker, confidence
 */
export function detectSummary(transcript) {
  if (!transcript) {
    return { detected: false, reason: 'No transcript provided' };
  }

  const lines = transcript.split('\n').filter(l => l.trim());
  const totalLines = lines.length;

  if (totalLines < 10) {
    return { detected: false, reason: 'Transcript too short' };
  }

  // Scan last 20% of transcript
  const scanStart = Math.floor(totalLines * 0.80);
  const tailLines = lines.slice(scanStart);

  let summaryStartIdx = -1;
  let summarySpeaker = null;
  let confidence = 'low';

  // Look for trigger phrase from a known speaker
  for (let i = 0; i < tailLines.length; i++) {
    const parsed = parseLine(tailLines[i]);

    if (parsed.speaker && hasSummaryTrigger(parsed.text)) {
      if (isKnownSpeaker(parsed.speaker)) {
        // High confidence: known speaker + trigger phrase
        summaryStartIdx = scanStart + i;
        summarySpeaker = parsed.speaker;
        confidence = 'high';
        break;
      } else if (summaryStartIdx === -1) {
        // Lower confidence: trigger phrase but unknown speaker
        summaryStartIdx = scanStart + i;
        summarySpeaker = parsed.speaker;
        confidence = 'medium';
      }
    }
  }

  // Fallback: if no trigger found, check if Dan/Phil speaks in last 15%
  if (summaryStartIdx === -1) {
    const fallbackStart = Math.floor(totalLines * 0.85);
    for (let i = fallbackStart; i < totalLines; i++) {
      const parsed = parseLine(lines[i]);
      if (parsed.speaker && isKnownSpeaker(parsed.speaker)) {
        summaryStartIdx = i;
        summarySpeaker = parsed.speaker;
        confidence = 'low';
        break;
      }
    }
  }

  if (summaryStartIdx === -1) {
    return { detected: false, reason: 'No summary section found' };
  }

  // Find end of summary: meeting ends or another speaker takes over for >3 lines
  let summaryEndIdx = totalLines - 1;
  let otherSpeakerCount = 0;
  const normalizedSummarySpeaker = summarySpeaker.toLowerCase();

  for (let i = summaryStartIdx + 1; i < totalLines; i++) {
    const parsed = parseLine(lines[i]);
    if (parsed.speaker) {
      const normalizedCurrent = parsed.speaker.toLowerCase();
      const isSameSpeaker = normalizedCurrent.includes(normalizedSummarySpeaker.split(' ')[0]) ||
                           normalizedSummarySpeaker.includes(normalizedCurrent.split(' ')[0]);

      if (!isSameSpeaker && !isKnownSpeaker(parsed.speaker)) {
        otherSpeakerCount++;
        if (otherSpeakerCount > 3) {
          summaryEndIdx = i - 4;
          break;
        }
      } else {
        otherSpeakerCount = 0;
      }
    }
  }

  // Extract summary text
  const summaryLines = lines.slice(summaryStartIdx, summaryEndIdx + 1);
  const summaryText = summaryLines.map(l => {
    const parsed = parseLine(l);
    return parsed.text || l;
  }).join(' ');

  return {
    detected: true,
    startLine: summaryStartIdx,
    endLine: summaryEndIdx,
    lineCount: summaryEndIdx - summaryStartIdx + 1,
    summaryText: summaryText.trim(),
    summaryLines: summaryLines,
    speaker: summarySpeaker,
    confidence,
    totalLines
  };
}

export default { detectSummary };
