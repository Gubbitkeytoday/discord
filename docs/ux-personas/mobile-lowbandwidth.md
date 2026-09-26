# UX persona panel: mobile and low-bandwidth

Group: `mobile-lowbandwidth` · Build: branch `worktree-agent-a3e52ca3e95d44786` with `claude/dreamy-goldberg-p3o5ao` merged · Date: 2026-09-26
Scenario script: `scripts/ux/mobile-lowbandwidth.mjs` (Playwright + CDP network and CPU throttling, reusable: `UX_BASE=http://localhost:7070 UX_PHASES=perf,boonmee,grace,omar node scripts/ux/mobile-lowbandwidth.mjs`)
Screenshots: `/tmp/claude-0/-home-user-discord/663d99e8-07c9-5b0f-8b1a-38c6a8c33dc1/scratchpad/shots/persona-mobile-lowbandwidth-*.png`

---

## สรุปภาษาไทย

เราทดสอบแอปกับผู้ใช้สมมติ 3 คน ได้แก่ **บุญมี** (ไรเดอร์ อายุ 19 ใช้ Android ราคาถูก เน็ต Slow 3G ที่หลุดเป็นช่วง ๆ), **เกรซ** (พยาบาลกะดึกชาวฟิลิปปินส์ ใช้ iPhone 13 โหมดมืด) และ **โอมาร์** (คนขับแท็กซี่ชาวตุรกี ใช้แท็บเล็ตแนวนอน คุยเสียงแบบไม่ใช้มือ)

**สิ่งที่ทำได้ดี:** UI ภาษาไทยถูกเลือกให้อัตโนมัติและตัวอักษรไทยแสดงผลสวย ข้อความที่พิมพ์ตอนเน็ตหลุด 20 วินาทีส่งถึงเพื่อนได้เองเมื่อกลับมาออนไลน์ และข้อความที่พลาดไประหว่างนั้นก็ขึ้นมาครบ (ใช้ connection-state recovery 2 นาที) มีแถบ "2 ข้อความใหม่ตั้งแต่ 22:40" กับเส้น "ข้อความใหม่" แถบความคืบหน้าอัปโหลดแสดงเป็นเปอร์เซ็นต์ ข้อความเสียงอัดและส่งได้ง่าย และหน้าห้องเสียงบนแท็บเล็ตแนวนอนดูดี ปุ่มใหญ่

**ปัญหาร้ายแรง:**
1. **ถ้าเน็ตหลุดนานกว่า 2 นาที ข้อความที่พลาดไปจะหายเงียบ ๆ** ข้อความ "ลูกค้ายกเลิกออเดอร์" ไม่ขึ้นเลยจนกว่าจะรีโหลดเอง และไม่มีแถบบอกว่า "ออฟไลน์/กำลังเชื่อมต่อ" ด้วย
2. **เปิดครั้งแรกบน Slow 3G ต้องรอประมาณ 25 วินาที ระหว่างนั้นเห็นแค่จอดำ** โหลด 774–906 KB เพราะเซิร์ฟเวอร์ Node ไม่บีบอัดไฟล์ และ regex ของ cache ไม่ตรงกับชื่อไฟล์ของ Vite (ทำให้ไม่ได้ cache แบบ immutable)
3. **ไม่มี PWA** (ไม่มี manifest ไม่มี service worker) ติดตั้งลงหน้าจอไม่ได้ เปิดตอนออฟไลน์ก็เจอหน้าไดโนเสาร์ และ iPhone ส่ง push notification ไม่ได้เลย เกรซจึงพลาดข้อความตอนปิดแท็บ
4. **ชื่อห้องภาษาไทยถูกทำลาย** พิมพ์ "งานวันนี้" แต่ได้ "#งานวนน" เพราะ regex ตัดสระและวรรณยุกต์ (\p{M}) ทิ้ง ชื่อไฟล์ภาษาไทยก็เพี้ยนเป็น "slip-à¹\u0080à¸..." (multer อ่านเป็น latin1)
5. **ปุ่มเล็กเกินไป** ปุ่มบนหัวแชตมีขนาด 20×20 px ปุ่มในช่องพิมพ์ 24×26 และปุ่มส่ง 28×28 (ควรอย่างน้อย 44×44) บนแท็บเล็ตเหลือแค่ 16×16
6. ไม่มีท่าปัดเปิดเมนูหรือปัดเพื่อตอบกลับแบบที่ LINE/WhatsApp มี การปัดแนวนอนกลายเป็นคำสั่ง "ย้อนกลับ" ของเบราว์เซอร์ ทำให้หลุดออกจากแอปไปหน้า about:blank
7. อัปโหลดรูปบนเน็ตช้า**ยกเลิกไม่ได้และลองใหม่ไม่ได้** และรูปที่โหลดไม่สำเร็จจะค้างเป็นไอคอนรูปแตกโดยไม่ลองโหลดใหม่
8. การแจ้งเตือน @mention จากเซิร์ฟเวอร์ไปขึ้นที่ไอคอน "ข้อความส่วนตัว" แทนที่จะขึ้นที่ไอคอนเซิร์ฟเวอร์ ผู้ใช้จึงหาไม่เจอ
9. ปุ่ม Push-to-talk บนแท็บเล็ตเขียนว่า "กดปุ่มค้างไว้" แต่แท็บเล็ตไม่มีคีย์บอร์ด พอแตะก็เป็นการปิดโหมดแทน

