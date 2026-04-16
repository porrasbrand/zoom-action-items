/**
 * Intent Router v3 — LLM-first intent classification + GPT-5.4 answer generation
 *
 * Architecture:
 * 1. Regex fast-path for obvious queries (skip LLM classification)
 * 2. Gemini 3.1 Flash-Lite classifies intent into 8 categories
 * 3. Smart router retrieves data per intent type
 * 4. GPT-5.4-mini (standard) or GPT-5.4 (complex) generates answer
 * 5. Query logging to data/concierge-queries.jsonl
 */

import 'dotenv/config';
import fs from 'fs';
import { GoogleGenerativeAI } from '@google/generative-ai';
import OpenAI from 'openai';
import { retrieveContext, formatContext, ensureIndex, detectClient } from './rag-engine.js';
import { embedChunk, searchSimilar, cosineSimilarity } from './transcript-embedder.js';

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Configurable models via env vars
const CLASSIFIER_MODEL = process.env.CLASSIFIER_MODEL || 'gemini-3.1-flash-lite-preview';
const ANSWER_MODEL = process.env.ANSWER_MODEL || 'gpt-5.4-mini';
const COMPLEX_ANSWER_MODEL = process.env.COMPLEX_ANSWER_MODEL || 'gpt-5.4';

const LOG_PATH = 'data/concierge-queries.jsonl';

const INTENT_CATEGORIES = [
  'count_query',
  'action_items',
  'sentiment_analysis',
  'meeting_prep',
  'meta_analysis',
  'temporal_search',
  'transcript_search',
  'meeting_summary'
];

// ============ QUERY LOGGING ============

function logQuery(entry) {
  try {
    const line = JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + '\n';
    fs.appendFileSync(LOG_PATH, line);
  } catch {}
}

// ============ REGEX FAST-PATH ============

/**
 * For obvious queries, skip LLM classification entirely.
 * Returns intent string or null if LLM classification needed.
 */
function regexFastPath(question, meetingId) {
  const q = question.toLowerCase();

  // Count queries
  if (/^how many\b/.test(q) && /meeting|session|call/.test(q)) {
    return 'count_query';
  }

  // Meeting-scoped queries get simpler routing
  if (meetingId) {
    if (/summary|summarize|what was discussed|what happened|overview|recap/.test(q)) return 'meeting_summary';
    if (/action item|task|todo|open item|follow.?up/.test(q)) return 'action_items';
    if (/score|sentiment|mood|evaluation/.test(q)) return 'sentiment_analysis';
    // Default to transcript_search for meeting-scoped
    return 'transcript_search';
  }

  // Strong signal patterns (no meetingId)
  if (/^(count|total|number of)\b/.test(q) || /\bhow many\b/.test(q)) return 'count_query';
  if (/\b(brief|prep me|prepare me|catch me up|what do i need to know)\b/.test(q)) return 'meeting_prep';
  if (/\b(which clients? need|who needs attention|at risk|neglected|stale)\b/.test(q)) return 'meta_analysis';
  if (/\b(ever discuss|first mention|history of|timeline|when was.*first|has.*come up|did we.*discuss)\b/.test(q)) return 'temporal_search';

  return null;
}

// ============ DYNAMIC CLIENT LIST ============

let cachedClientList = null;

function getClientList(db) {
  if (cachedClientList) return cachedClientList;
  cachedClientList = db.prepare("SELECT DISTINCT client_id, client_name FROM meetings WHERE client_id IS NOT NULL AND client_id != 'unmatched' ORDER BY client_name").all();
  return cachedClientList;
}

export function invalidateClientCache() {
  cachedClientList = null;
}

