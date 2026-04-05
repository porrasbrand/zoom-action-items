# Zoom Action Items Pipeline — Level-0 Plan

## Overview
Automate Zoom meeting → structured summary → Slack + ProofHub pipeline. Phase 1 (core pipeline) is already built and verified. This orchestration covers deployment through cross-meeting intelligence.

## Phase Overview

### Phase 2: Deployment & Operations
- Set up PM2 process (replace cron — better logging, restart on crash)
- Enable live Slack posting (remove dry-run default)
- Slack alert channel for errors
- Log rotation (daily files, 30-day retention)
- Lock file / singleton guard to prevent overlapping runs
- Startup validation (check all credentials)
- Health check script
- **Files:** ecosystem.config.cjs (PM2), src/poll.js (remove dry-run default), scripts/health-check.sh

### Phase 3: Slack Channel Routing
- Map all 30 clients to their Slack channel IDs in clients.json
- Post each client's meeting notes to their dedicated channel
- Unmatched meetings → #zoom-unmatched triage channel
- Internal B3X meetings → #b3x-internal-notes
- Channel verification on startup (confirm bot access)
- Fallback when channel archived or bot lacks permission
- **Files:** src/config/clients.json (add channel IDs), src/lib/slack-publisher.js

### Phase 4: Dashboard API (REORDERED — was Phase 7)
- Express API server serving meeting data from SQLite
- Endpoints: meetings list, meeting detail, action items, decisions, stats
- Filter by client, date range, status
- Action endpoints: approve/reject action items, push to ProofHub, mark complete
- Apache reverse proxy at manuelporras.com/zoom/
- PM2 process: zoom-dashboard (separate from zoom-pipeline)
- **Files:** src/api/server.js (new), src/api/routes.js (new)

### Phase 5: Dashboard Frontend
- Single-page HTML dashboard (same pattern as Slack mentions dashboard)
- Meeting list with filters (client, date, status)
- Meeting detail view: summary, action items, decisions, transcript
- Action item management: approve, reject, edit, push to ProofHub
- Stats overview: meetings processed, action items created, by client
- Dark theme matching existing dashboards
- **Files:** public/index.html (new)

### Phase 6: ProofHub Task Creation (Human-in-the-Loop via Dashboard)
- Slack interactive message: "Create Tasks in ProofHub" button on each meeting summary
- When clicked: creates PH tasks from the action items with assignees and due dates
- People resolver: map speaker names from transcript to ProofHub user IDs
- Task list selection per client project
- Link PH task IDs back to SQLite
- Update Slack message to include PH task links
- Duplicate guard: don't create tasks if already pushed
- **Files:** src/lib/proofhub-publisher.js (replace stub), src/lib/slack-publisher.js (add interactive buttons), src/lib/people-resolver.js (new), Express endpoint for Slack interactivity

### Phase 5: Cross-Meeting Intelligence
- Query open action items from prior meetings for the same client
- Query recent decisions for the same client
- Inject context into Gemini prompt as "Prior Meeting Context"
- AI output gains: resolved_items[], overdue_items[], recurring_topics[]
- Slack message gains "Follow-Up from Previous Meetings" section
- Configurable lookback (last 4 meetings or 30 days)
- **Files:** src/lib/ai-extractor.js (enhanced prompt), src/lib/database.js (add context queries)

### Phase 6: Operations Polish & Monitoring
- Daily digest: summary of meetings processed, action items created, errors
- Rate limit handling (Zoom API: per-second and daily limits)
- Graceful recovery from transient failures
- Client rules hot-reload (update clients.json without restart)
- Integration test script
- **Files:** src/lib/digest.js (new), scripts/test-pipeline.sh (new)

### Phase 7: Dashboard & Reporting
- Express API serving meeting data from SQLite
- Web UI: meeting list, meeting detail, client overview, action item tracker
- Filters: by client, date range, status, owner
- Apache reverse proxy at manuelporras.com/zoom/
- **Files:** src/api/server.js (new), public/index.html (new), public/app.js (new)

### Phase 08A: Client Roadmap Engine (Cross-Meeting Intelligence)
- New `roadmap_items` and `roadmap_snapshots` SQLite tables
- Canonical task taxonomy: 10 categories, 35 task types (derived from 337 real ProofHub tasks)
- AI cross-referencing engine: process meetings chronologically per client
- Meeting N-6 as seed → detect status changes, new items, stale items through N-1
- Track B3X vs client responsibility, staleness (meetings_silent_count)
- CLI: `node src/roadmap-build.js --client echelon --meetings 6`
- API endpoints: /api/roadmap/:clientId, /stale, /by-category, /timeline
- **Files:** src/lib/roadmap-db.js, src/lib/roadmap-processor.js, src/roadmap-build.js, src/config/task-taxonomy.json

