# Phase 03: Slack Channel Routing

## Context
Phase 2 (commit 5ad29cc) deployed the pipeline as a PM2 service running every 5 minutes in DRY_RUN mode. It currently formats Slack messages but doesn't post them.

The client matcher (`src/lib/client-matcher.js`) already identifies clients by meeting topic keywords. The `src/config/clients.json` has 30+ clients defined with keywords but all `slack_channel_id` fields are empty.

From the agency-client-state mentions system, we know these Slack channels exist for clients:
- int-delta-pro-services (C_EXAMPLE_3)
- int-LEDGERCFO (C_EXAMPLE_10)
- int-theta (C_EXAMPLE_4)
- int-tau-home-services (C_EXAMPLE_5)
- int-pat-and-chris-bell (C_EXAMPLE_11)
- int-rho-home-services (C_EXAMPLE_6)
- int-rowan-pryce (C_EXAMPLE_7)
- int-epsilon-service (C_EXAMPLE_1)
- int-beta-home-services (C_EXAMPLE_8)
- int-acme-hvac (C_EXAMPLE_9)
- int-morenochiro-website (C_EXAMPLE_12)

The Slack bot is `claude_bridge` and needs to be a member of each channel to post.

## Objective
Route each client's meeting notes to their dedicated Slack channel. Unmatched meetings go to a triage channel. After this phase, DRY_RUN can be turned off.

## Implementation Steps

1. **Populate `slack_channel_id` in `clients.json`:**
   - Use the Slack API to list all channels: `conversations.list` with types=public_channel,private_channel
   - Match client names to channel names (most follow pattern `int-<client-name>`)
   - Update clients.json with correct channel IDs
   - For clients without a dedicated channel, leave blank (will go to triage)

2. **Create/configure triage channels:**
   - `#zoom-unmatched` — for meetings that don't match any client
   - `#zoom-internal` — for Agency internal meetings (no client match, but recognized as internal by keywords like "huddle", "Agency", "internal", "standup", "team")
   - Add these channel IDs to an `src/config/channels.json` or as constants in the code

3. **Modify `src/lib/slack-publisher.js`:**
   - Accept a `channelId` parameter for where to post
   - If client has a `slack_channel_id`, post there
   - If meeting is identified as internal (keywords), post to #zoom-internal
   - If no client match and not internal, post to #zoom-unmatched
   - Add the client name and meeting topic in the message header

4. **Add channel verification on startup:**
   - In `src/service.js` startup validation, check that the bot has access to all configured channels
   - Call `conversations.info` for each channel in clients.json
   - Log warnings for channels the bot can't access (don't fail — just flag)

5. **Add bot to channels:**
   - Use `conversations.join` API to join public channels
   - For private channels, log a warning that manual invite is needed

6. **Update `src/poll.js` / service to pass channel routing:**
   - After client matching, look up the client's slack_channel_id
   - Pass it to the Slack publisher
   - Log which channel each meeting is posted to

7. **Add internal meeting detection:**
   - In `src/lib/client-matcher.js`, add a check for internal meeting keywords
   - If topic contains "huddle", "Agency", "internal", "standup", "team meeting", "weekly sync" (and doesn't match a client), mark as `internal: true`
   - Internal meetings get a simplified format (no client header, no PH integration later)

8. **Turn off DRY_RUN after testing:**
   - After verifying routing works correctly with a test run, set DRY_RUN=false in .env
   - Restart PM2: `pm2 restart zoom-pipeline`

## Files to Create
- None (or optionally `src/config/channels.json` for triage channel IDs)

## Files to Modify
- `src/config/clients.json` — Add slack_channel_id for all clients
- `src/lib/slack-publisher.js` — Add channel routing logic
- `src/lib/client-matcher.js` — Add internal meeting detection
- `src/poll.js` — Pass channel ID to publisher
- `src/service.js` — Add channel verification to startup
- `.env` — Set DRY_RUN=false after testing

## Do NOT Touch
- `src/lib/zoom-client.js` — No changes
- `src/lib/ai-extractor.js` — No changes
- `src/lib/database.js` — No changes
- `ecosystem.config.cjs` — No changes

## Acceptance Criteria
- [ ] All known clients in clients.json have correct slack_channel_id
- [ ] Meetings for known clients post to their dedicated channel
- [ ] Unmatched meetings post to a triage channel (#zoom-unmatched)
- [ ] Internal Agency meetings post to #zoom-internal (or equivalent)
- [ ] Bot verifies channel access on startup and logs warnings
- [ ] DRY_RUN=false and pipeline posts to Slack for real
- [ ] Each posted message includes client name and meeting topic in header
- [ ] Fallback: if target channel is inaccessible, post to triage channel instead

## Smoke Tests
Run these AFTER implementation to verify:

```bash
# Test 1: clients.json has channel IDs populated
node -e "import('./src/config/clients.json', {with: {type: 'json'}}).then(m => { const filled = m.default.clients.filter(c => c.slack_channel_id); console.log(filled.length + ' of ' + m.default.clients.length + ' clients have channel IDs'); })"
→ expect: at least 10 of N clients have channel IDs

# Test 2: Startup channel verification runs
pm2 restart zoom-pipeline && sleep 10 && pm2 logs zoom-pipeline --lines 30 --nostream | grep -i 'channel\|verified\|access'
→ expect: channel verification messages in logs

# Test 3: DRY_RUN is false
grep '^DRY_RUN' .env
→ expect: DRY_RUN=false

# Test 4: Pipeline posts to Slack for real (check after next poll cycle)
# Wait for a poll cycle and check logs
pm2 logs zoom-pipeline --lines 20 --nostream | grep -i 'posted\|slack\|channel'
→ expect: "Posted to #int-<client>" or similar messages

# Test 5: Internal meeting detection
node -e "import('./src/lib/client-matcher.js').then(m => { const r = m.matchClient('Agency Team Huddle'); console.log('internal:', r); })"
→ expect: internal flag or no client match with internal indicator

# Test 6: Unmatched meeting handling
node -e "import('./src/lib/client-matcher.js').then(m => { const r = m.matchClient('Random Unknown Meeting'); console.log('unmatched:', r); })"
→ expect: no match result

# Test 7: Git commit
git log --oneline -1
→ expect: [zoom-pipeline-03] commit
```

## Completion Instructions
1. Run all smoke tests and confirm they pass
2. Write result to: `.planning/phases/03-slack-channel-routing/result.md`
3. Commit all changes with prefix: `[zoom-pipeline-03]`
