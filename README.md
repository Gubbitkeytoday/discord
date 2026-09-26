# Antigravity Discord

A self-hosted, Discord-style chat server: text channels, threads, forums, DMs,
voice/video, roles and permissions, moderation, and a small bot API. It is one
Node.js process with an embedded SQLite database and a React single-page app,
built for small communities that want to run their own server.

It is **not** affiliated with Discord Inc., is **not** API-compatible with
Discord (Discord bots and clients will not work against it), and is a
single-node system. Read [Status and limitations](#status-and-limitations)
before you deploy it for real people.

## สรุปภาษาไทย

- **คืออะไร:** แชตแบบ Discord ที่ติดตั้งเองได้ รันเป็น Node.js process เดียว ใช้ SQLite ในเครื่อง มีห้องข้อความ, thread, forum, DM, voice/video, role/สิทธิ์, AutoMod, audit log และ bot API แบบง่าย รองรับภาษาไทยทั้ง UI และการค้นหาข้อความ (FTS5 trigram)
- **ข้อจำกัดสำคัญ:** voice เป็น WebRTC แบบ full mesh จำกัด 8 คนต่อห้อง (`VOICE_MESH_LIMIT`), ยังไม่มี TURN server ในโค้ด (ใช้ได้แค่ STUN ของ Google — ผู้ใช้หลัง NAT/ไฟร์วอลล์บางแบบจะต่อเสียงไม่ติด), ไม่มีการเข้ารหัส end-to-end, ไม่มี push notification / แอปมือถือ, และรันได้เครื่องเดียว (SQLite + Socket.IO ในหน่วยความจำ)
- **เริ่มใช้งาน (dev):** `npm ci` → `cp .env.example .env` → `npm run seed` → `npm run server` และ `npm run dev` แล้วเปิด http://localhost:5173 (บัญชีทดสอบ `AlexPro` / `antigravity123`)
- **Production:** ดู [DEPLOYMENT.md](DEPLOYMENT.md) — ต้องตั้ง `ALLOW_DEV_IDENTITY=0`, `STORAGE_URL_SECRET` ใหม่, `SECURE_COOKIES=1` ไม่งั้นเซิร์ฟเวอร์จะไม่ยอมสตาร์ต
- **รายละเอียดเชิงลึก:** [ARCHITECTURE.md](ARCHITECTURE.md) (ส่วนใหญ่เป็นภาษาไทย)

---

## Status and limitations

What has been verified on this commit (Node 22, Linux):

| Check | Result |
| --- | --- |
| `npm ci && npm run build` | builds (Vite warns that the main chunk is > 500 kB) |
| `npm test` | 281 tests in 70 suites, all passing (~7 s) |
| `npm run a11y` | static audit reports no problems (names, ARIA, alt text, contrast). This is a linter, not a screen-reader test. |
| `npm run i18n:audit`, `jsx:check`, `parse:check` | pass |
| Docker image / `docker compose` | **not verified** in CI or by the maintainers' last pass — build it yourself before relying on it |
| `npm audit --omit=dev` | 0 advisories (sqlite3 6, sharp 0.35, patched `qs`); re-run before each release |

Known limitations — read these before inviting users:

- **Voice/video is peer-to-peer full mesh.** Every participant uploads a stream
  to every other participant, so rooms are capped at `VOICE_MESH_LIMIT`
  (default 8) and the server refuses the 9th joiner with `VOICE_FULL`. There is
  no SFU. Stage channels use the same mesh (audience members join suppressed).
- **No TURN server is configured.** ICE servers are hard-coded to Google's
  public STUN servers in `src/hooks/useVoicePeers.js`. Calls between users on
  symmetric NAT, carrier-grade NAT or strict corporate firewalls will fail to
  connect. For real-world use you need to run a TURN server (e.g. coturn) and
  add it to that list; there is no environment variable for this yet.
- **No end-to-end encryption.** Media is DTLS-SRTP encrypted peer-to-peer, and
  messages are stored in plaintext in SQLite. (Discord itself now runs its DAVE
  E2EE protocol on all non-stage calls.)
- **Single node.** SQLite has one writer, and Socket.IO rooms, presence and rate
  limit buckets live in process memory. You cannot run two instances behind a
  load balancer. Rate-limit counters reset on restart.
- **No push notifications, no native mobile/desktop apps, no PWA manifest.**
  Notifications use the browser Notification API and only fire while a tab is
  open. The layout is responsive down to phone width.
- **Bot API is its own design.** Bots authenticate with `Authorization: Bot
  <token>` against this server's REST API and receive interactions over
  Socket.IO. There is no OAuth2, no gateway intents, and discord.js / discord.py
  will not work. See `scripts/example-bot.mjs`.
- **Email** (verification, password reset) logs to the console unless you set
  `MAIL_TRANSPORT=smtp`.

## Features

Verified present in the code (see ARCHITECTURE.md for how each works):

- **Messaging:** Markdown (bold, italics, code blocks, spoilers, quotes),
  replies, edits with history, deletes, pins, reactions, forwarding, mentions
  (`@user`, `@role`, `@everyone`, `@here`) with an inbox and unread tracking,
  attachments, voice notes, stickers and custom emoji, link previews (with an
  SSRF guard), polls, built-in slash commands (`/shrug`, `/me`, `/spoiler`, ...).
  A failed send can be retried manually.
- **Search:** SQLite FTS5 with the `trigram` tokenizer, so substring search works
  for Thai/CJK. Operators: `from:`, `mentions:`, `in:`, `has:`, `before:`,
  `after:`, `during:`, `pinned:`.
- **Channels:** text, voice, announcement (with cross-server following),
  forum (tags, list/gallery layout), media, stage, categories; public and
  private threads with auto-archive; slowmode; NSFW and spoiler channel
  click-through gates.
- **Servers:** roles with Discord's permission bit layout (36 of Discord's
  flags implemented), channel permission overwrites, role hierarchy checks,
  invites and vanity URLs, verification levels, membership screening, welcome
  screen, onboarding prompts, server templates, scheduled events, soundboard,
  insights, public widget, raid protection, per-server profiles, server folders.
