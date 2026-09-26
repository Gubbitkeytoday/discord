# UX persona study: accessibility group (Aisha, Tom, Kenji)

## สรุปภาษาไทย

ผู้ทดสอบสามคนใช้งานแอปแบบครบวงจร ตั้งแต่สมัครสมาชิก เข้าเซิร์ฟเวอร์ผ่านลิงก์เชิญ อ่านและตอบข้อความ กดรีแอค เข้าห้องเสียง ไปจนถึงเปลี่ยนการตั้งค่า รันด้วยสคริปต์ Playwright ที่รันซ้ำได้ (`scripts/ux/accessibility.mjs`) และตรวจด้วย axe-core ทุกหน้าจอ (18 หน้าจอ)

- **Aisha (ตาบอด ใช้ NVDA/VoiceOver กับคีย์บอร์ด):** เจอปัญหาที่ทำให้ใช้งานไม่ได้ (S1) ในตัวรายการข้อความ ข้อความทั้งหมดกลายเป็นข้อความก้อนเดียวใน accessibility tree ไม่มีขอบเขตแยกแต่ละข้อความ ไม่มี role=log/list/article และโฟกัสแถวข้อความไม่ได้ ปุ่ม Reply/React ใช้ `display:none` และจะโผล่เฉพาะตอนเอาเมาส์ไปวาง จึงไม่มีทั้งใน tab order และใน browse mode ของ screen reader ข้อความใหม่ สถานะกำลังพิมพ์ และการเข้าห้องเสียงก็ไม่ถูกประกาศเลย (live region เงียบ 0 ครั้ง) เธอ**ตอบข้อความหรือกดรีแอคไม่ได้เลย** ส่วนที่ดีคือมี skip links, ปุ่มมีชื่อครบ, หน้าตั้งค่ากักโฟกัสได้และคืนโฟกัสถูกที่, มีหน้ารวมคีย์ลัด (Ctrl+/) และสวิตช์มี role=switch
- **Tom (มือสั่น ใช้คีย์บอร์ดกับ switch):** ปุ่มบนหัวช่องขนาด 20×20px และปุ่ม search 14×14px ในการจำลองอาการสั่น (σ=6px) คลิกพลาด 7–20% แถบเครื่องมือของข้อความใช้ได้เฉพาะตอน hover ถ้าใช้ switch กด Tab 120 ครั้งก็ยังไปไม่ถึงปุ่ม Reply ส่วนเมนูคลิกขวาดี (ขนาด 32px ใช้ลูกศรได้) toast หายไปเองใน 2.4–6 วินาทีและไม่หยุดเมื่อ hover ถ้าซูมแอป 200% ส่วนหัวถูกตัด (ปุ่ม "Join Voice" ขาดครึ่ง) และ emoji picker ล้นออกนอกจอ
- **Kenji (ตาบอดสีเขียว-แดงชนิด deuteranopia, ดิสเล็กเซีย, ใช้ภาษาญี่ปุ่น):** จุดสถานะออนไลน์/ห้ามรบกวนบอกด้วยสีอย่างเดียว เมื่อจำลอง deuteranopia จุดสีเขียวกับสีแดงดูเป็นสีเดียวกัน แยกไม่ออก (Discord ใช้รูปทรงต่างกัน) การแปลภาษาญี่ปุ่นครบดี, reduced motion ได้ผล, text spacing ผ่าน และที่ 400% ไม่มี scroll แนวนอน แต่รายชื่อสมาชิกบังแชททั้งหมดที่ 320px

**สิ่งที่ต้องแก้ก่อน:** (1) ทำรายการข้อความเป็น `role="log"` ที่แต่ละข้อความเป็น `article` โฟกัสได้และเลื่อนด้วยลูกศรได้ แถบเครื่องมือต้องแสดงเมื่อโฟกัส (2) เพิ่ม live region สำหรับข้อความใหม่ สถานะกำลังพิมพ์ และห้องเสียง (3) ใส่รูปทรงหรือ mask ให้จุดสถานะ และใส่ชื่อสถานะใน accessible name (4) ขยายปุ่มให้ได้อย่างน้อย 24px (แนะนำ 32px) (5) เพิ่ม `<main>` และ `<h1>` และเปลี่ยน `document.title` ตามช่องที่เปิดอยู่

