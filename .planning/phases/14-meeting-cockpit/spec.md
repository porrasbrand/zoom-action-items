# Phase 14: Meeting Cockpit — Technical Implementation Spec

## Review Fixes Applied (from Gemini review 2026-03-31)

1. **Schema:** Added `client_id` to `roadmap_ph_links`, `ON DELETE CASCADE` for PH links, `reasoning` column for AI matches
2. **Matching:** Added min-unmatched threshold (skip AI batch if <=3 unmatched), retry with exponential backoff on PH API errors
3. **Error handling:** PH API down → 3 retries with backoff, Gemini failures → graceful fallback, stale link cleanup
4. **UI:** Sections collapsible, "[+ Link to PH]" moved to context menu, "Build My Agenda" shows clean agenda-only view
5. **Feedback loop:** `match_corrected` flag on links — when Phil manually changes a link, store it for future tuning

## Overview

Build an interactive meeting preparation workspace that gives Phil:
1. **ProofHub-enriched roadmap view** — every roadmap item linked to its parent PH campaign task with live completion status
2. **Checkboxes** — Phil toggles which items to discuss vs skip
3. **Talking points** — AI-generated one-liners for how to bring up each checked item
4. **"Build My Agenda"** — generates a personalized meeting agenda from Phil's selections only

## The Data Reality

### ProofHub Tasks (Prosper Group: 18 tasks)
Campaign-level tasks created manually by Phil. Rich descriptions with links, credentials, instructions.

```
Key fields per PH task:
  id: 506615362373 (numeric)
  title: "Richard O - Liberty Spenders - March 20th Webinar Ads"
  completed: true/false
  completed_at: "2026-03-23T18:42:03+00:00"
  created_at: "2026-03-03T22:49:07+00:00"
  start_date: "2026-03-03"
  due_date: null (often null)
  assigned: [12953324531] (array of PH user IDs)
  percent_progress: 100
  stage.name: "Complete" | "Task Created" | "In Progress"
  list.name: "Prosper Group - Traffic | Campaigns | Reporting"
  project.id: 9066064282
  comments: 5 (number of comments)
  description: HTML with full task brief
```

### Roadmap Items (Prosper Group: 23 items)
Granular action-level items extracted from Zoom transcripts by AI.

```
Key fields per roadmap item:
  id: 1 (integer)
  title: "Set up Facebook Ads for March 20th"
  status: "done" | "in-progress" | "agreed" | "blocked" | "deferred" | "dropped"
  category: "paid-ads"
  task_type: "campaign-optimization"
  owner_side: "b3x" | "client"
  owner_name: "Philip Mutrie"
  meetings_silent_count: 0
  created_at: "2026-03-31"
  source_action_item_id: 291 (links to action_items table)
```

### The Relationship: One-to-Many (Parent-Child)

PH tasks are campaigns. Roadmap items are sub-tasks within those campaigns.

| PH Task (parent) | Roadmap Items (children) |
|-------------------|--------------------------|
| "March 20th, 2026 Webinar" | Set up Facebook Ads, Provide Zoom links, Send final webinar invites, Evaluate ad budget, Optimize ad spend |
| "March 20th Webinar Ads" | Set up Facebook Ads, Optimize ad spend |
| "VIP Page Updates" | Schedule VIP delivery email, Finalize EverWebinar setup |
| (no PH parent) | Draft April raise hand campaign, HubSpot Permission Tag, Record promo reels, etc. |

