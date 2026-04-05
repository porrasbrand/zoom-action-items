#!/usr/bin/env node
/**
 * model-comparison-v2.mjs - Multi-model Session Evaluation Comparison
 * Compares 4 models on the same meetings, then uses AI-as-Judge to score quality
 */

import 'dotenv/config';
import Database from 'better-sqlite3';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync } from 'fs';
import { evaluateMeeting, initDatabase } from '../src/lib/session-evaluator.js';
import { callModel, parseJsonResponse } from '../src/lib/model-providers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'zoom-action-items.db');
const REPORT_PATH = join(__dirname, '..', 'data', 'model-comparison-report.md');

// Models to compare
const MODELS = [
  'gemini-2.0-flash',      // Baseline (already has evaluations)
  'claude-sonnet-4-20250514', // Claude Sonnet 4 (more available than Opus)
  'gpt-4o',                // GPT-4o (widely available)
  'gemini-2.0-flash-exp'   // Gemini 2.0 Flash Experimental
];

// Judge model
const JUDGE_MODEL = 'gemini-2.0-flash';

// Retry config
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function retryWithBackoff(fn, name) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (error) {
      console.error(`  ❌ ${name} attempt ${attempt}/${MAX_RETRIES} failed: ${error.message}`);
      if (attempt < MAX_RETRIES) {
        console.log(`  ⏳ Retrying in ${RETRY_DELAY_MS / 1000}s...`);
        await sleep(RETRY_DELAY_MS);
      }
    }
  }
  return null; // All retries failed
}

/**
 * Select 10 diverse test meetings
 */
function selectTestMeetings(db) {
  console.log('📊 Selecting 10 diverse test meetings...\n');

  const meetings = [];

  // Get evaluated meetings with scores
  const allEvaluated = db.prepare(`
    SELECT m.id, m.topic, m.client_name, e.composite_score, e.meeting_type
    FROM meetings m
    JOIN session_evaluations e ON m.id = e.meeting_id
    WHERE e.model_used = 'gemini-2.0-flash'
    ORDER BY e.composite_score DESC
  `).all();

  // 2 high-scoring (> 3.0)
  const highScoring = allEvaluated.filter(m => m.composite_score > 3.0).slice(0, 2);
  meetings.push(...highScoring);
  console.log(`  ✓ ${highScoring.length} high-scoring meetings (composite > 3.0)`);

  // 2 low-scoring (< 2.0)
  const lowScoring = allEvaluated.filter(m => m.composite_score < 2.0).slice(0, 2);
  meetings.push(...lowScoring);
  console.log(`  ✓ ${lowScoring.length} low-scoring meetings (composite < 2.0)`);

  // 2 internal meetings
  const internal = allEvaluated.filter(m =>
    m.client_name?.toLowerCase().includes('internal') ||
    m.client_name?.toLowerCase().includes('b3x') ||
    m.topic?.toLowerCase().includes('internal')
  ).filter(m => !meetings.find(existing => existing.id === m.id)).slice(0, 2);
  meetings.push(...internal);
  console.log(`  ✓ ${internal.length} internal/team meetings`);

  // 2 kickoff meetings
  const kickoff = allEvaluated.filter(m =>
    m.meeting_type === 'kickoff' ||
    m.topic?.toLowerCase().includes('kickoff') ||
    m.topic?.toLowerCase().includes('onboard')
  ).filter(m => !meetings.find(existing => existing.id === m.id)).slice(0, 2);
  meetings.push(...kickoff);
  console.log(`  ✓ ${kickoff.length} kickoff/new client meetings`);

  // Fill remaining with regular meetings
  const remaining = 10 - meetings.length;
  const regular = allEvaluated
    .filter(m => !meetings.find(existing => existing.id === m.id))
    .slice(0, remaining);
  meetings.push(...regular);
  console.log(`  ✓ ${regular.length} regular meetings`);

  console.log(`\n📋 Selected ${meetings.length} meetings for comparison:\n`);
  meetings.forEach((m, i) => {
    console.log(`  ${i + 1}. [${m.id}] ${m.topic?.slice(0, 50)} (${m.composite_score?.toFixed(2)})`);
  });

  return meetings;
}

/**
 * Run evaluation for a meeting with a specific model
 */
