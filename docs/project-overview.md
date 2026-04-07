# Zoom Action Items Pipeline — Project Overview

## What This Project Does

Automated pipeline that transforms Zoom meeting recordings into structured, actionable intelligence within 15 minutes of a call ending. Summaries are posted to per-client Slack channels, action items are pushed to ProofHub, meeting quality is scored by AI, and PPC task accountability is tracked across meetings.

**Problem it solves:** B3X holds ~30 client Zoom meetings/week. Raw transcripts dumped to Google Drive were never read. Action items surfaced 1-2 days late through manual recall. Meeting quality was unmeasured. PPC tasks discussed in meetings were never verified as completed.

**Deployed on:** Hetzner VPS (`~/awsc-new/awesome/zoom-action-items/`)
**Dashboard:** https://www.manuelporras.com/zoom/ (port 3875, reverse-proxied via Apache)
**Mirror:** https://ai.breakthrough3x.com/zoom/ (read-only, hourly sync from production)

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
[6] SESSION EVALUATION (non-blocking)
    session-metrics.js computes SQL metrics (speaker ratios, action density)
    session-evaluator.js sends transcript to GPT-5.4 for 12-dimension scoring
    session-baselines.js computes P25/P50/P75 percentile baselines
    Results stored in session_metrics + session_evaluations tables
       |
       v
[7] PPC TRACKING (non-blocking)
    ppc-task-tracker.js classifies PPC action items via Gemini 2.0 Flash
    Matches against ProofHub tasks via GPT-5.4 semantic matching
    Results stored in ppc_task_tracking table
       |
       v
[8] HUMAN REVIEW (Dashboard)
    Team reviews at manuelporras.com/zoom/
    Can edit action items, mark complete/reject, view transcript excerpts
    Session Intelligence tab shows meeting quality scores + coaching
    PPC Tasks tab shows accountability tracking
       |
       v
[9] PROOFHUB PUSH (Manual or Auto via Dashboard UI)
    Click "Push to PH" per action item or bulk push
    Auto-push for high-confidence items
    Creates real ProofHub tasks with assignee, due date, priority
    people-resolver.js maps speaker names to ProofHub user IDs
       |
       v
[10] ROADMAP & PREP
    roadmap-processor.js builds cross-meeting strategic roadmaps per client
    prep-generator.js creates meeting prep briefings with context, stale items, talking points
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js (ESM modules) |
| Database | SQLite via `better-sqlite3` (WAL mode) |
| AI — Extraction | Gemini 2.0 Flash (`@google/generative-ai`) |
| AI — Session Evaluation | OpenAI GPT-5.4 (via `model-providers.js`) |
| AI — PPC Classification | Gemini 2.0 Flash |
| AI — ProofHub Matching | OpenAI GPT-5.4 |
| AI — Roadmaps/Prep | Gemini 2.5 Flash |
| AI — UX Audit | Gemini Vision (screenshot analysis) |
| Slack | `@slack/web-api` (B3X Claude Assistant bot) |
| Dashboard API | Express (port 3875) |
| Dashboard UI | Single-file SPA (`public/index.html`, dark theme, ~9100 lines) |
| Process Mgmt | PM2 (`ecosystem.config.cjs`) |
| Task Mgmt | ProofHub REST API |
| Testing | Playwright + Gemini Vision (AI-powered UI audit) |
| Auth | Google OAuth2 (porrasbrand@gmail.com, Claude Email Integration project) |

---

## File Structure

