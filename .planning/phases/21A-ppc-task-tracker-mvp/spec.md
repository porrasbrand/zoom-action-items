# Phase 21A: PPC Task Accountability Tracker — MVP

## Objective
Build an LLM-powered system that identifies PPC-related action items from meeting transcripts and verifies whether they were tracked in ProofHub. This is the MVP — Slack and ad platform verification come later.

## Prior Work Summary
- Action items are already extracted from meetings by the pipeline (ai_extractor.js → ai_extraction JSON)
- ProofHub integration exists (auto-push.js, proofhub API keys in .env)
- Session Intelligence dashboard is live with 6 sub-views
- ProofHub API key: in .env as PROOFHUB_API_KEY, PROOFHUB_COMPANY_URL=breakthrough3x.proofhub.com

## Deliverables

### 1. New file: `src/lib/ppc-task-tracker.js`

#### Function: `classifyPPCTasks(meetingId, db)`
For a given meeting, get the action items from ai_extraction and classify which are PPC-related.

```javascript
// Get meeting's action items
const meeting = db.prepare('SELECT ai_extraction, client_id, client_name, start_time FROM meetings WHERE id = ?').get(meetingId);
const extraction = JSON.parse(meeting.ai_extraction);
const actionItems = extraction.action_items || extraction[0]?.action_items || [];

// For each action item, classify with LLM
// Use Gemini 2.0 Flash (fast, cheap — simple yes/no classification)
```

**LLM Classification Prompt (Gemini 2.0 Flash):**
```
Given this action item from a client meeting:
Title: "{title}"
Description: "{description}"
Client: "{client_name}"

Is this a PPC/paid advertising task? Consider: Google Ads, Google LSA (Local Services Ads), Meta/Facebook Ads, Bing/Microsoft Ads, campaign management, bid adjustments, budget changes, ad copy changes, targeting/audience changes, conversion tracking, pixel setup, landing page changes for ads, call tracking for ads, reporting on ad performance.

Respond in JSON:
{
  "is_ppc": true/false,
  "platform": "google_ads" | "google_lsa" | "meta" | "bing" | "multiple" | "unknown" | null,
  "action_type": "create" | "modify" | "pause" | "enable" | "budget" | "targeting" | "reporting" | "other" | null,
  "confidence": "high" | "medium" | "low"
}
```

Use `@google/generative-ai` SDK with model `gemini-2.0-flash`, responseMimeType: 'application/json'.

Batch multiple action items in one prompt for efficiency:
```
Classify each of these action items as PPC or not:
1. "{title1}" — {description1}
2. "{title2}" — {description2}
...

Respond with a JSON array of classifications.
```

#### Function: `matchProofHub(task, clientId, meetingDate, db)`
For a PPC task, search ProofHub for a matching task.

```javascript
// 1. Get the ProofHub project ID for this client
//    Check the existing client config or the proofhub mapping
//    The auto-push feature already maps clients to ProofHub projects

// 2. Fetch ProofHub tasks for that project
//    GET https://breakthrough3x.proofhub.com/api/v3/projects/{project_id}/todolists
//    Filter tasks created within 10 days of meeting date
//    Headers: { 'X-API-KEY': process.env.PROOFHUB_API_KEY, 'User-Agent': 'zoom-action-items' }

// 3. For each candidate ProofHub task, ask GPT-5.4 for semantic match
```

**LLM Match Prompt (GPT-5.4):**
```
TASK from client meeting ({meeting_date}):
Title: "{task_title}"
Description: "{task_description}"
Owner: "{owner}"
Client: "{client_name}"

PROOFHUB TASKS (created within 10 days of meeting):
1. Title: "{ph_title_1}", Created: "{date}", Assignee: "{assignee}", Status: "{status}"
2. Title: "{ph_title_2}", Created: "{date}", Assignee: "{assignee}", Status: "{status}"
...

Which ProofHub task (if any) tracks the same work as the meeting action item? Consider:
- Same intent even if different wording
- Same client context
- Could be a broader task that encompasses this specific item

Respond in JSON:
{
  "match_found": true/false,
  "matched_index": 1-N or null,
  "confidence": "high" | "medium" | "low",
  "match_reasoning": "brief explanation"
}
```

Use `model-providers.js` callModel with 'gpt-5.4'.

#### Function: `trackPPCTasks(meetingId, db)`
Orchestrates the full flow for one meeting:
1. classifyPPCTasks → get PPC action items
2. For each PPC task, matchProofHub → check ProofHub
3. Store results in ppc_task_tracking table
4. Return summary

#### Function: `backfillPPCTracking(db)`
Run tracking for all existing meetings that have action items.

#### Function: `getPPCReport(db, clientId, options)`
Query the tracking data for reporting:
- Per-client: completion rates, missing tasks, avg time to ProofHub
- Agency-wide: overall completion, worst clients, drop-off funnel
- Per-meeting: which tasks were tracked vs missed

### 2. Database table: `ppc_task_tracking`

