-- Phase 4D edit-logger: snapshot what we sent to PH at push time + diff history.

ALTER TABLE action_items ADD COLUMN snapshot_title TEXT;
ALTER TABLE action_items ADD COLUMN snapshot_description TEXT;
ALTER TABLE action_items ADD COLUMN snapshot_assignee_id TEXT;

CREATE TABLE IF NOT EXISTS action_item_edits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action_item_id INTEGER NOT NULL REFERENCES action_items(id),
  captured_at TEXT NOT NULL DEFAULT (datetime('now')),
  field TEXT NOT NULL,                 -- 'title' | 'description' | 'assignee_id' | 'comment_added'
  old_value TEXT,                      -- snapshot value (or previous capture)
  new_value TEXT,                      -- current PH value
  edit_classification TEXT,            -- 'structural' | 'tonal' | 'unknown'
  diff_summary TEXT                    -- short human-readable explainer
);

CREATE INDEX IF NOT EXISTS idx_action_item_edits_item ON action_item_edits(action_item_id);
CREATE INDEX IF NOT EXISTS idx_action_item_edits_captured ON action_item_edits(captured_at);
CREATE INDEX IF NOT EXISTS idx_action_item_edits_classification ON action_item_edits(edit_classification);
