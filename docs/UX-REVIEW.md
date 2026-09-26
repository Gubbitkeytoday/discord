# UX Review: Antigravity Discord (self-hosted Discord clone)

**Reviewer role:** principal UX designer, read-only critique
**Date:** 2026-09-26 · **Build:** `claude/dreamy-goldberg-p3o5ao` @ 229e358, production bundle (`npm run build`, `SERVE_STATIC=1`)
**Method:** I walked through the app with real accounts in Playwright/Chromium (`owner` and `friend`, both registered through the UI). I checked it at a 1440×900 desktop and a 390×844 touch phone, in dark and light themes, and in English (`en-US`) and Thai (`th-TH`). I ran scripted checks for WCAG contrast, font sizes under 12px, target sizes, horizontal overflow and text truncation, and I recorded the tab order. Then I read the source behind each finding to confirm it.
**Screenshots:** `/tmp/claude-0/-home-user-discord/663d99e8-07c9-5b0f-8b1a-38c6a8c33dc1/scratchpad/shots/ux-*.png`. They are not committed. Below they are referred to by file name only, for example `ux-12`.

---

## Executive summary

For a self-hosted build this is a very complete Discord clone. It has forums, stages, polls, events, AutoMod, onboarding, webhooks, soundboard, a quick switcher, high-contrast mode, a saturation slider and a full Thai translation. The visual language copies Discord closely enough that a Discord user feels at home right away. Measured colour contrast of text is good: the automated pass found no text below 4.5:1 in dark theme.

The product falls short in the moments that decide whether someone stays:

1. **First run is a dead end.** A new account lands on an empty Friends list that says "Nobody in this list" (`ux-05`). Nothing points to creating or joining a server. Creating a server works (3 clicks, about 1.4 s), but the new server is also empty. There is no "Welcome to your server" checklist and no invite prompt (`ux-12`). Discord shows both.
2. **Inviting is invisible.** "Invite people" copies a link without showing it, and the only confirmation is a toast with the code (`ux-14`). The user cannot see the full link, cannot pick an expiry (it silently expires after 24 h), and cannot invite existing friends. The invite landing page then shows a **broken image** as the server icon, because the default icon is hot-linked from `api.dicebear.com` (`ux-20`).
3. **Mentions only work if you pick from autocomplete.** Typing `@owner` and pressing Enter sends plain text. There is no highlight, no notification, and the Inbox says "No mentions yet" (`ux-23`, `ux-29`). If you do pick from autocomplete, the composer fills with a raw token like `<@1553398280883355648>` (`ux-93`).
4. **System events look like user messages.** Creating a thread posts a message that reads just "Kickoff", signed by the owner (`ux-60`, `ux-64`). Joins produce no "X just showed up!" line. The server writes `thread_created` rows, but no renderer exists for them.
5. **Phone users lose key features.** Search, Inbox and notification settings are CSS-hidden below the `md`/`sm` breakpoints. The channel drawer covers 88% of the screen on every load (`ux-80`, `ux-89`). Server Settings uses a two-column form at 390 px, so fields are clipped (`ux-88`). Message actions need an undiscoverable 450 ms long-press.
6. **Admin details are rough.** The Roles "Create" button reads **"Role created"** before anything has been created (`ux-51-ss-roles`). AutoMod starts with no presets (`ux-51-ss-automod`). Onboarding uses checkboxes where the rest of the app uses switches.

**Scores:** 5.6 / 10 overall. The code is well built, and the problems sit mostly on the way from first run to first conversation.

### สรุปภาษาไทย

แอปนี้เป็นโคลน Discord แบบโฮสต์เองที่มีฟีเจอร์ครบมาก ได้แก่ ฟอรัม สเตจ โพล อีเวนต์ AutoMod ระบบต้อนรับสมาชิกใหม่ โหมดคอนทราสต์สูง และแปลภาษาไทยครบ หน้าตาใกล้เคียง Discord จนผู้ใช้เดิมใช้งานได้ทันที และค่าคอนทราสต์ของตัวอักษรผ่านมาตรฐาน WCAG AA

