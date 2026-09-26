# UX persona panel: youth-gamers (Ploy 14, Jake 17, Minh 21)

## สรุปภาษาไทย

เราทดสอบแอปกับผู้ใช้จำลอง 3 คน ได้แก่ **พลอย** (อายุ 14 ปี ใช้ iPhone SE ภาษาไทย เน็ต 3G และไม่เคยใช้ Discord มาก่อน), **เจค** (อายุ 17 ปี ใช้ Discord หนักมาก) และ **มินห์** (อายุ 21 ปี เป็นประธานชมรมอีสปอร์ต ใช้ภาษาเวียดนาม บนแล็ปท็อปจอ 1366x768)

- **ปัญหาร้ายแรงที่สุดคือเรื่องความปลอดภัยของเด็ก** มี 3 ข้อ
  - ตอนสมัครไม่ถามอายุ
  - ค่าเริ่มต้นเปิดให้ "ทุกคน" ส่ง DM หาได้
  - ปุ่ม "รายงาน" มีแค่ช่องข้อความว่างๆ ไม่มีหมวดหมู่ให้เลือก เช่น "ขอรูป/คุกคามทางเพศ" และรายงานจะไปถึงแค่แอดมินของเซิร์ฟเวอร์ ซึ่งในกรณีนี้คือเพื่อนร่วมห้องอายุ 14 ปี ไม่ได้ส่งถึงทีมความปลอดภัยของแพลตฟอร์ม
- **ลิงก์เชิญที่ส่งมาทาง LINE ใช้งานยาก** บนเน็ต 3G จอดำนาน 9–11 วินาทีโดยไม่มีอะไรบอกว่ากำลังโหลด พอโหลดเสร็จก็ขึ้นหน้า "ยินดีต้อนรับกลับมา!" (หน้าเข้าสู่ระบบ) ทั้งที่พลอยยังไม่มีบัญชี และไม่บอกด้วยว่าใครเชิญเข้ากลุ่มไหน
- **ใช้บนมือถือลำบาก**
  - หลังรับคำเชิญ แถบรายการห้องบังแชท
  - ปุ่มต่างๆ เล็กแค่ 20–28px
  - กดค้างที่ข้อความแล้วไม่มีอะไรเกิดขึ้น
  - ช่องพิมพ์ใช้ตัวอักษร 14px ทำให้ iOS ซูมหน้าจอเองทุกครั้งที่แตะช่องพิมพ์
- **เจค** ชอบที่มี keybind, Ctrl+K, markdown, แชร์หน้าจอ และ push-to-talk แต่บ่นว่าไม่มีปุ่ม GIF หรือสติกเกอร์ในช่องพิมพ์ พิมพ์ `:fire:` แล้วไม่แปลงเป็นอิโมจิ และเจอข้อความ "You is sharing their screen" ที่ภาษาอังกฤษผิดไวยากรณ์
- **มินห์** ทำได้ทั้งบทบาท (roles), ขั้นตอนต้อนรับสมาชิกใหม่ (onboarding), อีเวนต์ และโพล แต่เจอปัญหาหลายข้อ
  - สร้างหมวดหมู่ (category) ไม่ได้
  - ห้องเสียงที่สร้างจากเมนูไปอยู่ใต้หมวด TEXT CHANNELS
  - ชื่อหมวดหมู่เริ่มต้นเป็นภาษาอังกฤษเสมอ
  - ปุ่มลบบทบาทเขียนว่า "Đã xóa vai trò" ซึ่งแปลว่า "ลบแล้ว"
  - ข้อความแจ้งข้อผิดพลาดเป็นภาษาอังกฤษ ("Prompt title invalid")
  - สมัครสมาชิกได้แค่ 10 คนต่อชั่วโมงต่อ IP ถ้าจัดบูธรับสมัครชมรมบน Wi‑Fi ของมหาวิทยาลัย คนที่ 11 จะสมัครไม่ได้
