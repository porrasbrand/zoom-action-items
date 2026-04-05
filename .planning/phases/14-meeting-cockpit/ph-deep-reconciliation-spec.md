# PH Deep Reconciliation — Technical Spec

## Review Fixes Applied (Gemini review 2026-03-31)

1. **CRITICAL: Credential sanitization** — `sanitizeForAI()` strips passwords, API keys, Bearer tokens, URL credentials BEFORE storing or sending to Gemini
2. **HTML stripping gaps** — Added `&#39;`, `&#xNNNN;` numeric entities, `<p>` → newlines, `<li>` → bullet points
3. **Batch chunking** — Process max 20 tasks per Gemini call to avoid context limits
4. **Gemini retry** — One retry with 2s backoff on failure
5. **Progress logging** — Log each task during deep sync
6. **AI instruction** — Explicitly tell Gemini to ignore any remaining credentials

## Problem

The current reconciliation matches roadmap items to ProofHub tasks by title keywords and AI inference. But it doesn't understand the **actual scope** of each PH task. Example:

**Roadmap item:** "Provide Zoom links for March 20th" (status: done)
**Matched PH task:** "Advanced Team - Prosper - March 20th VIP Page Updates" (status: Open)

The cockpit shows `🔄 PH: "March 20th VIP Page Updates" — Open`, which is confusing — Phil sees "done" in our roadmap but "Open" in ProofHub.

The reality: The PH task covers **much more** than Zoom links. Its description contains 5 distinct deliverables:
1. Update VIP Delivery page with new webinar replay video
2. Update PDF download link with new notes file
3. Duplicate VIP page → create `/vip-upgrade-one` with Brand Ambassadors video
4. Duplicate VIP page → create `/vip-upgrade-two` with Podcast Booking video
5. Both new pages need specific headlines

And the comment thread shows:
- Phil confirmed receipt (Mar 25)
- VIP email was scheduled (Mar 25)
- Request to remove three links from copies (Mar 26)
- Phil confirmed links removed (Mar 26)

Without reading this, the AI matched "Zoom links" to "VIP Page Updates" based on keyword overlap ("March 20th") — a loose match. With the full context, the AI would understand these are related but the PH task is a bigger container.

## Proposed Solution

**At reconciliation time** (not on every cockpit load), for each PH task:

1. Pull the task description (already available — we get it from `getAllProjectTasks`)
2. Pull the comment thread (1 extra API call per task)
3. Strip HTML, extract clean text
4. Feed to the AI batch alongside the roadmap items
5. Store a `scope_summary` (1-3 sentences) and `deliverables` (list) in `ph_task_cache`
6. Use the richer context for better matching decisions

## Data Available from ProofHub API

### Task Description (already fetched, not stored)
```
GET /projects/{projectId}/todolists/{listId}/tasks/{taskId}
→ task.description: HTML string with full brief, links, credentials, instructions
   Prosper "VIP Page Updates": 3,701 chars of HTML
```

### Task Comments (new API call needed)
```
GET /projects/{projectId}/todolists/{listId}/tasks/{taskId}/comments
→ Array of comment objects:
   {
     description: "<div>HTML comment body</div>",
     created_at: "2026-03-25T...",
     // author info embedded in HTML phmention tags
   }
   Prosper "VIP Page Updates": 5 comments showing back-and-forth between Phil and team
```

### Rate Limits
- ProofHub API: 25 requests per 10 seconds (1 per 400ms)
- Existing `proofhub-client.js` already handles this with `MIN_INTERVAL = 400`
- For Prosper Group: 18 tasks × 1 comment call each = 18 extra API calls = ~8 seconds
- For all 30 clients: ~200-300 tasks total = ~2-3 minutes one-time

## Implementation

### 1. Add `getTaskComments()` to `proofhub-client.js`

```javascript
/**
 * Get comments for a task
 */
export async function getTaskComments(projectId, taskListId, taskId) {
  return request('GET', `/projects/${projectId}/todolists/${taskListId}/tasks/${taskId}/comments`);
}
```

### 2. Add columns to `ph_task_cache`

```sql
ALTER TABLE ph_task_cache ADD COLUMN description_text TEXT;   -- cleaned text from HTML description
ALTER TABLE ph_task_cache ADD COLUMN comments_text TEXT;       -- cleaned text from all comments
ALTER TABLE ph_task_cache ADD COLUMN scope_summary TEXT;       -- AI-generated 1-3 sentence summary
ALTER TABLE ph_task_cache ADD COLUMN deliverables TEXT;        -- JSON array of specific deliverables
ALTER TABLE ph_task_cache ADD COLUMN context_synced_at DATETIME; -- when deep context was last pulled
```

