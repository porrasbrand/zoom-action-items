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
import { spawn } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env'), override: true });

import { listRecordings, filterMeetingsWithTranscripts, downloadTranscript } from './lib/zoom-client.js';
import { parseVTT, extractSpeakers } from './lib/vtt-parser.js';
import { matchClient, isInternalMeeting } from './lib/client-matcher.js';
import { extractMeetingData } from './lib/ai-extractor.js';
import { postToSlack, formatSlackMessage, postAlert, resolveChannel } from './lib/slack-publisher.js';
import * as db from './lib/database.js';
import { isProofhubConfigured } from './lib/proofhub-client.js';

const DRY_RUN = process.argv.includes('--dry-run') || process.env.DRY_RUN === 'true';
const NO_PUSH = process.argv.includes('--no-push');
const LOOKBACK_HOURS = parseInt(process.env.LOOKBACK_HOURS || '24', 10);

// Auto-push configuration
const AUTO_PUSH_ENABLED = process.env.AUTO_PUSH_ENABLED === 'true' && !NO_PUSH;
const PILOT_CLIENTS = (process.env.AUTO_PUSH_PILOT_CLIENTS || '').split(',').filter(Boolean);

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

/**
 * Log auto-push results to dedicated log file
 */
function logAutoPush(result, clientName) {
  const ts = new Date().toISOString();

  try {
    const logDir = join(__dirname, '..', 'logs');
    mkdirSync(logDir, { recursive: true });
    const logFile = join(logDir, 'auto-push.log');

    const lines = [
      `[${ts}] Meeting #${result.meeting_id} (${clientName}): ${result.summary.pushed} pushed, ${result.summary.drafted} drafted, ${result.summary.skipped} skipped, ${result.summary.client_reminders} client_reminders`
    ];

    for (const item of result.pushed) {
      lines.push(`[${ts}]   PUSHED: "${item.title.substring(0, 50)}" → PH task #${item.ph_task_id || 'N/A'} (${item.owner_name}, due ${item.deadline})`);
    }
    for (const item of result.drafted) {
      lines.push(`[${ts}]   DRAFTED: "${item.title.substring(0, 50)}" → pending review (${item.reason})`);
    }
    for (const item of result.skipped) {
      lines.push(`[${ts}]   SKIPPED: "${item.title.substring(0, 50)}" → ${item.reason}`);
    }
    for (const item of result.client_reminders) {
      lines.push(`[${ts}]   CLIENT_REMINDER: "${item.owner_name}: ${item.title.substring(0, 50)}"`);
    }

    appendFileSync(logFile, lines.join('\n') + '\n');
  } catch { /* ignore log write errors */ }
}

/**
 * Trigger roadmap rebuild for a client after their meeting is processed.
 * Runs async (fire-and-forget) so it doesn't block the main pipeline.
 */
