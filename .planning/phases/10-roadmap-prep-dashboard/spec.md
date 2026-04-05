# Phase 10: Roadmap & Meeting Prep Dashboard — Technical Implementation Spec

## Review Fixes Applied

This spec incorporates fixes from code review (2026-03-31):
1. **Attribute escaping bug** — Added `escapeAttr()` function for HTML attribute contexts (quotes in titles)
2. **Timeline title collision** — Use item `id` instead of `title` for timeline row matching
3. **loadSavedPrep .md handling** — Detect JSON vs Markdown response by filename extension
4. **Filter pills reset on client change** — Reset all filters to 'all' when switching clients
5. **Section collapse** — Click handler on `h3` only (not entire section div)
6. **Accessibility** — `role="tab"`, `aria-selected`, `aria-expanded`, `<button>` for pills
7. **AbortController** — Cancel in-flight prep generation on tab switch or new generation
8. **Category pill labels** — Show human-readable names from taxonomy, not raw IDs
9. **Search by title** — Added search input in roadmap controls

---

## Context & Current State

### The File You're Modifying
`public/index.html` — a **4,077-line** single-page HTML file with inline CSS and JS. It follows this structure:

```
Lines 1-1930:    <style> block (all CSS)
Lines 1930-2040: <body> HTML structure
Lines 2040-4077: <script> block (all JS)
```

### Existing DOM Structure (simplified)
```html
<div class="app">
  <div class="header">
    <div class="header-top">
      <h1>Zoom Meeting Notes</h1>
      <div class="header-right">
        <div class="user-info">...</div>
        <label class="auto-refresh">...</label>
      </div>
    </div>
    <div class="stats-bar" id="statsBar">
      <!-- 5 stat cards: Total Meetings, This Week, Action Items Open, Completed, Avg per Meeting -->
      <div class="validation-stats-toggle">...</div>
    </div>
  </div>

  <div class="validation-stats-section" id="validationStatsSection">...</div>

  <div class="main">                        <!-- THIS IS THE MEETINGS VIEW -->
    <div class="left-panel">
      <div class="filter-pills-container">
        <div class="week-pills" id="weekPills"></div>
        <div class="client-pills" id="clientPills"></div>
        <div class="signal-pills" id="signalPills"></div>
        <div class="filter-search-row">...</div>
      </div>
      <div class="meeting-list" id="meetingList"></div>
    </div>
    <div class="right-panel" id="rightPanel">
      <div class="no-selection">Select a meeting...</div>
    </div>
  </div>
</div>
<div class="toast-container" id="toastContainer"></div>
```

### Existing CSS Design Tokens
```css
/* Backgrounds */
--bg-body:    #0d1117;
--bg-header:  #161b22;
--bg-card:    #21262d;
--bg-hover:   #30363d;
--border:     #30363d;

/* Text */
--text-primary:   #f0f6fc;
--text-secondary: #c9d1d9;
--text-muted:     #8b949e;

/* Accents */
--blue:    #58a6ff;
--green:   #3fb950;
--yellow:  #d29922;
--red:     #f85149;
--orange:  #d29922;
--purple:  #bc8cff;

/* Stat card pattern */
.stat { background: #21262d; padding: 12px 20px; border-radius: 8px; text-align: center; min-width: 120px; }
.stat-value { font-size: 24px; font-weight: 600; color: #58a6ff; }
.stat-label { font-size: 11px; color: #8b949e; text-transform: uppercase; margin-top: 4px; }

/* Section card pattern (used in meeting detail) */
.section { background: #161b22; border-radius: 8px; padding: 20px; margin-bottom: 16px; border: 1px solid #30363d; }
.section h3 { font-size: 15px; color: #f0f6fc; margin-bottom: 12px; }

/* Meeting card pattern */
.meeting-card { background: #21262d; border-radius: 8px; padding: 14px; margin-bottom: 10px; cursor: pointer; border-left: 4px solid #58a6ff; }
```

### Existing JS Conventions
```javascript
// API base path
const API = '/zoom/api';

// State variables at module scope
let meetings = [];
let clients = [];
let selectedMeetingId = null;

// Fetch pattern — async functions, try/catch, showToast for errors
async function loadSomething() {
  try {
    const res = await fetch(`${API}/endpoint`);
    const data = await res.json();
    // render
  } catch (err) {
    console.error('Failed:', err);
    showToast('Failed to load', true);
  }
}

// Toast notification
function showToast(message, isError = false) { /* 3s auto-dismiss */ }

// XSS prevention
function escapeHtml(text) { /* div.textContent trick */ }

// Date formatting
function formatDate(dateStr) { /* "Mar 25, 2026, 3:15 PM" */ }
function formatShortDate(dateStr) { /* "Mar 25" */ }

// Init pattern
async function init() {
  await loadStats();
  await loadClients();
  await loadOwners();
  await renderWeekPills();
  await loadMeetings();
}
init();
```

### Backend API Endpoints (ALL already implemented, DO NOT MODIFY)

**Roadmap — 9 endpoints at `/zoom/api/`:**

```
GET  /roadmap/taxonomy
  → Returns: { categories: { "paid-ads": { name, types: [{ id, name, frequency }] }, ... } }

GET  /roadmap/:clientId
  → Returns: { client_id, items: [...], total: N }
  → Each item: { id, client_id, title, description, category, task_type,
                  owner_side, owner_name, status, status_reason,
                  created_meeting_id, last_discussed_meeting_id,
                  meetings_discussed (JSON string), meetings_silent_count,
                  due_date, status_history (JSON string),
                  source_action_item_id, created_at, updated_at }

GET  /roadmap/:clientId/active
  → Returns: { client_id, items: [...], total: N }
  → Same item shape, filtered to status NOT IN ('done', 'dropped')

GET  /roadmap/:clientId/stale?threshold=2
  → Returns: { client_id, threshold, items: [...], total: N }
  → Same item shape, filtered to meetings_silent_count >= threshold

GET  /roadmap/:clientId/by-category
  → Returns: { client_id, categories: { "paid-ads": [...items], "website": [...items] }, total: N }

GET  /roadmap/:clientId/snapshot/:meetingId
  → Returns: { id, client_id, meeting_id, snapshot_data (JSON string),
               items_total, items_done, items_in_progress, items_blocked, items_stale, created_at }

GET  /roadmap/:clientId/timeline
  → Returns: { client_id, snapshots: [...], total: N }
  → Each snapshot: same shape as above

PUT  /roadmap/items/:id
  → Body: { title?, owner_name?, owner_side?, due_date?, description?, category?, task_type? }
  → Returns: updated item object

POST /roadmap/items/:id/status
  → Body: { status, notes?, meeting_id? }
  → Returns: { success: true, item: {...} }
  → Valid statuses: "agreed", "in-progress", "done", "blocked", "dropped", "deferred"
```

**Meeting Prep — 5 endpoints at `/zoom/api/`:**

```
GET  /prep/:clientId
  → Returns: (generates fresh, 5-10 second Gemini call)
  → JSON shape:
    {
      status_report: {
        completed: [{ title, date, category }],
        in_progress: [{ title, owner, category, eta }],
        needs_client_action: [{ title, reason, since }]
      },
      accountability: {
        stale_items: [{ title, agreed_date, silent_meetings }],
        b3x_overdue: [{ title, owner, since }],
        client_overdue: [{ title, action_needed, since }]
      },
      strategic_direction: [
        { priority: "HIGH"|"MEDIUM"|"LOW", title, reasoning, category, task_type }
      ],
      suggested_agenda: [
        { topic, minutes, notes }
      ],
      estimated_meeting_length_minutes: N,
      meta: {
        client_id, client_name, generated_at, b3x_lead,
        last_meeting, days_since_last_meeting,
        meetings_analyzed, roadmap_stats: { total, done, in_progress, blocked, stale },
        fallback: true|undefined
      }
    }

GET  /prep/:clientId/markdown
  → Returns: text/plain (formatted Markdown document)

POST /prep/:clientId/slack
  → Returns: { success: true, channel, ts, prep: {...} }

GET  /prep/history/:clientId
  → Returns: { client_id, preps: [{ filename, date, json_path, md_path }] }
  → Sorted newest first

GET  /prep/saved/:filename
  → Returns: JSON content of saved prep file OR text/plain for .md files
```

