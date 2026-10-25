/**
 * Coverage Analyzer - Classifies transcript sections by action item coverage
 * Identifies gaps where commitment language exists but no action item was extracted
 */

/**
 * Analyze transcript coverage against extracted action items
 * @param {string} transcript - Raw transcript text
 * @param {Array} actionItems - Array of action items with transcript_excerpt
 * @param {Object} keywordResults - Results from keyword scanner (commitmentPhrases)
 * @returns {Object} Coverage analysis with sections, stats, and gaps
 */
export function analyzeCoverage(transcript, actionItems, keywordResults) {
  if (!transcript || transcript.length < 100) {
    return {
      sections: [],
      stats: {
        totalSections: 0,
        citedSections: 0,
        flaggedSections: 0,
        cleanSections: 0,
        coveragePercent: 0
      },
      gaps: []
    };
  }

  const lines = transcript.split('\n');
  const SECTION_SIZE = 10; // Lines per section

  // Build a set of cited line ranges from action item excerpts
  const citedLines = new Set();
  const citedItemMap = new Map(); // line -> action item id

  for (const item of actionItems) {
    if (!item.transcript_excerpt) continue;

    // Find where this excerpt appears in the transcript
    const excerptLines = item.transcript_excerpt.split('\n').map(l => l.trim()).filter(l => l);
    for (const excerptLine of excerptLines) {
      // Find matching line in transcript (fuzzy match - first 50 chars)
      const searchText = excerptLine.slice(0, 50).toLowerCase();
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(searchText)) {
          // Mark a range around the match
          for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j++) {
            citedLines.add(j);
            citedItemMap.set(j, item.id);
          }
          break;
        }
      }
    }
  }

  // Build a set of flagged lines from keyword results
  const flaggedLines = new Map(); // line -> phrase info
  for (const phrase of (keywordResults?.commitmentPhrases || [])) {
    const lineNum = phrase.line - 1; // Convert to 0-indexed
    if (!citedLines.has(lineNum)) {
      flaggedLines.set(lineNum, phrase);
    }
  }

  // Build sections
  const sections = [];
  for (let i = 0; i < lines.length; i += SECTION_SIZE) {
    const endLine = Math.min(i + SECTION_SIZE - 1, lines.length - 1);
    const sectionLines = lines.slice(i, endLine + 1);
    const text = sectionLines.join('\n');

    // Check if any line in this section is cited
    let type = 'clean';
    let actionItemId = null;
    let phrases = [];

    for (let j = i; j <= endLine; j++) {
      if (citedLines.has(j)) {
        type = 'cited';
        actionItemId = citedItemMap.get(j);
        break;
      }
    }

    // If not cited, check if flagged
    if (type === 'clean') {
      for (let j = i; j <= endLine; j++) {
        if (flaggedLines.has(j)) {
          type = 'flagged';
          phrases.push(flaggedLines.get(j));
        }
      }
    }

    sections.push({
      startLine: i,
      endLine,
      type,
      text: text.slice(0, 200) + (text.length > 200 ? '...' : ''),
      actionItemId,
      phrases: phrases.length > 0 ? phrases : undefined
    });
  }

  // Calculate stats
  const citedSections = sections.filter(s => s.type === 'cited').length;
  const flaggedSections = sections.filter(s => s.type === 'flagged').length;
  const cleanSections = sections.filter(s => s.type === 'clean').length;
  const totalSections = sections.length;
  const coveragePercent = totalSections > 0
    ? Math.round((citedSections + cleanSections) / totalSections * 100)
    : 0;

  // Build gaps list (individual flagged phrases)
  const gaps = [];
  for (const [lineNum, phrase] of flaggedLines) {
    gaps.push({
      line: lineNum + 1, // Convert back to 1-indexed
      text: lines[lineNum]?.trim() || phrase.context,
      phrase: phrase.text,
      type: phrase.type
    });
  }

  // Sort gaps by line number
  gaps.sort((a, b) => a.line - b.line);

  return {
    sections,
    stats: {
      totalSections,
      citedSections,
      flaggedSections,
      cleanSections,
      coveragePercent
    },
    gaps
  };
}

/**
 * Classify each line of transcript for detailed highlighting
 * @param {string} transcript - Raw transcript text
 * @param {Array} actionItems - Action items with transcript_excerpt
 * @param {Object} keywordResults - Keyword scan results
 * @returns {Array} Array of line classifications
 */
export function classifyLines(transcript, actionItems, keywordResults) {
  if (!transcript) return [];

  const lines = transcript.split('\n');
  const classifications = [];

  // Build cited and flagged line sets (same logic as above)
  const citedLines = new Set();
  for (const item of actionItems) {
    if (!item.transcript_excerpt) continue;
    const excerptLines = item.transcript_excerpt.split('\n').map(l => l.trim()).filter(l => l);
    for (const excerptLine of excerptLines) {
      const searchText = excerptLine.slice(0, 50).toLowerCase();
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(searchText)) {
          for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + 1); j++) {
            citedLines.add(j);
          }
          break;
        }
      }
    }
  }

  const flaggedLines = new Set();
  for (const phrase of (keywordResults?.commitmentPhrases || [])) {
    const lineNum = phrase.line - 1;
    if (!citedLines.has(lineNum)) {
      flaggedLines.add(lineNum);
    }
  }

  // Classify each line
  for (let i = 0; i < lines.length; i++) {
    let type = 'clean';
    if (citedLines.has(i)) type = 'cited';
    else if (flaggedLines.has(i)) type = 'flagged';

    classifications.push({
      line: i + 1,
      type,
      text: lines[i]
    });
  }

  return classifications;
}

export default { analyzeCoverage, classifyLines };
