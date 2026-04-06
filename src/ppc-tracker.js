#!/usr/bin/env node
/**
 * PPC Task Accountability Tracker — CLI
 *
 * Usage:
 *   node src/ppc-tracker.js --meeting 86           # Track one meeting
 *   node src/ppc-tracker.js --backfill             # Backfill all meetings
 *   node src/ppc-tracker.js --report --agency      # Agency-wide report
 *   node src/ppc-tracker.js --report --client gs-home-services
 */

import 'dotenv/config';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));

import {
  trackPPCTasks,
  backfillPPCTracking,
  getPPCReport,
  initPPCTrackingTable
} from './lib/ppc-task-tracker.js';

// Parse CLI args
const args = process.argv.slice(2);
const flags = {
  meeting: args.includes('--meeting') ? args[args.indexOf('--meeting') + 1] : null,
  backfill: args.includes('--backfill'),
  report: args.includes('--report'),
  agency: args.includes('--agency'),
  client: args.includes('--client') ? args[args.indexOf('--client') + 1] : null,
  days: args.includes('--days') ? parseInt(args[args.indexOf('--days') + 1]) : 30
};

// Open database
const dbPath = join(__dirname, '..', 'data', 'zoom-action-items.db');
const db = new Database(dbPath);

async function runMeetingTracking(meetingId) {
  console.log(`\n🎯 PPC Task Tracker — Meeting ${meetingId}\n`);

  const result = await trackPPCTasks(parseInt(meetingId), db);

  console.log(`PPC Tasks Found: ${result.ppc_tasks}`);
  console.log(`In ProofHub: ${result.tracked}`);
  console.log(`Missing: ${result.missing}`);
  console.log(`Avg Score: ${result.avg_score}%\n`);

  if (result.tasks.length > 0) {
    console.log('Tasks:');
    for (const task of result.tasks) {
      const status = task.proofhub_match ? '✅' : '❌';
      console.log(`  ${status} "${task.task_title}"`);
      console.log(`     Platform: ${task.platform || 'unknown'} | Owner: ${task.owner || 'unassigned'}`);
      if (task.proofhub_match) {
        console.log(`     ProofHub: "${task.proofhub_task_title}" (${task.proofhub_status})`);
        console.log(`     Days to PH: ${task.days_to_proofhub} | Score: ${task.completion_score}%`);
      }
      console.log('');
    }
  }
}

async function runBackfill() {
  console.log(`\n🔄 PPC Task Tracker — Backfill\n`);

  const result = await backfillPPCTracking(db);

  console.log(`\n========== BACKFILL COMPLETE ==========\n`);
  console.log(`Meetings Processed: ${result.processed}/${result.total_meetings}`);
  console.log(`PPC Tasks Found: ${result.ppc_tasks_found}`);
  console.log(`Tracked in ProofHub: ${result.tracked_in_proofhub}`);
  console.log(`Errors: ${result.errors}`);

  console.log(`\nBy Client:`);
  for (const [clientId, data] of Object.entries(result.by_client)) {
    if (data.ppc_tasks > 0) {
      const rate = data.ppc_tasks > 0 ? Math.round((data.tracked / data.ppc_tasks) * 100) : 0;
      console.log(`  ${data.client_name}: ${data.ppc_tasks} tasks, ${data.tracked} tracked (${rate}%)`);
    }
  }
}

function runReport(clientId = null, days = 30) {
  console.log(`\n📊 PPC Task Accountability Report\n`);
  console.log(`Period: Last ${days} days${clientId ? ` | Client: ${clientId}` : ' | Agency-wide'}\n`);

  const report = getPPCReport(db, { clientId, days });

  console.log(`========================================`);
  console.log(`Total PPC Tasks: ${report.total_ppc_tasks}`);
  console.log(`In ProofHub: ${report.in_proofhub} (${report.completion_rate}%)`);
  console.log(`Missing: ${report.missing} (${100 - report.completion_rate}%)`);
  console.log(`Avg Score: ${report.avg_score}%`);
  if (report.avg_days_to_proofhub) {
    console.log(`Avg Days to ProofHub: ${report.avg_days_to_proofhub}`);
  }
  console.log(`========================================\n`);

  // Drop-off funnel visualization
  const trackedPct = report.completion_rate;
  const trackedBars = Math.round(trackedPct / 5);
  const missingBars = 20 - trackedBars;
  console.log(`Drop-off Funnel:`);
  console.log(`${'█'.repeat(trackedBars)}${'░'.repeat(missingBars)} ${trackedPct}% tracked in ProofHub\n`);

  // Per-client breakdown
  console.log(`By Client:`);
  console.log(`─────────────────────────────────────────────────────`);

  const clients = Object.entries(report.by_client)
    .sort((a, b) => b[1].total - a[1].total);

  for (const [cid, data] of clients) {
    const status = data.completion_rate >= 80 ? '✅' : data.completion_rate >= 50 ? '⚠️' : '❌';
    console.log(`${status} ${data.client_name}`);
    console.log(`   Tasks: ${data.total} | In PH: ${data.tracked} (${data.completion_rate}%) | Missing: ${data.missing}`);
  }

  // At-risk tasks
  if (report.at_risk.length > 0) {
    console.log(`\n❌ MISSING FROM PROOFHUB (${report.at_risk.length} tasks):`);
    console.log(`─────────────────────────────────────────────────────`);

    for (const task of report.at_risk.slice(0, 15)) {
      const date = task.meeting_date?.split('T')[0] || 'unknown';
      const daysAgo = Math.floor((Date.now() - new Date(task.meeting_date).getTime()) / (1000 * 60 * 60 * 24));
      console.log(`• "${task.task_title}"`);
      console.log(`  ${task.client_name} | ${date} (${daysAgo}d ago) | Owner: ${task.owner || 'unassigned'}`);
    }

    if (report.at_risk.length > 15) {
      console.log(`\n  ... and ${report.at_risk.length - 15} more`);
    }
  }

  console.log(`\n========================================\n`);
}

async function main() {
  try {
    // Ensure table exists
    initPPCTrackingTable(db);

    if (flags.meeting) {
      await runMeetingTracking(flags.meeting);
    } else if (flags.backfill) {
      await runBackfill();
    } else if (flags.report) {
      runReport(flags.client, flags.days);
    } else {
      console.log(`
PPC Task Accountability Tracker

Usage:
  node src/ppc-tracker.js --meeting <id>           Track one meeting
  node src/ppc-tracker.js --backfill               Backfill all meetings
  node src/ppc-tracker.js --report --agency        Agency-wide report
  node src/ppc-tracker.js --report --client <id>   Client report
  node src/ppc-tracker.js --report --days 60       Custom period

Options:
  --days <n>    Report period (default: 30)
`);
    }
  } catch (err) {
    console.error('Error:', err.message);
    process.exit(1);
  } finally {
    db.close();
  }
}

main();
