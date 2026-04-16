#!/usr/bin/env node
/**
 * Populate client_contacts table from meeting topics + transcript speakers
 * Usage: node scripts/backfill-contacts.mjs
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '../data/zoom-action-items.db');
const db = new Database(DB_PATH);

// Ensure table exists
db.exec(`
  CREATE TABLE IF NOT EXISTS client_contacts (
    contact_name TEXT NOT NULL,
    client_id TEXT NOT NULL,
    client_name TEXT,
    source TEXT DEFAULT 'topic_parse',
    PRIMARY KEY (contact_name, client_id)
  )
`);

// B3X internal team — exclude from contact detection
const INTERNAL = new Set(['dan kuschell', 'philip mutrie', 'phil', 'richard', 'manuel', 'juan', 'vince', 'joaco', 'jacob', 'bill soady', 'bill', 'nicole', 'sarah', 'ray', 'ray z']);

const insert = db.prepare('INSERT OR IGNORE INTO client_contacts (contact_name, client_id, client_name, source) VALUES (?, ?, ?, ?)');
let count = 0;

function add(name, clientId, clientName, source) {
  name = name.trim();
  if (!name || name.length < 2 || INTERNAL.has(name.toLowerCase())) return;
  insert.run(name, clientId, clientName, source);
  count++;
}

// 1. Parse meeting topics
const meetings = db.prepare("SELECT DISTINCT topic, client_id, client_name FROM meetings WHERE client_id IS NOT NULL AND client_id != 'unmatched'").all();

for (const m of meetings) {
  if (!m.topic || !m.client_id) continue;

  // Add client_name as contact
  if (m.client_name) add(m.client_name, m.client_id, m.client_name, 'client_name');

  // Add client_id with hyphens as spaces
  add(m.client_id.replace(/-/g, ' '), m.client_id, m.client_name, 'client_id');

  // Parse topic: "{Contact}/{Company} | {Series}" or "{Contact} | {Company} | {Series}" etc.
  const topic = m.topic;

  // Pattern: "Name/Company | ..." or "Name/Name/Company | ..."
  const pipeIdx = topic.indexOf('|');
  const beforePipe = pipeIdx > 0 ? topic.slice(0, pipeIdx).trim() : topic;

  // Split by / to get contact names
  const parts = beforePipe.split('/').map(p => p.trim()).filter(Boolean);

  if (parts.length >= 2) {
    // Last part before pipe might be company name (skip if it matches client_name)
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      // Skip if it looks like the client/company name
      if (part.toLowerCase() === (m.client_name || '').toLowerCase()) continue;
      if (part.toLowerCase().includes('breakthrough') || part.toLowerCase().includes('b3x') || part.toLowerCase().includes('huddle')) continue;
      add(part, m.client_id, m.client_name, 'topic_parse');
    }
  } else if (parts.length === 1) {
    // Pattern: "Name - Company" or "Name | Company"
    const dashParts = beforePipe.split(/\s*[-–]\s*/);
    if (dashParts.length >= 1) {
      const name = dashParts[0].trim();
      if (name.toLowerCase() !== (m.client_name || '').toLowerCase()) {
        add(name, m.client_id, m.client_name, 'topic_parse');
      }
    }

    // Pattern: "Name & Name | Company"
    const ampParts = beforePipe.split(/\s*[&]\s*/);
    for (const part of ampParts) {
      const clean = part.trim();
      if (clean && clean.toLowerCase() !== (m.client_name || '').toLowerCase()) {
        add(clean, m.client_id, m.client_name, 'topic_parse');
      }
    }
  }
}

// 2. Extract speaker names from transcript chunks (per client)
const speakers = db.prepare(`
  SELECT DISTINCT tc.client_id, tc.speakers, m.client_name
  FROM transcript_chunks tc
  JOIN meetings m ON tc.meeting_id = m.id
  WHERE tc.client_id IS NOT NULL AND tc.client_id != 'unmatched'
`).all();

for (const row of speakers) {
  try {
    const names = JSON.parse(row.speakers || '[]');
    for (const name of names) {
      if (!INTERNAL.has(name.toLowerCase()) && !INTERNAL.has(name.split(' ')[0].toLowerCase())) {
        add(name, row.client_id, row.client_name, 'transcript_speaker');
      }
    }
  } catch {}
}

console.log(`\n📇 Populated client_contacts: ${count} entries inserted`);

// Show summary
const summary = db.prepare('SELECT client_id, COUNT(*) as c FROM client_contacts GROUP BY client_id ORDER BY c DESC').all();
console.log(`   ${summary.length} unique clients mapped\n`);
summary.slice(0, 10).forEach(s => console.log(`   ${s.client_id}: ${s.c} contacts`));
if (summary.length > 10) console.log(`   ... and ${summary.length - 10} more\n`);

db.close();
