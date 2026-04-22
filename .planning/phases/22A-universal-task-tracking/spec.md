# Phase 22A: Universal Task Tracking — Database + Matching Engine

## Objective
Expand task accountability tracking from PPC-only (107 tasks) to ALL action item categories (591 tasks). Add trackability classification, embedding-based pre-screening, and universal ProofHub matching with a 3-step funnel to minimize API costs.

## Prior Work Summary
- Phase 21A-21D: PPC Task Tracker with GPT-5.4 matching, expandable cards, status sync, improved prompt
- `ppc_task_tracking` table stores matched PPC tasks with ProofHub links, confidence, reasoning
- `ph_task_cache` has ~500 ProofHub tasks with titles, descriptions, assignees, status
- All 591 action items now have `transcript_excerpt` (backfilled)
- Improved matching prompt (Phase 21D) with negative examples, confidence calibration
- 9 categories: admin (125), content (101), follow-up (85), deliverable (73), ads (65), dev (59), other (57), design (16), seo (6)

## Deliverables

### 1. Extend `ppc_task_tracking` table schema

Add columns to the existing table (do NOT rename — would break running code):

```sql
ALTER TABLE ppc_task_tracking ADD COLUMN category TEXT DEFAULT NULL;
ALTER TABLE ppc_task_tracking ADD COLUMN trackable BOOLEAN DEFAULT NULL;
ALTER TABLE ppc_task_tracking ADD COLUMN trackable_reason TEXT DEFAULT NULL;
ALTER TABLE ppc_task_tracking ADD COLUMN embedding_score REAL DEFAULT NULL;
ALTER TABLE ppc_task_tracking ADD COLUMN match_method TEXT DEFAULT NULL;
-- match_method: 'gpt-5.4' | 'keyword' | 'embedding_skip' | 'no_candidates' | null
```

Run these migrations in `initPPCTrackingTable()` (use `ALTER TABLE ... ADD COLUMN` wrapped in try/catch for idempotency — SQLite throws if column already exists).

### 2. Trackability Classification — `scripts/classify-trackability.mjs`

Use Gemini 2.0 Flash to batch-classify all action items as trackable vs not_applicable.

**Prompt (batch 50 items per call):**
```
Classify each action item as either "trackable" or "not_applicable":

- trackable: Should have a corresponding task in project management. Concrete deliverables, client work, campaigns, technical tasks, content creation, design work, development tasks.
- not_applicable: Meta-tasks, verbal agreements, internal discussions, one-time events, decisions already made, things that don't need a project management task.

Examples of not_applicable:
- "Evaluate 90-day execution plan" (decision, not a deliverable)
- "Register for Profit Scaling Intensive event" (personal action, not client work)
- "Discuss budget with Dan" (verbal discussion, not a task)
- "Follow up verbally with client" (informal, no deliverable)
- "Client will send us their login credentials" (client's action, not ours)

Examples of trackable:
- "Create webinar banner and social posts" (deliverable)
- "Update Google Ads keywords for AC" (campaign work)
- "Rewrite profile descriptions" (content task)
- "Set up Facebook Ads for March 20th" (campaign launch)
- "Build landing page for spring promotion" (dev/design task)

ACTION ITEMS:
1. "{title}" — {description} — Category: {category}
2. "{title}" — {description} — Category: {category}
...

Respond with JSON array:
[{"index": 1, "trackable": true/false, "reason": "brief explanation"}, ...]
```

**Model:** Gemini 2.0 Flash, responseMimeType: application/json
**Rate:** 2s delay between batch calls (~12 batches for 591 items)
**Flags:** --dry-run (preview without writing), --id N (single item)

After classification:
- Update `trackable` and `trackable_reason` columns in ppc_task_tracking
- Print summary: X trackable, Y not_applicable

### 3. Embedding Cache — `src/lib/embedding-cache.js`

New module that manages embeddings for ProofHub tasks and action items.

