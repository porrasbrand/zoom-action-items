#!/usr/bin/env node
/**
 * Generate Q&A cache for all meetings (template-based, no LLM calls)
 * Usage: node scripts/generate-qa-cache.mjs [--meeting-id=X]
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { generateMeetingQA, saveQA } from '../src/lib/qa-generator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '../data/zoom-action-items.db');

const args = process.argv.slice(2);
const meetingIdArg = args.find(a => a.startsWith('--meeting-id='));
const singleMeetingId = meetingIdArg ? parseInt(meetingIdArg.split('=')[1]) : null;

const db = new Database(DB_PATH);

// Ensure table exists
db.exec(`
  CREATE TABLE IF NOT EXISTS meeting_qa_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id INTEGER NOT NULL REFERENCES meetings(id),
    question_type TEXT NOT NULL,
    question TEXT NOT NULL,
    answer TEXT NOT NULL,
    generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(meeting_id, question_type)
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_qa_meeting ON meeting_qa_cache(meeting_id)');

const meetings = singleMeetingId
  ? db.prepare('SELECT id FROM meetings WHERE id = ?').all(singleMeetingId)
  : db.prepare('SELECT id FROM meetings ORDER BY id').all();

console.log(`\n📝 Q&A Cache Generator`);
console.log(`   Meetings: ${meetings.length}\n`);

let totalPairs = 0;
const typeCounts = {};

for (const meeting of meetings) {
  const pairs = generateMeetingQA(db, meeting.id);
  if (pairs.length > 0) {
    saveQA(db, meeting.id, pairs);
    totalPairs += pairs.length;
    pairs.forEach(p => { typeCounts[p.question_type] = (typeCounts[p.question_type] || 0) + 1; });
  }
}

console.log(`📊 Generated ${totalPairs} Q&A pairs across ${meetings.length} meetings`);
console.log('   By type:');
Object.entries(typeCounts).sort((a, b) => b[1] - a[1]).forEach(([type, count]) => {
  console.log(`     ${type}: ${count}`);
});
console.log('');

db.close();
