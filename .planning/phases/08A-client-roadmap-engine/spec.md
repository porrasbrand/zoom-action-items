# Phase 08A: Client Roadmap Engine (Cross-Meeting Intelligence)

## Context

The zoom-action-items pipeline currently processes each meeting in isolation: Zoom recording → Gemini extraction → action items → Slack → ProofHub. There is no longitudinal tracking across meetings for a client. Action items from Meeting N-6 are not connected to discussions in Meeting N-5, N-4, etc.

B3X holds ~30 client meetings/week. Phil (and the team) needs to understand the full arc of a client engagement: what was agreed, what got done, what's stuck, what's forgotten, and what's next. This is the **Client Roadmap** — a living project plan per client that evolves meeting-by-meeting.

### Available Data
- SQLite database (`data/zoom-action-items.db`) with `meetings`, `action_items`, `decisions` tables
- 30+ clients configured in `src/config/clients.json` with ProofHub project IDs
- Gemini 2.0 Flash for AI extraction
- Task taxonomy: 10 categories, 35 task types derived from 337 real ProofHub tasks (see `task-taxonomy.json` in this directory)

### Key Insight
Meeting N-6 is the "seed" — it establishes the initial roadmap items. Each subsequent meeting (N-5, N-4, ..., N-1) is processed sequentially, and the AI cross-references the current roadmap to detect: status changes, new items, completed items, and stale/forgotten items.

## Objective

Build a roadmap engine that:
1. Creates a **living roadmap per client** from chronological meeting analysis
2. Tracks each roadmap item across meetings with **status transitions** (agreed → in-progress → done/blocked/dropped)
3. Classifies items using the **canonical task taxonomy** (10 categories, 35 types)
4. Distinguishes **B3X responsibility vs client responsibility**
5. Detects **stale items** (not discussed in 2+ consecutive meetings)
6. Stores everything in SQLite for dashboard consumption (Phase 08B+)

## Database Schema

### New table: `roadmap_items`

```sql
CREATE TABLE roadmap_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,

  -- Task identity
  title TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL,          -- from taxonomy: paid-ads, email-marketing, website, etc.
  task_type TEXT NOT NULL,          -- from taxonomy: google-ads-management, content-emails, etc.

  -- Ownership
  owner_side TEXT NOT NULL DEFAULT 'b3x',  -- 'b3x' or 'client'
  owner_name TEXT,                          -- specific person: Phil, Jacob, Dan, client contact

  -- Status tracking
  status TEXT NOT NULL DEFAULT 'agreed',    -- agreed, in-progress, blocked, done, dropped, deferred
  status_reason TEXT,                       -- why status changed (from AI analysis)

  -- Meeting linkage
  created_meeting_id INTEGER NOT NULL,      -- meeting where first identified
  last_discussed_meeting_id INTEGER,        -- last meeting where AI detected mention
  meetings_discussed TEXT DEFAULT '[]',     -- JSON array of meeting IDs where discussed
  meetings_silent_count INTEGER DEFAULT 0,  -- consecutive meetings NOT discussed (staleness)

  -- Dates
  due_date TEXT,

  -- Status history (audit trail)
  status_history TEXT DEFAULT '[]',  -- JSON: [{meeting_id, status, notes, date}]

  -- Source linkage
  source_action_item_id INTEGER,     -- links to original action_items row (if from extraction)

  -- Timestamps
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_roadmap_client ON roadmap_items(client_id);
CREATE INDEX idx_roadmap_status ON roadmap_items(status);
CREATE INDEX idx_roadmap_category ON roadmap_items(category);
CREATE INDEX idx_roadmap_stale ON roadmap_items(meetings_silent_count);
```

### New table: `roadmap_snapshots`

