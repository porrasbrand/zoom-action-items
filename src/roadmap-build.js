#!/usr/bin/env node
/**
 * Roadmap Builder CLI
 * Builds/rebuilds a client's roadmap from historical meetings
 *
 * Usage:
 *   node src/roadmap-build.js --client echelon [--meetings 6] [--dry-run] [--rebuild]
 */

import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '..', '.env') });

import {
  initRoadmapTables,
  createRoadmapItem,
  updateRoadmapItem,
  getRoadmapForClient,
  getActiveRoadmapItems,
  appendStatusHistory,
  incrementSilentCount,
  markItemDiscussed,
  saveSnapshot,
  clearRoadmapForClient
} from './lib/roadmap-db.js';

import {
  classifyActionItem,
  processAgainstRoadmap
} from './lib/roadmap-processor.js';

// Parse CLI args
const args = process.argv.slice(2);
const clientArg = args.find(a => a.startsWith('--client'));
const meetingsArg = args.find(a => a.startsWith('--meetings'));
const dryRun = args.includes('--dry-run');
const rebuild = args.includes('--rebuild');

const clientId = clientArg ? args[args.indexOf(clientArg) + 1] : null;
const meetingsCount = meetingsArg ? parseInt(args[args.indexOf(meetingsArg) + 1]) : 6;

if (!clientId) {
  console.error('Usage: node src/roadmap-build.js --client <client-id> [--meetings 6] [--dry-run] [--rebuild]');
  process.exit(1);
}

// Database connection
const DB_PATH = join(__dirname, '..', 'data', 'zoom-action-items.db');
const db = new Database(DB_PATH);

// Initialize roadmap tables
initRoadmapTables(db);

async function main() {
  console.log(`\n=== Roadmap Builder for ${clientId} ===`);
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE'}`);
  console.log(`Meetings to process: ${meetingsCount}`);

  // Load client config
  const clientsConfig = JSON.parse(
    (await import('fs')).readFileSync(join(__dirname, 'config', 'clients.json'), 'utf-8')
  );
  const client = clientsConfig.clients.find(c => c.id === clientId);

  if (!client) {
    console.error(`Client not found: ${clientId}`);
    console.error('Available clients:', clientsConfig.clients.map(c => c.id).join(', '));
    process.exit(1);
  }

  console.log(`Client: ${client.name}`);

  // Get meetings for this client
  const meetings = db.prepare(`
    SELECT m.*,
           (SELECT json_group_array(json_object(
             'id', ai.id,
             'action', ai.title,
             'assignee', ai.owner_name,
             'due_date', ai.due_date,
             'confidence_tier', ai.confidence_tier
           )) FROM action_items ai WHERE ai.meeting_id = m.id) as action_items_json
    FROM meetings m
    WHERE m.client_id = ? OR m.client_name = ?
    ORDER BY m.start_time ASC
    LIMIT ?
  `).all(clientId, client.name, meetingsCount);

  if (meetings.length === 0) {
    console.error(`No meetings found for client: ${clientId}`);
    process.exit(1);
  }

  console.log(`Found ${meetings.length} meetings\n`);

  // Clear existing roadmap if rebuilding
  if (rebuild && !dryRun) {
    console.log('Clearing existing roadmap for rebuild...');
    clearRoadmapForClient(db, clientId);
  }

  // Process meetings chronologically
  for (let i = 0; i < meetings.length; i++) {
    const meeting = meetings[i];
    const meetingNumber = i + 1;
    const isFirstMeeting = i === 0;

    // Parse action items
    meeting.action_items = JSON.parse(meeting.action_items_json || '[]');

    console.log(`\n--- Meeting ${meetingNumber}/${meetings.length}: ${meeting.topic} ---`);
    console.log(`Date: ${meeting.start_time}`);
    console.log(`Action items: ${meeting.action_items.length}`);

    if (isFirstMeeting) {
      // Seed meeting: create initial roadmap from action items
      await processSeedMeeting(meeting, client);
    } else {
      // Subsequent meetings: cross-reference against roadmap
      await processSubsequentMeeting(meeting, client, meetingNumber, meetings.length);
    }

    // Save snapshot after each meeting
    const currentRoadmap = getRoadmapForClient(db, clientId);
    if (!dryRun) {
      saveSnapshot(db, clientId, meeting.id, currentRoadmap);
    }

    console.log(`Roadmap items after this meeting: ${currentRoadmap.length}`);
  }

  // Final output
  const finalRoadmap = getRoadmapForClient(db, clientId);
  console.log('\n=== Final Roadmap Summary ===');
  console.log(`Total items: ${finalRoadmap.length}`);
  console.log(`Done: ${finalRoadmap.filter(i => i.status === 'done').length}`);
  console.log(`In Progress: ${finalRoadmap.filter(i => i.status === 'in-progress').length}`);
  console.log(`Blocked: ${finalRoadmap.filter(i => i.status === 'blocked').length}`);
  console.log(`Agreed/Pending: ${finalRoadmap.filter(i => i.status === 'agreed').length}`);
  console.log(`Stale (2+ silent): ${finalRoadmap.filter(i => i.meetings_silent_count >= 2).length}`);

  console.log('\n=== Roadmap Items ===');
  for (const item of finalRoadmap) {
    const staleMarker = item.meetings_silent_count >= 2 ? ' [STALE]' : '';
    console.log(`[${item.status.toUpperCase()}] ${item.title} (${item.category}/${item.task_type}) - ${item.owner_side}${staleMarker}`);
  }

  db.close();
}

