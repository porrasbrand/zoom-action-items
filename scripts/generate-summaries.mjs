#!/usr/bin/env node
/**
 * Generate meeting summaries + meeting-level embeddings for all meetings
 * Usage: node scripts/generate-summaries.mjs [--dry-run] [--meeting-id=X]
 */

import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { summarizeMeeting } from '../src/lib/meeting-summarizer.js';
import { embedMeetingSummary } from '../src/lib/transcript-embedder.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '../data/zoom-action-items.db');

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const meetingIdArg = args.find(a => a.startsWith('--meeting-id='));
const singleMeetingId = meetingIdArg ? parseInt(meetingIdArg.split('=')[1]) : null;

async function main() {
  const db = new Database(DB_PATH);

  // Ensure tables exist
  try { db.exec('ALTER TABLE meetings ADD COLUMN meeting_summary TEXT DEFAULT NULL'); } catch {}
  db.exec(`
    CREATE TABLE IF NOT EXISTS meeting_embeddings (
      meeting_id INTEGER PRIMARY KEY REFERENCES meetings(id),
      embedding BLOB NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Get meetings to process
  let meetings;
  if (singleMeetingId) {
    meetings = db.prepare(
      'SELECT id, topic, client_name FROM meetings WHERE id = ? AND transcript_raw IS NOT NULL'
    ).all(singleMeetingId);
  } else {
    meetings = db.prepare(
      'SELECT id, topic, client_name FROM meetings WHERE transcript_raw IS NOT NULL AND (meeting_summary IS NULL OR id NOT IN (SELECT meeting_id FROM meeting_embeddings)) ORDER BY id'
    ).all();
  }

  console.log(`\n📝 Meeting Summary + Embedding Generator`);
  console.log(`   Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log(`   Meetings to process: ${meetings.length}\n`);

  const startTime = Date.now();
  let summariesGenerated = 0;
  let embeddingsGenerated = 0;
  let fromExtraction = 0;
  let fromLLM = 0;
  let errors = 0;
  let totalTokens = 0;

  for (let i = 0; i < meetings.length; i++) {
    const meeting = meetings[i];

    try {
      // Check if already has summary
      const existing = db.prepare('SELECT meeting_summary FROM meetings WHERE id = ?').get(meeting.id);
      let summary = existing?.meeting_summary;
      let source = 'cached';

      if (!summary) {
        if (dryRun) {
          console.log(`  [${i + 1}/${meetings.length}] Meeting ${meeting.id} (${meeting.client_name || 'Unknown'}): would generate summary`);
          summariesGenerated++;
          continue;
        }

        const result = await summarizeMeeting(db, meeting.id);
        if (!result) { errors++; continue; }
        summary = result.summary;
        source = result.source;
        totalTokens += result.tokensUsed;
        summariesGenerated++;
        if (result.source === 'ai_extraction') fromExtraction++;
        else fromLLM++;

        // Rate limit for LLM calls
        if (result.source === 'claude_haiku') {
          await new Promise(r => setTimeout(r, 200));
        }
      }

      // Generate meeting-level embedding
      const hasEmbedding = db.prepare('SELECT meeting_id FROM meeting_embeddings WHERE meeting_id = ?').get(meeting.id);
      if (!hasEmbedding && summary && !dryRun) {
        await embedMeetingSummary(db, meeting.id, summary.slice(0, 2000));
        embeddingsGenerated++;
        await new Promise(r => setTimeout(r, 100));
      }

      console.log(`  [${i + 1}/${meetings.length}] Meeting ${meeting.id} (${(meeting.client_name || 'Unknown').slice(0, 20)}): summary ${source}, ${summary.length} chars${!hasEmbedding && !dryRun ? ', embedding ✓' : ''}`);

    } catch (err) {
      console.error(`  [${i + 1}/${meetings.length}] Meeting ${meeting.id}: ERROR - ${err.message}`);
      errors++;
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log('\n' + '='.repeat(50));
  console.log(`📊 Summary Generation Complete (${elapsed}s)`);
  console.log(`   Summaries: ${summariesGenerated} (${fromExtraction} from extraction, ${fromLLM} from LLM)`);
  console.log(`   Embeddings: ${embeddingsGenerated}`);
  console.log(`   LLM tokens: ${totalTokens}`);
  if (errors > 0) console.log(`   Errors: ${errors}`);
  console.log('='.repeat(50) + '\n');

  db.close();
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
