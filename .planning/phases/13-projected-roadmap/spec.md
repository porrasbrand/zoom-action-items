# Phase 13: Projected Roadmap & Pre-Huddle Brief

## Context

The meeting prep system (Phase 08B) generates a 4-section briefing document for Phil before client meetings: Status Report, Accountability Check, Strategic Direction, and Suggested Agenda. This works well for reviewing "where are we" but is missing two things:

1. **Projected Roadmap (Section 5)** — Specific NEW roadmap items Phil can proactively propose to the client. Not generic recommendations (which Section 3 already does), but detailed proposals with effort estimates, prerequisites, and "why now" reasoning that Phil can pitch — even when Dan isn't on the call.

2. **Pre-Huddle Brief** — A one-page cheat sheet format for Phil's 2-minute prep before the client joins. The full prep document is too long to scan quickly.

### What We Learned From Transcript Analysis

From analyzing 4 Prosper Group transcripts:
- Dan is the strategic brain who proposes new directions. Phil manages execution.
- When Dan isn't on the call, no proactive proposals happen.
- Phil preps from memory in the pre-huddle — no structured document.
- Pre-huddles degraded over 4 weeks (7 min → 0 min).
- The Projected Roadmap should systematize what Dan does naturally so Phil can do it too.

### Current System (files on Hetzner at ~/awsc-new/awesome/zoom-action-items/)

**Data already collected by `prep-collector.js`:**
- `client` — name, industry, services_active, services_available, b3x_lead, meeting_cadence
- `roadmap.active` — all non-done/dropped items with status, owner, category, silent_count
- `roadmap.stale` — items with meetings_silent_count >= 2
- `roadmap.recently_completed` — items done in last 30 days
- `roadmap.blocked` — blocked items
- `roadmap.stats` — counts (total, done, in_progress, blocked, agreed, stale)
- `meetings.recent` — last 3 meetings with AI summaries
- `service_gaps` — services_available minus services_active
- `taxonomy` — 10 categories, 35 task types

**Current Gemini prompt in `prep-generator.js`:**
- Model: `gemini-3-flash-preview`
- Produces JSON with: status_report, accountability, strategic_direction, suggested_agenda, estimated_meeting_length_minutes
- The `strategic_direction` section already recommends next steps but they're framed as general recommendations, not as pitchable roadmap items with effort/prerequisites

**Formatter in `prep-formatter.js`:**
- `formatAsMarkdown(prep)` — full text document
- `formatForSlack(prep)` — Slack-compatible version
- Both export via `export default { formatAsMarkdown, formatForSlack }`

**API endpoints in `routes.js`:**
```
GET  /api/prep/:clientId              → generate fresh prep (JSON)
GET  /api/prep/:clientId/markdown     → generate fresh prep (Markdown)
POST /api/prep/:clientId/slack        → generate and post to Slack
GET  /api/prep/history/:clientId      → list saved preps
GET  /api/prep/saved/:filename        → retrieve saved prep
```

---

## Implementation

### 1. Update Gemini Prompt — Add Section 5 (`prep-generator.js`)

Add a 5th section to the INSTRUCTIONS block in the existing prompt. Insert after the SECTION 4 instructions:

```
SECTION 5 - PROJECTED ROADMAP (New items to propose to client):
- Based on completed work, service gaps, industry patterns, and meeting history, propose 3-5 SPECIFIC new roadmap items that B3X should pitch to the client in the next meeting.
- These are NOT items already on the roadmap. They are NEW proposals.
- Each item must be concrete enough that Phil can present it as: "Here's what we recommend we add to our plan."
- For each proposed item:
  - title: Clear, specific task name (not generic like "improve SEO")
  - why_now: Connect to a specific trigger — a completed prerequisite, a seasonal opportunity, a service gap, or something the client mentioned in recent meetings
  - category and task_type: From the taxonomy
  - effort_b3x: Estimated B3X hours (e.g., "4hrs setup", "8hrs/month ongoing")
  - effort_client: What the client needs to provide or approve
  - prerequisites: What must be done first (reference roadmap items by title if applicable), or "None — can start immediately"
  - impact: Expected outcome in plain language
  - priority: QUICK_WIN (small effort, fast result) | GROWTH (medium effort, scaling) | STRATEGIC (larger effort, long-term positioning)
- Prioritize: QUICK_WINs first, then GROWTH, then STRATEGIC
- Do NOT repeat items that are already active on the roadmap
- Ground every proposal in data from the roadmap, service gaps, or meeting context — no generic filler
```

