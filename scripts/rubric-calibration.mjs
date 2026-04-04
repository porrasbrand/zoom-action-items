#!/usr/bin/env node
import 'dotenv/config';
/**
 * Rubric Calibration Script
 * Validates evaluation quality through 4 test suites:
 * 1. Scoring consistency (5 meetings x 3 runs)
 * 2. Score distribution analysis
 * 3. Cross-dimension correlation
 * 4. Bias check
 */

import Database from 'better-sqlite3';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { initDatabase, DEFAULT_MODEL } from '../src/lib/session-evaluator.js';
import { getMetrics } from '../src/lib/session-metrics.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const DB_PATH = join(DATA_DIR, 'zoom-action-items.db');

// Dimensions by tier
const TIER1_DIMS = ['client_sentiment', 'accountability', 'relationship_health'];
const TIER2_DIMS = ['meeting_structure', 'value_delivery', 'action_discipline', 'proactive_leadership'];
const TIER3_DIMS = ['time_utilization', 'redundancy', 'client_confusion', 'meeting_momentum', 'save_rate'];
const ALL_DIMS = [...TIER1_DIMS, ...TIER2_DIMS, ...TIER3_DIMS];

// Test configuration
const CONSISTENCY_RUNS = 3;
const CONSISTENCY_MEETINGS = 5;
const VARIANCE_THRESHOLD = 0.5;
const MODE_THRESHOLD = 0.80; // >80% same score = poor discrimination
const CORRELATION_THRESHOLD = 0.9;
const BIAS_THRESHOLD = 0.5;

/**
 * Select 5 diverse test meetings (same logic as comparison script)
 */
function selectTestMeetings(db) {
  const meetings = [];

  // Shortest meeting with content
  const shortest = db.prepare('SELECT id, topic, duration_minutes FROM meetings WHERE duration_minutes > 5 ORDER BY duration_minutes ASC LIMIT 1').get();
  if (shortest) meetings.push({ ...shortest, reason: 'shortest' });

  // Longest meeting
  const longest = db.prepare('SELECT id, topic, duration_minutes FROM meetings ORDER BY duration_minutes DESC LIMIT 1').get();
  if (longest && !meetings.find(m => m.id === longest.id)) meetings.push({ ...longest, reason: 'longest' });

  // Most action items
  const mostItems = db.prepare(`
    SELECT m.id, m.topic, m.duration_minutes, COUNT(ai.id) as item_count
    FROM meetings m
    JOIN action_items ai ON ai.meeting_id = m.id
    GROUP BY m.id
    ORDER BY COUNT(ai.id) DESC LIMIT 1
  `).get();
  if (mostItems && !meetings.find(m => m.id === mostItems.id)) meetings.push({ ...mostItems, reason: 'most_items' });

  // Fewest action items (but decent duration)
  const fewestItems = db.prepare(`
    SELECT m.id, m.topic, m.duration_minutes, COALESCE(cnt.c, 0) as item_count
    FROM meetings m
    LEFT JOIN (SELECT meeting_id, COUNT(*) as c FROM action_items GROUP BY meeting_id) cnt ON cnt.meeting_id = m.id
    WHERE m.duration_minutes > 15
    ORDER BY COALESCE(cnt.c, 0) ASC LIMIT 1
  `).get();
  if (fewestItems && !meetings.find(m => m.id === fewestItems.id)) meetings.push({ ...fewestItems, reason: 'fewest_items' });

  // Internal meeting
  const internal = db.prepare(`
    SELECT id, topic, duration_minutes FROM meetings
    WHERE client_name LIKE '%B3X%' OR client_name LIKE '%Internal%' OR topic LIKE '%Internal%' OR topic LIKE '%Huddle%'
    LIMIT 1
  `).get();
  if (internal && !meetings.find(m => m.id === internal.id)) meetings.push({ ...internal, reason: 'internal' });

  // Fill up to 5 with random meetings if needed
  while (meetings.length < CONSISTENCY_MEETINGS) {
    const existing = meetings.map(m => m.id);
    const random = db.prepare(`
      SELECT id, topic, duration_minutes FROM meetings
      WHERE id NOT IN (${existing.join(',') || 0})
      ORDER BY RANDOM() LIMIT 1
    `).get();
    if (random) meetings.push({ ...random, reason: 'random' });
    else break;
  }

  return meetings;
}

