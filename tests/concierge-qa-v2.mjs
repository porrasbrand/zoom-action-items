#!/usr/bin/env node
/**
 * Concierge QA v2 — Comprehensive test suite for rebuilt RAG (R1-R3)
 * Usage: node tests/concierge-qa-v2.mjs
 */

import 'dotenv/config';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '../data/zoom-action-items.db');
const REPORT_PATH = path.join(__dirname, '../data/concierge-qa-v2-report.md');
const API_BASE = 'http://localhost:3875/zoom/api';
const TOKEN = '885265e0f2ce7d4e258e9a5224e5e59b9514ccbe759c5bc4ba7ad2865e720e97';

const db = new Database(DB_PATH);
const results = [];

async function chat(question, clientId = null, sessionId = null) {
  const body = { question };
  if (clientId) body.client_id = clientId;
  if (sessionId) body.session_id = sessionId;
  const res = await fetch(`${API_BASE}/chat`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

async function brief(clientId) {
  db.prepare("DELETE FROM client_briefs WHERE client_id = ?").run(clientId);
  const res = await fetch(`${API_BASE}/chat/brief`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId })
  });
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

function score(answer, citations, queryType, extra = {}) {
  const s = {};
  const hasDate = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2}/i.test(answer);
  const hasSpeaker = /\b(phil|dan|bill|juan|manuel|vince|richard|sarah|nicole|jacob|ray|jerry|isaac|ryan|lisa|dr\.?\s*\w+)/i.test(answer);
  const hasMeeting = /meeting|session|call|huddle/i.test(answer);
  s.grounding = Math.min(5, Math.round(1 + (hasDate ? 1.5 : 0) + (hasSpeaker ? 1 : 0) + (hasMeeting ? 0.5 : 0) + (citations.length > 0 ? 1 : 0)));

  const words = answer.split(/\s+/).length;
  s.completeness = words < 15 ? 2 : words < 40 ? 3 : words < 150 ? 4 : words < 600 ? 5 : 4;

  const hasStructure = /\n-|\n\d\.|\*\*/.test(answer);
  s.tone = Math.min(5, Math.round(3 + (hasStructure ? 1 : 0) + (words <= 500 ? 1 : -1)));

  s.accuracy = extra.verified ? 5 : (answer.includes("don't have") || answer.includes('no information') ? 4 : 3);
  s.temporal = extra.temporalCorrect !== undefined ? (extra.temporalCorrect ? 5 : 2) : 4;

  for (const k in s) s[k] = Math.max(1, Math.min(5, s[k]));
  return s;
}

function avgScores(s) {
  const vals = Object.values(s);
  return (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1);
}

async function test(id, cat, question, clientId, opts = {}) {
  const start = Date.now();
  try {
    const d = await chat(question, clientId, opts.sessionId);
    const elapsed = Date.now() - start;

    // Temporal verification
    let temporalCorrect = undefined;
    if (opts.expectedDate) {
      temporalCorrect = d.answer.toLowerCase().includes(opts.expectedDate.toLowerCase());
    }

    const verified = opts.verifyFn ? opts.verifyFn(d.answer) : undefined;
    const s = score(d.answer, d.citations || [], d.query_type, { temporalCorrect, verified });
    const avg = avgScores(s);

    const icon = avg >= 4 ? '✅' : avg >= 3 ? '⚠️' : '❌';
    console.log(`  ${icon} ${id}: ${question.slice(0, 50)}... (${avg}/5, ${d.model_used === 'cache' ? 'CACHE' : elapsed + 'ms'})`);

    const r = { id, cat, question: question.slice(0, 80), scores: s, model: d.model_used, tokens: d.tokens_used, latency: elapsed, sessionId: d.session_id, answerPreview: d.answer.slice(0, 200), issues: [] };
    if (opts.expectCache && d.model_used !== 'cache') r.issues.push('Expected cache but got LLM');
    if (opts.expectLLM && d.model_used === 'cache') r.issues.push('Expected LLM but got cache');
    results.push(r);
    return r;
  } catch (e) {
    console.log(`  ❌ ${id}: ERROR - ${e.message}`);
    results.push({ id, cat, question, scores: { grounding: 1, accuracy: 1, completeness: 1, tone: 1, temporal: 1 }, error: e.message, issues: [e.message] });
    return null;
  }
}