**Existing endpoints you need:**
```
GET  /clients
  → Returns: { clients: [{ id, name, total_meetings, ... }] }
```

### Current Data Available (for testing)
- **prosper-group**: 10 roadmap items, all status "agreed"
- **gs-home-services**: 12 roadmap items, statuses "agreed" and "in-progress"
- **Saved preps**: Check `/api/prep/history/:clientId` for any saved files

---

## Implementation Plan

### STEP 1: Add CSS for Tab Navigation + New Views

Insert these styles **before the closing `</style>` tag** (around line 1929).

```css
/* ============ TAB NAVIGATION ============ */
.tab-nav {
  display: flex;
  gap: 0;
  background: #0d1117;
  border-bottom: 1px solid #30363d;
  padding: 0 24px;
}

.tab-btn {
  padding: 12px 24px;
  font-size: 14px;
  font-weight: 500;
  color: #8b949e;
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
  transition: all 0.15s;
}

.tab-btn:hover {
  color: #c9d1d9;
}

.tab-btn.active {
  color: #f0f6fc;
  border-bottom-color: #58a6ff;
}

.tab-content {
  display: none;
}

.tab-content.active {
  display: flex;         /* meetings view uses flex */
}

/* Roadmap and prep views override display */
.tab-content.active.roadmap-view {
  display: block;
}

.tab-content.active.prep-view {
  display: flex;
}

/* ============ ROADMAP VIEW ============ */
.roadmap-view {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
}

.roadmap-controls {
  display: flex;
  gap: 16px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 20px;
}

.roadmap-controls select {
  padding: 8px 12px;
  border: 1px solid #30363d;
  border-radius: 6px;
  background: #21262d;
  color: #c9d1d9;
  font-size: 13px;
}

.roadmap-controls select:focus {
  outline: none;
  border-color: #58a6ff;
}

.roadmap-search {
  padding: 8px 12px;
  border: 1px solid #30363d;
  border-radius: 6px;
  background: #21262d;
  color: #c9d1d9;
  font-size: 13px;
  width: 180px;
}

.roadmap-search:focus {
  outline: none;
  border-color: #58a6ff;
}

.roadmap-filter-pills {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.roadmap-pill {
  padding: 4px 12px;
  border-radius: 16px;
  font-size: 12px;
  border: 1px solid #30363d;
  background: #21262d;
  color: #8b949e;
  cursor: pointer;
  transition: all 0.15s;
}

.roadmap-pill:hover {
  border-color: #58a6ff;
  color: #c9d1d9;
}

.roadmap-pill.active {
  background: #58a6ff;
  color: #fff;
  border-color: #58a6ff;
}

.roadmap-stats-bar {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
  margin-bottom: 20px;
}

.roadmap-stat {
  background: #21262d;
  padding: 10px 16px;
  border-radius: 8px;
  text-align: center;
  min-width: 100px;
}

.roadmap-stat .value {
  font-size: 20px;
  font-weight: 600;
  color: #58a6ff;
}

.roadmap-stat .value.green { color: #3fb950; }
.roadmap-stat .value.yellow { color: #d29922; }
.roadmap-stat .value.red { color: #f85149; }

.roadmap-stat .label {
  font-size: 10px;
  color: #8b949e;
  text-transform: uppercase;
  margin-top: 3px;
}

.view-toggle {
  display: flex;
  gap: 0;
  margin-left: auto;
}

.view-toggle button {
  padding: 6px 14px;
  font-size: 12px;
  background: #21262d;
  color: #8b949e;
  border: 1px solid #30363d;
  cursor: pointer;
}

.view-toggle button:first-child {
  border-radius: 6px 0 0 6px;
}

.view-toggle button:last-child {
  border-radius: 0 6px 6px 0;
  border-left: none;
}

.view-toggle button.active {
  background: #30363d;
  color: #f0f6fc;
}

/* Roadmap Card Grid */
.roadmap-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 14px;
}

.roadmap-card {
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 8px;
  padding: 16px;
  transition: border-color 0.15s;
}

.roadmap-card:hover {
  border-color: #484f58;
}

.roadmap-card.stale {
  border-left: 3px solid #d29922;
}

.roadmap-card-header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 10px;
  gap: 8px;
}

.roadmap-card-badges {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.category-badge {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 10px;
  text-transform: uppercase;
  letter-spacing: 0.3px;
}

.status-badge {
  font-size: 10px;
  font-weight: 600;
  padding: 2px 8px;
  border-radius: 10px;
  text-transform: uppercase;
}

.roadmap-card-title {
  font-size: 14px;
  font-weight: 500;
  color: #f0f6fc;
  margin-bottom: 6px;
  line-height: 1.4;
}

.roadmap-card-meta {
  font-size: 12px;
  color: #8b949e;
  margin-bottom: 4px;
}

.roadmap-card-meta .owner-b3x { color: #58a6ff; }
.roadmap-card-meta .owner-client { color: #d29922; }

.roadmap-card-dates {
  font-size: 11px;
  color: #6e7681;
  margin-top: 8px;
  line-height: 1.6;
}

.stale-indicator {
  color: #d29922;
  font-weight: 600;
}

.roadmap-card-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid #21262d;
}

.roadmap-action-btn {
  font-size: 11px;
  padding: 4px 10px;
  border-radius: 4px;
  border: 1px solid #30363d;
  background: #21262d;
  color: #c9d1d9;
  cursor: pointer;
}

.roadmap-action-btn:hover {
  background: #30363d;
  border-color: #58a6ff;
}

/* Status dropdown (inline) */
.status-dropdown {
  position: relative;
  display: inline-block;
}

.status-dropdown-menu {
  display: none;
  position: absolute;
  top: 100%;
  left: 0;
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 6px;
  padding: 4px 0;
  z-index: 100;
  min-width: 140px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.4);
}

.status-dropdown-menu.open {
  display: block;
}

.status-dropdown-menu button {
  display: block;
  width: 100%;
  text-align: left;
  padding: 6px 12px;
  font-size: 12px;
  color: #c9d1d9;
  background: none;
  border: none;
  cursor: pointer;
}

.status-dropdown-menu button:hover {
  background: #21262d;
}

/* Inline edit overlay */
.roadmap-edit-overlay {
  display: none;
}

.roadmap-edit-overlay.active {
  display: block;
  padding: 12px;
  background: #21262d;
  border-radius: 6px;
  margin-top: 8px;
}

.roadmap-edit-overlay label {
  display: block;
  font-size: 11px;
  color: #8b949e;
  margin-bottom: 3px;
  margin-top: 8px;
}

.roadmap-edit-overlay label:first-child {
  margin-top: 0;
}

.roadmap-edit-overlay input {
  width: 100%;
  padding: 6px 10px;
  border: 1px solid #30363d;
  border-radius: 4px;
  background: #0d1117;
  color: #c9d1d9;
  font-size: 13px;
}

.roadmap-edit-overlay .edit-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}

.roadmap-edit-overlay .save-btn {
  padding: 5px 12px;
  background: #238636;
  color: #fff;
  border: none;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
}

.roadmap-edit-overlay .cancel-btn {
  padding: 5px 12px;
  background: #21262d;
  color: #c9d1d9;
  border: 1px solid #30363d;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
}

/* Roadmap Empty State */
.roadmap-empty {
  text-align: center;
  padding: 60px 20px;
  color: #8b949e;
}

.roadmap-empty h3 {
  font-size: 16px;
  color: #c9d1d9;
  margin-bottom: 8px;
}

/* ============ TIMELINE VIEW ============ */
.timeline-container {
  display: none;
  overflow-x: auto;
  padding-bottom: 16px;
}

.timeline-container.active {
  display: block;
}

.timeline-table {
  border-collapse: collapse;
  min-width: 100%;
}

.timeline-table th {
  position: sticky;
  top: 0;
  background: #161b22;
  padding: 10px 16px;
  font-size: 12px;
  font-weight: 600;
  color: #c9d1d9;
  text-align: left;
  border-bottom: 1px solid #30363d;
  white-space: nowrap;
}

.timeline-table td {
  padding: 8px 16px;
  font-size: 12px;
  color: #8b949e;
  border-bottom: 1px solid #21262d;
  vertical-align: middle;
  white-space: nowrap;
}

.timeline-table tr:hover td {
  background: #161b22;
}

.timeline-dot {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  margin-right: 6px;
}

.timeline-item-title {
  font-size: 12px;
  color: #c9d1d9;
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.timeline-new-badge {
  font-size: 9px;
  background: #238636;
  color: #fff;
  padding: 1px 5px;
  border-radius: 8px;
  margin-left: 4px;
}

/* ============ MEETING PREP VIEW ============ */
.prep-view {
  flex: 1;
  overflow: hidden;
}

.prep-left-panel {
  width: 300px;
  min-width: 260px;
  background: #161b22;
  border-right: 1px solid #30363d;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}

.prep-controls {
  padding: 16px;
  border-bottom: 1px solid #30363d;
}

.prep-controls select {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid #30363d;
  border-radius: 6px;
  background: #21262d;
  color: #c9d1d9;
  font-size: 13px;
  margin-bottom: 12px;
}

.prep-btn {
  display: block;
  width: 100%;
  padding: 10px;
  margin-bottom: 8px;
  border: none;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s;
}

.prep-btn.generate {
  background: #238636;
  color: #fff;
}

.prep-btn.generate:hover {
  background: #2ea043;
}

.prep-btn.generate:disabled {
  background: #21262d;
  color: #484f58;
  cursor: not-allowed;
}

.prep-btn.slack {
  background: #21262d;
  color: #c9d1d9;
  border: 1px solid #30363d;
}

.prep-btn.slack:hover {
  background: #30363d;
}

.prep-history {
  padding: 12px 16px;
  flex: 1;
  overflow-y: auto;
}

.prep-history h4 {
  font-size: 12px;
  color: #8b949e;
  text-transform: uppercase;
  margin-bottom: 10px;
}

.prep-history-item {
  padding: 10px 12px;
  background: #21262d;
  border-radius: 6px;
  margin-bottom: 6px;
  cursor: pointer;
  border: 1px solid transparent;
  transition: border-color 0.15s;
}

.prep-history-item:hover {
  border-color: #58a6ff;
}

.prep-history-item.active {
  border-color: #58a6ff;
  background: #161b22;
}

.prep-history-item .date {
  font-size: 13px;
  color: #c9d1d9;
  font-weight: 500;
}

.prep-history-item .ago {
  font-size: 11px;
  color: #8b949e;
  margin-top: 2px;
}

.prep-right-panel {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
}

/* Prep document sections */
.prep-document {
  max-width: 800px;
}

.prep-header {
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 8px;
  padding: 20px;
  margin-bottom: 20px;
}

.prep-header h2 {
  font-size: 18px;
  color: #f0f6fc;
  margin-bottom: 8px;
}

.prep-header-meta {
  font-size: 12px;
  color: #8b949e;
  line-height: 1.8;
}

.prep-section {
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 8px;
  padding: 20px;
  margin-bottom: 16px;
}

.prep-section h3 {
  font-size: 14px;
  font-weight: 600;
  color: #f0f6fc;
  margin-bottom: 16px;
  padding-bottom: 8px;
  border-bottom: 1px solid #21262d;
  cursor: pointer;
}

.prep-section h3::after {
  content: " ▾";
  color: #484f58;
  font-size: 11px;
}

.prep-section.collapsed .prep-section-body {
  display: none;
}

.prep-section.collapsed h3::after {
  content: " ▸";
}

.prep-subsection {
  margin-bottom: 16px;
}

.prep-subsection h4 {
  font-size: 12px;
  font-weight: 600;
  color: #8b949e;
  text-transform: uppercase;
  margin-bottom: 8px;
}

.prep-item {
  padding: 8px 12px;
  border-left: 3px solid #30363d;
  margin-bottom: 6px;
  font-size: 13px;
  color: #c9d1d9;
  line-height: 1.5;
}

.prep-item.completed { border-left-color: #3fb950; }
.prep-item.in-progress { border-left-color: #d29922; }
.prep-item.needs-action { border-left-color: #f85149; }
.prep-item.stale { border-left-color: #f85149; background: rgba(248,81,73,0.05); }
.prep-item.overdue { border-left-color: #d29922; }

.prep-item .item-title {
  font-weight: 500;
  color: #f0f6fc;
}

.prep-item .item-detail {
  font-size: 12px;
  color: #8b949e;
  margin-top: 2px;
}

.prep-item .category-tag {
  font-size: 10px;
  color: #8b949e;
  padding: 1px 6px;
  border: 1px solid #30363d;
  border-radius: 8px;
  margin-left: 6px;
}

/* Strategic recommendations */
.prep-recommendation {
  padding: 12px 16px;
  background: #21262d;
  border-radius: 6px;
  margin-bottom: 10px;
}

.prep-recommendation .priority {
  font-size: 10px;
  font-weight: 700;
  padding: 2px 8px;
  border-radius: 10px;
  text-transform: uppercase;
  margin-right: 8px;
}

.prep-recommendation .priority.high { background: rgba(248,81,73,0.2); color: #f85149; }
.prep-recommendation .priority.medium { background: rgba(210,153,34,0.2); color: #d29922; }
.prep-recommendation .priority.low { background: rgba(110,118,129,0.2); color: #8b949e; }

.prep-recommendation .rec-title {
  font-size: 14px;
  font-weight: 500;
  color: #f0f6fc;
  display: inline;
}

.prep-recommendation .rec-reasoning {
  font-size: 12px;
  color: #8b949e;
  margin-top: 6px;
  line-height: 1.5;
}

.prep-recommendation .rec-category {
  font-size: 10px;
  color: #6e7681;
  margin-top: 4px;
}

/* Agenda items */
.agenda-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid #21262d;
}

.agenda-item:last-child {
  border-bottom: none;
}

.agenda-number {
  font-size: 12px;
  font-weight: 700;
  color: #484f58;
  min-width: 20px;
}

.agenda-topic {
  flex: 1;
  font-size: 13px;
  color: #c9d1d9;
}

.agenda-time {
  font-size: 12px;
  font-weight: 600;
  color: #58a6ff;
  min-width: 50px;
  text-align: right;
}

.agenda-bar {
  height: 4px;
  background: #58a6ff;
  border-radius: 2px;
  opacity: 0.3;
  min-width: 20px;
  max-width: 120px;
}

.agenda-notes {
  font-size: 11px;
  color: #6e7681;
  padding-left: 32px;
  margin-top: -6px;
  margin-bottom: 4px;
}

.agenda-total {
  text-align: right;
  font-size: 14px;
  font-weight: 600;
  color: #f0f6fc;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid #30363d;
}

/* Prep loading spinner */
.prep-spinner {
  text-align: center;
  padding: 60px 20px;
  color: #8b949e;
}

.prep-spinner .spinner-icon {
  font-size: 24px;
  animation: spin 1s linear infinite;
  display: inline-block;
  margin-bottom: 12px;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.prep-empty {
  text-align: center;
  padding: 60px 20px;
  color: #8b949e;
}

.prep-empty h3 {
  font-size: 16px;
  color: #c9d1d9;
  margin-bottom: 8px;
}

/* Prep fallback warning */
.prep-fallback-warning {
  background: rgba(210,153,34,0.1);
  border: 1px solid #d29922;
  border-radius: 6px;
  padding: 10px 14px;
  font-size: 12px;
  color: #d29922;
  margin-bottom: 16px;
}
```

