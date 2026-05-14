// src/lib/ai-ph-matcher.js — daily AI↔PH matcher per
// ~/awsc-new/awesome/cc-xprt-echelon/scratch/handoff/daily-matcher-worker.md
//
// Algorithm per spec:
//   sim          = cosine(embed(ai.title + ' ' + ai.desc), embed(ph.title + ' ' + ph.desc))
//   overlap      = topic_tag_intersection(ai_text, ph_text)
//   date_boost   = 0.05 iff PH task created within ±21 days of AI's meeting start
//   score        = sim + date_boost
// Outcome bands:
//   auto-link   (score ≥ 0.85 AND overlap ≥ 1)  → write action_items.ph_task_id directly
//   candidate   (score 0.60–0.85, OR score ≥ 0.85 but overlap = 0) → insert match_candidates
//   no-match    (score < 0.60)                  → leave un-linked
//
// Echelon-only in v1 (per dispatch constraint). Other slugs throw.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- Constants per spec ----
export const AUTO_LINK_THRESHOLD = 0.85;
export const CANDIDATE_THRESHOLD = 0.60;
export const DATE_PROXIMITY_DAYS = 21;
export const DATE_PROXIMITY_BOOST = 0.05;
export const ALLOWED_CLIENTS = new Set(['echelon', 'echelon-services']);

// In v1 the worker only runs for Echelon. Map the JSON slug 'echelon-services'
// to the DB client_id 'echelon'.
export const CLIENT_SLUG_TO_DB_ID = {
  echelon: 'echelon',
  'echelon-services': 'echelon',
};

// ---- Topic-tag dictionary (loaded from config) ----
let _tagDict = null;
function loadTags(clientDbId = 'echelon') {
  if (_tagDict) return _tagDict[clientDbId] || [];
  const p = path.resolve(__dirname, '..', '..', 'config', 'matcher-topic-tags.json');
  _tagDict = JSON.parse(fs.readFileSync(p, 'utf8'));
  return _tagDict[clientDbId] || [];
}

// Reset cache for tests.
export function _resetTagCache() { _tagDict = null; }

export function extractTopicTags(text, clientDbId = 'echelon') {
  const tags = loadTags(clientDbId);
  const lower = String(text || '').toLowerCase();
  return tags.filter(t => lower.includes(t));
}

export function intersectionSize(a, b) {
  const setB = new Set(b);
  let n = 0;
  for (const x of a) if (setB.has(x)) n++;
  return n;
}

// ---- Cosine similarity (independent of the embedding-cache helper so this
// module is testable without the model). Returns 0 on length mismatch / zero
// vectors.
export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ---- Date proximity boost ----
export function datesWithinDays(d1, d2, days = DATE_PROXIMITY_DAYS) {
  if (!d1 || !d2) return false;
  const t1 = new Date(d1).getTime();
  const t2 = new Date(d2).getTime();
  if (Number.isNaN(t1) || Number.isNaN(t2)) return false;
  const diffMs = Math.abs(t1 - t2);
  return diffMs <= days * 86_400_000;
}

// ---- Score + classify per spec ----
export function scorePair(ai, ph, embeddings, opts = {}) {
  const clientDbId = opts.clientDbId || 'echelon';
  const aiText = `${ai.title || ''} ${ai.description || ''}`.trim();
  const phText = `${ph.title || ''} ${ph.description || ''}`.trim();

  const aiVec = embeddings.ai;
  const phVec = embeddings.ph;
  const sim = cosineSimilarity(aiVec, phVec);

  const tagsAi = extractTopicTags(aiText, clientDbId);
  const tagsPh = extractTopicTags(phText, clientDbId);
  const overlap = intersectionSize(tagsAi, tagsPh);

  const dateBoost = datesWithinDays(ai.meeting_start_time, ph.created_at, DATE_PROXIMITY_DAYS)
    ? DATE_PROXIMITY_BOOST
    : 0;
  const score = sim + dateBoost;

  return { sim, score, overlap, tagsAi, tagsPh, dateBoost };
}

export function classifyOutcome({ score, overlap }) {
  if (score >= AUTO_LINK_THRESHOLD && overlap >= 1) return 'auto-link';
  if (score >= CANDIDATE_THRESHOLD) return 'candidate';
  return 'no-match';
}

export function buildRationale(ai, ph, scoring) {
  const aiText = `${ai.title || ''}`.slice(0, 80);
  const phText = `${ph.title || ''}`.slice(0, 80);
  const tags = (scoring.tagsAi.filter(t => scoring.tagsPh.includes(t))).join(', ') || '(none)';
  const date = scoring.dateBoost > 0 ? ` · date-proximity boost (+${DATE_PROXIMITY_BOOST})` : '';
  return `AI "${aiText}" ↔ PH "${phText}" · sim=${scoring.sim.toFixed(3)} · overlap=${scoring.overlap} [${tags}]${date}`;
}

