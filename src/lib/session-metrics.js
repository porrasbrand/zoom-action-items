/**
 * Session Metrics Engine
 * Computes quantitative meeting quality indicators from existing SQL data.
 * No AI calls — pure SQL + transcript parsing.
 */

import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', '..', 'data', 'zoom-action-items.db');

// B3X team members (known names to classify as B3X side)
const B3X_TEAM = [
  'dan kuschell', 'dan', 'daniel kuschell',
  'philip mutrie', 'phil', 'phil mutrie', 'philip',
  'joe boland', 'joe',
  'richard bond', 'richard',
  'sarah young', 'sarah',
  'tea', 'tia',
  'lynn',
];

/**
 * Initialize database and create session_metrics table if needed
 */
export function initDatabase(dbPath = DB_PATH) {
  const db = new Database(dbPath);

  db.exec(`
    CREATE TABLE IF NOT EXISTS session_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id INTEGER NOT NULL UNIQUE REFERENCES meetings(id),

      -- Action item metrics
      action_item_count INTEGER DEFAULT 0,
      action_density REAL DEFAULT 0,
      due_date_rate REAL DEFAULT 0,
      owner_assignment_rate REAL DEFAULT 0,
      high_priority_rate REAL DEFAULT 0,
      category_spread INTEGER DEFAULT 0,

      -- Decision metrics
      decision_count INTEGER DEFAULT 0,
      decisions_per_minute REAL DEFAULT 0,

      -- Speaker analysis
      total_speakers INTEGER DEFAULT 0,
      b3x_speaker_count INTEGER DEFAULT 0,
      client_speaker_count INTEGER DEFAULT 0,
      b3x_line_count INTEGER DEFAULT 0,
      client_line_count INTEGER DEFAULT 0,
      b3x_word_count INTEGER DEFAULT 0,
      client_word_count INTEGER DEFAULT 0,
      speaker_ratio_b3x REAL DEFAULT 0,
      speaker_ratio_client REAL DEFAULT 0,
      dominant_speaker TEXT,
      dominant_speaker_pct REAL DEFAULT 0,

      -- Roadmap/accountability metrics
      b3x_stale_items INTEGER DEFAULT 0,
      client_stale_items INTEGER DEFAULT 0,
      repeat_topics INTEGER DEFAULT 0,
      roadmap_items_discussed INTEGER DEFAULT 0,

      -- Meeting metadata
      duration_minutes INTEGER DEFAULT 0,
      meeting_type TEXT DEFAULT 'regular',

      -- Timestamps
      computed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  return db;
}

/**
 * Compute action item metrics for a meeting
 */
export function computeActionMetrics(db, meetingId, durationMinutes) {
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN due_date IS NOT NULL THEN 1 ELSE 0 END) as with_due_date,
      SUM(CASE WHEN owner_name IS NOT NULL AND owner_name != '' THEN 1 ELSE 0 END) as with_owner,
      SUM(CASE WHEN priority = 'high' THEN 1 ELSE 0 END) as high_priority,
      COUNT(DISTINCT category) as categories
    FROM action_items
    WHERE meeting_id = ?
  `).get(meetingId);

  const total = stats.total || 0;

  return {
    action_item_count: total,
    action_density: durationMinutes > 0 ? total / durationMinutes : 0,
    due_date_rate: total > 0 ? (stats.with_due_date / total) * 100 : 0,
    owner_assignment_rate: total > 0 ? (stats.with_owner / total) * 100 : 0,
    high_priority_rate: total > 0 ? (stats.high_priority / total) * 100 : 0,
    category_spread: stats.categories || 0
  };
}

/**
 * Compute decision metrics for a meeting
 */
export function computeDecisionMetrics(db, meetingId, durationMinutes) {
  const stats = db.prepare(`
    SELECT COUNT(*) as total
    FROM decisions
    WHERE meeting_id = ?
  `).get(meetingId);

  const total = stats.total || 0;

  return {
    decision_count: total,
    decisions_per_minute: durationMinutes > 0 ? total / durationMinutes : 0
  };
}

