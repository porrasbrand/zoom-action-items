# Phase 16A: Build AI-Powered Session Intelligence Audit Agent

## Objective
Create an AI-powered Playwright testing agent that simulates a real user browsing the Session Intelligence tab. The agent navigates all 5 sub-views, validates functionality, checks data correctness, takes screenshots, and uses Gemini vision to evaluate UX/UI quality. Also fix a known bug: missing aggregate team endpoint.

## Prior Work Summary
- **Session Intelligence tab** (Phases 15A-15G) is live at http://localhost:3875/zoom/#session
- **5 sub-views:** Overview, Meeting Scorecard, Client Trends, Team Performance, Flags & Alerts
- **Existing test:** `tests/dashboard-audit.js` (723 lines, Phase 11) — tests Meetings/Roadmap/Prep tabs. Uses raw Playwright API, SQLite auth bypass, structured report output.
- **Auth bypass pattern:** Create `test@playwright.local` user in `auth_users`, insert session in `auth_sessions`, inject `zoom_session` cookie.
- **Playwright 1.58** installed, browsers available. `@google/generative-ai` SDK in package.json.
- **Known bug:** `loadSessionTeam()` in index.html calls `fetch(API + '/session/team')` but routes.js only has `GET /session/team/:memberName/stats`. Team Performance sub-view errors.

## Deliverables

### 1. Fix Team Endpoint Bug

**File: `src/lib/session-queries.js`** — Add `getAllTeamStats()` export:
```javascript
export function getAllTeamStats(db) {
  const B3X_MEMBERS = ['Dan', 'Phil', 'Joe']; // same list used elsewhere
  const members = [];
  for (const name of B3X_MEMBERS) {
    try {
      const stats = getTeamStats(db, name);
      if (stats && stats.meetings_led > 0) {
        members.push({
          member_name: name,
          member_id: name.toLowerCase(),
          meeting_count: stats.meetings_led,
          raw_avg: stats.avg_composite,
          adjusted_avg: stats.client_difficulty_adjustment?.difficulty_adjusted_avg || stats.avg_composite,
          difficult_clients: stats.client_difficulty_adjustment?.difficult_clients || 0,
          trend_last_10: stats.trend_last_10 || []
        });
      }
    } catch (e) { /* skip member if error */ }
  }
  return { members, adjustment_note: 'Scores adjusted for client difficulty tier' };
}
```

NOTE: Check how B3X_MEMBERS is defined in the codebase — it may already exist in session-metrics.js or session-evaluator.js. Reuse the same list. Also check `getTeamStats` return shape to map fields correctly.

**File: `src/api/routes.js`** — Add aggregate route BEFORE the existing `:memberName` route:
```javascript
// GET /api/session/team - Aggregate team stats
router.get('/session/team', (req, res) => {
  try {
    const metricsDb = initMetricsDb();
    const data = getAllTeamStats(metricsDb);
    metricsDb.close();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/session/team/:memberName/stats - (existing, keep as-is)
```

Import `getAllTeamStats` from session-queries.js at the top of routes.js alongside existing session imports.

### 2. Create `tests/session-intelligence-audit.js`

Follow the EXACT same structure/patterns as `tests/dashboard-audit.js`. Single file, raw Playwright API, not @playwright/test.

**Constants:**
```
BASE_URL = 'http://localhost:3875/zoom'
API_BASE = 'http://localhost:3875/zoom/api'
SCREENSHOT_DIR = '../data/session-audit-screenshots'
REPORT_PATH = '../data/session-audit-report.md'
GEMINI_MODEL = 'gemini-2.0-flash'
```

**Auth:** Copy `createTestSession()` from dashboard-audit.js exactly.

**Result tracking:** Same `results` object with: `passed`, `failed`, `warnings`, `bugs`, `uxIssues`, `consoleErrors`, `networkErrors`, `screenshots`, `geminiEvaluations`.

---

## Test Checks — Layer 1: Functional Testing

### SI-A: Tab Navigation (4 checks)
| ID | Check | How |
|----|-------|-----|
| SI-A1 | Session Intelligence tab button exists | `page.locator('.tab-btn[data-tab="session"]')` count === 1 |
| SI-A2 | Clicking tab shows sessionView | Click tab, verify `#sessionView` is visible |
| SI-A3 | Sub-navigation renders 5 buttons | `page.locator('.session-nav-btn')` count === 5 |
| SI-A4 | Hash navigation works | Go to `BASE_URL + '#session'`, verify session tab is active |

