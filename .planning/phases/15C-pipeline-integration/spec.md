# Phase 15C: Scoring Pipeline Integration + Baselines

## Prior Work Summary
Phase 15A created `session_metrics` table (SQL metrics for all 99 meetings). Phase 15B created `session_evaluations` table (AI-scored 12-dimension evaluations for all 99 meetings using winning model from comparison). Phase 15B-validate confirmed rubric reliability.

**This phase:** Hooks session scoring into the live pipeline (poll.js) and computes per-client baselines (P25/P50/P75).

## Objective
1. Auto-score every new meeting as it's processed by the pipeline
2. Compute per-client and agency-wide scoring baselines
3. Add baseline comparison to each evaluation

## Implementation

### 1. Modify `src/poll.js` — Add Session Scoring Step

After the existing AI extraction and Slack posting, add a post-processing step:

```javascript
// In the meeting processing loop, after slack posting and before marking complete:
// Step N+1: Compute session metrics
try {
  const { computeAllMetrics } = await import('./lib/session-metrics.js');
  await computeAllMetrics(meetingId);
  console.log(`  Session metrics computed for meeting ${meetingId}`);
} catch (err) {
  console.error(`  Session metrics failed (non-blocking): ${err.message}`);
}

// Step N+2: Run AI session evaluation (async, non-blocking)
try {
  const { evaluateMeeting } = await import('./lib/session-evaluator.js');
  // Use the winning model from Phase 15B comparison
  const MODEL = process.env.SESSION_EVAL_MODEL || 'gemini-3-flash-preview'; // update with actual winner
  await evaluateMeeting(meetingId, { model: MODEL });
  console.log(`  Session evaluation computed for meeting ${meetingId}`);
} catch (err) {
  console.error(`  Session evaluation failed (non-blocking): ${err.message}`);
}
```

**IMPORTANT:** Both steps are non-blocking — if they fail, the core pipeline (extraction + Slack posting) still completes. Wrap each in try/catch.

### 2. Create `src/lib/session-baselines.js`

Computes percentile baselines for scoring thresholds.

```javascript
// Functions:
// computeClientBaselines(clientId) — P25/P50/P75 for a specific client
// computeAgencyBaselines() — P25/P50/P75 across all meetings
// computeTeamMemberBaselines(memberName) — P25/P50/P75 for a specific B3X team member
// getThreshold(score, baselines) — returns 'green'/'yellow'/'red' based on percentile position
// recalculateAll() — recompute all baselines (for cron or on-demand)
```

**Baseline table:**

```sql
CREATE TABLE IF NOT EXISTS session_baselines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scope TEXT NOT NULL,              -- 'agency', 'client:echelon', 'member:phil'
  dimension TEXT NOT NULL,          -- 'composite', 'client_sentiment', etc.
  p25 REAL,
  p50 REAL,
  p75 REAL,
  mean REAL,
  sample_size INTEGER,
  computed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(scope, dimension)
);
```

**Threshold logic:**
- Green: score ≥ P75
- Yellow: P25 ≤ score < P75
- Red: score < P25

Require minimum 3 meetings per scope to compute baselines. Below that, use agency-wide baselines as fallback.

### 3. CLI Extension

Add to `src/session-metrics.js`:
```
  node src/session-metrics.js --baselines              # Compute all baselines
  node src/session-metrics.js --baselines --client echelon  # Single client
```

### 4. Add Baseline API Endpoints

Add to `src/api/routes.js`:
```javascript
// GET /api/session/baselines
// Returns all baselines (agency + per-client + per-member)

// GET /api/session/baselines/:scope
// Returns baselines for a specific scope (e.g., 'agency', 'client:echelon')
```

### 5. Environment Variable

Add to `.env`:
```
SESSION_EVAL_MODEL=gemini-3-flash-preview  # or whatever won the comparison
```

## Expected Files
- `src/poll.js` — **MODIFY** (add ~20 lines for session scoring step)
- `src/lib/session-baselines.js` — **NEW** (~150-200 lines)
- `src/session-metrics.js` — **MODIFY** (add --baselines command)
- `src/api/routes.js` — **MODIFY** (add 2 endpoints)
- `.env` — **MODIFY** (add SESSION_EVAL_MODEL)
- `data/zoom-action-items.db` — **MODIFY** (new table)

## Do NOT Touch
- `src/lib/session-evaluator.js` — Evaluation prompt stays as-is
- `src/lib/session-metrics.js` — Core metrics stay as-is
- `public/index.html` — Dashboard is Phase 15E

## Smoke Tests
```bash
cd ~/awsc-new/awesome/zoom-action-items

# Compute baselines
node src/session-metrics.js --baselines

# Verify baselines exist
node -e "
const Database = require('better-sqlite3');
const db = new Database('data/zoom-action-items.db', { readonly: true });
const baselines = db.prepare('SELECT COUNT(*) as c FROM session_baselines').get();
console.log('baseline rows:', baselines.c);
const agency = db.prepare(\"SELECT * FROM session_baselines WHERE scope = 'agency' AND dimension = 'composite'\").get();
console.log('agency composite:', JSON.stringify(agency));
console.assert(agency.p25 > 0, 'P25 should be positive');
console.assert(agency.p75 > agency.p25, 'P75 > P25');
db.close();
"

# Test pipeline integration (dry run a re-evaluation of latest meeting)
node -e "
const Database = require('better-sqlite3');
const db = new Database('data/zoom-action-items.db');
const latest = db.prepare('SELECT id FROM meetings ORDER BY id DESC LIMIT 1').get();
console.log('Latest meeting:', latest.id);
db.close();
import('./src/lib/session-metrics.js').then(m => m.computeAllMetrics(latest.id)).then(() => console.log('Metrics OK'));
"

# Check API
curl -s http://localhost:3875/zoom/api/session/baselines | node -e "process.stdin.on('data', d => { const j = JSON.parse(d); console.log('baselines returned:', Object.keys(j).length || j.length); })"
```

## Completion Instructions
1. Modify poll.js to add session scoring
2. Create session-baselines.js with percentile computation
3. Add --baselines to CLI
4. Add API endpoints
5. Run baseline computation
6. Verify integration with a test meeting
7. Commit with `[session-intel-15C]`
8. Report: number of baselines computed, sample agency baselines (composite P25/P50/P75)
