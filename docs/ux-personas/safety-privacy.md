# UX persona panel: Safety & Privacy

## สรุปภาษาไทย

เราทดสอบแอปกับผู้ใช้สมมติ 3 คน โดยใช้ Playwright กับเซิร์ฟเวอร์จริง (พอร์ต 7050, DB ชั่วคราว, `ALLOW_DEV_IDENTITY=0`) และใช้บัญชีที่สองเป็นคนก่อกวนหรือคนแปลกหน้า

- **ใหม่** (สตรีมเมอร์ไทย): บล็อก รายงาน และตั้งค่าให้รับ DM เฉพาะเพื่อนได้ภายใน 3–4 คลิก เซิร์ฟเวอร์บังคับใช้กฎได้จริง แม้คนก่อกวนจะสมัครบัญชีใหม่มาก็ยังถูกปฏิเสธ แต่มีปัญหาร้ายแรง 3 ข้อ
  1. **สถานะ "ซ่อนตัว" รั่ว**: API รายชื่อสมาชิกส่งค่า `status: "invisible"` ไปให้ทุกคน คนก่อกวนจึงรู้ว่าเธอออนไลน์อยู่แต่ซ่อนตัว
  2. **รายงาน DM ไม่ถึงใคร**: กล่องรายงานเขียนว่า "ผู้ดูแลเซิร์ฟเวอร์นี้จะเห็น" แต่ DM ไม่มีเซิร์ฟเวอร์ รายงานจึงถูกบันทึกโดย `server_id = NULL` ซึ่งเปิดอ่านได้ผ่าน `ADMIN_TOKEN` เท่านั้น และไม่มีหน้าจอให้ใครอ่าน
  3. **ไม่มีกล่อง "คำขอข้อความ"**: DM จากคนแปลกหน้าเด้งเข้ามาเหมือนข้อความจากเพื่อน
- **อเล็กซ์** (นักพัฒนาชาวเยอรมัน): ข้อมูลส่วนตัวรั่ว แม้ตั้งโปรไฟล์เป็น "เฉพาะเพื่อน" แล้ว คำสรรพนามและ bio ของเธอก็ยังเปิดอ่านได้ผ่าน `/api/servers/:id/profile/:userId` และ bio ยังแสดงใต้ชื่อในรายชื่อสมาชิกด้วย **อุปกรณ์ที่ถูกสั่งออกจากระบบจะเห็นแต่ JSON 401** และเข้าสู่ระบบใหม่ไม่ได้ จนกว่าจะล้างคุกกี้ ส่วนฟีเจอร์ Passkey มีโค้ดครบ แต่ไม่ถูกแสดงบนหน้าจอเลย
- **ฟาติมา** (ผู้ปกครองชาวอินโดนีเซีย): ตอนสมัครไม่ถามอายุ และไม่มีการตั้งค่าสำหรับวัยรุ่นหรือผู้ปกครอง ค่าเริ่มต้นให้คนแปลกหน้าที่อยู่เซิร์ฟเวอร์เดียวกันส่ง DM และคำขอเป็นเพื่อนหาเด็ก 15 ปีได้ทันที ช่องจำกัดอายุผ่านได้ด้วยการกด "ดำเนินการต่อ" ครั้งเดียว
- คะแนนความไว้วางใจเฉลี่ยอยู่ที่ประมาณ 4/10 สิ่งที่ควรแก้ก่อนคือข้อ S1 ทั้ง 5 ข้อด้านล่าง

---

**Method.** The scenario is `scripts/ux/safety-privacy.mjs`. It runs against `node server.js` on :7050 with `SERVE_STATIC=1`, a throwaway `DB_PATH`/`STORAGE_ROOT`, `ALLOW_DEV_IDENTITY=0` and a raised `RATE_LIMIT_REGISTER_PER_HOUR`. The browser is Chromium 141 (Playwright), and each persona gets its own context and locale. A second or third context plays the harasser, the alt account or the stranger. Screenshots are in `…/scratchpad/shots/persona-safety-privacy-*.png`. Server-side claims were confirmed with direct API calls and by reading the code. Time and click counts come from the script. They measure a bot that knows the target, so a real first-time user would take roughly 3–10× longer.

## Personas

