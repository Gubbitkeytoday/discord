# UX persona panel: older and non-technical users

## สรุปภาษาไทย

เราทดสอบแอปกับผู้ใช้จำลอง 3 คนที่ไม่ถนัดเทคโนโลยี แต่ละคนเริ่มจากศูนย์บนเบราว์เซอร์จริง (Playwright + Chromium) กับเซิร์ฟเวอร์จริงที่ใช้ฐานข้อมูลชั่วคราว

- **คุณสมชาย (68 ปี ครูเกษียณ สายตาไม่ดี ใช้ Android ราคาถูก เน็ต 3G ช้า ใช้แค่ LINE)** สุดท้ายเข้ากลุ่มครอบครัว ดูรูป และเข้าห้องเสียงได้ แต่ช่วงแรกเจออุปสรรคหนัก:
  - เปิดลิงก์คำเชิญแล้วเห็น**จอมืดเปล่า ๆ 22 วินาที** ไม่มีอะไรบอกว่ากำลังโหลด
  - หน้าแรกขึ้นว่า "ยินดีต้อนรับกลับมา!" ทั้งที่เขาไม่เคยมีบัญชี และไม่บอกว่าใครเป็นคนชวน
  - **ชื่อห้อง "รูปครอบครัว" ถูกตัดสระและวรรณยุกต์เหลือ "รปครอบครว"** เพราะตัวกรองชื่อห้องลบอักขระกลุ่ม `\p{M}` ออก ปัญหานี้กระทบภาษาไทย ฮินดี และภาษาอื่นที่ใช้เครื่องหมายกำกับ
  - เมื่อซูม 200% ช่องพิมพ์ข้อความแคบจนแทบมองไม่เห็น และไอคอนบนหัวหน้าจอซ้อนทับกัน
  - ปุ่มควบคุมระหว่างโทรไม่มีป้ายกำกับ และมีปุ่ม "กดเพื่อพูด" ที่ทำให้เขางง
  - ชื่อที่ระบบตั้งให้ยังเป็นภาษาอังกฤษ เช่น "TEXT CHANNELS", "general", "General Voice"
- **คุณลินดา (55 ปี ธุรการโรงเรียนในอังกฤษ)** ตั้งกลุ่มผู้ปกครองได้ แต่:
  - การตั้งห้องประกาศให้อ่านอย่างเดียวซ่อนอยู่ใน Server settings → Channel permissions และปุ่ม ✕ / – / ✓ ไม่มีคำอธิบาย
  - ผู้ปกครองยังพิมพ์ในห้องประกาศได้ แล้วค่อยเจอ error พร้อมปุ่ม "Retry" ที่กดไปก็ไม่มีประโยชน์
  - ไม่มีระบบ "อ่านแล้ว" (read receipt)
  - กดที่คำว่า "Mute channel" แล้วไม่มีอะไรเกิดขึ้น ต้องกดสวิตช์เล็ก ๆ เท่านั้น
  - ปุ่มลบบทบาทเขียนผิดเป็น "Role deleted"
  - ระบบจำกัดการสมัครไว้ 10 บัญชีต่อ IP ต่อชั่วโมง ถ้าผู้ปกครองสมัครพร้อมกันจาก Wi‑Fi โรงเรียน จะมีคนสมัครไม่ได้
- **คุณโรซา (44 ปี เจ้าของร้านเบเกอรี่ในบราซิล ใช้ iPad)**
  - ภาษาโปรตุเกสถูกเลือกให้อัตโนมัติ และ AutoMod บล็อกลิงก์สแปมได้จริง
  - แต่เมนูที่ต้องคลิกขวา (แบน สมาชิก ห้อง) ไม่มีทางเรียกด้วยการกดค้างบน iPad Safari
  - AutoMod มีตัวเลือก "regex" ที่ไม่เหมาะกับคนทั่วไป และไม่มีชุดป้องกันแบบกดครั้งเดียว
  - ข้อความตัวอย่างในช่องพิมพ์ถูกตัดขาด

**สิ่งที่ควรแก้ก่อน:**

