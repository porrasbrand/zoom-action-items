/**
 * Summary Section Extractor
 * Uses Gemini to extract action items from JUST the recap section.
 * This is a much cheaper call than full-transcript extraction.
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
        temperature: 0.1, // Low temperature for precise extraction
        maxOutputTokens: 2000,
        responseMimeType: 'application/json',
      },
    });
  }
  return model;
}

const SUMMARY_EXTRACTION_PROMPT = `This is the end-of-meeting action item recap from a business meeting.
The speaker is summarizing what was agreed upon during the call.

Extract ONLY the action items explicitly stated in this recap.
Do NOT infer or add items — only extract what the speaker explicitly assigns.

MEETING: {topic}
CLIENT: {client_name}
SPEAKER: {speaker}

RECAP:
{summary_text}

Return JSON:
{
  "items": [
    {
      "title": "Clear, actionable task title",
      "owner": "Person assigned (use exact name spoken)",
      "due_date": "YYYY-MM-DD or null if not mentioned",
      "priority": "high|medium|low based on urgency expressed",
      "description": "Additional context if provided"
    }
  ]
}

Rules:
- Only include items EXPLICITLY stated in the recap
- Do NOT infer tasks from context
- If the speaker says "number one" or "first thing", treat that as an item
- Use the exact owner name as spoken
- If no due date mentioned, set to null
- Keep titles concise but specific`;

/**
 * Extract action items from summary section
 *
 * @param {string} summaryText - The extracted summary text
 * @param {object} context - Meeting context (topic, clientName, speaker)
 * @returns {Promise<object>} Extracted items
 */
export async function extractSummaryItems(summaryText, context = {}) {
  if (!summaryText || summaryText.length < 50) {
    return { items: [], error: 'Summary text too short' };
  }

  const gemini = getModel();

  const prompt = SUMMARY_EXTRACTION_PROMPT
    .replace('{topic}', context.topic || 'Unknown')
    .replace('{client_name}', context.clientName || 'Unknown')
    .replace('{speaker}', context.speaker || 'Unknown')
    .replace('{summary_text}', summaryText);

  try {
    const result = await gemini.generateContent(prompt);
    const response = result.response;
    const text = response.text();

    const usage = response.usageMetadata;
    console.log(`  [Summary Extractor] Gemini: ${usage?.promptTokenCount || '?'} in / ${usage?.candidatesTokenCount || '?'} out tokens`);

    const parsed = JSON.parse(text);
    return {
      items: parsed.items || [],
      tokensIn: usage?.promptTokenCount,
      tokensOut: usage?.candidatesTokenCount
    };
  } catch (err) {
    console.error('  [Summary Extractor] Error:', err.message);
    return { items: [], error: err.message };
  }
}

export default { extractSummaryItems };
