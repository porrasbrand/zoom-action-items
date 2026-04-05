# Phase 15E: Dashboard UI — Session Intelligence Tab

## Prior Work Summary
Phase 15D added 6 API endpoints: scorecard, client trend, team stats, flags, benchmarks, weekly digest. All return JSON. The existing dashboard (`public/index.html`) has 3 tabs: Meetings, Roadmap, Meeting Prep. Built with vanilla JS, dark theme, tabbed navigation.

**This phase:** Add a 4th tab "Session Intelligence" with scorecard view, client trends, team performance, and flags panel.

## Objective
Add a comprehensive Session Intelligence tab to the existing dashboard, following the same vanilla JS + CSS patterns used in the Meetings/Roadmap/Meeting Prep tabs.

## Implementation

### Modify `public/index.html`

#### 1. Add Tab Button
Add after the existing "Meeting Prep" tab button:
```html
<button class="tab-btn" data-tab="session" onclick="switchTab('session')">Session Intelligence</button>
```

#### 2. Add Tab Content Container
```html
<div id="sessionView" class="tab-content" style="display:none;">
  <!-- Sub-navigation within Session Intelligence -->
  <div class="session-subnav">
    <button class="session-nav-btn active" onclick="switchSessionView('overview')">Overview</button>
    <button class="session-nav-btn" onclick="switchSessionView('scorecard')">Meeting Scorecard</button>
    <button class="session-nav-btn" onclick="switchSessionView('trends')">Client Trends</button>
    <button class="session-nav-btn" onclick="switchSessionView('team')">Team Performance</button>
    <button class="session-nav-btn" onclick="switchSessionView('flags')">Flags & Alerts</button>
  </div>
  
  <div id="sessionOverview"></div>
  <div id="sessionScorecard" style="display:none;"></div>
  <div id="sessionTrends" style="display:none;"></div>
  <div id="sessionTeam" style="display:none;"></div>
  <div id="sessionFlags" style="display:none;"></div>
</div>
```

#### 3. Sub-views

##### Overview Panel
Loads from `/api/session/benchmarks`:
- **Agency Score Card:** Large composite score (color-coded green/yellow/red), with P25/P50/P75 reference
- **Score Distribution:** Mini bar chart showing how many meetings scored 1-2/2-3/3-4 composite
- **Client Health Grid:** Cards for each client with name, meeting count, avg composite, trend arrow (↑/→/↓), color-coded border
- **Quick Flags:** Count badges for critical/warning flags with click to jump to Flags view
- **Win of the Week:** Highlighted card with meeting name, score, and highlight text

##### Meeting Scorecard View
- **Meeting selector:** Dropdown or search to pick a meeting (loads from `/api/session/:id/scorecard`)
- **Radar/Spider Chart:** 12 dimensions plotted on a radar chart (use simple SVG — no external charting library needed)
  - Alternative: 3 grouped horizontal bar charts (one per tier) if radar is too complex
- **Tier Breakdown:** 3 cards (Tier 1, 2, 3) each showing dimensions with 4-point visual (filled/empty circles)
- **Composite Score:** Large number with Green/Yellow/Red indicator based on baselines
- **Coaching Panel:**
  - Wins section: 2 cards with green accent, description + transcript quote
  - Improvements section: 2 cards with amber accent, description + quote + suggestion
  - Frustration moments: Red-accented cards with speaker, quote, and recovered? badge
  - Coaching notes: Text block with overall assessment
- **Metrics sidebar:** Key SQL metrics (action density, speaker ratio, due date rate, etc.)

##### Client Trends View
- **Client selector:** Dropdown to pick client
- **Trend Chart:** Line chart (SVG-based, simple) showing composite score over time
  - Overlay horizontal lines for P25 (red dashed), P50 (yellow dashed), P75 (green dashed)
  - Each point clickable → jumps to that meeting's scorecard
- **Dimension Breakdown:** Expandable section showing per-dimension trends
- **Stats:** Average composite, trend direction badge, meeting count, best/worst meetings
- **Client comparison table:** If no client selected, show all clients ranked by avg composite

##### Team Performance View
- **Member cards:** One card per B3X team member (Dan, Phil, Joe, etc.)
  - Meetings led count
  - Raw avg composite
  - Difficulty-adjusted avg composite
  - Bar showing raw vs adjusted (visualize the fairness adjustment)
  - Mini trend sparkline (last 10 meetings)
- **Comparison note:** Visible disclaimer: "Scores adjusted for client difficulty tier"
- **Click to drill:** Click member → see their meeting list with scores

