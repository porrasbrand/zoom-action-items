# Phase 15D: Session Intelligence API

## Prior Work Summary
Phase 15A: `session_metrics` table (SQL metrics, 99 meetings). Phase 15B: `session_evaluations` table (AI scores, 12 dimensions, 99 meetings). Phase 15C: `session_baselines` table (P25/P50/P75 per client/agency/member), pipeline integration in poll.js, basic metrics/baselines API endpoints.

**This phase:** Full Session Intelligence API — scorecards, trends, team stats, flags, weekly digest.

## Objective
Build 6 comprehensive API endpoints that power the Session Intelligence dashboard (Phase 15E) and coaching digest (Phase 15G).

## Implementation

### New file: `src/lib/session-queries.js`

All session intelligence queries in one module. Used by routes.js.

#### 1. `getScorecard(meetingId)`
Returns complete scorecard for one meeting:
```javascript
{
  meeting: { id, topic, client_name, start_time, duration_minutes },
  metrics: { /* from session_metrics */ },
  evaluation: { /* from session_evaluations */ },
  scores: {
    tier1: { client_sentiment, accountability, relationship_health, avg },
    tier2: { meeting_structure, value_delivery, action_discipline, proactive_leadership, avg },
    tier3: { time_utilization, redundancy, client_confusion, meeting_momentum, save_rate, avg },
    composite
  },
  thresholds: { /* green/yellow/red per dimension based on baselines */ },
  coaching: {
    wins: [ /* parsed from evaluation */ ],
    improvements: [ /* parsed from evaluation */ ],
    frustration_moments: [ /* parsed */ ],
    coaching_notes: "string"
  },
  meeting_type: "regular"
}
```

#### 2. `getClientTrend(clientId, options)`
Returns score trend over time for a client:
```javascript
// options: { limit: 20, dimension: 'composite' }
{
  client_id: "echelon",
  client_name: "Echelon",
  meeting_count: 12,
  trend: [
    { meeting_id: 45, date: "2026-03-15", composite: 2.8, client_sentiment: 3, ... },
    { meeting_id: 52, date: "2026-03-22", composite: 3.1, client_sentiment: 3, ... },
    ...
  ],
  baselines: { p25: 2.4, p50: 2.8, p75: 3.2 },
  trend_direction: "improving" | "declining" | "stable",
  // trend_direction based on last 3 meetings vs previous 3
  avg_composite: 2.95
}
```

#### 3. `getTeamStats(memberName)`
Returns aggregate stats for a B3X team member:
```javascript
{
  member: "Phil",
  meetings_led: 45,
  avg_composite: 2.9,
  avg_by_dimension: { client_sentiment: 3.1, accountability: 2.5, ... },
  best_meeting: { id, topic, composite, date },
  worst_meeting: { id, topic, composite, date },
  client_difficulty_adjustment: {
    // Compare member's scores against agency baseline for the SAME clients
    raw_avg: 2.9,
    difficulty_adjusted_avg: 3.1,  // some clients are harder
    note: "Phil handles 3 high-difficulty clients which reduces raw average"
  },
  trend_last_10: [ { meeting_id, date, composite }, ... ]
}
```

**Client difficulty tier** (simple heuristic):
- Count of services_active + meeting_cadence frequency + historical score variance
- High difficulty: many services + weekly cadence + high score variance
- Low difficulty: few services + biweekly + stable scores

#### 4. `getFlags(options)`
Returns flagged meetings requiring attention:
```javascript
// options: { limit: 20, severity: 'all' }
{
  flags: [
    {
      meeting_id: 67,
      topic: "Echelon Weekly",
      client_name: "Echelon",
      date: "2026-03-28",
      composite: 1.8,
      severity: "critical",  // composite < P25 
      reasons: [
        "Client sentiment scored 1 (frustration detected)",
        "3 B3X-owned stale items ignored",
        "No agenda or recap of prior items"
      ],
      frustration_moments: [ ... ]
    },
    ...
  ],
  summary: {
    critical: 3,   // below P25
    warning: 8,    // below P50
    total_meetings: 99
  }
}
```

**Flag rules:**
- `critical`: composite < P25 OR client_sentiment = 1 OR frustration_moments.length > 2
- `warning`: composite < P50 OR any Tier 1 dimension = 1 OR 2+ declining meetings in a row