/**
 * Calculate variance for an array of numbers
 */
function variance(arr) {
  if (arr.length < 2) return 0;
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  return arr.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / arr.length;
}

/**
 * Calculate standard deviation
 */
function stddev(arr) {
  return Math.sqrt(variance(arr));
}

/**
 * Calculate Pearson correlation coefficient
 */
function correlation(arr1, arr2) {
  if (arr1.length !== arr2.length || arr1.length < 2) return 0;
  const n = arr1.length;
  const mean1 = arr1.reduce((a, b) => a + b, 0) / n;
  const mean2 = arr2.reduce((a, b) => a + b, 0) / n;

  let num = 0, den1 = 0, den2 = 0;
  for (let i = 0; i < n; i++) {
    const d1 = arr1[i] - mean1;
    const d2 = arr2[i] - mean2;
    num += d1 * d2;
    den1 += d1 * d1;
    den2 += d2 * d2;
  }

  const den = Math.sqrt(den1 * den2);
  return den === 0 ? 0 : num / den;
}

/**
 * Calculate mode and its percentage
 */
function modeWithPct(arr) {
  const counts = {};
  arr.forEach(v => { counts[v] = (counts[v] || 0) + 1; });
  let mode = arr[0], maxCount = 0;
  for (const [val, count] of Object.entries(counts)) {
    if (count > maxCount) {
      maxCount = count;
      mode = parseInt(val);
    }
  }
  return { mode, pct: maxCount / arr.length };
}

/**
 * Build evaluation prompt (simplified version for consistency test)
 */
function buildEvaluationPrompt(meeting, metrics, aiExtraction, transcript) {
  return `You are an expert meeting quality analyst evaluating an agency-client meeting.

CONTEXT:
- Agency: Breakthrough 3x (B3X), a digital marketing agency
- B3X Team Members: Dan Kuschell (CEO/founder), Philip Mutrie (account manager), Joe Boland (media buyer), Richard Bond (operations)
- Meeting: ${meeting.topic}
- Client: ${meeting.client_name}
- Date: ${meeting.start_time}
- Duration: ${meeting.duration_minutes || 0} minutes

QUANTITATIVE METRICS:
- Action items: ${metrics.action_item_count || 0}
- Due date assignment rate: ${(metrics.due_date_rate || 0).toFixed(0)}%
- Owner assignment rate: ${(metrics.owner_assignment_rate || 0).toFixed(0)}%
- Decisions made: ${metrics.decision_count || 0}

TRANSCRIPT (first 12000 chars):
${(transcript || '').slice(0, 12000)}

---

EVALUATE this meeting on 12 dimensions using a 4-point rubric:
4 = Excellent, 3 = Good, 2 = Needs Improvement, 1 = Failing

DIMENSIONS:
**Tier 1 — Deal Breakers:**
1. client_sentiment: Client engagement and trust level
2. accountability: Past commitments acknowledged, stale items addressed
3. relationship_health: Trust signals, open sharing vs transactional

**Tier 2 — Core Competence:**
4. meeting_structure: Agenda, recap, clear wrap-up
5. value_delivery: Results, data, strategic recommendations presented
6. action_discipline: Specific items with owners and due dates
7. proactive_leadership: Ideas and forward-looking suggestions

**Tier 3 — Efficiency:**
8. time_utilization: Productive use of meeting time
9. redundancy: Topics rehashed without progress
10. client_confusion: Jargon, need for clarification
11. meeting_momentum: Relationship progressing vs stagnating
12. save_rate: Recovery from frustration (3 if none occurred)

RETURN VALID JSON:
{
  "scores": {
    "client_sentiment": N, "accountability": N, "relationship_health": N,
    "meeting_structure": N, "value_delivery": N, "action_discipline": N, "proactive_leadership": N,
    "time_utilization": N, "redundancy": N, "client_confusion": N, "meeting_momentum": N, "save_rate": N
  }
}`;
}