---

## Method

- Branch: `worktree-agent-a2544c7db84c9d8ec`, merged with `claude/dreamy-goldberg-p3o5ao`. The production build was served by `server.js` with `SERVE_STATIC=1` on a throwaway SQLite DB on port 7030 (`ALLOW_DEV_IDENTITY=0`, and `RATE_LIMIT_REGISTER_PER_HOUR` was raised after the default limit of 10 per hour started returning 429s partway through the study).
- Scenario: `scripts/ux/accessibility.mjs`, which is reusable (`UX_BASE=http://localhost:7030 node scripts/ux/accessibility.mjs [aisha|tom|kenji]`). A friend persona, **Mina**, creates "Book Club" and posts six messages. The persona contexts then join from her invite link, and Mina's context supplies realtime events: typing, new messages, a DND status and a new channel with an @mention.
- Instruments:
  - axe-core (wcag2a/aa, 2.1, 2.2aa, best-practice) on every screen.
  - Keyboard-only navigation that records every tab stop (tag, role, accessible name, visible focus ring).
  - A MutationObserver on `aria-live`/`role=status|alert|log` regions, which approximates what NVDA would say.
  - `ariaSnapshot()` of the accessibility tree.
  - A target-size census (<24px and <44px).
  - A Gaussian "tremor" click simulation (σ = 6px, 40 samples per control).
  - A Machado deuteranopia colour-matrix filter on screenshots.
  - The WCAG 1.4.12 text-spacing override, a 320-CSS-px viewport (400% zoom) and `prefers-reduced-motion`.
- Screenshots: `/tmp/claude-0/-home-user-discord/663d99e8-07c9-5b0f-8b1a-38c6a8c33dc1/scratchpad/shots/persona-accessibility-*.png`. The raw metrics are in `persona-accessibility-results.json` in the same folder.

## Personas

| | **Aisha** | **Tom** | **Kenji** |
|---|---|---|---|
| Age / gender | 34, woman | 29, man | 40, man |
| Occupation | Accessibility tester at an insurance company | Freelance illustrator (now mostly voice/3D work) | Logistics planner |
| Disability / needs | Blind since birth. Uses NVDA on Windows and VoiceOver on her iPhone, keyboard only, and moves around by headings, landmarks and browse mode | Essential tremor in both hands. Uses keyboard plus a 2-switch interface (Tab = next, Enter = select) and sometimes a trackball. Needs large targets and no hover-only, long-press or drag-only controls | Deuteranopia (red-green) and dyslexia. Prefers Japanese UI, reduced motion, wider spacing and zoom |
| Device | Windows laptop 1366×768, Chrome + NVDA | Laptop 1366×768, Chrome, OS switch-access | Desktop at 1280×800, tested down to 400% (320 CSS px) |
| Language | English | English | 日本語 (ja) |
| Tech literacy | Expert | Medium-high | Medium |
| Apps used | Slack (with its screen-reader mode), WhatsApp Web, Teams, Discord (gave up in 2022, came back when its a11y improved) | Discord, Telegram, Steam | LINE, Slack, X |
| Goal | Join her book club's server, catch up, reply to Mina, react, hop into the voice hangout, and turn on reduced motion | The same book club, without mis-clicking anything, from his switch | Join the club in Japanese and see who's online or DND |

## Task results

Time is wall-clock inside the automated run; a real screen-reader user would take 3–10× longer. Keys and clicks are counted input events.

