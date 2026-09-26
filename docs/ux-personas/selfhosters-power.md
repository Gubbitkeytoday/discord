# UX persona study: self-hosters and power users

Group: `selfhosters-power` · Branch under test: `worktree-agent-a10f2e0db07a311f9` with `claude/dreamy-goldberg-p3o5ao` merged (HEAD `93e4ea6`) · Date: 2026-09-26
Scenario script: `scripts/ux/selfhosters-power.mjs` (Playwright, run against a live server) · Screenshots: `/tmp/claude-0/-home-user-discord/663d99e8-07c9-5b0f-8b1a-38c6a8c33dc1/scratchpad/shots/persona-selfhosters-power-*.png`

## สรุปภาษาไทย

- **ภาพรวม:** ตัวแอปใช้แชตได้ดีจริง ติดตั้งแบบ bare-metal จาก clone ใหม่ใช้เวลาเครื่องประมาณ 70 วินาที (`npm ci` 35 วิ, `npm run build` 26 วิ, บูตครั้งแรก 4 วิ) ส่วนตั้งแต่เปิดหน้าเว็บจนเพื่อนเห็นข้อความแรกใช้ **15 วินาที** และตัวแอปไม่เรียก host ภายนอกเลยสักตัว (ไม่มี Google Fonts หรือ analytics) แต่เอกสารกับค่าเริ่มต้นมีกับดักที่ทำให้ผู้ติดตั้งมือใหม่พังได้ง่าย
- **ปัญหาร้ายแรงที่สุด (S1):** ถ้าเปิดผ่าน `http://IP-ในบ้าน` ในโหมด production ค่า `SECURE_COOKIES` จะเปิดอยู่เป็นค่าเริ่มต้น เบราว์เซอร์จึงทิ้งคุกกี้ไปเงียบ ๆ สมัครสมาชิกดูเหมือนสำเร็จ แต่พอรีเฟรชก็หลุดกลับไปหน้าล็อกอิน และไม่มีข้อความบอกสาเหตุเลย
- **S1 สำหรับ Synology (คุณนิรันดร์):** Caddy ใน compose ต้องใช้พอร์ต 80/443 ซึ่ง DSM จองไว้แล้ว เอกสารไม่พูดถึง Synology, การ forward พอร์ตที่เราเตอร์ หรือ reverse proxy ของ DSM เลย นอกจากนี้ image ต้อง build บน NAS เอง (คอมไพล์ sqlite3 และรัน Vite) เพราะไม่มี image สำเร็จรูปให้ดึง
- **S2 เรื่องสำรองข้อมูล:** คำสั่ง backup ใน Docker (`docker compose exec app node scripts/backup.mjs …`) ใช้ไม่ได้กับ PostgreSQL ซึ่งเป็นค่าเริ่มต้น เพราะใน image ของแอปไม่มี `pg_dump` (ตรวจแล้ว)
- **S2 เอกสารขัดกันเอง:** README บอกว่ายังไม่มี TURN/passkeys และรันได้เครื่องเดียว แต่ DEPLOYMENT.md กับโค้ดมีครบ คำสั่ง `npm run seed` ก็ไม่ได้ seed อะไรเลย
- **ผู้ใช้คีย์บอร์ด (Eve):** Ctrl+K, Alt+↑/↓, Alt+Shift+↓, แก้ข้อความด้วยลูกศรขึ้น, slash command, การเปลี่ยนคีย์ลัด และตัวกรองค้นหาส่วนใหญ่ใช้ได้ แต่ Ctrl+F (ที่ป้ายเขียนว่า "Search") กลับเปิด quick switcher, quick switcher หาช่องของเซิร์ฟเวอร์อื่นไม่เจอ, เลื่อนไปทีละข้อความด้วยคีย์บอร์ดไม่ได้, `/shrug` แขนหาย และไม่มีการเลือกข้อความหลายอันพร้อมกัน
- **คะแนนเฉลี่ย "จะแนะนำต่อไหม":** Sam 5/10, Niran 3/10, Eve 5/10 ยังไม่มีใครย้ายจาก Discord/Matrix เพราะขาด push notification/แอปมือถือ และ E2EE