/**
 * Run a single evaluation for consistency test (doesn't store in DB)
 */
async function runSingleEvaluation(db, meetingId, modelId) {
  const meeting = db.prepare(`
    SELECT id, topic, client_id, client_name, transcript_raw, duration_minutes, start_time, ai_extraction
    FROM meetings WHERE id = ?
  `).get(meetingId);

  if (!meeting) throw new Error(`Meeting ${meetingId} not found`);

  const metrics = getMetrics(db, meetingId) || {};

  let aiExtraction = {};
  try {
    aiExtraction = meeting.ai_extraction ? JSON.parse(meeting.ai_extraction) : {};
    if (Array.isArray(aiExtraction)) aiExtraction = aiExtraction[0] || {};
  } catch (e) { /* ignore */ }

  const prompt = buildEvaluationPrompt(meeting, metrics, aiExtraction, meeting.transcript_raw);

  const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
  const model = genAI.getGenerativeModel({ model: modelId });

  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.3,
      topP: 0.8,
      maxOutputTokens: 1024,
      responseMimeType: 'application/json'
    }
  });

  const text = result.response.text();
  let evaluation;
  try {
    evaluation = JSON.parse(text);
  } catch (e) {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) evaluation = JSON.parse(jsonMatch[0]);
    else throw new Error('Failed to parse JSON');
  }

  return evaluation.scores;
}

/**
 * Test 1: Scoring Consistency
 */
async function runConsistencyTest(db, evalDb, testMeetings) {
  console.log('\n=== Test 1: Scoring Consistency ===');
  const results = [];

  for (const meeting of testMeetings) {
    console.log(`  Testing meeting ${meeting.id} (${meeting.reason})...`);
    const runScores = [];

    for (let run = 1; run <= CONSISTENCY_RUNS; run++) {
      try {
        // Use the actual model but don't store - just collect scores
        const scores = await runSingleEvaluation(db, meeting.id, DEFAULT_MODEL);
        runScores.push(scores);

        // Calculate quick composite for logging
        const t1 = (scores.client_sentiment + scores.accountability + scores.relationship_health) / 3;
        const t2 = (scores.meeting_structure + scores.value_delivery + scores.action_discipline + scores.proactive_leadership) / 4;
        const t3 = (scores.time_utilization + scores.redundancy + scores.client_confusion + scores.meeting_momentum + scores.save_rate) / 5;
        const composite = t1 * 0.4 + t2 * 0.35 + t3 * 0.25;
        console.log(`    Run ${run}: composite=${composite.toFixed(2)}`);

        await new Promise(r => setTimeout(r, 2500)); // Rate limit
      } catch (err) {
        console.error(`    Run ${run} error: ${err.message}`);
      }
    }

    // Calculate variance per dimension
    if (runScores.length === CONSISTENCY_RUNS) {
      for (const dim of ALL_DIMS) {
        const scores = runScores.map(s => s[dim]);
        const v = variance(scores);
        results.push({
          meeting_id: meeting.id,
          reason: meeting.reason,
          dimension: dim,
          scores,
          variance: v,
          passed: v <= VARIANCE_THRESHOLD
        });
      }
    }
  }

  const passCount = results.filter(r => r.passed).length;
  const totalTests = results.length;
  const failedDims = results.filter(r => !r.passed);

  return {
    results,
    passCount,
    totalTests,
    failedDims,
    passed: failedDims.length <= 2 * CONSISTENCY_MEETINGS // Allow up to 2 per meeting
  };
}

/**
 * Test 2: Score Distribution Analysis
 */
