# Phase 08B: Meeting Prep & Agenda Generator

## Context

Phase 08A builds the Client Roadmap Engine — a living per-client project plan derived from chronological meeting analysis. This phase consumes that roadmap to generate **meeting preparation documents** for Phil (and the B3X team) before each client call.

### The Problem
Phil walks into ~30 client meetings/week. Without prep, he's relying on memory: "What did we talk about last time? What's been done? What should we propose next?" This leads to reactive meetings instead of proactive client guidance.

### The Solution
An AI-generated briefing document that gives Phil:
1. **What to report** — completed work, in-progress items, metrics
2. **What to address** — blocked items, stale commitments, client-side pending actions
3. **Where to lead** — strategic next steps based on roadmap gaps, services available, and client industry patterns

### Dependencies
- Phase 08A: Client Roadmap Engine (MUST be complete — roadmap data is the primary input)
- `clients.json` enhanced fields: `industry`, `services_active`, `services_available`, `meeting_cadence`, `primary_contact`, `b3x_lead`

## Objective

Build a meeting prep generator that:
1. Takes a client ID and produces a **structured briefing document**
2. Includes 4 sections: Status Report, Accountability Check, Strategic Direction, Suggested Agenda
3. Sources data from: roadmap items, meeting history, client config, task taxonomy
4. Generates strategic suggestions based on service gaps and industry patterns
5. Outputs as Markdown (for Slack posting) and JSON (for dashboard rendering)
6. Can be triggered manually (CLI/API) or automatically (24h before scheduled meeting)

## Meeting Prep Document Structure

```markdown
═══════════════════════════════════════════════════════
MEETING PREP: {Client Name}
Date: {Next Meeting Date}
Prepared for: {b3x_lead}
Last meeting: {date of most recent meeting} ({days_ago} days ago)
Meetings analyzed: {count}
═══════════════════════════════════════════════════════

━━━ SECTION 1: STATUS REPORT (What to tell the client) ━━━

COMPLETED SINCE LAST MEETING:
  • {title} — {completion_date} [{category}]
  • {title} — {completion_date} [{category}]

IN PROGRESS:
  • {title} — {owner_name} [{category}]
  • {title} — {owner_name}, ETA {due_date} [{category}]

BLOCKED / NEEDS CLIENT ACTION:
  ⚠️ {title} — {reason} (pending since {date})
  ⚠️ {title} — {reason} (asked {N} meetings ago)

━━━ SECTION 2: ACCOUNTABILITY CHECK ━━━

STALE ITEMS (not discussed in 2+ meetings):
  🔴 {title} — agreed {date}, last discussed {date}, silent for {N} meetings
  🔴 {title} — agreed {date}, never followed up

B3X OVERDUE:
  • {title} — assigned to {owner_name}, agreed {date}

CLIENT OVERDUE:
  • {title} — client was supposed to {action}, asked {date}

━━━ SECTION 3: STRATEGIC DIRECTION (Where we're heading) ━━━

RECOMMENDED NEXT STEPS:
Based on: roadmap progress, service gaps, industry patterns

  1. {PRIORITY}: {recommendation_title}
     Why: {reasoning based on data}
     Category: {from taxonomy}

  2. {EXPAND}: {recommendation_title}
     Why: {reasoning}

  3. {PROPOSE}: {recommendation_title}
     Why: {reasoning}

━━━ SECTION 4: SUGGESTED AGENDA ━━━

  1. Quick wins / completed items ({time} min)
  2. {topic based on in-progress items} ({time} min)
  3. Blocked items — get client commitments ({time} min)
  4. Strategic proposal: {main recommendation} ({time} min)
  5. Next steps & action items ({time} min)

Estimated meeting length: {total_time} minutes
```

## Implementation Steps

### 1. Create prep data collector (`src/lib/prep-collector.js`)

Gathers all inputs needed for the AI to generate the prep document.

```javascript
/**
 * Collect all data needed for meeting prep.
 *
 * @param {string} clientId
 * @returns {Object} prepData
 */
export async function collectPrepData(db, clientId) {
  return {
    client: getClientConfig(clientId),           // from clients.json (with enhanced fields)
    roadmap: {
      active: getActiveRoadmapItems(db, clientId),
      stale: getStaleItems(db, clientId, 2),
      recently_completed: getRecentlyCompleted(db, clientId, 30), // last 30 days
      blocked: getBlockedItems(db, clientId),
      by_category: getRoadmapByCategory(db, clientId),
      stats: getRoadmapStats(db, clientId)       // total, done, in-progress, blocked, stale counts
    },
    meetings: {
      recent: getRecentMeetings(db, clientId, 3),  // last 3 meetings with summaries
      total: getMeetingCount(db, clientId),
      last_date: getLastMeetingDate(db, clientId)
    },
    service_gaps: computeServiceGaps(clientId),    // services_available minus services_active
    taxonomy: loadTaxonomy()                       // for category labels
  };
}

/**
 * Compute which services the client doesn't have yet but could benefit from.
 */
function computeServiceGaps(clientId) {
  const client = getClientConfig(clientId);
  const active = new Set(client.services_active || []);
  const available = client.services_available || [];
  return available.filter(s => !active.has(s));
  // e.g., ["lsa", "meta-ads", "call-tracking", "seo"]
}
```

