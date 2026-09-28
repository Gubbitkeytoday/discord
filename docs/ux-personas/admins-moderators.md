# UX persona panel: admins and moderators

## สรุปภาษาไทย

เราทดสอบแอปกับผู้ดูแล 3 แบบ: **ณัฐ** (แอดมินคอมมูนิตี้เกมไทย 5,000 คนที่ย้ายมาจาก Discord), **ปรียา** (ผู้ดูแลโปรเจกต์โอเพนซอร์สจากอินเดีย) และ **คาร์ลอส** (ครูสอนออนไลน์ ภาษาสเปน es-419) โดยใช้ Playwright บนเซิร์ฟเวอร์จริง ปิด dev identity และจำลองการบุก (raid) ด้วยบัญชีใหม่ 10 บัญชีผ่าน API

**ภาพรวม:** หน้าตั้งค่าเซิร์ฟเวอร์ครบและดูเหมือน Discord มาก บทบาท, สิทธิ์ช่องแบบ ✕ / – / ✓, AutoMod, การต้อนรับสมาชิกใหม่, สถิติ, webhook, ฟอรัมพร้อมแท็ก และ stage ใช้งานได้จริง ฟอนต์ไทยก็แสดงผลสวย แต่พอถึงเครื่องมือด้านความปลอดภัยที่ต้องใช้ตอนเกิดเหตุจริง หลายอย่าง **"ดูเหมือนทำงาน แต่ไม่ได้ทำงาน"**:

1. **ปุ่ม "ล็อกทันที" ไม่ได้ล็อก** ถ้ายังไม่ได้ติ๊ก "เปิดการป้องกัน" ไว้ก่อน บัญชีใหม่ยังเข้าเซิร์ฟเวอร์ได้ ทั้งที่หน้าจอแสดงว่า "เซิร์ฟเวอร์ถูกล็อกอยู่" (S1)
2. **ชื่อห้องภาษาไทยเพี้ยน** เพราะระบบตัดสระบน สระล่าง และวรรณยุกต์ทิ้ง ตั้งชื่อว่า "ข่าวสาร อัปเดต" ได้ห้องชื่อ "#ขาวสาร-อปเดต" ส่วน "lfg-หาทีม" กลายเป็น "lfg-หาทม" ทั้งที่ตัวอย่างในฟอร์มยังแสดงชื่อที่ถูกต้อง (S2)
3. **AutoMod กรองคำหยาบไทยได้ แต่หลบง่ายมาก** แค่ใส่ zero-width space ("ค​วย") หรือเว้นวรรคระหว่างตัวอักษร ("ค ว ย") ก็ผ่าน ส่วนการกระทำ "แจ้งเตือนผู้ดูแล" ไม่ได้แจ้งเตือนใครเลย (S2)
4. **ปุ่มฉุกเฉินตอนโดนบุกซ่อนอยู่ท้ายหน้า "สถิติ"** และไม่มีการแจ้งเตือนเมื่อมีคนทะลักเข้ามา การแบนต้องทำทีละคน (10 คนใช้ 40 คลิก) แบนแล้วก็ลบข้อความสแปมไม่ได้ และบันทึกการตรวจสอบไม่บอกว่าแบน "ใคร" (S2)
5. **คำศัพท์ไทยไม่สม่ำเสมอ** ใช้ทั้ง "ยศ" และ "บทบาท" ทั้ง "ห้อง" และ "ช่อง" และสิทธิ์ Administrator แปลว่า "ผู้ดูแล" ซึ่งคนไทยเข้าใจว่าหมายถึง moderator เสี่ยงที่แอดมินจะให้สิทธิ์ทุกอย่างกับม็อดโดยไม่ตั้งใจ (S2)
6. ไม่มีปุ่มสร้างหมวดหมู่ ห้องส่วนตัวไม่ถามต่อว่าจะให้ใครเห็น ห้อง voice ปิดไมค์นักเรียนไม่ได้ อีเวนต์ตั้งให้ซ้ำไม่ได้ และส่งออกข้อมูลได้เฉพาะของตัวเอง ส่งออกของเซิร์ฟเวอร์ไม่ได้

**คะแนนเฉลี่ย (เต็ม 10):** ณัฐ 5.6, ปรียา 7.2, คาร์ลอส 5.8 ด้านความไว้ใจและความปลอดภัยได้คะแนนต่ำที่สุด

---

## Method

- **Build:** branch `claude/dreamy-goldberg-p3o5ao` merged into this worktree, then `npm ci` and `npm run build`. The server ran on port 7040 with `SERVE_STATIC=1`, `ALLOW_DEV_IDENTITY=0`, a throwaway `DB_PATH`/`STORAGE_ROOT` and `RATE_LIMIT_REGISTER_PER_HOUR=200`, so the 10-account raid could register from one IP. The default limit of 10/hour would have stopped the 11th raider.
- **Browser:** Playwright with Chromium (`/opt/pw-browsers/chromium`) and fake media devices. Every persona started from a cold, logged-out context.
- **Other people:**
  - A second "template author" account published a server template.
  - Raiders `freenitro_0..9` and `freenitro_late` registered and joined through the REST API (`/api/auth/register`, `/api/invites/:code/accept`, `/api/messages`).
  - Students and contributors joined the same way.
  - Some ran in their own browser contexts, for example Sofia on a phone.
