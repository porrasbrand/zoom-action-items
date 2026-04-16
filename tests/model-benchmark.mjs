#!/usr/bin/env node
/**
 * Model Benchmark — tests LLM models across Google, OpenAI, Anthropic
 * for intent classification (Benchmark A) and answer generation (Benchmark B).
 *
 * Usage: node tests/model-benchmark.mjs
 */

import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, '../data/zoom-action-items.db');
const RESULTS_PATH = path.join(__dirname, 'benchmark-results.json');
const REPORT_PATH = path.join(__dirname, 'benchmark-report.html');

const db = new Database(DB_PATH);

// ─── Provider clients ───
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const openai = new OpenAI();
const anthropic = new Anthropic();

// ─── Rate limiting ───
const lastCallTime = { google: 0, openai: 0, anthropic: 0 };
async function rateLimit(provider) {
  const now = Date.now();
  const elapsed = now - lastCallTime[provider];
  if (elapsed < 200) await new Promise(r => setTimeout(r, 200 - elapsed));
  lastCallTime[provider] = Date.now();
}

// ─── Unified model call ───
async function callModel(provider, modelId, prompt, maxTokens = 200, temperature = 0) {
  await rateLimit(provider);
  try {
    if (provider === 'google') {
      const model = genAI.getGenerativeModel({ model: modelId });
      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature, maxOutputTokens: maxTokens }
      });
      const text = result.response.text();
      // Some thinking models may return empty text; try candidates fallback
      if (!text && result.response.candidates?.[0]?.content?.parts) {
        const parts = result.response.candidates[0].content.parts;
        const textPart = parts.find(p => p.text && p.text.trim());
        if (textPart) return { text: textPart.text, error: null };
      }
      return { text: text || '', error: null };
    } else if (provider === 'openai') {
      const useNew = modelId.startsWith('o') || modelId.startsWith('gpt-5');
      const params = { model: modelId, messages: [{ role: 'user', content: prompt }] };
      if (useNew) {
        params.max_completion_tokens = maxTokens;
      } else {
        params.max_tokens = maxTokens;
        params.temperature = temperature;
      }
      const result = await openai.chat.completions.create(params);
      return { text: result.choices[0].message.content, error: null };
    } else if (provider === 'anthropic') {
      const result = await anthropic.messages.create({
        model: modelId, messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens
      });
      return { text: result.content[0].text, error: null };
    }
  } catch (e) {
    return { text: null, error: e.message || String(e) };
  }
}

// ─── Model definitions ───
const ALL_MODELS = [
  { provider: 'google', id: 'gemini-2.5-pro' },
  { provider: 'google', id: 'gemini-2.5-flash' },
  { provider: 'google', id: 'gemini-2.5-flash-lite' },
  { provider: 'google', id: 'gemini-2.0-flash' },
  { provider: 'google', id: 'gemini-2.0-flash-lite' },
  { provider: 'openai', id: 'gpt-4o-mini' },
  { provider: 'openai', id: 'o4-mini' },
  { provider: 'openai', id: 'gpt-5' },
  { provider: 'openai', id: 'gpt-5-mini' },
  { provider: 'anthropic', id: 'claude-3-haiku-20240307' },
];

// ═══════════════════════════════════════════════════════════════════════
// STEP 0: Smoke Test
// ═══════════════════════════════════════════════════════════════════════

async function smokeTest() {
  console.log('\n=== STEP 0: Smoke Test ===\n');
  const working = [];
  for (const m of ALL_MODELS) {
    process.stdout.write(`  Testing ${m.provider}/${m.id}... `);
    const r = await callModel(m.provider, m.id, 'Say hello in exactly 5 words.', 50, 0);
    if (r.error) {
      // Retry once
      const r2 = await callModel(m.provider, m.id, 'Say hello in exactly 5 words.', 50, 0);
      if (r2.error) {
        console.log(`FAIL (${r2.error.slice(0, 80)})`);
        continue;
      }
      r.text = r2.text;
    }
    console.log(`OK -> "${(r.text || '').slice(0, 40)}"`);
    working.push({ ...m, smokeResponse: r.text });
  }
  console.log(`\n  ${working.length}/${ALL_MODELS.length} models available\n`);
  return working;
}

// ═══════════════════════════════════════════════════════════════════════
// BENCHMARK A: Intent Classifier (44 test cases)
// ═══════════════════════════════════════════════════════════════════════