จุดที่ต้องแก้ด่วนคือช่วงเวลาสำคัญของผู้ใช้ใหม่:

1. **หลังสมัครสมาชิกไม่มีการแนะนำใด ๆ** หน้าแรกเขียนเพียง "ไม่มีใครในรายการนี้" และไม่มีปุ่มชวนให้สร้างหรือเข้าร่วมเซิร์ฟเวอร์
2. **การเชิญเพื่อนมองไม่เห็นลิงก์** ระบบคัดลอกลิงก์ให้เงียบ ๆ และลิงก์หมดอายุใน 24 ชั่วโมงโดยไม่แจ้ง ส่วนหน้ารับคำเชิญแสดงไอคอนเซิร์ฟเวอร์เป็นรูปเสีย
3. **การพิมพ์ @ชื่อ เองไม่นับเป็นการกล่าวถึง** ต้องเลือกจากรายการแนะนำเท่านั้น และเมื่อเลือกแล้ว ช่องพิมพ์จะแสดงรหัสดิบ `<@123…>`
4. **ข้อความระบบ เช่น การสร้างเธรด แสดงเหมือนข้อความของผู้ใช้**
5. **บนมือถือไม่มีปุ่มค้นหา กล่องแจ้งเตือน หรือการตั้งค่าแจ้งเตือน** และเมนูช่องปิดหน้าจอเกือบทั้งหมดทุกครั้งที่โหลด
6. **ภาษาไทย** ชื่อหมวดหมู่เริ่มต้น "TEXT CHANNELS" และ "General Voice" ไม่ถูกแปล เพราะถูกบันทึกเป็นข้อมูลภาษาอังกฤษ หัวข้อไทยขนาด 11–12px ที่ใส่ `tracking-wide` อ่านยาก ตัวเลือกภาษาซ่อนอยู่ในหน้า "รูปลักษณ์" และไม่มีบนหน้าเข้าสู่ระบบ

**คะแนนรวม 5.6/10** โครงสร้างโค้ดดี ปัญหาส่วนใหญ่แก้ได้เร็ว (ดูหัวข้อ Quick wins)

---

## Scorecard

| Area | Score | One-line verdict |
|---|---:|---|
| First-run & onboarding | **3** | Empty state gives no next step and there is no new-server checklist |
| Server creation | **7** | Fast (3 clicks). Templates exist. The server is empty afterwards |
| Inviting | **4** | Link is never shown, expiry is silent, and the invite page has a broken icon |
| Core messaging (send/edit/react/reply) | **7** | Close to Discord: hover bar, context menu, markdown, "New messages" divider |
| Mentions & notifications | **3** | Typed mentions don't resolve, raw `<@id>` tokens appear, no mention highlight |
| Feature discovery (threads/polls/forum/events/voice) | **6** | All present and reachable. Thread system message is broken. Headers differ by channel type |
| Search | **5** | Works with filters. "1 results", no term highlight, missing on mobile |
| User settings | **7** | Rich, searchable, live preview. Language picker buried under Appearance |
| Server admin & moderation | **6** | Complete (ban with reason, timeout, roles). Mislabelled button, no AutoMod presets |
| Accessibility (WCAG 2.2 AA) | **6** | Contrast and focus rings are good. No skip link. Every message's action buttons are separate tab stops. 16–20 px targets |
| Thai / i18n | **6** | Fully translated UI. Seeded data stays English, Thai tracking/size issues, en-GB dates for en-US |
| Mobile (390 px) | **4** | No horizontal overflow, but search and inbox are missing, the drawer blocks the chat, and settings forms clip |
| Visual consistency | **7** | Tokens are consistent. Default avatars are all identical. 12h/24h time is inconsistent. Switch vs checkbox |
| **Overall** | **5.6** | |

### Task efficiency vs Discord (measured)

