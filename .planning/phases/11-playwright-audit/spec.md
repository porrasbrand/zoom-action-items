# Phase 11: Playwright AI Audit Agent — Test, Find Bugs, Improve

## Context

Phase 10 added Roadmap and Meeting Prep tabs to the dashboard at `https://www.manuelporras.com/zoom/` (served by Express on port 3875). The dashboard is a single-page HTML app with 3 tabs:
- **Meetings** (existing) — meeting list, detail, action items, ProofHub push
- **Roadmap** (new) — per-client card grid, filters, timeline, inline edit
- **Meeting Prep** (new) — generate/view 4-section briefing documents

This phase runs a **Playwright-based AI testing agent** that:
1. Navigates the real dashboard in a headless browser
2. Tests every interaction (tab switching, filters, API calls, rendering)
3. Screenshots bugs and visual issues
4. Produces a structured audit report with specific bugs and improvements
5. Implements the fixes directly

### Authentication

The dashboard requires a `zoom_session` cookie. To create one for Playwright:

```javascript
// Create a test session directly in SQLite
import Database from 'better-sqlite3';
import crypto from 'crypto';

const authDb = new Database('data/zoom-auth.db');
const sid = crypto.randomBytes(32).toString('hex');
const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

// Get or create a test user
let user = authDb.prepare("SELECT id FROM auth_users WHERE email = 'test@playwright.local'").get();
if (!user) {
  authDb.prepare("INSERT INTO auth_users (email, name, role) VALUES (?, ?, ?)").run('test@playwright.local', 'Playwright Bot', 'admin');
  user = authDb.prepare("SELECT id FROM auth_users WHERE email = 'test@playwright.local'").get();
}

authDb.prepare("INSERT INTO auth_sessions (sid, user_id, email, name, expires_at) VALUES (?, ?, ?, ?, ?)")
  .run(sid, user.id, 'test@playwright.local', 'Playwright Bot', expiresAt);

console.log('SESSION_ID=' + sid);
// Use this sid as the zoom_session cookie value
```

In Playwright:
```javascript
await context.addCookies([{
  name: 'zoom_session',
  value: sessionId,
  domain: 'localhost',
  path: '/zoom',
  httpOnly: true
}]);
```

### Available Test Data
- **prosper-group**: 10 roadmap items (all "agreed"), 2 meetings
- **gs-home-services**: 12 roadmap items ("agreed" + "in-progress"), 2 meetings
- API base: `http://localhost:3875/zoom/api/`

---

## Objective

Build and run a comprehensive Playwright test suite that:

1. **Functional Testing** — Verify every feature works end-to-end
2. **Bug Detection** — Find rendering issues, broken interactions, JS errors
3. **Visual Audit** — Screenshot each view, check layout/spacing/contrast
4. **UX Improvements** — Identify friction points, missing affordances, confusing flows
5. **Fix Implementation** — Apply fixes directly to `public/index.html`

---

## Implementation Steps

### 1. Install Playwright on Hetzner

```bash
cd ~/awsc-new/awesome/zoom-action-items
npm install --save-dev playwright @playwright/test
npx playwright install chromium  # Only chromium, not all browsers
```

### 2. Create Test Session Script (`scripts/create-test-session.js`)

Creates an auth session and outputs the cookie value for Playwright to use. See the auth code above.

### 3. Create Audit Script (`tests/dashboard-audit.js`)

This is the main audit agent. It should be a **single script** (not a test framework suite) that:

```javascript
// Usage: node tests/dashboard-audit.js
//
// Output:
//   - data/audit-report.md (structured findings)
//   - data/audit-screenshots/ (PNGs for each view and bug)
//   - Console output with pass/fail for each check

import { chromium } from 'playwright';
```

### 4. Test Matrix

The audit script should run these checks:

**A. Tab Navigation (5 checks)**

| ID | Check | How |
|----|-------|-----|
| A1 | All 3 tabs visible | `page.locator('.tab-btn')` count === 3 |
| A2 | Meetings tab active by default | `.tab-btn.active` text === 'Meetings' |
| A3 | Click Roadmap tab switches view | Click, verify `#roadmapView` visible, `#meetingsView` hidden |
| A4 | Click Meeting Prep tab switches | Click, verify `#prepView` visible |
| A5 | URL hash updates | After tab click, check `page.url()` contains `#roadmap` or `#prep` |
| A6 | Hash navigation on load | Navigate to `/zoom/#roadmap`, verify roadmap tab active |
| A7 | Stats bar hides on non-meetings tabs | Verify `#statsBar` display:none on Roadmap tab |

