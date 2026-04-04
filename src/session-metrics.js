#!/usr/bin/env node
/**
 * Session Metrics CLI
 * Usage:
 *   node src/session-metrics.js --backfill          # Process all meetings
 *   node src/session-metrics.js --meeting 42        # Process single meeting
 *   node src/session-metrics.js --stats             # Print aggregate stats
 */

import { initDatabase, computeAllMetrics, backfillAll, getStats, getMetrics } from './lib/session-metrics.js';

function printUsage() {
  console.log(`
Session Metrics CLI

Usage:
  node src/session-metrics.js --backfill          Process all meetings
  node src/session-metrics.js --meeting <id>      Process single meeting
  node src/session-metrics.js --stats             Print aggregate stats
  node src/session-metrics.js --help              Show this help
`);
}

function printStats(db) {
  const stats = getStats(db);

  console.log('\n=== Session Metrics Summary ===');
  console.log(`Meetings processed: ${stats.total_meetings}`);
  console.log(`Avg action items/meeting: ${stats.avg_action_items?.toFixed(1) || 0}`);
  console.log(`Avg action density (items/min): ${stats.avg_action_density?.toFixed(3) || 0}`);
  console.log(`Avg due date rate: ${stats.avg_due_date_rate?.toFixed(0) || 0}%`);
  console.log(`Avg owner assignment rate: ${stats.avg_owner_assignment_rate?.toFixed(0) || 0}%`);
  console.log(`Avg B3X speaking ratio: ${stats.avg_b3x_speaking_ratio?.toFixed(0) || 0}%`);
  console.log(`Meetings with stale B3X items: ${stats.meetings_with_stale_b3x || 0}`);
  console.log(`Meeting types: regular=${stats.type_regular || 0}, internal=${stats.type_internal || 0}, kickoff=${stats.type_kickoff || 0}, vip-session=${stats.type_vip || 0}`);
  console.log('');
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  // Initialize database (creates table if needed)
  const db = initDatabase();

  if (args.includes('--backfill')) {
    console.log('[SessionMetrics] Starting backfill...');
    const result = backfillAll(db);
    console.log(`\nBackfill complete: ${result.processed}/${result.total} meetings processed`);
    if (result.errors > 0) {
      console.log(`Errors: ${result.errors}`);
    }
    printStats(db);
  } else if (args.includes('--meeting')) {
    const idx = args.indexOf('--meeting');
    const meetingId = parseInt(args[idx + 1]);
    if (isNaN(meetingId)) {
      console.error('Error: --meeting requires a valid meeting ID');
      process.exit(1);
    }

    console.log(`[SessionMetrics] Processing meeting ${meetingId}...`);
    const metrics = computeAllMetrics(db, meetingId);
    if (metrics) {
      console.log('Metrics computed:');
      console.log(JSON.stringify(metrics, null, 2));
    } else {
      console.error(`Meeting ${meetingId} not found`);
      process.exit(1);
    }
  } else if (args.includes('--stats')) {
    printStats(db);
  } else {
    console.error('Unknown command. Use --help for usage.');
    process.exit(1);
  }

  db.close();
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
