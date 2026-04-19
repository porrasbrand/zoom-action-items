# Zoom Action Items — Architecture

## Server Topology
```
┌─────────────────────────────────────────────┐
│ hetzner (78.47.21.177)                      │
│ Primary server — ALL data lives here        │
│                                             │
│ PM2: zoom-dashboard (port 3875)             │
│ PM2: zoom-pipeline (Zoom API polling)       │
│ DB: data/zoom-action-items.db (SQLite)      │
│ Nginx: reverse proxy → port 3875            │
│                                             │
│ Firewall: port 3875 open ONLY for hassan IP │
└──────────────┬──────────────────────────────┘
               │ HTTP :3875
               │
┌──────────────▼──────────────────────────────┐
│ hassan (104.251.217.215)                    │
│ Mirror — API proxy only, no local DB        │
│                                             │
│ Apache: ai.breakthrough3x.com              │
│   /zoom/ → local static files               │
│   /zoom/api/* → proxy to hetzner:3875       │
│   /zoom/auth/* → proxy to hetzner:3875      │
│                                             │
│ Cloudflare: SSL termination                 │
│ NO local Node server. NO local database.    │
└─────────────────────────────────────────────┘
```

## Data Flow
```
Zoom Cloud → webhook → hetzner zoom-pipeline
  → download recording → transcribe
  → AI extract action items → store in SQLite
  → auto-backfill (chunks, embeddings, summaries, evaluations)

User (Phil) → ai.breakthrough3x.com
  → login (Google OAuth via hetzner)
  → view meetings, edit action items
  → push to ProofHub (creates task, optional AK comment)
  → all API calls proxied to hetzner
```

## Session & Cookie Architecture
- Google OAuth → session ID stored in auth_sessions table
- Cookie: zoom_session, 7-day maxAge, sliding refresh
- trust proxy enabled (Cloudflare SSL termination)
- secure/sameSite auto-detected based on req.secure

## ProofHub Push Architecture
- User clicks Push → INSERT into push_queue (status=pending)
- Call PH API createTask → on success: UPDATE push_queue (completed) + UPDATE action_item
- On server restart: auto-retry pending items in push_queue
- Optional AK comment: POST comment to task after creation

## Hassan Proxy Configuration
Apache config at /etc/apache2/sites-enabled/zoom-dashboard.conf:
- ProxyPass /zoom/api/ → http://78.47.21.177:3875/zoom/api/
- ProxyPassReverseCookieDomain for session cookie rewriting
- SSLProxyEngine On (for HTTPS upstream if needed)
- LimitRequestBody 10MB (file uploads)
- ProxyTimeout 120s (LLM calls can be slow)

## Deploy Checklist
1. Make changes on hetzner codebase
2. `node --check src/api/server.js` (syntax verify)
3. `git commit && git push origin master`
4. `pm2 restart zoom-dashboard`
5. Verify: `curl -s https://www.manuelporras.com/zoom/api/health`
6. Pull frontend on hassan: `git pull origin master` (on hassan)
7. Verify proxy: `curl -s https://ai.breakthrough3x.com/zoom/api/health`