```
zoom-action-items/
  src/
    poll.js              # CLI entry point (run-once, supports --dry-run)
    service.js           # Long-running PM2 wrapper (5-min interval)
    ppc-tracker.js       # PPC task tracker CLI (--meeting, --backfill, --report)
    lib/
      zoom-client.js     # Zoom S2S OAuth, recording discovery, VTT download
      vtt-parser.js      # Parse VTT transcripts to speaker-labeled text
      client-matcher.js  # Match meeting topics to clients via keywords
      ai-extractor.js    # Gemini structured extraction (summary, items, decisions)
      slack-publisher.js # Format & post to Slack channels (respects DRY_RUN)
      database.js        # SQLite CRUD, dedup, migrations
      auth.js            # Google OAuth2 + session management
      proofhub-client.js # ProofHub API (projects, task lists, people, createTask)
      people-resolver.js # Map speaker names to ProofHub user IDs
      auto-push.js       # Automated ProofHub task push with confidence scoring
      auto-push-notifier.js # Slack notifications for auto-pushed items
      roadmap-db.js      # Roadmap SQLite operations
      roadmap-processor.js # Cross-meeting roadmap AI engine
      prep-collector.js  # Meeting prep data collection
      prep-generator.js  # Meeting prep AI generation (5 sections incl. projected roadmap)
      prep-formatter.js  # Prep output formatting (Markdown, JSON, Slack)
      ph-reconciler.js   # ProofHub task reconciliation engine
      session-metrics.js # SQL baseline metrics (speaker ratios, action density, etc.)
      session-evaluator.js # Multi-model AI session evaluation (GPT-5.4 default)
      session-baselines.js # P25/P50/P75 percentile computation per client
      session-queries.js # Session Intelligence API query functions
      session-digest.js  # Weekly coaching digest + Slack formatting
      model-providers.js # Unified API for OpenAI/Anthropic/Google models
      ppc-task-tracker.js # PPC classification + ProofHub matching + reporting
      confidence-calculator.js # ProofHub push confidence scoring
      coverage-analyzer.js # Action item coverage analysis
      keyword-scanner.js # Keyword-based matching utilities
      summary-detector.js # Meeting summary detection
      summary-extractor.js # Summary extraction from transcripts
      adversarial-verifier.js # AI extraction verification
    config/
      clients.json       # 30+ clients: keywords, slack_channel_id, ph_project_id
    api/
      server.js          # Express app (port 3875, static files, auth, SPA)
      routes.js          # REST endpoints (~2300 lines, 40+ endpoints)
      db-queries.js      # Database query helpers (pagination, filtering)
  public/
    index.html           # Dark-theme dashboard SPA (~9100 lines)
  scripts/
    model-comparison-v2.mjs  # Multi-model comparison: 10 meetings × 4 models
    consensus-calibration.mjs # Consensus-based model calibration (MAE + Pearson)
    audit-no-shows.mjs       # Retroactive meeting classification scan
    mirror-sync.sh           # Production → dev mirror sync script
    health-check.sh          # PM2 status, last poll time, error scan
    ecosystem.config.cjs     # PM2 config: zoom-pipeline + zoom-dashboard
  tests/
    session-intelligence-audit.js  # AI Playwright testing agent (960 lines, 50+ checks)
    dashboard-audit.js             # Regression test suite (45 checks)
  data/
    zoom-action-items.db   # Main SQLite database (gitignored)
    zoom-auth.db           # OAuth sessions database (gitignored)
  .planning/
    brief.md               # Project goals, boundaries, credentials
    project.md             # Phase overview, dependencies, risks
    status.json            # Current phase tracking (28/28 complete)
    events.jsonl           # Timestamped audit trail
    phases/                # Per-phase spec.md files
  docs/
    project-overview.md    # This file
    DEVELOPMENT-WORKFLOW.md # Dev/prod collaboration guide
    IMPLEMENTATION-PLAN.md  # Original 8-phase plan (historical)
  .env                     # Credentials (gitignored)
```

---

## Database Schema (SQLite)

### Core Tables

**meetings** — One row per processed Zoom recording
- `zoom_meeting_uuid` (unique key for dedup), `topic`, `client_id`, `client_name`, `start_time`, `duration_minutes`
- `transcript_raw`, `ai_extraction` (full Gemini JSON response)
- `status`, `slack_message_ts`, `slack_channel_id`, `error_message`

**action_items** — Extracted action items linked to meetings
- `meeting_id` (FK), `client_id`, `title`, `description`, `owner_name`, `due_date`, `priority`, `category`
- `transcript_excerpt` (2-4 lines of context from transcript)
- `ph_task_id`, `ph_project_id`, `ph_task_list_id`, `ph_assignee_id` (ProofHub linkage)
- `status` (new/pushed/complete/rejected), `pushed_at`

**decisions** — Key decisions recorded during meetings
- `meeting_id` (FK), `client_id`, `decision`, `context`

### Roadmap & Prep Tables

**roadmap_items** — Cross-meeting strategic roadmap items per client
**roadmap_snapshots** — Point-in-time roadmap snapshots
**roadmap_ph_links** — Roadmap ↔ ProofHub task linkage
**cockpit_selections** — Meeting cockpit view state

### Session Intelligence Tables

**session_metrics** — SQL-computed meeting metrics (speaker ratios, action density, etc.)
**session_evaluations** — AI evaluation scores per meeting (12 dimensions, composite, coaching)
- `model_used`: `gpt-5.4` (production), `human-calibration`, `consensus-average`, etc.
- `meeting_type`: `regular`, `no-show`, `test`, `internal`
- Per-dimension scores (1-4), composite score, coaching notes, transcript quotes
**session_baselines** — P25/P50/P75 percentile baselines per client

### PPC Tracking Tables

**ppc_task_tracking** — PPC action item lifecycle tracking
- `meeting_id`, `action_item_index`, `task_title`, `task_description`
- `platform` (google_ads, google_lsa, meta, bing, multiple, unknown)
- `action_type` (create, modify, pause, enable, budget, targeting, reporting)
- `proofhub_match` (NULL=unchecked, 0=no match, 1=matched)
- `completion_score`, `days_to_proofhub`
- `disposition` (pending, completed, cancelled, deprioritized, blocked)