```sql
-- Snapshot of roadmap state after each meeting is processed
-- Enables "show me the roadmap as of Meeting N-3"
CREATE TABLE roadmap_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,
  meeting_id INTEGER NOT NULL,
  snapshot_data TEXT NOT NULL,  -- JSON: full roadmap state at this point
  items_total INTEGER,
  items_done INTEGER,
  items_in_progress INTEGER,
  items_blocked INTEGER,
  items_stale INTEGER,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

## Implementation Steps

### 1. Create task taxonomy config (`src/config/task-taxonomy.json`)

Copy the refined taxonomy from `.planning/phases/08A-client-roadmap-engine/task-taxonomy.json` to `src/config/task-taxonomy.json` on Hetzner. This is the canonical reference for the AI classifier.

### 2. Create roadmap database layer (`src/lib/roadmap-db.js`)

```javascript
// Key functions:
export function initRoadmapTables(db)          // CREATE TABLE IF NOT EXISTS
export function createRoadmapItem(db, item)    // INSERT new item
export function updateRoadmapItem(db, id, updates)  // UPDATE status, last_discussed, etc.
export function getRoadmapForClient(db, clientId)    // SELECT all items for a client
export function getActiveRoadmapItems(db, clientId)  // SELECT WHERE status NOT IN ('done','dropped')
export function getStaleItems(db, clientId, threshold) // SELECT WHERE meetings_silent_count >= threshold
export function appendStatusHistory(db, id, entry)     // JSON append to status_history
export function incrementSilentCount(db, clientId, meetingId)  // Bump silent count for items NOT discussed
export function saveSnapshot(db, clientId, meetingId, roadmapState)  // Save roadmap snapshot
```

### 3. Create roadmap AI processor (`src/lib/roadmap-processor.js`)

This is the core engine. It processes meetings **chronologically** for a client.

```javascript
/**
 * Process a single meeting against the current roadmap state.
 *
 * @param {Object} meeting - Meeting record from DB (with transcript, action items)
 * @param {Array} currentRoadmap - Current roadmap items for this client
 * @param {Object} taxonomy - Task taxonomy config
 * @returns {Object} - { updated_items: [], new_items: [], completed_items: [] }
 */
export async function processAgainstRoadmap(meeting, currentRoadmap, taxonomy)
```

**The AI prompt for cross-referencing (Gemini call):**

```
You are analyzing a client meeting transcript and comparing it against an existing project roadmap.

CLIENT: {client_name}
MEETING DATE: {date}
MEETING NUMBER: {n} of {total} (chronological)

CURRENT ROADMAP (from previous meetings):
{JSON list of roadmap items with: title, category, task_type, owner_side, owner_name, status, due_date}

TASK TAXONOMY (valid categories and types):
{categories and task_types from taxonomy}

MEETING TRANSCRIPT:
{transcript}

MEETING ACTION ITEMS (already extracted):
{action items from existing pipeline extraction}

INSTRUCTIONS:
1. For EACH existing roadmap item, determine:
   - was_discussed: true/false (was this topic mentioned or referenced?)
   - new_status: unchanged/in-progress/done/blocked/deferred (only change if evidence in transcript)
   - status_evidence: quote or paraphrase from transcript supporting status change
   - new_details: any updates (new due date, owner change, scope change)

2. Identify NEW items from this meeting not on the roadmap:
   - title: clear, canonical task name
   - category: from taxonomy (must be valid category id)
   - task_type: from taxonomy (must be valid task_type id)
   - owner_side: 'b3x' or 'client' (who is responsible?)
   - owner_name: specific person if mentioned
   - due_date: if mentioned
   - description: brief context
   - transcript_evidence: relevant quote

3. For items classified as 'done', provide the evidence from transcript.

Return JSON:
{
  "existing_items_update": [
    { "roadmap_item_id": N, "was_discussed": bool, "new_status": "...", "status_evidence": "...", "new_details": {...} }
  ],
  "new_items": [
    { "title": "...", "category": "...", "task_type": "...", "owner_side": "...", "owner_name": "...", "due_date": "...", "description": "...", "transcript_evidence": "..." }
  ]
}
```

### 4. Create roadmap builder CLI (`src/roadmap-build.js`)

Entry point for building/rebuilding a client's roadmap from historical meetings.

```javascript
// Usage: node src/roadmap-build.js --client echelon [--meetings 6] [--dry-run]

// Steps:
// 1. Fetch last N meetings for client from DB (chronological, oldest first)
// 2. Meeting 1 (seed): extract initial roadmap items from action_items
// 3. For each subsequent meeting: call processAgainstRoadmap()
// 4. After each meeting: update DB, save snapshot, increment silent counts
// 5. Output final roadmap state
```

**Processing flow per meeting:**

```
Meeting N-6 (seed):
  → Take existing action_items from DB
  → Classify each with taxonomy (AI call)
  → Determine owner_side (b3x vs client)
  → INSERT into roadmap_items with status='agreed'
  → Save snapshot

Meeting N-5:
  → Load current roadmap (active items)
  → Call processAgainstRoadmap(meeting, currentRoadmap, taxonomy)
  → For each existing item:
    - If discussed: update last_discussed_meeting_id, reset silent_count=0
    - If status changed: update status, append to status_history
    - If NOT discussed: increment meetings_silent_count
  → For each new item: INSERT into roadmap_items
  → Save snapshot

Meeting N-4, N-3, N-2, N-1:
  → Same process, roadmap grows and evolves