### Phase 08B: Meeting Prep & Agenda Generator
- Consumes roadmap data from 08A to generate briefing documents for Phil
- 4-section prep: Status Report, Accountability Check, Strategic Direction, Suggested Agenda
- Data collector pulls roadmap, meeting history, service gaps, client config
- AI generates strategic recommendations based on service gaps + industry patterns
- Output as Markdown (Slack) and JSON (dashboard)
- CLI: `node src/meeting-prep.js --client echelon`
- API endpoints: /api/prep/:clientId, /markdown, /slack
- **Files:** src/lib/prep-collector.js, src/lib/prep-generator.js, src/lib/prep-formatter.js, src/meeting-prep.js

### Phase 09: AI Evaluation Agent
- End-to-end test of 08A + 08B with real client data
- Verify taxonomy classification accuracy
- Verify roadmap item tracking across meetings
- Verify prep document completeness and strategic quality
- Test with at least 2 different clients
- Validate stale item detection and owner_side classification

### Phase 10: Roadmap & Meeting Prep Dashboard
- Add tabbed navigation to existing dashboard: Meetings | Roadmap | Meeting Prep
- Roadmap view: per-client card grid with status/category/owner filters, search, inline edit, status change, timeline toggle
- Meeting Prep view: generate/view 4-section briefing documents, prep history, post to Slack
- All 14 backend API endpoints already exist — frontend-only phase
- Accessibility: ARIA roles on tabs, buttons for pills, escapeAttr for inputs
- AbortController for in-flight prep generation
- **Files:** public/index.html (modify — add ~1200 lines of CSS/HTML/JS)

### Phase 11: Playwright AI Audit Agent
- Install Playwright + chromium on Hetzner
- Create auth session bypass for headless browser testing
- Run comprehensive audit: 35+ checks across tabs, roadmap, prep, regression, console errors
- Screenshot every view (meetings, roadmap cards, timeline, prep document, mobile)
- Produce structured audit report with bugs and improvement opportunities
- Fix all HIGH/MEDIUM bugs found, implement HIGH impact improvements
- Re-run audit to verify fixes
- **Files:** scripts/create-test-session.js (new), tests/dashboard-audit.js (new), public/index.html (fixes)

### Phase 13: Projected Roadmap & Pre-Huddle Brief
- Add Section 5 to meeting prep: Projected Roadmap — specific NEW items Phil can pitch to clients
- Each proposal has: title, why_now, effort_b3x, effort_client, prerequisites, impact, priority (QUICK_WIN/GROWTH/STRATEGIC)
- Add Pre-Huddle Brief format — one-page cheat sheet for Phil's 2-minute pre-call scan
- New API endpoint: /api/prep/:clientId/brief
- Dashboard: Brief button, Section 5 renderer with priority badges
- Based on transcript analysis of how Dan/Phil run meetings — systematizes Dan's proactive proposals
- **Files:** src/lib/prep-generator.js, src/lib/prep-formatter.js, src/api/routes.js, public/index.html

---

## SESSION INTELLIGENCE SUBSYSTEM (Phases 15A–15F)

> Added 2026-04-04. Evaluates meeting quality, scores sessions, tracks trends, produces coaching output.
> Framework: Internal analysis + Gemini consultation. 4-point rubric, 3 weighted tiers.

### Phase 15A: SQL Baseline Metrics Engine
- Compute automated metrics from existing data (zero AI cost)
- **Metrics:** action density (items/minute), due date discipline (% with due dates), owner assignment rate, B3X accountability (owner_side='b3x' items gone stale), silent item count per client, repeat topic detection across consecutive meetings, decisions per meeting
- Speaker ratio: parse transcript_raw for speaker attribution, count lines per side (B3X team vs client)
- Per-client aggregation: averages, trends, percentile rankings
- Backfill all 99 existing meetings
- Output: `session_metrics` table in SQLite + JSON API endpoint
- CLI: `node src/session-metrics.js --backfill` and `node src/session-metrics.js --meeting <id>`
- **Files:** src/lib/session-metrics.js (new), src/session-metrics.js (new CLI), DB migration for session_metrics table
- **Depends on:** Nothing (reads existing tables)
- **Worker:** >>hetzner
- **Complexity:** medium
- **Smoke tests:** Backfill completes for 99 meetings, metrics non-null, speaker ratio sums to ~100%, API returns data

