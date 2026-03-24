#!/usr/bin/env node
/**
 * Zoom Action Items Pipeline — Cron entry point.
 * Polls Zoom for new recordings, extracts action items, posts to Slack.
 *
 * Usage:
 *   node src/poll.js              # Normal run
 *   node src/poll.js --dry-run    # Skip Slack posting
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { appendFileSync, mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env'), override: true });

import { listRecordings, filterMeetingsWithTranscripts, downloadTranscript } from './lib/zoom-client.js';
import { parseVTT, extractSpeakers } from './lib/vtt-parser.js';
import { matchClient } from './lib/client-matcher.js';
import { extractMeetingData } from './lib/ai-extractor.js';
import { postToSlack, formatSlackMessage, postAlert } from './lib/slack-publisher.js';
import * as db from './lib/database.js';

const DRY_RUN = process.argv.includes('--dry-run') || process.env.DRY_RUN === 'true';
const LOOKBACK_HOURS = parseInt(process.env.LOOKBACK_HOURS || '24', 10);

// Default channel for unmatched clients or clients without channel config
const DEFAULT_SLACK_CHANNEL = process.env.SLACK_DEFAULT_CHANNEL || 'zoom-meeting-notes';

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);

  // Also append to daily log file
  try {
    const logDir = join(__dirname, '..', 'logs');
    mkdirSync(logDir, { recursive: true });
    const logFile = join(logDir, `${ts.slice(0, 10)}.log`);
    appendFileSync(logFile, line + '\n');
  } catch { /* ignore log write errors */ }
}

async function processMeeting(meeting) {
  const { uuid, topic, start_time, duration, transcript_download_url } = meeting;

  // Sanitize UUID for dedup (Zoom uses / in double-encoded UUIDs)
  const safeUuid = uuid.replace(/\//g, '_');

  // Check dedup
  if (db.meetingExists(safeUuid)) {
    log(`  SKIP (already processed): ${topic}`);
    return { skipped: true };
  }

  log(`  Processing: "${topic}" (${start_time})`);

  // Match client
  const client = matchClient(topic);
  const clientName = client?.name || 'Unmatched';
  const clientId = client?.id || 'unmatched';
  log(`  Client: ${clientName}`);

  // Insert meeting record (status: processing)
  const meetingId = db.insertMeeting({
    zoomMeetingUuid: safeUuid,
    topic,
    clientId,
    clientName,
    startTime: start_time,
    durationMinutes: duration,
  });

  try {
    // Download transcript
    log('  Downloading transcript...');
    const rawVTT = await downloadTranscript(transcript_download_url);

    // Parse VTT
    const parsedTranscript = parseVTT(rawVTT);
    const speakers = extractSpeakers(parsedTranscript);
    log(`  Parsed: ${parsedTranscript.length} chars, ${speakers.length} speakers: ${speakers.join(', ')}`);

    // AI extraction
    log('  Running Gemini extraction...');
    const extraction = await extractMeetingData({
      transcript: parsedTranscript,
      topic,
      clientName,
      meetingDate: start_time,
      speakers,
    });

    const actionCount = extraction.action_items?.length || 0;
    const decisionCount = extraction.decisions?.length || 0;
    log(`  Extracted: ${actionCount} action items, ${decisionCount} decisions`);

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

    // Post to Slack
    const channelId = client?.slack_channel_id || DEFAULT_SLACK_CHANNEL;

    if (DRY_RUN) {
      log('  [DRY RUN] Would post to Slack:');
      console.log(formatSlackMessage({ topic, clientName, meetingDate: start_time, extraction }));
    } else {
      log(`  Posting to Slack channel: ${channelId}`);
      const slackResult = await postToSlack({
        channelId,
        topic,
        clientName,
        meetingDate: start_time,
        extraction,
      });
      db.updateMeetingResults(meetingId, {
        slackMessageTs: slackResult.ts,
        slackChannelId: slackResult.channel,
      });
      log(`  Posted to Slack: ${slackResult.channel} (ts: ${slackResult.ts})`);
    }

    return { processed: true, clientName, actionCount, decisionCount };

  } catch (err) {
    log(`  ERROR: ${err.message}`);
    db.updateMeetingResults(meetingId, {
      status: 'error',
      errorMessage: err.message,
    });

    if (!DRY_RUN) {
      await postAlert(`Failed to process meeting "${topic}": ${err.message}`);
    }

    return { error: true, message: err.message };
  }
}

/**
 * Run a single poll cycle. Exported for use by service.js.
 * @returns {{ processed: number, skipped: number, errors: number }}
 */
export async function pollOnce() {
  log(`=== Zoom Action Items Pipeline ${DRY_RUN ? '(DRY RUN)' : ''} ===`);
  log(`Looking back ${LOOKBACK_HOURS} hours for recordings...`);

  // Fetch recordings
  const allMeetings = await listRecordings(LOOKBACK_HOURS);
  log(`Found ${allMeetings.length} total meetings`);

  // Filter to those with transcripts
  const meetings = filterMeetingsWithTranscripts(allMeetings);
  log(`${meetings.length} meetings have transcripts`);

  if (meetings.length === 0) {
    log('No new meetings with transcripts. Done.');
    return { processed: 0, skipped: 0, errors: 0 };
  }

  // Process each meeting
  let processed = 0, skipped = 0, errors = 0;

  for (const meeting of meetings) {
    const result = await processMeeting(meeting);
    if (result.skipped) skipped++;
    else if (result.error) errors++;
    else if (result.processed) processed++;
  }

  log(`\nDone: ${processed} processed, ${skipped} skipped, ${errors} errors`);

  // Log stats
  const stats = db.getStats();
  log(`DB: ${stats.total} total meetings`);

  return { processed, skipped, errors };
}

// Run as CLI script if executed directly
async function main() {
  try {
    await pollOnce();
  } catch (err) {
    log(`FATAL: ${err.message}`);
    if (!DRY_RUN) {
      await postAlert(`Pipeline fatal error: ${err.message}`);
    }
    process.exit(1);
  }
}

// ES module main check
const isMainModule = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*[\\/]/, ''));
if (isMainModule) {
  main();
}