```sql
CREATE TABLE IF NOT EXISTS ppc_task_tracking (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id INTEGER NOT NULL REFERENCES meetings(id),
  action_item_index INTEGER NOT NULL,
  task_title TEXT NOT NULL,
  task_description TEXT,
  client_id TEXT NOT NULL,
  client_name TEXT,
  platform TEXT,  -- google_ads, google_lsa, meta, bing, multiple, unknown
  action_type TEXT,  -- create, modify, pause, enable, budget, targeting, reporting, other
  owner TEXT,
  meeting_date TEXT NOT NULL,
  ppc_confidence TEXT,  -- high, medium, low
  
  -- Checkpoint: ProofHub
  proofhub_match BOOLEAN DEFAULT NULL,  -- null=unchecked, 0=no match, 1=matched
  proofhub_task_id TEXT,
  proofhub_task_title TEXT,
  proofhub_status TEXT,  -- complete, incomplete
  proofhub_created TEXT,
  proofhub_assignee TEXT,
  proofhub_confidence TEXT,  -- high, medium, low
  proofhub_reasoning TEXT,
  
  -- Scoring
  completion_score REAL,  -- 0-100
  days_to_proofhub INTEGER,
  
  -- Disposition (for tasks intentionally not done)
  disposition TEXT DEFAULT 'pending',  -- pending, completed, cancelled, deprioritized, blocked
  disposition_reason TEXT,
  
  -- Metadata
  computed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_checked DATETIME,
  
  UNIQUE(meeting_id, action_item_index)
);
```

### 3. CLI: `src/ppc-tracker.js`

```bash
# Classify + track one meeting
node src/ppc-tracker.js --meeting 86

# Backfill all meetings
node src/ppc-tracker.js --backfill

# Report for a client
node src/ppc-tracker.js --report --client gs-home-services

# Agency-wide report
node src/ppc-tracker.js --report --agency
```

### 4. API endpoints in `src/api/routes.js`

Add BEFORE the session `:meetingId` catch-all:

```
GET /api/ppc/status                    — Agency-wide PPC tracking stats
GET /api/ppc/client/:clientId          — Per-client PPC task list + completion rates
GET /api/ppc/meeting/:meetingId        — PPC tasks from a specific meeting
GET /api/ppc/at-risk                   — Tasks missing from ProofHub (needs attention)
POST /api/ppc/task/:id/disposition     — Mark task as cancelled/deprioritized
```

### 5. Dashboard: PPC Accountability tab

Add a new top-level tab "PPC Tasks" (alongside Meetings, Roadmap, Meeting Prep, Session Intelligence).

#### PPC Overview
```
PPC Task Accountability
────────────────────────────────
Total PPC Tasks (30 days): 47
In ProofHub: 31 (66%)
Missing: 16 (34%)
Avg days to ProofHub: 1.8

Drop-off Funnel:
██████████████████░░░░ 66% tracked in ProofHub
```

#### Per-Client Cards
```
┌─────────────────────────┐  ┌─────────────────────────┐
│ GS Home Services        │  │ 1st Choice              │
│ 8 PPC tasks (30 days)   │  │ 3 PPC tasks (30 days)   │
│ 5 in ProofHub (63%)     │  │ 3 in ProofHub (100%) ✅ │
│ 3 MISSING ❌            │  │                         │
└─────────────────────────┘  └─────────────────────────┘
```

#### At-Risk Tasks List
```
❌ MISSING FROM PROOFHUB:
• "Disable Windows leads in LSA" — GS Home Services — Mar 31 — Owner: Phil — 6 days ago
• "Add negative keywords for screen repair" — GS Home Services — Mar 31 — Owner: Phil — 6 days ago
• "Increase Meta budget to $2000" — Pearce HVAC — Apr 2 — Owner: Joe — 4 days ago
```

Click a task → opens the meeting scorecard for context.

#### Task detail (when clicking a task)
Shows:
- Task title + description
- Meeting context (topic, date, client)
- ProofHub status: ✅ Matched / ❌ Missing / ⏳ Checking
- If matched: ProofHub task title, assignee, status, created date
- Disposition buttons: Mark as Cancelled / Deprioritized / Blocked

### 6. Integration with pipeline

In `src/poll.js`, after session evaluation (non-blocking):
```javascript
try {
  const { trackPPCTasks } = await import('./lib/ppc-task-tracker.js');
  await trackPPCTasks(meetingId, evalDb);
} catch (e) {
  console.error('[PPC Tracker] Error:', e.message);
}
```

## ProofHub API Reference

The existing codebase already uses ProofHub API. Check:
- `src/lib/auto-push.js` — how it creates tasks
- `.env` — PROOFHUB_API_KEY, PROOFHUB_COMPANY_URL
- Client → ProofHub project mapping (check clients.json or auto-push config)

**Key ProofHub endpoints:**
```
GET /api/v3/projects                              — list all projects
GET /api/v3/projects/{id}/todolists               — list task lists
GET /api/v3/projects/{id}/todolists/{id}/tasks    — list tasks in a list
```

Headers: `X-API-KEY: {key}`, `User-Agent: zoom-action-items`
Base URL: `https://{PROOFHUB_COMPANY_URL}/api/v3`

## Smoke Tests

```bash
# 1. Classify PPC tasks for a known meeting
node src/ppc-tracker.js --meeting 86
# Expected: identifies PPC tasks from GS Home Services meeting

# 2. Check ProofHub matching
# Expected: some tasks match, some don't

# 3. Agency report
node src/ppc-tracker.js --report --agency
# Expected: shows completion rates per client

# 4. API endpoints
curl http://localhost:3875/zoom/api/ppc/status
curl http://localhost:3875/zoom/api/ppc/at-risk

# 5. Backfill all meetings
node src/ppc-tracker.js --backfill
# Expected: processes all meetings with action items

# 6. Dashboard tab renders
# Visual check: PPC Tasks tab appears, shows data
```

## Important Notes

- Use Gemini 2.0 Flash for PPC classification (fast, cheap)
- Use GPT-5.4 via model-providers.js for ProofHub matching (best semantic understanding)
- Batch LLM calls where possible (multiple action items per prompt)
- ProofHub API may have rate limits — add 1s delay between requests
- Store the LLM's match_reasoning for audit/debugging
- The UNIQUE(meeting_id, action_item_index) constraint prevents duplicates on re-runs
- Non-blocking integration in poll.js (try/catch, don't break the main pipeline)