### 3. Add `deepSyncTask()` to `ph-reconciler.js`

```javascript
/**
 * Pull description + comments for a PH task, strip HTML, store clean text.
 * Runs ONCE per task at reconciliation time.
 *
 * @param {Database} db
 * @param {Object} task - PH task object from API (has id, _taskListId, description)
 * @param {string} projectId
 */
async function deepSyncTask(db, task, projectId, index, total) {
  console.log(`[DeepSync] ${index + 1}/${total}: ${(task.title || '').substring(0, 50)}...`);

  // 1. Clean description HTML → plain text → sanitize credentials
  const descRaw = stripHtml(task.description || '');
  const descText = sanitizeForAI(descRaw);

  // 2. Pull comments
  let commentsText = '';
  try {
    const comments = await proofhub.getTaskComments(projectId, task._taskListId, task.id);
    commentsText = comments.map(c => {
      const body = sanitizeForAI(stripHtml(c.description || c.content || ''));
      const date = (c.created_at || '').substring(0, 10);
      return `[${date}] ${body}`;
    }).join('\n');
  } catch (err) {
    console.warn(`  Failed to fetch comments for task ${task.id}: ${err.message}`);
  }

  // 3. Extract latest comment date
  let latestCommentDate = null;
  try {
    const comments = await proofhub.getTaskComments(projectId, task._taskListId, task.id);
    if (comments.length > 0) {
      latestCommentDate = comments[comments.length - 1]?.created_at?.substring(0, 10) || null;
    }
  } catch {} // Already warned above if failed

  // 4. Store sanitized text in cache (NEVER store raw credentials)
  db.prepare(`
    UPDATE ph_task_cache
    SET description_text = ?, comments_text = ?, context_synced_at = datetime('now')
    WHERE ph_task_id = ?
  `).run(descText, commentsText, task.id);

  return { descText, commentsText };
}

/**
 * Strip HTML tags → clean text.
 * (Gemini fix: added <p>, <li>, numeric entity handlers)
 */
function stripHtml(html) {
  return (html || '')
    .replace(/<phmention[^>]*>([^<]*)<\/phmention>/g, '$1')  // Extract @mention names
    .replace(/<\/p>/g, '\n\n')                                 // (Gemini fix) <p> → paragraph break
    .replace(/<li[^>]*>/g, '• ')                               // (Gemini fix) <li> → bullet
    .replace(/<\/li>/g, '\n')                                  // (Gemini fix) </li> → newline
    .replace(/<br\s*\/?>/g, '\n')
    .replace(/<\/div>/g, '\n')
    .replace(/<[^>]+>/g, '')                                   // Strip remaining tags
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(n))   // (Gemini fix) numeric entities &#39;
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))  // (Gemini fix) hex entities
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&shy;/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Sanitize text to remove credentials before storing or sending to AI.
 * CRITICAL: PH descriptions contain real passwords, API keys, login URLs.
 * (Gemini review: this is BLOCKING — must not store or send credentials)
 */
function sanitizeForAI(text) {
  return (text || '')
    // Password patterns (Password: xxx, pwd: xxx, pass: xxx)
    .replace(/password[:\s=]+\S+/gi, '[PASSWORD REDACTED]')
    .replace(/pwd[:\s=]+\S+/gi, '[PASSWORD REDACTED]')
    // URL credentials (https://user:pass@host)
    .replace(/https?:\/\/[^:\s]+:[^@\s]+@/gi, 'https://[CREDENTIALS]@')
    // API keys and tokens (long alphanumeric strings 32+ chars)
    .replace(/[a-zA-Z0-9_-]{40,}/g, '[TOKEN_REDACTED]')
    // Bearer tokens
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    // Common credential field patterns
    .replace(/api[_-]?key[:\s=]+\S+/gi, '[API_KEY REDACTED]')
    .replace(/secret[:\s=]+\S+/gi, '[SECRET REDACTED]')
    // Login URL patterns followed by credentials
    .replace(/(login\s*URL[:\s]+\S+[\s\S]{0,50}?)(Username[:\s]+\S+[\s\S]{0,50}?Password[:\s]+\S+)/gi, '$1[LOGIN CREDENTIALS REDACTED]');
}
```

### 4. Add `generateScopeSummary()` — AI call for batch summarization

