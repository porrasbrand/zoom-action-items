#!/usr/bin/env node
/**
 * Fetch client historical meetings from Zoom
 * Downloads transcripts, runs AI extraction, inserts into database
 *
 * Usage: node scripts/fetch-client-history.mjs --client <client-id>
 */

import 'dotenv/config';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Import from existing modules
import { listRecordings, filterMeetingsWithTranscripts, downloadTranscript } from '../src/lib/zoom-client.js';
import { parseVTT, extractSpeakers } from '../src/lib/vtt-parser.js';
import { extractMeetingData } from '../src/lib/ai-extractor.js';
import * as db from '../src/lib/database.js';

const LOOKBACK_HOURS = 2160; // 90 days

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function loadClientsConfig() {
  const configPath = join(__dirname, '..', 'src', 'config', 'clients.json');
  const config = JSON.parse(readFileSync(configPath, 'utf-8'));
  return config.clients || config;
}

function getClientConfig(clientId) {
  const clients = loadClientsConfig();
  return clients.find(c => c.id === clientId);
}

function matchesClient(topic, client) {
  const topicLower = topic?.toLowerCase() || '';
  return client.keywords.some(kw => topicLower.includes(kw.toLowerCase()));
}

async function main() {
  // Parse --client argument
  const args = process.argv.slice(2);
  const clientIdx = args.indexOf('--client');

  if (clientIdx === -1 || !args[clientIdx + 1]) {
    console.error('Usage: node scripts/fetch-client-history.mjs --client <client-id>');
    console.error('\nAvailable clients:');
    const clients = loadClientsConfig();
    clients.forEach(c => console.error(`  ${c.id} - ${c.name}`));
    process.exit(1);
  }

  const clientId = args[clientIdx + 1];
  const client = getClientConfig(clientId);

  if (!client) {
    console.error(`Error: Client '${clientId}' not found in config`);
    process.exit(1);
  }

  log(`=== Fetch ${client.name} History ===`);
  log(`Client ID: ${clientId}`);
  log(`Keywords: ${client.keywords.join(', ')}`);
  log(`Looking back ${LOOKBACK_HOURS} hours (${Math.round(LOOKBACK_HOURS / 24)} days)`);

  // Fetch all recordings
  log('Fetching recordings from Zoom...');
  const allMeetings = await listRecordings(LOOKBACK_HOURS);
  log(`Found ${allMeetings.length} total meetings across all users`);

  // Filter to meetings with transcripts
  const meetingsWithTranscripts = filterMeetingsWithTranscripts(allMeetings);
  log(`${meetingsWithTranscripts.length} meetings have transcripts`);

  // Filter to client meetings only
  const clientMeetings = meetingsWithTranscripts.filter(m => matchesClient(m.topic, client));
  log(`${clientMeetings.length} ${client.name} meetings found`);

  if (clientMeetings.length === 0) {
    log(`No ${client.name} meetings found. Done.`);
    return;
  }

  // Sort by date (oldest first for proper roadmap processing)
  clientMeetings.sort((a, b) => new Date(a.start_time) - new Date(b.start_time));

  // Process each meeting
  let ingested = 0;
  let skipped = 0;
  let errors = 0;

  for (const meeting of clientMeetings) {
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
      clientId: clientId,
      clientName: client.name,
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
        clientName: client.name,
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
        db.insertActionItems(meetingId, clientId, extraction.action_items);
      }
      if (extraction.decisions?.length) {
        db.insertDecisions(meetingId, clientId, extraction.decisions);
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
  log(`${client.name} meetings found in Zoom: ${clientMeetings.length}`);
  log(`Ingested: ${ingested}`);
  log(`Skipped (already exists): ${skipped}`);
  log(`Errors: ${errors}`);
  log(`\nDone. Run roadmap rebuild next.`);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