function runDistributionAnalysis(db) {
  console.log('\n=== Test 2: Score Distribution Analysis ===');

  const evals = db.prepare(`
    SELECT * FROM session_evaluations WHERE model_used = ?
  `).all(DEFAULT_MODEL);

  console.log(`  Analyzing ${evals.length} evaluations...`);

  const results = [];
  const poorDiscrimination = [];
  const ceilingFloor = [];

  for (const dim of ALL_DIMS) {
    const scores = evals.map(e => e[dim]).filter(s => s != null);
    if (scores.length === 0) continue;

    const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
    const sorted = [...scores].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const sd = stddev(scores);
    const { mode, pct: modePct } = modeWithPct(scores);

    // Count distribution
    const dist = { 1: 0, 2: 0, 3: 0, 4: 0 };
    scores.forEach(s => { dist[s] = (dist[s] || 0) + 1; });

    const hasPoorDiscrimination = modePct > MODE_THRESHOLD;
    const hasCeilingFloor = mean < 1.5 || mean > 3.5;

    if (hasPoorDiscrimination) poorDiscrimination.push(dim);
    if (hasCeilingFloor) ceilingFloor.push(dim);

    results.push({
      dimension: dim,
      mean,
      median,
      stddev: sd,
      mode,
      modePct,
      distribution: dist,
      passed: !hasPoorDiscrimination && !hasCeilingFloor
    });
  }

  const passedCount = results.filter(r => r.passed).length;

  return {
    results,
    poorDiscrimination,
    ceilingFloor,
    passed: poorDiscrimination.length === 0 && ceilingFloor.length === 0,
    evalCount: evals.length
  };
}

/**
 * Test 3: Cross-Dimension Correlation
 */
function runCorrelationAnalysis(db) {
  console.log('\n=== Test 3: Cross-Dimension Correlation ===');

  const evals = db.prepare(`
    SELECT * FROM session_evaluations WHERE model_used = ?
  `).all(DEFAULT_MODEL);

  const results = [];
  const redundantPairs = [];

  // Check all dimension pairs
  for (let i = 0; i < ALL_DIMS.length; i++) {
    for (let j = i + 1; j < ALL_DIMS.length; j++) {
      const dim1 = ALL_DIMS[i];
      const dim2 = ALL_DIMS[j];

      const scores1 = evals.map(e => e[dim1]).filter(s => s != null);
      const scores2 = evals.map(e => e[dim2]).filter(s => s != null);

      // Need same length arrays
      const paired = evals.filter(e => e[dim1] != null && e[dim2] != null);
      const arr1 = paired.map(e => e[dim1]);
      const arr2 = paired.map(e => e[dim2]);

      const r = correlation(arr1, arr2);
      const isRedundant = Math.abs(r) > CORRELATION_THRESHOLD;

      if (isRedundant) {
        redundantPairs.push({ dim1, dim2, correlation: r });
      }

      // Only include high correlations in results for brevity
      if (Math.abs(r) > 0.7) {
        results.push({ dim1, dim2, correlation: r, isRedundant });
      }
    }
  }

  console.log(`  Found ${results.length} high correlations (r>0.7)`);

  return {
    results,
    redundantPairs,
    passed: redundantPairs.length === 0 // Informational, but still track
  };
}

/**
 * Test 4: Bias Check
 */
