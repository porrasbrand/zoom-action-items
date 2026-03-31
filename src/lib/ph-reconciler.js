/**
 * ProofHub Reconciliation Engine
 * Matches roadmap items to ProofHub campaign tasks using 4-layer strategy.
 *
 * Layer 1: Keyword overlap (title word matching with Jaccard similarity)
 * Layer 2: Date + category alignment
 * Layer 3: Combined confidence scoring
 * Layer 4: AI batch for unmatched remainders (only if > 3 unmatched)
 */

import * as proofhub from './proofhub-client.js';
import { GoogleGenerativeAI } from '@google/generative-ai';

// ============ LAYER 1: KEYWORD MATCHING ============

/**
 * Normalize title for comparison: lowercase, strip punctuation, split to words.
 */
function tokenize(title) {
  return (title || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2);  // Skip short words
}

/**
 * Compute Jaccard similarity between two token sets.
 */
function jaccardSimilarity(tokensA, tokensB) {
  const setA = new Set(tokensA);
  const setB = new Set(tokensB);
  const intersection = [...setA].filter(t => setB.has(t));
  const union = new Set([...setA, ...setB]);
  return union.size > 0 ? intersection.length / union.size : 0;
}

/**
 * Layer 1: Find PH tasks with keyword overlap > threshold.
 */
function keywordMatch(roadmapItem, phTasks, threshold = 0.2) {
  const riTokens = tokenize(roadmapItem.title);
  const matches = [];

  for (const ph of phTasks) {
    // Strip common prefixes from PH title
    const cleanTitle = (ph.title || '')
      .replace(/^(Advanced Team|Richard O)\s*-\s*/i, '')
      .replace(/^(Prosper|Liberty Spenders|[A-Z][a-z]+\s+Group)\s*-?\s*/i, '');
    const phTokens = tokenize(cleanTitle);

    const score = jaccardSimilarity(riTokens, phTokens);
    if (score >= threshold) {
      matches.push({ phTaskId: ph.id, phTitle: ph.title, score, method: 'keyword' });
    }
  }

  return matches.sort((a, b) => b.score - a.score);
}

// ============ LAYER 2: DATE + CATEGORY ============

/**
 * Map PH task list names to roadmap categories.
 */
const PH_LIST_TO_CATEGORY = {
  'traffic': 'paid-ads',
  'campaigns': 'paid-ads',
  'reporting': 'reporting',
  'tech': 'website',
  'web': 'website',
  'email': 'email-marketing',
  'funnel': 'funnel-campaign',
  'creative': 'creative',
  'seo': 'seo',
  'social': 'social-media',
};

function phListToCategory(listName) {
  const lower = (listName || '').toLowerCase();
  for (const [keyword, category] of Object.entries(PH_LIST_TO_CATEGORY)) {
    if (lower.includes(keyword)) return category;
  }
  return null;
}

/**
 * Layer 2: Boost matches where dates align and categories match.
 */
function dateAndCategoryBoost(roadmapItem, phTask, existingScore) {
  let bonus = 0;

  // Date proximity bonus (±14 days)
  const riDate = new Date(roadmapItem.created_at);
  const phDate = new Date(phTask.created_at || phTask.start_date);
  if (!isNaN(riDate) && !isNaN(phDate)) {
    const daysDiff = Math.abs((riDate - phDate) / (1000 * 60 * 60 * 24));
    if (daysDiff <= 7) bonus += 0.2;
    else if (daysDiff <= 14) bonus += 0.1;
  }

  // Category alignment bonus
  const phCategory = phListToCategory(phTask._taskListTitle || phTask.task_list_name);
  if (phCategory && phCategory === roadmapItem.category) bonus += 0.15;

  return existingScore + bonus;
}

// ============ LAYER 3: COMBINED SCORING ============

/**
 * Run layers 1-3 for all roadmap items against all PH tasks.
 * Returns Map<roadmapItemId, { phTaskId, phTitle, confidence, method, reasoning }>
 */
