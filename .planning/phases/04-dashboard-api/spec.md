# Phase 04: Dashboard API

## Context
Phases 01-03 are complete. The pipeline runs on Hetzner every 5 minutes via PM2, processes Zoom recordings through Gemini AI, and stores results in SQLite. Slack posting is paused (DRY_RUN=true) — the web dashboard is now the priority review interface.

The SQLite database at `data/zoom-action-items.db` has three tables:
- `meetings` — id, zoom_meeting_uuid, topic, client_id, client_name, start_time, duration_minutes, transcript_raw, ai_extraction (JSON), status, slack_message_ts, slack_channel_id, error_message, created_at, updated_at
- `action_items` — id, meeting_id, client_id, title, description, owner_name, due_date, priority, category, ph_task_id, status (open/complete/rejected), created_at
- `decisions` — id, meeting_id, client_id, decision, context, created_at

The Hetzner server runs Apache with reverse proxy. Existing pattern: `manuelporras.com/slack/` → `localhost:3861`. We'll follow the same pattern for `/zoom/`.

Express is already a dependency (used by b3x-client-state). The zoom project currently only has `better-sqlite3`, `@google/generative-ai`, `@slack/web-api`, and `dotenv` as dependencies.

## Objective
Build a REST API serving meeting data from SQLite, with endpoints for listing, filtering, viewing details, and managing action items. Set up Express server with PM2 and Apache reverse proxy at `manuelporras.com/zoom/`.

## Implementation Steps

1. **Add Express dependency:**
   ```bash
   npm install express
   ```

