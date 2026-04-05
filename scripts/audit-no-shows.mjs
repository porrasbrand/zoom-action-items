#!/usr/bin/env node
/**
 * Retroactive No-Show Audit
 * Scans all meetings to identify no-shows and test recordings
 */

import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { classifyMeeting } from '../src/lib/session-metrics.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'zoom-action-items.db');

async function main() {
  const db = new Database(DB_PATH);

  console.log('=== No-Show Audit Report ===\n');

  // Get all meetings with gpt-5.4 evaluations
  const meetings = db.prepare(`
    SELECT m.id, m.topic, m.client_id, m.client_name, m.duration_minutes, m.transcript_raw,
           se.composite_score, se.meeting_type as current_type
    FROM meetings m
    JOIN session_evaluations se ON se.meeting_id = m.id
    WHERE se.model_used = 'gpt-5.4'
    ORDER BY m.start_time DESC
  `).all();

  console.log(`Scanning ${meetings.length} meetings...\n`);

  const noShows = [];
  const tests = [];
  const reclassified = [];

  for (const meeting of meetings) {
    const classification = classifyMeeting(meeting, meeting.transcript_raw);

    if (classification.type === 'no-show') {
      noShows.push({
        id: meeting.id,
        topic: meeting.topic,
        client_name: meeting.client_name,
        duration: meeting.duration_minutes,
        composite: meeting.composite_score,
        confidence: classification.confidence,
        reason: classification.reason
      });

      // Update the meeting_type if not already set
      if (meeting.current_type !== 'no-show') {
        db.prepare(`
          UPDATE session_evaluations
          SET meeting_type = 'no-show'
          WHERE meeting_id = ? AND model_used = 'gpt-5.4'
        `).run(meeting.id);
        reclassified.push({ id: meeting.id, topic: meeting.topic, from: meeting.current_type, to: 'no-show' });
      }
    } else if (classification.type === 'test') {
      tests.push({
        id: meeting.id,
        topic: meeting.topic,
        client_name: meeting.client_name,
        duration: meeting.duration_minutes,
        composite: meeting.composite_score,
        reason: classification.reason
      });

      if (meeting.current_type !== 'test') {
        db.prepare(`
          UPDATE session_evaluations
          SET meeting_type = 'test'
          WHERE meeting_id = ? AND model_used = 'gpt-5.4'
        `).run(meeting.id);
        reclassified.push({ id: meeting.id, topic: meeting.topic, from: meeting.current_type, to: 'test' });
      }
    }
  }

  // Report findings
  console.log('=== NO-SHOWS DETECTED ===');
  if (noShows.length === 0) {
    console.log('None found.\n');
  } else {
    noShows.forEach(m => {
      console.log(`  [${m.id}] ${m.topic}`);
      console.log(`      Client: ${m.client_name} | Duration: ${m.duration} min | Composite: ${m.composite?.toFixed(2)}`);
      console.log(`      Confidence: ${m.confidence} | Reason: ${m.reason}`);
      console.log();
    });
  }

  console.log('=== TEST RECORDINGS DETECTED ===');
  if (tests.length === 0) {
    console.log('None found.\n');
  } else {
    tests.forEach(m => {
      console.log(`  [${m.id}] ${m.topic}`);
      console.log(`      Duration: ${m.duration} min | Reason: ${m.reason}`);
      console.log();
    });
  }

  console.log('=== RECLASSIFIED MEETINGS ===');
  if (reclassified.length === 0) {
    console.log('No meetings reclassified.\n');
  } else {
    reclassified.forEach(r => {
      console.log(`  [${r.id}] ${r.topic}: ${r.from || 'regular'} → ${r.to}`);
    });
    console.log();
  }

  // Calculate impact on affected clients
  console.log('=== IMPACT ON CLIENT AVERAGES ===');
  const affectedClients = [...new Set(noShows.map(m => m.client_name))];

  for (const clientName of affectedClients) {
    // Get client_id from meetings
    const clientMeeting = db.prepare(`SELECT client_id FROM meetings WHERE client_name = ? LIMIT 1`).get(clientName);
    if (!clientMeeting) continue;

    const clientId = clientMeeting.client_id;

    // Average including no-shows
    const avgWithNoShows = db.prepare(`
      SELECT AVG(se.composite_score) as avg
      FROM session_evaluations se
      JOIN meetings m ON m.id = se.meeting_id
      WHERE m.client_id = ? AND se.model_used = 'gpt-5.4'
    `).get(clientId)?.avg;

    // Average excluding no-shows
    const avgWithoutNoShows = db.prepare(`
      SELECT AVG(se.composite_score) as avg
      FROM session_evaluations se
      JOIN meetings m ON m.id = se.meeting_id
      WHERE m.client_id = ? AND se.model_used = 'gpt-5.4'
        AND COALESCE(se.meeting_type, 'regular') NOT IN ('no-show', 'test')
    `).get(clientId)?.avg;

    const diff = avgWithoutNoShows - avgWithNoShows;
    console.log(`  ${clientName}:`);
    console.log(`    With no-shows:    ${avgWithNoShows?.toFixed(2) || 'N/A'}`);
    console.log(`    Without no-shows: ${avgWithoutNoShows?.toFixed(2) || 'N/A'}`);
    console.log(`    Impact: ${diff > 0 ? '+' : ''}${diff?.toFixed(2) || 'N/A'}`);
    console.log();
  }

  // Summary
  console.log('=== SUMMARY ===');
  console.log(`Total meetings scanned: ${meetings.length}`);
  console.log(`No-shows detected: ${noShows.length}`);
  console.log(`Test recordings detected: ${tests.length}`);
  console.log(`Meetings reclassified: ${reclassified.length}`);

  db.close();
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
