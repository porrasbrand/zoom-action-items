/**
 * RAG Engine — retrieval-augmented generation over meeting transcripts,
 * action items, and session evaluations.
 *
 * Uses Gemini embeddings for vector search + Claude Sonnet 4.6 for answers.
 */

import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { embedChunk, loadAllEmbeddings, searchSimilar } from './transcript-embedder.js';

const anthropic = new Anthropic();
const RAG_MODEL = process.env.RAG_MODEL || 'claude-3-haiku-20240307';

// In-memory embedding index (loaded once)
let embeddingIndex = null;

/**
 * Load embedding index into memory if not already loaded
 */
export function ensureIndex(db) {
  if (!embeddingIndex) {
    embeddingIndex = loadAllEmbeddings(db);
    console.log(`[RAG] Loaded ${embeddingIndex.size} embeddings into memory`);
  }
  return embeddingIndex;
}

/**
 * Invalidate the embedding index (call after adding new embeddings)
 */
export function invalidateIndex() {
  embeddingIndex = null;
}

// ============ QUERY ROUTER ============

/**
 * Classify question type using fast regex heuristics
 */
export function classifyQuery(question) {
  const q = question.toLowerCase();
  if (/open.*item|pending.*item|overdue|action item|task.*open|what.*open|status.*item/.test(q)) return 'action_items';
  if (/score|sentiment|mood|engagement|evaluation|session.*score|coaching|frustration|composite/.test(q)) return 'session_analysis';
  if (/brief|overview|history|prepare|prep me|catch me up|what do i need to know|summary.*client/.test(q)) return 'client_brief';
  if (/cross.?client|all clients|compare|across|trend/.test(q)) return 'cross_client';
  return 'transcript_search';
}

// ============ CONTEXT RETRIEVAL ============

/**
 * Retrieve relevant context for a question
 */
