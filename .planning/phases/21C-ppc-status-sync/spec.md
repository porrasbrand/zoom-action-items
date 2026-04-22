# Phase 21C: PPC ProofHub Status Sync — On-Demand Re-Check

## Objective
Keep PPC task statuses in sync with ProofHub. Currently we check once and never re-check — completed tasks still show as "incomplete" forever. Add on-demand background refresh triggered when users view the PPC tab, plus single-task refresh and Slack notifications on completion.

## Prior Work Summary
- Phase 21A: PPC Task Tracker MVP — classifies PPC tasks, matches to ProofHub, stores in `ppc_task_tracking`
- Phase 21B: Rich expandable cards with 3-level progressive disclosure
- `ppc_task_tracking` has `proofhub_status`, `last_checked`, `proofhub_task_id` fields
- `ph_task_cache` already caches PH tasks (synced by `ph-reconciler.js` on dashboard startup)
- ProofHub API: REST, `X-API-KEY` auth, ~1 req/sec rate limit
- Base URL: `https://breakthrough3x.proofhub.com/api/v3`
- Headers: `{ 'X-API-KEY': process.env.PROOFHUB_API_KEY, 'User-Agent': 'zoom-action-items' }`
- Currently ~15 matched PPC tasks, growing as new meetings are processed

## Deliverables

### 1. New function in `src/lib/ppc-task-tracker.js`: `refreshPPCStatuses(db)`

