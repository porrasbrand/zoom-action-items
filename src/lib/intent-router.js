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

  // "When" questions about meetings are temporal, not count
  if (/\bwhen('s| is| was| will)\b/.test(q) && /\b(next|last|upcoming|previous|recent)\b/.test(q) && /\bmeeting|call|session\b/.test(q)) {
    return 'temporal_search';
  }

  // Count queries - but NOT if user says "show me" or "list" (they want the actual items, not a count)
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
  // "Show me" / "list" patterns should NOT be count_query — they want the actual items
  if (/^(show|list|display|give me|what are)\b/.test(q) && /\b(overdue|action|item|task|open)\b/.test(q)) return 'action_items';
  if (/^(count|total|number of)\b/.test(q) || /\bhow many\b/.test(q)) return 'count_query';
  if (/\b(brief|prep me|prepare me|catch me up|what do i need to know)\b/.test(q)) return 'meeting_prep';
  if (/\b(which clients? need|who needs attention|at risk|neglected|stale)\b/.test(q)) return 'meta_analysis';
  if (/\b(ever discuss|first mention|history of|timeline|when was.*first|has.*come up|did we.*discuss)\b/.test(q)) return 'temporal_search';

  // Cross-client / portfolio-level analysis patterns
  if (/\b(across all|across clients?|all clients?|portfolio|most common|churn risk|trending|patterns?)\b/.test(q) && /\b(topic|theme|frustrat|sentiment|risk|pattern|common)\b/.test(q)) return 'meta_analysis';
  if (/\btop \d+\b.*\b(calls?|meetings?|important)\b/.test(q)) return 'meta_analysis';

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

IMPORTANT: For the "client" field, return the EXACT client name from the list above. If the user says a partial name or abbreviation, match to the closest client. If using pronouns (their/those/that), resolve from conversation context. If no client matches, return null.

Additional fields to include in your JSON response:
- "count_entity": For count_query intent, what entity is being counted? One of: "clients", "meetings", "action_items", "overdue", or null. Use "clients" when user asks how many clients/accounts/customers. Use "meetings" for meetings/sessions/calls. Use "action_items" for tasks/items/todos. Use "overdue" when user asks about overdue/late/past-due items.
- "format_hint": Suggest a display format. One of: "priority_list", "comparison", "table", or null.
- "comparison_clients": If the user is comparing two or more clients, list their EXACT names as an array. Otherwise null.

Examples:
Q: "How many total clients?" → {"intent":"count_query","client":null,"confidence":0.99,"count_entity":"clients","format_hint":null,"comparison_clients":null}
Q: "How many meetings with Echelon?" → {"intent":"count_query","client":"Echelon","confidence":0.95,"count_entity":"meetings","format_hint":null,"comparison_clients":null}
Q: "How many overdue items?" → {"intent":"count_query","client":null,"confidence":0.95,"count_entity":"overdue","format_hint":null,"comparison_clients":null}
Q: "Compare Echelon and Zuma sentiment" → {"intent":"sentiment_analysis","client":null,"confidence":0.9,"count_entity":null,"format_hint":"comparison","comparison_clients":["Echelon","Zuma"]}`;
}

// ============ TOPIC NORMALIZATION ============

function normalizeTopic(topic) {
  if (!topic) return null;
  const t = topic.toLowerCase();
  if (/client|account|customer/.test(t)) return 'clients';
  if (/meeting|session|call|huddle/.test(t)) return 'meetings';
  if (/action|item|task|todo/.test(t)) return 'action_items';
  if (/overdue|late|past.?due/.test(t)) return 'overdue';
  return t;
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

  const prompt = buildClassifierPrompt(db) + contextMessages + '\nQuestion: "' + question + '"\n\nRespond with JSON: {"intent": "<category>", "client": "<EXACT name from Known clients or null>", "confidence": <0.0-1.0>, "count_entity": "<clients|meetings|action_items|null>", "format_hint": "<priority_list|comparison|table|null>", "comparison_clients": ["<client names>"] or null}';

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const parsed = JSON.parse(text);

    if (INTENT_CATEGORIES.includes(parsed.intent)) {
      return {
        intent: parsed.intent,
        confidence: parsed.confidence || 0.8,
        method: 'llm',
        client: parsed.client || null,
        classifierOutput: parsed
      };
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

function handleCountQuery(db, question, clientId, classifierOutput) {
  const q = question.toLowerCase();

  // Determine entity from classifier output first, then normalizeTopic, then regex fallback
  let entity = classifierOutput?.count_entity || null;
  if (!entity && classifierOutput?.topic) {
    entity = normalizeTopic(classifierOutput.topic);
  }
  // Regex fallback only if classifier didn't resolve
  if (!entity) {
    if (/overdue|past.?due|late|behind/.test(q)) entity = 'overdue';
    else if (/client|account|customer/.test(q)) entity = 'clients';
    else if (/meeting|session|call/.test(q)) entity = 'meetings';
    else if (/action.?item|task|todo/.test(q)) entity = 'action_items';
  }

  const clientLabel = clientId ? ` for ${clientId}` : '';

  // Handle each entity type
  if (entity === 'overdue') {
    const query = clientId
      ? "SELECT COUNT(*) as count FROM action_items WHERE client_id = ? AND status = 'open' AND due_date IS NOT NULL AND due_date < date('now')"
      : "SELECT COUNT(*) as count FROM action_items WHERE status = 'open' AND due_date IS NOT NULL AND due_date < date('now')";
    const row = db.prepare(query).get(...(clientId ? [clientId] : []));
    return { answer: `There are **${row.count}** overdue action items${clientLabel}.`, tokensUsed: 0 };
  }

  if (entity === 'clients') {
    const row = db.prepare(
      "SELECT COUNT(DISTINCT client_id) as count FROM meetings WHERE client_id IS NOT NULL AND client_id != 'unmatched'"
    ).get();
    return { answer: `There are **${row.count}** clients in the system.`, tokensUsed: 0 };
  }

  if (entity === 'meetings') {
    // Check for time-scoped queries
    let timeFilter = '';
    let timeLabel = '';
    if (/this month|current month/.test(q)) {
      timeFilter = " AND start_time >= date('now', 'start of month')";
      timeLabel = ' this month';
    } else if (/this week|current week/.test(q)) {
      timeFilter = " AND start_time >= date('now', 'weekday 0', '-7 days')";
      timeLabel = ' this week';
    } else if (/today/.test(q)) {
      timeFilter = " AND date(start_time) = date('now')";
      timeLabel = ' today';
    } else if (/last month|previous month/.test(q)) {
      timeFilter = " AND start_time >= date('now', 'start of month', '-1 month') AND start_time < date('now', 'start of month')";
      timeLabel = ' last month';
    }

    const query = clientId
      ? `SELECT COUNT(*) as count FROM meetings WHERE client_id = ?${timeFilter}`
      : `SELECT COUNT(*) as count FROM meetings WHERE 1=1${timeFilter}`;
    const row = db.prepare(query).get(...(clientId ? [clientId] : []));
    const scopeLabel = timeLabel || ' in the system';
    return { answer: `There are **${row.count}** meetings${clientLabel}${scopeLabel}.`, tokensUsed: 0 };
  }

  if (entity === 'action_items') {
    const query = clientId
      ? "SELECT COUNT(*) as count FROM action_items WHERE client_id = ? AND status IN ('open', 'on-agenda')"
      : "SELECT COUNT(*) as count FROM action_items WHERE status IN ('open', 'on-agenda')";
    const row = db.prepare(query).get(...(clientId ? [clientId] : []));
    return { answer: `There are **${row.count}** open action items${clientLabel}.`, tokensUsed: 0 };
  }

  // Default fallback: count meetings
  const meetingCount = db.prepare(
    clientId ? 'SELECT COUNT(*) as count FROM meetings WHERE client_id = ?' : 'SELECT COUNT(*) as count FROM meetings'
  ).get(...(clientId ? [clientId] : []));
  return { answer: `There are **${meetingCount.count}** meetings${clientLabel}.`, tokensUsed: 0 };
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

async function handleComparison(db, comparisonClients) {
  const sections = [];

  for (const clientName of comparisonClients) {
    const resolved = resolveClientId(db, clientName, null);
    const clientId = resolved.clientId;
    if (!clientId) {
      sections.push(`## ${clientName}\n_Client not found in database._`);
      continue;
    }

    // Meetings (last 5 with summaries)
    const meetings = db.prepare(
      'SELECT topic, start_time, duration_minutes, meeting_summary FROM meetings WHERE client_id = ? ORDER BY start_time DESC LIMIT 5'
    ).all(clientId);

    // Open action items
    const openItems = db.prepare(
      "SELECT title, owner_name, due_date, priority FROM action_items WHERE client_id = ? AND status IN ('open', 'on-agenda') ORDER BY due_date ASC LIMIT 5"
    ).all(clientId);
    const openCount = db.prepare(
      "SELECT COUNT(*) as count FROM action_items WHERE client_id = ? AND status IN ('open', 'on-agenda')"
    ).get(clientId);

    // Overdue count
    const overdueCount = db.prepare(
      "SELECT COUNT(*) as count FROM action_items WHERE client_id = ? AND status = 'open' AND due_date IS NOT NULL AND due_date < date('now')"
    ).get(clientId);

    // Session scores (last 5)
    const scores = db.prepare(
      'SELECT se.composite_score, se.client_sentiment, m.start_time FROM session_evaluations se JOIN meetings m ON se.meeting_id = m.id WHERE m.client_id = ? ORDER BY m.start_time DESC LIMIT 5'
    ).all(clientId);

    const avgSentiment = scores.length > 0 ? (scores.reduce((s, r) => s + (r.client_sentiment || 0), 0) / scores.length).toFixed(1) : 'N/A';
    const avgComposite = scores.length > 0 ? (scores.reduce((s, r) => s + (r.composite_score || 0), 0) / scores.length).toFixed(1) : 'N/A';
    const trend = scores.length >= 2 ? (scores[0].composite_score > scores[1].composite_score ? 'improving' : scores[0].composite_score < scores[1].composite_score ? 'declining' : 'stable') : 'insufficient data';

    // Build section
    let section = `## ${clientName}\n`;
    section += `**Meetings (last 5):**\n`;
    for (const m of meetings) {
      section += `- ${m.start_time?.substring(0, 10) || '?'}: ${m.topic || 'Untitled'}${m.meeting_summary ? ' — ' + m.meeting_summary.substring(0, 120) : ''}\n`;
    }
    if (meetings.length === 0) section += `- _No meetings found._\n`;

    section += `\n**Action Items:** ${openCount.count} open`;
    if (overdueCount.count > 0) section += ` (${overdueCount.count} overdue)`;
    section += `\n`;
    for (const item of openItems) {
      section += `- ${item.title} (${item.owner_name || 'TBD'}${item.due_date ? ', Due: ' + item.due_date : ''})\n`;
    }

    section += `\n**Session Scores (last ${scores.length}):** Avg sentiment: ${avgSentiment}, Avg composite: ${avgComposite}, Trend: ${trend}\n`;
    for (const sc of scores) {
      section += `- ${sc.start_time?.substring(0, 10) || '?'}: composite=${sc.composite_score}, sentiment=${sc.client_sentiment}\n`;
    }

    sections.push(section);
  }

  const formattedContext = `=== Client Comparison ===\n\n${sections.join('\n---\n\n')}`;
  return { formattedContext };
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
      const result = handleCountQuery(db, question, clientId, intentResult?.classifierOutput);
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
      // Check for comparison_clients from classifier
      const compClients = intentResult?.classifierOutput?.comparison_clients;
      if (Array.isArray(compClients) && compClients.length >= 2) {
        const { formattedContext } = await handleComparison(db, compClients);
        return {
          context: { formattedContext },
          model: COMPLEX_ANSWER_MODEL
        };
      }
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
      // Check for comparison_clients from classifier
      const compClients = intentResult?.classifierOutput?.comparison_clients;
      if (Array.isArray(compClients) && compClients.length >= 2) {
        const { formattedContext } = await handleComparison(db, compClients);
        return {
          context: { formattedContext },
          model: COMPLEX_ANSWER_MODEL
        };
      }
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