- **จุดที่ทำได้ดี**
  - แปลเป็นภาษาไทยและเวียดนามได้ครบและเป็นธรรมชาติ แสดงปี พ.ศ. 2569 ได้ถูกต้อง
  - ข้อความเสียงใช้ได้จริง
  - หน้าต่างยืนยันการบล็อกเขียนไว้ชัดเจน
  - มีธีมสว่าง
  - หน้าต้อนรับสมาชิกใหม่ (กฎ + คำถาม) ทำงานได้ดีมาก

---

## Method

- **Build and server.** Branch `claude/dreamy-goldberg-p3o5ao` merged into the worktree, then `npm ci` and a production `vite build`. The server was booted the same way `scripts/e2e/run.mjs` boots it, on port **7010**, with `SERVE_STATIC=1`, a throwaway `DB_PATH` and `STORAGE_ROOT`, and `ALLOW_DEV_IDENTITY=0`.
  - Later runs raised `RATE_LIMIT_REGISTER_PER_HOUR` to 200 after the default limit blocked us (see issue S2-6).
- **Scenario.** `scripts/ux/youth-gamers.mjs` with helpers in `scripts/ux/lib.mjs`. It uses real Chromium through playwright-core and axe-core.
  - **Devices:** iPhone SE 375x667 with touch, **Fast 3G + 4x CPU**, `th-TH`; Pixel 7 412x915; desktop 1920x1080; laptop 1366x768 with `vi-VN`.
  - **Supporting cast:** a classmate "Nok" (Pixel 7, Thai) who creates the class server and invite, and a troll account.
  - **Media:** fake media devices, so voice and screen share were really exercised.
- **Measurements.** Time and click counts come from the last full run. Every friction point has a screenshot under `/tmp/claude-0/-home-user-discord/663d99e8-07c9-5b0f-8b1a-38c6a8c33dc1/scratchpad/shots/persona-youth-gamers-*.png`, and each one was reviewed by eye.
- **Reproduce:** `node scripts/ux/youth-gamers.mjs [--only=ploy|minh|jake]` with the app running on `UX_PORT` (default 7010).

---

## Persona profiles

| | **Ploy (พลอย)** | **Jake** | **Minh** |
|---|---|---|---|
| Age / gender | 14, girl | 17, boy | 21, non-binary |
| Occupation | Mathayom 2 student, Bangkok | US high-school junior, ranked Valorant player | Business student, esports club organiser (HCMC) |
| Tech literacy | High on TikTok/LINE/Roblox; **zero Discord mental model**; short attention span (~5 s per screen) | Expert. Has used Discord daily for 5 years, owns 3 servers, has Nitro | Medium-high; ran a Facebook group and Zalo chats for the club |
| Device | iPhone SE (375x667), Safari, often on mobile data (3G/4G) | Windows desktop 1920x1080 + Android (Pixel 7) | Laptop 1366x768, Chrome |
| Language | Thai only | English | Vietnamese (reads some English) |
| Accessibility | Wants bigger text at night; used to big touch targets | Keyboard-first; push-to-talk while gaming | None |
| Apps | LINE, TikTok, IG, Roblox | Discord, Steam, Twitch, Spotify | Facebook, Zalo, Messenger, Discord (as a member) |
| Goal | Tap classmate's LINE invite, chat about Roblox tonight, send a pic and a voice note, get rid of a creep | Join the club server, talk in voice with PTT, stream his screen, flex markdown/emoji | Build the club server: channels, categories, roles, rules/onboarding, a scrim event, a training poll, invite freshers |

---

## Task results (last full run)

