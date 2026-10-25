#!/usr/bin/env node
/**
 * Backfill transcript chunks + embeddings for all meetings
 *
 * Usage:
 *   node scripts/backfill-embeddings.mjs                    # process all meetings
 *   node scripts/backfill-embeddings.mjs --dry-run           # parse only, don't save
 *   node scripts/backfill-embeddings.mjs --meeting-id=133    # process one meeting
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { chunkTranscript, saveChunks, deleteChunksForMeeting } from '../src/lib/transcript-chunker.js';
import { embedAndSaveChunks } from '../src/lib/transcript-embedder.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '../data/zoom-action-items.db');

// Parse CLI args
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const meetingIdArg = args.find(a => a.startsWith('--meeting-id='));
const singleMeetingId = meetingIdArg ? parseInt(meetingIdArg.split('=')[1]) : null;

async function main() {
  const db = new Database(DB_PATH);

  // Ensure tables exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS transcript_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      meeting_id INTEGER NOT NULL REFERENCES meetings(id),
      client_id TEXT,
      chunk_index INTEGER NOT NULL,
      start_time TEXT,
      end_time TEXT,
      speakers TEXT,
      text TEXT NOT NULL,
      token_count INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_chunks_meeting ON transcript_chunks(meeting_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_chunks_client ON transcript_chunks(client_id)');
  db.exec(`
    CREATE TABLE IF NOT EXISTS transcript_embeddings (
      chunk_id INTEGER PRIMARY KEY REFERENCES transcript_chunks(id),
      embedding BLOB NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Get meetings to process
  let meetings;
  if (singleMeetingId) {
    meetings = db.prepare(
      'SELECT id, client_id, transcript_raw FROM meetings WHERE id = ? AND transcript_raw IS NOT NULL'
    ).all(singleMeetingId);
  } else {
    meetings = db.prepare(
      'SELECT id, client_id, transcript_raw FROM meetings WHERE transcript_raw IS NOT NULL ORDER BY id'
    ).all();
  }

  console.log(`\n📝 Transcript Chunker + Embedder`);
  console.log(`   Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log(`   Meetings: ${meetings.length}`);
  console.log('');

  const startTime = Date.now();
  let totalChunks = 0;
  let totalEmbeddings = 0;
  let totalSkipped = 0;
  let totalErrors = 0;

  for (let i = 0; i < meetings.length; i++) {
    const meeting = meetings[i];

    // Skip if already chunked (unless single meeting)
    if (!singleMeetingId) {
      const existingChunks = db.prepare(
        'SELECT COUNT(*) as count FROM transcript_chunks WHERE meeting_id = ?'
      ).get(meeting.id);
      if (existingChunks.count > 0) {
        console.log(`  [${i + 1}/${meetings.length}] Meeting ${meeting.id}: already chunked (${existingChunks.count} chunks) — skipping`);
        totalSkipped++;
        continue;
      }
    }

    // Chunk the transcript
    const chunks = chunkTranscript(meeting.id, meeting.transcript_raw, meeting.client_id);

    if (dryRun) {
      const totalTokens = chunks.reduce((sum, c) => sum + c.token_count, 0);
      const speakers = new Set();
      chunks.forEach(c => JSON.parse(c.speakers).forEach(s => speakers.add(s)));
      console.log(`  [${i + 1}/${meetings.length}] Meeting ${meeting.id}: ${chunks.length} chunks, ~${totalTokens} tokens, ${speakers.size} speakers`);
      totalChunks += chunks.length;
      continue;
    }

    // Delete existing chunks if re-processing single meeting
    if (singleMeetingId) {
      deleteChunksForMeeting(db, meeting.id);
    }

    // Save chunks
    const chunkIds = saveChunks(db, chunks);
    totalChunks += chunkIds.length;

    // Generate embeddings
    const result = await embedAndSaveChunks(db, chunkIds, 100);
    totalEmbeddings += result.embedded;
    totalErrors += result.errors;

    console.log(`  [${i + 1}/${meetings.length}] Meeting ${meeting.id}: ${chunkIds.length} chunks, ${result.embedded} embeddings${result.errors > 0 ? `, ${result.errors} errors` : ''}`);
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('\n' + '='.repeat(50));
  console.log(`📊 Backfill Complete (${elapsed}s)`);
  console.log(`   Total chunks: ${totalChunks}`);
  if (!dryRun) {
    console.log(`   Total embeddings: ${totalEmbeddings}`);
  }
  console.log(`   Skipped (already done): ${totalSkipped}`);
  if (totalErrors > 0) {
    console.log(`   Errors: ${totalErrors}`);
  }
  console.log('='.repeat(50) + '\n');

  db.close();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