- **Clicks and time:** counted by wrapping every scripted click and measuring the wall time of each scripted flow. Script time is a lower bound. Human estimates add reading time and are marked "est.".
- **Screenshots:** in `/tmp/claude-0/-home-user-discord/663d99e8-07c9-5b0f-8b1a-38c6a8c33dc1/scratchpad/shots/`. Names below are shortened to `…/persona-admins-moderators-*.png`.
- **Regression probe:** `node scripts/ux/admins-moderators.mjs` re-checks the six code-level findings against a running server. Today it reports 0/6 fixed.

---

## Persona profiles

| | **Nat (ณัฐ)** | **Priya** | **Carlos** |
|---|---|---|---|
| Age / gender | 28, man | 36, woman | 31, man |
| Role | Admin of a 5,000-member Thai gaming community (ROV, Valorant) moving off Discord | Maintainer of an open-source Python library | High-school history teacher running an online class |
| Tech literacy | High. Five years as a Discord admin, knows bots and permission overwrites | High (developer), but little admin experience on community platforms | Medium. Uses Google Classroom, Zoom, WhatsApp groups and Kahoot |
| Device / viewport | Windows laptop, 1366×768, dark theme | Windows desktop, 1920×1080 at 150% scaling (1280×720 CSS px at DPR 1.5) | 1366×768 laptop. His students use phones (Pixel 7, 412×915) |
| Language | Thai UI (`th-TH`, Buddhist-era dates) | Hindi UI (`hi-IN`) at first, then switches to English (UK) | Latin-American Spanish (`es-419`) |
| Accessibility | None | Relies on OS scaling at 150% | None, but many students are on phones on mobile data |
| Apps they use | Discord, LINE OpenChat, Facebook groups, TikTok | GitHub, Discord, Slack, WhatsApp | WhatsApp, Zoom, Google Classroom, Kahoot, Teams |
| Goal | Rebuild the server with the same structure, set up safety tooling before announcing the move, survive the first raid | A support forum with tags, a pinned FAQ, rotating moderators, and exportable history | Private channels per group, a "stage" lecture, polls, the ability to silence the class, and a weekly recurring class event |
| Patience | Low. "If my mods can't do it on their phone in 10 seconds during a raid, it's useless." | Medium, and methodical | Medium, but will give up and go back to WhatsApp if it is fiddly |

---

## Task-by-task results

Severity legend: S1 blocker, S2 major, S3 minor, S4 polish. Result legend: ✅ success, 🟡 partial, ❌ failure. Screenshot names below are short forms of `…/persona-admins-moderators-<name>.png`.

### Nat (Thai, laptop)

