# Phase 15A: SQL Baseline Metrics Engine

## Prior Work Summary
The zoom-action-items pipeline (Phases 01-14C) is fully operational on Hetzner. It processes ~30 Zoom meetings/week, extracts action items via Gemini AI, routes to Slack, syncs to ProofHub, builds roadmaps, and generates meeting prep. All data lives in `data/zoom-action-items.db` (SQLite).

**Existing tables relevant to this phase:**
- `meetings` — 99 meetings with `transcript_raw`, `ai_extraction` (JSON), `start_time`, `duration_minutes`, `client_id`, `client_name`
- `action_items` — 673 items with `owner_name`, `due_date`, `priority`, `category`, `transcript_excerpt`, `confidence_tier`
- `roadmap_items` — 246 items with `status`, `owner_side` (b3x/client), `meetings_silent_count`, `category`, `task_type`
- `decisions` — per-meeting decisions with context

**This phase adds:** Automated SQL-computable metrics for every meeting — no AI calls, zero cost.

## Objective
Build a session metrics engine that computes quantitative meeting quality indicators from existing data. These metrics feed into Phase 15B (AI evaluator) as context and stand alone as dashboardable data.

## New Database Table

```sql
CREATE TABLE IF NOT EXISTS session_metrics (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  meeting_id INTEGER NOT NULL UNIQUE REFERENCES meetings(id),
  
  -- Action item metrics
  action_item_count INTEGER DEFAULT 0,
  action_density REAL DEFAULT 0,              -- items per minute
  due_date_rate REAL DEFAULT 0,               -- % of items with due dates
  owner_assignment_rate REAL DEFAULT 0,        -- % of items with owner_name
  high_priority_rate REAL DEFAULT 0,           -- % items marked high priority
  category_spread INTEGER DEFAULT 0,           -- distinct categories used
  
  -- Decision metrics
  decision_count INTEGER DEFAULT 0,
  decisions_per_minute REAL DEFAULT 0,
  
  -- Speaker analysis (parsed from transcript_raw)
  total_speakers INTEGER DEFAULT 0,
  b3x_speaker_count INTEGER DEFAULT 0,
  client_speaker_count INTEGER DEFAULT 0,
  b3x_line_count INTEGER DEFAULT 0,
  client_line_count INTEGER DEFAULT 0,
  b3x_word_count INTEGER DEFAULT 0,
  client_word_count INTEGER DEFAULT 0,
  speaker_ratio_b3x REAL DEFAULT 0,           -- % of words from B3X side (0-100)
  speaker_ratio_client REAL DEFAULT 0,        -- % of words from client side (0-100)
  dominant_speaker TEXT,                       -- name of person who talked most
  dominant_speaker_pct REAL DEFAULT 0,         -- % of words from dominant speaker
  
  -- Roadmap/accountability metrics (cross-meeting)
  b3x_stale_items INTEGER DEFAULT 0,          -- owner_side='b3x' with meetings_silent_count > 2
  client_stale_items INTEGER DEFAULT 0,        -- owner_side='client' with meetings_silent_count > 2
  repeat_topics INTEGER DEFAULT 0,             -- action items similar to previous meeting
  roadmap_items_discussed INTEGER DEFAULT 0,   -- items from roadmap referenced in this meeting
  
  -- Meeting metadata
  duration_minutes INTEGER DEFAULT 0,
  meeting_type TEXT DEFAULT 'regular',         -- inferred: regular, internal, kickoff, unknown
  
  -- Timestamps
  computed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

## Implementation

### Create `src/lib/session-metrics.js`

```javascript
// Session Metrics Engine
// Computes quantitative meeting quality indicators from existing SQL data.
// No AI calls — pure SQL + transcript parsing.

import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = join(__dirname, '..', '..', 'data', 'zoom-action-items.db');
```

**Key functions to implement:**

#### 1. `computeActionMetrics(db, meetingId)`
Query `action_items` for this meeting:
- `action_item_count`: COUNT
- `action_density`: count / duration_minutes
- `due_date_rate`: COUNT(due_date IS NOT NULL) / COUNT(*)
- `owner_assignment_rate`: COUNT(owner_name IS NOT NULL AND owner_name != '') / COUNT(*)
- `high_priority_rate`: COUNT(priority = 'high') / COUNT(*)
- `category_spread`: COUNT(DISTINCT category)

#### 2. `computeDecisionMetrics(db, meetingId)`
Query `decisions` for this meeting:
- `decision_count`: COUNT
- `decisions_per_minute`: count / duration_minutes

#### 3. `parseSpeakerMetrics(transcriptRaw, clientId)`
Parse the VTT-style transcript to extract speaker attribution. Transcripts use format like:
```
Dan Kuschell: Let me share the results...
Philip Mutrie: Sure, and about the ads...
Brendan: Yeah that sounds good.
```

**B3X team members** (known names to classify as B3X side):
```javascript
const B3X_TEAM = [
  'dan kuschell', 'dan', 'daniel kuschell',
  'philip mutrie', 'phil', 'phil mutrie', 'philip',
  'joe boland', 'joe',
  'richard bond', 'richard',
  'tea', 'tia',  // assistant
  'lynn',        // assistant
];
```

Logic:
- Split transcript by lines
- Detect speaker changes (line starts with "Name:")
- Count lines and words per speaker
- Classify each speaker as B3X or client
- Calculate ratios, dominant speaker

#### 4. `computeAccountabilityMetrics(db, meetingId, clientId)`
Query `roadmap_items` for this client:
- `b3x_stale_items`: WHERE owner_side='b3x' AND meetings_silent_count > 2
- `client_stale_items`: WHERE owner_side='client' AND meetings_silent_count > 2
- `roadmap_items_discussed`: WHERE last_discussed_meeting_id = meetingId

#### 5. `inferMeetingType(topic, clientName, attendees)`
Simple heuristic:
- Topic contains "internal" or "huddle" or "leadership" or "team" → `internal`
- Client name is "B3X Internal" or "B3X Team Leadership Huddle" → `internal`
- Topic contains "kickoff" or "onboarding" or "intro" → `kickoff`
- Topic contains "VIP Session" → `vip-session`
- Otherwise → `regular`

#### 6. `computeAllMetrics(meetingId)` — Main entry point
Opens DB, runs all 5 functions, INSERTs or UPDATEs into `session_metrics`.

#### 7. `backfillAll()` — Process all meetings
```javascript
const meetings = db.prepare('SELECT id FROM meetings ORDER BY id').all();
for (const { id } of meetings) {
  computeAllMetrics(id);
}
```

### Create `src/session-metrics.js` (CLI)

```
Usage:
  node src/session-metrics.js --backfill          # Process all 99 meetings
  node src/session-metrics.js --meeting 42        # Process single meeting
  node src/session-metrics.js --stats             # Print aggregate stats
