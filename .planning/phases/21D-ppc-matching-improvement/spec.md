# Phase 21D: PPC Matching Improvement — Reduce False Positives

## Objective
Rewrite the ProofHub matching prompt to eliminate false positives, add PH descriptions + transcript excerpts as context, implement confidence thresholds (HIGH=accept, MEDIUM=flag, LOW=reject), and re-run matching for all existing PPC tasks.

## Prior Work Summary
- Phase 21A: PPC tracker MVP with GPT-5.4 matching
- Phase 21B: Rich expandable cards with detail view
- Phase 21C: ProofHub status sync (on-demand refresh)
- Backfill: 198 action items now have transcript_excerpt
- Current state: 15 matched tasks (8 HIGH, 7 MEDIUM). At least 3 MEDIUM matches are false positives.
- Model: GPT-5.4, temperature 0.1, via model-providers.js callModel()
- ProofHub task cache: ph_task_cache table has description_text, scope_summary fields

## Problem
The current prompt says "Could be a broader task that encompasses this specific item" — this encourages loose matching. A generic PH task like "UPDATES TO MAKE ON TRAFFIC" matches any traffic-related action item. The system treats MEDIUM confidence the same as HIGH.

## Deliverables

### 1. Rewrite `matchProofHub()` prompt in `src/lib/ppc-task-tracker.js`

Replace the existing prompt (lines ~264-285) with this improved version:

```
MEETING ACTION ITEM ({meeting_date}):
Title: "{task_title}"
Description: "{task_description}"
Owner: "{owner}"
Client: "{client_name}"
{if transcript_excerpt: Transcript context: "{transcript_excerpt}"}

CANDIDATE PROOFHUB TASKS (created within 10 days of meeting):
1. Title: "{ph_title}"
   Description: "{ph_description_first_200_chars}"
   Created: "{date}", Assignee: "{assignee}", Status: "{status}"
2. ...

Does any ProofHub task track THE SAME SPECIFIC WORK as this meeting action item?

MATCHING RULES:
- A match means the PH task was created specifically to track this action item or describes the same concrete deliverable
- The PH task title or description must reference the same specific activity, not just the same general area
- Same client + same broad category (e.g., "ads") is NOT sufficient for a match
- A generic task like "UPDATES TO MAKE ON TRAFFIC" does NOT match a specific item like "Throttle sump pump campaigns"
- A broad strategy task does NOT match a specific tactical item unless the PH task description explicitly mentions that tactic

EXAMPLES OF NON-MATCHES:
- "Develop Facebook ad concepts" ≠ "Getting More Hardwood Leads" (different scope — one is FB creative, one is lead strategy)
- "Pull CTR and Conversion Rate data" ≠ "AC Ads and Expansion" (reporting task ≠ campaign management)
- "Throttle sump pump campaigns" ≠ "UPDATES TO MAKE ON TRAFFIC" (specific action ≠ generic bucket)

EXAMPLES OF VALID MATCHES:
- "Update Google Ads keywords for AC" ≈ "Jacob - Pearce HVAC - Google/Bing Ads For AC" (same specific work)
- "Launch March 21st webinar Facebook Ads" ≈ "Richard O - March 21st Webinar Facebook Ads" (same event + channel)

CONFIDENCE CALIBRATION:
- HIGH: PH task title/description explicitly describes this exact work (same platform, same action, same scope)
- MEDIUM: PH task is clearly related and likely tracks this work, but title is broader than the action item
- LOW: PH task is in the same area but match is speculative
- NO MATCH: Default. Only match if you are confident the PH task tracks this specific work

Respond in JSON:
{
  "match_found": true/false,
  "matched_index": 1-N or null,
  "confidence": "high" | "medium" | "low",
  "match_reasoning": "one sentence: what specific evidence links these two tasks"
}
```

### 2. Include PH task descriptions in the candidate list

In `matchProofHub()`, when building `taskListStr`, include description from ph_task_cache:

```javascript
// For each candidate PH task, look up description in cache
const cached = db.prepare('SELECT description_text, scope_summary FROM ph_task_cache WHERE ph_task_id = ?')
  .get(parseInt(t.id));
const desc = cached?.scope_summary || (cached?.description_text || '').replace(/<[^>]+>/g, '').slice(0, 200) || 'No description';

// Format candidate:
`${i + 1}. Title: "${t.title}"
   Description: "${desc}"
   Created: "${t.created_at?.split('T')[0] || 'unknown'}", Assignee: "${t.responsible_name || 'unassigned'}", Status: "${t.completed ? 'complete' : 'incomplete'}"`
```

### 3. Include transcript excerpt in the prompt

The `task` object passed to `matchProofHub()` doesn't have `transcript_excerpt`. Add it:

In `trackPPCTasks()`, when building the task object for each PPC item, look up the transcript_excerpt from ai_extraction:

```javascript
// Already have meeting.ai_extraction parsed as extraction
const actionItem = actionItems[ppcTask.index];
const transcriptExcerpt = actionItem?.transcript_excerpt || null;

// Pass to matchProofHub
const phMatch = await matchProofHub(
  { ...task, transcript_excerpt: transcriptExcerpt },
  task.client_id, task.meeting_date, db
);
```

Then in the prompt, conditionally include:
```javascript
const transcriptLine = task.transcript_excerpt
  ? `\nTranscript context (what was said in the meeting):\n"${task.transcript_excerpt.slice(0, 500)}"\n`
  : '';
```