Add to the JSON output schema:

```json
"projected_roadmap": [
  {
    "title": "...",
    "why_now": "...",
    "category": "...",
    "task_type": "...",
    "effort_b3x": "...",
    "effort_client": "...",
    "prerequisites": "...",
    "impact": "...",
    "priority": "QUICK_WIN | GROWTH | STRATEGIC"
  }
]
```

### 2. Update Default/Fallback Prep (`prep-generator.js`)

Add a `projected_roadmap` array to the `getDefaultPrep()` function that generates basic proposals from service gaps:

```javascript
projected_roadmap: service_gaps.map(gap => ({
  title: `Activate ${gap} service`,
  why_now: `${gap} is available but not active for this client`,
  category: gap,
  task_type: 'general',
  effort_b3x: 'TBD',
  effort_client: 'Approval needed',
  prerequisites: 'None',
  impact: 'Expand marketing footprint',
  priority: 'GROWTH'
})).slice(0, 3)
```

### 3. Add `formatBrief()` to `prep-formatter.js`

A new export function that produces the pre-huddle cheat sheet from a prep JSON:

```javascript
export function formatBrief(prep) {
  const meta = prep.meta || {};
  const sr = prep.status_report || {};
  const acc = prep.accountability || {};
  const proj = prep.projected_roadmap || [];
  const agenda = prep.suggested_agenda || [];

  const lines = [];

  // Header
  lines.push(`${meta.client_name || 'Client'} — Pre-Huddle Brief`);
  lines.push(`Date: ${new Date().toISOString().split('T')[0]}`);
  lines.push(`Days since last meeting: ${meta.days_since_last_meeting || '?'}`);
  lines.push('');

  // Wins
  const wins = sr.completed || [];
  lines.push(`WINS TO REPORT: ${wins.length}`);
  wins.forEach(w => lines.push(`  + ${w.title}`));
  lines.push('');

  // Blockers
  const blockers = [...(sr.needs_client_action || [])];
  lines.push(`BLOCKERS TO RAISE: ${blockers.length}`);
  blockers.forEach(b => lines.push(`  ! ${b.title} (${b.reason})`));
  lines.push('');

  // Stale
  const stale = acc.stale_items || [];
  lines.push(`STALE — MUST ADDRESS: ${stale.length}`);
  stale.forEach(s => lines.push(`  !! ${s.title} (silent ${s.silent_meetings} meetings)`));
  lines.push('');

  // B3X Overdue
  const b3xOverdue = acc.b3x_overdue || [];
  if (b3xOverdue.length > 0) {
    lines.push(`B3X OVERDUE: ${b3xOverdue.length}`);
    b3xOverdue.forEach(o => lines.push(`  > ${o.title} — ${o.owner}`));
    lines.push('');
  }

  // Projected proposals (top 3)
  const topProposals = proj.slice(0, 3);
  if (topProposals.length > 0) {
    lines.push(`PHIL'S PITCH:`);
    topProposals.forEach(p => lines.push(`  >> [${p.priority}] ${p.title}`));
    lines.push('');
  }

  // One-liner agenda summary
  if (agenda.length > 0) {
    const totalMin = prep.estimated_meeting_length_minutes || agenda.reduce((s, a) => s + (a.minutes || 0), 0);
    lines.push(`AGENDA: ${agenda.length} items, ${totalMin} min`);
    agenda.forEach(a => lines.push(`  ${a.minutes}m — ${a.topic}`));
  }

  return lines.join('\n');
}
```

Update the default export:
```javascript
export default {
  formatAsMarkdown,
  formatForSlack,
  formatBrief
};
```

### 4. Update `formatAsMarkdown()` — Add Section 5

After the Section 4 (Suggested Agenda) rendering, add:

```javascript
// Section 5: Projected Roadmap
lines.push('━━━ SECTION 5: PROJECTED ROADMAP (What to propose next) ━━━');
lines.push('');