// ---- Worker entry point ----
//
// Inputs:
//   db: better-sqlite3 instance for zoom-action-items.db
//   options:
//     clientSlug:          'echelon' | 'echelon-services' (v1 only) — throws otherwise
//     phTasks:             array of { id, project_id, list_id, title, description, created_at }
//     embedAi(text):       async fn returning a number[] embedding
//     embedPh(text):       same shape; usually identical to embedAi
//     dryRun:              when true, no DB writes — return what WOULD happen
//     linkedBy:            DB column linked_by ('daily-matcher' default)
//
// Returns:
//   { scanned, autoLinked, candidates, noMatch, perAi: [...], skipped: [...] }
export async function runMatcherWorker({
  db, clientSlug, phTasks,
  embedAi, embedPh,
  dryRun = false,
  linkedBy = 'daily-matcher',
} = {}) {
  if (!ALLOWED_CLIENTS.has(clientSlug)) {
    throw new Error(`runMatcherWorker: client '${clientSlug}' is not enabled in v1 (Echelon-only)`);
  }
  if (!Array.isArray(phTasks)) throw new Error('runMatcherWorker: phTasks must be an array');
  if (typeof embedAi !== 'function') throw new Error('runMatcherWorker: embedAi must be a function');
  if (typeof embedPh !== 'function') throw new Error('runMatcherWorker: embedPh must be a function');

  const clientDbId = CLIENT_SLUG_TO_DB_ID[clientSlug];

  // Unlinked open/suggested AIs for this client.
  const openAis = db.prepare(`
    SELECT ai.id, ai.title, ai.description, ai.meeting_id, ai.client_id, ai.status,
           m.start_time AS meeting_start_time
      FROM action_items ai
      LEFT JOIN meetings m ON m.id = ai.meeting_id
     WHERE ai.client_id = ?
       AND ai.status IN ('open','suggested')
       AND ai.ph_task_id IS NULL
  `).all(clientDbId);

  const stmtUpdate = db.prepare(`
    UPDATE action_items
       SET ph_task_id = ?, ph_project_id = ?, ph_task_list_id = ?,
           link_source = 'matched',
           link_confidence = 'high',
           linked_by = ?,
           linked_at = datetime('now'),
           pushed_at = COALESCE(pushed_at, datetime('now'))
     WHERE id = ?
  `);
  const stmtInsertCand = db.prepare(`
    INSERT INTO match_candidates
      (action_item_id, ph_task_id, ph_project_id, ph_task_list_id,
       similarity_score, topic_overlap_count, rationale)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  // Pre-compute PH embeddings (one per task) to avoid re-embed per AI.
  const phEmbeddings = new Map();
  for (const ph of phTasks) {
    const text = `${ph.title || ''} ${ph.description || ''}`.trim();
    phEmbeddings.set(ph.id, await embedPh(text));
  }

  const summary = { scanned: 0, autoLinked: 0, candidates: 0, noMatch: 0, perAi: [], skipped: [] };

  for (const ai of openAis) {
    summary.scanned++;
    const aiText = `${ai.title || ''} ${ai.description || ''}`.trim();
    const aiVec = await embedAi(aiText);

    let best = null;
    let bestScoring = null;
    for (const ph of phTasks) {
      const phVec = phEmbeddings.get(ph.id);
      const scoring = scorePair(ai, ph, { ai: aiVec, ph: phVec }, { clientDbId });
      if (scoring.score < CANDIDATE_THRESHOLD) continue;
      if (!best || scoring.score > bestScoring.score) {
        best = ph;
        bestScoring = scoring;
      }
    }

    if (!best) {
      summary.noMatch++;
      summary.perAi.push({ ai_id: ai.id, outcome: 'no-match' });
      continue;
    }

    const outcome = classifyOutcome(bestScoring);
    const rationale = buildRationale(ai, best, bestScoring);
    if (outcome === 'auto-link') {
      summary.autoLinked++;
      if (!dryRun) {
        stmtUpdate.run(
          String(best.id),
          best.project_id ? String(best.project_id) : null,
          best.list_id ? String(best.list_id) : null,
          linkedBy,
          ai.id,
        );
      }
      summary.perAi.push({ ai_id: ai.id, outcome, ph_task_id: best.id, score: bestScoring.score, overlap: bestScoring.overlap, rationale });
    } else if (outcome === 'candidate') {
      summary.candidates++;
      if (!dryRun) {
        stmtInsertCand.run(
          ai.id,
          String(best.id),
          best.project_id ? String(best.project_id) : null,
          best.list_id ? String(best.list_id) : null,
          bestScoring.score,
          bestScoring.overlap,
          rationale,
        );
      }
      summary.perAi.push({ ai_id: ai.id, outcome, ph_task_id: best.id, score: bestScoring.score, overlap: bestScoring.overlap, rationale });
    } else {
      summary.noMatch++;
      summary.perAi.push({ ai_id: ai.id, outcome: 'no-match' });
    }
  }

  return summary;
}
