/**
 * Extract action items, decisions, and summary from meeting transcript using Gemini.
 * Pattern from market-intelligence.js (hvac-keyword-research).
 */

import { GoogleGenerativeAI } from '@google/generative-ai';

let model = null;

function getModel() {
  if (!model) {
    const apiKey = process.env.GOOGLE_API_KEY;
    if (!apiKey) throw new Error('Missing GOOGLE_API_KEY');

    const genAI = new GoogleGenerativeAI(apiKey);
    model = genAI.getGenerativeModel({
      model: 'gemini-3-flash-preview',
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 4000,
        responseMimeType: 'application/json',
      },
    });
  }
  return model;
}

const EXTRACTION_PROMPT = `You are an expert meeting analyst for a digital marketing agency (Breakthrough 3x).
Analyze this meeting transcript and extract structured information.

MEETING: {topic}
CLIENT: {client_name}
DATE: {meeting_date}
SPEAKERS: {speakers}

TRANSCRIPT:
{transcript}

Extract the following in JSON format:
{
  "summary": "2-3 sentence meeting recap focusing on key outcomes",
  "attendees": ["list of people on the call"],
  "action_items": [
    {
      "title": "Clear, actionable task title",
      "description": "Additional context if needed",
      "owner": "Person responsible (use their name from transcript)",
      "due_date": "YYYY-MM-DD or null if not mentioned",
      "priority": "high|medium|low",
      "category": "seo|ads|content|design|dev|admin|other",
      "transcript_excerpt": "The 2-4 lines from the transcript where this action item was discussed. Copy VERBATIM including speaker names. Example: 'Dan: Can you get the ads updated by Friday?\\nPhilip: Yes I will handle that'"
    }
  ],
  "decisions": [
    {
      "decision": "What was decided",
      "context": "Why it was decided"
    }
  ],
  "follow_ups": ["References to past commitments or pending items mentioned"],
  "next_meeting_notes": "Key prep items or agenda topics for next meeting, or null"
}

Rules:
- Only include action items that were explicitly assigned or volunteered for
- Use exact speaker names from the transcript
- If a due date wasn't mentioned, set it to null
- Priority: "high" = urgent/blocking, "medium" = this week, "low" = nice to have
- Be concise but specific in titles
- transcript_excerpt MUST be the exact verbatim lines from the transcript where this task was discussed
- If transcript is too short or unclear, still return valid JSON with empty arrays`;

/**
 * Extract structured meeting data from transcript.
 * @param {object} params
 * @param {string} params.transcript - Parsed transcript text
 * @param {string} params.topic - Meeting topic
 * @param {string} params.clientName - Matched client name
 * @param {string} params.meetingDate - ISO date string
 * @param {string[]} params.speakers - List of speaker names
 * @returns {Promise<object>} Extracted meeting data
 */
export async function extractMeetingData({ transcript, topic, clientName, meetingDate, speakers }) {
  const gemini = getModel();

  const prompt = EXTRACTION_PROMPT
    .replace('{topic}', topic)
    .replace('{client_name}', clientName || 'Unknown')
    .replace('{meeting_date}', meetingDate || 'Unknown')
    .replace('{speakers}', speakers?.join(', ') || 'Unknown')
    .replace('{transcript}', transcript.slice(0, 100_000)); // Gemini flash handles ~1M tokens but be safe

  const result = await gemini.generateContent(prompt);
  const response = result.response;
  const text = response.text();

  const usage = response.usageMetadata;
  console.log(`  Gemini: ${usage?.promptTokenCount || '?'} in / ${usage?.candidatesTokenCount || '?'} out tokens`);

  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed[0] : parsed;
  } catch {
    console.error('  Failed to parse Gemini JSON response, returning raw');
    return { raw: text, parseError: true, summary: 'Failed to parse AI response', action_items: [], decisions: [] };
  }
}