| | Mai | Alex | Fatima |
|---|---|---|---|
| Age / gender | 24, woman | 31, trans woman | 42, woman (parent of a 15-year-old) |
| Occupation | Thai Twitch/TikTok streamer, ~8k followers | Backend developer, Berlin | Office admin, Surabaya |
| Tech literacy | High on phone and streaming tools, low on settings | Very high, reads privacy policies | Low to medium |
| Device | Laptop 1366×768, dark theme | Laptop 1366×768, light OS, keyboard-first, password manager with passkeys | Samsung A12-class Android at 360×740, 4× CPU throttle, Fast 3G |
| Language | Thai (th) | German (de) | Indonesian (id) |
| Apps used | LINE, TikTok, Discord, IG | Signal, Matrix, Discord, GitHub | WhatsApp, Instagram, Roblox (the son) |
| Accessibility | none | Keyboard navigation, screen reader sometimes | Presbyopia, needs large tap targets |
| Goal | Stop a stalker-ish "fan" without him knowing her status, and stay safe on stream | Control exactly who sees her pronouns and bio, lock down the account, export and delete data | Decide whether her son may use this instead of Discord |

## Task results

| # | Persona | Task | Success | Time | Clicks | Worst issue |
|---|---|---|---|---|---|---|
| 1 | Mai | Register (Thai) | ✅ | 4.9s | 2 | – |
| 2 | Mai | Notice and open the abusive DM | ✅ | 2.4s | 2 | S2: no message-request gate or "not a friend" warning |
| 3 | Mai | Report the threatening message | ⚠️ looks fine but goes nowhere | 3.0s | 3 | **S1**: DM reports go nowhere, and the copy says "server moderators" |
| 4 | Mai | Block the harasser | ✅ | 5.4s | 3 | S2: Block is an unlabelled shield icon inside the profile; nothing in the DM header |
| 5 | (harasser) | After the block | – | – | – | S2: error codes let the harasser tell a block from a privacy setting |
| 6 | Mai | Find the blocked list again | ✅ | 0.4s | 3 | – |
| 7 | Mai | DMs friends-only, friend requests nobody | ✅ | 3.7s | 4 | S3: two DM controls that overlap; no "saved" feedback |
| 8 | Mai | Filter message requests | ❌ | – | – | S2: the feature does not exist |
| 9 | Mai | Streamer mode | ✅ | 1.6s | 3 | S2: no on-screen indicator; hides almost nothing; clicking the row label does nothing |
| 10 | (alt) | Block evasion with a new account | blocked ✅ | – | – | S3: public @mentions still get through |
| 11 | Mai | Appear offline | ⚠️ leaks | 2.2s | 2 | **S1**: `invisible` is sent to every member |
| 12 | Mai | Delete her own message | ✅ | 2.5s | 3 | – |
| 13 | Alex | Register (German) | ✅ | 3.7s | 2 | – |
| 14 | Alex | Pronouns and bio; username vs display name | ✅ | 3.8s | 2 | S3: no username field and no explanation |
| 15 | Alex | Profile visibility → friends only | ✅ in UI | 2.1s | 2 | **S1**: bio and pronouns still leak through the member list and the server-profile API |
| 16 | Alex | Revoke an unknown device | ❌ (revoked device is bricked) | 36s | 2 | **S1**: a stale cookie turns the whole site, `/api/auth/login` included, into JSON 401 |
| 17 | Alex | Enable 2FA | ✅ | 3.3s | 2 | S2: no re-auth; recovery codes are shown once with only a tiny "copy" link |
| 18 | Alex | Add a passkey | ❌ | – | – | S2: `PasskeysSection.jsx` is never rendered |
| 19 | Alex | Download my data | ✅ | 3.2s | 1 | S3: no IP/session detail; delete sits right next to export |
| 20 | Alex | Delete account | ✅ | 11.7s | 3 | S3: button says "Click again to delete", no grace period, messages kept |
| 21 | Fatima | Cold start and sign-up on 3G | ✅ | 13.3s (6.7s to form) | 2 | S2: no age or DOB, no ToS |
| 22 | Fatima | Find a teen or parental safety setting | ❌ (none exists) | 6.1s | 2 | **S1** for a parent: no age model at all |
| 23 | Fatima | Can a stranger DM or friend a 15-year-old? | Yes, HTTP 200 | – | – | S2: permissive defaults |
| 24 | Fatima | Age-restricted channel | 1 tap to enter | 8s | 3 | S2: self-attestation only; no 18+ marker in the sidebar |
| 25 | Fatima | Report a DM on the phone | ✅ | 10.3s | 8 | S2: 8 taps; long-press has no Report; no status feedback |

