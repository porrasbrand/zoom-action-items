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
    const apiName = process.env.VERIFIER_MODEL || 'gemini-2.0-flash';
    const generationConfig = {
      temperature: 0.3,
      maxOutputTokens: 8192,
      responseMimeType: 'application/json',
    };
    // Disable Gemini-2.5/3 chain-of-thought so it doesn't eat the output budget
    // and produce truncated JSON.
    if (/2\.5-flash|3-flash-preview|3\.1-flash/.test(apiName)) {
      generationConfig.thinkingConfig = { thinkingBudget: 0 };
    }
    const genAI = new GoogleGenerativeAI(apiKey);
    model = genAI.getGenerativeModel({ model: apiName, generationConfig });
  }
  return model;
}

export const ADVERSARIAL_PROMPT = `You are a skeptical auditor reviewing action item extraction from a B3X agency meeting.
Your job is to find what was MISSED, not to validate what was found.

EXTRACTED ITEMS (treat these as potentially incomplete):
{extracted_items}

ORIGINAL TRANSCRIPT:
{transcript}

PRIMARY FOCUS: Identify B3X-side commitments — things B3X team members
(Phil, Bill, Dan, Manuel, Vince, Jacob, Nicole, Sarah, Allysa, Juan, Richard,
Ray, Raz) committed to do for clients or for each other internally.
These are tasks B3X must execute and track in ProofHub.

SECONDARY: Note client-side commitments separately. Things the CLIENT
promised to do (e.g., "I'll send you the list", "we'll review by Friday").
Return them in a separate \`client_commitments\` array — same evidence schema
as missed_items, but for tracking-not-execution.

(B3X team list above is authoritative — anyone with @breakthrough3x.com
email is also B3X internal even if not listed.)

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

3. For each potentially missed item, provide this EXACT schema:
   {
     "title": "what needs to be done (clear, actionable)",
     "owner": "who is responsible (use exact name from transcript)",
     "evidence": {
       "start_char": <integer 0-based offset into the transcript text we provided>,
       "end_char": <integer 0-based offset, exclusive>,
       "speaker": "speaker name as it appears in transcript",
       "summary": "1-sentence summary of what was said in your own words"
     },
     "confidence": "HIGH/MEDIUM/LOW",
     "severity": "catastrophic" | "important" | "nice-to-have",
     "reasoning": "why this is a commitment/task that should be tracked"
   }

SEVERITY ASSIGNMENT — REQUIRED on every missed_item AND every client_commitment:

  catastrophic — Missing this item would directly damage the client relationship
                 OR cost B3X significant revenue. Examples: missed contract
                 review, unpaid invoice follow-up, broken promise to client
                 about a deliverable, commitment with money / contract / legal
                 stakes, or anything tied to a stop-the-account threat.

  important    — Missing this would cause friction, delay, or rework. Most
                 operational commitments fall here. Examples: send a doc,
                 schedule a meeting, update a tracker, follow up on a
                 question, run a campaign, edit a page.

  nice-to-have — Discussed but low-stakes. Casual mentions, ideas-to-explore,
                 informal "we should look into X" without ownership.

Be CONSERVATIVE with 'catastrophic' — reserve it for genuinely high-stakes
items. When in doubt, choose 'important'. Most meetings have zero
catastrophic items.

CRITICAL OFFSET RULES:
- start_char/end_char are character offsets into the transcript text we provided above (after "ORIGINAL TRANSCRIPT:")
- The slice transcript[start_char:end_char] MUST be the exact text where this commitment was made
- The evidence span should be 50-300 characters (long enough to be meaningful, short enough to be precise)
- Do NOT paraphrase or copy text into the JSON — just give us the offsets, our backend will render the slice
- If you cannot identify a precise span, lower the confidence to LOW or skip the item entirely

4. HIGH confidence: Explicit verbal commitment ("I will do X", "I'll handle that")
   MEDIUM confidence: Implied commitment or request that should probably be tracked
   LOW confidence: Vague or uncertain - might be a task, might be casual discussion

Return JSON:
{
  "missed_items": [...],         // B3X-side commitments, schema above
  "client_commitments": [...],   // Client-side promises, same schema
  "verification_notes": "brief summary of your review process and what you checked",
  "completeness_assessment": "complete|mostly_complete|incomplete",
  "sections_with_possible_commitments": ["line/timestamp ranges or short snippets that could contain commitments but were too vague to extract confidently"]
}

CRITICAL RULES:
- Do NOT re-extract items that are already in the EXTRACTED ITEMS list (even if worded differently)
- Only return genuinely NEW items that were missed
- Finding nothing missed is FINE if the extraction is thorough - say "completeness_assessment": "complete"
- If you find items, explain WHY they were likely missed (casual language, implied commitment, etc.)
- LOW confidence items should only be included if there's reasonable doubt they're real tasks

DEDUPLICATION GUIDANCE:
The EXTRACTED ITEMS list above may describe the same commitment from a
different speaker's POV. For example, an existing item "Discuss budget
with Amy" assigned to Ryan IS THE SAME commitment as "Phil confirms
budget will be discussed in next session" — different speaker, same
commitment.

When you find a candidate that matches an existing item by:
  - Same outcome verb (discuss/decide/send/review/update)
  - Same primary object/topic (e.g., budget, proposal, email)
  - Same time window OR both undated
  - Same meeting scope

…do NOT include it in missed_items, even if the speaker or phrasing differs.
Owner attribution is NOT part of identity — speaker vs executor mismatches
must dedup. A deterministic backstop runs after your output, but please
reduce the load by self-deduping when the match is obvious.

BEFORE OUTPUT: validate that every start_char/end_char points to a span
that actually contains a commitment when sliced. If you cannot verify
that the slice contains the commitment, mark confidence LOW or skip
the item entirely. Quality over quantity.`;

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
    const filteredClient = (parsed.client_commitments || []).filter(item =>
      item.confidence === 'HIGH' || item.confidence === 'MEDIUM'
    );

    return {
      missed_items: filteredItems,
      client_commitments: filteredClient,
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