### Auth Tables

**auth_users** — Authorized dashboard users (Google OAuth)
**auth_sessions** — Active sessions
**api_tokens** — API bearer tokens
**auto_push_drafts** — ProofHub auto-push queue

---

## Dashboard Tabs

### 1. Meetings
- Meeting list with client filter, date range, search
- Meeting detail: summary, action items, decisions, transcript excerpts
- Action item management: edit, push to ProofHub, mark status

### 2. Roadmap
- Per-client strategic roadmap cards
- Category/status/owner filters
- Timeline toggle
- ProofHub reconciliation status

### 3. Meeting Prep
- Generate 5-section meeting prep briefings
- Context from last N meetings, open items, stale tasks
- Projected roadmap with actionable proposals
- Pre-huddle brief format
- Post to Slack

### 4. Session Intelligence
Seven sub-views:
- **Overview** — Agency composite score, client health grid, flag counts
- **Meeting Scorecard** — 12-dimension breakdown, coaching insights with quotes, prev/next navigation, delta badges, biggest movers
- **Client Trends** — Comparison table, SVG trend charts, baseline overlays
- **Team Performance** — Per-member cards, difficulty-adjusted scores
- **Flags & Alerts** — Three-tier severity cards (critical/warning/info), client-grouped, trend-based urgency scoring
- **Calibration** — Human scoring form for 10 selected meetings, model comparison (MAE + Pearson)
- **PPC Tasks** — Agency-wide and per-client PPC task accountability

---

## External Services & Credentials (.env)

