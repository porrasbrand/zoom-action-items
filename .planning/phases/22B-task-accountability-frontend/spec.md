# Phase 22B: Task Accountability Frontend — Universal Dashboard

## Objective
Redesign the "PPC Tasks" tab into a universal "Task Accountability" tab that covers all 591 action items across 9 categories, with category pills, "My Tasks" owner button, default to last-14-days + missing-only, Recent Meetings sub-view, and stale task indicators.

## Prior Work Summary
- Phase 22A: Extended DB schema, trackability classification, embedding cache, universal ProofHub matching
- Phase 21B: Expandable 3-level cards (collapse → detail → evidence) — reuse as-is
- Phase 21C: ProofHub status sync (on-demand refresh) — works for all task types
- Phase 21D: Confidence thresholds (HIGH=accept, MEDIUM=flag, LOW=reject)
- `ppc_task_tracking` now has: category, trackable, embedding_score, match_method columns
- 591 total rows: ~350 trackable, ~150 not_applicable, all with ProofHub match status

## Deliverables

### 1. Rename tab and update navigation

In `public/index.html`:
- Change tab button text from "PPC Tasks" to "Task Accountability"
- Change `data-tab="ppc"` to `data-tab="tasks"` (or keep ppc internally, just change label)
- Update all CSS class references if renamed

### 2. Category pills

Add horizontal pill bar below the tab header:

```html
<div class="task-category-pills">
  <button class="pill active" data-category="all">ALL <span class="pill-count">42</span></button>
  <button class="pill" data-category="ads">PPC <span class="pill-count">8</span></button>
  <button class="pill" data-category="content">Content <span class="pill-count">6</span></button>
  <button class="pill" data-category="admin">Admin <span class="pill-count">12</span></button>
  <button class="pill" data-category="follow-up">Follow-up <span class="pill-count">5</span></button>
  <button class="pill" data-category="deliverable">Deliverable <span class="pill-count">7</span></button>
  <button class="pill" data-category="dev">Dev <span class="pill-count">3</span></button>
  <button class="pill" data-category="design">Design <span class="pill-count">1</span></button>
  <button class="pill" data-category="seo">SEO <span class="pill-count">0</span></button>
</div>
```

**Counts show ACTIONABLE items (missing + needs_review), not totals.** This is critical — "Content 6" means 6 tasks needing attention, not 101 total.

**Category colors (pill background on active):**
```css
.pill[data-category="ads"]         { --pill-color: #4285F4; } /* Blue */
.pill[data-category="content"]     { --pill-color: #7B1FA2; } /* Purple */
.pill[data-category="admin"]       { --pill-color: #6B7280; } /* Gray */
.pill[data-category="follow-up"]   { --pill-color: #F59E0B; } /* Orange */
.pill[data-category="deliverable"] { --pill-color: #10B981; } /* Green */
.pill[data-category="dev"]         { --pill-color: #06B6D4; } /* Cyan */
.pill[data-category="design"]      { --pill-color: #EC4899; } /* Pink */
.pill[data-category="seo"]         { --pill-color: #D97706; } /* Amber */
```

### 3. "My Tasks" owner button

Prominent button next to category pills (or in the filter bar):

```html
<button class="my-tasks-btn" onclick="toggleMyTasks()">
  👤 My Tasks
</button>
```

When active:
- Filters to tasks owned by the logged-in user (detect from auth session)
- Shows personal accountability rate in the scorecard
- Highlighted state (blue border)

For now, since we know Phil is the primary user, default "My Tasks" to filter by "Philip Mutrie". In the future, detect from the auth session.

### 4. Default view: Last 14 days + missing/needs_review only

On tab load:
- Date filter defaults to "Last 14 days"
- Status filter defaults to "Missing + Needs Review" (hide confirmed matches)
- Category defaults to "ALL"
- This shows ~20-30 actionable items, not 591

Add "Show All" toggle button that removes both filters:
```html
<button class="show-all-btn" onclick="toggleShowAll()">Show All Tasks</button>
```

### 5. Updated accountability scorecard

```html
<div class="task-scorecard">
  <div class="stat-card">
    <div class="value">{total_trackable}</div>
    <div class="label">Trackable Tasks</div>
  </div>
  <div class="stat-card green">
    <div class="value">{high_matches}</div>
    <div class="label">In ProofHub</div>
  </div>
  <div class="stat-card yellow">
    <div class="value">{needs_review}</div>
    <div class="label">Needs Review</div>
  </div>
  <div class="stat-card red">
    <div class="value">{missing}</div>
    <div class="label">Missing</div>
  </div>
  <div class="stat-card">
    <div class="value">{rate}%</div>
    <div class="label">Accountability Rate</div>
  </div>
  <div class="stat-card muted">
    <div class="value">{not_applicable}</div>
    <div class="label">N/A (not trackable)</div>
  </div>
</div>
```

Scorecard updates when category pill or owner filter changes.

### 6. Updated filter controls

```html
<div class="task-filters">
  <select id="taskFilterStatus">
    <option value="actionable">Missing + Needs Review</option>
    <option value="all">All Status</option>
    <option value="missing">❌ Missing</option>
    <option value="needs_review">⚠️ Needs Review</option>
    <option value="confirmed">✅ In ProofHub</option>
    <option value="not_applicable">N/A (not trackable)</option>
  </select>
  <select id="taskFilterClient">{client options}</select>
  <select id="taskFilterOwner">{owner options}</select>
  <select id="taskFilterPriority">
    <option value="all">All Priority</option>
    <option value="high">High</option>
    <option value="medium">Medium</option>
    <option value="low">Low</option>
  </select>
  <select id="taskFilterDate">
    <option value="14">Last 14 days</option>
    <option value="30">Last 30 days</option>
    <option value="60">Last 60 days</option>
    <option value="all">All time</option>
  </select>
  <input type="text" id="taskSearch" placeholder="Search tasks...">
</div>
<div class="task-count">Showing {filtered} of {total} tasks</div>
```