1. แก้ regex ชื่อห้องให้เก็บ `\p{M}` (1 บรรทัด ใน 3 ไฟล์)
2. เพิ่มหน้าจอโหลดแบบ inline ใน `index.html`
3. ทำให้หน้าคำเชิญบอกชื่อผู้ชวนและเริ่มที่หน้าสมัคร
4. ปิดช่องพิมพ์เมื่อไม่มีสิทธิ์ส่งข้อความ
5. ทำให้ช่องพิมพ์ใช้งานได้ที่ซูม 200%
6. รองรับการกดค้างบนรายชื่อสมาชิกและห้อง

---

**Method.** I ran a moderated role-play with 3 personas and scripted it in `scripts/ux/older-nontech.mjs`. You can rerun it with `UX_BASE=http://localhost:7020 node scripts/ux/older-nontech.mjs [somchai|linda|rosa|all]`.

- **Server:** real `server.js` with `SERVE_STATIC=1`, `ALLOW_DEV_IDENTITY=0`, a throwaway SQLite DB, and the built SPA from branch `claude/dreamy-goldberg-p3o5ao`.
- **Browser:** Chromium via playwright-core, one browser context per person. Where a task needed a second person (grandson, parent, spammer), that person had their own context.
- **Network and CPU:** Slow 3G and 4× CPU throttling came from CDP.
- **Screenshots:** stored in `scratchpad/shots/persona-older-nontech-*.png`. I looked at all of them.
- **Accessibility checks:** @axe-core/playwright, WCAG 2 AA.

---

## 1. Persona profiles

| | **Somchai** สมชาย | **Linda** | **Rosa** |
|---|---|---|---|
| Age / gender | 68, man | 55, woman | 44, woman |
| Occupation | Retired Thai-language teacher, Khon Kaen | Primary-school office administrator, Leeds (UK) | Owner of "Padaria da Rosa", a small bakery in Belo Horizonte |
| Tech literacy | Very low. Uses LINE (stickers, video calls with grandchildren) and scrolls Facebook. Has never "registered" for anything himself; his grandson set up LINE. | Low confidence. Uses Outlook, Teams (only what IT set up), and WhatsApp for family. Afraid of "breaking something". | Medium. Heavy WhatsApp Business and Instagram user, some Canva. No experience with community tools. |
| Device | Samsung Galaxy A02-class Android, 360×740, Chrome. Slow 3G and 4× CPU throttling. | Windows 11 laptop, 1366×768 at 125% scaling (1093×614 CSS px), Edge/Chrome, mouse and touchpad | iPad 10th gen, 820×1180, Safari, touch only |
| Language | Thai only (`th-TH`) | English (`en-GB`) | Portuguese (`pt-BR`) |
| Accessibility | Low vision: browser zoom 200% and large text. Presbyopia, so small grey text is unreadable. Slow typist on the Thai keyboard. | Mild presbyopia (the reason for 125% scaling). Avoids right-click ("I don't know what that does"). | None, but reads on a busy counter between customers, so she needs big, obvious targets. |
| Goal | His grandson sent a link in LINE: "ปู่ เข้ามาดูรูปวันเกิดยายหน่อย แล้วเย็นนี้โทรคุยกันในห้องเสียงนะ" ("Grandpa, come and see the photos from Grandma's birthday, then let's talk in the voice room this evening"). | Replace the chaotic "Y3 Parents" WhatsApp group: announcements only staff can post, pinned rules, a chatty channel she can mute, and knowing who has read important notices. | A customer community: order and promo announcements, a support channel, no spam, and customers must not get her personal details. |
| Mental model | LINE: one chat list, big green call button, sticker/heart reactions, "อ่านแล้ว" (read) under his messages | WhatsApp: "Only admins can send messages" toggle, blue ticks, "Mute: 8 hours / 1 week / Always" | WhatsApp Business: broadcast lists, labels, "Admins only" groups, quick replies |

---

## 2. Task-by-task results

Severity is the worst issue in the task: S1 blocker, S2 major, S3 minor, S4 polish. Time is wall-clock from the scripted run, including Slow 3G for Somchai. Clicks are taps, clicks and field entries.

### Somchai (Android, Thai, Slow 3G, 200% zoom)