- **Moderation:** AutoMod (keyword, regex, link, mention-spam and spam triggers;
  block/alert/timeout actions; role and channel exemptions), kick/ban/unban,
  timeouts (max 28 days), member/message reports queue, audit log.
- **Accounts:** registration and login, scrypt password hashing, session tokens
  stored as SHA-256 hashes, TOTP 2FA with backup codes, session list and
  revoke, friends and blocking, DMs and group DMs, DM calls, profile privacy,
  private notes, settings synced across devices, JSON data export, account
  deletion (anonymising).
- **Voice/video:** mic, camera, screen share, push-to-talk, automatic input
  sensitivity, per-user volume up to 200%, camera blur, spatial audio.
- **Bots:** applications with bot tokens, guild/global slash commands,
  context-menu commands, interactions with embeds and buttons, incoming
  webhooks.
- **UI:** themes (dark, onyx, light, ash, follow system), English and Thai
  (switchable at runtime), keyboard shortcuts, quick switcher.
- **Operations:** content-addressed file storage with dedupe and magic-byte
  type checks, optional S3/R2 backend, signed private file URLs, `/api/health`
  and `/api/ready`, Prometheus `/metrics`, JSON logs, graceful shutdown, online
  backup/restore scripts, storage GC/verify scripts.

### Compared with Discord

| Area | Status here |
| --- | --- |
| Text chat, threads, forums, reactions, pins, polls, search filters | Present |
| Roles, overwrites, audit log, bans, timeouts, slowmode, AutoMod | Present (AutoMod has no ML/keyword presets) |
| Onboarding, screening, welcome screen, templates, events | Present |
| Stage channels | Partial — mesh-based, 8-person cap, no speaker requests at scale |
| Voice/video scale | Partial — P2P mesh, no SFU, no TURN |
| Bots / slash commands / interactions | Partial — own API, not Discord-compatible; no OAuth2, intents or modals ecosystem |
| Rate limit headers | Partial — `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `Retry-After`; no `Reset`/`Bucket` |
| NSFW gating | Partial — click-through warning, no age verification |
| 2FA | Partial — TOTP + backup codes; no passkeys/WebAuthn or SMS |
| Rich presence / activities, Go Live to many viewers | Missing (custom status only) |
| Push notifications, mobile/desktop apps, PWA | Missing |
| E2E encrypted calls (DAVE) | Missing |
| OAuth2 / "Login with", gateway intents, sharding | Missing |
| Boosts, Nitro, monetisation | Missing (schema columns only) |

## Quickstart (development)

Requirements: **Node.js 20.17 or newer** (22 recommended; the server uses
`process.loadEnvFile`), npm 10, and a platform where the `sqlite3` prebuilt
binary installs (Linux, macOS, Windows x64/arm64). `sharp` is optional; without
it images are stored without resized variants.

```bash
git clone https://github.com/Gubbitkeytoday/discord.git
cd discord
npm ci
cp .env.example .env        # development defaults work as-is
npm run seed                # optional: 5 demo accounts, 3 servers
```

Then, in two terminals:

```bash
npm run server              # API + Socket.IO on :3001 (restarts on change)
npm run dev                 # Vite on :5173, proxies /api and /uploads to :3001
```

Open <http://localhost:5173>. Seeded accounts are `AlexPro`, `CyberNinja`,
`ChillBot` (a bot user), `GamerGirl99` and `CodeMaster`, all with password
`antigravity123`. You can also register a new account from the login screen.

On Windows, `start-discord.bat` launches both processes and opens the browser.

To check a change:

```bash
npm test                    # integration tests; each file boots its own server on a temp DB
npm run verify              # jsx:check + parse:check + a11y + i18n:audit + build + test
```

Tests pick a port in 3900-3989 per test file; set `TEST_PORT` to force one, or
`TEST_PORT_BASE` to move the whole range.

The same suite runs against PostgreSQL; each test file creates (and drops) its
own database on the given server:

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm run test:pg
```