export async function retrieveContext(db, question, queryType, { clientId = null, topK = 10 } = {}) {
  const context = {};

  // Vector search for transcript-based queries
  if (queryType === 'transcript_search' || queryType === 'client_brief' || queryType === 'cross_client') {
    const index = ensureIndex(db);
    if (index.size > 0) {
      const queryEmbed = await embedChunk(question);
      const similar = searchSimilar(queryEmbed, index, topK, clientId);

      context.chunks = similar.map(s => {
        const chunk = db.prepare('SELECT * FROM transcript_chunks WHERE id = ?').get(s.chunkId);
        if (!chunk) return null;
        const meeting = db.prepare('SELECT topic, start_time, client_name, client_id FROM meetings WHERE id = ?').get(chunk.meeting_id);
        return {
          ...chunk,
          meeting_topic: meeting?.topic || 'Unknown',
          meeting_date: meeting?.start_time || '',
          client_name: meeting?.client_name || '',
          similarity: s.similarity
        };
      }).filter(Boolean);
    }
  }

  // Action items
  if (queryType === 'action_items' || queryType === 'client_brief') {
    const query = clientId
      ? 'SELECT ai.*, m.topic, m.start_time FROM action_items ai JOIN meetings m ON ai.meeting_id = m.id WHERE ai.client_id = ? ORDER BY m.start_time DESC LIMIT 20'
      : 'SELECT ai.*, m.topic, m.start_time FROM action_items ai JOIN meetings m ON ai.meeting_id = m.id ORDER BY m.start_time DESC LIMIT 20';
    context.actionItems = db.prepare(query).all(...(clientId ? [clientId] : []));
  }

  // Session evaluations
  if (queryType === 'session_analysis' || queryType === 'client_brief') {
    const query = clientId
      ? 'SELECT se.*, m.topic, m.start_time, m.client_name FROM session_evaluations se JOIN meetings m ON se.meeting_id = m.id WHERE m.client_id = ? ORDER BY m.start_time DESC LIMIT 5'
      : 'SELECT se.*, m.topic, m.start_time, m.client_name FROM session_evaluations se JOIN meetings m ON se.meeting_id = m.id ORDER BY m.start_time DESC LIMIT 10';
    context.sessions = db.prepare(query).all(...(clientId ? [clientId] : []));
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

/**
 * Format retrieved context into a clean text block for the LLM
 */
export function formatContext(context) {
  const parts = [];

  if (context.chunks?.length > 0) {
    parts.push('=== Transcript Excerpts ===');
    for (const chunk of context.chunks) {
      const date = formatDate(chunk.meeting_date);
      parts.push(`\n[Meeting: ${date} | ${chunk.meeting_topic}] (relevance: ${chunk.similarity.toFixed(2)})`);
      parts.push(chunk.text);
    }
  }

  if (context.actionItems?.length > 0) {
    parts.push('\n=== Action Items ===');
    for (const item of context.actionItems) {
      const status = (item.status || 'open').toUpperCase();
      const owner = item.owner_name || 'TBD';
      const due = item.due_date ? ` Due: ${formatDate(item.due_date)}` : '';
      const collab = item.collaborators ? ` (Also: ${item.collaborators})` : '';
      parts.push(`- [${status}] ${item.title} (Owner: ${owner}${due}${collab})`);
    }
  }

  if (context.sessions?.length > 0) {
    parts.push('\n=== Session Evaluations ===');
    for (const se of context.sessions) {
      const date = formatDate(se.start_time);
      parts.push(`- ${date} (${se.client_name || 'Unknown'}): composite ${se.composite_score}/100, sentiment ${se.client_sentiment}/100, accountability ${se.accountability}/100`);
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
- When asked for a "brief" or "overview", synthesize all available data sources`;

// ============ ANSWER GENERATION ============

/**
 * Generate an answer using Claude Sonnet 4.6
 */
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

  // Extract citations from the response
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

/**
 * Parse citation patterns from the LLM response and map to source data
 */
function extractCitations(text, context) {
  const citations = [];
  const citationPattern = /\[Meeting:\s*([^|]+)\|([^\]]+)\]/g;
  let match;

  while ((match = citationPattern.exec(text)) !== null) {
    const dateStr = match[1].trim();
    const detail = match[2].trim();

    // Try to find the matching chunk
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

/**
 * Generate a comprehensive client brief
 */
export async function generateClientBrief(db, clientId) {
  const startTime = Date.now();

  // 1. Get client info and meetings
  const meetings = db.prepare(
    'SELECT id, topic, start_time, duration_minutes, client_name FROM meetings WHERE client_id = ? ORDER BY start_time DESC LIMIT 10'
  ).all(clientId);

  if (meetings.length === 0) {
    return { brief: 'No meetings found for this client.', cached: false, tokens_used: 0, data_sources: {} };
  }

  const clientName = meetings[0]?.client_name || clientId;

  // 2. Get open action items
  const openItems = db.prepare(
    "SELECT title, owner_name, status, due_date, priority, collaborators FROM action_items WHERE client_id = ? AND status IN ('open', 'on-agenda') ORDER BY priority DESC"
  ).all(clientId);

  // 3. Get session evaluations
  const evals = db.prepare(
    'SELECT se.composite_score, se.client_sentiment, se.accountability, se.value_delivery, se.meeting_structure, se.wins, se.improvements, m.topic, m.start_time FROM session_evaluations se JOIN meetings m ON se.meeting_id = m.id WHERE m.client_id = ? ORDER BY m.start_time DESC LIMIT 5'
  ).all(clientId);

  // 4. Get transcript highlights via vector search
  let transcriptChunks = [];
  try {
    const index = ensureIndex(db);
    if (index.size > 0) {
      const keyQueries = ['key decisions', 'client concerns', 'commitments and promises', 'budget and timeline'];
      const seen = new Set();
      for (const q of keyQueries) {
        const qEmbed = await embedChunk(q);
        const results = searchSimilar(qEmbed, index, 3, clientId);
        for (const r of results) {
          if (!seen.has(r.chunkId)) {
            seen.add(r.chunkId);
            const chunk = db.prepare('SELECT text, start_time FROM transcript_chunks WHERE id = ?').get(r.chunkId);
            if (chunk) transcriptChunks.push({ text: chunk.text, time: chunk.start_time, topic: q, score: r.similarity });
          }
        }
      }
      transcriptChunks.sort((a, b) => b.score - a.score);
      transcriptChunks = transcriptChunks.slice(0, 8);
    }
  } catch (e) {
    console.warn('[Brief] Transcript search failed:', e.message);
  }

  // 5. Get decisions
  const decisions = db.prepare(
    'SELECT d.decision, d.context, m.start_time FROM decisions d JOIN meetings m ON d.meeting_id = m.id WHERE d.client_id = ? ORDER BY m.start_time DESC LIMIT 10'
  ).all(clientId);

  // 6. Build context
  const contextParts = [`Client: ${clientName} (ID: ${clientId})\n`];

  contextParts.push('=== Meetings (last 10) ===');
  meetings.forEach(m => contextParts.push(`- ${formatDate(m.start_time)}: ${m.topic} (${m.duration_minutes || '?'} min)`));

  if (openItems.length > 0) {
    contextParts.push(`\n=== Open Action Items (${openItems.length}) ===`);
    openItems.forEach(i => {
      const due = i.due_date ? ` Due: ${formatDate(i.due_date)}` : '';
      const collab = i.collaborators ? ` (Also: ${i.collaborators})` : '';
      contextParts.push(`- [${i.status.toUpperCase()}] ${i.title} (Owner: ${i.owner_name || 'TBD'}${due}${collab})`);
    });
  }

  if (evals.length > 0) {
    contextParts.push('\n=== Session Evaluations ===');
    evals.forEach(e => {
      contextParts.push(`- ${formatDate(e.start_time)}: composite ${e.composite_score}/100, sentiment ${e.client_sentiment}/100, accountability ${e.accountability}/100, value ${e.value_delivery}/100`);
      if (e.wins) contextParts.push(`  Wins: ${e.wins}`);
      if (e.improvements) contextParts.push(`  Improvements: ${e.improvements}`);
    });
  }

  if (transcriptChunks.length > 0) {
    contextParts.push('\n=== Transcript Highlights ===');
    transcriptChunks.forEach(c => contextParts.push(`[Topic: ${c.topic}]\n${c.text}\n`));
  }

  if (decisions.length > 0) {
    contextParts.push('\n=== Decisions ===');
    decisions.forEach(d => contextParts.push(`- ${formatDate(d.start_time)}: ${d.decision}`));
  }

  // 7. Generate brief with Claude
  const response = await anthropic.messages.create({
    model: RAG_MODEL,
    max_tokens: 2500,
    system: BRIEF_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: `Generate a meeting prep brief for this client:\n\n${contextParts.join('\n')}` }]
  });

  const brief = response.content[0].text;
  const tokensUsed = response.usage.input_tokens + response.usage.output_tokens;
  const latencyMs = Date.now() - startTime;

  return {
    brief,
    client_name: clientName,
    cached: false,
    tokens_used: tokensUsed,
    latency_ms: latencyMs,
    model: RAG_MODEL,
    data_sources: {
      meetings: meetings.length,
      action_items: openItems.length,
      evaluations: evals.length,
      transcript_chunks: transcriptChunks.length,
      decisions: decisions.length
    }
  };
}

// ============ MAIN INTERFACE ============

/**
 * Ask a question — main entry point for the RAG concierge
 * @param {import('better-sqlite3').Database} db
 * @param {string} question
 * @param {Object} options
 * @returns {Object} {answer, citations, queryType, model, tokensUsed, chunksUsed, latencyMs}
 */
export async function ask(db, question, { clientId = null, chatHistory = [], topK = 10 } = {}) {
  // Step 1: Classify
  const queryType = classifyQuery(question);

  // Step 2: Retrieve
  const context = await retrieveContext(db, question, queryType, { clientId, topK });

  // Step 3: Generate
  const result = await generateAnswer(question, context, chatHistory, queryType);

  return result;
}