async function runEvaluation(meetingId, modelId, db) {
  // Check if already evaluated
  const existing = db.prepare(`
    SELECT * FROM session_evaluations WHERE meeting_id = ? AND model_used = ?
  `).get(meetingId, modelId);

  if (existing) {
    console.log(`    ⏭️  ${modelId}: Using existing evaluation`);
    return {
      composite: existing.composite_score,
      tier1: existing.tier1_avg,
      tier2: existing.tier2_avg,
      tier3: existing.tier3_avg,
      tokensIn: existing.tokens_in,
      tokensOut: existing.tokens_out,
      latencyMs: existing.latency_ms,
      cached: true
    };
  }

  const result = await retryWithBackoff(async () => {
    const startTime = Date.now();
    await evaluateMeeting(meetingId, { model: modelId, db });
    const latencyMs = Date.now() - startTime;

    // Fetch the stored evaluation
    const eval_ = db.prepare(`
      SELECT * FROM session_evaluations WHERE meeting_id = ? AND model_used = ?
    `).get(meetingId, modelId);

    return {
      composite: eval_.composite_score,
      tier1: eval_.tier1_avg,
      tier2: eval_.tier2_avg,
      tier3: eval_.tier3_avg,
      tokensIn: eval_.tokens_in,
      tokensOut: eval_.tokens_out,
      latencyMs: latencyMs,
      cached: false
    };
  }, `${modelId} eval for meeting ${meetingId}`);

  if (result) {
    console.log(`    ✅ ${modelId}: ${result.composite?.toFixed(2)} (${result.latencyMs}ms)`);
  } else {
    console.log(`    ❌ ${modelId}: FAILED after ${MAX_RETRIES} attempts`);
  }

  return result;
}

/**
 * Judge evaluations for a single meeting
 */
async function judgeEvaluations(meetingId, evaluations, db) {
  // Get meeting info
  const meeting = db.prepare('SELECT topic, client_name FROM meetings WHERE id = ?').get(meetingId);

  // Get full evaluation details for each model
  const modelEvals = {};
  for (const [modelId, result] of Object.entries(evaluations)) {
    if (!result) continue;
    const eval_ = db.prepare(`
      SELECT * FROM session_evaluations WHERE meeting_id = ? AND model_used = ?
    `).get(meetingId, modelId);
    modelEvals[modelId] = eval_;
  }

  // Build judge prompt
  const modelLabels = ['A', 'B', 'C', 'D'];
  const modelMapping = {};
  let evalDescriptions = '';

  Object.keys(modelEvals).forEach((modelId, i) => {
    const label = modelLabels[i];
    modelMapping[label] = modelId;
    const eval_ = modelEvals[modelId];

    evalDescriptions += `
## Model ${label}
- Composite Score: ${eval_.composite_score?.toFixed(2)}
- Tier 1 (Deal Breakers): ${eval_.tier1_avg?.toFixed(2)}
- Tier 2 (Core): ${eval_.tier2_avg?.toFixed(2)}
- Tier 3 (Efficiency): ${eval_.tier3_avg?.toFixed(2)}
- Meeting Type: ${eval_.meeting_type || 'unknown'}
- Wins: ${eval_.wins || 'N/A'}
- Improvements: ${eval_.improvements || 'N/A'}
- Coaching Notes: ${eval_.coaching_notes?.slice(0, 300) || 'N/A'}...
`;
  });

  const judgePrompt = `You are an expert evaluator comparing AI-generated meeting quality assessments.

Meeting: "${meeting.topic}" (Client: ${meeting.client_name})

Below are ${Object.keys(modelEvals).length} evaluations of the SAME meeting from different AI models (anonymized as Model A, B, C, D).
${evalDescriptions}

Score each model on these 5 criteria (1-5 scale, 5 = best):
1. **Score Accuracy** - Do the scores seem to match what you'd expect from the meeting context?
2. **Evidence Quality** - Are the coaching insights specific and evidence-based?
3. **Coaching Value** - Are the suggestions actionable and helpful?
4. **Nuance** - Does it show understanding of context (internal vs client, kickoff vs regular)?
5. **Consistency** - Are scores logically coherent across dimensions?

Return JSON:
{
  "scores": {
    "A": { "accuracy": N, "evidence": N, "coaching": N, "nuance": N, "consistency": N, "total": N },
    "B": { "accuracy": N, "evidence": N, "coaching": N, "nuance": N, "consistency": N, "total": N },
    ...
  },
  "winner": "A|B|C|D",
  "reasoning": "Brief explanation of why winner was chosen"
}`;

  const result = await retryWithBackoff(async () => {
    const { text } = await callModel(JUDGE_MODEL, judgePrompt, { temperature: 0.2 });
    return parseJsonResponse(text);
  }, `Judge for meeting ${meetingId}`);

  if (result) {
    // Map back from labels to model IDs
    const mappedScores = {};
    for (const [label, scores] of Object.entries(result.scores || {})) {
      if (modelMapping[label]) {
        mappedScores[modelMapping[label]] = scores;
      }
    }
    result.scores = mappedScores;
    result.winner = modelMapping[result.winner] || result.winner;
  }

  return result;
}