| # | Task | Success | Time | Clicks | Worst severity |
|---|---|---|---|---|---|
| T1 | Tap the invite link in LINE and reach the first usable screen | ✅ (slow) | 22.3 s of a blank dark screen, 24 s total | 0 | **S2**: no loading feedback; the page says "Welcome back!" |
| T2 | Register from the invite | ✅ on the 2nd try | 15 s | 8 | S3: the 4-character password error is a native English tooltip |
| T3 | Accept the invite and land in the family server | ✅ | 6 s | 1 | S3: lands in `#general`, not in the photos channel the invite was for |
| T4 | Find and view the family photos | ✅ | 11 s | 2 | **S1 (Thai)**: channel name mangled to "รปครอบครว" |
| T5 | Say hello and react with a heart | ✅ message / ⚠️ reaction | 9 s | 3 | S3: the long-press menu has jargon ("สร้างเทรด" (create thread), "ทำเป็นยังไม่อ่าน" (mark unread)) and no quick heart |
| T6 | Join the family voice call | ✅ | 10 s | 3 | S2: unlabeled round icon controls; "กดเพื่อพูด" (push to talk) is a trap |
| T7 | Use the app at 200% zoom | ⚠️ readable but can't type | 12 s | 3 | **S1**: composer squashed to ~10 px; header icons overlap |
| T8 | Make text bigger inside the app | ⚠️ found after hunting | 31 s | 3 + long scroll | S2: text size lives under "ธีมและการแสดงผล" (theme and display), not "การเข้าถึง" (accessibility) |

### Linda (Windows 1366×768 at 125%, en-GB)

| # | Task | Success | Time | Clicks | Worst severity |
|---|---|---|---|---|---|
| L1 | Register | ✅ | 5–7 s | 5 | — |
| L2 | Create the server "Oakfield Y3 Parents" and get a link that won't expire | ✅ | 8–14 s | 6 | S3: link defaults to 7 days; no "school/club" template |
| L3 | Create an announcements channel | ✅ | 10 s | 4 | S3: typed "Announcements from school" but got `announcements-from-school`, truncated in the sidebar |
| L4 | Make announcements read-only for parents | ⚠️ only with coaching | 10 s scripted (a real user would give up) | 10 | **S1 for her**: no gear on hover, no Permissions in channel settings; ✕/–/✓ unlabeled |
| L5 | Post the group rules and pin them | ✅ | 7 s | 4 | S3: no confirmation, no pinned marker on the message, only a tiny "1" on the pin icon |
| L6 | Parent joins and tries to post in announcements | ✅ (blocked) | 15 s | 5 | **S2**: composer still enabled; failed message plus a useless "Retry" |
| L7 | See who has read the announcement | ❌ | — | 3 | **S2** (feature gap) |
| L8 | Mute the chatty #general | ✅ on the 2nd try | 7 s | 5 | S2: clicking the words "Mute channel" does nothing |
| L9 | Find the "trip letters" message | ✅ | 2 s | 1 | S4: result shows a `#` icon for an announcement channel |
| L10 | Make a co-admin a moderator | ⚠️ | 6 s | 4 | S2: delete button reads "Role deleted"; new role is "new role" with 0 permissions and no presets |
| L11 | Remove a spammer | ✅ with right-click | 2 s | 1 | S3: only via right-click |
| — | 30 parents join at parents' evening on school Wi‑Fi | ❌ after 10 | — | — | **S2**: registration limit is 10 per IP per hour, so the 11th parent sees "You're doing that too fast" |

### Rosa (iPad 820×1180, pt-BR)

| # | Task | Success | Time | Clicks | Worst severity |
|---|---|---|---|---|---|
| R1 | Register (language auto-detected) | ✅ | 8–11 s | 5 | — |
| R2 | Create "Padaria da Rosa" and a never-expiring invite | ✅ | 11–20 s | 4 | S3: defaults are English ("TEXT CHANNELS", "general", "General Voice") |
| R3 | Create #pedidos-e-encomendas (Anúncios) and #suporte | ✅ | 10–17 s | 7 | S4 |
| R4 | Spam protection (block links) | ✅ | 18 s | 7 | S2: form defaults to "Palavras filtradas" (filtered words) and can't be saved until she finds the type dropdown; "Padrão (regex)" shown to a baker; "AutoMod" untranslated |
| R5 | Spammer posts "GANHE R$500 no PIX" plus a bit.ly link | ✅ blocked | — | — | S3: Rosa gets no alert (alert action is off by default); spammer gets "Tentar de novo" (try again) |
| R6 | Ban the spammer on the iPad | ⚠️ | 7–11 s | 4 | **S2**: member menu only opens via contextmenu, which iOS Safari never fires on long-press |
| R7 | Post an order announcement with a photo | ✅ | 7 s | 4 | S3: member-list overlay ignores Escape; composer placeholder clipped to "encomendas" |
| R8 | Stop customers DMing her personal account | ✅ | 3.4 s | 2 | S3: defaults are "Todo mundo" (everyone) for DMs and full profile; a business owner has to discover this herself |

