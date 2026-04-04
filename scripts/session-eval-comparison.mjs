#!/usr/bin/env node
import 'dotenv/config';
/**
 * Session Evaluation Model Comparison
 * Compares multiple models on 5 diverse meetings using Gemini as judge.
 */

import Database from 'better-sqlite3';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { evaluateMeeting, initDatabase } from '../src/lib/session-evaluator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const DB_PATH = join(DATA_DIR, 'zoom-action-items.db');

// Models to compare
const MODELS = [
  { id: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash (default)' },
  { id: 'gemini-2.0-flash-lite', label: 'Gemini 2.0 Flash Lite' },
  { id: 'gemini-1.5-flash', label: 'Gemini 1.5 Flash' },
];

const JUDGE_MODEL = 'gemini-2.0-flash';

/**
 * Select 5 diverse test meetings
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
  while (meetings.length < 5) {
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
 * Run judge evaluation
 */
async function judgeEvaluations(meetingContext, evaluations) {
  const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
  const model = genAI.getGenerativeModel({ model: JUDGE_MODEL });

  const modelLetters = {};
  evaluations.forEach((e, i) => {
    modelLetters[e.model] = String.fromCharCode(65 + i);
  });

  const prompt = `You are judging the quality of AI-generated meeting evaluations. Multiple AI models evaluated the same meeting. Judge which model produced the most accurate, insightful, and actionable evaluation.

MEETING CONTEXT:
${meetingContext}

${evaluations.map((e, i) => `
MODEL ${String.fromCharCode(65 + i)} (${e.model}):
Composite Score: ${e.composite_score.toFixed(2)}
Scores: client_sentiment=${e.scores.client_sentiment}, accountability=${e.scores.accountability}, relationship_health=${e.scores.relationship_health}, meeting_structure=${e.scores.meeting_structure}, value_delivery=${e.scores.value_delivery}, action_discipline=${e.scores.action_discipline}, proactive_leadership=${e.scores.proactive_leadership}
Coaching notes: ${e.coaching_notes}
Wins: ${JSON.stringify(e.wins?.map(w => w.description))}
Improvements: ${JSON.stringify(e.improvements?.map(i => i.description))}
`).join('\n')}

EVALUATE each model on (1-5 scale):
1. SCORE_ACCURACY: Do the scores match what the transcript shows?
2. EVIDENCE_QUALITY: Are coaching insights backed by evidence?
3. COACHING_VALUE: Are suggestions specific and actionable?
4. NUANCE: Does it pick up on subtle signals?

Return JSON:
{
  "model_scores": {
    ${evaluations.map(e => `"${e.model}": { "score_accuracy": N, "evidence_quality": N, "coaching_value": N, "nuance": N, "avg": N.N }`).join(',\n    ')}
  },
  "winner": "model_id",
  "reasoning": "Why this model is best"
}`;

  const result = await model.generateContent({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 2048,
      responseMimeType: 'application/json'
    }
  });

  const text = result.response.text();
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : null;
  }
}