### STEP 2: Modify HTML Structure

**2a.** Add tab navigation bar. Insert **after** the `<div class="validation-stats-section">...</div>` and **before** `<div class="main">`:

```html
<!-- Tab Navigation -->
<div class="tab-nav" role="tablist">
  <button class="tab-btn active" onclick="switchTab('meetings')" data-tab="meetings" role="tab" aria-selected="true" aria-controls="meetingsView">Meetings</button>
  <button class="tab-btn" onclick="switchTab('roadmap')" data-tab="roadmap" role="tab" aria-selected="false" aria-controls="roadmapView">Roadmap</button>
  <button class="tab-btn" onclick="switchTab('prep')" data-tab="prep" role="tab" aria-selected="false" aria-controls="prepView">Meeting Prep</button>
</div>
```

**2b.** Wrap existing `<div class="main">` content with a tab-content div. Change:
```html
<div class="main">
```
to:
```html
<div class="main tab-content active" id="meetingsView" role="tabpanel" aria-labelledby="tab-meetings">
```
(keep the closing `</div>` where it is)

**2c.** Add Roadmap view **after** the closing `</div>` of `#meetingsView` and **before** `</div><!-- .app -->`:

```html
<!-- Roadmap View -->
<div class="tab-content roadmap-view" id="roadmapView" role="tabpanel" aria-labelledby="tab-roadmap">
  <div class="roadmap-controls">
    <select id="roadmapClientSelect" onchange="onRoadmapClientChange(this.value)" aria-label="Select client">
      <option value="">Select a client...</option>
    </select>

    <input type="text" id="roadmapSearch" placeholder="Search items..." oninput="applyRoadmapFilter()" class="roadmap-search" aria-label="Search roadmap items">

    <div class="roadmap-filter-pills" id="roadmapStatusPills">
      <button class="roadmap-pill active" onclick="filterRoadmap('status', 'all', this)">All</button>
      <button class="roadmap-pill" onclick="filterRoadmap('status', 'active', this)">Active</button>
      <button class="roadmap-pill" onclick="filterRoadmap('status', 'stale', this)">Stale</button>
      <button class="roadmap-pill" onclick="filterRoadmap('status', 'done', this)">Done</button>
      <button class="roadmap-pill" onclick="filterRoadmap('status', 'blocked', this)">Blocked</button>
    </div>

    <div class="roadmap-filter-pills" id="roadmapOwnerPills">
      <button class="roadmap-pill active" onclick="filterRoadmap('owner', 'all', this)">All</button>
      <button class="roadmap-pill" onclick="filterRoadmap('owner', 'b3x', this)">B3X</button>
      <button class="roadmap-pill" onclick="filterRoadmap('owner', 'client', this)">Client</button>
    </div>

    <div class="view-toggle">
      <button class="active" onclick="toggleRoadmapView('cards', this)">Cards</button>
      <button onclick="toggleRoadmapView('timeline', this)">Timeline</button>
    </div>
  </div>

  <div class="roadmap-filter-pills" id="roadmapCategoryPills" style="margin-bottom: 16px;">
    <!-- Dynamically populated from taxonomy with human-readable names -->
  </div>

  <div class="roadmap-stats-bar" id="roadmapStatsBar">
    <!-- Dynamically populated -->
  </div>

  <div class="roadmap-grid" id="roadmapGrid">
    <div class="roadmap-empty">
      <h3>Select a client to view their roadmap</h3>
      <p>Choose a client from the dropdown above</p>
    </div>
  </div>

  <div class="timeline-container" id="timelineContainer">
    <!-- Rendered by renderRoadmapTimeline() -->
  </div>
</div>
```