function runBiasCheck(db) {
  console.log('\n=== Test 4: Bias Check ===');

  const results = [];

  // Get all evaluations with meeting data
  const evals = db.prepare(`
    SELECT se.*, m.topic, m.client_name, m.duration_minutes, m.ai_extraction
    FROM session_evaluations se
    JOIN meetings m ON m.id = se.meeting_id
    WHERE se.model_used = ?
  `).all(DEFAULT_MODEL);

  // Helper to calculate average composite
  const avgComposite = (arr) => arr.length > 0
    ? arr.reduce((sum, e) => sum + e.composite_score, 0) / arr.length
    : 0;

  // 1. Dan-led vs Phil-led meetings
  const danLed = evals.filter(e => {
    const ai = tryParseJson(e.ai_extraction);
    const attendees = ai?.attendees || ai?.participants || [];
    return attendees.some(a => /dan/i.test(a.name || a));
  });
  const philLed = evals.filter(e => {
    const ai = tryParseJson(e.ai_extraction);
    const attendees = ai?.attendees || ai?.participants || [];
    return attendees.some(a => /phil/i.test(a.name || a));
  });

  const danAvg = avgComposite(danLed);
  const philAvg = avgComposite(philLed);
  results.push({
    comparison: 'Dan-led vs Phil-led',
    groupA: 'Dan-led',
    groupB: 'Phil-led',
    groupACount: danLed.length,
    groupBCount: philLed.length,
    groupAAvg: danAvg,
    groupBAvg: philAvg,
    delta: Math.abs(danAvg - philAvg),
    significant: Math.abs(danAvg - philAvg) > BIAS_THRESHOLD
  });

  // 2. Long vs Short meetings
  const longMeetings = evals.filter(e => e.duration_minutes > 45);
  const shortMeetings = evals.filter(e => e.duration_minutes < 25);

  const longAvg = avgComposite(longMeetings);
  const shortAvg = avgComposite(shortMeetings);
  results.push({
    comparison: 'Long (>45min) vs Short (<25min)',
    groupA: 'Long',
    groupB: 'Short',
    groupACount: longMeetings.length,
    groupBCount: shortMeetings.length,
    groupAAvg: longAvg,
    groupBAvg: shortAvg,
    delta: Math.abs(longAvg - shortAvg),
    significant: Math.abs(longAvg - shortAvg) > BIAS_THRESHOLD
  });

  // 3. High action items vs Low action items
  const actionCounts = db.prepare(`
    SELECT meeting_id, COUNT(*) as cnt FROM action_items GROUP BY meeting_id
  `).all();
  const actionMap = Object.fromEntries(actionCounts.map(a => [a.meeting_id, a.cnt]));

  const highItems = evals.filter(e => (actionMap[e.meeting_id] || 0) >= 10);
  const lowItems = evals.filter(e => (actionMap[e.meeting_id] || 0) <= 3);

  const highAvg = avgComposite(highItems);
  const lowAvg = avgComposite(lowItems);
  results.push({
    comparison: 'High items (>=10) vs Low items (<=3)',
    groupA: 'High items',
    groupB: 'Low items',
    groupACount: highItems.length,
    groupBCount: lowItems.length,
    groupAAvg: highAvg,
    groupBAvg: lowAvg,
    delta: Math.abs(highAvg - lowAvg),
    significant: Math.abs(highAvg - lowAvg) > BIAS_THRESHOLD
  });

  // 4. Internal vs Client meetings
  const internalMeetings = evals.filter(e =>
    /internal|huddle|b3x/i.test(e.client_name) || /internal|huddle/i.test(e.topic)
  );
  const clientMeetings = evals.filter(e =>
    !/internal|huddle|b3x/i.test(e.client_name) && !/internal|huddle/i.test(e.topic)
  );

  const internalAvg = avgComposite(internalMeetings);
  const clientAvg = avgComposite(clientMeetings);
  results.push({
    comparison: 'Internal vs Client',
    groupA: 'Internal',
    groupB: 'Client',
    groupACount: internalMeetings.length,
    groupBCount: clientMeetings.length,
    groupAAvg: internalAvg,
    groupBAvg: clientAvg,
    delta: Math.abs(internalAvg - clientAvg),
    significant: Math.abs(internalAvg - clientAvg) > BIAS_THRESHOLD
  });

  const significantBiases = results.filter(r => r.significant);

  return {
    results,
    significantBiases,
    passed: significantBiases.length === 0
  };
}

function tryParseJson(str) {
  try {
    const parsed = JSON.parse(str || '{}');
    return Array.isArray(parsed) ? parsed[0] : parsed;
  } catch {
    return {};
  }
}

/**
 * Generate markdown report
 */