| # | Persona | Task | Result | Time | Clicks/taps | Severity |
|---|---|---|---|---|---|---|
| P1 | Ploy | Open invite link from LINE on Fast 3G | **Fail**: 9–11 s blank dark screen, then "ยินดีต้อนรับกลับมา!" (Welcome back!) login with no server shown | 10.4 s | 0 | S1 |
| P2 | Ploy | Create account (first tries a 4-char password) | Pass. Browser error bubble was in **English**, and no age was asked | 5.7 s | 3 | S1/S3 |
| P3 | Ploy | Accept invite, see friend's message | Pass. The channel drawer covered the chat, so she had to tap "general" (an English name) | 4.6 s | 2 | S2 |
| P4 | Ploy | Send a message | Pass. The composer is 14px, so iOS zooms on focus | 0.5 s | 1 | S3 |
| P5 | Ploy | React ❤️ (tap message, then toolbar) | Pass. Buttons are 25x22px and the toolbar **stays stuck open** after reacting | 1.3 s | 2 | S2 |
| P6 | Ploy | Long-press a message (LINE habit) | **Fail**: nothing appears | 2.0 s | 0 | S2 |
| P7 | Ploy | Send a photo | Pass | 1.2 s | 2 | none |
| P8 | Ploy | Record and send a voice note | Pass. Upload on 3G has no progress indicator | 24.9 s | 2 | S3 |
| P9 | Ploy | Mute the noisy class channel | Pass, but hidden behind ⋮ → "ตั้งค่าการแจ้งเตือน"; there's no duration (1 h / 8 h), only a toggle | 3.5 s | 3 | S3 |
| P10 | Ploy | Report + block a troll who says "send pics" | Pass mechanically. The report is **free text only**, goes to server mods (a 14-year-old), and block is an unlabeled shield icon | 7.9 s | 8 | **S1** |
| P11 | Ploy | Light theme + bigger text | Pass. In the drawer her own name is truncated to one glyph | 8.7 s | 4 | S3 |
| M1 | Minh | Register (auto-detects Vietnamese) | Pass | 1.4 s | 2 | none |
| M2 | Minh | Create club server from a "club" template | Partial. "Bắt đầu từ mẫu" only accepts a template code, and default categories are "TEXT CHANNELS"/"VOICE CHANNELS" in English | 2.3 s | 5 | S2 |
| M3 | Minh | Categories + announcement + voice channels | **Fail**: no "Create category" anywhere, and the voice channel lands under TEXT CHANNELS | 4.0 s | 7 | S2 |
| M4 | Minh | 3 coloured roles | Pass, but blocked twice by the "unsaved changes" bar. The delete button reads "Đã xóa vai trò" (= "role deleted"), and there's no custom hex colour | 7.2 s | 14 | S3 |
| M5 | Minh | Onboarding: rules + "which game?" question → role | Pass after an **English error toast** "Prompt title invalid". The save bar overlaps the Questions section at 768px | 3.9 s | 7 | S3 |
| M6 | Minh | Scrim event, Saturday 19:00, in a voice channel | Pass. "Where" defaults to "Nơi khác" (somewhere else) even though voice channels exist | 2.2 s | 5 | S4 |
| M7 | Minh | Poll "Tập luyện tối nào?" | Pass (nice poll card) | 1.5 s | 2 | none |
| J1 | Jake | Invite, sign up, 2-step onboarding (rules + game) | Pass. Onboarding is good | 6.5 s | 7 | none |
| J2 | Jake | Markdown / spoiler / code block / `:fire:` | Pass except `:fire:` stays literal text | 2.1 s | 0 | S3 |
| J3 | Jake | ↑ edit last, Ctrl+K, Ctrl+/ shortcuts | Pass (all three) | 2.3 s | 0 | none |
| J4 | Jake | Join voice, share screen, set push-to-talk | Pass. Banner reads "**You is sharing their screen**"; tile label "jake(you)" has no space | 9.0 s | 4 | S3 |
| J5 | Jake | GIF / sticker / custom emoji | **Fail (expectation)**: no GIF or sticker button in the composer; emoji picker has no server/custom tab | 1.0 s | 1 | S2 |
| J6 | Jake | Profile flex (banner, effects, decoration) | Partial: flat colour banner, accent hex, pronouns. No banner image, decoration or effect | 1.0 s | 2 | S4 |
| J7 | Jake | Same account on Pixel 7 | Pass. Lands on Friends with the drawer open, not on the server he was using | 3.0 s | 0 | S3 |

