# Deployment

Everything needed to run this in production, in the order you need it. If you
only read one section, read [Before you go live](#before-you-go-live) — the app
refuses to start on most misconfigurations, but not all of them are fatal.

---

## 1. What you are deploying

One Node process. It serves the REST API, the WebSocket gateway, uploaded files
and the built React client, all on a single port. SQLite is the database, so
there is no second service to run.

That has one consequence worth knowing up front: **SQLite means one writer**, so
this scales vertically, not horizontally. One container is the design. Give it
CPU and disk rather than replicas. (See [Scaling](#scaling).)

| Piece | Where it lives |
| --- | --- |
| Application | `server.js`, `routes/`, `services/`, `lib/` |
| Database | one file, `DB_PATH` (default `./discord.db`) |
| Uploaded files | `STORAGE_ROOT` (default `./public/uploads`), or S3 |
| Client bundle | `dist/`, built by `npm run build` |

---

## 2. Quick start with Docker Compose

The compose file runs the app plus Caddy, which obtains and renews a TLS
certificate automatically. This is the recommended path.

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
```

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

## 4. Before you go live

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

Verify the whole build before shipping:

```bash
npm run verify
```

That runs the client build, 119 tests, the accessibility audit and the
translation audit.

---

## 5. Operating it

### Health and monitoring

| Endpoint | Purpose | Use for |
| --- | --- | --- |
| `/api/live` | process is up; does **not** touch the database | liveness probe |
| `/api/ready` | database reachable; 503 while draining | readiness probe, load-balancer check |
| `/api/health` | detailed status | humans |
| `/metrics` | Prometheus text exposition | scraping |

Use `/api/live` for liveness and `/api/ready` for readiness — never the reverse.
A database blip should pull an instance out of rotation, not have the
orchestrator kill an otherwise healthy container.

Never expose `/metrics` publicly. Either scrape it over a private network or set
`METRICS_TOKEN` and send `Authorization: Bearer <token>`.

Exported metrics include request counts by method and status, p50/p95/p99
latency, 5xx count, live WebSocket connections, messages sent, uploads and
process memory.

Logs are JSON in production (`LOG_FORMAT=json`), one object per line, each with a
`request_id` that is also returned in the `X-Request-Id` response header — so a
user-reported failure can be found in the logs.

### Backups

The database is one file, but do not copy it with `cp` while the server is
running: you can capture a torn page or miss data still in the WAL.

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

A nightly cron:

```bash
0 3 * * * cd /srv/antigravity && npm run backup >> /var/log/antigravity-backup.log 2>&1
0 4 * * * cd /srv/antigravity && npm run backup:prune >> /var/log/antigravity-backup.log 2>&1
```

### Storage housekeeping

```bash
npm run storage:stats     # usage, orphans, per-user quotas
npm run storage:gc        # delete files nothing references any more
npm run storage:verify    # re-hash stored files and compare
npm run search:reindex    # rebuild the full-text index
```

The server also runs hourly housekeeping on its own: expired sessions and account
tokens are pruned, and threads past their auto-archive window are archived.

### Deploying an update

```bash
git pull
npm ci
npm run build
docker compose up -d --build     # or: systemctl restart antigravity
```

Rolling restarts are safe: `SIGTERM` makes `/api/ready` return 503 immediately so
the proxy stops sending new traffic, then in-flight requests finish, WebSockets
close, and the database is checkpointed — up to `SHUTDOWN_TIMEOUT_MS` (default
15s), after which the process exits anyway.

Migrations are versioned and run automatically at startup. **Take a backup before
deploying a schema change**, because they are forward-only.

---

## 6. Object storage (optional)

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

## 7. Scaling

**What scales now.** One process on modest hardware handles thousands of
concurrent WebSocket connections. SQLite in WAL mode gives concurrent readers
with a single writer, which suits chat: reads vastly outnumber writes.

**What does not, and what to do about it.**

| Limit | Why | Fix |
| --- | --- | --- |
| One writer | SQLite | vertical scaling; PostgreSQL if you truly outgrow it |
| No multi-instance | Socket.IO state is in-process | a Redis adapter would be needed |
| Voice above `VOICE_MESH_LIMIT` (8) | WebRTC full mesh: each extra peer costs every participant another upstream | an SFU (mediasoup, LiveKit) |
| Local uploads | tied to one host's disk | switch to `S3_*` |

Before optimising anything, look at `/metrics`. p95 latency and the 5xx counter
will tell you where the time actually goes.

---

## 8. Security checklist

- [ ] `STORAGE_URL_SECRET` and `ADMIN_TOKEN` freshly generated, not the examples
- [ ] `ALLOW_DEV_IDENTITY=0`
- [ ] `SECURE_COOKIES=1` and TLS terminating in front
- [ ] `TRUST_PROXY` equal to your real hop count
- [ ] `/metrics` not publicly reachable
- [ ] `CORS_ORIGIN` empty (same-origin) or an explicit list — never `*`
- [ ] Backups running, and a restore actually tested
- [ ] `.env` not committed; `600` permissions on the host

Already enforced in code: scrypt password hashing, session tokens stored only as
SHA-256, HttpOnly/SameSite cookies, per-route rate limits, upload magic-byte
sniffing (an HTML file renamed `.png` is rejected), path-traversal guards,
SSRF protection on link unfurling including link-local addresses, and a strict
CSP with `Content-Disposition: attachment` on user uploads.

---

## 9. Troubleshooting

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

**Thai search returns nothing** — the FTS index needs the trigram tokenizer.
Migration v2 handles this; if the database predates it, run
`npm run search:reindex`.