const INTENT_TOKEN_CAPS = {
  count_query: 80,
  action_items: 600,
  meeting_summary: 500,
  sentiment_analysis: 400,
  transcript_search: 500,
  temporal_search: 500,
  meeting_prep: 1000,
  meta_analysis: 800,
};

const SYSTEM_PROMPT = `You are the Transcripts AI Concierge for the B3X meeting dashboard. Answer using ONLY the provided context.

CRITICAL — BREVITY IS YOUR #1 PRIORITY:
- Every response must be as short as possible while still answering the question.
- If the user asks a simple question, give a simple answer. Do NOT add unrequested context.

Format rules:
- Use **bold** for key names, numbers, and decisions.
- Use bullet lists for action items, not numbered prose.
- Never use numbered lists for action items — always use "- " bullets.

Response length (STRICT — exceeding these limits is a failure):
- Count queries: 1 sentence ONLY. No follow-up, no context. Just the number.
- Action item lists: bullets only. Format: - **[STATUS]** Title (Owner, Due: date). No prose between bullets.
- Meeting summaries: 1-2 sentence overview + 3-5 bullet points. Max 120 words total.
- Sentiment analysis: score + 2-3 bullets. Max 80 words total.
- Client briefs: structured with headers. Max 300 words.
- Complex/meta analysis: structured with headers + bullets. Max 250 words. Lead with the direct answer.
- Transcript search: answer the specific question in 2-4 sentences + bullets if needed. Max 150 words.

Citation rules:
- Cite source ONCE at the end: [Source: meeting date]
- Do NOT cite per-paragraph. One citation line at the end.
- Mention speaker names naturally in text.

Content rules:
- Never make up information. Say "I don't have data on that" if context is insufficient.
- When listing action items, always include status and owner.
- Be proactive: suggest 1 brief next step when relevant (1 sentence max).
- IMPORTANT: Answer the EXACT question asked. If user asks "which client has the most X", answer with the client name first, then brief supporting data.
- When the user asks about a SPECIFIC client by name, only discuss that client. Never substitute a different client.
- If the question mentions a client name (e.g., "Echelon"), your answer MUST be about that client, even if the context contains data about other clients. Ignore irrelevant client data.
- If context doesn't contain data about the asked client, say "I don't have data on [client name]" — do NOT answer about a different client instead. This is a HARD RULE.
- For "across all clients" or "most common" questions, synthesize data from ALL clients in context, not just one.
- When listing action items, include ALL items from context. Do not truncate or summarize — show complete list with status, owner, and due date for each.
- If the user asks for action items WITHOUT specifying a client, show ALL available action items from context. Do NOT refuse just because a previously mentioned client doesn't exist.
- If the question cannot be answered with available data (e.g., asking for a metric you can't compute), clearly state what data is missing and suggest what would be needed.`;

