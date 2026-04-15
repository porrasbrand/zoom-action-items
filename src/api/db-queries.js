/**
 * Database query helpers for the Dashboard API.
 * Read-only access to zoom-action-items.db
 */

import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', '..', 'data', 'zoom-action-items.db');

let db = null;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH, { readonly: false }); // Need write for updates
    db.pragma('journal_mode = WAL');
  }
  return db;
}

// Export for roadmap-db.js functions
export function getDatabase() {
  return getDb();
}

// Run migrations on startup
export function runMigrations() {
  const d = getDb();

  // Check action_items columns
  const actionItemsInfo = d.prepare("PRAGMA table_info(action_items)").all();
  const actionItemsCols = new Set(actionItemsInfo.map(c => c.name));

  const actionItemsNewCols = [
    { name: 'transcript_excerpt', type: 'TEXT' },
    { name: 'ph_project_id', type: 'TEXT' },
    { name: 'ph_task_list_id', type: 'TEXT' },
    { name: 'ph_assignee_id', type: 'TEXT' },
    { name: 'pushed_at', type: 'TEXT' },
    { name: 'source', type: "TEXT DEFAULT 'llm_extracted'" },
    { name: 'confidence_tier', type: "TEXT DEFAULT 'conversation'" },
    { name: 'collaborators', type: "TEXT DEFAULT ''" },
    { name: 'task_type', type: "TEXT DEFAULT NULL" },
  ];

  for (const col of actionItemsNewCols) {
    if (!actionItemsCols.has(col.name)) {
      console.log(`[Migration] Adding action_items column: ${col.name}`);
      d.exec(`ALTER TABLE action_items ADD COLUMN ${col.name} ${col.type}`);
    }
  }

  // Check meetings columns
  const meetingsInfo = d.prepare("PRAGMA table_info(meetings)").all();
  const meetingsCols = new Set(meetingsInfo.map(c => c.name));

  const meetingsNewCols = [
    { name: 'validation_status', type: "TEXT DEFAULT 'pending'" },
    { name: 'keyword_count', type: 'INTEGER DEFAULT 0' },
    { name: 'keyword_ratio', type: 'REAL DEFAULT 0' },
    { name: 'confidence_signal', type: "TEXT DEFAULT 'pending'" },
    { name: 'adversarial_result', type: 'TEXT' },
    { name: 'adversarial_run_at', type: 'TEXT' },
    { name: 'completeness_assessment', type: 'TEXT' },
    { name: 'coverage_analysis', type: 'TEXT' },
    { name: 'spot_checked_at', type: 'TEXT' },
    { name: 'recap_detected', type: 'INTEGER DEFAULT 0' },
    { name: 'recap_speaker', type: 'TEXT' },
    { name: 'recap_start_line', type: 'INTEGER' },
    { name: 'recap_item_count', type: 'INTEGER DEFAULT 0' },
  ];

  for (const col of meetingsNewCols) {
    if (!meetingsCols.has(col.name)) {
      console.log(`[Migration] Adding meetings column: ${col.name}`);
      d.exec(`ALTER TABLE meetings ADD COLUMN ${col.name} ${col.type}`);
    }
  }

  // Transcript chunks + embeddings tables (Concierge RAG)
  d.exec(`
    CREATE TABLE IF NOT EXISTS transcript_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id INTEGER NOT NULL REFERENCES meetings(id),
      client_id TEXT,
      chunk_index INTEGER NOT NULL,
      start_time TEXT,
      end_time TEXT,
      speakers TEXT,
      text TEXT NOT NULL,
      token_count INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  d.exec('CREATE INDEX IF NOT EXISTS idx_chunks_meeting ON transcript_chunks(meeting_id)');
  d.exec('CREATE INDEX IF NOT EXISTS idx_chunks_client ON transcript_chunks(client_id)');
  d.exec(`
    CREATE TABLE IF NOT EXISTS transcript_embeddings (
      chunk_id INTEGER PRIMARY KEY REFERENCES transcript_chunks(id),
      embedding BLOB NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Chat sessions + messages tables (Concierge)
  d.exec(`
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      user_email TEXT NOT NULL,
      client_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  d.exec(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES chat_sessions(id),
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      citations TEXT,
      query_type TEXT,
      model_used TEXT,
      tokens_used INTEGER,
      chunks_used INTEGER,
      latency_ms INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  d.exec('CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id)');

  console.log('[Migration] Database schema up to date');
}

// ============ MEETINGS ============

export function getMeetings({ client_id, status, from, to, limit = 50, offset = 0, sort = 'desc' } = {}) {
  const d = getDb();
  const params = [];
  const conditions = [];

  if (client_id) {
    conditions.push('m.client_id = ?');
    params.push(client_id);
  }
  if (status) {
    conditions.push('m.status = ?');
    params.push(status);
  }
  if (from) {
    conditions.push('date(m.start_time) >= date(?)');
    params.push(from);
  }
  if (to) {
    conditions.push('date(m.start_time) <= date(?)');
    params.push(to);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const orderDir = sort === 'asc' ? 'ASC' : 'DESC';

  // Get total count
  const countSql = `SELECT COUNT(*) as total FROM meetings m ${whereClause}`;
  const { total } = d.prepare(countSql).get(...params);

  // Get meetings with action item and decision counts
  const sql = `
    SELECT
      m.id, m.topic, m.client_id, m.client_name, m.start_time,
      m.duration_minutes, m.status, m.created_at,
      m.confidence_signal, m.keyword_count, m.keyword_ratio, m.validation_status,
      m.completeness_assessment, m.adversarial_run_at,
      LENGTH(m.transcript_raw) as transcript_length,
      (SELECT COUNT(*) FROM action_items WHERE meeting_id = m.id AND source != 'adversarial_added' AND (status IS NULL OR status NOT IN ('superseded'))) as action_item_count,
      (SELECT COUNT(*) FROM action_items WHERE meeting_id = m.id AND source = 'adversarial_added' AND status = 'suggested') as suggested_count,
      (SELECT COUNT(*) FROM decisions WHERE meeting_id = m.id) as decision_count
    FROM meetings m
    ${whereClause}
    ORDER BY m.start_time ${orderDir}
    LIMIT ? OFFSET ?
  `;

  const meetings = d.prepare(sql).all(...params, limit, offset);

  return { meetings, total, limit, offset };
}

export function getMeetingById(id) {
  const d = getDb();

  const meeting = d.prepare(`
    SELECT *, LENGTH(transcript_raw) as transcript_length FROM meetings WHERE id = ?
  `).get(id);

  if (!meeting) return null;

  // Parse ai_extraction JSON
  if (meeting.ai_extraction) {
    try {
      meeting.ai_extraction_parsed = JSON.parse(meeting.ai_extraction);
    } catch { /* ignore parse errors */ }
  }

  // Get action items (exclude superseded by default)
  const action_items = d.prepare(`
    SELECT * FROM action_items WHERE meeting_id = ? AND (status IS NULL OR status != 'superseded') ORDER BY priority DESC, created_at ASC
  `).all(id);

  // Get decisions
  const decisions = d.prepare(`
    SELECT * FROM decisions WHERE meeting_id = ? ORDER BY created_at ASC
  `).all(id);

  return { meeting, action_items, decisions };
}

export function getMeetingTranscript(id) {
  const d = getDb();
  const row = d.prepare('SELECT transcript_raw FROM meetings WHERE id = ?').get(id);
  return row?.transcript_raw || null;
}

export function updateMeeting(id, updates) {
  const d = getDb();
  const allowedFields = ['status', 'client_id', 'client_name'];
  const sets = [];
  const params = [];

  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key)) {
      sets.push(`${key} = ?`);
      params.push(value);
    }
  }

  if (sets.length === 0) return false;

  sets.push('updated_at = datetime("now")');
  params.push(id);

  const sql = `UPDATE meetings SET ${sets.join(', ')} WHERE id = ?`;
  const result = d.prepare(sql).run(...params);
  return result.changes > 0;
}

// ============ ACTION ITEMS ============

export function getActionItems({ client_id, status, owner_name, meeting_id, limit = 50, offset = 0 } = {}) {
  const d = getDb();
  const params = [];
  const conditions = [];

  if (client_id) {
    conditions.push('ai.client_id = ?');
    params.push(client_id);
  }
  if (status) {
    conditions.push('ai.status = ?');
    params.push(status);
  }
  if (owner_name) {
    conditions.push('ai.owner_name LIKE ?');
    params.push(`%${owner_name}%`);
  }
  if (meeting_id) {
    conditions.push('ai.meeting_id = ?');
    params.push(meeting_id);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  // Get total count
  const countSql = `SELECT COUNT(*) as total FROM action_items ai ${whereClause}`;
  const { total } = d.prepare(countSql).get(...params);

  // Get action items with meeting info
  const sql = `
    SELECT
      ai.*,
      m.topic as meeting_topic,
      m.start_time as meeting_date
    FROM action_items ai
    JOIN meetings m ON m.id = ai.meeting_id
    ${whereClause}
    ORDER BY ai.created_at DESC
    LIMIT ? OFFSET ?
  `;

  const items = d.prepare(sql).all(...params, limit, offset);

  return { items, total, limit, offset };
}

export function getActionItemById(id) {
  const d = getDb();
  return d.prepare(`
    SELECT ai.*, m.topic as meeting_topic, m.start_time as meeting_date
    FROM action_items ai
    JOIN meetings m ON m.id = ai.meeting_id
    WHERE ai.id = ?
  `).get(id);
}

export function updateActionItem(id, updates) {
  const d = getDb();
  const allowedFields = [
    'title', 'description', 'owner_name', 'due_date', 'priority', 'status', 'category',
    'transcript_excerpt', 'ph_project_id', 'ph_task_list_id', 'ph_assignee_id', 'ph_task_id',
    'confidence_tier', 'collaborators', 'task_type'
  ];
  const sets = [];
  const params = [];

  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key)) {
      sets.push(`${key} = ?`);
      params.push(value);
    }
  }

  if (sets.length === 0) return null;

  params.push(id);
  const sql = `UPDATE action_items SET ${sets.join(', ')} WHERE id = ?`;
  const result = d.prepare(sql).run(...params);

  if (result.changes > 0) {
    // Return the updated record
    return getActionItemById(id);
  }
  return null;
}

// Get distinct owner names
export function getDistinctOwners() {
  const d = getDb();
  const rows = d.prepare(`
    SELECT owner_name, COUNT(*) as count
    FROM action_items
    WHERE owner_name IS NOT NULL AND owner_name != ''
    GROUP BY owner_name
    ORDER BY count DESC
  `).all();
  return rows.map(r => r.owner_name);
}

// Set pushed_at timestamp
export function setPushedAt(id) {
  const d = getDb();
  return d.prepare("UPDATE action_items SET pushed_at = datetime('now') WHERE id = ?").run(id);
}

export function setActionItemStatus(id, status) {
  const d = getDb();
  const result = d.prepare('UPDATE action_items SET status = ? WHERE id = ?').run(status, id);
  return result.changes > 0;
}

// ============ DECISIONS ============

export function getDecisions({ client_id, meeting_id, limit = 50, offset = 0 } = {}) {
  const d = getDb();
  const params = [];
  const conditions = [];

  if (client_id) {
    conditions.push('d.client_id = ?');
    params.push(client_id);
  }
  if (meeting_id) {
    conditions.push('d.meeting_id = ?');
    params.push(meeting_id);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const countSql = `SELECT COUNT(*) as total FROM decisions d ${whereClause}`;
  const { total } = d.prepare(countSql).get(...params);

  const sql = `
    SELECT d.*, m.topic as meeting_topic, m.start_time as meeting_date
    FROM decisions d
    JOIN meetings m ON m.id = d.meeting_id
    ${whereClause}
    ORDER BY d.created_at DESC
    LIMIT ? OFFSET ?
  `;

  const items = d.prepare(sql).all(...params, limit, offset);

  return { items, total, limit, offset };
}

// ============ CLIENTS ============

export function getClientsWithStats() {
  const d = getDb();

  // Get client stats from meetings
  const clientStats = d.prepare(`
    SELECT
      client_id,
      client_name,
      COUNT(*) as total_meetings,
      MAX(start_time) as last_meeting_date
    FROM meetings
    WHERE client_id IS NOT NULL AND client_id != 'unmatched'
    GROUP BY client_id
  `).all();

  // Get action item counts per client
  const actionCounts = d.prepare(`
    SELECT client_id, COUNT(*) as total_action_items
    FROM action_items
    WHERE client_id IS NOT NULL
    GROUP BY client_id
  `).all();

  const actionMap = new Map(actionCounts.map(c => [c.client_id, c.total_action_items]));

  // Combine stats
  return clientStats.map(c => ({
    id: c.client_id,
    name: c.client_name,
    total_meetings: c.total_meetings,
    total_action_items: actionMap.get(c.client_id) || 0,
    last_meeting_date: c.last_meeting_date,
  }));
}

// ============ STATS ============

export function getStats() {
  const d = getDb();

  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const meetings = d.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN date(start_time) = date(?) THEN 1 ELSE 0 END) as today,
      SUM(CASE WHEN date(start_time) >= date(?) THEN 1 ELSE 0 END) as this_week
    FROM meetings
  `).get(today, weekAgo);

  const actionItems = d.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open,
      SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) as rejected
    FROM action_items
  `).get();

  const topClients = d.prepare(`
    SELECT client_id, client_name, COUNT(*) as meeting_count
    FROM meetings
    WHERE client_id IS NOT NULL AND client_id != 'unmatched'
    GROUP BY client_id
    ORDER BY meeting_count DESC
    LIMIT 5
  `).all();

  const avgActionItems = meetings.total > 0
    ? (actionItems.total / meetings.total).toFixed(1)
    : 0;

  return {
    meetings_total: meetings.total,
    meetings_today: meetings.today,
    meetings_this_week: meetings.this_week,
    action_items_total: actionItems.total,
    action_items_open: actionItems.open || 0,
    action_items_completed: actionItems.completed || 0,
    action_items_rejected: actionItems.rejected || 0,
    top_clients: topClients,
    average_action_items_per_meeting: parseFloat(avgActionItems),
  };
}

// ============ HEALTH ============

export function getHealth() {
  const d = getDb();
  const { total } = d.prepare('SELECT COUNT(*) as total FROM meetings').get();
  const last = d.prepare('SELECT start_time, created_at FROM meetings ORDER BY created_at DESC LIMIT 1').get();

  return {
    total_meetings: total,
    last_processed: last?.created_at || null,
    last_meeting_date: last?.start_time || null,
  };
}

// ============ VALIDATION ============

export function getMeetingForValidation(id) {
  const d = getDb();
  return d.prepare(`
    SELECT id, transcript_raw, status, validation_status
    FROM meetings WHERE id = ?
  `).get(id);
}

export function getActionItemCountForMeeting(meetingId) {
  const d = getDb();
  const row = d.prepare('SELECT COUNT(*) as count FROM action_items WHERE meeting_id = ?').get(meetingId);
  return row?.count || 0;
}

export function updateMeetingValidation(id, { keywordCount, keywordRatio, confidenceSignal, validationStatus }) {
  const d = getDb();
  return d.prepare(`
    UPDATE meetings
    SET keyword_count = ?, keyword_ratio = ?, confidence_signal = ?, validation_status = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(keywordCount, keywordRatio, confidenceSignal, validationStatus, id);
}

export function getPendingValidationMeetings() {
  const d = getDb();
  return d.prepare(`
    SELECT id FROM meetings WHERE validation_status = 'pending' OR validation_status IS NULL
  `).all();
}

export function getValidationStats() {
  const d = getDb();
  return d.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN confidence_signal = 'green' THEN 1 ELSE 0 END) as green,
      SUM(CASE WHEN confidence_signal = 'yellow' THEN 1 ELSE 0 END) as yellow,
      SUM(CASE WHEN confidence_signal = 'red' THEN 1 ELSE 0 END) as red,
      SUM(CASE WHEN confidence_signal = 'pending' OR confidence_signal IS NULL THEN 1 ELSE 0 END) as pending
    FROM meetings
  `).get();
}

// ============ ADVERSARIAL VERIFICATION ============

export function getMeetingWithItems(id) {
  const d = getDb();
  const meeting = d.prepare('SELECT * FROM meetings WHERE id = ?').get(id);
  if (!meeting) return null;

  const items = d.prepare('SELECT * FROM action_items WHERE meeting_id = ? AND source != ?').all(id, 'adversarial_added');
  return { meeting, items };
}

export function updateMeetingAdversarial(id, { adversarialResult, completenessAssessment, confidenceSignal }) {
  const d = getDb();
  return d.prepare(`
    UPDATE meetings
    SET adversarial_result = ?, adversarial_run_at = datetime('now'), completeness_assessment = ?, confidence_signal = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(JSON.stringify(adversarialResult), completenessAssessment, confidenceSignal, id);
}

