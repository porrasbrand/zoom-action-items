# Project Brief

## What
Build an automated pipeline that processes Zoom meeting recordings into structured summaries with action items, posts them to Slack, and creates trackable tasks in ProofHub. Within 15 minutes of a call ending, every participant has a structured summary with assigned action items.

## Why
B3X holds ~30 client Zoom meetings per week. Today, raw transcripts are dumped into TXT files on Google Drive via an N8N workflow. Nobody reads them. Action items surface 1-2 days late through manual recall. Clients notice and are frustrated.

## Where
- Project path (local planning): /home/mp/awesome/super-agent/projects/zoom-action-items/
- Remote project path: ~/awsc-new/awesome/zoom-action-items/
- Target worker: >>hetzner
- Zoom API: S2S OAuth (credentials in .env on Hetzner)
- Slack: Bot token in .env
- ProofHub API: Available (reuse pattern from b3x-client-state)
- Gemini API: Configured in .env

## Boundaries
- Do NOT modify the existing N8N workflow (Zoom2DriveMin) — it continues running in parallel
- Do NOT auto-create ProofHub tasks without human confirmation (use Slack interactive "Confirm" button)
- Do NOT store raw transcripts longer than needed (privacy — client conversations)
- Keep SQLite for now (defer Supabase migration to a future project)
- Budget: Gemini Flash only (no expensive models)

## Success Criteria
- [ ] Pipeline runs every 5 minutes on Hetzner via cron/PM2
- [ ] New Zoom recordings with transcripts are detected and processed within 15 minutes
- [ ] AI extracts summary, action items (with owners), and decisions from each meeting
- [ ] Meeting notes are posted to the correct client Slack channel
- [ ] Unmatched meetings go to a triage channel
- [ ] Action items can be pushed to ProofHub via Slack button (human-in-the-loop)
- [ ] Duplicate meetings are not re-processed
- [ ] Errors are reported to a Slack alert channel
- [ ] Cross-meeting context: AI sees open items from prior meetings with the same client

## Access & Credentials
- All credentials already configured in .env on Hetzner
- Zoom S2S OAuth: ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET
- Gemini: GOOGLE_API_KEY
- Slack: SLACK_BOT_TOKEN, SLACK_ALERT_CHANNEL
- ProofHub: Will need PROOFHUB_API_KEY (available from b3x-client-state/.env)

## Preferences
- Tech stack: Match existing (Node.js ESM, SQLite, Express for any API)
- Code style: Match existing codebase
- Testing: Smoke tests via CLI and curl (--dry-run mode exists)
- Checkpoint frequency: Every 2 phases
- Max phases: 7

## Current State (Phase 1 Complete)
Phase 1 core pipeline is ALREADY BUILT and verified working on Hetzner:
- src/poll.js — CLI entry point with --dry-run
- src/lib/zoom-client.js — S2S OAuth, recording discovery, VTT download
- src/lib/vtt-parser.js — VTT transcript parsing
- src/lib/client-matcher.js — Client matching by topic keywords (30 clients)
- src/lib/ai-extractor.js — Gemini 2.0 Flash structured extraction
- src/lib/slack-publisher.js — Slack message formatting
- src/lib/database.js — SQLite storage with dedup
- src/lib/proofhub-publisher.js — STUB (18 lines, placeholder)
- src/config/clients.json — Client keyword rules

Dry-run tested: 6 meetings processed, action items and decisions extracted correctly.

Orchestration starts from Phase 2 (deployment & operations).