**2d.** Add Meeting Prep view **after** `#roadmapView`:

```html
<!-- Meeting Prep View -->
<div class="tab-content prep-view" id="prepView" role="tabpanel" aria-labelledby="tab-prep">
  <div class="prep-left-panel">
    <div class="prep-controls">
      <select id="prepClientSelect" onchange="onPrepClientChange(this.value)">
        <option value="">Select a client...</option>
      </select>
      <button class="prep-btn generate" id="generatePrepBtn" onclick="generatePrep()" disabled>
        Generate Fresh Prep
      </button>
      <button class="prep-btn slack" id="postSlackBtn" onclick="postPrepToSlack()" disabled>
        Post to Slack
      </button>
    </div>
    <div class="prep-history" id="prepHistoryPanel">
      <h4>Saved Preps</h4>
      <div id="prepHistoryList">
        <div style="font-size: 12px; color: #8b949e;">Select a client first</div>
      </div>
    </div>
  </div>
  <div class="prep-right-panel" id="prepRightPanel">
    <div class="prep-empty">
      <h3>Select a client to view meeting prep</h3>
      <p>Generate a fresh briefing or view saved prep documents</p>
    </div>
  </div>
</div>
```

### STEP 3: Add JavaScript

Insert all new JS **before** the `init()` call at the bottom of the `<script>` block (before `init();`).

