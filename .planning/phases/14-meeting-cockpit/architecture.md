# Phase 14: Meeting Cockpit — Architecture

## The Reality

### ProofHub Tasks (Prosper Group: 18 tasks)
These are **high-level campaign tasks** created manually by Phil's team. They represent major deliverables:
```
[DONE] Advanced Team - Prosper - March 20th, 2026 Webinar
[DONE] Richard O - Liberty Spenders - March 20th Webinar Ads
[OPEN] Advanced Team - Prosper - March 20th VIP Page Updates
[OPEN] Advanced Team - Prosper - Webinar OTO & Delivery Pages in WordPress
```

### Roadmap Items (Prosper Group: 23 items)
These are **granular action items** extracted from meeting transcripts:
```
[done] Set up Facebook Ads for March 20th
[done] Optimize March 20 webinar ad spend by cutting non-performers
[in-progress] Finalize EverWebinar setup
[agreed] Draft April 'raise hand' email campaign
```

### The Mismatch

These are NOT 1-to-1. They're **different granularity levels**:

| ProofHub Task (campaign-level) | Roadmap Items (action-level) |
|-------------------------------|------------------------------|
| "March 20th, 2026 Webinar" | Set up Facebook Ads for March 20th |
| | Provide Zoom links for March 20th |
| | Send final webinar invites |
| | Evaluate ad budget increase |
| | Optimize ad spend by cutting non-performers |
| "March 20th Webinar Ads" | Set up Facebook Ads for March 20th |
| | Optimize ad spend by cutting non-performers |
| "VIP Page Updates" | Schedule VIP delivery email |
| | Finalize EverWebinar setup |
| (no PH task) | Draft April 'raise hand' email campaign |
| (no PH task) | Implement HubSpot Permission Tag |
| (no PH task) | Record 30-second promo reels |

So the relationship is: **One PH task → many roadmap items** (parent-child), not 1-to-1 matching.

And many roadmap items have **no PH task at all** — they're too granular for Phil to have created a ProofHub task for them.

## Matching Strategy

### What We're Actually Matching

Not "which PH task IS this roadmap item" but rather "which PH campaign/task CONTAINS this roadmap item."

A roadmap item like "Set up Facebook Ads for March 20th" is a **sub-task** of the ProofHub campaign "March 20th, 2026 Webinar" and also of "March 20th Webinar Ads."

### 4-Layer Matching (parent-child, not 1-to-1)

**Layer 1: Keyword/Topic Extraction**
- Extract key topic words from PH task title: "March 20th, 2026 Webinar" → `[march, 20th, webinar, 2026]`
- Extract from roadmap item: "Set up Facebook Ads for March 20th" → `[facebook, ads, march, 20th]`
- If 2+ topic words overlap AND same client → candidate parent

**Layer 2: Date Window**
- PH task created 2026-03-05 ("March 20th Webinar")
- Roadmap item created from meeting on 2026-03-03 or 2026-03-10
- If roadmap item creation meeting is within 14 days of PH task creation → strengthen match

**Layer 3: Category Alignment**
- PH task has "Ads" in title → maps to `paid-ads` category
- Roadmap item category is `paid-ads` → category match confirms

**Layer 4: AI Batch Reconciliation (for unmatched remainders)**
- After layers 1-3, send unmatched items to Gemini in ONE batch call:
  ```
  Here are 8 unmatched roadmap items and 3 unmatched ProofHub campaign tasks for Prosper Group.
  For each roadmap item, determine if it is a sub-task of any PH campaign. Return the mapping.
  A roadmap item can belong to 0 or 1 PH campaign. A PH campaign can contain 0 or many roadmap items.
  ```
- This handles semantic matches like: "Nudge clients Jared and Jerry for Orlando event paperwork" → could be sub-task of a PH campaign about the Orlando event

### Storage Schema

New table: `roadmap_ph_links`

```sql
CREATE TABLE roadmap_ph_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  roadmap_item_id INTEGER NOT NULL,
  ph_task_id TEXT NOT NULL,           -- ProofHub task ID
  ph_task_title TEXT,                 -- Cached title for display
  match_method TEXT NOT NULL,         -- 'keyword' | 'date_window' | 'category' | 'ai_batch' | 'manual'
  match_confidence REAL,             -- 0.0 to 1.0
  matched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (roadmap_item_id) REFERENCES roadmap_items(id)
);
```

Why a separate table instead of a column on `roadmap_items`:
- One roadmap item could relate to multiple PH campaigns (rare but possible)
- We want to store HOW the match was made (method, confidence)
- We can add manual overrides (Phil corrects a wrong match in the UI)
- Cleaner than stuffing JSON into a column

Also add a **PH status cache table** so we don't hit the API every time:

```sql
CREATE TABLE ph_task_cache (
  ph_task_id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  title TEXT,
  completed INTEGER DEFAULT 0,       -- 0 or 1
  assigned_to TEXT,
  due_date TEXT,
  last_synced_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Reconciliation Flow

```
1. INITIAL RECONCILIATION (one-time per client)
   │
   ├─ Pull all PH tasks for client (API call, cache in ph_task_cache)
   ├─ Pull all roadmap items for client (local DB)
   │
   ├─ Layer 1: Keyword matching → store links with method='keyword'
   ├─ Layer 2: Date window → strengthen/add matches
   ├─ Layer 3: Category alignment → strengthen/add matches
   ├─ Layer 4: AI batch for remainders → store with method='ai_batch'
   │
   └─ Store all links in roadmap_ph_links