Safety features reachable in 3 clicks or fewer: block (3), privacy tab (2), status (2) and streamer mode (3) pass. Report takes 3 on desktop but 8 on mobile, and "message requests" and "family centre" do not exist.

## Ranked issues

### S1: blockers

**1. Revoked or expired sessions lock the device out of the entire site.**
- **What happened:** Alex revoked her phone's session. On reload the phone showed `{"error":"Your session has expired or is invalid","code":"INVALID_SESSION"}` instead of the login screen. `POST /api/auth/login` with that cookie also returns 401, so the device cannot recover until the user clears cookies by hand. This was reproduced with curl.
- **Screenshot:** `persona-safety-privacy-alex-10-revoked-device.png`
- **Who it affects:** everyone after a password change ("signs out your other devices"), "sign out everywhere", or a session revoke. It hits hardest for a victim who revokes an abuser's device and then uses that device again.
- **Root cause:** `lib/httpUtils.js` `makeIdentify` calls `next(new ApiError(… INVALID_SESSION))` for every path whenever an unresolvable token is present.
- **Fix:** in `makeIdentify`, on an unresolvable token, set `res.append('Set-Cookie', clearedCookie())` and continue anonymously (`req.userId = null; return next()`). Keep the 401 only for `/api/*` routes behind `requireUser`, and always let `/api/auth/login|register` through. On the client (`src/api` 401 handler), route to `LoginScreen` with the existing "you were signed out because this session ended" banner.

**2. DM reports are unreviewable, and the dialog misleads.**
- **What happened:** Mai and Fatima both reported DMs. The dialog says "ผู้ดูแลเซิร์ฟเวอร์นี้จะเห็น…" / "Moderator server ini akan dapat meninjau…", but in a DM `createReport` stores `server_id = NULL`. `GET /api/reports` and `PATCH` then require `ADMIN_TOKEN`, and no admin UI exists, so nobody ever sees the report. The reason is hard-coded to `'other'` (`App.jsx` `handleReportMessage`). The reporter gets no confirmation ID and no status, and `GET /api/reports` returns 403 for them.
- **Screenshots:** `mai-08-report-dialog.png`, `fatima-15-report-mobile.png`
- **Who it affects:** harassment victims and parents, which makes this the product's core trust promise.
- **Fix:**
  - (a) In `src/App.jsx` `handleReportMessage`, pick copy by context. In DMs use `chat.reportBodyDm` = "This goes to the administrators of this Antigravity instance, not to anyone in the conversation. They will not be told who reported."
  - (b) Replace the free-text-only field in `ConfirmModal` with a reason radio list (`spam, harassment, self_harm, nsfw, illegal, impersonation, other`, which already exist in `services/reports.js` `REASONS`). Add an optional details box and an **"Also block @name"** checkbox, checked by default.
  - (c) Add an instance-admin "Reports" page, or route `server_id NULL` reports to the owner of the instance's first server, so that DM reports are actionable.
  - (d) Add a "My reports" list (status open/resolved) under Privacy & Safety.

**3. "Invisible" status leaks to every server member.**
- **What happened:** after Mai chose ซ่อนตัว ("others will see you as offline"), the harasser's `GET /api/servers/:id/members` returned `status: "invisible"` for her.
- **Screenshot:** `mai-24-status-menu.png`
- **Who it affects:** anyone hiding from a stalker. Being seen as "invisible" is worse than being seen online.
- **Root cause:** `services/guildAdmin.js` `listMembers` and `services/guilds.js` (~line 251, server `memberRows`) select `u.status` raw. Only `services/users.js:78` and `server.js:335/374` mask it.
- **Fix:** add one helper, `publicStatus(status, viewerId, userId)`, in `lib/presence.js` and apply it in every member and presence serializer (`guildAdmin.listMembers`, the `guilds.js` server payload, search results).

