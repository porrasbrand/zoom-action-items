# Phase 06A: Editable Action Items (DB + API + UI)

## Context
Phase 05 (commit 89190d0) built the dashboard frontend. Action items display in the meeting detail panel with complete/reject/reopen buttons. But editing title, description, owner, due date, priority is NOT exposed in the UI — only the API supports PUT /action-items/:id.

The dashboard is at `public/index.html` (~single HTML file, dark theme). The API is in `src/api/routes.js`. Database is SQLite at `data/zoom-action-items.db`.

Current action_items schema: id, meeting_id, client_id, title, description, owner_name, due_date, priority, category, ph_task_id, status, created_at.

## Objective
Make all action item fields fully editable in the dashboard UI. Add missing DB columns for ProofHub integration. Ensure the detail panel shows description prominently.

## Implementation Steps

1. **DB Migration — add new columns to action_items:**
   ```sql
   ALTER TABLE action_items ADD COLUMN transcript_excerpt TEXT;
   ALTER TABLE action_items ADD COLUMN ph_project_id TEXT;
   ALTER TABLE action_items ADD COLUMN ph_task_list_id TEXT;
   ALTER TABLE action_items ADD COLUMN ph_assignee_id TEXT;
   ALTER TABLE action_items ADD COLUMN pushed_at TEXT;
   ```
   Run this in `src/api/server.js` on startup (check if columns exist first to avoid errors on restart).

2. **Update API `PUT /api/action-items/:id`:**
   - Accept all editable fields: title, description, owner_name, due_date, priority, category, status, ph_project_id, ph_task_list_id, ph_assignee_id
   - Return the updated record

3. **Update dashboard `public/index.html` — Action Item Cards:**
   Currently action items in the meeting detail panel show as read-only text. Change to:

   Each action item card should have:
   - **Title** — shown as text, click to edit (inline input)
   - **Description** — shown below title in smaller text, click to edit (inline textarea, 2-3 rows)
   - **Owner** — shown as badge, click to edit (inline input with datalist of known owners)
   - **Due Date** — shown as date badge, click to edit (input type=date)
   - **Priority** — shown as colored badge (high=red, medium=yellow, low=grey), click to cycle through or dropdown
   - **Category** — shown as small label, click to edit (dropdown: follow-up, deliverable, decision, other)
   - **Status** — existing complete/reject/reopen buttons remain

   **Edit mode pattern:**
   - Click on any field → it becomes an input/textarea
   - Press Enter or click away → saves via API call
   - Escape → cancels edit
   - Show a subtle "saving..." indicator during API call
   - Toast notification on save success/failure

4. **Add a "known owners" datalist** for the owner field:
   - On page load, fetch unique owner_name values from `GET /api/action-items?distinct_owners=true`
   - Or add a new endpoint `GET /api/owners` that returns distinct owner names
   - Use as `<datalist>` suggestions when editing owner field

5. **Show description prominently in the action item card:**
   - If description exists, show it as a second line below the title (grey text, 13px)
   - If no description, show "No description" in italic placeholder

6. **Add `GET /api/owners` endpoint:**
   - Returns `{ owners: ["Philip Mutrie", "Dan Kuschell", "Bill Soady", ...] }`
   - Distinct, sorted by frequency

## Files to Modify
- `src/api/server.js` — Add migration on startup
- `src/api/routes.js` — Update PUT endpoint, add GET /owners
- `public/index.html` — Editable action item cards

## Do NOT Touch
- `src/lib/ai-extractor.js` — Phase 06B handles this
- `src/lib/proofhub-publisher.js` — Phase 06C handles this
- `src/poll.js`, `src/service.js` — No changes

## Acceptance Criteria
- [ ] New columns exist on action_items table (transcript_excerpt, ph_project_id, ph_task_list_id, ph_assignee_id, pushed_at)
- [ ] Clicking an action item title makes it editable inline
- [ ] Clicking description makes it editable inline (textarea)
- [ ] Clicking owner shows input with datalist of known owners
- [ ] Clicking due date shows date picker
- [ ] Clicking priority cycles or shows dropdown (high/medium/low)
- [ ] All edits save via API and show toast confirmation
- [ ] Escape cancels edit without saving
- [ ] Description is visible on each action item card
- [ ] GET /api/owners returns distinct owner list

## Smoke Tests
```bash
# Test 1: New columns exist
curl -s http://localhost:3875/zoom/api/action-items?limit=1 | python3 -c "import sys,json; i=json.load(sys.stdin)['items'][0]; print('transcript_excerpt' in i, 'ph_project_id' in i)"
→ expect: True True

# Test 2: PUT action item works with new fields
curl -s -X PUT http://localhost:3875/zoom/api/action-items/1 -H 'Content-Type: application/json' -d '{"title":"Updated title","priority":"high"}' | python3 -c "import sys,json; print(json.load(sys.stdin).get('title','?'))"
→ expect: Updated title

# Test 3: Owners endpoint
curl -s http://localhost:3875/zoom/api/owners | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('owners',[])), 'owners')"
→ expect: 30+ owners

# Test 4: Frontend has inline edit capability
curl -s http://localhost:3875/zoom/ | grep -c 'editField\|inline-edit\|contenteditable'
→ expect: at least 2

# Test 5: Description visible
curl -s http://localhost:3875/zoom/ | grep -c 'description\|item-desc'
→ expect: at least 3
```

## Completion Instructions
1. Run all smoke tests
2. Write result to `.planning/phases/06A-editable-action-items/result.md`
3. Commit with prefix `[zoom-pipeline-06A]`