### SI-B: Overview (7 checks)
| ID | Check | How |
|----|-------|-----|
| SI-B1 | Overview loads without error | `#sessionOverview` text does NOT contain "Error:" |
| SI-B2 | Agency score card renders | `.session-score-card` or `.score-value` exists inside `#sessionOverview` |
| SI-B3 | P25/P50/P75 baselines displayed | Text content contains "P25" and "P50" and "P75" |
| SI-B4 | Client health grid has cards | `#sessionOverview .health-card` count > 0 |
| SI-B5 | Flag count badges visible | `.flags-summary` inside `#sessionOverview` exists |
| SI-B6 | API /session/benchmarks returns 200 | Intercept network, check response status |
| SI-B7 | Click health card → navigates to trends | Click first `.health-card`, verify `#sessionTrends` becomes visible |

### SI-C: Meeting Scorecard (10 checks)
| ID | Check | How |
|----|-------|-----|
| SI-C1 | Meeting dropdown populated | Click "Meeting Scorecard" sub-nav, `#scorecardMeetingSelect option` count > 1 |
| SI-C2 | Selecting meeting loads scorecard | Select first option with a value, wait for content to not be "Loading..." |
| SI-C3 | Composite score displayed | Element with score value text exists, value is numeric 0-4 |
| SI-C4 | Tier breakdown renders 3 tier sections | `.tier-card` count === 3 |
| SI-C5 | Dimension scores in 1-4 range | Extract all dimension score values, verify each >= 1.0 and <= 4.0 |
| SI-C6 | Coaching section has wins | Text content includes "Win" or coaching-card.win exists |
| SI-C7 | Coaching section has improvements | Text includes "Improvement" or coaching-card.improvement exists |
| SI-C8 | Transcript quotes present | `.quote` elements or blockquote elements with content |
| SI-C9 | API /session/:id/scorecard returns 200 | Intercept |
| SI-C10 | Session metrics sidebar renders | Text includes "Action Items" or "Action Density" or "B3X Speaking" |

### SI-D: Client Trends (8 checks)
| ID | Check | How |
|----|-------|-----|
| SI-D1 | Client dropdown populated | Click "Client Trends" sub-nav, `#trendsClientSelect option` count > 1 |
| SI-D2 | Comparison table renders (no client selected) | Table or `.comparison` element exists in `#trendsContent` |
| SI-D3 | Selecting client loads trend data | Select first client, wait, verify content changes |
| SI-D4 | SVG trend chart renders | `#sessionTrends svg` count > 0 |
| SI-D5 | Baseline overlay lines present | SVG contains `line` elements (for P25/P50/P75 dashed lines) |
| SI-D6 | Data points clickable | SVG contains `circle` elements with onclick |
| SI-D7 | API /session/client/:id/trend returns 200 | Intercept |
| SI-D8 | Trend direction indicator visible | Text contains ↑ or ↓ or → (trend arrows) |

### SI-E: Team Performance (6 checks)
| ID | Check | How |
|----|-------|-----|
| SI-E1 | Team view loads without error | Click "Team Performance" sub-nav, `#sessionTeam` text does NOT contain "Error:" |
| SI-E2 | API /session/team returns 200 | Intercept (this verifies the bug fix) |
| SI-E3 | Team member cards render | `.team-card` count > 0 |
| SI-E4 | Raw and adjusted averages shown | Each team-card text contains "Raw" and "Adjusted" |
| SI-E5 | Difficulty adjustment note visible | Text contains "adjusted for client difficulty" or similar |
| SI-E6 | Bar charts render | `.avg-bar .fill` elements exist |

### SI-F: Flags & Alerts (7 checks)
| ID | Check | How |
|----|-------|-----|
| SI-F1 | Flags view loads | Click "Flags & Alerts" sub-nav, `#sessionFlags` text does NOT contain "Error:" |
| SI-F2 | Severity badges render | `.flag-badge` count >= 2 (critical + warning) |
| SI-F3 | Flag cards have severity classes | `.flag-card.critical` or `.flag-card.warning` exist |
| SI-F4 | Flag cards have reasons | `.flag-card .reasons` or `.flag-card ul` has content |
| SI-F5 | Click flag card → navigates to scorecard | Click first `.flag-card`, verify scorecard view opens |
| SI-F6 | API /session/flags returns 200 | Intercept |
| SI-F7 | Critical count matches API data | Compare DOM `.flag-badge.critical .count` text vs API response array length |