### 7. Category badge on cards

For non-PPC tasks, show category badge instead of platform badge:

```javascript
function getCategoryBadge(task) {
  if (task.category === 'ads' && task.platform) {
    // PPC task — show platform badge (existing behavior)
    return `<span class="platform-badge ${task.platform}">${platformLabel(task.platform)}</span>`;
  }
  // Non-PPC — show category badge
  return `<span class="category-badge ${task.category}">${task.category}</span>`;
}
```

### 8. Stale task indicator

Tasks from >14 days ago that are still "missing":

```css
.task-card.stale {
  opacity: 0.6;
}
.stale-badge {
  font-size: 10px;
  color: #6e7681;
  background: #21262d;
  padding: 2px 6px;
  border-radius: 3px;
}
```

```javascript
const isStale = task.days_ago > 14 && task.proofhub_match !== 1;
```

### 9. Not-applicable tasks display

Tasks classified as `not_applicable` show differently:

```css
.task-card.not-applicable {
  opacity: 0.5;
  border-left-color: #30363d;
}
.na-badge {
  font-size: 10px;
  color: #6e7681;
  font-style: italic;
}
```

Hidden by default (status filter = "Missing + Needs Review"). Only visible when "All Status" or "N/A" filter selected.

### 10. Recent Meetings sub-view

Add a toggle between "Task List" and "By Meeting" views:

```html
<div class="view-toggle">
  <button class="active" onclick="showTaskList()">Task List</button>
  <button onclick="showByMeeting()">By Meeting</button>
</div>
```

**By Meeting view:**
```
Last 5 meetings:
┌──────────────────────────────────────────────────────┐
│ Legendary Service — Apr 2 — Sean/Joe                  │
│ 7 action items: 2 ✅ in PH | 1 ⚠️ review | 4 ❌    │
│ [Expand to see all items]                             │
├──────────────────────────────────────────────────────┤
│ Vision Flooring — Mar 19 — Phil/Dan                   │
│ 5 action items: 1 ✅ in PH | 0 ⚠️ review | 4 ❌    │
│ [Expand to see all items]                             │
└──────────────────────────────────────────────────────┘
```

This needs a new API endpoint or modification to existing ones to group tasks by meeting.

### 11. API changes in `src/api/routes.js`

**Update GET /api/ppc/status** to return universal stats:
```javascript
{
  total_tasks: 591,
  total_trackable: 350,
  not_applicable: 156,
  in_proofhub: 31,        // HIGH + human-verified only
  needs_review: 8,         // MEDIUM
  missing: 311,            // trackable but no match
  accountability_rate: 9,  // (in_proofhub / total_trackable) * 100
  by_category: {
    ads: { total: 107, trackable: 95, matched: 8, missing: 87 },
    content: { total: 101, trackable: 68, matched: 5, missing: 63 },
    ...
  },
  period_days: 14  // or whatever filter is active
}
```

**Update GET /api/ppc/tracked** to support category filter:
```
GET /api/ppc/tracked?category=content&days=14&owner=Philip+Mutrie
```

**New GET /api/ppc/by-meeting** — group tasks by meeting:
```javascript
{
  meetings: [
    {
      meeting_id: 96,
      topic: "Legendary Service | Sean/Joe",
      client_name: "Legendary Service",
      meeting_date: "2026-04-02",
      total_items: 7,
      in_proofhub: 2,
      needs_review: 1,
      missing: 4,
      tasks: [...]
    },
    ...
  ]
}
```

## File Changes

| File | Changes |
|------|---------|
| `src/api/routes.js` | Update /ppc/status, /ppc/tracked, /ppc/at-risk to support category/owner/priority/date filters. Add /ppc/by-meeting endpoint. |
| `public/index.html` | Rename tab, category pills, "My Tasks" button, default filters, scorecard update, category badges, stale/NA indicators, By Meeting view, filter controls. ~500 lines CSS + JS. |

## Smoke Tests

```bash
# 1. API: status with categories
curl /api/ppc/status
# Expected: by_category object with all 9 categories

# 2. API: tracked with category filter
curl /api/ppc/tracked?category=content
# Expected: only content tasks returned

# 3. API: tracked with owner filter
curl "/api/ppc/tracked?owner=Philip+Mutrie"
# Expected: only Phil's tasks

# 4. API: by-meeting endpoint
curl /api/ppc/by-meeting?days=14
# Expected: meetings with per-meeting task counts

# 5. Visual: tab renamed to "Task Accountability"
# 6. Visual: category pills render with actionable counts
# 7. Visual: "My Tasks" button filters to Phil's tasks
# 8. Visual: default view shows last 14 days, missing + needs review only
# 9. Visual: non-PPC tasks show category badges (not platform)
# 10. Visual: N/A tasks are hidden by default, visible with filter
# 11. Visual: "By Meeting" view groups tasks by meeting
# 12. Visual: stale tasks (>14d) show faded with badge
```

## Important Notes

- Keep all existing PPC card functionality (expandable, detail, evidence, disposition, refresh)
- Category pills are client-side filtering (no API calls per click)
- "My Tasks" initially hardcoded to "Philip Mutrie" — future: detect from auth
- The "By Meeting" view reuses the same card components, just grouped differently
- N/A tasks don't count toward accountability rate
- Scorecard numbers update reactively when filters change
- Mobile: pills scroll horizontally, filters stack vertically
