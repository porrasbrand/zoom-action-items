# Zoom Action Items Pipeline - Project Overview

## What This Project Does

Automated pipeline that transforms Zoom meeting recordings into structured, actionable summaries within 15 minutes of a call ending. Summaries are posted to per-client Slack channels and action items can be pushed to ProofHub for task tracking.

**Problem it solves:** B3X holds ~30 client Zoom meetings/week. Raw transcripts dumped to Google Drive were never read. Action items surfaced 1-2 days late through manual recall, causing client frustration.

**Deployed on:** Hetzner VPS (`~/awsc-new/awesome/zoom-action-items/`)
**Dashboard:** https://www.manuelporras.com/zoom/ (port 3875, reverse-proxied via Apache)

---

## End-to-End Workflow

```
Zoom Meeting Ends
       |
       v
[1] POLL (every 5 min via PM2)
    zoom-client.js fetches recent recordings from Zoom API (S2S OAuth)
    vtt-parser.js converts VTT transcript to speaker-labeled text
    database.js deduplicates by zoom_meeting_uuid
       |
       v
[2] CLIENT MATCHING
    client-matcher.js matches meeting topic to 30+ known clients
    via keyword matching against src/config/clients.json
       |
       v
[3] AI EXTRACTION
    ai-extractor.js sends transcript to Gemini 2.0 Flash
    Returns structured JSON: summary, action_items[], decisions[]
    Each action item includes: title, owner, due_date, priority, category, transcript_excerpt
       |
       v
[4] DATABASE STORAGE
    Inserts meeting, action_items, decisions into SQLite
    (data/zoom-action-items.db)
       |
       v
[5] SLACK POSTING
    slack-publisher.js posts formatted summary to #int-<client-name>
    Unmatched meetings go to #zoom-unmatched triage channel
    Controlled by DRY_RUN env var
       |
       v
[6] HUMAN REVIEW (Dashboard)
    Team reviews at manuelporras.com/zoom/
    Can edit action items, mark complete/reject, view transcript excerpts
       |
       v
[7] PROOFHUB PUSH (Manual via Dashboard UI)
    Click "Push to PH" per action item or bulk push
    Creates real ProofHub tasks with assignee, due date, priority
    people-resolver.js maps speaker names to ProofHub user IDs
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js (ESM modules) |
| Database | SQLite via `better-sqlite3` |
| AI | Gemini 2.0 Flash (`@google/generative-ai`) |
| Slack | `@slack/web-api` (B3X Claude Assistant bot) |
| Dashboard API | Express (port 3875) |
| Dashboard UI | Single-file SPA (`public/index.html`, dark theme, ~3000 lines inline) |
| Process Mgmt | PM2 (`ecosystem.config.cjs`) |
| Task Mgmt | ProofHub REST API |

---

## File Structure

```
zoom-action-items/
  src/
    poll.js              # CLI entry point (run-once, supports --dry-run)
    service.js           # Long-running PM2 wrapper (5-min interval)
    lib/
      zoom-client.js     # Zoom S2S OAuth, recording discovery, VTT download
      vtt-parser.js      # Parse VTT transcripts to speaker-labeled text
      client-matcher.js  # Match meeting topics to clients via keywords
      ai-extractor.js    # Gemini structured extraction (summary, items, decisions)
      slack-publisher.js # Format & post to Slack channels (respects DRY_RUN)
      database.js        # SQLite CRUD, dedup, migrations
      proofhub-client.js # ProofHub API (projects, task lists, people, createTask)
      people-resolver.js # Map speaker names to ProofHub user IDs (hardcoded + fuzzy)
    config/
      clients.json       # 30+ clients: keywords, slack_channel_id, ph_project_id
    api/
      server.js          # Express app (port 3875, static files, SPA)
      routes.js          # REST endpoints (/meetings, /action-items, /decisions, /proofhub, /stats)
      db-queries.js      # Database query helpers (pagination, filtering)
  public/
    index.html           # Dark-theme dashboard SPA (meeting list, detail, edit, push UI)
  scripts/
    health-check.sh      # PM2 status, last poll time, error scan
    ecosystem.config.cjs # PM2 config: zoom-pipeline + zoom-dashboard
  data/
    zoom-action-items.db # SQLite database (gitignored)
  .planning/
    brief.md             # Project goals, boundaries, credentials
    project.md           # Phase overview, dependencies, risks
    status.json          # Current phase tracking
    events.jsonl         # Timestamped audit trail
    phases/              # Per-phase spec.md files (01 through 07)
  .env                   # Credentials (gitignored)