### SI-G: Console & Network (3 checks)
| ID | Check | How |
|----|-------|-----|
| SI-G1 | No JS console errors during Session tab | Collect via `page.on('console')`, filter type=error |
| SI-G2 | No failed network requests | Collect via `page.on('requestfailed')` |
| SI-G3 | All session API calls return 200 | Collect via `page.on('response')`, filter URLs containing `/session/` |

---

## Test Checks — Layer 2: Data Validation (8 checks)

Use direct `fetch()` via page.evaluate or Node fetch (the Playwright page is authenticated).

| ID | Check | How |
|----|-------|-----|
| SI-V1 | Benchmarks structure valid | `/session/benchmarks` → `agency` has `composite` object, `clients` is array |
| SI-V2 | Scorecard scores in range | `/session/:id/scorecard` → all `dimension_scores` values >= 1.0 and <= 4.0, `composite_score` >= 0 and <= 4.0 |
| SI-V3 | Client names not null/undefined | In benchmarks `clients`, no `client_name` is "null", "undefined", "", or missing |
| SI-V4 | Dates parseable | In trend data, all `date` or `meeting_date` fields produce valid `new Date()` |
| SI-V5 | Flag reasons non-empty | Every flag in `/session/flags` has `reasons` array with length > 0 |
| SI-V6 | Coaching fields valid | In scorecard, `coaching.wins` and `coaching.improvements` are arrays of objects |
| SI-V7 | Team members array valid | `/session/team` → `members` is array, each has `member_name` (string), `raw_avg` (number), `adjusted_avg` (number) |
| SI-V8 | Flag severities valid | Every flag has `severity` === "critical" or "warning" |

---

## Test Checks — Layer 3: AI UX/UI Evaluation (Gemini Vision)

### Screenshots to capture (8):
1. `session-overview.png` — Overview sub-view fully loaded
2. `session-scorecard.png` — Scorecard with a meeting selected
3. `session-scorecard-coaching.png` — Coaching section scrolled into view
4. `session-trends-chart.png` — Client Trends with SVG chart visible
5. `session-trends-comparison.png` — Client comparison table
6. `session-team.png` — Team Performance cards
7. `session-flags.png` — Flags & Alerts panel
8. `session-mobile.png` — Overview at 768px viewport width

### Gemini Evaluation Prompt:
```
You are a senior UX/UI auditor reviewing a dark-themed data dashboard.

This screenshot shows the "{VIEW_NAME}" view of a Session Intelligence dashboard for a digital agency. It displays meeting quality scores, coaching data, and team performance metrics.

Evaluate this view on the following 6 criteria. Score each 1-5 (1=Poor, 5=Excellent). Provide specific, actionable feedback for any score below 4.

**Criteria:**
1. **Readability** — Is text legible? Font sizes appropriate? Sufficient contrast between text and background? Are numbers and scores easy to scan?
2. **Color Contrast** — Does the color scheme meet WCAG AA standards? Are status colors (red/yellow/green) distinguishable? Are low-contrast elements present?
3. **Layout & Spacing** — Is the layout organized logically? Consistent spacing? No cramped or overly sparse areas? Grid alignment clean?
4. **Information Hierarchy** — Are the most important metrics visually prominent? Clear visual path from summary to detail? Labels clear?
5. **Dark Theme Quality** — Consistent background shades? No jarring bright elements? Borders and separators subtle but visible?
6. **Mobile Readiness** — Would this layout work on smaller screens? Touch targets large enough? Elements that should stack vertically doing so?

**Also identify:**
- Any visual bugs (overlapping elements, cut-off text, broken layouts)
- Missing visual affordances (things that should look clickable but don't)
- Data presentation issues (numbers without units, confusing labels, misleading visualizations)

Respond in this exact JSON format:
{
  "view": "{VIEW_NAME}",
  "overall_score": <1-5 average>,
  "criteria": {
    "readability": { "score": <1-5>, "feedback": "<string or null if score >= 4>" },
    "color_contrast": { "score": <1-5>, "feedback": "<string or null>" },
    "layout_spacing": { "score": <1-5>, "feedback": "<string or null>" },
    "information_hierarchy": { "score": <1-5>, "feedback": "<string or null>" },
    "dark_theme": { "score": <1-5>, "feedback": "<string or null>" },
    "mobile_readiness": { "score": <1-5>, "feedback": "<string or null>" }
  },
  "visual_bugs": ["<description>", ...],
  "missing_affordances": ["<description>", ...],
  "data_presentation_issues": ["<description>", ...],
  "top_improvement": "<single most impactful change to make>"
}
```

