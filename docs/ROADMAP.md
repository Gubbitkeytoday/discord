# Roadmap

Prioritised plan to take this self-hosted Discord-style server from "works for a
friend group" to "safe to run for a real community of a few hundred to a few
thousand people". Evidence and links are in [RESEARCH.md](RESEARCH.md).

Effort: **S** ≤ 2 days · **M** ≤ 2 weeks · **L** > 2 weeks (one engineer).

---

## สรุปภาษาไทย

**สถานะตอนนี้:** ฟีเจอร์ด้านข้อความ/เซิร์ฟเวอร์/การกลั่นกรองใกล้เคียง Discord มากแล้ว
(thread, forum, poll, AutoMod, onboarding, audit log, 2FA, export/ลบบัญชี)
แต่สิ่งที่ทำให้ชุมชนจริง "ย้ายกลับไป Discord" ยังขาดอยู่ ได้แก่ การแจ้งเตือนบนมือถือ,
เสียงที่ต่อได้ทุกเครือข่าย, ความเสถียรเมื่อหลุดการเชื่อมต่อ และเครื่องมือผู้ดูแลระบบระดับ instance

**P0 (ต้องมีก่อนเปิดให้คนจริงใช้):**
1. PWA + Web Push (VAPID) — แจ้งเตือน DM/mention บนมือถือโดยไม่ต้องมีแอปหรือบัญชี Google/Apple (iOS ต้อง "เพิ่มไปยังหน้าจอโฮม")
2. เติมข้อความที่พลาดหลัง reconnect (Socket.IO connection-state recovery + ดึง `after=` ผ่าน REST)
3. เปิด TURN (coturn) เป็นค่าเริ่มต้นใน deployment และทดสอบจริง — ผู้ใช้ 8–30% ต่อเสียงไม่ติดถ้าไม่มี
4. โหมดการสมัคร (เปิด / ต้องมีคำเชิญ / ปิด) + บังคับยืนยันอีเมล + captcha แบบ proof-of-work ที่ host เอง (ALTCHA)
5. หน้า Admin ระดับ instance: รายงาน, แบนผู้ใช้ทั้งระบบ, ลบไฟล์ตาม hash, ดูสถานะระบบ
6. Kill-switch และ rate limit สำหรับ event ที่กระจายเยอะ (typing, presence) — บทเรียนจาก Stoat ล่มเดือน ก.พ. 2026
7. สำรองข้อมูลอัตโนมัติ + ทดสอบกู้คืน (Litestream หรือ cron) และ runbook แจ้งเหตุข้อมูลรั่วตาม PDPA (72 ชั่วโมง)
8. หน้า Privacy Policy/ToS ที่ผู้ดูแลแก้ได้ + ตั้งค่าระยะเวลาเก็บข้อมูล (PDPA/GDPR)

**P1:** แยก bundle/virtualize รายการข้อความ, LiveKit SFU แบบเลือกได้ (ห้องเสียง >8 คน, stage),
AutoMod preset + สแกนชื่อโปรไฟล์, ระบบเตือน/อุทธรณ์ของผู้ใช้, สิทธิ์ใหม่ของ Discord (PIN_MESSAGES, BYPASS_SLOWMODE),
การตัดคำภาษาไทยด้วย `Intl.Segmenter`, `role="log"` + ทดสอบ screen reader, metrics ธุรกิจ

**สิ่งที่ "ไม่ควรทำ":** เข้ากันได้กับ API ของ Discord (Spacebar พิสูจน์แล้วว่าไล่ตามไม่ทัน), federation,
E2EE ของข้อความ, แอป native iOS/Android (ใช้ PWA แทน), สแกน CSAM เอง (ใช้ Cloudflare CSAM tool แทน),
ระบบรายได้/Nitro, age verification ด้วยบัตรประชาชน, และการย้ายไป multi-node/Postgres ก่อนที่ metrics จะบอกว่าจำเป็น

---

## Guiding principles

1. **Fix the reasons communities leave, before adding features.** Research
   (RESEARCH §2) points to: no phone notifications, voice that fails, outages,
   admin pain. Feature parity is already high.
2. **Zero third-party accounts by default.** Self-hosters choose this to avoid
   platform dependence (Guilded, Discord age-ID). Web Push, self-hosted PoW
   captcha, coturn, optional LiveKit — all self-hostable.
3. **Stay single-node until metrics say otherwise.** SQLite is not the
   bottleneck at community scale; in-process fan-out is. Measure first.
