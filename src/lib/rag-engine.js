/**
 * RAG Engine v2 — smart pre-fetch + two-stage retrieval
 *
 * Architecture:
 * 1. Always pre-fetch structured data for detected client (meetings, items, scores)
 * 2. Recency queries → direct meeting lookup (no vector search)
 * 3. Topic queries → two-stage funnel (meeting embeddings → chunk embeddings)
 * 4. Structured queries → pre-fetched data only
 * 5. ONE LLM call with full context
 */

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import fs from 'fs';
import { embedChunk, loadAllEmbeddings, searchSimilar, loadMeetingEmbeddings, searchMeetings, cosineSimilarity } from './transcript-embedder.js';

const anthropic = new Anthropic();
const RAG_MODEL = process.env.RAG_MODEL || 'claude-3-haiku-20240307';

// In-memory indexes (loaded once)
let chunkIndex = null;
let meetingIndex = null;

export function ensureIndex(db) {
  if (!chunkIndex) {
    chunkIndex = loadAllEmbeddings(db);
    console.log(`[RAG] Loaded ${chunkIndex.size} chunk embeddings`);
  }
  if (!meetingIndex) {
    meetingIndex = loadMeetingEmbeddings(db);
    console.log(`[RAG] Loaded ${meetingIndex.size} meeting embeddings`);
  }
  return { chunkIndex, meetingIndex };
}

export function invalidateIndex() {
  chunkIndex = null;
  meetingIndex = null;
  contactMap = null;
}

// ============ CLIENT AUTO-DETECTION ============

let contactMap = null;

function buildContactMap(db) {
  const contacts = db.prepare('SELECT contact_name, client_id, client_name FROM client_contacts').all();
  const clients = db.prepare("SELECT DISTINCT client_id, client_name FROM meetings WHERE client_id IS NOT NULL AND client_id != 'unmatched'").all();

  const entries = [];
  for (const c of contacts) {
    entries.push({ name: c.contact_name.toLowerCase(), clientId: c.client_id, clientName: c.client_name || c.client_id });
  }
  for (const c of clients) {
    if (c.client_name) entries.push({ name: c.client_name.toLowerCase(), clientId: c.client_id, clientName: c.client_name });
    entries.push({ name: c.client_id.replace(/-/g, ' '), clientId: c.client_id, clientName: c.client_name || c.client_id });
  }
  // Sort longest first so 'Andrew Williams' matches before 'Andrew'
  entries.sort((a, b) => b.name.length - a.name.length);
  return entries;
}

export function detectClient(db, question) {
  if (!contactMap) contactMap = buildContactMap(db);
  const qLower = question.toLowerCase();

  for (const entry of contactMap) {
    if (entry.name.length >= 3 && qLower.includes(entry.name)) {
      return { clientId: entry.clientId, clientName: entry.clientName, method: 'substring_match', matched: entry.name };
    }
  }
  return null;
}

// ============ QUERY LOGGING ============

const LOG_PATH = 'data/concierge-queries.jsonl';

function logQuery(entry) {
  try {
    const line = JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + '\n';
    fs.appendFileSync(LOG_PATH, line);
  } catch {}
}

// ============ QUERY ROUTER ============

export function classifyQuery(question) {
  const q = question.toLowerCase();
  if (/open.*item|pending.*item|overdue|action item|task.*open|what.*open|status.*item/.test(q)) return 'action_items';
  if (/score|sentiment|mood|engagement|evaluation|session.*score|coaching|frustration|composite/.test(q)) return 'session_analysis';
  if (/brief|overview|history|prepare|prep me|catch me up|what do i need to know|summary.*client/.test(q)) return 'client_brief';
  if (/cross.?client|all clients|compare|across|trend/.test(q)) return 'cross_client';
  return 'transcript_search';
}

function detectRecency(question) {
  return /last|latest|most recent|previous|yesterday|this week|today/.test(question.toLowerCase());
}

// ============ PRE-FETCH STRUCTURED DATA ============

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

// ============ RECENCY RETRIEVAL ============

function getRecentMeetingContext(db, clientId) {
  const meeting = db.prepare(
    'SELECT id, topic, start_time, duration_minutes, meeting_summary, client_name FROM meetings WHERE client_id = ? AND transcript_raw IS NOT NULL ORDER BY start_time DESC LIMIT 1'
  ).get(clientId);
  if (!meeting) return null;

  const chunks = db.prepare(
    'SELECT text, start_time, end_time, speakers FROM transcript_chunks WHERE meeting_id = ? ORDER BY chunk_index ASC'
  ).all(meeting.id);

  return { meeting, chunks };
}