function deterministicMatch(roadmapItems, phTasks) {
  const links = new Map();

  for (const ri of roadmapItems) {
    const keywordMatches = keywordMatch(ri, phTasks);

    if (keywordMatches.length > 0) {
      // Apply layer 2 boost to top keyword matches
      const boosted = keywordMatches.map(m => {
        const phTask = phTasks.find(t => t.id === m.phTaskId);
        const confidence = dateAndCategoryBoost(ri, phTask, m.score);
        return { ...m, confidence };
      }).sort((a, b) => b.confidence - a.confidence);

      // Take the best match if confidence >= 0.30
      if (boosted[0].confidence >= 0.30) {
        links.set(ri.id, {
          phTaskId: boosted[0].phTaskId,
          phTitle: boosted[0].phTitle,
          confidence: Math.min(boosted[0].confidence, 1.0),
          method: 'keyword',
          reasoning: `Keyword match (Jaccard: ${boosted[0].score.toFixed(2)}, boosted to ${boosted[0].confidence.toFixed(2)})`
        });
      }
    }
  }

  return links;
}

// ============ LAYER 4: AI BATCH ============

/**
 * For unmatched roadmap items, send one batch to Gemini.
 * Only triggers if > 3 unmatched items.
 */
async function aiBatchMatch(unmatchedItems, phTasks) {
  // Only run AI batch if more than 3 unmatched items
  if (unmatchedItems.length <= 3) {
    console.log(`[Reconciler] Skipping AI batch (only ${unmatchedItems.length} unmatched items, threshold is >3)`);
    return new Map();
  }

  if (!process.env.GOOGLE_API_KEY) {
    console.log('[Reconciler] Skipping AI batch (no GOOGLE_API_KEY)');
    return new Map();
  }

  const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

  const prompt = `You are matching granular meeting action items to their parent ProofHub campaign tasks.

PROOFHUB CAMPAIGN TASKS (parent-level):
${phTasks.map(t => `  PH-${t.id}: "${t.title}" (${t.completed ? 'DONE' : 'OPEN'}, list: ${t._taskListTitle || t.task_list_name || 'unknown'})`).join('\n')}

UNMATCHED ROADMAP ITEMS (action-level, need parent):
${unmatchedItems.map(r => `  RI-${r.id}: "${r.title}" (status: ${r.status}, category: ${r.category})`).join('\n')}

For each roadmap item, determine if it is a SUB-TASK of any ProofHub campaign.
Rules:
- A roadmap item can match 0 or 1 PH campaign (pick the BEST parent)
- A PH campaign can be parent of many roadmap items
- Only match if genuinely related (same topic/project/deliverable)
- If no PH campaign is a clear parent, return null

Return ONLY valid JSON array:
[
  { "roadmap_item_id": N, "ph_task_id": N or null, "confidence": 0.0-1.0, "reasoning": "brief explanation" }
]`;

  try {
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return new Map();

    const parsed = JSON.parse(jsonMatch[0]);
    const links = new Map();

    for (const match of parsed) {
      if (match.ph_task_id && match.confidence >= 0.6) {
        const phTask = phTasks.find(t => t.id === match.ph_task_id);
        links.set(match.roadmap_item_id, {
          phTaskId: match.ph_task_id,
          phTitle: phTask?.title || 'Unknown',
          confidence: match.confidence,
          method: 'ai_batch',
          reasoning: match.reasoning || 'AI matched'
        });
      }
    }

    return links;
  } catch (err) {
    console.error('[Reconciler] AI batch matching failed:', err.message);
    return new Map();
  }
}

// ============ HELPER: RETRY WITH BACKOFF ============

