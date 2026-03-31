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

  // Phase 14: ProofHub reconciliation tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS roadmap_ph_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id TEXT NOT NULL,
      roadmap_item_id INTEGER NOT NULL,
      ph_task_id INTEGER NOT NULL,
      ph_task_title TEXT,
      match_method TEXT NOT NULL,
      match_confidence REAL DEFAULT 0.8,
      match_reasoning TEXT,
      match_corrected INTEGER DEFAULT 0,
      matched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_by TEXT,
      FOREIGN KEY (roadmap_item_id) REFERENCES roadmap_items(id) ON DELETE CASCADE
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_ph_links_roadmap ON roadmap_ph_links(roadmap_item_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ph_links_ph ON roadmap_ph_links(ph_task_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ph_links_client ON roadmap_ph_links(client_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ph_links_ph_roadmap ON roadmap_ph_links(ph_task_id, roadmap_item_id)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS ph_task_cache (
      ph_task_id INTEGER PRIMARY KEY,
      client_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      title TEXT,
      completed INTEGER DEFAULT 0,
      completed_at TEXT,
      stage_name TEXT,
      percent_progress INTEGER DEFAULT 0,
      assigned_names TEXT,
      task_list_name TEXT,
      task_list_id TEXT,
      start_date TEXT,
      due_date TEXT,
      comments_count INTEGER DEFAULT 0,
      last_synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      -- Phase 14 Deep Reconciliation columns
      description_text TEXT,
      comments_text TEXT,
      scope_summary TEXT,
      deliverables TEXT,
      context_synced_at DATETIME
    )
  `);

  // ALTER TABLE for existing databases (add deep recon columns if missing)
  try {
    db.exec(`ALTER TABLE ph_task_cache ADD COLUMN description_text TEXT`);
  } catch (e) { /* column exists */ }
  try {
    db.exec(`ALTER TABLE ph_task_cache ADD COLUMN comments_text TEXT`);
  } catch (e) { /* column exists */ }
  try {
    db.exec(`ALTER TABLE ph_task_cache ADD COLUMN scope_summary TEXT`);
  } catch (e) { /* column exists */ }
  try {
    db.exec(`ALTER TABLE ph_task_cache ADD COLUMN deliverables TEXT`);
  } catch (e) { /* column exists */ }
  try {
    db.exec(`ALTER TABLE ph_task_cache ADD COLUMN context_synced_at DATETIME`);
  } catch (e) { /* column exists */ }
  try {
    db.exec(`ALTER TABLE ph_task_cache ADD COLUMN task_list_id TEXT`);
  } catch (e) { /* column exists */ }

  db.exec(`CREATE INDEX IF NOT EXISTS idx_ph_cache_client ON ph_task_cache(client_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_ph_cache_project ON ph_task_cache(project_id)`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS cockpit_selections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id TEXT NOT NULL,
      roadmap_item_id INTEGER NOT NULL,
      selected INTEGER DEFAULT 1,
      selection_date TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(client_id, roadmap_item_id, selection_date)
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_cockpit_client_date ON cockpit_selections(client_id, selection_date)`);
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
    SELECT rs.id, rs.client_id, rs.meeting_id, rs.snapshot_data, rs.items_total, rs.items_done,
           rs.items_in_progress, rs.items_blocked, rs.items_stale, rs.created_at, m.start_time as meeting_date, m.topic as meeting_topic
    FROM roadmap_snapshots rs LEFT JOIN meetings m ON rs.meeting_id = m.id
    WHERE rs.client_id = ?
    ORDER BY m.start_time ASC
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