คะแนนเฉลี่ย "จะแนะนำให้เพื่อนไหม": บุญมี 3/10, เกรซ 5/10, โอมาร์ 6/10

---

## 1. Personas

| | **Boonmee (บุญมี)** | **Grace** | **Omar** |
|---|---|---|---|
| Age / gender | 19, man | 27, woman | 35, man |
| Occupation | Motorbike food-delivery rider, Sai Mai (Bangkok outskirts) | ICU nurse, night shift, Manila | Taxi driver, Kadıköy, Istanbul |
| Tech literacy | Medium on phone apps (LINE, TikTok, Grab Rider, Facebook). Has never used a desktop app. | High on phone (Messenger, Viber, Instagram, Teams at work) | Medium (WhatsApp, BiTaksi, YouTube, Zello push-to-talk for dispatch) |
| Device | Samsung Galaxy A03-class, 360×740, emulated with 6x CPU throttle | iPhone 13, 390×844, @3x | Samsung Galaxy Tab A-class, 1280×800 landscape on a dash mount |
| Network | Slow 3G (2 s RTT, ~400 kbps), drops in tunnels and lifts (20 s and 150 s) | Hospital Wi-Fi / Fast 3G, uses the app in 5-minute breaks | Fast 3G, mobile hotspot |
| Language | Thai (th); weak English | English (en-PH) | Turkish (tr) |
| Access needs | One-handed with gloves on, data budget ~3 GB/month, battery anxiety | Dark mode (eyes adapted to dark ward), notifications must reach her while the phone is locked | Hands-free while driving; big targets; must never have to read small text |
| Goal | Join the riders' group from a LINE link, get jobs, send slip photos and voice notes, never miss "order cancelled" | "What did I miss?" in 30 seconds per break; get pinged when someone needs her to cover a bed | Sit in the drivers' voice channel all shift, talk hands-free, see who is talking |

---

## 2. Measurements

### 2.1 Load performance (360×740, cold cache, logged out → login form usable; then logged in; then warm reload)

| Network | FCP | Login form usable | Bytes, cold | Login → app shell | Bytes idle-preloaded after login | Warm reload → shell | Bytes, warm |
|---|---|---|---|---|---|---|---|
| Wi-Fi, 1x CPU | 0.45 s | 1.3 s | 825 KB | 0.34 s | 301 KB | 0.84 s | 28 KB |
| Fast 3G, 4x CPU | 5.6 s | 7.2 s | 825 KB | 2.1 s | 188 KB (still going) | 2.9 s | 134 KB |
| **Slow 3G, 6x CPU** | **20.1 s** | **24.9 s** | **774 KB** | 2.6 s | 54 KB (still going) | 7.5 s | 92 KB |
| Invite link, Slow 3G, Thai | — | **29.4 s** | **906 KB** (adds the 138 KB `th` chunk; the 90 KB English table is in the main bundle anyway) | | | | |