---

## 1. Personas

| | **Sam** | **Niran (นิรันดร์)** | **Eve** |
| --- | --- | --- | --- |
| Age / gender | 33, non-binary | 45, man | 29, woman |
| Occupation | Backend developer, privacy-focused | IT admin at a 25-person Thai company (accounting + logistics) | Frontend engineer |
| Tech literacy | Expert (runs Nextcloud, Vaultwarden, Jellyfin at home) | Medium: Windows admin; uses Synology DSM GUI and Container Manager; copies Linux commands from blogs | Expert, keyboard-first (Vim, Slack/Discord shortcuts, Raycast) |
| Device | ThinkPad on Linux (Firefox/Chromium), 1366×768; home server on the LAN | Synology DS920+ (DSM 7.2, 8 GB RAM, Container Manager); Windows desktop; staff use LINE plus a few phones | Desktop 1920×1080, 32" monitor, mechanical keyboard |
| Language | English | Thai first, reads technical English slowly | English |
| Accessibility | none | Reading glasses; prefers Thai UI | Hates reaching for the mouse (RSI) |
| Uses today | Signal, Matrix/Element (tried), Discord (hates it) | LINE groups, Microsoft Teams (licence cost), Synology Chat | Slack at work, Discord for communities, Linear |
| Goal | Replace Discord for a 12-person friend group. Wants self-hosting, no tracking, and a quick install | Internal chat for staff on the office NAS: TLS, backups, upgrades without a consultant | Decide whether this can be a daily driver: jump, triage unreads, write code snippets and search without the mouse |

## 2. Method

- **Sam:** made a fresh clone of the branch (`git clone <worktree> scratchpad/sam-clone`) and followed the README cold. First the dev Quickstart verbatim in another clone (`devqs-clone`), then "Minimal bare-metal run" with `NODE_ENV=production` on port 7080 and SQLite. The site was opened (a) through the LAN IP `http://192.0.2.2:7080` and (b) through `http://localhost:7080`. The friend used a second browser context (Pixel 7, 412×915, touch).
- **Niran:** fresh clone (`niran-clone`), followed DEPLOYMENT.md §2 literally (`cp .env.example .env`, appended the "at minimum" block), then ran `docker compose config`, and `docker compose up -d --build`. The image build failed on sandbox egress policy: plain-HTTP `deb.debian.org` is blocked here, which is not an app bug. So the stack was checked piece by piece:
  - Caddyfile validated with `caddy validate` in `caddy:2-alpine`
  - PostgreSQL 16 first boot against the app (worked: schema created, `🐘 Connected to PostgreSQL`)
  - `pg_dump` checked for in `node:22-bookworm-slim`, the runtime base image (absent)
  - `db/seed.js` run as documented
- **Eve:** Chromium at 1920×1080, 2 servers × 5 channels, plus a second user (Finn) creating unreads. Every step was done with the keyboard where possible.

## 3. Task results

