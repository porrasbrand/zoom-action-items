/**
 * Meeting Summarizer — generates or extracts meeting summaries
 * Uses existing ai_extraction when available, falls back to Claude Haiku
 */

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic();

/**
 * Generate or extract a meeting summary
 * @param {import('better-sqlite3').Database} db
 * @param {number} meetingId
 * @returns {{summary: string, source: string, tokensUsed: number}}
 */
export async function summarizeMeeting(db, meetingId) {
  const meeting = db.prepare(
    'SELECT id, topic, start_time, duration_minutes, transcript_raw, client_name, ai_extraction FROM meetings WHERE id = ?'
  ).get(meetingId);

  if (!meeting || !meeting.transcript_raw) return null;

  // Try ai_extraction first (already exists for most meetings)
  if (meeting.ai_extraction && meeting.ai_extraction.length > 200) {
    let summary;
    try {
      const parsed = JSON.parse(meeting.ai_extraction);
      // Build a rich summary from the structured extraction
      const parts = [];
      if (parsed.summary) parts.push(parsed.summary);
      if (parsed.decisions?.length > 0) {
        parts.push('\nKey decisions: ' + parsed.decisions.map(d => typeof d === 'string' ? d : d.decision || d.text || '').filter(Boolean).join('; '));
      }
      if (parsed.follow_ups?.length > 0) {
        parts.push('\nFollow-ups: ' + parsed.follow_ups.map(f => typeof f === 'string' ? f : f.text || f.description || '').filter(Boolean).join('; '));
      }
      summary = parts.join('\n').trim();
    } catch {
      summary = meeting.ai_extraction.slice(0, 2000);
    }

    if (summary.length > 100) {
      db.prepare('UPDATE meetings SET meeting_summary = ? WHERE id = ?').run(summary, meetingId);
      return { summary, source: 'ai_extraction', tokensUsed: 0 };
    }
  }

  // Fallback: generate with Claude Haiku
  const truncated = meeting.transcript_raw.slice(0, 32000);

  const response = await anthropic.messages.create({
    model: 'claude-3-haiku-20240307',
    max_tokens: 800,
    messages: [{
      role: 'user',
      content: `Summarize this meeting in 300-500 words. Include: key topics, decisions, action items, client sentiment, notable moments, unresolved issues.

Meeting: ${meeting.topic}
Date: ${meeting.start_time}
Client: ${meeting.client_name || 'Unknown'}
Duration: ${meeting.duration_minutes || '?'} minutes

Transcript:
${truncated}`
    }]
  });

  const summary = response.content[0].text;
  const tokensUsed = response.usage.input_tokens + response.usage.output_tokens;

  db.prepare('UPDATE meetings SET meeting_summary = ? WHERE id = ?').run(summary, meetingId);
  return { summary, source: 'claude_haiku', tokensUsed };
}