function buildClassifierPrompt(db) {
  const clientNames = getClientList(db).map(c => c.client_name).join(', ');
  return `Classify this user question into exactly one intent category.

Categories:
- count_query: User wants a numeric count (how many meetings, total items, etc.)
- action_items: User asks about tasks, action items, to-dos, open/pending items
- sentiment_analysis: User asks about scores, sentiment, mood, engagement, evaluation
- meeting_prep: User wants a briefing, overview, or preparation for a client meeting
- meta_analysis: User asks about cross-client trends, which clients need attention, risk flags
- temporal_search: User asks about something that happened during a specific time period across meetings
- transcript_search: User asks about specific topics discussed in meetings
- meeting_summary: User wants a summary of what was discussed in a specific meeting

Known clients (use EXACTLY these names in your response):
${clientNames}

IMPORTANT: For the "client" field, return the EXACT client name from the list above. If the user says a partial name or abbreviation, match to the closest client. If using pronouns (their/those/that), resolve from conversation context. If no client matches, return null.`;
}

// ============ LLM INTENT CLASSIFICATION ============

async function classifyWithLLM(question, chatHistory, db) {
  const model = genAI.getGenerativeModel({
    model: CLASSIFIER_MODEL,
    generationConfig: { responseMimeType: 'application/json', temperature: 0, maxOutputTokens: 200 }
  });

  let contextMessages = '';
  if (chatHistory && chatHistory.length > 0) {
    const recent = chatHistory.slice(-4);
    contextMessages = '\n\nRecent conversation (resolve pronouns using this):\n';
    for (const m of recent) {
      contextMessages += m.role + ': ' + (m.content || '').substring(0, 300) + '\n';
    }
  }

  const prompt = buildClassifierPrompt(db) + contextMessages + '\nQuestion: "' + question + '"\n\nRespond with JSON: {"intent": "<category>", "client": "<EXACT name from Known clients or null>", "confidence": <0.0-1.0>}';

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const parsed = JSON.parse(text);

    if (INTENT_CATEGORIES.includes(parsed.intent)) {
      return { intent: parsed.intent, confidence: parsed.confidence || 0.8, method: 'llm', client: parsed.client || null };
    }
  } catch (err) {
    console.warn('[IntentRouter] LLM classification failed:', err.message);
  }

  return { intent: 'transcript_search', confidence: 0.3, method: 'llm_fallback' };
}

// ============ CLIENT RESOLUTION ============

function resolveClientId(db, clientNameOrQuestion, providedClientId) {
  if (providedClientId) return { clientId: providedClientId, method: 'provided' };
  if (!clientNameOrQuestion) return { clientId: null, method: 'none' };

  // Direct match on client_name (classifier returns exact canonical name)
  const direct = db.prepare("SELECT DISTINCT client_id FROM meetings WHERE client_name = ? AND client_id IS NOT NULL AND client_id != 'unmatched' LIMIT 1").get(clientNameOrQuestion);
  if (direct) return { clientId: direct.client_id, method: 'canonical_match' };

  // Case-insensitive match
  const ci = db.prepare("SELECT DISTINCT client_id FROM meetings WHERE LOWER(client_name) = LOWER(?) AND client_id IS NOT NULL AND client_id != 'unmatched' LIMIT 1").get(clientNameOrQuestion);
  if (ci) return { clientId: ci.client_id, method: 'ci_match' };

  // Contact map fallback
  const contact = db.prepare('SELECT client_id FROM client_contacts WHERE LOWER(contact_name) = LOWER(?) LIMIT 1').get(clientNameOrQuestion);
  if (contact) return { clientId: contact.client_id, method: 'contact_match' };

  // detectClient substring fallback
  const detected = detectClient(db, clientNameOrQuestion);
  if (detected) return { clientId: detected.clientId, clientName: detected.clientName, method: detected.method };

  return { clientId: null, method: 'none' };
}

// ============ DATA FETCHING ============