#### 5. `getBenchmarks()`
Returns agency-wide benchmarks:
```javascript
{
  agency: {
    meetings_scored: 99,
    avg_composite: 2.85,
    dimensions: {
      client_sentiment: { mean: 3.1, p25: 2.5, p50: 3.0, p75: 3.5 },
      ...
    }
  },
  by_client: [
    { client_id: "echelon", client_name: "Echelon", meetings: 12, avg_composite: 2.9, trend: "stable" },
    ...
  ],
  by_member: [
    { member: "Phil", meetings: 45, avg_composite: 2.9, difficulty_adjusted: 3.1 },
    { member: "Dan", meetings: 30, avg_composite: 3.2, difficulty_adjusted: 3.1 },
    ...
  ],
  top_meetings: [ /* top 5 by composite */ ],
  bottom_meetings: [ /* bottom 5 by composite */ ]
}
```

#### 6. `getWeeklyDigest(weekStart)`
Returns weekly digest data:
```javascript
// weekStart: ISO date string for Monday of the week (or null for current week)
{
  week: "2026-03-24",
  meetings_scored: 8,
  avg_composite: 2.9,
  
  flagged_meetings: [ /* meetings below P50 with reasons */ ],
  
  pattern_alerts: [
    { type: "declining_client", client: "Echelon", detail: "Composite dropped 3 meetings in a row (3.1 → 2.8 → 2.3)" },
    { type: "stale_accountability", client: "1st Choice", detail: "5 B3X-owned items silent for 3+ meetings" },
  ],
  
  win_of_the_week: {
    meeting_id: 72,
    topic: "Prosper Group Weekly",
    composite: 3.8,
    highlight: "Strong value delivery — Phil presented ROI data and proposed 2 new initiatives"
  },
  
  team_snapshot: [
    { member: "Phil", meetings: 5, avg: 3.0 },
    { member: "Dan", meetings: 3, avg: 3.2 },
  ]
}
```

### API Endpoints (add to `src/api/routes.js`)

```javascript
// Session Intelligence endpoints
app.get('/zoom/api/session/:meetingId/scorecard', requireAuth, ...);
app.get('/zoom/api/session/client/:clientId/trend', requireAuth, ...);
app.get('/zoom/api/session/team/:memberName/stats', requireAuth, ...);
app.get('/zoom/api/session/flags', requireAuth, ...);
app.get('/zoom/api/session/benchmarks', requireAuth, ...);
app.get('/zoom/api/session/digest/weekly', requireAuth, ...);  // ?week=2026-03-24
```

## Expected Files
- `src/lib/session-queries.js` — **NEW** (~400-500 lines)
- `src/api/routes.js` — **MODIFY** (add 6 endpoints, ~60 lines)

## Do NOT Touch
- `src/lib/session-evaluator.js` — No changes
- `src/lib/session-metrics.js` — No changes
- `src/poll.js` — No changes
- `public/index.html` — Dashboard is Phase 15E

## Smoke Tests
```bash
cd ~/awsc-new/awesome/zoom-action-items

# Restart API server to pick up new routes
pm2 restart zoom-dashboard 2>/dev/null || node src/api/server.js &

# Test each endpoint
echo "=== Scorecard ==="
curl -s http://localhost:3875/zoom/api/session/50/scorecard | node -e "process.stdin.on('data', d => { const j = JSON.parse(d); console.log('composite:', j.scores?.composite, 'wins:', j.coaching?.wins?.length); })"

echo "=== Client Trend ==="
curl -s http://localhost:3875/zoom/api/session/client/echelon/trend | node -e "process.stdin.on('data', d => { const j = JSON.parse(d); console.log('meetings:', j.meeting_count, 'direction:', j.trend_direction); })"

echo "=== Team Stats ==="
curl -s 'http://localhost:3875/zoom/api/session/team/Phil/stats' | node -e "process.stdin.on('data', d => { const j = JSON.parse(d); console.log('meetings:', j.meetings_led, 'avg:', j.avg_composite); })"

echo "=== Flags ==="
curl -s http://localhost:3875/zoom/api/session/flags | node -e "process.stdin.on('data', d => { const j = JSON.parse(d); console.log('critical:', j.summary?.critical, 'warning:', j.summary?.warning); })"

echo "=== Benchmarks ==="
curl -s http://localhost:3875/zoom/api/session/benchmarks | node -e "process.stdin.on('data', d => { const j = JSON.parse(d); console.log('agency avg:', j.agency?.avg_composite, 'clients:', j.by_client?.length); })"

echo "=== Weekly Digest ==="
curl -s 'http://localhost:3875/zoom/api/session/digest/weekly' | node -e "process.stdin.on('data', d => { const j = JSON.parse(d); console.log('meetings:', j.meetings_scored, 'flags:', j.flagged_meetings?.length, 'win:', j.win_of_the_week?.composite); })"
```

## Completion Instructions
1. Create session-queries.js with all 6 query functions
2. Add 6 API endpoints to routes.js
3. Restart API server
4. Run all smoke tests
5. Commit with `[session-intel-15D]`
6. Report: sample scorecard, flags summary, benchmark highlights