| Task | This app | Discord | Note |
|---|---|---|---|
| Register → app shell | 1 form, 4 fields, 1 click | similar (plus DOB) | Native browser validation bubble, English only (`ux-04`) |
| Create server | 3 clicks, ~1.4 s | 4 clicks (template step) | Good |
| Invite a friend | 2 clicks, **link not visible** | 1 click, modal shows link, expiry and friends list | Discord also offers invite right after creation |
| First message | 1 click + type | same | Good |
| Ban a member | 3 clicks (right-click → Ban → confirm with reason) | 3 clicks + delete-history option | No "delete message history" choice |
| Change language | 3 clicks + scroll (Settings → Appearance → scroll) | 2 clicks (Settings → Language) | Not available pre-login |
| Reach composer by keyboard | 22 tabs **+ ~8 per visible message** | skip-to-content, then roving focus | See issue #9 |

---

## Ranked issue list

Severity: **S1** blocks or seriously misleads a core task · **S2** major friction · **S3** minor/polish.
Heuristics refer to Nielsen's 10 (H1 visibility of status … H10 help & docs). WCAG refers to 2.2 AA.

| # | Sev | Issue | Evidence | Heuristic / WCAG | Concrete fix (file) |
|---|---|---|---|---|---|
| 1 | S1 | **Typed `@name` is not a mention.** Only autocomplete inserts `<@id>`. The server's `parseMentions` only recognises tokens, so plain `@owner` sends no notification and gets no highlight | `ux-23`, `ux-29` | H5 error prevention, H2 match real world | Before sending in `ChatArea.jsx`, resolve `@username` / `@displayname` against the loaded member list into `<@id>`, the same way Discord's client does. Reuse the matcher in `ComposerAutocomplete.jsx` |
| 2 | S1 | **Raw `<@1553…>` token in the composer** after choosing a mention | `ux-93` | H2, H4 consistency | In `ComposerAutocomplete.jsx` insert `@username`, keep a `{display → token}` map in composer state, and swap in the tokens on submit. Alternatively render tokens as pills in a contenteditable composer |
| 3 | S1 | **Mentions of you are not highlighted** in the message list: no yellow row background or left bar | `ux-23` | H1 | Add a `mentionsMe` row style to the message row in `ChatArea.jsx` (`bg-d-mention-row` + 2 px left border). The token already exists in `src/utils/markdownParser.jsx` |
| 4 | S1 | **Empty first-run state has no call to action.** "Nobody in this list" on Friends, with nothing about servers | `ux-05` | H10, H6 recognition | In `HomeDirectMessages.jsx`, when the user has 0 servers and 0 friends, show a hero with **Create a server**, **Join with invite link** and **Add a friend**, plus a line of explanation |
| 5 | S1 | **Thread creation renders as a user message** ("owner: Kickoff"). `type='thread_created'` (and `join`/`pin`) has no renderer | `ux-60`, `ux-64` | H1, H4 | In the `ChatArea.jsx` message map, branch on `msg.type` and render a compact system line: "owner started a thread: **Kickoff** · See all threads", with a jump link. Do the same for `pin` and `join` |
| 6 | S1 | **Search, Inbox and notification settings are unreachable on mobile** (`hidden md:block`, `max-sm:hidden`) | `ux-91` | H7 flexibility, WCAG 1.3.4-adjacent | In `ChatArea.jsx`, keep the Inbox and a search icon on small screens. The icon opens a full-screen search sheet (`SearchResultsPanel.jsx`). Put notification settings into the channel long-press / header overflow "⋯" menu |
| 7 | S2 | **Invite link is copied silently.** No visible URL, no expiry control (defaults to 24 h without saying so), no "invite friends" list, and no invite prompt after creating a server | `ux-14` | H1, H3 user control | Add an `InviteModal.jsx`: read-only URL field + Copy, "Expires after [1 h / 1 d / 7 d / never]", max uses, and a friends list with Invite buttons. Open it from `ServerDropdown.jsx` and automatically after `CreateServerModal.jsx` succeeds |
| 8 | S2 | **Broken server icon on the invite page.** The default `icon_url` is `https://api.dicebear.com/...`, a third-party request on a self-hosted install, which fails offline or under a strict CSP | `ux-20` | H8, privacy | In `services/guilds.js`, store `icon_url = null` and let the initials fallback in `InviteJoinScreen.jsx` (which already exists) render. Also add `onError` to fall back to initials |
| 9 | S2 | **Keyboard: no skip link, and every message adds about 8 tab stops** (❤️🔥👍, react, reply, edit, delete, more) before the composer | tab log | WCAG 2.4.1 Bypass Blocks, 2.4.3 | Add "Skip to message composer" and "Skip to channel list" links in `App.jsx`. Make the message list one roving-tabindex `role="list"`: arrow keys move between messages, Tab leaves the list, and the action bar is reachable with Enter or Shift+F10. Provide a shortcut sheet (Ctrl+/ currently does nothing, `ux-66`) listing the bindings from `KeybindsTab.jsx` |
| 10 | S2 | **Roles "create" button says "Role created"** | `ux-51-ss-roles` | H4, H2 | `ServerSettingsModal.jsx:787` uses `t('audit.ROLE_CREATE')`. Add `roles.create: 'Create role'` / `'สร้างยศ'` to `src/i18n/en.js`/`th.js` and use it |
| 11 | S2 | **Mobile channel drawer opens on every load** and covers 342 of 390 px. The only way to dismiss it is a 48 px strip | `ux-80`, `ux-89` | H3, H8 | In `App.jsx`/`ChannelSidebar.jsx`, open straight to the last channel on mobile. Make the drawer full width with a swipe-to-close gesture, and a visible close or back affordance |
| 12 | S2 | **Server Settings on mobile keeps a 2-column grid.** Vanity URL, verification select and the tab strip clip under the X button | `ux-88` | WCAG 1.4.10 Reflow | `ServerSettingsModal.jsx`: change `grid-cols-2` to `grid-cols-1 sm:grid-cols-2`. Turn the mobile tab strip into a list screen with drill-down (the iOS settings pattern) and move the close button out of the strip |
| 13 | S2 | **Empty new server has no guidance** ("Welcome to #general" only) | `ux-12` | H10 | Add a server-owner checklist card at the top of `#general` in `ChatArea.jsx`: Invite friends · Personalize with an icon · Send first message · Set up roles. Dismissible, stored per server |
| 14 | S2 | **Seeded data isn't localised.** "TEXT CHANNELS", "VOICE CHANNELS" and "General Voice" stay in English for Thai creators | `ux-70` | H2 | In `services/guilds.js`, take the creator's locale (Accept-Language or the request body from `CreateServerModal.jsx`) and use the translated default names: "ห้องข้อความ", "ห้องเสียง", "ห้องเสียงทั่วไป" |
| 15 | S2 | **AutoMod starts empty.** No presets for mention spam, suspected spam links or flagged words | `ux-51-ss-automod` | H6, H10 | In `settings/AutoModTab.jsx`, show 3 preset cards with a one-click Enable in the empty state, as Discord does ([AutoMod FAQ](https://support.discord.com/hc/en-us/articles/4421269296535-AutoMod-FAQ)) |
| 16 | S2 | **Identical default avatars.** Every user without an avatar is the same blurple figure, so owner and friend are indistinguishable at a glance | `ux-23` | H6, WCAG 1.4.1 (use of colour as the only cue is fine, but here there is none) | In `src/utils/avatar.js`, hash the user id to one of 6 background colours (Discord uses 5–6), or render initials |
| 17 | S2 | **Language picker buried** under Appearance, and not on the login or sign-up screens | `ux-41-us-appearance`, `ux-01` | H7 | Add a "Language" nav entry in `UserSettingsModal.jsx`, plus a compact EN/ไทย switch in the footer of `LoginScreen.jsx` |
| 18 | S2 | **Message actions on touch** need an undocumented 450 ms long-press that shows the desktop hover bar. There is no bottom sheet | `ux-95` | H6, H7 | In `ChatArea.jsx`, long-press should open a bottom action sheet (reactions row, Reply, Create thread, Copy, Edit, Delete) with 48 px rows, matching Discord mobile |
| 19 | S3 | **Direct red Delete button in the hover bar**, one click from a misfire. Discord hides it under "⋯" (Shift-click for power users) | `ux-16` | H5 | `ChatArea.jsx` action bar: move Delete into the ⋯ menu and keep Shift+click as the fast path |
| 20 | S3 | **Thread opens with no starter message**, only "Welcome to #Kickoff" with a `#` glyph | `ux-37` | H6 | Render the parent message at the top of the thread and use the thread icon in the heading instead of `#` (`ChatArea.jsx`) |
| 21 | S3 | **Pluralisation:** "1 members" (`ux-20`), "1 results" (`ux-32`) | — | H4 | Add `Intl.PluralRules` to `src/i18n/index.jsx` (`one`/`other` keys) |
| 22 | S3 | **Date/time inconsistent:** chat uses 24 h "13:30", while the Appearance preview uses "01:34 PM". en-US users get en-GB dates (26/09/2026) | `ux-41-us-appearance`, `ux-51-ss-members` | H4 | `src/i18n/index.jsx`: map `en` to the browser's actual `en-*` tag and not always `en-GB`. `settings/AppearanceTab.jsx:118` should use `formatDate` |
| 23 | S3 | **Thai labels use `uppercase tracking-wide` at 11–12 px.** Thai has no case, and letter-spacing loosens clusters with stacked tone marks | `ux-73` | WCAG 1.4.12 spirit, readability | In `src/index.css`, add `:lang(th) .tracking-wide{letter-spacing:0}` and bump Thai small labels to at least 13 px with line-height at least 1.6 |
| 24 | S3 | **Header icon targets are 20×20, "+" create-channel 16×16, search icon 14×14.** They pass 2.5.8 only through the spacing exception and are poor on touch (Apple/Material recommend 44/48 px) | measured | WCAG 2.5.8 | Add `p-2` hit areas (36–44 px) in `ChatArea.jsx` header and `ChannelSidebar.jsx` category rows |
| 25 | S3 | **Inconsistent toolbars by channel type:** forum shows no search/inbox/pins, voice shows a different set | `ux-25`, `ux-35` | H4 | Extract a shared `ChannelHeader` used by `ChatArea.jsx`, `ForumView.jsx` and `VoiceRoom.jsx` |
| 26 | S3 | **Checkboxes vs switches:** Onboarding and "Show archived" use checkboxes, everything else uses switches | `ux-51-ss-onboarding` | H4 | Use the `Toggle` from `settings/primitives.jsx` in `settings/OnboardingTab.jsx` |
| 27 | S3 | **Server icon placeholder in settings is a person silhouette**, while the rail shows "DG" | `ux-50` | H4 | `ServerSettingsModal.jsx` overview: render the same initials tile as `ServerRail.jsx` |
| 28 | S3 | **Sign-up validation uses native browser bubbles**, which are unstyled and not translated | `ux-04` | H9 | In `LoginScreen.jsx`, add `noValidate` and show inline field errors with `aria-describedby`. Show a live password-length meter |
| 29 | S3 | **Toasts cover content** (bottom-right over settings toggles and the member list), with no pause on hover | `ux-37`, `ux-41-us-accessibility` | WCAG 2.2.1 Timing Adjustable | In `ToastStack.jsx`, pause the timer on hover/focus and place toasts above the composer, not over modals |
| 30 | S3 | **External asset dependencies:** favicon hot-linked from Discord's own CDN (brand and availability risk), Google Fonts on a self-hosted product | `index.html` | privacy / H8 | Self-host Inter + a Thai face (IBM Plex Sans Thai or Noto Sans Thai) under `public/fonts`. Ship an original favicon and logo, and don't reuse Discord's Clyde mark in `ServerRail.jsx` |

---

## Quick wins (≤ 1 day each)

1. Fix the "Role created" label (#10). One line plus two i18n keys.
2. Set the default `icon_url` to `null` and add an `onError` fallback (#8).
3. Pluralisation with `Intl.PluralRules` (#21) and time-format consistency (#22).
4. Resolve typed `@name` to `<@id>` on submit (#1). Insert `@name` instead of the raw token (#2).
5. Mention highlight row style (#3).
6. System-message renderer for `thread_created` / `pin` / `join` (#5).
7. Un-hide the Inbox and add a search icon on mobile (#6).
8. Hashed default avatar colours (#16).
9. Skip links (#9, first half) and hit-area padding on header icons (#24).
10. Thai `letter-spacing:0` rule and a larger small-label size (#23).
11. A "Language" settings entry and an EN/ไทย switch on the login screen (#17).
12. `grid-cols-1 sm:grid-cols-2` in Server Settings (#12).

## Larger redesigns (1–2 sprints)

1. **Guided first run.** Home hero CTA (#4), a new-server checklist (#13), an invite modal that opens automatically (#7), and an optional short "how Discord works" tour for users new to the model (servers → channels → threads).
2. **Mobile shell.** Discord-mobile navigation: open to the last channel, full-screen swipe panels (servers/channels ← chat → members), a bottom action sheet for messages (#18), a search sheet, and settings as drill-down lists (#11, #12).
3. **Keyboard model.** Roving focus in the message list, a Shift+F10 action menu, and a Ctrl+/ shortcut sheet (#9).
4. **Admin presets.** AutoMod preset cards (#15), a ban dialog with "delete message history (none / 1 h / 24 h / 7 d)", role templates (Moderator, Member), and a "Safety setup" wizard that ties together verification level, AutoMod and a rules channel.
5. **Rich composer.** A contenteditable composer with mention/channel/emoji pills. This fixes #1–#2 at the root and matches Discord.

---

## What's already good (keep it)

- The channel-type picker explains each type in one line (`ux-24`). This is better than Discord's own.
- Destructive actions confirm and ask for a reason (`ux-62`). "Danger zone" is separated visually (`ux-50`).
- Empty states exist for forum, events, pins, AutoMod and search (`ux-25`, `ux-27`, `ux-28`, `ux-33`), and the pins empty state teaches the gesture.
- The voice error banner links straight to the fix ("Voice and video") (`ux-35`).
- Accessibility settings: high contrast, reduced motion, saturation, and role-colour display options (`ux-41-us-accessibility`).
- Focus rings are visible (`ux-64`). The measured dark-theme text contrast had no failures. Alt+↓ channel navigation works.
- No horizontal page scroll at 390 px on any screen I tested.

## References

- Nielsen Norman Group, *10 Usability Heuristics for User Interface Design*.
- W3C, *WCAG 2.2*: 2.4.1 Bypass Blocks, 2.5.8 Target Size (Minimum) with the 24 px spacing exception ([summary](https://wcag22aa.org/new-criteria/target-size/)), 1.4.10 Reflow, 2.2.1 Timing Adjustable.
- Discord, [Starting Your First Discord Server](https://discord.com/blog/starting-your-first-discord-server): welcome checklist and "Invite your friends" CTA on a new server.
- Discord Support, [Invites 101](https://support.discord.com/hc/en-us/articles/208866998-Invites-101) and [Discord Server Setup Guide](https://support.discord.com/hc/en-us/articles/33023827550359-Discord-Server-Setup-Guide).
- Discord Support, [AutoMod FAQ](https://support.discord.com/hc/en-us/articles/4421269296535-AutoMod-FAQ): preset rules for mention spam and flagged words.
- W3C, [Thai Script Resources](https://www.w3.org/International/sealreq/thai/), and Cadson Demak, [Quick Guide on Basic Thai Typography](https://cadsondemak.com/medias/read/quick-guide-on-basic-thai-typography-part-1): stacked tone marks, generous line-height, no artificial tracking.
- Mobbin reference screens were not used because the Mobbin connector requires a paid plan. The Discord comparisons come from the support articles above and product knowledge.
