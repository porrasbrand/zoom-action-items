#!/usr/bin/env node
/**
 * One-shot backfill: insert a `field='created'` row in action_item_changelog
 * for every existing action_items row that doesn't already have one.
 *
 * Idempotent — safe to re-run.
 *
 * Usage: node scripts/backfill-changelog.js
 */

import 'dotenv/config';
import Database from 'better-sqlite3';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'zoom-action-items.db');

const db = new Database(DB_PATH);

// Find every action_item without a 'created' changelog row
const items = db.prepare(`
  SELECT ai.id, ai.meeting_id, ai.title, ai.created_at, ai.source
  FROM action_items ai
  LEFT JOIN action_item_changelog c
    ON c.action_item_id = ai.id AND c.field = 'created'
  WHERE c.id IS NULL
  ORDER BY ai.id ASC
`).all();

console.log(`Found ${items.length} action_items without a creation row.`);

const insert = db.prepare(`
  INSERT INTO action_item_changelog
    (action_item_id, meeting_id, field, old_value, new_value, changed_by_email, changed_by_name, changed_at, source, ip_address, notes)
  VALUES
    (?, ?, 'created', NULL, ?, NULL, NULL, ?, ?, NULL, NULL)
`);
const tx = db.transaction((rows) => {
  for (const r of rows) {
    const source = (r.source === 'llm_extracted' || !r.source) ? 'extraction' : r.source;
    insert.run(r.id, r.meeting_id || null, r.title || '(no title)', r.created_at || new Date().toISOString(), source);
  }
});
tx(items);

console.log(`Inserted ${items.length} 'created' rows.`);
const total = db.prepare(`SELECT COUNT(*) as n FROM action_item_changelog`).get().n;
console.log(`Total changelog rows: ${total}.`);
db.close();