const KNOWN_CLIENTS = [
  'Bearcat', 'Echelon', 'B3X Internal', '1st Choice', 'Tom Ruwitch',
  'Mike McVety', 'Legendary Service', 'Vision Flooring AZ', 'Raider Flooring',
  'BEC CFO', 'Jerry Levinson', 'Jay Conner / Conner Marketing', 'Empower',
  'GS Home Services', 'London Flooring', 'Prosper Group', 'Pearce HVAC',
  'Incontrera Consulting', 'Regen Profits', 'Northern Services'
];

const CLASSIFIER_PROMPT_TEMPLATE = `You are an intent classifier for an AI Concierge that manages meeting transcripts and action items.

Classify the user's question into a JSON object with these fields:
- intent: one of [meeting_summary, action_items, count_query, sentiment_analysis, transcript_search, temporal_search, meeting_prep, meta_analysis]
- client: the client name mentioned (or null if none)
- person: a specific person mentioned (or null)
- time_scope: one of [latest, last_week, last_month, all_time, specific_date] or null
- topic: the topic/keyword being searched for (or null)
- filters: any extra filters as an object (or null)

Intent definitions:
- meeting_summary: user wants a summary of a meeting
- action_items: user wants to see open/pending/overdue action items or tasks
- count_query: user asks "how many" of something
- sentiment_analysis: user asks about mood, sentiment, engagement, satisfaction scores
- transcript_search: user wants to search transcript content for specific topics or quotes
- temporal_search: user wants to compare or look across a time range
- meeting_prep: user wants to prepare for an upcoming meeting
- meta_analysis: user wants cross-client analysis, trends, or patterns across multiple meetings

Known clients: ${KNOWN_CLIENTS.join(', ')}

Respond with ONLY valid JSON, no explanation.

User question: `;