### 4. Confidence thresholds in dashboard

#### Frontend changes in `public/index.html`:

**Collapsed card:** Change status logic:
- `proofhub_match = 1 AND proofhub_confidence = 'high'` → ✅ green border, "Matched" status
- `proofhub_match = 1 AND proofhub_confidence = 'medium'` → ⚠️ yellow border, "Needs Review" status  
- `proofhub_match = 1 AND proofhub_confidence = 'low'` → treat as unmatched (show in missing list)
- `proofhub_match = 0 or NULL` → ❌ red border, "Missing" status

**Overview stats:** Only count HIGH confidence as "In ProofHub". MEDIUM goes into a separate "Needs Review" count.

**New section in PPC overview:** Between "Tracked in ProofHub" and "Missing from ProofHub", add:
```
⚠️ NEEDS REVIEW (X tasks)
Tasks with possible ProofHub matches that need human verification.
[Accept Match] [Reject Match] buttons per task
```

#### API changes in `src/api/routes.js`:

Update `/ppc/status` response to include:
```javascript
{
  total_ppc_tasks: N,
  in_proofhub: count_where_high,        // Only HIGH confidence
  needs_review: count_where_medium,       // MEDIUM confidence
  missing: count_where_no_match_or_low,   // No match + LOW
  ...
}
```

Update `/ppc/tracked` to add a `match_status` field:
```javascript
match_status: task.proofhub_confidence === 'high' ? 'confirmed'
            : task.proofhub_confidence === 'medium' ? 'needs_review'
            : 'unconfirmed'
```

Add new endpoint or modify existing:
```
POST /api/ppc/task/:id/verify — Accept or reject a medium-confidence match
Body: { "action": "accept" | "reject" }
- accept: upgrades proofhub_confidence to 'human-verified'
- reject: sets proofhub_match = 0, proofhub_confidence = 'rejected'
```

### 5. Re-run matching for all existing PPC tasks

Create `scripts/rematch-ppc.mjs`:

```javascript
// For each PPC task in ppc_task_tracking:
// 1. Clear existing match data (proofhub_match, proofhub_task_id, etc.)
// 2. Re-run matchProofHub() with the new prompt
// 3. Update the row with new results
// 4. Print comparison: old match vs new match, old confidence vs new confidence

// Usage:
// node scripts/rematch-ppc.mjs              # Re-match all
// node scripts/rematch-ppc.mjs --dry-run    # Preview changes without writing
// node scripts/rematch-ppc.mjs --id 41      # Re-match single task
```

After re-matching, print a summary:
```
Re-match Results:
- HIGH matches: X (was 8)
- MEDIUM matches: X (was 7)
- LOW matches: X (was 0)
- No match: X
- Changed: X tasks got different results
- False positives removed: X
```

### 6. Update filter controls

Add "Needs Review" to the status filter dropdown:
```html
<option value="needs_review">⚠️ Needs Review</option>
```

## File Changes

| File | Changes |
|------|---------|
| `src/lib/ppc-task-tracker.js` | Rewrite matchProofHub() prompt, add PH descriptions + transcript excerpt, pass transcript_excerpt in trackPPCTasks() |
| `src/api/routes.js` | Update /ppc/status counts, add match_status to /ppc/tracked, add POST /ppc/task/:id/verify endpoint |
| `public/index.html` | Confidence-based card styling, "Needs Review" section, accept/reject buttons, updated filter dropdown, updated stats display |
| `scripts/rematch-ppc.mjs` | New script to re-run matching with improved prompt |

## Smoke Tests

```bash
# 1. Re-match with dry-run first
node scripts/rematch-ppc.mjs --dry-run
# Expected: shows what would change, no DB writes

# 2. Re-match all tasks
node scripts/rematch-ppc.mjs
# Expected: fewer false positives, some MEDIUM → no match

# 3. Re-match single task (the Vision Flooring false positive)
node scripts/rematch-ppc.mjs --id 41
# Expected: should NOT match "Getting More Hardwood Leads" anymore

# 4. API: status endpoint reflects new counts
curl /api/ppc/status
# Expected: needs_review count visible, in_proofhub only counts HIGH

# 5. API: verify endpoint works
curl -X POST /api/ppc/task/46/verify -d '{"action":"accept"}'
# Expected: confidence upgraded to 'human-verified'

# 6. Visual: "Needs Review" section appears in dashboard
# 7. Visual: MEDIUM tasks show ⚠️ yellow border, not ✅ green
# 8. Visual: Accept/Reject buttons work on needs-review tasks
# 9. Visual: filter dropdown includes "Needs Review" option

# 10. Restart dashboard
pm2 restart zoom-dashboard
```

## Important Notes

- GPT-5.4 is the right model — the prompt was the problem, not the model
- Temperature stays at 0.1 (we want deterministic matching)
- The re-match script should have rate limiting (2s between calls) to respect API limits
- After re-matching, the status sync (Phase 21C) still works — it only checks completion status, not match quality
- The verify endpoint creates a new confidence level: 'human-verified' — treated same as HIGH in all queries
- PH descriptions: strip HTML tags, use scope_summary if available, fallback to description_text first 200 chars
- Transcript excerpt: cap at 500 chars in the prompt to avoid token bloat