---

## 3. Ranked issue list

### S1: blockers

**1. Thai and other combining-mark scripts are destroyed in channel names**
- **What happened:** The grandson named the channel "รูปครอบครัว". Everyone sees "รปครอบครว", which is gibberish: the vowels ู and ั are gone. Somchai: *"ห้องนี้ชื่ออะไร อ่านไม่ออก"* ("What is this room called? I can't read it").
- **Screenshots:** `persona-older-nontech-somchai-08-in-server.png`, `-10-photos-channel.png`
- **Affects:** every Thai, Hindi, Bengali, Tamil, Khmer, Lao or Myanmar user. It also affects Vietnamese and Arabic text typed with combining marks (the NFD form).
- **Root cause:** the slug regex `/[^\p{L}\p{N}_-]/gu` strips `\p{M}` (combining marks).
- **Fix:** use `/[^\p{L}\p{M}\p{N}_-]/gu` and normalise with `.normalize('NFC')` first. Change it in:
  - `services/guilds.js` lines 401 and 476
  - `src/components/CreateChannelModal.jsx` line 38 (live preview)

  Also add a unit test for `'รูปครอบครัว'` and `'नमस्ते'`.

**2. At 200% browser zoom the composer is unusable and the header collapses**
- **What happened:** At 200% zoom (180 CSS px wide), the composer row keeps four fixed 44px icon buttons, so the textarea shrinks to about 10 px and only "ส่" of the placeholder is visible. The channel name disappears, and the `#` icon renders under the pin icon.
- **Screenshot:** `somchai-19-zoom-chat.png`
- **Affects:** every low-vision user, and WCAG 1.4.10 Reflow.
- **Fix:**
  - `src/components/ChatArea.jsx` (header): below 320 px, hide pin, members and search behind the existing "⋮ More options" menu, and give the title `min-w-0 flex-1 truncate`.
  - Composer: at widths under 360 px, put the textarea on its own row (`flex-wrap`, textarea `basis-full order-first`). Collapse emoji, voice note and GIF into the ➕ menu, and keep only ➕ and Send beside it.

**3. Making an announcements channel read-only is effectively impossible for a novice (Linda)**
- **What happened:** Hovering a channel shows no gear. The channel settings dialog has name, topic, slowmode and age-restricted, but no Permissions. Linda: *"There's no 'only admins can post' like on WhatsApp. I'd have given up here."*
  - The only path is Server settings → Channel permissions → pick the channel from a dropdown → scroll about 25 rows → find "Send messages" → press an unlabeled ✕ (36×28 px) → Save.
  - After scrolling, nothing on screen says which channel she is editing.
- **Screenshots:** `linda-11-hover-channel.png`, `-14-channel-settings.png`, `-16-deny-send.png`
- **Fix:**
  - `src/components/CreateChannelModal.jsx`: when type is Announcement, show a checked-by-default toggle **"Only admins and moderators can post here"**. On create, add a `@everyone` deny `SEND_MESSAGES` overwrite (same API as `settings/ChannelPermissionsTab.jsx`).
  - `ChannelSettingsModal.jsx`: add the same toggle, plus a "Permissions" tab that embeds `ChannelPermissionsTab` preselected to this channel.
  - `ChannelSidebar.jsx`: show a ⚙ and a 👤+ button on row hover and focus (Discord pattern), calling `onEditChannel` / `onCreateInviteFor`.
  - `settings/ChannelPermissionsTab.jsx`: give `TriState` visible text labels ("Block", "Default", "Allow"), with the ✕/–/✓ kept as icons. Make the selectors sticky: "Editing **#announcements** for **@everyone**".

### S2: major

**4. No loading feedback on slow networks, and the invite landing is wrong**
- **What happened:**
  - On Slow 3G the invite link shows a blank `#1e1f22` screen for **22 s**. Somchai: *"มันค้างหรือเปล่า"* ("Has it frozen?"). He would have pressed Back to LINE.
  - When the page does appear, it says **"ยินดีต้อนรับกลับมา!"** ("Welcome back!") and a login form. It does not say who invited him or to what. The server name and grandson's name only appear after he has registered.
