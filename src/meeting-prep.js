#!/usr/bin/env node
/**
 * Meeting Prep Generator CLI
 * Generates AI-powered meeting preparation documents from roadmap data.
 *
 * Usage:
 *   node src/meeting-prep.js --client echelon
 *   node src/meeting-prep.js --client echelon --format markdown
 *   node src/meeting-prep.js --client echelon --format json
 *   node src/meeting-prep.js --client echelon --slack
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env') });

import { collectPrepData } from './lib/prep-collector.js';
import { generateMeetingPrep } from './lib/prep-generator.js';
import { formatAsMarkdown, formatForSlack } from './lib/prep-formatter.js';
import { initRoadmapTables } from './lib/roadmap-db.js';

// Parse CLI args
const args = process.argv.slice(2);
const clientArg = args.find(a => a.startsWith('--client'));
const formatArg = args.find(a => a.startsWith('--format'));
const postToSlack = args.includes('--slack');

const clientId = clientArg ? args[args.indexOf(clientArg) + 1] : null;
const format = formatArg ? args[args.indexOf(formatArg) + 1] : 'markdown';

if (!clientId) {
  console.error('Usage: node src/meeting-prep.js --client <client-id> [--format markdown|json] [--slack]');
  process.exit(1);
}

// Database connection
const DB_PATH = join(__dirname, '..', 'data', 'zoom-action-items.db');
const db = new Database(DB_PATH);

// Ensure roadmap tables exist
initRoadmapTables(db);

// Ensure preps directory exists
const prepsDir = join(__dirname, '..', 'data', 'preps');
if (!existsSync(prepsDir)) {
  mkdirSync(prepsDir, { recursive: true });
}

async function main() {
  console.log(`\n=== Meeting Prep Generator ===`);
  console.log(`Client: ${clientId}`);
  console.log(`Format: ${format}`);
  console.log(`Post to Slack: ${postToSlack}`);
  console.log('');

  // Load client config
  const clientsConfig = JSON.parse(
    readFileSync(join(__dirname, 'config', 'clients.json'), 'utf-8')
  );
  const client = clientsConfig.clients.find(c => c.id === clientId);

  if (!client) {
    console.error(`Client not found: ${clientId}`);
    console.error('Available clients:', clientsConfig.clients.map(c => c.id).join(', '));
    process.exit(1);
  }

  console.log(`Client Name: ${client.name}`);
  console.log(`Industry: ${client.industry || 'unknown'}`);
  console.log(`B3X Lead: ${client.b3x_lead || 'unassigned'}`);
  console.log('');

  // Check if client has roadmap data
  const roadmapCount = db.prepare('SELECT COUNT(*) as cnt FROM roadmap_items WHERE client_id = ?').get(clientId);
  if (!roadmapCount || roadmapCount.cnt === 0) {
    console.error(`No roadmap data found for ${clientId}. Run roadmap-build.js first.`);
    process.exit(1);
  }
  console.log(`Roadmap items: ${roadmapCount.cnt}`);

  // Collect prep data
  console.log('\nCollecting prep data...');
  const prepData = await collectPrepData(db, clientId);

  console.log(`  Active items: ${prepData.roadmap.active.length}`);
  console.log(`  Stale items: ${prepData.roadmap.stale.length}`);
  console.log(`  Recently completed: ${prepData.roadmap.recently_completed.length}`);
  console.log(`  Blocked: ${prepData.roadmap.blocked.length}`);
  console.log(`  Recent meetings: ${prepData.meetings.recent.length}`);
  console.log(`  Service gaps: ${prepData.service_gaps.length}`);

  // Generate prep document
  console.log('\nGenerating meeting prep (calling Gemini)...');
  const result = await generateMeetingPrep(prepData);
  const prep = result.json;

  console.log('\nGeneration complete!');
  console.log(`  Completed items: ${prep.status_report?.completed?.length || 0}`);
  console.log(`  In-progress items: ${prep.status_report?.in_progress?.length || 0}`);
  console.log(`  Stale items flagged: ${prep.accountability?.stale_items?.length || 0}`);
  console.log(`  Strategic recommendations: ${prep.strategic_direction?.length || 0}`);
  console.log(`  Agenda items: ${prep.suggested_agenda?.length || 0}`);

  // Save prep to files
  const dateStr = new Date().toISOString().split('T')[0];
  const baseFilename = `${clientId}-${dateStr}`;
  const mdPath = join(prepsDir, `${baseFilename}.md`);
  const jsonPath = join(prepsDir, `${baseFilename}.json`);

  const markdown = formatAsMarkdown(prep);
  writeFileSync(mdPath, markdown);
  writeFileSync(jsonPath, JSON.stringify(prep, null, 2));

  console.log(`\nSaved to:`);
  console.log(`  ${mdPath}`);
  console.log(`  ${jsonPath}`);

  // Output based on format
  if (format === 'json') {
    console.log('\n--- JSON OUTPUT ---\n');
    console.log(JSON.stringify(prep, null, 2));
  } else {
    console.log('\n--- MARKDOWN OUTPUT ---\n');
    console.log(markdown);
  }

  // Post to Slack if requested
  if (postToSlack) {
    if (!client.slack_channel_id) {
      console.error('\nCannot post to Slack: No slack_channel_id configured for this client');
    } else {
      console.log(`\nPosting to Slack channel ${client.slack_channel_id}...`);
      await postPrepToSlack(client.slack_channel_id, prep);
    }
  }

  db.close();
}

/**
 * Post prep to Slack channel
 */
async function postPrepToSlack(channelId, prep) {
  const slackToken = process.env.SLACK_BOT_TOKEN;
  if (!slackToken) {
    console.error('SLACK_BOT_TOKEN not configured');
    return;
  }

  try {
    const slackMarkdown = formatForSlack(prep);

    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${slackToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        channel: channelId,
        text: `Meeting Prep: ${prep.meta.client_name}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: slackMarkdown.substring(0, 3000) // Slack block limit
            }
          }
        ]
      })
    });

    const result = await response.json();
    if (result.ok) {
      console.log('Posted to Slack successfully');
    } else {
      console.error('Slack error:', result.error);
    }
  } catch (err) {
    console.error('Failed to post to Slack:', err.message);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