function preFetchClientData(db, clientId) {
  if (!clientId) return null;

  const meetings = db.prepare(
    'SELECT id, topic, start_time, duration_minutes, meeting_summary, client_name FROM meetings WHERE client_id = ? ORDER BY start_time DESC LIMIT 5'
  ).all(clientId);

  const actionItems = db.prepare(
    "SELECT title, owner_name, status, due_date, priority, collaborators FROM action_items WHERE client_id = ? AND status IN ('open', 'on-agenda') ORDER BY created_at DESC LIMIT 15"
  ).all(clientId);

  const sessionScores = db.prepare(
    'SELECT se.composite_score, se.client_sentiment, se.accountability, se.value_delivery, se.wins, se.improvements, m.topic, m.start_time FROM session_evaluations se JOIN meetings m ON se.meeting_id = m.id WHERE m.client_id = ? ORDER BY m.start_time DESC LIMIT 3'
  ).all(clientId);

  return { meetings, actionItems, sessionScores, clientName: meetings[0]?.client_name || clientId };
}

// ============ INTENT HANDLERS ============

function handleCountQuery(db, question, clientId) {
  const q = question.toLowerCase();

  // Overdue items (check BEFORE generic action items)
  if (/overdue|past.?due|late|behind/.test(q)) {
    const query = clientId
      ? "SELECT COUNT(*) as count FROM action_items WHERE client_id = ? AND status = 'open' AND due_date IS NOT NULL AND due_date < date('now')"
      : "SELECT COUNT(*) as count FROM action_items WHERE status = 'open' AND due_date IS NOT NULL AND due_date < date('now')";
    const row = db.prepare(query).get(...(clientId ? [clientId] : []));
    const clientLabel = clientId ? ` for ${clientId}` : '';
    return { answer: `There are **${row.count}** overdue action items${clientLabel}.`, tokensUsed: 0 };
  }

  // Determine what to count
  if (/meeting|session|call/.test(q)) {
    const query = clientId
      ? 'SELECT COUNT(*) as count FROM meetings WHERE client_id = ?'
      : 'SELECT COUNT(*) as count FROM meetings';
    const row = db.prepare(query).get(...(clientId ? [clientId] : []));
    const clientLabel = clientId ? ` for ${clientId}` : '';
    return { answer: `There are **${row.count}** meetings${clientLabel} in the system.`, tokensUsed: 0 };
  }

  if (/action item|task|todo/.test(q)) {
    const query = clientId
      ? "SELECT COUNT(*) as count FROM action_items WHERE client_id = ? AND status IN ('open', 'on-agenda')"
      : "SELECT COUNT(*) as count FROM action_items WHERE status IN ('open', 'on-agenda')";
    const row = db.prepare(query).get(...(clientId ? [clientId] : []));
    const clientLabel = clientId ? ` for ${clientId}` : '';
    return { answer: `There are **${row.count}** open action items${clientLabel}.`, tokensUsed: 0 };
  }

  // Generic count
  const meetingCount = db.prepare(
    clientId ? 'SELECT COUNT(*) as count FROM meetings WHERE client_id = ?' : 'SELECT COUNT(*) as count FROM meetings'
  ).get(...(clientId ? [clientId] : []));
  return { answer: `There are **${meetingCount.count}** meetings${clientId ? ` for ${clientId}` : ''}.`, tokensUsed: 0 };
}

