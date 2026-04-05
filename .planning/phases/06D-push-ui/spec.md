# Phase 06D: Push to ProofHub UI

## Context
Phase 06A (commit ed95038) made action items fully editable in the dashboard.
Phase 06C (commit 873d004) added ProofHub API integration with:
- `POST /api/action-items/:id/push-ph` — push single item to PH
- `POST /api/meetings/:id/push-all-ph` — push all open items from a meeting
- `GET /api/proofhub/projects` — list PH projects
- `GET /api/proofhub/projects/:id/task-lists` — task lists per project
- `GET /api/proofhub/people` — PH people list
- `GET /api/proofhub/resolve-owner/:name` — name → PH user resolver
- `GET /api/proofhub/client-project/:clientId` — client → PH project mapping

The dashboard is at `public/index.html`. Action items show in the right panel when a meeting is selected. Each item has inline editing + complete/reject/reopen buttons.

People resolver maps: Phil→12896349500, Bill→13652696772, Richard→12930841172, etc.
Client→PH project: bearcat→8149674025, echelon→9104911511, empower→9330165736, etc.

## Objective
Add "Push to ProofHub" UI for individual action items and bulk "Push All" per meeting. Phil reviews items, edits as needed, then pushes approved ones to ProofHub.

## Implementation Steps

1. **Add "Push to PH" button per action item:**
   - Show on items with status='open' (not rejected, not already pushed)
   - Button style: blue outline, small, next to existing complete/reject buttons
   - Clicking opens a push confirmation panel (inline, not modal — keeps context visible)

2. **Push confirmation panel (inline, per action item):**
   When "Push to PH" is clicked, expand a panel below the action item card showing:

   - **ProofHub Project** — dropdown, auto-selected based on meeting's client mapping
     - Fetch from `GET /proofhub/projects` (cache after first load)
     - Auto-select using `GET /proofhub/client-project/:clientId`

   - **Task List** — dropdown, loads when project is selected
     - Fetch from `GET /proofhub/projects/:id/task-lists`
     - Default to first task list if only one exists

   - **Assignee** — dropdown, auto-selected from owner_name resolver
     - Fetch all PH people from `GET /proofhub/people`
     - Auto-resolve using `GET /proofhub/resolve-owner/:ownerName`
     - Show resolved name + email for confirmation

   - **Title** — pre-filled from action item title (editable input)

   - **Description** — pre-filled from action item description + transcript excerpt (editable textarea)
     - Format: "[AI Description]\n\n---\nFrom meeting: [topic] ([date])\n[transcript excerpt if available]"

   - **Due Date** — pre-filled from action item due_date (date input)

   - **Push** button (green) + **Cancel** button (grey)

3. **Push action flow:**
   - Click "Push" → disable button, show "Pushing..."
   - Call `POST /api/action-items/:id/push-ph` with form values
   - On success:
     - Toast: "Pushed to ProofHub ✓"
     - Update item display: show "Pushed" badge (green), hide push button
     - Show PH task link if returned
   - On error:
     - Toast with error message
     - Keep panel open for retry

4. **"Push All Open" button per meeting:**
   - Add button in the meeting detail header area (next to meeting title/info)
   - Label: "Push All to PH (N)" where N = count of open items
   - Only show if meeting has open (non-rejected, non-pushed) action items
   - Clicking opens a confirmation panel at the top of the action items section:
     - Shows: "Push N action items to ProofHub"
     - ProofHub Project dropdown (auto-selected from client)
     - Task List dropdown
     - "Assignees will be auto-resolved from the meeting transcript"
     - **Push All** button + **Cancel**
   - Calls `POST /api/meetings/:id/push-all-ph`
   - On success: update all items to show "Pushed" badge, show toast with count

5. **Pushed item display:**
   - Items with `pushed_at` show a green "Pushed" badge
   - The push button is hidden for pushed items
   - Show PH task ID or link if available
   - "Undo" link that sets status back to 'open' and clears ph_task_id (optional, nice to have)

6. **Cache PH data:**
   - Cache projects, people, and task lists in JS variables after first fetch
   - Don't re-fetch on every push panel open
   - Clear cache on page refresh

7. **Loading states:**
   - Show spinner/loading text when fetching PH projects, task lists, or people
   - Show spinner on push button during API call

## Files to Modify
- `public/index.html` — Push UI, push confirmation panels, Push All button

## Do NOT Touch
- `src/api/routes.js` — Phase 06C already added all needed endpoints
- `src/lib/proofhub-client.js` — Already working
- `src/lib/people-resolver.js` — Already working
- `src/lib/ai-extractor.js` — Phase 06B handles this

## Acceptance Criteria
- [ ] Each open action item has a "Push to PH" button
- [ ] Clicking shows inline push panel with project, task list, assignee dropdowns
- [ ] Project auto-selects based on meeting's client
- [ ] Assignee auto-resolves from owner_name
- [ ] Push creates a real ProofHub task and shows success toast
- [ ] Pushed items show "Pushed" green badge and hide push button
- [ ] "Push All" button exists in meeting header when open items exist
- [ ] "Push All" pushes all open items with auto-resolved assignees
- [ ] Loading states shown during API calls
- [ ] PH data is cached (projects, people fetched once)

## Smoke Tests
```bash
# Test 1: Push button exists in frontend
curl -s http://localhost:3875/zoom/ | grep -c 'push-ph\|Push to PH\|pushToPH'
→ expect: at least 3

# Test 2: Push All button exists
curl -s http://localhost:3875/zoom/ | grep -c 'push-all\|Push All\|pushAllToPH'
→ expect: at least 2

# Test 3: PH project dropdown
curl -s http://localhost:3875/zoom/ | grep -c 'ph-project\|proofhub.*project\|phProject'
→ expect: at least 2

# Test 4: PH assignee dropdown
curl -s http://localhost:3875/zoom/ | grep -c 'ph-assignee\|proofhub.*assignee\|phAssignee'
→ expect: at least 2

# Test 5: Push API still works
curl -s http://localhost:3875/zoom/api/proofhub/projects | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('projects',[])), 'projects')"
→ expect: 31 projects

# Test 6: Visual test — open https://www.manuelporras.com/zoom/
# Select a meeting with action items
# Click "Push to PH" on an action item
# Verify dropdown panel appears with project, task list, assignee
# Click Push → verify PH task created
```

## Completion Instructions
1. Run smoke tests 1-5
2. Write result to `.planning/phases/06D-push-ui/result.md`
3. Commit with prefix `[zoom-pipeline-06D]`
