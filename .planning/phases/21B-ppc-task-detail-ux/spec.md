# Phase 21B: PPC Task Detail UX — Rich Expandable Cards

## Objective
Redesign the PPC Task Tracker display from flat one-liners into rich, status-first expandable cards with progressive disclosure. Users should immediately see what needs attention, then drill into the full story (transcript → action item → ProofHub match) on demand.

## Prior Work Summary
- Phase 21A built the PPC Task Tracker MVP: classification, ProofHub matching, dashboard tab
- `GET /api/ppc/tracked` endpoint returns matched tasks with ProofHub URLs (joins ppc_task_tracking + ph_task_cache)
- `GET /api/ppc/at-risk` returns unmatched tasks
- `GET /api/ppc/status` returns agency-wide stats
- Frontend: `public/index.html` has PPC tab with overview stats, client cards, tracked list, at-risk list
- Data available per task: transcript_excerpt, task_title, task_description, platform, action_type, owner, priority, due_date, ppc_confidence, proofhub_task_title, proofhub_status, proofhub_created, proofhub_assignee, proofhub_confidence, proofhub_reasoning, completion_score, days_to_proofhub
- ProofHub task cache has: title, stage_name, task_list_name, comments_count, assigned_names, due_date, completed, scope_summary
- Transcript excerpts have speaker attribution: `Speaker Name: "quoted text"`

## Design Principles (from Gemini consultation)
1. **Status-first** — Lead with "what needs attention?", not "what happened?"
2. **Progressive disclosure** — 3 levels, not info dump
3. **Clear CTAs** — Action buttons prominent, not buried
4. **Aggressive simplification** of collapsed state

## Deliverables

### 1. New API endpoint: `GET /api/ppc/task/:id/detail`

Returns full task detail by joining all tables:

```javascript
// Join ppc_task_tracking + meetings (for ai_extraction.action_items[index]) + ph_task_cache
{
  // Core task
  id, task_title, task_description, platform, action_type, owner,
  meeting_id, meeting_date, client_id, client_name,
  ppc_confidence, disposition, disposition_reason,
  
  // From ai_extraction.action_items[action_item_index]
  due_date, priority, category,
  transcript_excerpt,  // speaker-attributed conversation snippet
  
  // ProofHub match
  proofhub_match,
  proofhub_task_id, proofhub_task_title, proofhub_status, proofhub_created,
  proofhub_assignee, proofhub_confidence, proofhub_reasoning,
  completion_score, days_to_proofhub,
  
  // From ph_task_cache (enrichment)
  ph_url,            // clickable ProofHub link
  ph_stage_name,     // "Task Created", "In Progress", "Completed"
  ph_task_list_name, // "Traffic | Campaigns | Reporting"
  ph_comments_count,
  ph_assigned_names, // resolved names if possible
  ph_due_date,
  ph_scope_summary
}
```

Place this route BEFORE the `/ppc/task/:id/disposition` POST route in routes.js.

### 2. Enhance `GET /api/ppc/tracked` and `GET /api/ppc/at-risk`

Add these fields to each task in the response (needed for collapsed card):
- `transcript_excerpt` (from ai_extraction via meetings table)
- `priority` (from ai_extraction)
- `due_date` (from ai_extraction)

This requires joining meetings table and parsing ai_extraction JSON. Do this in the route handler, not in getPPCReport (to keep it simple):

```javascript
// After getting tasks from getPPCReport, enrich each with action item data
for (const task of tasks) {
  const meeting = db.prepare('SELECT ai_extraction FROM meetings WHERE id = ?').get(task.meeting_id);
  if (meeting && meeting.ai_extraction) {
    const extraction = JSON.parse(meeting.ai_extraction);
    const items = extraction.action_items || (extraction[0]?.action_items) || [];
    const item = items[task.action_item_index];
    if (item) {
      task.transcript_excerpt = item.transcript_excerpt || null;
      task.priority = item.priority || null;
      task.due_date = item.due_date || null;
    }
  }
}
```

### 3. Frontend: Redesigned PPC Task Cards

#### Level 1: Collapsed Card (4 elements max)

```html
<div class="ppc-task-card {statusClass}" onclick="expandPPCTask({id})">
  <div class="ppc-task-status">{statusIcon}</div>
  <div class="ppc-task-summary">
    <div class="ppc-task-title">{task_title}</div>
    <div class="ppc-task-meta">{owner} · {relative_date} · {client_name}</div>
  </div>
  <div class="ppc-task-badges">
    <span class="platform-badge {platform}">{platformLabel}</span>
    {proofhub_match ? '<span class="ph-badge">PH</span>' : ''}
  </div>
</div>
```

**Status classes (left border color):**
- `.status-complete` — green border: PH matched + completed
- `.status-tracked` — blue border: PH matched, not completed
- `.status-missing` — red border: not in ProofHub, pending
- `.status-dismissed` — gray border: cancelled/deprioritized