### Phase 15B: AI Session Evaluator + Model Comparison
- New Gemini evaluation pass on each transcript — purpose-built for quality, not extraction
- **4-point rubric** (4=Excellent, 3=Good, 2=Needs Improvement, 1=Failing)
- **Tier 1 (40% weight):** Client Sentiment + Accountability/Follow-Through
- **Tier 2 (35% weight):** Meeting Structure + Value Delivery + Action Item Discipline
- **Tier 3 (25% weight):** Time Utilization, Redundancy, Proactive vs Reactive
- **Additional dimensions from Gemini review:** Relationship Health (trust signals, vulnerability, delegation), Meeting Momentum (progressing vs stagnating), Save Rate (frustration → recovery pattern), Meeting Type classification (kickoff/regular/QBR/renewal/escalation)
- Detect: frustration markers (repetition with emphasis, meta-commentary, withdrawal, past-tense complaints, third-party invocation), satisfaction markers (future commitment, voluntary scope expansion, humor), jargon without context, confusion signals
- Output per meeting: weighted composite score, per-dimension scores, top 2 wins, top 2 improvements with transcript quotes, meeting type tag
- New table: `session_evaluations` (meeting_id, model_used, scores JSON, wins, improvements, coaching_notes, meeting_type, tokens_in, tokens_out, latency_ms)
- CLI: `node src/session-evaluate.js --meeting <id>` and `node src/session-evaluate.js --meeting <id> --model <model>`
- **Model comparison built-in:** Following Phase 12 pattern, run identical prompt against multiple models:
  - `gemini-3-flash-preview` (current pipeline model)
  - `gemini-2.5-flash-preview` (fast, cheap)
  - `gemini-3-pro-preview` (highest quality)
  - `gpt-4o` via OpenAI (cross-provider comparison)
- Comparison script: `scripts/session-eval-comparison.mjs` — runs 5 test meetings × 4 models = 20 evaluations
- AI-as-judge: `gemini-2.5-pro` judges which model produces most accurate, consistent, and actionable session scores
- Output: `data/session-eval-comparison-report.md` with winner per dimension + overall recommendation
- **Files:** src/lib/session-evaluator.js (new), src/session-evaluate.js (new CLI), scripts/session-eval-comparison.mjs (new), DB migration
- **Depends on:** Phase 15A (uses speaker ratios + SQL metrics as input context for AI)
- **Worker:** >>hetzner
- **Complexity:** complex
- **Smoke tests:** Evaluation runs on 3 test meetings, all dimensions scored 1-4, coaching notes non-empty, transcript quotes present, composite score weighted correctly, comparison report generated with 4 models scored

### Phase 15B-validate: Rubric Calibration & Human Review
- **CHECKPOINT PHASE — must pass before proceeding to 15C**
- Select 5 diverse meetings for human review: 1 high-energy client, 1 frustrated client, 1 routine update, 1 kickoff/onboarding, 1 escalation/problem meeting
- Present AI scores + coaching notes to Manuel for manual review
- Compare AI judgment vs human judgment on each dimension
- Identify dimensions where AI is unreliable or biased
- Adjust rubric weights, scoring criteria, or prompt based on findings
- Test scoring consistency: run same 5 meetings twice, measure score variance (acceptable: ≤0.5 point per dimension)
- Document calibration decisions in `data/rubric-calibration.md`
- **Gate:** If >2 dimensions have >1 point AI-vs-human disagreement, revise prompt and re-run before proceeding
- **Files:** scripts/rubric-calibration.mjs (new), data/rubric-calibration.md (generated)
- **Depends on:** Phase 15B
- **Worker:** >>hetzner (script) + lipo-360 (human review)
- **Complexity:** medium
- **Smoke tests:** 5 meetings scored, consistency variance ≤0.5, calibration report generated, model recommendation documented