axe-core (WCAG 2 A/AA) found:
- `color-contrast` (serious) on desktop chat: 3–5 nodes, mainly the timestamp, "0 votes" and muted grey hints.
- One `aria-prohibited-attr` on desktop chat.
- One `aria-required-attr` in a Minh run.

Touch targets under 44px on the iPhone included:
- All header icons: 20x20, or 28x28 at the bigger text setting.
- Composer icons: 24x26.
- Send: 28x28.
- Message toolbar: 25x22.
- The "Create channel" "+" next to a category: 16x16.

---

## Ranked issues

### S1 — Blockers

**S1-1. Minors are unprotected: no age gate, DMs from "everyone" by default, and reports go only to server mods.**

- **What happened.** Ploy (14) signed up with only a username and password. The troll, who only shares a server with her, posted "ploy ur so ugly lol send pics".
- **Report flow.** Her report dialog is a single free-text box: "มีปัญหาอะไร?" (What's wrong?). The copy says "ผู้ดูแลเซิร์ฟเวอร์นี้จะเห็นข้อความนี้" (this server's moderators will see it). Those moderators are her classmate Nok, who is also 14.
- **DMs.** The privacy default is `allowDmsFrom: 'everyone'`.
- **Screenshots:** `ploy-21-troll-message.png`, `ploy-23-report-dialog.png`, `ploy-04-register-short-password.png`.
- **Who:** every under-18 user, and the operator (COPPA/GDPR-K, Thai PDPA child-consent rules).
- **Root cause:**
  - `LoginScreen.jsx` register mode has no birth date.
  - `services/userSettings.js:77` defaults to `allowDmsFrom: 'everyone'`.
  - The report modal in `MessageContextMenu.jsx`/`ChatArea.jsx` uses the `chat.reportReason` free-text field.
- **Fix:**
  1. `src/components/LoginScreen.jsx`: add a required **"วันเกิด / Date of birth"** field (three selects) to register mode. Block under 13 with a kind message. If the user is under 18, store `is_minor`.
  2. `services/userSettings.js`: when `is_minor`, default `allowDmsFrom: 'friends'` and add message-request filtering. Show a one-time explainer in `settings/PrivacyTab.jsx`: "เฉพาะเพื่อนเท่านั้นที่ส่งข้อความหาคุณได้".
  3. Report dialog (the `chat.report*` UI in `src/components/MessageContextMenu.jsx`): replace the free-text box with radio categories:
     - "คุกคาม/กลั่นแกล้ง"
     - "ขอรูปหรือเนื้อหาทางเพศ"
     - "สแปม"
     - "ทำร้ายตัวเอง"
     - "อื่นๆ"

     Keep the text box as optional. Route the sexual-content/minor-safety and self-harm categories to platform Trust & Safety, **not only** server mods. After submitting, offer "บล็อกคนนี้ด้วยไหม?" (Block this person too?) with a one-tap Block.
  4. `src/components/UserProfileModal.jsx:187-191`: give the shield button a visible label, "บล็อก" (Block). Add a separate "รายงานผู้ใช้" (Report user) item next to it.

**S1-2. The invite link greets a brand-new user with "Welcome back!" and a login form, after 9–11 s of a blank screen.**

