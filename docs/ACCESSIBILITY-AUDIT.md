# Accessibility Audit: WCAG 2.2 AA and Discord Parity

Audit date: 2026-09-26. Build: `claude/dreamy-goldberg-p3o5ao` merged into this branch, `npm run build`, served by `server.js` with `SERVE_STATIC=1` on a throwaway SQLite DB.
Method: axe-core 4.x through Playwright (Chromium), a manual-style probe suite (`scripts/a11y/axe-scan.mjs`), and a code review of the components involved.
Scope: 48 views and modals × {dark, light} × {desktop 1366×860, mobile 390×844}, which comes to 192 scans.

---

## สรุปสำหรับผู้บริหาร (ภาษาไทย)

**สถานะโดยรวม: ยังไม่ผ่าน WCAG 2.2 AA.** พื้นฐานหลายอย่างทำไว้ดีแล้ว แต่งานหลักของแอปแชต (อ่านข้อความและจัดการข้อความด้วยคีย์บอร์ดหรือโปรแกรมอ่านหน้าจอ) ยังทำไม่ได้

**จุดที่ทำได้ดี**
- หน้าตั้งค่าผู้ใช้และตั้งค่าเซิร์ฟเวอร์ (27 แท็บ) ผ่าน axe เกือบทั้งหมด ปุ่มสวิตช์ใช้ `role="switch"` และ radiogroup ถูกต้อง
- dialog มี `aria-modal`, focus trap และปิดด้วย Esc ได้ทุกตัวที่ทดสอบ
- Reflow ที่ 320px (ซูม 400%) ไม่มีสกรอลล์แนวนอน และ text-spacing (1.4.12) ไม่ตัดข้อความ
- ปฏิบัติตาม `prefers-reduced-motion` จริง (ไม่มี element เคลื่อนไหวเหลืออยู่เลย) และมีสวิตช์ลดการเคลื่อนไหวในแอป
- มีการตั้งค่าสไตล์ Discord ครบหลายตัว ได้แก่ saturation, สีบทบาท 3 โหมด, high-contrast, GIF/อีโมจิ/สติกเกอร์ และความเร็ว TTS
- ข้อความภาษาไทย (สระบน-ล่าง, ฤๅ, ฎ, ฐ) แสดงผลครบ ไม่โดนตัด ใช้ line-height 26px

