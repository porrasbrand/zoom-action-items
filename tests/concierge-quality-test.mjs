#!/usr/bin/env node
/**
 * Concierge Quality Stress Test — 52 questions, 10 sessions, LLM-as-judge
 * Scores each response on 6 dimensions (1-5): conciseness, accuracy, relevance,
 * actionability, formatting, proactivity.
 * Uses GPT-5.4 as judge for standard, Claude Haiku 4.5 for complex.
 *
 * Usage: node tests/concierge-quality-test.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const API_URL = 'http://localhost:3875/zoom/api/chat';
const TOKEN = '885265e0f2ce7d4e258e9a5224e5e59b9514ccbe759c5bc4ba7ad2865e720e97';
const RESULTS_PATH = path.join(__dirname, 'quality-test-results.json');
const REPORT_PATH = path.join(__dirname, 'quality-test-report.html');

// ── Judge APIs ─────────────────────────────────────────────────────────────

import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const JUDGE_PROMPT = `You are a strict quality evaluator for an AI meeting concierge. Score the response on these 6 dimensions (1-5 each):

1. **conciseness** (1-5): Is the response appropriately brief? 5 = perfectly concise for the query type, 1 = bloated wall of text
2. **accuracy** (1-5): Does it contain correct, specific facts from the data? 5 = all facts verifiable and precise, 1 = vague or fabricated
3. **relevance** (1-5): Does it directly answer what was asked? 5 = laser-focused, 1 = off-topic
4. **actionability** (1-5): Does it give actionable insights the user can act on? 5 = clear next steps, 1 = purely informational with no direction
5. **formatting** (1-5): Is it well-structured with bold, bullets, headers as appropriate? 5 = perfect formatting, 1 = unreadable blob
6. **proactivity** (1-5): Does it anticipate follow-up needs or suggest next steps? 5 = proactively helpful, 1 = answers only the literal question

Scoring guide per query type:
- Count queries: conciseness should be 5 only if 1-2 sentences. Anything longer = 1-2.
- Action items: must use bullet list format with status/owner. Prose = formatting 1.
- Meeting summaries: max ~150 words. Overview + bullets. Longer = conciseness penalty.
- Sentiment: max ~100 words. Scores + brief bullets.

Respond with ONLY valid JSON, no markdown fences:
{"conciseness": {"score": N, "reason": "..."}, "accuracy": {"score": N, "reason": "..."}, "relevance": {"score": N, "reason": "..."}, "actionability": {"score": N, "reason": "..."}, "formatting": {"score": N, "reason": "..."}, "proactivity": {"score": N, "reason": "..."}}`;

function stripMarkdownFences(text) {
  // Remove ```json ... ``` or ``` ... ``` wrappers
  return text.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();
}

async function judgeWithGPT(question, answer, queryType) {
  const userMsg = `Query type: ${queryType}\nQuestion: ${question}\n\nResponse to evaluate:\n${answer}`;
  try {
    const resp = await openai.chat.completions.create({
      model: 'gpt-5.4',
      temperature: 0,
      max_completion_tokens: 600,
      messages: [
        { role: 'system', content: JUDGE_PROMPT },
        { role: 'user', content: userMsg }
      ]
    });
    const text = stripMarkdownFences(resp.choices[0].message.content.trim());
    return JSON.parse(text);
  } catch (err) {
    console.warn('  [judge-gpt] Parse error:', err.message);
    return null;
  }
}

async function judgeWithClaude(question, answer, queryType) {
  const userMsg = `Query type: ${queryType}\nQuestion: ${question}\n\nResponse to evaluate:\n${answer}`;
  try {
    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      temperature: 0,
      system: JUDGE_PROMPT,
      messages: [{ role: 'user', content: userMsg }]
    });
    const text = stripMarkdownFences(resp.content[0].text.trim());
    return JSON.parse(text);
  } catch (err) {
    console.warn('  [judge-claude] Parse error:', err.message);
    return null;
  }
}

// ── Concierge API ──────────────────────────────────────────────────────────

async function chat(question, sessionId = null, meetingId = null) {
  const body = { question };
  if (sessionId) body.session_id = sessionId;
  if (meetingId) body.meeting_id = meetingId;
  const start = Date.now();
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const latency = Date.now() - start;
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }
  const data = await res.json();
  data._latency = latency;
  return data;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Weighted Composite ─────────────────────────────────────────────────────

const WEIGHTS = {
  accuracy: 0.30,
  relevance: 0.25,
  conciseness: 0.20,
  actionability: 0.10,
  formatting: 0.10,
  proactivity: 0.05
};

function computeComposite(scores) {
  if (!scores) return 0;
  let total = 0;
  for (const [dim, weight] of Object.entries(WEIGHTS)) {
    const s = scores[dim]?.score || 0;
    total += s * weight;
  }
  return Math.round(total * 100) / 100;
}

// ── Session Definitions (10 sessions, 52 questions) ────────────────────────

const SESSIONS = [
  {
    name: 'A: Executive Brief',
    judge: 'gpt',
    questions: [
      { q: 'Which clients need attention right now?', type: 'meta_analysis' },
      { q: 'Brief me on the most urgent one.', type: 'meeting_prep' },
      { q: 'What is the latest Echelon update?', type: 'transcript_search' },
      { q: 'Show me all overdue action items.', type: 'action_items' },
      { q: 'Give me a priority list of what to tackle first today.', type: 'meta_analysis' },
    ]
  },
  {
    name: 'B: London Flooring Dive',
    judge: 'gpt',
    questions: [
      { q: 'Brief me on London Flooring.', type: 'meeting_prep' },
      { q: 'When was the last London Flooring meeting?', type: 'temporal_search' },
      { q: 'What was the sentiment in their last meeting?', type: 'sentiment_analysis' },
      { q: 'What open items does London Flooring have?', type: 'action_items' },
      { q: 'What recurring topics come up in London Flooring meetings?', type: 'transcript_search' },
      { q: 'Generate talking points for the next London Flooring meeting.', type: 'meeting_prep' },
    ]
  },
  {
    name: 'C: Accountability',
    judge: 'gpt',
    questions: [
      { q: 'How many overdue action items do we have?', type: 'count_query' },
      { q: 'Show me those overdue items.', type: 'action_items' },
      { q: 'Which client has the most open action items?', type: 'meta_analysis' },
      { q: 'What about Pearce specifically — what are their open items?', type: 'action_items' },
      { q: "What are Dan's action items?", type: 'action_items' },
      { q: 'What is our average response time on action items?', type: 'meta_analysis' },
    ]
  },
  {
    name: 'D: Sentiment',
    judge: 'gpt',
    questions: [
      { q: 'Are any of our clients unhappy? Check sentiment.', type: 'sentiment_analysis' },
      { q: "What's Echelon's sentiment score?", type: 'sentiment_analysis' },
      { q: 'How has Bearcat been feeling in recent meetings?', type: 'sentiment_analysis' },
      { q: 'Which client has the worst trending sentiment?', type: 'meta_analysis' },
      { q: 'What are the most common frustration themes across clients?', type: 'meta_analysis' },
    ]
  },
  {
    name: 'E: Quick Facts',
    judge: 'gpt',
    questions: [
      { q: 'How many meetings have we had this month?', type: 'count_query' },
      { q: 'When was the last Prosper meeting?', type: 'temporal_search' },
      { q: 'Is GS happy with us?', type: 'sentiment_analysis' },
      { q: "What are Tom Ruwitch's action items?", type: 'action_items' },
      { q: 'Who is our newest client?', type: 'meta_analysis' },
      { q: 'How many total open action items are there?', type: 'count_query' },
    ]
  },
  {
    name: 'F: Complex Analysis',
    judge: 'claude',
    questions: [
      { q: 'Compare Echelon vs London Flooring — engagement, sentiment, action item completion.', type: 'meta_analysis' },
      { q: 'What topics come up most commonly across all client meetings?', type: 'meta_analysis' },
      { q: 'Which clients are at highest churn risk based on meeting data?', type: 'meta_analysis' },
      { q: 'What patterns do you see in clients with declining sentiment?', type: 'meta_analysis' },
      { q: 'What were the top 3 most important calls today?', type: 'meta_analysis' },
    ]
  },
  {
    name: 'G: Meeting-Scoped',
    judge: 'claude',
    meetingId: 135,
    questions: [
      { q: 'What was discussed in this meeting?', type: 'meeting_summary' },
      { q: 'What action items came out of it?', type: 'action_items' },
      { q: 'How did the client feel during this meeting?', type: 'sentiment_analysis' },
      { q: 'What decisions were made?', type: 'transcript_search' },
      { q: 'What should we follow up on from this meeting?', type: 'action_items' },
    ]
  },
  {
    name: 'H: Edge Cases',
    judge: 'claude',
    questions: [
      { q: 'Tell me about Acme Corporation.', type: 'transcript_search' },
      { q: 'Show me action items.', type: 'action_items' },
      { q: 'meetings', type: 'transcript_search' },
      { q: 'What did they say about the thing?', type: 'transcript_search' },
      { q: 'Actually, I meant Echelon. What did they say about hiring?', type: 'transcript_search' },
    ]
  },
  {
    name: 'I: Natural Conversation',
    judge: 'claude',
    questions: [
      { q: "Hey, what's going on with Echelon lately?", type: 'meeting_prep' },
      { q: 'Has anyone mentioned a Golden Ticket program?', type: 'transcript_search' },
      { q: "I'm about to call Andrew. What should I know?", type: 'meeting_prep' },
      { q: "When's the next meeting with them?", type: 'temporal_search' },
    ]
  },
  {
    name: 'J: Data Validation',
    judge: 'claude',
    questions: [
      { q: 'How many meetings have we had with Echelon?', type: 'count_query', expect: { min: 6, field: 'number' } },
      { q: 'How many total clients do we have?', type: 'count_query', expect: { min: 22, field: 'number' } },
      { q: "What is Echelon's composite sentiment score?", type: 'sentiment_analysis' },
    ]
  }
];

// ── Runner ─────────────────────────────────────────────────────────────────

async function runSession(session, sessionIndex, totalSessions) {
  const sessionResult = {
    name: session.name,
    judge: session.judge,
    sessionId: null,
    questions: [],
    composites: [],
    startTime: new Date().toISOString()
  };

  console.log(`\n${'='.repeat(70)}`);
  console.log(`  SESSION ${sessionIndex + 1}/${totalSessions}: ${session.name} [judge: ${session.judge}]`);
  console.log(`${'='.repeat(70)}`);

  for (let i = 0; i < session.questions.length; i++) {
    const { q, type, expect } = session.questions[i];
    const meetingId = session.meetingId || null;

    try {
      // 1. Ask concierge
      const resp = await chat(q, sessionResult.sessionId, meetingId);
      if (!sessionResult.sessionId && resp.session_id) {
        sessionResult.sessionId = resp.session_id;
      }

      const answer = resp.answer || '';
      const queryType = resp.query_type || type;

      // 2. Judge the response
      let judgeScores;
      if (session.judge === 'claude') {
        judgeScores = await judgeWithClaude(q, answer, queryType);
      } else {
        judgeScores = await judgeWithGPT(q, answer, queryType);
      }

      const composite = computeComposite(judgeScores);

      // 3. Data validation check
      let validationResult = null;
      if (expect) {
        const numbers = answer.match(/\d+/g);
        if (numbers && expect.min !== undefined) {
          const maxNum = Math.max(...numbers.map(Number));
          validationResult = { expected: `>= ${expect.min}`, found: maxNum, pass: maxNum >= expect.min };
        } else {
          validationResult = { expected: `>= ${expect.min}`, found: 'no number', pass: false };
        }
      }

      const qResult = {
        questionNum: i + 1,
        question: q,
        answer,
        queryType,
        latencyMs: resp._latency,
        model: resp.model_used,
        tokensUsed: resp.tokens_used,
        judgeScores,
        composite,
        validation: validationResult
      };

      sessionResult.questions.push(qResult);
      sessionResult.composites.push(composite);

      // Print
      const stars = composite >= 4.0 ? '***' : composite >= 3.0 ? '** ' : composite >= 2.0 ? '*  ' : '   ';
      const preview = answer.substring(0, 100).replace(/\n/g, ' ');
      console.log(`  [${stars}] Q${i + 1}/${session.questions.length} composite=${composite.toFixed(2)} [${resp._latency}ms] ${queryType}`);
      console.log(`       Q: ${q}`);
      console.log(`       A: ${preview}...`);
      if (judgeScores) {
        const dims = Object.entries(judgeScores).map(([k, v]) => `${k.substring(0, 4)}=${v.score}`).join(' ');
        console.log(`       Dims: ${dims}`);
      }
      if (validationResult) {
        console.log(`       Validation: ${validationResult.pass ? 'PASS' : 'FAIL'} (expected ${validationResult.expected}, found ${validationResult.found})`);
      }

    } catch (err) {
      console.log(`  [!!!] Q${i + 1} ERROR: ${err.message}`);
      sessionResult.questions.push({
        questionNum: i + 1,
        question: q,
        error: err.message,
        judgeScores: null,
        composite: 0
      });
      sessionResult.composites.push(0);
    }

    if (i < session.questions.length - 1) await sleep(500);
  }

  sessionResult.endTime = new Date().toISOString();
  const avgComposite = sessionResult.composites.length
    ? (sessionResult.composites.reduce((a, b) => a + b, 0) / sessionResult.composites.length).toFixed(2)
    : '0';
  console.log(`  -- Session Avg Composite: ${avgComposite}/5.00`);

  return sessionResult;
}

// ── HTML Report ────────────────────────────────────────────────────────────

function generateHTML(results) {
  const allComposites = results.sessions.flatMap(s => s.composites);
  const avgComposite = allComposites.length
    ? (allComposites.reduce((a, b) => a + b, 0) / allComposites.length)
    : 0;

  // Dimension averages
  const dimTotals = { conciseness: [], accuracy: [], relevance: [], actionability: [], formatting: [], proactivity: [] };
  for (const sess of results.sessions) {
    for (const q of sess.questions) {
      if (q.judgeScores) {
        for (const dim of Object.keys(dimTotals)) {
          if (q.judgeScores[dim]) dimTotals[dim].push(q.judgeScores[dim].score);
        }
      }
    }
  }
  const dimAvgs = {};
  for (const [k, arr] of Object.entries(dimTotals)) {
    dimAvgs[k] = arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2) : '0';
  }

  // Latencies
  const latencies = results.sessions.flatMap(s => s.questions.filter(q => q.latencyMs).map(q => q.latencyMs)).sort((a, b) => a - b);
  const avgLatency = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
  const p50 = latencies[Math.floor(latencies.length * 0.5)] || 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;

  const gradeColor = avgComposite >= 4.0 ? '#22c55e' : avgComposite >= 3.0 ? '#eab308' : '#ef4444';
  const grade = avgComposite >= 4.5 ? 'A+' : avgComposite >= 4.0 ? 'A' : avgComposite >= 3.5 ? 'B+' : avgComposite >= 3.0 ? 'B' : avgComposite >= 2.5 ? 'C' : 'D';

  // Session rows
  let sessionRows = '';
  for (const sess of results.sessions) {
    const avg = sess.composites.length ? (sess.composites.reduce((a, b) => a + b, 0) / sess.composites.length) : 0;
    const color = avg >= 4.0 ? '#22c55e' : avg >= 3.0 ? '#eab308' : '#ef4444';
    const pct = Math.round((avg / 5) * 100);
    sessionRows += `<tr>
      <td><strong>${sess.name}</strong></td>
      <td>${sess.questions.length}</td>
      <td>${sess.judge}</td>
      <td style="color:${color};font-weight:bold">${avg.toFixed(2)}/5.00</td>
      <td><div style="background:#e5e7eb;border-radius:4px;overflow:hidden;height:20px">
        <div style="background:${color};height:100%;width:${pct}%"></div></div></td>
    </tr>`;
  }

  // Detail sections
  let detailSections = '';
  for (const sess of results.sessions) {
    let qRows = '';
    for (const q of sess.questions) {
      const c = q.composite || 0;
      const color = c >= 4.0 ? '#22c55e' : c >= 3.0 ? '#eab308' : '#ef4444';
      const js = q.judgeScores || {};
      const ansPreview = (q.answer || q.error || 'N/A').substring(0, 250).replace(/</g, '&lt;').replace(/\n/g, '<br>');

      const dimCells = ['conciseness', 'accuracy', 'relevance', 'actionability', 'formatting', 'proactivity']
        .map(d => {
          const s = js[d]?.score || '-';
          const sColor = s >= 4 ? '#22c55e' : s >= 3 ? '#eab308' : s >= 1 ? '#ef4444' : '#9ca3af';
          return `<td style="color:${sColor};font-weight:bold">${s}</td>`;
        }).join('');

      const valBadge = q.validation
        ? `<span style="color:${q.validation.pass ? '#22c55e' : '#ef4444'};font-weight:bold">${q.validation.pass ? 'PASS' : 'FAIL'}</span>`
        : '';

      qRows += `<tr>
        <td>Q${q.questionNum}</td>
        <td style="max-width:220px">${q.question}</td>
        <td><code>${q.queryType || 'err'}</code></td>
        <td>${q.latencyMs || '-'}ms</td>
        ${dimCells}
        <td style="color:${color};font-weight:bold">${c.toFixed(2)}</td>
        <td>${valBadge}</td>
      </tr>
      <tr><td colspan="12" style="background:#f9fafb;font-size:0.85em;padding:6px 12px">${ansPreview}</td></tr>`;

      // Add judge reasons row
      if (q.judgeScores) {
        const reasons = Object.entries(q.judgeScores)
          .map(([k, v]) => `<strong>${k}</strong>: ${(v.reason || '').replace(/</g, '&lt;')}`)
          .join(' | ');
        qRows += `<tr><td colspan="12" style="background:#fefce8;font-size:0.78em;padding:4px 12px;color:#6b7280">${reasons}</td></tr>`;
      }
    }

    const avg = sess.composites.length ? (sess.composites.reduce((a, b) => a + b, 0) / sess.composites.length) : 0;
    const sColor = avg >= 4.0 ? '#22c55e' : avg >= 3.0 ? '#eab308' : '#ef4444';
    detailSections += `
    <div style="margin-top:24px">
      <h3>${sess.name} <span style="color:${sColor}">(${avg.toFixed(2)}/5.00)</span> <span style="font-size:0.8em;color:#9ca3af">[${sess.judge} judge]</span></h3>
      <table class="detail">
        <thead><tr><th>#</th><th>Question</th><th>Type</th><th>Lat.</th><th>Conc</th><th>Acc</th><th>Rel</th><th>Act</th><th>Fmt</th><th>Pro</th><th>Comp</th><th>Val</th></tr></thead>
        <tbody>${qRows}</tbody>
      </table>
    </div>`;
  }

  // Dimension breakdown bar chart (CSS bars)
  const dimBars = Object.entries(dimAvgs).map(([k, v]) => {
    const pct = Math.round((parseFloat(v) / 5) * 100);
    const weight = WEIGHTS[k] ? `(${Math.round(WEIGHTS[k] * 100)}%)` : '';
    const color = parseFloat(v) >= 4.0 ? '#22c55e' : parseFloat(v) >= 3.0 ? '#eab308' : '#ef4444';
    return `<div style="margin-bottom:8px">
      <div style="display:flex;justify-content:space-between;font-size:0.9em;margin-bottom:2px">
        <span>${k} ${weight}</span><span style="font-weight:bold;color:${color}">${v}/5.00</span>
      </div>
      <div style="background:#e5e7eb;border-radius:4px;overflow:hidden;height:16px">
        <div style="background:${color};height:100%;width:${pct}%"></div>
      </div>
    </div>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Concierge Quality Test Report</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f3f4f6; color: #1f2937; padding: 24px; }
  .container { max-width: 1300px; margin: 0 auto; }
  h1 { font-size: 1.8em; margin-bottom: 4px; }
  h2 { font-size: 1.3em; margin: 24px 0 12px; border-bottom: 2px solid #e5e7eb; padding-bottom: 6px; }
  h3 { font-size: 1.1em; margin-bottom: 8px; }
  .hero { background: white; border-radius: 12px; padding: 32px; margin-bottom: 24px; box-shadow: 0 1px 3px rgba(0,0,0,.1); text-align: center; }
  .hero .grade { font-size: 4em; font-weight: 900; }
  .hero .subtitle { color: #6b7280; margin-top: 8px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .card { background: white; border-radius: 8px; padding: 14px; text-align: center; box-shadow: 0 1px 2px rgba(0,0,0,.05); }
  .card .value { font-size: 1.5em; font-weight: 700; }
  .card .label { color: #6b7280; font-size: 0.82em; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 2px rgba(0,0,0,.05); margin-bottom: 16px; }
  th, td { padding: 6px 10px; text-align: left; border-bottom: 1px solid #f3f4f6; font-size: 0.85em; }
  th { background: #f9fafb; font-weight: 600; }
  table.detail th { font-size: 0.78em; }
  code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; font-size: 0.82em; }
  .dims-panel { background: white; border-radius: 8px; padding: 20px; box-shadow: 0 1px 2px rgba(0,0,0,.05); margin-bottom: 24px; }
  .timestamp { color: #9ca3af; font-size: 0.8em; margin-top: 24px; text-align: center; }
</style></head><body>
<div class="container">
  <div class="hero">
    <h1>Concierge Quality Stress Test</h1>
    <div class="grade" style="color:${gradeColor}">${grade}</div>
    <div style="font-size:1.4em;font-weight:600">Weighted Composite: ${avgComposite.toFixed(2)} / 5.00</div>
    <div class="subtitle">10 sessions | 52 questions | LLM-as-judge (GPT-5.4 + Claude Haiku 4.5) | 6 dimensions</div>
  </div>

  <div class="cards">
    <div class="card"><div class="value">${avgLatency}ms</div><div class="label">Avg Latency</div></div>
    <div class="card"><div class="value">${p50}ms</div><div class="label">P50 Latency</div></div>
    <div class="card"><div class="value">${p95}ms</div><div class="label">P95 Latency</div></div>
    <div class="card"><div class="value">${allComposites.filter(c => c >= 4.0).length}/${allComposites.length}</div><div class="label">Score >= 4.0</div></div>
    <div class="card"><div class="value">${allComposites.filter(c => c < 2.5).length}</div><div class="label">Score < 2.5</div></div>
  </div>

  <h2>Dimension Breakdown (Weighted)</h2>
  <div class="dims-panel">${dimBars}</div>

  <h2>Session Summary</h2>
  <table>
    <thead><tr><th>Session</th><th>Questions</th><th>Judge</th><th>Avg Composite</th><th>Bar</th></tr></thead>
    <tbody>${sessionRows}</tbody>
  </table>

  <h2>Detailed Results</h2>
  ${detailSections}

  <div class="timestamp">Generated ${new Date().toISOString()} | Concierge Quality Stress Test v1</div>
</div></body></html>`;
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('='.repeat(70));
  console.log('  CONCIERGE QUALITY STRESS TEST -- 10 Sessions, 52 Questions');
  console.log('  LLM-as-Judge: GPT-5.4 (standard) + Claude Haiku 4.5 (complex)');
  console.log('  6 Dimensions: conciseness, accuracy, relevance, actionability, formatting, proactivity');
  console.log('='.repeat(70));

  const results = {
    startTime: new Date().toISOString(),
    sessions: [],
    summary: {}
  };

  const totalSessions = SESSIONS.length;

  for (let i = 0; i < SESSIONS.length; i++) {
    if (i > 0) {
      console.log('\n  [pause] 2s between sessions...');
      await sleep(2000);
    }
    const sessionResult = await runSession(SESSIONS[i], i, totalSessions);
    results.sessions.push(sessionResult);
  }

  // Summary
  const allComposites = results.sessions.flatMap(s => s.composites);
  const avgComposite = allComposites.length
    ? allComposites.reduce((a, b) => a + b, 0) / allComposites.length
    : 0;

  const latencies = results.sessions.flatMap(s => s.questions.filter(q => q.latencyMs).map(q => q.latencyMs)).sort((a, b) => a - b);

  results.summary = {
    totalQuestions: allComposites.length,
    avgComposite: Math.round(avgComposite * 100) / 100,
    scoresAbove4: allComposites.filter(c => c >= 4.0).length,
    scoresBelow25: allComposites.filter(c => c < 2.5).length,
    avgLatencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0,
    p50LatencyMs: latencies[Math.floor(latencies.length * 0.5)] || 0,
    p95LatencyMs: latencies[Math.floor(latencies.length * 0.95)] || 0,
  };
  results.endTime = new Date().toISOString();

  // Write outputs
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
  console.log(`\nResults: ${RESULTS_PATH}`);

  fs.writeFileSync(REPORT_PATH, generateHTML(results));
  console.log(`Report: ${REPORT_PATH}`);

  // Final summary
  console.log(`\n${'='.repeat(70)}`);
  console.log(`  FINAL: Avg Composite = ${avgComposite.toFixed(2)}/5.00`);
  console.log(`  Questions: ${allComposites.length} | >= 4.0: ${results.summary.scoresAbove4} | < 2.5: ${results.summary.scoresBelow25}`);
  console.log(`  Avg Latency: ${results.summary.avgLatencyMs}ms | P95: ${results.summary.p95LatencyMs}ms`);
  console.log(`${'='.repeat(70)}`);

  console.log('\n  Per-Session:');
  for (const s of results.sessions) {
    const avg = s.composites.length ? (s.composites.reduce((a, b) => a + b, 0) / s.composites.length) : 0;
    const bar = '#'.repeat(Math.round(avg * 4)) + '.'.repeat(20 - Math.round(avg * 4));
    console.log(`    ${s.name.padEnd(30)} ${bar} ${avg.toFixed(2)}/5.00`);
  }
  console.log('');
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