**4. Profile visibility "Friends only" does not hide bio or pronouns.**
- **What happened:** Alex set **Nur Freunde**. The profile modal shows "This person keeps their profile private." (good), but the stranger still sees her bio as the subtitle in the member list. `GET /api/servers/:id/profile/:alexId` also returns `effective.bio` and `effective.pronouns: "sie/ihr"`.
- **Screenshot:** `alex-07-stranger-sees-profile.png` (member list, top right)
- **Who it affects:** trans and queer users who share pronouns only with friends, and anyone hiding personal details.
- **Root cause:** `services/guilds.js` member rows include `u.bio`. `MemberList.jsx:159` renders `member.custom_status || member.bio`. `guildAdmin.getGuildProfile` ignores `profile_visibility`.
- **Fix:** drop `u.bio` from member payloads. `MemberList.jsx` should show `custom_status` only. `getGuildProfile` should apply the same visibility check as `users.js` getProfile and null out `bio`, `pronouns` and `banner` for non-permitted viewers. Add a "Preview as: Everyone / Server member / Friend" toggle to the preview card in `settings/ProfileTab.jsx`.

**5. Nothing protects minors.**
- **What happened:** sign-up asks no DOB and shows no ToS or minimum age (`fatima-02-signup-form.png`). No teen defaults exist. Settings search for "anak", "usia", "keluarga", "orang tua" and "sensitif" returns nothing (`fatima-05-search-anak.png`). With the defaults, a stranger in a shared "Free Robux" server can DM and friend-request a 15-year-old (both HTTP 200, `fatima-09-kid-gets-dm-notice.png`). The age-restricted channel opens after one "Lanjutkan" tap (`fatima-11/12`).
- **Fix:**
  - `LoginScreen.jsx`: add a date-of-birth field with a 13+ minimum and a ToS / community-guidelines link.
  - `services/userSettings.js`: when the user is under 18, default `allowDmsFrom:'friends'`, `friendRequests:'friends_of_friends'` and `dmScanning:'everyone'`.
  - `ChannelGate.jsx`: refuse entry for under-18 accounts instead of showing "Continue".
  - Add an 18+ badge to NSFW channels in `ChannelSidebar.jsx`.
  - Add a "Family Centre / Teen safety" section to `PrivacyTab.jsx`, with keywords in `settings.kwPrivacy`: anak/usia/keluarga/Kind/Alter/เด็ก/อายุ.

### S2: major

**6. No message-request inbox.**
- **What happened:** stranger DMs land in the main DM list with the full text visible, the same as a friend's (`mai-05-dm-open.png`). Discord, Instagram and Messenger all quarantine these.
- **Fix:** in `HomeDirectMessages.jsx`, add a "Message requests (n)" row above the DM list. DMs from non-friends go there with previews blurred, and each has **Accept / Ignore / Block & report** buttons. Add a toggle in `PrivacyTab.jsx`: "Filter message requests from people who aren't friends".

**7. Block is hard to find and has side effects.**
- **What happened:** the DM header has no block or profile menu (`mai-10-dm-header.png`). Block exists only as an unlabelled 🛡 icon, with only a `title`, in `UserProfileModal.jsx:185`, next to a large green **ยอมรับ / Terima** ("accept friend") button (`mai-11-profile-popout.png`, `fatima-14-long-press.png`). The confirmation ("they can't message you and you won't see their messages") does not say that they are not notified, that they can still see her messages in shared servers, or that she should report first. After blocking, the composer stays active and the DM stays pinned, still showing their green online dot (`mai-13b-after-block-dm.png`).
- **Fix:**
  - `UserProfileModal.jsx`: turn the shield into a labelled "Block" item inside a "⋯" menu, together with "Report user" (target_type `user` already exists server-side). Demote Accept to a secondary style when the requester is not a mutual friend.
  - `ChatArea` DM header: add a "⋯" button with Block, Report and Close DM.
  - Copy `dm.blockBody`: "They won't be notified. They can't DM you or send friend requests. In servers you share, they can still see your messages. Report first if you're in danger."
  - After blocking, replace the composer with "You blocked this user · Unblock" and group the collapsed rows as "5 blocked messages · Show".

**8. The harasser can tell he is blocked.**
- **What happened:** after the block, the harasser gets `403 "Cannot send a request to this user"` or `"Cannot message this user"`. The alt account gets `"This user is not accepting friend requests"` or `"…only accepts direct messages from friends"`. Comparing the two confirms the block. The harasser's UI also shows "You do not have permission to do that · Retry" (`mai-14-creep-after-block.png`).
- **Fix:** in `services/users.js` `sendFriendRequest` and `assertCanDirectMessage`, and `services/access.js`, return one generic code for all refusal reasons (`USER_UNREACHABLE`, "This person isn't accepting messages from you right now."), and drop "Retry" for 403s in the composer's failed-send UI.