| # | Task | Result | Time | Clicks | Notes / severity | Screenshot |
|---|---|---|---|---|---|---|
| N1 | Register (Thai UI) | ✅ | 2.7 s script, ~25 s est. | 3 + typing | Thai auto-detected and rendering is crisp. | `nat-01-login-th`, `nat-03-after-register` |
| N2 | Create server from template (pasting the full template URL) | ✅ | 5.8 s script, ~40 s est. | 5 | Pasting a full URL works. There is no built-in gallery (Discord offers Gaming, School club and others) (S3). The template preview mixes English "role" into Thai text (S4). | `nat-05-template-code`, `nat-06-template-preview`, `nat-07-server-created` |
| N3 | Create a **category** | ❌ | — | — | Not in the server menu, not on right-click of a category, not in the create-channel modal (existing categories only) (S2). | `nat-08-server-menu`, `nat-09-category-context` |
| N4 | Create a channel with a Thai name in GAMES via the category "+" | 🟡 | ~20 s est. | 4 | The "+" on GAMES preselects **TEXT CHANNELS** (S3). The Thai name "ข่าวสาร อัปเดต" is saved as **"ขาวสาร-อปเดต"** (S2). | `nat-11-create-channel-category-default`, `nat-12-channel-created` |
| N5 | Moderator role (kick, ban, timeout, manage messages, audit log) | ✅ | ~60 s est. | 13 | Discord-like editor with an unsaved-changes bar. The hoist and mentionable switches have no accessible name (S3). "ยศ" and "บทบาท" are mixed in the same screen (S3). | `nat-17-role-created`, `nat-18-moderator-role-editing` |
| N6 | Administrator toggle guard | 🟡 | — | 1 | A warning banner appears at the **top** of the list, off-screen when you toggle it at the bottom. No confirm dialog. The Thai label "ผู้ดูแล" reads as "moderator" (S2). | `nat-20-admin-toggle` |
| N7 | `#rules` read-only for @everyone (channel overwrite) | ✅ | ~45 s est. | 6 | The overwrite editor is buried in Server settings › "สิทธิ์ของช่อง", not in Edit channel (S3). Allow / Neutral / Deny is clear once coloured; the tooltip calls neutral "สืบทอด" (inherit). The list shows server-only permissions such as Manage server and Ban, which do nothing per channel (S3). The unsaved-changes nudge works. | `nat-22-channel-perms-top`, `nat-25-deny-state`, `nat-27-switch-channel-unsaved` |
| N8 | Muted role denied in every channel | 🟡 | ~8 min est. | ~60 (5 × 12 channels) | Categories cannot hold overwrites, so there is no "sync to category". Timeout is the better tool and it exists (S2 for migration). | `nat-21-channel-perms` |
| N9 | Rules screening and onboarding questions | ✅ (explored) | — | — | Screening, welcome page and questions (7 × 12 options) exist. The checkbox inputs have no labels (`input "on"`) (S3). | `nat-30-tab-onboarding` |
| N10 | AutoMod: Thai bad words + spam + mention spam | 🟡 | ~50 s est. | 6 per rule | Rules are easy to create. **Bypassed** by ZWSP and spaced letters (S2). The "Alert moderators" action is a no-op and has no channel picker (S2). Mention spam counts only `<@id>`, so six `@everyone` passed (S3). Coordinated "spam spam" from 10 accounts passed because the heuristic is per user (S3). | `nat-32-automod-alert`, `nat-36-automod-list`, `nat-38-raid-in-progress` |
| N11 | Slowmode | ✅ | ~10 s est. | 3 (right-click › Edit channel › slider) | The slider has Discord presets. | `nat-14-channel-settings` |
| N12 | **Raid:** notice, lock down, clean up | ❌ | ~3 min est. | 4 to find the lockdown + 40 to ban 10 | No banner or alert during the raid. Raid protection is off by default and hidden at the bottom of "สถิติ" (Insights). **Lock now did not stop a new account joining (HTTP 200)** (S1). Existing raiders kept posting. Banning is one at a time with no "delete message history" (13 spam messages stayed). | `nat-39-after-raid-return`, `nat-41-raid-section`, `nat-42-lock-clicked`, `nat-43-members-tab`, `nat-46-after-bans` |
| N13 | Timeout a user | ✅ | ~5 s est. | 3 | The submenu lists 1 hour before 5 min, which is odd ordering, and there is no reason field (S4). | `nat-48-timeout-dialog` |
| N14 | Audit log review | 🟡 | — | 2 | "nat_admin แบนสมาชิก" never says **who** was banned (S2). The avatar is a random colour per entry. Raw keys (`LOCKDOWN_START`, `AUTOMOD_BLOCK`) are untranslated (S3). No filters. | `nat-47-audit-log` |
| N15 | Webhook | ✅ | ~20 s est. | 3 | A simple form. | `nat-49-webhooks` |
| N16 | Announcement channel following | ✅ (button present) | — | — | The "ติดตาม" button is in the header. There is no "Publish" action on a message (S3). | `nat-50-announcements`, `nat-51-announcement-hover` |
| N17 | Scheduled event | ✅ | ~40 s est. | 3 + typing | No recurrence and no Stage location (see C6). | `nat-52-events`, `nat-53-event-form` |
| N18 | Server insights | ✅ | — | 2 | Honest, live numbers. "Most active members" happened to be the raiders, which is a nice accidental raid detector. | `nat-40-insights-full` |

### Priya (Hindi, then English; Windows at 150%)