**B. Roadmap Tab (12 checks)**

| ID | Check | How |
|----|-------|-----|
| B1 | Client dropdown populated | `#roadmapClientSelect option` count > 1 |
| B2 | Selecting client loads cards | Select 'prosper-group', wait for `.roadmap-card` elements |
| B3 | Card count matches API | Compare DOM card count vs `/api/roadmap/prosper-group` items count |
| B4 | Cards have category badges | Every `.roadmap-card` has `.category-badge` |
| B5 | Cards have status badges | Every `.roadmap-card` has `.status-badge` |
| B6 | Status filter works | Click 'Active' pill, verify filtered cards shown |
| B7 | Owner filter works | Click 'B3X' pill, verify only b3x items |
| B8 | Category filter works | Click a category pill, verify filtered |
| B9 | Search filters by title | Type in search box, verify filtered results |
| B10 | Status dropdown opens | Click 'Status' button on a card, verify dropdown visible |
| B11 | Edit overlay opens | Click 'Edit' button, verify overlay visible with inputs |
| B12 | Timeline toggle works | Click 'Timeline' button, verify `.timeline-container` visible, grid hidden |
| B13 | Stats bar shows counts | Verify roadmap stats bar has numbers > 0 |
| B14 | Stale cards have indicator | If any stale items, verify `.stale` class and warning text |
| B15 | Client switch resets filters | Switch client, verify all pills back to 'All' |

**C. Meeting Prep Tab (10 checks)**

| ID | Check | How |
|----|-------|-----|
| C1 | Client dropdown synced | Select client on Roadmap, switch to Prep, verify same client selected |
| C2 | Generate button enabled after client select | Verify button not disabled |
| C3 | Generate shows spinner | Click generate, verify spinner appears |
| C4 | Prep document renders | After generation, verify `.prep-document` exists |
| C5 | All 4 sections present | Check for 4 `.prep-section` elements |
| C6 | Section headers correct | Text includes STATUS REPORT, ACCOUNTABILITY, STRATEGIC, AGENDA |
| C7 | Sections collapsible | Click h3, verify body hidden |
| C8 | Agenda has time values | `.agenda-time` elements exist with numeric content |
| C9 | Post to Slack button exists | `#postSlackBtn` visible and not disabled (when client selected) |
| C10 | Prep history loads | After generation, history list has at least 1 item |
| C11 | Fallback warning shown when applicable | If meta.fallback, verify `.prep-fallback-warning` visible |

**D. Meetings Tab Regression (5 checks)**

| ID | Check | How |
|----|-------|-----|
| D1 | Meeting list loads | `.meeting-card` elements exist |
| D2 | Clicking meeting shows detail | Click first card, verify `.meeting-detail` appears |
| D3 | Action items render | `.action-item` elements exist in detail |
| D4 | Stats bar shows on meetings tab | `#statsBar` display is flex |
| D5 | Week pills work | Click a week pill, verify it becomes active |

**E. Console Errors & Network (3 checks)**

| ID | Check | How |
|----|-------|-----|
| E1 | No JS console errors | Listen to `page.on('console')`, collect errors |
| E2 | No failed network requests | Listen to `page.on('requestfailed')` |
| E3 | All API calls return 200 | Listen to `page.on('response')` for /api/ calls |

**F. Visual Audit (screenshots + inspection)**

| ID | Check | How |
|----|-------|-----|
| F1 | Meetings tab screenshot | Full page screenshot |
| F2 | Roadmap cards screenshot | Screenshot with client loaded |
| F3 | Roadmap timeline screenshot | Switch to timeline view, screenshot |
| F4 | Meeting prep document screenshot | Generate prep, screenshot |
| F5 | Mobile viewport check | Resize to 768px, screenshot, check for overflow |
| F6 | Element overlap detection | Check for z-index issues, overlapping elements |

### 5. Audit Report Format

Output to `data/audit-report.md`:

