# Deployment

Everything needed to run this in production, in the order you need it. If you
only read one section, read [Before you go live](#5-before-you-go-live) — the app
refuses to start on most misconfigurations, but not all of them are fatal.

**Pick your path:**

| You have | Go to |
| --- | --- |
| A spare PC / VM on your LAN, just trying it out | [2a. 5-minute LAN quickstart](#2a-5-minute-lan-quickstart) |
| A VPS or server with a domain, ports 80/443 free | [2. Docker Compose](#2-quick-start-with-docker-compose) |
| A Synology / QNAP NAS (ports 80/443 already taken) | [2b. NAS (Synology / QNAP)](#2b-nas-synology--qnap) |
| Node.js and your own reverse proxy | [3. Without Docker](#3-without-docker) |

Every environment variable is listed in [16. Environment reference](#16-environment-reference).

---

## 1. What you are deploying

One Node process. It serves the REST API, the WebSocket gateway, uploaded files
and the built React client, all on a single port.

The database is either **PostgreSQL** (`DATABASE_URL=postgres://…`, the
production default in the compose file) or an embedded **SQLite** file (no
`DATABASE_URL`: zero setup, ideal for development and small single-host
installs). Both run the same code and the same migrations; see
[PostgreSQL](#11-postgresql) for setup, migrating an existing SQLite database,
backups and tuning.

By default the process keeps rate limits, presence, typing indicators and
Socket.IO rooms **in memory**, so one app instance serves everyone — scale it
vertically first. With PostgreSQL plus Redis/Valkey (`REDIS_URL`, the compose
`scale` profile) several instances share that state; see
[Running several instances](#running-several-instances).

Optional pieces, each off until configured: a TURN relay (coturn, `turn`
profile), a LiveKit SFU for large voice/video rooms (`livekit`), self-hosted
translation (LibreTranslate, `translate`), Web Push notifications (VAPID keys),
passkeys (WebAuthn), and a Grafana/Tempo/Loki/Prometheus stack
(`observability`).

| Piece | Where it lives |
| --- | --- |
| Application | `server.js`, `routes/`, `services/`, `lib/` |
| Database | PostgreSQL at `DATABASE_URL`, or one SQLite file at `DB_PATH` (default `./discord.db`) |
| Uploaded files | `STORAGE_ROOT` (default `./public/uploads`), or S3 |
| Client bundle | `dist/`, built by `npm run build` |

---

## 2. Quick start with Docker Compose

The compose file runs the app, PostgreSQL 16 and Caddy, which obtains and
renews a TLS certificate automatically. This is the recommended path. The app
waits for Postgres to report healthy, then creates and migrates the schema
itself.

```bash
cp .env.example .env
npm run secrets -- --write     # fills STORAGE_URL_SECRET, POSTGRES_PASSWORD, ADMIN_TOKEN,
                               # TURN/LiveKit secrets and VAPID keys; never overwrites a set value
                               # (no Node on the host? `npm run secrets` prints them for pasting,
                               #  or: openssl rand -base64 32 / openssl rand -hex 24)
```

Then edit `.env` — at minimum:

```bash
NODE_ENV=production
PUBLIC_URL=https://chat.example.com
DOMAIN=chat.example.com
ALLOW_DEV_IDENTITY=0
SECURE_COOKIES=1
CORS_ORIGIN=
# and, from npm run secrets: STORAGE_URL_SECRET, ADMIN_TOKEN, POSTGRES_PASSWORD
```

`.env.example` ships `POSTGRES_PASSWORD=` **empty on purpose**: `docker compose`
refuses to start ("set POSTGRES_PASSWORD in .env") until you set one, so the
database never comes up with a published example password. Use URL-safe
characters (it is spliced into `DATABASE_URL`).

`POSTGRES_PASSWORD` is fixed into the database volume on the very first start;
changing it later means `ALTER ROLE antigravity PASSWORD '…'` inside Postgres
as well. To stay on SQLite under compose, add `DATABASE_URL=` (empty) to `.env`.

`CORS_ORIGIN` is deliberately empty: the client is served by the same process, so
it is same-origin and needs no CORS at all.

```bash
docker compose up -d --build
docker compose logs -f app
```

Optional demo data (five accounts, one of them a bot, three servers, sample
messages — password `antigravity123`). Production refuses to seed unless you ask
for it explicitly, because anyone can then sign in as the seeded owner; only do
this on a throwaway instance:

```bash
docker compose exec -e SEED_DATABASE=1 app node db/seed.js
```

Point your DNS A/AAAA record at the host before the first start, or Caddy cannot
complete the ACME challenge.

**HTTPS is not optional for voice.** Browsers expose the microphone and camera
only on `https://` origins (and `localhost`). Served over plain `http://` from a
LAN IP, text chat works but joining voice shows "Voice and video need HTTPS".

**Image size.** The runtime image carries production dependencies only. The
client-side packages (React, Tailwind, Vite and its esbuild/rollup binaries,
lucide icons, fonts, livekit-client, the WebAuthn browser helper) are
`devDependencies`: the build stage installs them to run `npm run build`, then
`npm prune --omit=dev` drops them — about 110 MB less `node_modules`, and no
Go-built esbuild binary for scanners to flag. `npm ci --omit=dev && npm start`
therefore works on a bare host too, as long as `dist/` was built somewhere with
the dev dependencies (CI checks both).

---

## 2a. 5-minute LAN quickstart

For a home server or a spare PC, reachable only inside your network. Plain HTTP,
so **no voice/video** (browsers require HTTPS for the microphone) and **never
expose it to the internet** like this.

```bash
git clone https://github.com/Gubbitkeytoday/discord.git antigravity && cd antigravity
npm ci && npm run build
cat > .env <<'EOF'
NODE_ENV=production
SERVE_STATIC=1
PUBLIC_URL=http://192.168.1.20:3001      # this machine's LAN address
SECURE_COOKIES=0                          # plain http: a Secure cookie would be dropped
ALLOW_DEV_IDENTITY=0
CORS_ORIGIN=
EOF
npm run secrets | grep STORAGE_URL_SECRET >> .env
npm start
```

Open `http://192.168.1.20:3001` from any device on the LAN and register — the
first account is an ordinary user; create a server and share its invite link.
SQLite is used (no `DATABASE_URL`), so the database is one file (`discord.db`)
and `npm run backup` backs it up.

Why `SECURE_COOKIES=0`: production defaults it on, and browsers silently drop
`Secure` cookies on `http://` (except `localhost`). Sign-up then *looks*
successful and every reload lands back on the login screen. The server prints a
red **CONFIGURATION PROBLEM** box at boot when `SECURE_COOKIES` is on and
`PUBLIC_URL` is plain http on a non-localhost address — if you see it, this is
why. Once you put TLS in front, set `SECURE_COOKIES=1` and an `https://`
`PUBLIC_URL`.

With Docker instead of Node on the host: follow section 2 with the `no-proxy`
profile and `APP_BIND=0.0.0.0` (next section), plus the same `SECURE_COOKIES=0`
and `PUBLIC_URL`.

---

## 2b. NAS (Synology / QNAP)

DSM (and QTS) already run a web server on ports 80 and 443, so the default
compose stack's Caddy fails with "address already in use". Two ways around it:

**A. Let the NAS terminate TLS (recommended on DSM).** Run the stack without
Caddy and point DSM's reverse proxy at the app.

1. Install **Container Manager** (DSM 7.2) and copy this repository to a shared
   folder, e.g. `/volume1/docker/antigravity` (File Station, or `git clone` over
   SSH).
2. In that folder: `cp .env.example .env`, set the values from section 2, then
   also:
   ```bash
   PUBLIC_URL=https://chat.example.synology.me
   TRUST_PROXY=2          # DSM's proxy + the app-direct forwarder
   APP_PORT=3001          # published on 127.0.0.1 only
   ```
3. Start it over SSH (`sudo docker compose --profile no-proxy up -d app-direct`)
   or as a Container Manager **Project** from this folder with the same command.
   Naming `app-direct` starts the app and PostgreSQL but **not** Caddy.
4. **DDNS:** Control Panel › External Access › DDNS › Add → Synology, pick a
   hostname such as `chat-example.synology.me` (any DDNS provider works).
5. **Certificate:** Control Panel › Security › Certificate › Add → Let's
   Encrypt for that hostname.
6. **Reverse proxy:** Control Panel › Login Portal › Advanced › Reverse Proxy ›
   Create. Source: HTTPS, the hostname, port 443. Destination: HTTP,
   `localhost`, port `3001`. Then **Custom Header › Create › WebSocket** — it
   adds `Upgrade` and `Connection`; without them realtime falls back to slow
   polling. Under Advanced Settings raise the proxy timeouts to 300 s so large
   uploads are not cut off.
7. **Router:** forward TCP 443 (and 80, for Let's Encrypt renewals) to the NAS.
   Nothing else is needed for text chat.
8. Assign the certificate to the reverse-proxy hostname (Certificate ›
   Settings).

QNAP: the same with QTS's **Web Server › Reverse Proxy** (or Container Station
plus nginx Proxy Manager). Enable WebSocket support on the rule.

**B. Keep Caddy on other ports.** Set `HTTP_PORT=8080` and `HTTPS_PORT=8443` in
`.env`, run `docker compose up -d`, and forward the router's **80 → 8080** and
**443 → 8443** (TCP, plus UDP 443 → 8443 for HTTP/3). Caddy gets its own Let's
Encrypt certificate for `DOMAIN`, so `DOMAIN` must resolve to your public IP
(DDNS as in step 4).

**Voice on a NAS:** add the `turn` profile and, because the NAS sits behind the
router's NAT, set `TURN_EXTERNAL_IP=<public-ip>/<nas-lan-ip>` and forward
**3478/udp+tcp** and **49160-49200/udp** to the NAS. See
[TURN](#4-voice-and-video-turn).

**Backups on a NAS:** Hyper Backup cannot see named Docker volumes (they live
under `/volume1/@docker`). Run `scripts/ops/docker-backup.sh backup
/volume1/backup/antigravity` from a scheduled task (Control Panel › Task
Scheduler › User-defined script, as root) and let Hyper Backup copy that folder
off the box. See [Backups](#backups).

**Build time:** there is no prebuilt image yet, so the NAS builds it (installs
dependencies and runs Vite): several minutes on a DS920+, and 2 GB+ of free RAM
helps. Building on a PC and `docker save | ssh nas docker load` works too.

---

## 3. Without Docker

```bash
npm ci
npm run build
NODE_ENV=production node server.js
```

Put a reverse proxy in front of it for TLS. Two working configs are included:

- `Caddyfile` — used by compose, certificates handled for you
- `nginx.conf.example` — if nginx is already your edge

Whichever you use, three things must be right:

1. **WebSocket upgrade headers on `/socket.io/`.** Without them realtime silently
   degrades to long-polling.
2. **No response buffering on that path.** Buffering delays every event.
3. **`TRUST_PROXY` matching your real number of hops.** Behind exactly one proxy,
   set `1`. Too high and a client can forge `X-Forwarded-For` to escape rate
   limiting; too low and every rate limit keys on the proxy's own address, so one
   abusive user throttles everybody.

A systemd unit, if you are not using containers:

```ini
[Unit]
Description=Antigravity Discord
After=network.target

[Service]
Type=simple
User=antigravity
WorkingDirectory=/srv/antigravity
EnvironmentFile=/srv/antigravity/.env
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
# Graceful drain: server.js handles SIGTERM and finishes in-flight requests.
KillSignal=SIGTERM
TimeoutStopSec=30

[Install]
WantedBy=multi-user.target
```

---

## 4. Voice and video: TURN

Voice, video and screen share are peer-to-peer WebRTC: the server only relays
the offer/answer/ICE messages over Socket.IO. Media then has to find a direct
path between every pair of participants. With STUN alone (the default, Google's
public STUN servers) that works for most home broadband, and **fails** for:

- mobile data (carrier-grade NAT), many hotel/café/campus networks,
- symmetric NAT and corporate firewalls that block outbound UDP,
- two users behind the same restrictive NAT.

Those users see the other tile stuck on "Connecting…" and then "Can't connect",
and hear nothing. Rough industry numbers put this at 10–20% of real users. The
fix is a **TURN relay**, which forwards media for pairs that cannot connect
directly. Plan for it before launch.

### Run coturn with the compose file

```bash
# .env
TURN_SECRET=<npm run secrets>
TURN_URLS=turn:chat.example.com:3478?transport=udp,turn:chat.example.com:3478?transport=tcp
STUN_URLS=stun:chat.example.com:3478     # coturn answers STUN too; unset = Google's STUN
# Behind ANY NAT — a cloud VM with 1:1 NAT (AWS, GCP, Azure, Oracle) *or* a
# home/office router in front of a NAS/PC: public[/private]
TURN_EXTERNAL_IP=203.0.113.10/192.168.1.20

docker compose --profile turn up -d
```

Open in the host firewall **and** the cloud security group — or forward on
your router, when the host is behind one: `3478/udp`, `3478/tcp`, and the
relay range `49160-49200/udp` (≈ 20 concurrent relayed users; widen
`--min-port/--max-port` in the compose file for more). The coturn container
uses host networking, so these are the host's ports. The bundled coturn has no
TLS certificate, so it listens for `turn:` only (TLS and DTLS are switched off);
do not list `turns:` URLs unless you front it with your own certificate.

Without `STUN_URLS` the client uses Google's public STUN servers, which means
every caller's IP address is sent to Google. Point it at your coturn to keep
calls entirely on your infrastructure.

`TURN_SECRET` is the coturn *shared secret* (TURN REST API). The app never hands
it to browsers — it mints a credential per user that expires, so a leaked
credential is useless within a day.

### How the client gets the ICE servers

On every voice join the client calls `GET /api/voice/ice-servers` and expects:

```json
{ "iceServers": [{ "urls": ["stun:…"] }, { "urls": ["turn:…"], "username": "…", "credential": "…" }],
  "iceTransportPolicy": "all" }
```

The server implements it (`server.js`, `GET /api/voice/ice-servers`): it reads
`STUN_URLS`, `TURN_URLS`, `TURN_SECRET`, `TURN_TTL_SECONDS` and
`ICE_TRANSPORT_POLICY`, and mints a per-user TURN REST credential
(`username = "<unix-expiry>:<userId>"`,
`credential = base64(HMAC-SHA1(TURN_SECRET, username))`). If the request fails
the client falls back to public STUN only.

### Checking it works

1. Open https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/,
   add `turn:chat.example.com:3478` with a username/credential from
   `/api/voice/ice-servers`, and gather. A `relay` candidate means TURN works.
2. Set `ICE_TRANSPORT_POLICY=relay` temporarily: every call is forced through
   TURN, which proves the relay path end to end. Set it back afterwards.
3. `chrome://webrtc-internals` shows the selected candidate pair per call.

### Room size

Full mesh: every participant uploads one copy of their audio (and camera, and
screen) to every other participant. `VOICE_MESH_LIMIT` (default 8) caps the room.
Audio alone is fine at 8; with cameras on, 4–5 people is the practical limit on
typical home upload bandwidth. Beyond that, turn on the optional LiveKit SFU
(section 4b), which removes the cap.

### Echo

Chrome only echo-cancels audio played through a media element. The client plays
voices that way, and switches to Web Audio only when you boost someone above
100% or turn on spatial audio — in those cases speaker users may cause echo;
headphones avoid it.

---

## 4b. Voice and video: LiveKit (optional SFU)

The mesh above tops out at a handful of people. For bigger rooms, stage
channels with a large audience, or many cameras, run a **LiveKit** SFU
(selective forwarding unit): every participant uploads each track once and the
SFU forwards it to everyone else. It is optional — with no `LIVEKIT_*`
variables the app keeps using the mesh, unchanged.

**What changes when it is on**

| | Mesh (default) | LiveKit |
|---|---|---|
| Room size | `VOICE_MESH_LIMIT` (8) | channel `user_limit` / `LIVEKIT_ROOM_LIMIT` only |
| Upload per person | one copy per other participant | one copy |
| Video | single layer | simulcast + dynacast (unused layers are not encoded), adaptive stream (hidden/small tiles get a small layer or none) |
| Codecs | browser default | AV1 → VP9 → VP8 by support, always with a VP8 backup layer (`LIVEKIT_VIDEO_CODEC`) |
| Audio | Opus | Opus + RED (redundant packets survive loss) + DTX |
| Moderation | enforced by the clients | also enforced by the SFU (permissions revoked, participants removed) |
| Encryption | DTLS-SRTP peer to peer | DTLS-SRTP to the SFU; optional E2EE (`LIVEKIT_E2EE=1`) |

What stays the same: the gateway (Socket.IO) is still the source of truth for
who is in a channel, mute/deafen, stage speakers, speaking indicators and the
soundboard; the UI is identical, plus a connection-quality indicator and a
"Reconnecting…" state. Clients ask `GET /api/voice/config` which mode is on.

**How authorization maps to LiveKit.** `POST /api/voice/livekit/token` issues
a short-lived room token (identity = user id, room = voice channel id) only to
users with **CONNECT** in that channel. Grants follow the channel's
permissions: **SPEAK** → microphone, **STREAM** → camera / screen share (+
its audio). On a **stage**, the audience can only subscribe; speakers and
stage moderators (**MUTE_MEMBERS**) publish. Moderators can server-mute
(**MUTE_MEMBERS**), server-deafen (**DEAFEN_MEMBERS**), move and disconnect
(**MOVE_MEMBERS**) through `/api/voice/channels/:channelId/members/:userId/…`;
the app pushes each change to the SFU through the RoomService API, so a
modified client cannot ignore it. Server mute/deafen is stored on the
membership and survives rejoining.

### Production requirements

- **A public IP** on the LiveKit host (or 1:1 NAT: cloud VMs are fine —
  `use_external_ip` discovers it via STUN; pin it with `NODE_IP` if needed).
- **Open ports** (host firewall *and* cloud security group):
  `7882/udp` (all WebRTC media, multiplexed on one port), `7881/tcp` (ICE/TCP
  fallback for UDP-blocking networks), `3479/udp` (embedded TURN relay),
  plus `443/tcp` for signalling through Caddy.
- **A TLS domain for signalling**, e.g. `lk.example.com`, pointing at the
  host. Browsers only allow `wss://` from an `https://` page.
- The secret: `openssl rand -hex 32` (LiveKit refuses anything under 32
  characters, and so does the app).
- Bandwidth: the SFU *downloads* one copy of every track and *uploads* one per
  subscriber. A 20-person audio room is ~1.5 Mbit/s up; a room with cameras
  is dominated by video — budget ~1.5 Mbit/s per visible 720p tile per viewer
  (adaptive stream lowers this for small tiles).

### Run it with the compose file

```bash
# .env
LIVEKIT_URL=wss://lk.example.com
LIVEKIT_API_KEY=antigravity            # must equal webhook.api_key in livekit.yaml
LIVEKIT_API_SECRET=<openssl rand -hex 32>
LIVEKIT_HOST=http://livekit:7880       # app → LiveKit over the internal network
LIVEKIT_DOMAIN=lk.example.com

docker compose --profile livekit up -d
```

Then enable the LiveKit site block in `Caddyfile` (it is commented out so a
stack without LiveKit does not try to get a certificate for a domain that does
not exist) and `docker compose restart caddy`.

`livekit.yaml` holds the server config (ports, embedded TURN, codecs, the
webhook). The API key/secret are **not** in it: compose passes them in the
`LIVEKIT_KEYS` environment variable. The webhook goes to
`http://app:3001/api/voice/livekit/webhook` over the internal network; the app
verifies its signature (JWT signed with the API secret, with a SHA-256 of the
exact body) and uses `participant_joined` / `participant_left` to keep the
voice roster honest when a browser reaches or leaves the SFU without the
gateway noticing (a crashed tab). Deliveries with a bad signature get `401`.

**TURN over TLS (optional).** The embedded TURN relay listens on UDP 3479.
Networks that allow only HTTPS need TURN/TLS on 443, which requires a second
domain (e.g. `turn.example.com`) with its own certificate and a TCP (layer-4)
load balancer or a dedicated IP — see LiveKit's "Firewall / TURN" docs, then
set `turn.domain`, `turn.tls_port` and `turn.external_tls` in `livekit.yaml`.
coturn (profile `turn`) is only for the mesh and is not needed with LiveKit.

**nginx instead of Caddy.** Proxy `lk.example.com` to `127.0.0.1:7880` with
WebSocket upgrade headers and `proxy_read_timeout 86400s` — see the commented
block in `nginx.conf.example`. UDP/TCP media ports go straight to LiveKit, never
through the web proxy.

**E2EE.** `LIVEKIT_E2EE=1` encrypts media frames in the browser with a
per-room key the app derives from `LIVEKIT_E2EE_SECRET` (or the API secret).
This hides media from whoever runs the SFU (useful with LiveKit Cloud), not
from this app's server. It costs CPU, disables RED and forces VP8; browsers
without insertable streams cannot join encrypted rooms.

**LiveKit Cloud** works the same way: set `LIVEKIT_URL` / key / secret from the
cloud project, leave `LIVEKIT_HOST` unset, and point the project's webhook at
`https://chat.example.com/api/voice/livekit/webhook`. No compose profile needed.

### Checking it works

1. `curl -s https://chat.example.com/api/voice/config -H "Cookie: …"` →
   `"mode":"livekit"`. If it says `mesh`, a variable is missing or the secret is
   too short — the app logs which one at boot (never the value).
2. Join a voice channel from two browsers: the room header shows **SFU** with a
   signal icon instead of **P2P n/m**.
3. `docker compose logs livekit` shows `participant active` for each; a
   participant stuck in "Reconnecting…" almost always means `7882/udp` (and
   `7881/tcp`) are not reachable from outside.
4. LiveKit's connection test (https://livekit.io/connection-test) with a token
   from `POST /api/voice/livekit/token` checks signalling, UDP, TCP and TURN.

**Content-Security-Policy.** The browser connects to `wss://lk.example.com`,
which `connect-src … wss:` already allows. LiveKit's diagnostic HTTPS request
(`/rtc/validate`, used only to explain a failed connection) is blocked by the
CSP; that only affects the error text.

**Noise suppression.** The toggle (room controls and Voice settings) uses the
browser's built-in noise suppression (`getUserMedia` constraint). An
RNNoise/WASM model is a possible follow-up; LiveKit's Krisp filter requires
LiveKit Cloud.

---

## 5. Before you go live

`lib/config.js` **refuses to start** with `NODE_ENV=production` if any of these
is true, because each one is a real vulnerability rather than a style preference:

| Refused | Why |
| --- | --- |
| `STORAGE_URL_SECRET` is the development default | anyone who has read this repository could forge a signed URL to any private file |
| `STORAGE_URL_SECRET` shorter than 24 characters | brute-forceable |
| `ALLOW_DEV_IDENTITY` enabled | an `x-user-id` header would let any request act as any user |
| `CORS_ORIGIN=*` | any website could call the API with your users' cookies |

It **warns** but starts on these — check them yourself:

- `SECURE_COOKIES=0` → session cookies sent over plain HTTP
- `SECURE_COOKIES` on (the production default) while `PUBLIC_URL` is plain
  `http://` on a non-localhost address → printed as a red **CONFIGURATION
  PROBLEM** box: browsers drop the Secure session cookie, so every sign-in is
  forgotten on reload. Put TLS in front, or set `SECURE_COOKIES=0` for a LAN test
- `PUBLIC_URL` unset → assumed `http://localhost:<port>`; same cookie problem
  when people open the server by IP
- `PUBLIC_URL` not `https://`
- `ADMIN_TOKEN` unset → maintenance and report-triage endpoints stay disabled
- `METRICS_TOKEN` unset → `/metrics` is not served at all in production
- `MAIL_TRANSPORT` is `console`/unset → password reset and e-mail verification
  are disabled (503 `MAIL_NOT_CONFIGURED`); configure SMTP to enable them.
  Reset/verification tokens are never returned in API responses in production.

Also enforced in code, no configuration needed: remote images are served
through the same-origin proxy `/api/media/proxy?url=…` and the CSP allows
images only from `'self'` (plus `STORAGE_PUBLIC_BASE`'s origin and any
`CSP_IMG_SOURCES`); sessions end after `SESSION_TTL_DAYS` (30) or
`SESSION_IDLE_DAYS` (14) idle; logging out or revoking a device disconnects its
live sockets; deleting an account and turning off 2FA require the password
again (and a 2FA code where enabled); a TOTP code is accepted once.

Verify the whole build before shipping:

```bash
npm run verify
```

That runs the client build, the test suite, the accessibility audit and the
translation audit.

---

## 6. Operating it

### Health and monitoring

| Endpoint | Purpose | Use for |
| --- | --- | --- |
| `/api/live` | process is up; does **not** touch the database | liveness probe |
| `/api/ready` | database reachable, Redis answers (only if `REDIS_URL` is set), enough free disk for uploads / the SQLite file; 503 while draining. Details under `checks` | readiness probe, load-balancer check |
| `/api/health` | detailed status, including `database: { driver, reachable, latency_ms, pool }`; 503 if the database is unreachable | humans, dashboards |
| `/metrics` | Prometheus text exposition | scraping |

Use `/api/live` for liveness and `/api/ready` for readiness — never the reverse.
A database blip should pull an instance out of rotation, not have the
orchestrator kill an otherwise healthy container.

In production `/metrics` exists only when `METRICS_TOKEN` is set, and every
scrape must send `Authorization: Bearer <token>` (compared in constant time).
Still scrape it over a private network where you can.

Exported metrics include request counts by method and status, p50/p95/p99
latency, 5xx count, live WebSocket connections, messages sent, uploads and
process memory, plus (prom-client) a route-templated request-duration
histogram, database call timings and errors, pool usage, voice participants,
socket events, notification deliveries, disk free per volume, browser Web
Vitals and the standard Node.js process/event-loop metrics. The full list,
tracing, dashboards and alerts are in [Observability](#14-observability).

Logs are JSON in production (`LOG_FORMAT=json`), one object per line, each with a
`request_id` that is also returned in the `X-Request-Id` response header — so a
user-reported failure can be found in the logs. Passwords, tokens, cookies,
e-mail addresses and message content are redacted before a line is written.

### Backups

The same commands work on both engines: with `DATABASE_URL` set they call
`pg_dump` / `pg_restore` and write `discord-<stamp>.dump` files (details in
[PostgreSQL → Backups](#backups-with-pg_dump)); without it they snapshot the
SQLite file as described here.

The SQLite database is one file, but do not copy it with `cp` while the server
is running: you can capture a torn page or miss data still in the WAL.

```bash
npm run backup            # database snapshot + uploaded files
npm run backup:list
npm run backup:prune      # keep the newest 7
npm run backup:verify backups/discord-20260801-040845.db
```

`create` uses SQLite's `VACUUM INTO`, which writes a consistent, compacted
snapshot while the server keeps serving. Uploaded files are content-addressed, so
the file copy only ever adds — re-running it is cheap.

Restoring (server **must** be stopped, or it will keep holding a stale WAL):

```bash
npm run backup:restore backups/discord-20260801-040845.db -- --force
```

The previous database is renamed aside rather than deleted. Migrations run
automatically on the next connect.

**In Docker** (either engine), use `scripts/ops/docker-backup.sh` from the
folder holding `docker-compose.yml`. It needs only `docker compose` and `sh` on
the host:

```bash
scripts/ops/docker-backup.sh backup ./backups            # → ./backups/<stamp>/{discord.dump|discord.db, uploads/}
scripts/ops/docker-backup.sh verify ./backups/<stamp>    # reads the whole archive
scripts/ops/docker-backup.sh drill ./backups             # backup + restore into a scratch DB + compare counts
scripts/ops/docker-backup.sh restore ./backups/<stamp>   # stops app (and app-2), restores, starts it
# copy ./backups off the host — a backup on the same disk is not a backup
```

With PostgreSQL (the compose default) it runs `pg_dump --format=custom` **inside
the `postgres` container**: the app image is distroless and ships no `pg_dump`,
while the database container always has tools matching the server. The dump
streams to the host over `docker compose exec -T`. Uploads are copied out with
`docker compose cp`, which reads the container filesystem directly (no shell
needed, works on a stopped container). Restore runs `pg_restore --clean
--if-exists --single-transaction` (a failed restore changes nothing) and copies
the uploads back as root with the image's own `node`, then hands them to the
app user (uid 1000), which `docker cp` would not do.

The same by hand, if you prefer:

```bash
docker compose exec -T postgres pg_dump -U antigravity -d antigravity --format=custom \
  > backups/discord-$(date +%Y%m%d-%H%M%S).dump
docker compose cp app:/data/uploads ./backups/uploads-$(date +%F)
# restore:
docker compose stop app
docker compose exec -T postgres pg_restore -U antigravity -d antigravity \
  --clean --if-exists --no-owner --single-transaction < backups/<file>.dump
docker compose start app
```

**Restore drill.** An untested backup is not a backup. `drill` restores the new
dump into a throwaway database next to the live one (`createdb drill_<time>`),
compares user/message counts and the schema version with the live database, and
drops it again; the live data is never touched. Run it after changing anything
about backups, and monthly from cron. On this branch the drill was exercised
end to end against PostgreSQL 16 (backup → verify → drill → wipe messages →
restore → counts back).

Nightly, from the host's cron:

```bash
15 3 * * * cd /srv/antigravity && scripts/ops/docker-backup.sh backup /srv/backups >> /var/log/antigravity-backup.log 2>&1
```

**In Docker with SQLite** (`DATABASE_URL=` empty), `docker-backup.sh` detects
it and snapshots with `VACUUM INTO` inside the app container. Done by hand,
snapshots go to the `app-backups` volume (`BACKUP_DIR=/backups`), separate from
the data volume, so recreating the container keeps them:

```bash
docker compose exec app node scripts/backup.mjs create --files
docker compose exec app node scripts/backup.mjs prune --keep 7
# copy them off the host — a backup on the same disk is not a backup
docker compose cp app:/backups ./backups-$(date +%F)
```

Restore in Docker: `docker compose stop app`, then
`docker compose run --rm app node scripts/backup.mjs restore /backups/<file>.db --force`,
then `docker compose start app`.

A nightly cron (without Docker):

```bash
0 3 * * * cd /srv/antigravity && npm run backup >> /var/log/antigravity-backup.log 2>&1
0 4 * * * cd /srv/antigravity && npm run backup:prune >> /var/log/antigravity-backup.log 2>&1
```

### Storage housekeeping

```bash
npm run storage:stats     # usage, orphans, per-user quotas
npm run storage:gc        # delete files nothing references any more
npm run storage:verify    # re-hash stored files and compare
npm run search:reindex    # SQLite: rebuild the FTS5 index. Postgres: nothing to rebuild (ANALYZE only)
node scripts/storage.js reprocess [--all]   # renditions/posters for uploads made before the media pipeline
node scripts/storage.js jobs                # media job queue: queued / running / failed
```

The server also runs hourly housekeeping on its own: expired sessions and account
tokens are pruned, and threads past their auto-archive window are archived.

### Deploying an update

```bash
git pull
docker compose up -d --build     # the image builds the client itself
# without Docker: npm ci && npm run build && systemctl restart antigravity
```

Rolling restarts are safe: `SIGTERM` makes `/api/ready` return 503 immediately so
the proxy stops sending new traffic, then in-flight requests finish, WebSockets
close, queries already running are allowed to finish, and the database is
closed (SQLite WAL checkpointed / Postgres pool ended) — up to
`SHUTDOWN_TIMEOUT_MS` (default 15s), after which the process exits anyway.

Migrations are versioned and run automatically at startup. **Take a backup before
deploying a schema change**, because they are forward-only.

---

## 7. Object storage (optional)

Local disk is the default and is fine for a single host. Set the `S3_*` variables
to move files to any S3-compatible service — AWS S3, Cloudflare R2, Backblaze B2,
MinIO. The signer is a hand-written SigV4 implementation verified against AWS's
published test vectors, so no SDK is required.

```bash
S3_ENDPOINT=https://<account>.r2.cloudflarestorage.com
S3_BUCKET=antigravity-media
S3_REGION=auto
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_FORCE_PATH_STYLE=1     # MinIO and some others need path-style URLs
```

Existing local files are not migrated automatically. Every `files` row records
the backend its bytes are on, so files written before S3 was configured keep
being served from disk; new uploads go to the bucket.

**Serving.** With `STORAGE_PUBLIC_BASE=https://cdn.example.com` (a CDN or public
bucket URL in front of the bucket) public URLs point straight at it. Left at
`/uploads`, a request for `/uploads/<key>` is answered with a 302 to a one-hour
presigned URL, and so are `/api/files/:id` and `/api/media/:id` for any
visibility (after the access check). The bucket answers `Range` itself, so video
seeking works through the redirect. Add the bucket (or CDN) origin to
`CSP_IMG_SOURCES`; `media-src` already allows `https:`.

**Direct uploads** (browser → bucket, bytes never touch the app):

1. `POST /api/media/uploads {category, filename, contentType, size}` →
   `{upload_id, method, url, fields | headers, complete_url}`. `method: "POST"`
   is an S3 POST policy that pins the key (`incoming/<user>/<id>`), the
   `Content-Type` and `content-length-range` = the declared size, valid 10
   minutes. Cloudflare R2 does not implement POST Object, so for R2 (or
   `S3_DIRECT_UPLOAD=put`) it is a presigned PUT whose signature covers
   `Content-Type` and `Content-Length`.
2. The browser sends the form fields + file (or the PUT) to `url`.
3. `POST complete_url` → the server HEADs the object (size must match), sniffs
   its first 4 KB with a ranged GET (type must be allowed; image header
   dimensions checked against the bomb limits), charges the quota, creates the
   file and queues an `ingest` job that strips metadata, moves it to its
   content-addressed key and makes renditions. The answer waits for that up to
   a few seconds, otherwise it comes back `media_status: "processing"`.

Bucket setup for direct uploads:

- CORS: allow `POST, PUT` from your site's origin with headers `Content-Type`,
  and expose `ETag`.
- CSP: the page's `connect-src` must include the bucket origin (the upload is a
  `fetch` to it) — see `lib/middleware.js`.
- A lifecycle rule expiring `incoming/` after 1 day catches uploads that were
  never completed (the app also deletes them after 10 minutes).
- Direct uploads are not deduplicated against existing files.

---

## 7a. Media pipeline

Every image upload is sanitised and given responsive renditions; everything is
optional and degrades cleanly (no sharp → originals only; no ffmpeg → no video
posters).

| Step | What happens |
| --- | --- |
| Limits | header dimensions checked *before* decoding (`MEDIA_MAX_PIXELS`, default 100 MP; `MEDIA_MAX_DIMENSION`, 16384 px) and sharp's `limitInputPixels` as a backstop — a decompression bomb is a cheap 413 `IMAGE_TOO_LARGE` |
| Metadata | EXIF, XMP, IPTC, GPS, comments and iPhone multi-picture trailers are removed from the stored original. Lossless (segments/chunks dropped) for JPEG, PNG and WebP; metadata items zero-filled for AVIF/HEIC; a re-encode (JPEG q92) only when an EXIF orientation has to be baked into the pixels |
| Placeholders | `width`/`height` (orientation applied) and a ThumbHash are in the upload response, so clients reserve the box before anything loads |
| Renditions | WebP at `MEDIA_WIDTHS` (160/480/960/1920, never enlarged); avatars and server icons square-cropped to 64/128/256/512; emoji 48/96/160 and stickers 160/320 fitted, never cropped; animated GIF/WebP → animated WebP up to 640 px plus a still |
| AVIF | same widths, in the background at effort 2 (`MEDIA_AVIF=0` turns it off). Measured per 1920 px rendition on one core: WebP ~0.65 s, AVIF effort 2 ~1.35 s, effort 4 (sharp's default) ~9 s |
| HEIC | recognised and metadata-stripped; prebuilt sharp cannot decode HEVC, so HEIC stays a downloadable file (and is refused for avatars/emoji) unless sharp is built against a libheif with HEVC |
| Video | dimensions (also from the MP4/WebM header without ffmpeg), duration, and a poster frame via system ffmpeg/ffprobe. The Docker image includes ffmpeg only with `--build-arg WITH_FFMPEG=1`: the runtime is distroless (no apt), so static `ffmpeg`/`ffprobe` binaries are copied from `FFMPEG_IMAGE` (default `mwader/static-ffmpeg:8.1.2`) into `/usr/local/bin`; the default build pulls nothing extra |

Serving: `GET /api/media/:id?w=<px>` picks the smallest rendition at least
`w` wide, in AVIF → WebP → original order by the request's `Accept` (wildcards
don't count), with `Vary: Accept`, an ETag, and
`Cache-Control: public, max-age=31536000, immutable` for public files once
processing is complete. Rendition files themselves are content-addressed
(`<sha256>.w480.webp`) and served immutable from `/uploads`. The original stays
downloadable at `/api/files/:id?download=1`.

Processing runs on a persisted queue (`media_jobs`): `MEDIA_JOB_CONCURRENCY`
jobs per process, leases so a job whose process died is picked up again, three
attempts with back-off. A multipart upload answers as soon as the bytes are stored
(`media_status: "processing"`, with dimensions and ThumbHash already set);
set `MEDIA_SYNC_BUDGET_MS` to make it wait for the WebP renditions instead. `GET /api/media/config` reports what this instance can
do and the queue depth. GC removes a file's renditions with it and sweeps
rendition files on disk that no row points at.

Renditions are not counted against the uploader's quota (they are the server's
choice); originals are. `STORAGE_QUOTA_BYTES` sets one quota for everybody.

---

## 8. Scaling

**What scales now.** One process on modest hardware handles thousands of
concurrent WebSocket connections. On PostgreSQL, writes from different requests
run concurrently (each transaction on its own pooled connection); on SQLite,
WAL mode gives concurrent readers with a single, queued writer, which suits
small installs because reads vastly outnumber writes.

**What does not, and what to do about it.**

| Limit | Why | Fix |
| --- | --- | --- |
| One writer | SQLite only | switch to PostgreSQL ([§11](#11-postgresql)) |
| One instance by default | Socket.IO rooms, presence and rate limits are in-process memory unless `REDIS_URL` is set | set `REDIS_URL` (Valkey/Redis) and run several instances — see "Running several instances" below |
| Voice above `VOICE_MESH_LIMIT` (8) | WebRTC full mesh: each extra peer costs every participant another upstream | an SFU (mediasoup, LiveKit) |
| Local uploads | tied to one host's disk | switch to `S3_*` |

Before optimising anything, look at `/metrics`. p95 latency and the 5xx counter
will tell you where the time actually goes.

<!-- realtime-scale: begin -->
### Reconnects and catch-up (every deployment)

- **Connection-state recovery.** A client that drops for less than
  `SOCKET_RECOVERY_MS` (default 2 min) reconnects with the same socket id and
  rooms, and the server replays the room events it missed (`socket.recovered`
  is `true` on the client). Before a resume is accepted the server re-checks
  the session (not revoked/expired) and every room (still a member, still has
  `VIEW_CHANNEL`); any change turns it into a fresh connection, so a replayed
  event can never leak a channel the user just lost. Sockets that were in a
  voice room always get a fresh connection (the voice client rejoins).
- **Catch-up REST** for anything longer, or a refused resume:
  `GET /api/sync?since=<cursor>` returns per-channel new/edited/deleted counts
  for readable channels, and a `state_hash` per guild (roles + visible
  channels + effective permissions) — refetch a guild when its hash changes,
  page `GET /api/channels/:id/messages?after=<newest id>` for channels you
  hold. Store the returned `cursor` each time; `reset: true` means reload
  everything. Full algorithm: comment at the top of `routes/sync.js`.
- **Search** filters by permission inside SQL, so pages are always full;
  page with `?before=<X-Next-Cursor>` from the previous response.
- **Graceful drain** (SIGTERM): `/api/ready` turns 503, clients receive
  `server_draining` and are closed with a *recoverable* reason, idle HTTP
  keep-alives close, in-flight requests finish, then the database closes.
  Presence is not flipped offline for users who are only switching instance.
- **Flood protection**: each socket has per-event budgets (typing, presence,
  speaking, signalling…); over-budget events are dropped (acks get
  `RATE_LIMITED`), and a socket that keeps flooding receives `rate_limited`
  and is disconnected. Frames above `SOCKET_MAX_PAYLOAD_BYTES` (512 KiB) close
  the connection. Typing is re-broadcast at most once per 3 s per user.

### Running several instances

Set `REDIS_URL` (Valkey 7/8 or Redis ≥ 6.2) and use PostgreSQL. Each instance
then uses:

| Concern | With `REDIS_URL` | Without |
| --- | --- | --- |
| Room fan-out | `@socket.io/redis-streams-adapter` (one stream, `ag:socket.io`) | in memory |
| Resume after a drop | session + missed events come from Redis, so it works across instances (e.g. after a deploy) | same instance only |
| Rate limits | token bucket in a Lua script, shared by all instances; falls back to per-instance buckets if Redis blips | per instance |
| Presence | per-user sorted set of live connections with TTL heartbeats; a crashed instance's users go offline after `PRESENCE_TTL_MS` | per instance |
| Once-per-cluster timers | event reminders and the presence/voice reaper take a short lease | — |

Streams rather than the pub/sub Redis adapter because only the streams
adapter supports connection-state recovery. An instance that loses Redis
reports 503 on `/api/ready` so the proxy stops routing to it.

**Sticky sessions.** Socket.IO's HTTP long-polling fallback sends each request
of one session separately and they must reach the same instance; WebSocket-only
clients would not care, but keep stickiness on. With Caddy use
`lb_policy cookie` (as in `Caddyfile.scale`); with nginx use `ip_hash` (or
`hash $cookie_… consistent`) in the `upstream` block, plus the usual
`Upgrade`/`Connection` headers.

**Compose.** The `scale` profile adds Valkey and a second app instance
(`app-2`, its own `WORKER_ID`) and `Caddyfile.scale` load-balances both with
sticky cookies and `/api/ready` health checks:

```bash
# .env
REDIS_URL=redis://valkey:6379
CADDYFILE=./Caddyfile.scale

docker compose --profile scale up -d
curl -s https://$DOMAIN/api/health | jq .realtime   # {"mode":"cluster","redis":"connected",…}
```

Rolling update: restart `app`, wait for `/api/ready`, then `app-2`. Clients on
the restarting instance get `server_draining`, reconnect to the other one and
resume without losing events.

Every instance needs a distinct `WORKER_ID` (0–31; snowflake ids embed it).
Valkey holds nothing durable (sockets, presence, buckets, a replay stream
trimmed to `SOCKET_STREAM_MAXLEN`), so it runs without persistence; restarting
it only forces clients to reconnect and catch up over REST.

Not shared between instances (by design, harmless): typing timers, the
soundboard cooldown and AFK speaking timestamps — each lives on the instance
that holds the user's socket.

### Hot-path caches and load shedding

Findings from `docs/PERFORMANCE.md`, and what now addresses them:

- **Permission cache** (`services/permCache.js`). Guild roles, overwrites,
  channels, owner and each member's roles/timeout are cached in memory. The
  database keeps a per-guild counter (`guild_perm_versions`, maintained by
  triggers from schema v34) that every check reads; a changed counter reloads
  the guild. A revoke is therefore honoured on the next check on *every*
  instance and for every code path, including manual SQL edits. A check costs
  one indexed lookup instead of five queries. `/api/health` → `realtime.permission_cache`
  shows hits and reloads.
- **Session cache** (`lib/auth.js`). With `SESSION_CACHE_TTL_MS` (30 s in
  production, off otherwise), resolved sessions are cached by token hash.
  Logout, revoke, password change and account deletion evict immediately, and
  with `REDIS_URL` on every instance (cluster bus). `last_seen_at` is written
  at most every `SESSION_TOUCH_INTERVAL_MS` (5 min).
- **Presence**. Going offline waits `PRESENCE_OFFLINE_GRACE_MS` (5 s), so a
  reconnect storm or a deploy produces no offline/online churn. Coming online
  when the stored status already says present writes and broadcasts nothing.
- **Admission control** for message writes (REST and socket):
  `MESSAGE_WRITE_CONCURRENCY` (32) in flight, `MESSAGE_WRITE_QUEUE` (256)
  waiting for at most `MESSAGE_WRITE_MAX_WAIT_MS` (5 s). Beyond that the send is
  refused with `503 RETRY_LATER` instead of queuing without bound.
  `/api/health` → `realtime.message_admission` shows the queue.
- **Thread pool**. `UV_THREADPOOL_SIZE` defaults to 16 (or 2× cores), set by
  `lib/threadpool.js` before anything uses the pool, so scrypt during a login
  storm no longer starves database queries. An explicit value wins.
- **Rate limits**, all overridable: `RATE_LIMIT_READ_PER_MIN` (600, GET/HEAD
  only), `RATE_LIMIT_MUTATE_PER_MIN` (max(600, write), other methods),
  `RATE_LIMIT_WRITE_PER_MIN` (60), `RATE_LIMIT_UPLOAD_PER_MIN` (30),
  `RATE_LIMIT_LOGIN_PER_5MIN` (10 per IP + username) and
  `RATE_LIMIT_LOGIN_IP_PER_5MIN` (60 per IP). Because the login limit is keyed
  on IP and username, an office or carrier NAT full of users is no longer
  locked out after ten attempts.
- **Batch re-join**. The `join_rooms {servers, channels}` socket event re-joins
  every room in one round trip after a non-recovered reconnect. Each room is
  still checked, and the check is served by the permission cache.
<!-- realtime-scale: end -->

---

## 9. Security checklist

- [ ] `STORAGE_URL_SECRET` and `ADMIN_TOKEN` freshly generated, not the examples
- [ ] `ALLOW_DEV_IDENTITY=0`
- [ ] `SECURE_COOKIES=1` and TLS terminating in front
- [ ] `TRUST_PROXY` equal to your real hop count
- [ ] `/metrics` not publicly reachable
- [ ] `CORS_ORIGIN` empty (same-origin) or an explicit list — never `*`
- [ ] Backups running, and a restore actually tested
- [ ] TURN relay running (or a deliberate decision to accept that some users cannot join voice)
- [ ] `.env` not committed; `600` permissions on the host

Already enforced in code: scrypt password hashing, session tokens stored only as
SHA-256, HttpOnly/SameSite cookies, per-route rate limits, upload magic-byte
sniffing (an HTML file renamed `.png` is rejected), path-traversal guards,
SSRF protection on link unfurling including link-local addresses, and a strict
CSP with `Content-Disposition: attachment` on user uploads.

---

## 10. Troubleshooting

**`Cannot GET /`** — `SERVE_STATIC` is on but `dist/` is missing, or another
process already owns the port. Run `npm run build`; check for a stale listener
(on Windows, note that a process bound to `::` and one bound to `0.0.0.0` can
both hold port 3001, and `localhost` resolves to IPv6 first).

**Realtime feels slow** — the WebSocket upgrade is not reaching the app. Confirm
the proxy passes `Upgrade`/`Connection` and that buffering is off on
`/socket.io/`.

**Every user shares one rate limit** — `TRUST_PROXY` is too low, so every request
appears to come from the proxy.

**Refusing to start** — read the list it prints; each line names the variable and
what to set. This is `lib/config.js` doing its job.

**Sign-up works, but every reload goes back to the login screen** — the session
cookie is `Secure` and the page is plain `http://` (not localhost), so the
browser drops it. The boot log shows a red CONFIGURATION PROBLEM box. Serve it
over HTTPS, or set `SECURE_COOKIES=0` for a LAN-only test.

**`docker compose up` says "set POSTGRES_PASSWORD in .env"** — intended: the
example file leaves it empty. `npm run secrets -- --write` fills it (keep it: it
is fixed into the database volume on the first start).

**Caddy: "address already in use" on 80/443** — something else (a NAS's own web
server) owns the ports. Use `HTTP_PORT`/`HTTPS_PORT` or the `no-proxy` profile:
[NAS (Synology / QNAP)](#2b-nas-synology--qnap).

**Requests hang when Redis/Valkey stalls** — they should not: every Redis
command times out after `REDIS_COMMAND_TIMEOUT_MS` (500 ms), after which rate
limits and presence use per-instance memory until Redis answers a PING again.
`/api/health` shows `redis.stalled: true` meanwhile.

**Uploads rejected at ~1 MB** — that is nginx's `client_max_body_size` default,
not the app.

**Voice: "Connecting…" forever / "Can't connect" for some users** — no TURN
relay, or its ports are closed. See [Voice and video: TURN](#4-voice-and-video-turn).
If *nobody* connects, check that `/socket.io/` WebSockets reach the app —
signalling rides on it.

**Voice: "Voice and video need HTTPS"** — the page was opened over plain http
from a non-localhost address.

**Voice: one person cannot be heard after they switch networks** — the client
restarts ICE automatically (up to three times). If it stays "Can't connect",
that pair has no route: TURN again.

**Thai search returns nothing** — on SQLite the FTS index needs the trigram
tokenizer. Migration v2 handles this; if the database predates it, run
`npm run search:reindex`. On PostgreSQL search reads `messages.content`
directly; check the extension exists (`\dx pg_trgm` in psql).

**PostgreSQL: `permission denied to create extension "pg_trgm"`** — the first
boot creates the schema, including `CREATE EXTENSION pg_trgm`. The role in
`DATABASE_URL` must own the database (pg_trgm is a trusted extension from
PostgreSQL 13), or have an administrator run `CREATE EXTENSION pg_trgm;` in that
database once beforehand.

**PostgreSQL: `remaining connection slots are reserved` / pool timeouts** —
`DB_POOL_MAX` × processes (app + any running scripts) exceeds the server's
`max_connections`. Lower the pool or raise the server limit; see
[Tuning](#tuning).

**PostgreSQL: `/api/health` returns 503 with `reachable: false`** — the
`database.error` field says why (DNS, TLS, authentication, timeout).

---

## 11. PostgreSQL

### When to use it

Use PostgreSQL for any deployment that matters: concurrent writes, online
backups with `pg_dump`, point-in-time recovery if your host offers it, and a
database you can inspect and tune while the app runs. SQLite remains the
zero-config default for development and small single-host installs; both
engines run the identical code, schema and test suite.

Supported: PostgreSQL **13 or newer** (tested on 16), including managed services
(RDS, Cloud SQL, Azure, Neon, Supabase, Crunchy). The only extension needed is
**pg_trgm** (message search), which all of them provide.

### Setting it up

Compose already does all of this ([§2](#2-quick-start-with-docker-compose)).
For your own server:

```sql
CREATE ROLE antigravity LOGIN PASSWORD 'change-me';
CREATE DATABASE antigravity OWNER antigravity ENCODING 'UTF8' TEMPLATE template0;
```

```bash
DATABASE_URL=postgres://antigravity:change-me@db.internal:5432/antigravity
DATABASE_SSL=verify-full            # for anything that crosses a network you do not own
# DATABASE_SSL_CA=/path/to/ca.pem   # private CA (RDS, Cloud SQL…)
```

Percent-encode special characters in the password inside the URL
(`@` → `%40`, `/` → `%2F`, `:` → `%3A`).

On first boot the app creates the whole schema (`db/schema.pg.sql`, schema v17)
in one transaction and records it in `schema_migrations`. Later versions are
applied by numbered migrations, each in its own transaction, at startup. Boot
holds a Postgres advisory lock while it migrates, so several processes starting
at once (a rolling deploy, a script run during a restart) apply each migration
exactly once. The app refuses to start against a database with application
tables but no `schema_migrations`, or with a newer schema than it knows.

### Moving an existing SQLite deployment to PostgreSQL

The copy tool reads the SQLite file (never writes to it), creates the schema in
an **empty** Postgres database, copies every table in one transaction
preserving all ids, converts timestamps and JSON, checks every table's row
count, and commits only if everything matches. On any error nothing is written
and it tells you the table, row and column.

1. **Update the code first** and start it once on SQLite, so the SQLite file
   is at the current schema version (the tool refuses an older file).
2. **Create the empty Postgres database** (above) and verify you can connect:
   `psql "$DATABASE_URL" -c 'select 1'`.
3. **Rehearse** while the old server is still running (read-only, harmless):
   ```bash
   npm run db:migrate-to-pg -- --from ./discord.db --to "$DATABASE_URL" --dry-run
   ```
   This does the entire copy and verification, then rolls back.
4. **Stop the app** (`docker compose stop app` / `systemctl stop antigravity`)
   so no new writes land in SQLite, and take a SQLite backup
   (`npm run backup`).
5. **Copy for real:**
   ```bash
   npm run db:migrate-to-pg -- --from ./discord.db --to "$DATABASE_URL"
   ```
   Re-running against a database that now has rows is refused; `--force`
   truncates the target and copies again. `--drop-orphans` leaves behind rows
   that already violate a foreign key in SQLite (the tool lists them first).
6. **Point the app at Postgres** — set `DATABASE_URL` in `.env` — and start it.
   Check `/api/health` shows `"driver": "postgres"`, sign in, open a channel,
   search for something.
7. Keep the SQLite file and its backup until you are satisfied; rolling back is
   unsetting `DATABASE_URL` (anything written to Postgres meanwhile would be
   left behind).

In Docker: copy the file out of the old volume and run the tool from the app
image against the compose network, for example
`docker compose run --rm -v "$PWD/discord.db:/tmp/discord.db:ro" app
node scripts/migrate-sqlite-to-postgres.mjs --from /tmp/discord.db --to "$DATABASE_URL"`.

Uploaded files do not move: they stay under `STORAGE_ROOT` (or in S3), and the
copied `files` rows keep pointing at them.

### Backups with pg_dump

```bash
npm run backup                  # pg_dump --format=custom → backups/discord-<stamp>.dump (+ files)
npm run backup:verify backups/discord-<stamp>.dump
npm run backup:restore backups/discord-<stamp>.dump -- --force   # app stopped
```

`pg_dump` takes a consistent snapshot without blocking the app. Restore runs
`pg_restore --clean --single-transaction`, so a failed restore changes nothing.
The PostgreSQL client tools must be the server's major version or newer (point
`PG_DUMP` / `PG_RESTORE` at them if several are installed). Credentials are
passed through `PG*` environment variables, never on the command line.

In compose the dump is easiest from the database container, which always has
matching tools:

```bash
docker compose exec -T postgres pg_dump -U antigravity -d antigravity --format=custom \
  > backups/discord-$(date +%Y%m%d-%H%M%S).dump
```

For anything beyond a small community, also turn on continuous WAL archiving /
point-in-time recovery (managed services do this for you; self-hosted, use
pgBackRest or WAL-G). A nightly dump alone can lose up to a day.

### Tuning

- **Connections.** Each app process opens up to `DB_POOL_MAX` (default 10).
  Keep `DB_POOL_MAX × processes + maintenance scripts` well under
  `max_connections`. 10 is plenty for one process: queries are short, and a
  larger pool mostly adds contention. Use PgBouncer only in **session** mode —
  transaction pooling breaks the per-connection settings and advisory lock the
  app relies on.
- **Timeouts** (per connection, set by the app): `DB_STATEMENT_TIMEOUT_MS`
  (30 s), `DB_LOCK_TIMEOUT_MS` (10 s), `DB_IDLE_IN_TX_TIMEOUT_MS` (60 s).
  A request that hits one gets a 503 with code `TIMEOUT`/`BUSY`, never a hang.
- **Isolation.** Transactions run at `SERIALIZABLE` (`DB_TX_ISOLATION`) and are
  retried automatically (`DB_TX_RETRIES`, default 8, exponential backoff) on
  serialization failures and deadlocks. The code was written for SQLite, where
  transactions never overlap; serializable isolation keeps every
  check-then-write inside a transaction correct without auditing each one for
  races. Sending a message — the hot path — runs `READ COMMITTED` because it
  only makes atomic updates. Lowering the global level is not recommended.
- **Memory.** Start from `shared_buffers` ≈ 25% of RAM,
  `effective_cache_size` ≈ 50–75%, `work_mem` 8–16 MB,
  `maintenance_work_mem` 128–512 MB. The compose file sets values for a 1 GB
  VM.
- **Search index.** `idx_messages_content_trgm` (GIN, pg_trgm) is the largest
  index — roughly the size of the message text again. It serves
  `ILIKE '%term%'` for terms of three or more characters; one- and
  two-character terms (common in Thai) scan the channel/server-filtered rows.
  Autovacuum keeps it current; after a bulk import run `ANALYZE messages` (the
  migration tool does this).
- **Observe.** `log_min_duration_statement=1000` (set in compose) logs slow
  queries; `pg_stat_statements` shows where time goes.

### Behaviour notes

- Ids are text snowflakes (19 digits) compared byte-wise (`COLLATE "C"`), so
  ordering is identical to SQLite. All text columns use `"C"` collation for the
  same reason: sort order and uniqueness match SQLite exactly (name ordering is
  by code point, not language-aware).
- Timestamps are `timestamptz(3)` and are returned as
  `YYYY-MM-DDTHH:MM:SS.sssZ` — the same string SQLite stored.
- JSON columns are `jsonb`: invalid JSON is rejected on write, and object keys
  come back in Postgres' canonical order rather than insertion order.
- Search is case-insensitive (`ILIKE`) and, like SQLite, folds ASCII letters
  only; Thai and other scripts match exactly, as substrings.
- Rate limits, presence, typing state and Socket.IO rooms stay in process
  memory; they do not move into Postgres (see [Scaling](#8-scaling)).

## 12. Passkeys and message translation

Both are optional and off unless configured; `GET /api/passkeys/config` and
`GET /api/translate/config` report what is active.

### Passkeys (WebAuthn)

Set `PUBLIC_URL` (or `RP_ID` + `RP_ORIGIN`) and passkeys turn on:

| Variable | Default | Meaning |
|---|---|---|
| `PASSKEYS_ENABLED` | on when `RP_ID`/`PUBLIC_URL` is set | `0` forces off |
| `RP_ID` | host of `PUBLIC_URL` | domain passkeys are bound to. **Changing it orphans every passkey.** |
| `RP_ORIGIN` | origin of `PUBLIC_URL` | comma-separated list of page origins allowed to run a ceremony |
| `RP_NAME` | `Antigravity Discord` | name shown by the browser |

Behaviour:

- Discoverable credentials, attestation `none`, user verification
  `preferred`. A **sign-in** is only accepted when the authenticator verified
  the user (biometric/PIN); such a sign-in skips both the password and TOTP.
- Challenges are single-use rows in `webauthn_challenges`, valid 5 minutes.
- Adding or removing a passkey needs a re-authentication (password + TOTP, or
  a passkey) from the same session within the last 5 minutes.
- Sign-in counters, backup-eligible/backed-up flags and last-used times are
  stored; `GET /api/passkeys/events` is the account's audit trail.
- WebAuthn needs a secure context: HTTPS, or `http://localhost` in development.
  With the Vite dev server set `RP_ID=localhost` and
  `RP_ORIGIN=http://localhost:5173`.

### Message translation

The client first uses the browser's on-device Translator API (Chrome), which
needs no server at all. Otherwise `POST /api/translate {messageId, targetLang}`
translates the *stored* text of a message the caller can read — never arbitrary
text — trying, in order, the providers that are configured:

1. **LibreTranslate** (self-hosted, recommended): `docker compose --profile
   translate up -d`, then `LIBRETRANSLATE_URL=http://libretranslate:5000` in
   `.env`. `LT_LOAD_ONLY` picks the languages (default
   `en,th,ja,zh,zt,ko,es,fr,de,pt,ru,vi,id`); models download on first start
   into the `lt-models` volume. Set `LT_API_KEYS=true` plus
   `LIBRETRANSLATE_API_KEY` to require a key.
2. **DeepL**: `DEEPL_API_KEY` (free-plan keys ending `:fx` are detected).
3. **Claude**: `ANTHROPIC_API_KEY`; model `TRANSLATION_ANTHROPIC_MODEL`
   (default `claude-haiku-4-5-20251001`). Message text is sent to Anthropic —
   only enable it if your privacy policy allows.

`TRANSLATION_PROVIDERS` reorders or narrows the list;
`TRANSLATION_SERVER_ENABLED=0` disables the endpoint; a server owner can turn
server-side translation off for one guild (`PUT
/api/servers/:id/translation {disabled:true}`, MANAGE_GUILD).

Mentions, channels, emoji, timestamps, code, URLs and Markdown markers are
replaced by placeholders before text reaches a provider and restored after.
Results are cached in `translation_cache` per (message, content hash, target
language) for `TRANSLATION_CACHE_TTL_HOURS` (default 168); editing a message
changes the hash, so an old translation is never served. Provider calls are
rate limited per user (`TRANSLATION_RATE_PER_MIN`, default 20). Message
content is never written to logs.

## 13. Installable app (PWA) and Web Push

The SPA is an installable Progressive Web App out of the box: `vite build`
emits `manifest.webmanifest`, the icon set (`public/icons/`, regenerate with
`node scripts/generate-pwa-icons.mjs` after changing `favicon.svg`),
`offline.html`, and `sw.js` stamped with the build id and the hashed app-shell
files to precache. Serve `/sw.js` with `Cache-Control: no-cache` (the built-in
static server does; so must any CDN or reverse proxy in front of it) or clients
will not see new versions. After a deploy, open tabs show "A new version is
available — Reload"; nothing is swapped under a user mid-conversation. The
worker never caches `/api`, `/socket.io` or `/uploads`.

Web Push is optional. It needs HTTPS (a secure context) and a VAPID key pair:

```bash
npm run push:keys -- --subject mailto:ops@example.com   # prints the three lines for .env
```

| Variable | Default | Meaning |
|---|---|---|
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | unset (push off) | all three required; the subject is `mailto:` or `https://` |
| `PUSH_ENDPOINT_HOSTS` | FCM, Mozilla, Apple, WNS | host suffixes the server may POST to; keep it to real push services |
| `PUSH_USER_LIMIT_PER_MIN` | 30 | per-user push budget; the per-channel Topic collapses the rest |
| `PUSH_TTL_SECONDS` | 14400 | how long a push service holds an undelivered push |

`GET /api/push/config` reports `{ enabled, public_key }`. Outbound HTTPS from
the server to the push services must be allowed.

Behaviour: a subscription belongs to the session (device login) that created
it and is deleted on logout, session revoke and "log out everywhere". Pushes go
out for DMs, mentions, keyword highlights and — at a channel/server level of
"All messages" — every message, following each member's notification settings
(`/api/notification-settings`), and never while the user has the app focused on
another device. The payload is Declarative Web Push JSON (Safari 18.4+ shows it
without running the worker); each user chooses whether pushes show the message,
only the sender, or nothing private. Subscriptions the push service reports as
gone (404/410) are deleted. On iPhone/iPad, push works only after "Add to Home
Screen" (iOS 16.4+); the app explains this instead of offering a prompt that
cannot work.

---

## 14. Observability

Everything in this section is **optional and off by default**: with none of
the variables below set, the app behaves exactly as before (JSON logs on
stdout, `/metrics`, health endpoints). Each piece switches on independently.

### Logs

Structured JSON (pino) in production, a readable one-line format in
development (`LOG_FORMAT=json|pretty`, `LOG_LEVEL=trace|debug|info|warn|error|fatal|silent`).
Every line written while handling a request or a socket event carries that
request's `request_id` (and `trace_id`/`span_id` when tracing is on). Keys such
as `password`, `token`, `authorization`, `cookie`, `email`, `content` are
replaced with `[REDACTED]` at any depth, and strings are scrubbed for e-mail
addresses, bearer tokens, credentials in URLs and token query parameters. IP
addresses and user ids are kept (security investigation needs them): set a log
retention that matches your privacy notice.

### Metrics

`/metrics` (behind `METRICS_TOKEN` in production) now combines the original
`app_*` series with prom-client's. Useful ones:

| Metric | Type | Labels |
| --- | --- | --- |
| `app_http_request_duration_seconds` | histogram | `method`, `route` (template, e.g. `/api/channels/:channelId/messages`), `status_code` |
| `app_db_query_duration_seconds`, `app_db_query_errors_total` | histogram, counter | `driver`, `operation` (run/get/all/exec/transaction) |
| `app_db_pool_connections` | gauge | `state` = total/idle/waiting/max (PostgreSQL) |
| `app_socket_connections`, `app_socket_events_total` | gauge, counter | `event` |
| `app_messages_sent_total` | counter | — |
| `app_voice_participants` | gauge | — |
| `app_push_sends_total` | counter | `channel`, `result` |
| `app_disk_free_bytes`, `app_disk_total_bytes` | gauge | `volume` = storage/database |
| `app_web_vitals_{lcp,inp,fcp,ttfb}_seconds`, `app_web_vitals_cls` | histogram | `rating` |
| `nodejs_eventloop_lag_seconds`, `process_*`, `nodejs_*` | prom-client defaults | — |

### Tracing (OpenTelemetry)

Set `OTEL_EXPORTER_OTLP_ENDPOINT` (OTLP/HTTP, e.g. `http://lgtm:4318`) and start
Node with the preload — the Docker image always does:

```bash
NODE_OPTIONS="--import ./lib/otel-preload.mjs" npm start
```

You get HTTP server spans, Express route spans and `pg` query spans
(auto-instrumented), one span per database adapter call on both SQLite and
PostgreSQL (statement text with literals stripped, **never** parameters), one
span per inbound Socket.IO event, the metrics above pushed over OTLP (same
series names after Prometheus' OTLP translation, so the dashboard works either
way), and the logs as OTLP log records correlated with their traces
(`OTEL_LOGS_EXPORTER=none` keeps logs on stdout only). All standard `OTEL_*`
variables apply; in production sample, e.g.
`OTEL_TRACES_SAMPLER=parentbased_traceidratio` with `OTEL_TRACES_SAMPLER_ARG=0.1`.
Without the endpoint the SDK is not loaded at all (a test asserts this).
Without the preload (plain `npm start` with the endpoint set) database/socket
spans and metrics still work; HTTP/Express/pg auto-instrumentation does not,
and the log says so.

### Error tracking (Sentry protocol — GlitchTip or Sentry)

- `SENTRY_DSN` — server: 5xx errors, uncaught exceptions and unhandled
  rejections, tagged with `request_id`, route and a pseudonymous user id.
  Request headers, cookies, bodies, e-mails and IPs are removed before sending.
- `SENTRY_BROWSER_DSN` — browser: `@sentry/browser` is downloaded **only**
  when this is set (a lazily loaded chunk), errors only (no replay, no
  tracing), PII scrubbed in the browser and again on the server, which
  tunnels the reports (`POST /api/telemetry/errors`), so the CSP needs no
  change. Envelopes for any other DSN are refused.
- Release = `APP_RELEASE` (the image sets it to the git sha).

Self-hosting [GlitchTip](https://glitchtip.com) (Sentry-compatible, much
lighter than self-hosted Sentry) takes a Postgres, a Redis/Valkey and two
containers; create one project for the server and one for the browser and
paste their DSNs.

### Web Vitals

For `WEB_VITALS_SAMPLE_RATE` of page loads (default 0.25) the client sends LCP,
INP, CLS, FCP and TTFB as one `sendBeacon` to `POST /api/telemetry/vitals` when
the page is hidden. Only name, value and rating are accepted (no URL, user
agent or user id); the endpoint validates ranges, caps the payload at 4 KB and
is rate-limited per IP (`RATE_LIMIT_VITALS_PER_MIN`, default 30). Turn it off
with `WEB_VITALS_ENABLED=0`.

### The bundled stack: compose `observability` profile

```bash
# .env
OTEL_EXPORTER_OTLP_ENDPOINT=http://lgtm:4318
GRAFANA_ADMIN_PASSWORD=<openssl rand -base64 24>

docker compose --profile observability up -d
ssh -L 3000:127.0.0.1:3000 you@host      # then open http://localhost:3000
```

`grafana/otel-lgtm` runs Grafana, Prometheus, Tempo, Loki and an OpenTelemetry
Collector in one container, pre-provisioned with the **Antigravity Discord —
Overview** dashboard (`ops/grafana/dashboards/`) and alert rules
(`ops/alerts/grafana-alerting.yml`). Grafana is bound to `127.0.0.1` and has
anonymous access disabled; the OTLP ports are not published. Add a contact
point (Alerting → Contact points) so alerts reach someone. It is sized for one
small node; for longer retention or several hosts send OTLP to a managed or
dedicated backend instead — only the endpoint changes.

Already run Prometheus? Scrape `/metrics` with the bearer token and load
`ops/alerts/antigravity.rules.yml` (`promtool check rules` passes); import the
dashboard JSON into your Grafana. Panels marked "scrape only" use series that
only the scrape provides (process CPU/memory, event-loop p99, in-flight
queries).

### Alerts and runbooks

| Alert | Fires when | Runbook |
| --- | --- | --- |
| AntigravityDown | no telemetry for 5 min | `ops/runbooks/db-down.md` |
| AntigravityHighErrorRate | > 5% 5xx for 10 min | `ops/runbooks/high-latency.md` |
| AntigravityHighLatency | p95 > 1 s for 10 min | `ops/runbooks/high-latency.md` |
| AntigravityDatabaseErrors | > 0.5 failed DB calls/s | `ops/runbooks/db-down.md` |
| AntigravityEventLoopLag / SlowQueries / DbPoolSaturated | loop > 200 ms, DB p95 > 250 ms, pool queueing | `ops/runbooks/high-latency.md` |
| AntigravityDiskLow / DiskCritical | < 10% / < 3% free | `ops/runbooks/disk-full.md` |
| AntigravitySocketsDropped | sockets halve in 10 min | `ops/runbooks/turn-livekit.md` |

Also in `ops/runbooks/`: restoring from backup, and the **PDPA 72-hour breach
notification** checklist.

### Container hardening

The image is `gcr.io/distroless/nodejs24-debian13:nonroot`: no shell, no
package manager, non-root (uid 1000), `tini` as PID 1, production
`node_modules` only (client packages are devDependencies, pruned after the
build), a `HEALTHCHECK` on `/api/live`,
OCI labels (`org.opencontainers.image.revision` = git sha). It runs with a
read-only root filesystem — the app writes only to `/data` and `/backups`:

```yaml
  app:
    read_only: true
    tmpfs: [/tmp]
    cap_drop: [ALL]
    security_opt: ["no-new-privileges:true"]
```

Optional ffmpeg for the media pipeline: `docker build --build-arg WITH_FFMPEG=1 .`
(static binaries, see [Media pipeline](#7a-media-pipeline)). The image has no
`pg_dump`; back up PostgreSQL from the `postgres` container (see
[Backups](#backups)).

There is no shell, so debug with `docker compose exec app node -e "…"` or
`docker debug` rather than `sh`. CI publishes an SPDX SBOM for every build,
scans the image (grype; fails on fixable critical CVEs and prints the findings
as a table in the job log and summary) and, when the
`REGISTRY_IMAGE` repository variable is set, pushes on `main` and signs the
image keylessly with cosign. Verify before deploying:

```bash
cosign verify <registry>/<image>@<digest> \
  --certificate-identity-regexp '^https://github.com/<owner>/<repo>/' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

---

## 15. Upgrading

### To this release (Node 24, distroless image)

- **Runtime is Node.js 24 LTS.** CI tests on Node 22 and 24; outside Docker
  either works (`engines` still allows >= 20.17, but test on 22+). The full test
  suite passes on Node 24.21 with the same prebuilt `sqlite3` 6.x and `sharp`
  binaries (both are N-API, so no rebuild is needed when switching majors).
- **Base images:** build `node:24-trixie-slim`, run
  `gcr.io/distroless/nodejs24-debian13:nonroot`. Both are Debian 13 (glibc
  2.41), which the `sqlite3` 6.x prebuilt binaries require (≥ 2.38; bookworm
  had 2.36). If the prebuilt does not load, the build compiles it from source.
- **Volume ownership is unchanged:** the process still runs as uid 1000
  (the old image's `node` user), so existing volumes need nothing. If you run
  with a different `user:`, `chown -R` the `app-data` and `app-backups`
  volumes to it first.

- **No shell in the container:** scripts that ran `docker compose exec app sh -c …`
  must call `node` directly (`docker compose exec app node scripts/backup.mjs …`).
  With PostgreSQL, run `pg_dump` in the `postgres` container (see [Backups](#backups)).
- **Logs** are pino JSON: the same `request_id`, `level`, `time` fields, with
  `msg` instead of free text and HTTP access fields nested under `http`.
  Adjust log queries that matched the old emoji-prefixed messages.
- `/api/ready` now also fails on critically low disk (`READY_DISK_MIN_FREE_MB`)
  and, if `REDIS_URL` is set, on Redis. `/api/health` and `/metrics` are
  backward compatible.

- **This polish release:** client-only packages moved to `devDependencies`.
  Bare-metal installs that ran `npm ci --omit=dev` *and then* `npm run build`
  must build first (or build in CI) — the runtime needs nothing from them. The
  `.env.example` now leaves `POSTGRES_PASSWORD` empty and `LOG_LEVEL` unset;
  an existing `.env` is unaffected. `TRUST_PROXY` in compose now honours `.env`
  (default still `1`).

### Any release

1. Read the release notes for schema changes; **back up first** (migrations are forward-only).
2. `git pull && docker compose up -d --build` (or pull the signed image by digest).
3. Watch `/api/ready` and the dashboard's 5xx/latency panels for 15 minutes.
4. Roll back by redeploying the previous image; restore the backup only if a
   migration ran and the old code cannot read the new schema
   (`ops/runbooks/restore-from-backup.md`).

---

## 16. Environment reference

Generated from `.env.example` (sections and comments) by
`node scripts/ops/env-check.mjs --write`; CI (`npm run env:check`) fails when a
variable the code reads is missing from `.env.example` or this table is stale.
"Example / default" is the value `.env.example` shows (a commented-out line is
an example, not a default).

<!-- env-reference:start -->
<!-- Generated from .env.example by `node scripts/ops/env-check.mjs --write`. Edit .env.example, not this table. -->


**runtime**

| Variable | Example / default | Notes |
| --- | --- | --- |
| `NODE_ENV` | `development` |  |
| `PORT` | `3001` | ↑ same group as above |
| `HOST` | `0.0.0.0` | ↑ same group as above |
| `PUBLIC_URL` | `http://localhost:5173` | Absolute, externally visible URL. Used in invite links, e-mails and the CSP. Production: your real https:// origin. |
| `TRUST_PROXY` | `loopback` | How many reverse proxies sit in front of this process. Behind exactly one (nginx, Caddy, a cloud load balancer) use 1. Trusting more hops than you actually have lets a client forge its own IP and escape rate limiting. 'loopback' is the development default; production defaults to 1. Compose `no-proxy` profile behind a NAS reverse proxy: 2. |
| `CORS_ORIGIN` | `http://localhost:5173` | Comma-separated allow-list. Leave EMPTY in production when this process also serves the SPA — the client is then same-origin and needs no CORS at all. '*' is refused in production. |

**serving the built client**

| Variable | Example / default | Notes |
| --- | --- | --- |
| `SERVE_STATIC` | `0` | On in production: one process, one port, no separate web server. In development the Vite dev server handles this instead. |
| `STATIC_DIR` | `dist` | ↑ same group as above |

**database**

| Variable | Example / default | Notes |
| --- | --- | --- |
| `DB_PATH` | `./discord.db` | Two engines, one code path: * DATABASE_URL unset → SQLite file at DB_PATH (zero-config, one process, fine for small communities) * DATABASE_URL=postgres://… → PostgreSQL 13+ (recommended for production: concurrent writers, pg_dump backups, several app instances if you add a shared socket adapter — see DEPLOYMENT.md) The schema is created and migrated automatically on boot either way. Moving an existing SQLite database over: npm run db:migrate-to-pg. |
| `DATABASE_URL` | `postgres://antigravity:change-me@localhost:5432/antigravity` | ↑ same group as above |
| `DATABASE_SSL` | `verify-full` | TLS to the database. disable \| require (encrypt, don't verify) \| verify-full (encrypt and verify; add DATABASE_SSL_CA for a private CA). An ?sslmode= in DATABASE_URL works too; this variable wins when both are set. |
| `DATABASE_SSL_CA` | `/etc/ssl/certs/rds-ca.pem` | ↑ same group as above |
| `DB_POOL_MAX` | `10` | Connection pool, per app process. Keep DB_POOL_MAX × instances below the server's max_connections (minus superuser_reserved_connections). |
| `DB_POOL_MIN` | `0` | ↑ same group as above |
| `DB_POOL_IDLE_MS` | `30000` | ↑ same group as above |
| `DB_CONNECT_TIMEOUT_MS` | `10000` | ↑ same group as above |
| `DB_STATEMENT_TIMEOUT_MS` | `30000` | Server-side limits applied to every connection (milliseconds). |
| `DB_LOCK_TIMEOUT_MS` | `10000` | ↑ same group as above |
| `DB_IDLE_IN_TX_TIMEOUT_MS` | `60000` | ↑ same group as above |
| `DB_TX_ISOLATION` | `serializable` | Transactions run SERIALIZABLE and are retried on serialization failures / deadlocks this many times. Leave the isolation alone unless you know why. |
| `DB_TX_RETRIES` | `8` | ↑ same group as above |
| `DB_APPLICATION_NAME` | `antigravity-discord` | ↑ same group as above |
| `SQL_DEBUG` | `1 (SQLite only: verbose driver stack traces)` |  |

**file storage**

| Variable | Example / default | Notes |
| --- | --- | --- |
| `STORAGE_ROOT` | `./public/uploads` |  |
| `STORAGE_PUBLIC_BASE` | `/uploads` | ↑ same group as above |
| `STORAGE_URL_SECRET` | `dev-insecure-storage-secret` | Signs private-file URLs. MUST be replaced in production — with the value below, anyone who has read this repository can forge a link to any file. openssl rand -base64 32 |
| `ADMIN_TOKEN` |  | Required to enable /api/files/maintenance/* (GC, integrity check) and report triage. Generate the same way as above. |

**authentication**

| Variable | Example / default | Notes |
| --- | --- | --- |
| `ALLOW_DEV_IDENTITY` | `1` | The x-user-id shortcut: any request can claim to be any user. Development only — production refuses to start unless this is 0. |
| `SECURE_COOKIES` | `0` | Adds the Secure flag to session cookies. Default: on in production. Browsers DROP Secure cookies on plain http:// (except localhost), so with this on, opening the server as http://192.168.x.x signs everyone straight back out (the server prints a red CONFIGURATION PROBLEM box at boot when PUBLIC_URL is http:// and not localhost). Testing on a LAN without TLS: SECURE_COOKIES=0 and PUBLIC_URL=http://<lan-ip>:3001. Never run it that way on the internet. |
| `SESSION_TTL_DAYS` | `30` | Session lifetime (absolute, from sign-in) and idle limit, in days. |
| `SESSION_IDLE_DAYS` | `14` | ↑ same group as above |

**mail (password reset, e-mail verification)**

| Variable | Example / default | Notes |
| --- | --- | --- |
| `MAIL_TRANSPORT` | `console` | console (default, logs only) \| file \| smtp Production with `console` (or unset): password reset and e-mail verification are switched off (503 MAIL_NOT_CONFIGURED) — configure SMTP to enable them. Reset/verification tokens are only ever echoed in API responses in development with the console transport. |
| `MAIL_FROM` | `Antigravity Discord <no-reply@antigravity.local>` | ↑ same group as above |
| `MAIL_FILE` | `mail.log` | ↑ same group as above |
| `SMTP_HOST` | `smtp.example.com` | ↑ same group as above |
| `SMTP_PORT` | `587` | ↑ same group as above |
| `SMTP_USER` |  | ↑ same group as above |
| `SMTP_PASS` |  | ↑ same group as above |
| `SMTP_EHLO` | `chat.example.com` | Name sent in EHLO (some relays reject "localhost"). |

**object storage**

| Variable | Example / default | Notes |
| --- | --- | --- |
| `S3_ENDPOINT` | `https://<account>.r2.cloudflarestorage.com` | Leave unset to keep files on local disk. Any S3-compatible endpoint works (AWS S3, Cloudflare R2, Backblaze B2, MinIO) — the signer is SigV4. |
| `S3_BUCKET` | `antigravity-media` | ↑ same group as above |
| `S3_REGION` | `auto` | ↑ same group as above |
| `S3_ACCESS_KEY_ID` |  | ↑ same group as above |
| `S3_SECRET_ACCESS_KEY` |  | ↑ same group as above |
| `S3_SESSION_TOKEN` |  | Temporary credentials (STS) only. |
| `S3_FORCE_PATH_STYLE` | `1` | ↑ same group as above |
| `S3_DIRECT_UPLOAD` | `post` | Browser → bucket uploads (POST /api/media/uploads). post = presigned POST policy (S3, MinIO, B2); put = presigned PUT (Cloudflare R2 has no POST Object — picked automatically for *.r2.cloudflarestorage.com); off = disabled. The bucket needs CORS allowing POST/PUT from your origin, and the CSP connect-src must allow the bucket origin (see DEPLOYMENT.md §7). |
| `STORAGE_PUBLIC_BASE` | `https://cdn.example.com` | Serve public objects straight from a CDN / public bucket URL. Unset, public files are redirected to short-lived presigned URLs via /uploads/<key>. |

**media pipeline**

| Variable | Example / default | Notes |
| --- | --- | --- |
| `MEDIA_WIDTHS` | `160,480,960,1920` | Images: EXIF/GPS stripped, WebP renditions at MEDIA_WIDTHS, AVIF in the background (effort 2: ~1.4 s for a 1920px rendition on one core; sharp's default effort 4 is ~9 s). Videos: poster + probe via system ffmpeg. |
| `MEDIA_AVIF` | `1` | ↑ same group as above |
| `MEDIA_AVIF_EFFORT` | `2` | ↑ same group as above |
| `MEDIA_AVIF_QUALITY` | `50` | ↑ same group as above |
| `MEDIA_WEBP_QUALITY` | `78` | ↑ same group as above |
| `MEDIA_MAX_PIXELS` | `100000000` | Decompression-bomb limits, checked from the header before any decode. |
| `MEDIA_MAX_DIMENSION` | `16384` | ↑ same group as above |
| `MEDIA_MAX_ANIMATED_PIXELS` | `200000000` | ↑ same group as above |
| `MEDIA_SYNC_BUDGET_MS` | `0` | How long a multipart upload waits for its renditions before answering 'processing' (0 = answer at once; dimensions + thumbhash are always included). |
| `MEDIA_JOB_CONCURRENCY` | `2` | Background jobs processed at once by this process. |
| `MEDIA_FFMPEG` | `1` | ffmpeg/ffprobe for video posters, dimensions and duration (optional). |
| `FFMPEG_PATH` | `/usr/bin/ffmpeg` | ↑ same group as above |
| `FFPROBE_PATH` | `/usr/bin/ffprobe` | ↑ same group as above |
| `STORAGE_QUOTA_BYTES` |  | Per-user storage quota in bytes for everyone (0 = unlimited). Unset, the per-user users.storage_quota column (default 5 GiB) applies. |

**voice**

| Variable | Example / default | Notes |
| --- | --- | --- |
| `VOICE_MESH_LIMIT` | `8` | Full-mesh participant cap. Beyond this an SFU is required: every extra peer costs each participant another upstream, so the mesh stops scaling. |

**internationalisation**

| Variable | Example / default | Notes |
| --- | --- | --- |
| `DEFAULT_LOCALE` | `en` | The client picks the UI language from the visitor's browser languages and remembers an explicit choice; it falls back to English. 32 locales ship (Discord's set: en-US, en-GB, th, ja, zh-CN, zh-TW, ko, de, fr, es-ES, es-419, pt-BR, …; full list in src/i18n/locales/_registry.js). DEFAULT_LOCALE is read by lib/config.js but not yet used by the client. |

**observability**

| Variable | Example / default | Notes |
| --- | --- | --- |
| `LOG_FORMAT` | `pretty` | pretty (human, development) \| json (one object per line, for a log aggregator). Default: json in production, pretty otherwise. Compose forces json. |
| `LOG_LEVEL` | `info` | error \| warn \| info \| debug. Default: info in production, debug otherwise — left unset here so a copied .env does not put production on debug. |
| `ENABLE_METRICS` | `1` | Prometheus text exposition at /metrics, behind `Authorization: Bearer <token>`. In production the endpoint exists only when METRICS_TOKEN is set; in development it is open when no token is set. |
| `METRICS_TOKEN` |  | ↑ same group as above |

**images**

| Variable | Example / default | Notes |
| --- | --- | --- |
| `CSP_IMG_SOURCES` | `https://cdn.example.com` | Remote images (avatars, icons, link previews) are served through the same-origin proxy /api/media/proxy?url=…, and the CSP allows images from 'self' only. Add origins here if you serve uploads from a CDN that is not STORAGE_PUBLIC_BASE (comma-separated). |
| `MEDIA_PROXY_MAX_BYTES` | `8388608` | ↑ same group as above |
| `MEDIA_PROXY_CACHE_BYTES` | `67108864` | ↑ same group as above |
| `SHUTDOWN_TIMEOUT_MS` | `15000` | How long SIGTERM waits for in-flight requests before forcing exit. |

**static client (SERVE_STATIC=1)**

| Variable | Example / default | Notes |
| --- | --- | --- |
| `STATIC_COMPRESS` | `1` | JS/CSS/HTML/SVG are compressed (brotli, else gzip) once per build and kept in memory, for installs without a compressing proxy in front. 0 = off. |
| `STATIC_COMPRESS_CACHE_BYTES` | `33554432` | ↑ same group as above |

**docker compose**

| Variable | Example / default | Notes |
| --- | --- | --- |
| `DOMAIN` | `mychat.synology.me (DSM › External Access › DDNS).` | Domain Caddy requests a certificate for. Use `localhost` for a local self-signed cert instead of a public ACME one. Dynamic DNS works too, e.g. |
| `DOMAIN` | `localhost` | ↑ same group as above |
| `POSTGRES_PASSWORD` |  | REQUIRED for docker compose — deliberately empty, so `docker compose up` refuses to start until you set one ("set POSTGRES_PASSWORD in .env"). URL-safe characters only (it is spliced into DATABASE_URL): `npm run secrets` prints one. Baked into the database volume on the very first start. To stay on SQLite under compose instead, set DATABASE_URL= (empty). |
| `HTTP_PORT` | `80` | Host ports Caddy publishes. Change them when something else already owns 80/443 (a Synology/QNAP NAS) and forward the router's 80/443 to these. |
| `HTTPS_PORT` | `443` | ↑ same group as above |
| `APP_BIND` | `127.0.0.1` | `no-proxy` profile (docker compose --profile no-proxy up -d app-direct): the app on plain HTTP at APP_BIND:APP_PORT, no Caddy. 127.0.0.1 = reachable only by a reverse proxy on the same host (DSM); 0.0.0.0 = the whole LAN. |
| `APP_PORT` | `3001` | ↑ same group as above |

**seed data**

| Variable | Example / default | Notes |
| --- | --- | --- |
| `SEED_DATABASE` | `0` | Development databases are seeded with demo accounts that all share the password in db/seed.js. Production never seeds unless this is set to 1 — leave it unset there, or anyone can sign in as the seeded server owner. `npm run seed` (node db/seed.js) follows the same rule: refused in production unless SEED_DATABASE=1, and a no-op on a database that already has users. |

**voice / video (WebRTC)**

| Variable | Example / default | Notes |
| --- | --- | --- |
| `STUN_URLS` | `stun:stun.l.google.com:19302` | Served to signed-in clients by GET /api/voice/ice-servers. STUN servers, comma-separated. Unset = Google's public STUN, which means every caller's IP address is sent to Google. With the compose `turn` profile, coturn answers STUN too: STUN_URLS=stun:chat.example.com:3478 |
| `TURN_URLS` | `turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp` | TURN relay (coturn with use-auth-secret / static-auth-secret). When both are set, each client gets short-lived REST credentials derived from the secret; the secret itself never leaves the server. The compose coturn has no TLS certificate, so list turn: (UDP and TCP) only, not turns:. |
| `TURN_SECRET` |  | ↑ same group as above |
| `TURN_EXTERNAL_IP` | `203.0.113.10/192.168.1.20` | compose `turn` profile: public IP, or public/private when the host is behind NAT (cloud VM *or* a home/office router in front of a NAS). |
| `TURN_TTL_SECONDS` | `86400` | Lifetime of issued TURN credentials, in seconds. |
| `ICE_TRANSPORT_POLICY` | `all` | 'relay' forces all media through TURN (hides client IPs); default 'all'. |

**voice / video: LiveKit SFU (optional)**

| Variable | Example / default | Notes |
| --- | --- | --- |
| `LIVEKIT_URL` | `wss://lk.example.com` | When LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET are all set, voice, video, screen share and stage channels use the LiveKit SFU instead of the peer-to-peer mesh (no VOICE_MESH_LIMIT, simulcast, adaptive stream). Leave them unset to keep the mesh. GET /api/voice/config tells clients which. Compose: `docker compose --profile livekit up -d` + DEPLOYMENT.md. Public WebSocket URL browsers connect to (TLS in production). |
| `LIVEKIT_API_KEY` | `antigravity` | Key name and secret (secret: 32+ chars, `openssl rand -hex 32`). The compose profile passes these to the LiveKit container; livekit.yaml's webhook.api_key must equal the key name. |
| `LIVEKIT_API_SECRET` |  | ↑ same group as above |
| `LIVEKIT_HOST` | `http://livekit:7880` | Server API URL the app calls (moderation, permissions). Defaults to LIVEKIT_URL with ws→http; inside compose use the internal address. |
| `LIVEKIT_DOMAIN` | `lk.example.com` | Hostname Caddy serves LiveKit signalling on (see Caddyfile). |
| `LIVEKIT_TOKEN_TTL_SECONDS` | `600` | Room token lifetime (60–3600 s). LiveKit refreshes tokens of connected participants itself, so this only bounds how long an unused token is valid. |
| `LIVEKIT_ROOM_LIMIT` | `0` | Cap per room on top of each channel's own user limit; 0 = none. |
| `LIVEKIT_VIDEO_CODEC` | `auto` | Preferred camera/screen codec: auto (AV1 → VP9 → VP8 by browser support, always with a VP8 backup layer), vp8, vp9, av1, h264. |
| `LIVEKIT_E2EE` | `0` | Media encryption with a per-room key derived from LIVEKIT_E2EE_SECRET (or the API secret). Protects media from the SFU operator, not from this app server. |
| `LIVEKIT_E2EE_SECRET` |  | ↑ same group as above |

**backups**

| Variable | Example / default | Notes |
| --- | --- | --- |
| `BACKUP_DIR` | `./backups` | Where database/file backup snapshots are written (backup tooling). |
| `PG_DUMP` | `/usr/lib/postgresql/16/bin/pg_dump` | PostgreSQL client binaries for scripts/backup.mjs (default: from PATH). Must be the server's major version or newer. In Docker use scripts/ops/docker-backup.sh instead: it runs pg_dump in the postgres container. |
| `PG_RESTORE` | `/usr/lib/postgresql/16/bin/pg_restore` | ↑ same group as above |

**realtime scale-out (optional)**

| Variable | Example / default | Notes |
| --- | --- | --- |
| `REDIS_URL` | `redis://valkey:6379` | Unset = single instance, everything in memory (the default). Set to run several app instances behind one proxy: Socket.IO Redis Streams adapter (cross-instance fan-out + connection-state recovery across instances), shared rate limits, presence with TTL heartbeats. Valkey or Redis >= 6.2. Requires PostgreSQL. See DEPLOYMENT.md §8 "Running several instances". |
| `REDIS_KEY_PREFIX` | `ag:` | Key prefix, so one Valkey can serve several deployments. |
| `REDIS_CONNECT_TIMEOUT_MS` | `5000` | First connection attempt (ms). A configured but unreachable Redis fails boot. |
| `REDIS_COMMAND_TIMEOUT_MS` | `500` | Per-command timeout (ms). A Redis that stops answering (paused, overloaded, black-holed network) trips a breaker: rate limits and presence fall back to this instance's memory until a PING (every REDIS_STALL_PROBE_MS) answers. |
| `REDIS_STALL_PROBE_MS` | `1000` | ↑ same group as above |
| `CADDYFILE` | `./Caddyfile.scale` | compose `scale` profile: two sticky upstreams instead of one. |
| `WORKER_ID` | `0` | Each instance needs a distinct snowflake worker id (0-31); compose sets it. |
| `SOCKET_RECOVERY_MS` | `120000` | How long a dropped client may resume with its missed events (ms; 0 = off). |
| `SOCKET_MAX_PAYLOAD_BYTES` | `524288` | Largest single socket frame accepted (bytes). Files go over HTTP. |
| `PRESENCE_TTL_MS` | `90000` | Presence heartbeat TTL on a cluster: a crashed instance's users go offline after roughly this long (ms). |
| `SOCKET_STREAM_MAXLEN` | `20000` | Replay history kept in the Redis stream (entries, approximate). |
| `PRESENCE_OFFLINE_GRACE_MS` | `5000` | Offline is announced only after this long without any connection (ms). |
| `SESSION_CACHE_TTL_MS` | `30000` | Resolved-session cache (ms); default 30000 in production, 0 elsewhere. |
| `SESSION_TOUCH_INTERVAL_MS` | `300000` | ↑ same group as above |
| `MESSAGE_WRITE_CONCURRENCY` | `32` | Message write admission: in flight / waiting / longest wait (ms). |
| `MESSAGE_WRITE_QUEUE` | `256` | ↑ same group as above |
| `MESSAGE_WRITE_MAX_WAIT_MS` | `5000` | ↑ same group as above |
| `UV_THREADPOOL_SIZE` | `16` | libuv pool (scrypt + sqlite3 + fs); default max(16, 2 x cores). |
| `RATE_LIMIT_READ_PER_MIN` | `600` | Rate limits (per user unless noted). |
| `RATE_LIMIT_MUTATE_PER_MIN` | `600` | ↑ same group as above |
| `RATE_LIMIT_UPLOAD_PER_MIN` | `30` | ↑ same group as above |
| `RATE_LIMIT_LOGIN_PER_5MIN` | `10` | per IP + username |
| `RATE_LIMIT_LOGIN_IP_PER_5MIN` | `60` | per IP |
| `RATE_LIMIT_WRITE_PER_MIN` | `60` | message sends / edits over HTTP |
| `RATE_LIMIT_REGISTER_PER_HOUR` | `20` | new accounts per IP (no invite) |
| `RATE_LIMIT_REGISTER_INVITE_PER_HOUR` | `100` | sign-ups carrying a valid invite (schools, clubs on one Wi-Fi) |
| `SOCKET_FLOOD_MULTIPLIER` | `1` | Socket flood guard: multiply every per-event budget (load tests only). |
| `PERM_CACHE_GUILDS` | `2000` | Guilds whose permission data is cached in memory (LRU). |

**safety & instance administration**

| Variable | Example / default | Notes |
| --- | --- | --- |
| `REGISTRATION_MODE` | `open` | Who may create accounts: open \| invite (valid invite required) \| closed. Instance admins can override this at runtime in the admin console. |
| `ADMIN_EMAILS` |  | Comma-separated e-mails that are instance admins once verified (the first account on a fresh instance is admin automatically). |
| `REQUIRE_BIRTHDATE` | `0` | Require a date of birth at sign-up (year + month only are stored; under-13 is refused, under-18 gets teen-safe defaults). |

**profiles & cosmetics**

| Variable | Example / default | Notes |
| --- | --- | --- |
| `PROFILE_EARLY_MEMBERS` | `100` | The first N accounts on the instance get the "early member" badge. |
| `STATUS_SWEEP_MS` | `30000` | How often expired custom statuses are cleared, in ms (minimum 5000). |

**passkeys (WebAuthn)**

| Variable | Example / default | Notes |
| --- | --- | --- |
| `PASSKEYS_ENABLED` | `1` | Off unless PASSKEYS_ENABLED=1, RP_ID or PUBLIC_URL is set (PASSKEYS_ENABLED=0 always wins). RP_ID is the registrable domain passkeys are bound to — changing it later orphans every registered passkey. Both default from PUBLIC_URL. |
| `RP_ID` | `chat.example.com` | ↑ same group as above |
| `RP_ORIGIN` | `http://localhost:5173).` | Allowed page origins, comma-separated (add the Vite dev origin in development: |
| `RP_ORIGIN` | `https://chat.example.com` | ↑ same group as above |
| `RP_NAME` | `Antigravity Discord` | ↑ same group as above |

**message translation**

| Variable | Example / default | Notes |
| --- | --- | --- |
| `LIBRETRANSLATE_URL` | `http://libretranslate:5000` | Browsers with the built-in Translator API translate on-device and need none of this. Server-side providers are tried in order; unset = not used. Self-hosted LibreTranslate (docker compose --profile translate up -d): |
| `LIBRETRANSLATE_API_KEY` |  | ↑ same group as above |
| `LT_LOAD_ONLY` | `en,th,ja,zh,zt,ko,es,fr,de,pt,ru,vi,id` | compose `translate` profile: languages to download (each is a model of a few hundred MB) and LibreTranslate's own API-key switch (then set the key above). |
| `LT_API_KEYS` | `false` | ↑ same group as above |
| `DEEPL_API_KEY` |  | keys ending in :fx use the free API host |
| `DEEPL_API_URL` |  | override the DeepL host (proxy / regional endpoint) |
| `ANTHROPIC_API_KEY` |  | Claude as a last resort |
| `TRANSLATION_ANTHROPIC_MODEL` | `claude-haiku-4-5-20251001` | ↑ same group as above |
| `TRANSLATION_PROVIDERS` | `libretranslate,deepl,anthropic` | Order / subset of providers: |
| `TRANSLATION_SERVER_ENABLED` | `1` | 0 turns off /api/translate entirely |
| `TRANSLATION_CLIENT_ENABLED` | `1` | 0 hides on-device translation too |
| `TRANSLATION_CACHE_TTL_HOURS` | `168` | ↑ same group as above |
| `TRANSLATION_RATE_PER_MIN` | `20` | provider calls (cache misses) per user |
| `TRANSLATION_REQUESTS_PER_MIN` | `120` | all translate requests per user |

**Web Push / PWA notifications (services/push.js)**

| Variable | Example / default | Notes |
| --- | --- | --- |
| `VAPID_PUBLIC_KEY` |  | Off unless all three VAPID values are set. Generate once: npm run push:keys Rotating the key pair invalidates every browser subscription (they re-subscribe on their next visit). Keep the private key out of the client and out of logs. |
| `VAPID_PRIVATE_KEY` |  | ↑ same group as above |
| `VAPID_SUBJECT` | `mailto:ops@example.com` | ↑ same group as above |
| `PUSH_ENDPOINT_HOSTS` | `fcm.googleapis.com,updates.push.services.mozilla.com,web.push.apple.com,notify.windows.com` | Push services the server will POST to (host suffixes). Default: FCM, Mozilla, Apple, WNS. Never allow arbitrary hosts — the endpoint URL comes from browsers. |
| `PUSH_USER_LIMIT_PER_MIN` | `30` | pushes per user per minute (topic collapses the rest) |
| `PUSH_TTL_SECONDS` | `14400` | how long a push service keeps an undelivered push |
| `PUSH_APP_NAME` | `Antigravity` | title of "hidden content" pushes |
| `PUSH_EXTRA_CA_FILE` | `/etc/ssl/certs/corporate-ca.pem` | PUBLIC_URL (above) is used for the link a notification opens. Extra CA bundle for reaching push services through a TLS-intercepting proxy. |
| `PUSH_ALLOW_INSECURE_ENDPOINTS` | `0` | Development/tests only: allow http:// and non-allow-listed push endpoints. |

**observability**

| Variable | Example / default | Notes |
| --- | --- | --- |
| `OTEL_EXPORTER_OTLP_ENDPOINT` |  | Everything here is optional and off by default. See DEPLOYMENT.md, "Observability". LOG_LEVEL accepts trace\|debug\|info\|warn\|error\|fatal\|silent. OpenTelemetry traces + metrics + logs over OTLP/HTTP. Unset = the SDK is not even loaded. Needs the preload (the Docker image always uses it): NODE_OPTIONS="--import ./lib/otel-preload.mjs" npm start With the compose `observability` profile: http://lgtm:4318 |
| `OTEL_SERVICE_NAME` | `antigravity-discord` | ↑ same group as above |
| `OTEL_TRACES_SAMPLER` | `parentbased_traceidratio` | Sample 10% of new traces in production (parent decisions are respected). |
| `OTEL_TRACES_SAMPLER_ARG` | `0.1` | ↑ same group as above |
| `OTEL_LOGS_EXPORTER` | `none` | keep logs on stdout only |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` |  | Per-signal endpoints, when traces and metrics go to different collectors: |
| `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` |  | ↑ same group as above |
| `OTEL_METRIC_EXPORT_INTERVAL` | `15000` | ms |
| `OTEL_SDK_DISABLED` | `true` | load nothing even if an endpoint is set |
| `GRAFANA_ADMIN_PASSWORD` |  | Grafana admin password for the compose `observability` profile. |
| `SENTRY_DSN` |  | Error tracking (Sentry protocol: self-hosted GlitchTip or Sentry). Server errors (5xx, crashes) are sent with PII scrubbed. SENTRY_BROWSER_DSN is public by design (it ships to browsers); use a separate project for it. Browser reports are tunnelled through /api/telemetry/errors. |
| `SENTRY_BROWSER_DSN` |  | ↑ same group as above |
| `SENTRY_ENVIRONMENT` | `production` | ↑ same group as above |
| `APP_RELEASE` |  | Release tag for error reports; the Docker image sets it to the git sha. Falls back to GIT_SHA, then SOURCE_COMMIT (set by some PaaS builders). |
| `GIT_SHA` |  | ↑ same group as above |
| `SOURCE_COMMIT` |  | ↑ same group as above |
| `WEB_VITALS_ENABLED` | `1` | Core Web Vitals from browsers (anonymous; name/value/rating only). |
| `WEB_VITALS_SAMPLE_RATE` | `0.25` | ↑ same group as above |
| `RATE_LIMIT_VITALS_PER_MIN` | `30` | ↑ same group as above |
| `READY_DISK_MIN_FREE_MB` | `256` | Readiness (/api/ready): 503 below this much free disk where uploads or the SQLite file live; "low" (still ready) below the warn level. |
| `READY_DISK_WARN_FREE_MB` | `1024` | ↑ same group as above |

**example bot (scripts/example-bot.mjs)**

| Variable | Example / default | Notes |
| --- | --- | --- |
| `API_BASE` | `http://localhost:3001` | Only read by the example bot, not by the server. |
| `BOT_TOKEN` |  | ↑ same group as above |

<!-- env-reference:end -->