```

The `--stats` command should output:
```
=== Session Metrics Summary ===
Meetings processed: 99
Avg action items/meeting: X.X
Avg action density (items/min): X.XX
Avg due date rate: XX%
Avg owner assignment rate: XX%
Avg B3X speaking ratio: XX%
Meetings with stale B3X items: XX
Meeting types: regular=XX, internal=XX, kickoff=XX, vip-session=XX
```

### Create API endpoint

Add to `src/api/routes.js`:
```javascript
// GET /api/session/:meetingId/metrics
// Returns session_metrics row for a single meeting
app.get('/zoom/api/session/:meetingId/metrics', requireAuth, (req, res) => {
  const metrics = db.prepare('SELECT * FROM session_metrics WHERE meeting_id = ?').get(req.params.meetingId);
  if (!metrics) return res.status(404).json({ error: 'No metrics for this meeting' });
  res.json(metrics);
});

// GET /api/session/metrics/summary
// Returns aggregate stats across all meetings
```

## Expected Files Changed
- `src/lib/session-metrics.js` — **NEW** (~250-300 lines)
- `src/session-metrics.js` — **NEW** CLI (~80 lines)
- `src/api/routes.js` — **MODIFY** (add 2 endpoints, ~30 lines)
- `data/zoom-action-items.db` — **MODIFY** (new table + data)

## Do NOT Touch
- `src/lib/ai-extractor.js` — No changes to extraction
- `src/poll.js` — Pipeline integration is Phase 15C
- `public/index.html` — Dashboard changes are Phase 15E
- Any existing tables — read-only access

## Acceptance Criteria
- [ ] `session_metrics` table created with all columns
- [ ] `--backfill` processes all 99 meetings without errors
- [ ] Speaker parsing correctly identifies B3X vs client speakers
- [ ] Action density, due date rate, owner assignment rate all computed
- [ ] Stale item detection works for clients with roadmap data
- [ ] Meeting type inference correctly classifies "B3X Internal" meetings
- [ ] API endpoint returns metrics for a valid meeting ID
- [ ] `--stats` prints meaningful aggregate numbers

## Smoke Tests
```bash
cd ~/awsc-new/awesome/zoom-action-items

# Run backfill
node src/session-metrics.js --backfill

# Check all meetings have metrics
node -e "
const Database = require('better-sqlite3');
const db = new Database('data/zoom-action-items.db', { readonly: true });
const total = db.prepare('SELECT COUNT(*) as c FROM session_metrics').get();
const meetings = db.prepare('SELECT COUNT(*) as c FROM meetings').get();
console.log('metrics rows:', total.c, '/ meetings:', meetings.c);
console.assert(total.c === meetings.c, 'Not all meetings have metrics');

// Check speaker ratios sum to ~100
const bad = db.prepare('SELECT COUNT(*) as c FROM session_metrics WHERE speaker_ratio_b3x + speaker_ratio_client < 90 AND total_speakers > 1').get();
console.log('bad speaker ratios:', bad.c);

// Check action density is reasonable
const avgDensity = db.prepare('SELECT AVG(action_density) as avg FROM session_metrics WHERE duration_minutes > 0').get();
console.log('avg action density:', avgDensity.avg?.toFixed(3), 'items/min');
console.assert(avgDensity.avg > 0, 'Action density should be positive');

db.close();
console.log('All checks passed');
"

# Print stats
node src/session-metrics.js --stats

# Test API (if server running)
curl -s http://localhost:3875/zoom/api/session/1/metrics | node -e "process.stdin.on('data', d => { const j = JSON.parse(d); console.log('meeting_id:', j.meeting_id, 'action_density:', j.action_density, 'speaker_ratio_b3x:', j.speaker_ratio_b3x); })"
```

## Completion Instructions
1. Create the DB migration (CREATE TABLE)
2. Implement all metric functions in `src/lib/session-metrics.js`
3. Create CLI in `src/session-metrics.js`
4. Add API endpoints to `src/api/routes.js`
5. Run `--backfill` and verify all 99 meetings processed
6. Run smoke tests
7. Run `--stats` and include output in completion message
8. Commit with prefix: `[session-intel-15A]`