| # | Persona | Task | Result | Time | Clicks | Worst issue |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | Sam | Dev Quickstart verbatim (`npm ci`, `cp .env`, `npm run seed`, `npm run server`) | ✅ (seed step is a no-op) | ~45 s machine | – | S3 `npm run seed` writes a 0-byte DB and seeds nothing; the server auto-seeds instead |
| 2 | Sam | Prod bare-metal: `npm ci` + `npm run build` + `.env` + `npm start` | ✅ | 35 s + 26 s + 4 s boot | – | Refusal message is excellent (names each variable and gives the `openssl` command) |
| 3 | Sam | Open via LAN IP over http, register, reload | ❌ **silent logout** | 7 s | 2 | **S1** Secure cookie dropped over http; the UI shows the app, then the session is gone on reload |
| 4 | Sam | Localhost: land, understand what this is | ⚠️ | 2 s | 0 | S3 A first-time visitor sees "Welcome back! Good to see you again"; there is no product name or description |
| 5 | Sam | Register first account: any admin/owner setup? | ⚠️ | 4 s | 2 | S2 No instance admin, no way to close sign-ups, no user list |
| 6 | Sam | Create server | ✅ | 2.4 s | 3 | – (invite dialog opens automatically, nice) |
| 7 | Sam | Get invite link | ✅ | 0.2 s | 0 | – |
| 8 | Sam | Friend (phone) opens invite, registers, joins | ✅ | 5.4 s | 3 | S3 Logged-out invite page says "Welcome back!" and doesn't name the server or inviter until after sign-up |
| 9 | Sam | Time to first message (landing → friend sees it) | ✅ **15 s** | 0.8 s send | 0 | – |
| 10 | Niran | `cp .env.example .env` + edit + `docker compose config` | ✅ | – | – | S3 The `POSTGRES_PASSWORD` `:?` guard never fires because the example ships `change-me-too` |
| 11 | Niran | `docker compose up -d --build` on a Synology NAS | ❌ (predicted) / not runnable here | – | – | **S1** Caddy needs host 80/443, which DSM already uses; nothing in the docs covers it |
| 12 | Niran | TLS / domain | ⚠️ | – | – | S2 No DDNS, router port-forward or DSM reverse-proxy guidance |
| 13 | Niran | TURN for staff on 4G | ⚠️ | – | – | S2 Docs contradict each other; `TURN_EXTERNAL_IP` is described as "only cloud VMs" but is also needed behind a home/office router |
| 14 | Niran | Backups (Docker + default Postgres) | ❌ | – | – | **S2** The documented `docker compose exec app node scripts/backup.mjs create` needs `pg_dump`, which the app image lacks |
| 15 | Niran | Upgrades | ⚠️ | – | – | S3 `git pull` (DSM has no git by default); no tagged releases, prebuilt image or changelog |
| 16 | Niran | PostgreSQL first boot | ✅ | 4 s | – | – |
| 17 | Niran | Thai UI | ✅ | – | – | – (renders cleanly, see `niran-home-th.png`) |
| 18 | Eve | Ctrl+K → channel in **another** server | ❌ | 1.4 s | 1 | S2 Switcher only indexes the current server's channels |
| 19 | Eve | Ctrl+K → channel in current server → Enter | ✅ | ~2 s | 1 | S3 Focus lands on the server-rail button, not the composer |
| 20 | Eve | Alt+↑/↓ channel nav | ✅ | <1 s each | 0 | – |
| 21 | Eve | Alt+Shift+↓ next unread | ✅ | <1 s | 0 | – |
| 22 | Eve | Markdown (bold/italic/underline/strike/inline/code block/quote/list/heading/masked link/spoiler) | ✅ 11/12 | – | 0 | S4 No syntax highlighting in ```` ```js ```` blocks (Copy button present) |
| 23 | Eve | `/` menu → Tab-complete `/shrug` → Enter | ⚠️ | 3.5 s | 0 | S3 Output renders as `¯\(ツ)/¯`: the arms are eaten by the italic parser |
| 24 | Eve | ↑ on empty composer edits last; Enter saves; Esc cancels | ✅ | – | 0 | – |
| 25 | Eve | Ctrl+F for message search | ❌ | – | 0 | **S2** Ctrl+F (labelled "Search") opens the quick switcher |
| 26 | Eve | Search operators in header box | ✅ mostly | ~1 s per query | 1 | S3 `before:tomorrow` and `during:today` give 0 results with no hint; no operator autocomplete; results not arrow-navigable |
| 27 | Eve | Keyboard navigation through messages (reply/react/edit without mouse) | ❌ | – | – | S2 Message rows are not focusable (0 rows with `tabindex`) |
| 28 | Eve | Ctrl+/ shortcut sheet | ✅ | 1 s | 0 | – (clear, grouped, links to customize) |
| 29 | Eve | Rebind quick switcher to Ctrl+J | ✅ | 6 s | 3 | S3 Recording the new chord also fires it (switcher opens on top of Settings) |
| 30 | Eve | Bulk: Shift+Esc mark all read; multi-select messages to delete | ⚠️ | – | – | S3 Mark-all-read works; no multi-select or bulk delete |

Search operator results (6 "needle" messages across 2 channels): `from:` ✅, `from:@` ✅, `in:backend` / `in:#backend` ✅, `has:link` ✅, `after:2020-01-01` ✅, `before:2020-01-01` ✅ (0, correct), `during:2026-09-26` ✅, `during:today` ❌ 0, `before:tomorrow` ❌ 0.

