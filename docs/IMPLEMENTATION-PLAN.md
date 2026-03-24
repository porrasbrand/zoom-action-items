# Zoom Meeting → Action Items Pipeline — Implementation Plan

**Project:** `zoom-action-items`
**Location:** `/home/ubuntu/awsc-new/awesome/zoom-action-items/`
**Created:** 2026-03-24
**Status:** Phase 1 in progress

---

## Problem Statement

B3X holds ~30 client Zoom meetings per week. Today, raw transcripts are dumped into growing TXT files on Google Drive via an N8N workflow (`Zoom2DriveMin`). Nobody reads them. Action items surface 1-2 days late through manual recall. Clients notice and are frustrated.

**Goal:** Within 15 minutes of a Zoom call ending, every participant and stakeholder has a structured summary with assigned action items — in Slack immediately, in Proofhub as trackable tasks, and in a searchable archive for cross-meeting continuity.

---

## Architecture

```
Zoom Call Ends (~5 min cloud processing)
    │
    ▼
[Cron: poll.js every 5 min]
    │
    ├─ Zoom S2S API → list new recordings with transcripts
    ├─ Match topic → client (keyword rules, 30 clients)
    ├─ Download VTT → parse to speaker-labeled text
    │
    ├─ [AI Layer]
    │   ├─ Gemini: extract action items, decisions, summary
    │   └─ (Phase 5) Context injection from prior meetings
    │
    ├─ [Distribution Layer]
    │   ├─ Slack: formatted summary to client channel
    │   ├─ (Phase 3) Proofhub: create tasks with assignees
    │   └─ (Phase 6) Email digest for external participants
    │
    ├─ [Storage Layer]
    │   ├─ SQLite: meetings, action_items, decisions (dedup + audit)
    │   └─ (Phase 7) Supabase pgvector: semantic search
    │
    └─ [Operations Layer]
        ├─ Error alerts to Slack
        ├─ Health monitoring
        └─ Daily digest of processing stats
```

---

## Phase Overview

| Phase | Name | Depends On | Delivers |
|-------|------|------------|----------|
| **1** | Core Pipeline | — | Zoom → AI → Slack (single channel, dry-run validated) |
| **2** | Deployment & Operations | 1 | Cron on Hetzner, monitoring, alerting, log rotation |
| **3** | Proofhub Task Creation | 2 | Action items become trackable PH tasks with assignees |
| **4** | Slack Channel Routing | 2 | Each client's notes go to their dedicated Slack channel |
| **5** | Cross-Meeting Intelligence | 4 | AI sees open items from prior meetings, notes follow-ups |
| **6** | External Participant Notifications | 4 | Email summaries to non-Slack attendees (clients) |
| **7** | Semantic Search & Retrieval | 2 | Vector embeddings, Slack `/meetings search` command |
| **8** | Dashboard & Reporting | 2 | Web UI for browsing meetings, action items, client history |

---

## Phase 1: Core Pipeline

**Goal:** A working pipeline that downloads Zoom transcripts, extracts structured data with AI, formats it for Slack, and stores it in SQLite — all runnable from a single CLI command.

**Scope:**
- Zoom S2S OAuth authentication and token management
- Recording discovery across all account users (4 users currently)
- VTT transcript download and parsing into speaker-labeled text
- Client matching by meeting topic keywords (30 client rule set from N8N)
- Gemini 2.0 Flash structured extraction (summary, action items, decisions, follow-ups)
- Slack message formatting (readable, emoji-enhanced, priority-tagged)
- SQLite storage with dedup by meeting UUID
- CLI entry point with `--dry-run` mode for safe testing
- Daily log file output

**Not in scope:** Live Slack posting, cron, monitoring, Proofhub, channel routing.

**Validation criteria:**
- `node src/poll.js --dry-run` processes real Zoom meetings end-to-end
- VTT parsing preserves speaker names and produces clean text
- Client matcher correctly identifies known clients by topic
- Gemini returns valid JSON with action items that make sense
- SQLite dedup prevents re-processing on subsequent runs
- Formatted Slack output is readable and complete

**Status:** Implementation in progress. Core modules built and dry-run tested with real meeting data (Joaco|Dan meeting: 5 action items, 3 decisions extracted successfully).

---

## Phase 2: Deployment & Operations

**Goal:** The pipeline runs autonomously on Hetzner every 5 minutes with proper error handling, alerting, and operational visibility.

**Scope:**
- Transfer project to Hetzner server
- Environment configuration (`.env` on Hetzner, secrets management)
- Cron job setup (`*/5 * * * *`) with lock file to prevent overlapping runs
- Slack alert channel (`#zoom-pipeline-alerts`) for errors and anomalies
- Log rotation (daily files, 30-day retention)
- Health check endpoint or script (for monitoring)
- Graceful handling of Zoom API rate limits (per-second and daily)
- Startup validation (check all credentials before first poll)
- Process for updating client rules without restarting

**Validation criteria:**
- Cron runs reliably every 5 minutes without overlap
- Errors are posted to Slack alert channel within 1 minute
- Logs are rotated and old logs are cleaned up
- Rate limit encounters are handled gracefully (backoff, retry)
- Pipeline recovers automatically after transient failures

---

## Phase 3: Proofhub Task Creation

**Goal:** Every extracted action item with an identifiable owner becomes a task in the client's Proofhub project, assigned to the right person, with a due date.

**Scope:**
- Proofhub API integration (reuse pattern from `slack-mention-tracker`)
- People resolver: map speaker names from transcript to Proofhub user IDs
- Task creation with title, description, assignee, due date, and priority
- Task list selection per client project (e.g., "Meeting Action Items")
- Link Proofhub task IDs back to SQLite for tracking
- Update Slack message to include Proofhub task links
- Handle name ambiguity (multiple "Dan"s, nicknames, etc.)

