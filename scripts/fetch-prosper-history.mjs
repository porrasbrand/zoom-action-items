#!/usr/bin/env node
/**
 * Fetch Prosper Group historical meetings from Zoom
 * Downloads transcripts, runs AI extraction, inserts into database
 *
 * Usage: node scripts/fetch-prosper-history.mjs
 */

import 'dotenv/config';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Import from existing modules
import { listRecordings, filterMeetingsWithTranscripts, downloadTranscript } from '../src/lib/zoom-client.js';
import { parseVTT, extractSpeakers } from '../src/lib/vtt-parser.js';
import { extractMeetingData } from '../src/lib/ai-extractor.js';
import * as db from '../src/lib/database.js';

const LOOKBACK_HOURS = 2160; // 90 days
const CLIENT_ID = 'prosper-group';
const CLIENT_NAME = 'Prosper Group';

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function main() {
  log('=== Fetch Prosper Group History ===');
  log(`Looking back ${LOOKBACK_HOURS} hours (${Math.round(LOOKBACK_HOURS / 24)} days)`);

  // Fetch all recordings
  log('Fetching recordings from Zoom...');
  const allMeetings = await listRecordings(LOOKBACK_HOURS);
  log(`Found ${allMeetings.length} total meetings across all users`);

  // Filter to meetings with transcripts
  const meetingsWithTranscripts = filterMeetingsWithTranscripts(allMeetings);
  log(`${meetingsWithTranscripts.length} meetings have transcripts`);

  // Filter to Prosper Group meetings only
  const prosperMeetings = meetingsWithTranscripts.filter(m =>
    m.topic?.toLowerCase().includes('prosper')
  );
  log(`${prosperMeetings.length} Prosper Group meetings found`);

  if (prosperMeetings.length === 0) {
    log('No Prosper Group meetings found. Done.');
    return;
  }

  // Sort by date (oldest first for proper roadmap processing)
  prosperMeetings.sort((a, b) => new Date(a.start_time) - new Date(b.start_time));

  // Process each meeting
  let ingested = 0;
  let skipped = 0;
  let errors = 0;

  for (const meeting of prosperMeetings) {
    const { uuid, topic, start_time, duration, transcript_download_url } = meeting;

    // Sanitize UUID (Zoom uses / in double-encoded UUIDs)
    const safeUuid = uuid.replace(/\//g, '_');

    // Check if already in DB
    if (db.meetingExists(safeUuid)) {
      log(`  SKIP (exists): ${topic} - ${start_time}`);
      skipped++;
      continue;
    }

    log(`\n  Processing: "${topic}" (${start_time})`);

    // Insert meeting record
    const meetingId = db.insertMeeting({
      zoomMeetingUuid: safeUuid,
      topic,
      clientId: CLIENT_ID,
      clientName: CLIENT_NAME,
      startTime: start_time,
      durationMinutes: duration,
    });

    try {
      // Download transcript
      log('    Downloading transcript...');
      const rawVTT = await downloadTranscript(transcript_download_url);

      // Parse VTT
      const parsedTranscript = parseVTT(rawVTT);
      const speakers = extractSpeakers(parsedTranscript);
      log(`    Parsed: ${parsedTranscript.length} chars, ${speakers.length} speakers`);

      // AI extraction
      log('    Running Gemini extraction...');
      const extraction = await extractMeetingData({
        transcript: parsedTranscript,
        topic,
        clientName: CLIENT_NAME,
        meetingDate: start_time,
        speakers,
      });

      const actionCount = extraction.action_items?.length || 0;
      const decisionCount = extraction.decisions?.length || 0;
      log(`    Extracted: ${actionCount} action items, ${decisionCount} decisions`);

      // Store in database
      db.updateMeetingResults(meetingId, {
        transcriptRaw: parsedTranscript,
        aiExtraction: extraction,
        status: 'completed',
      });

      if (extraction.action_items?.length) {
        db.insertActionItems(meetingId, CLIENT_ID, extraction.action_items);
      }
      if (extraction.decisions?.length) {
        db.insertDecisions(meetingId, CLIENT_ID, extraction.decisions);
      }

      log(`    ✓ Ingested meeting ID ${meetingId}`);
      ingested++;

      // Rate limit - wait 2 seconds between AI calls
      await new Promise(r => setTimeout(r, 2000));

    } catch (err) {
      log(`    ✗ ERROR: ${err.message}`);
      db.updateMeetingResults(meetingId, {
        status: 'error',
        errorMessage: err.message,
      });
      errors++;
    }
  }

  log('\n=== Summary ===');
  log(`Prosper meetings found: ${prosperMeetings.length}`);
  log(`Ingested: ${ingested}`);
  log(`Skipped (already exists): ${skipped}`);
  log(`Errors: ${errors}`);

  // Count total Prosper meetings in DB
  const totalInDb = db.getDb ? null : 'N/A'; // Can't access directly, will count after
  log(`\nDone. Run roadmap rebuild next.`);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
