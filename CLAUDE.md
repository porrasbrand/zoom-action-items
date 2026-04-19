# Zoom Action Items — CLAUDE.md

## What This Is
Meeting transcript pipeline + dashboard for Breakthrough3x. Processes Zoom recordings, extracts action items via AI, pushes to ProofHub. Used daily by Phil, Dan, and the B3X team.

## Live URLs
- **Primary:** https://www.manuelporras.com/zoom/ (hetzner, port 3875)
- **Mirror:** https://ai.breakthrough3x.com/zoom/ (hassan, API proxied to hetzner)
- **GitHub:** https://github.com/porrasbrand/zoom-action-items (private)

## Architecture (as of 2026-04-19)
```
Phil's browser → ai.breakthrough3x.com (hassan)
                    → Apache → static files (local)
                    → /zoom/api/* → PROXY to hetzner:3875 (direct IP)
                    → /zoom/auth/* → PROXY to hetzner:3875

Pipeline (webhooks, Zoom polling) → hetzner:3875 → SQLite DB

ONE database: hetzner only. Hassan has NO local DB (archived).
```

## Key Files
| File | Purpose |
|------|---------|
| src/api/server.js | Express server, routes, auth, CORS |
| src/api/routes.js | API endpoints (meetings, action items, PH push) |
| src/api/db-queries.js | SQLite queries |
| src/lib/auth.js | Google OAuth, sessions, whitelisting |
| src/lib/proofhub-client.js | PH API (tasks, comments, attachments) |
| src/lib/intent-router.js | AI Concierge (Gemini classifier → GPT generator) |
| src/lib/rag-engine.js | RAG retrieval for concierge |
| src/lib/pipeline-backfill.js | Auto-fill pipeline gaps |
| src/config/clients.json | Client→PH project mapping |
| public/index.html | Dashboard frontend (single page) |
| data/zoom-action-items.db | SQLite database (THE single source of truth) |

## PM2 Services (hetzner)
| Service | Purpose |
|---------|---------|
| zoom-dashboard | API server on port 3875 |
| zoom-pipeline | Zoom polling + transcript processing |

## Auth System
- Google OAuth with whitelisted emails (@breakthrough3x.com auto-allowed)
- Session: 7-day expiry with sliding refresh (extends on every use)
- Cookie: `zoom_session`, path=/zoom, secure auto-detected, sameSite auto-detected
- Sessions stored in auth_sessions table

## ProofHub Integration
- Push action items to PH tasks via API
- AK comment: auto-posts acknowledgment request to assignee
- File attachments via multer upload
- Push queue: survives server restarts (push_queue table)

## Development Rules
1. **Hetzner is the codebase.** Never implement on lipo-360 (local machine).
2. **Deploy order:** hetzner first → git push → hassan git pull (for frontend).
3. **Hassan has NO local server.** Apache proxies API to hetzner.
4. **Never restart during Phil's work hours** (13:00-23:00 UTC / 8am-6pm ET) without warning.
5. **DB backups before risky changes:** `cp data/zoom-action-items.db data/zoom-action-items.db.backup-YYYY-MM-DD`
6. **Test after deploy:** `curl -s https://ai.breakthrough3x.com/zoom/api/health`

## Common Operations
```bash
# Deploy to hetzner
ssh hetzner "cd ~/awsc-new/awesome/zoom-action-items && git pull && pm2 restart zoom-dashboard"

# Deploy frontend to hassan
sshpass -p 'XXX' ssh hassan "cd /home/vince/zoom-action-items && git pull origin master"

# Backup DB
ssh hetzner "cp ~/awsc-new/awesome/zoom-action-items/data/zoom-action-items.db ~/awsc-new/awesome/zoom-action-items/data/zoom-action-items.db.backup-$(date +%Y-%m-%d)"

# Check health
curl -s https://www.manuelporras.com/zoom/api/health
curl -s https://ai.breakthrough3x.com/zoom/api/health
```

## Recent Architecture Decisions
- **2026-04-19:** Hassan converted from independent server to API proxy (single DB on hetzner)
- **2026-04-17:** Push queue added — survives server restarts, auto-retries pending pushes
- **2026-04-17:** Session sliding refresh — active users never expire
- **2026-04-16:** Concierge v3 — LLM-first intent classification (Gemini classifier → GPT generators)
- **2026-04-16:** People resolver pulls from ProofHub API (not hardcoded)

## Full Architecture Details
See docs/ARCHITECTURE.md