/**
 * Check if a speaker name is a B3X team member
 */
function isB3XMember(speakerName) {
  const normalized = speakerName.toLowerCase().trim();
  return B3X_TEAM.some(name => normalized.includes(name) || name.includes(normalized));
}

/**
 * Parse speaker metrics from transcript
 */
export function parseSpeakerMetrics(transcriptRaw, clientName) {
  if (!transcriptRaw) {
    return {
      total_speakers: 0,
      b3x_speaker_count: 0,
      client_speaker_count: 0,
      b3x_line_count: 0,
      client_line_count: 0,
      b3x_word_count: 0,
      client_word_count: 0,
      speaker_ratio_b3x: 0,
      speaker_ratio_client: 0,
      dominant_speaker: null,
      dominant_speaker_pct: 0
    };
  }

  const lines = transcriptRaw.split('\n');
  const speakerStats = new Map();
  let currentSpeaker = null;

  for (const line of lines) {
    // Detect speaker change (line starts with "Name:")
    const speakerMatch = line.match(/^([^:]+):\s*/);
    if (speakerMatch) {
      currentSpeaker = speakerMatch[1].trim();
      const content = line.substring(speakerMatch[0].length).trim();

      if (!speakerStats.has(currentSpeaker)) {
        speakerStats.set(currentSpeaker, { lines: 0, words: 0 });
      }

      speakerStats.get(currentSpeaker).lines++;
      speakerStats.get(currentSpeaker).words += content.split(/\s+/).filter(w => w).length;
    } else if (currentSpeaker && line.trim()) {
      // Continuation of previous speaker
      speakerStats.get(currentSpeaker).words += line.trim().split(/\s+/).filter(w => w).length;
    }
  }

  // Classify speakers
  let b3xSpeakers = 0, clientSpeakers = 0;
  let b3xLines = 0, clientLines = 0;
  let b3xWords = 0, clientWords = 0;
  let dominantSpeaker = null;
  let maxWords = 0;
  let totalWords = 0;

  for (const [speaker, stats] of speakerStats) {
    totalWords += stats.words;

    if (stats.words > maxWords) {
      maxWords = stats.words;
      dominantSpeaker = speaker;
    }

    if (isB3XMember(speaker)) {
      b3xSpeakers++;
      b3xLines += stats.lines;
      b3xWords += stats.words;
    } else {
      clientSpeakers++;
      clientLines += stats.lines;
      clientWords += stats.words;
    }
  }

  return {
    total_speakers: speakerStats.size,
    b3x_speaker_count: b3xSpeakers,
    client_speaker_count: clientSpeakers,
    b3x_line_count: b3xLines,
    client_line_count: clientLines,
    b3x_word_count: b3xWords,
    client_word_count: clientWords,
    speaker_ratio_b3x: totalWords > 0 ? (b3xWords / totalWords) * 100 : 0,
    speaker_ratio_client: totalWords > 0 ? (clientWords / totalWords) * 100 : 0,
    dominant_speaker: dominantSpeaker,
    dominant_speaker_pct: totalWords > 0 ? (maxWords / totalWords) * 100 : 0
  };
}

/**
 * Compute accountability metrics from roadmap data
 */
export function computeAccountabilityMetrics(db, meetingId, clientId) {
  // B3X stale items (owner_side='b3x' with meetings_silent_count > 2)
  const b3xStale = db.prepare(`
    SELECT COUNT(*) as count
    FROM roadmap_items
    WHERE client_id = ? AND owner_side = 'b3x' AND meetings_silent_count > 2
  `).get(clientId);

  // Client stale items
  const clientStale = db.prepare(`
    SELECT COUNT(*) as count
    FROM roadmap_items
    WHERE client_id = ? AND owner_side = 'client' AND meetings_silent_count > 2
  `).get(clientId);

  // Roadmap items discussed in this meeting
  const discussed = db.prepare(`
    SELECT COUNT(*) as count
    FROM roadmap_items
    WHERE client_id = ? AND last_discussed_meeting_id = ?
  `).get(clientId, meetingId);

  return {
    b3x_stale_items: b3xStale?.count || 0,
    client_stale_items: clientStale?.count || 0,
    repeat_topics: 0, // Would need more complex analysis
    roadmap_items_discussed: discussed?.count || 0
  };
}