| # | Persona | Task | Success | Time | Keys / clicks | Worst severity |
|---|---|---|---|---|---|---|
| 1 | Aisha | Understand login page (landmarks/headings) | ✅ | 6.3s | 14 / 0 | S3 (no landmarks, input focus = 1px border) |
| 2 | Aisha | Register, keyboard only | ✅ | 7.8s | 59 / 0 | S2 (focus dropped to `<body>` after mode switch and after sign-up) |
| 3 | Aisha | Join server from invite link | ✅ | 12.4s | 2 / 0 | S2 (focus lost to `<body>`, no announcement, title stays "Antigravity") |
| 4 | Aisha | Reach composer (skip link) | ✅ | 4.9s | 1 via skip link / 24 without | none, delightful |
| 5 | Aisha | Read the channel message by message | ❌ (only as one blob) | – | 6 / 0 | **S1** |
| 6 | Aisha | Hear new message and "Mina is typing" | ❌ | 5.1s | 0 | **S1** (0 live announcements) |
| 7 | Aisha | Reply to Mina | ❌ | gave up after 40 Shift+Tab | 40 / 0 | **S1** |
| 8 | Aisha | Add a reaction | ❌ | gave up after 40 | 40 / 0 | **S1** |
| 9 | Aisha | Find keyboard shortcuts (Ctrl+/) | ✅ | 8.2s | 2 / 0 | S3 (contrast 3.09 on "danger" text) |
| 10 | Aisha | Join voice | ✅ | 10.3s | 7 / 0 | S2 (join and "Transmitting" never announced) |
| 11 | Aisha | Settings › Accessibility › Reduced motion › close | ✅ | 26.9s | 140 / 0 | S4 (Settings is 19–20 Tabs from the composer, or Ctrl+,) |
| 12 | Tom | Target-size census, channel view | – | – | – | S2 (8 of 29 targets <24px, 21 <44px) |
| 13 | Tom | Tremor hit-rate on header icons | ⚠ | – | – | S2 (80–93% hit rate on 20×20 icons) |
| 14 | Tom | Reach message toolbar with a shaky mouse | ⚠ | – | – | S3 (toolbar vanished on 3 of 12 wobble steps) |
| 15 | Tom | Accidental double-click heart (tap-to-react) | ✅ no false reaction | – | – | none |
| 16 | Tom | React via right-click menu + arrows | ✅ | 8.9s | 15 / 1 | S3 (no visible focus on first menu item; picker off-screen) |
| 17 | Tom | Switch access: Tab to Reply | ❌ | – | 120 / 0 | **S1** |
| 18 | Tom | Read a toast | ⚠ | toast gone 2.4s after hover | – | S3 (no pause on hover or focus) |
| 19 | Tom | Voice join/leave | ✅ | 3.0s | 0 / 2 | S3 (sidebar Disconnect 28×28) |
| 20 | Tom | Raise app zoom to 200% by keyboard | ✅ | 11.3s | 13 / 0 | S2 (header clipped, no reflow at 200% app zoom) |
| 21 | Kenji | Switch login to 日本語 | ✅ (auto-detected from ja-JP) | 4.4s | 0 / 0 | none, delightful |
| 22 | Kenji | Register in ja, trigger error | ✅ | 5.9s | 0 / 2 | S3 (errors are native bubbles that disappear; 10px hints) |
| 23 | Kenji | Tell online vs DND (deuteranopia) | ❌ | – | – | **S2** |
| 24 | Kenji | See unread / mention | ✅ (bold + number badge) | 3.9s | – | S3 (unread-without-mention is weight only) |
| 25 | Kenji | Reduced motion (OS) | ✅ | 1.8s | – | none, delightful |
| 26 | Kenji | WCAG 1.4.12 text spacing | ✅ (1 → 2 clipped labels) | 3.6s | – | S4 |
| 27 | Kenji | 400% zoom / 320px reflow | ⚠ no h-scroll, but member drawer covers chat | 6.6s | – | S3 |
| 28 | Kenji | Readability in ja (font, sizes) | ⚠ | – | – | S3 (9–11px timestamps and badges; category names stay English) |

### axe-core violations per screen

"region" means content outside any landmark. It follows from the missing `<main>` and is listed separately so the other rules stand out.

