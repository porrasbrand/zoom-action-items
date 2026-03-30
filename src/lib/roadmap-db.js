/**
 * Roadmap Database Layer
 * SQLite CRUD operations for roadmap_items and roadmap_snapshots tables
 */

/**
 * Initialize roadmap tables (called from database.js)
 */
export function initRoadmapTables(db) {
  // Create roadmap_items table
  db.exec(`
    CREATE TABLE IF NOT EXISTS roadmap_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id TEXT NOT NULL,

      -- Task identity
      title TEXT NOT NULL,
      description TEXT,
      category TEXT NOT NULL,
      task_type TEXT NOT NULL,

      -- Ownership
      owner_side TEXT NOT NULL DEFAULT 'b3x',
      owner_name TEXT,

      -- Status tracking
      status TEXT NOT NULL DEFAULT 'agreed',
      status_reason TEXT,

      -- Meeting linkage
      created_meeting_id INTEGER NOT NULL,
      last_discussed_meeting_id INTEGER,
      meetings_discussed TEXT DEFAULT '[]',
      meetings_silent_count INTEGER DEFAULT 0,

      -- Dates
      due_date TEXT,

      -- Status history (audit trail)
      status_history TEXT DEFAULT '[]',

      -- Source linkage
      source_action_item_id INTEGER,

      -- Timestamps
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create indexes
  db.exec(`CREATE INDEX IF NOT EXISTS idx_roadmap_client ON roadmap_items(client_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_roadmap_status ON roadmap_items(status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_roadmap_category ON roadmap_items(category)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_roadmap_stale ON roadmap_items(meetings_silent_count)`);

  // Create roadmap_snapshots table
  db.exec(`
    CREATE TABLE IF NOT EXISTS roadmap_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id TEXT NOT NULL,
      meeting_id INTEGER NOT NULL,
      snapshot_data TEXT NOT NULL,
      items_total INTEGER,
      items_done INTEGER,
      items_in_progress INTEGER,
      items_blocked INTEGER,
      items_stale INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_snapshots_client ON roadmap_snapshots(client_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_snapshots_meeting ON roadmap_snapshots(meeting_id)`);
}

/**
 * Create a new roadmap item
 */
export function createRoadmapItem(db, item) {
  const stmt = db.prepare(`
    INSERT INTO roadmap_items (
      client_id, title, description, category, task_type,
      owner_side, owner_name, status, status_reason,
      created_meeting_id, last_discussed_meeting_id, meetings_discussed,
      due_date, status_history, source_action_item_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const meetingsDiscussed = JSON.stringify([item.created_meeting_id]);
  const statusHistory = JSON.stringify([{
    meeting_id: item.created_meeting_id,
    status: item.status || 'agreed',
    notes: 'Initial creation',
    date: new Date().toISOString()
  }]);

  const result = stmt.run(
    item.client_id,
    item.title,
    item.description || null,
    item.category,
    item.task_type,
    item.owner_side || 'b3x',
    item.owner_name || null,
    item.status || 'agreed',
    item.status_reason || null,
    item.created_meeting_id,
    item.created_meeting_id,
    meetingsDiscussed,
    item.due_date || null,
    statusHistory,
    item.source_action_item_id || null
  );

  return result.lastInsertRowid;
}

/**
 * Update a roadmap item
 */
export function updateRoadmapItem(db, id, updates) {
  const fields = [];
  const values = [];

  const allowedFields = [
    'title', 'description', 'category', 'task_type',
    'owner_side', 'owner_name', 'status', 'status_reason',
    'last_discussed_meeting_id', 'meetings_discussed', 'meetings_silent_count',
    'due_date', 'status_history'
  ];

  for (const [key, value] of Object.entries(updates)) {
    if (allowedFields.includes(key)) {
      fields.push(`${key} = ?`);
      values.push(typeof value === 'object' ? JSON.stringify(value) : value);
    }
  }

  if (fields.length === 0) return false;

  fields.push('updated_at = CURRENT_TIMESTAMP');
  values.push(id);

  const sql = `UPDATE roadmap_items SET ${fields.join(', ')} WHERE id = ?`;
  const result = db.prepare(sql).run(...values);

  return result.changes > 0;
}

/**
 * Get full roadmap for a client
 */
export function getRoadmapForClient(db, clientId) {
  const items = db.prepare(`
    SELECT * FROM roadmap_items
    WHERE client_id = ?
    ORDER BY created_at ASC
  `).all(clientId);

  return items.map(parseRoadmapItem);
}

/**
 * Get active roadmap items (not done or dropped)
 */
export function getActiveRoadmapItems(db, clientId) {
  const items = db.prepare(`
    SELECT * FROM roadmap_items
    WHERE client_id = ? AND status NOT IN ('done', 'dropped')
    ORDER BY created_at ASC
  `).all(clientId);

  return items.map(parseRoadmapItem);
}

/**
 * Get stale items (not discussed in N+ consecutive meetings)
 */
export function getStaleItems(db, clientId, threshold = 2) {
  const items = db.prepare(`
    SELECT * FROM roadmap_items
    WHERE client_id = ?
      AND status NOT IN ('done', 'dropped')
      AND meetings_silent_count >= ?
    ORDER BY meetings_silent_count DESC
  `).all(clientId, threshold);

  return items.map(parseRoadmapItem);
}

/**
 * Append entry to status history
 */
export function appendStatusHistory(db, id, entry) {
  const item = db.prepare('SELECT status_history FROM roadmap_items WHERE id = ?').get(id);
  if (!item) return false;

  const history = JSON.parse(item.status_history || '[]');
  history.push({
    ...entry,
    date: new Date().toISOString()
  });

  return db.prepare('UPDATE roadmap_items SET status_history = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(JSON.stringify(history), id).changes > 0;
}

/**
 * Increment silent count for items not discussed in a meeting
 */
export function incrementSilentCount(db, clientId, meetingId) {
  // Increment silent count for all active items that weren't discussed in this meeting
  const result = db.prepare(`
    UPDATE roadmap_items
    SET meetings_silent_count = meetings_silent_count + 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE client_id = ?
      AND status NOT IN ('done', 'dropped')
      AND (last_discussed_meeting_id IS NULL OR last_discussed_meeting_id != ?)
  `).run(clientId, meetingId);

  return result.changes;
}

/**
 * Mark item as discussed in a meeting
 */
export function markItemDiscussed(db, id, meetingId) {
  const item = db.prepare('SELECT meetings_discussed FROM roadmap_items WHERE id = ?').get(id);
  if (!item) return false;

  const meetings = JSON.parse(item.meetings_discussed || '[]');
  if (!meetings.includes(meetingId)) {
    meetings.push(meetingId);
  }

  return db.prepare(`
    UPDATE roadmap_items
    SET last_discussed_meeting_id = ?,
        meetings_discussed = ?,
        meetings_silent_count = 0,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(meetingId, JSON.stringify(meetings), id).changes > 0;
}

/**
 * Save roadmap snapshot after processing a meeting
 */
export function saveSnapshot(db, clientId, meetingId, roadmapItems) {
  const stats = {
    total: roadmapItems.length,
    done: roadmapItems.filter(i => i.status === 'done').length,
    in_progress: roadmapItems.filter(i => i.status === 'in-progress').length,
    blocked: roadmapItems.filter(i => i.status === 'blocked').length,
    stale: roadmapItems.filter(i => i.meetings_silent_count >= 2).length
  };

  const result = db.prepare(`
    INSERT INTO roadmap_snapshots (
      client_id, meeting_id, snapshot_data,
      items_total, items_done, items_in_progress, items_blocked, items_stale
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    clientId,
    meetingId,
    JSON.stringify(roadmapItems),
    stats.total,
    stats.done,
    stats.in_progress,
    stats.blocked,
    stats.stale
  );

  return result.lastInsertRowid;
}

/**
 * Get snapshot for a specific meeting
 */
export function getSnapshot(db, clientId, meetingId) {
  const snapshot = db.prepare(`
    SELECT * FROM roadmap_snapshots
    WHERE client_id = ? AND meeting_id = ?
  `).get(clientId, meetingId);

  if (snapshot) {
    snapshot.snapshot_data = JSON.parse(snapshot.snapshot_data);
  }
  return snapshot;
}

/**
 * Get all snapshots for a client (timeline)
 */
export function getSnapshotsTimeline(db, clientId) {
  return db.prepare(`
    SELECT id, client_id, meeting_id, items_total, items_done,
           items_in_progress, items_blocked, items_stale, created_at
    FROM roadmap_snapshots
    WHERE client_id = ?
    ORDER BY meeting_id ASC
  `).all(clientId);
}

/**
 * Get roadmap item by ID
 */
export function getRoadmapItemById(db, id) {
  const item = db.prepare('SELECT * FROM roadmap_items WHERE id = ?').get(id);
  return item ? parseRoadmapItem(item) : null;
}

/**
 * Clear roadmap for a client (for rebuilding)
 */
export function clearRoadmapForClient(db, clientId) {
  db.prepare('DELETE FROM roadmap_snapshots WHERE client_id = ?').run(clientId);
  db.prepare('DELETE FROM roadmap_items WHERE client_id = ?').run(clientId);
}

/**
 * Helper to parse JSON fields in roadmap item
 */
function parseRoadmapItem(item) {
  return {
    ...item,
    meetings_discussed: JSON.parse(item.meetings_discussed || '[]'),
    status_history: JSON.parse(item.status_history || '[]')
  };
}

export default {
  initRoadmapTables,
  createRoadmapItem,
  updateRoadmapItem,
  getRoadmapForClient,
  getActiveRoadmapItems,
  getStaleItems,
  appendStatusHistory,
  incrementSilentCount,
  markItemDiscussed,
  saveSnapshot,
  getSnapshot,
  getSnapshotsTimeline,
  getRoadmapItemById,
  clearRoadmapForClient
};