### Phase 15C: Scoring Pipeline Integration
- Hook session evaluation into the existing poll.js pipeline — every new meeting auto-scored
- Run session-metrics (15A) then session-evaluate (15B) after ai-extractor completes
- Add to PM2 process or as post-processing step in poll.js
- Graceful degradation: if Gemini evaluation fails, SQL metrics still persist
- Rate limiting: evaluation is non-blocking — can run async after Slack posting
- Per-client baseline calculation: P25/P50/P75 percentiles for Green/Yellow/Red thresholds
- Recalculation on demand: `node src/session-metrics.js --recalculate-baselines`
- **Files:** src/poll.js (modify — add evaluation step), src/lib/session-baselines.js (new)
- **Depends on:** Phase 15A + 15B
- **Worker:** >>hetzner
- **Complexity:** medium
- **Smoke tests:** Process a meeting end-to-end (poll → extract → evaluate → score stored), baselines computed for all clients with 3+ meetings

### Phase 15D: Session Intelligence API
- New Express API endpoints on existing dashboard server
- `GET /api/session/:meetingId/scorecard` — full scorecard for one meeting
- `GET /api/session/client/:clientId/trend` — score trend over time
- `GET /api/session/team/:memberName/stats` — team member aggregate (controlled for client difficulty tier)
- `GET /api/session/flags` — all flagged meetings (low scores, declining sentiment, frustration detected)
- `GET /api/session/benchmarks` — agency-wide P25/P50/P75 baselines
- `GET /api/session/digest/weekly` — weekly digest JSON (flagged meetings, pattern alerts, win of the week)
- Client difficulty tier calculation: based on services_active count, meeting_cadence, historical score variance
- **Files:** src/api/routes.js (modify — add session endpoints), src/lib/session-queries.js (new)
- **Depends on:** Phase 15C (needs scores + baselines in DB)
- **Worker:** >>hetzner
- **Complexity:** medium
- **Smoke tests:** All 6 endpoints return valid JSON, trend shows multiple data points, flags filter works, team stats controlled for difficulty

### Phase 15E: Dashboard UI — Session Intelligence Tab
- New tab on existing dashboard: Meetings | Roadmap | Meeting Prep | **Session Intelligence**
- **Meeting Scorecard View:** Select meeting → see 4-point scores per dimension, weighted composite, tier breakdown, wins/improvements with transcript quotes, meeting type badge
- **Client Trend View:** Line chart of composite score over time per client, overlay P50 baseline, Green/Yellow/Red zones, click to drill into specific meeting
- **Team Performance View:** Bar chart per B3X team member, controlled for client difficulty, with tooltip showing sample sizes
- **Flags Panel:** List of flagged meetings (red cards) with one-line reason, click to see full scorecard
- **Bias controls visible:** Show "controlled for client difficulty" note, meeting type filter (exclude kickoffs from regular benchmarks)
- Dark theme matching existing dashboard
- Mobile responsive (at least scorecard view)
- **Files:** public/index.html (modify — add Session Intelligence tab, ~800-1000 lines CSS/HTML/JS)
- **Depends on:** Phase 15D (needs all API endpoints)
- **Worker:** >>hetzner
- **Complexity:** complex
- **Smoke tests:** Tab renders, scorecard loads for a meeting, trend chart displays, flags panel populates, team view shows data, no console errors

### Phase 15F: Regression & End-to-End Tests
- **Regression:** Ensure session evaluation pipeline doesn't break existing extraction, roadmap, or prep
- Run existing `evaluate-pipeline.js --all-clients` and verify scores haven't degraded
- Run existing `tests/dashboard-audit.js` (Playwright) and verify all 45 tests still pass with new Session Intelligence tab
- **Session-specific tests:**
  - Consistency test: Score same meeting 3 times → variance ≤0.5 per dimension
  - Edge cases: Very short meeting (<10 min), very long meeting (>60 min), meeting with no action items, meeting with only 1 speaker
  - Bias check: Compare scores for Dan-led vs Phil-led meetings, controlling for client difficulty
  - Backfill integrity: All 99 meetings have session_metrics + session_evaluations rows
  - API contract: All 6 session endpoints return valid JSON matching documented schema
  - Dashboard: Session Intelligence tab renders without console errors (Playwright)
  - Digest: Weekly digest generates valid Markdown and Slack-formatted output
- Test script: `scripts/session-test-suite.mjs` — automated runner for all above
- Output: `data/session-test-report.md`
- **Files:** scripts/session-test-suite.mjs (new), data/session-test-report.md (generated)
- **Depends on:** Phase 15E (needs full pipeline + dashboard)
- **Worker:** >>hetzner
- **Complexity:** complex
- **Smoke tests:** All regression tests pass, all session tests pass, report generated