**Status icons:**
- ✅ Complete (PH matched + done)
- ⏳ Tracked (PH matched, in progress)
- ❌ Missing (not in PH)
- ⊘ Dismissed (cancelled/deprioritized)

**Platform badges (color-coded):**
- Google Ads: blue (#4285F4)
- Google LSA: teal (#00897B)
- Meta: purple (#7B1FA2)
- Bing: orange (#F57C00)
- Multiple: gradient
- Unknown: gray

#### Level 2: First Expand (summary + actions)

When card is clicked, expand below it (accordion style, collapse others):

```html
<div class="ppc-task-detail">
  <!-- Action buttons row (TOP, prominent) -->
  <div class="ppc-task-actions">
    {if missing: <button class="btn-create-ph">Create PH Task</button>}
    {if tracked: <button class="btn-mark-complete">Mark Complete</button>}
    <button class="btn-dismiss">Dismiss</button>
    <button class="btn-open-meeting">View Meeting</button>
  </div>
  
  <!-- Two-column: Action Item | ProofHub Match -->
  <div class="ppc-detail-columns">
    <div class="ppc-detail-left">
      <h4>Action Item</h4>
      <div class="detail-field"><label>Description</label>{task_description}</div>
      <div class="detail-field"><label>Platform</label>{platform_label}</div>
      <div class="detail-field"><label>Action Type</label>{action_type}</div>
      <div class="detail-field"><label>Owner</label>{owner}</div>
      <div class="detail-field"><label>Due Date</label>{due_date || 'Not set'}</div>
      <div class="detail-field"><label>Priority</label>{priority badge}</div>
      <div class="detail-field"><label>PPC Confidence</label>{confidence dots}</div>
    </div>
    
    <div class="ppc-detail-right">
      {if matched:}
        <h4>ProofHub Task</h4>
        <div class="detail-field"><label>Title</label><a href="{ph_url}" target="_blank">{proofhub_task_title}</a></div>
        <div class="detail-field"><label>Status</label>{proofhub_status} ({ph_stage_name})</div>
        <div class="detail-field"><label>Created</label>{proofhub_created}</div>
        <div class="detail-field"><label>Task List</label>{ph_task_list_name}</div>
        <div class="detail-field"><label>Assignee</label>{proofhub_assignee || ph_assigned_names}</div>
        <div class="detail-field"><label>Comments</label>{ph_comments_count}</div>
        <div class="detail-field"><label>Match Confidence</label>{confidence dots}</div>
      {else:}
        <h4>Not Found in ProofHub</h4>
        <p>No matching task found within 10 days of meeting.</p>
        <button class="btn-create-ph-large">Create Task in ProofHub</button>
      {/if}
    </div>
  </div>
  
  <!-- Timeline -->
  <div class="ppc-timeline">
    <div class="timeline-point meeting">
      <div class="dot"></div>
      <div class="label">Discussed</div>
      <div class="date">{meeting_date}</div>
    </div>
    <div class="timeline-line {timelineColor}"></div>
    <div class="timeline-point ph {phClass}">
      <div class="dot"></div>
      <div class="label">{matched ? 'PH Created' : 'Not Tracked'}</div>
      <div class="date">{proofhub_created || '—'}</div>
      {days_to_proofhub ? <div class="delta">{days_to_proofhub}d</div> : ''}
    </div>
    <div class="timeline-line {completionColor}"></div>
    <div class="timeline-point completion {completionClass}">
      <div class="dot"></div>
      <div class="label">{proofhub_status === 'complete' ? 'Completed' : 'Pending'}</div>
      <div class="date">{completion_date || '—'}</div>
    </div>
  </div>
  
  <!-- Show Evidence toggle -->
  <button class="btn-show-evidence" onclick="toggleEvidence({id})">
    Show Evidence (Transcript + AI Reasoning)
  </button>
</div>
```

#### Level 3: Evidence Panel (collapsed by default)

```html
<div class="ppc-evidence" id="evidence-{id}" style="display:none">
  <!-- Transcript Excerpt -->
  <div class="evidence-section">
    <h4>📝 Transcript Excerpt</h4>
    <div class="transcript-box">
      {transcript_excerpt formatted with speaker names bolded}
    </div>
  </div>
  
  <!-- AI Match Reasoning (only for matched tasks) -->
  {if matched:}
  <div class="evidence-section">
    <h4>🤖 AI Match Reasoning</h4>
    <div class="reasoning-box">
      {proofhub_reasoning}
    </div>
    <div class="confidence-bar">
      Confidence: {confidence dots ●●●○} {proofhub_confidence}
      · Match Score: {completion_score}%
    </div>
  </div>
  {/if}
</div>
```

### 4. List Controls (sticky header)

Add above the task list:

```html
<div class="ppc-controls">
  <div class="ppc-filters">
    <select id="ppcFilterStatus">
      <option value="all">All Status</option>
      <option value="missing">❌ Missing</option>
      <option value="tracked">⏳ Tracked</option>
      <option value="complete">✅ Complete</option>
      <option value="dismissed">⊘ Dismissed</option>
    </select>
    <select id="ppcFilterClient">
      <option value="all">All Clients</option>
      {clients...}
    </select>
    <select id="ppcFilterPlatform">
      <option value="all">All Platforms</option>
      <option value="google_ads">Google Ads</option>
      <option value="google_lsa">Google LSA</option>
      <option value="meta">Meta</option>
      <option value="bing">Bing</option>
    </select>
    <input type="text" id="ppcSearch" placeholder="Search tasks...">
  </div>
  <div class="ppc-count">Showing {filtered} of {total} tasks</div>
</div>
```

### 5. CSS Additions

Add to the existing PPC CSS section in index.html:

- `.ppc-task-card` — collapsed card with left border color, hover effect, cursor pointer
- `.ppc-task-card.status-complete` / `.status-tracked` / `.status-missing` / `.status-dismissed`
- `.ppc-task-status` — status icon column (fixed width)
- `.platform-badge.google_ads` / `.google_lsa` / `.meta` / `.bing`
- `.ppc-task-detail` — expanded panel, slide-down animation
- `.ppc-task-actions` — button row at top of expanded panel
- `.ppc-detail-columns` — CSS grid, 2 columns (1fr 1fr), gap 24px
- `.ppc-timeline` — horizontal flexbox with dots and lines
- `.timeline-point .dot` — colored circles (12px)
- `.timeline-line` — connecting line between dots (colored by speed)
- `.ppc-evidence` — collapsible evidence section
- `.transcript-box` — styled quote box with speaker names bold, monospace-ish
- `.reasoning-box` — italic, lighter color, AI-generated feel
- `.confidence-dots` — ●●●○ visualization
- `.ppc-controls` — sticky filter bar
- `.ppc-filters select, input` — dark theme inputs matching existing dashboard

### 6. Disposition Modal

When user clicks "Dismiss", show a small modal:

```html
<div class="disposition-modal">
  <h4>Dismiss Task</h4>
  <select>
    <option value="cancelled">Cancelled — client changed mind</option>
    <option value="deprioritized">Deprioritized — will do later</option>
    <option value="blocked">Blocked — waiting on something</option>
  </select>
  <textarea placeholder="Reason (optional)"></textarea>
  <button onclick="submitDisposition(id)">Confirm</button>
  <button onclick="closeModal()">Cancel</button>
</div>
```

This calls `POST /api/ppc/task/:id/disposition` which already exists.

## File Changes

| File | Changes |
|------|---------|
| `src/api/routes.js` | +1 new endpoint (GET /ppc/task/:id/detail), enhance /ppc/tracked and /ppc/at-risk with transcript_excerpt |
| `public/index.html` | Replace PPC tracked/at-risk list rendering with new card components, add CSS (~200 lines), add JS functions (~300 lines) |

## Smoke Tests

```bash
# 1. New detail endpoint
curl http://localhost:3875/zoom/api/ppc/task/1/detail
# Expected: full task detail with transcript_excerpt, ph_task_list_name, proofhub_reasoning

# 2. Enhanced tracked endpoint
curl http://localhost:3875/zoom/api/ppc/tracked
# Expected: tasks now include transcript_excerpt, priority, due_date

# 3. Enhanced at-risk endpoint  
curl http://localhost:3875/zoom/api/ppc/at-risk
# Expected: tasks now include transcript_excerpt, priority, due_date

# 4. Visual: collapsed cards render with status icons and platform badges
# 5. Visual: clicking a card expands to Level 2 (detail + actions + timeline)
# 6. Visual: "Show Evidence" reveals Level 3 (transcript + AI reasoning)
# 7. Visual: filters work (status, client, platform, search)
# 8. Visual: disposition modal works and updates task status
# 9. Visual: ProofHub links are clickable and open correct task
```

## Important Notes

- Keep the existing PPC overview (stats grid, funnel, client cards) as-is — only replace the task lists
- The `/ppc/task/:id/detail` endpoint parses ai_extraction JSON server-side to extract the specific action item
- Transcript excerpt formatting: split on `\n`, bold speaker names (text before first `:`)
- Confidence dots: high=●●●○, medium=●●○○, low=●○○○
- Timeline colors: green (<2 days), yellow (3-7 days), red (>7 days), gray (not tracked)
- All new CSS must use the existing dark theme (#0d1117 background, #f0f6fc text, etc.)
- Accordion behavior: only one task expanded at a time (clicking another closes the first)
- "Create PH Task" button is placeholder for now (future phase) — just show it disabled with tooltip