```javascript
// In-memory lock to prevent concurrent refreshes
let refreshInProgress = null;
let lastRefreshTime = null;
const REFRESH_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

export async function refreshPPCStatuses(db) {
  // 1. Check cooldown — if last refresh < 1 hour ago, return cached result
  if (lastRefreshTime && (Date.now() - lastRefreshTime) < REFRESH_COOLDOWN_MS) {
    return { skipped: true, reason: 'cooldown', last_refresh: lastRefreshTime };
  }
  
  // 2. Debounce — if refresh already in progress, return existing promise
  if (refreshInProgress) {
    return refreshInProgress;
  }
  
  // 3. Run refresh
  refreshInProgress = _doRefresh(db);
  try {
    const result = await refreshInProgress;
    lastRefreshTime = Date.now();
    return result;
  } finally {
    refreshInProgress = null;
  }
}

async function _doRefresh(db) {
  // Get all incomplete matched tasks
  const tasks = db.prepare(`
    SELECT id, proofhub_task_id, proofhub_status, proofhub_task_title,
           client_name, task_title, meeting_date
    FROM ppc_task_tracking 
    WHERE proofhub_match = 1 AND proofhub_status != 'complete'
  `).all();
  
  const updated = [];
  let apiCalls = 0;
  
  for (const task of tasks) {
    // Step A: Check ph_task_cache first (FREE — no API call)
    const cached = db.prepare(`
      SELECT completed, completed_at, stage_name 
      FROM ph_task_cache WHERE ph_task_id = ?
    `).get(parseInt(task.proofhub_task_id));
    
    if (cached && cached.completed === 1) {
      // Cache says complete — update ppc_task_tracking
      db.prepare(`
        UPDATE ppc_task_tracking 
        SET proofhub_status = 'complete', last_checked = datetime('now')
        WHERE id = ?
      `).run(task.id);
      updated.push({
        task_id: task.id,
        task_title: task.task_title,
        client_name: task.client_name,
        old_status: 'incomplete',
        new_status: 'complete',
        source: 'cache'
      });
      continue;
    }
    
    // Step B: Cache doesn't know — hit ProofHub API directly
    // Use the existing proofhub-client or raw fetch
    try {
      // Need project_id and task_list_id from cache to construct API URL
      const cacheInfo = db.prepare(`
        SELECT project_id, task_list_id FROM ph_task_cache WHERE ph_task_id = ?
      `).get(parseInt(task.proofhub_task_id));
      
      if (!cacheInfo) {
        // No cache entry — skip, can't query without project/list IDs
        continue;
      }
      
      const url = `https://${process.env.PROOFHUB_COMPANY_URL}/api/v3/projects/${cacheInfo.project_id}/todolists/${cacheInfo.task_list_id}/tasks/${task.proofhub_task_id}`;
      
      const response = await fetch(url, {
        headers: {
          'X-API-KEY': process.env.PROOFHUB_API_KEY,
          'User-Agent': 'zoom-action-items'
        }
      });
      
      if (response.ok) {
        const phTask = await response.json();
        apiCalls++;
        
        // Update ph_task_cache
        const isComplete = phTask.completed === true || phTask.completed === 1;
        db.prepare(`
          UPDATE ph_task_cache 
          SET completed = ?, completed_at = ?, stage_name = ?, last_synced_at = datetime('now')
          WHERE ph_task_id = ?
        `).run(
          isComplete ? 1 : 0,
          phTask.completed_on || null,
          phTask.stage?.name || phTask.workflow_status?.name || null,
          parseInt(task.proofhub_task_id)
        );
        
        // Update ppc_task_tracking if status changed
        if (isComplete && task.proofhub_status !== 'complete') {
          db.prepare(`
            UPDATE ppc_task_tracking 
            SET proofhub_status = 'complete', last_checked = datetime('now')
            WHERE id = ?
          `).run(task.id);
          updated.push({
            task_id: task.id,
            task_title: task.task_title,
            client_name: task.client_name,
            old_status: 'incomplete',
            new_status: 'complete',
            source: 'api'
          });
        } else {
          // Still incomplete — just update last_checked
          db.prepare(`
            UPDATE ppc_task_tracking SET last_checked = datetime('now') WHERE id = ?
          `).run(task.id);
        }
      }
      
      // Rate limit: 1 second between API calls
      await new Promise(r => setTimeout(r, 1000));
      
    } catch (err) {
      console.error(`[PPC Sync] Error checking task ${task.id}:`, err.message);
    }
  }
  
  return {
    skipped: false,
    checked: tasks.length,
    api_calls: apiCalls,
    updated: updated,
    timestamp: new Date().toISOString()
  };
}
```

### 2. New function: `refreshSingleTask(db, taskId)`

```javascript
export async function refreshSingleTask(db, taskId) {
  // Same logic as _doRefresh but for one task only
  // No cooldown, no lock — always runs immediately
  // Returns { updated: boolean, old_status, new_status }
}
```

### 3. API Endpoints in `src/api/routes.js`

Add BEFORE the `/ppc/task/:id/disposition` route:

```javascript
// POST /api/ppc/refresh — Refresh all incomplete PPC task statuses from ProofHub
router.post('/ppc/refresh', async (req, res) => {
  try {
    const database = getDatabase();
    const result = await refreshPPCStatuses(database);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/ppc/refresh/:taskId — Refresh single task status
router.post('/ppc/refresh/:taskId', async (req, res) => {
  try {
    const taskId = parseInt(req.params.taskId);
    const database = getDatabase();
    const result = await refreshSingleTask(database, taskId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

Import `refreshPPCStatuses` and `refreshSingleTask` from `ppc-task-tracker.js` at the top of routes.js (update existing import line).

### 4. Slack Notification on Completion

When `refreshPPCStatuses` or `refreshSingleTask` detects a task transitioned to "complete", post to Slack:

```javascript
// In the refresh functions, after updating status to 'complete':
try {
  const { WebClient } = await import('@slack/web-api');
  const slack = new WebClient(process.env.SLACK_BOT_TOKEN);
  const alertChannel = process.env.SLACK_ALERT_CHANNEL || '#zoom-pipeline-alerts';
  
  await slack.chat.postMessage({
    channel: alertChannel,
    text: `✅ PPC task completed in ProofHub\n*${task.task_title}*\nClient: ${task.client_name} | Meeting: ${task.meeting_date?.split('T')[0]}\nPH: ${task.proofhub_task_title}`
  });
} catch (slackErr) {
  console.error('[PPC Sync] Slack notification failed:', slackErr.message);
}
```

Keep this non-blocking — wrap in try/catch, don't fail the refresh if Slack fails.

### 5. Frontend Changes in `public/index.html`

#### Auto-refresh on PPC tab load

In the existing `loadPPCOverview()` function, add after the data loads:

```javascript
// After rendering the overview with stale data, trigger background refresh
triggerPPCRefresh();
```

```javascript
async function triggerPPCRefresh() {
  // Show subtle banner
  const banner = document.createElement('div');
  banner.className = 'ppc-refresh-banner';
  banner.id = 'ppcRefreshBanner';
  banner.innerHTML = '🔄 Refreshing ProofHub status...';
  const panel = document.getElementById('ppcOverview');
  panel.prepend(banner);
  
  try {
    const res = await fetch(API + '/ppc/refresh', { method: 'POST' });
    const result = await res.json();
    
    if (result.skipped) {
      banner.innerHTML = '✓ ProofHub status is current';
    } else if (result.updated && result.updated.length > 0) {
      banner.innerHTML = `✓ ${result.updated.length} task(s) updated from ProofHub`;
      banner.classList.add('has-updates');
      // Reload the PPC data to show fresh statuses
      setTimeout(() => loadPPCOverview(), 1500);
    } else {
      banner.innerHTML = `✓ All ${result.checked} tasks checked — no changes`;
    }
  } catch (err) {
    banner.innerHTML = '⚠ Could not refresh ProofHub status';
    banner.classList.add('refresh-error');
  }
  
  // Auto-dismiss banner after 5 seconds
  setTimeout(() => {
    if (banner.parentNode) banner.remove();
  }, 5000);
}
```

#### Single-task refresh button

In the expanded task detail (Level 2), add a refresh icon next to the ProofHub status:

```javascript
// In renderPPCTaskDetail, next to the PH status field:
`<button class="btn-refresh-task" onclick="refreshSinglePPCTask(${task.id}, event)" title="Check ProofHub now">🔄</button>`
```

```javascript
async function refreshSinglePPCTask(taskId, event) {
  event.stopPropagation();
  const btn = event.target;
  btn.disabled = true;
  btn.textContent = '⏳';
  
  try {
    const res = await fetch(API + '/ppc/refresh/' + taskId, { method: 'POST' });
    const result = await res.json();
    
    if (result.updated) {
      btn.textContent = '✅';
      // Reload this task's detail
      setTimeout(() => togglePPCTask(taskId), 1000);
    } else {
      btn.textContent = '✓';
    }
  } catch (err) {
    btn.textContent = '⚠';
  }
  
  setTimeout(() => { btn.disabled = false; btn.textContent = '🔄'; }, 3000);
}
```

#### Staleness indicator

In the collapsed card meta line, show last_checked:

```javascript
// In renderPPCTaskCard, add to meta:
const lastChecked = task.last_checked 
  ? `Checked ${formatPPCRelativeDate(task.last_checked)}`
  : 'Never checked';
// Show as small gray text after the existing meta
```

#### Manual refresh button in PPC header

Add next to the "PPC Task Accountability" title:

```html
<button class="ppc-refresh-btn" onclick="triggerPPCRefresh()">🔄 Refresh PH Status</button>
```

#### CSS additions

```css
.ppc-refresh-banner {
  background: #1c2128;
  border: 1px solid #30363d;
  border-radius: 6px;
  padding: 8px 16px;
  font-size: 12px;
  color: #8b949e;
  margin-bottom: 12px;
  transition: all 0.3s;
}

.ppc-refresh-banner.has-updates {
  border-color: #3fb950;
  color: #3fb950;
}

.ppc-refresh-banner.refresh-error {
  border-color: #f85149;
  color: #f85149;
}

.btn-refresh-task {
  background: none;
  border: 1px solid #30363d;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  padding: 2px 6px;
  margin-left: 8px;
}

.btn-refresh-task:hover {
  border-color: #58a6ff;
}

.ppc-refresh-btn {
  background: #21262d;
  border: 1px solid #30363d;
  border-radius: 6px;
  color: #8b949e;
  cursor: pointer;
  font-size: 12px;
  padding: 6px 12px;
  margin-left: 12px;
}

.ppc-refresh-btn:hover {
  border-color: #58a6ff;
  color: #f0f6fc;
}

.staleness-indicator {
  font-size: 10px;
  color: #6e7681;
  font-style: italic;
}
```

### 6. Update `/api/ppc/tracked` and `/api/ppc/at-risk` responses

Add `last_checked` to each task in the response so the frontend can show staleness.

## File Changes

| File | Changes |
|------|---------|
| `src/lib/ppc-task-tracker.js` | +`refreshPPCStatuses()`, +`refreshSingleTask()`, +in-memory lock/cooldown, +Slack notification |
| `src/api/routes.js` | +2 endpoints (POST /ppc/refresh, POST /ppc/refresh/:taskId), update import, add last_checked to responses |
| `public/index.html` | +`triggerPPCRefresh()`, +`refreshSinglePPCTask()`, +refresh banner, +refresh buttons, +staleness indicator, +CSS (~40 lines) |

## Smoke Tests

```bash
# 1. Bulk refresh endpoint
curl -X POST http://localhost:3875/zoom/api/ppc/refresh
# Expected: { checked: N, api_calls: N, updated: [...], timestamp: "..." }
# Or: { skipped: true, reason: "cooldown" } if called within 1 hour

# 2. Single task refresh
curl -X POST http://localhost:3875/zoom/api/ppc/refresh/1
# Expected: { updated: true/false, old_status: "incomplete", new_status: "..." }

# 3. Cooldown works — call refresh twice quickly
curl -X POST http://localhost:3875/zoom/api/ppc/refresh
curl -X POST http://localhost:3875/zoom/api/ppc/refresh
# Second call: { skipped: true, reason: "cooldown" }

# 4. Visual: open PPC tab → see "Refreshing ProofHub status..." banner
# 5. Visual: banner updates to show results → auto-dismisses after 5s
# 6. Visual: click 🔄 on a task row → checks that one task → updates inline
# 7. Visual: staleness "Last checked: Xm ago" visible on cards
# 8. Check Slack channel for completion notifications (if any tasks completed)
```

## Important Notes

- `fetch()` is available in Node.js 18+ (hetzner runs v24) — no need for node-fetch
- Slack notification is best-effort (try/catch) — never block the refresh
- The in-memory lock + cooldown resets on server restart — this is fine
- ProofHub API response format for a single task: check `phTask.completed` (boolean) and `phTask.completed_on` (ISO date string or null)
- The existing `import { getPPCReport, trackPPCTasks, updateDisposition, initPPCTrackingTable } from '../lib/ppc-task-tracker.js'` in routes.js needs to add `refreshPPCStatuses, refreshSingleTask`
