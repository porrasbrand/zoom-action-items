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

// Run migrations on startup
export function runMigrations() {
  const d = getDb();

  // Check which columns exist
  const tableInfo = d.prepare("PRAGMA table_info(action_items)").all();
  const existingColumns = new Set(tableInfo.map(c => c.name));

  const newColumns = [
    { name: 'transcript_excerpt', type: 'TEXT' },
    { name: 'ph_project_id', type: 'TEXT' },
    { name: 'ph_task_list_id', type: 'TEXT' },
    { name: 'ph_assignee_id', type: 'TEXT' },
    { name: 'pushed_at', type: 'TEXT' },
  ];

  for (const col of newColumns) {
    if (!existingColumns.has(col.name)) {
      console.log(`[Migration] Adding column: ${col.name}`);
      d.exec(`ALTER TABLE action_items ADD COLUMN ${col.name} ${col.type}`);
    }
  }

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
      (SELECT COUNT(*) FROM action_items WHERE meeting_id = m.id) as action_item_count,
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
    SELECT * FROM meetings WHERE id = ?
  `).get(id);

  if (!meeting) return null;

  // Parse ai_extraction JSON
  if (meeting.ai_extraction) {
    try {
      meeting.ai_extraction_parsed = JSON.parse(meeting.ai_extraction);
    } catch { /* ignore parse errors */ }
  }

  // Get action items
  const action_items = d.prepare(`
    SELECT * FROM action_items WHERE meeting_id = ? ORDER BY priority DESC, created_at ASC
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
    'transcript_excerpt', 'ph_project_id', 'ph_task_list_id', 'ph_assignee_id'
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