```markdown
# Dashboard Audit Report
Date: {date}
Tests: {passed}/{total} passed

## Summary
- PASS: {count}
- FAIL: {count}
- WARN: {count}

## Bugs Found

### BUG-1: {description}
- **Severity:** HIGH / MEDIUM / LOW
- **Check:** {check_id}
- **Screenshot:** audit-screenshots/{filename}.png
- **Expected:** {what should happen}
- **Actual:** {what happens}
- **Fix:** {specific code change needed in public/index.html}

### BUG-2: ...

## Improvement Opportunities

### IMP-1: {description}
- **Type:** UX / Performance / Accessibility / Visual
- **Impact:** HIGH / MEDIUM / LOW
- **Current:** {what it does now}
- **Proposed:** {what it should do}
- **Implementation:** {specific code change}

## Console Errors
{list of any JS errors captured}

## Network Issues
{list of any failed requests}

## Screenshots
- meetings-tab.png
- roadmap-cards.png
- roadmap-timeline.png
- meeting-prep.png
- mobile-viewport.png
```

### 6. Implement Fixes

After the audit completes, the script should:

1. Read the audit report
2. For each BUG with severity HIGH or MEDIUM, implement the fix in `public/index.html`
3. Re-run the failing checks to verify fixes work
4. Update the audit report with fix status

**IMPORTANT:** Only fix bugs found by the audit. Do NOT make speculative improvements or refactor working code. Each fix should be minimal and targeted.

### 7. Improvement Implementation

For improvement opportunities rated HIGH impact:
1. Implement the proposed change
2. Take before/after screenshots
3. Re-run relevant checks

---

## Files to Create

1. `scripts/create-test-session.js` — Auth session creator for Playwright
2. `tests/dashboard-audit.js` — Main audit script (~400-600 lines)
3. `data/audit-report.md` — Generated output
4. `data/audit-screenshots/` — Generated screenshots

## Files to Modify

1. `public/index.html` — Apply bug fixes found by audit
2. `package.json` — Add playwright dev dependency

## Do NOT Touch

- `src/api/` — No backend changes
- `src/lib/` — No library changes
- `src/config/` — No config changes
- `ecosystem.config.cjs` — No PM2 changes

## Acceptance Criteria

- [ ] Playwright installed and chromium browser available
- [ ] Test session created successfully (auth bypass)
- [ ] All 3 tabs load without JS errors
- [ ] All A-checks (tab navigation) pass
- [ ] All B-checks (roadmap) pass — cards render, filters work, timeline works
- [ ] All C-checks (meeting prep) pass — generate, render, collapse, history
- [ ] All D-checks (meetings regression) pass — no regressions
- [ ] No console errors (E1)
- [ ] Screenshots captured for all views
- [ ] Audit report saved to `data/audit-report.md`
- [ ] HIGH/MEDIUM bugs fixed and verified
- [ ] HIGH impact improvements implemented

## Smoke Tests

```bash
cd ~/awsc-new/awesome/zoom-action-items

# 1. Playwright installed
npx playwright --version
# Expected: 1.x.x

# 2. Test session works
node scripts/create-test-session.js
# Expected: SESSION_ID=<hex string>

# 3. Audit script runs
node tests/dashboard-audit.js
# Expected: exits 0, prints pass/fail summary

# 4. Report generated
test -f data/audit-report.md && echo "Report exists"
# Expected: Report exists

# 5. Screenshots captured
ls data/audit-screenshots/*.png | wc -l
# Expected: >= 5

# 6. Check for remaining bugs
grep "FAIL" data/audit-report.md | wc -l
# Expected: 0 (all bugs fixed)

# 7. Dashboard still works after fixes
curl -s http://localhost:3875/zoom/api/stats | python3 -c "import sys,json; d=json.load(sys.stdin); print('ok:', d.get('meetings_total',0) > 0)"
# Expected: ok: True
```

## Completion Instructions

1. Install Playwright + chromium
2. Create test session script
3. Build and run audit script
4. Review audit report
5. Fix all HIGH/MEDIUM bugs found
6. Implement HIGH impact improvements
7. Re-run audit to verify fixes
8. Commit with prefix: `[zoom-pipeline-11]`
9. Include audit report summary in commit message