```

---

## Database Schema (SQLite)

**meetings** - One row per processed Zoom recording
- `zoom_meeting_uuid` (unique key for dedup), `topic`, `client_id`, `start_time`, `duration_minutes`
- `transcript_raw`, `ai_extraction` (full Gemini JSON response)
- `status`, `slack_message_ts`, `slack_channel_id`, `error_message`

**action_items** - Extracted action items linked to meetings
- `meeting_id` (FK), `client_id`, `title`, `description`, `owner_name`, `due_date`, `priority`, `category`
- `transcript_excerpt` (2-4 lines of context from transcript)
- `ph_task_id`, `ph_project_id`, `ph_task_list_id`, `ph_assignee_id` (ProofHub linkage)
- `status` (new/pushed/complete/rejected), `pushed_at`

**decisions** - Key decisions recorded during meetings
- `meeting_id` (FK), `client_id`, `decision`, `context`

---

## External Services & Credentials (.env)

| Service | Env Vars | Purpose |
|---------|----------|---------|
| Zoom API | `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET` | S2S OAuth, fetch recordings & transcripts |
| Gemini | `GOOGLE_API_KEY` | AI extraction (Flash model only) |
| Slack | `SLACK_BOT_TOKEN`, `SLACK_ALERT_CHANNEL` | Post summaries, error alerts |
| ProofHub | `PROOFHUB_API_KEY`, `PROOFHUB_COMPANY_URL`, `PROOFHUB_AWESOME_TEAM_ID` | Create tasks, resolve people |
| Config | `DRY_RUN` | `true` = skip Slack posting (testing mode) |

Slack bot token is shared from the `slack-mention-tracker` project (B3X Claude Assistant bot).

---

## PM2 Processes (ecosystem.config.cjs)

| Process | Command | Behavior |
|---------|---------|----------|
| `zoom-pipeline` | `node src/service.js` | Polls Zoom API every 5 min, processes new recordings |
| `zoom-dashboard` | `node src/api/server.js` | Express on port 3875, serves dashboard + REST API |

Start: `pm2 start ecosystem.config.cjs`
Health: `bash scripts/health-check.sh`

---

## Development Phases

| Phase | Name | Status |
|-------|------|--------|
| 01 | Core Pipeline (Zoom API -> Gemini -> DB) | COMPLETE |
| 02 | Deployment & Operations (PM2, health checks) | COMPLETE |
| 03 | Slack Channel Routing (per-client posting) | COMPLETE |
| 04 | Dashboard API (Express REST endpoints) | COMPLETE |
| 05 | Dashboard Frontend (dark-theme SPA) | COMPLETE |
| 06A | Editable Action Items (inline editing) | COMPLETE |
| 06B | Transcript Excerpts (per-item context) | COMPLETE |
| 06C | ProofHub Integration (API client, people resolver) | COMPLETE |
| 06D | Push UI (dashboard ProofHub push flow) | COMPLETE |
| 06 | Operations Polish (daily digest, rate limiting) | PENDING |
| 07 | Cross-Meeting Intelligence (prior meeting context) | PENDING |

Phase specs live in `.planning/phases/<phase-id>/spec.md`.

---

## Slack Channel Routing

- Per-client channels: `#int-<client-name>` (bot already a member)
- Unmatched meetings: `#zoom-unmatched` (triage)
- Internal B3X meetings: `#zoom-internal`
- Error alerts: `SLACK_ALERT_CHANNEL`

Client-to-channel mapping is in `src/config/clients.json`.

---

## ProofHub Integration

- **Push flow:** Dashboard UI -> PUT `/api/action-items/:id/push-ph` -> `proofhub-client.js` -> ProofHub API
- **People resolver:** Hardcoded map of known team members (Philip Mutrie, Bill Soady, Richard, Joaco, etc.) with fuzzy matching for transcript speaker names
- **Project mapping:** Each client in `clients.json` has a `ph_project_id`
- **Task creation:** Title, description, assignee, due date pushed as real ProofHub tasks
- **Status tracking:** `ph_task_id` stored back in `action_items` table, status set to `pushed`

---

## Quick Reference Commands (on Hetzner)

```bash
# Start services
pm2 start ecosystem.config.cjs

# Check health
bash scripts/health-check.sh

# Run pipeline once (testing)
node src/poll.js --dry-run

# View logs
pm2 logs zoom-pipeline --lines 50
pm2 logs zoom-dashboard --lines 50

# Restart after code changes
pm2 restart zoom-pipeline
pm2 restart zoom-dashboard
```