## 4. Ranked issues

### S1: blockers

**S1-1. Production over plain http logs the user out silently (Sam; anyone testing on a LAN before TLS)**
- **What happened:** following the README "Minimal bare-metal run" with `PUBLIC_URL=http://192.0.2.2:7080`, registration *looked* successful and the app shell rendered (`sam-lan-register.png`). No cookie was stored. On reload the user was back at "Welcome back!" (`sam-lan-after-reload.png`). The console showed only 401s. `lib/config.js` defaults `secureCookies` to `isProduction`, so even leaving `SECURE_COOKIES` unset triggers this.
- **Sam:** "It let me in and then forgot me. No error, nothing in the server log. I'd assume the session code is broken and uninstall."
- **Root cause:** a `Secure` cookie over http is rejected by the browser, and neither the server nor the client detects it.
- **Fix:**
  1. `lib/config.js`: when `secureCookies && !PUBLIC_URL.startsWith('https://')` and the host is not localhost, print a *red* line: "SECURE_COOKIES is on but PUBLIC_URL is http:// — browsers will drop the session cookie and every login will silently fail. Put TLS in front, or set SECURE_COOKIES=0 for a LAN test."
  2. `src/components/LoginScreen.jsx`: after a 2xx from `/api/auth/login` or `/api/auth/register`, call `GET /api/auth/me`. On 401, show inline: "Signed in, but your browser refused the session cookie. This server requires HTTPS — open it via https://… or ask the admin to set SECURE_COOKIES=0 for local testing."
  3. README "Minimal bare-metal run": add a line, "Testing on a LAN without TLS? Also set `SECURE_COOKIES=0` and `PUBLIC_URL=http://<lan-ip>:3001`."

**S1-2. Compose stack cannot start on a Synology NAS as documented (Niran)**
- **What happened:** `docker-compose.yml` publishes Caddy on host `80:80`, `443:443` and `443:443/udp`. DSM's own nginx holds 80/443, so `caddy` fails with "address already in use". DEPLOYMENT.md never mentions NAS devices, router port forwarding, or DSM's built-in reverse proxy and Let's Encrypt.
- **Niran:** "ทำตามทุกบรรทัดแล้ว แต่ container caddy ขึ้นสีแดง ผมไม่รู้ว่าพอร์ตชนกับ DSM" ("I followed every line, but the caddy container is red. I didn't know the port clashes with DSM.")
- **Root cause:** the compose file assumes a dedicated VM that owns ports 80/443.
- **Fix:**
  1. `docker-compose.yml`: publish `"${HTTP_PORT:-80}:80"`, `"${HTTPS_PORT:-443}:443"`, and an opt-in `app` port `"${APP_PUBLISH:-127.0.0.1:3001}:3001"` under a `no-caddy` profile.
  2. DEPLOYMENT.md: add a "§2b NAS (Synology/QNAP)" section with two paths. (a) DSM reverse proxy (Control Panel › Login Portal › Advanced › Reverse Proxy, with a WebSocket custom header) → `127.0.0.1:3001`, a Let's Encrypt certificate from DSM, and `TRUST_PROXY=1`. (b) Caddy on 8443 plus a router forward of 443→8443.
  3. Add the `.synology.me` DDNS example for `DOMAIN`.

### S2: major

