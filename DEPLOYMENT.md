# Deployment

Everything needed to run this in production, in the order you need it. If you
only read one section, read [Before you go live](#5-before-you-go-live) — the app
refuses to start on most misconfigurations, but not all of them are fatal.

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

Either way the process keeps rate limits, presence, typing indicators and
Socket.IO rooms **in memory**, so run **one app instance** — scale it
vertically. (See [Scaling](#8-scaling).)

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
```

Then edit `.env` — at minimum:

```bash
NODE_ENV=production
PUBLIC_URL=https://chat.example.com
DOMAIN=chat.example.com
STORAGE_URL_SECRET=<openssl rand -base64 32>
ADMIN_TOKEN=<openssl rand -base64 32>
ALLOW_DEV_IDENTITY=0
SECURE_COOKIES=1
CORS_ORIGIN=
POSTGRES_PASSWORD=<openssl rand -hex 24>   # URL-safe: it is spliced into DATABASE_URL
```

`POSTGRES_PASSWORD` is fixed into the database volume on the very first start;
changing it later means `ALTER ROLE antigravity PASSWORD '…'` inside Postgres
as well. To stay on SQLite under compose, add `DATABASE_URL=` (empty) to `.env`.

`CORS_ORIGIN` is deliberately empty: the client is served by the same process, so
it is same-origin and needs no CORS at all.

```bash
docker compose up -d --build
docker compose logs -f app
```

Optional demo data (six accounts, three servers, sample messages — password
`antigravity123`):

```bash
docker compose exec app node db/seed.js
```

Point your DNS A/AAAA record at the host before the first start, or Caddy cannot
complete the ACME challenge.

**HTTPS is not optional for voice.** Browsers expose the microphone and camera
only on `https://` origins (and `localhost`). Served over plain `http://` from a
LAN IP, text chat works but joining voice shows "Voice and video need HTTPS".

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
TURN_SECRET=<openssl rand -hex 32>
TURN_URLS=turn:chat.example.com:3478?transport=udp,turn:chat.example.com:3478?transport=tcp
# Only on cloud VMs with 1:1 NAT (AWS, GCP, Azure, Oracle): public[/private]
TURN_EXTERNAL_IP=203.0.113.10/10.0.0.5

docker compose --profile turn up -d
```

Open in the host firewall **and** the cloud security group: `3478/udp`,
`3478/tcp`, and the relay range `49160-49200/udp` (≈ 20 concurrent relayed
users; widen `--min-port/--max-port` in the compose file for more). The coturn
container uses host networking, so these are the host's ports.

`TURN_SECRET` is the coturn *shared secret* (TURN REST API). The app never hands
it to browsers — it mints a credential per user that expires, so a leaked
credential is useless within a day.

### How the client gets the ICE servers

On every voice join the client calls `GET /api/voice/ice-servers` and expects:

```json
{ "iceServers": [{ "urls": ["stun:…"] }, { "urls": ["turn:…"], "username": "…", "credential": "…" }],
  "iceTransportPolicy": "all" }
```

If that endpoint is missing or fails, the client falls back to the build-time
`VITE_ICE_SERVERS` (a JSON array, baked in by `npm run build`; static TURN
credentials only, and visible to anyone who loads the page), and then to public
STUN only.

> **Server support.** `/api/voice/ice-servers` has to be implemented in
> `server.js` (a ~25-line route: read `STUN_URLS`, `TURN_URLS`, `TURN_SECRET`,
> `TURN_TTL_SECONDS`, `ICE_TRANSPORT_POLICY`; mint
> `username = "<unix-expiry>:<userId>"`,
> `credential = base64(HMAC-SHA1(TURN_SECRET, username))`). Until it exists,
> only the `VITE_ICE_SERVERS` fallback can carry TURN.

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
| `/api/ready` | database reachable; 503 while draining | readiness probe, load-balancer check |
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
process memory.

Logs are JSON in production (`LOG_FORMAT=json`), one object per line, each with a
`request_id` that is also returned in the `X-Request-Id` response header — so a
user-reported failure can be found in the logs.

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

**In Docker**, snapshots go to the `app-backups` volume (`BACKUP_DIR=/backups`),
separate from the data volume, so recreating the container keeps them:

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
| Video | dimensions (also from the MP4/WebM header without ffmpeg), duration, and a poster frame via system ffmpeg/ffprobe. The Docker image installs ffmpeg only with `--build-arg WITH_FFMPEG=1` (it adds a few hundred MB to the image) |

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