/**
 * Infer meeting type from topic and client name
 */
export function inferMeetingType(topic, clientName) {
  const topicLower = (topic || '').toLowerCase();
  const clientLower = (clientName || '').toLowerCase();

  // Internal meetings
  if (topicLower.includes('internal') || topicLower.includes('huddle') ||
      topicLower.includes('leadership') || topicLower.includes('team meeting') ||
      clientLower.includes('b3x internal') || clientLower.includes('b3x team')) {
    return 'internal';
  }

  // Kickoff meetings
  if (topicLower.includes('kickoff') || topicLower.includes('onboarding') ||
      topicLower.includes('intro') || topicLower.includes('kick-off')) {
    return 'kickoff';
  }

  // VIP sessions
  if (topicLower.includes('vip session') || topicLower.includes('vip-session')) {
    return 'vip-session';
  }

  return 'regular';
}

/**
 * Compute all metrics for a single meeting
 */
export function computeAllMetrics(db, meetingId) {
  // Get meeting data
  const meeting = db.prepare(`
    SELECT id, topic, client_id, client_name, transcript_raw, duration_minutes
    FROM meetings
    WHERE id = ?
  `).get(meetingId);

  if (!meeting) {
    console.log(`[SessionMetrics] Meeting ${meetingId} not found`);
    return null;
  }

  const duration = meeting.duration_minutes || 0;

  // Compute all metric groups
  const actionMetrics = computeActionMetrics(db, meetingId, duration);
  const decisionMetrics = computeDecisionMetrics(db, meetingId, duration);
  const speakerMetrics = parseSpeakerMetrics(meeting.transcript_raw, meeting.client_name);
  const accountabilityMetrics = computeAccountabilityMetrics(db, meetingId, meeting.client_id);
  const meetingType = inferMeetingType(meeting.topic, meeting.client_name);

  // Combine all metrics
  const metrics = {
    meeting_id: meetingId,
    ...actionMetrics,
    ...decisionMetrics,
    ...speakerMetrics,
    ...accountabilityMetrics,
    duration_minutes: duration,
    meeting_type: meetingType
  };

  // Upsert into session_metrics
  const columns = Object.keys(metrics);
  const placeholders = columns.map(() => '?').join(', ');
  const updates = columns.filter(c => c !== 'meeting_id').map(c => `${c} = excluded.${c}`).join(', ');

  db.prepare(`
    INSERT INTO session_metrics (${columns.join(', ')}, computed_at)
    VALUES (${placeholders}, datetime('now'))
    ON CONFLICT(meeting_id) DO UPDATE SET ${updates}, computed_at = datetime('now')
  `).run(...columns.map(c => metrics[c]));

  return metrics;
}

/**
 * Backfill all meetings
 */
export function backfillAll(db) {
  const meetings = db.prepare('SELECT id FROM meetings ORDER BY id').all();
  console.log(`[SessionMetrics] Backfilling ${meetings.length} meetings...`);

  let processed = 0;
  let errors = 0;

  for (const { id } of meetings) {
    try {
      computeAllMetrics(db, id);
      processed++;
      if (processed % 10 === 0) {
        console.log(`[SessionMetrics] Processed ${processed}/${meetings.length}`);
      }
    } catch (err) {
      console.error(`[SessionMetrics] Error processing meeting ${id}:`, err.message);
      errors++;
    }
  }

  console.log(`[SessionMetrics] Backfill complete: ${processed} processed, ${errors} errors`);
  return { processed, errors, total: meetings.length };
}

/**
 * Get aggregate statistics
 */