```javascript
// ============ CONSTANTS ============

const CATEGORY_COLORS = {
  'paid-ads':        '#ff6b6b',
  'email-marketing': '#ffd43b',
  'website':         '#51cf66',
  'funnel-campaign': '#cc5de8',
  'call-tracking':   '#ff922b',
  'reporting':       '#339af0',
  'crm-automation':  '#20c997',
  'gbp':             '#f06595',
  'creative':        '#845ef7',
  'client-ops':      '#868e96'
};

const STATUS_COLORS = {
  'agreed':      '#4c9aff',
  'in-progress': '#ffd43b',
  'done':        '#51cf66',
  'blocked':     '#f85149',
  'dropped':     '#495057',
  'deferred':    '#bc8cff'
};

const VALID_STATUSES = ['agreed', 'in-progress', 'done', 'blocked', 'dropped', 'deferred'];

// Human-readable category names (for pills and display)
const CATEGORY_LABELS = {
  'paid-ads':        'Paid Ads',
  'email-marketing': 'Email Marketing',
  'website':         'Website',
  'funnel-campaign': 'Funnel / Campaign',
  'call-tracking':   'Call Tracking',
  'reporting':       'Reporting',
  'crm-automation':  'CRM / Automation',
  'gbp':             'Google Business',
  'creative':        'Creative',
  'client-ops':      'Client Ops'
};

// ============ ATTRIBUTE ESCAPING (FIX: escapeHtml doesn't handle attribute context) ============

function escapeAttr(text) {
  if (!text) return '';
  return String(text).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/'/g,'&#39;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ============ SHARED STATE ============

let currentTab = 'meetings';
let sharedClientId = null;       // shared between roadmap & prep tabs
let roadmapItems = [];           // full roadmap for current client
let roadmapFiltered = [];        // after filter
let roadmapTaxonomy = null;      // cached taxonomy
let roadmapFilter = { status: 'all', owner: 'all', category: 'all' };
let currentPrepData = null;      // current prep being viewed
let roadmapViewMode = 'cards';   // 'cards' or 'timeline'
let prepAbortController = null;  // AbortController for in-flight prep generation

// ============ TAB NAVIGATION ============

function switchTab(tab) {
  currentTab = tab;

  // Cancel any in-flight prep generation
  if (prepAbortController) {
    prepAbortController.abort();
    prepAbortController = null;
  }

  // Update tab buttons (+ ARIA)
  document.querySelectorAll('.tab-btn').forEach(btn => {
    const isActive = btn.dataset.tab === tab;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });

  // Update tab content
  document.getElementById('meetingsView').classList.toggle('active', tab === 'meetings');
  document.getElementById('roadmapView').classList.toggle('active', tab === 'roadmap');
  document.getElementById('prepView').classList.toggle('active', tab === 'prep');

  // Update stats bar visibility
  document.getElementById('statsBar').style.display = tab === 'meetings' ? 'flex' : 'none';

  // Update URL hash
  window.location.hash = tab === 'meetings' ? '' : tab;

  // Load data for tab if needed
  if (tab === 'roadmap') {
    ensureTaxonomyLoaded();
    populateRoadmapClientDropdown();
    if (sharedClientId) {
      document.getElementById('roadmapClientSelect').value = sharedClientId;
      loadRoadmap(sharedClientId);
    }
  } else if (tab === 'prep') {
    populatePrepClientDropdown();
    if (sharedClientId) {
      document.getElementById('prepClientSelect').value = sharedClientId;
      loadPrepHistory(sharedClientId);
    }
  }
}

// Handle hash on page load
function initTabFromHash() {
  const hash = window.location.hash.replace('#', '');
  if (hash === 'roadmap' || hash === 'prep') {
    switchTab(hash);
  }
}

// ============ ROADMAP FUNCTIONS ============

function populateRoadmapClientDropdown() {
  const select = document.getElementById('roadmapClientSelect');
  if (select.options.length > 1) return; // already populated
  clients.forEach(c => {
    if (c.total_meetings > 0) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = escapeHtml(c.name);
      select.appendChild(opt);
    }
  });
}

async function ensureTaxonomyLoaded() {
  if (roadmapTaxonomy) return;
  try {
    const res = await fetch(`${API}/roadmap/taxonomy`);
    roadmapTaxonomy = await res.json();
    renderCategoryPills();
  } catch (err) {
    console.error('Failed to load taxonomy:', err);
  }
}

function renderCategoryPills() {
  const container = document.getElementById('roadmapCategoryPills');
  if (!roadmapTaxonomy?.categories) return;

  let html = '<button class="roadmap-pill active" onclick="filterRoadmap(\'category\', \'all\', this)">All Categories</button>';
  for (const catId of Object.keys(roadmapTaxonomy.categories)) {
    const color = CATEGORY_COLORS[catId] || '#8b949e';
    const label = CATEGORY_LABELS[catId] || catId;
    html += `<button class="roadmap-pill" onclick="filterRoadmap('category', '${catId}', this)" style="border-color: ${color}40;">${escapeHtml(label)}</button>`;
  }
  container.innerHTML = html;
}

function onRoadmapClientChange(clientId) {
  sharedClientId = clientId || null;

  // Reset filters when switching clients
  roadmapFilter = { status: 'all', owner: 'all', category: 'all' };
  document.querySelectorAll('#roadmapStatusPills .roadmap-pill, #roadmapOwnerPills .roadmap-pill, #roadmapCategoryPills .roadmap-pill').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('#roadmapStatusPills .roadmap-pill:first-child, #roadmapOwnerPills .roadmap-pill:first-child, #roadmapCategoryPills .roadmap-pill:first-child').forEach(p => p.classList.add('active'));
  const searchInput = document.getElementById('roadmapSearch');
  if (searchInput) searchInput.value = '';

  if (clientId) {
    loadRoadmap(clientId);
  } else {
    document.getElementById('roadmapGrid').innerHTML = '<div class="roadmap-empty"><h3>Select a client to view their roadmap</h3><p>Choose a client from the dropdown above</p></div>';
    document.getElementById('roadmapStatsBar').innerHTML = '';
    document.getElementById('timelineContainer').innerHTML = '';
  }
  // Sync prep dropdown
  const prepSelect = document.getElementById('prepClientSelect');
  if (prepSelect) prepSelect.value = clientId || '';
}

async function loadRoadmap(clientId) {
  const grid = document.getElementById('roadmapGrid');
  grid.innerHTML = '<div class="roadmap-empty"><p>Loading roadmap...</p></div>';

  try {
    const [itemsRes, timelineRes] = await Promise.all([
      fetch(`${API}/roadmap/${clientId}`),
      fetch(`${API}/roadmap/${clientId}/timeline`)
    ]);

    const itemsData = await itemsRes.json();
    const timelineData = await timelineRes.json();

    roadmapItems = itemsData.items || [];

    // Parse JSON string fields
    roadmapItems.forEach(item => {
      if (typeof item.meetings_discussed === 'string') {
        try { item.meetings_discussed = JSON.parse(item.meetings_discussed); } catch { item.meetings_discussed = []; }
      }
      if (typeof item.status_history === 'string') {
        try { item.status_history = JSON.parse(item.status_history); } catch { item.status_history = []; }
      }
    });

    renderRoadmapStats(roadmapItems);
    applyRoadmapFilter();

    // Render timeline (hidden by default)
    if (timelineData.snapshots?.length > 0) {
      renderRoadmapTimeline(timelineData.snapshots);
    }
  } catch (err) {
    console.error('Failed to load roadmap:', err);
    grid.innerHTML = '<div class="roadmap-empty"><h3>Failed to load roadmap</h3><p>' + escapeHtml(err.message) + '</p></div>';
  }
}

function renderRoadmapStats(items) {
  const stats = {
    total: items.length,
    agreed: items.filter(i => i.status === 'agreed').length,
    inProgress: items.filter(i => i.status === 'in-progress').length,
    done: items.filter(i => i.status === 'done').length,
    blocked: items.filter(i => i.status === 'blocked').length,
    stale: items.filter(i => i.meetings_silent_count >= 2).length
  };

  const pct = stats.total > 0 ? Math.round((stats.done / stats.total) * 100) : 0;

  document.getElementById('roadmapStatsBar').innerHTML = `
    <div class="roadmap-stat"><div class="value">${stats.total}</div><div class="label">Total</div></div>
    <div class="roadmap-stat"><div class="value">${stats.agreed}</div><div class="label">Agreed</div></div>
    <div class="roadmap-stat"><div class="value yellow">${stats.inProgress}</div><div class="label">In Progress</div></div>
    <div class="roadmap-stat"><div class="value green">${stats.done}</div><div class="label">Done</div></div>
    <div class="roadmap-stat"><div class="value red">${stats.blocked}</div><div class="label">Blocked</div></div>
    <div class="roadmap-stat"><div class="value" style="color:#d29922">${stats.stale}</div><div class="label">Stale</div></div>
    <div class="roadmap-stat"><div class="value">${pct}%</div><div class="label">Complete</div></div>
  `;
}

function filterRoadmap(type, value, el) {
  roadmapFilter[type] = value;

  // Update pill active states within the correct pill group
  const parent = el.parentElement;
  parent.querySelectorAll('.roadmap-pill').forEach(p => p.classList.remove('active'));
  el.classList.add('active');

  applyRoadmapFilter();
}

function applyRoadmapFilter() {
  const searchTerm = (document.getElementById('roadmapSearch')?.value || '').toLowerCase().trim();

  roadmapFiltered = roadmapItems.filter(item => {
    // Search filter
    if (searchTerm && !item.title.toLowerCase().includes(searchTerm) && !(item.owner_name || '').toLowerCase().includes(searchTerm)) return false;

    // Status filter
    if (roadmapFilter.status === 'active' && (item.status === 'done' || item.status === 'dropped')) return false;
    if (roadmapFilter.status === 'stale' && item.meetings_silent_count < 2) return false;
    if (roadmapFilter.status === 'done' && item.status !== 'done') return false;
    if (roadmapFilter.status === 'blocked' && item.status !== 'blocked') return false;

    // Owner filter
    if (roadmapFilter.owner !== 'all' && item.owner_side !== roadmapFilter.owner) return false;

    // Category filter
    if (roadmapFilter.category !== 'all' && item.category !== roadmapFilter.category) return false;

    return true;
  });

  renderRoadmapCards(roadmapFiltered);
}

function renderRoadmapCards(items) {
  const grid = document.getElementById('roadmapGrid');

  if (items.length === 0) {
    grid.innerHTML = '<div class="roadmap-empty"><h3>No items match filters</h3><p>Try adjusting the filters above</p></div>';
    return;
  }

  grid.innerHTML = items.map(item => {
    const catColor = CATEGORY_COLORS[item.category] || '#8b949e';
    const statusColor = STATUS_COLORS[item.status] || '#8b949e';
    const isStale = item.meetings_silent_count >= 2;
    const ownerClass = item.owner_side === 'b3x' ? 'owner-b3x' : 'owner-client';

    return `
      <div class="roadmap-card ${isStale ? 'stale' : ''}" id="roadmap-card-${item.id}">
        <div class="roadmap-card-header">
          <div class="roadmap-card-badges">
            <span class="category-badge" style="background: ${catColor}20; color: ${catColor};">${escapeHtml(item.category)}</span>
            <span class="status-badge" style="background: ${statusColor}20; color: ${statusColor};">${escapeHtml(item.status)}</span>
          </div>
        </div>
        <div class="roadmap-card-title">${escapeHtml(item.title)}</div>
        <div class="roadmap-card-meta">
          ${escapeHtml(item.task_type)} &middot; <span class="${ownerClass}">${escapeHtml(item.owner_side)}</span>${item.owner_name ? ': ' + escapeHtml(item.owner_name) : ''}
        </div>
        <div class="roadmap-card-dates">
          Created: ${formatShortDate(item.created_at)}
          ${item.due_date ? '<br>Due: ' + escapeHtml(item.due_date) : ''}
          ${isStale ? '<br><span class="stale-indicator">Silent ' + item.meetings_silent_count + ' meetings</span>' : ''}
        </div>
        <div class="roadmap-card-actions">
          <div class="status-dropdown">
            <button class="roadmap-action-btn" onclick="toggleStatusDropdown(${item.id})">Status ▾</button>
            <div class="status-dropdown-menu" id="status-dd-${item.id}">
              ${VALID_STATUSES.map(s => `<button onclick="changeRoadmapStatus(${item.id}, '${s}')" style="color: ${STATUS_COLORS[s]}">${s}</button>`).join('')}
            </div>
          </div>
          <button class="roadmap-action-btn" onclick="toggleRoadmapEdit(${item.id})">Edit</button>
        </div>
        <div class="roadmap-edit-overlay" id="edit-overlay-${item.id}">
          <label for="edit-title-${item.id}">Title</label>
          <input type="text" id="edit-title-${item.id}" value="${escapeAttr(item.title)}">
          <label for="edit-owner-${item.id}">Owner</label>
          <input type="text" id="edit-owner-${item.id}" value="${escapeAttr(item.owner_name || '')}">
          <label for="edit-due-${item.id}">Due Date</label>
          <input type="text" id="edit-due-${item.id}" value="${escapeAttr(item.due_date || '')}" placeholder="YYYY-MM-DD">
          <div class="edit-actions">
            <button class="save-btn" onclick="saveRoadmapEdit(${item.id})">Save</button>
            <button class="cancel-btn" onclick="toggleRoadmapEdit(${item.id})">Cancel</button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function toggleStatusDropdown(itemId) {
  // Close all other dropdowns first
  document.querySelectorAll('.status-dropdown-menu.open').forEach(m => m.classList.remove('open'));
  const menu = document.getElementById(`status-dd-${itemId}`);
  menu.classList.toggle('open');
}