Cold breakdown: JS 646 KB (index 336 KB, react 194 KB, icons 56 KB, socket 43 KB), CSS 97 KB, fonts 25–76 KB. **Nothing is compressed**: `server.js` with `SERVE_STATIC=1` has no gzip/brotli. The same JS+CSS gzips to ~206 KB (checked with `gzip -9`), so a Caddy/nginx deployment would be ~3.5x smaller. Anyone who runs `node server.js` or `start-discord.bat` directly ships 3.5x the bytes.

Hashed assets are served `Cache-Control: no-cache`, not `immutable`. The regex in `server.js:2085` expects `name.<hash>.js`, but Vite emits `name-<hash>.js`, so every warm load revalidates every asset (7 × 304 on reload = 7 round trips at 2 s RTT).

What Boonmee sees for the first ~20 s on Slow 3G is a **flat, empty dark screen** (`perf-slow3g-at-3s.png`), with no logo, spinner or text.

### 2.2 PWA / installability

| Check | Result |
|---|---|
| `<link rel="manifest">` | **none** (`/manifest.json` returns the SPA HTML) |
| Service worker | **none** |
| `theme-color`, `apple-touch-icon` | none |
| Chrome installability errors | `no-manifest` |
| Reload while offline | Chrome "No internet" dinosaur (`perf-offline-reload.png`) |
| Web Push | impossible on iOS without an installed PWA + SW, so Grace gets **no** notification once the tab is closed |

### 2.3 Offline and reconnect (Boonmee, Slow 3G)

| Situation | Result |
|---|---|
| Offline banner / status | **None** at any point (`boonmee-13-offline-2s.png`, `boonmee-15-offline-20s.png`) |
| Send while offline (20 s) | Row shows at 50% opacity with no "sending…" or clock icon; it **was delivered** 0.3 s after reconnect, exactly once (Socket.IO buffers the emit). |
| Friend's messages during a 20 s drop | Appeared 0.3 s after reconnect (connection-state recovery), with a "2 new messages since 22:40 / Mark as read" bar and a red "New" divider (`boonmee-17-after-long-drop.png`) |
| Friend's message during a **150 s** drop (beyond the 120 s recovery window) | **Never appeared** (waited 60 s after reconnect). The client ignores `socket.recovered === false` and does not refetch. |
| Grace: 30 s background drop | Recovered in 0.12 s |
| Image upload, 400 KB photo, Slow 3G | Inline progress bar "กำลังอัปโหลด… 36%" (good). **No cancel.** The attach "+" icon spins and looks like an ✕, but it is a disabled button. 11 s to finish. |
| Upload when going offline mid-way | Bar froze at 48% with no status for the whole offline period (`boonmee-12-upload-offline.png`). In this run the in-flight request finished after reconnect, so the photo was attached. If the request errors, though, `xhr.onerror` drops the file (`ChatArea.jsx:~468`): there is **no retry button** and you must pick the photo again. |
| Images that failed while offline | Stay as broken-image placeholders with mojibake alt text after reconnect; there is no retry or tap-to-reload. |

### 2.4 Touch targets (<44×44 CSS px, visible on the chat screen)

| Screen | Too small / total | Offenders |
|---|---|---|
| Phone chat (Boonmee 360 px, Grace 390 px) | 9 / 36 | Hamburger "Show channels" **20×20**, Pins 20×20, Members 20×20, Search 20×20, More ⋮ 20×20, Attach 24×26, Emoji 24×26, Voice-note mic 24×26, **Send 28×28** |
| Tablet voice screen (Omar 1280 px) | 19 / 37 | Header Pins/Bell/Members **16×16**, Disconnect in user panel 28×28, Mute/Deafen/Settings 32×32, channel rows 223×32, composer icons 24×26. The voice-room control bar itself is good (≈52 px round buttons). |

### 2.5 Gestures and keyboard

| Gesture | Result |
|---|---|
| Swipe right to open channel drawer (Discord mobile, LINE) | **Not supported.** The horizontal swipe fell through to Chromium's history back-navigation and **left the app for `about:blank`** (both from x=4 and x=24). `boonmee-06-after-swipe.png` is a white page. |
| Swipe message left to reply (LINE/WhatsApp/Telegram) | Not supported |
| Long-press message | Code has a 450 ms long-press handler (`ChatArea.jsx:1207`), but it did not open the action bar under CDP touch emulation. Inconclusive; needs a real-device check. |
| Long-press channel (to mute) | Only `onContextMenu`, which Android Chrome fires on long-press and **iOS Safari never does**. Grace cannot reach channel mute by long-press. |
| Soft keyboard (Android, resized layout viewport to 450 px) | Composer stays visible (y=380 of 450). But the list did not stick to the bottom: Boonmee's own last message scrolled out of view behind the keyboard (`boonmee-05-keyboard-open.png`). |
| Soft keyboard (iOS) | Root uses `h-screen` (100vh) and the viewport meta has no `interactive-widget`, so on iOS Safari the composer sits under the keyboard/URL bar when the keyboard opens (code review; iOS keyboard cannot be emulated in Chromium). |