**Current state:** 0 of 23 roadmap items are linked to PH (Phil hasn't used the dashboard push feature).

---

## Phase 14A: ProofHub Reconciliation Engine

### New Database Tables

Add to `initRoadmapTables()` in `src/lib/roadmap-db.js`:

```sql
CREATE TABLE IF NOT EXISTS roadmap_ph_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,              -- (Gemini fix: added for easier querying)
  roadmap_item_id INTEGER NOT NULL,
  ph_task_id INTEGER NOT NULL,
  ph_task_title TEXT,
  match_method TEXT NOT NULL,           -- 'keyword', 'date_category', 'ai_batch', 'manual', 'pushed'
  match_confidence REAL DEFAULT 0.8,    -- 0.0 to 1.0
  match_reasoning TEXT,                 -- (Gemini fix: store AI reasoning for ai_batch matches)
  match_corrected INTEGER DEFAULT 0,    -- (Gemini fix: 1 if Phil manually changed this link — feedback loop)
  matched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (roadmap_item_id) REFERENCES roadmap_items(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_ph_links_roadmap ON roadmap_ph_links(roadmap_item_id);
CREATE INDEX IF NOT EXISTS idx_ph_links_ph ON roadmap_ph_links(ph_task_id);
CREATE INDEX IF NOT EXISTS idx_ph_links_client ON roadmap_ph_links(client_id);

CREATE TABLE IF NOT EXISTS ph_task_cache (
  ph_task_id INTEGER PRIMARY KEY,
  client_id TEXT NOT NULL,
  project_id TEXT,                      -- (Gemini fix: store PH project ID)
  title TEXT,
  completed INTEGER DEFAULT 0,
  completed_at TEXT,
  stage_name TEXT,
  percent_progress INTEGER DEFAULT 0,
  assigned_names TEXT,                  -- JSON array of names
  task_list_name TEXT,
  start_date TEXT,
  due_date TEXT,
  comments_count INTEGER DEFAULT 0,
  last_synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_ph_cache_client ON ph_task_cache(client_id);

CREATE TABLE IF NOT EXISTS cockpit_selections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,
  roadmap_item_id INTEGER NOT NULL,
  selected INTEGER DEFAULT 1,           -- 1 = discuss, 0 = skip
  selection_date TEXT NOT NULL,          -- YYYY-MM-DD (selections are per-day)
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(client_id, roadmap_item_id, selection_date)
);

CREATE INDEX IF NOT EXISTS idx_selections_client_date ON cockpit_selections(client_id, selection_date);
```

### Create `src/lib/ph-reconciler.js`

```javascript
/**
 * ProofHub Reconciliation Engine
 * Matches roadmap items to ProofHub campaign tasks using 4-layer strategy.
 *
 * Layer 1: Keyword overlap (title word matching)
 * Layer 2: Date + category alignment
 * Layer 3: Combined confidence scoring
 * Layer 4: AI batch for unmatched remainders
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
    .filter(w => w.length > 2);  // Skip short words: "the", "a", "to", etc.
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
 * Returns array of { phTaskId, score } for each roadmap item.
 */
function keywordMatch(roadmapItem, phTasks, threshold = 0.25) {
  const riTokens = tokenize(roadmapItem.title);
  const matches = [];

  for (const ph of phTasks) {
    // Tokenize PH title (strip "Advanced Team - Prosper -" prefix pattern)
    const cleanTitle = (ph.title || '').replace(/^(Advanced Team|Richard O)\s*-\s*/i, '').replace(/^(Prosper|Liberty Spenders)\s*-?\s*/i, '');
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
 * roadmapItem.created_at (from meeting date) within 14 days of ph.created_at → bonus
 * roadmapItem.category matches ph task list category → bonus
 */
function dateAndCategoryBoost(roadmapItem, phTask, existingScore) {
  let bonus = 0;

  // Date proximity bonus (±14 days)
  const riDate = new Date(roadmapItem.created_at);
  const phDate = new Date(phTask.created_at);
  const daysDiff = Math.abs((riDate - phDate) / (1000 * 60 * 60 * 24));
  if (daysDiff <= 7) bonus += 0.2;
  else if (daysDiff <= 14) bonus += 0.1;

  // Category alignment bonus
  const phCategory = phListToCategory(phTask._taskListTitle || phTask.list?.name);
  if (phCategory && phCategory === roadmapItem.category) bonus += 0.15;

  return existingScore + bonus;
}

// ============ LAYER 3: COMBINED SCORING ============

/**
 * Run layers 1-3 for all roadmap items against all PH tasks.
 * Returns Map<roadmapItemId, { phTaskId, phTitle, confidence, method }>
 */
function deterministicMatch(roadmapItems, phTasks) {
  const links = new Map(); // roadmapItemId → best match

  for (const ri of roadmapItems) {
    const keywordMatches = keywordMatch(ri, phTasks);

    if (keywordMatches.length > 0) {
      // Apply layer 2 boost to top keyword matches
      const boosted = keywordMatches.map(m => {
        const phTask = phTasks.find(t => t.id === m.phTaskId);
        const confidence = dateAndCategoryBoost(ri, phTask, m.score);
        return { ...m, confidence };
      }).sort((a, b) => b.confidence - a.confidence);

      // Take the best match if confidence >= 0.35
      if (boosted[0].confidence >= 0.35) {
        links.set(ri.id, {
          phTaskId: boosted[0].phTaskId,
          phTitle: boosted[0].phTitle,
          confidence: Math.min(boosted[0].confidence, 1.0),
          method: 'keyword'
        });
      }
    }
  }

  return links;
}

// ============ LAYER 4: AI BATCH ============

/**
 * For unmatched roadmap items, send one batch to Gemini.
 * (Gemini fix: only trigger if >3 unmatched items — don't waste API call for 1-2 items)
 * Returns Map<roadmapItemId, { phTaskId, phTitle, confidence, method }>
 */
const AI_BATCH_MIN_ITEMS = 3;

async function aiBatchMatch(unmatchedItems, phTasks) {
  if (unmatchedItems.length === 0) return new Map();
  if (unmatchedItems.length <= AI_BATCH_MIN_ITEMS) {
    console.log(`  Skipping AI batch — only ${unmatchedItems.length} unmatched (threshold: ${AI_BATCH_MIN_ITEMS})`);
    return new Map();
  }

  const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

  const prompt = `You are matching granular meeting action items to their parent ProofHub campaign tasks.

PROOFHUB CAMPAIGN TASKS (parent-level):
${phTasks.map(t => `  PH-${t.id}: "${t.title}" (${t.completed ? 'DONE' : 'OPEN'}, list: ${t._taskListTitle || 'unknown'})`).join('\n')}

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
  { "roadmap_item_id": N, "ph_task_id": N or null, "confidence": 0.0-1.0, "reasoning": "brief" }
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
          reasoning: match.reasoning || null  // (Gemini fix: store reasoning)
        });
      }
    }

    return links;
  } catch (err) {
    console.error('AI batch matching failed:', err.message);
    return new Map();
  }
}

