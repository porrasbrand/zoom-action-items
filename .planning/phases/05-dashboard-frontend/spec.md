# Phase 05: Dashboard Frontend

## Context
Phase 04 (commit 03bc321) deployed the Dashboard API at `manuelporras.com/zoom/`. The API serves 7 meetings, 21 action items from SQLite. All endpoints work and are accessible externally.

Available API endpoints (base: `/zoom/api/`):
- `GET /meetings` — List with filters (client_id, status, from, to, limit, offset, sort)
- `GET /meetings/:id` — Full detail with action_items[] and decisions[]
- `GET /meetings/:id/transcript` — Raw transcript
- `PUT /meetings/:id` — Update meeting
- `GET /action-items` — List with filters (client_id, status, owner_name, meeting_id)
- `PUT /action-items/:id` — Update item
- `POST /action-items/:id/complete` — Mark complete
- `POST /action-items/:id/reject` — Mark rejected (AI hallucination)
- `POST /action-items/:id/reopen` — Reopen
- `GET /decisions` — List decisions
- `GET /clients` — Client list with meeting counts
- `GET /stats` — Overview statistics
- `GET /health` — Pipeline health

Current data: 7 meetings, 21 action items (20 open, 1 completed), 1 matched client (Bearcat), 6 unmatched.

The existing Slack mentions dashboard (`public/slack/index.html` in b3x-client-state) is a good reference for the dark theme, card layout, and interaction patterns. That file is ~3000 lines of single-page HTML with inline JS/CSS.

## Objective
Build a single-page dashboard for reviewing Zoom meeting notes and managing action items. This is the primary interface for the team to review AI-extracted content, approve/reject action items, and track follow-ups across meetings.

## Implementation Steps

1. **Replace `public/index.html`** with a full dashboard. Single HTML file with inline CSS and JS (matching the pattern of the Slack mentions dashboard).

2. **Layout — Three sections:**

   a. **Top Bar:**
   - Title: "Zoom Meeting Notes"
   - Stats row: Total Meetings | This Week | Action Items Open | Completed | Avg per Meeting
   - Auto-refresh toggle (poll every 60 seconds)

   b. **Left Panel (30% width) — Meeting List:**
   - Scrollable list of meetings, newest first
   - Each meeting card shows: date, topic, client name (or "Unmatched"), duration, action item count
   - Color-coded: matched client = blue accent, unmatched = orange accent
   - Filters at top: client dropdown, date range, status
   - Search by topic text
   - Clicking a meeting loads its detail in the right panel
   - Active/selected meeting highlighted

   c. **Right Panel (70% width) — Meeting Detail:**
   - Header: topic, client, date, duration, speakers list
   - **Summary section:** AI-generated summary (formatted text)
   - **Action Items section:** Table/cards with:
     - Title, owner, priority (color-coded), due date, status
     - Actions per item: Complete (green check), Reject (red X), Edit (pencil)
     - Inline editing for title, owner, due date
     - Status badges: Open (blue), Complete (green), Rejected (red/strikethrough)
   - **Decisions section:** List of decisions with context
   - **Transcript section:** Collapsible, speaker-labeled transcript
     - Show speakers with alternating background
     - Search within transcript

3. **Interaction patterns:**
   - Click meeting → loads detail (no page reload)
   - Complete action item → instant UI update + API call
   - Reject action item → confirm dialog ("Mark as AI hallucination?") → strikethrough + API call
   - Edit action item → inline edit fields → save button → API call
   - Filter changes → re-fetch meeting list
   - Toast notifications for actions (like Slack mentions dashboard)

4. **Styling (dark theme):**
   - Background: #0d1117 (or similar dark)
   - Cards: #161b22 with subtle border
   - Text: #c9d1d9
   - Accents: #4c9aff (blue), #51cf66 (green), #ff6b6b (red), #ffd43b (yellow)
   - Priority colors: urgent=red, high=orange, medium=yellow, low=grey
   - Font: system-ui, monospace for code/transcript
   - Responsive: works on desktop (primary) and tablet

5. **Empty states:**
   - No meetings: "No meetings found. Pipeline is polling every 5 minutes."
   - No action items: "No action items extracted from this meeting."
   - Unmatched client: Show orange "Unmatched" badge with option to assign client

6. **Client assignment for unmatched meetings:**
   - Dropdown to assign a client to an unmatched meeting
   - Calls `PUT /meetings/:id` with client_id
   - Updates the meeting card in the list

7. **JavaScript structure:**
   - `API` base path derived from window.location
   - `loadMeetings()` — fetch and render meeting list
   - `loadMeetingDetail(id)` — fetch and render right panel
   - `loadStats()` — fetch and render top bar stats
   - `completeItem(id)` / `rejectItem(id)` / `reopenItem(id)` — action item management
   - `updateItem(id, fields)` — inline edit save
   - `assignClient(meetingId, clientId)` — client assignment
   - `showToast(message, isError)` — notifications
   - `escapeHtml(text)` — XSS prevention

## Files to Create
- None (replacing existing placeholder)

## Files to Modify
- `public/index.html` — Complete rewrite with full dashboard

## Do NOT Touch
- `src/api/` — API is complete, no changes
- `src/lib/` — Pipeline libraries, no changes
- `src/poll.js` / `src/service.js` — No changes
- `ecosystem.config.cjs` — No changes

## Acceptance Criteria
- [ ] Dashboard loads at https://www.manuelporras.com/zoom/
- [ ] Meeting list shows all 7 meetings with client names and dates
- [ ] Clicking a meeting shows its full detail (summary, action items, decisions)
- [ ] Action items can be marked as Complete (green badge)
- [ ] Action items can be marked as Rejected (red/strikethrough)
- [ ] Action items can be edited inline (title, owner, due date)
- [ ] Stats bar shows correct counts
- [ ] Client filter works
- [ ] Unmatched meetings show orange "Unmatched" badge
- [ ] Transcript section is collapsible and shows speaker labels
- [ ] Toast notifications appear on actions
- [ ] Dark theme consistent with existing dashboards
- [ ] No JavaScript errors in browser console

## Smoke Tests
Run these AFTER implementation to verify:

```bash
# Test 1: Dashboard HTML loads and has key elements
curl -s http://localhost:3875/zoom/ | grep -c 'Zoom Meeting Notes'
→ expect: at least 1

# Test 2: Has meeting list container
curl -s http://localhost:3875/zoom/ | grep -c 'meeting-list\|loadMeetings'
→ expect: at least 2

# Test 3: Has action item management functions
curl -s http://localhost:3875/zoom/ | grep -c 'completeItem\|rejectItem'
→ expect: at least 2

# Test 4: Has stats section
curl -s http://localhost:3875/zoom/ | grep -c 'loadStats\|stats'
→ expect: at least 2

# Test 5: Has transcript section
curl -s http://localhost:3875/zoom/ | grep -c 'transcript'
→ expect: at least 2

# Test 6: Has toast notification
curl -s http://localhost:3875/zoom/ | grep -c 'showToast'
→ expect: at least 1

# Test 7: API still works (dashboard didn't break it)
curl -s http://localhost:3875/zoom/api/stats | python3 -c "import sys,json; d=json.load(sys.stdin); print('meetings:', d.get('meetings_total','?'))"
→ expect: meetings: 7

# Test 8: External access
curl -s https://www.manuelporras.com/zoom/ | grep -c 'Zoom Meeting Notes'
→ expect: at least 1
```

## Completion Instructions
1. Run all smoke tests and confirm they pass
2. Write result to: `.planning/phases/05-dashboard-frontend/result.md`
3. Commit all changes with prefix: `[zoom-pipeline-05]`