##### Flags & Alerts View
- **Summary bar:** Critical (red badge with count), Warning (yellow badge with count)
- **Flag cards:** Sorted by severity then date
  - Meeting name, date, client, composite score
  - Reasons list (bulleted)
  - Click to jump to scorecard
- **Filter:** By severity (critical/warning/all), by client, by date range

#### 4. CSS Additions

Follow existing dark theme patterns. Key additions:
```css
/* Session Intelligence specific styles */
.session-subnav { /* horizontal pill buttons */ }
.score-card { /* large number with color background */ }
.score-badge { /* 4-point rubric visual: filled/empty dots */ }
.tier-card { /* grouped dimension display */ }
.coaching-card { /* win/improvement with colored accent border */ }
.trend-chart { /* SVG chart container */ }
.flag-card { /* severity-colored border */ }
.flag-card.critical { border-left: 4px solid #ef4444; }
.flag-card.warning { border-left: 4px solid #f59e0b; }
.sparkline { /* mini inline chart */ }
.health-grid { /* client cards grid */ }
```

#### 5. JavaScript

All session JS functions in a `// === SESSION INTELLIGENCE ===` section:

```javascript
// State
let sessionData = {};
let currentSessionView = 'overview';

// Navigation
function switchSessionView(view) { ... }

// Data loading
async function loadSessionOverview() { ... }
async function loadSessionScorecard(meetingId) { ... }
async function loadSessionTrends(clientId) { ... }
async function loadSessionTeam() { ... }
async function loadSessionFlags() { ... }

// Rendering
function renderOverview(data) { ... }
function renderScorecard(data) { ... }
function renderRadarChart(scores, container) { ... }  // or renderBarCharts
function renderTrendChart(trend, baselines, container) { ... }
function renderTeamCards(data) { ... }
function renderFlags(data) { ... }

// Utilities
function getScoreColor(score) { ... }  // 1=red, 2=orange, 3=yellow, 4=green
function getThresholdColor(score, baselines) { ... }  // green/yellow/red based on percentiles
function renderScoreDots(score) { ... }  // ●●●○ for score=3
```

**Chart rendering:** Use inline SVG. For trend charts:
```javascript
function renderTrendChart(dataPoints, baselines, container) {
  // Simple SVG line chart
  // X axis: meeting dates
  // Y axis: 1-4 scale
  // Line: composite scores connected
  // Horizontal dashed lines for P25/P50/P75
  // Dots at each data point, clickable
}
```

For radar chart (optional — bar chart is acceptable fallback):
```javascript
function renderRadarChart(scores, container) {
  // 12-point radar/spider chart using SVG polygon
  // Outer ring = score 4, inner = score 1
  // Filled polygon for actual scores
  // Light outline for P50 baseline
}
```

## Expected Files
- `public/index.html` — **MODIFY** (~800-1000 lines of CSS/HTML/JS added)

## Do NOT Touch
- `src/api/routes.js` — API endpoints are already done (Phase 15D)
- `src/lib/` — No backend changes
- `src/poll.js` — No pipeline changes

## Acceptance Criteria
- [ ] 4th tab "Session Intelligence" visible and clickable
- [ ] 5 sub-views all render without errors
- [ ] Overview loads agency benchmarks + client health grid
- [ ] Scorecard loads for any meeting with scores, coaching, metrics
- [ ] Trend chart renders with baseline overlays
- [ ] Team view shows difficulty-adjusted scores
- [ ] Flags panel shows critical/warning meetings
- [ ] Dark theme matches existing dashboard
- [ ] No console errors on any view
- [ ] Tab state preserved in URL hash (e.g., #session/scorecard/42)

## Smoke Tests
```bash
cd ~/awsc-new/awesome/zoom-action-items

# Restart dashboard
pm2 restart zoom-dashboard 2>/dev/null

# Quick content check
curl -s http://localhost:3875/zoom/ | grep -c "Session Intelligence"
# Should return 1+

# Check no JS syntax errors in the HTML
node -e "
const html = require('fs').readFileSync('public/index.html', 'utf8');
const scriptMatch = html.match(/<script[^>]*>([\s\S]*?)<\/script>/g);
console.log('Script blocks:', scriptMatch?.length || 0);
// Basic syntax check - try to parse any inline JS
"
```

## Completion Instructions
1. Add tab button and content container
2. Implement all 5 sub-views
3. Add CSS for session intelligence components
4. Add all JavaScript functions
5. Test each view loads data correctly
6. Commit with `[session-intel-15E]`
7. Report: which views work, any charts rendered, screenshot descriptions