const projected = prep.projected_roadmap || [];
if (projected.length > 0) {
  for (let i = 0; i < projected.length; i++) {
    const p = projected[i];
    lines.push(`  ${i + 1}. [${p.priority}] ${p.title}`);
    lines.push(`     Why now: ${p.why_now}`);
    lines.push(`     B3X effort: ${p.effort_b3x}`);
    lines.push(`     Client needs: ${p.effort_client}`);
    lines.push(`     Prerequisites: ${p.prerequisites}`);
    lines.push(`     Impact: ${p.impact}`);
    lines.push(`     Category: ${p.category}/${p.task_type || 'general'}`);
    lines.push('');
  }
} else {
  lines.push('  (No projected items generated)');
  lines.push('');
}
```

### 5. Add API Endpoint — `/api/prep/:clientId/brief` (`routes.js`)

Add after the existing prep endpoints:

```javascript
// GET /api/prep/:clientId/brief - Generate pre-huddle brief (returns text)
router.get('/prep/:clientId/brief', async (req, res) => {
  try {
    const prepData = await collectPrepData(getDatabase(), req.params.clientId);
    const result = await generateMeetingPrep(prepData);
    const brief = formatBrief(result.json);
    res.type('text/plain').send(brief);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

Import `formatBrief` at the top of routes.js — update the existing import:
```javascript
import { formatAsMarkdown, formatForSlack, formatBrief } from '../lib/prep-formatter.js';
```

### 6. Update Dashboard — Add Brief Tab in Meeting Prep View (`public/index.html`)

In the Meeting Prep tab's left panel, add a "Brief" button next to "Generate Fresh Prep":

```html
<button class="prep-btn brief" id="generateBriefBtn" onclick="generateBrief()" disabled>
  Pre-Huddle Brief
</button>
```

Add JS function:
```javascript
async function generateBrief() {
  if (!sharedClientId) return;
  const panel = document.getElementById('prepRightPanel');
  panel.innerHTML = '<div class="prep-spinner"><div class="spinner-icon" aria-hidden="true">&#9881;</div><p>Generating brief...</p></div>';

  try {
    const res = await fetch(`${API}/prep/${sharedClientId}/brief`);
    if (!res.ok) throw new Error('Failed');
    const text = await res.text();
    panel.innerHTML = `<div class="prep-document"><pre style="white-space: pre-wrap; font-family: monospace; font-size: 13px; color: #c9d1d9; line-height: 1.6;">${escapeHtml(text)}</pre></div>`;
  } catch (err) {
    panel.innerHTML = '<div class="prep-empty"><h3>Failed to generate brief</h3></div>';
    showToast('Brief generation failed', true);
  }
}
```

Also update the `renderPrepDocument()` function to render Section 5 (Projected Roadmap) in the full prep view. Add after the agenda section rendering:

```javascript
// Section 5: Projected Roadmap
const projected = prep.projected_roadmap || [];
html += `
  <div class="prep-section">
    <h3 onclick="this.parentElement.classList.toggle('collapsed')" aria-expanded="true">PROJECTED ROADMAP — What to Propose</h3>
    <div class="prep-section-body">
      ${projected.length > 0 ? projected.map((p, i) => `
        <div class="prep-recommendation">
          <span class="priority ${(p.priority || 'growth').toLowerCase().replace('_','-')}">${escapeHtml(p.priority || 'GROWTH')}</span>
          <span class="rec-title">${escapeHtml(p.title)}</span>
          <div class="rec-reasoning"><strong>Why now:</strong> ${escapeHtml(p.why_now)}</div>
          <div style="font-size: 12px; color: #8b949e; margin-top: 4px; line-height: 1.6;">
            <strong>B3X effort:</strong> ${escapeHtml(p.effort_b3x)}<br>
            <strong>Client needs:</strong> ${escapeHtml(p.effort_client)}<br>
            <strong>Prerequisites:</strong> ${escapeHtml(p.prerequisites)}<br>
            <strong>Impact:</strong> ${escapeHtml(p.impact)}
          </div>
          <div class="rec-category">${escapeHtml(p.category || '')}${p.task_type ? ' / ' + escapeHtml(p.task_type) : ''}</div>
        </div>
      `).join('') : '<div style="color: #8b949e; font-size: 13px;">No projected items</div>'}
    </div>
  </div>
`;
```

Add CSS for the new priority type:
```css
.prep-recommendation .priority.quick-win { background: rgba(59,185,80,0.2); color: #3fb950; }
.prep-recommendation .priority.growth { background: rgba(210,153,34,0.2); color: #d29922; }
.prep-recommendation .priority.strategic { background: rgba(188,140,255,0.2); color: #bc8cff; }
```

And CSS for the brief button:
```css
.prep-btn.brief {
  background: #21262d;
  color: #58a6ff;
  border: 1px solid #58a6ff;
}
.prep-btn.brief:hover {
  background: #161b22;
}
.prep-btn.brief:disabled {
  color: #484f58;
  border-color: #30363d;
  cursor: not-allowed;
}
```

### 7. Enable Brief Button When Client Selected

In the existing `onPrepClientChange()` function, add:
```javascript
document.getElementById('generateBriefBtn').disabled = !clientId;
```

In the `switchTab('prep')` branch, add:
```javascript
document.getElementById('generateBriefBtn').disabled = !sharedClientId;
```

---

## Files to Modify

1. `src/lib/prep-generator.js` — Add Section 5 to prompt + update fallback
2. `src/lib/prep-formatter.js` — Add `formatBrief()` + update `formatAsMarkdown()` with Section 5
3. `src/api/routes.js` — Add `/api/prep/:clientId/brief` endpoint + import formatBrief
4. `public/index.html` — Brief button, `generateBrief()` JS, Section 5 renderer, CSS for priorities + brief button

## Files to Create

None.

## Do NOT Touch

- `src/lib/prep-collector.js` — Data collection is already sufficient
- `src/lib/roadmap-processor.js` — Roadmap engine unchanged
- `src/lib/roadmap-db.js` — DB layer unchanged
- `ecosystem.config.cjs` — No PM2 changes

## Acceptance Criteria

- [ ] Prep generation returns 5 sections (not 4)
- [ ] `projected_roadmap` array has 3-5 items per client
- [ ] Each projected item has: title, why_now, category, task_type, effort_b3x, effort_client, prerequisites, impact, priority
- [ ] Priority values are QUICK_WIN, GROWTH, or STRATEGIC
- [ ] Projected items do NOT duplicate active roadmap items
- [ ] `GET /api/prep/:clientId/brief` returns pre-huddle text format
- [ ] Brief includes: wins count, blockers, stale items, top 3 proposals, agenda summary
- [ ] `formatAsMarkdown()` includes Section 5
- [ ] Dashboard renders Section 5 with priority badges (green/yellow/purple)
- [ ] "Pre-Huddle Brief" button works in dashboard
- [ ] Test with Prosper Group — projected items reference real service gaps and completed work

## Smoke Tests

```bash
cd ~/awsc-new/awesome/zoom-action-items

# 1. Generate prep with projected roadmap
node src/meeting-prep.js --client prosper-group --format json | python3 -c "
import sys, json
d = json.load(sys.stdin)
proj = d.get('projected_roadmap', [])
print('Projected items:', len(proj))
for p in proj:
    print(f'  [{p[\"priority\"]}] {p[\"title\"]}')
    print(f'    Why: {p[\"why_now\"][:80]}...')
"

# 2. Test brief endpoint
curl -s -b "zoom_session=$(node scripts/create-test-session.js 2>/dev/null | grep SESSION_ID | cut -d= -f2)" http://localhost:3875/zoom/api/prep/prosper-group/brief | head -20

# 3. Markdown format has Section 5
node src/meeting-prep.js --client prosper-group | grep -c "PROJECTED ROADMAP"
# Expected: 1

# 4. Dashboard has brief button
grep -c "generateBrief\|Pre-Huddle Brief" public/index.html
# Expected: >= 2

# 5. Projected items use valid taxonomy
node src/meeting-prep.js --client prosper-group --format json | python3 -c "
import sys, json
d = json.load(sys.stdin)
for p in d.get('projected_roadmap', []):
    assert p.get('category'), f'Missing category: {p[\"title\"]}'
    assert p.get('priority') in ['QUICK_WIN','GROWTH','STRATEGIC'], f'Bad priority: {p[\"priority\"]}'
print('All projected items valid')
"
```

## Completion Instructions

1. Modify the 4 files as specified
2. Restart zoom-dashboard PM2 process
3. Run all smoke tests
4. Generate Prosper Group prep and verify Section 5 quality
5. Generate Prosper Group brief and verify format
6. Write result to `.planning/phases/13-projected-roadmap/result.md`
7. Commit with prefix: `[zoom-pipeline-13]`
