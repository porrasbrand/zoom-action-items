/**
 * SQLite database for meeting tracking, dedup, and audit trail.
 */

import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { initRoadmapTables } from './roadmap-db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', '..', 'data', 'zoom-action-items.db');

let db = null;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initialize();
  }
  return db;
}

/**
 * Create tables if they don't exist.
 */
export function initialize() {
  const d = getDb();

  d.exec(`
    CREATE TABLE IF NOT EXISTS meetings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      zoom_meeting_uuid TEXT UNIQUE NOT NULL,
      topic TEXT,
      client_id TEXT,
      client_name TEXT,
      start_time TEXT,
      duration_minutes INTEGER,
      transcript_raw TEXT,
      ai_extraction TEXT,
      status TEXT DEFAULT 'pending',
      slack_message_ts TEXT,
      slack_channel_id TEXT,
      error_message TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS action_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id INTEGER NOT NULL REFERENCES meetings(id),
      client_id TEXT,
      title TEXT NOT NULL,
      description TEXT,
      owner_name TEXT,
      due_date TEXT,
      priority TEXT DEFAULT 'medium',
      category TEXT DEFAULT 'other',
      ph_task_id TEXT,
      status TEXT DEFAULT 'open',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id INTEGER NOT NULL REFERENCES meetings(id),
      client_id TEXT,
      decision TEXT NOT NULL,
      context TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_meetings_uuid ON meetings(zoom_meeting_uuid);
    CREATE INDEX IF NOT EXISTS idx_meetings_client ON meetings(client_id);
    CREATE INDEX IF NOT EXISTS idx_meetings_status ON meetings(status);
    CREATE INDEX IF NOT EXISTS idx_action_items_meeting ON action_items(meeting_id);
    CREATE INDEX IF NOT EXISTS idx_action_items_client ON action_items(client_id);
    CREATE INDEX IF NOT EXISTS idx_action_items_status ON action_items(status);
  `);

  // Initialize roadmap tables
  initRoadmapTables(d);
}

/**
 * Check if a meeting has already been processed.
 */
export function meetingExists(zoomMeetingUuid) {
  const d = getDb();
  // Zoom UUIDs can have / or _ interchangeably - check both variations
  const withUnderscore = zoomMeetingUuid.replace(/\//g, '_');
  const withSlash = zoomMeetingUuid.replace(/_/g, '/');
  const row = d.prepare('SELECT id FROM meetings WHERE zoom_meeting_uuid IN (?, ?, ?)').get(zoomMeetingUuid, withUnderscore, withSlash);
  return !!row;
}

/**
 * Insert a new meeting record.
 * @returns {number} Inserted meeting ID
 */
export function insertMeeting({ zoomMeetingUuid, topic, clientId, clientName, startTime, durationMinutes }) {
  const d = getDb();
  const result = d.prepare(`
    INSERT INTO meetings (zoom_meeting_uuid, topic, client_id, client_name, start_time, duration_minutes, status)
    VALUES (?, ?, ?, ?, ?, ?, 'processing')
  `).run(zoomMeetingUuid, topic, clientId, clientName, startTime, durationMinutes);
  return result.lastInsertRowid;
}

/**
 * Update meeting with transcript and AI extraction results.
 */
export function updateMeetingResults(meetingId, { transcriptRaw, aiExtraction, slackMessageTs, slackChannelId, status, errorMessage }) {
  const d = getDb();
  d.prepare(`
    UPDATE meetings SET
      transcript_raw = COALESCE(?, transcript_raw),
      ai_extraction = COALESCE(?, ai_extraction),
      slack_message_ts = COALESCE(?, slack_message_ts),
      slack_channel_id = COALESCE(?, slack_channel_id),
      status = COALESCE(?, status),
      error_message = COALESCE(?, error_message),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    transcriptRaw || null,
    aiExtraction ? JSON.stringify(aiExtraction) : null,
    slackMessageTs || null,
    slackChannelId || null,
    status || null,
    errorMessage || null,
    meetingId
  );
}

/**
 * Insert action items for a meeting.
 */
export function insertActionItems(meetingId, clientId, actionItems) {
  const d = getDb();
  const stmt = d.prepare(`
    INSERT INTO action_items (meeting_id, client_id, title, description, owner_name, due_date, priority, category, transcript_excerpt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = d.transaction((items) => {
    for (const item of items) {
      stmt.run(
        meetingId, clientId,
        item.title, item.description || null,
        item.owner || null, item.due_date || null,
        item.priority || 'medium', item.category || 'other',
        item.transcript_excerpt || null
      );
    }
  });

  insertMany(actionItems);
}

/**
 * Insert decisions for a meeting.
 */
export function insertDecisions(meetingId, clientId, decisions) {
  const d = getDb();
  const stmt = d.prepare(`
    INSERT INTO decisions (meeting_id, client_id, decision, context)
    VALUES (?, ?, ?, ?)
  `);

  const insertMany = d.transaction((items) => {
    for (const item of items) {
      stmt.run(meetingId, clientId, item.decision, item.context || null);
    }
  });

  insertMany(decisions);
}

/**
 * Get recent open action items for a client (for Phase 3 context injection).
 */
export function getOpenActionItems(clientId, limit = 20) {
  const d = getDb();
  return d.prepare(`
    SELECT ai.*, m.topic, m.start_time
    FROM action_items ai
    JOIN meetings m ON m.id = ai.meeting_id
    WHERE ai.client_id = ? AND ai.status = 'open'
    ORDER BY ai.created_at DESC
    LIMIT ?
  `).all(clientId, limit);
}

/**
 * Get meeting processing stats.
 */
export function getStats() {
  const d = getDb();
  return {
    meetings: d.prepare('SELECT status, COUNT(*) as count FROM meetings GROUP BY status').all(),
    actionItems: d.prepare('SELECT status, COUNT(*) as count FROM action_items GROUP BY status').all(),
    total: d.prepare('SELECT COUNT(*) as count FROM meetings').get().count,
  };
}