// ============ TWO-STAGE FUNNEL ============

async function twoStageFunnel(db, question, clientId, topMeetingCount = 3, topChunkCount = 8) {
  const { chunkIndex: ci, meetingIndex: mi } = ensureIndex(db);
  if (mi.size === 0) return [];

  const queryEmbed = await embedChunk(question);

  // Stage 1: Find top meetings by summary embedding
  const topMeetings = searchMeetings(queryEmbed, mi, topMeetingCount * 2);

  // Filter by client if specified
  let filteredMeetings = topMeetings;
  if (clientId) {
    const clientMeetingIds = new Set(
      db.prepare('SELECT id FROM meetings WHERE client_id = ?').all(clientId).map(m => m.id)
    );
    filteredMeetings = topMeetings.filter(m => clientMeetingIds.has(m.meetingId)).slice(0, topMeetingCount);
  } else {
    filteredMeetings = topMeetings.slice(0, topMeetingCount);
  }

  if (filteredMeetings.length === 0) return [];

  // Stage 2: Search chunks ONLY within matched meetings
  const meetingIds = new Set(filteredMeetings.map(m => m.meetingId));
  const results = [];

  for (const [chunkId, data] of ci) {
    if (!meetingIds.has(data.meeting_id)) continue;
    if (clientId && data.client_id !== clientId) continue;
    const sim = cosineSimilarity(queryEmbed, data.embedding);
    results.push({ chunkId, similarity: sim, meeting_id: data.meeting_id });
  }

  results.sort((a, b) => b.similarity - a.similarity);
  const topChunks = results.slice(0, topChunkCount);

  // Hydrate chunks with full data
  return topChunks.map(r => {
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
}

// ============ CONTEXT RETRIEVAL (REWRITTEN) ============

export async function retrieveContext(db, question, queryType, { clientId = null, topK = 10 } = {}) {
  const context = {};
  const wantsRecent = detectRecency(question);

  // ALWAYS pre-fetch structured data for client-scoped queries
  if (clientId) {
    const preFetched = preFetchClientData(db, clientId);
    if (preFetched) {
      context.preFetched = preFetched;
      // Include meetings with summaries in context for temporal awareness
      context.meetingTimeline = preFetched.meetings;
    }
  }

  // TRANSCRIPT SEARCH or CLIENT BRIEF — need transcript content
  if (queryType === 'transcript_search' || queryType === 'client_brief') {

    if (wantsRecent && clientId) {
      // RECENCY: direct meeting lookup, no vector search
      const recent = getRecentMeetingContext(db, clientId);
      if (recent) {
        context.recentMeeting = recent.meeting;
        context.chunks = recent.chunks.map(c => ({
          ...c,
          meeting_topic: recent.meeting.topic,
          meeting_date: recent.meeting.start_time,
          client_name: recent.meeting.client_name,
          similarity: 1.0
        }));
      }
    } else {
      // TOPIC SEARCH: two-stage funnel
      context.chunks = await twoStageFunnel(db, question, clientId, 3, topK);
    }
  }

  // ACTION ITEMS — use pre-fetched data or fetch fresh
  if (queryType === 'action_items' || queryType === 'client_brief') {
    if (context.preFetched?.actionItems) {
      context.actionItems = context.preFetched.actionItems;
    } else {
      const query = clientId
        ? "SELECT title, owner_name, status, due_date, priority, collaborators FROM action_items WHERE client_id = ? AND status IN ('open', 'on-agenda') ORDER BY created_at DESC LIMIT 20"
        : "SELECT title, owner_name, status, due_date, priority, collaborators FROM action_items WHERE status IN ('open', 'on-agenda') ORDER BY created_at DESC LIMIT 20";
      context.actionItems = db.prepare(query).all(...(clientId ? [clientId] : []));
    }
  }

  // SESSION SCORES — use pre-fetched data or fetch fresh
  if (queryType === 'session_analysis' || queryType === 'client_brief') {
    if (context.preFetched?.sessionScores) {
      context.sessions = context.preFetched.sessionScores;
    } else {
      const query = clientId
        ? 'SELECT se.composite_score, se.client_sentiment, se.accountability, se.wins, se.improvements, m.topic, m.start_time, m.client_name FROM session_evaluations se JOIN meetings m ON se.meeting_id = m.id WHERE m.client_id = ? ORDER BY m.start_time DESC LIMIT 5'
        : 'SELECT se.composite_score, se.client_sentiment, se.accountability, se.wins, se.improvements, m.topic, m.start_time, m.client_name FROM session_evaluations se JOIN meetings m ON se.meeting_id = m.id ORDER BY m.start_time DESC LIMIT 10';
      context.sessions = db.prepare(query).all(...(clientId ? [clientId] : []));
    }
  }

  // CROSS-CLIENT / NO CLIENT — standard vector search
  if ((queryType === 'cross_client' || !clientId) && queryType === 'transcript_search') {
    if (!context.chunks || context.chunks.length === 0) {
      const { chunkIndex: ci } = ensureIndex(db);
      if (ci.size > 0) {
        const queryEmbed = await embedChunk(question);
        const similar = searchSimilar(queryEmbed, ci, topK, null);
        context.chunks = similar.map(s => {
          const chunk = db.prepare('SELECT * FROM transcript_chunks WHERE id = ?').get(s.chunkId);
          if (!chunk) return null;
          const meeting = db.prepare('SELECT topic, start_time, client_name FROM meetings WHERE id = ?').get(chunk.meeting_id);
          return { ...chunk, meeting_topic: meeting?.topic || 'Unknown', meeting_date: meeting?.start_time || '', client_name: meeting?.client_name || '', similarity: s.similarity };
        }).filter(Boolean);
      }
    }
  }

  return context;
}

// ============ CONTEXT FORMATTING ============

function formatDate(dateStr) {
  if (!dateStr) return 'Unknown';
  try {
    return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  } catch { return dateStr; }
}

export function formatContext(context) {
  const parts = [];

  // Client header
  if (context.preFetched?.clientName) {
    parts.push(`=== Client: ${context.preFetched.clientName} ===`);
  }

  // Meeting timeline with summaries
  if (context.meetingTimeline?.length > 0) {
    parts.push('\n=== Meeting Timeline ===');
    context.meetingTimeline.forEach((m, i) => {
      const label = i === 0 ? '[Most Recent]' : '';
      parts.push(`${label} ${formatDate(m.start_time)} — ${m.topic} (${m.duration_minutes || '?'} min)`);
      if (m.meeting_summary) {
        const summary = m.meeting_summary.length > 400 ? m.meeting_summary.slice(0, 400) + '...' : m.meeting_summary;
        parts.push(`Summary: ${summary}`);
      }
    });
  }

  // Transcript chunks
  if (context.chunks?.length > 0) {
    parts.push('\n=== Transcript Details ===');
    for (const chunk of context.chunks) {
      const date = formatDate(chunk.meeting_date);
      parts.push(`\n[Meeting: ${date} | ${chunk.meeting_topic}] (relevance: ${chunk.similarity.toFixed(2)})`);
      parts.push(chunk.text);
    }
  }

  // Action items
  if (context.actionItems?.length > 0) {
    parts.push(`\n=== Open Action Items (${context.actionItems.length}) ===`);
    for (const item of context.actionItems) {
      const status = (item.status || 'open').toUpperCase();
      const owner = item.owner_name || 'TBD';
      const due = item.due_date ? ` Due: ${formatDate(item.due_date)}` : '';
      const collab = item.collaborators ? ` (Also: ${item.collaborators})` : '';
      parts.push(`- [${status}] ${item.title} (Owner: ${owner}${due}${collab})`);
    }
  }

  // Session scores
  if (context.sessions?.length > 0) {
    parts.push('\n=== Session Scores ===');
    for (const se of context.sessions) {
      const date = formatDate(se.start_time);
      parts.push(`- ${date}: composite ${se.composite_score}/100, sentiment ${se.client_sentiment}/100, accountability ${se.accountability}/100`);
      if (se.wins) parts.push(`  Wins: ${se.wins}`);
      if (se.improvements) parts.push(`  Improvements: ${se.improvements}`);
    }
  }

  return parts.join('\n') || 'No relevant context found.';
}

// ============ SYSTEM PROMPT ============

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

// ============ ANSWER GENERATION ============

async function generateAnswer(question, context, chatHistory, queryType) {
  const contextBlock = formatContext(context);

  const messages = [
    ...chatHistory.slice(-6),
    { role: 'user', content: `${question}\n\n---\nContext:\n${contextBlock}` }
  ];

  const startTime = Date.now();

  const response = await anthropic.messages.create({
    model: RAG_MODEL,
    max_tokens: 1500,
    system: SYSTEM_PROMPT,
    messages
  });

  const latencyMs = Date.now() - startTime;
  const answer = response.content[0].text;
  const citations = extractCitations(answer, context);

  return {
    answer,
    citations,
    queryType,
    model: RAG_MODEL,
    tokensUsed: response.usage.input_tokens + response.usage.output_tokens,
    chunksUsed: context.chunks?.length || 0,
    latencyMs
  };
}

// ============ CITATION EXTRACTION ============

function extractCitations(text, context) {
  const citations = [];
  const citationPattern = /\[Meeting:\s*([^|]+)\|([^\]]+)\]/g;
  let match;

  while ((match = citationPattern.exec(text)) !== null) {
    const dateStr = match[1].trim();
    const detail = match[2].trim();

    let bestChunk = null;
    if (context.chunks) {
      for (const chunk of context.chunks) {
        const chunkDate = formatDate(chunk.meeting_date);
        if (chunkDate.includes(dateStr) || dateStr.includes(chunkDate)) {
          bestChunk = chunk;
          break;
        }
      }
    }

    citations.push({
      raw: match[0],
      date: dateStr,
      detail,
      meeting_id: bestChunk?.meeting_id || null,
      chunk_id: bestChunk?.id || null,
      start_time: bestChunk?.start_time || null
    });
  }

  return citations;
}

// ============ CLIENT BRIEF GENERATION ============

const BRIEF_SYSTEM_PROMPT = `You are preparing a client meeting brief for a B3X team member. Generate a structured, actionable brief using ONLY the provided data.

Format:
## Client Brief
### Meeting History
- Date, topic, duration, key takeaway

### Sentiment Trend
- Scores over time (improving/declining/stable)
- Current composite score and key dimensions
- Areas of strength and concern

### Open Action Items
- Grouped by owner: B3X items vs Client items
- Highlight overdue or on-agenda items

### Key Themes from Recent Meetings
- What the client keeps bringing up
- Unresolved topics
- Commitments made by both sides

### Suggested Talking Points for Next Meeting
- Based on open items, sentiment trends, and unresolved topics
- 3-5 bullet points, prioritized

### Risk Flags
- Declining sentiment? Overdue items? Repeated complaints? Long gaps?`;

export async function generateClientBrief(db, clientId) {
  const startTime = Date.now();

  // Pre-fetch all structured data
  const preFetched = preFetchClientData(db, clientId);
  if (!preFetched || preFetched.meetings.length === 0) {
    return { brief: 'No meetings found for this client.', cached: false, tokens_used: 0, data_sources: {} };
  }

  // Get transcript highlights via two-stage funnel
  let transcriptChunks = [];
  try {
    const keyQueries = ['key decisions', 'client concerns', 'commitments and promises', 'budget and timeline'];
    const seen = new Set();
    for (const q of keyQueries) {
      const chunks = await twoStageFunnel(db, q, clientId, 2, 3);
      for (const c of chunks) {
        if (!seen.has(c.id)) {
          seen.add(c.id);
          transcriptChunks.push(c);
        }
      }
    }
    transcriptChunks = transcriptChunks.slice(0, 8);
  } catch (e) {
    console.warn('[Brief] Transcript search failed:', e.message);
  }

  // Get decisions
  const decisions = db.prepare(
    'SELECT d.decision, d.context, m.start_time FROM decisions d JOIN meetings m ON d.meeting_id = m.id WHERE d.client_id = ? ORDER BY m.start_time DESC LIMIT 10'
  ).all(clientId);

  // Build context
  const context = {
    preFetched,
    meetingTimeline: preFetched.meetings,
    actionItems: preFetched.actionItems,
    sessions: preFetched.sessionScores,
    chunks: transcriptChunks
  };

  const contextBlock = formatContext(context);

  // Add decisions
  let fullContext = contextBlock;
  if (decisions.length > 0) {
    fullContext += '\n\n=== Decisions ===\n';
    decisions.forEach(d => { fullContext += `- ${formatDate(d.start_time)}: ${d.decision}\n`; });
  }

  const response = await anthropic.messages.create({
    model: RAG_MODEL,
    max_tokens: 2500,
    system: BRIEF_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: `Generate a meeting prep brief for this client:\n\n${fullContext}` }]
  });

  const brief = response.content[0].text;
  const tokensUsed = response.usage.input_tokens + response.usage.output_tokens;

  return {
    brief,
    client_name: preFetched.clientName,
    cached: false,
    tokens_used: tokensUsed,
    latency_ms: Date.now() - startTime,
    model: RAG_MODEL,
    data_sources: {
      meetings: preFetched.meetings.length,
      action_items: preFetched.actionItems.length,
      evaluations: preFetched.sessionScores.length,
      transcript_chunks: transcriptChunks.length,
      decisions: decisions.length
    }
  };
}

