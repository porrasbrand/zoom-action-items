/**
 * Adversarial Verifier - Skeptical auditor that finds missed action items
 * Runs as a second Gemini call after primary extraction
 */

import { GoogleGenerativeAI } from '@google/generative-ai';

let model = null;

function getModel() {
  if (!model) {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error('Missing GOOGLE_API_KEY');

    const genAI = new GoogleGenerativeAI(apiKey);
    model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      generationConfig: {
        temperature: 0.3,
        maxOutputTokens: 4000,
        responseMimeType: 'application/json',
      },
    });
  }
  return model;
}

const ADVERSARIAL_PROMPT = `You are a skeptical auditor reviewing action item extraction from a business meeting.
Your job is to find what was MISSED, not to validate what was found.

EXTRACTED ITEMS (treat these as potentially incomplete):
{extracted_items}

ORIGINAL TRANSCRIPT:
{transcript}

Your task:
1. Read the ENTIRE transcript carefully, not just the parts around extracted items
2. Look specifically for:
   - Verbal commitments using casual language ("I'll take care of that", "lemme handle", "sure thing", "yeah I'll knock that out")
   - Implied commitments ("that shouldn't be a problem" = someone will do something)
   - Client requests that weren't captured as action items
   - Time-sensitive items ("before the call tomorrow", "by end of week")
   - Conditional commitments ("if X happens, we'll need to Y")
   - Agreements or promises made during discussion
   - "I need to..." or "We should..." statements that indicate tasks

3. For each potentially missed item, provide:
   {
     "title": "what needs to be done (clear, actionable)",
     "owner": "who is responsible (use exact name from transcript)",
     "source_quote": "exact 2-4 lines from transcript where this was discussed - VERBATIM with speaker names",
     "confidence": "HIGH/MEDIUM/LOW",
     "reasoning": "why this is a commitment/task that should be tracked"
   }

4. HIGH confidence: Explicit verbal commitment ("I will do X", "I'll handle that")
   MEDIUM confidence: Implied commitment or request that should probably be tracked
   LOW confidence: Vague or uncertain - might be a task, might be casual discussion

Return JSON:
{
  "missed_items": [...],
  "verification_notes": "brief summary of your review process and what you checked",
  "completeness_assessment": "complete|mostly_complete|incomplete",
  "sections_with_possible_commitments": ["line/timestamp ranges or quotes that seemed like they could contain commitments but were too vague to extract confidently"]
}

CRITICAL RULES:
- Do NOT re-extract items that are already in the EXTRACTED ITEMS list (even if worded differently)
- Only return genuinely NEW items that were missed
- Finding nothing missed is FINE if the extraction is thorough - say "completeness_assessment": "complete"
- If you find items, explain WHY they were likely missed (casual language, implied commitment, etc.)
- LOW confidence items should only be included if there's reasonable doubt they're real tasks`;

/**
 * Run adversarial verification on a meeting's extraction
 * @param {string} transcript - The raw meeting transcript
 * @param {Array} extractedItems - Array of already-extracted action items
 * @returns {Promise<object>} Verification result with missed_items and assessment
 */
export async function verifyExtraction(transcript, extractedItems) {
  if (!transcript || transcript.length < 100) {
    return {
      missed_items: [],
      verification_notes: 'Transcript too short to verify',
      completeness_assessment: 'incomplete',
      sections_with_possible_commitments: [],
      error: 'Transcript too short'
    };
  }

  const gemini = getModel();

  // Format extracted items for the prompt
  const itemsList = extractedItems.map((item, i) =>
    `${i + 1}. "${item.title}" (Owner: ${item.owner_name || 'TBD'})`
  ).join('\n') || '(No items were extracted)';

  const prompt = ADVERSARIAL_PROMPT
    .replace('{extracted_items}', itemsList)
    .replace('{transcript}', transcript.slice(0, 80_000)); // Leave room for prompt

  try {
    const result = await gemini.generateContent(prompt);
    const response = result.response;
    const text = response.text();

    const usage = response.usageMetadata;
    console.log(`  Adversarial: ${usage?.promptTokenCount || '?'} in / ${usage?.candidatesTokenCount || '?'} out tokens`);

    const parsed = JSON.parse(text);

    // Filter out LOW confidence items - only keep HIGH and MEDIUM
    const filteredItems = (parsed.missed_items || []).filter(item =>
      item.confidence === 'HIGH' || item.confidence === 'MEDIUM'
    );

    return {
      missed_items: filteredItems,
      all_findings: parsed.missed_items || [], // Keep all for logging
      verification_notes: parsed.verification_notes || '',
      completeness_assessment: parsed.completeness_assessment || 'unknown',
      sections_with_possible_commitments: parsed.sections_with_possible_commitments || []
    };
  } catch (err) {
    console.error('  Adversarial verification failed:', err.message);
    return {
      missed_items: [],
      verification_notes: 'Verification failed: ' + err.message,
      completeness_assessment: 'error',
      sections_with_possible_commitments: [],
      error: err.message
    };
  }
}

export default { verifyExtraction };