4. **Every new sidecar is optional** and the app degrades cleanly without it.

---

## P0 — must have before a real-world launch

### P0-1. PWA + Web Push notifications — **M**
- **Why:** Mobile notifications are the #1 practical reason communities abandon
  alternatives; Rocket.Chat/Mattermost need vendor gateways for native push, but
  Web Push (RFC 8291/8292) needs none. iOS 16.4+ supports it for Home-Screen PWAs.
  README lists "No push notifications … no PWA manifest" as a limitation.
- **What:**
  - `public/manifest.webmanifest` (name, icons 192/512 + maskable, `display: standalone`, theme colours), `<link rel="manifest">` in `index.html`.
  - Service worker (`public/sw.js`): `push` → `showNotification` (title, body truncated, icon, `tag` per channel to collapse, `data.url`), `notificationclick` → focus/open the deep link. Cache only the app shell; never cache API responses.
  - Server: VAPID keys from env (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`; generate on first boot in dev, refuse to start in prod without them *only if* push is enabled). Table `push_subscriptions(id, user_id, endpoint UNIQUE, p256dh, auth, user_agent, created_at, last_success_at)` via new migration.
  - `POST/DELETE /api/push/subscriptions`. Delivery in `services/push.js`: on new message, for each recipient who is a DM participant or mentioned (respecting per-channel/server notification settings, mute, DND, blocked users) **and has no focused socket**, send; drop subscription on 404/410; timeout + concurrency cap; never include message text if the user enabled "hide content in notifications".
  - Settings → Notifications: "Enable push on this device" button (user gesture), per-device list, test notification. iOS hint: "Add to Home Screen first".
- **Files:** `index.html`, `public/`, `vite.config.js` (SW copied as-is), new `services/push.js`, `db/` migration, `server.js` routes, `services/messages.js` hook, `src/components/settings/NotificationsTab.jsx`, `src/utils/notifier.js`, i18n files, `lib/middleware.js` (CSP `worker-src 'self'`), DEPLOYMENT.md.
- **Acceptance:** Lighthouse "installable" passes; a DM to an offline user produces a system notification on Android Chrome and on an iOS Home-Screen PWA within 5 s; clicking opens that channel; muted channels and DND produce nothing; unsubscribed/expired endpoints are pruned; tests cover subscription CRUD, targeting rules, and 410 pruning (with a stubbed push endpoint).

### P0-2. Missed-event recovery after reconnect — **S/M**
- **Why:** Mobile networks drop sockets constantly. The client re-identifies and rejoins rooms on reconnect (`src/App.jsx` ~L352), but messages sent while disconnected are only seen after a manual channel switch. Discord solves this with RESUME; Socket.IO has Connection State Recovery (RESEARCH §1, §4).
- **What:** enable `connectionStateRecovery` in `realtime.js` (2-min window); on `connect` with `socket.recovered === false`, the client refetches `GET /channels/:id/messages?after=<last id>` for the open channel and refreshes unread counts/inbox for others; merge by id (dedupe). Show a "Reconnecting…" banner after 3 s offline.
- **Files:** `realtime.js`, `src/App.jsx`, `src/api.js`, `services/messages.js` (confirm `after` path), tests in `scripts/`.
- **Acceptance:** e2e test: user B disconnects, A sends 3 messages, B reconnects → B sees all 3 in order without reload, no duplicates; unread badges correct.

### P0-3. TURN on by default, verified — **S**
- **Why:** 8–30% of WebRTC sessions need a relay. Code support exists (`/api/voice/ice-servers`, coturn compose profile) but it's opt-in and README still says "No TURN server is configured".
- **What:** make the `turn` profile part of the documented default path; `/api/ready` or startup warns loudly in production when `TURN_URLS` is unset; a `npm run turn:check` script that fetches credentials and does an ICE gather via a headless test; update README limitations.
- **Files:** `docker-compose.yml`, `lib/config.js`, `server.js`, `scripts/`, README.md, DEPLOYMENT.md.
- **Acceptance:** with `ICE_TRANSPORT_POLICY=relay`, a two-browser e2e call connects with audio; production boot without TURN logs a warning shown on the admin page (P0-5).

### P0-4. Registration controls and abuse prevention — **M**
- **Why:** Stoat's influx "acted like a DDoS"; open registration on a public instance invites spam bots. Email verification exists but is only enforced by per-server verification level.
- **What:**
  - `REGISTRATION_MODE=open|invite|closed` (default `invite` in production). `invite` requires a valid server invite or an instance invite code.
  - `REQUIRE_EMAIL_VERIFICATION=1`: unverified accounts can log in but only read and verify (no DMs, no joining public servers, no uploads).
  - Self-hosted proof-of-work captcha (ALTCHA-compatible challenge/verify, no third party) on register, password reset, and after N failed logins. Optional Turnstile via env for those who want it.
  - Per-account new-user limits: first 10 minutes — no links/attachments, low DM creation rate.
- **Files:** `routes/auth.js`, `lib/config.js`, new `lib/pow.js`, `src/components/LoginScreen.jsx`, `services/users.js`, `services/messages.js`, i18n, tests.
- **Acceptance:** scripted bulk registration of 100 accounts from one IP without solving PoW fails; with `invite` mode registration without a code returns 403; unverified user cannot send a DM; screen-reader users can complete PoW (it is invisible/automatic).

### P0-5. Instance admin console — **M**
- **Why:** Reports that aren't tied to a server, global bans, and file takedowns currently require `curl` with `x-admin-token` (`server.js` ~L1838). Spacebar's lack of an admin GUI is a known weakness. CSAM or illegal-content response must be minutes, not a shell session.
- **What:** `users.is_instance_admin` flag (first registered user or `ADMIN_USERS` env); `/admin` UI: open reports queue with context, global suspend/ban with reason (sessions revoked, sockets kicked), **purge file by content hash everywhere + block re-upload of that hash**, evidence preservation (export report + file hash to a restricted folder before purge), registration mode toggle, health (schema version, sockets, disk, backup age, TURN/push status). All actions audit-logged. Keep `ADMIN_TOKEN` for automation.
- **Files:** `services/reports.js`, new `services/instanceAdmin.js`, `storageService.js` (hash blocklist), `server.js`, `src/components/admin/*` (lazy-loaded), i18n, migration, tests.
- **Acceptance:** an admin can go from a report to "user banned + file purged + blocked hash" in ≤ 3 clicks; blocked hash re-upload is rejected; non-admins get 403 on every `/api/admin/*` route (tested).

### P0-6. Fan-out protection and load test — **S/M**
- **Why:** Stoat had to disable typing indicators and profile updates to survive its influx. Typing/presence/voice-state events are O(members) per event and in-process.
- **What:** per-socket rate limits on `typing_start`, presence updates, and voice signalling in `realtime.js`; presence broadcasts only to guilds with ≤ N online members or throttled/batched (1/s per guild); env kill-switches `DISABLE_TYPING`, `DISABLE_PRESENCE_BROADCAST`; a k6 or Artillery script (`scripts/load/`) with 1,000 sockets in one guild; metrics for events emitted/s and event-loop lag.
- **Files:** `realtime.js`, `lib/rateLimit.js`, `lib/middleware.js` (metrics), `scripts/load/`, DEPLOYMENT.md.
- **Acceptance:** documented numbers: p95 message delivery latency and event-loop lag at 500 and 1,000 connected sockets on a 2 vCPU box; a single client spamming `typing_start` cannot exceed 1 event/3 s.

### P0-7. Backups that are proven, plus incident runbook — **S**
- **Why:** backup scripts exist, but an untested backup is not a backup; PDPA requires breach notification to the PDPC within 72 h when feasible.
- **What:** scheduled backup in compose (sidecar cron or Litestream to S3), `backup:verify` runs a restore into a temp dir and checks schema + row counts; admin page shows last successful backup age (alert if > 26 h via `/metrics` gauge). `docs/INCIDENT.md`-style section in DEPLOYMENT.md: breach triage, PDPC 72 h/15-day rule, user notice template (TH/EN).
- **Files:** `docker-compose.yml`, `scripts/backup.mjs`, `lib/middleware.js`, DEPLOYMENT.md.
- **Acceptance:** CI job restores the latest test backup and boots the server against it; gauge `backup_last_success_timestamp` exported.

### P0-8. Privacy and data-rights completeness (PDPA/GDPR) — **S**
- **Why:** the operator is data controller; software must make compliance possible. Export and anonymising deletion exist (`services/dataRights.js`).
- **What:** operator-editable Privacy Policy / Terms / contact page (Markdown in DB, linked from login and settings; registration requires acceptance with timestamp stored); configurable retention for IP addresses in logs/sessions and for deleted-message tombstones; export also covers uploads index, sessions, reports filed, and consent records; audit-log entry when an admin views or exports someone else's data.
- **Files:** `services/dataRights.js`, `routes/auth.js`, new settings rows + migration, `src/components/LoginScreen.jsx`, `src/components/settings/PrivacyTab.jsx`, i18n.
- **Acceptance:** register flow records consent version; export JSON includes listed sections; retention job deletes IPs older than configured days (tested with fake clock).

---

## P1 — next, once P0 is live

| # | Item | Why (evidence) | What | Effort | Areas | Acceptance |
| --- | --- | --- | --- | --- | --- | --- |
| P1-1 | **Client performance: code-split + virtualize** | Vite warns main chunk > 500 kB; `App.jsx` 2.5k and `ChatArea.jsx` 1.8k lines, no virtualization; mobile is where users are. | `React.lazy` for settings, admin, voice, forum, emoji picker; windowed message list (keep scroll anchoring, jump-to-message); split `App.jsx` state into contexts/hooks. | M | `src/App.jsx`, `src/components/ChatArea.jsx`, `vite.config.js` | Initial JS < 300 kB gz; 10k-message channel scrolls at 60 fps on a mid-range Android; e2e still green. |
| P1-2 | **Optional LiveKit SFU** | Mesh cap 8; cameras practical only at 4–5. Stoat and Element Call both converged on LiveKit + JWT service + coturn. | `VOICE_BACKEND=mesh|livekit`; server mints LiveKit tokens after its own permission check (`CONNECT`, `SPEAK`, `STREAM`, stage speaker); client uses `livekit-client` when enabled; stage channels become real (audience subscribe-only); optional LiveKit E2EE. | L | `realtime.js`, `server.js`, `src/hooks/useVoicePeers.js`, `useVoiceMedia.js`, `docker-compose.yml` (profile) | 25-person room with 5 cameras on LiveKit profile; mesh unchanged when disabled; permission denial tested. |
| P1-3 | **AutoMod presets + profile scanning** | Discord ships maintained presets (with obfuscation handling) and "Block Words in Member Profile Names". | Bundled EN + TH preset lists (slurs, sexual, scam links) with leetspeak/zero-width normalisation; rule type `member_profile` on join/nickname/bio change; per-rule allow-list. | M | `services/automod.js`, `src/components/settings/AutoModTab.jsx`, i18n | Obfuscated variants (`s p a m`, Cyrillic homoglyphs, zero-width) are caught in tests; Thai list reviewed by a native speaker. |
| P1-4 | **User-facing enforcement notices + appeals** | Discord Warning System / DSA "statement of reasons". | When a user is timed out/kicked/banned/message removed by AutoMod, they get a system DM with rule + reason; server-level appeal form routed to the mod queue. | M | `services/reports.js`, `services/guildAdmin.js`, `services/automod.js`, UI | Actioned user sees reason; appeal appears in queue; all logged. |
| P1-5 | **Permission bits parity (2025–26)** | Discord split `PIN_MESSAGES` (1<<51), `BYPASS_SLOWMODE` (1<<52), added `SEND_POLLS`, `CREATE_EVENTS`, `USE_EXTERNAL_APPS`. | Add bits, migrate existing roles (grant where `MANAGE_MESSAGES` had them), enforce, expose in UI. | S | `lib/permissions.js`, `src/utils/permissionCatalog.js`, migration, services | Tests: pin without `PIN_MESSAGES` → 403; slowmode bypass only with new bit. |
| P1-6 | **Thai-aware text handling** | Thai has no word spaces; `Intl.Segmenter` is Baseline. | Use `Intl.Segmenter('th', {granularity:'word'})` for search-hit highlighting, composer ctrl+←/→, autocomplete token boundaries; grapheme-safe truncation in notifications/embeds; search query normalisation (Sara Am, NFC). | S | `src/utils/markdownParser.jsx`, `ComposerAutocomplete.jsx`, `lib/searchQuery.js`, notifier | Tests with Thai strings: truncation never splits a combining mark; highlight wraps whole words. |
| P1-7 | **Screen-reader pass** | Current a11y check is a static linter; WCAG 4.1.3 + ARIA `role="log"` technique. `ChatArea.jsx` has no `role="log"`. | Message list `role="log"` with name; announce new messages only for the focused channel; manual NVDA + VoiceOver script documented and run per release. | S/M | `ChatArea.jsx`, `ToastStack.jsx`, docs | Checklist signed off for send/read/reply/react/join voice with NVDA and VoiceOver. |
| P1-8 | **Business metrics + optional OpenTelemetry** | One node, but no visibility into fan-out, loop lag, WAL size. | Gauges/counters: sockets, events/s by type, event-loop lag, SQLite busy retries, WAL bytes, voice rooms/participants, push sent/failed. Optional `OTEL_EXPORTER_OTLP_ENDPOINT` using `@opentelemetry/auto-instrumentations-node` + socket.io instrumentation. Example Grafana dashboard JSON. | S/M | `lib/middleware.js`, `realtime.js`, `docs/` | Dashboard shows all gauges under load test (P0-6). |
| P1-9 | **Media pipeline polish** | Common UX expectations; privacy (GPS in EXIF). | Verify EXIF strip on every image path (not only when sharp resizes); video poster frame + duration (ffmpeg optional); blurhash placeholder; `Cache-Control: public, max-age=31536000, immutable` for content-addressed paths; CDN notes. | M | `storageService.js`, `routes/files.js`, `lib/mediaProbe.js` | Uploaded JPEG with GPS returns without GPS; hashed paths carry immutable caching. |
| P1-10 | **Security hardening follow-ups** | `npm audit` 13 advisories; CSP `style-src 'unsafe-inline'`. | Resolve/justify advisories (consider `better-sqlite3` or `node:sqlite` to drop the `sqlite3` build chain); `Cross-Origin-Resource-Policy` on uploads; CSP `report-to` endpoint (rate-limited); passkeys (WebAuthn) as a 2FA option. | M | `package.json`, `db.js`, `lib/middleware.js`, `routes/accountSecurity.js` | `npm audit --omit=dev` clean or each item documented; passkey login e2e. |

---

## P2 — valuable, not urgent

- **Discord import** (M/L): import a server's channel/role structure (and optionally message history via a user's own data package) to lower the network-effect barrier. Structure only first; history is legally and technically messy.
- **Meilisearch backend** (M): only if users report bad Thai search ranking; FTS5 trigram stays default. Must filter by the searcher's channel permissions server-side.
- **Horizontal scale path** (L): Postgres + Socket.IO Redis Streams adapter (supports connection-state recovery) + shared rate limits. Do this only when P1-8 metrics show one node saturating.
- **"Catch up" view** (M): Zulip-style unread-by-thread/topic summary across servers.
- **Activities-lite** (M): sandboxed iframe apps in voice channels with a tiny postMessage API; only after bots API stabilises.
- **Scheduled messages, message drafts sync, reminders** (S each).
- **Litestream PITR as default** (S), once P0-7 cron path is proven.
- **UnifiedPush / native wrapper** (L): only if PWA limits on iOS prove a real blocker.

---

## What this project should NOT attempt

| Don't | Why |
| --- | --- |
| Discord API/gateway compatibility | Spacebar has chased it for years and still isn't compatible; Discord changes permissions and endpoints monthly. Keep our own documented bot API. |
| Federation | Matrix shows the cost (Synapse RAM, state resolution, moderation across servers). Not what community admins ask for. |
| Text E2EE | Breaks search, moderation, AutoMod, and reports — the features that make community chat workable. Discord itself doesn't do it. |
| Home-grown DAVE / media E2EE on mesh | Mesh is already peer-to-peer DTLS-SRTP. If E2EE via SFU is wanted, use LiveKit's. |
| Native iOS/Android apps | Two more codebases and vendor push gateways (Rocket.Chat/Mattermost pain). PWA + Web Push covers notifications. |
| In-house CSAM hash matching / ML moderation | Hash lists (NCMEC) aren't available to small operators; PDQ without a list is useless. Document Cloudflare's CSAM Scanning Tool; give admins fast purge + hash-block. |
| ID-based age verification | The very thing users are fleeing; high breach liability. Offer an operator-set minimum age at signup and NSFW gates. |
| Monetisation (Nitro/boosts/shop) | No self-hoster needs it; schema columns can stay dormant. |
| Premature Postgres/Kubernetes | Adds ops burden (Rocket.Chat/MongoDB lesson) before there is evidence of need. |

---

## Ranked summary (top 10 across P0/P1)

1. P0-1 PWA + Web Push
2. P0-2 Missed-event recovery after reconnect
3. P0-3 TURN on by default, verified
4. P0-4 Registration modes + email verification + self-hosted PoW captcha
5. P0-5 Instance admin console (reports, global ban, hash purge/block)
6. P0-6 Fan-out rate limits, kill-switches, load test
7. P0-7 Proven backups + breach runbook (PDPA 72 h)
8. P0-8 Privacy policy/consent/retention
9. P1-1 Code-split + virtualized message list
10. P1-2 Optional LiveKit SFU