// ============ Q&A CACHE ============

function mapQueryToQAType(question) {
  const q = question.toLowerCase();
  if (/what was discussed|what happened|summary|overview|what.+meeting about/.test(q)) return 'summary';
  if (/action item|task|todo|open item|what.+came out/.test(q)) return 'action_items';
  if (/sentiment|mood|feeling|happy|upset|how.+feel/.test(q)) return 'sentiment';
  if (/decision|decided|agreed/.test(q)) return 'key_decisions';
  if (/next step|follow.?up|what.?s next/.test(q)) return 'next_steps';
  if (/commit|promise|pledg/.test(q)) return 'commitments';
  return null;
}

function checkQACache(db, question, clientId) {
  if (!clientId) return null;
  if (!detectRecency(question)) return null;

  const qaType = mapQueryToQAType(question);
  if (!qaType) return null;

  // Find the most recent meeting for this client
  const recentMeeting = db.prepare(
    'SELECT id FROM meetings WHERE client_id = ? ORDER BY start_time DESC LIMIT 1'
  ).get(clientId);
  if (!recentMeeting) return null;

  const cached = db.prepare(
    'SELECT answer FROM meeting_qa_cache WHERE meeting_id = ? AND question_type = ?'
  ).get(recentMeeting.id, qaType);

  return cached?.answer || null;
}