2. INCREMENTAL (when new meeting processed or new PH tasks appear)
   │
   ├─ Only match NEW roadmap items (no existing link)
   ├─ Only against PH tasks created since last sync
   └─ Same 4 layers but on smaller dataset

3. BRIEF GENERATION (every time Phil clicks)
   │
   ├─ For each roadmap item in prep:
   │   ├─ Look up roadmap_ph_links → get ph_task_id(s)
   │   ├─ Look up ph_task_cache → get completion status
   │   │   (if cache older than 1 hour, refresh from API)
   │   └─ Enrich prep data with PH status
   │
   └─ No AI calls, no matching — just DB lookups + optional API refresh
```

### What Phil Sees

```
☑ Set up Facebook Ads for March 20th [DONE in roadmap]
  📋 PH: "March 20th Webinar Ads" — ✅ Completed (Richard O)
  → Already reported — skip or briefly mention

☑ Finalize EverWebinar setup [IN-PROGRESS in roadmap]
  📋 PH: "VIP Page Updates" — 🔄 Open (Advanced Team)
  → PH task still open, Phil knows internal work is ongoing

☐ Implement HubSpot Permission Tag [AGREED, stale 3 meetings]
  📋 No linked PH task
  → Phil needs to decide: create PH task or drop it?

☑ Draft April 'raise hand' email campaign [AGREED]
  📋 No linked PH task
  → New item, hasn't been turned into PH work yet. Phil can pitch it.
```

### Interactive Cockpit (Dashboard)

The Meeting Prep tab gets a third view mode alongside "Full Prep" and "Brief":

**"Meeting Cockpit" view:**
- Each roadmap item displayed as a row with:
  - ☐ Checkbox (Phil toggles: discuss / skip)
  - Title + status badge
  - PH link status (linked + PH status, or "No PH task")
  - Talking point (generated once, cached)
  - Priority indicator
- Items grouped by: Wins | Blockers | Stale | Proposals
- Phil checks the items he wants → "Build My Agenda" button → generates personalized agenda from checked items only
- Selections persist per client per day (localStorage or SQLite)

### Phil's Workflow

```
Morning of meeting day:
  1. Open dashboard → Meeting Prep tab → Prosper Group
  2. Click "Meeting Cockpit" (or it's the default)
  3. System shows all items with PH status (cached, instant)
  4. Phil checks items to discuss, unchecks what to skip
  5. Clicks "Build My Agenda" → gets personalized talking points
  6. 2 minutes before call: glances at the agenda on his phone/screen
  7. Client joins → Phil leads with confidence
```

### API Endpoints (new)

```
POST /api/reconcile/:clientId          → Run initial PH reconciliation for client
GET  /api/reconcile/:clientId/status   → Check reconciliation status (linked/unlinked counts)
GET  /api/cockpit/:clientId            → Get cockpit data (prep + PH status + links)
PUT  /api/cockpit/:clientId/selection  → Save Phil's checkbox selections
GET  /api/cockpit/:clientId/agenda     → Get personalized agenda from selections
POST /api/cockpit/:clientId/link       → Manual link: Phil connects a roadmap item to PH task
DELETE /api/cockpit/:clientId/link/:id → Remove a wrong link
```

### Implementation Phases

**14A: PH Reconciliation Engine**
- New tables: `roadmap_ph_links`, `ph_task_cache`
- 4-layer matching logic in `src/lib/ph-reconciler.js`
- CLI: `node src/ph-reconcile.js --client prosper-group`
- API: `/api/reconcile/:clientId`
- Run for Prosper Group as test

**14B: Cockpit Data + API**
- Enrich prep data with PH status in `prep-collector.js`
- Cockpit API endpoints
- Selection persistence (SQLite table `cockpit_selections`)
- Talking points generation (add to Gemini prompt)

**14C: Cockpit Dashboard UI**
- Interactive checkbox view in Meeting Prep tab
- PH status indicators on each item
- "Build My Agenda" flow
- Manual link/unlink UI

### Files to Create
- `src/lib/ph-reconciler.js` — 4-layer matching engine
- `src/ph-reconcile.js` — CLI for reconciliation

### Files to Modify
- `src/lib/roadmap-db.js` — New tables init
- `src/lib/prep-collector.js` — Enrich with PH status
- `src/lib/prep-generator.js` — Add talking points to prompt
- `src/api/routes.js` — New endpoints
- `public/index.html` — Cockpit UI

### Cost Analysis
- Initial reconciliation: 1 Gemini call per client (for AI batch, layer 4) = ~$0.001 per client
- PH API calls: ~20 per client for full task pull (one-time, then cached)
- Per-brief generation: 0 Gemini calls for PH matching (all cached), 1 Gemini call for prep (existing)
- Total for 30 clients initial reconciliation: ~$0.03 + 600 PH API calls (within rate limits)
