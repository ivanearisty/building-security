# Building Security Camera — Architecture

## Overview

A self-hosted security camera system for an apartment building hallway.
Residents log in to view and download footage. The system is hardened
against abuse since the thief may be a resident with access.

```
Tapo C110 ──RTSP──▶ security-recorder ──writes──▶ /recordings volume
                                                        │
                                                    read-only
                                                        │
              cloudflared ◀──localhost:8443──▶ security-api
                  │                          (nginx + FastAPI)
                  │
               tunnel        ← all of the above runs on TrueNAS
─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─
                  │
              Cloudflare
              ┌───┴───┐
              │       │
         Pages CDN   kosciuszko.suape.net
         (frontend)  (API + video proxy)
              │       │
              ▼       ▼
          Resident browser
```

## Components

### 1. security-recorder (Docker container on TrueNAS)

**Image**: `ghcr.io/ivanearisty/building-security-recorder:latest`
**Base**: Alpine 3.19

Runs ffmpeg in a loop, capturing the camera's RTSP stream and writing
HLS segments (10s each) to disk organized by date:

```
/recordings/
  2026-03-06/
    playlist.m3u8
    segment_14-00-00.ts
    segment_14-00-10.ts
    ...
  2026-03-07/
    ...
```

**Resilience**:
- If the camera disconnects or ffmpeg crashes, it retries with exponential
  backoff (5s → 10s → 20s → ... → 60s max).
- On clean exit, backoff resets to 5s.
- RTSP connection timeout is 10s so ffmpeg won't hang on a dead camera.
- ffmpeg restarts every hour (`-t 3600`) to ensure the day directory
  rolls over at midnight and playlists stay manageable.
- A cron job runs daily at midnight deleting recording directories older
  than 14 days.

### 2. security-api (Docker container on TrueNAS)

**Image**: `ghcr.io/ivanearisty/building-security-api:latest`
**Base**: Python 3.11-slim + nginx + ffmpeg

Two processes in one container:
- **nginx** (port 80, exposed as 8443): reverse proxy + static file server
- **FastAPI/uvicorn** (port 8000, internal only): auth + API logic

**API endpoints**:

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/auth/login` | POST | No | Username/password → JWT (24hr) |
| `/auth/me` | GET | Bearer | Validate token |
| `/auth/users` | POST | Admin | Create user |
| `/auth/users/{name}/disable` | POST | Admin | Disable account |
| `/api/days` | GET | Bearer | List recording dates |
| `/api/download?date=...&start=...&end=...` | GET | Bearer | Download clip as mp4 |
| `/recordings/**/*.m3u8` | GET | Bearer | HLS playlist (static) |
| `/recordings/**/*.ts` | GET | Bearer | HLS segment (static) |

Everything else returns 403.

**User storage**: SQLite at `/data/users.db` (persisted via Docker volume).
Passwords hashed with bcrypt (12 rounds). No self-registration — admin
creates accounts via CLI:

```bash
docker compose exec security-api python auth.py create-admin admin SecurePass
docker compose exec security-api python auth.py create-user resident1 TempPass
docker compose exec security-api python auth.py disable-user resident1
docker compose exec security-api python auth.py reset-password resident1 NewPass
docker compose exec security-api python auth.py list-users
```

**Audit log**: every login attempt and video access is logged to
`/data/audit.log` with timestamp, username, IP, and path.

### 3. Frontend (Cloudflare Pages)

**Stack**: Vite + React + TypeScript + hls.js
**Bundle**: ~85KB gzipped

Two views:
- **Login**: username/password form → stores JWT in localStorage
- **Player**: date picker, hls.js video player, time range download

hls.js injects the JWT as an `Authorization` header on every `.ts`/`.m3u8`
request via `xhrSetup`, so nginx can validate auth on each segment.

Deployed automatically to Cloudflare Pages on push to `main`.

### 4. cloudflared (Docker container on TrueNAS)

Runs the Cloudflare Tunnel that routes `kosciuszko.suape.net` to
`localhost:8443`. No ports are open on the TrueNAS host — all traffic
flows through the tunnel. Cloudflare provides DDoS protection on the
free tier.

### 5. Infrastructure as Code

**`homelab-infra/terraform/`** manages:
- The Cloudflare Tunnel
- DNS CNAME records (`kosciuszko.suape.net` → tunnel)
- Ingress routing (subdomain → local port)

**`homelab-infra/docker-compose.yml`** runs all containers on TrueNAS.
Watchtower polls ghcr.io every 5 minutes and auto-updates containers
when CI pushes new images.

## Security Model

The thief may be a resident with legitimate access. Defense in depth:

**nginx layer**:
- Allowlisted routes only — everything else is 403
- Only GET, POST, OPTIONS allowed
- `autoindex off` — no directory browsing
- Rate limiting: 10 req/s on auth, 50 req/s on video, 20 req/s on API
- `client_max_body_size 1k` — no uploads
- Security headers (X-Frame-Options DENY, CSP, no-sniff, etc.)
- `server_tokens off`

**Auth layer**:
- JWT expires in 24 hours
- bcrypt with 12 rounds
- Admin can disable any account instantly
- No self-registration, no password reset flow
- All access audited

**Network layer**:
- Cloudflare Tunnel — no open ports on TrueNAS
- DDoS protection via Cloudflare free tier
- Path traversal blocked by nginx regex + Python path validation

## Data Flow

### Live viewing
1. Resident opens frontend → logs in → gets JWT
2. Selects today's date → frontend loads `https://kosciuszko.suape.net/recordings/2026-03-06/playlist.m3u8`
3. hls.js sends `Authorization: Bearer <jwt>` with each request
4. nginx validates JWT via `auth_request` to FastAPI → serves .m3u8/.ts files
5. Video plays with ~10s delay (HLS segment duration)

### Downloading a clip
1. Resident picks date + start/end time → clicks download
2. Frontend calls `/api/download?date=2026-03-06&start=14-00-00&end=14-30-00`
3. FastAPI finds matching .ts segments, concatenates them with ffmpeg → returns mp4
4. Browser saves the file

### CI/CD
1. Push to `main` → GitHub Actions runs lint + build
2. Docker images pushed to ghcr.io
3. Watchtower on TrueNAS detects new images → pulls and restarts containers
4. Wrangler deploys frontend to Cloudflare Pages

## Volumes

| Volume | Mountpoint | Purpose |
|---|---|---|
| `security_recordings` | `/recordings` | HLS segments + playlists |
| `security_data` | `/data` | SQLite DB + audit log |

Both persist across container rebuilds. Only destroyed by explicit
`docker volume rm`.