```javascript
import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const embeddingModel = genAI.getGenerativeModel({ model: 'text-embedding-004' });

/**
 * Generate embedding for a text string
 * @param {string} text - Text to embed
 * @returns {Float32Array} - 768-dimensional embedding vector
 */
export async function generateEmbedding(text) {
  const result = await embeddingModel.embedContent(text);
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
 * Embed all PH tasks and cache in database
 */
export async function cachePhTaskEmbeddings(db) {
  // Create embedding cache table if not exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS embedding_cache (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,  -- 'ph_task' or 'action_item'
      text_hash TEXT,
      embedding BLOB,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const phTasks = db.prepare(`
    SELECT ph_task_id, title, scope_summary, description_text 
    FROM ph_task_cache
  `).all();

  let cached = 0, skipped = 0;
  for (const task of phTasks) {
    const key = 'ph_' + task.ph_task_id;
    
    // Skip if already cached
    const existing = db.prepare('SELECT id FROM embedding_cache WHERE id = ?').get(key);
    if (existing) { skipped++; continue; }

    // Build text: title + summary/description
    const desc = task.scope_summary 
      || (task.description_text || '').replace(/<[^>]+>/g, '').slice(0, 200) 
      || '';
    const text = `${task.title} — ${desc}`.slice(0, 500);

    const embedding = await generateEmbedding(text);
    const buffer = Buffer.from(new Float32Array(embedding).buffer);
    
    db.prepare('INSERT OR REPLACE INTO embedding_cache (id, source, embedding) VALUES (?, ?, ?)')
      .run(key, 'ph_task', buffer);
    
    cached++;
    // Rate limit: 10 per second is safe for embedding API
    if (cached % 10 === 0) await new Promise(r => setTimeout(r, 1000));
  }

  return { cached, skipped, total: phTasks.length };
}

/**
 * Find plausible PH matches for an action item using embedding similarity
 * @param {string} actionItemText - Action item title + description
 * @param {Array} candidatePhTaskIds - PH task IDs from the date-filtered SQL query
 * @param {Database} db - Database connection
 * @param {number} threshold - Similarity threshold (default 0.65)
 * @returns {Array} - Candidates above threshold, sorted by similarity
 */
export async function findPlausibleMatches(actionItemText, candidatePhTaskIds, db, threshold = 0.65) {
  // Embed the action item
  const itemEmbedding = await generateEmbedding(actionItemText.slice(0, 500));

  // Compare against cached PH task embeddings
  const results = [];
  for (const phId of candidatePhTaskIds) {
    const cached = db.prepare('SELECT embedding FROM embedding_cache WHERE id = ?').get('ph_' + phId);
    if (!cached) continue;

    const phEmbedding = new Float32Array(cached.embedding.buffer, cached.embedding.byteOffset, cached.embedding.length / 4);
    const similarity = cosineSimilarity(itemEmbedding, phEmbedding);
    
    if (similarity >= threshold) {
      results.push({ ph_task_id: phId, similarity });
    }
  }

  return results.sort((a, b) => b.similarity - a.similarity);
}
```

### 4. Universal Matching — `scripts/match-all-tasks.mjs`

Three-step funnel for all trackable non-PPC action items:

```javascript
// For each meeting with action items:
//   For each action item NOT already in ppc_task_tracking:

// STEP 1: SQL — Does this client have PH tasks in the window?
const candidates = db.prepare(`
  SELECT ph_task_id, title, scope_summary, description_text, 
         completed, created_at, assigned_names
  FROM ph_task_cache
  WHERE client_id = ? AND created_at BETWEEN ? AND ?
`).all(clientId, windowStart, windowEnd);

if (candidates.length === 0) {
  // Insert row with match_method = 'no_candidates', proofhub_match = 0
  continue;
}

// STEP 2: Embedding similarity — any plausible match?
const actionText = `${item.title} — ${item.description || ''}`;
const plausible = await findPlausibleMatches(
  actionText, 
  candidates.map(c => c.ph_task_id), 
  db, 
  0.65  // threshold
);

if (plausible.length === 0) {
  // Insert row with match_method = 'embedding_skip', proofhub_match = 0
  // Store best embedding_score for debugging
  continue;
}

// STEP 3: GPT-5.4 — semantic matching (only plausible candidates)
const plausibleCandidates = candidates.filter(c => 
  plausible.some(p => p.ph_task_id === c.ph_task_id)
);

const matchResult = await matchProofHub(task, clientId, meetingDate, db, plausibleCandidates);
// Insert/update row with match_method = 'gpt-5.4', full match data
```

**Script flags:**
- `--dry-run` — preview without writing
- `--client <id>` — match one client only
- `--meeting <id>` — match one meeting only
- `--stats` — show funnel statistics without running

**Rate limits:**
- Embedding API: 10 per second (very generous)
- GPT-5.4: 2s delay between calls

**Output:**
```
=== Universal Matching Results ===
Total action items:        591
Already in tracker (PPC):  107
New items to process:      484
  Not applicable:          156 (skipped — not trackable)
  Trackable:               328

Matching funnel:
  Step 1 — No PH candidates:  132 (40% filtered)
  Step 2 — Embedding < 0.65:   98 (30% filtered)  
  Step 3 — GPT-5.4 called:     98 (30% reached GPT)
    HIGH match:               23
    MEDIUM match:              8
    No match:                 67

Final: 23 confirmed + 8 needs review + 297 missing
Cost: ~98 GPT calls (~$1.50-3.00), ~500 embeddings (~$0.003)
```

### 5. Update `matchProofHub()` in `ppc-task-tracker.js`

Modify the function to accept an optional `candidateOverride` parameter:

```javascript
export async function matchProofHub(task, clientId, meetingDate, db, candidateOverride = null) {
  // If candidates provided (from embedding pre-screen), use those
  // Otherwise, fetch from ProofHub API (existing behavior for pipeline)
  
  let candidateTasks;
  if (candidateOverride) {
    candidateTasks = candidateOverride;
  } else {
    // Existing ProofHub API fetch logic...
  }
  
  // Rest of matching logic unchanged (Phase 21D prompt)
}
```

Also add a follow-up/admin negative example to the prompt:
```
- "Follow up with client about proposal" ≠ "Client Onboarding Tasks" (verbal follow-up ≠ project task)
```

### 6. Insert non-PPC tasks into `ppc_task_tracking`

For each non-PPC action item, insert a row with:
- `platform = NULL` (non-PPC items don't have a platform)
- `action_type = NULL`
- `category` = the action item's category (admin, content, follow-up, etc.)
- `trackable` = true/false from Step 2
- `match_method` = which step determined the result
- `embedding_score` = best similarity score from Step 2

### 7. Pipeline integration update

In `src/poll.js`, after the existing PPC tracking call, also run universal matching for non-PPC items from the same meeting:

```javascript
// Existing: PPC tracking
try {
  const { trackPPCTasks } = await import('./lib/ppc-task-tracker.js');
  await trackPPCTasks(meetingId, evalDb);
} catch (e) {
  console.error('[PPC Tracker] Error:', e.message);
}

// New: Universal task tracking (non-PPC)
try {
  const { trackAllTasks } = await import('./lib/ppc-task-tracker.js');
  await trackAllTasks(meetingId, evalDb);
} catch (e) {
  console.error('[Task Tracker] Error:', e.message);
}
```

`trackAllTasks()` runs the 3-step funnel for each non-PPC action item from that meeting.

## File Changes

| File | Changes |
|------|---------|
| `src/lib/ppc-task-tracker.js` | Add columns migration, modify matchProofHub() to accept candidate override, add trackAllTasks() function, add follow-up negative example to prompt |
| `src/lib/embedding-cache.js` | NEW — embedding generation, caching, similarity search |
| `scripts/classify-trackability.mjs` | NEW — Gemini Flash batch classification of trackable vs not_applicable |
| `scripts/match-all-tasks.mjs` | NEW — 3-step funnel matching for all trackable non-PPC items |
| `src/poll.js` | Add trackAllTasks() call after trackPPCTasks() |

## Execution Order

1. Run schema migration (automatic on next dashboard restart via initPPCTrackingTable)
2. `node scripts/classify-trackability.mjs` — classify all 591 items (~12 Gemini Flash calls)
3. Cache PH embeddings: run `cachePhTaskEmbeddings()` (~500 embeddings, $0.003)
4. `node scripts/match-all-tasks.mjs --dry-run` — preview the funnel results
5. `node scripts/match-all-tasks.mjs` — run the full matching
6. `pm2 restart zoom-dashboard`

## Smoke Tests

```bash
# 1. Schema migration
node -e "require('./src/lib/ppc-task-tracker.js')" 
# Expected: no errors, new columns exist

# 2. Trackability classification (dry-run)
node scripts/classify-trackability.mjs --dry-run
# Expected: shows trackable/not_applicable counts

# 3. Trackability classification (run)
node scripts/classify-trackability.mjs
# Expected: ~350-400 trackable, ~150-200 not_applicable

# 4. PH embeddings cached
node -e "import('./src/lib/embedding-cache.js').then(m => m.cachePhTaskEmbeddings(db))"
# Expected: ~500 embeddings cached

# 5. Universal matching (dry-run)
node scripts/match-all-tasks.mjs --dry-run
# Expected: funnel stats showing filter rates per step

# 6. Universal matching (run)
node scripts/match-all-tasks.mjs
# Expected: ~20-30 new HIGH matches, ~5-10 MEDIUM

# 7. Total tracked tasks
# Expected: ppc_task_tracking now has 591 rows (was 107)

# 8. Categories populated
# Expected: SELECT DISTINCT category FROM ppc_task_tracking shows all 9 categories

# 9. Match methods populated
# Expected: SELECT match_method, COUNT(*) FROM ppc_task_tracking GROUP BY match_method

# 10. Pipeline test: process a new meeting and verify both PPC + universal tracking run
```

## Important Notes

- Do NOT rename ppc_task_tracking table — add columns only
- Embedding cache is one-time for existing PH tasks, auto-updates when ph_task_cache refreshes
- The 0.65 embedding threshold is tunable — start conservative, can lower if too many false skips
- GPT-5.4 temperature stays at 0.1
- Non-PPC items have platform=NULL, action_type=NULL — frontend must handle this
- The `trackable` flag means: should this item even HAVE a PH task? Not all action items should.
- Cost estimate: ~$2-4 total for the full backfill (embeddings $0.003 + ~100 GPT calls ~$2-3)
