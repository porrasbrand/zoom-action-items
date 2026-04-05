# Phase 06C: ProofHub Integration (People Resolver + Client Mapping)

## Context
The b3x-client-state project on Hetzner has a fully working ProofHub API client at `~/awsc-new/awesome/b3x-client-state/lib/proofhub-client.js`. It provides: getProjects(), getTaskLists(), getTasks(), createTask(), getPeople(). ProofHub credentials are in `~/awsc-new/awesome/b3x-client-state/.env` (PROOFHUB_API_KEY, PROOFHUB_COMPANY_URL).

Available ProofHub data:
- 31 projects (1st Choice, Bearcat Coaching, BEC CFO, Echelon Electric, etc.)
- Task lists per project (e.g., "1st Choice - Traffic | Campaigns | Reporting")
- People: Phil@breakthrough3x.com (12896349500), bill@breakthrough3x.com (13652696772), richard@breakthrough3x.com (12930841172), vince@breakthrough3x.com (14513930205), jacob.traffic@breakthrough3x.com (13766931777), etc.

Action items have owner_name from transcripts: "Philip Mutrie", "Dan Kuschell", "Bill Soady", "Joaco Malig", etc.
Clients in meetings map to PH projects: bearcat → "Bearcat Coaching", echelon → "Andrew Williams - Echelon Electric", etc.

## Objective
1. Copy ProofHub API client to zoom-action-items project
2. Build a people resolver that maps transcript speaker names to PH user IDs
3. Map client IDs to ProofHub project IDs in clients.json
4. Add API endpoints for PH projects, task lists, and people (for UI dropdowns)

## Implementation Steps

1. **Copy ProofHub client:**
   - Copy `~/awsc-new/awesome/b3x-client-state/lib/proofhub-client.js` to `~/awsc-new/awesome/zoom-action-items/src/lib/proofhub-client.js`
   - Copy PROOFHUB_API_KEY, PROOFHUB_COMPANY_URL, PROOFHUB_AWESOME_TEAM_ID from b3x-client-state/.env to zoom-action-items/.env

2. **Create people resolver `src/lib/people-resolver.js`:**
   - Hardcoded mapping table (most reliable for small team):
   ```javascript
   const PEOPLE_MAP = [
     { names: ['Philip Mutrie', 'Phil', 'Phil Mutrie'], ph_id: '12896349500', email: 'Phil@breakthrough3x.com' },
     { names: ['Bill Soady', 'Bill'], ph_id: '13652696772', email: 'bill@breakthrough3x.com' },
     { names: ['Richard', 'Richard Bonn', 'Richard Osterude', 'Richard O'], ph_id: '12930841172', email: 'richard@breakthrough3x.com' },
     { names: ['Joaco', 'Joaco Malig'], ph_id: '12953229550', email: 'jmejia@breakthrough3x.com' },
     { names: ['Jacob', 'Jacob Hastings', 'Jacob/Traffic Team'], ph_id: '13766931777', email: 'jacob.traffic@breakthrough3x.com' },
     { names: ['Vince', 'Vince Lei'], ph_id: '14513930205', email: 'vince@breakthrough3x.com' },
     { names: ['Sarah', 'Sarah Young'], ph_id: '12953338100', email: 'sarah.young@breakthrough3x.com' },
     { names: ['Manuel', 'Manuel Porras'], ph_id: '12953283825', email: 'minisite911@gmail.com' },
     { names: ['Juan', 'Juan Mejia'], ph_id: '12953229550', email: 'jmejia@breakthrough3x.com' },
     { names: ['Ray Z', 'Ray'], ph_id: '12953297394', email: 'rayz@breakthrough3x.com' },
     { names: ['Nicole'], ph_id: '13766918208', email: 'nicole.traffic@breakthrough3x.com' },
     { names: ['Dan Kuschell', 'Dan', "Dan's Team"], ph_id: null, email: 'help@breakthrough3x.com', note: 'CEO - usually delegates' },
   ];
   ```
   - Export `resolvePerson(ownerName)` → returns `{ ph_id, email, name }` or null
   - Export `getAllPeople()` → returns full list for dropdowns
   - Fuzzy match: case-insensitive, trim whitespace, partial match for first names

3. **Map client IDs to ProofHub project IDs in `src/config/clients.json`:**
   Add `ph_project_id` to each client entry. Known mappings:
   - 1st-choice → 8703304705
   - bearcat → 8149674025
   - echelon → 9104911511
   - empower → 9330165736
   - gs-home-services → 9330152168
   - jerry-levinson → 9330179305
   - legendary-service → 8750225319
   - london-flooring → 9431293364
   - mike-mcvety → 8316677760 (Red Fortress)
   - pearce-hvac → 9353273257
   - prosper-group → 9066064282
   - raider-flooring → 9385295423
   - tom-ruwitch → 8586749449
   - vision-flooring → 9353286826
   - b3x-internal → 8173459981

   For clients without a clear PH project match, leave empty.