---

## 3. Task results

| # | Persona | Task | Result | Time | Taps | Severity of worst issue |
|---|---|---|---|---|---|---|
| B1 | Boonmee | Open invite link from LINE, cold, Slow 3G | ✅ but slow | 29.4 s to first usable screen, 906 KB | 0 | S1 (blank 20 s) |
| B2 | Boonmee | Register (Thai auto-detected) | ✅ | 16.6 s | 4 | S2: the invite link shows generic "ยินดีต้อนรับกลับมา!" (Welcome back) login, not "Somchai invited you to ไรเดอร์ สายไหม"; sign-up is a small link |
| B3 | Boonmee | Accept invite → find the job channel | ✅ | 10 s | 2 | S2: channel "งานวันนี้" shows as "#งานวนน" |
| B4 | Boonmee | Send text one-thumbed | ✅ | 3.7 s, delivered in 0.13 s | 2 | S2: send button 28×28 |
| B5 | Boonmee | Keyboard open, composer visible | ✅ | — | — | S3: list does not stay pinned to bottom |
| B6 | Boonmee | Swipe to open drawer | ❌ left the app | — | — | S1 |
| B7 | Boonmee | Swipe to reply | ❌ | — | — | S3 |
| B8 | Boonmee | Upload slip photo on Slow 3G | ✅ | 11 s | 2 | S2: no cancel; Thai filename mojibake |
| B9 | Boonmee | Upload interrupted by tunnel | ⚠️ froze at 48% with no status; finished after reconnect; no retry path | — | — | S2 |
| B10 | Boonmee | 20 s offline: send and catch up | ✅ | 0.3 s after reconnect | 0 | S2: no offline or sending indicator |
| B11 | Boonmee | 150 s offline: catch "order cancelled" | ❌ message never shown | — | — | **S1** |
| B12 | Boonmee | Record and send 3 s voice note | ✅ | 12 s | 2 | S3: mic 24×26 |
| G1 | Grace | Invite + sign-up in dark mode | ✅ | 16 s | 5 | — (follows `prefers-color-scheme`, good) |
| G2 | Grace | Turn on notifications | ⚠️ found in Settings › Notifications, labelled "**Desktop** notifications"; bell hidden on phone (`max-sm:hidden`) | 3.8 s | 2 | **S1**: no push once the tab is closed (no SW) |
| G3 | Grace | After shift: "what did I miss?" (25 msgs + @mention) | ✅ but misleading | 14.4 s | 3 | S2: mention badge on the **DM/Home** icon, not the server; no "N new since" bar on first visit to a channel |
| G4 | Grace | 30 s background drop | ✅ | 0.12 s | 0 | — |
| G5 | Grace | Mute channel for 8 h via long-press | ❌ nothing happens on iOS | — | 2 | S2 |
| O1 | Omar | Invite + sign up in Turkish | ✅ | 20.6 s | 5 | — |
| O2 | Omar | Join voice hands-free | ✅ "Bağlandı" | 6.7 s | 1 | — |
| O3 | Omar | Friend joins, see who talks | ✅ | — | 0 | — |
| O4 | Omar | Rotate to portrait and back | ⚠️ | — | 0 | S2: member list opens as an overlay over half the screen and hides Disconnect/Push-to-talk; friend's tile disappears (`omar-05-portrait.png`) |
| O5 | Omar | Use push-to-talk from the tablet | ❌ | — | 1 | S2: button says "hold key to talk" (keyboard key); tapping it turns PTT **off** |

---

## 4. Ranked issues

### S1: blockers