// Close dropdowns on outside click
document.addEventListener('click', (e) => {
  if (!e.target.closest('.status-dropdown')) {
    document.querySelectorAll('.status-dropdown-menu.open').forEach(m => m.classList.remove('open'));
  }
});

async function changeRoadmapStatus(itemId, newStatus) {
  try {
    const res = await fetch(`${API}/roadmap/items/${itemId}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus, notes: 'Manual update from dashboard' })
    });

    if (!res.ok) throw new Error('Failed to update status');

    showToast(`Status changed to ${newStatus}`);

    // Update local state
    const item = roadmapItems.find(i => i.id === itemId);
    if (item) item.status = newStatus;

    renderRoadmapStats(roadmapItems);
    applyRoadmapFilter();
  } catch (err) {
    showToast('Failed to change status: ' + err.message, true);
  }
}

function toggleRoadmapEdit(itemId) {
  const overlay = document.getElementById(`edit-overlay-${itemId}`);
  overlay.classList.toggle('active');
}

async function saveRoadmapEdit(itemId) {
  const title = document.getElementById(`edit-title-${itemId}`).value.trim();
  const owner_name = document.getElementById(`edit-owner-${itemId}`).value.trim();
  const due_date = document.getElementById(`edit-due-${itemId}`).value.trim();

  if (!title) {
    showToast('Title is required', true);
    return;
  }

  try {
    const res = await fetch(`${API}/roadmap/items/${itemId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, owner_name: owner_name || null, due_date: due_date || null })
    });

    if (!res.ok) throw new Error('Failed to save');

    showToast('Item updated');

    // Update local state
    const item = roadmapItems.find(i => i.id === itemId);
    if (item) {
      item.title = title;
      item.owner_name = owner_name || null;
      item.due_date = due_date || null;
    }

    applyRoadmapFilter();
  } catch (err) {
    showToast('Failed to save: ' + err.message, true);
  }
}

function toggleRoadmapView(mode, el) {
  roadmapViewMode = mode;
  el.parentElement.querySelectorAll('button').forEach(b => b.classList.remove('active'));
  el.classList.add('active');

  document.getElementById('roadmapGrid').style.display = mode === 'cards' ? 'grid' : 'none';
  document.getElementById('timelineContainer').classList.toggle('active', mode === 'timeline');
}

function renderRoadmapTimeline(snapshots) {
  const container = document.getElementById('timelineContainer');

  if (!snapshots || snapshots.length === 0) {
    container.innerHTML = '<div class="roadmap-empty"><p>No timeline data yet</p></div>';
    return;
  }

  // Parse snapshot_data for each snapshot
  const parsed = snapshots.map(s => {
    let items = [];
    try {
      items = typeof s.snapshot_data === 'string' ? JSON.parse(s.snapshot_data) : s.snapshot_data;
    } catch {}
    return { ...s, items };
  });

  // Collect all unique items across snapshots using ID (not title, to avoid collisions)
  // Each entry: { id, title, first_seen_index }
  const allItems = new Map(); // id → { title, firstIdx }
  parsed.forEach((snap, idx) => {
    (snap.items || []).forEach(item => {
      const key = item.id || item.title; // fallback to title if snapshot doesn't have id
      if (!allItems.has(key)) {
        allItems.set(key, { title: item.title, firstIdx: idx });
      }
    });
  });

  // Build table
  let html = '<table class="timeline-table"><thead><tr>';
  html += '<th>Item</th>';
  parsed.forEach(s => {
    const date = formatShortDate(s.created_at);
    html += `<th>${date}</th>`;
  });
  html += '</tr></thead><tbody>';

  for (const [itemKey, { title, firstIdx }] of allItems) {
    html += `<tr><td class="timeline-item-title">${escapeHtml(title)}</td>`;
    parsed.forEach((snap, idx) => {
      if (idx < firstIdx) {
        html += '<td>—</td>';
      } else {
        const item = snap.items?.find(i => (i.id || i.title) === itemKey);
        if (item) {
          const color = STATUS_COLORS[item.status] || '#8b949e';
          const isNew = idx === firstIdx && idx > 0;
          html += `<td><span class="timeline-dot" style="background:${color}" title="${escapeAttr(item.status)}"></span>${escapeHtml(item.status)}${isNew ? '<span class="timeline-new-badge">NEW</span>' : ''}</td>`;
        } else {
          html += '<td style="color:#484f58">—</td>';
        }
      }
    });
    html += '</tr>';
  }

  html += '</tbody></table>';
  container.innerHTML = html;
}

// ============ MEETING PREP FUNCTIONS ============

function populatePrepClientDropdown() {
  const select = document.getElementById('prepClientSelect');
  if (select.options.length > 1) return; // already populated
  clients.forEach(c => {
    if (c.total_meetings > 0) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = escapeHtml(c.name);
      select.appendChild(opt);
    }
  });
}