export function insertSuggestedItem(meetingId, clientId, item) {
  const d = getDb();
  return d.prepare(`
    INSERT INTO action_items (meeting_id, client_id, title, description, owner_name, priority, category, transcript_excerpt, source, status)
    VALUES (?, ?, ?, ?, ?, 'medium', 'other', ?, 'adversarial_added', 'suggested')
  `).run(
    meetingId,
    clientId,
    item.title,
    item.reasoning || null,
    item.owner || null,
    item.source_quote || null
  );
}

export function getSuggestedItemsCount(meetingId) {
  const d = getDb();
  const row = d.prepare('SELECT COUNT(*) as count FROM action_items WHERE meeting_id = ? AND status = ?').get(meetingId, 'suggested');
  return row?.count || 0;
}

export function getMeetingsForVerification() {
  const d = getDb();
  return d.prepare(`
    SELECT id FROM meetings WHERE adversarial_run_at IS NULL AND transcript_raw IS NOT NULL AND LENGTH(transcript_raw) > 500
  `).all();
}

// ============ COVERAGE ANALYSIS ============

export function getMeetingForCoverage(id) {
  const d = getDb();
  const meeting = d.prepare('SELECT id, transcript_raw, coverage_analysis FROM meetings WHERE id = ?').get(id);
  if (!meeting) return null;

  const items = d.prepare('SELECT * FROM action_items WHERE meeting_id = ?').all(id);
  return { meeting, items };
}