**S1-1. Messages missed during a drop longer than 2 minutes never appear**
- What happened: while Boonmee was offline for 150 s, Somchai wrote "ลูกค้ายกเลิกออเดอร์" (customer cancelled the order). After reconnect it did not show within 60 s. There is no banner, no refetch, and nothing to tap. Screenshot: `boonmee-17-after-long-drop.png` (latest message is still from before the drop).
- Who: every mobile user; a lift, a tunnel or a locked phone causes this.
- Root cause: the server uses Socket.IO `connectionStateRecovery` with `RECOVERY_WINDOW_MS = 120000` (`realtime.js:112-124`). The client (`src/App.jsx:410-420`, `onConnect`) only re-identifies. It never checks `socket.recovered`, and the message-history effect (`App.jsx:~541`) only runs when `activeChannelId` changes.
- Fix: in `src/App.jsx` `onConnect`, when `!socket.recovered`, (a) refetch `/api/messages/:active?after=<last known id>` and merge by id, (b) call `loadReadStates(currentUserId)` so badges update, (c) reload the open server's channel list. Also refetch on `visibilitychange` → visible when the tab has been hidden for >120 s.

**S1-2. No connection status anywhere**
- What happened: offline for 20 s or 150 s, the UI looks identical to online (`boonmee-13-offline-2s.png`). Pending messages are only 50% opacity.
- Who: Boonmee, Grace.
- Fix: new `src/components/ConnectionBanner.jsx` mounted in `App.jsx`, driven by socket `disconnect`/`connect`/`reconnect_attempt` plus `navigator.onLine`: a thin amber bar "ออฟไลน์ — ข้อความจะถูกส่งเมื่อกลับมาออนไลน์" / "Offline — messages will send when you're back", then "กำลังเชื่อมต่อใหม่…" / "Reconnecting…", then a green "เชื่อมต่อแล้ว" / "Back online" for 2 s. In `ChatArea.jsx` show pending rows with a small clock icon and the text "กำลังส่ง…" / "Sending…" (WhatsApp/LINE pattern) instead of opacity alone.

**S1-3. First load on Slow 3G: 20–29 s of blank dark screen, 774–906 KB**
- What happened: `perf-slow3g-at-3s.png` is a solid #1e1f22 screen. Boonmee: "จอดำ ๆ นึกว่าแอปพัง ปิดดีกว่า" ("black screen, I thought it was broken, I'm closing it").
- Root causes: (a) no compression in `server.js` static serving; (b) the immutable-cache regex in `server.js:2085` `/\.[0-9a-zA-Z_-]{8,}\.(js|css|…)$/` never matches Vite's `index-DLfPUkMA.js`, so assets get `no-cache`; (c) `index.html` has no inline loading state; (d) `preloadWhenIdle` (`App.jsx:377`) downloads ~300 KB of settings, voice, forum and events chunks right after login, even on 2G/3G.
- Fix: `server.js`: add `compression()` (or serve pre-built `.br/.gz` from `vite build` via `vite-plugin-compression`) and change the regex to `/-[0-9a-zA-Z_-]{8,}\.(js|css|woff2?|png|jpe?g|svg|webp)$/`. `index.html`: put an inline SVG logo and a CSS-only spinner inside `<div id="root">` (React replaces it). `src/utils/lazyComponent.jsx` `preloadWhenIdle`: return early when `navigator.connection?.saveData` or `effectiveType` is `slow-2g`, `2g` or `3g`. Split `en.js` out of the main bundle for non-English locales. Target: <250 KB on the wire for the login screen.

**S1-4. Not a PWA: no install, no offline shell, no push on iPhone**
- What happened: no manifest, no service worker, `installabilityErrors: no-manifest`; an offline reload gives the Chrome dinosaur (`perf-offline-reload.png`). Grace, with the tab closed, gets nothing. She says: "Messenger buzzes my phone. This only works if I leave Safari open? On a 12-hour shift? No."
- Fix: add `public/manifest.webmanifest` (name, `short_name`, `display: standalone`, `theme_color #1e1f22`, 192/512 maskable icons), `<link rel="manifest">`, `<meta name="theme-color">` and `apple-touch-icon` in `index.html`, plus a service worker (`vite-plugin-pwa`, `injectManifest`) that precaches the hashed shell (offline start, instant warm loads) and handles Web Push (`push` / `notificationclick`). The server needs a VAPID push endpoint. In `src/components/settings/*` (Notifications tab), rename "Desktop notifications" to "Push notifications" on touch devices and, on iOS, show "Add to Home Screen to get notifications" with the share-sheet steps.