function triggerRoadmapRebuild(clientId, clientName) {
  try {
    log(`  Triggering roadmap rebuild for ${clientName} (${clientId})...`);

    const scriptPath = join(__dirname, 'roadmap-build.js');
    const child = spawn('node', [scriptPath, '--client', clientId, '--rebuild'], {
      cwd: join(__dirname, '..'),
      stdio: 'pipe',
      detached: false
    });

    // Capture output for logging
    let output = '';
    child.stdout.on('data', (data) => { output += data.toString(); });
    child.stderr.on('data', (data) => { output += data.toString(); });

    child.on('close', (code) => {
      if (code === 0) {
        // Extract summary from output
        const summaryMatch = output.match(/Total items: (\d+)/);
        const itemCount = summaryMatch ? summaryMatch[1] : '?';
        log(`  Roadmap rebuild complete for ${clientName}: ${itemCount} items`);
      } else {
        log(`  Roadmap rebuild FAILED for ${clientName} (exit code ${code})`);
      }
    });

    child.on('error', (err) => {
      log(`  Roadmap rebuild ERROR for ${clientName}: ${err.message}`);
    });

  } catch (err) {
    // Don't let roadmap rebuild failure crash the pipeline
    log(`  Roadmap rebuild ERROR for ${clientName}: ${err.message}`);
  }
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

  // Match client and check if internal
  const client = matchClient(topic);
  const isInternal = client?.internal || isInternalMeeting(topic);
  const clientName = client?.name || 'Unmatched';
  const clientId = client?.id || 'unmatched';

  // Resolve target channel for logging
  const { channelName, routing } = resolveChannel(client, isInternal);
  log(`  Client: ${clientName} | Routing: ${routing} → ${channelName}`);

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

    // Post to Slack with channel routing
    if (DRY_RUN) {
      log(`  [DRY RUN] Would post to Slack (${routing} → ${channelName}):`);
      console.log(formatSlackMessage({ topic, clientName, meetingDate: start_time, extraction, isInternal }));
    } else {
      log(`  Posting to Slack: ${routing} → ${channelName}`);
      const slackResult = await postToSlack({
        topic,
        clientName,
        meetingDate: start_time,
        extraction,
        client,
        isInternal,
      });
      db.updateMeetingResults(meetingId, {
        slackMessageTs: slackResult.ts,
        slackChannelId: slackResult.channel,
      });
      const fallbackNote = slackResult.usedFallback ? ' (used fallback)' : '';
      log(`  Posted to Slack: ${slackResult.channel} (${slackResult.routing})${fallbackNote}`);
    }

    // Auto-push to ProofHub (if enabled and configured)
    if (AUTO_PUSH_ENABLED && isProofhubConfigured() && !DRY_RUN) {
      try {
        const { autoPushMeeting } = await import('./lib/auto-push.js');
        const { sendAutoPushNotification, initAutoPushTables } = await import('./lib/auto-push-notifier.js');

        // Ensure drafts table exists
        initAutoPushTables(db.getDb());

        const pushResult = await autoPushMeeting(db.getDb(), meetingId, {
          dryRun: false,
          pilotClients: PILOT_CLIENTS.length > 0 ? PILOT_CLIENTS : null
        });

        log(`  ProofHub auto-push: ${pushResult.summary.pushed} pushed, ${pushResult.summary.drafted} drafts, ${pushResult.summary.skipped} skipped`);
        logAutoPush(pushResult, clientName);

        // Send Slack notification about auto-push results
        if (pushResult.summary.pushed > 0 || pushResult.summary.drafted > 0) {
          const notifyResult = await sendAutoPushNotification(db.getDb(), pushResult, {
            id: meetingId,
            topic,
            client_id: clientId,
            start_time,
            duration_minutes: duration,
          });
          if (notifyResult.success) {
            log(`  Auto-push notification sent to ${notifyResult.channel}`);
          }
        }

        // Log any alerts
        if (pushResult.alerts?.length > 0) {
          for (const alert of pushResult.alerts) {
            log(`  ⚠️ Auto-push alert: ${alert.message || alert.type}`);
            if (alert.type === 'missing_ph_project') {
              await postAlert(`Missing ProofHub project for client: ${alert.client_id}`);
            }
          }
        }
      } catch (pushErr) {
        log(`  ProofHub auto-push ERROR: ${pushErr.message}`);
        // Don't fail the whole pipeline if PH push fails
      }
    } else if (AUTO_PUSH_ENABLED && !isProofhubConfigured()) {
      log('  Auto-push: ProofHub not configured, skipping');
    }

    // Trigger roadmap rebuild for this client (async, don't block pipeline)
    if (clientId && clientId !== 'unmatched' && !DRY_RUN) {
      triggerRoadmapRebuild(clientId, clientName);
    }

    // Session scoring (non-blocking)
    // Step: Compute session metrics
    try {
      const { computeAllMetrics, initDatabase: initMetricsDb } = await import('./lib/session-metrics.js');
      const metricsDb = initMetricsDb();
      computeAllMetrics(metricsDb, meetingId);
      metricsDb.close();
      log(`  Session metrics computed for meeting ${meetingId}`);
    } catch (err) {
      log(`  Session metrics failed (non-blocking): ${err.message}`);
    }

    // Step: Run AI session evaluation
    try {
      const { evaluateMeeting, initDatabase: initEvalDb } = await import('./lib/session-evaluator.js');
      const evalModel = process.env.SESSION_EVAL_MODEL || 'gemini-2.0-flash';
      const evalDb = initEvalDb();
      await evaluateMeeting(meetingId, { model: evalModel, db: evalDb });
      evalDb.close();
      log(`  Session evaluation computed for meeting ${meetingId}`);
    } catch (err) {
      log(`  Session evaluation failed (non-blocking): ${err.message}`);
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