| # | Task | Result | Time | Clicks | Notes / severity | Screenshot |
|---|---|---|---|---|---|---|
| P1 | Cold start in Hindi, register, create server | ✅ | ~60 s est. | 5 | Hindi auto-detected with good Devanagari rendering. The default categories "TEXT CHANNELS" and "VOICE CHANNELS" stay in English (S3). | `priya-01-login-hindi`, `priya-03-home-hindi`, `priya-05-server-created-hi` |
| P2 | Switch UI to English | ✅ | 3.7 s script, ~30 s est. | 3 + scroll | There is no "Language" tab; it is at the bottom of Appearance (दिखावट). She hunted through the tab list first (S3). | `priya-07-settings-hi`, `priya-08-appearance-hi`, `priya-09-english` |
| P3 | Create forum `#support` | ✅ | ~20 s est. | 4 | Clean empty state. No prompt to add tags or post guidelines (S4). | `priya-10-forum-empty` |
| P4 | Add tags (bug, question, feature-request, solved = mod-only) | ✅ | 4.2 s script, ~60 s est. | 14 | Saves instantly. Mod-only tags are a nice touch. No "post guidelines" field (S3). | `priya-11-forum-settings`, `priya-12-tags-added` |
| P5 | Pinned FAQ post | ✅ | ~45 s est. | 5 | Pin appears on hover and shows a "Pinned" label. | `priya-15-post-hover`, `priya-18-forum-list-live` |
| P6 | Answer a newcomer's post and mark it "solved" | 🟡 | ~40 s est. | 3 | Tags can only be edited from the list card's hover icon, not inside the post (S3). The post header says "Welcome to #ImportError on Windows 11!", text-channel boilerplate with a "#" (S3). Every forum post is listed in the sidebar, which will not scale to hundreds of support posts (S3). | `priya-19-post-thread`, `priya-20-edit-tags` |
| P7 | Moderator rotation: create "Mod on duty" and assign to Arjun | ✅ | ~40 s est. | 8 + 3 | Right-click › Roles › checkbox is fast. The submenu items are `menuitem`, not `menuitemcheckbox`, so screen readers get no checked state (S3). Rotating means one person at a time. There is no "members with this role" list to remove people in bulk (S3). | `priya-21-roles-submenu`, `priya-23-arjun-profile` |
| P8 | Export support history or the member list | ❌ | — | — | Only a personal "Download my data", saved as **`antigravity-export.json`** (off-brand filename) (S3). No server, channel or forum export (S2 for maintainers). | `priya-24-export` |
| P9 | Delete-server guard (checked, not confirmed) | 🟡 | — | 2 | From the server dropdown it is a one-step "Delete server?" confirm. The Settings › Overview path requires typing the name, so the guard is inconsistent (S2). | `priya-25-delete-server-guard` |

### Carlos (es-419; laptop, students on phones)

| # | Task | Result | Time | Clicks | Notes / severity | Screenshot |
|---|---|---|---|---|---|---|
| C1 | Register and create the class server | ✅ | ~45 s est. | 4 | Spanish copy is natural ("¡Hola de nuevo!"). | `carlos-01-login-es`, `carlos-02-server` |
| C2 | Roles "Grupo A" and "Grupo B" | ✅ | ~70 s est. | 10 | | `carlos-03-roles` |
| C3 | Private channel `#grupo-a` visible only to Grupo A | 🟡 | ~3 min est. | 4 + 7 | The "Canal privado" toggle creates a channel **nobody** can see, and there is no follow-up "who can access?" step (Discord asks right away) (S2). He had to find Server settings › Permisos del canal › pick channel › pick role › ✓ on "Ver canales" › Guardar. The member list in the private channel still shows all 5 students (S3). | `carlos-04-private-toggle`, `carlos-05-after-private`, `carlos-06-perms-grupo-a` |
| C4 | Assign students to groups | ✅ | ~15 s each est. | 3 each | Verified through the API: Sofia sees `grupo-a` and Diego does not. | — |
| C5 | Stage lecture | 🟡 | ~20 s est. | 4 | Creating the stage **auto-connects him live on stage with the mic on ("Transmitiendo")** and no topic or "Start stage" step (S2). The stage was placed under TEXT CHANNELS. The student's phone showed a **false "profe_carlos está compartiendo su pantalla"** black tile (S2). Audience members see mic, camera and screen-share buttons they cannot use, plus the jargon "P2P 1/1" (S3). Raise hand and teacher "Invitar a hablar" work (✅). | `carlos-08-stage-created`, `carlos-10-student-in-stage`, `carlos-11-teacher-sees-hand` |
| C6 | Weekly recurring class event | ❌ | — | — | No recurrence in the Events form or the API (S2 for teachers). | `nat-53-event-form` |
| C7 | Poll / quiz | 🟡 | — | — | A poll button exists in the composer. There is no quiz mode with a correct answer (Discord has none either; Kahoot habit) (S3). | — |
| C8 | "Mute everyone" / mute a noisy student in voice | ❌ | — | — | No server-mute or "mute all" in voice channels. `MUTE_MEMBERS` only works on stages. Workaround: run class as a stage (S2). For text he would need a channel overwrite or slowmode. | — |

---

## Ranked issue list

### S1: blockers

**S1-1. "Lock now" (ล็อกทันที) shows the server as locked while new accounts still join.**

- **What happened:** During the raid Nat found Raid protection at the bottom of Insights and clicked "ล็อกทันที". The banner said "เซิร์ฟเวอร์ถูกล็อกอยู่ … คนใหม่เข้าไม่ได้จนกว่าจะปลดล็อก". Then `freenitro_late` joined through the invite with HTTP 200, and the probe script reproduces it.
- **Screenshots:** `…/persona-admins-moderators-nat-42-lock-clicked.png`, `nat-48-timeout-dialog.png` (the late raider is in the member list).
- **Who it affects:** every admin under attack. It is actively misleading: the admin stops watching the join flood because they think the door is shut.
- **Root cause:** `services/insights.js` `guardJoin()` returns `{ allowed: true }` when `raid_protection` is off, *before* checking `activeLockdown()`. A manual lockdown therefore only works if the separate "เปิดการป้องกัน" checkbox is also on.
- **Fix:**
  - In `services/insights.js` (backend; this also affects the UI), move `const existing = await activeLockdown(serverId); if (existing) throw …SERVER_LOCKDOWN` above the `if (!server?.raid_protection)` early return.
  - In `src/components/settings/InsightsTab.jsx`, disable nothing, but add a one-line status under the button: "ล็อกแล้ว: ปฏิเสธการเข้าร่วมใหม่ N ครั้ง".