export function updateMeetingCoverage(id, coverageAnalysis) {
  const d = getDb();
  return d.prepare(`
    UPDATE meetings SET coverage_analysis = ?, updated_at = datetime('now') WHERE id = ?
  `).run(JSON.stringify(coverageAnalysis), id);
}

// ============ VALIDATION STATS ============

export function getValidationStatsData(periodDays = null) {
  const d = getDb();

  let dateFilter = '';
  if (periodDays) {
    dateFilter = `AND m.start_time >= datetime('now', '-${periodDays} days')`;
  }

  // Meeting stats
  const meetingStats = d.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN confidence_signal IS NOT NULL AND confidence_signal != 'pending' THEN 1 ELSE 0 END) as validated,
      SUM(CASE WHEN confidence_signal = 'green' THEN 1 ELSE 0 END) as green,
      SUM(CASE WHEN confidence_signal = 'yellow' THEN 1 ELSE 0 END) as yellow,
      SUM(CASE WHEN confidence_signal = 'red' THEN 1 ELSE 0 END) as red,
      AVG(keyword_ratio) as avg_keyword_ratio
    FROM meetings m
    WHERE 1=1 ${dateFilter}
  `).get();

  // Action item stats
  const itemStats = d.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN ai.source = 'llm_extracted' OR ai.source IS NULL THEN 1 ELSE 0 END) as llm_extracted,
      SUM(CASE WHEN ai.source = 'adversarial_added' THEN 1 ELSE 0 END) as adversarial_added,
      SUM(CASE WHEN ai.source = 'manual_added' THEN 1 ELSE 0 END) as manual_added,
      SUM(CASE WHEN ai.source = 'adversarial_added' AND ai.status = 'open' THEN 1 ELSE 0 END) as accepted_suggestions,
      SUM(CASE WHEN ai.source = 'adversarial_added' AND ai.status = 'dismissed' THEN 1 ELSE 0 END) as dismissed_suggestions,
      SUM(CASE WHEN ai.status = 'complete' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN ai.status = 'rejected' THEN 1 ELSE 0 END) as rejected_as_hallucination
    FROM action_items ai
    JOIN meetings m ON ai.meeting_id = m.id
    WHERE 1=1 ${dateFilter}
  `).get();

  return { meetingStats, itemStats };
}

