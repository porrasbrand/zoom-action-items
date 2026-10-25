# Phase 06C: ProofHub Integration (People Resolver + Client Mapping)

## Context
The agency-client-state project on production server has a fully working ProofHub API client at `../agency-client-state/lib/proofhub-client.js`. It provides: getProjects(), getTaskLists(), getTasks(), createTask(), getPeople(). ProofHub credentials are in `../agency-client-state/.env` (PROOFHUB_API_KEY, PROOFHUB_COMPANY_URL).

Available ProofHub data:
- 31 projects (Delta Pro, Zeta Coaching, Ledger CFO, Theta Systems Electric, etc.)
- Task lists per project (e.g., "Delta Pro - Traffic | Campaigns | Reporting")
- People: alex@example.com (1000000005), kris@example.com (1000000006), chris@example.com (1000000007), mika@example.com (1000000010), jules.traffic@example.com (1000000009), etc.

Action items have owner_name from transcripts: "Alex Rivera", "Jamie Lee", "Kris Soto", "Leo Park", etc.
Clients in meetings map to PH projects: zeta-coaching → "Zeta Coaching", theta → "Sam Carter - Theta Systems Electric", etc.

## Objective
1. Copy ProofHub API client to zoom-action-items project
2. Build a people resolver that maps transcript speaker names to PH user IDs
3. Map client IDs to ProofHub project IDs in clients.json
4. Add API endpoints for PH projects, task lists, and people (for UI dropdowns)

## Implementation Steps

1. **Copy ProofHub client:**
   - Copy `../agency-client-state/lib/proofhub-client.js` to `./src/lib/proofhub-client.js`
   - Copy PROOFHUB_API_KEY, PROOFHUB_COMPANY_URL, PROOFHUB_AWESOME_TEAM_ID from agency-client-state/.env to zoom-action-items/.env

2. **Create people resolver `src/lib/people-resolver.js`:**
   - Hardcoded mapping table (most reliable for small team):
   ```javascript
   const PEOPLE_MAP = [
     { names: ['Alex Rivera', 'Alex', 'Alex Rivera'], ph_id: '1000000005', email: 'alex@example.com' },
     { names: ['Kris Soto', 'Kris'], ph_id: '1000000006', email: 'kris@example.com' },
     { names: ['Chris', 'Chris Novak', 'Pat Olsen', 'Pat O'], ph_id: '1000000007', email: 'chris@example.com' },
     { names: ['Leo', 'Leo Park'], ph_id: '1000000008', email: 'sam@example.com' },
     { names: ['Jules', 'Jules Hart', 'Jules/Traffic Team'], ph_id: '1000000009', email: 'jules.traffic@example.com' },
     { names: ['Mika', 'Mika Chen'], ph_id: '1000000010', email: 'mika@example.com' },
     { names: ['Nina', 'Nina Ward'], ph_id: '1000000011', email: 'nina.ward@example.com' },
     { names: ['Manuel', 'Manuel Porras'], ph_id: '1000000012', email: 'user2@example.com' },
     { names: ['Sam', 'Sam Ortiz'], ph_id: '1000000008', email: 'sam@example.com' },
     { names: ['Dana Z', 'Dana'], ph_id: '1000000013', email: 'dana@example.com' },
     { names: ['Ivy'], ph_id: '1000000014', email: 'ivy.traffic@example.com' },
     { names: ['Jamie Lee', 'Jamie', "Jamie's Team"], ph_id: null, email: 'jamie@example.com', note: 'CEO - usually delegates' },
   ];
   ```
   - Export `resolvePerson(ownerName)` → returns `{ ph_id, email, name }` or null
   - Export `getAllPeople()` → returns full list for dropdowns
   - Fuzzy match: case-insensitive, trim whitespace, partial match for first names

3. **Map client IDs to ProofHub project IDs in `src/config/clients.json`:**
   Add `ph_project_id` to each client entry. Known mappings:
   - delta-pro → 1000000019
   - zeta-coaching → 1000000020
   - theta → 1000000021
   - tau-home → 1000000022
   - rho-home-services → 1000000023
   - rowan-pryce → 1000000024
   - epsilon-service → 1000000025
   - chi-flooring → 1000000026
   - casey-lowe → 1000000027 (Kappa Security)
   - acme-hvac → 1000000028
   - gamma-group → 1000000029
   - upsilon-flooring → 1000000030
   - taylor-brooks → 1000000031
   - phi-flooring → 1000000032
   - agency-internal → 1000000033

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
- `src/lib/proofhub-client.js` — Copied from agency-client-state
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
- [ ] People resolver maps "Alex Rivera" → PH user ID correctly
- [ ] People resolver handles fuzzy matches ("Alex" → Alex Rivera)
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

# Test 2: Task lists for Zeta Coaching (1000000020)
curl -s http://localhost:3875/zoom/api/proofhub/projects/1000000020/task-lists | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('task_lists',d)), 'task lists')"
→ expect: at least 1 task list

# Test 3: People resolver
curl -s http://localhost:3875/zoom/api/proofhub/resolve-owner/Alex%20Rivera | python3 -m json.tool
→ expect: { ph_id: "1000000005", email: "alex@example.com" }

# Test 4: Fuzzy resolve
curl -s http://localhost:3875/zoom/api/proofhub/resolve-owner/Alex | python3 -c "import sys,json; print(json.load(sys.stdin).get('ph_id','none'))"
→ expect: 1000000005

# Test 5: Client project mapping
curl -s http://localhost:3875/zoom/api/proofhub/client-project/zeta-coaching | python3 -c "import sys,json; print(json.load(sys.stdin).get('ph_project_id','none'))"
→ expect: 1000000020

# Test 6: clients.json has PH project IDs
node -e "import fs from 'fs'; const c = JSON.parse(fs.readFileSync('src/config/clients.json','utf8')); const filled = c.clients.filter(x=>x.ph_project_id); console.log(filled.length, 'clients with PH project');"
→ expect: 15+

# Test 7: Push single item (use a test action item)
# Note: This creates a REAL ProofHub task — use a test project if available
curl -s -X POST http://localhost:3875/zoom/api/action-items/1/push-ph -H 'Content-Type: application/json' -d '{"ph_project_id":"1000000033","ph_task_list_id":"","title":"Test task from Zoom pipeline","description":"Testing PH integration"}' | python3 -m json.tool
→ expect: { success: true, ph_task_id: ... } or meaningful error
```

## Completion Instructions
1. Run smoke tests 1-6 (skip 7 if you don't want to create a real PH task)
2. Write result to `.planning/phases/06C-proofhub-integration/result.md`
3. Commit with prefix `[zoom-pipeline-06C]`
