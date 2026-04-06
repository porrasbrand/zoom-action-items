# Development Workflow — zoom-action-items

## Environments

| Environment | URL | Machine | Purpose |
|-------------|-----|---------|---------|
| **Production** | https://www.manuelporras.com/zoom/ | hetzner (remote.manuelporras.com) | Live dashboard, pipeline, webhooks |
| **Development** | https://ai.breakthrough3x.com/zoom/ | 104.251.217.215 | Dev/staging, read-only DB mirror |

## Architecture

```
┌──────────────────────────┐        ┌──────────┐        ┌──────────────────────────┐
│  Dev (104.251.217.215)   │        │  GitHub   │        │  Production (hetzner)    │
│                          │        │           │        │                          │
│  Vince codes here        │──push──│  master   │──pull──│  Manuel approves here    │
│  Feature branches        │        │  (protected)       │  Pipeline + webhooks     │
│  ai.breakthrough3x.com   │        │  PRs required      │  manuelporras.com/zoom   │
│                          │        │           │        │                          │
│  DB: mirror (read-only)  │◄──sync─────────────────────│  DB: source of truth     │
│  Hourly cron from prod   │        │           │        │  99 meetings + evals     │
└──────────────────────────┘        └──────────┘        └──────────────────────────┘
```

## For Vince (Developer)

### Daily workflow

1. **Start from a fresh branch:**
   ```bash
   cd ~/zoom-action-items
   git checkout master
   git pull origin master
   git checkout -b feature/my-feature-name
   ```

2. **Code and test locally:**
   - Edit files
   - Test at https://ai.breakthrough3x.com/zoom/
   - The local DB has a recent copy of production data (synced hourly)

3. **Commit and push:**
   ```bash
   git add <files>
   git commit -m "feat: Description of change"
   git push origin feature/my-feature-name
   ```

4. **Create a Pull Request:**
   - Go to https://github.com/porrasbrand/zoom-action-items
   - Click "Compare & pull request"
   - Describe what changed and why
   - Request review from @porrasbrand

5. **Wait for approval:**
   - Manuel reviews the PR
   - Once approved and merged → production updates

### Rules
- **NEVER push directly to `master`** — it is branch-protected
- **NEVER modify the production database** — your DB is a mirror, changes will be overwritten
- **NEVER run the pipeline** (`poll.js`, `service.js`) — only hetzner processes Zoom webhooks
- **Only the dashboard runs on your machine** (`src/api/server.js` via PM2)
- **Feature branches only** — name them: `feature/`, `fix/`, `refactor/`

### Restarting the dashboard
```bash
pm2 restart zoom-dashboard
pm2 logs zoom-dashboard --lines 20
```

### Checking your DB is current
The mirror syncs hourly from production. To force a sync:
```bash
sudo /home/vince/zoom-action-items/scripts/mirror-sync.sh
```

---

## For Manuel (Owner / Reviewer)

### Reviewing PRs

1. Check PRs at https://github.com/porrasbrand/zoom-action-items/pulls
2. Review the diff
3. Approve and merge (or request changes)
4. Pull on hetzner:
   ```bash
   cd ~/awsc-new/awesome/zoom-action-items
   git pull origin master
   pm2 restart zoom-dashboard
   ```

### Emergency: Direct production changes
If you need to push directly to master (bypasses branch protection since enforce_admins is off):
```bash
cd ~/awsc-new/awesome/zoom-action-items
# Make changes
git add <files>
git commit -m "hotfix: Description"
git push origin master
```

### DB migrations
If a code change requires a DB migration:
1. Merge the PR
2. Pull on hetzner
3. Run the migration on hetzner (production DB)
4. The mirror will pick up the DB change on next hourly sync

---

## Mirror Sync Details

**Script:** `/home/vince/zoom-action-items/scripts/mirror-sync.sh`
**Schedule:** Every hour (cron on 104.251.217.215)
**What syncs:**
- `git pull origin master` (code)
- SQLite DB copied from hetzner (WAL checkpoint first, then SCP)
- `npm install` (if package.json changed)
- `pm2 restart zoom-dashboard`

**Direction:** Production → Dev (one-way). Dev changes never flow back automatically.

---

## What Runs Where

| Component | Production (hetzner) | Dev (104.251.217.215) |
|-----------|---------------------|----------------------|
| Dashboard (`server.js`) | ✅ PM2 | ✅ PM2 |
| Pipeline (`poll.js`) | ✅ PM2 | ❌ Stopped |
| Zoom webhooks | ✅ Receives | ❌ N/A |
| Slack notifications | ✅ Posts | ❌ N/A |
| ProofHub sync | ✅ Pushes | ❌ N/A |
| Session evaluation | ✅ Runs on new meetings | ❌ N/A |
| SQLite DB | ✅ Source of truth | 📋 Read-only mirror |
| Cron sync | ❌ N/A | ✅ Hourly pull |

---

## Google OAuth

Both environments share the same OAuth client:
- **Account:** porrasbrand@gmail.com
- **Project:** Claude Email Integration
- **Client ID:** `683293165614-...`
- **Redirect URIs:**
  - `https://www.manuelporras.com/zoom/auth/callback` (production)
  - `https://ai.breakthrough3x.com/zoom/auth/callback` (dev)

To add a new environment, add its callback URL in Google Cloud Console → APIs & Services → Credentials.