async function main() {
  console.log('\n🤖 Concierge QA v2 — Comprehensive Test Suite\n');

  const C1 = 'london-flooring', C1N = 'London Flooring';
  const C2 = 'gs-home-services', C2N = 'GS Home Services';
  const C3 = 'prosper-group', C3N = 'Prosper Group';

  // Get latest meeting dates for verification
  const c1Latest = db.prepare("SELECT start_time FROM meetings WHERE client_id=? ORDER BY start_time DESC LIMIT 1").get(C1);
  const c1Date = c1Latest?.start_time ? new Date(c1Latest.start_time).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';

  // ===== A. TEMPORAL (8 tests) =====
  console.log('📅 A. Temporal / Recency');
  await test('A1', 'Temporal', `What was discussed in the last meeting with ${C1N}?`, C1, { expectedDate: 'Apr 14' });
  await test('A2', 'Temporal', `When was the last meeting with ${C2N}?`, C2, { expectedDate: 'Apr 14' });
  await test('A3', 'Temporal', `What happened in the ${C3N} meeting in early April?`, C3);
  await test('A4', 'Temporal', `Compare the last two meetings with ${C1N}`, C1);
  await test('A5', 'Temporal', `What was discussed with ${C2N} in March?`, C2);
  await test('A6', 'Temporal', `What changed since the previous meeting with ${C3N}?`, C3);
  await test('A7', 'Temporal', `Has anything been discussed with ${C1N} this week?`, C1);
  await test('A8', 'Temporal', `What was the earliest meeting with ${C2N} about?`, C2);

  // ===== B. TOPIC SEARCH (6 tests) =====
  console.log('\n🔍 B. Topic Search');
  await test('B1', 'Topic', `What did Phil say about email marketing with ${C1N}?`, C1);
  await test('B2', 'Topic', `Has ${C2N} ever mentioned budget or pricing?`, C2);
  await test('B3', 'Topic', `What concerns has the client raised with ${C3N}?`, C3);
  await test('B4', 'Topic', `Did anyone discuss lead generation with ${C2N}?`, C2);
  await test('B5', 'Topic', `What did Phil say in the last meeting with ${C1N}?`, C1);
  await test('B6', 'Topic', `Were there any issues or problems discussed with ${C3N}?`, C3);

  // ===== C. ACTION ITEMS (5 tests) =====
  console.log('\n📌 C. Action Items');
  await test('C1', 'Actions', `What action items are open for ${C1N}?`, C1);
  await test('C2', 'Actions', `What items are on the agenda for ${C2N}?`, C2);
  await test('C3', 'Actions', `What has been completed for ${C3N}?`, C3);
  await test('C4', 'Actions', 'Who has the most open tasks across all clients?', null);
  await test('C5', 'Actions', `Are there any overdue items for ${C1N}?`, C1);

  // ===== D. SESSION SCORES (4 tests) =====
  console.log('\n📈 D. Session Intelligence');
  await test('D1', 'Session', `How is the sentiment trending for ${C1N}?`, C1);
  await test('D2', 'Session', `What are the session scores for ${C2N}?`, C2);
  await test('D3', 'Session', `Is ${C3N} at risk? Any warning signs?`, C3);
  await test('D4', 'Session', 'Which client has the lowest engagement scores?', null);

  // ===== E. BRIEFS (3 tests) =====
  console.log('\n📋 E. Client Briefs');
  for (const [id, cid, label] of [['E1', C1, '7 meetings'], ['E2', C3, '7 meetings'], ['E3', 'northern-services', '1 meeting']]) {
    try {
      const b = await brief(cid);
      const sections = (b.brief?.match(/###/g) || []).length;
      const words = b.brief?.split(/\s+/).length || 0;
      const s = { grounding: sections >= 3 ? 5 : 3, accuracy: 4, completeness: sections >= 4 ? 5 : 3, tone: words > 100 && words < 1000 ? 5 : 3, temporal: 4 };
      const avg = avgScores(s);
      console.log(`  ${avg >= 4 ? '✅' : '⚠️'} ${id}: Brief for ${cid} (${avg}/5, ${words}w, ${sections} sections, ${b.latency_ms}ms)`);
      results.push({ id, cat: 'Brief', question: `Brief for ${cid} (${label})`, scores: s, tokens: b.tokens_used, latency: b.latency_ms, issues: [] });
    } catch (e) {
      console.log(`  ❌ ${id}: ${e.message}`);
      results.push({ id, cat: 'Brief', scores: { grounding: 1, accuracy: 1, completeness: 1, tone: 1, temporal: 1 }, error: e.message, issues: [e.message] });
    }
  }

  // ===== F. CROSS-CLIENT (4 tests) =====
  console.log('\n🌐 F. Cross-Client');
  await test('F1', 'Cross', 'What was the most common topic across all meetings this month?', null);
  await test('F2', 'Cross', 'Which clients had meetings this week?', null);
  await test('F3', 'Cross', 'How many total open action items are there?', null);
  await test('F4', 'Cross', 'Give me a status update across all clients', null);

  // ===== G. CONVERSATION CONTINUITY (3 tests) =====
  console.log('\n🔄 G. Continuity');
  const g1 = await test('G1', 'Continuity', `What was discussed in the last meeting with ${C1N}?`, C1);
  if (g1) await test('G2', 'Continuity', 'Tell me more about the main topic', C1, { sessionId: g1.sessionId });
  if (g1) await test('G3', 'Continuity', 'What action items came from it?', C1, { sessionId: g1.sessionId });

  // ===== H. EDGE CASES (6 tests) =====
  console.log('\n🧪 H. Edge Cases');
  await test('H1', 'Edge', 'What about ABC Corp? What meetings have they had?', null);
  await test('H2', 'Edge', 'What about Londn Flooring?', null);
  await test('H3', 'Edge', 'Tell me everything', null);
  await test('H4', 'Edge', 'asdfghjkl', null);
  await test('H5', 'Edge', 'This is a very long question '.repeat(10) + 'what was the last meeting about?', null);
  await test('H6', 'Edge', 'How does this concierge work? What technology is behind it?', null);

  // ===== I. CACHE ROUTING (4 tests) =====
  console.log('\n⚡ I. Cache Routing');
  await test('I1', 'Cache', `What was discussed in the last meeting with ${C2N}?`, C2, { expectCache: true });
  await test('I2', 'Cache', `What action items came from the last meeting with ${C3N}?`, C3, { expectCache: true });
  await test('I3', 'Cache', `What specific words did Phil use about the storyboard with ${C1N}?`, C1, { expectLLM: true });
  await test('I4', 'Cache', `Compare the last 3 meetings with ${C1N}`, C1, { expectLLM: true });

  // ===== REPORT =====
  const dims = ['grounding', 'accuracy', 'completeness', 'tone', 'temporal'];
  const cats = ['Temporal', 'Topic', 'Actions', 'Session', 'Brief', 'Cross', 'Continuity', 'Edge', 'Cache'];
  const allScores = results.map(r => r.scores);

  const dimAvgs = {};
  dims.forEach(d => dimAvgs[d] = (allScores.reduce((sum, s) => sum + s[d], 0) / allScores.length).toFixed(1));
  const overall = (allScores.flatMap(s => Object.values(s)).reduce((a, b) => a + b, 0) / (allScores.length * dims.length)).toFixed(1);

  const catAvgs = {};
  cats.forEach(c => {
    const catResults = results.filter(r => r.cat === c);
    if (catResults.length === 0) return;
    catAvgs[c] = (catResults.flatMap(r => Object.values(r.scores)).reduce((a, b) => a + b, 0) / (catResults.length * dims.length)).toFixed(1);
  });

  const cacheTests = results.filter(r => r.cat === 'Cache');
  const cacheCorrect = cacheTests.filter(r => r.issues.length === 0).length;

  let report = `# Concierge QA v2 Report\nGenerated: ${new Date().toISOString()}\nModel: ${results[0]?.model || 'unknown'}\n\n## Summary\n- Tests: ${results.length}\n- Overall: **${overall}/5**\n`;
  dims.forEach(d => { report += `- ${d}: ${dimAvgs[d]}/5\n`; });
  report += `- Cache routing: ${cacheCorrect}/${cacheTests.length} correct\n- Errors: ${results.filter(r => r.error).length}\n\n`;

  report += `## Per-Category Scores\n`;
  Object.entries(catAvgs).forEach(([c, avg]) => { report += `- **${c}**: ${avg}/5\n`; });

  report += `\n## Detailed Results\n`;
  for (const cat of cats) {
    const catResults = results.filter(r => r.cat === cat);
    if (catResults.length === 0) continue;
    report += `\n### ${cat}\n`;
    for (const r of catResults) {
      const avg = avgScores(r.scores);
      report += `- ${avg >= 4 ? '✅' : avg >= 3 ? '⚠️' : '❌'} **${r.id}**: ${r.question || 'N/A'} → **${avg}/5**`;
      if (r.model) report += ` (${r.model === 'cache' ? 'CACHE' : r.model})`;
      if (r.issues?.length > 0) report += ` ⚠️ ${r.issues.join('; ')}`;
      report += `\n`;
    }
  }

  const issues = results.filter(r => parseFloat(avgScores(r.scores)) < 3 || r.error || r.issues?.length > 0);
  if (issues.length > 0) {
    report += `\n## Issues\n`;
    issues.forEach(r => { report += `- ${r.id}: ${r.error || r.issues?.join('; ') || 'Low score'}\n`; });
  }

  fs.writeFileSync(REPORT_PATH, report);

  console.log('\n' + '='.repeat(50));
  console.log(`📊 QA v2 Complete: ${results.length} tests`);
  dims.forEach(d => console.log(`   ${d}: ${dimAvgs[d]}/5`));
  console.log(`   Overall: ${overall}/5`);
  console.log(`   Cache routing: ${cacheCorrect}/${cacheTests.length}`);
  Object.entries(catAvgs).forEach(([c, avg]) => { if (parseFloat(avg) < 3.5) console.log(`   ⚠️ ${c} below 3.5: ${avg}/5`); });
  console.log('='.repeat(50));
  console.log(`📄 Report: ${REPORT_PATH}\n`);

  db.close();
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