export function getSpotCheckMeetings() {
  const d = getDb();
  return d.prepare(`
    SELECT id, topic, client_name, start_time, confidence_signal
    FROM meetings
    WHERE spot_checked_at IS NULL
      AND start_time >= datetime('now', '-7 days')
      AND confidence_signal IS NOT NULL
    ORDER BY RANDOM()
    LIMIT 2
  `).all();
}

export function getMeetingCountsByWeek() {
  const d = getDb();
  // Get meetings grouped by week (Monday start) for last 8 weeks
  return d.prepare(`
    SELECT
      date(start_time, 'weekday 0', '-6 days') as week_start,
      date(start_time, 'weekday 0') as week_end,
      COUNT(*) as count
    FROM meetings
    WHERE start_time >= date('now', '-56 days')
    GROUP BY week_start
    ORDER BY week_start DESC
  `).all();
}

export function markSpotChecked(id) {
  const d = getDb();
  return d.prepare(`
    UPDATE meetings SET spot_checked_at = datetime('now') WHERE id = ?
  `).run(id);
}

export function insertManualActionItem(meetingId, clientId, data) {
  const d = getDb();
  const result = d.prepare(`
    INSERT INTO action_items (meeting_id, client_id, title, description, owner_name, due_date, priority, category, source, status, collaborators)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'other', 'manual_added', 'open', ?)
  `).run(
    meetingId,
    clientId,
    data.title,
    data.description || null,
    data.owner_name || null,
    data.due_date || null,
    data.priority || 'medium',
    data.collaborators || ''
  );

  return d.prepare('SELECT * FROM action_items WHERE id = ?').get(result.lastInsertRowid);
}