**9. Streamer mode is almost cosmetic.**
- **What happened:** enabling it hides only the email/IP in Account and the invite link in InviteModal (`App.jsx:2578`, `AccountSecurityTab.jsx:19`). There is no persistent "STREAMER MODE" banner (`mai-22b`/`22c`). Usernames, the #discriminator, DM names and friend-request toasts ("fan4ever ส่งคำขอเป็นเพื่อน") all stay on screen. Clicking the row title "เปิดโหมดสตรีมเมอร์" does not toggle it. Only the 40px switch works (`mai-22-streamer-on.png`).
- **Fix:** add a red top-of-app banner "Streamer mode on · Turn off" in `App.jsx`. While active, mask the `#discriminator`, the DM list names and toast bodies ("New message"), and hide the Notes field. In `settings/primitives.jsx` `SettingToggle`, make the whole `Row` a `<label>` or clickable.

**10. Passkeys are built but unreachable.**
- **What happened:** `PasskeysSection.jsx`, `src/auth/passkeys.js` and `routes/passkeys.js` all exist, but nothing imports the section, and LoginScreen has no "Sign in with a passkey" button. Settings search for "Passkey" returns nothing (`alex-13-search-passkey.png`). Passkey strings are also missing in de and id: 26 `passkeys.*` keys in each.
- **Fix:** render `<PasskeysSection/>` in `AccountSecurityTab.jsx` after Two-factor. Add a `passkeys.signIn` button plus conditional mediation in `LoginScreen.jsx`. Translate `passkeys.*` in `locales/de.js` and `id.js`.

**11. Session list is unreadable, and "Abmelden" is ambiguous.**
- **What happened:** each device shows the raw user agent (`Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 …`) plus `127.0.0.1`. The per-device revoke button and the app's sign-out button share the accessible name **Abmelden**, which is 2 identical buttons for a screen reader. Revoke is instant, with no confirmation or toast (`alex-08-sessions.png`).
- **Fix:** in `AccountSecurityTab.jsx`, parse the UA into "Chrome on Android · Pixel 7", show a coarse location or "same network as this device", and set `aria-label={t('security.revokeDevice',{device})}`. Show a toast: "Pixel 7 signed out."

**12. 2FA hygiene.**
- **What happened:** "Enable two-factor" needs no password, so an attacker with a stolen session can lock out the owner. Recovery codes appear once with only a tiny **Kopieren** link, and the destructive **Deaktivieren** form is rendered directly underneath (`alex-11`, `alex-12`).
- **Fix:** require the current password in `/auth/mfa/begin` and the enrolment form. Add "Download .txt" and "I have saved these codes" buttons, and hide the disable form until the codes are dismissed.

**13. Reporting on mobile takes 8 taps.**
- **What happened:** long-press opens only the reaction bar (❤️🔥👍), and Report sits behind "⋯" (`fatima-14b-tap-message.png`). The bar also covers the author name and time.
- **Fix:** add "Report" and "Block" to the long-press action sheet in `ChatArea.jsx` (~line 1207). For DMs from non-friends, hide the quick-reaction emojis and show a "Report / Block" safety bar above the first message.

### S3: minor

