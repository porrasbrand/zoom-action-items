-- Path-C-2: dedup matching layer (write-time match metadata in suggested_missed_items JSON,
-- no schema change for that) + action item audit trail (changelog table).

CREATE TABLE IF NOT EXISTS action_item_changelog (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action_item_id INTEGER NOT NULL REFERENCES action_items(id),
  meeting_id INTEGER,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT NOT NULL,
  changed_by_email TEXT,
  changed_by_name TEXT,
  changed_at TEXT NOT NULL DEFAULT (datetime('now')),
  source TEXT,
  ip_address TEXT,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_changelog_item ON action_item_changelog(action_item_id);
CREATE INDEX IF NOT EXISTS idx_changelog_meeting ON action_item_changelog(meeting_id);
CREATE INDEX IF NOT EXISTS idx_changelog_email ON action_item_changelog(changed_by_email);
CREATE INDEX IF NOT EXISTS idx_changelog_at ON action_item_changelog(changed_at);
CREATE INDEX IF NOT EXISTS idx_changelog_field ON action_item_changelog(field);
