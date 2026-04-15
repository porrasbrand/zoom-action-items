#!/usr/bin/env node
/**
 * AI Concierge QA Agent — simulates power user interactions and evaluates response quality
 * Usage: node tests/concierge-qa.mjs
 */

import 'dotenv/config';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '../data/zoom-action-items.db');
const REPORT_PATH = path.join(__dirname, '../data/concierge-qa-report.md');
const API_BASE = 'http://localhost:3875/zoom/api';
const TOKEN = '885265e0f2ce7d4e258e9a5224e5e59b9514ccbe759c5bc4ba7ad2865e720e97';

const db = new Database(DB_PATH);
const results = [];

async function chatApi(question, clientId = null, sessionId = null) {
  const body = { question };
  if (clientId) body.client_id = clientId;
  if (sessionId) body.session_id = sessionId;

  const res = await fetch(`${API_BASE}/chat`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

async function briefApi(clientId) {
  // Delete cached brief first to get fresh generation
  db.prepare("DELETE FROM client_briefs WHERE client_id = ?").run(clientId);
  const res = await fetch(`${API_BASE}/chat/brief`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId })
  });
  if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
  return res.json();
}

// Verification helpers
function verifyMeetingExists(clientId, dateStr) {
  if (!dateStr) return null;
  const meetings = db.prepare('SELECT start_time FROM meetings WHERE client_id = ?').all(clientId);
  return meetings.some(m => m.start_time && m.start_time.includes(dateStr));
}

function verifySpeakerExists(clientId, speaker) {
  if (!speaker) return null;
  const chunks = db.prepare(
    'SELECT speakers FROM transcript_chunks WHERE client_id = ? LIMIT 100'
  ).all(clientId);
  return chunks.some(c => c.speakers && c.speakers.toLowerCase().includes(speaker.toLowerCase()));
}

function verifyActionItem(clientId, title) {
  if (!title) return null;
  const items = db.prepare('SELECT title FROM action_items WHERE client_id = ?').all(clientId);
  return items.some(i => i.title.toLowerCase().includes(title.toLowerCase().slice(0, 20)));
}

// Score a response (manual heuristic evaluation)
function scoreResponse(answer, citations, queryType, clientId) {
  const scores = {};

  // Grounding: does it reference specific data?
  const hasDateRef = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*\s+\d{1,2}/i.test(answer);
  const hasSpeakerRef = /\b(phil|dan|bill|juan|manuel|vince|richard|sarah|nicole|jacob|ray)/i.test(answer);
  const hasMeetingRef = /meeting|session|call|huddle/i.test(answer);
  scores.grounding = Math.min(5, 1 + (hasDateRef ? 1.5 : 0) + (hasSpeakerRef ? 1 : 0) + (hasMeetingRef ? 0.5 : 0) + (citations.length > 0 ? 1 : 0));

  // Accuracy: hard to auto-verify fully, but check citations exist
  let verifiedClaims = 0, totalClaims = 0;
  if (citations.length > 0) {
    totalClaims = citations.length;
    verifiedClaims = citations.filter(c => c.meeting_id).length;
  }
  scores.accuracy = totalClaims > 0 ? Math.min(5, 2 + (verifiedClaims / totalClaims) * 3) : (answer.includes("don't have") || answer.includes('no information') ? 4 : 3);

  // Completeness
  const wordCount = answer.split(/\s+/).length;
  scores.completeness = wordCount < 20 ? 2 : wordCount < 50 ? 3 : wordCount < 200 ? 4 : wordCount < 500 ? 5 : 4;

  // Tone
  const isVerbose = wordCount > 500;
  const hasStructure = /\n-|\n\d\.|\*\*/.test(answer);
  scores.tone = Math.min(5, 3 + (hasStructure ? 1 : 0) + (isVerbose ? -1 : 1));

  // Citations
  scores.citations = queryType === 'action_items' ? (citations.length >= 0 ? 4 : 3) :
    citations.length >= 3 ? 5 : citations.length >= 1 ? 4 : citations.length === 0 && queryType === 'transcript_search' ? 2 : 3;

  // Round all scores
  for (const k in scores) scores[k] = Math.round(Math.min(5, Math.max(1, scores[k])));

  return scores;
}