/**
 * Process the first (seed) meeting - creates initial roadmap items
 */
async function processSeedMeeting(meeting, client) {
  console.log('Processing as SEED meeting (creating initial roadmap)...');

  const actionItems = meeting.action_items || [];

  for (const ai of actionItems) {
    if (!ai.action) continue;

    console.log(`  Classifying: ${ai.action.substring(0, 60)}...`);

    // Classify the action item
    const classification = await classifyActionItem(ai, client.name);

    const roadmapItem = {
      client_id: client.id,
      title: ai.action,
      description: null,
      category: classification.category,
      task_type: classification.task_type,
      owner_side: classification.owner_side,
      owner_name: classification.owner_name || ai.assignee,
      status: 'agreed',
      created_meeting_id: meeting.id,
      due_date: ai.due_date || null,
      source_action_item_id: ai.id
    };

    if (!dryRun) {
      const id = createRoadmapItem(db, roadmapItem);
      console.log(`    Created roadmap item #${id}: ${classification.category}/${classification.task_type}`);
    } else {
      console.log(`    [DRY RUN] Would create: ${classification.category}/${classification.task_type}`);
    }
  }
}

/**
 * Process subsequent meetings - cross-reference against existing roadmap
 */
async function processSubsequentMeeting(meeting, client, meetingNumber, totalMeetings) {
  console.log('Cross-referencing against existing roadmap...');

  const currentRoadmap = getActiveRoadmapItems(db, client.id);

  if (currentRoadmap.length === 0) {
    console.log('  No active roadmap items to cross-reference');
    // Still process action items as new items
    await processSeedMeeting(meeting, client);
    return;
  }

  // Call AI to process meeting against roadmap
  const result = await processAgainstRoadmap(
    meeting,
    currentRoadmap,
    client.name,
    meetingNumber,
    totalMeetings
  );

  // Process updates to existing items
  console.log(`  Updates to existing items: ${result.existing_items_update.length}`);

  const discussedIds = new Set();

  for (const update of result.existing_items_update) {
    const item = currentRoadmap.find(i => i.id === update.roadmap_item_id);
    if (!item) continue;

    if (update.was_discussed) {
      discussedIds.add(update.roadmap_item_id);

      if (!dryRun) {
        markItemDiscussed(db, update.roadmap_item_id, meeting.id);
      }

      if (update.new_status && update.new_status !== 'unchanged' && update.new_status !== item.status) {
        console.log(`    [${item.title.substring(0, 40)}...] ${item.status} → ${update.new_status}`);

        if (!dryRun) {
          updateRoadmapItem(db, update.roadmap_item_id, {
            status: update.new_status,
            status_reason: update.status_evidence
          });

          appendStatusHistory(db, update.roadmap_item_id, {
            meeting_id: meeting.id,
            status: update.new_status,
            notes: update.status_evidence
          });
        }
      }
    }
  }

  // Increment silent count for items not discussed
  const notDiscussedCount = currentRoadmap.length - discussedIds.size;
  if (notDiscussedCount > 0) {
    console.log(`  Items not discussed this meeting: ${notDiscussedCount}`);
    if (!dryRun) {
      for (const item of currentRoadmap) {
        if (!discussedIds.has(item.id)) {
          updateRoadmapItem(db, item.id, {
            meetings_silent_count: item.meetings_silent_count + 1
          });
        }
      }
    }
  }

  // Process new items
  console.log(`  New items identified: ${result.new_items.length}`);

  for (const newItem of result.new_items) {
    const roadmapItem = {
      client_id: client.id,
      title: newItem.title,
      description: newItem.description,
      category: newItem.category,
      task_type: newItem.task_type,
      owner_side: newItem.owner_side || 'b3x',
      owner_name: newItem.owner_name,
      status: 'agreed',
      created_meeting_id: meeting.id,
      due_date: newItem.due_date || null
    };

    if (!dryRun) {
      const id = createRoadmapItem(db, roadmapItem);
      console.log(`    Created: #${id} ${newItem.title.substring(0, 50)}...`);
    } else {
      console.log(`    [DRY RUN] Would create: ${newItem.title.substring(0, 50)}...`);
    }
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
