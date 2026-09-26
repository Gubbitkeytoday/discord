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
typical home upload bandwidth. Beyond that you need an SFU (LiveKit, mediasoup).

### Echo

Chrome only echo-cancels audio played through a media element. The client plays
voices that way, and switches to Web Audio only when you boost someone above
100% or turn on spatial audio — in those cases speaker users may cause echo;
headphones avoid it.

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

Existing local files are not migrated automatically.

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
