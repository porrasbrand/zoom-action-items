#!/usr/bin/env node
/**
 * Run pipeline backfill: fills all processing gaps (chunks, embeddings, summaries, Q&A, evals).
 * Usage: node scripts/run-backfill.mjs [maxEvals]
 */

import 'dotenv/config';
import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { runBackfill } from '../src/lib/pipeline-backfill.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', 'data', 'zoom-action-items.db');

const maxEvals = parseInt(process.argv[2], 10) || 10;

console.log(`[run-backfill] DB: ${DB_PATH}`);
console.log(`[run-backfill] maxEvals: ${maxEvals}`);
console.log();

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

try {
  const counts = await runBackfill(db, { maxEvals, quiet: false });

  console.log('\n=== Final Report ===');
  console.log(`Chunks created:          ${counts.chunks.processed} (errors: ${counts.chunks.errors})`);
  console.log(`Chunk embeddings:        ${counts.chunkEmbeddings.embedded} embedded, ${counts.chunkEmbeddings.skipped} skipped, ${counts.chunkEmbeddings.errors} errors`);
  console.log(`Summaries generated:     ${counts.summaries.processed} (errors: ${counts.summaries.errors})`);
  console.log(`Meeting embeddings:      ${counts.meetingEmbeddings.processed} (errors: ${counts.meetingEmbeddings.errors})`);
  console.log(`Q&A cache entries:       ${counts.qa.processed} (errors: ${counts.qa.errors})`);
  console.log(`Session evaluations:     ${counts.evals.processed} (errors: ${counts.evals.errors}, skipped: ${counts.evals.skipped})`);
} finally {
  db.close();
}