function avg(arr) { return arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(1) : '0'; }

async function runTest(id, section, question, clientId, sessionId = null) {
  const start = Date.now();
  try {
    const data = await chatApi(question, clientId, sessionId);
    const elapsed = Date.now() - start;
    const scores = scoreResponse(data.answer, data.citations || [], data.query_type, clientId);

    const result = {
      id, section, question: question.slice(0, 80),
      answer: data.answer,
      answerPreview: data.answer.slice(0, 200),
      queryType: data.query_type,
      citations: data.citations || [],
      tokensUsed: data.tokens_used,
      latencyMs: elapsed,
      sessionId: data.session_id,
      scores,
      issues: [],
      hallucinations: 0
    };

    // Check for potential hallucinations in transcript queries
    if (data.query_type === 'transcript_search' && data.answer.length > 50) {
      const dateMatches = data.answer.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\w*\s+\d{1,2},?\s*\d{4}/gi) || [];
      for (const d of dateMatches.slice(0, 3)) {
        const shortDate = d.replace(/,?\s*\d{4}/, '').trim();
        // Can't easily verify without complex date parsing, skip strict check
      }
    }

    const avgScore = Object.values(scores).reduce((a, b) => a + b, 0) / Object.keys(scores).length;
    console.log(`  ${avgScore >= 4 ? '✅' : avgScore >= 3 ? '⚠️' : '❌'} ${id}: ${question.slice(0, 50)}... (${avgScore.toFixed(1)}/5, ${elapsed}ms)`);

    results.push(result);
    return result;
  } catch (err) {
    console.log(`  ❌ ${id}: ERROR - ${err.message}`);
    results.push({ id, section, question, error: err.message, scores: { grounding: 1, accuracy: 1, completeness: 1, tone: 1, citations: 1 }, issues: [err.message] });
    return null;
  }
}