async function handleActionItems(db, question, clientId, intentFilters) {
  let sql = "SELECT title, owner_name, status, due_date, priority, collaborators, client_id FROM action_items WHERE 1=1";
  const params = [];

  if (clientId) { sql += ' AND client_id = ?'; params.push(clientId); }

  // Overdue filter
  const q = question.toLowerCase();
  if (/overdue|past.?due|late|behind/.test(q) || intentFilters?.status === 'overdue') {
    sql += " AND status = 'open' AND due_date IS NOT NULL AND due_date < date('now')";
  } else {
    const status = intentFilters?.status || 'open';
    if (status !== 'all') { sql += " AND status IN ('open', 'on-agenda')"; }
  }

  // Owner filter from intent or question
  const owner = intentFilters?.owner || null;
  if (owner) {
    sql += ' AND LOWER(owner_name) LIKE ?';
    params.push('%' + owner.toLowerCase() + '%');
  } else {
    // Check question for owner patterns: "Dan's items", "Manuel's tasks"
    const ownerMatch = question.match(/(\w+)(?:'s|s')\s*(?:action|item|task|todo|open|overdue)/i);
    if (ownerMatch) {
      sql += ' AND LOWER(owner_name) LIKE ?';
      params.push('%' + ownerMatch[1].toLowerCase() + '%');
    }
  }

  sql += ' ORDER BY due_date ASC, created_at DESC LIMIT 25';
  const items = db.prepare(sql).all(...params);
  return { actionItems: items };
}

async function handleSentimentAnalysis(db, question, clientId) {
  const query = clientId
    ? 'SELECT se.composite_score, se.client_sentiment, se.accountability, se.wins, se.improvements, m.topic, m.start_time, m.client_name FROM session_evaluations se JOIN meetings m ON se.meeting_id = m.id WHERE m.client_id = ? ORDER BY m.start_time DESC LIMIT 5'
    : 'SELECT se.composite_score, se.client_sentiment, se.accountability, se.wins, se.improvements, m.topic, m.start_time, m.client_name FROM session_evaluations se JOIN meetings m ON se.meeting_id = m.id ORDER BY m.start_time DESC LIMIT 10';
  const sessions = db.prepare(query).all(...(clientId ? [clientId] : []));
  return { sessions };
}

async function handleMeetingPrep(db, question, clientId) {
  const preFetched = preFetchClientData(db, clientId);

  // Also get decisions
  const decisions = clientId
    ? db.prepare('SELECT d.decision, d.context, m.start_time FROM decisions d JOIN meetings m ON d.meeting_id = m.id WHERE d.client_id = ? ORDER BY m.start_time DESC LIMIT 10').all(clientId)
    : [];

  return { preFetched, decisions };
}

async function handleMetaAnalysis(db) {
  // Overdue items across all clients
  const overdue = db.prepare(
    "SELECT ai.title, ai.owner_name, ai.due_date, ai.client_id, m.client_name FROM action_items ai LEFT JOIN meetings m ON ai.meeting_id = m.id WHERE ai.status = 'open' AND ai.due_date < date('now') ORDER BY ai.due_date ASC LIMIT 20"
  ).all();

  // Declining scores (clients with latest score < previous)
  const allScores = db.prepare(
    'SELECT se.composite_score, m.client_id, m.client_name, m.start_time FROM session_evaluations se JOIN meetings m ON se.meeting_id = m.id ORDER BY m.start_time DESC'
  ).all();

  // Group by client, find declining trends
  const clientScores = {};
  for (const s of allScores) {
    if (!s.client_id || s.client_id === 'unmatched') continue;
    if (!clientScores[s.client_id]) clientScores[s.client_id] = [];
    clientScores[s.client_id].push(s);
  }

  const declining = [];
  for (const [cid, scores] of Object.entries(clientScores)) {
    if (scores.length >= 2 && scores[0].composite_score < scores[1].composite_score) {
      declining.push({ client_id: cid, client_name: scores[0].client_name, latest: scores[0].composite_score, previous: scores[1].composite_score });
    }
  }

  // Clients with no recent meetings (gaps)
  const gaps = db.prepare(
    "SELECT client_id, client_name, MAX(start_time) as last_meeting FROM meetings WHERE client_id IS NOT NULL AND client_id != 'unmatched' GROUP BY client_id HAVING last_meeting < datetime('now', '-14 days') ORDER BY last_meeting ASC LIMIT 10"
  ).all();

  return { overdue, declining, gaps };
}

