# Antigravity Discord

A self-hosted, Discord-style chat server: text channels, threads, forums, DMs,
voice/video, roles and permissions, moderation, and a small bot API. One
Node.js process serves the API, the WebSocket gateway and a React single-page
app. The database is PostgreSQL (the Docker default) or an embedded SQLite file.
Everything else is optional and self-hostable: a TURN relay, a LiveKit SFU,
Web Push, passkeys, machine translation, Redis for several instances, and an
observability stack.

It is **not** affiliated with Discord Inc. and is **not** API-compatible with
Discord (Discord bots and clients will not work against it). Read
[Status and limitations](#status-and-limitations) before you deploy it for real
people.

## สรุปภาษาไทย

- **คืออะไร:** แชตแบบ Discord ที่ติดตั้งเองได้ มีห้องข้อความ, thread, forum, DM, โทรใน DM, voice/video, stage, role/สิทธิ์, AutoMod, audit log และ bot API แบบง่าย UI มี 32 ภาษา (รวมไทย) ค้นหาข้อความภาษาไทยได้ (trigram)
- **ฐานข้อมูล:** PostgreSQL (ค่าเริ่มต้นใน Docker) หรือ SQLite ไฟล์เดียว — schema ถูกสร้าง/migrate อัตโนมัติ (ตอนนี้ v38)
- **ส่วนเสริม (เปิดเมื่อตั้งค่า):** TURN (coturn) สำหรับคนที่อยู่หลัง NAT, LiveKit SFU สำหรับห้องเสียง/วิดีโอใหญ่, แจ้งเตือนมือถือผ่าน Web Push + ติดตั้งเป็น PWA, passkey (WebAuthn), แปลข้อความ (LibreTranslate/DeepL/Claude หรือในเบราว์เซอร์), Redis/Valkey สำหรับรันหลาย instance, Grafana/Tempo/Loki/Prometheus
- **ข้อจำกัด:** ข้อความไม่ได้เข้ารหัสแบบ end-to-end, ยังไม่มีแอป native (ใช้ PWA), ยังไม่มีหน้า admin ระดับ instance และการปิดรับสมัคร, voice แบบ mesh จำกัด 8 คนถ้าไม่เปิด LiveKit, ยังไม่มี image สำเร็จรูปให้ดึง (ต้อง build เอง)
- **เริ่มใช้งาน (dev):** `npm ci` → `cp .env.example .env` → `npm run seed` → `npm run server` และ `npm run dev` แล้วเปิด http://localhost:5173 (บัญชีทดสอบ `AlexPro` / `antigravity123`)
- **ทดลองในวง LAN (5 นาที):** ดู [DEPLOYMENT.md §2a](DEPLOYMENT.md#2a-5-minute-lan-quickstart) — ถ้าเปิดผ่าน `http://IP` ต้องตั้ง `SECURE_COOKIES=0` ไม่งั้นล็อกอินแล้วรีเฟรชจะหลุด (เซิร์ฟเวอร์จะขึ้นกล่องสีแดงเตือนตอนบูต)
- **Synology/QNAP:** ดู [DEPLOYMENT.md §2b](DEPLOYMENT.md#2b-nas-synology--qnap) — ใช้ profile `no-proxy` แล้วให้ reverse proxy ของ DSM ทำ HTTPS (อย่าลืม custom header WebSocket)
- **Production:** ดู [DEPLOYMENT.md](DEPLOYMENT.md) — `npm run secrets -- --write` สร้างรหัสลับทั้งหมดให้, ต้องตั้ง `ALLOW_DEV_IDENTITY=0` และ `PUBLIC_URL` เป็น https ไม่งั้นเซิร์ฟเวอร์ไม่ยอมสตาร์ตหรือเตือน; สำรองข้อมูลใน Docker ด้วย `scripts/ops/docker-backup.sh`
- **รายละเอียดเชิงลึก:** [ARCHITECTURE.md](ARCHITECTURE.md) (ส่วนใหญ่เป็นภาษาไทย)

---

## Status and limitations

What is checked on every commit by CI (Node 22 and 24, Linux):

| Check | Result |
| --- | --- |
| `npm ci && npm run build` | builds; the client is code-split (lazy settings, voice, forum, modals) |
| `npm test` (SQLite) and `npm run test:pg` (PostgreSQL 16) | the same integration suites, each file booting its own server; all passing |
| `npm run e2e`, `e2e:integration`, `e2e:passkeys`, `e2e:pwa` | Playwright/Chromium against a real server: core flows, passkey sign-in, translation, reconnect catch-up, installable PWA and offline shell |
| `npm run a11y`, `i18n:audit`, `jsx:check`, `parse:check`, `env:check` | pass. `a11y` is a static linter, not a screen-reader test |
| Docker image | built, booted read-only and probed on `/api/live` in CI; SBOM + grype scan (fails on fixable critical CVEs); signed and pushed only when a registry is configured |
| `docker compose config` | every profile validated in CI; an empty `POSTGRES_PASSWORD` is refused |
| `npm audit --omit=dev` | no critical advisories (gate); re-run before each release |

Known limitations — read these before inviting users:

- **No end-to-end encryption for messages.** Messages are stored in plaintext
  in the database so that search, AutoMod and reports work. Calls are
  DTLS-SRTP encrypted in transit; with LiveKit, optional media E2EE
  (`LIVEKIT_E2EE=1`) keeps the SFU operator out, not this app's server.
- **Voice without LiveKit is a peer-to-peer mesh**, capped at
  `VOICE_MESH_LIMIT` (default 8) people per room. The LiveKit SFU (`livekit`
  compose profile) removes the cap and adds simulcast. Either way you want a
  **TURN relay** for users behind carrier-grade NAT or strict firewalls: the
  server mints short-lived TURN credentials (`TURN_URLS`, `TURN_SECRET`) and the
  compose `turn` profile runs coturn, but it is not on by default. Without
  `STUN_URLS` the client uses Google's public STUN servers.
- **No native mobile/desktop apps.** The client is an installable PWA with Web
  Push notifications (VAPID keys; on iPhone only after "Add to Home Screen",
  iOS 16.4+).
- **No instance administration UI.** The first account is an ordinary user;
  anyone who can reach the server can register (rate-limited per IP). There is
  no invite-only registration mode, global ban or user list yet; `ADMIN_TOKEN`
  unlocks file maintenance and report triage over the API only.
- **No prebuilt image is published by default.** `docker compose up --build`
  builds it on your machine (several minutes on a small NAS). CI can push a
  signed image to your registry when `REGISTRY_IMAGE` is set.
- **Scaling out needs PostgreSQL + Redis/Valkey.** One instance keeps
  presence, rate limits and Socket.IO rooms in memory. Several instances share
  them through Redis (`REDIS_URL`, compose `scale` profile); if Redis stalls,
  each instance falls back to its own memory until it answers again.
- **Bot API is its own design.** Bots authenticate with `Authorization: Bot
  <token>` and receive interactions over Socket.IO. No OAuth2, gateway intents
  or sharding; discord.js / discord.py will not work. See `scripts/example-bot.mjs`.
- **No SSO/LDAP.** Accounts are local (password, TOTP, passkeys).
- **E-mail** (verification, password reset) only logs to the console until you
  configure SMTP; in production those features answer 503 until then.

## Features

Verified present in the code (see ARCHITECTURE.md for how each works):

- **Messaging:** Markdown (bold, italics, code blocks, spoilers, quotes,
  headings, lists, masked links), replies, edits with history, deletes, pins,
  reactions and Super Reactions, forwarding, mentions (`@user`, `@role`,
  `@everyone`, `@here`) with an inbox and unread tracking, attachments, voice
  notes, stickers and custom emoji, link previews (with an SSRF guard), polls,
  built-in slash commands. Sends are idempotent (client nonce) and a dropped
  connection catches up on reconnect.
- **Search:** SQLite FTS5 `trigram` or PostgreSQL `pg_trgm`, so substring search
  works for Thai/CJK. Operators: `from:`, `mentions:`, `in:`, `has:`, `before:`,
  `after:`, `during:` (dates, months, years, and `today` / `yesterday` /
  `tomorrow`), `pinned:`.
- **Channels:** text, voice, announcement (with cross-server following),
  forum (tags, list/gallery), media, stage, categories; public and private
  threads with auto-archive; slowmode; NSFW and spoiler gates.
- **Servers:** Discord's permission bit layout, channel overwrites, role
  hierarchy, invites and vanity URLs, verification levels, membership
  screening, welcome screen, onboarding, templates, scheduled events,
  soundboard, insights, public widget, raid protection, per-server profiles,
  server folders.
- **Moderation:** AutoMod (keyword, regex, link, mention-spam and spam triggers;
  block/alert/timeout; exemptions), kick/ban/unban, timeouts, reports queue,
  audit log.
- **Accounts:** registration and login, scrypt password hashing, hashed session
  tokens, TOTP 2FA with backup codes, **passkeys (WebAuthn)** for sign-in and
  step-up, session list and revoke, friends and blocking, DMs, group DMs, DM
  calls, profile privacy, notes, synced settings, JSON data export, account
  deletion.
- **Voice/video:** mic, camera, screen share, push-to-talk, automatic input
  sensitivity, per-user volume up to 200 %, camera blur, spatial audio; P2P mesh
  or LiveKit SFU (AV1/VP9/VP8, simulcast, optional media E2EE); TURN credentials
  per user.
- **Media pipeline:** EXIF/GPS stripped, WebP/AVIF renditions with `srcset`,
  thumbhash placeholders, decompression-bomb limits, video posters and duration
  (optional ffmpeg), direct-to-bucket uploads on S3/R2/B2/MinIO.
- **Notifications:** per-server/channel levels, mentions inbox, Web Push to
  installed PWAs and desktop browsers (VAPID, no third-party account), offline
  app shell.
- **Translation:** on-device (browser Translator API) or server-side through
  self-hosted LibreTranslate, DeepL or Claude, cached per message.
- **UI:** themes (dark, onyx, light, ash, follow system), 32 languages
  (Discord's set, switchable at runtime; Thai is complete), keyboard shortcuts
  with rebinding, quick switcher.
- **Operations:** health/readiness endpoints, Prometheus `/metrics`, pino JSON
  logs with request ids, OpenTelemetry traces/metrics/logs, Sentry-protocol
  error tracking (GlitchTip), Web Vitals, bundled Grafana dashboards and alert
  rules, graceful drain, online backup/restore (SQLite `VACUUM INTO`,
  `pg_dump`) plus a Docker backup/restore/drill script, storage GC/verify,
  content-addressed storage with dedupe and magic-byte checks, signed private
  URLs, compressed static serving (brotli/gzip) when no proxy compresses.

### Compared with Discord, Matrix and Revolt

How this project stacks up for a small self-hosted community. "Revolt" is the
self-hostable Revolt/Stoat stack; "Matrix" is Synapse + Element.

| | Antigravity (this) | Discord | Matrix (Synapse + Element) | Revolt / Stoat |
| --- | --- | --- | --- | --- |
| Self-hostable | Yes: one Node process + PostgreSQL (or SQLite); `docker compose` | No | Yes, heavier (Synapse, Postgres, often a separate call stack) | Yes, `docker compose` (several services + MongoDB) |
| Discord-style servers, roles, channel overwrites | Yes, Discord's permission bits | — | Rooms/spaces with power levels | Yes |
| Threads, forums, polls, events, onboarding | Yes | Yes | Threads; no forums/onboarding | Partial |
| Search incl. Thai/CJK substrings | Yes (trigram) | Yes | Limited server-side search | Basic |
| Voice/video | Mesh ≤ 8, or LiveKit SFU; TURN via coturn | SFU, large rooms, Go Live | Element Call (LiveKit) | LiveKit-based |
| E2EE | Media only (LiveKit option); messages no | DAVE for calls; messages no | Yes, messages and calls | No |
| Mobile | Installable PWA + Web Push | Native apps | Native apps | Native apps |
| Federation | No | No | Yes | No |
| Passkeys | Yes | Yes | Via the homeserver's SSO/OIDC provider | Not documented |
| Bots | Own REST + Socket.IO API, slash commands, components | Huge ecosystem | Appservices/bots, bridges | Own API |
| Instance admin UI, registration control | **No** (API tokens only) | n/a | Yes (Synapse Admin API, registration config) | Limited (invite-only registration) |
| Moderation | AutoMod, reports, audit log, timeouts | Richer AutoMod, ML | Per-room moderation, policy lists | Basic |
| Translation built in | Yes (self-hosted or on-device) | No | No | No |
| Observability shipped | Prometheus, OTel, dashboards, alerts | n/a | Prometheus metrics | Limited |

If you need E2EE for text or federation, choose Matrix. If you need native
mobile apps today, Discord or Revolt. This project fits a community that wants
Discord's structure, runs its own box, and is fine with a PWA.

## Quickstart (development)

Requirements: **Node.js 22 or 24** (`engines` allows 20.17+, CI tests 22 and
24), npm 10, and a platform where the `sqlite3` prebuilt binary installs (Linux,
macOS, Windows x64/arm64). `sharp` is optional; without it images are stored
without renditions.

```bash
git clone https://github.com/Gubbitkeytoday/discord.git
cd discord
npm ci
cp .env.example .env        # development defaults work as-is
npm run seed                # optional: 5 demo accounts (one bot), 3 servers
```

Then, in two terminals:

```bash
npm run server              # API + Socket.IO on :3001 (restarts on change)
npm run dev                 # Vite on :5173, proxies /api and /uploads to :3001
```

Open <http://localhost:5173>. Seeded accounts are `AlexPro`, `CyberNinja`,
`ChillBot` (a bot user), `GamerGirl99` and `CodeMaster`, all with password
`antigravity123`. A development server also seeds itself on first boot;
`npm run seed` does it explicitly, is a no-op on a database that already has
users, and refuses `NODE_ENV=production` unless `SEED_DATABASE=1`.

On Windows, `start-discord.bat` launches both processes and opens the browser.

To check a change:

```bash
npm test                    # integration tests; each file boots its own server on a temp DB
npm run verify              # jsx:check + parse:check + a11y + i18n:audit + build + test
```

Tests pick a port in 3900-3989 per test file; set `TEST_PORT` to force one, or
`TEST_PORT_BASE` to move the whole range. The same suite runs against
PostgreSQL; each test file creates (and drops) its own database:

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres npm run test:pg
```

## Configuration

All settings are environment variables, read from `.env` if present.
`.env.example` lists **every** variable the code reads, with comments; the
generated table in [DEPLOYMENT.md §16](DEPLOYMENT.md#16-environment-reference)
is the full reference (CI keeps the two in sync). `npm run secrets` prints fresh
values for every secret (`-- --write` fills the gaps in `.env`).

With `NODE_ENV=production`, `lib/config.js` **refuses to start** on an unsafe
combination and warns about risky ones. The ones people trip over:

| Variable | Default | Notes |
| --- | --- | --- |
| `PUBLIC_URL` | `http://localhost:<PORT>` | Your external `https://` origin; links, CSP, passkeys, push |
| `STORAGE_URL_SECRET` | dev value | **Required** in production: 24+ random characters |
| `ALLOW_DEV_IDENTITY` | `1` in dev | Lets any request impersonate a user via `x-user-id`. **Must be `0`** in production |
| `SECURE_COOKIES` | on in production | Needs HTTPS. On a plain-http LAN test set `0`, or sign-ins are silently dropped (a red boot alert says so) |
| `CORS_ORIGIN` | dev: `http://localhost:5173` | Leave empty when this process serves the SPA; `*` is refused in production |
| `TRUST_PROXY` | `1` in production | Number of proxies in front (Caddy/nginx: `1`; NAS proxy + `no-proxy` forwarder: `2`) |
| `DATABASE_URL` | unset (SQLite) | `postgres://…` selects PostgreSQL 13+ (`pg_trgm`); compose sets it |
| `REDIS_URL` | unset | Several instances; see DEPLOYMENT.md §8 |
| `TURN_URLS` / `TURN_SECRET` / `STUN_URLS` | unset | Voice relay; see DEPLOYMENT.md §4 |
| `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | unset | SFU instead of the mesh |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_SUBJECT` | unset | Web Push |
| `POSTGRES_PASSWORD` | empty (compose refuses) | Docker Compose's bundled PostgreSQL; URL-safe |

## Deployment

Full guide: **[DEPLOYMENT.md](DEPLOYMENT.md)**: Docker Compose with PostgreSQL
and Caddy, a 5-minute LAN quickstart, Synology/QNAP, bare Node behind nginx,
TURN, LiveKit, backups (with a restore drill), updates, scaling, observability,
and moving an existing SQLite database to PostgreSQL
(`npm run db:migrate-to-pg`).

Minimal bare-metal run:

```bash
npm ci && npm run build
# in .env: NODE_ENV=production, SERVE_STATIC=1, ALLOW_DEV_IDENTITY=0,
#          STORAGE_URL_SECRET=<npm run secrets>, CORS_ORIGIN=,
#          PUBLIC_URL=https://chat.example.com, TRUST_PROXY=1,
#          DATABASE_URL=postgres://… (recommended; omit to use SQLite)
npm start
```

Put TLS in front (Caddy or `nginx.conf.example`): browsers only allow the
microphone and camera on HTTPS origins. **Testing on a LAN without TLS?** Also
set `SECURE_COOKIES=0` and `PUBLIC_URL=http://<lan-ip>:3001`, and never expose
that setup to the internet.

With Docker: `cp .env.example .env`, `npm run secrets -- --write` (or paste the
printed values), set `NODE_ENV=production`, `PUBLIC_URL`, `DOMAIN`,
`ALLOW_DEV_IDENTITY=0`, then `docker compose up -d --build`. Ports 80/443
taken (a NAS)? Use `HTTP_PORT`/`HTTPS_PORT` or the `no-proxy` profile.

Before inviting users: set up TURN, schedule backups
(`scripts/ops/docker-backup.sh backup` in Docker, `npm run backup` without) and
run a restore drill once, and set `ADMIN_TOKEN`.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Server exits with "Refusing to start — configuration is unsafe for production" | One of the required production settings; the message lists which |
| Sign-up works, but a reload goes back to the login screen | `SECURE_COOKIES` is on and the page is plain `http://` (not localhost); the boot log shows a red CONFIGURATION PROBLEM box. Use HTTPS, or `SECURE_COOKIES=0` for a LAN test |
| `docker compose up`: "set POSTGRES_PASSWORD in .env" | Intended; `.env.example` leaves it empty. `npm run secrets -- --write` |
| Caddy: "address already in use" | Something (a NAS) owns 80/443: `HTTP_PORT`/`HTTPS_PORT` or the `no-proxy` profile |
| `npm ci` fails building `sqlite3` | No prebuilt binary for your platform/Node; install Python 3 and a C++ toolchain, or use Node 22/24 |
| Uploaded images are blank in dev | Open the app via Vite on :5173 (it proxies `/uploads`), not the API port |
| Voice connects for some users but not others | No TURN relay; users behind strict NAT cannot reach each other |
| "Voice room is full" (`VOICE_FULL`) | Mesh cap reached; enable LiveKit, or raise `VOICE_MESH_LIMIT` only if everyone has the upstream bandwidth |
| Mic/camera prompt never appears | Page is not served over HTTPS (localhost is exempt) |
| Thai search finds nothing on an old database | SQLite: run `npm run search:reindex`. Postgres: check `pg_trgm` is installed |
| `/api/health` returns 503 | The database is unreachable; `database.error` in the response says why |
| Tests fail with `EADDRINUSE` | Another process holds a 39xx port; set `TEST_PORT_BASE` |
| Blank page after an update | Rebuild the client (`npm run build`) so `dist/` matches the server |

`GET /api/health` returns the live and expected schema versions (currently
**38**, the highest migration in `db.js`) and the socket count; check it first.

## Project layout

```
server.js           Express app, REST routes, static serving
realtime.js         Socket.IO gateway: presence, typing, voice signalling
db.js, db/          database layer: SQLite + PostgreSQL drivers, dialect helpers,
                    migrations (v1-v38), schema.sql / schema.pg.sql, seed.js
lib/                auth, permissions, snowflake IDs, TOTP, rate limits, Redis,
                    presence, config, mailer, S3, telemetry, static assets
routes/             auth, files, passkeys, account security
services/           domain logic: messages, guilds, automod, threads, forum, polls,
                    apps, push, livekit, translation, media pipeline, observability ...
storageService.js   content-addressed file storage
src/                React 19 client (components, hooks, i18n, voice, PWA)
public/             manifest, service worker, offline page, icons
ops/                Grafana dashboards, alert rules, runbooks
scripts/            tests, e2e, audits, backup, storage tools, load tests,
                    ops/ (secrets, docker-backup, env-check), example bot
```

Deeper design notes (mostly in Thai): [ARCHITECTURE.md](ARCHITECTURE.md).
Performance and load tests: [docs/PERFORMANCE.md](docs/PERFORMANCE.md).
Plan: [docs/ROADMAP.md](docs/ROADMAP.md).

## License

No license file is included, so default copyright applies; ask the author
before reusing the code. Not affiliated with, sponsored by, or endorsed by
Discord Inc. "Discord" is a trademark of Discord Inc.