const META_SYSTEM_PROMPT = `You are the Transcripts AI Concierge for the B3X meeting dashboard. You're answering a meta-analysis question about the overall client portfolio.

CRITICAL — BREVITY FIRST:
- Lead with the direct answer to the question in the FIRST sentence.
- Max 200 words total. Use short bullets, not paragraphs.
- Flag urgent items first (overdue tasks, declining scores).
- Group information by client using **bold** names.
- End with 1 actionable next step (1 sentence).
- Do NOT repeat data the user didn't ask for. Stay focused on the question.
- For "top N" questions, list exactly N items. For "which client" questions, name the client first.
- For cross-client topic/theme questions, list the topics as bullets — do NOT organize by client unless asked.`;

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

async function generateWithGPT(question, context, chatHistory, intent, model, formatHint) {
  const isMetaAnalysis = intent === 'meta_analysis';
  let systemPrompt = isMetaAnalysis ? META_SYSTEM_PROMPT : SYSTEM_PROMPT;

  // Wire format_hint for priority lists
  if (formatHint === 'priority_list') {
    systemPrompt += '\n\nFormat as a numbered priority list (max 5). Each: **[Client]** — Action — Why urgent.';
  }

  // Use formattedContext directly if available (e.g. from comparison handler)
  const contextBlock = context.formattedContext
    ? context.formattedContext
    : isMetaAnalysis ? formatMetaContext(context) : formatContext(context);

  // Limit chat history and add a reminder about the current question
  const historyMessages = chatHistory.slice(-6).map(m => ({ role: m.role, content: m.content }));

  const messages = [
    { role: 'system', content: systemPrompt },
    ...historyMessages,
    { role: 'user', content: `${question}\n\n---\nContext:\n${contextBlock}` }
  ];

  const startTime = Date.now();
  const maxTokens = INTENT_TOKEN_CAPS[intent] || 800;

  const response = await openai.chat.completions.create({
    model,
    max_completion_tokens: maxTokens,
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
  // 2c. If regex fast-path was used, run LLM classifier for client extraction AND structured fields
  if (intentResult.method === 'regex') {
    const llmResult = await classifyWithLLM(question, chatHistory, db);
    // Always capture classifierOutput for structured fields (count_entity, etc.)
    if (llmResult?.classifierOutput) {
      intentResult.classifierOutput = llmResult.classifierOutput;
      intentResult.client = llmResult.client || intentResult.client;
    }
    if (!resolvedClient.clientId && llmResult?.client) {
      const llmResolved = resolveClientId(db, llmResult.client, null);
      if (llmResolved.clientId) {
        resolvedClient = llmResolved;
        console.log('[v3] LLM resolved client after regex fast-path:', llmResolved.clientId);
      }
    }
  }
  // 2d. If still no client, restore session-inherited client
  // BUT: for count_query where the classifier found NO client, do NOT inherit session client.
  // e.g., "How many total clients?" should never scope to a session client.
  if (!resolvedClient.clientId && sessionClientId) {
    const classifierFoundNoClient = intentResult.client === null || intentResult.client === undefined;
    if (intent === 'count_query' && classifierFoundNoClient) {
      console.log('[v3] count_query with no classifier client — skipping session restore');
    } else {
      resolvedClient = { clientId: sessionClientId, method: 'session_restore' };
      console.log('[v3] Restored session client:', sessionClientId);
    }
  }
  const effectiveClientIdFinal = resolvedClient.clientId;

  // 3. Fallback clarification for client-specific intents without a client
  //    Skip if comparison_clients is present — the comparison handler resolves clients itself
  const hasComparisonClients = Array.isArray(intentResult?.classifierOutput?.comparison_clients) && intentResult.classifierOutput.comparison_clients.length >= 2;
  if (!effectiveClientIdFinal && !hasComparisonClients && ['meeting_prep', 'meeting_summary'].includes(intent)) {
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
  const formatHint = intentResult?.classifierOutput?.format_hint || null;
  const { answer, tokensUsed, latencyMs: gptLatency } = await generateWithGPT(
    question, routeResult.context, chatHistory, intent, model, formatHint
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