async function handleTemporalSearch(db, question, clientId, topK) {
  const { chunkIndex } = ensureIndex(db);
  if (chunkIndex.size === 0) return { chunks: [] };

  const queryEmbed = await embedChunk(question);
  const results = searchSimilar(queryEmbed, chunkIndex, topK * 2, clientId || null);

  // Hydrate and group by date
  const chunks = results.map(r => {
    const chunk = db.prepare('SELECT * FROM transcript_chunks WHERE id = ?').get(r.chunkId);
    if (!chunk) return null;
    const meeting = db.prepare('SELECT topic, start_time, client_name FROM meetings WHERE id = ?').get(chunk.meeting_id);
    return {
      ...chunk,
      meeting_topic: meeting?.topic || 'Unknown',
      meeting_date: meeting?.start_time || '',
      client_name: meeting?.client_name || '',
      similarity: r.similarity
    };
  }).filter(Boolean);

  return { chunks };
}

// ============ SMART ROUTER ============

async function routeAndRetrieve(db, question, intent, clientId, meetingId, topK, intentResult) {
  switch (intent) {
    case 'count_query': {
      const result = handleCountQuery(db, question, clientId);
      return { directAnswer: result.answer, tokensUsed: 0, skipLLM: true };
    }

    case 'action_items': {
      const { actionItems } = await handleActionItems(db, question, clientId, intentResult?.filters);
      const preFetched = preFetchClientData(db, clientId);
      return {
        context: { actionItems, preFetched, meetingTimeline: preFetched?.meetings },
        model: ANSWER_MODEL
      };
    }

    case 'sentiment_analysis': {
      const { sessions } = await handleSentimentAnalysis(db, question, clientId);
      const preFetched = preFetchClientData(db, clientId);
      return {
        context: { sessions, preFetched, meetingTimeline: preFetched?.meetings },
        model: ANSWER_MODEL
      };
    }

    case 'meeting_prep': {
      const { preFetched, decisions } = await handleMeetingPrep(db, question, clientId);
      // Also get transcript highlights
      let chunks = [];
      try {
        const ctx = await retrieveContext(db, question, 'client_brief', { clientId, topK });
        chunks = ctx.chunks || [];
      } catch {}

      return {
        context: {
          preFetched,
          meetingTimeline: preFetched?.meetings,
          actionItems: preFetched?.actionItems,
          sessions: preFetched?.sessionScores,
          chunks,
          decisions
        },
        model: COMPLEX_ANSWER_MODEL
      };
    }

    case 'meta_analysis': {
      const { overdue, declining, gaps } = await handleMetaAnalysis(db);
      return {
        context: { overdue, declining, gaps },
        model: COMPLEX_ANSWER_MODEL
      };
    }

    case 'temporal_search': {
      const { chunks } = await handleTemporalSearch(db, question, clientId, topK);
      const preFetched = preFetchClientData(db, clientId);
      return {
        context: { chunks, preFetched, meetingTimeline: preFetched?.meetings },
        model: ANSWER_MODEL
      };
    }

    case 'transcript_search':
    case 'meeting_summary':
    default: {
      const queryType = intent === 'meeting_summary' ? 'transcript_search' : 'transcript_search';
      const context = await retrieveContext(db, question, queryType, { clientId, topK });
      return { context, model: ANSWER_MODEL };
    }
  }
}

// ============ GPT ANSWER GENERATION ============

const SYSTEM_PROMPT = `You are the Transcripts AI Concierge for the B3X meeting dashboard. You answer questions about client meetings using ONLY the provided context — meeting transcripts, action items, and session evaluations.

Rules:
- ALWAYS cite your sources: mention the meeting date, speaker name, and timestamp when quoting transcripts
- Format citations as: [Meeting: {date} | {speaker} at {timestamp}]
- If the context doesn't contain the answer, say so — never make up information
- Be concise but thorough — aim for 2-4 paragraphs
- When discussing action items, include their status (open/complete/on-agenda)
- When discussing sentiment, reference specific session evaluation scores
- Use the speaker names from the transcripts, not generic references
- When asked for a "brief" or "overview", synthesize all available data sources
- You have access to a Meeting Timeline showing the client's recent meetings with summaries — use this for temporal context`;