export function getStats(db) {
  const stats = db.prepare(`
    SELECT
      COUNT(*) as total_meetings,
      AVG(action_item_count) as avg_action_items,
      AVG(action_density) as avg_action_density,
      AVG(due_date_rate) as avg_due_date_rate,
      AVG(owner_assignment_rate) as avg_owner_assignment_rate,
      AVG(speaker_ratio_b3x) as avg_b3x_speaking_ratio,
      SUM(CASE WHEN b3x_stale_items > 0 THEN 1 ELSE 0 END) as meetings_with_stale_b3x,
      SUM(CASE WHEN meeting_type = 'regular' THEN 1 ELSE 0 END) as type_regular,
      SUM(CASE WHEN meeting_type = 'internal' THEN 1 ELSE 0 END) as type_internal,
      SUM(CASE WHEN meeting_type = 'kickoff' THEN 1 ELSE 0 END) as type_kickoff,
      SUM(CASE WHEN meeting_type = 'vip-session' THEN 1 ELSE 0 END) as type_vip
    FROM session_metrics
  `).get();

  return stats;
}

/**
 * Get metrics for a single meeting
 */
export function getMetrics(db, meetingId) {
  return db.prepare('SELECT * FROM session_metrics WHERE meeting_id = ?').get(meetingId);
}

/**
 * Classify a meeting as no-show, test, partial, or normal
 * Used for detecting meetings that should be excluded from averages
 */
export function classifyMeeting(meeting, transcript) {
  const B3X_MEMBERS = [
    'Dan', 'Dan Kuschell', 'Daniel Kuschell',
    'Phil', 'Philip', 'Philip Mutrie', 'Phil Mutrie',
    'Joe', 'Joe Boland',
    'Richard', 'Richard Bond',
    'Sarah', 'Sarah Young',
    'Tea', 'Tia',
    'Lynn'
  ];
  const noShowPhrases = [
    'not here', 'no-show', 'not joining', 'give them a few more minutes', 'reschedule',
    'looks like they', 'not coming', 'not showing', "they're not", 'they are not',
    'see if they', 'are they running late', 'are they coming', 'they coming',
    'waiting for', 'give them', "let's wait", "haven't joined", "hasn't joined",
    'not on yet', 'not on the call', 'waiting on', 'no one else'
  ];

  const transcriptLower = (transcript || '').toLowerCase();
  const duration = meeting.duration_minutes || 0;

  // Extract speakers from VTT-style transcript
  // Lines like: [00:04:14.870] Dan Kuschell: ...
  const speakerMatches = transcript?.match(/\]\s*([^:]+):/g) || [];
  const speakers = [...new Set(speakerMatches.map(s => s.replace(/^\]\s*/, '').replace(/:$/, '').trim()))];
  const clientSpeakers = speakers.filter(s => !B3X_MEMBERS.some(m => s.toLowerCase().includes(m.toLowerCase())));

  const hasNoShowPhrase = noShowPhrases.some(p => transcriptLower.includes(p));

  // Classification rules
  if (duration < 5) {
    return { type: 'test', confidence: 'high', reason: 'Under 5 min, likely test recording' };
  }
  if (duration < 10 && clientSpeakers.length === 0) {
    return { type: 'no-show', confidence: 'high', reason: 'Under 10 min, no client speakers' };
  }
  // Expanded: If no-show phrases detected and no client speakers, flag up to 30 min
  if (hasNoShowPhrase && clientSpeakers.length === 0 && duration <= 30) {
    return { type: 'no-show', confidence: 'high', reason: 'No-show phrases detected, no client speakers' };
  }
  // No client speakers for longer meetings - medium confidence
  if (clientSpeakers.length === 0 && duration < 30) {
    return { type: 'no-show', confidence: 'medium', reason: 'No client speakers detected' };
  }

  return { type: 'normal', confidence: 'high', reason: null };
}

export default {
  initDatabase,
  computeActionMetrics,
  computeDecisionMetrics,
  parseSpeakerMetrics,
  computeAccountabilityMetrics,
  inferMeetingType,
  computeAllMetrics,
  backfillAll,
  getStats,
  getMetrics,
  classifyMeeting
};