**Validation criteria:**
- Action items with clear owners create PH tasks with correct assignees
- Tasks appear in the right project and task list
- Due dates are set correctly (or omitted when AI didn't extract one)
- Slack message includes links to created PH tasks
- Duplicate tasks are not created on re-run

---

## Phase 4: Slack Channel Routing

**Goal:** Each client's meeting notes are posted to their dedicated Slack channel instead of a single catch-all channel.

**Scope:**
- Map all 30 clients to their Slack channel IDs in `clients.json`
- Audit which Slack channels exist vs. need to be created
- Handle unmatched meetings (post to a `#zoom-unmatched` triage channel)
- Handle internal meetings (B3X team meetings → `#b3x-internal-notes`)
- Channel verification on startup (confirm bot has access to all channels)
- Fallback behavior when channel is archived or bot lacks permission

**Validation criteria:**
- Known client meetings post to the correct client channel
- Unmatched meetings go to a triage channel for manual review
- Internal meetings are separated from client meetings
- Bot permission errors are caught and reported, not silently dropped

---

## Phase 5: Cross-Meeting Intelligence

**Goal:** The AI extraction is context-aware — it knows what was discussed and committed to in previous meetings with the same client, and can flag resolved items, overdue tasks, and recurring topics.

**Scope:**
- Query open action items from prior meetings for the same client
- Query recent decisions for the same client
- Inject this context into the Gemini prompt as "Prior Meeting Context"
- AI output gains new fields: `resolved_items[]`, `overdue_items[]`, `recurring_topics[]`
- Slack message gains a "Follow-Up from Previous Meetings" section
- Configurable lookback window (default: last 4 meetings or 30 days)

**Validation criteria:**
- Gemini receives and uses prior meeting context in its extraction
- Previously assigned action items that are discussed as complete are flagged
- Overdue items (past due date, still open) are highlighted
- Slack message shows meaningful cross-meeting context
- Works correctly for clients with no prior meetings (first meeting)

---

## Phase 6: External Participant Notifications

**Goal:** Clients and external participants who are not on Slack receive meeting summaries and their action items via email.

**Scope:**
- Attendee email resolution (Zoom participant data, manual mapping)
- Email template (HTML, clean, mobile-friendly)
- Email delivery (SES, SendGrid, or existing B3X email infrastructure)
- Per-client configuration: who gets emails, when, and what format
- Opt-out mechanism
- Distinguish internal attendees (Slack) from external attendees (email)

**Validation criteria:**
- External participants receive a clean email within 15 minutes
- Email contains their specific action items highlighted
- Internal team members do not receive redundant emails
- Opt-out works and is respected on subsequent meetings

---

## Phase 7: Semantic Search & Retrieval

**Goal:** All meeting transcripts and extracted data are searchable by meaning, enabling queries like "what did we decide about the spring campaign?" across all meetings.

**Scope:**
- Generate embeddings for meeting chunks (transcripts, action items, decisions)
- Store in Supabase pgvector (reuse existing Supabase instance)
- Slack slash command: `/meetings search <query>`
- Slack slash command: `/meetings client <name> [last N]`
- Result ranking by relevance and recency
- Access control (users only see meetings they should see)

**Validation criteria:**
- Semantic search returns relevant results across meeting history
- Slash commands work in Slack with reasonable response times (<3s)
- Results include meeting date, client, and relevant excerpt
- Empty/no-match queries return helpful guidance

---

## Phase 8: Dashboard & Reporting

**Goal:** A web UI for leadership to browse meeting history, track action item completion rates, and see client engagement patterns.

**Scope:**
- Express API serving meeting data from SQLite (and/or Supabase)
- Web frontend (lightweight — HTML/CSS/JS or simple React)
- Views: meeting list, meeting detail, client overview, action item tracker
- Filters: by client, date range, status, owner
- Metrics: meetings/week, action items created/completed, average extraction quality
- Export: CSV/PDF for client reporting
- Authentication (reuse existing B3X auth pattern)

**Validation criteria:**
- Dashboard loads meeting data correctly
- Filtering and search work across all dimensions
- Action item status updates reflect in real-time
- Accessible from B3X internal network

---

## Working Process

For each phase:

```
1. DETAIL  → Create docs/PHASE-N-<name>.md with full technical specification
2. REVIEW  → Walk through the spec, adjust scope, confirm approach
3. BUILD   → Implement the code, module by module
4. TEST    → Validate against the phase's criteria
5. APPROVE → Confirm phase is complete, update this document
6. NEXT    → Move to the next phase
```

---

## Dependencies & Credentials

| Resource | Used In | Status |
|----------|---------|--------|
| Zoom S2S OAuth (Account ID, Client ID, Secret) | Phase 1+ | ✅ Working |
| Gemini API Key (Google AI) | Phase 1+ | ✅ Working |
| Slack Bot Token | Phase 1+ | ✅ Working |
| Proofhub API Key | Phase 3 | ✅ Available (in slack-mention-tracker) |
| Proofhub User ID Mapping | Phase 3 | ❌ Needs creation |
| Slack Channel ID Mapping | Phase 4 | ❌ Needs audit |
| Email Service (SES/SendGrid) | Phase 6 | ❌ TBD |
| Supabase (pgvector) | Phase 7 | ✅ Available |
| Hetzner Server Access | Phase 2+ | ✅ Available |

---

## Revision History

| Date | Change |
|------|--------|
| 2026-03-24 | Initial plan created. Phase 1 core modules built and dry-run tested. |