// Supersede adversarial suggestions for a meeting (used before reextract)
export function supersedeAdversarialItems(meetingId) {
  const d = getDb();
  return d.prepare(`
    UPDATE action_items
    SET status = 'superseded'
    WHERE meeting_id = ?
      AND source = 'adversarial_added'
      AND status = 'suggested'
  `).run(meetingId);
}

// Get meeting data for reextraction
export function getMeetingForReextract(meetingId) {
  const d = getDb();
  return d.prepare(`
    SELECT id, topic, client_id, client_name, start_time, transcript_raw, LENGTH(transcript_raw) as transcript_length
    FROM meetings WHERE id = ?
  `).get(meetingId);
}

// Insert action items from reextraction
export function insertReextractedItems(meetingId, clientId, actionItems) {
  const d = getDb();
  const stmt = d.prepare(`
    INSERT INTO action_items (meeting_id, client_id, title, description, owner_name, due_date, priority, category, source, status, transcript_excerpt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'llm_extracted', 'open', ?)
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

// Insert decisions from reextraction
export function insertReextractedDecisions(meetingId, clientId, decisions) {
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

// Update meeting after reextraction
export function updateMeetingReextract(meetingId, aiExtraction) {
  const d = getDb();
  d.prepare(`
    UPDATE meetings SET
      ai_extraction = ?,
      status = 'completed',
      updated_at = datetime('now')
    WHERE id = ?
  `).run(JSON.stringify(aiExtraction), meetingId);
}

// ============ RECAP/SUMMARY DETECTION ============

// Insert recap-extracted action items
export function insertRecapItems(meetingId, clientId, items) {
  const d = getDb();
  const stmt = d.prepare(`
    INSERT INTO action_items (meeting_id, client_id, title, description, owner_name, due_date, priority, category, source, confidence_tier, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'other', 'recap_extracted', 'recap', 'open')
  `);

  const insertMany = d.transaction((items) => {
    for (const item of items) {
      stmt.run(
        meetingId, clientId,
        item.title,
        item.description || null,
        item.owner || null,
        item.due_date || null,
        item.priority || 'medium'
      );
    }
  });

  insertMany(items);
  return items.length;
}

// Update meeting with recap detection results
export function updateMeetingRecap(meetingId, { detected, speaker, startLine, itemCount }) {
  const d = getDb();
  return d.prepare(`
    UPDATE meetings SET
      recap_detected = ?,
      recap_speaker = ?,
      recap_start_line = ?,
      recap_item_count = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(detected ? 1 : 0, speaker || null, startLine || null, itemCount || 0, meetingId);
}

// Get all meetings for bulk summary extraction
export function getMeetingsForSummaryExtraction() {
  const d = getDb();
  return d.prepare(`
    SELECT id, topic, client_id, client_name, transcript_raw
    FROM meetings
    WHERE transcript_raw IS NOT NULL
      AND LENGTH(transcript_raw) > 1000
      AND (recap_detected IS NULL OR recap_detected = 0)
    ORDER BY start_time DESC
  `).all();
}

// Get recap item count for a meeting
export function getRecapItemCount(meetingId) {
  const d = getDb();
  const row = d.prepare(`
    SELECT COUNT(*) as count FROM action_items
    WHERE meeting_id = ? AND confidence_tier = 'recap'
  `).get(meetingId);
  return row?.count || 0;
}

// Clear existing recap items before re-extraction
export function clearRecapItems(meetingId) {
  const d = getDb();
  return d.prepare(`
    DELETE FROM action_items WHERE meeting_id = ? AND confidence_tier = 'recap'
  `).run(meetingId);
}
