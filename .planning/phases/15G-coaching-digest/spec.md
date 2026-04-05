# Phase 15G: Coaching Digest & Slack Alerts

## Prior Work Summary
The full Session Intelligence pipeline is built and tested: SQL metrics (15A), AI evaluations (15B), calibrated rubric (15B-validate), pipeline integration + baselines (15C), API (15D), dashboard (15E), tests passing (15F).

**This phase:** Automated weekly digest + Slack alerts for coaching and client health monitoring.

## Objective
1. Weekly digest script that summarizes meeting quality
2. Slack integration for posting digest to team channel
3. Trend alerts for declining clients
4. Per-meeting coaching output

## Implementation

### Create `src/lib/session-digest.js`

```javascript
// Functions:
// generateWeeklyDigest(weekStart) — produces structured digest
// generateMeetingCoaching(meetingId) — produces per-meeting coaching card
// detectPatternAlerts(lookbackWeeks) — finds concerning trends
// formatForSlack(digest) — converts to Slack Block Kit format
// formatForMarkdown(digest) — converts to readable markdown
```

#### `generateWeeklyDigest(weekStart)`
Uses the `/api/session/digest/weekly` query (from Phase 15D session-queries.js):
- Flagged meetings (below P50) with reasons
- Pattern alerts (3+ meeting decline, stale accountability)
- Win of the week (highest composite)
- Team snapshot (per-member averages)
- Week-over-week comparison

#### `detectPatternAlerts(lookbackWeeks = 4)`
Scans the last N weeks for:
- **Declining client:** 3+ meetings with decreasing composite
- **Stale accountability:** Client with 5+ B3X-owned items silent 3+ meetings
- **Frustration spike:** 2+ frustration moments in recent meeting (from session_evaluations)
- **Engagement drop:** Client speaking ratio dropped below 30% (was above 40%)
- **Over-meeting:** Client with <3 action items for 3+ consecutive meetings (meeting too frequent?)

#### `formatForSlack(digest)`
Converts digest to Slack Block Kit format:
```javascript
{
  blocks: [
    { type: "header", text: { type: "plain_text", text: "📊 Session Intelligence — Weekly Digest" } },
    { type: "section", text: { type: "mrkdwn", text: `*Week of ${weekStart}*\n${digest.meetings_scored} meetings scored` } },
    // Flagged meetings
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: "*🚩 Flagged Meetings*" } },
    // ... flag cards
    // Pattern alerts
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: "*⚠️ Pattern Alerts*" } },
    // ... alert items
    // Win of the week
    { type: "divider" },
    { type: "section", text: { type: "mrkdwn", text: "*🏆 Win of the Week*" } },
    // ... win card
  ]
}
```

### Create `src/session-digest.js` (CLI)

```
Usage:
  node src/session-digest.js                    # Generate current week digest
  node src/session-digest.js --week 2026-03-24  # Specific week
  node src/session-digest.js --post-slack       # Generate and post to Slack
  node src/session-digest.js --coaching 42      # Per-meeting coaching for meeting 42
  node src/session-digest.js --alerts           # Show current pattern alerts only
```

### Slack Posting

Post to the B3X internal channel. Use the existing Slack bot token from `.env` (SLACK_BOT_TOKEN).

```javascript
import { WebClient } from '@slack/web-api';

const slack = new WebClient(process.env.SLACK_BOT_TOKEN);

// Post to #b3x-internal-notes or a dedicated #session-quality channel
const DIGEST_CHANNEL = process.env.SESSION_DIGEST_CHANNEL || 'C07V3CH2H3Q'; // fallback to a known channel
```

**IMPORTANT:** Only post if `--post-slack` flag is passed. Never auto-post without explicit request.

### PM2 Scheduled Task (Optional)

Add to `ecosystem.config.cjs`:
```javascript
{
  name: 'session-digest',
  script: 'src/session-digest.js',
  args: '--post-slack',
  cron_restart: '0 9 * * 1',  // Every Monday at 9am
  autorestart: false,
  watch: false,
}
```

**Note:** This is optional and should be documented but NOT started automatically. Manuel should manually enable it when ready.

### Per-Meeting Coaching Output

`generateMeetingCoaching(meetingId)` produces a focused coaching card:
```javascript
{
  meeting: { topic, client_name, date, b3x_lead },
  composite_score: 2.8,
  threshold: "yellow",
  
  top_wins: [
    { description: "...", quote: "...", dimension: "value_delivery" },
    { description: "...", quote: "...", dimension: "meeting_structure" }
  ],
  
  top_improvements: [
    { description: "...", quote: "...", suggestion: "...", dimension: "accountability" },
    { description: "...", quote: "...", suggestion: "...", dimension: "action_discipline" }
  ],
  
  specific_coaching: "Phil, in this meeting with Echelon, you presented great results on the ad campaign (value delivery was strong). However, 3 B3X-owned items from prior meetings were not mentioned. Before next meeting, review the roadmap tab and address stale items in the first 5 minutes.",
  
  prep_for_next: "Review stale items: [list]. Prepare results update for: [specific deliverables]. Client asked about X — have answer ready."
}
```

## Expected Files
- `src/lib/session-digest.js` — **NEW** (~300-350 lines)
- `src/session-digest.js` — **NEW** CLI (~100 lines)
- `ecosystem.config.cjs` — **MODIFY** (add session-digest entry, disabled by default)

## Do NOT Touch
- `src/lib/session-evaluator.js` — No prompt changes
- `src/poll.js` — Digest is separate from pipeline
- `public/index.html` — No dashboard changes

## Smoke Tests
```bash
cd ~/awsc-new/awesome/zoom-action-items

# Generate digest (no Slack posting)
node src/session-digest.js

# Check output
node src/session-digest.js --alerts

# Per-meeting coaching
node src/session-digest.js --coaching 50

# Verify Slack format
node -e "
import('./src/lib/session-digest.js').then(async m => {
  const digest = await m.generateWeeklyDigest();
  const slack = m.formatForSlack(digest);
  console.log('Slack blocks:', slack.blocks.length);
  console.log('Has header:', slack.blocks[0]?.type === 'header');
  const md = m.formatForMarkdown(digest);
  console.log('Markdown length:', md.length);
  console.log('Has flags section:', md.includes('Flagged'));
});
"
```

## Completion Instructions
1. Create session-digest.js lib and CLI
2. Implement Slack formatting
3. Add PM2 config entry (disabled)
4. Run digest generation
5. Run per-meeting coaching for 2-3 meetings
6. Run all smoke tests
7. Commit with `[session-intel-15G]`
8. Report: sample digest output, pattern alerts found, coaching example