async function main() {
  console.log('=== Session Evaluation Model Comparison ===\n');

  const db = new Database(DB_PATH, { readonly: true });
  const evalDb = initDatabase();

  // Select test meetings
  const testMeetings = selectTestMeetings(db);
  console.log(`Selected ${testMeetings.length} test meetings:`);
  testMeetings.forEach(m => console.log(`  - Meeting ${m.id}: ${m.topic?.slice(0, 50)}... (${m.reason})`));
  console.log('');

  // Run evaluations for each model x meeting
  const allResults = [];
  const aggregateScores = {};

  for (const model of MODELS) {
    console.log(`\nTesting model: ${model.label}`);
    aggregateScores[model.id] = { total: 0, count: 0, latencies: [], tokens: [] };

    for (const meeting of testMeetings) {
      try {
        console.log(`  Evaluating meeting ${meeting.id}...`);
        const result = await evaluateMeeting(meeting.id, { model: model.id, db: evalDb });
        allResults.push({
          meeting_id: meeting.id,
          model: model.id,
          ...result
        });
        aggregateScores[model.id].total += result.composite_score;
        aggregateScores[model.id].count++;
        aggregateScores[model.id].latencies.push(result.latency_ms);
        aggregateScores[model.id].tokens.push(result.tokens_in + result.tokens_out);

        // Rate limit
        await new Promise(r => setTimeout(r, 2000));
      } catch (err) {
        console.error(`  Error: ${err.message}`);
      }
    }
  }

  // Run judge evaluations
  console.log('\n\nRunning judge evaluations...');
  const judgeResults = [];

  for (const meeting of testMeetings) {
    const meetingData = db.prepare('SELECT topic, client_name, duration_minutes FROM meetings WHERE id = ?').get(meeting.id);
    const meetingContext = `Meeting: ${meetingData.topic}, Client: ${meetingData.client_name}, Duration: ${meetingData.duration_minutes}min`;

    const evals = allResults.filter(r => r.meeting_id === meeting.id);
    if (evals.length < 2) continue;

    try {
      const judgeResult = await judgeEvaluations(meetingContext, evals);
      if (judgeResult) {
        judgeResults.push({ meeting_id: meeting.id, ...judgeResult });
      }
      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      console.error(`Judge error for meeting ${meeting.id}: ${err.message}`);
    }
  }

  // Aggregate judge scores
  const modelJudgeScores = {};
  for (const model of MODELS) {
    modelJudgeScores[model.id] = { score_accuracy: 0, evidence_quality: 0, coaching_value: 0, nuance: 0, wins: 0, count: 0 };
  }

  for (const jr of judgeResults) {
    for (const [modelId, scores] of Object.entries(jr.model_scores || {})) {
      if (modelJudgeScores[modelId]) {
        modelJudgeScores[modelId].score_accuracy += scores.score_accuracy || 0;
        modelJudgeScores[modelId].evidence_quality += scores.evidence_quality || 0;
        modelJudgeScores[modelId].coaching_value += scores.coaching_value || 0;
        modelJudgeScores[modelId].nuance += scores.nuance || 0;
        modelJudgeScores[modelId].count++;
      }
    }
    if (jr.winner && modelJudgeScores[jr.winner]) {
      modelJudgeScores[jr.winner].wins++;
    }
  }

  // Determine winner
  let winner = MODELS[0].id;
  let highestAvg = 0;
  for (const model of MODELS) {
    const s = modelJudgeScores[model.id];
    if (s.count > 0) {
      const avg = (s.score_accuracy + s.evidence_quality + s.coaching_value + s.nuance) / (s.count * 4);
      if (avg > highestAvg) {
        highestAvg = avg;
        winner = model.id;
      }
    }
  }

  // Generate report
  const report = `# Session Evaluation — Model Comparison Report
Date: ${new Date().toISOString().split('T')[0]}
Test meetings: ${testMeetings.length}
Models compared: ${MODELS.length}

## Summary

| Model | Score Accuracy | Evidence | Coaching | Nuance | Wins | Overall |
|-------|---------------|----------|----------|--------|------|---------|
${MODELS.map(m => {
  const s = modelJudgeScores[m.id];
  const n = s.count || 1;
  const overall = ((s.score_accuracy + s.evidence_quality + s.coaching_value + s.nuance) / (n * 4)).toFixed(2);
  return `| ${m.label} | ${(s.score_accuracy / n).toFixed(1)} | ${(s.evidence_quality / n).toFixed(1)} | ${(s.coaching_value / n).toFixed(1)} | ${(s.nuance / n).toFixed(1)} | ${s.wins} | ${overall} |`;
}).join('\n')}

## Winner: ${winner}
${judgeResults.find(j => j.winner === winner)?.reasoning || 'Best overall judge scores across test meetings.'}

## Performance Metrics

| Model | Avg Latency | Avg Tokens | Avg Composite Score |
|-------|------------|------------|---------------------|
${MODELS.map(m => {
  const s = aggregateScores[m.id];
  const avgLatency = s.latencies.length ? (s.latencies.reduce((a,b) => a+b, 0) / s.latencies.length).toFixed(0) : 'N/A';
  const avgTokens = s.tokens.length ? (s.tokens.reduce((a,b) => a+b, 0) / s.tokens.length).toFixed(0) : 'N/A';
  const avgComposite = s.count ? (s.total / s.count).toFixed(2) : 'N/A';
  return `| ${m.label} | ${avgLatency}ms | ${avgTokens} | ${avgComposite} |`;
}).join('\n')}

## Test Meetings

${testMeetings.map(m => `- Meeting ${m.id}: ${m.topic?.slice(0, 60)}... (${m.reason})`).join('\n')}

## Recommendation

**Production model:** ${winner}

Based on the comparison, ${winner} provides the best balance of accuracy, coaching value, and nuance for session evaluation.
`;

  // Save report
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(join(DATA_DIR, 'session-eval-comparison-report.md'), report);
  writeFileSync(join(DATA_DIR, 'session-eval-comparison-raw.json'), JSON.stringify({
    date: new Date().toISOString(),
    models: MODELS,
    test_meetings: testMeetings,
    all_results: allResults,
    judge_results: judgeResults,
    winner
  }, null, 2));

  console.log('\n' + report);
  console.log(`\nReports saved to:`);
  console.log(`  - ${join(DATA_DIR, 'session-eval-comparison-report.md')}`);
  console.log(`  - ${join(DATA_DIR, 'session-eval-comparison-raw.json')}`);

  db.close();
  evalDb.close();
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
