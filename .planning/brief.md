# Project Brief

## What
Build an automated pipeline that processes Zoom meeting recordings into structured summaries with action items, posts them to Slack, creates trackable tasks in ProofHub, evaluates meeting quality with AI-powered Session Intelligence, and tracks PPC task accountability. Within 15 minutes of a call ending, every participant has a structured summary with assigned action items.

## Why
B3X holds ~30 client Zoom meetings per week. Today, raw transcripts are dumped into TXT files on Google Drive via an N8N workflow. Nobody reads them. Action items surface 1-2 days late through manual recall. Clients notice and are frustrated. Meeting quality is unmeasured, coaching is reactive, and PPC tasks discussed in meetings are never verified as completed.

## Where
- Project path (local planning): /home/mp/awesome/super-agent/projects/zoom-action-items/
- Remote project path (production): ~/awsc-new/awesome/zoom-action-items/
- Mirror path (dev): /home/vince/zoom-action-items/ on 104.251.217.215
- Target worker: >>hetzner
- Dashboard: https://www.manuelporras.com/zoom/
- Mirror: https://ai.breakthrough3x.com/zoom/
- GitHub: https://github.com/porrasbrand/zoom-action-items (private)

## Boundaries
- Do NOT modify the existing N8N workflow (Zoom2DriveMin) — it continues running in parallel
- Do NOT auto-create ProofHub tasks without confidence threshold (auto-push has confidence scoring)
- Do NOT store raw transcripts longer than needed (privacy — client conversations)
- Keep SQLite for now (defer Supabase migration to a future project)
- Google Ads: READ ONLY — never make changes to ad accounts

## Success Criteria (All Met)
- [x] Pipeline runs every 5 minutes on Hetzner via PM2
- [x] New Zoom recordings with transcripts are detected and processed within 15 minutes
- [x] AI extracts summary, action items (with owners), and decisions from each meeting
- [x] Meeting notes are posted to the correct client Slack channel
- [x] Unmatched meetings go to a triage channel
- [x] Action items can be pushed to ProofHub via dashboard UI (human-in-the-loop + auto-push)
- [x] Duplicate meetings are not re-processed
- [x] Errors are reported to a Slack alert channel
- [x] Cross-meeting context: roadmap engine tracks commitments across meetings
- [x] Meeting prep: 5-section briefings with context, stale items, projected roadmap
- [x] Session Intelligence: 12-dimension AI scoring, coaching insights, team performance
- [x] PPC task accountability: 107 tasks tracked, 86% accountability gap discovered
- [x] Dashboard with Google OAuth, 4 main tabs, 7 Session Intelligence sub-views
- [x] Production + mirror deployment with hourly sync
- [x] AI-powered Playwright audit (50+ checks, Gemini vision UX evaluation)
- [x] 28/28 development phases complete

## Access & Credentials
- All credentials configured in .env on Hetzner
- Zoom S2S OAuth: ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET
- Gemini: GOOGLE_API_KEY
- OpenAI: OPENAI_API_KEY (GPT-5.4 for session evaluation + PPC matching)
- Anthropic: ANTHROPIC_API_KEY (model comparison)
- Slack: SLACK_BOT_TOKEN, SLACK_ALERT_CHANNEL
- ProofHub: PROOFHUB_API_KEY, PROOFHUB_COMPANY_URL
- Google OAuth: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET (porrasbrand@gmail.com, project: Claude Email Integration)

## Preferences
- Tech stack: Node.js ESM, SQLite, Express
- AI models: GPT-5.4 (session eval, PPC matching), Gemini 2.0 Flash (extraction, classification), Gemini 2.5 Flash (roadmaps)
- Testing: Playwright + Gemini Vision (AI-powered audit), smoke tests via CLI/curl
- Code: Single-file SPA frontend (public/index.html), dark theme
- Checkpoint frequency: Every 2 phases

## Current State (All 28 Phases Complete)
Pipeline fully operational on Hetzner. 101 meetings processed. 99 GPT-5.4 evaluations. 107 PPC tasks tracked. Dashboard live with 4 tabs + 7 Session Intelligence sub-views. Mirror deployed at ai.breakthrough3x.com. Dev/prod workflow with GitHub branch protection.

## Future Work (Not Yet Started)
- Phase 21B: Slack verification for PPC tasks
- Phase 21C: Ad platform execution verification (Google Ads/LSA/Meta/Bing APIs)
- Human calibration: Manual scoring of 10 meetings (form built, awaiting user time)
- Weekly Slack digest: PM2 job configured but disabled