4. **Add API endpoints in `src/api/routes.js`:**
   - `GET /api/proofhub/projects` — list all PH projects (from PH API, cached)
   - `GET /api/proofhub/projects/:id/task-lists` — task lists for a project
   - `GET /api/proofhub/people` — list PH people with resolved names
   - `GET /api/proofhub/resolve-owner/:name` — resolve an owner name to PH user
   - `GET /api/proofhub/client-project/:clientId` — get PH project for a client

5. **Add `POST /api/action-items/:id/push-ph` endpoint:**
   - Accept: `{ ph_project_id, ph_task_list_id, ph_assignee_id, title, description, due_date, priority }`
   - Call `createTask()` from proofhub-client.js
   - On success: update action_items row with ph_task_id, ph_project_id, ph_task_list_id, ph_assignee_id, pushed_at, status='pushed'
   - Return: `{ success: true, ph_task_id, ph_task_url }`

6. **Add `POST /api/meetings/:id/push-all-ph` endpoint:**
   - Push all open action items from a meeting to ProofHub
   - Accept: `{ ph_project_id, ph_task_list_id }` (applies to all items)
   - Individual assignees resolved per item via people resolver
   - Return: `{ success: true, pushed: N, tasks: [...] }`

## Files to Create
- `src/lib/proofhub-client.js` — Copied from b3x-client-state
- `src/lib/people-resolver.js` — Name → PH user resolver

## Files to Modify
- `.env` — Add PROOFHUB_API_KEY, PROOFHUB_COMPANY_URL
- `src/config/clients.json` — Add ph_project_id per client
- `src/api/routes.js` — Add ProofHub API endpoints + push endpoints

## Do NOT Touch
- `src/lib/ai-extractor.js` — Phase 06B
- `public/index.html` — Phase 06D handles the push UI
- `src/poll.js`, `src/service.js` — No changes

## Acceptance Criteria
- [ ] ProofHub API client works (can list projects, task lists, people)
- [ ] People resolver maps "Philip Mutrie" → PH user ID correctly
- [ ] People resolver handles fuzzy matches ("Phil" → Philip Mutrie)
- [ ] clients.json has ph_project_id for at least 15 clients
- [ ] GET /api/proofhub/projects returns PH project list
- [ ] GET /api/proofhub/projects/:id/task-lists returns task lists
- [ ] GET /api/proofhub/people returns people with resolved names
- [ ] POST /api/action-items/:id/push-ph creates a real PH task
- [ ] POST /api/meetings/:id/push-all-ph pushes all open items
- [ ] Pushed action items have ph_task_id stored in DB

## Smoke Tests
```bash
# Test 1: ProofHub projects
curl -s http://localhost:3875/zoom/api/proofhub/projects | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('projects',[])), 'projects')"
→ expect: 30+ projects

# Test 2: Task lists for Bearcat (8149674025)
curl -s http://localhost:3875/zoom/api/proofhub/projects/8149674025/task-lists | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('task_lists',d)), 'task lists')"
→ expect: at least 1 task list

# Test 3: People resolver
curl -s http://localhost:3875/zoom/api/proofhub/resolve-owner/Philip%20Mutrie | python3 -m json.tool
→ expect: { ph_id: "12896349500", email: "Phil@breakthrough3x.com" }

# Test 4: Fuzzy resolve
curl -s http://localhost:3875/zoom/api/proofhub/resolve-owner/Phil | python3 -c "import sys,json; print(json.load(sys.stdin).get('ph_id','none'))"
→ expect: 12896349500

# Test 5: Client project mapping
curl -s http://localhost:3875/zoom/api/proofhub/client-project/bearcat | python3 -c "import sys,json; print(json.load(sys.stdin).get('ph_project_id','none'))"
→ expect: 8149674025

# Test 6: clients.json has PH project IDs
node -e "import fs from 'fs'; const c = JSON.parse(fs.readFileSync('src/config/clients.json','utf8')); const filled = c.clients.filter(x=>x.ph_project_id); console.log(filled.length, 'clients with PH project');"
→ expect: 15+

# Test 7: Push single item (use a test action item)
# Note: This creates a REAL ProofHub task — use a test project if available
curl -s -X POST http://localhost:3875/zoom/api/action-items/1/push-ph -H 'Content-Type: application/json' -d '{"ph_project_id":"8173459981","ph_task_list_id":"","title":"Test task from Zoom pipeline","description":"Testing PH integration"}' | python3 -m json.tool
→ expect: { success: true, ph_task_id: ... } or meaningful error
```

## Completion Instructions
1. Run smoke tests 1-6 (skip 7 if you don't want to create a real PH task)
2. Write result to `.planning/phases/06C-proofhub-integration/result.md`
3. Commit with prefix `[zoom-pipeline-06C]`