2. **Create `src/api/server.js`** — Express app:
   - Port: 3870 (check it's not in use — interview-bot uses 3870, pick 3875 instead)
   - Serve static files from `public/` directory
   - Mount API routes at `/api/`
   - CORS headers for development
   - Cache-Control: no-store for API responses
   - Serve `public/index.html` for `/` and all non-API routes (SPA pattern)

3. **Create `src/api/routes.js`** — All API endpoints:

   **Meetings:**
   - `GET /api/meetings` — List meetings with filters
     - Query params: `client_id`, `status`, `from` (date), `to` (date), `limit` (default 50), `offset`, `sort` (desc/asc)
     - Returns: `{ meetings: [...], total, limit, offset }`
     - Each meeting includes: id, topic, client_name, start_time, duration_minutes, status, action_item_count, decision_count
   - `GET /api/meetings/:id` — Full meeting detail
     - Returns: meeting record + parsed ai_extraction + action_items[] + decisions[]
     - Include formatted transcript (speaker-labeled segments)
   - `GET /api/meetings/:id/transcript` — Raw transcript text
   - `PUT /api/meetings/:id` — Update meeting (status, client assignment)

   **Action Items:**
   - `GET /api/action-items` — List all action items with filters
     - Query params: `client_id`, `status` (open/complete/rejected), `owner_name`, `meeting_id`, `limit`, `offset`
     - Returns: `{ items: [...], total }`
   - `GET /api/action-items/:id` — Single action item detail
   - `PUT /api/action-items/:id` — Update action item (title, description, owner, due_date, priority, status)
   - `POST /api/action-items/:id/complete` — Mark as complete
   - `POST /api/action-items/:id/reject` — Mark as rejected (AI hallucination, not real task)
   - `POST /api/action-items/:id/reopen` — Reopen a completed/rejected item

   **Decisions:**
   - `GET /api/decisions` — List decisions with filters
     - Query params: `client_id`, `meeting_id`, `limit`, `offset`

   **Clients:**
   - `GET /api/clients` — List all clients from clients.json with meeting counts
     - Include: id, name, total_meetings, total_action_items, last_meeting_date

   **Stats:**
   - `GET /api/stats` — Overview statistics
     - meetings_total, meetings_today, meetings_this_week
     - action_items_total, action_items_open, action_items_completed, action_items_rejected
     - top_clients (by meeting count)
     - average_action_items_per_meeting

   **Health:**
   - `GET /api/health` — Pipeline status
     - db_size, total_meetings, last_processed, pipeline_status (from PM2)

4. **Create `src/api/db-queries.js`** — Database query helpers:
   - Wrap better-sqlite3 queries in reusable functions
   - Avoid raw SQL in routes
   - Handle pagination consistently

5. **Create PM2 config for dashboard:**
   - Add to existing `ecosystem.config.cjs` as a second app: `zoom-dashboard`
   - Or create separate `ecosystem.dashboard.cjs`

6. **Configure Apache reverse proxy:**
   - Add to the existing Apache config on Hetzner:
   ```apache
   <Location "/zoom/">
       ProxyPass "http://127.0.0.1:3875/zoom/"
       ProxyPassReverse "http://127.0.0.1:3875/zoom/"
   </Location>
   ```
   - Server must handle the `/zoom/` prefix in all routes

7. **Handle the `/zoom/` base path:**
   - Express serves static at `/zoom/`
   - API routes at `/zoom/api/`
   - Or strip prefix via Apache and serve at `/`
   - Simplest: Express app mounted at `/zoom` prefix

## Files to Create
- `src/api/server.js` — Express application
- `src/api/routes.js` — API route definitions
- `src/api/db-queries.js` — Database query helpers
- `public/index.html` — Placeholder HTML (Phase 05 builds the real UI)

## Files to Modify
- `package.json` — Add express dependency, add "dashboard" script
- `ecosystem.config.cjs` — Add zoom-dashboard process

## Do NOT Touch
- `src/poll.js` — Pipeline logic, no changes
- `src/service.js` — Pipeline service, no changes
- `src/lib/` — All existing lib files unchanged
- `data/zoom-action-items.db` — Read-only from API (writes only from pipeline)

## Acceptance Criteria
- [ ] `GET /zoom/api/meetings` returns meeting list from SQLite
- [ ] `GET /zoom/api/meetings/:id` returns full meeting detail with action items and decisions
- [ ] `GET /zoom/api/action-items` returns filterable action items list
- [ ] `PUT /zoom/api/action-items/:id` updates an action item
- [ ] `POST /zoom/api/action-items/:id/complete` marks item as complete
- [ ] `POST /zoom/api/action-items/:id/reject` marks item as rejected
- [ ] `GET /zoom/api/clients` returns client list with meeting counts
- [ ] `GET /zoom/api/stats` returns overview statistics
- [ ] `GET /zoom/api/health` returns pipeline status
- [ ] Dashboard accessible at https://www.manuelporras.com/zoom/
- [ ] PM2 process `zoom-dashboard` is running
- [ ] Apache reverse proxy configured and working

## Smoke Tests
Run these AFTER implementation to verify:

```bash
# Test 1: Express server starts
pm2 start ecosystem.config.cjs --only zoom-dashboard 2>/dev/null || pm2 restart zoom-dashboard
sleep 3 && pm2 status zoom-dashboard | grep online
→ expect: online

# Test 2: Meetings list
curl -s http://localhost:3875/zoom/api/meetings | python3 -c "import sys,json; d=json.load(sys.stdin); print('meetings:', len(d.get('meetings',[])))"
→ expect: meetings: 6+ (from earlier pipeline runs)

# Test 3: Meeting detail
curl -s http://localhost:3875/zoom/api/meetings/1 | python3 -c "import sys,json; d=json.load(sys.stdin); m=d.get('meeting',d); print('topic:', m.get('topic','?')); print('action_items:', len(d.get('action_items',[])))"
→ expect: topic and action items present

# Test 4: Action items list
curl -s http://localhost:3875/zoom/api/action-items | python3 -c "import sys,json; d=json.load(sys.stdin); print('items:', len(d.get('items',[])))"
→ expect: items: 10+ (from earlier extractions)

# Test 5: Update action item
curl -s -X POST http://localhost:3875/zoom/api/action-items/1/complete | python3 -m json.tool
→ expect: {"success": true} or similar

# Test 6: Stats
curl -s http://localhost:3875/zoom/api/stats | python3 -m json.tool
→ expect: JSON with meetings_total, action_items_total, etc.

# Test 7: Clients list
curl -s http://localhost:3875/zoom/api/clients | python3 -c "import sys,json; d=json.load(sys.stdin); print('clients:', len(d.get('clients',[])))"
→ expect: clients: 30+

# Test 8: Apache proxy (external access)
curl -s https://www.manuelporras.com/zoom/api/health | python3 -m json.tool
→ expect: JSON health response (if Apache configured)

# Test 9: Health endpoint
curl -s http://localhost:3875/zoom/api/health | python3 -c "import sys,json; d=json.load(sys.stdin); print('total_meetings:', d.get('total_meetings','?'))"
→ expect: total_meetings: 6+
```

## Completion Instructions
1. Run all smoke tests and confirm they pass
2. Write result to: `.planning/phases/04-dashboard-api/result.md`
3. Commit all changes with prefix: `[zoom-pipeline-04]`