- **What happened.** On Fast 3G with 4x CPU, the first interactive screen came after 9–11 s of solid `#1e1f22` with no spinner or logo. Then it showed "ยินดีต้อนรับกลับมา! ดีใจที่ได้เจอกันอีกครั้ง" (Welcome back! Glad to see you again) with username/password. Only a small banner said "เข้าสู่ระบบเพื่อรับคำเชิญนี้" (Sign in to accept this invite).
- **Missing context.** There is no server name, no inviter and no icon, although `GET /api/invites/:code` already returns them publicly (server name, `inviter.display_name`, `member_count`).
- **Ploy's reaction:** "ยินดีต้อนรับกลับมา? หนูไม่เคยเข้ามานะ… ลิงก์เสียรึเปล่า" ("Welcome back? I've never been here… is the link broken?"). In a real session she would go back to LINE.
- **Screenshots:** `ploy-01-invite-blank-2s.png`, `ploy-02-invite-landing.png`.
- **Who:** every invited newcomer; this is the main growth funnel.
- **Root cause:**
  - `src/components/LoginScreen.jsx:15` always starts in `useState('login')`.
  - The invite banner at `LoginScreen.jsx:114` is generic.
  - `index.html` has an empty `#root` and no boot splash, so the 336 KB main JS plus the Thai dictionary chunk must download before any pixel.
- **Fix:**
  - `LoginScreen.jsx`: when `inviteCode` is set, start in `'register'` mode. Fetch `/api/invites/:code` and render the `InviteJoinScreen` header above the form: server icon, "**nok_m2 เชิญคุณเข้าร่วม ม.2/5 Roblox**" (nok_m2 invited you to join ม.2/5 Roblox), and "12 ออนไลน์ · 34 สมาชิก" (12 online · 34 members).
  - Make the primary button "สมัครและเข้าร่วม" (Sign up and join), which registers and accepts in one step, skipping the separate "รับคำเชิญ" (Accept invite) card.
  - Keep "มีบัญชีแล้ว? เข้าสู่ระบบ" (Already have an account? Log in) as secondary.
  - `index.html`: inline a CSS-only splash (logo plus pulsing dots) inside `#root` so something appears at around 1 s.
  - Consider server-rendering the invite meta tags (og:title "Join ม.2/5 Roblox") so the LINE link preview shows the server name.

### S2 — Major

**S2-1. On mobile, the channel drawer covers the chat after joining, and login lands on Friends instead of the server.**

- After "รับคำเชิญ" (Accept invite), the drawer stays open over the conversation. Ploy sees "TEXT CHANNELS / general" instead of Nok's message and has to guess that she should tap "general".
- After login on a phone (Ploy and Jake on Pixel 7), the app opens Home/Friends with the drawer open, not the last server.
- **Screenshots:** `ploy-06-after-accept.png`, `jake-android-01-android-home.png`.
- **Root cause:** `App.jsx` mobile-drawer state is not closed on invite accept, and the route is not restored to the last channel.
- **Fix (`src/App.jsx`):**
  - After a successful accept, navigate to the invite's channel (or the first text channel) and close the drawer.
  - On boot on mobile, restore the last `/channels/:server/:channel` instead of `@me`.

**S2-2. Mobile message actions: long-press does nothing, the toolbar is tiny, and it gets stuck open.**

- A plain tap opens a 6-button toolbar made of 25x22px targets.
- After reacting, the toolbar stays visible: the sticky `:hover` after a tap keeps `group-hover:flex` active.
- Long-press, the gesture every LINE/Messenger/Discord-mobile user uses, opens nothing. The 450 ms timer sets `touchActionsId`, then the trailing click in the scroller's `onClick` toggles it closed again.
- **Screenshots:** `ploy-08-tap-message-toolbar.png`, `ploy-09-reacted.png`, `ploy-10-long-press.png`.
- **Fix:**
  - `src/components/ChatArea.jsx` (~l.1207 and 1041): record `longPressFiredRef = true` when the timer fires. In the scroller's `onClick`, ignore the click that follows (`if (longPressFiredRef.current) { longPressFiredRef.current = false; return; }`).
  - On `max-sm`, render the actions as a **bottom sheet**, as Discord mobile and LINE do: 8 quick reactions, then Reply / Copy / Report / Block, with rows 48px tall.
  - Wrap `group-hover:flex` in `@media (hover:hover)` so the toolbar never sticks on touch.

**S2-3. Servers cannot be organised: there is no "Create category", and voice channels land in the wrong category.**