- **Screenshots:** `somchai-01-loading-3s.png`, `-02-invite-landing.png`
- **Fix:**
  - `index.html`: add an inline, CSS-only splash (logo plus "กำลังโหลด…" / "Loading…" chosen from `navigator.language`) inside `#root`, so it paints before the JS bundle arrives.
  - `src/components/LoginScreen.jsx`: when `inviteCode` is set, fetch `/api/invites/:code` (it is public) and render the `InviteJoinScreen` header: server icon, "บีม เชิญคุณเข้าร่วม บ้านเรา 🏠" ("Beam invited you to join บ้านเรา 🏠"), member count. Default to `mode='register'` and the heading "สร้างบัญชีเพื่อเข้าร่วม" ("Create an account to join"). Remove the "เข้าสู่ระบบเพื่อรับคำเชิญนี้" ("Log in to accept this invite") banner on the register form; it tells a new user to *log in*.
  - After registration, auto-accept the invite (one less tap) and open the invite's channel.

**5. The composer stays enabled where the user can't post**
- **What happened:** A parent in `#announcements` types a question, and it appears in the chat with "You do not have permission to do that. ↻ Retry", plus a duplicate toast. Dave: *"Did it send or not? Retry does nothing."*
- **Screenshot:** `linda-24-parent-posted.png`
- **Fix:** in `ChatArea.jsx`, when the viewer lacks `SEND_MESSAGES` in the channel (the permissions are already in `viewerPermissions`), replace the composer with a grey bar: "🔒 Only admins can post in #announcements. Questions? Ask in #general." Also, never offer "Retry" for `MISSING_PERMISSIONS` or AutoMod blocks (`ChatArea.jsx` failed-message row); show "Remove" instead.

**6. Clicking the "Mute channel" label does nothing**
- **What happened:** In the popover, only the 40×20 px switch is clickable, and the text "Mute channel" is a plain `<span>`. Linda clicked the words twice. The mute durations also appear in 12 px text.
- **Screenshots:** `linda-27-notif-popover.png`, `-28-mute-duration.png`
- **Fix:** in `src/components/NotificationSettingsPopover.jsx` (lines 82–95), make the whole row a `<button role="switch">`, or wrap it in a `<label>`, with a minimum height of 40px. Use `text-sm` for the durations and add "1 week", as WhatsApp does.

**7. No read receipts or "Seen by" for announcements (Linda)**
- **What happened:** The context menu has Publish, Pin, Mark unread and so on, but nothing about who read the message. Linda: *"In WhatsApp I tap 'Message info' and see the blue ticks. How do I know the parents saw the trip letter?"*
- **Screenshot:** `linda-25-looking-for-seen-by.png`
- **Fix:** add a **"Seen by N"** footer on announcement-channel messages, built from existing `read_states` (last_read_message_id ≥ message id, members only). Show it only to authors and moderators, and have it open a list. Otherwise, add an "Acknowledge ✅" button type on announcements.
- **Files:** `ChatArea.jsx` (message footer), `MessageContextMenu.jsx` ("Message info"), and a new `GET /api/channels/:id/messages/:mid/readers` in `server.js`.

**8. Registration limit blocks group onboarding**
- **What happened:** `routes/auth.js:51` allows `RATE_LIMIT_REGISTER_PER_HOUR` = **10 per IP**. At a parents' evening on one school Wi‑Fi (one NAT IP), parent #11 gets "You're doing that too fast" for an hour. I hit this for real while running the three personas.
- **Fix:**
  - Count registrations that arrive with a valid invite code in a separate, higher bucket (for example 100 per IP per hour, still limited per invite).
  - Change the error text: "Lots of people are joining from this network. Please try again in a few minutes."
  - Show the retry-after time in `LoginScreen.jsx`.

**9. Touch users can't reach member or channel actions on iPad**
- **What happened:** `MemberList.jsx` and `ChannelSidebar.jsx` open their menus only with `onContextMenu`. iOS Safari does not fire `contextmenu` on long-press, so Rosa cannot open the Ban/Kick/Timeout menu or channel Mute/Edit by touch. Messages already have a long-press handler (`ChatArea.jsx:1207`).
- **Screenshot:** `rosa-18-member-menu.png` (reached only by right-click emulation)
- **Fix:**
  - Extract that long-press logic into `src/utils/useLongPress.js` and apply it to member rows and channel rows (500 ms, cancel on move).
  - Also add a visible "⋯" button on member rows for touch (`@media (hover:none)`).