**S2-1. Docker backup instructions fail on the default (PostgreSQL) stack (Niran)**
- **What happened:** DEPLOYMENT §6 "In Docker" says `docker compose exec app node scripts/backup.mjs create --files`. With `DATABASE_URL` set (the compose default), `scripts/backup.mjs` shells out to `pg_dump`. `node:22-bookworm-slim` has none (verified: `no pg_dump in runtime base image`), so it errors with "pg_dump not found". The restore line still shows a `.db` file.
- **Root cause:** the backup docs predate the Postgres default.
- **Fix:**
  1. `Dockerfile` runtime stage: `apt-get install -y --no-install-recommends postgresql-client-16` from the PGDG repo, or copy `pg_dump`/`pg_restore` from `postgres:16-alpine`.
  2. Or rewrite the §6 Docker block to use the `postgres` container (`docker compose exec -T postgres pg_dump …`) plus a separate files copy.
  3. Show `.dump` in the restore example.
  4. For Synology, recommend bind mounts (`./data:/data`) so Hyper Backup can see them; named volumes hide under `/volume1/@docker`.

**S2-2. Docs contradict each other on TURN, passkeys and scaling (Sam, Niran; trust)**
- **What happened:**
  - README "Known limitations" says "No TURN server is configured… there is no environment variable for this yet", "2FA … no passkeys", and "Single node … You cannot run two instances".
  - DEPLOYMENT §4 says `/api/voice/ice-servers` "has to be implemented in server.js … Until it exists, only the VITE_ICE_SERVERS fallback can carry TURN".
  - The code has `TURN_URLS`/`TURN_SECRET` (server.js:1553, `.env.example`), passkeys (DEPLOYMENT §12) and `REDIS_URL` scaling (§8).
  - Also stale: "schema versions (currently 17)" (actually 36), "English and Thai" (31 locale files in `src/i18n/locales`), and `DEFAULT_LOCALE … Available: en, th` in `.env.example`.
- **Sam:** "If the README is wrong about TURN, what else is it wrong about? Now I have to read the source."
- **Fix:** update README "Status and limitations", the "Compared with Discord" rows (TURN: env-configurable; passkeys: present; multi-instance: with Redis), the locale list and the schema version. Delete the "Server support … has to be implemented" note in DEPLOYMENT §4. A CI check that greps README for `schema versions (currently N)` against `SCHEMA_VERSION` would stop it drifting again.

**S2-3. No instance-level admin or sign-up control (Sam)**
- **What happened:** the first account is an ordinary user. There is no admin panel, no "invite-only registration", and no user list or delete. `ADMIN_TOKEN` only unlocks two API endpoints. Anyone who finds the URL can register, create servers and upload files.
- **Sam:** "For a friend group I want the door locked. Right now the whole internet can sign up on my box."
- **Fix:**
  1. Env `REGISTRATION=open|invite|closed` (default `invite` in production), enforced in `routes/auth.js`: register requires a valid invite code when `invite`.
  2. `LoginScreen.jsx`: hide "Sign up" unless arriving via `/invite/:code`, and show "Registration is invite-only on this server."
  3. Make the first registered account `instance_admin` and add a minimal "Instance" tab in `src/components/UserSettingsModal.jsx` with users, disable/delete, storage usage and registration mode.

**S2-4. Ctrl+F opens the quick switcher, not message search (Eve)**
- **What happened:** the shortcut sheet lists "Search Ctrl + F", but `App.jsx` maps `search: () => setShowQuickSwitcher(true)`. Eve typed `from:finn` into the channel jumper and got "Nothing matched" (`eve-ctrl-f.png`).
- **Fix:** in `src/App.jsx`, have `search` focus the header search input (expose a ref or signal from `src/components/ChatArea.jsx`: `searchInputRef.current?.focus(); select()`). On mobile, open the mobile search sheet.

