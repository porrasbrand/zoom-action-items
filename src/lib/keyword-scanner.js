/**
 * Keyword Scanner - Scans transcripts for commitment phrases
 * Used for validation confidence signals
 */

// Commitment patterns to detect
const PATTERNS = [
  { type: 'first_person_commitment', regex: /\b(I'll|I will|I'm going to|I can|let me|I should)\s+\w+/gi },
  { type: 'we_commitment', regex: /\b(we'll|we will|we can|we should|we're going to|we need to)\s+\w+/gi },
  { type: 'request', regex: /\b(can you|could you|would you|will you|please)\s+\w+/gi },
  { type: 'deadline_mention', regex: /\b(by|before|until)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|end of (?:day|week)|EOD|EOW|next week|ASAP|urgent)/gi },
  { type: 'explicit_marker', regex: /\b(action item|todo|to-do|follow.?up|deliverable|next step)/gi }
];

// Exclusion patterns - common phrases that look like commitments but aren't
const EXCLUSIONS = [
  /\b(I'll tell you|we'll see|can you believe|I will say|you'll see|we'll find out)\b/i,
  /\b(he'll|she'll|they'll|he said|she said|he will|she will|they will)\b/i,
  /\b(I'll be|we'll be)\s+(right back|there|honest|frank|happy to)\b/i,
  /\b(I can't|I cannot|we can't|we cannot|I couldn't|we couldn't)\b/i,
  /\b(can you hear|can you see|will you be)\b/i,
  /\bplease\s+(hold|wait|standby)\b/i
];

/**
 * Check if a phrase matches any exclusion pattern
 */
function isExcluded(phrase) {
  return EXCLUSIONS.some(exclusion => exclusion.test(phrase));
}

/**
 * Scan a transcript for commitment phrases
 * @param {string} transcriptText - The raw transcript text
 * @returns {Object} Scan results with phrases and categories
 */
export function scanTranscript(transcriptText) {
  if (!transcriptText || typeof transcriptText !== 'string') {
    return {
      totalPhrases: 0,
      commitmentPhrases: [],
      categories: {
        first_person_commitment: 0,
        we_commitment: 0,
        request: 0,
        deadline_mention: 0,
        explicit_marker: 0
      }
    };
  }

  const lines = transcriptText.split('\n');
  const commitmentPhrases = [];
  const categories = {
    first_person_commitment: 0,
    we_commitment: 0,
    request: 0,
    deadline_mention: 0,
    explicit_marker: 0
  };

  lines.forEach((line, lineIndex) => {
    // Skip empty lines
    if (!line.trim()) return;

    for (const pattern of PATTERNS) {
      // Reset regex state
      pattern.regex.lastIndex = 0;

      let match;
      while ((match = pattern.regex.exec(line)) !== null) {
        const phrase = match[0];

        // Check against exclusions (with some context)
        const contextStart = Math.max(0, match.index - 20);
        const contextEnd = Math.min(line.length, match.index + phrase.length + 20);
        const context = line.slice(contextStart, contextEnd);

        if (!isExcluded(context)) {
          commitmentPhrases.push({
            line: lineIndex + 1,
            text: phrase.trim(),
            type: pattern.type,
            context: line.trim().slice(0, 100)
          });
          categories[pattern.type]++;
        }
      }
    }
  });

  return {
    totalPhrases: commitmentPhrases.length,
    commitmentPhrases,
    categories
  };
}

export default { scanTranscript };