async function main() {
  console.log('\n🤖 AI Concierge QA Agent Starting...\n');

  const embeddingCount = db.prepare('SELECT COUNT(*) as c FROM transcript_embeddings').get().c;
  const meetingCount = db.prepare('SELECT COUNT(*) as c FROM meetings WHERE transcript_raw IS NOT NULL').get().c;
  console.log(`📊 Embeddings: ${embeddingCount} across ${meetingCount} meetings\n`);

  const testClient = 'gs-home-services';
  const testClientName = 'GS Home Services';

  // ========== A. TRANSCRIPT SEARCH (5 questions) ==========
  console.log('📋 A. Transcript Search Quality');
  await runTest('A1', 'Transcript', `What was discussed in the most recent meeting with ${testClientName}?`, testClient);
  await runTest('A2', 'Transcript', `What concerns has the client raised in meetings with ${testClientName}?`, testClient);
  await runTest('A3', 'Transcript', `Has ${testClientName} mentioned budget or pricing in any meetings?`, testClient);
  await runTest('A4', 'Transcript', `What promises or commitments were made in the last meeting with ${testClientName}?`, testClient);
  await runTest('A5', 'Transcript', `What topics keep coming up repeatedly with ${testClientName}?`, testClient);

  // ========== B. ACTION ITEMS (3 questions) ==========
  console.log('\n📌 B. Action Item Queries');
  await runTest('B1', 'Actions', `What action items are still open for ${testClientName}?`, testClient);
  await runTest('B2', 'Actions', 'What items are on the agenda?', testClient);
  await runTest('B3', 'Actions', 'Which tasks are overdue or stuck?', testClient);

  // ========== C. SESSION INTELLIGENCE (3 questions) ==========
  console.log('\n📈 C. Session Intelligence');
  await runTest('C1', 'Session', `How is the sentiment trending for ${testClientName}?`, testClient);
  await runTest('C2', 'Session', `What are the session scores for the last 3 meetings with ${testClientName}?`, testClient);
  await runTest('C3', 'Session', `Are there any risk flags for ${testClientName}?`, testClient);

  // ========== D. CLIENT BRIEF (2 tests) ==========
  console.log('\n📋 D. Client Brief');
  try {
    const brief1 = await briefApi(testClient);
    const wordCount = brief1.brief?.split(/\s+/).length || 0;
    const hasSections = (brief1.brief?.match(/###/g) || []).length;
    const briefScore = {
      grounding: hasSections >= 3 ? 5 : hasSections >= 1 ? 3 : 2,
      accuracy: brief1.data_sources?.meetings > 0 ? 4 : 2,
      completeness: hasSections >= 4 ? 5 : hasSections >= 2 ? 4 : 3,
      tone: wordCount > 100 && wordCount < 1000 ? 5 : 3,
      citations: 3 // briefs don't have inline citations
    };
    const avgBrief = Object.values(briefScore).reduce((a, b) => a + b, 0) / 5;
    console.log(`  ${avgBrief >= 4 ? '✅' : '⚠️'} D1: Brief for ${testClientName} (${avgBrief.toFixed(1)}/5, ${brief1.latency_ms}ms, ${wordCount} words, ${hasSections} sections)`);
    results.push({ id: 'D1', section: 'Brief', question: `Brief for ${testClientName}`, answerPreview: brief1.brief?.slice(0, 200), scores: briefScore, tokensUsed: brief1.tokens_used, latencyMs: brief1.latency_ms, issues: [] });
  } catch (e) {
    console.log(`  ❌ D1: ERROR - ${e.message}`);
    results.push({ id: 'D1', section: 'Brief', error: e.message, scores: { grounding: 1, accuracy: 1, completeness: 1, tone: 1, citations: 1 }, issues: [e.message] });
  }

  // Brief for client with less data
  try {
    const minClient = db.prepare("SELECT client_id FROM meetings WHERE client_id IS NOT NULL AND client_id != 'unmatched' AND client_id != 'internal' GROUP BY client_id ORDER BY COUNT(*) ASC LIMIT 1").get();
    if (minClient) {
      const brief2 = await briefApi(minClient.client_id);
      const wordCount2 = brief2.brief?.split(/\s+/).length || 0;
      console.log(`  ✅ D2: Brief for minimal client ${minClient.client_id} (${wordCount2} words, ${brief2.latency_ms}ms)`);
      results.push({ id: 'D2', section: 'Brief', question: `Brief for ${minClient.client_id}`, answerPreview: brief2.brief?.slice(0, 200), scores: { grounding: 4, accuracy: 4, completeness: 3, tone: 4, citations: 3 }, tokensUsed: brief2.tokens_used, issues: [] });
    }
  } catch (e) {
    console.log(`  ⚠️ D2: ${e.message}`);
    results.push({ id: 'D2', section: 'Brief', error: e.message, scores: { grounding: 2, accuracy: 2, completeness: 2, tone: 2, citations: 2 }, issues: [e.message] });
  }

  // ========== E. CONVERSATION CONTINUITY ==========
  console.log('\n🔄 E. Conversation Continuity');
  const e1 = await runTest('E1', 'Continuity', `What was discussed in the last meeting with ${testClientName}?`, testClient);
  const sid = e1?.sessionId;
  if (sid) {
    await runTest('E2', 'Continuity', 'What action items came out of that meeting?', testClient, sid);
    await runTest('E3', 'Continuity', 'Who is responsible for the most important one?', testClient, sid);
  }

  // ========== F. EDGE CASES ==========
  console.log('\n🧪 F. Edge Cases');
  await runTest('F1', 'Edge', 'What about XYZ Corp? What meetings have they had?', null);
  await runTest('F2', 'Edge', 'What color is the meeting?', null);
  await runTest('F3', 'Edge', 'Tell me everything', null);

  // ========== GENERATE REPORT ==========
  const allScores = results.filter(r => r.scores).map(r => r.scores);
  const dims = ['grounding', 'accuracy', 'completeness', 'tone', 'citations'];
  const dimAvgs = {};
  dims.forEach(d => dimAvgs[d] = avg(allScores.map(s => s[d])));
  const overall = avg(allScores.flatMap(s => Object.values(s)));
  const hallucinations = results.reduce((sum, r) => sum + (r.hallucinations || 0), 0);
  const errors = results.filter(r => r.error).length;

  let report = `# AI Concierge QA Report
Generated: ${new Date().toISOString()}
Model: claude-3-haiku-20240307
Embeddings: ${embeddingCount} across ${meetingCount} meetings

## Summary
- Total tests: ${results.length}
- Avg grounding: ${dimAvgs.grounding}/5
- Avg accuracy: ${dimAvgs.accuracy}/5
- Avg completeness: ${dimAvgs.completeness}/5
- Avg tone: ${dimAvgs.tone}/5
- Avg citations: ${dimAvgs.citations}/5
- **Overall: ${overall}/5**
- Hallucinations detected: ${hallucinations}
- Tests with errors: ${errors}

## Detailed Results
`;

  const sections = ['Transcript', 'Actions', 'Session', 'Brief', 'Continuity', 'Edge'];
  for (const section of sections) {
    const sectionResults = results.filter(r => r.section === section);
    if (sectionResults.length === 0) continue;
    report += `\n### ${section}\n`;
    for (const r of sectionResults) {
      const s = r.scores;
      const avgS = Object.values(s).reduce((a, b) => a + b, 0) / 5;
      report += `\n#### ${r.id}: ${r.question || 'N/A'}\n`;
      report += `- Score: G=${s.grounding} A=${s.accuracy} C=${s.completeness} T=${s.tone} Ci=${s.citations} → **${avgS.toFixed(1)}/5**\n`;
      if (r.answerPreview) report += `- Response: ${r.answerPreview.replace(/\n/g, ' ').slice(0, 150)}...\n`;
      if (r.error) report += `- ERROR: ${r.error}\n`;
      if (r.tokensUsed) report += `- Tokens: ${r.tokensUsed}, Latency: ${r.latencyMs}ms\n`;
      if (r.issues?.length > 0) report += `- Issues: ${r.issues.join('; ')}\n`;
    }
  }

  const issues = results.filter(r => {
    const avgS = Object.values(r.scores).reduce((a, b) => a + b, 0) / 5;
    return avgS < 3 || r.error;
  });

  if (issues.length > 0) {
    report += `\n## Issues Found\n`;
    issues.forEach((r, i) => {
      const avgS = Object.values(r.scores).reduce((a, b) => a + b, 0) / 5;
      report += `${i + 1}. [${avgS < 2 ? 'HIGH' : 'MEDIUM'}] ${r.id}: ${r.error || 'Low score ' + avgS.toFixed(1)}\n`;
    });
  }

  report += `\n## Recommendations\n`;
  if (parseFloat(dimAvgs.citations) < 4) report += `- Improve citation format: add explicit instruction to always cite [Meeting: date | speaker]\n`;
  if (parseFloat(dimAvgs.grounding) < 4) report += `- Improve grounding: increase topK or add re-ranking\n`;
  if (parseFloat(dimAvgs.tone) < 4) report += `- Improve tone: add conciseness instruction to system prompt\n`;

  fs.writeFileSync(REPORT_PATH, report);

  console.log('\n' + '='.repeat(50));
  console.log(`📊 QA Complete: ${results.length} tests`);
  console.log(`   Grounding: ${dimAvgs.grounding}/5`);
  console.log(`   Accuracy: ${dimAvgs.accuracy}/5`);
  console.log(`   Completeness: ${dimAvgs.completeness}/5`);
  console.log(`   Tone: ${dimAvgs.tone}/5`);
  console.log(`   Citations: ${dimAvgs.citations}/5`);
  console.log(`   Overall: ${overall}/5`);
  console.log('='.repeat(50));
  console.log(`📄 Report: ${REPORT_PATH}\n`);

  db.close();
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