14. **Label collisions in translation.** "Konto & Sicherheit" vs "Privatsphäre & Sicherheit", "Akun & keamanan" vs "Privasi & Keamanan", and "บัญชีและความปลอดภัย" vs "ความเป็นส่วนตัวและความปลอดภัย" read as the same thing. Rename `settings.accountTab` to "Konto & Anmeldung", "Akun & login" and "บัญชีและการเข้าสู่ระบบ".
15. **Overlapping DM controls.** "Who can DM you: Friends only" and the "Allow messages from server members" toggle do the same thing (`services/users.js:348-353`). Remove the toggle from `PrivacyTab.jsx` or fold it into a third radio option. Privacy changes save silently, so add a "Saved" toast.
16. **Repeated labels on the privacy page.** "Friends only" and "Everyone" repeat across three radio groups on one long page (`mai-18/19`). Add sticky section headers, or a one-line summary at the top ("Right now: anyone in your servers can DM you").
17. **Username vs display name.** No username field and no copy explain which name is the unique handle. Add a helper under Display name in `ProfileTab.jsx`: "Shown to others. Your username @alex_dev is unique and is how people add you."
18. **Delete-account flow.** The copy "Erneut klicken, um endgültig zu löschen" sits on a submit button that needs a password. There is no deactivate option and no 14-day grace period, and there is no choice to delete messages. The delete button sits right next to "Meine Daten herunterladen" (`alex-18-delete-form.png`). Fix: move deletion to a separate "Danger zone", relabel the button "Delete account permanently", and offer "Export first".
19. **Untranslated channel categories.** Default category names "TEXT CHANNELS" / "VOICE CHANNELS" appear in English in id and th (`fatima-09`).
20. **Composer placeholder.** "Kirim pesan ke @gamer_bro_…" wraps and is clipped at 360px (`fatima-13`). Add `truncate` to the placeholder.
21. **Public mentions after blocking.** An alt account can still @mention Mai in public channels, and nothing warns of new accounts. Add an optional server-side setting: "Hide messages from accounts < 24h old in servers I own".

### S4: polish
22. The Thai privacy page renders well (no tofu, comfortable line height), but the 240px rail wraps "ความเป็นส่วนตัวและความปลอดภัย" onto two lines. That is acceptable, but add `title` tooltips.
23. The export filename `antigravity-export.json` has no date. Use `antigravity-export-YYYY-MM-DD.json`.

## What delighted them

- **Mai:** "บล็อกแล้วเซิร์ฟเวอร์ไม่ยอมให้มันทักมาจริง ๆ แม้มันสมัครแอคใหม่ก็ยังโดนปิด" ("Once I blocked him, the server really wouldn't let him message me, even when he made a new account.") Enforcement is server-side, and the page says so with the note that the rules hold even for a modified client. The Blocked tab is easy to find, and blocked messages collapse behind "แสดงอยู่ดี" ("show anyway").
- **Alex:** "Endlich ein Export, der sofort als Datei kommt, und Konto-Löschung mit Passwort + 2FA." ("Finally an export that arrives as a file right away, and account deletion with password + 2FA.") The unsaved-changes bar on Profile works, the QR code includes a manual key and an otpauth link, and "This person keeps their profile private." is honest wording.
- **Fatima:** "Ada peringatan sebelum masuk saluran dewasa, dan bahasa Indonesianya rapi." ("There's a warning before entering the adult channel, and the Indonesian is tidy.") Radio rows on the phone are big and easy to hit (≥64px).

## Scores (1–10)

| Persona | First impression | Ease of use | Visual appeal | Trust / safety | Would recommend |
|---|---|---|---|---|---|
| Mai | 7 | 6 | 7 | 4 | 5 |
| Alex | 7 | 6 | 7 | 3 | 4 |
| Fatima | 6 | 5 | 6 | 2 | 2 |

> Fatima: "Kalau orang asing bisa langsung DM anak saya dan tidak ada pengaturan umur, saya tidak akan izinkan. Discord saja minta tanggal lahir." ("If strangers can DM my child directly and there's no age setting, I won't allow it. Even Discord asks for a date of birth.")
> Alex: "Die UI verspricht ‚nur Freunde', aber die API liefert meine Pronomen an jeden. Das ist schlimmer als gar keine Einstellung." ("The UI promises 'friends only', but the API hands my pronouns to anyone. That's worse than having no setting at all.")
> Mai: "กดรายงานแล้วบอกว่า 'ส่งให้ผู้ดูแลแล้ว' แต่มันเป็น DM ไม่มีผู้ดูแล… แล้วใครอ่าน?" ("It says the report went to the moderators, but this is a DM with no moderators… so who reads it?")

## Comparison with Discord and other apps

- **Discord:** asks for a DOB at sign-up (13+) and has Message Requests, Family Center and Teen Safety Assist (blur plus safety alerts for teens). DM reports go to Trust & Safety, with category pickers and "block too". Its streamer mode shows a persistent banner. The block notice in a DM is "You blocked this user" and the composer is disabled.
- **LINE / Instagram / Messenger:** all quarantine non-friend messages into a request folder and offer Ignore / Block / Report as one tap on the request.
- **Signal:** message requests plus "Report spam & block" in one button, and the sender is not told they were blocked.