- Minh wanted categories "📢 THÔNG BÁO / 🎮 GIẢI ĐẤU / 🔊 PHÒNG VOICE". The server menu offers only "Tạo kênh" (Create channel) and "Tạo kênh thoại" (Create voice channel). The category field is a `<select>` of existing categories only.
- Creating a voice channel from the menu put "Valorant 5v5" under **TEXT CHANNELS**.
- Channels cannot be re-ordered by drag, either.
- **Screenshots:** `minh-04-server-menu.png`, `minh-06-channels.png`.
- **Root cause:**
  - `src/components/CreateChannelModal.jsx:19` sets `useState(categories[0])` regardless of `defaultType`.
  - `src/components/ServerDropdown.jsx` has no category action.
  - `src/components/ChannelSidebar.jsx` has no drag handlers.
- **Fix:**
  - `CreateChannelModal.jsx`: default the category to the first category whose channels match the type (voice → the voice category), and add a "+ Danh mục mới / New category" option to the select.
  - `ServerDropdown.jsx`: add "Tạo danh mục / Create category".
  - `ChannelSidebar.jsx`: add drag-and-drop reorder for channels and categories (Discord parity).
  - Also move the name field **above** the 6 type cards in `CreateChannelModal.jsx`. At 768px it sits at y=598, under the fold (`minh-05-create-channel-fold.png`).

**S2-4. No real server templates for a club.**

- "Bắt đầu từ mẫu" (Start from template) only takes a pasted code (`minh-02-template-needs-code.png`).
- Discord offers built-in "Gaming", "School Club", "Study Group" and "Friends" templates. Each pre-creates categories, channels and roles.
- **Fix (`src/components/CreateServerModal.jsx`):** show 4–6 built-in template tiles (Câu lạc bộ / Gaming / Lớp học / Bạn bè) before the code box. Each seeds localised categories, #luật, #thông-báo (announcement), voice rooms and roles.

**S2-5. Seeded names are always English.**

- "TEXT CHANNELS", "VOICE CHANNELS", "General Voice" and "general" appear in Thai and Vietnamese servers.
- For Ploy, the first thing she has to tap is an English word.
- **Root cause:** `services/guilds.js:23,362-365` hard-codes the English names, and `CreateChannelModal.jsx:31` falls back to them.
- **Fix:** pass the creator's locale to server creation. Seed the names from i18n keys (`th`: "ห้องแชท", "ห้องพูดคุย", "ทั่วไป"; `vi`: "KÊNH CHAT", "KÊNH THOẠI", "chung").

**S2-6. The registration rate limit blocks a club fair or a classroom.**

- After 10 sign-ups from one IP in an hour, Jake got "You are doing that too fast. Wait a moment and try again." The message doesn't say how long to wait.
- A university or school Wi-Fi (one NAT IP) cannot onboard a club recruitment booth.
- **Screenshot:** an earlier run, `jake-02-FAIL…` (register form with the error).
- **Root cause:** `routes/auth.js:49-53` sets a limit of 10 per hour, keyed by IP only.
- **Fix:**
  - Raise the default to 60 per hour per IP. Add a per-invite allowance: registrations that carry a valid invite code get their own higher bucket.
  - Show the remaining wait: "Thử lại sau 12 phút" (Try again in 12 minutes).

**S2-7. The composer has no GIF or sticker entry.**

- Jake: "Where's the GIF button? Where are stickers? This is Discord from 2016."
- `StickerPicker.jsx` exists, but the composer shows only upload, emoji and mic (and poll on desktop).
- `:fire:` is sent as literal text.
- **Screenshots:** `jake-07-markdown.png`, `jake-15-emoji-picker.png`.
- **Fix:**
  - `src/components/ChatArea.jsx` composer: add GIF and Sticker buttons next to Emoji. On mobile, put them in one "😊" sheet with tabs.
  - `src/utils/markdownParser.jsx` (or on send in `ChatArea.jsx`): convert `:shortcode:` to unicode or custom emoji.
  - Add a server-emoji tab to `EmojiPicker.jsx`.