| Service | Env Vars | Purpose |
|---------|----------|---------|
| Zoom API | `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET` | S2S OAuth, fetch recordings & transcripts |
| Gemini | `GOOGLE_API_KEY` | AI extraction, PPC classification, roadmaps, UX audit |
| OpenAI | `OPENAI_API_KEY`, `SESSION_EVAL_MODEL` | Session evaluation (GPT-5.4), ProofHub matching |
| Anthropic | `ANTHROPIC_API_KEY` | Model comparison (Claude Opus) |
| Slack | `SLACK_BOT_TOKEN`, `SLACK_ALERT_CHANNEL` | Post summaries, coaching digest, error alerts |
| ProofHub | `PROOFHUB_API_KEY`, `PROOFHUB_COMPANY_URL`, `PROOFHUB_AWESOME_TEAM_ID` | Create tasks, resolve people, PPC matching |
| Google OAuth | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET` | Dashboard authentication |
| Config | `DRY_RUN` | `true` = skip Slack posting (testing mode) |

Slack bot token is shared from the `slack-mention-tracker` project (B3X Claude Assistant bot).

---

## PM2 Processes (ecosystem.config.cjs)

| Process | Command | Behavior |
|---------|---------|----------|
| `zoom-pipeline` | `node src/service.js` | Polls Zoom API every 5 min, processes new recordings, runs session eval + PPC tracking |
| `zoom-dashboard` | `node src/api/server.js` | Express on port 3875, serves dashboard + REST API |

Start: `pm2 start ecosystem.config.cjs`
Health: `bash scripts/health-check.sh`

---

## Development Phases (All Complete)

| Phase | Name | Status |
|-------|------|--------|
| 01 | Core Pipeline (Zoom API → Gemini → DB) | COMPLETE |
| 02 | Deployment & Operations (PM2, health checks) | COMPLETE |
| 03 | Slack Channel Routing (per-client posting) | COMPLETE |
| 04 | Dashboard API (Express REST endpoints) | COMPLETE |
| 05 | Dashboard Frontend (dark-theme SPA) | COMPLETE |
| 06A | Editable Action Items (inline editing) | COMPLETE |
| 06B | Transcript Excerpts (per-item context) | COMPLETE |
| 06C | ProofHub Integration (API client, people resolver) | COMPLETE |
| 06D | Push UI (dashboard ProofHub push flow) | COMPLETE |
| 08A | Client Roadmap Engine (cross-meeting intelligence) | COMPLETE |
| 08B | Meeting Prep Generator (5-section briefing) | COMPLETE |
| 09 | AI Evaluation (pipeline quality check) | COMPLETE |
| 10 | Roadmap & Prep Dashboard (frontend tabs) | COMPLETE |
| 11 | Playwright Audit (45/45 tests pass) | COMPLETE |
| 13 | Projected Roadmap (proposal engine) | COMPLETE |
| 14A | ProofHub Reconciliation (task linking) | COMPLETE |
| 14B | Meeting Cockpit Data (backend) | COMPLETE |
| 14C | Meeting Cockpit UI (frontend) | COMPLETE |
| 15A | Session Metrics Engine (SQL baselines) | COMPLETE |
| 15B | Session Evaluator + Model Comparison | COMPLETE |
| 15B-v | Rubric Calibration & Validation | COMPLETE |
| 15C | Pipeline Integration + Baselines | COMPLETE |
| 15D | Session Intelligence API (6 endpoints) | COMPLETE |
| 15E | Dashboard UI — Session Intelligence Tab | COMPLETE |
| 15F | Regression & E2E Tests (25/30 pass) | COMPLETE |
| 15G | Coaching Digest & Alerts | COMPLETE |
| 16A | AI Audit Agent (960-line Playwright) | COMPLETE |
| 16B | Audit Bug Fix & Re-verify (48/50 pass) | COMPLETE |
| 20 | Flagging Redesign (3-tier, trend-based) | COMPLETE |
| 21A | PPC Task Accountability Tracker MVP | COMPLETE |

Phase specs live in `.planning/phases/<phase-id>/spec.md`.

---

## Session Intelligence Details

### Scoring Rubric (12 Dimensions)

| Tier | Weight | Dimensions | Scale |
|------|--------|-----------|-------|
| Deal Breakers | 40% | Client Sentiment, Accountability, Relationship Health | 1-4 |
| Core Competence | 35% | Meeting Structure, Value Delivery, Action Discipline, Proactive Leadership | 1-4 |
| Efficiency | 25% | Time Utilization, Redundancy, Client Confusion, Meeting Momentum, Save Rate | 1-4 |

**Composite** = (Tier1 avg × 0.40) + (Tier2 avg × 0.35) + (Tier3 avg × 0.25)

### Meeting Classification

| Type | Detection | Treatment |
|------|-----------|-----------|
| Regular | Default | Fully scored |
| No-show | Client not in transcript | NULL composite, tracked as engagement signal |
| Test | "Test" in topic, <2 min | Excluded from all metrics |
| Internal | Only B3X speakers | Excluded from client metrics |

### Production Model: GPT-5.4

Selected via consensus calibration (average of 4 models as ground truth):

| Model | MAE | Pearson r |
|-------|-----|-----------|
| **GPT-5.4** | **0.229** | **0.910** |
| Claude Opus 4.6 | 0.246 | 0.909 |
| Gemini 2.0 Flash | 0.321 | 0.821 |
| Gemini 3.1 Pro | 0.417 | 0.780 |

---

## PPC Task Accountability Tracker

### What It Tracks
PPC-related action items from meetings → ProofHub verification → completion scoring.

### How It Works
1. **Classify**: Gemini 2.0 Flash identifies PPC action items (Google Ads, LSA, Meta, Bing)
2. **Match**: GPT-5.4 semantically matches against ProofHub tasks (10-day window)
3. **Score**: Completion score 0-100 based on ProofHub tracking + time to track
4. **Report**: Per-client and agency-wide accountability metrics

### Current Results (April 2026)
- 107 PPC tasks identified across 42 meetings, 19 clients
- 15 tracked in ProofHub (14%)
- 86% accountability gap discovered

### Future Phases
- **21B**: Slack verification (Checkpoint 1)
- **21C**: Ad platform execution verification (Checkpoint 3)

---

## Deployment

### Production (Hetzner)
- **URL:** https://www.manuelporras.com/zoom/
- **Path:** `~/awsc-new/awesome/zoom-action-items/`
- **PM2:** `zoom-pipeline` + `zoom-dashboard`
- **Apache:** Reverse proxy on port 3875

### Mirror (Dev/Staging)
- **URL:** https://ai.breakthrough3x.com/zoom/
- **Path:** `/home/vince/zoom-action-items/`
- **Sync:** Hourly cron (git pull + DB SCP from production)
- **Purpose:** Read-only mirror, dev environment for Vince
- **Only dashboard runs** — no pipeline, no Slack posting, no ProofHub push

### Branch Protection
- GitHub: `master` branch protected, PRs required
- `enforce_admins=false` for owner hotfix bypass

---

## Quick Reference Commands (on Hetzner)

```bash
# Start services
pm2 start ecosystem.config.cjs

# Check health
bash scripts/health-check.sh
curl http://localhost:3875/zoom/api/health

# Run pipeline once (testing)
node src/poll.js --dry-run

# PPC tracker
node src/ppc-tracker.js --meeting 86      # Track one meeting
node src/ppc-tracker.js --backfill        # All meetings
node src/ppc-tracker.js --report --agency # Agency report

# View logs
pm2 logs zoom-pipeline --lines 50
pm2 logs zoom-dashboard --lines 50

# Restart after code changes
pm2 restart zoom-pipeline zoom-dashboard

# Run tests
node tests/session-intelligence-audit.js  # AI audit (50+ checks)
node tests/dashboard-audit.js             # Regression (45 checks)
```
