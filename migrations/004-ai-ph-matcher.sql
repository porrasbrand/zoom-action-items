-- Migration 004 — daily AI↔PH matcher worker.
-- Adds link provenance columns to action_items + a match_candidates queue
-- for ambiguous-similarity AIs that need human review.
-- All statements are idempotent (IF NOT EXISTS / column-exists guard).
-- Apply via: node scripts/migrate-004-ai-ph-matcher.mjs

-- The 4 new action_items columns use ALTER TABLE ADD COLUMN; SQLite does not
-- support IF NOT EXISTS on ADD COLUMN, so the migrate script wraps these in a
-- pragma_table_info check. The script is the canonical applier.

CREATE TABLE IF NOT EXISTS match_candidates (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  action_item_id       INTEGER NOT NULL REFERENCES action_items(id),
  ph_task_id           TEXT NOT NULL,
  ph_project_id        TEXT,
  ph_task_list_id      TEXT,
  similarity_score     REAL,
  topic_overlap_count  INTEGER,
  rationale            TEXT,
  status               TEXT DEFAULT 'pending' CHECK(status IN ('pending','accepted','rejected')),
  reviewed_by          TEXT,
  reviewed_at          TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_match_candidates_action_item ON match_candidates(action_item_id);
CREATE INDEX IF NOT EXISTS idx_match_candidates_status ON match_candidates(status);