async function retryWithBackoff(fn, maxRetries = 3, baseDelay = 2000) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isRetryable = err.message?.includes('429') ||
                          err.message?.includes('503') ||
                          err.message?.includes('timeout') ||
                          err.message?.includes('ECONNRESET');

      if (isRetryable && attempt < maxRetries) {
        const delay = baseDelay * Math.pow(2, attempt - 1);
        console.log(`[Reconciler] Retry ${attempt}/${maxRetries} after ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
}

// ============ MAIN RECONCILIATION ============

/**
 * Run full reconciliation for a client.
 *
 * @param {Database} db - better-sqlite3 instance
 * @param {string} clientId
 * @param {string} phProjectId - ProofHub project ID
 * @returns {Object} { total_roadmap, total_ph, linked, unlinked, new_links, links: [] }
 */
export async function reconcileClient(db, clientId, phProjectId) {
  console.log(`[Reconciler] Starting reconciliation for ${clientId} (project: ${phProjectId})`);

  // 1. Pull PH tasks with retry
  const phTasks = await retryWithBackoff(() => proofhub.getAllProjectTasks(phProjectId));
  console.log(`[Reconciler] Fetched ${phTasks.length} PH tasks`);
  cachePHTasks(db, clientId, phProjectId, phTasks);

  // 2. Get roadmap items
  const roadmapItems = db.prepare('SELECT * FROM roadmap_items WHERE client_id = ?').all(clientId);
  console.log(`[Reconciler] Found ${roadmapItems.length} roadmap items`);

  if (roadmapItems.length === 0) {
    return { total_roadmap: 0, total_ph: phTasks.length, linked: 0, unlinked: 0, new_links: 0, links: [] };
  }

  // 3. Get existing links (skip already-linked items)
  const existingLinks = db.prepare(
    `SELECT roadmap_item_id FROM roadmap_ph_links WHERE client_id = ?`
  ).all(clientId);
  const alreadyLinked = new Set(existingLinks.map(l => l.roadmap_item_id));
  const unlinkedItems = roadmapItems.filter(r => !alreadyLinked.has(r.id));

  console.log(`[Reconciler] ${alreadyLinked.size} already linked, ${unlinkedItems.length} to match`);

  if (unlinkedItems.length === 0) {
    return {
      total_roadmap: roadmapItems.length,
      total_ph: phTasks.length,
      linked: alreadyLinked.size,
      unlinked: 0,
      new_links: 0,
      links: []
    };
  }

  // 4. Layers 1-3: Deterministic matching
  const deterLinks = deterministicMatch(unlinkedItems, phTasks);
  console.log(`[Reconciler] Deterministic matching found ${deterLinks.size} links`);

  // 5. Layer 4: AI batch for remainders (only if > 3 unmatched)
  const stillUnmatched = unlinkedItems.filter(r => !deterLinks.has(r.id));
  const aiLinks = await aiBatchMatch(stillUnmatched, phTasks);
  console.log(`[Reconciler] AI batch found ${aiLinks.size} additional links`);

  // 6. Merge and store all links
  const allNewLinks = new Map([...deterLinks, ...aiLinks]);

  const insertStmt = db.prepare(`
    INSERT OR REPLACE INTO roadmap_ph_links
    (client_id, roadmap_item_id, ph_task_id, ph_task_title, match_method, match_confidence, match_reasoning)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((links) => {
    for (const [riId, match] of links) {
      insertStmt.run(
        clientId,
        riId,
        match.phTaskId,
        match.phTitle,
        match.method,
        match.confidence,
        match.reasoning || null
      );
    }
  });

  insertMany(allNewLinks);

  const result = {
    total_roadmap: roadmapItems.length,
    total_ph: phTasks.length,
    linked: alreadyLinked.size + allNewLinks.size,
    unlinked: unlinkedItems.length - allNewLinks.size,
    new_links: allNewLinks.size,
    links: [...allNewLinks.entries()].map(([riId, m]) => ({
      roadmap_item_id: riId,
      ph_task_id: m.phTaskId,
      ph_title: m.phTitle,
      method: m.method,
      confidence: m.confidence,
      reasoning: m.reasoning
    }))
  };

  console.log(`[Reconciler] Complete: ${result.linked} linked, ${result.unlinked} unlinked`);
  return result;
}

/**
 * Cache PH tasks in local DB for fast lookups.
 */
function cachePHTasks(db, clientId, projectId, phTasks) {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO ph_task_cache
    (ph_task_id, client_id, project_id, title, completed, completed_at, stage_name,
     percent_progress, assigned_names, task_list_name, start_date, due_date,
     comments_count, last_synced_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const insertAll = db.transaction((tasks) => {
    for (const t of tasks) {
      stmt.run(
        t.id,
        clientId,
        projectId,
        t.title,
        t.completed ? 1 : 0,
        t.completed_at || null,
        t.stage?.name || null,
        t.percent_progress || 0,
        JSON.stringify(t.assigned || []),
        t._taskListTitle || t.list?.name || null,
        t.start_date || null,
        t.due_date || null,
        t.comments || 0
      );
    }
  });

  insertAll(phTasks);
  console.log(`[Reconciler] Cached ${phTasks.length} PH tasks`);
}

/**
 * Refresh PH cache for a client (re-pull from API).
 */
export async function refreshPHCache(db, clientId, phProjectId) {
  const phTasks = await retryWithBackoff(() => proofhub.getAllProjectTasks(phProjectId));
  cachePHTasks(db, clientId, phProjectId, phTasks);
  return phTasks.length;
}

/**
 * Get reconciliation status for a client.
 */
export function getReconcileStatus(db, clientId) {
  const total = db.prepare('SELECT COUNT(*) as c FROM roadmap_items WHERE client_id = ?').get(clientId)?.c || 0;
  const linked = db.prepare('SELECT COUNT(*) as c FROM roadmap_ph_links WHERE client_id = ?').get(clientId)?.c || 0;
  const cached = db.prepare('SELECT COUNT(*) as c FROM ph_task_cache WHERE client_id = ?').get(clientId)?.c || 0;
  const lastSync = db.prepare('SELECT MAX(last_synced_at) as t FROM ph_task_cache WHERE client_id = ?').get(clientId)?.t;

  return {
    total_roadmap_items: total,
    linked_items: linked,
    unlinked_items: total - linked,
    cached_ph_tasks: cached,
    last_ph_sync: lastSync
  };
}

/**
 * Get all PH links for a client's roadmap items.
 */
export function getAllPHLinksForClient(db, clientId) {
  return db.prepare(`
    SELECT ri.id as roadmap_item_id, ri.title as roadmap_title, ri.status, ri.category,
           l.ph_task_id, l.ph_task_title, l.match_method, l.match_confidence, l.match_reasoning,
           c.completed as ph_completed, c.completed_at as ph_completed_at,
           c.stage_name as ph_stage, c.percent_progress as ph_progress,
           c.task_list_name as ph_list, c.project_id as ph_project_id
    FROM roadmap_items ri
    LEFT JOIN roadmap_ph_links l ON ri.id = l.roadmap_item_id
    LEFT JOIN ph_task_cache c ON l.ph_task_id = c.ph_task_id
    WHERE ri.client_id = ?
    ORDER BY ri.status, ri.id
  `).all(clientId);
}

/**
 * Manual link: Phil connects a roadmap item to a PH task.
 */
export function manualLink(db, clientId, roadmapItemId, phTaskId, phTaskTitle) {
  db.prepare(`
    INSERT OR REPLACE INTO roadmap_ph_links
    (client_id, roadmap_item_id, ph_task_id, ph_task_title, match_method, match_confidence, match_corrected, updated_by)
    VALUES (?, ?, ?, ?, 'manual', 1.0, 1, 'phil')
  `).run(clientId, roadmapItemId, phTaskId, phTaskTitle);
}

/**
 * Remove a link.
 */
export function removeLink(db, linkId) {
  db.prepare('DELETE FROM roadmap_ph_links WHERE id = ?').run(linkId);
}

export default {
  reconcileClient,
  refreshPHCache,
  getReconcileStatus,
  getAllPHLinksForClient,
  manualLink,
  removeLink
};