### 2. Create prep AI generator (`src/lib/prep-generator.js`)

The AI prompt that produces the briefing document.

```javascript
/**
 * Generate meeting prep document from collected data.
 *
 * @param {Object} prepData - from collectPrepData()
 * @returns {Object} - { markdown: string, json: Object }
 */
export async function generateMeetingPrep(prepData)
```

**Gemini prompt:**

```
You are a digital marketing strategist preparing a meeting briefing for a B3X team member.

CLIENT: {name}
INDUSTRY: {industry}
B3X LEAD: {b3x_lead}
SERVICES ACTIVE: {services_active}
SERVICES NOT YET ACTIVE (upsell opportunities): {service_gaps}
MEETING CADENCE: {meeting_cadence}
LAST MEETING: {last_date}

CURRENT ROADMAP STATUS:
Total items: {stats.total} | Done: {stats.done} | In Progress: {stats.in_progress} | Blocked: {stats.blocked} | Stale: {stats.stale}

ACTIVE ROADMAP ITEMS:
{JSON list of active items with: title, category, task_type, status, owner_side, owner_name, due_date, meetings_silent_count}

RECENTLY COMPLETED (last 30 days):
{list of completed items with dates}

STALE ITEMS (not discussed in 2+ meetings):
{list with title, agreed_date, last_discussed_date, silent_count}

BLOCKED ITEMS:
{list with title, reason, blocked_since}

LAST 3 MEETING SUMMARIES:
{summaries from ai_extraction for context on recent discussions}

SERVICE GAPS (available but not active):
{service_gaps list}

INSTRUCTIONS:
Generate a meeting prep document with these 4 sections:

SECTION 1 - STATUS REPORT:
- List completed items since last meeting (with dates)
- List in-progress items (with owner and ETA if known)
- List items needing client action (with context)

SECTION 2 - ACCOUNTABILITY CHECK:
- Flag stale items (agreed but not discussed for 2+ meetings) — these are CRITICAL
- Separate B3X overdue from client overdue
- Be specific about who owes what and since when

SECTION 3 - STRATEGIC DIRECTION:
- Based on the roadmap state, service gaps, and industry, recommend 2-4 next steps
- Each recommendation must have:
  - A clear title
  - WHY it makes sense NOW (connect to data: completed prerequisites, performance trends, industry patterns)
  - Which taxonomy category it falls under
- Prioritize: quick wins first, then growth opportunities, then long-term plays
- Consider industry seasonality (e.g., HVAC → summer AC push, winter heating)
- Consider service gaps as upsell opportunities

SECTION 4 - SUGGESTED AGENDA:
- Propose a meeting agenda with time allocations
- Put quick wins first (positive momentum)
- Put strategic proposal as main discussion topic
- End with clear next steps
- Estimate total meeting length

OUTPUT FORMAT: JSON
{
  "status_report": {
    "completed": [{"title": "...", "date": "...", "category": "..."}],
    "in_progress": [{"title": "...", "owner": "...", "category": "...", "eta": "..."}],
    "needs_client_action": [{"title": "...", "reason": "...", "since": "..."}]
  },
  "accountability": {
    "stale_items": [{"title": "...", "agreed_date": "...", "silent_meetings": N}],
    "b3x_overdue": [{"title": "...", "owner": "...", "since": "..."}],
    "client_overdue": [{"title": "...", "action_needed": "...", "since": "..."}]
  },
  "strategic_direction": [
    {"priority": "HIGH|MEDIUM", "title": "...", "reasoning": "...", "category": "...", "task_type": "..."}
  ],
  "suggested_agenda": [
    {"topic": "...", "minutes": N, "notes": "..."}
  ],
  "estimated_meeting_length_minutes": N
}
```

### 3. Create prep CLI (`src/meeting-prep.js`)