**10. Unlabeled call controls and the push-to-talk trap**
- **What happened:** The voice view has 8 round icon-only buttons. The only text label is **"กดเพื่อพูด"** ("push to talk"), which invites Somchai to press it, and doing so changes his input mode. The control bar also covers the participant tiles (his own avatar is cut in half). The mic error text is jargon: "เลือกอุปกรณ์อินพุตอื่น" ("choose another input device").
- **Screenshot:** `somchai-15-voice.png`
- **Fix:**
  - `src/components/VoiceRoom.jsx` and `CallPanel.jsx`: put a text label under each control ("ไมค์" (mic), "เสียง" (sound), "กล้อง" (camera), "แชร์จอ" (share screen), "วางสาย" (hang up)), as LINE does.
  - Move push-to-talk into ⚙ Voice settings.
  - On screens narrower than 480 px, show only Mic, Speaker, Camera and **Hang up** (red, 64px, labelled), and put the rest under "More".
  - Give the tiles `padding-bottom` equal to the control-bar height.
  - Error copy: "ไม่ได้ยินเสียงจากไมค์ — แตะเพื่ออนุญาตให้ใช้ไมโครโฟน" ("Can't hear your mic. Tap to allow the microphone.")

**11. The "Delete role" button reads "Role deleted"**
- **What happened:** `ServerSettingsModal.jsx:946` and `:1010` use the audit-log string `t('audit.ROLE_DELETE')`. A red "🗑 Role deleted" appears next to a role Linda just created. *"Did I just delete it?!"*
- **Screenshot:** `linda-34-new-role.png`
- **Fix:** add `roles.delete: 'Delete role'` (plus translations) and use it in both places. Also add one-click presets on "Create role": **Moderator** (kick, timeout, manage messages) and **Helper** (manage messages).

**12. AutoMod is not built for a small-business owner**
- **What happened:**
  - "Criar regra" (create rule) opens with the type **Palavras filtradas** (filtered words) and an empty keyword field, so Save is blocked with an orange hint.
  - The type list includes "Padrão (regex)".
  - The spammer is blocked, but Rosa is never told, because "Alertar moderadores" (alert moderators) is off by default.
  - The name "AutoMod" is untranslated.
- **Screenshots:** `rosa-12-automod-new.png`, `-16-spam-attempt.png`
- **Fix:**
  - `settings/AutoModTab.jsx`: when there are no rules, show a **"Proteção básica contra spam (recomendado)"** (basic spam protection, recommended) card with one switch. It creates link, spam and mention-spam rules with Block + Alert.
  - Put regex behind "Avançado" (advanced).
  - In `pt-BR.js`, rename `settings.automod` to "Moderação automática".

**13. Text size is hard to find and the default theme is dark**
- **What happened:** Somchai opened "การเข้าถึง" (accessibility) first, and it has no text size. Text size sits under "ธีมและการแสดงผล" (theme and display) → about 3 screens down → "ขนาดตัวอักษรในแชท" (chat text size). The account's stored theme was `dark` even though Chromium reported a light preference.
- **Screenshots:** `somchai-21-settings.png`, `-22-appearance.png`
- **Fix:**
  - `settings/AccessibilityTab.jsx`: add the "Chat font scaling" and "Zoom" sliders at the top (the same settings as in `AppearanceTab.jsx`).
  - Default new accounts to `system` theme (the register handler writes `theme: "dark"`).
  - Axe also flagged `#80848e` on `#2b2d31` at 11 px (contrast 3.68:1) in the home empty state. Change `--d-text4` to at least `#9a9ea6`, and use 12 px or larger for hints.

### S3: minor