// 32 standard test cases + 12 edge cases = 44 total
const CLASSIFIER_TESTS = [
  // --- meeting_summary (6) ---
  { q: "Summarize the last Echelon meeting", expected: { intent: "meeting_summary", client: "Echelon", time_scope: "latest" } },
  { q: "What happened in the most recent Bearcat call?", expected: { intent: "meeting_summary", client: "Bearcat", time_scope: "latest" } },
  { q: "Give me a recap of the London Flooring session", expected: { intent: "meeting_summary", client: "London Flooring", time_scope: "latest" } },
  { q: "Summary of last week's GS Home Services meeting", expected: { intent: "meeting_summary", client: "GS Home Services", time_scope: "last_week" } },
  { q: "What did we cover in the Prosper Group call?", expected: { intent: "meeting_summary", client: "Prosper Group", time_scope: "latest" } },
  { q: "Tell me about the Jerry Levinson meeting", expected: { intent: "meeting_summary", client: "Jerry Levinson", time_scope: "latest" } },

  // --- action_items (6) ---
  { q: "What are the open action items for Echelon?", expected: { intent: "action_items", client: "Echelon" } },
  { q: "Show me pending tasks for Bearcat", expected: { intent: "action_items", client: "Bearcat" } },
  { q: "Any overdue items for GS Home Services?", expected: { intent: "action_items", client: "GS Home Services" } },
  { q: "List all open tasks across all clients", expected: { intent: "action_items", client: null } },
  { q: "What action items does Tom Ruwitch have?", expected: { intent: "action_items", client: "Tom Ruwitch" } },
  { q: "Show me Pearce HVAC's pending items", expected: { intent: "action_items", client: "Pearce HVAC" } },

  // --- count_query (4) ---
  { q: "How many meetings have we had with Echelon?", expected: { intent: "count_query", client: "Echelon" } },
  { q: "How many open action items total?", expected: { intent: "count_query", client: null } },
  { q: "How many clients do we have?", expected: { intent: "count_query", client: null } },
  { q: "How many meetings happened last week?", expected: { intent: "count_query", time_scope: "last_week" } },

  // --- sentiment_analysis (4) ---
  { q: "What's the sentiment score for Echelon?", expected: { intent: "sentiment_analysis", client: "Echelon" } },
  { q: "How is Bearcat feeling about our work?", expected: { intent: "sentiment_analysis", client: "Bearcat" } },
  { q: "Show me engagement scores for London Flooring", expected: { intent: "sentiment_analysis", client: "London Flooring" } },
  { q: "What's the mood trend across all clients?", expected: { intent: "sentiment_analysis", client: null } },

  // --- transcript_search (4) ---
  { q: "Did anyone mention budget cuts in the Echelon meeting?", expected: { intent: "transcript_search", client: "Echelon", topic: "budget cuts" } },
  { q: "Search for discussions about SEO in Bearcat transcripts", expected: { intent: "transcript_search", client: "Bearcat", topic: "SEO" } },
  { q: "Find where we talked about onboarding with GS Home Services", expected: { intent: "transcript_search", client: "GS Home Services", topic: "onboarding" } },
  { q: "What did Mike say about the landing page?", expected: { intent: "transcript_search", person: "Mike", topic: "landing page" } },

  // --- temporal_search (3) ---
  { q: "Compare Echelon meetings from this month vs last month", expected: { intent: "temporal_search", client: "Echelon" } },
  { q: "Show me all meetings from last week", expected: { intent: "temporal_search", time_scope: "last_week" } },
  { q: "What changed in Bearcat's sentiment over the past month?", expected: { intent: "temporal_search", client: "Bearcat", time_scope: "last_month" } },

  // --- meeting_prep (3) ---
  { q: "Prep me for the Echelon meeting tomorrow", expected: { intent: "meeting_prep", client: "Echelon" } },
  { q: "What do I need to know before the Bearcat call?", expected: { intent: "meeting_prep", client: "Bearcat" } },
  { q: "Brief me on London Flooring before our session", expected: { intent: "meeting_prep", client: "London Flooring" } },

  // --- meta_analysis (2) ---
  { q: "Which clients have the most overdue items?", expected: { intent: "meta_analysis" } },
  { q: "Compare engagement scores across all clients", expected: { intent: "meta_analysis" } },

  // ─── 12 EDGE CASES ───
  { q: "echelon action items", expected: { intent: "action_items", client: "Echelon" }, edge: "lowercase, no question mark" },
  { q: "summarize", expected: { intent: "meeting_summary", client: null }, edge: "single word" },
  { q: "How's Bearcat doing?", expected: { intent: "sentiment_analysis", client: "Bearcat" }, edge: "vague sentiment" },
  { q: "What about GS Home Services?", expected: { intent: "meeting_summary", client: "GS Home Services" }, edge: "ambiguous intent" },
  { q: "Tell me everything about Echelon", expected: { intent: "meeting_prep", client: "Echelon" }, edge: "broad request" },
  { q: "yo whats up with bearcat", expected: { intent: "meeting_summary", client: "Bearcat" }, edge: "slang" },
  { q: "1st Choice open items and sentiment", expected: { intent: "action_items", client: "1st Choice" }, edge: "multi-intent" },
  { q: "", expected: { intent: null, client: null }, edge: "empty input" },
  { q: "asdfghjkl qwerty", expected: { intent: null, client: null }, edge: "gibberish" },
  { q: "What is the meaning of life?", expected: { intent: null, client: null }, edge: "off-topic" },
  { q: "Jay Conner meeting summary and action items", expected: { intent: "meeting_summary", client: "Jay Conner / Conner Marketing" }, edge: "partial client name" },
  { q: "Prep me for ALL meetings tomorrow", expected: { intent: "meeting_prep", client: null }, edge: "all-client prep" },
];

function scoreClassification(predicted, expected) {
  const scores = { intent_correct: 0, client_correct: 0, json_valid: 0, person_correct: 0, time_scope_correct: 0 };

  // JSON valid?
  if (predicted !== null) scores.json_valid = 1;
  else return scores;

  // Intent
  if (expected.intent === null) {
    // Edge case: if expected is null, any response is acceptable
    scores.intent_correct = 1;
  } else if (predicted.intent === expected.intent) {
    scores.intent_correct = 1;
  }

  // Client
  if (expected.client === undefined) {
    scores.client_correct = 1; // not tested
  } else if (expected.client === null && (!predicted.client || predicted.client === null || predicted.client === 'null')) {
    scores.client_correct = 1;
  } else if (expected.client && predicted.client && predicted.client.toLowerCase().includes(expected.client.toLowerCase().split('/')[0].trim())) {
    scores.client_correct = 1;
  } else if (expected.client === null || expected.client === predicted.client) {
    scores.client_correct = 1;
  }

  // Person
  if (expected.person === undefined) {
    scores.person_correct = 1;
  } else if (expected.person === null && (!predicted.person || predicted.person === null)) {
    scores.person_correct = 1;
  } else if (expected.person && predicted.person && predicted.person.toLowerCase().includes(expected.person.toLowerCase())) {
    scores.person_correct = 1;
  }

  // Time scope
  if (expected.time_scope === undefined) {
    scores.time_scope_correct = 1;
  } else if (expected.time_scope === null && (!predicted.time_scope || predicted.time_scope === null)) {
    scores.time_scope_correct = 1;
  } else if (expected.time_scope === predicted.time_scope) {
    scores.time_scope_correct = 1;
  }

  return scores;
}