const META_SYSTEM_PROMPT = `You are the Transcripts AI Concierge for the B3X meeting dashboard. You're answering a meta-analysis question about the overall client portfolio.

Rules:
- Summarize findings clearly with specific numbers
- Flag urgent items first (overdue tasks, declining scores)
- Group information by client
- Suggest prioritized actions
- Be direct and actionable`;

function formatMetaContext(context) {
  const parts = [];

  if (context.overdue?.length > 0) {
    parts.push(`=== Overdue Action Items (${context.overdue.length}) ===`);
    for (const item of context.overdue) {
      parts.push(`- [OVERDUE] ${item.title} (Owner: ${item.owner_name || 'TBD'}, Due: ${item.due_date}, Client: ${item.client_name || item.client_id})`);
    }
  }

  if (context.declining?.length > 0) {
    parts.push(`\n=== Declining Sentiment Scores ===`);
    for (const d of context.declining) {
      parts.push(`- ${d.client_name || d.client_id}: ${d.previous} → ${d.latest} (dropped ${d.previous - d.latest} points)`);
    }
  }

  if (context.gaps?.length > 0) {
    parts.push(`\n=== Meeting Gaps (>14 days since last meeting) ===`);
    for (const g of context.gaps) {
      parts.push(`- ${g.client_name || g.client_id}: last meeting ${g.last_meeting}`);
    }
  }

  return parts.join('\n') || 'No risk flags found.';
}

async function generateWithGPT(question, context, chatHistory, intent, model) {
  const isMetaAnalysis = intent === 'meta_analysis';
  const systemPrompt = isMetaAnalysis ? META_SYSTEM_PROMPT : SYSTEM_PROMPT;
  const contextBlock = isMetaAnalysis ? formatMetaContext(context) : formatContext(context);

  const messages = [
    { role: 'system', content: systemPrompt },
    ...chatHistory.slice(-6).map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: `${question}\n\n---\nContext:\n${contextBlock}` }
  ];

  const startTime = Date.now();

  const response = await openai.chat.completions.create({
    model,
    max_completion_tokens: 1500,
    temperature: 0.3,
    messages
  });

  const latencyMs = Date.now() - startTime;
  const answer = response.choices[0].message.content;
  const tokensUsed = (response.usage?.prompt_tokens || 0) + (response.usage?.completion_tokens || 0);

  return { answer, tokensUsed, latencyMs };
}

// ============ MAIN INTERFACE ============

