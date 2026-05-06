-- Path-C verifier upgrade: offset evidence + workflow-integrated labeling.

-- meetings table additions
ALTER TABLE meetings ADD COLUMN client_commitments TEXT;
ALTER TABLE meetings ADD COLUMN verifier_model TEXT;
ALTER TABLE meetings ADD COLUMN verifier_version TEXT DEFAULT 'v2-offsets';

-- truth_labels table — captures the workflow-integrated 3-button labels
-- (real_miss / not_real / already_captured) so we accumulate a real
-- ground-truth set from normal Phil usage.
CREATE TABLE IF NOT EXISTS truth_labels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id INTEGER NOT NULL REFERENCES meetings(id),
  candidate_hash TEXT NOT NULL,
  candidate_title TEXT NOT NULL,
  candidate_evidence TEXT,
  candidate_confidence TEXT,
  label TEXT NOT NULL CHECK (label IN ('real_miss', 'not_real', 'already_captured')),
  label_severity TEXT,
  label_notes TEXT,
  labeled_by TEXT,
  labeled_at TEXT NOT NULL DEFAULT (datetime('now')),
  resulting_action_item_id INTEGER REFERENCES action_items(id),
  UNIQUE(meeting_id, candidate_hash)
);

CREATE INDEX IF NOT EXISTS idx_truth_labels_meeting ON truth_labels(meeting_id);
CREATE INDEX IF NOT EXISTS idx_truth_labels_label ON truth_labels(label);
CREATE INDEX IF NOT EXISTS idx_truth_labels_at ON truth_labels(labeled_at);