/**
 * Generate markdown report
 */
function generateReport(meetings, evaluations, judgments, startTime) {
  const endTime = Date.now();
  const durationMin = ((endTime - startTime) / 60000).toFixed(1);

  // Aggregate stats per model
  const modelStats = {};
  for (const modelId of MODELS) {
    modelStats[modelId] = {
      wins: 0,
      totalJudgeScore: 0,
      judgeCount: 0,
      composites: [],
      latencies: [],
      tokensIn: [],
      tokensOut: [],
      criteria: { accuracy: [], evidence: [], coaching: [], nuance: [], consistency: [] }
    };
  }

  // Collect stats
  for (const meetingId of Object.keys(evaluations)) {
    const meetingEvals = evaluations[meetingId];
    const judgment = judgments[meetingId];

    for (const [modelId, result] of Object.entries(meetingEvals)) {
      if (!result) continue;
      modelStats[modelId].composites.push(result.composite || 0);
      modelStats[modelId].latencies.push(result.latencyMs || 0);
      modelStats[modelId].tokensIn.push(result.tokensIn || 0);
      modelStats[modelId].tokensOut.push(result.tokensOut || 0);
    }

    if (judgment) {
      for (const [modelId, scores] of Object.entries(judgment.scores || {})) {
        if (modelStats[modelId]) {
          modelStats[modelId].totalJudgeScore += scores.total || 0;
          modelStats[modelId].judgeCount++;
          for (const criterion of Object.keys(modelStats[modelId].criteria)) {
            if (scores[criterion]) {
              modelStats[modelId].criteria[criterion].push(scores[criterion]);
            }
          }
        }
      }
      if (judgment.winner && modelStats[judgment.winner]) {
        modelStats[judgment.winner].wins++;
      }
    }
  }

  // Calculate averages
  const rankings = MODELS.map(modelId => {
    const stats = modelStats[modelId];
    const avgJudge = stats.judgeCount > 0 ? stats.totalJudgeScore / stats.judgeCount : 0;
    const avgComposite = stats.composites.length > 0
      ? stats.composites.reduce((a, b) => a + b, 0) / stats.composites.length : 0;
    const avgLatency = stats.latencies.length > 0
      ? stats.latencies.reduce((a, b) => a + b, 0) / stats.latencies.length : 0;
    const avgTokensIn = stats.tokensIn.length > 0
      ? stats.tokensIn.reduce((a, b) => a + b, 0) / stats.tokensIn.length : 0;
    const avgTokensOut = stats.tokensOut.length > 0
      ? stats.tokensOut.reduce((a, b) => a + b, 0) / stats.tokensOut.length : 0;

    return {
      modelId,
      avgJudge: avgJudge.toFixed(1),
      wins: stats.wins,
      avgComposite: avgComposite.toFixed(2),
      avgLatency: (avgLatency / 1000).toFixed(1),
      avgTokensIn: Math.round(avgTokensIn),
      avgTokensOut: Math.round(avgTokensOut),
      criteria: {}
    };
  }).sort((a, b) => parseFloat(b.avgJudge) - parseFloat(a.avgJudge));

  // Build report
  let report = `# Model Comparison Report — Session Intelligence Evaluation
Date: ${new Date().toISOString().split('T')[0]}
Test Set: ${meetings.length} meetings | Judge: ${JUDGE_MODEL}
Duration: ${durationMin} minutes

## Overall Rankings
| Rank | Model | Avg Judge Score | Wins | Avg Composite | Avg Latency |
|------|-------|-----------------|------|---------------|-------------|
`;

  rankings.forEach((r, i) => {
    report += `| ${i + 1} | ${r.modelId} | ${r.avgJudge}/25 | ${r.wins}/${meetings.length} | ${r.avgComposite} | ${r.avgLatency}s |\n`;
  });

  // Per-meeting results
  report += `\n## Head-to-Head: Per-Meeting Results
| Meeting | Topic | ${MODELS.map(m => m.split('-')[0]).join(' | ')} | Winner |
|---------|-------|${MODELS.map(() => '------').join('|')}|--------|
`;

  for (const meeting of meetings) {
    const meetingEvals = evaluations[meeting.id] || {};
    const judgment = judgments[meeting.id];
    const scores = MODELS.map(m => meetingEvals[m]?.composite?.toFixed(2) || '—').join(' | ');
    const winner = judgment?.winner?.split('-')[0] || '—';
    report += `| ${meeting.id} | ${meeting.topic?.slice(0, 30)}... | ${scores} | ${winner} |\n`;
  }

  // Per-criteria breakdown
  report += `\n## Per-Criteria Average (Judge Scores)
| Criterion | ${MODELS.map(m => m.split('-')[0]).join(' | ')} |
|-----------|${MODELS.map(() => '------').join('|')}|
`;

  for (const criterion of ['accuracy', 'evidence', 'coaching', 'nuance', 'consistency']) {
    const scores = MODELS.map(modelId => {
      const vals = modelStats[modelId].criteria[criterion];
      return vals.length > 0 ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1) : '—';
    }).join(' | ');
    report += `| ${criterion} | ${scores} |\n`;
  }

  // Token usage
  report += `\n## Token Usage & Latency
| Model | Avg Tokens In | Avg Tokens Out | Avg Latency |
|-------|---------------|----------------|-------------|
`;

  for (const r of rankings) {
    report += `| ${r.modelId} | ${r.avgTokensIn} | ${r.avgTokensOut} | ${r.avgLatency}s |\n`;
  }

  // Recommendation
  const winner = rankings[0];
  report += `\n## Recommendation
**${winner.modelId}** ranks highest with an average judge score of ${winner.avgJudge}/25 and ${winner.wins}/${meetings.length} wins.

${winner.modelId === 'gemini-2.0-flash'
    ? 'The current default model remains the best choice.'
    : `Consider switching from gemini-2.0-flash to **${winner.modelId}** for improved evaluation quality.`}
`;

  return report;
}