function onPrepClientChange(clientId) {
  sharedClientId = clientId || null;
  document.getElementById('generatePrepBtn').disabled = !clientId;
  document.getElementById('postSlackBtn').disabled = !clientId;

  // Sync roadmap dropdown
  const roadmapSelect = document.getElementById('roadmapClientSelect');
  if (roadmapSelect) roadmapSelect.value = clientId || '';

  if (clientId) {
    loadPrepHistory(clientId);
  } else {
    document.getElementById('prepHistoryList').innerHTML = '<div style="font-size: 12px; color: #8b949e;">Select a client first</div>';
    document.getElementById('prepRightPanel').innerHTML = '<div class="prep-empty"><h3>Select a client to view meeting prep</h3><p>Generate a fresh briefing or view saved prep documents</p></div>';
  }
}

async function generatePrep() {
  if (!sharedClientId) return;

  // Abort any in-flight generation
  if (prepAbortController) prepAbortController.abort();
  prepAbortController = new AbortController();

  const btn = document.getElementById('generatePrepBtn');
  const panel = document.getElementById('prepRightPanel');

  btn.disabled = true;
  btn.textContent = 'Generating prep...';
  panel.innerHTML = '<div class="prep-spinner"><div class="spinner-icon" aria-hidden="true">&#9881;</div><p>Generating meeting prep via AI...<br>This may take 5-10 seconds</p></div>';

  try {
    const res = await fetch(`${API}/prep/${sharedClientId}`, { signal: prepAbortController.signal });
    if (!res.ok) throw new Error('Failed to generate prep');

    const data = await res.json();
    currentPrepData = data;
    renderPrepDocument(data);
    showToast('Meeting prep generated');

    // Refresh history
    loadPrepHistory(sharedClientId);
  } catch (err) {
    if (err.name === 'AbortError') return; // User navigated away, ignore
    panel.innerHTML = '<div class="prep-empty"><h3>Failed to generate prep</h3><p>' + escapeHtml(err.message) + '</p></div>';
    showToast('Failed to generate prep: ' + err.message, true);
  } finally {
    prepAbortController = null;
    btn.disabled = false;
    btn.textContent = 'Generate Fresh Prep';
  }
}

async function postPrepToSlack() {
  if (!sharedClientId) return;

  const btn = document.getElementById('postSlackBtn');
  btn.disabled = true;
  btn.textContent = 'Posting...';

  try {
    const res = await fetch(`${API}/prep/${sharedClientId}/slack`, { method: 'POST' });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || 'Failed');
    }
    showToast('Prep posted to Slack');
  } catch (err) {
    showToast('Failed to post to Slack: ' + err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Post to Slack';
  }
}

async function loadPrepHistory(clientId) {
  const container = document.getElementById('prepHistoryList');

  try {
    const res = await fetch(`${API}/prep/history/${clientId}`);
    const data = await res.json();
    const preps = data.preps || [];

    if (preps.length === 0) {
      container.innerHTML = '<div style="font-size: 12px; color: #8b949e;">No saved preps yet.<br>Generate one above.</div>';
      return;
    }

    container.innerHTML = preps.map(p => {
      const daysAgo = p.date ? Math.floor((Date.now() - new Date(p.date).getTime()) / 86400000) : '?';
      return `
        <div class="prep-history-item" onclick="loadSavedPrep('${escapeHtml(p.filename)}', this)">
          <div class="date">${escapeHtml(p.date || p.filename)}</div>
          <div class="ago">${daysAgo} day${daysAgo !== 1 ? 's' : ''} ago</div>
        </div>
      `;
    }).join('');
  } catch (err) {
    container.innerHTML = '<div style="font-size: 12px; color: #f85149;">Failed to load history</div>';
  }
}

async function loadSavedPrep(filename, el) {
  // Highlight selected
  document.querySelectorAll('.prep-history-item').forEach(i => i.classList.remove('active'));
  if (el) el.classList.add('active');

  const panel = document.getElementById('prepRightPanel');
  panel.innerHTML = '<div class="prep-spinner"><div class="spinner-icon" aria-hidden="true">&#9881;</div><p>Loading...</p></div>';

  try {
    // Always load the JSON version (history items have .json filenames)
    const jsonFilename = filename.endsWith('.md') ? filename.replace('.md', '.json') : filename;
    const res = await fetch(`${API}/prep/saved/${jsonFilename}`);

    if (!res.ok) throw new Error('Prep file not found');

    const data = await res.json();
    currentPrepData = data;
    renderPrepDocument(data);
  } catch (err) {
    panel.innerHTML = '<div class="prep-empty"><h3>Failed to load prep</h3><p>' + escapeHtml(err.message) + '</p></div>';
  }
}

function renderPrepDocument(prep) {
  const panel = document.getElementById('prepRightPanel');
  const meta = prep.meta || {};

  let html = '<div class="prep-document">';

  // Header
  html += `
    <div class="prep-header">
      <h2>Meeting Prep: ${escapeHtml(meta.client_name || sharedClientId)}</h2>
      <div class="prep-header-meta">
        Prepared for: ${escapeHtml(meta.b3x_lead || 'B3X Team')}<br>
        Last meeting: ${meta.last_meeting ? formatDate(meta.last_meeting) : 'N/A'}
          ${meta.days_since_last_meeting ? ' (' + meta.days_since_last_meeting + ' days ago)' : ''}<br>
        Meetings analyzed: ${meta.meetings_analyzed || '?'}<br>
        Generated: ${meta.generated_at ? formatDate(meta.generated_at) : 'now'}
        ${meta.roadmap_stats ? '<br>Roadmap: ' + meta.roadmap_stats.total + ' items (' + meta.roadmap_stats.done + ' done, ' + meta.roadmap_stats.in_progress + ' in progress, ' + meta.roadmap_stats.blocked + ' blocked)' : ''}
      </div>
    </div>
  `;

  // Fallback warning
  if (meta.fallback) {
    html += '<div class="prep-fallback-warning">AI generation used fallback mode — data shown is from roadmap directly, not AI-enhanced.</div>';
  }

  // Section 1: Status Report
  const sr = prep.status_report || {};
  html += `
    <div class="prep-section">
      <h3 onclick="this.parentElement.classList.toggle('collapsed')" aria-expanded="true">STATUS REPORT</h3>
      <div class="prep-section-body">
        ${renderPrepSubsection('Completed', sr.completed, 'completed', i => `${escapeHtml(i.title)} <span class="item-detail">&mdash; ${escapeHtml(i.date)}</span> <span class="category-tag">${escapeHtml(i.category)}</span>`)}
        ${renderPrepSubsection('In Progress', sr.in_progress, 'in-progress', i => `${escapeHtml(i.title)} <span class="item-detail">&mdash; ${escapeHtml(i.owner || 'unassigned')}${i.eta ? ', ETA ' + escapeHtml(i.eta) : ''}</span> <span class="category-tag">${escapeHtml(i.category)}</span>`)}
        ${renderPrepSubsection('Needs Client Action', sr.needs_client_action, 'needs-action', i => `${escapeHtml(i.title)} <span class="item-detail">&mdash; ${escapeHtml(i.reason)} (since ${escapeHtml(i.since)})</span>`)}
      </div>
    </div>
  `;

  // Section 2: Accountability
  const acc = prep.accountability || {};
  html += `
    <div class="prep-section">
      <h3 onclick="this.parentElement.classList.toggle('collapsed')" aria-expanded="true">ACCOUNTABILITY CHECK</h3>
      <div class="prep-section-body">
        ${renderPrepSubsection('Stale Items', acc.stale_items, 'stale', i => `${escapeHtml(i.title)} <span class="item-detail">&mdash; agreed ${escapeHtml(i.agreed_date)}, silent ${i.silent_meetings} meetings</span>`)}
        ${renderPrepSubsection('B3X Overdue', acc.b3x_overdue, 'overdue', i => `${escapeHtml(i.title)} <span class="item-detail">&mdash; ${escapeHtml(i.owner)}, since ${escapeHtml(i.since)}</span>`)}
        ${renderPrepSubsection('Client Overdue', acc.client_overdue, 'overdue', i => `${escapeHtml(i.title)} <span class="item-detail">&mdash; ${escapeHtml(i.action_needed)}, since ${escapeHtml(i.since)}</span>`)}
      </div>
    </div>
  `;

  // Section 3: Strategic Direction
  const strat = prep.strategic_direction || [];
  html += `
    <div class="prep-section">
      <h3 onclick="this.parentElement.classList.toggle('collapsed')" aria-expanded="true">STRATEGIC DIRECTION</h3>
      <div class="prep-section-body">
        ${strat.length > 0 ? strat.map((r, i) => `
          <div class="prep-recommendation">
            <span class="priority ${(r.priority || 'medium').toLowerCase()}">${escapeHtml(r.priority || 'MEDIUM')}</span>
            <span class="rec-title">${escapeHtml(r.title)}</span>
            <div class="rec-reasoning">${escapeHtml(r.reasoning)}</div>
            <div class="rec-category">${escapeHtml(r.category || '')}${r.task_type ? ' / ' + escapeHtml(r.task_type) : ''}</div>
          </div>
        `).join('') : '<div style="color: #8b949e; font-size: 13px;">No strategic recommendations</div>'}
      </div>
    </div>
  `;

  // Section 4: Suggested Agenda
  const agenda = prep.suggested_agenda || [];
  const totalMin = prep.estimated_meeting_length_minutes || agenda.reduce((s, a) => s + (a.minutes || 0), 0);
  const maxMin = Math.max(...agenda.map(a => a.minutes || 0), 1);

  html += `
    <div class="prep-section">
      <h3 onclick="this.parentElement.classList.toggle('collapsed')" aria-expanded="true">SUGGESTED AGENDA</h3>
      <div class="prep-section-body">
        ${agenda.length > 0 ? agenda.map((a, i) => `
          <div class="agenda-item">
            <span class="agenda-number">${i + 1}.</span>
            <span class="agenda-topic">${escapeHtml(a.topic)}</span>
            <div class="agenda-bar" style="width: ${Math.round((a.minutes / maxMin) * 120)}px;"></div>
            <span class="agenda-time">${a.minutes} min</span>
          </div>
          ${a.notes ? '<div class="agenda-notes">' + escapeHtml(a.notes) + '</div>' : ''}
        `).join('') : '<div style="color: #8b949e; font-size: 13px;">No agenda generated</div>'}
        ${agenda.length > 0 ? `<div class="agenda-total">Estimated: ${totalMin} minutes</div>` : ''}
      </div>
    </div>
  `;

  html += '</div>';
  panel.innerHTML = html;
}

