/**
 * Transcript Embedder — generates and manages embeddings for transcript chunks
 * Uses Gemini embedding-001 (768-dim) via @google/generative-ai SDK
 */

import 'dotenv/config';
import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const EMBEDDING_DIM = 768;

/**
 * Generate embedding for a text chunk
 * @param {string} text
 * @returns {Float32Array} 768-dim embedding
 */
export async function embedChunk(text) {
  const model = genAI.getGenerativeModel({ model: 'gemini-embedding-001' });
  const result = await model.embedContent(text);
  return new Float32Array(result.embedding.values);
}

/**
 * Generate and save embeddings for chunks that don't have one yet
 * @param {import('better-sqlite3').Database} db
 * @param {Array<number>} chunkIds - IDs of chunks to embed
 * @param {number} delayMs - delay between API calls (rate limiting)
 * @returns {{embedded: number, skipped: number, errors: number}}
 */
export async function embedAndSaveChunks(db, chunkIds, delayMs = 100) {
  const getChunk = db.prepare('SELECT id, text FROM transcript_chunks WHERE id = ?');
  const hasEmbedding = db.prepare('SELECT chunk_id FROM transcript_embeddings WHERE chunk_id = ?');
  const insertEmbedding = db.prepare(
    'INSERT OR REPLACE INTO transcript_embeddings (chunk_id, embedding) VALUES (?, ?)'
  );

  let embedded = 0, skipped = 0, errors = 0;

  for (const chunkId of chunkIds) {
    // Skip if already embedded
    if (hasEmbedding.get(chunkId)) {
      skipped++;
      continue;
    }

    const chunk = getChunk.get(chunkId);
    if (!chunk) { errors++; continue; }

    try {
      const embedding = await embedChunk(chunk.text);
      const buffer = Buffer.from(embedding.buffer);
      insertEmbedding.run(chunkId, buffer);
      embedded++;

      if (delayMs > 0) {
        await new Promise(r => setTimeout(r, delayMs));
      }
    } catch (err) {
      console.error(`  Error embedding chunk ${chunkId}: ${err.message}`);
      errors++;
    }
  }

  return { embedded, skipped, errors };
}

/**
 * Load ALL embeddings into memory for fast cosine search
 * @param {import('better-sqlite3').Database} db
 * @returns {Map<number, Float32Array>} chunkId → embedding vector
 */
export function loadAllEmbeddings(db) {
  const rows = db.prepare(`
    SELECT te.chunk_id, te.embedding, tc.meeting_id, tc.client_id
    FROM transcript_embeddings te
    JOIN transcript_chunks tc ON tc.id = te.chunk_id
  `).all();

  const map = new Map();
  for (const row of rows) {
    const arr = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, EMBEDDING_DIM);
    map.set(row.chunk_id, { embedding: arr, meeting_id: row.meeting_id, client_id: row.client_id });
  }
  return map;
}

/**
 * Cosine similarity between two vectors
 */
export function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Search for most similar chunks
 * @param {Float32Array} queryEmbedding
 * @param {Map} allEmbeddings - from loadAllEmbeddings()
 * @param {number} topK
 * @param {string|null} clientId - optional filter by client
 * @returns {Array<{chunkId: number, similarity: number, meeting_id: number}>}
 */
export function searchSimilar(queryEmbedding, allEmbeddings, topK = 10, clientId = null) {
  const scores = [];

  for (const [chunkId, data] of allEmbeddings) {
    if (clientId && data.client_id !== clientId) continue;
    const sim = cosineSimilarity(queryEmbedding, data.embedding);
    scores.push({ chunkId, similarity: sim, meeting_id: data.meeting_id });
  }

  scores.sort((a, b) => b.similarity - a.similarity);
  return scores.slice(0, topK);
}

// ============ MEETING-LEVEL EMBEDDINGS ============

/**
 * Generate and store a meeting-level embedding from summary text
 */
export async function embedMeetingSummary(db, meetingId, summaryText) {
  const embedding = await embedChunk(summaryText);
  const buffer = Buffer.from(embedding.buffer);
  db.prepare('INSERT OR REPLACE INTO meeting_embeddings (meeting_id, embedding) VALUES (?, ?)').run(meetingId, buffer);
}

/**
 * Load all meeting-level embeddings into memory
 */
export function loadMeetingEmbeddings(db) {
  const rows = db.prepare('SELECT meeting_id, embedding FROM meeting_embeddings').all();
  const map = new Map();
  for (const row of rows) {
    const arr = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, EMBEDDING_DIM);
    map.set(row.meeting_id, arr);
  }
  return map;
}

/**
 * Search for most relevant meetings using meeting-level embeddings
 */
export function searchMeetings(queryEmbedding, meetingEmbeddings, topK = 5) {
  const results = [];
  for (const [meetingId, embedding] of meetingEmbeddings) {
    const sim = cosineSimilarity(queryEmbedding, embedding);
    results.push({ meetingId, similarity: sim });
  }
  results.sort((a, b) => b.similarity - a.similarity);
  return results.slice(0, topK);
}