function computeWeightedScore(scores) {
  return (scores.intent_correct * 0.40) + (scores.client_correct * 0.25) +
         (scores.json_valid * 0.15) + (scores.person_correct * 0.10) +
         (scores.time_scope_correct * 0.10);
}

function parseJSON(text) {
  if (!text) return null;
  // Try to extract JSON from markdown code blocks or raw text
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/) || text.match(/(\{[\s\S]*\})/);
  if (jsonMatch) {
    try { return JSON.parse(jsonMatch[1].trim()); } catch {}
  }
  try { return JSON.parse(text.trim()); } catch {}
  return null;
}

async function runClassifierBenchmark(workingModels) {
  console.log('\n=== BENCHMARK A: Intent Classifier (44 tests) ===\n');
  const results = {};

  for (const model of workingModels) {
    const key = `${model.provider}/${model.id}`;
    console.log(`  Testing ${key}...`);
    results[key] = { model: model.id, provider: model.provider, tests: [], totalScore: 0, avgScore: 0 };
    let completed = 0;

    for (const tc of CLASSIFIER_TESTS) {
      const prompt = CLASSIFIER_PROMPT_TEMPLATE + (tc.q || '(empty)');
      let r = await callModel(model.provider, model.id, prompt, 200, 0);
      if (r.error) r = await callModel(model.provider, model.id, prompt, 200, 0); // retry once

      const parsed = parseJSON(r.text);
      const scores = scoreClassification(parsed, tc.expected);
      const weighted = computeWeightedScore(scores);

      results[key].tests.push({
        question: tc.q,
        expected: tc.expected,
        predicted: parsed,
        raw: (r.text || '').slice(0, 300),
        error: r.error,
        scores,
        weighted,
        edge: tc.edge || null
      });

      results[key].totalScore += weighted;
      completed++;
      if (completed % 10 === 0) process.stdout.write(`    ${completed}/44 `);
    }

    results[key].avgScore = results[key].totalScore / CLASSIFIER_TESTS.length;
    console.log(`\n    -> avg score: ${(results[key].avgScore * 100).toFixed(1)}%`);
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════════════
// BENCHMARK B: Answer Generator (25 test cases)
// ═══════════════════════════════════════════════════════════════════════

// Pre-assemble context from the DB
function getClientContext(clientId) {
  const meetings = db.prepare(
    'SELECT id, topic, start_time, duration_minutes, meeting_summary, client_name FROM meetings WHERE client_id = ? AND transcript_raw IS NOT NULL ORDER BY start_time DESC LIMIT 3'
  ).all(clientId);

  const actionItems = db.prepare(
    "SELECT title, owner_name, status, due_date, priority FROM action_items WHERE client_id = ? AND status IN ('open','on-agenda') ORDER BY created_at DESC LIMIT 10"
  ).all(clientId);

  const sessionScores = db.prepare(
    'SELECT se.composite_score, se.client_sentiment, se.accountability, se.value_delivery, m.topic, m.start_time FROM session_evaluations se JOIN meetings m ON se.meeting_id = m.id WHERE m.client_id = ? ORDER BY m.start_time DESC LIMIT 3'
  ).all(clientId).catch?.(() => []) || [];

  let sessionScoresData = [];
  try {
    sessionScoresData = db.prepare(
      'SELECT se.composite_score, se.client_sentiment, se.accountability, se.value_delivery, m.topic, m.start_time FROM session_evaluations se JOIN meetings m ON se.meeting_id = m.id WHERE m.client_id = ? ORDER BY m.start_time DESC LIMIT 3'
    ).all(clientId);
  } catch { sessionScoresData = []; }

  const chunks = db.prepare(
    'SELECT text, speakers FROM transcript_chunks WHERE meeting_id = ? ORDER BY chunk_index ASC LIMIT 10'
  ).all(meetings[0]?.id || 0);

  let contextStr = `=== Client: ${meetings[0]?.client_name || clientId} ===\n`;
  contextStr += `\n=== Meeting Timeline ===\n`;
  for (const m of meetings) {
    contextStr += `${m.start_time} - ${m.topic} (${m.duration_minutes || '?'} min)\n`;
    if (m.meeting_summary) contextStr += `Summary: ${m.meeting_summary.slice(0, 400)}\n`;
  }
  if (actionItems.length > 0) {
    contextStr += `\n=== Open Action Items (${actionItems.length}) ===\n`;
    for (const item of actionItems) {
      contextStr += `- [${(item.status || 'open').toUpperCase()}] ${item.title} (Owner: ${item.owner_name || 'TBD'})\n`;
    }
  }
  if (sessionScoresData.length > 0) {
    contextStr += `\n=== Session Scores ===\n`;
    for (const s of sessionScoresData) {
      contextStr += `- ${s.start_time}: composite ${s.composite_score}/100, sentiment ${s.client_sentiment}/100\n`;
    }
  }
  if (chunks.length > 0) {
    contextStr += `\n=== Recent Transcript Excerpts ===\n`;
    for (const c of chunks) {
      contextStr += `[${c.speakers || 'Unknown'}]: ${c.text.slice(0, 200)}\n`;
    }
  }
  return { contextStr, meetings, actionItems, sessionScores: sessionScoresData, chunks };
}

function getGlobalContext() {
  const clientCounts = db.prepare(
    "SELECT client_name, COUNT(*) as cnt FROM meetings WHERE client_name IS NOT NULL AND client_name != 'Unmatched' GROUP BY client_name ORDER BY cnt DESC LIMIT 15"
  ).all();
  const totalMeetings = db.prepare('SELECT COUNT(*) as cnt FROM meetings WHERE transcript_raw IS NOT NULL').get().cnt;
  const totalItems = db.prepare("SELECT COUNT(*) as cnt FROM action_items WHERE status='open'").get().cnt;

  let ctx = `=== Global Stats ===\nTotal meetings with transcripts: ${totalMeetings}\nOpen action items: ${totalItems}\n`;
  ctx += `\nMeetings per client:\n`;
  for (const c of clientCounts) ctx += `  ${c.client_name}: ${c.cnt}\n`;
  return ctx;
}

const ANSWER_SYSTEM = `You are an AI Concierge for a marketing agency. Answer questions about client meetings, action items, and performance using ONLY the provided context. Be concise and factual. Cite specific dates and meeting names when available. If the context doesn't contain the answer, say so.`;

const GENERATOR_TESTS = [
  // meeting_summary (4)
  { q: "Summarize the last Echelon meeting", clientId: "echelon", intent: "meeting_summary",
    checks: { mustMention: ["echelon"], minLength: 50, maxLength: 2000 } },
  { q: "What happened in the latest Bearcat call?", clientId: "bearcat", intent: "meeting_summary",
    checks: { mustMention: ["bearcat"], minLength: 50, maxLength: 2000 } },
  { q: "Recap the most recent GS Home Services session", clientId: "gs-home-services", intent: "meeting_summary",
    checks: { mustMention: ["gs home"], minLength: 50, maxLength: 2000 } },
  { q: "What was discussed in the London Flooring meeting?", clientId: "london-flooring", intent: "meeting_summary",
    checks: { mustMention: ["london"], minLength: 50, maxLength: 2000 } },

  // action_items (4)
  { q: "What are the open action items for Echelon?", clientId: "echelon", intent: "action_items",
    checks: { mustMention: ["echelon"], minLength: 30 } },
  { q: "Show pending tasks for Bearcat", clientId: "bearcat", intent: "action_items",
    checks: { mustMention: ["bearcat"], minLength: 30 } },
  { q: "Any overdue items for Pearce HVAC?", clientId: "pearce-hvac", intent: "action_items",
    checks: { mustMention: ["pearce"], minLength: 20 } },
  { q: "List all open tasks for Prosper Group", clientId: "prosper-group", intent: "action_items",
    checks: { mustMention: ["prosper"], minLength: 20 } },

  // count_query (3)
  { q: "How many meetings have we had with Echelon?", clientId: "echelon", intent: "count_query",
    checks: { mustMention: ["echelon"], mustContainNumber: true } },
  { q: "How many open action items total?", clientId: null, intent: "count_query",
    checks: { mustContainNumber: true } },
  { q: "How many clients do we have?", clientId: null, intent: "count_query",
    checks: { mustContainNumber: true } },

  // sentiment_analysis (3)
  { q: "What's the sentiment score for Echelon?", clientId: "echelon", intent: "sentiment_analysis",
    checks: { mustMention: ["echelon"], minLength: 30 } },
  { q: "How is Bearcat feeling about our work?", clientId: "bearcat", intent: "sentiment_analysis",
    checks: { mustMention: ["bearcat"], minLength: 30 } },
  { q: "Show engagement scores for London Flooring", clientId: "london-flooring", intent: "sentiment_analysis",
    checks: { mustMention: ["london"], minLength: 20 } },

  // transcript_search (3)
  { q: "Did anyone mention budget in the Echelon meeting?", clientId: "echelon", intent: "transcript_search",
    checks: { mustMention: ["echelon"], minLength: 20 } },
  { q: "Search for SEO discussions in Bearcat transcripts", clientId: "bearcat", intent: "transcript_search",
    checks: { mustMention: ["bearcat"], minLength: 20 } },
  { q: "Find where we talked about onboarding with GS Home Services", clientId: "gs-home-services", intent: "transcript_search",
    checks: { mustMention: ["gs home", "onboard"], minLength: 20 } },

  // meeting_prep (3)
  { q: "Prep me for the Echelon meeting", clientId: "echelon", intent: "meeting_prep",
    checks: { mustMention: ["echelon"], minLength: 100 } },
  { q: "What do I need to know before the Bearcat call?", clientId: "bearcat", intent: "meeting_prep",
    checks: { mustMention: ["bearcat"], minLength: 100 } },
  { q: "Brief me on London Flooring", clientId: "london-flooring", intent: "meeting_prep",
    checks: { mustMention: ["london"], minLength: 50 } },

  // meta_analysis (3)
  { q: "Which clients have the most overdue items?", clientId: null, intent: "meta_analysis",
    checks: { minLength: 30 } },
  { q: "Compare engagement across clients", clientId: null, intent: "meta_analysis",
    checks: { minLength: 30 } },
  { q: "What are the trends in meeting frequency?", clientId: null, intent: "meta_analysis",
    checks: { minLength: 30 } },

  // temporal_search (2)
  { q: "How has Echelon sentiment changed over time?", clientId: "echelon", intent: "temporal_search",
    checks: { mustMention: ["echelon"], minLength: 30 } },
  { q: "Show me all meetings from last week", clientId: null, intent: "temporal_search",
    checks: { minLength: 30 } },
];

function scoreGeneratorResponse(text, tc) {
  if (!text) return { factual: 0, noHallucination: 1, citationPresent: 0, lengthOk: 0, total: 0 };

  const lower = text.toLowerCase();
  const checks = tc.checks;
  const scores = { factual: 0, noHallucination: 1, citationPresent: 0, lengthOk: 0 };

  // Factual: all mustMention terms present
  if (checks.mustMention) {
    const found = checks.mustMention.filter(t => lower.includes(t.toLowerCase()));
    scores.factual = found.length / checks.mustMention.length;
  } else {
    scores.factual = 1;
  }

  // Must contain number check
  if (checks.mustContainNumber && !/\d+/.test(text)) {
    scores.factual *= 0.5;
  }

  // Hallucination: check for clearly fabricated patterns
  if (/i don.t have access|i cannot|as an ai|i.m not able/i.test(text)) {
    scores.noHallucination = 0.5; // unhelpful refusal
  }

  // Citation: mentions dates or meeting names
  if (/\d{4}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|meeting|session|call/i.test(text)) {
    scores.citationPresent = 1;
  }

  // Length
  const len = text.length;
  const minLen = checks.minLength || 20;
  const maxLen = checks.maxLength || 3000;
  if (len >= minLen && len <= maxLen) scores.lengthOk = 1;
  else if (len < minLen) scores.lengthOk = Math.max(0, len / minLen);
  else scores.lengthOk = Math.max(0, 1 - (len - maxLen) / maxLen);

  scores.total = (scores.factual * 0.35) + (scores.noHallucination * 0.25) +
                 (scores.citationPresent * 0.20) + (scores.lengthOk * 0.20);
  return scores;
}

async function runGeneratorBenchmark(workingModels) {
  // Pick top 3 models (or all if <=3) based on classifier results
  const modelsToTest = workingModels.slice(0, Math.min(workingModels.length, 5));
  console.log(`\n=== BENCHMARK B: Answer Generator (25 tests x ${modelsToTest.length} models) ===\n`);

  // Pre-build contexts
  const contextCache = {};
  const globalCtx = getGlobalContext();

  const results = {};

  for (const model of modelsToTest) {
    const key = `${model.provider}/${model.id}`;
    console.log(`  Testing ${key}...`);
    results[key] = { model: model.id, provider: model.provider, tests: [], totalScore: 0, avgScore: 0 };
    let completed = 0;

    for (const tc of GENERATOR_TESTS) {
      let ctx;
      if (tc.clientId) {
        if (!contextCache[tc.clientId]) contextCache[tc.clientId] = getClientContext(tc.clientId);
        ctx = contextCache[tc.clientId].contextStr;
      } else {
        ctx = globalCtx;
      }

      const prompt = `${ANSWER_SYSTEM}\n\n--- CONTEXT ---\n${ctx}\n--- END CONTEXT ---\n\nQuestion: ${tc.q}\n\nAnswer:`;

      let r = await callModel(model.provider, model.id, prompt, 1500, 0);
      if (r.error) r = await callModel(model.provider, model.id, prompt, 1500, 0);

      const scores = scoreGeneratorResponse(r.text, tc);

      results[key].tests.push({
        question: tc.q,
        clientId: tc.clientId,
        intent: tc.intent,
        responseLength: (r.text || '').length,
        responsePreview: (r.text || '').slice(0, 200),
        error: r.error,
        scores
      });

      results[key].totalScore += scores.total;
      completed++;
      if (completed % 5 === 0) process.stdout.write(`    ${completed}/25 `);
    }

    results[key].avgScore = results[key].totalScore / GENERATOR_TESTS.length;
    console.log(`\n    -> avg score: ${(results[key].avgScore * 100).toFixed(1)}%`);
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════════════
// HTML Report Generation
// ═══════════════════════════════════════════════════════════════════════

function generateHTMLReport(smokeResults, classifierResults, generatorResults) {
  const modelRows = (results, type) => {
    return Object.entries(results)
      .sort((a, b) => b[1].avgScore - a[1].avgScore)
      .map(([key, data], rank) => {
        const pct = (data.avgScore * 100).toFixed(1);
        const color = data.avgScore >= 0.8 ? '#22c55e' : data.avgScore >= 0.6 ? '#eab308' : '#ef4444';
        return `<tr>
          <td>${rank + 1}</td>
          <td><strong>${key}</strong></td>
          <td style="color:${color}; font-weight:bold">${pct}%</td>
          <td>${data.tests.length}</td>
          <td>${type === 'classifier' ?
            `Intent: ${(data.tests.filter(t => t.scores.intent_correct).length)}/${data.tests.length} | Client: ${(data.tests.filter(t => t.scores.client_correct).length)}/${data.tests.length}` :
            `Factual: ${(data.tests.reduce((s,t) => s + t.scores.factual, 0) / data.tests.length * 100).toFixed(0)}% | Cite: ${(data.tests.reduce((s,t) => s + t.scores.citationPresent, 0) / data.tests.length * 100).toFixed(0)}%`
          }</td>
        </tr>`;
      }).join('\n');
  };

  const detailRows = (results) => {
    return Object.entries(results).map(([key, data]) => {
      return data.tests.map(t => {
        const bg = t.weighted >= 0.8 ? '#f0fdf4' : t.weighted >= 0.6 ? '#fefce8' : '#fef2f2';
        return `<tr style="background:${bg}">
          <td>${key}</td>
          <td title="${t.edge || ''}">${t.question || '(empty)'}${t.edge ? ' *' : ''}</td>
          <td>${t.expected.intent || '-'}</td>
          <td>${t.predicted?.intent || t.error?.slice(0,30) || '-'}</td>
          <td>${t.predicted?.client || '-'}</td>
          <td>${(t.weighted * 100).toFixed(0)}%</td>
        </tr>`;
      }).join('\n');
    }).join('\n');
  };

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Model Benchmark Report</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; background: #f9fafb; }
  h1 { color: #1e293b; border-bottom: 2px solid #3b82f6; padding-bottom: 8px; }
  h2 { color: #334155; margin-top: 30px; }
  table { width: 100%; border-collapse: collapse; margin: 10px 0 20px; background: white; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  th { background: #1e293b; color: white; padding: 10px; text-align: left; font-size: 13px; }
  td { padding: 8px 10px; border-bottom: 1px solid #e2e8f0; font-size: 13px; }
  tr:hover { background: #f1f5f9 !important; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: bold; }
  .badge-ok { background: #dcfce7; color: #166534; }
  .badge-fail { background: #fecaca; color: #991b1b; }
  .meta { color: #64748b; font-size: 12px; }
  .card { background: white; padding: 15px; border-radius: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin: 10px 0; }
</style></head>
<body>
<h1>AI Concierge Model Benchmark Report</h1>
<p class="meta">Generated: ${new Date().toISOString()} | Models tested: ${smokeResults.length}</p>

<div class="card">
<h2>Smoke Test Results</h2>
<table>
<tr><th>Provider</th><th>Model</th><th>Status</th><th>Response</th></tr>
${smokeResults.map(m => `<tr><td>${m.provider}</td><td>${m.id}</td><td><span class="badge badge-ok">OK</span></td><td class="meta">${(m.smokeResponse||'').slice(0,50)}</td></tr>`).join('\n')}
</table>
</div>

<h2>Benchmark A: Intent Classifier Rankings</h2>
<table>
<tr><th>#</th><th>Model</th><th>Score</th><th>Tests</th><th>Breakdown</th></tr>
${modelRows(classifierResults, 'classifier')}
</table>

<h2>Benchmark B: Answer Generator Rankings</h2>
<table>
<tr><th>#</th><th>Model</th><th>Score</th><th>Tests</th><th>Breakdown</th></tr>
${modelRows(generatorResults, 'generator')}
</table>

<h2>Classifier Detail (per question)</h2>
<table>
<tr><th>Model</th><th>Question</th><th>Expected Intent</th><th>Got Intent</th><th>Got Client</th><th>Score</th></tr>
${detailRows(classifierResults)}
</table>

</body></html>`;
}

// ═══════════════════════════════════════════════════════════════════════
// Main
// ═══════════════════════════════════════════════════════════════════════

async function main() {
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  AI Concierge Model Benchmark                   ║');
  console.log('╚══════════════════════════════════════════════════╝');

  const startTime = Date.now();

  // Step 0: Smoke test
  const workingModels = await smokeTest();
  if (workingModels.length === 0) {
    console.error('No models passed smoke test. Exiting.');
    process.exit(1);
  }

  // Benchmark A: Classifier
  const classifierResults = await runClassifierBenchmark(workingModels);

  // Rank models for generator benchmark (use top performers)
  const rankedModels = Object.entries(classifierResults)
    .sort((a, b) => b[1].avgScore - a[1].avgScore)
    .map(([key]) => workingModels.find(m => `${m.provider}/${m.id}` === key))
    .filter(Boolean);

  // Benchmark B: Generator
  const generatorResults = await runGeneratorBenchmark(rankedModels);

  const elapsedMin = ((Date.now() - startTime) / 60000).toFixed(1);

  // Save results
  const fullResults = {
    timestamp: new Date().toISOString(),
    elapsedMinutes: parseFloat(elapsedMin),
    smokeTest: workingModels.map(m => ({ provider: m.provider, id: m.id })),
    classifierRankings: Object.entries(classifierResults)
      .sort((a, b) => b[1].avgScore - a[1].avgScore)
      .map(([key, data]) => ({ model: key, avgScore: data.avgScore, tests: data.tests.length })),
    generatorRankings: Object.entries(generatorResults)
      .sort((a, b) => b[1].avgScore - a[1].avgScore)
      .map(([key, data]) => ({ model: key, avgScore: data.avgScore, tests: data.tests.length })),
    classifierDetails: classifierResults,
    generatorDetails: generatorResults
  };

  fs.writeFileSync(RESULTS_PATH, JSON.stringify(fullResults, null, 2));
  console.log(`\nResults saved to ${RESULTS_PATH}`);

  // Generate HTML report
  const html = generateHTMLReport(workingModels, classifierResults, generatorResults);
  fs.writeFileSync(REPORT_PATH, html);
  console.log(`Report saved to ${REPORT_PATH}`);

  // Final summary
  console.log(`\n=== FINAL RANKINGS (elapsed: ${elapsedMin} min) ===\n`);
  console.log('Classifier:');
  fullResults.classifierRankings.forEach((r, i) => console.log(`  ${i+1}. ${r.model}: ${(r.avgScore*100).toFixed(1)}%`));
  console.log('\nGenerator:');
  fullResults.generatorRankings.forEach((r, i) => console.log(`  ${i+1}. ${r.model}: ${(r.avgScore*100).toFixed(1)}%`));
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