**S2-8. Touch targets and iOS zoom.**

- Mobile header icons are 20x20 (28 at larger text).
- Composer icons are 24x26; Send is 28x28; category "+" is 16x16.
- The composer and search inputs are 14px and 12px, so iOS Safari zooms the whole page on focus.
- **Fix:**
  - `ChatArea.jsx` header and composer, `ChannelSidebar.jsx`: add `max-sm:min-w-11 max-sm:min-h-11` hit areas (padding, not bigger icons).
  - Set `font-size:16px` on `textarea`/`input` at `max-sm` in `src/index.css`.

### S3 — Minor

1. **Grammar and localisation bugs:**
   - "**You is sharing their screen**" (`jake-12-screen-share.png`): `src/components/VoiceRoom.jsx:316` passes `voice.youLabel` into `voice.sharingScreenBy`. Add `voice.youAreSharing` = "You are sharing your screen" / "คุณกำลังแชร์หน้าจอ" / "Bạn đang chia sẻ màn hình".
   - The tile label reads "jake(you)" with no space; add a space before `voice.you`.
2. **Role delete button says "role deleted".** `src/components/ServerSettingsModal.jsx:946,1010` use the audit-log key `audit.ROLE_DELETE` ("Đã xóa vai trò" / "Deleted role"). Use a new `roles.delete` key = "Xóa vai trò" / "Delete role".
3. **Server errors reach the UI untranslated:**
   - "Prompt title invalid" (`minh-14-onboarding-error-toast.png`) comes from `services/onboarding.js:187`. Map the `PROMPTS_INVALID` code to `onboarding.errorPromptTitle` in `settings/OnboardingTab.jsx`, and highlight the empty field.
   - The password bubble is native English ("Please lengthen this text…"). In `LoginScreen.jsx`, add `noValidate` and render `auth.passwordHint` in red.
4. **Creating several roles fights the unsaved-changes bar.** Clicking "Tạo vai trò" (Create role) while one is unsaved is rejected twice (`minh-08-unsaved-changes-block.png`). In `ServerSettingsModal.jsx`, auto-save the current role before creating the next one, or let "Create role" save and continue.
5. **Mute has no duration.** The notification popover (`ploy-19-mute-durations.png`) only toggles. Discord and LINE offer 15 min / 1 h / 8 h / 24 h / until I turn it back on. The `notif.muteForever` string already exists. In `src/components/NotificationSettingsPopover.jsx`, open a duration submenu on toggle. On mobile, surface a bell icon in the header instead of hiding it in ⋮.
6. **The mobile drawer truncates the user's own name.** With larger text it becomes one glyph ("ๅ" in `ploy-33-light-chat.png`). In `ChannelSidebar.jsx`, reduce the mic/deafen/settings cluster to icons at 40px and allow the name to take the free space. It could also hide mic/deafen when not in voice.
7. **Voice-note upload on 3G shows a spinner for about 20 s with no progress** (`ploy-15-voice-note-after.png`). In `src/components/VoiceNote.jsx`/`ChatArea.jsx`, show the message optimistically with upload % and allow cancel.
8. **The unsaved-changes bar hides content at 1366x768.** It overlaps the "Câu hỏi" (Questions) section and the last row of the onboarding editor (`minh-12`). Add bottom padding equal to the bar height in `ServerSettingsModal.jsx` when dirty.
9. **Poll creation is hidden on phones** (`max-sm:hidden` in `ChatArea.jsx:1830`). Put it in the "+" attachment sheet on mobile.
10. **Colour contrast (axe, serious)** on timestamps, "0 votes", "23 hours left" and hint text (`text-d-text4`). Raise `--d-text4` in `src/index.css` to meet 4.5:1 on `--d-base`.
11. **The empty-channel intro shows raw markdown** ("ใช้ Markdown ได้ทั้ง \*\*ตัวหนา\*\* ||สปอยล์||"). For a first-timer this reads as garbage. In `ChatArea.jsx`, render the examples formatted, or say "พิมพ์ข้อความแรกเลย! 👋" (Type the first message! 👋) for non-owners.

