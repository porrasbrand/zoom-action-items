#!/usr/bin/env node
// Daily AI↔PH matcher worker entry point.
// Reads zoom-action-items.db, pulls open action_items + PH tasks via
// proofhub-client (cache OK), embeds + scores + classifies + writes back.
//
// Usage:
//   node scripts/run-matcher.mjs                  # echelon (default), live
//   node scripts/run-matcher.mjs --dry-run        # no writes
//   node scripts/run-matcher.mjs --client echelon --dry-run

import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runMatcherWorker, ALLOWED_CLIENTS } from '../src/lib/ai-ph-matcher.js';
import { generateEmbedding } from '../src/lib/embedding-cache.js';
import { getAllProjectTasks, isProofhubConfigured } from '../src/lib/proofhub-client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DB = path.resolve(__dirname, '..', 'data', 'zoom-action-items.db');

const ECHELON_PROJECT_ID = '9104911511';

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { client: 'echelon', dryRun: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') opts.dryRun = true;
    else if (args[i] === '--client') opts.client = args[++i];
  }
  return opts;
}

async function loadPhTasks(clientSlug) {
  if (clientSlug !== 'echelon' && clientSlug !== 'echelon-services') {
    throw new Error(`Client '${clientSlug}' not in v1 pilot scope`);
  }
  if (!isProofhubConfigured()) {
    console.warn('[run-matcher] PROOFHUB not configured; returning empty PH task list');
    return [];
  }
  const tasks = await getAllProjectTasks(ECHELON_PROJECT_ID);
  // Normalize to the shape the matcher expects.
  return tasks.map(t => ({
    id: String(t.id),
    project_id: String(t.project_id || ECHELON_PROJECT_ID),
    list_id: String(t.task_list_id || t.list_id || ''),
    title: t.title || '',
    description: t.description || '',
    created_at: t.created_at || t.created || null,
  }));
}

async function main() {
  const { client, dryRun } = parseArgs();
  if (!ALLOWED_CLIENTS.has(client)) {
    console.error(`[run-matcher] client '${client}' is not enabled in v1 (Echelon-only)`);
    process.exit(2);
  }
  const db = new Database(DEFAULT_DB);
  const phTasks = await loadPhTasks(client);
  console.log(`[run-matcher] client=${client} dryRun=${dryRun} phTasks=${phTasks.length}`);

  const result = await runMatcherWorker({
    db, clientSlug: client, phTasks,
    embedAi: async (text) => generateEmbedding(text),
    embedPh: async (text) => generateEmbedding(text),
    dryRun,
    linkedBy: 'daily-matcher',
  });

  console.log(`[run-matcher] scanned:    ${result.scanned}`);
  console.log(`[run-matcher] autoLinked: ${result.autoLinked}`);
  console.log(`[run-matcher] candidates: ${result.candidates}`);
  console.log(`[run-matcher] noMatch:    ${result.noMatch}`);
  if (process.env.MATCHER_VERBOSE) {
    for (const row of result.perAi.slice(0, 20)) console.log('  ', JSON.stringify(row));
  }
  db.close();
}

main().catch(e => { console.error('[run-matcher] error:', e); process.exit(1); });