After deep syncing all tasks for a client, make ONE Gemini call to summarize all tasks:

```javascript
/**
 * Generate scope summaries for all PH tasks in one batch.
 * Runs ONCE at reconciliation time.
 */
/**
 * (Gemini fix: chunking at 20 tasks, retry on failure, credential warning in prompt)
 */
const SCOPE_CHUNK_SIZE = 20;

async function generateScopeSummaries(db, clientId) {
  const tasks = db.prepare(`
    SELECT ph_task_id, title, description_text, comments_text, completed
    FROM ph_task_cache
    WHERE client_id = ? AND description_text IS NOT NULL AND scope_summary IS NULL
  `).all(clientId);

  if (tasks.length === 0) return;

  const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);
  const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

  // (Gemini fix: chunk into batches of 20)
  const chunks = [];
  for (let i = 0; i < tasks.length; i += SCOPE_CHUNK_SIZE) {
    chunks.push(tasks.slice(i, i + SCOPE_CHUNK_SIZE));
  }

  const stmt = db.prepare('UPDATE ph_task_cache SET scope_summary = ?, deliverables = ? WHERE ph_task_id = ?');
  let totalSummarized = 0;

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    console.log(`[Reconciler] Generating scope summaries batch ${ci + 1}/${chunks.length} (${chunk.length} tasks)...`);

    const prompt = `For each ProofHub task below, generate:
1. scope_summary: 1-2 sentences describing what this task actually involves (the real deliverables, not just the title)
2. deliverables: JSON array of specific work items within this task

IMPORTANT: If you see any credentials, passwords, API keys, or login URLs in the descriptions, DO NOT include them in the scope_summary or deliverables. Focus ONLY on the work deliverables.

TASKS:
${chunk.map(t => `
--- TASK ${t.ph_task_id}: "${t.title}" (${t.completed ? 'DONE' : 'OPEN'}) ---
DESCRIPTION:
${(t.description_text || '').substring(0, 2000)}

COMMENTS:
${(t.comments_text || '').substring(0, 1000)}
`).join('\n')}

Return ONLY valid JSON array:
[
  {
    "ph_task_id": 123,
    "scope_summary": "Update VIP delivery page with new webinar replay and notes PDF, then create two new VIP upgrade pages with workshop videos.",
    "deliverables": ["Update VIP replay video", "Replace notes PDF download", "Create /vip-upgrade-one", "Create /vip-upgrade-two"]
  }
]`;

    // (Gemini fix: retry once on failure)
    let result;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        result = await model.generateContent(prompt);
        break;
      } catch (err) {
        console.warn(`  Gemini attempt ${attempt}/2 failed: ${err.message}`);
        if (attempt === 2) { console.error('  Skipping this batch'); continue; }
        await new Promise(r => setTimeout(r, 2000));
      }
    }

    if (!result) continue;

    try {
      const text = result.response.text().trim();
      const jsonMatch = text.match(/\[[\s\S]*\]/);
      if (!jsonMatch) continue;

      const summaries = JSON.parse(jsonMatch[0]);
      for (const s of summaries) {
        stmt.run(s.scope_summary, JSON.stringify(s.deliverables || []), s.ph_task_id);
        totalSummarized++;
      }
    } catch (err) {
      console.error('  Failed to parse scope summaries:', err.message);
    }
  }

  console.log(`[Reconciler] Generated scope summaries for ${totalSummarized}/${tasks.length} tasks`);
}
```

### 5. Update `reconcileClient()` flow

```
Current flow:
  1. Pull PH tasks (API)
  2. Cache basic fields
  3. Layers 1-3 deterministic matching
  4. Layer 4 AI batch matching
  5. Store links

New flow:
  1. Pull PH tasks (API)
  2. Cache basic fields
  3. Deep sync: pull description + comments for each task (API)
  4. Generate scope summaries (1 Gemini call for all tasks)
  5. Layers 1-3 deterministic matching (now uses scope_summary for better keyword matching)
  6. Layer 4 AI batch matching (now includes description context in prompt)
  7. Store links
```

### 6. Enhanced AI Batch Prompt (Layer 4)

With the deep context, the AI batch prompt becomes much richer:

```
PROOFHUB CAMPAIGN TASKS (parent-level):
  PH-512921639437: "Advanced Team - Prosper - March 20th VIP Page Updates" (OPEN)
    Scope: Update VIP delivery page with new webinar replay and notes PDF,
    create two new VIP upgrade pages with workshop videos.
    Deliverables: Update VIP replay video, Replace notes PDF, Create /vip-upgrade-one, Create /vip-upgrade-two
    Recent activity: Phil confirmed receipt, VIP email scheduled, links removed per request

UNMATCHED ROADMAP ITEMS:
  RI-36: "Provide Zoom links for March 20th" (done, funnel-campaign)
```

The AI now sees that "Provide Zoom links" is a **small sub-task** within a larger VIP page updates project — it can match with higher confidence AND explain the relationship.

### 7. Update Cockpit Display

Instead of:
```
🔄 PH: "Advanced Team - Prosper - March 20th VIP Page Updates" — Open
```

Show:
```
🔄 PH: Advanced Team - Prosper - March 20th VIP Page Updates — Open
   Scope: Update VIP page with new replay video + notes PDF, create 2 VIP upgrade pages
   Latest: Phil confirmed links removed (Mar 26)
```

The `scope_summary` and latest comment provide Phil real context without opening ProofHub.

### 8. Show in Cockpit UI

Add to the PH display section in cockpit items:

```javascript
// If scope_summary exists, show it
if (phLink.scope_summary) {
  phHtml += `<div class="cockpit-ph-scope">${escapeHtml(phLink.scope_summary)}</div>`;
}
// If deliverables exist, show count
if (phLink.deliverables && phLink.deliverables.length > 0) {
  phHtml += `<div class="cockpit-ph-deliverables">${phLink.deliverables.length} deliverables in this task</div>`;
}
```

CSS:
```css
.cockpit-ph-scope {
  font-size: 11px;
  color: #8b949e;
  margin-top: 2px;
  font-style: italic;
  line-height: 1.4;
}
.cockpit-ph-deliverables {
  font-size: 10px;
  color: #6e7681;
  margin-top: 2px;
}
```

## Cost Analysis

| Operation | API Calls | Gemini Calls | When |
|-----------|-----------|-------------|------|
| Deep sync (descriptions already fetched) | 0 extra | 0 | Reconciliation |
| Deep sync (comments) | 1 per PH task | 0 | Reconciliation |
| Scope summaries | 0 | 1 per client | Reconciliation |
| Cockpit load | 0 | 0 | Every click |

For Prosper Group (18 PH tasks): 18 comment API calls (~8 seconds) + 1 Gemini call (~$0.002)
For all 30 clients (~300 tasks): ~300 comment calls (~3 minutes) + 30 Gemini calls (~$0.06)

**Total one-time cost: ~3 minutes + $0.06.** Then it's cached forever.

## Files to Modify

1. `src/lib/proofhub-client.js` — Add `getTaskComments()`
2. `src/lib/ph-reconciler.js` — Add `deepSyncTask()`, `stripHtml()`, `generateScopeSummaries()`, update `reconcileClient()` flow
3. `src/lib/roadmap-db.js` — Add new columns to ph_task_cache CREATE TABLE
4. `src/lib/prep-collector.js` — Include scope_summary and deliverables in phLinkMap
5. `public/index.html` — Show scope_summary in cockpit PH display

## Do NOT Touch

- `src/lib/prep-generator.js` — No prompt changes needed
- `src/api/routes.js` — No new endpoints needed (existing reconcile endpoint triggers the deep sync)

## Acceptance Criteria

- [ ] `getTaskComments()` pulls comments from PH API
- [ ] `deepSyncTask()` strips HTML and stores clean text
- [ ] `scope_summary` generated for each PH task (1-2 sentences)
- [ ] `deliverables` extracted as JSON array
- [ ] AI batch matching uses description context for better accuracy
- [ ] Cockpit shows scope summary below PH task link
- [ ] Deep sync runs once at reconciliation time, not on cockpit load
- [ ] Comment API failures are graceful (warn, continue)
- [ ] Prosper Group: VIP Page Updates task shows real scope (video replacement, page duplication)

## Smoke Tests

```bash
cd ~/awsc-new/awesome/zoom-action-items

# Re-run reconciliation with deep sync
node src/ph-reconcile.js --client prosper-group --deep

# Check scope summaries
node -e "
const db = require('better-sqlite3')('data/zoom-action-items.db');
db.prepare('SELECT title, scope_summary, deliverables FROM ph_task_cache WHERE client_id = ? AND scope_summary IS NOT NULL').all('prosper-group').forEach(t => {
  console.log(t.title);
  console.log('  Scope:', t.scope_summary);
  console.log('  Deliverables:', t.deliverables);
});
"
```