// ============ MAIN INTERFACE ============

export async function ask(db, question, { clientId = null, meetingId = null, chatHistory = [], topK = 10 } = {}) {
  const queryType = classifyQuery(question);
  let detectionMethod = clientId ? 'provided' : 'none';

  // If meeting_id provided, resolve client from meeting
  if (meetingId && !clientId) {
    const meeting = db.prepare('SELECT client_id, client_name FROM meetings WHERE id = ?').get(meetingId);
    if (meeting?.client_id && meeting.client_id !== 'unmatched') {
      clientId = meeting.client_id;
      detectionMethod = 'meeting_scope';
    }
  }

  // Auto-detect client from question text if not provided
  if (!clientId) {
    const detected = detectClient(db, question);
    if (detected) {
      clientId = detected.clientId;
      detectionMethod = detected.method;
      console.log(`[RAG] Auto-detected client: ${detected.clientId} via ${detected.method} (matched: "${detected.matched}")`);
    }
  }

  // Meeting-scoped retrieval: user clicked on a specific meeting
  if (meetingId) {
    const qaType = mapQueryToQAType(question);
    if (qaType) {
      const cached = db.prepare('SELECT answer FROM meeting_qa_cache WHERE meeting_id = ? AND question_type = ?').get(meetingId, qaType);
      if (cached?.answer) {
        logQuery({ query: question, clientDetected: clientId, meetingId, detectionMethod: 'meeting_scope', classification: queryType, retrievalPath: 'meeting_cache', cacheHit: true });
        return { answer: cached.answer, citations: [], queryType, model: 'cache', tokensUsed: 0, chunksUsed: 0, latencyMs: 0, cached: true, clientDetected: clientId };
      }
    }

    const mtg = db.prepare('SELECT id, topic, start_time, duration_minutes, meeting_summary, client_name, client_id FROM meetings WHERE id = ?').get(meetingId);
    if (mtg) {
      const chunks = db.prepare('SELECT * FROM transcript_chunks WHERE meeting_id = ? ORDER BY chunk_index ASC').all(meetingId);
      const items = db.prepare('SELECT title, owner_name, status, due_date, priority, collaborators FROM action_items WHERE meeting_id = ?').all(meetingId);
      const score = db.prepare('SELECT composite_score, client_sentiment, accountability, wins, improvements FROM session_evaluations WHERE meeting_id = ?').get(meetingId);

      let contextChunks = chunks.map(c => ({ ...c, meeting_topic: mtg.topic, meeting_date: mtg.start_time, client_name: mtg.client_name || '', similarity: 1.0 }));

      // If too many chunks, keep first 5 + last 5 + vector-best 5
      if (contextChunks.length > 15) {
        const first5 = contextChunks.slice(0, 5);
        const last5 = contextChunks.slice(-5);
        const kept = new Set([...first5.map(c => c.id), ...last5.map(c => c.id)]);
        const { chunkIndex: ci } = ensureIndex(db);
        if (ci.size > 0) {
          const qEmbed = await embedChunk(question);
          const scores = [];
          for (const [cid, data] of ci) {
            if (data.meeting_id !== meetingId) continue;
            scores.push({ chunkId: cid, sim: cosineSimilarity(qEmbed, data.embedding) });
          }
          scores.sort((a, b) => b.sim - a.sim);
          const middle = scores.filter(s => !kept.has(s.chunkId)).slice(0, 5);
          const middleChunks = middle.map(s => chunks.find(c => c.id === s.chunkId)).filter(Boolean).map(c => ({ ...c, meeting_topic: mtg.topic, meeting_date: mtg.start_time, client_name: mtg.client_name || '', similarity: 1.0 }));
          contextChunks = [...first5, ...middleChunks, ...last5];
        } else {
          contextChunks = [...first5, ...contextChunks.slice(Math.floor(contextChunks.length / 2) - 2, Math.floor(contextChunks.length / 2) + 3), ...last5];
        }
      }

      const context = {
        recentMeeting: mtg, meetingTimeline: [mtg], chunks: contextChunks,
        actionItems: items,
        sessions: score ? [{ ...score, topic: mtg.topic, start_time: mtg.start_time }] : [],
        preFetched: { clientName: mtg.client_name || mtg.topic?.split('|')[0]?.trim() || 'Unknown' }
      };

      const result = await generateAnswer(question, context, chatHistory, queryType);
      result.clientDetected = clientId;
      logQuery({ query: question, clientDetected: clientId, meetingId, detectionMethod: 'meeting_scope', classification: queryType, retrievalPath: 'meeting_direct', cacheHit: false, chunksReturned: contextChunks.length, model: result.model, tokensUsed: result.tokensUsed, latencyMs: result.latencyMs });
      return result;
    }
  }

  // Fallback clarification: if still no client for client-specific queries, don't silently return wrong data
  if (!clientId && ['transcript_search', 'client_brief', 'action_items', 'session_analysis'].includes(queryType)) {
    const recentClients = db.prepare(
      "SELECT DISTINCT client_name FROM meetings WHERE client_id IS NOT NULL AND client_id != 'unmatched' ORDER BY start_time DESC LIMIT 5"
    ).all();
    const suggestions = recentClients.map(c => c.client_name).join(', ');

    logQuery({ query: question, clientDetected: null, detectionMethod: 'none', classification: queryType, retrievalPath: 'clarification', cacheHit: false });

    return {
      answer: `I couldn't identify which client you're asking about. Could you mention the client name? Recent clients: ${suggestions}`,
      citations: [],
      queryType,
      model: 'system',
      tokensUsed: 0,
      chunksUsed: 0,
      latencyMs: 0,
      needsClarification: true,
      clientDetected: null
    };
  }

  // Check Q&A cache (instant, zero tokens)
  const cachedAnswer = checkQACache(db, question, clientId);
  if (cachedAnswer) {
    logQuery({ query: question, clientDetected: clientId, detectionMethod, classification: queryType, retrievalPath: 'cache', cacheHit: true });
    return {
      answer: cachedAnswer,
      citations: [],
      queryType,
      model: 'cache',
      tokensUsed: 0,
      chunksUsed: 0,
      latencyMs: 0,
      cached: true,
      clientDetected: clientId
    };
  }

  const context = await retrieveContext(db, question, queryType, { clientId, topK });
  const result = await generateAnswer(question, context, chatHistory, queryType);
  result.clientDetected = clientId;

  logQuery({
    query: question,
    clientDetected: clientId,
    detectionMethod,
    classification: queryType,
    retrievalPath: context.chunks?.length > 0 ? 'chunks' : 'structured',
    cacheHit: false,
    chunksReturned: context.chunks?.length || 0,
    model: result.model,
    tokensUsed: result.tokensUsed,
    latencyMs: result.latencyMs
  });

  return result;
}