### S2: major

**S2-1. Thai (and every Indic) channel name loses its vowel and tone marks.**

- **What happened:** "ข่าวสาร อัปเดต" became `#ขาวสาร-อปเดต`, which reads as "white rice-update". "lfg-หาทีม" became "lfg-หาทม", including inside the template. The create-channel preview line ("จะถูกสร้างเป็น #ข่าวสาร2") showed the correct name, then the server saved something else.
- **Screenshots:** `nat-11-create-channel-category-default.png`, `nat-12-channel-created.png`, `nat-07-server-created.png`
- **Who:** Thai, Hindi and every script with combining marks (Mn/Mc), which covers the whole target market.
- **Cause:** the slug regex `/[^\p{L}\p{N}_-]/gu` drops `\p{M}`. It appears at `services/guilds.js:401`, `services/guilds.js:476` and `src/components/CreateChannelModal.jsx:38`.
- **Fix:** change all three to `/[^\p{L}\p{M}\p{N}_-]/gu`. Add a unit test with "ข่าวสาร อัปเดต" → "ข่าวสาร-อัปเดต" and "सहायता केंद्र" → "सहायता-केंद्र".
  - Nat: "ห้องแรกที่สร้างชื่อผิดเป็น 'ขาวสาร' สมาชิกขำกันทั้งเซิร์ฟ"

**S2-2. No way to create, rename or delete a category.**

- **What happened:** Nat looked in the server menu (`nat-08-server-menu`), right-clicked a category header (`nat-09-category-context`, nothing happens) and checked the create-channel modal (existing categories only). Categories only come from templates or the API.
- **Who:** every admin with more than 10 channels.
- **Cause:** categories are just a `categoryName` string on channels. `src/components/ServerDropdown.jsx` has no item, and the category header in `src/components/ChannelSidebar.jsx` has no `onContextMenu`.
- **Fix:**
  - Add "สร้างหมวดหมู่ / Create category" to `ServerDropdown.jsx`, opening `InputModal`, and a "+ New category…" option at the bottom of the category `<select>` in `CreateChannelModal.jsx`.
  - Give the category header in `ChannelSidebar.jsx` a context menu: Rename, Delete (channels move to no category), and "Edit permissions" (see S2-9).

**S2-3. The Administrator permission is labelled "ผู้ดูแล" in Thai, and Thai terms are inconsistent.**

