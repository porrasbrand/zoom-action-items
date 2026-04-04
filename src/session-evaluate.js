#!/usr/bin/env node
import 'dotenv/config';
/**
 * Session Evaluate CLI
 * Usage:
 *   node src/session-evaluate.js --meeting 42                    # Evaluate single meeting
 *   node src/session-evaluate.js --meeting 42 --model gemini-3-pro-preview  # Use specific model
 *   node src/session-evaluate.js --backfill                      # Evaluate all meetings
 *   node src/session-evaluate.js --backfill --model gemini-2.0-flash  # Backfill with specific model
 *   node src/session-evaluate.js --stats                         # Print statistics
 */

import { initDatabase, evaluateMeeting, backfillAll, getEvalStats, DEFAULT_MODEL } from './lib/session-evaluator.js';

function printUsage() {
  console.log(`
Session Evaluate CLI

Usage:
  node src/session-evaluate.js --meeting <id>           Evaluate single meeting
  node src/session-evaluate.js --meeting <id> --model <model>  Use specific model
  node src/session-evaluate.js --backfill               Evaluate all meetings
  node src/session-evaluate.js --backfill --model <model>  Backfill with specific model
  node src/session-evaluate.js --stats                  Print statistics
  node src/session-evaluate.js --help                   Show this help

Default model: ${DEFAULT_MODEL}
`);
}

function printStats(db) {
  const stats = getEvalStats(db);

  console.log('\n=== Session Evaluation Statistics ===');
  console.log(`Meetings evaluated: ${stats.total}`);
  console.log(`Avg composite score: ${stats.avg_composite?.toFixed(2) || 'N/A'}`);
  console.log(`  - Tier 1 (Deal Breakers): ${stats.avg_tier1?.toFixed(2) || 'N/A'}`);
  console.log(`  - Tier 2 (Core Competence): ${stats.avg_tier2?.toFixed(2) || 'N/A'}`);
  console.log(`  - Tier 3 (Efficiency): ${stats.avg_tier3?.toFixed(2) || 'N/A'}`);
  console.log('\nScore distribution:');
  console.log(`  - Excellent (3.5+): ${stats.excellent || 0}`);
  console.log(`  - Good (2.5-3.5): ${stats.good || 0}`);
  console.log(`  - Needs Improvement (1.5-2.5): ${stats.needs_improvement || 0}`);
  console.log(`  - Failing (<1.5): ${stats.failing || 0}`);
  console.log('');
}

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  // Parse model option
  const modelIdx = args.indexOf('--model');
  const modelId = modelIdx !== -1 ? args[modelIdx + 1] : DEFAULT_MODEL;

  if (args.includes('--stats')) {
    const db = initDatabase();
    printStats(db);
    db.close();
    return;
  }

  if (args.includes('--backfill')) {
    console.log(`[SessionEval] Starting backfill with model: ${modelId}`);
    const force = args.includes('--force');
    const result = await backfillAll({ model: modelId, force });
    console.log(`\nBackfill complete: ${result.processed}/${result.total} meetings`);
    if (result.errors > 0) {
      console.log(`Errors: ${result.errors}`);
    }

    const db = initDatabase();
    printStats(db);
    db.close();
    return;
  }

  if (args.includes('--meeting')) {
    const idx = args.indexOf('--meeting');
    const meetingId = parseInt(args[idx + 1]);
    if (isNaN(meetingId)) {
      console.error('Error: --meeting requires a valid meeting ID');
      process.exit(1);
    }

    console.log(`[SessionEval] Evaluating meeting ${meetingId} with model: ${modelId}`);
    try {
      const result = await evaluateMeeting(meetingId, { model: modelId });
      console.log('\n=== Evaluation Result ===');
      console.log(`Meeting ID: ${result.meeting_id}`);
      console.log(`Model: ${result.model_used}`);
      console.log(`Meeting Type: ${result.meeting_type}`);
      console.log(`\nScores (1-4 scale):`);
      console.log(`  Tier 1 (Deal Breakers):`);
      console.log(`    - Client Sentiment: ${result.scores.client_sentiment}`);
      console.log(`    - Accountability: ${result.scores.accountability}`);
      console.log(`    - Relationship Health: ${result.scores.relationship_health}`);
      console.log(`  Tier 2 (Core Competence):`);
      console.log(`    - Meeting Structure: ${result.scores.meeting_structure}`);
      console.log(`    - Value Delivery: ${result.scores.value_delivery}`);
      console.log(`    - Action Discipline: ${result.scores.action_discipline}`);
      console.log(`    - Proactive Leadership: ${result.scores.proactive_leadership}`);
      console.log(`  Tier 3 (Efficiency):`);
      console.log(`    - Time Utilization: ${result.scores.time_utilization}`);
      console.log(`    - Redundancy: ${result.scores.redundancy}`);
      console.log(`    - Client Confusion: ${result.scores.client_confusion}`);
      console.log(`    - Meeting Momentum: ${result.scores.meeting_momentum}`);
      console.log(`    - Save Rate: ${result.scores.save_rate}`);
      console.log(`\nComposite Scores:`);
      console.log(`  - Tier 1 Avg: ${result.tier1_avg.toFixed(2)}`);
      console.log(`  - Tier 2 Avg: ${result.tier2_avg.toFixed(2)}`);
      console.log(`  - Tier 3 Avg: ${result.tier3_avg.toFixed(2)}`);
      console.log(`  - Overall Composite: ${result.composite_score.toFixed(2)}`);
      console.log(`\nCoaching Notes:`);
      console.log(`  ${result.coaching_notes}`);
      console.log(`\nWins:`);
      (result.wins || []).forEach((w, i) => {
        console.log(`  ${i + 1}. ${w.description} (${w.dimension})`);
        console.log(`     "${w.transcript_quote?.slice(0, 100)}..."`);
      });
      console.log(`\nImprovements:`);
      (result.improvements || []).forEach((imp, i) => {
        console.log(`  ${i + 1}. ${imp.description} (${imp.dimension})`);
        console.log(`     Suggestion: ${imp.suggestion}`);
      });
      console.log(`\nPerformance: ${result.tokens_in} tokens in, ${result.tokens_out} tokens out, ${result.latency_ms}ms`);
    } catch (err) {
      console.error('Error:', err.message);
      process.exit(1);
    }
    return;
  }

  console.error('Unknown command. Use --help for usage.');
  process.exit(1);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