### Gemini call pattern:
```javascript
import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

const imageData = fs.readFileSync(screenshotPath);
const base64Image = imageData.toString('base64');

const result = await model.generateContent({
  contents: [{ role: 'user', parts: [
    { inlineData: { mimeType: 'image/png', data: base64Image } },
    { text: prompt }
  ]}],
  generationConfig: { temperature: 0.3, maxOutputTokens: 2048, responseMimeType: 'application/json' }
});
```

Add 3-second delay between Gemini calls to avoid rate limits. If any Gemini call fails, log warning and continue — UX eval is non-blocking.

---

## Layer 4: Report Format

Output: `data/session-audit-report.md`

```markdown
# Session Intelligence Audit Report
Date: {YYYY-MM-DD HH:MM}
Tests: {passed}/{total} passed | Warnings: {N}

## Summary
| Category | Pass | Fail | Warn |
|----------|------|------|------|
| Tab Navigation (SI-A) | X | X | X |
| Overview (SI-B) | X | X | X |
| Scorecard (SI-C) | X | X | X |
| Trends (SI-D) | X | X | X |
| Team (SI-E) | X | X | X |
| Flags (SI-F) | X | X | X |
| Console/Network (SI-G) | X | X | X |
| Data Validation (SI-V) | X | X | X |
| **Total** | **X** | **X** | **X** |

## Bugs Found
### BUG-1: {title}
- **Severity:** HIGH / MEDIUM / LOW
- **Check ID:** SI-XX
- **Screenshot:** session-audit-screenshots/{name}.png
- **Expected:** {description}
- **Actual:** {description}
- **Fix Suggestion:** {specific file and change}

## UX Evaluation (Gemini 2.0 Flash Vision)
### Overall UX Score: {avg}/5.0

| View | Score | Top Issue |
|------|-------|-----------|
| Overview | X.X | {or "None"} |
| ... | ... | ... |

### UX-1: {title} ({view})
- **Criterion:** {name}
- **Score:** {X}/5
- **Feedback:** {Gemini feedback}

## Visual Bugs (AI-Detected)
{bulleted list, deduplicated}

## Console Errors
{list or "None"}

## Network Issues
{list or "None"}

## Screenshots Captured
{list of .png files}

## Verdict
**{PASS / PASS WITH WARNINGS / FAIL}**
- Functional: {X}/{Y}
- Data Validation: {X}/{Y}
- UX Average: {X.X}/5.0
- Bugs: {N} ({breakdown by severity})
```

---

## Smoke Tests

```bash
# 1. Team endpoint fix
pm2 restart zoom-dashboard && sleep 2
curl -s http://localhost:3875/zoom/api/session/team | node -e "process.stdin.on('data', d => { const j = JSON.parse(d); console.log('members:', j.members?.length, 'note:', j.adjustment_note?.slice(0,30)); })"
# Expected: members: 2-5, note: Scores adjusted for client diff...

# 2. Existing team/:name still works
curl -s 'http://localhost:3875/zoom/api/session/team/Dan/stats' | node -e "process.stdin.on('data', d => { const j = JSON.parse(d); console.log('member:', j.member, 'meetings:', j.meetings_led); })"

# 3. Audit script runs
node tests/session-intelligence-audit.js
# Expected: exits with summary output

# 4. Report + screenshots generated
test -f data/session-audit-report.md && echo "Report OK"
ls data/session-audit-screenshots/*.png | wc -l
# Expected: 8+ screenshots

# 5. Gemini UX evaluation present
grep "UX Evaluation" data/session-audit-report.md && echo "UX eval present"
```

## Files to Create/Modify
- **CREATE:** `tests/session-intelligence-audit.js` (~700-900 lines)
- **MODIFY:** `src/api/routes.js` — add `GET /session/team` aggregate route (before line ~2039)
- **MODIFY:** `src/lib/session-queries.js` — add `getAllTeamStats()` export

## Important Notes
- Follow the EXACT patterns from `tests/dashboard-audit.js` — same auth, same logging, same report style
- The Gemini API key is in `.env` as `GOOGLE_API_KEY` (already used by session-evaluator.js)
- Route order matters: `/session/team` MUST come BEFORE `/session/team/:memberName/stats`
- All work is in `~/awsc-new/awesome/zoom-action-items/`