function generateReport(consistency, distribution, correlation, bias) {
  const date = new Date().toISOString().split('T')[0];

  // Determine overall verdict
  const criticalFails = [];
  if (!consistency.passed) criticalFails.push('Consistency test failed');
  if (!distribution.passed) criticalFails.push('Distribution analysis failed');
  if (bias.significantBiases.length > 0) criticalFails.push(`Bias detected in ${bias.significantBiases.length} comparisons`);

  const overallPassed = criticalFails.length === 0;

  let report = `# Rubric Calibration Report
Date: ${date}
Model: ${DEFAULT_MODEL}
Meetings analyzed: ${distribution.evalCount} (backfill) + ${CONSISTENCY_MEETINGS * CONSISTENCY_RUNS} (consistency test)

## Test 1: Scoring Consistency
${CONSISTENCY_MEETINGS} meetings evaluated ${CONSISTENCY_RUNS} times each. Variance threshold: ≤${VARIANCE_THRESHOLD}

| Meeting | Dimension | Run 1 | Run 2 | Run 3 | Variance | Status |
|---------|-----------|-------|-------|-------|----------|--------|
${consistency.results.map(r =>
  `| ${r.meeting_id} (${r.reason}) | ${r.dimension} | ${r.scores[0]} | ${r.scores[1]} | ${r.scores[2]} | ${r.variance.toFixed(2)} | ${r.passed ? '✅' : '❌'} |`
).join('\n')}

Overall: ${consistency.passCount}/${consistency.totalTests} dimension-tests within tolerance
${consistency.failedDims.length > 0 ? `\nFailed dimensions:\n${consistency.failedDims.map(f => `- Meeting ${f.meeting_id}: ${f.dimension} (variance=${f.variance.toFixed(2)})`).join('\n')}` : ''}

**RESULT: ${consistency.passed ? 'PASS' : 'FAIL'}**

## Test 2: Score Distribution
Analyzed ${distribution.evalCount} evaluations. Thresholds: Mode% ≤${(MODE_THRESHOLD * 100).toFixed(0)}%, Mean in [1.5, 3.5]

| Dimension | Mean | Median | StdDev | Mode | Mode% | 1s | 2s | 3s | 4s | Status |
|-----------|------|--------|--------|------|-------|----|----|----|----|--------|
${distribution.results.map(r =>
  `| ${r.dimension} | ${r.mean.toFixed(2)} | ${r.median} | ${r.stddev.toFixed(2)} | ${r.mode} | ${(r.modePct * 100).toFixed(0)}% | ${r.distribution[1]} | ${r.distribution[2]} | ${r.distribution[3]} | ${r.distribution[4]} | ${r.passed ? '✅' : '❌'} |`
).join('\n')}

Dimensions with poor discrimination (>${(MODE_THRESHOLD * 100).toFixed(0)}% same score): ${distribution.poorDiscrimination.length > 0 ? distribution.poorDiscrimination.join(', ') : 'None'}
Dimensions with ceiling/floor effect: ${distribution.ceilingFloor.length > 0 ? distribution.ceilingFloor.join(', ') : 'None'}

**RESULT: ${distribution.passed ? 'PASS' : 'FAIL'}**

## Test 3: Correlation Analysis
Checking for redundant dimensions (r>${CORRELATION_THRESHOLD})

| Dimension Pair | Correlation | Status |
|----------------|-------------|--------|
${correlation.results.map(r =>
  `| ${r.dim1} ↔ ${r.dim2} | ${r.correlation.toFixed(3)} | ${r.isRedundant ? '⚠️ Redundant' : '✅'} |`
).join('\n')}

Potentially redundant pairs (r>${CORRELATION_THRESHOLD}): ${correlation.redundantPairs.length > 0 ? correlation.redundantPairs.map(p => `${p.dim1}↔${p.dim2}`).join(', ') : 'None'}

**RESULT: ${correlation.passed ? 'PASS' : 'WARN'} (informational)**

## Test 4: Bias Check
Comparing average composite scores between groups. Significance threshold: >${BIAS_THRESHOLD}

| Comparison | Group A | Count | Avg | Group B | Count | Avg | Delta | Significant? |
|------------|---------|-------|-----|---------|-------|-----|-------|--------------|
${bias.results.map(r =>
  `| ${r.comparison} | ${r.groupA} | ${r.groupACount} | ${r.groupAAvg.toFixed(2)} | ${r.groupB} | ${r.groupBCount} | ${r.groupBAvg.toFixed(2)} | ${r.delta.toFixed(2)} | ${r.significant ? '⚠️ Yes' : 'No'} |`
).join('\n')}

${bias.significantBiases.length > 0 ? `\n**Significant biases detected:**\n${bias.significantBiases.map(b => `- ${b.comparison}: Delta of ${b.delta.toFixed(2)}`).join('\n')}` : ''}

**RESULT: ${bias.passed ? 'PASS' : 'WARN'}**

## Overall Verdict

${overallPassed ? '**PASS** — Rubric is ready for production' : `**NEEDS_ATTENTION** — Issues found:\n${criticalFails.map(f => `- ${f}`).join('\n')}`}

## Recommendations
${generateRecommendations(consistency, distribution, correlation, bias)}
`;

  return report;
}