**ปัญหาร้ายแรงที่ต้องแก้ก่อน (Critical/Serious)**
1. **ใช้คีย์บอร์ดจัดการข้อความไม่ได้ (2.1.1).** แถวข้อความ focus ไม่ได้ และแถบปุ่ม Reply/React/More จะโผล่ด้วย Tab ได้เฉพาะข้อความที่มีลิงก์อยู่ข้างใน ส่วน Shift+F10 ก็ไม่เปิดเมนูคลิกขวา ทำให้ปักหมุด ตอบกลับ สร้างเธรด หรือส่งต่อข้อความด้วยคีย์บอร์ดไม่ได้
2. **โปรแกรมอ่านหน้าจอไม่ประกาศอะไรเลย (4.1.3).** รายการข้อความไม่มี `role="log"`/`aria-live` ข้อความใหม่และ "กำลังพิมพ์…" จึงเงียบ (probe จับ live announcement ได้ 0 ครั้ง)
3. **ไม่มี `<main>` ไม่มี h1 ไม่มี skip link (1.3.1, 2.4.1)** และ title ของหน้าไม่เปลี่ยนตามช่องที่เปิดอยู่ (2.4.2)
4. **คอนทราสต์สี (1.4.3).** โทเคน `--color-d-text4` (#80848e) ได้แค่ 3.37–3.74:1 ในทุกธีม สีบทบาทแสดงตามค่าดิบ (เช่น #f1c40f บนพื้นขาวได้ 1.66:1 และ #e91e63 บนธีมมืดได้ 2.9:1) สมาชิกออฟไลน์ถูกทำ opacity 60% จนเหลือ 1.83:1 ป้าย "Connected" ของห้องเสียงได้ 2.52:1
5. **ลิงก์ในข้อความไม่มีขีดเส้นใต้ (1.4.1).** ต่างจากข้อความรอบข้างแค่ 1.94:1 และเช็กการตั้งค่า "Always underline links" ของ Discord ก็ยังไม่มี
6. **เมนู/ตัวเลือกที่ใช้คีย์บอร์ดไม่ได้.** เมนู dropdown ของเซิร์ฟเวอร์ไม่ย้าย focus ใช้ลูกศรไม่ได้ และปิดด้วย Esc ไม่ได้ ใน Quick Switcher ผลลัพธ์เป็นปุ่มที่ผูกแค่ `onMouseDown` ส่วน autocomplete ของ @mention และ :emoji: ไม่มี `role=listbox` หรือ `aria-activedescendant`
7. **Target size (2.5.8).** ปุ่มค้นหา 14×14px และปุ่ม "+" สร้างช่อง 16×16px ชิดกับหัวหมวด
8. **มือถือ/ซูม 400% (1.4.10).** ช่องค้นหาหายไปเมื่อกว้าง <768px และ Inbox หายไปเมื่อกว้าง <640px
9. **เรียงลำดับเซิร์ฟเวอร์และบทบาทได้ด้วยการลากเท่านั้น (2.5.7).**

**สิ่งที่ควรเพิ่มให้เท่า Discord.** ตัวเลือก "Always underline links", "Sync reduced motion with computer", "Apply saturation to custom colours", ปรับคอนทราสต์ของสีบทบาทให้อัตโนมัติ, นำทางข้อความด้วยลูกศร พร้อมคีย์ลัดเมื่อ focus ข้อความ (E/R/P/Backspace/+), คีย์ลัด Alt+Shift+↑/↓ (ช่องที่ยังไม่อ่าน), Esc (mark read), Ctrl+/ (รายการคีย์ลัด) และข้อความประกาศสำหรับโปรแกรมอ่านหน้าจอ

**ประมาณงาน.** แก้ 15 ข้อแรกได้ในราว 3–5 วันทำงาน งานส่วนใหญ่อยู่ใน `ChatArea.jsx`, `index.css` (โทเคนสี), `ServerDropdown.jsx`, `QuickSwitcher.jsx`, `ComposerAutocomplete.jsx` และ `App.jsx`

---

## 1. How to reproduce

```bash
npm ci && npm run build
npm i --no-save playwright-core @axe-core/playwright axe-core
node scripts/a11y/axe-scan.mjs                       # full matrix + probes (~15 min)
node scripts/a11y/axe-scan.mjs --only=dark-desktop   # one combo
node scripts/a11y/axe-scan.mjs --views=server-chat,emoji --no-probes
node scripts/a11y/axe-scan.mjs --probes-only
```

Output goes to `$A11Y_OUT` (by default the session scratchpad `shots/`). The script writes `axe-results.json` (or `axe-results-partial.json` when filtered), `probes.json`, and `a11y-<view>-<theme>-<viewport>.png` for every view that has a serious or critical violation. Axe tags used: `wcag2a, wcag2aa, wcag21a, wcag21aa, wcag22aa, best-practice`. Views whose content sits in a modal are scanned inside `[role=dialog]` only, so page-level findings are not counted twice.

Evidence screenshots from this run, in the scratchpad `shots/` directory:
- `a11y-server-chat-light-desktop.png`: role colours on white.
- `a11y-pinned-dark-desktop.png`: unnamed close button and text4 contrast.
- `a11y-voice-room-light-desktop.png`: "Connected" badge and error banner contrast.
- `a11y-server-dropdown-light-desktop.png`: mint "Invite people" at 1.54:1.
- `a11y-quick-switcher-light-desktop.png`: text4 hints.
- `a11y-mobile-no-search-inbox.png`: header at 390px with no Search or Inbox.
- `a11y-focus-rail.png`: server dropdown still open after Escape.
- `a11y-focus-composer.png`: composer focused, with no focus indicator.
- `a11y-thai-render.png`: Thai glyph stacking.
- `a11y-reflow-*.png`, `a11y-text-spacing.png`, `a11y-settings-accessibility-tab.png`.

---

## 2. axe-core results per view

Cells show **rules / nodes**. Desktop is 1366×860 and mobile is 390×844. `n/a` means the entry point does not exist at that width (see issue #9).

| View | dark desktop | light desktop | dark mobile | light mobile |
|---|---|---|---|---|
| login | 1/5 | 1/5 | 1/5 | 1/5 |
| register | 1/7 | 1/7 | 1/7 | 1/7 |
| home / DMs | 3/7 | 3/7 | 1/4 | 1/4 |
| DM chat | 4/11 | 4/11 | 1/7 | 1/7 |
| server chat | 6/22 | 6/28 | 5/19 | 5/24 |
| member list | 6/22 | 6/28 | 3/18 | 3/24 |
| thread | 5/9 | 5/10 | 3/6 | 3/6 |
| forum | 4/10 | 4/11 | 3/9 | 3/9 |
| voice room | 4/15 | 4/19 | 4/10 | 5/12 |
| events (dialog) | 1/1 | 1/1 | 1/1 | 1/1 |
| server dropdown | 6/30 | 6/38 | 3/25 | 3/32 |
| quick switcher (dialog) | 1/4 | 1/4 | 1/4 | 1/4 |
| message context menu | 4/30 | 4/37 | 3/27 | 3/33 |
| member context menu | 4/30 | 4/38 | 3/27 | 3/36 |
| emoji picker | 6/24 | 6/30 | 5/21 | 5/26 |
| search results | 5/20 | 5/25 | n/a | n/a |
| inbox | 4/20 | 4/28 | n/a | n/a |
| pinned messages | 5/25 | 5/31 | 4/22 | 4/27 |
| user profile (dialog) | 0/0 | 1/1 | 0/0 | 1/1 |
| create server (dialog) | 0/0 | 0/0 | 0/0 | 0/0 |
| create channel (dialog) | 2/2 | 2/2 | 2/2 | 2/2 |
| User settings: Profile | 0/0 | 0/0 | 1/1 | 1/1 |
| User settings: Account, Privacy, Activity, Voice, Notifications, Keybinds, Text & Images, Streamer, Applications | 0/0 | 0/0 | 0/0 | 0/0 |
| User settings: Appearance | 1/1 | 1/1 | 0/0 | 0/0 |
| User settings: Accessibility | 0/0 | 0/0 | 1/2 | 1/3 |
| Server settings: Overview | 1/2 | 1/2 | 0/0 | 0/0 |
| Server settings: Roles | 3/3 | 3/3 | 3/3 | 3/3 |
| Server settings: Channel permissions | 1/1 | 1/1 | 1/1 | 1/1 |
| Server settings: Soundboard / Reports | 1/1 | 1/1 | 1/1 | 1/1 |
| Server settings: Audit log | 2/12 | 2/12 | 2/11 | 2/11 |
| Server settings: Members | 1/1 | 1/2 | 1/1 | 1/2 |
| Server settings: Emoji, Stickers, Webhooks, AutoMod, Bans, Onboarding, Insights, Invites | 0/0 | 0/0 | 0/0 | 0/0 |

Rule totals across the desktop matrix plus the mobile re-run:

| Rule | Impact | WCAG | Nodes | Root cause |
|---|---|---|---|---|
| region | moderate | best practice | 682 | Nothing is wrapped in `<main>`; only `nav` and `aside` landmarks exist. |
| color-contrast | serious | 1.4.3 | 287 | Raw role colours, `text-d-text4`, `d-danger`/`d-online`/`d-brand` used as text. |
| link-in-text-block | serious | 1.4.1 | 28 | Links are not underlined (1.94:1 dark, 2.15:1 light against body text). |
| landmark-one-main / page-has-heading-one | moderate | 1.3.1 / 2.4.1 | 28 + 28 | App shell has no `<main>` and no `<h1>`. |
| target-size | serious | 2.5.8 | 22 | Search submit button 14×14. |
| button-name | critical | 4.1.2 | 4 | Pinned-messages close button. |
| heading-order | moderate | 1.3.1 | 4 | Roles / Channel permissions headings skip levels. |
| aria-required-attr | critical | 4.1.2 | 2 | `role="switch"` without `aria-checked` in Roles. |
| aria-allowed-role | minor | 4.1.2 | 2 | `<form role="dialog">` in Create channel. |
| scrollable-region-focusable | serious | 2.1.1 | 2 | Audit-log scroller cannot be focused. |

Axe cannot see the most severe problems (keyboard access to messages, live regions, menus). Those come from the probes in section 3.

---

## 3. Manual probe results

| Check | Result |
|---|---|
| Landmarks | `nav "Servers"` and `aside "Members — 2"` only. No `main`, no `header`/banner, no `search`. Channel list is not a landmark. |
| Headings | Only "Welcome to #channel" (h2, which disappears once history is long), then "Online — 1" and "Offline — 1" (h3). No h1. Channel name in the header is not a heading. |
| Skip link | None. 35 Tab presses from page top to reach the composer. |
| Message list | Plain `div`s: no `role=log/list/article`, no `tabindex`, no `aria-labelledby`. **0 focusable messages**. ArrowUp from the list does nothing. |
| Live regions in chat | **None.** A second user typed and then sent a message, and the mutation observer on live regions recorded **0 announcements**. |
| Toast | `role="status"` per toast. Each toast mounts together with its text, so NVDA and VoiceOver often miss it; a persistent container is needed. |
| Hover toolbar via keyboard | Shown on `:focus-within`, but a row only receives focus if it already contains a link. The Tab walk reached the toolbar (React/Reply/Delete/More) only on the one message with a URL. |
| Shift+F10 / ContextMenu key | Does not open the message menu. |
| Context menu (mouse-opened) | Focus moves to the first `menuitem`, ↓ moves, Esc closes. **Pass.** |
| Server dropdown | Enter opens it, but focus stays on the trigger, ↓ does nothing, and **Esc does not close it**. |
| Server rail | No arrow-key roving; every icon is a Tab stop. Unread/mention badge is outside the button, and `aria-label` overrides it, so the unread state is not announced. |
| Dialogs | User settings, Create server and Quick switcher move focus in, trap it, and close on Esc. **Server settings does not move focus in** (it stays on BODY). **Quick switcher does not return focus** on close (it lands on BODY). No dialog makes the background `inert`/`aria-hidden`. |
| ↑ in empty composer edits last message | **Pass.** |
| Target size 2.5.8 | Search submit 14×14; "Create text/voice channel" 16×16 sitting 0 px from the category toggle. Header icons (20×20) pass through the spacing exception. |
| Reflow 320×256 (400 %) and 683×430 (200 %) | No horizontal scroll, composer reachable. **But Search is not rendered below 768 px and Inbox is not rendered below 640 px.** |
| Text spacing 1.4.12 | 0 clipped elements. **Pass.** |
| Reduced motion (OS) | 0 animated or transitioned elements, 0 smooth-scroll. **Pass.** |
| Focus visible | Global `:focus-visible` 2px brand outline. The composer textarea and the header search input use `focus:outline-none` and show no indicator. Rail buttons animate the outline (`transition-all`), so for the first 200 ms the ring is 0–1 px. |
| Thai | Renders correctly with the system fallback font (Kanit is fetched from Google Fonts and is blocked offline, so self-hosted installs never get it). Line-height 26px, no clipping. The Thai message inherits `lang="en-US"`. |
| Role colours | Rendered raw, with no contrast correction. Of Discord's 20 preset role colours, **13 fail 4.5:1 on the dark canvas** and **12 fail on light** (full table in `probes.json`). |
| Document title | Always "Antigravity" (plus the unread count); it never names the channel. |

---

## 4. WCAG 2.2 A/AA conformance summary

Legend: **Pass**, **Fail**, **Partial** (meets it in most places, with listed exceptions), **N/A**. Issue numbers refer to section 5.

| # | Criterion | Level | Result | Notes |
|---|---|---|---|---|
| 1.1.1 | Non-text content | A | Fail | Presence dot (online/idle/dnd) has no text; voice speaking ring has no text (#11). Emoji and custom emoji have alt text. |
| 1.2.1 | Audio/video only (prerecorded) | A | N/A | Voice messages are user-generated; no transcript feature (advisory). |
| 1.2.2 | Captions (prerecorded) | A | N/A | User-generated media. |
| 1.2.3 | Audio description / media alternative | A | N/A | |
| 1.2.4 | Captions (live) | AA | N/A | Live voice/video is real-time communication between users. |
| 1.2.5 | Audio description (prerecorded) | AA | N/A | |
| 1.3.1 | Info and relationships | A | Fail | No list/log/article semantics for messages; no main/h1; heading-order issues; autocomplete not exposed (#2, #3, #8, #14). |
| 1.3.2 | Meaningful sequence | A | Pass | DOM order matches visual order. |
| 1.3.3 | Sensory characteristics | A | Pass | |
| 1.3.4 | Orientation | AA | Pass | |
| 1.3.5 | Identify input purpose | AA | Pass | `autocomplete` set on username, password, email and one-time code. |
| 1.4.1 | Use of colour | A | Fail | Links not underlined; presence status and unread channel shown by colour/weight only (#5, #11). |
| 1.4.2 | Audio control | A | Pass | Soundboard and voice have volume and mute controls. |
| 1.4.3 | Contrast (minimum) | AA | Fail | 287 nodes (#4). |
| 1.4.4 | Resize text | AA | Pass | Browser zoom to 200% and in-app zoom both work. |
| 1.4.5 | Images of text | AA | Pass | |
| 1.4.10 | Reflow | AA | Fail | No horizontal scroll, but Search and Inbox are lost at 320 CSS px (#9). |
| 1.4.11 | Non-text contrast | AA | Partial | Text inputs on `bg-d-base` inside `bg-d-canvas` cards have a boundary of about 1.2:1; toggle "off" track `bg-d-text4` on surface is 3.7:1 (passes). |
| 1.4.12 | Text spacing | AA | Pass | 0 clipped elements. |
| 1.4.13 | Content on hover or focus | AA | Pass | Hover toolbar persists while hovered; `title` tooltips are native. |
| 2.1.1 | Keyboard | A | **Fail** | Message actions, server dropdown, quick-switcher results, audit-log scroller and drag reordering are not keyboard-operable (#1, #6, #7, #13). |
| 2.1.2 | No keyboard trap | A | Pass | |
| 2.1.4 | Character key shortcuts | A | Pass | All shortcuts use modifiers; single-key actions only apply inside the focused composer. |
| 2.2.1 | Timing adjustable | A | Partial | Toasts auto-dismiss after 6 s with no way to extend; any toast that carries an action should persist (#12). |
| 2.2.2 | Pause, stop, hide | A | Pass | GIF autoplay, animated emoji and sticker animation settings; reduced motion. |
| 2.3.1 | Three flashes | A | Pass | |
| 2.4.1 | Bypass blocks | A | Fail | No skip link, no `main` (#3). |
| 2.4.2 | Page titled | A | Partial | Title never reflects the current channel or DM (#3). |
| 2.4.3 | Focus order | A | Fail | Server settings does not take focus; quick switcher does not return it (#10). |
| 2.4.4 | Link purpose (in context) | A | Pass | |
| 2.4.5 | Multiple ways | AA | Pass | Quick switcher, search, sidebar. |
| 2.4.6 | Headings and labels | AA | Partial | Quick-switcher and emoji search use placeholder only (#7). |
| 2.4.7 | Focus visible | AA | Partial | Composer and search input have `focus:outline-none` (#15). |
| 2.4.11 | Focus not obscured (minimum) | AA | Pass | |
| 2.5.1 | Pointer gestures | A | Pass | Long-press has a "More" button alternative. |
| 2.5.2 | Pointer cancellation | A | Pass | One exception: quick-switcher results fire on `mousedown`, not click (#7). |
| 2.5.3 | Label in name | A | Pass | |
| 2.5.4 | Motion actuation | A | N/A | |
| 2.5.7 | Dragging movements | AA | Fail | Server rail order and role order are drag-only (#13). |
| 2.5.8 | Target size (minimum) | AA | Fail | Search submit 14px; create-channel "+" 16px next to another target (#12). |
| 3.1.1 | Language of page | A | Pass | `<html lang>` follows the UI locale. |
| 3.1.2 | Language of parts | AA | N/A | User-generated content (advisory: see #15 note on Thai). |
| 3.2.1 | On focus | A | Pass | |
| 3.2.2 | On input | A | Pass | |
| 3.2.3 | Consistent navigation | AA | Pass | |
| 3.2.4 | Consistent identification | AA | Pass | |
| 3.2.6 | Consistent help | A | N/A | No help mechanism. |
| 3.3.1 | Error identification | A | Pass | Login and forms use `role="alert"`. |
| 3.3.2 | Labels or instructions | A | Partial | Placeholder-only inputs (#7). |
| 3.3.3 | Error suggestion | AA | Pass | |
| 3.3.4 | Error prevention (legal, financial, data) | AA | Pass | Destructive actions are confirmed. |
| 3.3.7 | Redundant entry | A | Pass | |
| 3.3.8 | Accessible authentication (minimum) | AA | Pass | Password managers and paste work; MFA code accepts paste. |
| 4.1.2 | Name, role, value | A | Fail | Unnamed button, switch with no `aria-checked`, menus and listboxes not exposed, unread/mention state missing from names (#6, #8, #11, #14). |
| 4.1.3 | Status messages | AA | **Fail** | No live region for new messages, typing or search result counts; toasts are unreliable (#2). |

**Totals:** Pass 29, Fail 12, Partial 6, N/A 8 (55 criteria) (A/AA criteria in WCAG 2.2; 4.1.1 is obsolete and not counted).

---

## 5. Ranked issues and exact fixes

Severity reflects user impact: **Critical** blocks a core task, **Serious** causes major difficulty, **Moderate** or **Minor** otherwise.

### 1. Critical: messages cannot be reached or acted on with the keyboard (2.1.1, 2.4.3)
- **Where:** `src/components/ChatArea.jsx`, message row `<div id="message-…">` (around lines 958–1000) and the toolbar `div.message-actions` (around line 1236). `src/index.css:430` shows the toolbar only on `:focus-within`.
- **Evidence:** probe `messagesFocusable: 0`. The Tab walk reached the Reply/React/More toolbar only on the one message that contains a link. Shift+F10 does not open the menu. Discord's "Navigate between messages with arrow keys" is missing.
- **Fix:**
  1. Put the list in `role="list"` (or keep the `log` wrapper from issue #2 and give each group `role="article"`). Give each row `tabIndex={focusedId === msg.id ? 0 : -1}` (roving tabindex), `aria-labelledby` pointing at the author, timestamp and content ids, and `aria-setsize`/`aria-posinset`.
  2. On the list's `onKeyDown`: ↑/↓ move focus between rows; Home/End go to the first and last row; PageUp/PageDown move by page and load history at the top; Esc returns to the composer. Shift+F10 or the ContextMenu key opens `MessageContextMenu` at the row's bounding box. Also add Discord's message-focused shortcuts: `E` edit, `R` reply, `P` pin, `+` react, `T` thread, `Backspace`/`Delete` delete (with confirm), `Ctrl+C` copy text.
  3. From the composer, Shift+Tab (or ↑ when the caret is at 0 in a non-empty draft, as in Discord) focuses the last message.
  4. Keep the `.message-row:focus-within .message-actions` rule; it now works for every row because the row itself is focusable.
  5. Make the author name a `<button>` (it is currently a `span` with `onClick`, so profiles cannot be opened from the keyboard).

### 2. Critical: nothing is announced to screen readers (4.1.3)
- **Where:** `ChatArea.jsx` scroll container (around line 859), typing indicator (around line 1604), `ToastStack.jsx`, and the search results count in `SearchResultsPanel.jsx`.
- **Evidence:** `liveRegions: []`, `liveAnnouncements: []` after a second user typed and sent a message.
- **Fix:**
  - Wrap the rendered messages in `<div role="log" aria-live="polite" aria-relevant="additions" aria-label={t('chat.messagesIn', {channel})}>`. Only append new rows to it; history prepends should go outside the log or be marked `aria-busy` during the load, which already exists.
  - Add a visually hidden announcer that is always mounted, for example `<div className="sr-only" aria-live="polite" aria-atomic="true">{typingText}</div>`, and render the typing text there (throttled). Discord announces "X is typing".
  - `ToastStack`: render the container permanently as `<div role="status" aria-live="polite">` (use `role="alert"` for `type==='error'`) and drop `role="status"` from each child.
  - Search: announce "N results for 'q'" through the same announcer.
  - Optional (Discord has it): announce incoming DMs and mentions in channels you are not viewing through the announcer when TTS is off.

### 3. Serious: no page structure (1.3.1, 2.4.1, 2.4.2)
- **Where:** `src/App.jsx` (shell layout), `ChatArea.jsx` header, `ChannelSidebar.jsx`.
- **Evidence:** axe `landmark-one-main` and `page-has-heading-one` fail on 28 views; 682 `region` nodes; no skip link; `document.title` is static.
- **Fix:**
  - Wrap the conversation column in `<main aria-labelledby="channel-title">`.
  - Render the channel or DM name in the header as `<h1 id="channel-title">`, and demote "Welcome to #…" to an `<h2>` (already the case).
  - Wrap `ChannelSidebar` in `<nav aria-label={serverName + ' channels'}>`, and give the composer form `role="region" aria-label="Message composer"`.
  - Add `<a href="#chat-composer" className="sr-only focus:not-sr-only …">Skip to message box</a>` as the first child of the app, plus a second link to `#channel-title`.
  - Set `document.title = `${unreadPrefix}${isDM ? '@' + title : '#' + title} | ${serverName} | Antigravity``, and fold it into `utils/notifier.js`, which already rewrites the title.

### 4. Serious: text contrast (1.4.3), 287 nodes
- **Where and fix:**
  - **`--color-d-text4` in `src/index.css`.** It is #80848e: 3.68:1 on #2b2d31, 3.37 on #313338 and #f2f3f5, 3.74 on white. Change the dark value to `#a3a8b0` (5.77 on surface, 5.29 on canvas) and the light value to `#4e5058` (7.24 on #f2f3f5). This affects timestamps, hints, "Nothing to review", quick-switcher hints, slider marks and counters.
  - **`--color-d-text3` on selected rows.** It gets 3.57 on `bg-d-active` in dark and 4.48 on #d4d7dc in light (`CreateChannelModal`, `QuickSwitcher` hints). Use `text-d-text2` on active or selected backgrounds.
  - **Danger text.** #f23f43 as text gets 3.35 on dark and 3.77 on white ("Danger zone", "Delete server", Roles delete, voice error banner). Add a token `--color-d-dangertext` (dark `#ff7a7d`, light `#c9282d`) for text and keep `d-danger` for fills.
  - **Online/brand/mint as text.**
    - `text-d-online` on `bg-d-online/20` gets 2.52 (the "Connected" badge in `ChannelSidebar.jsx` around line 310 and in `VoiceRoom.jsx`).
    - `text-d-brand` gets 2.99 on dark (`EventsPanel`).
    - `text-d-mint` "Invite people" gets 1.54 on light (`ServerDropdown`).
    - Fix: add `--color-d-onlinetext` (dark `#2dc770`, light `#1a7f45`) and `--color-d-brandtext` (dark `#949cf7`, light `#4752c4`), and map mint to the brand/online text tokens in the light theme.
  - **Offline members at `opacity-60`** (`MemberList.jsx`) drop role colours to 1.83:1. Dim the avatar only, not the name, or cap the opacity at 0.85 and apply the role-colour contrast clamp from issue #5b.

### 5. Serious: links rely on colour, and role colours are unreadable (1.4.1, 1.4.3)
- **5a. Links.** `src/utils/markdownParser.jsx:215,224` use `className="text-d-link hover:underline"`. Change to `underline decoration-1 underline-offset-2` by default, or add Discord's **"Always underline links"** setting (Accessibility tab) that toggles `:root[data-underline-links="true"] a { text-decoration: underline }`, with the default ON for WCAG conformance.
- **5b. Role colours.** Name colours come straight from the database (`MemberList.jsx` around line 118, and the message author `.role-colored` in `ChatArea.jsx`). Add a helper `readableRoleColor(hex, bg)` in `src/utils/` that adjusts HSL lightness until the colour reaches at least 4.5:1 against `--color-d-canvas`/`--color-d-surface` for the active theme, and use it in every place that sets `style.color` from `role_color`. Keep the raw colour for the swatch or dot. Evidence: 13/20 Discord presets fail on dark and 12/20 on light; #f1c40f on white is 1.66:1. Also fix the `AppearanceTab`/`AccessibilityTab` preview samples (`#f0b232` "Kira" is 1.88 on white).

### 6. Serious: server dropdown menu is not keyboard-operable (2.1.1, 4.1.2)
- **Where:** `src/components/ServerDropdown.jsx` (`role="menu"` has no key handling) and the trigger at `ChannelSidebar.jsx:200`.
- **Evidence:** after Enter, focus stays on the trigger, ↓ does nothing, and Esc leaves the menu open (`a11y-focus-rail.png`).
- **Fix:** reuse the roving-focus logic from `ContextMenu.jsx:35-60`. On mount, focus the first `[role=menuitem]`; handle ↑/↓/Home/End and Esc (close, then `triggerRef.current.focus()`); close on Tab. Also give the separator rows `role="separator"`.

### 7. Serious: quick switcher and emoji picker (2.1.1, 4.1.2, 3.3.2)
- **Where:** `src/components/QuickSwitcher.jsx:87-120`, `src/components/EmojiPicker.jsx:136-230`.
- **Evidence:** result buttons only have `onMouseDown`, so Tab plus Enter on a result does nothing. The input has no label, and the active option is announced by nothing. Focus is not returned on close.
- **QuickSwitcher fix:** use the combobox pattern.
  - Input: `role="combobox" aria-expanded="true" aria-controls="qs-list" aria-activedescendant={`qs-${index}`} aria-label={t('switcher.ariaLabel')}`.
  - List: `<div id="qs-list" role="listbox">`.
  - Rows: `role="option" id={`qs-${i}`} aria-selected={i===index} tabIndex={-1}`, with `onClick` instead of `onMouseDown`.
  - Restore focus to `document.activeElement` captured on open, or switch to `useFocusTrap`, which already restores focus.
- **EmojiPicker fix:**
  - Container: `role="dialog" aria-label="Emoji picker"`.
  - Search: `aria-label={t('emoji.search')}`.
  - Category strip: `role="tablist"`, with `role="tab" aria-selected` on each button.
  - Grid: `role="grid"` with rows of 9 and ←↑→↓ roving focus. Name each emoji button with its shortcode, `aria-label=":grinning:"`, as Discord does, rather than the raw glyph.
  - Esc closes the picker and returns focus to the Emoji button.

### 8. Serious: composer autocomplete (@mention, :emoji:, /command) is invisible to screen readers (4.1.2, 1.3.1)
- **Where:** `src/components/ComposerAutocomplete.jsx` (no roles) and the composer `<textarea>` in `ChatArea.jsx`.
- **Fix:** when the popup is open, set on the textarea `role="combobox" aria-autocomplete="list" aria-expanded aria-controls="composer-ac" aria-activedescendant`. Give the popup `role="listbox" id="composer-ac" aria-label={t('autocomplete.members')}` and give items `role="option" aria-selected`.

### 9. Serious: Search and Inbox disappear at narrow widths or high zoom (1.4.10)
- **Where:** in the `ChatArea.jsx` header, the search form (around line 837) is `hidden md:block` (gone below 768px) and the Inbox button (around line 822) is `max-sm:hidden` (gone below 640px). `SearchResultsPanel.jsx:39` is `hidden xl:flex`.
- **Evidence:** `a11y-mobile-no-search-inbox.png`. At 390px, and at 1280px with 400% zoom, only Pins and Members remain.
- **Fix:** below `md`, collapse Search, Inbox and Notification settings into an overflow "More" button (`aria-haspopup="menu"`). Render `SearchResultsPanel` as a full-screen sheet below `xl` instead of hiding it.

### 10. Serious: dialog focus management (2.4.3)
- **Where:** `src/components/ServerSettingsModal.jsx` (no `useFocusTrap`, so focus stays on BODY and is lost on close); `QuickSwitcher.jsx` (focus is not restored); every modal leaves the background exposed to screen readers.
- **Fix:**
  - Apply `useFocusTrap(true, onClose)` to the Server settings root, the same way as `UserSettingsModal`.
  - In `src/hooks/useFocusTrap.js`, while active, set `inert` on `#root > *:not(:has(container))`, or render modals in a portal and set `document.getElementById('root').inert = true`, then restore it on cleanup.

### 11. Serious: state conveyed by colour or visuals only (1.1.1, 1.4.1, 4.1.2)
- **Where and fix:**
  - **Presence dot** (`MemberList.jsx:95`, user panel, DM list). Add `<span className="sr-only">{t('status.'+member.status)}</span>` and put the status into the button's name. Also adopt Discord's shape-coded status masks (idle moon, DND bar, offline ring), which serve colour-blind users.
  - **Server rail** (`ServerRail.jsx:314-333`). `aria-label={title}` hides the badge. Use `aria-label={`${badge ? `${badge} mentions, ` : unread ? 'unread, ' : ''}${title}`}`.
  - **Channel rows** (`ChannelSidebar.jsx:281`). Unread is shown only by bold text and a white pip. Add `aria-label` or sr-only text such as "unread", "N mentions", "muted", "private", plus the channel type ("text channel", "voice channel", "forum"). Discord reads "unread, general (text channel)".
  - **Voice room speaking ring** (`VoiceRoom.jsx:351-377`). Add `aria-label`/sr-only "speaking" and expose muted/deafened as text.

### 12. Serious: target size and timing (2.5.8, 2.2.1)
- **Where:**
  - `ChatArea.jsx:847`: search submit `absolute right-2 top-1.5` renders a 14×14 icon.
  - `ChannelSidebar.jsx` around line 254: "Create text/voice channel" 16×16 sits flush against the category toggle.
  - `ToastStack.jsx`: 6 s auto-dismiss.
- **Fix:**
  - Give both buttons `className="… p-1 -m-1 min-w-6 min-h-6"` (24×24 hit area, same visual).
  - Toasts: pause the timer on hover or focus, keep error toasts until dismissed, and multiply the TTL by the new Accessibility setting "Notification duration" (Discord has no such setting; this is WCAG-driven).

### 13. Moderate: drag-only reordering; audit log scroller (2.5.7, 2.1.1)
- **Where:**
  - `ServerRail.jsx:110` (draggable servers and folders).
  - `ServerSettingsModal.jsx:799` (draggable roles).
  - `ServerSettingsModal.jsx:206` (overflow container with no focusable content in the Audit log).
- **Fix:**
  - Add "Move up" and "Move down" items to the server context menu, and ↑/↓ buttons or Alt+↑/↓ on the focused role row that call the same reorder API.
  - Give the audit-log scroller `tabIndex={0} role="region" aria-label={t('settings.auditLog')}`.

### 14. Moderate: invalid or unnamed ARIA (4.1.2, 1.3.1)
- **`PinnedMessagesPopover.jsx:21`.** The close button has no name. Add `aria-label={t('common.close')}`. Also give the popover `role="dialog" aria-label={t('chat.pinnedMessages')}` and focus it on open.
- **`ServerSettingsModal.jsx:957`.** `const on = checked || forced` can be `undefined`, so `aria-checked` disappears. Use `aria-checked={Boolean(on)}`, and add `aria-describedby` for the description `<p>`.
- **`CreateChannelModal.jsx:45`.** `<form role="dialog">` is not allowed. Wrap the form in a `<div role="dialog" aria-modal="true" aria-labelledby>`.
- **Heading order.** Roles "Permissions" `h3` follows `h1` (use `h2`); Channel permissions `h4` follows `h1` (use `h2`/`h3`).

### 15. Moderate: focus visibility on inputs; Thai font (2.4.7, advisory)
- **Where:** the composer textarea and the header search input in `ChatArea.jsx`. Both use `focus:outline-none` (110 occurrences of `outline-none` across the app, and only 12 `focus-visible:` replacements).
- **Evidence:** `a11y-focus-composer.png`.
- **Fix:** on the composer wrapper, add `focus-within:ring-2 focus-within:ring-d-brand/60`, and apply the same to search. Remove `transition-all` from `RailButton` (use `transition-[border-radius,background-color]`) so the focus outline appears instantly.
- **Thai:** `index.html` loads Inter and Kanit from `fonts.googleapis.com`, so offline self-hosted installs silently fall back. Bundle the fonts (Noto Sans Thai or Kanit woff2) under `public/fonts` with `font-display: swap`. Advisory: when a message's text is detected to be at least 50% Thai (`/[฀-๿]/`), set `lang="th"` on the message content so screen readers switch voice.

### Lower priority
- The `ToastStack` container is `pointer-events-none` and fixed at bottom-right; at 400% zoom it can cover the send button. Move it to the top on narrow widths (2.4.11).
- `MemberList.jsx:150`: `aria-label` on a plain `<span>` (👑) is ignored by assistive technology. Use `role="img" aria-label`.
- The login screen error (`role="alert"`) should also set `aria-invalid` and `aria-describedby` on the offending field.
- The `high contrast` theme only changes text and divider colours. Discord's contrast mode also thickens focus rings and control borders; extend `:root[data-contrast="high"]` to `--color-d-control` and input borders (1.4.11).

---

## 6. Comparison with Discord's accessibility features

Reference: Discord desktop/web, User Settings › Accessibility, Appearance, Keybinds, and Discord's documented keyboard navigation.

| Discord feature | Here | Gap / action |
|---|---|---|
| **Saturation** slider | Yes (`AccessibilityTab`, `data-saturation`, applied on `:root`) | Add Discord's **"Apply saturation to custom colours"** toggle, so role colours can be exempted or included. |
| **Role colours**: in names / next to names / off | Yes (3 modes) | Add automatic contrast correction (#5b); Discord adjusts role colours against the theme. |
| **Link decorations**: always underline links | **Missing** | Add it; this also fixes 1.4.1 (#5a). |
| **Contrast mode / high contrast** | Yes (text and divider tokens) | Extend to control borders and focus width (see Lower priority). |
| **Reduced motion**: enable, and sync with computer | Enable toggle exists; the OS preference is honoured by CSS | Add an explicit **"Sync with computer"** toggle so the UI reflects the OS state, and wire `SuperReaction`/`VoiceRoom` animations to one source. |
| **Automatically play GIFs**, **Play animated emoji**, **Sticker animation** | Yes | None. |
| **Text-to-speech**: allow `/tts`, **TTS rate** | Yes (toggle, rate 0.5–3×, preview); notification TTS modes live in Notifications | Add a voice picker (Discord uses the OS voice) and expose `speech.js` for #2's optional announcements. |
| **Chat font scaling, zoom level, message spacing, compact mode** | Yes (Appearance) | None. |
| **Show send message button** | Yes | None. |
| **Screen reader support**: message list announced, messages as articles, typing announced | **Missing** (#1, #2) | Top priority. |
| **Navigate between messages with arrow keys**, plus message shortcuts (E edit, R reply, P pin, + react, Backspace delete) | **Missing** (only ↑-to-edit in an empty composer) | #1. |
| **Keyboard mode focus rings** (shown only after Tab) | Yes (`:focus-visible`) | Fix inputs (#15). |
| Alt+↑/↓ channel, Ctrl+Alt+↑/↓ server, Ctrl+K switcher, Ctrl+Shift+M/D mute/deafen, Ctrl+E emoji, Ctrl+P pins, Ctrl+U members, Ctrl+F search, Ctrl+, settings | Yes (`useUserSettings` keybinds, rebindable) | None. |
| **Alt+Shift+↑/↓** (previous/next unread channel), **Ctrl+Shift+Alt+↑/↓** (unread mentions) | **Missing** | Add `navigateUnreadUp/Down` in `useUserSettings.js` keybind defaults and `App.jsx` step helpers (filter `readStates[id].unread`). |
| **Esc** marks channel read; **Shift+Esc** marks server read; **Shift+PageUp** jumps to oldest unread | **Missing** (Esc only closes panels, `App.jsx:923`) | Add these. |
| **Ctrl+/** keyboard shortcut overlay | **Missing** (only the Keybinds settings tab) | Add a modal listing the bindings from `useKeybinds`. |
| **Server rail as a tree with arrow keys** | **Missing** (all icons are Tab stops) | `role="tree"`/`treeitem` with roving tabindex, ↑/↓ to move, Enter to open. |
| **Dyslexia-friendly / custom font** | Not present (Discord offers limited font options) | Optional: a font setting (system / Inter / OpenDyslexic) through `--font-body`. |

### Recommended additions to `AccessibilityTab.jsx`
1. `underlineLinks` (default **true**) sets `data-underline-links`.
2. `syncReducedMotion` (default true) shows the OS state as read-only while on.
3. `saturateCustomColors` (default true) excludes role and embed colours from the filter when off.
4. `roleColorContrast` (default true) turns on the #5b clamp.
5. `toastDuration` (short / default / long / until dismissed).
6. `announceMessages`: off / mentions only / all messages in the current channel. This drives the live region verbosity from #2, similar to screen-reader verbosity in Discord.