### S4 — Polish

- **Discord logo in the server rail:** the app uses Discord's Clyde logo while its title is "Antigravity". Jake: "lol it's a Discord skin". Ploy thinks it *is* Discord, so she trusts it with Discord's reputation. `ServerRail.jsx` should use the product's own mark.
- **Event "Where" defaults to "Somewhere else"** even when voice channels exist. In `EventsPanel.jsx`, default to the first voice channel.
- **Invite card after registration** is a second confirm step ("รับคำเชิญ"); merge it into register (see S1-2).
- **Profile:** no banner image upload, avatar decoration or profile effect (Jake: "no way to flex"). `settings/ProfileTab.jsx` could allow a banner image.
- **Discriminator shown** ("@nok_m2#8449"), which Discord retired in 2023. Hide it in `UserProfileModal.jsx`.
- **Onboarding option editor:** the emoji field looks like a truncated text input. `settings/OnboardingTab.jsx` should use an emoji-button trigger.
- **Server initials** "มหF", "UE6": the initials algorithm mixes the RUN suffix and Thai. Prefer the first grapheme of the first two words.

---

## What delighted them

- **Ploy:**
  - Everything was in Thai the moment she opened the link. Thai rendering (Kanit headings) is crisp, and dates use พ.ศ. ("26 ก.ย. 2569").
  - The voice-note bubble "เหมือน LINE เลย" (just like LINE).
  - The block confirmation copy, "เขาจะส่งข้อความหาคุณไม่ได้ และคุณจะไม่เห็นข้อความของเขา" (They won't be able to message you, and you won't see their messages), is clear.
  - After blocking, the troll's message collapses behind "แสดงอยู่ดี" (Show anyway).
  - The light theme picker has big visual swatches.
- **Jake:**
  - Ctrl+K quick switcher, ↑ to edit the last message, a Ctrl+/ shortcuts sheet, code blocks with a language label and Copy, and spoilers.
  - Clicking a voice channel auto-joins, as in Discord.
  - Screen share worked on the first click, and push-to-talk has a keybind in Voice & video.
  - "OK the keyboard stuff is legit."
- **Minh:**
  - The Vietnamese is complete and natural.
  - The invite dialog offers expiry and max-uses presets.
  - The roles permission list has clear descriptions.
  - Onboarding (rules gate plus questions that grant roles/channels) works end to end: Jake saw "Server rules" then "Bạn chơi game nào?" (Which game do you play?).
  - The poll card looks polished.

---

## Scores (1–10)

| Persona | First impression | Ease of use | Visual appeal | Trust / safety | Would recommend |
|---|---|---|---|---|---|
| Ploy (14, TH, iPhone SE) | 3 | 5 | 7 | 3 | 4 |
| Jake (17, power user) | 6 | 8 | 7 | 5 | 6 |
| Minh (21, VN organiser) | 6 | 6 | 7 | 6 | 6 |

- **Ploy:** "ตอนแรกนึกว่าลิงก์เสีย พอเข้าได้ก็โอเค ส่งเสียงได้ แต่มีคนแปลกๆ ขอรูป กดรายงานแล้วก็ไม่รู้ว่าใครจะช่วย" ("At first I thought the link was broken. Once I got in it was OK, I could send voice. But some weird guy asked for pics, I reported him and I don't know who will help.")
- **Jake:** "Keybinds and screen share are solid. No GIFs, no stickers, 'You is sharing' — feels like a beta."
- **Minh:** "Onboarding và poll rất tốt, nhưng không tạo được danh mục thì không tổ chức server CLB được." ("Onboarding and polls are great, but without categories I can't organise a club server.")
