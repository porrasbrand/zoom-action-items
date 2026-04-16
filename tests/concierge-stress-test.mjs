#!/usr/bin/env node
/**
 * Concierge v3 Stress Test — 8 multi-turn sessions, 47 questions
 * Tests session continuity, factual accuracy, context retention, and edge cases.
 * Usage: node tests/concierge-stress-test.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const API_URL = 'http://localhost:3875/zoom/api/chat';
const TOKEN = '885265e0f2ce7d4e258e9a5224e5e59b9514ccbe759c5bc4ba7ad2865e720e97';
const RESULTS_PATH = path.join(__dirname, 'stress-test-results.json');
const REPORT_PATH = path.join(__dirname, 'stress-test-report.html');

// ── API Helper ──────────────────────────────────────────────────────────────

async function chat(question, sessionId = null) {
  const body = { question };
  if (sessionId) body.session_id = sessionId;
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

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Scoring ─────────────────────────────────────────────────────────────────

function scoreResponse(resp, question, opts = {}) {
  const answer = resp.answer || '';
  const words = answer.split(/\s+/).filter(Boolean).length;
  const scores = {};

  // factual (0-2): has substantive content (1pt), contains numbers/names (1pt)
  let factual = 0;
  if (words >= 5) factual++;
  const hasNumbers = /\d+/.test(answer);
  const hasNames = /\b(phil|dan|bill|juan|manuel|vince|richard|sarah|nicole|jacob|ray|jerry|isaac|ryan|lisa|pearce|echelon|prosper|bearcat|london|northern)\b/i.test(answer);
  if (hasNumbers || hasNames) factual++;
  if (opts.expectNumber && !hasNumbers) factual = Math.max(0, factual - 1);
  scores.factual = Math.min(2, factual);

  // contextRetention (0-2): for follow-up questions, check if response relates to prior context
  if (opts.isFollowUp) {
    let retention = 0;
    // If we have context keywords to check for
    if (opts.contextKeywords) {
      const found = opts.contextKeywords.filter(kw => answer.toLowerCase().includes(kw.toLowerCase()));
      retention = found.length > 0 ? 1 : 0;
      if (found.length >= 2) retention = 2;
    } else {
      // Default: if response has substance, assume context was retained
      retention = words >= 10 ? 1 : 0;
      if (words >= 30) retention = 2;
    }
    scores.contextRetention = Math.min(2, retention);
  } else {
    // First question: full marks for context (nothing to retain yet)
    scores.contextRetention = 2;
  }

  // intentMatch (0-1): correct query_type returned
  if (opts.expectedType) {
    const qt = resp.query_type || '';
    scores.intentMatch = qt.includes(opts.expectedType) ? 1 : 0;
  } else {
    scores.intentMatch = (resp.query_type && resp.query_type !== 'unknown') ? 1 : 0;
  }

  // quality (0-2): adequate length and structure
  let quality = 0;
  if (words >= 10) quality++;
  const hasStructure = /\n[-*]|\n\d\.|\*\*|##/.test(answer);
  if (words >= 25 || hasStructure) quality++;
  scores.quality = Math.min(2, quality);

  // noHallucination (0-1): no obvious fabrications
  const hallucMarkers = [
    /I made up/i, /I don't actually/i, /hypothetical/i,
    /as an AI/i, /I cannot access/i
  ];
  const hasHalluc = hallucMarkers.some(m => m.test(answer));
  // Also check: if response says "no data" or similar, that's honest (not hallucination)
  scores.noHallucination = hasHalluc ? 0 : 1;

  const total = Object.values(scores).reduce((a, b) => a + b, 0);
  return { scores, total, maxScore: 8 };
}

// ── Session Definitions ─────────────────────────────────────────────────────

const SESSIONS = [
  {
    name: 'Dan Morning Prep',
    description: 'Executive morning briefing flow: overview → client prep → sentiment → search → action items',
    questions: [
      {
        q: 'Give me a meta analysis of all our recent meetings. What are the big themes?',
        opts: { expectedType: 'meta_analysis' }
      },
      {
        q: 'I have a meeting with Pearce today. Give me a meeting prep.',
        opts: { expectedType: 'meeting_prep', isFollowUp: true, contextKeywords: ['pearce'] }
      },
      {
        q: 'What was the sentiment in their last meeting?',
        opts: { expectedType: 'sentiment', isFollowUp: true, contextKeywords: ['pearce', 'sentiment', 'positive', 'negative', 'neutral'] }
      },
      {
        q: 'Now prep me for Echelon.',
        opts: { expectedType: 'meeting_prep', isFollowUp: true, contextKeywords: ['echelon'] }
      },
      {
        q: 'Has Andrew mentioned anything about a Golden Ticket program?',
        opts: { expectedType: 'transcript_search', isFollowUp: true, contextKeywords: ['golden', 'ticket', 'andrew'] }
      },
      {
        q: 'What open action items do I still have?',
        opts: { expectedType: 'action_items', isFollowUp: true }
      }
    ]
  },
  {
    name: 'Phil Accountability',
    description: 'Accountability review: overdue counts → details → per-person → cross-client comparison',
    questions: [
      {
        q: 'How many overdue action items do we have right now?',
        opts: { expectedType: 'count', expectNumber: true }
      },
      {
        q: 'Show me those overdue items.',
        opts: { expectedType: 'action_items', isFollowUp: true, contextKeywords: ['overdue'] }
      },
      {
        q: "What are Dan's action items?",
        opts: { expectedType: 'action_items', isFollowUp: true, contextKeywords: ['dan'] }
      },
      {
        q: "What about Manuel's?",
        opts: { expectedType: 'action_items', isFollowUp: true, contextKeywords: ['manuel'] }
      },
      {
        q: 'Compare Echelon vs Prosper — which client has more engagement?',
        opts: { expectedType: 'meta_analysis', isFollowUp: true, contextKeywords: ['echelon', 'prosper'] }
      },
      {
        q: "Between those two, who's performing better overall?",
        opts: { expectedType: 'meta_analysis', isFollowUp: true, contextKeywords: ['echelon', 'prosper', 'better', 'perform'] }
      }
    ]
  },
  {
    name: 'New Team Member Onboarding',
    description: 'New hire getting oriented: client count → top clients → deep dives → comparisons',
    questions: [
      {
        q: 'How many clients do we manage?',
        opts: { expectedType: 'count', expectNumber: true }
      },
      {
        q: 'Which are our top 3 most active clients?',
        opts: { expectedType: 'meta_analysis' }
      },
      {
        q: 'Tell me about Bearcat. Give me a meeting prep.',
        opts: { expectedType: 'meeting_prep', isFollowUp: true, contextKeywords: ['bearcat'] }
      },
      {
        q: 'Who are the key people we talk to there?',
        opts: { expectedType: 'transcript_search', isFollowUp: true, contextKeywords: ['bearcat'] }
      },
      {
        q: 'Summarize their last meeting.',
        opts: { expectedType: 'meeting_summary', isFollowUp: true, contextKeywords: ['bearcat'] }
      },
      {
        q: 'Now give me a prep for London Flooring.',
        opts: { expectedType: 'meeting_prep', isFollowUp: true, contextKeywords: ['london', 'flooring'] }
      },
      {
        q: 'How does London Flooring compare to Bearcat in terms of activity?',
        opts: { expectedType: 'meta_analysis', isFollowUp: true, contextKeywords: ['london', 'bearcat'] }
      }
    ]
  },
  {
    name: 'Fire Drill Investigation',
    description: 'Urgent client issue: sentiment scan → specific client → complaint search → promises → overdue',
    questions: [
      {
        q: 'Are any of our clients unhappy? Check sentiment across the board.',
        opts: { expectedType: 'sentiment' }
      },
      {
        q: 'Give me a full summary of Northern Services meetings.',
        opts: { expectedType: 'meeting_summary', isFollowUp: true, contextKeywords: ['northern'] }
      },
      {
        q: 'Search their transcripts for any complaints or frustrations.',
        opts: { expectedType: 'transcript_search', isFollowUp: true, contextKeywords: ['northern'] }
      },
      {
        q: 'What promises have we made to them?',
        opts: { expectedType: 'transcript_search', isFollowUp: true, contextKeywords: ['northern', 'promise'] }
      },
      {
        q: 'Are there any overdue action items for Northern Services specifically?',
        opts: { expectedType: 'action_items', isFollowUp: true, contextKeywords: ['northern', 'overdue'] }
      }
    ]
  },
  {
    name: 'Cross-Meeting Topic Tracking',
    description: 'Tracking topics across time and clients: SEO → website → hiring → budget → pricing → timeline',
    questions: [
      {
        q: 'When was SEO last discussed in London Flooring meetings?',
        opts: { expectedType: 'temporal' }
      },
      {
        q: 'What about their website — any recent discussions?',
        opts: { expectedType: 'temporal', isFollowUp: true, contextKeywords: ['london', 'flooring', 'website'] }
      },
      {
        q: 'Has hiring come up in Echelon meetings recently?',
        opts: { expectedType: 'temporal', isFollowUp: true, contextKeywords: ['echelon', 'hir'] }
      },
      {
        q: 'What about budget discussions at Prosper?',
        opts: { expectedType: 'temporal', isFollowUp: true, contextKeywords: ['prosper', 'budget'] }
      },
      {
        q: 'Has pricing been discussed across any clients recently?',
        opts: { expectedType: 'temporal', isFollowUp: true, contextKeywords: ['pric'] }
      },
      {
        q: "Give me a timeline of Echelon's budget conversations.",
        opts: { expectedType: 'temporal', isFollowUp: true, contextKeywords: ['echelon', 'budget'] }
      }
    ]
  },
  {
    name: 'Rapid Fire Factual',
    description: 'Quick factual questions testing speed and accuracy',
    questions: [
      {
        q: 'How many meetings have we had with London Flooring?',
        opts: { expectedType: 'count', expectNumber: true }
      },
      {
        q: 'Summarize the last one.',
        opts: { expectedType: 'meeting_summary', isFollowUp: true, contextKeywords: ['london', 'flooring'] }
      },
      {
        q: 'How long was that meeting?',
        opts: { expectedType: 'meeting_summary', isFollowUp: true, expectNumber: true }
      },
      {
        q: 'How many open action items does Echelon have?',
        opts: { expectedType: 'count', expectNumber: true }
      },
      {
        q: 'Who owns the most action items across all clients?',
        opts: { expectedType: 'meta_analysis', isFollowUp: true }
      },
      {
        q: 'How many total meetings have happened this month?',
        opts: { expectedType: 'count', expectNumber: true }
      }
    ]
  },
  {
    name: 'Adversarial Edge Cases',
    description: 'Testing robustness with vague, malformed, and edge-case queries',
    questions: [
      {
        q: "What's going on?",
        opts: {}
      },
      {
        q: 'meetings',
        opts: {}
      },
      {
        q: 'Tell me everything about every client we have ever worked with in complete detail.',
        opts: {}
      },
      {
        q: 'What happened in meetings on February 30th, 2025?',
        opts: {}
      },
      {
        q: 'Compare all clients against each other on every metric.',
        opts: { expectedType: 'meta_analysis' }
      },
      {
        q: 'How good are you at answering questions? Rate yourself.',
        opts: {}
      }
    ]
  },
  {
    name: 'Real Dan Patterns',
    description: 'Simulating how Dan actually uses the concierge — terse, contextual, rapid',
    questions: [
      {
        q: 'Pearce',
        opts: {}
      },
      {
        q: 'How many sessions have they had?',
        opts: { isFollowUp: true, expectNumber: true, contextKeywords: ['pearce'] }
      },
      {
        q: 'Prep me for their next meeting.',
        opts: { expectedType: 'meeting_prep', isFollowUp: true, contextKeywords: ['pearce'] }
      },
      {
        q: 'How has their sentiment trended?',
        opts: { expectedType: 'sentiment', isFollowUp: true, contextKeywords: ['pearce', 'sentiment'] }
      },
      {
        q: 'Big picture — how are we doing across the board?',
        opts: { expectedType: 'meta_analysis', isFollowUp: true }
      }
    ]
  }
];

// ── Runner ──────────────────────────────────────────────────────────────────

async function runSession(session, sessionIndex) {
  const sessionResult = {
    name: session.name,
    description: session.description,
    sessionId: null,
    questions: [],
    totalScore: 0,
    maxScore: 0,
    startTime: new Date().toISOString()
  };

  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  SESSION ${sessionIndex + 1}/8: ${session.name}`);
  console.log(`  ${session.description}`);
  console.log(`${'═'.repeat(70)}`);

  for (let i = 0; i < session.questions.length; i++) {
    const { q, opts } = session.questions[i];
    const qNum = i + 1;

    try {
      const resp = await chat(q, sessionResult.sessionId);

      // Capture session_id from first response
      if (!sessionResult.sessionId && resp.session_id) {
        sessionResult.sessionId = resp.session_id;
      }

      const scoring = scoreResponse(resp, q, opts);
      const answer = resp.answer || '';
      const preview = answer.substring(0, 120).replace(/\n/g, ' ');

      const qResult = {
        questionNum: qNum,
        question: q,
        answer: answer,
        queryType: resp.query_type,
        latencyMs: resp._latency,
        sessionId: resp.session_id,
        citationCount: (resp.citations || []).length,
        modelUsed: resp.model_used,
        tokensUsed: resp.tokens_used,
        chunksUsed: resp.chunks_used,
        scoring
      };

      sessionResult.questions.push(qResult);
      sessionResult.totalScore += scoring.total;
      sessionResult.maxScore += scoring.maxScore;

      const pct = Math.round((scoring.total / scoring.maxScore) * 100);
      const bar = pct >= 75 ? '++' : pct >= 50 ? '+ ' : '--';
      console.log(`  [${bar}] Q${qNum}/${session.questions.length} (${scoring.total}/${scoring.maxScore} = ${pct}%) [${resp._latency}ms] ${resp.query_type}`);
      console.log(`       Q: ${q}`);
      console.log(`       A: ${preview}...`);

      // Print individual score breakdown
      const s = scoring.scores;
      console.log(`       Scores: fact=${s.factual} ctx=${s.contextRetention} intent=${s.intentMatch} qual=${s.quality} halluc=${s.noHallucination}`);

    } catch (err) {
      console.log(`  [!!] Q${qNum}/${session.questions.length} ERROR: ${err.message}`);
      sessionResult.questions.push({
        questionNum: qNum,
        question: q,
        error: err.message,
        scoring: { scores: { factual: 0, contextRetention: 0, intentMatch: 0, quality: 0, noHallucination: 0 }, total: 0, maxScore: 8 }
      });
      sessionResult.maxScore += 8;
    }

    // 500ms between questions
    if (i < session.questions.length - 1) {
      await sleep(500);
    }
  }

  sessionResult.endTime = new Date().toISOString();
  const sessionPct = Math.round((sessionResult.totalScore / sessionResult.maxScore) * 100);
  console.log(`  ── Session Score: ${sessionResult.totalScore}/${sessionResult.maxScore} (${sessionPct}%)`);

  return sessionResult;
}

// ── HTML Report Generator ───────────────────────────────────────────────────

function generateHTML(results) {
  const totalScore = results.sessions.reduce((a, s) => a + s.totalScore, 0);
  const maxScore = results.sessions.reduce((a, s) => a + s.maxScore, 0);
  const overallPct = Math.round((totalScore / maxScore) * 100);

  const gradeColor = overallPct >= 80 ? '#22c55e' : overallPct >= 60 ? '#eab308' : '#ef4444';
  const grade = overallPct >= 90 ? 'A' : overallPct >= 80 ? 'B' : overallPct >= 70 ? 'C' : overallPct >= 60 ? 'D' : 'F';

  // Compute dimension averages
  const dims = { factual: [], contextRetention: [], intentMatch: [], quality: [], noHallucination: [] };
  for (const sess of results.sessions) {
    for (const q of sess.questions) {
      if (q.scoring && q.scoring.scores) {
        for (const k of Object.keys(dims)) {
          if (q.scoring.scores[k] !== undefined) dims[k].push(q.scoring.scores[k]);
        }
      }
    }
  }
  const dimAvgs = {};
  for (const [k, arr] of Object.entries(dims)) {
    dimAvgs[k] = arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2) : '0';
  }

  // Latency stats
  const latencies = [];
  for (const sess of results.sessions) {
    for (const q of sess.questions) {
      if (q.latencyMs) latencies.push(q.latencyMs);
    }
  }
  latencies.sort((a, b) => a - b);
  const avgLatency = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
  const p50 = latencies[Math.floor(latencies.length * 0.5)] || 0;
  const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
  const maxLatency = latencies[latencies.length - 1] || 0;

  let sessionRows = '';
  for (const sess of results.sessions) {
    const pct = Math.round((sess.totalScore / sess.maxScore) * 100);
    const color = pct >= 80 ? '#22c55e' : pct >= 60 ? '#eab308' : '#ef4444';
    sessionRows += `<tr>
      <td><strong>${sess.name}</strong></td>
      <td>${sess.questions.length}</td>
      <td>${sess.totalScore}/${sess.maxScore}</td>
      <td style="color:${color};font-weight:bold">${pct}%</td>
      <td><div style="background:#e5e7eb;border-radius:4px;overflow:hidden;height:20px">
        <div style="background:${color};height:100%;width:${pct}%"></div></div></td>
    </tr>`;
  }

  let detailSections = '';
  for (const sess of results.sessions) {
    let qRows = '';
    for (const q of sess.questions) {
      const sc = q.scoring || {};
      const pct = sc.maxScore ? Math.round((sc.total / sc.maxScore) * 100) : 0;
      const color = pct >= 75 ? '#22c55e' : pct >= 50 ? '#eab308' : '#ef4444';
      const scores = sc.scores || {};
      const ansPreview = (q.answer || q.error || 'N/A').substring(0, 200).replace(/</g, '&lt;').replace(/\n/g, '<br>');
      qRows += `<tr>
        <td>Q${q.questionNum}</td>
        <td style="max-width:250px">${q.question}</td>
        <td><code>${q.queryType || 'err'}</code></td>
        <td>${q.latencyMs || '-'}ms</td>
        <td>${scores.factual ?? '-'}</td>
        <td>${scores.contextRetention ?? '-'}</td>
        <td>${scores.intentMatch ?? '-'}</td>
        <td>${scores.quality ?? '-'}</td>
        <td>${scores.noHallucination ?? '-'}</td>
        <td style="color:${color};font-weight:bold">${sc.total || 0}/${sc.maxScore || 8}</td>
      </tr>
      <tr><td colspan="10" style="background:#f9fafb;font-size:0.85em;padding:6px 12px">${ansPreview}</td></tr>`;
    }
    const sPct = Math.round((sess.totalScore / sess.maxScore) * 100);
    detailSections += `
    <div style="margin-top:24px">
      <h3>${sess.name} <span style="color:${sPct >= 80 ? '#22c55e' : sPct >= 60 ? '#eab308' : '#ef4444'}">(${sPct}%)</span></h3>
      <p style="color:#6b7280;margin-bottom:8px">${sess.description}</p>
      <table class="detail">
        <thead><tr><th>#</th><th>Question</th><th>Type</th><th>Latency</th><th>Fact</th><th>Ctx</th><th>Intent</th><th>Qual</th><th>Halluc</th><th>Total</th></tr></thead>
        <tbody>${qRows}</tbody>
      </table>
    </div>`;
  }

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Concierge v3 Stress Test Report</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f3f4f6; color: #1f2937; padding: 24px; }
  .container { max-width: 1200px; margin: 0 auto; }
  h1 { font-size: 1.8em; margin-bottom: 4px; }
  h2 { font-size: 1.3em; margin: 24px 0 12px; border-bottom: 2px solid #e5e7eb; padding-bottom: 6px; }
  h3 { font-size: 1.1em; margin-bottom: 8px; }
  .hero { background: white; border-radius: 12px; padding: 32px; margin-bottom: 24px; box-shadow: 0 1px 3px rgba(0,0,0,.1); text-align: center; }
  .hero .grade { font-size: 4em; font-weight: 900; }
  .hero .subtitle { color: #6b7280; margin-top: 8px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .card { background: white; border-radius: 8px; padding: 16px; text-align: center; box-shadow: 0 1px 2px rgba(0,0,0,.05); }
  .card .value { font-size: 1.6em; font-weight: 700; }
  .card .label { color: #6b7280; font-size: 0.85em; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; background: white; border-radius: 8px; overflow: hidden; box-shadow: 0 1px 2px rgba(0,0,0,.05); margin-bottom: 16px; }
  th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #f3f4f6; font-size: 0.9em; }
  th { background: #f9fafb; font-weight: 600; }
  table.detail th { font-size: 0.8em; }
  code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; font-size: 0.85em; }
  .timestamp { color: #9ca3af; font-size: 0.8em; margin-top: 24px; text-align: center; }
</style></head><body>
<div class="container">
  <div class="hero">
    <h1>Concierge v3 Stress Test</h1>
    <div class="grade" style="color:${gradeColor}">${grade}</div>
    <div style="font-size:1.4em;font-weight:600">${totalScore} / ${maxScore} (${overallPct}%)</div>
    <div class="subtitle">8 sessions | 47 questions | multi-turn context testing</div>
  </div>

  <div class="cards">
    <div class="card"><div class="value">${avgLatency}ms</div><div class="label">Avg Latency</div></div>
    <div class="card"><div class="value">${p50}ms</div><div class="label">P50 Latency</div></div>
    <div class="card"><div class="value">${p95}ms</div><div class="label">P95 Latency</div></div>
    <div class="card"><div class="value">${maxLatency}ms</div><div class="label">Max Latency</div></div>
    <div class="card"><div class="value">${dimAvgs.factual}/2</div><div class="label">Avg Factual</div></div>
    <div class="card"><div class="value">${dimAvgs.contextRetention}/2</div><div class="label">Avg Context</div></div>
    <div class="card"><div class="value">${dimAvgs.intentMatch}/1</div><div class="label">Avg Intent</div></div>
    <div class="card"><div class="value">${dimAvgs.quality}/2</div><div class="label">Avg Quality</div></div>
    <div class="card"><div class="value">${dimAvgs.noHallucination}/1</div><div class="label">Avg No-Halluc</div></div>
  </div>

  <h2>Session Summary</h2>
  <table>
    <thead><tr><th>Session</th><th>Questions</th><th>Score</th><th>Pct</th><th>Bar</th></tr></thead>
    <tbody>${sessionRows}</tbody>
  </table>

  <h2>Detailed Results</h2>
  ${detailSections}

  <div class="timestamp">Generated ${new Date().toISOString()} | Concierge v3 Stress Test</div>
</div></body></html>`;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║          CONCIERGE v3 STRESS TEST — 8 Sessions, 47 Questions       ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');

  const results = {
    startTime: new Date().toISOString(),
    sessions: [],
    summary: {}
  };

  for (let i = 0; i < SESSIONS.length; i++) {
    if (i > 0) {
      console.log('\n  [pause] 2s between sessions...');
      await sleep(2000);
    }
    const sessionResult = await runSession(SESSIONS[i], i);
    results.sessions.push(sessionResult);
  }

  // Summary
  const totalScore = results.sessions.reduce((a, s) => a + s.totalScore, 0);
  const maxScore = results.sessions.reduce((a, s) => a + s.maxScore, 0);
  const overallPct = Math.round((totalScore / maxScore) * 100);
  const totalQuestions = results.sessions.reduce((a, s) => a + s.questions.length, 0);

  const latencies = [];
  for (const s of results.sessions) {
    for (const q of s.questions) {
      if (q.latencyMs) latencies.push(q.latencyMs);
    }
  }
  latencies.sort((a, b) => a - b);

  results.summary = {
    totalQuestions,
    totalScore,
    maxScore,
    overallPercent: overallPct,
    avgLatencyMs: latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0,
    p50LatencyMs: latencies[Math.floor(latencies.length * 0.5)] || 0,
    p95LatencyMs: latencies[Math.floor(latencies.length * 0.95)] || 0,
    maxLatencyMs: latencies[latencies.length - 1] || 0
  };
  results.endTime = new Date().toISOString();

  // Write results
  fs.writeFileSync(RESULTS_PATH, JSON.stringify(results, null, 2));
  console.log(`\nResults written to ${RESULTS_PATH}`);

  // Write HTML report
  fs.writeFileSync(REPORT_PATH, generateHTML(results));
  console.log(`Report written to ${REPORT_PATH}`);

  // Final summary
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  FINAL SCORE: ${totalScore}/${maxScore} (${overallPct}%)`);
  console.log(`  Questions: ${totalQuestions} | Avg Latency: ${results.summary.avgLatencyMs}ms | P95: ${results.summary.p95LatencyMs}ms`);
  console.log(`${'═'.repeat(70)}`);

  // Per-session summary
  console.log('\n  Per-Session Breakdown:');
  for (const s of results.sessions) {
    const pct = Math.round((s.totalScore / s.maxScore) * 100);
    const bar = '█'.repeat(Math.round(pct / 5)) + '░'.repeat(20 - Math.round(pct / 5));
    console.log(`    ${s.name.padEnd(30)} ${bar} ${pct}% (${s.totalScore}/${s.maxScore})`);
  }
  console.log('');
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
