#!/usr/bin/env node
/**
 * Zoom Pipeline Service — Long-running PM2 service.
 * Runs pollOnce() every 5 minutes with singleton lock.
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { WebClient } from '@slack/web-api';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env'), override: true });

import { pollOnce } from './poll.js';
import { listUsers } from './lib/zoom-client.js';
import { postAlert } from './lib/slack-publisher.js';

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const DRY_RUN = process.env.DRY_RUN === 'true';

// Singleton lock to prevent overlapping poll cycles
let isPolling = false;

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

/**
 * Validate all required credentials are set and working.
 */
async function validateCredentials() {
  log('Validating credentials...');
  const errors = [];

  // Check required env vars
  const required = [
    'ZOOM_ACCOUNT_ID',
    'ZOOM_CLIENT_ID',
    'ZOOM_CLIENT_SECRET',
    'GOOGLE_API_KEY',
    'SLACK_BOT_TOKEN',
  ];

  for (const key of required) {
    if (!process.env[key]) {
      errors.push(`Missing env var: ${key}`);
    }
  }

  if (errors.length) {
    throw new Error(`Credential validation failed:\n  ${errors.join('\n  ')}`);
  }

  // Test Zoom API
  try {
    log('  Testing Zoom API...');
    const users = await listUsers();
    log(`  Zoom: OK (${users.length} users on account)`);
  } catch (err) {
    throw new Error(`Zoom API test failed: ${err.message}`);
  }

  // Test Slack API
  try {
    log('  Testing Slack API...');
    const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
    const authResult = await slack.auth.test();
    log(`  Slack: OK (bot: ${authResult.user}, team: ${authResult.team})`);
  } catch (err) {
    throw new Error(`Slack API test failed: ${err.message}`);
  }

  // Note: We don't test Gemini here as it would cost tokens
  // The AI extractor will throw on first use if key is invalid
  log('  Gemini: Key present (will validate on first use)');

  log('Credential validation: PASSED');
}

/**
 * Run a single poll cycle with singleton guard.
 */
async function runPollCycle() {
  if (isPolling) {
    log('Previous poll still running, skipping this cycle');
    return;
  }

  isPolling = true;
  const startTime = Date.now();
  log('--- Poll cycle starting ---');

  try {
    const result = await pollOnce();
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log(`--- Poll cycle complete (${elapsed}s) --- processed=${result.processed}, skipped=${result.skipped}, errors=${result.errors}`);
  } catch (err) {
    log(`--- Poll cycle FAILED: ${err.message} ---`);
    if (!DRY_RUN) {
      try {
        await postAlert(`Pipeline error: ${err.message}`);
      } catch (alertErr) {
        log(`Failed to post alert: ${alertErr.message}`);
      }
    }
  } finally {
    isPolling = false;
  }
}

/**
 * Main service entry point.
 */
async function main() {
  log('=== Zoom Pipeline Service Starting ===');
  log(`Mode: ${DRY_RUN ? 'DRY RUN (no Slack posting)' : 'LIVE'}`);
  log(`Poll interval: ${POLL_INTERVAL_MS / 1000}s`);

  // Validate credentials on startup
  try {
    await validateCredentials();
  } catch (err) {
    log(`FATAL: ${err.message}`);
    process.exit(1);
  }

  // Run first poll immediately
  await runPollCycle();

  // Schedule recurring polls
  log(`Scheduling polls every ${POLL_INTERVAL_MS / 1000 / 60} minutes...`);
  setInterval(runPollCycle, POLL_INTERVAL_MS);

  log('Service running. Press Ctrl+C to stop.');
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  log('Received SIGINT, shutting down...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  log('Received SIGTERM, shutting down...');
  process.exit(0);
});

main();