**S1-5. Horizontal swipe leaves the app**
- What happened: a thumb swipe to open the drawer (Discord mobile, LINE) triggered browser back-navigation to `about:blank` (`boonmee-06-after-swipe.png`, `boonmee-06b-edge-back.png`), and the app then needed a 25 s cold reload on Slow 3G.
- Fix: `src/index.css` `html, body { overscroll-behavior-x: none; }`. In `App.jsx`, add a pointer/touch swipe handler on the chat pane: swipe right (>60 px, mostly horizontal) opens `mobileSidebarOpen`, swipe left on the drawer closes it, and swipe left in chat opens the member list. Also make the SPA push a history entry when the drawer opens, so Android system "back" closes the drawer instead of leaving.

### S2: major

**S2-1. Thai (and Hindi, etc.) channel names are corrupted**: "งานวันนี้" becomes "#งานวนน" (`boonmee-04-channel.png`). The regex `/[^\p{L}\p{N}_-]/gu` strips combining marks (`\p{M}`: Thai vowels and tone marks, Devanagari matras). Fix in both `src/components/CreateChannelModal.jsx:38` and `services/guilds.js:401,476`: `/[^\p{L}\p{M}\p{N}_-]/gu`. Add a unit test with "งานวันนี้" and "नमस्ते".

**S2-2. Non-ASCII upload filenames become mojibake**: "slip-โอนเงิน.png" is stored as "slip-à¹\u0080à¸\u0082…png" (`boonmee-12-upload-offline.png`). multer/busboy decodes as latin1. Fix in `routes/files.js`: create multer with `defParamCharset: 'utf8'` (multer 2.x) or normalise `f.originalname = Buffer.from(f.originalname, 'latin1').toString('utf8')`.

**S2-3. Touch targets far below 44 px on phone and tablet**: header icons 20×20 (16×16 on tablet), composer icons 24×26, Send 28×28. Fix in `src/components/ChatArea.jsx` header buttons (~L830-1010) and composer buttons (~L1774-1885), and in `src/components/VoiceNote.jsx` `VoiceNoteButton`: give every icon button `min-w-11 min-h-11 inline-flex items-center justify-center rounded-md` (keep the 20 px glyph, grow the hit area). Make Send 44×44 with a filled brand circle when there is text (WhatsApp/LINE). In the user panel (`ChannelSidebar.jsx` / `HomeDirectMessages.jsx`), make Mute/Deafen/Settings/Disconnect ≥44 px when `(pointer: coarse)`.

**S2-4. Server mentions show on the wrong icon; other servers show no unread**: after reopening, Grace saw a red "1" on the Home/DM icon, and the "Ward 5B" icon had no badge (`grace-05-reopen.png`). Root cause: `src/components/ServerRail.jsx:125-143` derives per-server state from `channels`, which holds only the *active* server's channels (`App.jsx:433`), so every other server's mentions fall into `dmMentions`. The read-state rows already carry `server_id` (`services/messages.js:1215`). Fix: group `Object.values(readStates)` by `state.server_id`, and use `!state.server_id` for DM mentions.

**S2-5. Upload cannot be cancelled or retried**: `ChatArea.jsx` `postAttachments` keeps no handle on the XHR and discards the `File` on failure. Fix: store `xhrRef`, and render a real "✕ ยกเลิก / Cancel" button (44 px) inside the progress bar that calls `xhr.abort()`. On error keep the `File[]` and show "อัปโหลดไม่สำเร็จ · ลองใหม่" / "Upload failed · Retry". Add `xhr.timeout` or a stall detector (no progress for 15 s means failed). Stop animating the attach "+" into a look-alike ✕ (`PlusCircle animate-spin`): show it disabled but static. Compress photos client-side before upload (canvas → WebP/JPEG at max 1600 px, q≈0.8) when `saveData` is set or the file is over 1 MB (LINE and WhatsApp do this).

