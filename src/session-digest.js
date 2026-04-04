#!/usr/bin/env node
/**
 * Session Intelligence Digest CLI
 *
 * Usage:
 *   node src/session-digest.js                    # Generate current week digest
 *   node src/session-digest.js --week 2026-03-24  # Specific week
 *   node src/session-digest.js --post-slack       # Generate and post to Slack
 *   node src/session-digest.js --coaching 42      # Per-meeting coaching for meeting 42
 *   node src/session-digest.js --alerts           # Show current pattern alerts only
 */

import 'dotenv/config';
import {
  generateWeeklyDigest,
  generateMeetingCoaching,
  detectPatternAlerts,
  formatForSlack,
  formatForMarkdown,
  formatCoachingForSlack
} from './lib/session-digest.js';

// Slack config
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const DIGEST_CHANNEL = process.env.SESSION_DIGEST_CHANNEL || 'C07V3CH2H3Q';

function printUsage() {
  console.log(`
Session Intelligence Digest CLI

Usage:
  node src/session-digest.js                    Generate current week digest
  node src/session-digest.js --week YYYY-MM-DD  Generate digest for specific week
  node src/session-digest.js --post-slack       Generate and post to Slack
  node src/session-digest.js --coaching <id>    Per-meeting coaching card
  node src/session-digest.js --alerts           Show pattern alerts only
  node src/session-digest.js --help             Show this help
`);
}

async function postToSlack(blocks) {
  if (!SLACK_BOT_TOKEN) {
    console.error('Error: SLACK_BOT_TOKEN not configured');
    return false;
  }

  try {
    const { WebClient } = await import('@slack/web-api');
    const slack = new WebClient(SLACK_BOT_TOKEN);

    const result = await slack.chat.postMessage({
      channel: DIGEST_CHANNEL,
      blocks: blocks.blocks,
      text: 'Session Intelligence Weekly Digest'
    });

    console.log(`Posted to Slack channel ${DIGEST_CHANNEL}, ts: ${result.ts}`);
    return true;
  } catch (err) {
    console.error('Slack posting failed:', err.message);
    return false;
  }
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  // Handle --alerts (pattern alerts only)
  if (args.includes('--alerts')) {
    console.log('\n=== Pattern Alerts ===\n');
    const alerts = detectPatternAlerts(4);

    if (alerts.length === 0) {
      console.log('No pattern alerts detected.\n');
    } else {
      for (const alert of alerts) {
        const icon = alert.severity === 'critical' ? '🔴' :
                     alert.severity === 'warning' ? '🟡' : 'ℹ️';
        console.log(`${icon} ${alert.type.replace(/_/g, ' ').toUpperCase()}`);
        console.log(`   ${alert.client_name || alert.topic || ''}`);
        console.log(`   ${alert.detail}\n`);
      }
      console.log(`Total: ${alerts.length} alerts\n`);
    }
    process.exit(0);
  }

  // Handle --coaching <meetingId>
  const coachingIdx = args.indexOf('--coaching');
  if (coachingIdx !== -1) {
    const meetingId = parseInt(args[coachingIdx + 1]);
    if (isNaN(meetingId)) {
      console.error('Error: --coaching requires a valid meeting ID');
      process.exit(1);
    }

    console.log(`\n=== Coaching Card for Meeting ${meetingId} ===\n`);
    const coaching = await generateMeetingCoaching(meetingId);

    if (!coaching) {
      console.error(`Meeting ${meetingId} not found or has no evaluation`);
      process.exit(1);
    }

    const emoji = coaching.threshold === 'green' ? '🟢' : coaching.threshold === 'yellow' ? '🟡' : '🔴';

    console.log(`Topic: ${coaching.meeting.topic}`);
    console.log(`Client: ${coaching.meeting.client_name}`);
    console.log(`Date: ${new Date(coaching.meeting.date).toLocaleDateString()}`);
    console.log(`B3X Lead: ${coaching.meeting.b3x_lead}`);
    console.log(`Score: ${emoji} ${coaching.composite_score.toFixed(2)} (${coaching.threshold})`);
    console.log(`Tier Scores: T1=${coaching.tier_scores.tier1?.toFixed(2)} T2=${coaching.tier_scores.tier2?.toFixed(2)} T3=${coaching.tier_scores.tier3?.toFixed(2)}`);
    console.log('');

    if (coaching.top_wins.length > 0) {
      console.log('WINS:');
      coaching.top_wins.forEach((w, i) => {
        console.log(`  ${i + 1}. ${w.description}`);
        if (w.quote) console.log(`     "${w.quote.slice(0, 80)}..."`);
      });
      console.log('');
    }

    if (coaching.top_improvements.length > 0) {
      console.log('IMPROVEMENTS:');
      coaching.top_improvements.forEach((imp, i) => {
        console.log(`  ${i + 1}. ${imp.description}`);
        if (imp.suggestion) console.log(`     💡 ${imp.suggestion}`);
      });
      console.log('');
    }

    if (coaching.frustration_moments.length > 0) {
      console.log('FRUSTRATION MOMENTS:');
      coaching.frustration_moments.forEach((f, i) => {
        console.log(`  ${i + 1}. ${f.speaker}: ${f.description}`);
        console.log(`     Recovered: ${f.recovered ? 'Yes' : 'No'}`);
      });
      console.log('');
    }

    console.log('COACHING FOCUS:');
    console.log(`  ${coaching.specific_coaching}`);
    console.log('');

    console.log('PREP FOR NEXT:');
    console.log(`  ${coaching.prep_for_next}`);
    console.log('');

    if (args.includes('--post-slack')) {
      const slackBlocks = formatCoachingForSlack(coaching);
      await postToSlack(slackBlocks);
    }

    process.exit(0);
  }

  // Handle weekly digest (default)
  const weekIdx = args.indexOf('--week');
  const weekStart = weekIdx !== -1 ? args[weekIdx + 1] : null;
  const shouldPostSlack = args.includes('--post-slack');

  console.log(`\n=== Weekly Digest ${weekStart ? `(${weekStart})` : '(Current Week)'} ===\n`);

  const digest = await generateWeeklyDigest(weekStart);

  // Print markdown version
  const markdown = formatForMarkdown(digest);
  console.log(markdown);

  // Post to Slack if requested
  if (shouldPostSlack) {
    console.log('\nPosting to Slack...');
    const slackBlocks = formatForSlack(digest);
    const success = await postToSlack(slackBlocks);
    if (!success) {
      process.exit(1);
    }
  }

  // Also show Slack block count for verification
  const slackBlocks = formatForSlack(digest);
  console.log(`\n[Debug] Slack blocks: ${slackBlocks.blocks.length}`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