export async function handleChat(db, question, { clientId = null, meetingId = null, chatHistory = [], topK = 10 } = {}) {
  const startTime = Date.now();

  // 1. Resolve client
  let resolvedClient;
  if (meetingId && !clientId) {
    const meeting = db.prepare('SELECT client_id, client_name FROM meetings WHERE id = ?').get(meetingId);
    if (meeting?.client_id && meeting.client_id !== 'unmatched') {
      resolvedClient = { clientId: meeting.client_id, method: 'meeting_scope' };
    } else {
      resolvedClient = resolveClientId(db, question, null);
    }
  } else {
    resolvedClient = resolveClientId(db, question, clientId);
  }
  const effectiveClientId = resolvedClient.clientId;

  const sessionClientId = effectiveClientId; // save session-inherited client

  // 2. Classify intent — try regex fast-path first
  let intentResult;
  const fastIntent = regexFastPath(question, meetingId);
  if (fastIntent) {
    intentResult = { intent: fastIntent, confidence: 1.0, method: 'regex' };
  } else {
    intentResult = await classifyWithLLM(question, chatHistory, db);
  }

  const { intent } = intentResult;

  // 2b. If LLM classifier resolved a client from context, use it
  if (!resolvedClient.clientId && intentResult.client) {
    const llmResolved = resolveClientId(db, intentResult.client, null);
    if (llmResolved.clientId) {
      resolvedClient = llmResolved;
    }
  }
  // 2c. If regex fast-path was used and no client yet, run LLM classifier just for client extraction
  if (!resolvedClient.clientId && intentResult.method === 'regex') {
    const llmResult = await classifyWithLLM(question, chatHistory, db);
    if (llmResult?.client) {
      const llmResolved = resolveClientId(db, llmResult.client, null);
      if (llmResolved.clientId) {
        resolvedClient = llmResolved;
        console.log('[v3] LLM resolved client after regex fast-path:', llmResolved.clientId);
      }
    }
  }
  // 2d. If still no client, restore session-inherited client
  if (!resolvedClient.clientId && sessionClientId) {
    resolvedClient = { clientId: sessionClientId, method: 'session_restore' };
    console.log('[v3] Restored session client:', sessionClientId);
  }
  const effectiveClientIdFinal = resolvedClient.clientId;

  // 3. Fallback clarification for client-specific intents without a client
  if (!effectiveClientIdFinal && ['sentiment_analysis', 'meeting_prep', 'meeting_summary'].includes(intent)) {
    const recentClients = db.prepare(
      "SELECT DISTINCT client_name FROM meetings WHERE client_id IS NOT NULL AND client_id != 'unmatched' ORDER BY start_time DESC LIMIT 5"
    ).all();
    const suggestions = recentClients.map(c => c.client_name).join(', ');

    logQuery({
      query: question, intent, intentMethod: intentResult.method, intentConfidence: intentResult.confidence,
      clientDetected: null, clientMethod: 'none', retrievalPath: 'clarification', model: 'system', tokensUsed: 0
    });

    return {
      answer: `I couldn't identify which client you're asking about. Could you mention the client name? Recent clients: ${suggestions}`,
      citations: [],
      queryType: intent,
      model: 'system',
      tokensUsed: 0,
      chunksUsed: 0,
      latencyMs: Date.now() - startTime,
      needsClarification: true,
      clientDetected: null
    };
  }

  // 4. Route and retrieve data
  const routeResult = await routeAndRetrieve(db, question, intent, effectiveClientIdFinal, meetingId, topK, intentResult);

  // 5. If direct answer (count_query), return immediately
  if (routeResult.skipLLM) {
    logQuery({
      query: question, intent, intentMethod: intentResult.method, intentConfidence: intentResult.confidence,
      clientDetected: effectiveClientIdFinal, clientMethod: resolvedClient.method, retrievalPath: 'sql_direct',
      model: 'none', tokensUsed: 0, latencyMs: Date.now() - startTime
    });

    return {
      answer: routeResult.directAnswer,
      citations: [],
      queryType: intent,
      model: 'sql',
      tokensUsed: 0,
      chunksUsed: 0,
      latencyMs: Date.now() - startTime,
      clientDetected: effectiveClientIdFinal
    };
  }

  // 6. Generate answer with GPT
  const model = routeResult.model || ANSWER_MODEL;
  const { answer, tokensUsed, latencyMs: gptLatency } = await generateWithGPT(
    question, routeResult.context, chatHistory, intent, model
  );

  const totalLatency = Date.now() - startTime;

  logQuery({
    query: question, intent, intentMethod: intentResult.method, intentConfidence: intentResult.confidence,
    clientDetected: effectiveClientIdFinal, clientMethod: resolvedClient.method,
    retrievalPath: intent, model, tokensUsed, latencyMs: totalLatency,
    chunksReturned: routeResult.context?.chunks?.length || 0
  });

  return {
    answer,
    citations: [],
    queryType: intent,
    model,
    tokensUsed,
    chunksUsed: routeResult.context?.chunks?.length || 0,
    latencyMs: totalLatency,
    clientDetected: effectiveClientIdFinal
  };
}