**S2-6. Broken images never retry**: images that failed while offline stay as broken placeholders after reconnect (`boonmee-20-voice-sent.png`). Fix in `ChatArea.jsx` attachment `<img>` (~L1400) and `src/components/StillImage.jsx`: `onError` shows a "แตะเพื่อโหลดใหม่ / Tap to reload" tile and retries automatically on the socket `connect` event. Also serve thumbnails (`thumbnail_url` is already used in the composer preview) in the message list instead of the original.

**S2-7. Invite link opens a generic "Welcome back!" login**: a brand-new user from a LINE link sees "ยินดีต้อนรับกลับมา!" and a note "Sign in to accept this invite", not *who* invited them or *to what* (`boonmee-01-invite-cold.png`, `grace-01-invite.png`). The server card is only shown after sign-up (`boonmee-02b-invite-card.png`). Fix: `src/components/LoginScreen.jsx` with invite context: fetch `/api/invites/:code` (public), show the `InviteJoinScreen` card (icon, "Somchai เชิญคุณเข้าร่วม ไรเดอร์ สายไหม", online/member counts) above the form, **default to the Sign up tab**, and make the primary button "สมัครและเข้าร่วม / Sign up & join" (Discord's invite page does this).

**S2-8. No "new since" bar or divider on the first visit to a channel**: Grace had 25 unread messages in #handover and landed at the bottom with no "25 new messages" bar and no "New" line (`grace-06-channel-catchup.png`); the mention happened to be on screen. Root cause: `isFirstUnread` needs a stored read marker, and there is none before the first visit. Fix in `App.jsx` (where `setChannelReadMarker` is set, ~L537): when there is no read state, use the member's server `joined_at` as the marker (Discord behaviour), so the bar reads "25 new messages since 22:31" and jumps to the first unread.

**S2-9. Push-to-talk is unusable on touch**: `VoiceRoom.jsx:620-638`: the chip reads "Hold {key} to talk" and `onClick` toggles the input mode off. Omar: "Hangi tuş? Klavyem yok ki." ("Which key? I don't have a keyboard."). Fix: when `(pointer: coarse)` and PTT is on, render a large (≥72 px) "Basılı tut ve konuş" / "Hold to talk" button with `onPointerDown`/`onPointerUp` driving `media.pttHeld`, and move the mode switch into voice settings. Also add `navigator.wakeLock.request('screen')` while in voice (optional toggle) and Media Session metadata, so the call shows in the Android notification shade.

**S2-10. Tablet portrait: member list overlay covers the voice controls**: after rotating to 800×1280 the member panel slides over half the screen, hiding Disconnect and PTT; the friend's tile is gone (`omar-05-portrait.png`). Fix in `App.jsx` (`showMemberList` initial state is computed once, L161): listen to `matchMedia('(max-width: 1023px)')` changes and close the member list when crossing into narrow. In `VoiceRoom.jsx`, let the control bar wrap to two centred rows instead of clipping.

**S2-11. Channel mute is unreachable by long-press on iPhone**: `ChannelSidebar.jsx:286,327` only use `onContextMenu`. Fix: reuse the 450 ms long-press pattern from `ChatArea.jsx:1207` on channel rows and open the same menu (Mute 15 min / 1 h / 8 h / until I turn it back on). Show the bell in the phone header too (it is `max-sm:hidden`, `ChatArea.jsx:~935`), or put "Mute channel" as the first ⋮ item.

### S3: minor

- **S3-1.** The list does not stay pinned to the bottom when the keyboard resizes the viewport (`boonmee-05-keyboard-open.png`). `ChatArea.jsx`: on `visualViewport` `resize`, if the list was at the bottom, scroll to the bottom again. Root `div` in `App.jsx:2123`: `h-screen` → `h-dvh`. Viewport meta in `index.html`: add `interactive-widget=resizes-content, viewport-fit=cover`, plus `env(safe-area-inset-bottom)` padding under the composer (iPhone home bar).
- **S3-2.** No swipe-to-reply (LINE, WhatsApp, Telegram, Discord mobile all have it). `ChatArea.jsx` message row: horizontal drag >56 px sets `replyToMsg`, with a small reply-arrow reveal and a haptic `navigator.vibrate(10)`.
- **S3-3.** A chunk that fails to download renders `null` silently (`lazyComponent.jsx` `ChunkBoundary`): on flaky 3G, tapping Settings does nothing. Render "โหลดไม่สำเร็จ · ลองใหม่" / "Couldn't load · Retry" instead.
- **S3-4.** The Thai UI still downloads the English table (90 KB raw, in the main bundle) plus Thai (138 KB). Lazy-load `en.js` as a fallback chunk only for missing keys, or ship per-locale bundles.
- **S3-5.** "Desktop notifications" wording on a phone (`settings` Notifications tab). Use "Notifications on this device".

### S4: polish

- **S4-1.** Server initials: `serverInitials("ไรเดอร์ สายไหม")` gives "ไส" in the rail, but the invite card shows "ไร" (two algorithms). In `src/utils/avatar.js`, use `Intl.Segmenter` graphemes and skip Thai leading vowels `[เ-ไ]`, giving "รส", and reuse it in `InviteJoinScreen.jsx`.
- **S4-2.** Default category names "TEXT CHANNELS / VOICE CHANNELS" and "General Voice" are created in the creator's language and never localised for Thai or Turkish members. Store them as i18n keys unless renamed.
- **S4-3.** The loading skeleton in the channel list after accepting an invite on Slow 3G is an empty grey panel for ~4 s (`boonmee-03-after-accept.png`). Show 4–5 shimmer rows.

---

## 5. What delighted them

- **Boonmee:** "ภาษาไทยมาเองเลย ไม่ต้องหา" ("Thai just appeared, I didn't have to look for it"). Thai glyphs render crisply with correct vowel stacking (Noto/Inter fallback). He liked the voice note flow: tap the mic, a red dot and timer, a big blue send button, and a clean player bubble (`boonmee-19-recording.png`, `boonmee-20-voice-sent.png`). The blue "2 ข้อความใหม่ตั้งแต่ 22:40 · ทำเครื่องหมายว่าอ่านแล้ว" bar was "เหมือน LINE เลย" ("just like LINE"). His offline message went out by itself on reconnect.
- **Grace:** dark mode followed iOS automatically (`grace-02-channel.png`). The mention row is highlighted with a gold bar and easy to spot. The Notifications settings page is well written ("What interrupts you, and how loudly"), with sound previews.
- **Omar:** the landscape voice room looks professional. The control bar has large round buttons, "Bu odada 2 kişi" (2 people in this room), a green speaking ring, and Turkish throughout (`omar-04-two-in-voice.png`). Rejoining voice after a reconnect is handled in code (`App.jsx:389`).

---

## 6. Scores (1–10)

| Persona | First impression | Ease of use | Visual appeal | Trust / safety | Would recommend |
|---|---|---|---|---|---|
| Boonmee | 3 | 5 | 7 | 4 | 3 |
| Grace | 6 | 6 | 8 | 5 | 5 |
| Omar | 7 | 6 | 8 | 7 | 6 |

Boonmee: "เน็ตหลุดแป๊บเดียวแล้วงานยกเลิกหายไปเลย แบบนี้โดนลูกค้าด่าแน่ ใช้ LINE ต่อดีกว่า" ("The net drops for a moment and the cancelled order just vanishes. Customers will yell at me. I'll stick with LINE.")
Grace: "It looks nicer than Teams, but if it can't buzz my phone it's useless on a ward."
Omar: "Ses güzel, ama bas-konuş için klavye mi taşıyacağım?" ("Voice is nice, but am I supposed to carry a keyboard for push-to-talk?")

---

## 7. Comparison with apps these personas already use

| Behaviour | This app | Discord (Android/iOS app) | LINE / WhatsApp / Telegram / Zello |
|---|---|---|---|
| Install / offline start | Browser tab only, dinosaur offline | Native app | Native; Telegram Web and WhatsApp Web are PWAs with a SW |
| Offline indicator | none | "Connecting…" bar | "Connecting…" in the title (Telegram/WhatsApp), clock icon on queued messages |
| Catch up after a long disconnect | Missed messages lost until reload | Full resync on reconnect | Full resync |
| Photo upload | Original size, no cancel or retry | Cancel ✕ on upload, retry | Compressed by default; cancel and retry |
| Swipe gestures | none; swipe exits the app | Swipe right = channels, left = members | Swipe message to reply |
| Push-to-talk on touch | "Hold key" only | On-screen PTT in mobile app | Zello: giant hold-to-talk button, the whole point of the app |
| Push notifications with the app closed | Impossible on iOS | Yes | Yes |