```

### 5. Add `clients.json` enhancements

Add fields needed for roadmap context:

```json
{
  "id": "echelon",
  "name": "Echelon",
  "industry": "home-services-electrical-hvac",
  "services_active": ["google-ads", "bing-ads", "website", "gbp", "email-marketing"],
  "services_available": ["lsa", "meta-ads", "call-tracking", "seo"],
  "meeting_cadence": "biweekly",
  "primary_contact": "Andrew Williams",
  "b3x_lead": "Phil Mutrie",
  "account_start_date": "2025-09-15",
  "keywords": ["echelon", "andrew williams"],
  "slack_channel_id": "C08RTPBLV46",
  "ph_project_id": "9104911511"
}
```

New fields: `industry`, `services_active`, `services_available`, `meeting_cadence`, `primary_contact`, `b3x_lead`, `account_start_date`. These feed the meeting prep generator (Phase 08B).

### 6. Add roadmap API endpoints (`src/api/routes.js`)

```javascript
// Roadmap endpoints
GET  /api/roadmap/:clientId                 // Full roadmap for client
GET  /api/roadmap/:clientId/active          // Active items only (not done/dropped)
GET  /api/roadmap/:clientId/stale           // Items with silent_count >= 2
GET  /api/roadmap/:clientId/by-category     // Grouped by category
GET  /api/roadmap/:clientId/snapshot/:meetingId  // Roadmap state at a specific meeting
GET  /api/roadmap/:clientId/timeline        // Status changes over time
POST /api/roadmap/:clientId/build           // Trigger roadmap build (with ?meetings=6&dry-run=true)
PUT  /api/roadmap/items/:id                 // Manual edit of roadmap item
POST /api/roadmap/items/:id/status          // Manual status change
```

## Files to Create

On Hetzner at `~/awsc-new/awesome/zoom-action-items/`:

1. `src/config/task-taxonomy.json` — Canonical task taxonomy (10 categories, 35 types)
2. `src/lib/roadmap-db.js` — SQLite CRUD for roadmap_items and roadmap_snapshots
3. `src/lib/roadmap-processor.js` — AI cross-referencing engine (Gemini calls)
4. `src/roadmap-build.js` — CLI entry point for building client roadmaps

## Files to Modify

1. `src/config/clients.json` — Add industry, services_active, services_available, meeting_cadence, primary_contact, b3x_lead, account_start_date fields
2. `src/api/routes.js` — Add roadmap API endpoints
3. `src/lib/database.js` — Add initRoadmapTables() call to DB initialization

## Do NOT Touch

- `src/poll.js` / `src/service.js` — Pipeline polling (separate concern)
- `src/lib/ai-extractor.js` — Existing per-meeting extraction (unchanged)
- `src/lib/slack-publisher.js` — Slack posting (separate concern)
- `public/index.html` — Dashboard frontend (separate phase for roadmap UI)

## Acceptance Criteria

- [ ] `roadmap_items` and `roadmap_snapshots` tables created on DB init
- [ ] `task-taxonomy.json` loaded and validated on startup
- [ ] `node src/roadmap-build.js --client echelon --meetings 6 --dry-run` processes 6 meetings and outputs roadmap to console
- [ ] Seed meeting correctly creates initial roadmap items from action_items
- [ ] Subsequent meetings detect status changes (done, in-progress, blocked) with evidence
- [ ] New items from later meetings are added to roadmap with correct taxonomy classification
- [ ] `meetings_silent_count` increments for items not discussed in a meeting
- [ ] `status_history` JSON array tracks all transitions with meeting_id and date
- [ ] Snapshots saved after each meeting processed
- [ ] `GET /api/roadmap/echelon` returns full roadmap with all fields
- [ ] `GET /api/roadmap/echelon/stale` returns items with silent_count >= 2
- [ ] `GET /api/roadmap/echelon/by-category` groups items correctly
- [ ] All roadmap items have valid category and task_type from taxonomy
- [ ] owner_side correctly distinguishes B3X vs client responsibilities
- [ ] Gemini rate limiting respected (reuse existing MIN_INTERVAL pattern)

## Smoke Tests

```bash
# Build roadmap for echelon (dry run)
cd ~/awsc-new/awesome/zoom-action-items
node src/roadmap-build.js --client echelon --meetings 6 --dry-run

# Build roadmap for real
node src/roadmap-build.js --client echelon --meetings 6

# Check API
curl -s http://localhost:3875/api/roadmap/echelon | jq '.items | length'
curl -s http://localhost:3875/api/roadmap/echelon/stale | jq '.items[] | {title, silent_count: .meetings_silent_count}'
curl -s http://localhost:3875/api/roadmap/echelon/by-category | jq 'keys'

# Verify taxonomy compliance
curl -s http://localhost:3875/api/roadmap/echelon | jq '.items[] | {category, task_type}' | sort -u
```

## Completion Instructions

1. Run all smoke tests
2. Verify at least one client roadmap builds successfully end-to-end
3. Commit with prefix: `[zoom-pipeline-08A]`
4. Update `.planning/status.json` to mark 08A as COMPLETE