// ============ MAIN RECONCILIATION ============

/**
 * Run full reconciliation for a client.
 *
 * @param {Database} db - better-sqlite3 instance
 * @param {string} clientId
 * @param {string} phProjectId - ProofHub project ID from clients.json
 * @returns {Object} { total_roadmap, total_ph, linked, unlinked, links: [] }
 */
export async function reconcileClient(db, clientId, phProjectId) {
  // 1. Pull PH tasks with retry (Gemini fix: exponential backoff)
  let phTasks;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      phTasks = await proofhub.getAllProjectTasks(phProjectId);
      break;
    } catch (err) {
      console.error(`PH API attempt ${attempt}/3 failed:`, err.message);
      if (attempt === 3) throw new Error(`ProofHub API failed after 3 retries: ${err.message}`);
      await new Promise(r => setTimeout(r, attempt * 2000)); // 2s, 4s backoff
    }
  }
  cachePHTasks(db, clientId, phTasks);

  // 2. Get roadmap items
  const roadmapItems = db.prepare('SELECT * FROM roadmap_items WHERE client_id = ?').all(clientId);

  // 3. Get existing links (skip already-linked items)
  const existingLinks = db.prepare('SELECT roadmap_item_id FROM roadmap_ph_links WHERE roadmap_item_id IN (' + roadmapItems.map(r => r.id).join(',') + ')').all();
  const alreadyLinked = new Set(existingLinks.map(l => l.roadmap_item_id));
  const unlinkedItems = roadmapItems.filter(r => !alreadyLinked.has(r.id));

  if (unlinkedItems.length === 0) {
    return { total_roadmap: roadmapItems.length, total_ph: phTasks.length, linked: alreadyLinked.size, unlinked: 0, new_links: 0 };
  }

  // 4. Layers 1-3: Deterministic matching
  const deterLinks = deterministicMatch(unlinkedItems, phTasks);

  // 5. Layer 4: AI batch for remainders
  const stillUnmatched = unlinkedItems.filter(r => !deterLinks.has(r.id));
  const aiLinks = await aiBatchMatch(stillUnmatched, phTasks);

  // 6. Merge and store all links
  const allNewLinks = new Map([...deterLinks, ...aiLinks]);

  const insertStmt = db.prepare(
    'INSERT OR REPLACE INTO roadmap_ph_links (client_id, roadmap_item_id, ph_task_id, ph_task_title, match_method, match_confidence, match_reasoning) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );

  const insertMany = db.transaction((links) => {
    for (const [riId, match] of links) {
      insertStmt.run(clientId, riId, match.phTaskId, match.phTitle, match.method, match.confidence, match.reasoning || null);
    }
  });

  insertMany(allNewLinks);

  return {
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
      confidence: m.confidence
    }))
  };
}

