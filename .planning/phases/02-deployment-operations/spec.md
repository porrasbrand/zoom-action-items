# Phase 02: Deployment & Operations

## Context
Phase 1 (core pipeline) is complete and verified on Hetzner at `~/awsc-new/awesome/zoom-action-items/`. The pipeline can process Zoom recordings end-to-end in --dry-run mode: Zoom API → VTT download → Gemini extraction → Slack formatting → SQLite storage.

Currently `poll.js` is a CLI tool that runs once and exits. It needs to run continuously as a service.

The Hetzner server already runs PM2 for other services (b3x-client-state, slack-queue, etc.). The existing PM2 pattern should be followed.

Slack bot token is configured in .env. The pipeline currently formats Slack messages but skips posting in dry-run mode.

## Objective
Make the pipeline run autonomously on Hetzner every 5 minutes with proper error handling, alerting, and operational visibility. Enable live Slack posting.

## Implementation Steps

1. **Create `ecosystem.config.cjs`** (PM2 config):
   - Run `src/poll.js` every 5 minutes using a wrapper or PM2 cron
   - Since poll.js is a run-once script (not a long-running server), use a wrapper approach:
     - Create `src/service.js` that runs poll.js logic on a setInterval(5 * 60 * 1000) loop
     - Or use PM2 cron_restart: `cron_restart: '*/5 * * * *'`
   - PM2 process name: `zoom-pipeline`
   - Log files: `logs/zoom-pipeline-out.log`, `logs/zoom-pipeline-error.log`
   - Auto-restart on crash with max_restarts: 10

2. **Create `src/service.js`** (long-running wrapper):
   - Import the poll logic
   - Run on startup, then setInterval every 5 minutes
   - Add a singleton lock (prevent overlapping runs if a poll takes >5 min)
   - Log each cycle start/end with timing
   - Catch and log all errors (don't crash the process)

3. **Enable live Slack posting:**
   - Modify `src/lib/slack-publisher.js` to actually call the Slack API (it currently formats but may skip posting in dry-run)
   - Respect the DRY_RUN env var: if `DRY_RUN=true`, log but don't post
   - If DRY_RUN is not set or is "false", post to Slack for real

4. **Add error alerting to Slack:**
   - When a meeting fails to process, post an error summary to SLACK_ALERT_CHANNEL
   - Format: `:warning: Zoom pipeline error: [meeting topic] — [error message]`
   - Don't alert on transient errors more than once per meeting

5. **Add startup validation:**
   - On service start, verify all credentials are set (ZOOM_*, GOOGLE_API_KEY, SLACK_BOT_TOKEN)
   - Test Zoom API connectivity (list users)
   - Test Slack API connectivity (auth.test)
   - Log validation results, fail fast if critical credentials missing

6. **Add health check script** `scripts/health-check.sh`:
   - Check PM2 process is running
   - Check last successful poll time from SQLite (should be within last 10 minutes)
   - Check logs for recent errors
   - Exit 0 if healthy, 1 if unhealthy

7. **Add log rotation:**
   - PM2 handles log rotation with `pm2-logrotate` module
   - Or configure in ecosystem.config.cjs: `log_date_format: 'YYYY-MM-DD HH:mm:ss'`
   - Keep 30 days of logs

8. **Initialize git repo on Hetzner:**
   - `git init` in the project directory
   - Create .gitignore (node_modules, data/*.db, .env, logs/)
   - Initial commit with all current code

## Files to Create
- `ecosystem.config.cjs` — PM2 configuration
- `src/service.js` — Long-running service wrapper with setInterval
- `scripts/health-check.sh` — Health check script

## Files to Modify
- `src/lib/slack-publisher.js` — Enable live Slack posting (respect DRY_RUN)
- `src/poll.js` — Export poll logic as importable function for service.js

## Do NOT Touch
- `src/lib/zoom-client.js` — Working, no changes
- `src/lib/ai-extractor.js` — Working, no changes
- `src/lib/vtt-parser.js` — Working, no changes
- `src/lib/database.js` — Working, no changes
- `src/config/clients.json` — No changes in this phase

## Acceptance Criteria
- [ ] `pm2 start ecosystem.config.cjs` starts the zoom-pipeline process
- [ ] Pipeline runs every 5 minutes automatically
- [ ] Overlapping runs are prevented (singleton lock)
- [ ] Live Slack posting works when DRY_RUN is not set
- [ ] DRY_RUN=true still skips Slack posting
- [ ] Errors are posted to SLACK_ALERT_CHANNEL
- [ ] Startup validates all credentials and logs results
- [ ] `bash scripts/health-check.sh` returns 0 when healthy
- [ ] PM2 auto-restarts on crash
- [ ] Git repo initialized with clean initial commit

## Smoke Tests
Run these AFTER implementation to verify:

```bash
# Test 1: PM2 config exists and is valid
node -e "const c = require('./ecosystem.config.cjs'); console.log('name:', c.apps[0].name)"
→ expect: name: zoom-pipeline

# Test 2: Start service
pm2 start ecosystem.config.cjs
pm2 status zoom-pipeline
→ expect: status: online

# Test 3: Wait for first poll cycle (check logs after 30 seconds)
sleep 30 && pm2 logs zoom-pipeline --lines 10 --nostream
→ expect: logs showing poll cycle start/end

# Test 4: Health check
bash scripts/health-check.sh && echo "HEALTHY" || echo "UNHEALTHY"
→ expect: HEALTHY

# Test 5: Startup validation logged
pm2 logs zoom-pipeline --lines 20 --nostream | grep -i 'validation\|credential'
→ expect: credential validation messages

# Test 6: DRY_RUN mode still works
DRY_RUN=true node src/poll.js 2>&1 | grep -i 'dry.run'
→ expect: dry run messages, no Slack posting

# Test 7: Git repo exists
git log --oneline -1
→ expect: initial commit hash and message
```

## Completion Instructions
1. Run all smoke tests and confirm they pass
2. Write result to: `.planning/phases/02-deployment-operations/result.md`
3. Commit all changes with prefix: `[zoom-pipeline-02]`
4. Push to origin (if remote exists) or just local commit