- **What happened:** In the role editor the Administrator switch reads **"ผู้ดูแล"**, the word Thai admins use for *moderator*. Nat named his mod role "Moderator ผู้ดูแล" and was one click from giving it every permission. The warning appears at the top of the list, off-screen when you toggle at the bottom. The same screens mix "ยศ" (tab), "บทบาท" (button, menu) and "role" (English), and "ห้อง" and "ช่อง" for channel.
- **Screenshots:** `nat-16-roles.png`, `nat-20-admin-toggle.png`, `nat-22-channel-perms-top.png`
- **Fix:**
  - In `src/i18n/th.js`, set `'roles.administrator': 'ผู้ดูแลระบบ (สิทธิ์ทุกอย่าง)'`, standardise on "บทบาท" (Discord's Thai term) for every `roles.*`/`settings.roles` string and on "ช่อง" for channel, and replace "role" in `server.templateHint` and `onboarding.*` with "บทบาท".
  - In `src/components/ServerSettingsModal.jsx` (role editor, around line 955), show `roles.adminWarning` directly under the Administrator switch as well, and confirm the toggle with `ConfirmModal`.

**S2-4. AutoMod keyword filter is trivially evaded, and "Alert moderators" does nothing.**

- **What happened:** With the "คำหยาบภาษาไทย" rule on, `ค​วย` and `ค ว ย` were posted (`nat-38-raid-in-progress.png`). The action "+ แจ้งเตือนผู้ดูแล" is saved and displayed, but no alert goes anywhere. A rule with only "alert" has no effect at all, not even an audit entry.
- **Who:** every community, and especially Thai ones, where spacing letters out is the standard evasion.
- **Cause:** in `services/automod.js`, `matches()` runs `lowered.includes(word)` on raw text, and `'alert'` is only validated in `ACTIONS`, never executed.
- **Fix:**
  - In `services/automod.js`, normalise before matching: NFKC, strip `[​-‍⁠﻿]`, and for keyword rules also compare against a copy with whitespace and punctuation between single characters removed.
  - Implement `alert`: post a system embed (rule, user, channel, content, "Timeout / Ban / Dismiss" buttons) to `rule.trigger_metadata.alert_channel_id`, and log `AUTOMOD_ALERT` for non-blocking hits.
  - In `src/components/settings/AutoModTab.jsx`, when "แจ้งเตือนผู้ดูแล" is on, show a required "ส่งไปที่ช่อง" channel select.
  - Count `@everyone`/`@here` in mention spam (`MENTION` regex in `services/automod.js`).

**S2-5. Raid response tools: hidden, off by default, one-at-a-time, and banning leaves the spam.**

- **What happened:**
  - Nothing alerted Nat during a 10-account raid (`nat-39-after-raid-return`).
  - Raid protection lives at the bottom of **Insights** (`nat-41-raid-section`) and is off by default.
  - Banning 10 raiders took **40 clicks**, and the ban dialog has no "delete message history", so 13 spam messages remained (`nat-45-ban-dialog`, `nat-46-after-bans`).
  - The Members tab (`nat-43-members-tab`) shows join *date* only: no join time, no account age, no multi-select.
  - Nat: "ตอนโดนบุกผมต้องหาเครื่องมือในหน้า 'สถิติ' เนี่ยนะ? Discord มี Safety Setup กับแบนทีละหลายคนได้"
- **Cause:**
  - `src/App.jsx:1701` hard-codes `deleteMessageSeconds: 0`, and `src/components/ServerSettingsModal.jsx:1135` sends no `deleteMessageSeconds`, even though `POST /bans/:id` supports it.
  - Raid settings are placed in `InsightsTab.jsx`.
- **Fix:**
  - Move the raid section into a new "ความปลอดภัย / Safety setup" tab (group `moderation`) in `ServerSettingsModal.jsx`, together with verification level and AutoMod shortcuts. Default `raid_protection = 1` with `action = 'screen'` for new servers.
  - Add a ban-dialog select "ลบข้อความย้อนหลัง: ไม่ลบ / 1 ชม. / 6 ชม. / 24 ชม. / 7 วัน", defaulting to 1 hour, in the `ConfirmModal` used by `App.jsx` (member context ban) and in the `ServerSettingsModal.jsx` members tab.
  - In the Members tab, add checkboxes, "เข้าร่วมเมื่อ" with time, "อายุบัญชี", sort by "เข้าล่าสุด", and a bulk bar "แบน / เตะ / พักการใช้งาน N คน".
  - When `guardJoin` detects a spike, push a toast and inbox notification to members with `MANAGE_GUILD`: "มีคนเข้า 10 คนใน 10 วินาที — [ล็อกเซิร์ฟเวอร์] [ดูสมาชิกใหม่]".

**S2-6. Delete-server guard is inconsistent.**

- **What happened:** From the server dropdown (`src/components/ServerDropdown.jsx` → `App.jsx` `handleDeleteServer`, line 1599) it is a plain "Delete OpenLib Community? / Permanently delete this server?" confirm (`priya-25-delete-server-guard.png`). Settings › Overview requires typing the name. The item also sits in the dropdown next to "Manage roles".
- **Fix:** reuse the type-the-name confirm (`ServerSettingsModal.jsx` around line 534, the `deleteName` input) in `handleDeleteServer`. Separate "Delete server" in `ServerDropdown.jsx` with a divider at the very bottom, or remove it from the dropdown as Discord does and keep it only in Settings.

**S2-7. The audit log never says who was acted on.**

- **What happened:** Ten identical rows read "nat_admin แบนสมาชิก · raid", each with a different random avatar (`nat-47-audit-log.png`).
- **Cause:** `AuditTab` in `src/components/ServerSettingsModal.jsx` (around line 1564) renders only `entry.display_name` and uses `defaultAvatar(entry.id)`, which is the entry id rather than the user id. `LOCKDOWN_START` and `AUTOMOD_BLOCK` are missing from `auditLabels()`, so raw keys show.
- **Fix:**
  - Join the target user or channel name in the audit-log query and render "nat_admin แบน **freenitro_3_j5n**".
  - Use `defaultAvatar(entry.user_id)`.
  - Add `audit.LOCKDOWN_START`, `audit.LOCKDOWN_END`, `audit.AUTOMOD_BLOCK` and `audit.AUTOMOD_ALERT` to every locale.
  - Add filter selects (user, action) as Discord has.

**S2-8. Private channel is created with nobody allowed in, and there is no follow-up.**

- **What happened:** Carlos toggled "Canal privado", clicked Crear, and got a channel only he can see with no next step (`carlos-05-after-private.png`). He needed 7 more clicks in Server settings › Permisos del canal. Carlos: "¿Y ahora cómo le digo que es solo para el Grupo A?"
- **Fix:** when `is_private`, `src/components/CreateChannelModal.jsx` gets a second step, "¿Quién puede acceder?" / "ใครเข้าได้บ้าง?", with role and member chips. On submit it writes VIEW_CHANNEL allow overwrites, the same call `ChannelPermissionsTab.jsx` makes. Also add a "Permisos" tab to `src/components/ChannelSettingsModal.jsx` that embeds `ChannelPermissionsTab` pre-filtered to the channel. Today per-channel permissions are only reachable from Server settings.

**S2-9. No category-level permissions, so migrating a "Muted" role costs about 60 clicks.**

- **Cause:** `ChannelPermissionsTab.jsx` filters out `type === 'category'`, and categories have no rows.
- **Fix:** allow selecting a category in `ChannelPermissionsTab.jsx`, and let channels "Sync with category" (a Discord concept Nat already knows). Until then, show a tip in the role editor: "ใช้ 'พักการใช้งาน' แทนยศ Muted".

**S2-10. Creating a stage puts the teacher live with the mic open, and students see a phantom screen share.**

- **What happened:**
  - Right after "Crear canal", Carlos was connected on stage and "Transmitiendo" (`carlos-08-stage-created.png`).
  - On Sofia's phone, a black tile said "profe_carlos está compartiendo su pantalla" although nothing was shared (`carlos-10-student-in-stage.png`).
  - The audience also sees camera, screen-share and PTT buttons plus a "P2P 1/1" debug label.
- **Fix:**
  - In `src/App.jsx` (channel-created handler), select a new voice or stage channel without calling join.
  - In `src/components/VoiceRoom.jsx`, give stage channels a "Iniciar escenario" screen with a topic field before going live. Only render the screen-share tile when the remote track's `contentHint`/metadata says it is a screen, not for any extra video track. For audience members, hide camera, screen and PTT and show only "Levantar la mano" and "Salir". Hide the transport label behind a debug flag.

**S2-11. Teachers cannot mute anyone in a voice channel.**

- **Cause:** `MUTE_MEMBERS` is used only for stage speakers (`realtime.js` around lines 579 and 667). `src/components/MemberContextMenu.jsx` has no "Silenciar en el servidor".
- **Fix:** add "Silenciar / Ensordecer en el servidor" to the member context menu when both users are in the same voice channel. Add a "Silenciar a todos" button in the `VoiceRoom.jsx` moderator strip, using a new `voice_server_mute` socket event gated by `MUTE_MEMBERS`.

**S2-12. No recurring events.**

- **Cause:** there is no recurrence field in `services/events.js` or `src/components/EventsPanel.jsx`. Discord supports weekly and other repeats.
- **Fix:** add a "Repetir: No / Cada semana / Cada 2 semanas / Cada mes" select to the `EventsPanel.jsx` form. Store an RRULE and create the next occurrence when one ends.

**S2-13. No server or channel data export.**

- **What happened:** Priya wanted to archive support history. The only option is a personal export, named `antigravity-export.json`.
- **Fix:**
  - Add Server settings › "Exportar / Export" (MANAGE_GUILD) that produces a JSON/CSV of channels, forum posts with tags, messages and the member list, using the same streaming approach as `/api/users/@me/export`.
  - Rename the personal export file to `<app>-data-<username>-<date>.json` in `src/components/settings/AccountSecurityTab.jsx`.

### S3: minor

1. **The category "+" does not preselect its category.** `src/components/ChannelSidebar.jsx` calls `onOpenCreateChannelModal(type)` without a category, and `CreateChannelModal.jsx` defaults to `categories[0]`. Pass the category name through (`nat-11`).
2. **Default categories are hard-coded in English** ("TEXT CHANNELS", "VOICE CHANNELS") in the Thai, Hindi and Spanish UIs. They are created server-side in `services/guilds.js createServer`. Localise using the creator's locale, or store `null` and render `t('sidebar.textChannels')`.
3. **Channel overwrites list server-only permissions** (Manage server, Ban, Kick, Insights) that have no per-channel meaning. In `ChannelPermissionsTab.jsx`, filter `permissionGroups()` to channel-scoped bits as Discord does. Also show the "สืบทอด / Inherit" label in a small legend above the list, not only as a tooltip.
4. **Unlabelled controls:**
   - hoist and mentionable switches in the role editor (`ServerSettingsModal.jsx`, `button[switch] ""`)
   - onboarding and insights checkboxes (`input "on"`, in `OnboardingTab.jsx` and `InsightsTab.jsx`)
   - the role submenu uses `menuitem` instead of `menuitemcheckbox` with `aria-checked` (`MemberContextMenu.jsx`)
5. **Forum:**
   - Tags can't be edited from inside a post.
   - The post header uses text-channel boilerplate ("Welcome to #…") in `ChatArea.jsx`.
   - The sidebar lists every forum post (`ChannelSidebar.jsx` `threadsByParent`). Show only followed or active posts.
   - There is no "post guidelines" field in forum settings (`ForumView.jsx`).
6. **Language is buried** at the bottom of Appearance. Add a "Idioma / भाषा / ภาษา" entry to the `UserSettingsModal.jsx` nav, or at least a globe shortcut in the user panel.
7. **Private-channel member list shows everyone**, including people who can't see the channel (`MemberList.jsx`). Filter by `VIEW_CHANNEL`.
8. **@everyone from a member without MENTION_EVERYONE is still rendered as a pill and highlights the message yellow** for the admin (`nat-38`), even though nobody was notified. In `ChatArea.jsx`/`src/utils/mentions.js`, render plain text when `message.mention_everyone` is false.
9. **No "Publish" for announcement messages.** Following exists, but there is no crosspost action in the message hover bar (`nat-51`).
10. **No template gallery.** You need a template code or URL from someone else. Ship 3–4 built-in templates (Gaming, Study group/Clase, Open-source support, Friends) in `CreateServerModal.jsx`.
11. **Stage created under TEXT CHANNELS** when started from the server menu. Default voice and stage types to the first voice category.
12. **Poll has no quiz mode.** This is optional; Carlos compared it to Kahoot. A "Respuesta correcta" toggle in `CreatePollModal.jsx` that reveals results after close would be enough.

### S4: polish

- Timeout submenu order: 60 s, 5 min, 10 min, 1 h, 1 day, 1 week (`MemberContextMenu.jsx`). Offer a reason field like ban and kick.
- In the role editor, the name and colour scroll away while editing permissions. Make the role header sticky.
- A toast stack covers the composer's send button right after server creation (`nat-07`).
- Add a permission search box in the role editor (Discord has one).

---

## Allow / Neutral / Deny: does it make sense?

- **Nat, a Discord veteran:** understood it immediately. The ✕ / – / ✓ segmented control is the same as Discord's, and the red and green fills are clear once set (`nat-25-deny-state`). The confusions were about scope, not the three states:
  - Server-wide permissions appear in the list, where they do nothing.
  - There is no category level.
  - The editor is hidden in Server settings instead of in Edit channel.
- **Carlos:** did not understand "–" until he hovered and read "Heredar". His mental model is Google Classroom's "who can see this". He wanted a "Quién puede ver" people picker, not a matrix. The private-channel wizard in S2-8 would avoid the matrix for 90% of teachers.
- **Priya:** fine with it. She compared it to GitHub team permissions and asked for a "View server as role" preview to check what a contributor sees.

## Discoverability vs Discord

| Feature | Here | Discord |
|---|---|---|
| Create category | none | Server menu › Create Category |
| Channel permissions | Server settings › Channel permissions only | Edit channel › Permissions |
| Raid / lockdown | Insights tab, bottom | Safety Setup, Security Actions (Pause invites) |
| Ban with message cleanup | backend only | Ban dialog "Delete message history" |
| Bulk moderation | none | Members page multi-select |
| Audit log target | missing | shown, with filters |
| Recurring events | none | yes |
| Slowmode, timeout, AutoMod, onboarding, forum tags, stage, webhooks, insights | ✅ comparable, often fewer clicks | ✅ |

---

## What delighted them

- **Nat:**
  - Thai typography is clean and the Buddhist-era dates (26/9/2569) are correct.
  - Pasting a full template URL just works, with a preview of categories before creating.
  - The Discord-style unsaved-changes bar turns red and shakes when you try to leave, so he never lost a permission edit.
  - AutoMod's copy is honest: "ข้อความที่ถูกบล็อกจึงไม่เคยถูกเก็บไว้เลย".
  - "Most active members" in Insights showed the raiders straight away.
  - Nat: "โครงหน้าตาเหมือน Discord เป๊ะ ม็อดผมไม่ต้องเรียนใหม่"
- **Priya:**
  - Forum tags with emoji and a **mod-only** "solved" tag that newcomers can't pick.
  - Pinned FAQ with a clear "Pinned" label.
  - Hindi rendered well, and the language search box has native and English names side by side.
  - Priya: "The forum is honestly nicer than Discourse for a small project."
- **Carlos:**
  - Raise hand, then "Invitar a hablar" in the stage works cleanly and is exactly what a lecture needs.
  - The Spanish copy feels native rather than machine-translated.
  - Right-click › Roles › Grupo A takes 3 clicks per student.

## Scores (1–10)

| Persona | First impression | Ease of use | Visual appeal | Trust / safety | Would recommend | Avg |
|---|---|---|---|---|---|---|
| Nat (Thai gaming admin) | 7 | 6 | 7 | **3** | 5 | 5.6 |
| Priya (OSS maintainer) | 8 | 7 | 8 | 6 | 7 | 7.2 |
| Carlos (teacher, es-419) | 7 | 5 | 7 | 5 | 5 | 5.8 |

Nat's trust score is driven by S1-1 (a lock that does not lock), S2-4 (filters bypassed with one invisible character) and S2-5 (spam stays after bans). "ถ้าผมประกาศย้ายคอมมูวันนี้ คืนนี้โดนบุกแน่ แล้วผมจะรู้ได้ยังไงว่าล็อกได้จริง"