### Phase 15G: Coaching Digest & Alerts
- Weekly automated digest (runs via cron or PM2 scheduled task)
- **Per-meeting coaching output:** Top 2 wins + top 2 improvements with specific transcript quotes and timestamps
- **Weekly digest:** Only flagged meetings (not all 30), pattern alerts ("Client X sentiment declining 3 meetings straight"), win of the week (highest composite score)
- **Slack integration:** Post weekly digest to #b3x-internal-notes or dedicated #session-quality channel
- **Trend alerts:** Client score drops below P25 for 2+ consecutive meetings → flag
- **Stale accountability alert:** B3X-owned roadmap items with meetings_silent_count > 3
- Digest format: Markdown (Slack) + JSON (API) + HTML (dashboard)
- **Files:** src/lib/session-digest.js (new), src/session-digest.js (new CLI), ecosystem.config.cjs (add digest cron)
- **Depends on:** Phase 15D + 15E + 15F (needs API + dashboard + tests passing)
- **Worker:** >>hetzner
- **Complexity:** medium
- **Smoke tests:** Digest generates for current week, Slack post formats correctly, trend alerts fire for test data, stale accountability detects known stale items

---

## Dependencies (Updated)

### Original (Phases 01–14C)
- Phase 2 → Phase 3 → Phase 4 (sequential)
- Phase 5 depends on Phase 4 (needs PH task tracking)
- Phase 6 depends on Phase 2
- Phase 7 depends on Phase 2
- Phase 08A depends on Phases 01-06D (needs meetings + action items in DB)
- Phase 08B depends on Phase 08A (needs roadmap data)
- Phase 09 depends on Phase 08A + 08B
- Phase 10 depends on Phase 08A + 08B (needs roadmap + prep API endpoints)
- Phase 11 depends on Phase 10 (tests the new dashboard tabs)
- Phase 13 depends on Phase 08B (extends meeting prep with projected roadmap)
- Phase 14A/B/C depends on Phase 13 + ProofHub integration (06C)

### Session Intelligence (Phases 15A–15G)
- Phase 15A: Independent (reads existing tables)
- Phase 15B depends on Phase 15A (uses speaker ratios as AI input)
- Phase 15B-validate depends on Phase 15B (human review checkpoint — GATE)
- Phase 15C depends on Phase 15B-validate (only after rubric validated)
- Phase 15D depends on Phase 15C (needs scores in DB)
- Phase 15E depends on Phase 15D (needs API endpoints)
- Phase 15F depends on Phase 15E (regression + e2e tests on full pipeline)
- Phase 15G depends on Phase 15F (coaching digest only after tests pass)

```
15A (SQL metrics) → 15B (AI evaluator + model comparison)
                         ↓
                    15B-validate (rubric calibration — GATE)
                         ↓
                    15C (pipeline integration + baselines)
                         ↓
                    15D (API endpoints)
                         ↓
                    15E (Dashboard UI)
                         ↓
                    15F (Regression + E2E tests)
                         ↓
                    15G (Coaching digest + alerts)
```

## Checkpoints (Updated)
- After Phase 3: Pipeline is live, posting to correct channels
- After Phase 5: Full intelligence loop working
- After Phase 08A: Roadmap engine builds correctly for test client
- After Phase 09: Full evaluation passes
- **After Phase 15B-validate: GATE — Rubric must pass human review before proceeding (AI-vs-human ≤1 point on all dimensions)**
- **After Phase 15D: API returns correct scores, verify against manual review**
- **After Phase 15F: All regression + session tests pass before enabling coaching digest**
- **After Phase 15G: Full session intelligence loop operational**

## Risks (Updated)
- Zoom API rate limits (300 req/day for S2S) — mitigated by 5-min polling interval
- Speaker name resolution for ProofHub (multiple "Dan"s, nicknames) — Phase 4 handles
- Gemini hallucination creating fake action items — mitigated by human-in-the-loop (Phase 4)
- Roadmap cross-referencing accuracy — mitigated by structured AI prompts with taxonomy constraints
- Meeting prep strategic suggestions quality — mitigated by grounding in real roadmap data + service gaps
- **Session scoring bias: action quantity ≠ quality** — mitigated by weighted rubric favoring sentiment over density
- **Team comparison fairness** — mitigated by client difficulty tier normalization in Phase 15D
- **Relationship-building penalty** — mitigated by meeting type classification excluding kickoffs/renewals from regular benchmarks
- **Rubric calibration drift** — mitigated by quarterly baseline recalculation + checkpoint after 15B
- **Privacy/ethics of AI-evaluating employees** — mitigated by transparent rollout, shared rubric, coaching (not surveillance) positioning
