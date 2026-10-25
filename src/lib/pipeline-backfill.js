/**
 * Pipeline Backfill — finds and fills all processing gaps across the pipeline.
 * Handles: chunks, chunk embeddings, summaries, meeting embeddings, Q&A cache, session evaluations.
 * Idempotent — safe to run multiple times.
 */

import 'dotenv/config';
import { chunkTranscript, saveChunks } from './transcript-chunker.js';
import { embedAndSaveChunks, embedMeetingSummary } from './transcript-embedder.js';
import { summarizeMeeting } from './meeting-summarizer.js';
import { generateMeetingQA, saveQA } from './qa-generator.js';
import { evaluateMeeting, DEFAULT_MODEL } from './session-evaluator.js';
import { invalidateIndex } from './rag-engine.js';

function log(quiet, ...args) {
  if (!quiet) console.log('[Backfill]', ...args);
}

/**
 * Run a full pipeline backfill, filling all gaps.
 * @param {import('better-sqlite3').Database} db
 * @param {{ maxEvals?: number, quiet?: boolean }} opts
 * @returns {Promise<Object>} counts of what was processed
 */
export async function runBackfill(db, { maxEvals = 10, quiet = false } = {}) {
  const counts = {
    chunks: { processed: 0, errors: 0 },
    chunkEmbeddings: { embedded: 0, skipped: 0, errors: 0 },
    summaries: { processed: 0, errors: 0 },
    meetingEmbeddings: { processed: 0, errors: 0 },
    qa: { processed: 0, errors: 0 },
    evals: { processed: 0, skipped: 0, errors: 0 },
  };

  let indexDirty = false;

  // ─── Step 1: Chunk meetings missing transcript_chunks ───
  log(quiet, '--- Step 1: Chunking missing transcripts ---');
  const meetingsMissingChunks = db.prepare(`
    SELECT m.id, m.transcript_raw, m.client_id
    FROM meetings m
    WHERE m.transcript_raw IS NOT NULL
      AND m.transcript_raw != ''
      AND m.id NOT IN (SELECT DISTINCT meeting_id FROM transcript_chunks)
  `).all();

  log(quiet, `Found ${meetingsMissingChunks.length} meetings missing chunks`);

  for (const m of meetingsMissingChunks) {
    try {
      const chunks = chunkTranscript(m.id, m.transcript_raw, m.client_id);
      if (chunks.length > 0) {
        saveChunks(db, chunks);
        counts.chunks.processed++;
        log(quiet, `  Chunked meeting ${m.id}: ${chunks.length} chunks`);
      }
    } catch (err) {
      console.error(`  Error chunking meeting ${m.id}:`, err.message);
      counts.chunks.errors++;
    }
  }

  // ─── Step 2: Embed chunks missing embeddings ───
  log(quiet, '--- Step 2: Embedding missing chunks ---');
  const chunksMissingEmbeddings = db.prepare(`
    SELECT tc.id FROM transcript_chunks tc
    WHERE tc.id NOT IN (SELECT chunk_id FROM transcript_embeddings)
  `).all().map(r => r.id);

  log(quiet, `Found ${chunksMissingEmbeddings.length} chunks missing embeddings`);

  if (chunksMissingEmbeddings.length > 0) {
    const result = await embedAndSaveChunks(db, chunksMissingEmbeddings, 100);
    counts.chunkEmbeddings = result;
    indexDirty = result.embedded > 0;
    log(quiet, `  Embedded: ${result.embedded}, skipped: ${result.skipped}, errors: ${result.errors}`);
  }

  // ─── Step 3: Generate missing summaries ───
  log(quiet, '--- Step 3: Generating missing summaries ---');
  const meetingsMissingSummaries = db.prepare(`
    SELECT id FROM meetings
    WHERE transcript_raw IS NOT NULL
      AND transcript_raw != ''
      AND (meeting_summary IS NULL OR meeting_summary = '')
  `).all();

  log(quiet, `Found ${meetingsMissingSummaries.length} meetings missing summaries`);

  for (const { id } of meetingsMissingSummaries) {
    try {
      const result = await summarizeMeeting(db, id);
      if (result) {
        counts.summaries.processed++;
        log(quiet, `  Summarized meeting ${id} (source: ${result.source})`);
      }
    } catch (err) {
      console.error(`  Error summarizing meeting ${id}:`, err.message);
      counts.summaries.errors++;
    }
  }

  // ─── Step 4: Generate missing meeting-level embeddings ───
  log(quiet, '--- Step 4: Generating missing meeting embeddings ---');
  const meetingsMissingMeetingEmbed = db.prepare(`
    SELECT m.id, m.meeting_summary FROM meetings m
    WHERE m.meeting_summary IS NOT NULL
      AND m.meeting_summary != ''
      AND m.id NOT IN (SELECT meeting_id FROM meeting_embeddings)
  `).all();

  log(quiet, `Found ${meetingsMissingMeetingEmbed.length} meetings missing meeting-level embeddings`);

  for (const { id, meeting_summary } of meetingsMissingMeetingEmbed) {
    try {
      await embedMeetingSummary(db, id, meeting_summary);
      counts.meetingEmbeddings.processed++;
      indexDirty = true;
      log(quiet, `  Embedded meeting ${id} summary`);
      // Rate limit
      await new Promise(r => setTimeout(r, 100));
    } catch (err) {
      console.error(`  Error embedding meeting ${id} summary:`, err.message);
      counts.meetingEmbeddings.errors++;
    }
  }

  // ─── Step 5: Generate missing Q&A cache ───
  log(quiet, '--- Step 5: Generating missing Q&A cache ---');
  const meetingsMissingQA = db.prepare(`
    SELECT m.id FROM meetings m
    WHERE m.transcript_raw IS NOT NULL
      AND m.transcript_raw != ''
      AND m.id NOT IN (SELECT DISTINCT meeting_id FROM meeting_qa_cache)
  `).all();

  log(quiet, `Found ${meetingsMissingQA.length} meetings missing Q&A cache`);

  for (const { id } of meetingsMissingQA) {
    try {
      const qaPairs = generateMeetingQA(db, id);
      if (qaPairs.length > 0) {
        saveQA(db, id, qaPairs);
        counts.qa.processed++;
        log(quiet, `  Generated ${qaPairs.length} Q&A pairs for meeting ${id}`);
      }
    } catch (err) {
      console.error(`  Error generating Q&A for meeting ${id}:`, err.message);
      counts.qa.errors++;
    }
  }

  // ─── Step 6: Session evaluations ───
  log(quiet, `--- Step 6: Session evaluations (max ${maxEvals}) ---`);
  const meetingsMissingEvals = db.prepare(`
    SELECT m.id FROM meetings m
    WHERE m.transcript_raw IS NOT NULL
      AND m.transcript_raw != ''
      AND m.id NOT IN (
        SELECT meeting_id FROM session_evaluations WHERE model_used = ?
      )
    ORDER BY m.id
  `).all(DEFAULT_MODEL);

  log(quiet, `Found ${meetingsMissingEvals.length} meetings missing evals (model: ${DEFAULT_MODEL})`);

  const evalBatch = meetingsMissingEvals.slice(0, maxEvals);
  for (const { id } of evalBatch) {
    try {
      await evaluateMeeting(id, { model: DEFAULT_MODEL, db });
      counts.evals.processed++;
      log(quiet, `  Evaluated meeting ${id}`);
      // Rate limit: 2s between eval calls
      await new Promise(r => setTimeout(r, 2000));
    } catch (err) {
      console.error(`  Error evaluating meeting ${id}:`, err.message);
      counts.evals.errors++;
    }
  }
  counts.evals.skipped = meetingsMissingEvals.length - evalBatch.length;

  // ─── Invalidate RAG indexes if embeddings were added ───
  if (indexDirty) {
    log(quiet, 'Invalidating RAG indexes (new embeddings added)');
    invalidateIndex();
  }

  // ─── Summary ───
  log(quiet, '=== Backfill complete ===');
  log(quiet, JSON.stringify(counts, null, 2));

  return counts;
}