| Screen | Rules | Nodes | Non-region rules |
|---|---|---|---|
| login | 1 | 5 | – |
| login-ja | 1 | 5 | – |
| invite-screen | 1 | 4 | – |
| home-empty (after register) | 5 | 11 | color-contrast(1, 3.68:1 on `.leading-relaxed` 11px), landmark-one-main, page-has-heading-one, **skip-link(1)** (target `#message-composer` does not exist on Home) |
| home-ja | 5 | 11 | same as home-empty |
| channel (owner) | 4 | 20 | landmark-one-main, page-has-heading-one, target-size(1) (`.right-2`, the 14×14 search icon button) |
| channel (member) | 4 | 20 | same |
| channel-ja | 4 | 24 | same |
| channel-ja 320px | 2 | 21 | scrollable-region-focusable(1) |
| shortcuts modal | 4 | 23 | color-contrast(2) (`text-d-danger` on `#443439`, 3.09:1, 10px bold), scrollable-region-focusable(1), target-size(1) |
| voice connected | 4 | 14 | color-contrast(3) ("Connected" pill `text-d-online` on `bg-d-online/20`, **2.52:1**, 10px), landmark-one-main, page-has-heading-one |
| message context menu | 2 | 28 | target-size(1) |
| emoji picker | 2 | 22 | target-size(1) |
| user settings / a11y / appearance | 1 | 5 | – |
| settings-ja / a11y-ja | 2 | 22 | target-size(1) |

In total: 18 screens and 0 critical-impact rules, but axe misses the worst problems. Hidden message actions, the flat message text and colour-only status all pass axe, because axe cannot see a control that is not in the DOM or a meaning carried by colour alone.

## Ranked issues

### S1: blockers

**1. The message list is one undifferentiated text blob to a screen reader. Messages are not focusable and there is no arrow-key navigation.** (Aisha, Tom)
- What happened: `ariaSnapshot()` of the chat pane gives a single `text:` node: *"mina 15:11 Chapter 1 thoughts… 15:11 Chapter 2 thoughts… 15:11 Chapter 3…"*. There are no list items, articles, per-message boundaries or author headings. The `<time>` element is missing, so the times are bare "15:11" strings. Up and Alt+Up from the composer do nothing (Alt+Up switches channel). Shift+Tab from the composer goes Formatting → Upload → Search and skips the whole history. The message row has no tabindex.
- Aisha: *"It just reads me a wall. I can't tell where one message ends, who wrote the one I'm on, or jump to the newest. In Discord I press Up from the box and I'm on the last message."*
- Screenshots: `persona-accessibility-aisha-04-channel.png`, `persona-accessibility-aisha-05-reply-hunt.png`
- Root cause: `src/components/ChatArea.jsx` renders each `<div id="message-…" className="message-row group …">` (around line 1203) without a role, tabindex or label. The scroller (around line 1045) has no role.
- Fix, in `src/components/ChatArea.jsx`:
  - Give the scroller `role="log" aria-label={t('chat.messagesIn', { channel })}` and `aria-live="off"`, because announcements go through the dedicated region in issue 2.
  - Make each row `role="article"` with `aria-labelledby` pointing at the author name plus a hidden full timestamp, and `aria-roledescription={t('a11y.message')}`. Render timestamps as `<time dateTime=… aria-label={formatFullTimestamp}>`.
  - Use a roving `tabIndex` (0 on the active row, −1 on the others). Up and Down move between rows, Home and End jump to the ends, PageUp and PageDown move by screen. Up from an empty composer focuses the last message, as Discord does.
  - On a focused row: Enter or R replies, E edits, Plus opens the reaction picker, Shift+F10 or the ContextMenu key opens `MessageContextMenu`, and Escape returns to the composer.