function renderPrepSubsection(title, items, cssClass, renderFn) {
  return `
    <div class="prep-subsection">
      <h4>${escapeHtml(title)} (${items?.length || 0})</h4>
      ${items?.length > 0
        ? items.map(i => `<div class="prep-item ${cssClass}"><span class="item-title">${renderFn(i)}</span></div>`).join('')
        : '<div style="font-size: 12px; color: #6e7681; padding-left: 12px;">(none)</div>'}
    </div>
  `;
}
```

### STEP 4: Modify `init()` Function

Update the existing `init()` function to add tab initialization at the end:

```javascript
async function init() {
  await loadStats();
  await loadClients();
  await loadOwners();
  await renderWeekPills();
  await loadMeetings();

  // Create owners datalist
  const datalist = document.createElement('datalist');
  datalist.id = 'ownersList';
  owners.forEach(owner => {
    const opt = document.createElement('option');
    opt.value = owner;
    datalist.appendChild(opt);
  });
  document.body.appendChild(datalist);

  // Initialize tab from URL hash
  initTabFromHash();
}
```

The only change is adding `initTabFromHash();` at the end of `init()`.

---

## Files to Create

None.

## Files to Modify

- `public/index.html` — **Single file**, all CSS/HTML/JS changes described above

## Do NOT Touch

- `src/api/routes.js` — All 14 endpoints already exist
- `src/lib/` — No backend changes needed
- `src/poll.js` / `src/service.js` — Pipeline unchanged
- `src/config/` — No config changes
- `ecosystem.config.cjs` — No PM2 changes

## Acceptance Criteria

- [ ] Tab navigation visible: Meetings | Roadmap | Meeting Prep
- [ ] Meetings tab works exactly as before (zero regression)
- [ ] Tab switching via click and URL hash (`#roadmap`, `#prep`)
- [ ] Stats bar hides on non-meetings tabs

**Roadmap:**
- [ ] Client dropdown populated, selecting loads data
- [ ] Cards render with colored category badge, status badge, owner, staleness
- [ ] Status/category/owner filter pills work (client-side)
- [ ] Stats bar shows counts: total, agreed, in-progress, done, blocked, stale, completion%
- [ ] Status dropdown changes status via API, updates in-place
- [ ] Edit overlay saves title/owner/due_date via PUT API
- [ ] Timeline toggle shows snapshot table with status dots
- [ ] Toast on status change and edit

**Meeting Prep:**
- [ ] Client dropdown syncs with Roadmap tab selection
- [ ] "Generate Fresh Prep" calls API with spinner, renders 4-section document
- [ ] All 4 sections render: Status Report, Accountability, Strategic Direction, Agenda
- [ ] Prep sections are collapsible (click h3)
- [ ] Agenda shows time bars and total estimate
- [ ] Prep History lists saved preps, click loads them
- [ ] "Post to Slack" calls API with confirmation toast
- [ ] Fallback warning shown when `meta.fallback` is true
- [ ] Empty states for no client selected, no preps saved

## Smoke Tests

```bash
# Test 1: Tab navigation exists
curl -s http://localhost:3875/zoom/ | grep -c 'switchTab'
# Expected: >= 3

# Test 2: Roadmap view HTML present
curl -s http://localhost:3875/zoom/ | grep -c 'roadmapView'
# Expected: >= 1

# Test 3: Prep view HTML present
curl -s http://localhost:3875/zoom/ | grep -c 'prepView'
# Expected: >= 1

# Test 4: JS functions exist
curl -s http://localhost:3875/zoom/ | grep -c 'loadRoadmap\|renderRoadmapCards\|renderPrepDocument'
# Expected: >= 3

# Test 5: Category colors defined
curl -s http://localhost:3875/zoom/ | grep -c 'CATEGORY_COLORS'
# Expected: >= 1

# Test 6: Timeline renderer
curl -s http://localhost:3875/zoom/ | grep -c 'renderRoadmapTimeline'
# Expected: >= 1

# Test 7: Prep generator function
curl -s http://localhost:3875/zoom/ | grep -c 'generatePrep'
# Expected: >= 2

# Test 8: API still works (no regression)
curl -s http://localhost:3875/zoom/api/stats | python3 -c "import sys,json; d=json.load(sys.stdin); print('meetings:', d.get('meetings_total','?'))"
# Expected: meetings: 7+

# Test 9: Roadmap API works
curl -s http://localhost:3875/zoom/api/roadmap/prosper-group | python3 -c "import sys,json; d=json.load(sys.stdin); print('items:', len(d.get('items',[])))"
# Expected: items: 10

# Test 10: External access
curl -s https://www.manuelporras.com/zoom/ | grep -c 'switchTab'
# Expected: >= 1
```

## Completion Instructions

1. Insert CSS at end of `<style>` block
2. Modify HTML structure: add tab-nav, wrap existing main, add roadmap + prep views
3. Insert JS before `init()` call
4. Add `initTabFromHash()` to end of existing `init()` function
5. Run all smoke tests
6. Verify in browser: switch tabs, load roadmap for prosper-group, generate prep
7. Verify no console errors
8. Write result to `.planning/phases/10-roadmap-prep-dashboard/result.md`
9. Commit with prefix: `[zoom-pipeline-10]`