```javascript
// Usage:
//   node src/meeting-prep.js --client echelon
//   node src/meeting-prep.js --client echelon --format markdown
//   node src/meeting-prep.js --client echelon --format json
//   node src/meeting-prep.js --client echelon --slack  (post to client's Slack channel)

// Steps:
// 1. Validate client exists and has roadmap data
// 2. Call collectPrepData()
// 3. Call generateMeetingPrep()
// 4. Output as markdown (default) or JSON
// 5. Optionally post to Slack channel
// 6. Save to data/preps/{clientId}-{date}.md
```

### 4. Create prep formatter (`src/lib/prep-formatter.js`)

Converts the AI JSON output into:
- **Markdown** — for Slack posting and terminal output
- **HTML** — for dashboard rendering (future phase)
- Uses emoji indicators: ✅ done, 🔄 in-progress, ⚠️ stale, ❌ blocked, 🆕 new recommendation

### 5. Add prep API endpoints (`src/api/routes.js`)

```javascript
// Meeting Prep endpoints
GET  /api/prep/:clientId              // Generate fresh prep (returns JSON)
GET  /api/prep/:clientId/markdown     // Generate fresh prep (returns Markdown)
POST /api/prep/:clientId/slack        // Generate and post to Slack
GET  /api/prep/history/:clientId      // List saved prep documents
GET  /api/prep/saved/:filename        // Retrieve a saved prep document
```

### 6. Save and archive preps

```
data/preps/
  echelon-2026-04-03.md
  echelon-2026-04-03.json
  pearce-hvac-2026-04-01.md
  ...
```

Each prep is saved with both markdown and JSON versions for future reference and dashboard display.

## Files to Create

On Hetzner at `~/awsc-new/awesome/zoom-action-items/`:

1. `src/lib/prep-collector.js` — Data collection layer
2. `src/lib/prep-generator.js` — AI prompt and generation logic
3. `src/lib/prep-formatter.js` — Markdown/HTML output formatting
4. `src/meeting-prep.js` — CLI entry point

## Files to Modify

1. `src/api/routes.js` — Add prep API endpoints
2. `ecosystem.config.cjs` — (future) Add optional cron for auto-prep generation

## Do NOT Touch

- `src/poll.js` / `src/service.js` — Pipeline polling
- `src/lib/roadmap-processor.js` — Roadmap engine (Phase 08A, consumed as-is)
- `src/lib/ai-extractor.js` — Per-meeting extraction
- `public/index.html` — Dashboard (roadmap + prep UI is a separate phase)

## Acceptance Criteria

- [ ] `node src/meeting-prep.js --client echelon` produces a complete 4-section prep document
- [ ] Status Report correctly lists completed, in-progress, and blocked items from roadmap
- [ ] Accountability section flags items with `meetings_silent_count >= 2` as stale
- [ ] Accountability correctly separates B3X overdue vs client overdue by `owner_side`
- [ ] Strategic Direction includes 2-4 recommendations with reasoning tied to data
- [ ] Service gap analysis surfaces upsell opportunities (services_available not in services_active)
- [ ] Suggested Agenda includes time allocations and logical ordering
- [ ] `--format markdown` outputs clean, Slack-compatible markdown
- [ ] `--format json` outputs structured JSON matching the schema above
- [ ] `--slack` posts formatted prep to client's `slack_channel_id`
- [ ] Prep saved to `data/preps/{clientId}-{date}.md` and `.json`
- [ ] API endpoint `GET /api/prep/echelon` returns valid JSON prep
- [ ] Gemini rate limiting respected
- [ ] Works for clients with as few as 2 meetings and as many as 20+

## Smoke Tests

```bash
# Generate prep for echelon
cd ~/awsc-new/awesome/zoom-action-items
node src/meeting-prep.js --client echelon

# Generate as JSON
node src/meeting-prep.js --client echelon --format json | jq '.strategic_direction'

# Check saved preps
ls data/preps/

# Test API
curl -s http://localhost:3875/api/prep/echelon | jq '.suggested_agenda'
curl -s http://localhost:3875/api/prep/echelon/markdown

# Post to Slack (manual trigger)
curl -X POST http://localhost:3875/api/prep/echelon/slack
```

## Completion Instructions

1. Run all smoke tests
2. Generate prep for at least 2 different clients
3. Verify strategic recommendations make sense (not generic)
4. Commit with prefix: `[zoom-pipeline-08B]`
5. Update `.planning/status.json` to mark 08B as COMPLETE

## Future Enhancements (not in scope for 08B)

- **Auto-trigger**: Generate prep 24h before scheduled meeting (needs calendar integration)
- **Performance data**: Pull Google Ads / GA4 metrics into prep (API integration)
- **Dashboard UI**: Roadmap visualization + prep document viewer in existing dashboard
- **Phil feedback loop**: Phil marks recommendations as "used" / "skipped" to improve future suggestions
