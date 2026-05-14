#!/usr/bin/env node
// Backfill action_items.ph_task_id / ph_project_id / ph_task_list_id from the
// xprt:echelon hand-curated link JSON.
//
// Source-of-truth file (read-only):
//   ~/awsc-new/awesome/cc-xprt-echelon/scratch/ph-export/echelon-ai-ph-links.json
//
// Idempotent: rows that already have ph_task_id set (matching the proposed
// link) are skipped. Rows linked to a DIFFERENT ph_task_id are preserved as-is
// and flagged in the conflict report — backfill never overwrites existing
// (potentially human-corrected) links.

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = path.resolve(__dirname, '..', 'data', 'zoom-action-items.db');
const DEFAULT_JSON = '/home/ubuntu/awsc-new/awesome/cc-xprt-echelon/scratch/ph-export/echelon-ai-ph-links.json';

export function runBackfill({
  dbPath = DEFAULT_DB,
  jsonPath = DEFAULT_JSON,
  linkedBy = 'xprt:echelon',
  now = new Date().toISOString(),
} = {}) {
  const payload = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  if (!Array.isArray(payload.links)) throw new Error(`Expected payload.links[] in ${jsonPath}`);

  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');

  const stmtSelect = db.prepare('SELECT id, ph_task_id FROM action_items WHERE id = ?');
  const stmtUpdate = db.prepare(`
    UPDATE action_items
       SET ph_task_id      = ?,
           ph_project_id   = ?,
           ph_task_list_id = ?,
           link_source     = ?,
           link_confidence = ?,
           linked_by       = ?,
           linked_at       = ?
     WHERE id = ?
  `);

  const result = {
    json_links: payload.links.length,
    updated: [],
    already_correct: [],
    conflicts: [],
    missing_action_items: [],
  };

  const tx = db.transaction((links) => {
    for (const link of links) {
      const aiId = link.action_item_id;
      const row = stmtSelect.get(aiId);
      if (!row) { result.missing_action_items.push(aiId); continue; }
      if (row.ph_task_id && String(row.ph_task_id) === String(link.ph_task_id)) {
        result.already_correct.push(aiId);
        continue;
      }
      if (row.ph_task_id && String(row.ph_task_id) !== String(link.ph_task_id)) {
        result.conflicts.push({
          action_item_id: aiId,
          existing_ph_task_id: row.ph_task_id,
          proposed_ph_task_id: link.ph_task_id,
        });
        continue;
      }
      stmtUpdate.run(
        String(link.ph_task_id),
        link.ph_project_id ? String(link.ph_project_id) : null,
        link.ph_task_list_id ? String(link.ph_task_list_id) : null,
        link.link_source || 'matched',
        link.link_confidence || null,
        linkedBy,
        now,
        aiId,
      );
      result.updated.push(aiId);
    }
  });
  tx(payload.links);

  db.close();
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = runBackfill();
  console.log(`[backfill] json links:        ${result.json_links}`);
  console.log(`[backfill] updated:           ${result.updated.length} → ${JSON.stringify(result.updated)}`);
  console.log(`[backfill] already_correct:   ${result.already_correct.length} → ${JSON.stringify(result.already_correct)}`);
  console.log(`[backfill] conflicts:         ${result.conflicts.length}`);
  for (const c of result.conflicts) console.log(`  conflict: AI ${c.action_item_id} has ph_task_id=${c.existing_ph_task_id}, proposed=${c.proposed_ph_task_id}`);
  console.log(`[backfill] missing AIs:       ${result.missing_action_items.length} → ${JSON.stringify(result.missing_action_items)}`);
}