## Configuration

All settings are environment variables, read from `.env` if present. See
`.env.example` for comments. With `NODE_ENV=production`, `lib/config.js`
**refuses to start** on an unsafe combination (marked "required" below).

| Variable | Default | Notes |
| --- | --- | --- |
| `NODE_ENV` | `development` | `production` enables the safety checks |
| `PORT` / `HOST` | `3001` / `0.0.0.0` | |
| `PUBLIC_URL` | `http://localhost:5173` | Your external https origin; used in links and CSP |
| `TRUST_PROXY` | `loopback` | Number of proxies in front (`1` behind Caddy/nginx) |
| `CORS_ORIGIN` | `http://localhost:5173` | Leave empty when the app serves the SPA itself; `*` is rejected in production |
| `SERVE_STATIC` / `STATIC_DIR` | `0` / `dist` | Set `1` in production to serve the built client |
| `DATABASE_URL` | unset | `postgres://user:pass@host:5432/db` selects **PostgreSQL** (13+, needs `pg_trgm`); unset = SQLite at `DB_PATH`. Schema is created/migrated on boot. See [DEPLOYMENT.md §11](DEPLOYMENT.md#11-postgresql) |
| `DB_PATH` | `./discord.db` | SQLite file (WAL mode), used when `DATABASE_URL` is unset |
| `DATABASE_SSL` / `PGSSLMODE`, `DATABASE_SSL_CA` | unset | Postgres TLS: `disable`, `require`, `verify-full`; CA bundle path for a private CA |
| `DB_POOL_MAX` / `DB_POOL_IDLE_MS` / `DB_CONNECT_TIMEOUT_MS` | `10` / `30000` / `10000` | Postgres connection pool per process |
| `DB_STATEMENT_TIMEOUT_MS` / `DB_LOCK_TIMEOUT_MS` / `DB_IDLE_IN_TX_TIMEOUT_MS` | `30000` / `10000` / `60000` | Postgres per-connection limits |
| `DB_TX_ISOLATION` / `DB_TX_RETRIES` | `serializable` / `8` | Postgres transaction isolation and automatic retries on serialization failure/deadlock |
| `STORAGE_ROOT` / `STORAGE_PUBLIC_BASE` | `./public/uploads` / `/uploads` | Local file storage |
| `STORAGE_URL_SECRET` | dev value | **Required** in production: new random value, 24+ chars (`openssl rand -base64 32`) |
| `ADMIN_TOKEN` | unset | Enables file maintenance and report triage endpoints |
| `ALLOW_DEV_IDENTITY` | `1` | Lets any request impersonate a user via `x-user-id`. **Must be `0`** in production |
| `SECURE_COOKIES` | `0` | Set `1` once TLS is in front |
| `MAIL_TRANSPORT` | `console` | `console`, `file` (`MAIL_FILE`) or `smtp` (`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`); `MAIL_FROM`. In production without a real transport, password reset and e-mail verification answer 503 `MAIL_NOT_CONFIGURED` |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` | unset | Optional S3-compatible object storage (AWS, R2, B2, MinIO) |
| `VOICE_MESH_LIMIT` | `8` | Max people per voice room |
| `DEFAULT_LOCALE` | `en` | `en` or `th`; browser language wins |
| `LOG_FORMAT` / `LOG_LEVEL` | `pretty` / `debug` | Use `json` / `info` in production |
| `ENABLE_METRICS` / `METRICS_TOKEN` | `1` / unset | Prometheus at `/metrics` behind `Bearer <token>`; in production it is only served when a token is set |
| `SESSION_TTL_DAYS` / `SESSION_IDLE_DAYS` | `30` / `14` | Absolute session lifetime and idle limit |
| `CSP_IMG_SOURCES` | unset | Extra image origins for the CSP (remote images otherwise go through `/api/media/proxy`) |
| `MEDIA_PROXY_MAX_BYTES` / `MEDIA_PROXY_CACHE_BYTES` | 8 MiB / 64 MiB | Image proxy limits |
| `SHUTDOWN_TIMEOUT_MS` | `15000` | Drain time on SIGTERM |
| `DOMAIN` | `localhost` | Docker Compose only: hostname Caddy gets a certificate for |
| `POSTGRES_PASSWORD` | example value | Docker Compose only: password of the bundled PostgreSQL (URL-safe characters) |

Rate limits, presence, typing indicators and Socket.IO rooms are kept in
process memory on both database engines, so run a single app instance.

## Deployment

Full guide: **[DEPLOYMENT.md](DEPLOYMENT.md)** (Docker Compose with PostgreSQL
and Caddy, bare Node behind nginx, backups, updates, scaling, security
checklist, and moving an existing SQLite database to PostgreSQL with
`npm run db:migrate-to-pg`).

Minimal bare-metal run:

```bash
npm ci && npm run build
# in .env: NODE_ENV=production, SERVE_STATIC=1, ALLOW_DEV_IDENTITY=0,
#          STORAGE_URL_SECRET=<random>, SECURE_COOKIES=1, CORS_ORIGIN=,
#          PUBLIC_URL=https://chat.example.com, TRUST_PROXY=1,
#          DATABASE_URL=postgres://… (recommended; omit to use SQLite)
npm start
```

Put TLS in front (Caddy or `nginx.conf.example`) — browsers only allow
microphone/camera on HTTPS origins. With Docker, edit `.env` the same way
(the compose file sets `NODE_ENV=production` but reads the rest from `.env`, so
the development defaults will make it refuse to start), set `DOMAIN` and
`POSTGRES_PASSWORD`, then `docker compose up -d --build`.

Before inviting users: set up a TURN server (see limitations), schedule
`npm run backup` + `npm run backup:prune`, and set `ADMIN_TOKEN`.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Server exits with "Refusing to start — configuration is unsafe for production" | One of the required production settings above; the message lists which |
| `npm ci` fails building `sqlite3` | No prebuilt binary for your platform/Node; install Python 3 and a C++ toolchain, or use Node 22 LTS |
| Uploaded images are blank in dev | Open the app via Vite on :5173 (it proxies `/uploads`), not the API port |
| Voice connects for some users but not others | No TURN server; users behind strict NAT cannot reach each other |
| "Voice room is full" (`VOICE_FULL`) | Mesh cap reached; raise `VOICE_MESH_LIMIT` only if everyone has the upstream bandwidth |
| Mic/camera prompt never appears | Page is not served over HTTPS (localhost is exempt) |
| Thai search finds nothing on an old database | SQLite: FTS index predates migration v2; run `npm run search:reindex`. Postgres: check `pg_trgm` is installed |
| `/api/health` returns 503 | The database is unreachable; `database.error` in the response says why |
| `permission denied to create extension "pg_trgm"` | The `DATABASE_URL` role must own the database, or run `CREATE EXTENSION pg_trgm` once as an admin |
| Tests fail with `EADDRINUSE` | Another process holds a 39xx port; set `TEST_PORT` |
| Blank page after an update | Rebuild the client (`npm run build`) so `dist/` matches the server |

`GET /api/health` returns the live and expected schema versions (currently 17)
and socket count; check it first.

## Project layout

```
server.js           Express app, REST routes, static serving
realtime.js         Socket.IO gateway: presence, typing, voice signalling
db.js, db/          database layer: SQLite + PostgreSQL drivers, dialect helpers,
                    migrations (v1-v17), schema.sql / schema.pg.sql, seed.js
lib/                auth, permissions, snowflake IDs, TOTP, rate limits, config, mailer, S3
routes/             auth, files, account security
services/           domain logic: messages, guilds, automod, threads, forum, polls, apps ...
storageService.js   content-addressed file storage
src/                React 19 client (components, hooks, i18n, utils)
scripts/            tests, audits, backup, storage tools, example bot
```

Deeper design notes (mostly in Thai): [ARCHITECTURE.md](ARCHITECTURE.md).

## License

No license file is included, so default copyright applies; ask the author
before reusing the code. Not affiliated with, sponsored by, or endorsed by
Discord Inc. "Discord" is a trademark of Discord Inc.