/**
 * Main comparison flow
 */
async function main() {
  console.log('🔬 Multi-Model Session Evaluation Comparison\n');
  console.log('Models:', MODELS.join(', '));
  console.log('Judge:', JUDGE_MODEL);
  console.log('');

  const startTime = Date.now();
  const db = initDatabase(DB_PATH);

  // Step 1: Select test meetings
  const meetings = selectTestMeetings(db);

  // Step 2: Run evaluations
  console.log('\n📝 Running evaluations...\n');
  const evaluations = {}; // { meetingId: { modelId: result } }

  for (const meeting of meetings) {
    console.log(`\n  Meeting ${meeting.id}: ${meeting.topic?.slice(0, 40)}...`);
    evaluations[meeting.id] = {};

    for (const modelId of MODELS) {
      const result = await runEvaluation(meeting.id, modelId, db);
      evaluations[meeting.id][modelId] = result;
      await sleep(1000); // Rate limit between models
    }
  }

  // Step 3: Judge evaluations
  console.log('\n\n⚖️ Running AI-as-Judge comparisons...\n');
  const judgments = {}; // { meetingId: judgeResult }

  for (const meeting of meetings) {
    console.log(`  Judging meeting ${meeting.id}...`);
    const judgment = await judgeEvaluations(meeting.id, evaluations[meeting.id], db);
    judgments[meeting.id] = judgment;
    if (judgment) {
      console.log(`    Winner: ${judgment.winner || 'tie'}`);
    }
    await sleep(1000);
  }

  // Step 4: Generate report
  console.log('\n📄 Generating report...\n');
  const report = generateReport(meetings, evaluations, judgments, startTime);
  writeFileSync(REPORT_PATH, report);
  console.log(`Report saved to: ${REPORT_PATH}\n`);

  // Print summary
  console.log('=' .repeat(60));
  console.log(report);

  db.close();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