**S2-5. Quick switcher can't reach channels in other servers (Eve)**
- **What happened:** from "Games", Ctrl+K → "back" returned "Nothing matched" although #backend exists in "Work" (`eve-quickswitcher-cross-server.png`). Only the active server's `channels` are passed in.
- **Fix:** in `src/App.jsx`, pass a flattened `allChannels` list (every guild's text/voice/forum channels the user can see, with the guild name as `hint`) to `src/components/QuickSwitcher.jsx`, and on pick call `setActiveServerId(guildId)` before `pickChannel`. Also:
  - Support Discord's prefixes: `*` servers, `#` text channels, `@` DMs, `!` voice.
  - Rank unread/mentioned entries first on an empty query.
  - After a pick, focus the composer: `requestAnimationFrame(() => document.getElementById('message-composer')?.focus())`.

**S2-6. Messages are not keyboard-navigable (Eve)**
- **What happened:** Shift+Tab from the composer reaches "Formatting", then "Upload". No message row has `tabindex`, so reply, react, pin or delete need the mouse or a right-click (`eve-message-focus.png`).
- **Eve:** "Discord lets me hit ↑ from the list and then R to reply. Here I have to grab the mouse every single time."
- **Fix:** in `src/components/ChatArea.jsx` (message list):
  - Use a roving `tabindex` on message rows (`tabIndex={i === focused ? 0 : -1}`, `role="article"`, `aria-label` = author + time), with ↑/↓ moving focus, Home/End, and Escape back to the composer.
  - Per-message keys, as in Discord: `R` reply, `E` edit (own), `+` react, `P` pin, `T` thread, `Backspace`/`Delete` delete (with confirm, Shift to skip), `Ctrl+C` copy text.
  - Add a "Messages" group to `src/components/settings/KeybindsTab.jsx` so the keys appear in Ctrl+/.

**S2-7. TURN guidance is wrong for on-prem (Niran)**
- **What happened:** DEPLOYMENT §4 says `TURN_EXTERNAL_IP` is "Only on cloud VMs with 1:1 NAT", and only mentions the "cloud security group". A NAS behind an office router is also 1:1-NAT'd: it needs `TURN_EXTERNAL_IP=<public>/<nas-lan-ip>` and router forwards for 3478/udp+tcp and 49160-49200/udp. The `.env.example` sample uses `turns:…:5349`, but the coturn service has no certificate configured, so `turns:` can never work.
- **Fix:**
  - DEPLOYMENT §4: "Behind any NAT (cloud VM **or** home/office router) set `TURN_EXTERNAL_IP=public/private` and forward these ports on the router."
  - `.env.example`: change the sample to `turn:…:3478?transport=udp,turn:…:3478?transport=tcp`, and remove `--tls-listening-port=5349` from `docker-compose.yml` until certs are mounted.
  - Add an admin-visible "TURN reachable?" check in Server Settings › Voice that runs an ICE gather with `iceTransportPolicy: 'relay'`.

**S2-8. No prebuilt image; the NAS must compile everything (Niran)**
- **What happened:** the Dockerfile runs `npm ci`, `npm rebuild sqlite3 --build-from-source` and the Vite build. On a 2–4 GB NAS this takes many minutes, and on ARM or 1 GB models it risks OOM. Container Manager shows only "building…". README's own status table says "Docker image … **not verified**", which kills Niran's confidence.
- **Fix:** publish multi-arch images (`ghcr.io/<owner>/antigravity:<version>`, linux/amd64 and arm64) from CI, switch `docker-compose.yml` to `image:` with `build:` as the fallback, and add tagged releases plus a `CHANGELOG.md` so "upgrade" means changing a tag rather than running `git pull`.

### S3: minor

- **S3-1. `npm run seed` / `docker compose exec app node db/seed.js` do nothing.** `db/seed.js` exports `seedDatabase` but has no entry point, so it just opens (and creates) an empty DB file. Fix: add a `if (import.meta.url === pathToFileURL(process.argv[1]).href)` block that calls `initDB({ seed: true })`, refuse under `NODE_ENV=production` unless `--force`, and warn that the seeded password is public. Update README ("5 demo accounts") and DEPLOYMENT ("six accounts") to agree.
- **S3-2. Login page greets strangers with "Welcome back!"** No product name, no description, and `<title>` is only "Antigravity" (`sam-first-load.png`). Fix in `src/components/LoginScreen.jsx`:
  - When there is no remembered username, use "Sign in to {instanceName}" and a one-line description.
  - On `/invite/:code` while logged out, show the invite card (server name, icon, inviter, member count) *above* the form with **Create account** as the primary button. The card already exists in `InviteJoinScreen.jsx` after login.
- **S3-3. Home button uses Discord's real logo mark** (`sam-after-register.png`, `ServerRail.jsx:161`). A privacy-minded self-hoster reads this as legal risk ("will this repo vanish after a DMCA?"). Fix: use the app's own `public/favicon.svg` bubble mark in `src/components/ServerRail.jsx`.
- **S3-4. `/shrug` renders `¯\(ツ)/¯`.** In `src/utils/slashCommands.js` the content is `¯\_(ツ)_/¯`, and the Markdown renderer treats `_(ツ)_` as italics. Fix: emit a markdown-escaped form, literal `¯\\\_(ツ)\_/¯` (JS string `'¯\\\\\\_(ツ)\\_/¯'`). Apply the same escaping to `/tableflip` and `/unflip`, and add a render test.
- **S3-5. Natural-language dates silently return nothing.** `before:tomorrow` and `during:today` → 0 results. Fix in `lib/searchQuery.js`: accept `today`, `yesterday`, `tomorrow` and `YYYY-MM`. For anything unparseable, return a `warnings` array and show "Didn't understand date 'x', use YYYY-MM-DD" in `src/components/SearchResultsPanel.jsx`.
- **S3-6. Search UX for keyboard users.**
  - No operator autocomplete in the header input (typing `from:` suggests nothing).
  - Results can't be navigated with ↓/Enter.
  - Matches are not highlighted.
  - The input is 144 px wide.

  Fix in `src/components/ChatArea.jsx` (header search):
  - Add a popover listing `from: mentions: has: in: before: after: during: pinned:`, with member/channel suggestions once an operator is typed.
  - Make ↓ move into `SearchResultsPanel.jsx` results (`role="listbox"`), with Enter jumping to the message.
  - Wrap matches in `<mark>`.
- **S3-7. Recording a keybind also triggers it.** Pressing Ctrl+J while recording opened the switcher over Settings (`eve-keybinds-after.png`). Fix: in `src/components/settings/KeybindsTab.jsx` `capture()`, call `event.preventDefault(); event.stopPropagation()`. In `src/hooks/useKeybinds.js`, ignore events while `document.querySelector('[data-capturing-keybind]')` exists.
- **S3-8. Warning noise on a correct config.** Booting with the documented `CORS_ORIGIN=` prints "⚠️ CORS_ORIGIN is unset…", which is the recommended value. Fix: downgrade it to info (or drop it) in `lib/config.js` when `SERVE_STATIC=1`.
- **S3-9. `POSTGRES_PASSWORD` guard is defeated.** `.env.example` sets `POSTGRES_PASSWORD=change-me-too`, so `${POSTGRES_PASSWORD:?…}` never trips. Fix: leave it empty in `.env.example` (`POSTGRES_PASSWORD=`) so compose refuses with the helpful message. Also `LOG_LEVEL=debug` from `.env.example` leaks into production compose; default it to `info` when `NODE_ENV=production`.
- **S3-10. No multi-select or bulk delete for moderators.** The context menu has 10 items but no "Select messages". Discord lacks it natively (bots do it), but Rocket.Chat's "Prune messages" covers it. Fix: add "Select" mode to `src/components/MessageContextMenu.jsx`, with checkboxes and a bulk bar (delete up to 100 through a new `POST /api/channels/:id/messages/bulk-delete`).
- **S3-11. Google STUN is the default** (`useVoicePeers.js:39`, `.env.example`). This leaks every caller's IP to Google, which is exactly what Sam is escaping. Fix: in `.env.example`, recommend running coturn for STUN too (`STUN_URLS=stun:chat.example.com:3478`), and say plainly in README that the default contacts Google.

### S4: polish

- No syntax highlighting in fenced code blocks, although the language label "JS" and a Copy button are shown (`eve-markdown-rendered.png`). Use a lazy-loaded highlight.js or Shiki in the message renderer.
- Slash-command and quick-switcher rows have no `role="option"` or `aria-selected` (screen readers and test tooling can't see the selection).
- The context menu doesn't show keyboard hints next to its items (Discord shows none either, but Slack does), which would help people learn the shortcuts.

## 5. What delighted them

- **Sam:** the production refusal message. It names every unsafe variable, explains why, and gives the exact `openssl rand` command. "That's better than most commercial software." The SPA contacts **zero** third-party hosts (checked: no fonts, analytics or CDN). Landing to first message took 15 s, and the invite dialog pops up automatically after creating a server. The README is honest about limitations, even where it is out of date.
- **Niran:** the Thai UI is complete and renders cleanly (`niran-home-th.png`), and the README starts with a Thai summary. PostgreSQL first boot "just worked" with migrations. The compose file is heavily commented, and the coturn wrapper refuses to start an open relay.
- **Eve:**
  - Ctrl+/ shortcut sheet, grouped, with "Change shortcuts" one click away.
  - Every shortcut is rebindable, with conflict detection.
  - Alt+Shift+↓ unread jumping and ↑-to-edit.
  - The slash menu shows descriptions and "Tab or Enter to select".
  - Full Discord markdown, including headings, lists and masked links.
  - Search chips (channel, author, has-file) next to the operator syntax.

## 6. Scores (1–10)

| Persona | First impression | Ease of use | Visual appeal | Trust / safety | Would recommend |
| --- | --- | --- | --- | --- | --- |
| Sam | 6 | 6 | 7 | 5 | 5 |
| Niran | 5 | 3 | 7 | 5 | 3 |
| Eve | 7 | 6 | 7 | 6 | 5 |

## 7. Would they switch?

- **Sam, compared with the alternatives:**
  - **Discord:** yes on principle (no tracking, no third-party calls), but the friend group would revolt without push notifications or a mobile app (README: "No push notifications, no native mobile/desktop apps, no PWA manifest").
  - **Matrix/Element:** loses on E2EE (messages stored in plaintext), which is the one thing a privacy person wants, and has no mobile apps. Wins massively on familiarity and install speed: Synapse plus Element is hours of work, this is minutes.
  - **Revolt/Stoat:** the closest competitor (Discord-like, self-hostable with docker compose, has mobile clients). This app has richer moderation and permissions, but no mobile client and no instance admin.
  - **Verdict:** "I'd run it for a weekend LAN party group. I won't move my friends until there's a PWA with web push and invite-only registration."
- **Niran, compared with LINE/Teams/Rocket.Chat/Synology Chat:** Synology Chat is already one click in Package Center, with mobile apps and DSM accounts. Rocket.Chat has LDAP/AD, mobile apps and a documented Synology path. This app needs manual port juggling, has no LDAP/SSO, and has a backup story that fails on the default stack. **Verdict:** "Not yet. If there were a ready image and a Synology page in Thai, I would test it."
- **Eve, compared with Slack/Discord:** about 70% keyboard parity. Missing cross-server Ctrl+K, message-level keyboard focus, and the Ctrl+F mapping, and those are her three most-used flows. Markdown and slash commands are on par with Discord. **Verdict:** "Fix S2-4/5/6 and I'd use it for a side-project community. As a Slack replacement at work, no: no threads-in-sidebar triage view, no SSO and no mobile push."

## 8. Reproduce

```bash
# boot (production, SQLite, throwaway dirs) like scripts/e2e/run.mjs, on port 7080, then:
UX_BASE=http://localhost:7080 UX_LAN=http://<lan-ip>:7080 node scripts/ux/selfhosters-power.mjs all
```