/**
 * Cache PH tasks in local DB for fast lookups.
 */
function cachePHTasks(db, clientId, phTasks) {
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
        t.id, clientId,
        t.project?.id || null,
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
}

/**
 * Refresh PH cache for a client (re-pull from API).
 */
export async function refreshPHCache(db, clientId, phProjectId) {
  const phTasks = await proofhub.getAllProjectTasks(phProjectId);
  cachePHTasks(db, clientId, phTasks);
  return phTasks.length;
}

/**
 * Get PH status for a roadmap item (from cache).
 */
export function getPHStatusForItem(db, roadmapItemId) {
  return db.prepare(`
    SELECT l.ph_task_id, l.ph_task_title, l.match_method, l.match_confidence,
           c.completed, c.completed_at, c.stage_name, c.percent_progress,
           c.task_list_name, c.comments_count
    FROM roadmap_ph_links l
    LEFT JOIN ph_task_cache c ON l.ph_task_id = c.ph_task_id
    WHERE l.roadmap_item_id = ?
  `).get(roadmapItemId) || null;
}

/**
 * Get all PH links for a client's roadmap items.
 */
export function getAllPHLinksForClient(db, clientId) {
  return db.prepare(`
    SELECT ri.id as roadmap_item_id, ri.title as roadmap_title, ri.status,
           l.ph_task_id, l.ph_task_title, l.match_method, l.match_confidence,
           c.completed as ph_completed, c.completed_at as ph_completed_at,
           c.stage_name as ph_stage, c.percent_progress as ph_progress,
           c.task_list_name as ph_list
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
    (client_id, roadmap_item_id, ph_task_id, ph_task_title, match_method, match_confidence, match_corrected)
    VALUES (?, ?, ?, ?, 'manual', 1.0, 1)
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
  getPHStatusForItem,
  getAllPHLinksForClient,
  manualLink,
  removeLink
};
```

### Create `src/ph-reconcile.js` (CLI)

```javascript
// Usage:
//   node src/ph-reconcile.js --client prosper-group
//   node src/ph-reconcile.js --all-clients
//   node src/ph-reconcile.js --client prosper-group --refresh  (re-pull PH tasks only)
//
// Steps:
// 1. Load client config (get ph_project_id)
// 2. Run 4-layer reconciliation
// 3. Print results: linked/unlinked counts, match details
```

### API Endpoints (add to routes.js)

```javascript
// POST /api/reconcile/:clientId — Run PH reconciliation
// GET  /api/reconcile/:clientId/status — Get link counts
// POST /api/reconcile/:clientId/refresh — Refresh PH cache only
// POST /api/cockpit/:clientId/link — Manual link { roadmap_item_id, ph_task_id }
// DELETE /api/cockpit/:clientId/link/:linkId — Remove link
```

---

## Phase 14B: Cockpit Data + Talking Points

### Update `prep-collector.js`

Add a new function `collectCockpitData()` that extends `collectPrepData()` with:

```javascript
export async function collectCockpitData(db, clientId) {
  const prepData = await collectPrepData(db, clientId);

  // Enrich with PH links
  const phLinks = getAllPHLinksForClient(db, clientId);

  // Check if PH cache is stale (>1 hour)
  const client = getClientConfig(clientId);
  if (client?.ph_project_id) {
    const cacheAge = db.prepare(
      "SELECT MIN((julianday('now') - julianday(last_synced_at)) * 24) as hours_old FROM ph_task_cache WHERE client_id = ?"
    ).get(clientId);

    if (!cacheAge?.hours_old || cacheAge.hours_old > 1) {
      await refreshPHCache(db, clientId, client.ph_project_id);
    }
  }

  // Get today's selections
  const today = new Date().toISOString().split('T')[0];
  const selections = db.prepare(
    'SELECT roadmap_item_id, selected FROM cockpit_selections WHERE client_id = ? AND selection_date = ?'
  ).all(clientId, today);

  const selectionMap = {};
  selections.forEach(s => { selectionMap[s.roadmap_item_id] = s.selected; });

  return {
    ...prepData,
    ph_links: phLinks,
    selections: selectionMap
  };
}
```

### Update `prep-generator.js` — Add Talking Points

Add to the Gemini prompt (after Section 5 PROJECTED ROADMAP instructions):

```
SECTION 6 - TALKING POINTS:
For each item in sections 1-5 that Phil might discuss with the client, generate a short
conversational one-liner — exactly what Phil should SAY to introduce the topic naturally.
Write as if Phil is speaking directly to the client in a warm, professional tone.

Examples of good talking points:
- For a completed item: "Great news — we got the Facebook Ads live for the 20th, and Richard optimized the spend mid-run"
- For a blocker: "Kurt, quick question — do you have a timeline for the dinner email copy? We need it to schedule the promo"
- For a stale item: "I want to flag something — the HubSpot permission tag has been on our list since March 3 but hasn't come up. Should we keep it or formally take it off the table?"
- For a proposal: "Something I want to put on your radar — now that the evergreen funnel is taking shape, a quick website audit could really boost the conversion on all the traffic we're driving"

Return as a JSON object keyed by item title:
"talking_points": {
  "Set up Facebook Ads for March 20th": "Great news — the ads went live on schedule...",
  "Implement HubSpot Permission Tag": "I want to flag something...",
  ...
}
```

Add `talking_points` to the JSON output schema.

### Selection Persistence API

```javascript
// PUT /api/cockpit/:clientId/selection — Save checkbox state
//   Body: { roadmap_item_id: N, selected: 0|1 }
//   Persists to cockpit_selections table for today's date

// GET /api/cockpit/:clientId — Get full cockpit data
//   Returns: prep data + ph_links + selections + talking_points

// POST /api/cockpit/:clientId/agenda — Build personalized agenda
//   Uses only selected items to generate a focused agenda
```

---

## Phase 14C: Cockpit Dashboard UI

### Layout: Replace prep right panel with cockpit view

When Phil selects a client and clicks "Meeting Cockpit" (new button alongside "Generate Fresh Prep"):

```
┌─────────────────────────────────────────────────────────────┐
│ Meeting Cockpit: Prosper Group         [Build My Agenda ▶]  │
│ Last meeting: Mar 24 (6 days ago)     [Refresh PH Status]  │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ ━━━ WINS TO REPORT ━━━                                      │
│                                                             │
│ ☑ Set up Facebook Ads for March 20th               [DONE]  │
│   📋 PH: "March 20th Webinar Ads" ✅ Complete             │
│   💬 "Great news — ads went live on schedule, Richard       │
│       optimized the spend mid-run to cut non-performers"    │
│                                                             │
│ ☑ Optimize March 20 ad spend                       [DONE]  │
│   📋 PH: "March 20th Webinar Ads" ✅ Complete             │
│   💬 "We trimmed underperformers — cost per reg held at $26"│
│                                                             │
│ ☐ Provide Zoom links for March 20th                [DONE]  │
│   📋 PH: "March 20th Webinar" ✅ Complete   [SKIPPED]     │
│                                                             │
│ ━━━ BLOCKERS — GET ANSWERS ━━━                              │
│                                                             │
│ ☑ Collect member testimonials              [AGREED, stale]  │
│   📋 No PH task linked  [+ Link to PH]                     │
│   💬 "Anthony, can we get 2-3 member quotes this week?      │
│       The raise-hand campaign is ready once we have those"   │
│                                                             │
│ ━━━ STALE — MUST ADDRESS ━━━                                │
│                                                             │
│ ☑ HubSpot Permission Tag            [AGREED, silent 3 mtg] │
│   📋 No PH task linked  [+ Link to PH]                     │
│   💬 "This has been on our list since March 3 but hasn't    │
│       come up — should we keep it or drop it?"               │
│                                                             │
│ ☐ Impact Filter tool                [AGREED, silent 2 mtg] │
│   📋 No PH task linked   [SKIPPED — Dan handles]          │
│                                                             │
│ ━━━ PHIL'S PITCH — PROACTIVE PROPOSALS ━━━                  │
│                                                             │
│ ☑ [QUICK_WIN] Website Conversion Audit                      │
│   📋 No PH task (new proposal)                              │
│   💬 "Now that evergreen is taking shape, I want to flag    │
│       your website — a 3-hour audit could boost conversion   │
│       on all the traffic we're driving to the funnel"        │
│   Est: B3X 3hrs | Client: analytics access | Impact: ↑ CVR │
│                                                             │
│ ☐ [GROWTH] SMS Reminders for EverWebinar                    │
│   📋 No PH task (new proposal)  [SKIPPED — wait for EW]   │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### UI Components

**Checkbox behavior:**
- Click checkbox → immediate PUT to `/api/cockpit/:clientId/selection`
- Default: all items checked EXCEPT items that are DONE + have PH complete (auto-skip completed work)
- Phil unchecks items he wants to skip
- Selections persist per client per day in SQLite (cross-device safe)

**Section headers (Gemini fix: collapsible):**
- Each group (Wins, Blockers, Stale, Proposals) has a collapsible header
- Click to expand/collapse (same pattern as prep sections)
- Item count shown in header: "BLOCKERS — GET ANSWERS (3)"
- Default: all expanded

**PH status indicators:**
- `✅ Complete` — green text, faded row (same as timeline done treatment)
- `🔄 In Progress (60%)` — yellow text with progress
- `📋 No PH task linked` — grey text
- (Gemini fix: "[+ Link to PH]" moved to right-click context menu or "..." overflow button — less visual noise)
- Context menu also has: "Unlink from PH", "Mark as not applicable"

**Talking points:**
- Shown below each item in a quote-style block
- Italic, slightly smaller text, conversational tone
- Only shown for checked items (skip items don't need talking points)
- Generated once per prep, cached — not regenerated on checkbox toggle

**"Build My Agenda" button:**
- Takes only checked items
- Groups them: Wins → Blockers → Stale → Proposals
- Assigns time estimates per group
- (Gemini fix: switches to clean agenda-ONLY view — hides the cockpit items, shows ONLY the final agenda)
- "Back to Cockpit" button to return to full view
- Outputs a clean agenda Phil can screenshot or print

**"Refresh PH Status" button:**
- Calls `/api/reconcile/:clientId/refresh`
- (Gemini fix: retry with backoff if PH API fails, show toast error if all retries fail)
- Updates the PH completion status from live API
- Updates UI in-place without regenerating the whole cockpit

### CSS Additions

```css
.cockpit-item { display: flex; gap: 12px; padding: 12px; border-bottom: 1px solid #21262d; }
.cockpit-item.skipped { opacity: 0.35; }
.cockpit-item.skipped:hover { opacity: 0.7; }
.cockpit-checkbox { flex-shrink: 0; margin-top: 2px; }
.cockpit-checkbox input[type="checkbox"] { width: 18px; height: 18px; cursor: pointer; }
.cockpit-body { flex: 1; }
.cockpit-title { font-size: 14px; font-weight: 500; color: #f0f6fc; }
.cockpit-ph { font-size: 12px; color: #8b949e; margin-top: 4px; }
.cockpit-ph .ph-complete { color: #3fb950; }
.cockpit-ph .ph-open { color: #d29922; }
.cockpit-ph .ph-none { color: #484f58; }
.cockpit-talking-point { font-size: 12px; color: #c9d1d9; font-style: italic; margin-top: 6px; padding: 8px 12px; background: #21262d; border-left: 2px solid #58a6ff; border-radius: 0 4px 4px 0; line-height: 1.5; }
.cockpit-proposal-meta { font-size: 11px; color: #6e7681; margin-top: 4px; }
.cockpit-link-btn { font-size: 11px; color: #58a6ff; background: none; border: none; cursor: pointer; text-decoration: underline; }
.cockpit-section-header { font-size: 13px; font-weight: 600; color: #8b949e; text-transform: uppercase; padding: 16px 0 8px; border-bottom: 1px solid #30363d; margin-bottom: 8px; }
.build-agenda-btn { background: #238636; color: #fff; border: none; padding: 10px 20px; border-radius: 6px; font-size: 14px; font-weight: 500; cursor: pointer; }
.build-agenda-btn:hover { background: #2ea043; }
```

---

## Acceptance Criteria

### 14A: Reconciliation
- [ ] New tables created: roadmap_ph_links, ph_task_cache, cockpit_selections
- [ ] `node src/ph-reconcile.js --client prosper-group` runs successfully
- [ ] Prosper Group: PH tasks cached (18 tasks)
- [ ] Deterministic matching links some items (layers 1-3)
- [ ] AI batch matches additional items (layer 4)
- [ ] Results stored in roadmap_ph_links with method and confidence
- [ ] API: POST /api/reconcile/:clientId works

### 14B: Cockpit Data
- [ ] `collectCockpitData()` returns prep + PH links + selections
- [ ] Talking points generated in Gemini prompt (Section 6)
- [ ] Selection persistence: PUT/GET work for checkbox state
- [ ] PH cache refreshes automatically if >1 hour old
- [ ] Cockpit API returns full dataset

### 14C: Dashboard UI
- [ ] "Meeting Cockpit" button in prep tab
- [ ] Checkboxes toggle and persist per client per day
- [ ] PH status shown for linked items
- [ ] Talking points displayed for checked items
- [ ] "Build My Agenda" generates focused agenda from selections
- [ ] "[+ Link to PH]" button opens PH task selector
- [ ] Skipped items visually faded
- [ ] No console errors

## Smoke Tests

```bash
cd ~/awsc-new/awesome/zoom-action-items

# 14A: Reconciliation
node src/ph-reconcile.js --client prosper-group
# Expected: shows linked/unlinked counts

# Check DB
node -e "const db=require('better-sqlite3')('data/zoom-action-items.db'); console.log('links:', db.prepare('SELECT COUNT(*) as c FROM roadmap_ph_links').get().c); console.log('cache:', db.prepare('SELECT COUNT(*) as c FROM ph_task_cache').get().c);"

# 14B: Cockpit API (with auth session)
SID=$(node scripts/create-test-session.js 2>/dev/null | grep SESSION_ID | cut -d= -f2)
curl -s -b "zoom_session=$SID" http://localhost:3875/zoom/api/cockpit/prosper-group | python3 -c "import sys,json; d=json.load(sys.stdin); print('ph_links:', len(d.get('ph_links',[]))); print('items with talking_points:', len(d.get('talking_points',{})))"

# 14C: Dashboard
grep -c "cockpit\|Meeting Cockpit\|build-agenda-btn\|cockpit-talking-point" public/index.html
# Expected: >= 5
```

## Completion Instructions

This phase has 3 sub-phases. Execute sequentially:

**14A:** Create tables + ph-reconciler.js + CLI + reconcile API. Run for prosper-group. Commit: `[zoom-pipeline-14A]`

**14B:** Update prep-collector + prep-generator (talking points) + cockpit API + selections. Commit: `[zoom-pipeline-14B]`

**14C:** Dashboard cockpit UI with checkboxes, PH indicators, talking points, Build My Agenda. Commit: `[zoom-pipeline-14C]`

After each sub-phase, run its smoke tests before proceeding to the next.