14. **English default names in localized servers.** New servers get "TEXT CHANNELS", "VOICE CHANNELS", "general" and "General Voice" even for a Thai or Brazilian owner (`services/guilds.js:23, 362–365`, `App.jsx:1562`, `CreateChannelModal.jsx:31`). Create them from the owner's locale (`req.user.locale`), for example "ห้องแชท" (chat rooms) and "ห้องเสียง" (voice rooms), "geral" and "Voz". Screenshots: `somchai-08`, `rosa-06`.
15. **The welcome text is jargon.** "…ใช้ Markdown ได้ทั้ง \*\*ตัวหนา\*\* ||สปอยล์|| และบล็อกโค้ด" ("…you can use Markdown, including \*\*bold\*\*, ||spoilers|| and code blocks") appears in every new channel. Replace it with "นี่คือจุดเริ่มต้นของ #X — ส่งข้อความ รูป หรือเสียงได้เลย" ("This is the start of #X. Send a message, photo or voice note.") in `ChatArea.jsx` (channel-welcome block) and the locale key.
16. **The composer placeholder is clipped.** Long placeholders ("ส่งข้อความไปที่ #General Voice" (send a message to #General Voice), "Conversar em #pedidos-e-encomendas") wrap inside the one-line textarea, and only a fragment shows ("encomendas", "#General"). Add `placeholder:truncate` / `white-space:nowrap; text-overflow:ellipsis` on the textarea placeholder, or shorten to "ส่งข้อความ…" ("Send a message…") on narrow widths. Screenshots: `rosa-22`, `somchai-15`.
17. **Small touch targets on the phone home screen** (axe/DOM scan at 360 px):
    - hamburger "แสดงรายการห้อง" (show channel list): **20×20** (`ChatArea.jsx:839`, `w-5 h-5`)
    - "สร้างแชทกลุ่ม" (create group chat): **16×16**
    - settings, mute and add friend: 32×32

    Give all icon buttons at least `min-w-11 min-h-11` (44 px) on `pointer:coarse`.
18. **The default invite lasts 7 days** (`InviteModal.jsx:25`). For family and community servers, "Never" is what people expect from a WhatsApp group link. Default to Never, with the text "Anyone with this link can join until you turn it off (Server settings → Invites)".
19. **Pinning gives no confirmation.** There is no toast, and the message gets no 📌 marker, so Linda can't tell it worked (`linda-21-after-pin.png`). Show a toast "Pinned. Find it under 📌 at the top", and add a small "📌 Pinned" line on the message (`ChatArea.jsx`).
20. **Native password validation bubble is in English** ("Please lengthen this text to 8 characters…") inside a Thai UI (`somchai-04`). Use `noValidate` on the form, and show `t('auth.passwordTooShort')` inline under the field in `LoginScreen.jsx`.
21. **Escape doesn't close the member-list overlay on tablets** (`rosa-20-banned.png`). Only tapping the dim backdrop does. Add an Escape handler in `MemberList.jsx` / `App.jsx`.
22. **Privacy defaults are wide open.** "Who can DM you" and "Who can see your full profile" both default to "Everyone". For Rosa, add a hint in the server-owner onboarding: "Clientes podem te mandar mensagem direta. Quer limitar só a amigos?" ("Customers can send you direct messages. Want to limit this to friends only?"). Link it to `settings/PrivacyTab.jsx`.
23. **The long-press message menu leads with power-user items** ("สร้างเทรด" (create thread), "ทำเป็นยังไม่อ่าน" (mark unread), "คัดลอกลิงก์ข้อความ" (copy message link)) and has no quick-reaction row (`somchai-13`). Show a row of 6 big quick reactions (❤️👍😂😮😢🙏) at the top, as LINE and WhatsApp do, in `MessageContextMenu.jsx`.

### S4: polish

24. The Thai server-icon initial "บ้" (first grapheme with a tone mark) looks odd. Use just the first base consonant, or the first emoji if the name has one ("🏠").
25. The language list shows English sub-names ("Danish", "Indonesian") in the Thai UI. Use `Intl.DisplayNames(locale)`.
26. The search result card shows `#` for an announcement channel (`SearchResultsPanel.jsx`). Use the channel-type icon.
27. `Seguir` / `Follow` is prominent on announcement channels in the header, which confuses single-server owners. Show it only when the viewer manages another server.

---

## 4. What delighted them

- **Somchai:**
  - The app opened in Thai with no setup, and the Thai font (Noto/IBM Plex–style) rendered cleanly with correct vowel stacking in *messages*.
  - Photos show large and full-width. Tapping one opens a clean viewer with big "ดาวน์โหลด" (download) and ✕ buttons.
  - Tapping the voice channel joins immediately, with no extra "Join" step. *"เหมือนกด LINE โทรเลย"* ("It's just like pressing call in LINE").
  - Thai usernames are accepted (`สมชาย` registered fine via the API).
- **Linda:**
  - The invite dialog opens automatically after creating the server and shows the link with a big **Copy** button and plain words: "Anyone with this link can join the server."
  - The mute durations ("Until I turn it back on") are in human language.
  - Search worked on the first try and showed a friendly date ("26 September 2026 at 16:21").
- **Rosa:**
  - Portuguese was auto-selected.
  - AutoMod blocked "GANHE R$500 no PIX" with a clear pt-BR message.
  - Banning showed a clear toast ("promo_pix… foi banido" (was banned)).
  - Mentioning `#suporte` in a post became a tappable chip.
  - The image upload preview was instant.

---

## 5. Scores (1–10)

| Persona | First impression | Ease of use | Visual appeal | Trust / safety | Would recommend |
|---|---|---|---|---|---|
| Somchai | 3 | 4 | 6 | 6 | 3 |
| Linda | 6 | 4 | 7 | 5 | 4 |
| Rosa | 7 | 6 | 7 | 7 | 6 |

- **Somchai:** *"ถ้าหลานไม่มานั่งข้าง ๆ ปู่คงไม่ได้เข้า ชื่อห้องก็อ่านไม่ออก"* ("If my grandson hadn't sat next to me, I'd never have got in. I can't even read the room name.")
- **Linda:** *"It looks professional, but the one thing I needed (admins-only announcements) was buried in a list of 30 switches with no words on them."*
- **Rosa:** *"O anti-spam funcionou, gostei. Mas no iPad não consigo abrir o menu do membro, e tive que achar sozinha a opção de mensagens diretas."* ("The anti-spam worked, I liked that. But on the iPad I can't open the member menu, and I had to find the direct-message setting on my own.")

---

## 6. Comparison with apps they already use

| Task | This app | Discord | LINE / WhatsApp / Telegram |
|---|---|---|---|
| Admin-only posting | Server settings → Channel permissions → ✕ on "Send messages" | Channel ⚙ → Permissions → @everyone ✕ Send Messages (still hard) | WhatsApp: Group info → "Send messages: Only admins" (1 toggle). Telegram: Channel type = broadcast by default. |
| Read status | none | none | WhatsApp blue ticks / Message info. LINE "อ่านแล้ว N" (read by N). Teams "Seen by". |
| Mute | Bell → small switch → duration | Right-click → Mute → duration | Tap chat header → Mute → 8 h / 1 wk / Always, with large rows |
| Call controls | 8 unlabeled circles | Icon row with tooltips | LINE and WhatsApp: 3–4 labelled buttons, big red hang-up |
| Invite landing | Login form "Welcome back" | Discord shows "X invited you to Y" before login | WhatsApp group link preview shows group name and photo before joining |
| Long-press on touch | Messages only | Everywhere (native apps) | Everywhere |
| Loading on slow network | blank screen 22 s | Discord shows animated logo splash | LINE Lite designed for 2G/3G |

---

## 7. Top fixes by impact per effort

1. `\p{M}` in the channel-name slug (`services/guilds.js`, `CreateChannelModal.jsx`): 3 one-line changes, fixes Thai and Indic scripts.
2. Label key "Role deleted" → "Delete role" (`ServerSettingsModal.jsx:946,1010`).
3. Make the whole "Mute channel" row clickable (`NotificationSettingsPopover.jsx`).
4. Disable the composer with an explanation when `SEND_MESSAGES` is denied, and drop "Retry" on permission and AutoMod errors (`ChatArea.jsx`).
5. Inline splash in `index.html`, and an invite-aware register screen (`LoginScreen.jsx`).
6. "Only admins can post" toggle on Announcement create and edit (`CreateChannelModal.jsx`, `ChannelSettingsModal.jsx`).
7. Composer and header reflow at ≤360 px or 200% zoom (`ChatArea.jsx`).
8. `useLongPress` for member and channel rows (`MemberList.jsx`, `ChannelSidebar.jsx`).
9. Labelled, simplified call controls on phones (`VoiceRoom.jsx`, `CallPanel.jsx`).
10. Separate registration rate-limit bucket for invite sign-ups (`routes/auth.js`).
