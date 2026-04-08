/**
 * Embedding Cache — text-embedding-004 for ProofHub task similarity matching
 *
 * Generates embeddings, caches them in SQLite, and provides cosine similarity
 * search for the 3-step matching funnel (Phase 22A).
 */

import 'dotenv/config';
import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

/**
 * Generate embedding for a text string using text-embedding-004
 * @param {string} text - Text to embed (max ~2048 tokens)
 * @returns {Array<number>} - 768-dimensional embedding vector
 */
export async function generateEmbedding(text) {
  const model = genAI.getGenerativeModel({ model: 'gemini-embedding-001' });
  const result = await model.embedContent(text);
  return result.embedding.values;
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
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Initialize the embedding cache table
 */
export function initEmbeddingCache(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS embedding_cache (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      text_hash TEXT,
      embedding BLOB,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

/**
 * Embed all PH tasks and cache in database
 */
export async function cachePhTaskEmbeddings(db) {
  initEmbeddingCache(db);

  const phTasks = db.prepare(`
    SELECT ph_task_id, title, scope_summary, description_text
    FROM ph_task_cache
  `).all();

  let cached = 0, skipped = 0;
  for (const task of phTasks) {
    const key = 'ph_' + task.ph_task_id;

    const existing = db.prepare('SELECT id FROM embedding_cache WHERE id = ?').get(key);
    if (existing) { skipped++; continue; }

    const desc = task.scope_summary
      || (task.description_text || '').replace(/<[^>]+>/g, '').slice(0, 200)
      || '';
    const text = `${task.title} — ${desc}`.slice(0, 500);

    try {
      const embedding = await generateEmbedding(text);
      const buffer = Buffer.from(new Float32Array(embedding).buffer);

      db.prepare('INSERT OR REPLACE INTO embedding_cache (id, source, embedding) VALUES (?, ?, ?)')
        .run(key, 'ph_task', buffer);

      cached++;
      // Rate limit: batch 10 per second
      if (cached % 10 === 0) {
        process.stdout.write(`  Cached ${cached} embeddings...\r`);
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (err) {
      console.error(`  Error embedding PH task ${task.ph_task_id}: ${err.message}`);
    }
  }

  console.log(`[Embedding Cache] Cached: ${cached}, Skipped: ${skipped}, Total PH tasks: ${phTasks.length}`);
  return { cached, skipped, total: phTasks.length };
}

/**
 * Find plausible PH matches for an action item using embedding similarity
 * @param {string} actionItemText - Action item title + description
 * @param {Array<number>} candidatePhTaskIds - PH task IDs from date-filtered SQL query
 * @param {Database} db - Database connection
 * @param {number} threshold - Similarity threshold (default 0.65)
 * @returns {Array} - Candidates above threshold, sorted by similarity desc
 */
export async function findPlausibleMatches(actionItemText, candidatePhTaskIds, db, threshold = 0.65) {
  const itemEmbedding = await generateEmbedding(actionItemText.slice(0, 500));

  const results = [];
  let bestScore = 0;

  for (const phId of candidatePhTaskIds) {
    const cached = db.prepare('SELECT embedding FROM embedding_cache WHERE id = ?').get('ph_' + phId);
    if (!cached || !cached.embedding) continue;

    const phEmbedding = new Float32Array(
      cached.embedding.buffer,
      cached.embedding.byteOffset,
      cached.embedding.length / 4
    );
    const similarity = cosineSimilarity(itemEmbedding, phEmbedding);

    if (similarity > bestScore) bestScore = similarity;

    if (similarity >= threshold) {
      results.push({ ph_task_id: phId, similarity });
    }
  }

  return { matches: results.sort((a, b) => b.similarity - a.similarity), bestScore };
}