**2. The message hover toolbar (React, Reply, Edit, More) is `display:none` unless the mouse is over the row.** (Aisha, Tom)
- What happened: with the mouse parked away, 120 Tabs (Tom's switch) never reach a Reply button. The toolbar is `hidden group-hover:flex`, so it is absent from both the tab order and NVDA browse mode. The CSS rule `.message-row:focus-within .message-actions` can never fire because nothing inside a plain-text message is focusable. In one run the Reply button *was* reached, in 26 Tabs, only because the pointer happened to rest over that message. Keyboard access currently depends on where the mouse is.
- Tom: *"So I have to get my shaky hand onto the exact message, hold it still, and then hit a 24px arrow? With my switch I can't reply at all."*
- Screenshots: `persona-accessibility-tom-02-hover-toolbar.png`, `persona-accessibility-FAIL-tom-switch-access-Tab-count-to-reach-Reply-f.png`
- Fix: once issue 1 makes rows focusable, `:focus-within` shows the toolbar. Also:
  - Change `hidden group-hover:flex` to `flex opacity-0 group-hover:opacity-100 group-focus-within:opacity-100` so the buttons stay in the accessibility tree.
  - Keep them out of the Tab order with `tabIndex={-1}` unless the row is active, and expose them through a roving `role="toolbar"` (Left/Right).
  - Add Settings › Accessibility › "Always show message actions" for switch and tremor users. Discord's equivalent is keyboard mode.

**3. New messages, typing and voice state are never announced.** (Aisha)
- What happened: the live-region monitor recorded **0** announcements while Mina typed for 1.5s ("Mina is typing…" was visible), posted "Welcome Aisha!…", and while Aisha joined voice and became "Transmitting". The typing line (`ChatArea.jsx` around line 1891) is a plain `<div>`. The voice panel has no live region, and `CallPanel`'s `aria-live="assertive"` covers incoming calls only.
- Aisha: *"Mina said she welcomed me. I heard nothing. I'd have to keep re-reading the whole wall to see if anything changed."*
- Fix:
  - Add one persistent visually-hidden `<div aria-live="polite" aria-atomic="false" id="sr-announcer">` in `src/App.jsx`, with an `announce(text)` helper.
  - Call it from the message-received handler for the active channel ("mina_…: Welcome Aisha!…"), throttled and batched ("3 new messages") and skipped for your own messages. Discord has a matching setting, "Announce new messages".
  - Call it for the typing line only when it changes (debounce to 1 per 5s), or put `aria-live="polite"` on the typing `<div>` in `ChatArea.jsx`.
  - Call it on voice connect and disconnect, on mute and deafen toggles, and when somebody joins or leaves (`VoiceRoom.jsx`, `ChannelSidebar.jsx` user panel).

### S2: major

**4. There is no `<main>` or `<h1>`, and `document.title` never changes from "Antigravity".** (Aisha)
- Evidence: axe `landmark-one-main` and `page-has-heading-one` on every app screen, plus `region` on 4–27 nodes per screen. The landmarks found are `nav "Servers"` and `aside "Members"` only. The channel list and chat are not landmarks, and the first heading is `H2 "Welcome to #general!"`, which scrolls away. The title stayed "Antigravity" after joining the server and switching channels, so NVDA's title key (Insert+T) and the alt-tab list give no location.
- Fix:
  - `src/App.jsx`: wrap the chat column in `<main aria-label={channelName}>` and the channel sidebar in `<nav aria-label={t('a11y.channels')}>`.
  - `src/components/ChatArea.jsx`: make the header channel name an `<h1>`, visually unchanged.
  - Set `document.title = `#${channel.name} | ${server.name} – Antigravity`` in an effect, with the unread count prefixed, as Discord and Slack do.

**5. Focus is dropped to `<body>` after the auth mode switch, after sign-up and after accepting an invite.** (Aisha)
- Evidence:
  - After pressing "Sign up", focus stays on the same button, which now reads "Log in". Nothing announces that the form changed. The next Tab goes to `<body>` and then the language button.
  - After registering, and after "Accept invite", `document.activeElement` is `<body>`.
- Fix:
  - `src/components/LoginScreen.jsx`: on a `mode` change, focus the `<h1>` (tabIndex −1) or the first input, since the username field already has `autoFocus` but it only runs on mount. Also announce "Create an account" through `role="status"`.
  - `src/App.jsx`: after auth and after join, focus the channel `<h1>` from issue 4, or the composer.

**6. Online, idle and DND status is colour-only, a 10px dot with no text alternative.** (Kenji, Aisha)
- Evidence: in the member list, Mina was DND (`bg-d-danger`) and the others were online (`bg-d-online`). In the deuteranopia simulation all four dots render the same olive: `persona-accessibility-kenji-06b-members-deutan.png` against `persona-accessibility-kenji-06-members.png`. The accessible names are just "mina_… 👑" and "aisha_…". The dot has no `aria-label`, `title` or SVG shape, so Aisha cannot hear status either.
- Kenji: 「ミナさんは緑？赤？全部同じ茶色に見える。話しかけていいのか分からない。」 ("Is Mina green or red? They all look the same brown to me. I can't tell if it's OK to message her.")
- Fix:
  - `src/components/MemberList.jsx` (`STATUS_COLORS`, around line 9 and line 98), `ChannelSidebar.jsx` (user panel), `HomeDirectMessages.jsx` and `UserProfileModal.jsx`: replace the plain dot with a shared `<StatusIndicator status>` that draws Discord's shapes: a filled circle for online, a crescent for idle, a circle with a horizontal bar for DND and a hollow ring for offline.
  - Size it at 12–14px with a 3px cut-out ring.
  - Append the status to the row's accessible name, for example `aria-label={`${name}, ${t('status.'+status)}`}`.

**7. Header and composer icons are 14–20px, which fails WCAG 2.5.8 and misses under tremor.** (Tom)
- Evidence: 8 of 29 targets in the channel view are under 24px: Notification settings, Pinned, Member list and Inbox at 20×20, the search button at 14×14 (axe `target-size`), and Formatting at 20×22. In the voice view the header icons shrink to 16×16. The category toggles "TEXT CHANNELS" and "VOICE CHANNELS" are 16px tall. Tremor simulation at σ=6px gave hit rates of 80–93% on the 20px icons against 100% on the 32px user-panel buttons.
- Tom: *"One in eight clicks on the bell opens the pin list instead. That's how I end up muting the wrong thing."*
- Fix:
  - `src/components/ChatArea.jsx` header buttons: `p-1` becomes `p-2`, giving at least a 32×32 hit area with the 20px icon unchanged.
  - Search button: `w-8 h-8`.
  - `ChannelSidebar.jsx` category buttons: `py-1.5` and `min-h-[28px]`.
  - `VoiceRoom.jsx` header icons: 24px or more.
  - Add a "Larger click targets" toggle to `AccessibilityTab.jsx` that sets `--hit-min: 44px`.

**8. Unread channels and live voice status are not exposed to assistive tech.** (Aisha)
- Evidence: the channel button accessible names are "general" and "spoilers 1". An unread channel without a mention differs only by `font-weight` 600 against 500, and a white pill. "General Voice Connected" only gained its suffix while she was connected. The number of people in a voice channel is not in the name.
- Fix: in `src/components/ChannelSidebar.jsx`, build names like `aria-label={`${name}${unread ? ', ' + t('a11y.unread') : ''}${mentions ? ', ' + t('a11y.mentions', {count}) : ''}`}`, and for voice channels "General Voice, voice channel, 2 people".

**9. App zoom at 200% clips the header instead of reflowing.** (Tom, Kenji)
- Evidence: after raising Settings › Appearance › Zoom by keyboard, the 1366px window crops the "Join Voice" button in half. Search, member-list and inbox icons are off-screen with no scrollbar (`overflow:hidden`), and the send button is clipped. See `persona-accessibility-tom-08-zoomed-channel.png`. At a real 320px viewport the mobile layout works, so the breakpoints simply don't account for the app's own zoom.
- Fix: `src/components/settings/AppearanceTab.jsx` / `useUserSettings.js` should implement zoom as a root `font-size` (rem) change, or divide the viewport width by the zoom factor when choosing the `max-sm`/`max-md` layout, so 200% app zoom on 1366px behaves like a 683px window, with drawers and a collapsed header overflow menu.

### S3: minor

**10. The toast auto-dismisses after 2.4–6s with no pause on hover or focus, and toasts are injected rather than announced from a persistent region.** (Tom, Aisha)
- Evidence: the "Copied link" toast disappeared 2.4s after the pointer rested on it. `ToastStack.jsx` sets `setTimeout(onDismiss, ttl)` with no pause logic. Each toast node is created with `role="status"` already on it, which NVDA and JAWS often do not announce.
- Fix, `src/components/ToastStack.jsx`:
  - Put `role="region" aria-live="polite"` on the always-mounted stack container, and `role="alert"` for errors.
  - Pause the timer on `mouseenter`/`focusin` and resume on leave.
  - Make the minimum TTL 8s, or unlimited for errors when Reduced motion or "Keep toasts" is on (WCAG 2.2.1).

**11. The emoji picker opened from the context menu renders partly off-screen and has no dialog semantics.** (Tom, Aisha)
- Evidence: rect [1062, 532 → 1402, 844] on a 1366×768 viewport. The right column and the bottom rows are cut off, and the flag category tab is clipped (`persona-accessibility-tom-05-picker-from-menu.png`). The container has no `role` or `aria-label`. Focus does land on "Search emoji", and typing "heart" then Enter works.
- Fix, `src/components/EmojiPicker.jsx`:
  - Clamp the position with `Math.min(x, innerWidth - width - 8)` and the same for y, or anchor it to the message row.
  - Add `role="dialog" aria-label={t('emoji.pickerTitle')}`.
  - Give the result grid `role="grid"` with arrow-key navigation, and `aria-label` on every emoji button using its name ("thumbs up").

**12. Focus indicators are weak or missing.**
- Evidence:
  - Every text input uses `focus:outline-none focus:border-d-brand`: a 1px colour change on a dark border, about 2:1 against `#1e1f22`. This affects `LoginScreen.jsx` inputs, the search box and the composer.
  - The first context-menu item, focused programmatically after a right-click, shows no highlight (`persona-accessibility-tom-04-context-menu.png`), because the menu items only style `hover:`.
- Fix:
  - Replace `focus:outline-none` with `focus-visible:ring-2 focus-visible:ring-d-brand`, or keep the global `:focus-visible` outline, in `LoginScreen.jsx`, `ChatArea.jsx` (search and composer wrapper `focus-within:ring-2`) and `settings/primitives.jsx`.
  - `ContextMenu.jsx` items: add `focus:bg-d-brand focus:text-white` alongside the `hover:` classes.

**13. Colour contrast.**
- Evidence: the voice "Connected" pill is 2.52:1 (`bg-d-online/20` with `text-d-online`, 10px). The shortcuts modal's danger text is 3.09:1. The home onboarding copy is 3.68:1 at 11px.
- Fix:
  - `ChannelSidebar.jsx` voice badge: `bg-d-online text-black` or `text-white` on `bg-d-online/80`.
  - `ShortcutsModal.jsx`: use `text-d-danger` on the plain surface, or lighten it to #ff6b6e.
  - Home empty-state (`HomeDirectMessages.jsx`): use `text-d-text2`.

**14. Tiny text for dyslexic readers, and English data in the Japanese UI.** (Kenji)
- Evidence: timestamps are 10–11px, badges 9–10px, the date divider 「今日」 11px and field hints 10px (「パスワードのリセットに必要です…」). Section headings are uppercase-tracked Latin at 11px. The default category names "TEXT CHANNELS" and "VOICE CHANNELS" and the channel "General Voice" are created in English, even for a ja user (`persona-accessibility-kenji-04-channel-ja.png`). `body` font is `Inter, Kanit, sans-serif`, with no CJK face declared, so Japanese falls back to whatever the OS picks.
- Fix:
  - Raise the minimum to 12px (`text-[10px]` and `text-[11px]` become `text-xs`) in `ChatArea.jsx` timestamps, `LoginScreen.jsx` hints, `ChannelSidebar.jsx` badges and `MemberList.jsx` headings.
  - Scale timestamps with the "Chat font scale" setting.
  - Seed default categories and channels in the creator's locale in `CreateServerModal.jsx` and the server-side template.
  - Add `"Noto Sans JP", "Hiragino Sans", "Yu Gothic UI"` to the font stack in `index.css` for `:lang(ja)`.
  - Offer a dyslexia-friendly font option (for example "Atkinson Hyperlegible") and a letter-spacing slider in `AccessibilityTab.jsx`.

**15. At 320px (400% zoom) the member drawer stays open over the chat.** (Kenji)
- Evidence: no horizontal scroll (good), but the member list that was toggled on at desktop width covers about 70% of the screen and the composer (`persona-accessibility-kenji-09-reflow-400.png`).
- Fix: in `src/App.jsx` / `MemberList.jsx`, close the member drawer automatically when crossing below the `md` breakpoint, and give the overlay a visible close button and Escape handling.

**16. Registration errors are native `:invalid` bubbles that vanish after a few seconds.** (Kenji, Aisha)
- Evidence: a short password shows Chrome's bubble ("Please lengthen this text…"), which covers the hint and disappears. The hint 「8文字以上」 is not linked with `aria-describedby`.
- Fix: in `LoginScreen.jsx`, use `noValidate` on the form, validate in JS, render a persistent inline error under the field (icon plus text, not colour alone) with `aria-invalid` and `aria-describedby`, and link the hints with `aria-describedby`.

**17. The "Skip to message composer" link is broken on Home.**
- Evidence: axe `skip-link` fails because `#message-composer` is not rendered in DMs Home.
- Fix: in `src/App.jsx`, render that skip link only when a composer exists, or point it at the DM list.

### S4: polish

**18.** Settings takes 19–20 Tabs from the composer. Ctrl+, exists but is listed only in the shortcuts modal. Add it as `aria-keyshortcuts="Control+Comma"` on the gear button and mention it in its tooltip (`ChannelSidebar.jsx`).

**19.** Text-spacing override: only the `@handle` in the user panel starts clipping (1 → 2 clipped labels). Allow two lines there, or use a tooltip (`ChannelSidebar.jsx`).

**20.** The sidebar Disconnect button is 28×28 and sits right next to the 32px settings gear. Hanging up needs no confirmation, which matches Discord, but a bigger gap would help (`ChannelSidebar.jsx` voice panel: `w-9 h-9`, `gap-2`).

## What delighted them

- **Skip links** (Aisha): the first Tab is "Skip to message composer" and the second is "Skip to channel list". *"Finally someone read WCAG 2.4.1."*
- **Every icon button has a real name**: Mute, Deafen, Pinned messages, Upload files or images. The switch reports `role=switch` with `aria-checked`, and "Member list" has `aria-pressed`.
- **User settings** (Aisha): a labelled `aria-modal` dialog, focus trapped, and focus returns to "User settings" on Escape. Nav items are real buttons.
- **Ctrl+/ shortcuts sheet**, with Discord-parity shortcuts (Alt+↑/↓, Ctrl+K, Ctrl+Shift+M/D/H) and roles reorderable by `Alt+↑/↓` with `aria-keyshortcuts`.
- **Right-click message menu** (Tom): 32px rows, arrow-key navigation, and focus starts inside it.
- **Tap-to-react never misfired**: a tremor double-click selects a word instead of reacting.
- **Accessibility settings** (Kenji): Saturation slider, High contrast, Reduced motion, three role-colour modes with a live "Kira" preview, and TTS. OS `prefers-reduced-motion` is honoured with 0 remaining animations. 「設定がDiscordより親切。」 ("The settings are friendlier than Discord's.")
- **Japanese**: auto-detected from the browser, no untranslated strings in Settings › Accessibility, and CJK renders cleanly. At 320px there is no horizontal scroll and a 「チャンネルを表示」 button.

## Comparison with the apps they use

- **Discord:** messages are focusable, and Up from an empty composer enters the history. It has a "keyboard mode" that shows the action bar on the focused message, announces new messages through a live region, and uses status *shapes* (moon, minus, ring). The page title is "#channel | Server". Antigravity matches Discord's settings but not its message list.
- **Slack:** the message list is a `role=list`/`listitem` with per-message labels ("Mina, 3:11 PM, Welcome…"). F6 cycles landmarks, and a screen-reader mode reduces verbosity.
- **WhatsApp Web / Telegram Web:** messages can be reached with Tab and arrow keys, and new messages are announced. LINE, which Kenji uses, marks online status with text rather than colour.
- **Teams:** toasts pause while hovered, and "Leave" is a large labelled button.

## Scores (1–10)

| Persona | First impression | Ease of use | Visual appeal | Trust / safety | Would recommend |
|---|---|---|---|---|---|
| Aisha | 5 (skip links and named buttons are promising) | **2** (can't read, reply or react) | 4 (structure as heard: flat) | 6 | **2** |
| Tom | 7 | 4 (switch cannot reply; small header icons) | 7 | 7 | 4 |
| Kenji | 8 (ja auto-detected, clean) | 6 | 6 (tiny timestamps, English categories) | 6 (can't tell DND) | 6 |

Aisha: *"The settings screen is better than Discord's. The chat, the one thing I came for, I cannot use. I'm back on WhatsApp."*
Tom: *"Give me focusable messages and bigger header buttons and I'd switch from Discord."*
Kenji: 「日本語は完璧。でもステータスの色が見分けられないのは致命的。」 ("The Japanese is perfect. But not being able to tell the status colours apart is a deal-breaker.")