function generateRecommendations(consistency, distribution, correlation, bias) {
  const recs = [];

  // Consistency recommendations
  if (consistency.failedDims.length > 0) {
    const problemDims = [...new Set(consistency.failedDims.map(f => f.dimension))];
    recs.push(`- **Consistency**: Dimensions with high variance (${problemDims.join(', ')}) may need clearer rubric definitions in the prompt.`);
  }

  // Distribution recommendations
  if (distribution.poorDiscrimination.length > 0) {
    recs.push(`- **Discrimination**: ${distribution.poorDiscrimination.join(', ')} show low variance. Consider revising their rubric descriptions to better differentiate scores.`);
  }
  if (distribution.ceilingFloor.length > 0) {
    recs.push(`- **Ceiling/Floor**: ${distribution.ceilingFloor.join(', ')} have extreme means. May need recalibration.`);
  }

  // Correlation recommendations
  if (correlation.redundantPairs.length > 0) {
    recs.push(`- **Redundancy**: Highly correlated pairs (${correlation.redundantPairs.map(p => `${p.dim1}↔${p.dim2}`).join(', ')}) might be measuring the same underlying concept. Consider merging or differentiating them.`);
  }

  // Bias recommendations
  for (const b of bias.significantBiases) {
    recs.push(`- **Bias**: ${b.comparison} shows significant score difference (${b.delta.toFixed(2)}). Review if this reflects reality or model bias.`);
  }

  if (recs.length === 0) {
    recs.push('- No significant issues found. The rubric appears well-calibrated.');
    recs.push('- Continue monitoring score distributions as more meetings are evaluated.');
  }

  return recs.join('\n');
}

async function main() {
  console.log('=== Rubric Calibration ===');
  console.log(`Model: ${DEFAULT_MODEL}`);
  console.log(`Consistency test: ${CONSISTENCY_MEETINGS} meetings × ${CONSISTENCY_RUNS} runs\n`);

  const db = new Database(DB_PATH, { readonly: true });
  const evalDb = initDatabase();

  // Select test meetings
  const testMeetings = selectTestMeetings(db);
  console.log('Selected test meetings:');
  testMeetings.forEach(m => console.log(`  - Meeting ${m.id}: ${m.topic?.slice(0, 50)}... (${m.reason})`));

  // Run all 4 tests
  const consistencyResults = await runConsistencyTest(db, evalDb, testMeetings);
  const distributionResults = runDistributionAnalysis(evalDb);
  const correlationResults = runCorrelationAnalysis(evalDb);
  const biasResults = runBiasCheck(evalDb);

  // Generate report
  const report = generateReport(consistencyResults, distributionResults, correlationResults, biasResults);

  // Save report
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const reportPath = join(DATA_DIR, 'rubric-calibration.md');
  writeFileSync(reportPath, report);

  console.log('\n' + '='.repeat(60));
  console.log(report);
  console.log('='.repeat(60));
  console.log(`\nReport saved to: ${reportPath}`);

  db.close();
  evalDb.close();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
