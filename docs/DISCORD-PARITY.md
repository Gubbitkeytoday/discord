# Discord Feature Parity Inventory

Every user-facing Discord feature we could find, grouped by area and checked
against this codebase as of branch `claude/dreamy-goldberg-p3o5ao` (September 2026).
Each row says whether our version is wired end-to-end: UI, API, service,
database and enforcement.

Legend: ✅ implemented and wired end-to-end · 🟡 partial (UI-only, backend-only,
stored but not enforced, or missing sub-options; the Gap column says which) ·
❌ missing · 🚫 intentionally out of scope (Nitro, billing, native-only, or
depends on a proprietary Discord service).

> **How the Discord side was checked.** From this build environment,
> `discord.com`, `support.discord.com` and `docs.discord.com` are blocked by the
> egress proxy. Two sources were used instead:
> 1. **Developer-API enums** (permissions, audit-log events, AutoMod, channel,
>    message and component types) come from the `discord-api-types@0.38.55`
>    npm package. It is generated from the official
>    [discord-api-docs](https://github.com/discord/discord-api-docs), so it
>    tracks what [discord.com/developers/docs](https://discord.com/developers/docs/intro)
>    publishes.
> 2. **Client behaviour** comes from support.discord.com articles located
>    through web search; each section links the articles it relies on.
>    Where an article could only be read through search snippets, we say so.
>
> **How our side was checked.** By reading the code: `db/schema.sql` together
> with the migrations in `db.js`, `server.js` routes, `services/*`, `realtime.js`,
> `lib/permissions.js`, `src/components/**` and `services/userSettings.js`
> (`SETTING_DEFAULTS`). A setting marked ✅ is both persisted and applied. One
> that is only saved is marked 🟡.

---

## สรุปภาษาไทย

**ภาพรวม:** เราตรวจฟีเจอร์ของ Discord ทั้งหมด **385 รายการ** ใน 9 หมวดหลัก แล้วเทียบกับโค้ดของโปรเจกต์นี้ ผลเป็นดังนี้

| สถานะ | จำนวน | สัดส่วน |
|---|---:|---:|
| ✅ ทำแล้ว ใช้งานได้ครบทั้งระบบ | 185 | 48% |
| 🟡 ทำไปบางส่วน (มี UI แต่ไม่มี backend หรือกลับกัน / บันทึกค่าได้แต่ยังไม่บังคับใช้) | 81 | 21% |
| ❌ ยังไม่มี | 93 | 24% |
| 🚫 ตั้งใจไม่ทำ (Nitro, การชำระเงิน, บริการเฉพาะของ Discord, แอป native) | 26 | 7% |

**จุดแข็ง (ทำได้ใกล้ Discord มากแล้ว):** ข้อความ (markdown ครบ, แก้ไขพร้อมประวัติ, reply, pin, reaction, poll, ข้อความเสียง, sticker, forward แบบพื้นฐาน),
เธรด/ฟอรัม/media channel, AutoMod พื้นฐาน, raid protection, onboarding + rules screening + welcome screen, audit log,
การตั้งค่าผู้ใช้เกือบทุกหน้า (Appearance, Accessibility, Voice & Video, Chat, Keybinds ที่แก้ได้, Streamer Mode, Privacy ที่บังคับใช้ฝั่ง server),
2FA (TOTP), รายการอุปกรณ์ที่ล็อกอิน, export/ลบบัญชี, bot + slash command + context menu + ปุ่ม/select menu, webhook, การติดตาม announcement channel, template, insights, widget

**ช่องโหว่สำคัญที่เจอ (ควรแก้ก่อน):**
1. **ระดับการแจ้งเตือนไม่ถูกบังคับใช้:** ตั้งค่า "ทุกข้อความ / เฉพาะ @mention / ไม่มีเลย" และค่าเริ่มต้นของเซิร์ฟเวอร์ได้ แต่ฝั่ง server สร้างการแจ้งเตือนเฉพาะตอนถูก mention และไม่ดูระดับที่ตั้งไว้เลย
   ส่วน "ปิด @everyone" และ "ปิด role mention" มีคอลัมน์ในฐานข้อมูลแล้วแต่ไม่มี UI และไม่มีการบังคับใช้ ส่วนการ mute เซิร์ฟเวอร์ไม่ดูเวลาหมดอายุ (`muted_until`)
2. **สิทธิ์หลายตัวมีในรายการแต่ไม่ถูกตรวจ:** SPEAK, STREAM, USE_VAD, PRIORITY_SPEAKER, SEND_TTS_MESSAGES, EMBED_LINKS, VIEW_GUILD_INSIGHTS, MOVE_MEMBERS, DEAFEN_MEMBERS
   และยังไม่มีสิทธิ์ใหม่ของ Discord อีก 16 ตัว (bit 31–52; บิต 41 เป็นเรื่อง monetization จึงไม่ทำ) เช่น **PIN_MESSAGES** และ **BYPASS_SLOWMODE** ที่ Discord บังคับใช้ตั้งแต่ 23 ก.พ. 2026, SEND_POLLS, SEND_VOICE_MESSAGES, USE_SOUNDBOARD, CREATE_EVENTS
3. **AutoMod:** action "alert" เลือกได้แต่ไม่มีผล (ไม่มีช่องแจ้งเตือน) และยังไม่มี keyword preset, allow list, กฎตรวจชื่อ/โปรไฟล์สมาชิก, mention-raid protection
4. **Explicit content filter:** เก็บค่าไว้ แต่ไม่มี UI และไม่มีการสแกนจริง
5. **ห้องเสียง:** ผู้ดูแลยัง server-mute, deafen, ย้าย หรือเตะคนออกจากห้องเสียงไม่ได้ (ทำได้เฉพาะใน stage) ยังไม่มีการตั้ง bitrate, region, video quality, voice status และยังไม่มี stage topic หรือ stage instance
6. **Private thread, message request, การค้นหาด้วย author type, @silent, suppress embeds, alt text ของไฟล์แนบ (มีคอลัมน์แล้วแต่ไม่มี UI), การเปิด/ปิด ping ตอน reply, recurring events, Server Guide, default channels** ยังไม่มีทั้งหมด
7. **ภาษา:** มีแค่ไทยกับอังกฤษ (Discord มี 31 ภาษา) และเปลี่ยน username หรืออีเมลเองไม่ได้

**แผนงาน:** มี backlog 30 รายการที่ท้ายเอกสาร แบ่งเป็น 9 ชุด (B1–B9) ให้วิศวกรทำพร้อมกันได้โดยไม่แก้ไฟล์เดียวกัน
แต่ต้องทำ **B0 (งานเตรียมเล็ก ๆ)** ก่อน: แยกไฟล์ i18n และ migration เป็นส่วนย่อย, ให้ route ถูก mount อัตโนมัติ,
ดึงโค้ดส่วนแจ้งเตือนออกจาก `services/messages.js` และเพิ่ม permission flag ใหม่ทั้งหมดใน `lib/permissions.js`

---

## Totals by area

| # | Area | ✅ | 🟡 | ❌ | 🚫 |
|---|---|---:|---:|---:|---:|
| 1 | User Settings: account, profile, privacy, data | 15 | 6 | 10 | 5 |
| 2 | User Settings: app settings | 39 | 7 | 9 | 6 |
| 3 | Server Settings pages | 14 | 13 | 6 | 3 |
| 4 | Channels (all types), threads, DMs | 18 | 9 | 10 | 2 |
| 5 | Messages (format, compose, reactions, polls, search) | 31 | 10 | 9 | 0 |
| 6 | Notifications | 5 | 7 | 5 | 2 |
| 7 | Moderation, safety, audit log | 15 | 11 | 12 | 1 |
| 8 | Roles and permissions (incl. every flag) | 30 | 13 | 18 | 3 |
| 9 | Community, onboarding, events, voice, stage, apps | 18 | 5 | 14 | 4 |
| | **Total (385)** | **185** | **81** | **93** | **26** |

(The permission-flag table in §8 counts every flag as its own row.)

---

## 1. User Settings: User settings (account, profile, content & social, data)

Sources: [Per-Server Profiles](https://support.discord.com/hc/en-us/articles/4409388345495-Per-Server-Profiles), [Custom Profiles](https://support.discord.com/hc/en-us/articles/4403147417623-Custom-Profiles), [New Usernames & Display Names](https://support.discord.com/hc/en-us/articles/12620128861463-New-Usernames-Display-Names), [Message Requests](https://support.discord.com/hc/en-us/articles/7924992471191-Message-Requests), [Sensitive Content Filters](https://support.discord.com/hc/en-us/articles/18210995019671-Discord-Sensitive-Content-Filters), [Safer Messaging](https://support.discord.com/hc/en-us/articles/115000068672-Safer-Messaging-on-Discord), [Family Center](https://support.discord.com/hc/en-us/articles/14155039712407-What-is-Family-Center), [Nameplates](https://support.discord.com/hc/en-us/articles/30408457944215-Nameplates-FAQ), [Server Tags](https://support.discord.com/hc/en-us/articles/31444248479639-Server-Tags), [Display Name Styles](https://support.discord.com/hc/en-us/articles/33833879643927-Discord-Display-Name-Styles-FAQ), [Shop FAQ](https://support.discord.com/hc/en-us/articles/17162747936663-Shop-FAQ).

### 1a. My Account

| Feature | Discord behaviour | Status | Our files | Gap / next step |
|---|---|---|---|---|
| View username / email | Account card with reveal toggle | ✅ | `settings/AccountSecurityTab.jsx` | — |
| Change username | Unique `@username`, rate-limited changes | ❌ | `services/users.js` (`updateProfile` has no `username` in `writable`) | Add `POST /api/users/@me/username` with a uniqueness check, a cooldown and an audit trail |
| Change email (re-verify) | Needs password + code to old and new address | ❌ | `routes/auth.js` | Two-step change flow through `lib/mailer.js` |
| Verify email | Send / resend verification | ✅ | `routes/auth.js` `/auth/verify-email*`, `AccountSecurityTab.jsx` | — |
| Change password | Current + new | ✅ | `routes/auth.js` `/auth/change-password` | — |
| 2FA authenticator app (TOTP) | Enable/disable, backup codes | ✅ | `routes/accountSecurity.js`, `lib/totp.js`, `services/accountSecurity.js` | — |
| Regenerate backup codes | "View backup codes" re-issues a set | 🟡 | `services/accountSecurity.js` | Codes are shown once at enrolment; add a regenerate button |
| SMS 2FA / phone number | Add phone, SMS backup | 🚫 | — | Needs a paid SMS provider; self-host keeps TOTP |
| Security keys / passkeys (WebAuthn) | Register keys, passwordless login | ❌ | — | Add WebAuthn as a second factor (`@simplewebauthn/server`) |
| Disable account | Reversible deactivation | ❌ | `services/dataRights.js` | Add `users.disabled_at`: log in to re-enable |
| Delete account | Permanent, blocked while owning servers | ✅ | `DELETE /api/users/@me`, `services/dataRights.js` (`OWNS_SERVERS`) | — |
| Devices / sessions | List devices, log out one or all | ✅ | `routes/auth.js` `/auth/sessions`, `/auth/logout-all` | — |

### 1b. Profiles

| Feature | Discord behaviour | Status | Our files | Gap / next step |
|---|---|---|---|---|
| Display name, avatar, banner, accent colour, bio, pronouns | Global profile editor with preview | ✅ | `settings/ProfileTab.jsx`, `services/users.js`, `routes/files.js` `/upload/avatar`,`/upload/banner` | — |
| Per-server profile (nick, avatar, banner, bio, pronouns) | "Server Profiles" tab | 🟡 | `PATCH /api/servers/:id/profile/@me`, `services/guildAdmin.js` `setGuildProfile`, `UserProfileModal.jsx` | API and read path exist; `ProfileTab.jsx` has no per-server editor. Add a server picker to the Profile tab |
| Profile visibility (who sees bio/banner) | Not in Discord (bio is always public) | ✅ | `PrivacyTab.jsx`, `users.profile_visibility` | Extension of ours, enforced in `services/users.js` |
| Avatar decorations, profile effects, nameplates, profile themes | Shop/Nitro cosmetics | 🚫 | — | Paid cosmetics |
| Display-name styles (fonts/gradients) | Nitro (2025) | 🚫 | — | Nitro |
| Server Tag (4-char guild tag beside name) | Needs 3 boosts; member adopts tag (2025) | ❌ | — | Could ship without boosts: `servers.tag` plus `users.primary_guild_id`, rendered next to the name |
| Custom status with emoji and "clear after" | Text + emoji + expiry (30m/1h/4h/today/never) | 🟡 | `UserStatusMenu.jsx`, `users.custom_status(_emoji)` | No expiry. Add `custom_status_expires_at` and a sweep |
| Presence: online / idle / DND / invisible | Manual + auto-idle | ✅ | `UserStatusMenu.jsx`, `PATCH /api/users/:id/presence`, `realtime.js` | — |
| Private notes on users | Note field in profile | ✅ | `PUT /api/users/:id/note`, `user_notes` | — |

### 1c. Content & Social (formerly Privacy & Safety)

| Feature | Discord behaviour | Status | Our files | Gap / next step |
|---|---|---|---|---|
| DM spam / explicit-media filter | Filter all / non-friends / off | 🟡 | `PrivacyTab.jsx` (`privacy.dmScanning`), `ChatArea.jsx` L175 | Applied only on the client (blur by sender type); there is no media classifier. The spam part is missing |
| Sensitive media filters (show/blur/block) × (friends DMs, other DMs, servers) | 2024–25 adult controls | ❌ | — | Needs a classifier (see §7 explicit filter). Offer "blur all media from non-friends" as a cheap first step |
| Allow DMs from server members (global + per-server) | Toggle, and per-server override | 🟡 | `services/users.js` L316-320, `PrivacyTab.jsx` | Global switch is enforced. The per-server override from the server-dropdown privacy settings is missing |
| Message requests | DMs from non-friends land in a Requests inbox (accept/ignore) | ❌ | `HomeDirectMessages.jsx` | Add `channel_recipients.request_state` and a Requests tab. Unknown senders go there instead of the DM list |
| Friend requests from: everyone / friends-of-friends / server members | Three toggles | ✅ | `services/users.js` L272-275, `PrivacyTab.jsx` | Discord has three independent toggles, we have a radio; close enough |
| Block user | Hide messages, block DMs and friend requests | ✅ | `POST/DELETE /api/blocks`, `ChatArea.jsx` "blocked message – show anyway" | — |
| Ignore user (2024) | Softer block: hide without notifying | ❌ | — | Add `ignores` table: suppress their notifications and collapse their messages |
| Age-restricted content opt-in | Age-gated servers/channels | ✅ | `ChannelGate.jsx` | Per-device gate, no age verification (matches our roadmap stance) |
| Family Center | Parent/teen activity dashboard | 🚫 | — | Out of scope for self-hosted communities |

### 1d. Data & Privacy, Authorized Apps, Connections, Billing

| Feature | Discord behaviour | Status | Our files | Gap / next step |
|---|---|---|---|---|
| Show current activity to others | Toggle | ✅ | `privacy.showCurrentActivity`, `ActivityTab.jsx` | — |
| Request all my data | ZIP export | ✅ | `GET /api/users/@me/export`, `services/dataRights.js` | — |
| Use data to improve / personalise | Analytics toggles | 🟡 | `privacy.allowAnalytics` | No analytics exist, so the toggle does nothing. Keep it hidden or document that |
| Authorized Apps (OAuth grants) | List and revoke | ❌ | — | No OAuth2 provider yet. It becomes relevant once B8 adds OAuth |
| Connections (Steam, GitHub, Spotify…) | Linked accounts shown on profile | ❌ | — | Low priority. A "verified link" (rel=me) list would be a cheap version |
| Nitro / Server Boost / Subscriptions / Gift inventory / Billing / Shop / Quests | Paid features | 🚫 | — | Out of scope (ROADMAP "don't do") |

---

## 2. User Settings: App settings

Sources: [Accessibility Settings Tab](https://support.discord.com/hc/en-us/articles/1500010454681-Accessibility-Settings-Tab), [Streamer Mode 101](https://support.discord.com/hc/en-us/articles/218485407-Streamer-Mode-101), [Keyboard Navigation FAQ](https://support.discord.com/hc/en-us/articles/1500000056121-Keyboard-Navigation-FAQ), [Commands, Shortcuts & Navigation Guide](https://support.discord.com/hc/en-us/articles/31232432266647-Discord-Commands-Shortcuts-and-Navigation-Guide), [Windows Hotkeys](https://support.discord.com/hc/en-us/articles/225977308--Windows-Discord-Hotkeys), [Voice, Video & Streaming Guide](https://support.discord.com/hc/en-us/articles/33030151293079-Discord-Voice-Video-Streaming-Guide), [Krisp FAQ](https://support.discord.com/hc/en-us/articles/360040843952-Krisp-FAQ), [Activity Sharing FAQ](https://support.discord.com/hc/en-us/articles/7931156448919-Activity-Sharing-on-Discord-FAQ). The language list comes from search-result snippets (31 locales).

### 2a. Appearance

| Feature | Discord behaviour | Status | Our files | Gap / next step |
|---|---|---|---|---|
| Theme: Light / Ash / Dark / Onyx / Sync with OS | 4 base themes + system | ✅ | `AppearanceTab.jsx`, `appearance.theme` | — |
| Nitro colour themes / custom app icons | Gradient themes | 🚫 | — | Nitro |
| Message display: Cozy / Compact | Toggle | ✅ | `appearance.messageDisplay` | — |
| Chat font scaling | 12–24 px | ✅ | `appearance.chatFontScale` | — |
| Space between message groups | 0–24 px | ✅ | `appearance.messageGroupSpacing` | — |
| Zoom level | 50–200 % | ✅ | `appearance.zoom` | — |
| UI density (compact / default / spacious) | 2024 redesign | ✅ | `appearance.uiDensity` | — |
| Show avatars in compact mode, "show send button" | Toggles | 🟡 | `appearance.showSendButton` | Send-button toggle exists. "Show avatars in compact mode" is missing |
| Sync appearance across clients | Toggle | ✅ | `appearance.syncAcrossDevices`, `services/userSettings.js` | — |

### 2b. Accessibility

| Feature | Discord behaviour | Status | Our files | Gap / next step |
|---|---|---|---|---|
| Saturation slider | 0–100 % | ✅ | `accessibility.saturation` | — |
| Apply saturation to custom colours | Toggle | ❌ | `AccessibilityTab.jsx` | Add toggle; apply filter to role colours |
| Contrast / high-contrast mode | Contrast slider (mobile), high contrast | ✅ | `accessibility.highContrast` | Boolean where Discord has a slider; acceptable |
| Sync with OS high-contrast | Windows HCM | 🟡 | `accessibility.forceColors` | Stored; no `forced-colors` media query wiring verified |
| Reduced motion (+ sync with computer) | Toggle + OS sync | 🟡 | `accessibility.reducedMotion` | No "sync with `prefers-reduced-motion`" option |
| Role colours: in names / next to names / hidden | 3-way | ✅ | `accessibility.roleColors` | — |
| Play animated emoji, autoplay GIFs, sticker animation | Toggles | ✅ | `accessibility.playAnimatedEmoji/autoplayGifs/stickerAnimation` | — |
| Always underline links | Toggle | ❌ | — | CSS class on `<html>` |
| Show role icons | Toggle | ❌ | — | Depends on role icons (§8) |
| Dyslexia-friendly font (OpenDyslexic, 2025) | Font choice | ❌ | — | Add a font-family option |
| Text-to-speech playback + rate | TTS toggle and speed | ✅ | `accessibility.ttsEnabled/ttsRate`, `utils/speech.js` | — |
| Keyboard focus ring / keyboard mode | Always-visible focus when navigating by keyboard | ✅ | `hooks/useFocusTrap.js`, `ContextMenu.jsx` | — |

### 2c. Voice & Video

| Feature | Discord behaviour | Status | Our files | Gap / next step |
|---|---|---|---|---|
| Input/output device, volumes | Device pickers, sliders | ✅ | `settings/VoiceSettings.jsx`, `hooks/useVoiceSettings.js` | Devices stay per device, as on Discord |
| Mic test + level meter | "Let's check" | ✅ | `VoiceSettings.jsx` | — |
| Input mode: Voice Activity / Push-to-Talk + release delay | Keybind and delay | ✅ | `voice.inputMode`, `voice.pushToTalkReleaseMs` | — |
| Automatic / manual sensitivity | Threshold slider | ✅ | `voice.automaticSensitivity/sensitivity` | — |
| Echo cancellation, noise suppression (Krisp), AGC | Toggles | ✅ | `voice.echoCancellation/noiseSuppression/autoGainControl` | Browser DSP, not Krisp (proprietary) |
| Attenuation (lower others while speaking/streaming) | Slider + toggles | 🟡 | `voice.attenuation*` | Stored; effect on mix not verified in `useVoicePeers.js` |
| Camera preview, background blur | Preview, blur/backgrounds | ✅ | `voice.blurCamera`, `VoiceSettings.jsx` | Custom backgrounds are Nitro 🚫 |
| Video resolution / FPS | Quality settings | ✅ | `voice.videoResolution/videoFrameRate` | — |
| Screen share with audio, quality | Go Live 720p/1080p/source | ✅ | `hooks/useVoiceMedia.js` | Higher quality tiers are Nitro-gated on Discord |
| Per-user volume / local mute | Right-click user → volume | ✅ | `VoiceRoom.jsx` (`antigravity.userVolumes`) | — |
| Soundboard volume | Slider | ✅ | `voice.soundboardVolume` | — |
| Silence / "mic not detected" warning | Warning toast | ✅ | `voice.silenceWarning` | — |
| QoS / H.264 / OpenH264 / subsystem (Advanced) | Desktop-only | 🚫 | — | Browser controls these |

### 2d. Chat

| Feature | Discord behaviour | Status | Our files | Gap / next step |
|---|---|---|---|---|
| Display images/videos inline, link previews, embeds | Toggles | ✅ | `chat.showImagePreviews/showLinkPreviews/showEmbeds/inlineAttachmentMedia` | — |
| Show emoji reactions | Toggle | ❌ | `ChatTab.jsx` | Add toggle |
| Convert emoticons to emoji | Toggle | ✅ | `chat.convertEmoticons` | — |
| Show spoiler content: on click / servers I moderate / always | 3-way | ✅ | `chat.renderSpoilers` | — |
| Sticker suggestions / emoji autocomplete | Toggles | 🟡 | `ComposerAutocomplete.jsx` | Autocomplete always on; no toggles |
| Show compose-box "text formatting" toolbar | Toggle | ✅ | `ChatArea.jsx` formatting toolbar, keybind `toggleFormatting` | — |
| Preview markdown while typing | Toggle | ❌ | — | Optional |
| 24-hour clock, timestamps | Toggle | ✅ | `chat.use24HourClock/showTimestamps` | — |
| Typing indicator (show own) | Toggle | ✅ | `chat.showTypingIndicator` | — |

### 2e. Notifications (app-level)

| Feature | Discord behaviour | Status | Our files | Gap / next step |
|---|---|---|---|---|
| Desktop notifications enable | Browser permission + toggle | ✅ | `NotificationsTab.jsx`, `utils/notifier.js` | — |
| Unread badge, taskbar flash | Toggles | ✅ | `notifications.unreadBadge`, `applyUnreadBadge` | Tab title only; taskbar flash is desktop-only |
| TTS notifications: all / current channel / never | 3-way | ✅ | `notifications.ttsMode` | — |
| Per-event sounds | ~15 sounds | ✅ | `notifications.sounds.*`, `utils/soundEffects.js` | — |
| Push notification inactive timeout / mobile push | Mobile push when desktop idle | ❌ | `push_tokens` table (unused) | See B1 (Web Push). `push_tokens` is only deleted in `dataRights.js` |
| Email notifications (missed messages, highlights) | Email categories | ❌ | `lib/mailer.js` | Optional digest email |

### 2f. Keybinds

| Feature | Discord behaviour | Status | Our files | Gap / next step |
|---|---|---|---|---|
| Custom keybinds list (add/remove/record) | Global keybinds (desktop) | ✅ | `KeybindsTab.jsx`, `hooks/useKeybinds.js`, `keybinds.*` (20 actions) | In-browser only, which is the platform limit |
| Default shortcuts (Ctrl+K switcher, Alt+↑/↓ channels, Ctrl+Alt+↑/↓ servers, Esc mark read, Shift+Esc server read, Ctrl+P pins, Ctrl+F search, Ctrl+E emoji, Ctrl+Shift+M/D mute/deafen) | Fixed list | ✅ | `services/userSettings.js` `keybinds` | — |
| Alt+Shift+↑/↓ unread channel, Ctrl+Shift+Alt+↑/↓ unread mention, Ctrl+I inbox, Ctrl+Shift+U upload, Ctrl+/ shortcut sheet, Ctrl+Shift+A collapse folder, Ctrl+Shift+T answer call, Ctrl+Enter decline | Discord defaults | ❌ | `hooks/useKeybinds.js` | Add these, plus a "Ctrl+/" cheat-sheet modal |
| Push-to-talk (priority), toggle overlay, toggle Go Live | Desktop global | 🚫 | — | Needs a native global hook |

### 2g. Language, Streamer Mode, Advanced, Activity

| Feature | Discord behaviour | Status | Our files | Gap / next step |
|---|---|---|---|---|
| Language picker | 31 locales | 🟡 | `src/i18n/index.jsx` (`th`, `en`) | 2 of 31. Add a community-translation workflow (Weblate) and JSON parts |
| Streamer Mode: enable, auto-enable, hide personal info, hide invite links, disable sounds, disable notifications | 6 toggles | ✅ | `StreamerModeTab.jsx`, `streamerMode.*`, `utils/notifier.js` | Auto-enable triggers on screen share, not on OBS/XSplit detection |
| Hide window from screen capture | Desktop | 🚫 | — | Native only |
| Developer Mode (Copy ID) | Toggle, then "Copy ID" in context menus | ✅ | `chat.developerMode`, `MessageContextMenu.jsx` `chat.copyId` | — |
| Application test mode | SKU testing | 🚫 | — | Billing |
| Hardware acceleration, open on startup, minimise to tray | Desktop | 🚫 | — | Browser |
| Activity privacy: share activity status, share with large servers | Toggles | ✅ | `activity.shareActivity`, `privacy.showCurrentActivity` | — |
| Registered games / game detection / overlay | Desktop process scan | 🟡 | `ActivityTab.jsx` (`customActivity`) | Manual "custom activity" instead; detection impossible in a browser |

---

## 3. Server Settings pages

Sources: [Verification Levels](https://support.discord.com/hc/en-us/articles/216679607-Verification-Levels), [Enabling Server Discovery](https://support.discord.com/hc/en-us/articles/360030843331-Enabling-Server-Discovery), [Community Welcome Screen](https://support.discord.com/hc/en-us/articles/360043913591-Community-Server-Welcome-Screen), [Rules Screening FAQ](https://support.discord.com/hc/en-us/articles/1500000466882-Rules-Screening-FAQ), [Server Setup Guide](https://support.discord.com/hc/en-us/articles/33023827550359-Discord-Server-Setup-Guide), [Soundboard Guide](https://support.discord.com/hc/en-us/articles/12612888127767-Discord-Soundboard-Guide-Using-Adding-and-Managing-Sounds), [Server Boosting FAQ](https://support.discord.com/hc/en-us/articles/360028038352-Server-Boosting-FAQ), [Server Subscriptions](https://support.discord.com/hc/en-us/articles/5371495812631-Server-Subscriptions-for-Creators-Server-Owners-Admins). Enum values (system channel flags, guild features, NSFW level, MFA level) come from `discord-api-types` `GuildSystemChannelFlags` / `GuildFeature`.

| Page / option | Discord behaviour | Status | Our files | Gap / next step |
|---|---|---|---|---|
| Overview: name, icon | Edit + upload | ✅ | `ServerSettingsModal.jsx` Overview, `/upload/server-icon`, `services/guildAdmin.js` `updateGuild` | — |
| Overview: description | Community | ✅ | same | — |
| Overview: banner, invite splash, discovery splash | Boost perks | 🟡 | `servers.banner_url`, `splash_url` | Columns exist. No upload route or UI. Add `/upload/server-banner` and a field |
| Overview: inactive (AFK) channel + timeout | Move idle users | ✅ | `realtime.js` L756-773 sweep, Overview fields | — |
| Overview: system messages channel | Channel select | ✅ | `system_channel_id` | — |
| System channel flags: join message, "wave" sticker replies, boost message, setup tips, role-sub purchase | 6 flags | ❌ | — | Add `servers.system_channel_flags`, and check it where the `join` system message is written |
| Overview: default notification settings | All / mentions only | 🟡 | `default_notifications`, Overview select | Stored and editable, but not used as the fallback when the member has no row (§6) |
| Overview: server "Community" toggle | Enables community features | ❌ | `servers.features` JSON (unused) | Features are always on. Gate announcement/discovery/welcome behind `COMMUNITY` |
| Server primary language / locale | Community | 🟡 | `servers.locale` | Column only; add a select |
| Roles page | See §8 | 🟡 | `ServerSettingsModal.jsx` Roles | See §8 |
| Emoji page: upload, delete, rename, limits per tier, uploader shown | Manage expressions | 🟡 | Emoji tab, `services/guildAdmin.js` `createEmoji/deleteEmoji` | No rename (no `EMOJI_UPDATE`), no per-server limit display |
| Stickers page | Upload PNG/APNG/GIF/Lottie, name, tag emoji, description | ✅ | Stickers tab, `/upload/sticker`, `stickers` | Editing is missing (`STICKER_UPDATE`); minor |
| Soundboard page | Upload ≤ 5 s / 512 KB, emoji, volume | ✅ | Soundboard tab, `soundboard_sounds`, `SoundboardPanel.jsx` | Edit of emoji/volume missing |
| Widget | Enable, invite channel, JSON/embed | ✅ | `InsightsTab.jsx`, `services/insights.js` `getWidget/updateWidget`, `/widget.json` | — |
| Server template | Create, sync, delete, use | ✅ | Overview template section, `services/templates.js` | — |
| Custom invite link (vanity URL) | Level 3 boost | ✅ | Overview vanity field, `services/guildAdmin.js` | — |
| Integrations page (bots, webhooks, followed channels, command permissions) | One hub | 🟡 | Webhooks tab, `GET /api/servers/:id/following`, bots via `DELETE /servers/:id/bots/:app` | No single page; no per-command permission overrides (§9) |
| App Directory | Browse/add apps | 🚫 | — | Discord service |
| Safety Setup: raid protection & CAPTCHA, DM/spam protection, verification level, explicit filter, 2FA-for-mods | One page | 🟡 | Verification in Overview, raid in `InsightsTab.jsx` | Split across pages. Explicit filter and mod-2FA have no UI (§7) |
| AutoMod page | See §7 | 🟡 | `AutoModTab.jsx` | See §7 |
| Audit Log page with filters (user, action) | Filters | 🟡 | Audit tab, `GET /api/servers/:id/audit-log` | List only. Add filters by user and action |
| Bans page: search, unban, bulk ban | Search; bulk ban up to 200 (2024) | 🟡 | Bans tab | No search, no bulk ban |
| Members page (2024): join method, invite code, account age, flags, role filter, prune | Rich table | 🟡 | Members tab (search, nick, roles, kick/ban/timeout, transfer) | No join method/invite tracking, no prune, no filters |
| Invites page | List, revoke, pause | ✅ | Invites tab, `services/guildAdmin.js` | "Pause invites" is §7 |
| Onboarding page | See §9 | 🟡 | `OnboardingTab.jsx` | See §9 |
| Server Insights | See §9 | ✅ | `InsightsTab.jsx` | — |
| Enable Discovery | Listing in Discover | ❌ | — | Instance-local directory (B6) |
| Server Boost status / Server Subscriptions / Server Shop / Creator monetisation | Paid | 🚫 | — | Out of scope |
| Delete server | Type name to confirm, MFA if required | ✅ | Danger zone, `DELETE /api/servers/:id` | — |
| Transfer ownership | Members context | ✅ | `POST /api/servers/:id/transfer-ownership` | — |
| Server Guide (2023) | Welcome sign, to-dos, resources | ❌ | — | See §9 |
| Reports page (ours) | Server-side reports queue | ✅ | Reports tab, `services/reports.js` | Discord reports go to T&S; ours is a bonus |
| Tag / Server Tag settings | 2025 | ❌ | — | See §1b |
| Enhanced role styles (gradient/holographic) | 2025, 3 boosts | 🟡 | `roles.color_secondary` | Backend and render path exist (`MemberList.jsx`). No editor in the Roles UI |
| Guild MFA requirement for moderation | Server setting | ❌ | — | `servers.mfa_level`; refuse ban/kick/delete from non-2FA mods |
| Premium progress bar | Boost bar toggle | 🚫 | — | Boosts |

---

## 4. Channels (text, voice, stage, forum, media, announcement, category) and threads

Sources: [Threads FAQ](https://support.discord.com/hc/en-us/articles/4403205878423-Threads-FAQ), [Forum Channels FAQ](https://support.discord.com/hc/en-us/articles/6208479917079-Forum-Channels-FAQ), [Stage Channels FAQ](https://support.discord.com/hc/en-us/articles/1500005513722-Stage-Channels-FAQ), [Slowmode FAQ](https://support.discord.com/hc/en-us/articles/360016150952-Slowmode-FAQ). Enums (`ChannelType` 0-16, `ChannelFlags`, `ThreadAutoArchiveDuration`, `SortOrderType`, `ForumLayoutType`, `VideoQualityMode`) come from `discord-api-types`.

| Feature | Discord behaviour | Status | Our files | Gap / next step |
|---|---|---|---|---|
| Channel types: text, voice, category, announcement, forum, stage | Types 0,2,4,5,13,15 | ✅ | `channels.type` CHECK, `CreateChannelModal.jsx` | — |
| Media channel (type 16) | Forum variant, gallery-first, hide download option | ✅ | `services/guilds.js` L387 (forum + `default_layout='gallery'`) | Stored as `forum`. The `HideMediaDownloadOptions` flag is missing |
| Directory channel (hub, type 14) | Student hubs | 🚫 | — | Discord service |
| Private channel toggle on create | Choose roles/members | 🟡 | `ChannelPermissionsTab.jsx` | Can be done after creation. No "private" switch in `CreateChannelModal.jsx` |
| Text: name, topic (1024), slowmode (0–6 h), age-restricted | Overview | ✅ | `ChannelSettingsModal.jsx`, `services/guilds.js` L461 | — |
| Text: "hide after inactivity" default thread archive | Overview | ❌ | `channels.auto_archive_duration` | Add select to the settings modal |
| Spoiler channel (ours) | — | ✅ | `channels.spoiler`, `ChannelGate.jsx` | Beyond Discord |
| Channel permissions tab (in channel settings) | Advanced overwrites per role/member, sync with category | 🟡 | `settings/ChannelPermissionsTab.jsx` (in Server Settings), `POST /channels/:id/permissions/sync` | Not reachable from Channel Settings. The sync endpoint has no button |
| Channel invites tab / integrations tab | Per-channel lists | ❌ | — | Reuse the server Invites/Webhooks lists filtered by channel |
| Clone channel | Context menu | ❌ | — | `POST /api/channels/:id/clone` copying overwrites |
| Reorder / move between categories (drag) | Drag and drop | ✅ | `PATCH /api/servers/:id/channels/order`, `ChannelSidebar.jsx` | — |
| Category: collapse, mute category, sync perms | Category settings | 🟡 | `channel_settings.collapsed` | Collapse works. Mute-category inheritance and sync button are missing |
| Voice: user limit (0–99) | Slider | 🟡 | `ChannelSettingsModal.jsx` (max 20) | Discord allows 99. Raise the max |
| Voice: bitrate (8–96 kbps, boosts up to 384) | Slider | 🟡 | `channels.bitrate`, allowed in PATCH | No UI, and the WebRTC sender does not apply it (`setParameters.maxBitrate`) |
| Voice: region override | Auto / region | 🚫 | `channels.rtc_region` | P2P mesh has no regions |
| Voice: video quality mode (auto/720p) | Setting | ❌ | `channels.video_quality_mode` | Column only |
| Voice: text chat in voice | Built-in chat | ✅ | `App.jsx` L472 | — |
| Voice channel status (2023, `SET_VOICE_CHANNEL_STATUS`) | Short status line under the channel | ❌ | — | Add `channels.status` and a realtime event |
| Voice: slowmode, age-restricted for text-in-voice | Settings | 🟡 | shared text fields | `ChannelSettingsModal.jsx` hides slowmode/NSFW for voice |
| Announcement: publish (crosspost), follow into other servers | Publish button, Follow | ✅ | `POST /messages/:id/crosspost`, `FollowChannelModal.jsx`, `services/following.js` | — |
| Announcement ⇄ text conversion | Toggle in overview | ❌ | — | Allow `type` change text↔announcement in the PATCH |
| Stage: audience/speakers, raise hand, invite to speak, move to audience | Stage controls | ✅ | `realtime.js` L338-441, `VoiceRoom.jsx` | — |
| Stage instance (topic, "start stage", privacy, notify @everyone) | `StageInstance` resource | ❌ | — | Add a `stage_instances` table, "Start Stage" dialog and system messages 27-31 |
| Forum: tags (≤20, emoji, moderated), require tag | Tag editor | ✅ | `services/forum.js`, `ForumView.jsx` | — |
| Forum: default sort, default layout, default reaction emoji | Defaults | ✅ | `default_sort_order`, `default_layout`, `default_reaction_emoji` | — |
| Forum: post guidelines | Topic shown on the new-post screen | 🟡 | `channels.topic` | Topic editable, but not shown in the composer |
| Forum: default slowmode for posts (`default_thread_rate_limit_per_user`) | Setting | ❌ | — | Add column + enforcement in `services/automod.js` |
| Forum: pin post, close/lock post, search, filter by tag, gallery | Post management | ✅ | `PUT /forum/posts/:id/pin`, `ForumView.jsx` | — |
| Threads: create from message or standalone, name, auto-archive 1h/24h/3d/1w | Create thread dialog | ✅ | `services/threads.js`, `POST /channels/:id/threads` | Auto-archive picker exists in API only |
| Threads: archive/unarchive, lock | Thread settings | ✅ | `PATCH /api/threads/:id`, `ChatArea.jsx` | — |
| Threads: join/leave, member list | Thread members | 🟡 | `POST /threads/:id/join`, `DELETE .../members/me` | No thread-member list UI, and no "add member" by @mention |
| Private threads (`CREATE_PRIVATE_THREADS`, invitable) | Invite-only threads | ❌ | `channels.invitable` (unused) | Add `private` flag to `createThread`, access check in `services/access.js` |
| Threads browser (active/archived list) | "Threads" button | ✅ | `GET /channels/:id/threads` | — |
| Thread slowmode, rename, delete | Settings | ✅ | `PATCH/DELETE /api/threads/:id` | — |
| Announcement threads (type 10) | Threads in announcement channels | 🟡 | `threads.js` accepts any parent | Works as a normal thread; not typed separately |
| DMs: 1:1, group DM ≤10, add/remove members, name, icon, owner transfer, leave | DM features | ✅ | `services/guilds.js`, `PUT/DELETE /dms/:id/recipients`, `CreateGroupDmModal.jsx` | Owner transfer not verified |
| DM / group calls (ring, decline, missed) | Calls | ✅ | `services/calls.js`, `CallPanel.jsx` | — |
| Close DM / hide from list | Close | ✅ | `DELETE /api/dms/:id`, `channel_recipients.closed` | — |
| Channel list: hide muted channels, show all channels, "Browse channels" | Opt-in channels | ❌ | — | See §9 onboarding |

---

## 5. Messages

Sources: [Markdown Text 101](https://support.discord.com/hc/en-us/articles/210298617-Markdown-Text-101-Chat-Formatting-Bold-Italic-Underline) (read through search snippets), [Using Search](https://support.discord.com/hc/en-us/articles/115000468588-Using-Search), [Reactions and Super Reactions FAQ](https://support.discord.com/hc/en-us/articles/12102061808663-Reactions-and-Super-Reactions-FAQ), [Polls FAQ](https://support.discord.com/hc/en-us/articles/22163184112407-Polls-FAQ), [Voice Messages](https://support.discord.com/hc/en-us/articles/13091096725527-Voice-Messages), [Message Forwarding](https://support.discord.com/hc/en-us/articles/24640649961367-Message-Forwarding), [Soundmoji FAQ](https://support.discord.com/hc/en-us/articles/27924658426135-Soundmoji-FAQ). `MessageFlags` (SuppressEmbeds=4, SuppressNotifications=4096, IsVoiceMessage=8192, HasSnapshot=16384, IsComponentsV2=32768), `MessageReferenceType.Forward=1` and `EmbedType` come from `discord-api-types`.

### 5a. Formatting and rendering

| Feature | Discord behaviour | Status | Our files | Gap / next step |
|---|---|---|---|---|
| Bold, italic, underline, strikethrough, inline code | Markdown | ✅ | `utils/markdownParser.jsx` | — |
| Code blocks with language tag | ```` ```js ```` | 🟡 | `markdownParser.jsx` L367 | Shows the language label, but no syntax highlighting. Add lazy `highlight.js` |
| Headers `#`/`##`/`###`, subtext `-#` | 2023 | ✅ | `markdownParser.jsx` | — |
| Block quotes `>` and `>>>` | Quotes | ✅ | `markdownParser.jsx` | Verify `>>>` multi-line |
| Lists `-`/`*`/`1.` (nested) | Lists | ✅ | `markdownParser.jsx` | — |
| Masked links `[text](url)` + "leaving Discord" warning | Links | 🟡 | `markdownParser.jsx` | Rendered, but there is no external-link confirmation (`ShouldShowLinkNotDiscordWarning`) |
| Spoilers `||text||` | Click to reveal | ✅ | `SpoilerText` | — |
| Mentions `<@id>`, `<@&role>`, `<#channel>`, `@everyone`, `@here` | Mentions | ✅ | `markdownParser.jsx`, `services/messages.js` `parseMentions` | — |
| Guild navigation mentions `<id:customize>`, `<id:browse>`, `<id:guide>`, slash-command mentions `</name:id>` | 2023 | ❌ | `markdownParser.jsx` | Add them once Browse/Guide exist |
| Timestamps `<t:unix:t/T/d/D/f/F/R>` | 7 styles | ✅ | `renderTimestamp` | Locale hard-coded to `th-TH` for `R`; use the active locale |
| Custom emoji `<:name:id>`, animated `<a:…>` | Inline | ✅ | `markdownParser.jsx`, `/api/emojis/:id/image` | — |
| Emoji-only messages render jumbo | Big emoji | 🟡 | `ChatArea.jsx` | Not verified. Add a check (≤ 30 emoji → 48 px) |
| Link embeds (OpenGraph/oEmbed), rich embeds (bots) | Embeds, ≤10 per message | ✅ | `services/linkEmbeds.js`, `LinkEmbed.jsx`, `RichEmbed.jsx` | — |
| Suppress embeds (remove preview) | Author or MANAGE_MESSAGES removes embeds | ❌ | — | `messages.flags` exists: set bit 4 and hide in render |
| `<url>` suppresses the preview | Angle brackets | ❌ | `services/linkEmbeds.js` | Skip URLs wrapped in `<>` |

### 5b. Composing and sending

| Feature | Discord behaviour | Status | Our files | Gap / next step |
|---|---|---|---|---|
| Attachments: multiple files, drag-drop, paste, size limit | ≤10 files | ✅ | `routes/files.js` `/upload/attachments`, `ChatArea.jsx` | — |
| Attachment spoiler | Mark as spoiler | ✅ | `attachments.is_spoiler` | — |
| Attachment alt text (description) | Alt text editor | 🟡 | `attachments.description` | Column exists, but the composer has no editor and the renderer uses `alt=""`. Add both |
| Voice messages (record, waveform, playback speed) | Mobile + desktop | ✅ | `VoiceNote.jsx`, `utils/voiceNote.js`, `attachments.waveform` | Not gated by a permission (`SEND_VOICE_MESSAGES`, §8) |
| Stickers (one per message, server + default packs) | Sticker picker | ✅ | `StickerPicker.jsx`, `messages.sticker_id` | Default Discord packs 🚫 |
| GIF picker (Tenor/Klipy) and favourites | GIF tab | ❌ | — | A third-party API breaks zero-deps. Offer "favourite GIFs" from uploaded/linked GIFs, plus an optional Tenor key |
| Emoji picker with server emoji, search, skin tone, frequent | Picker | ✅ | `EmojiPicker.jsx` | Skin tone not verified |
| Slash commands (built-in: /me /shrug /tableflip /spoiler /tts /nick /thread …) | Built-ins + apps | ✅ | `utils/slashCommands.js` (26 built-ins), `ComposerAutocomplete.jsx` | — |
| TTS messages `/tts` | Read aloud | 🟡 | `messages.tts`, `slashCommands.js` | `SEND_TTS_MESSAGES` is not enforced |
| Silent messages `@silent` | `SuppressNotifications` flag | ❌ | — | Parse the leading `@silent`, set flag 4096, and skip notifications |
| Replies with the ping on/off toggle | Reply + "@ ON/OFF" | 🟡 | `reply_to_id`, `ChatArea.jsx` replying-to bar | Reply works; the mention toggle is missing |
| Edit message + edit history | Edited label | ✅ | `PATCH /api/messages/:id`, `message_edits`, `EditHistoryModal.jsx` | Edit history is a bonus: Discord doesn't show it |
| Delete (own / MANAGE_MESSAGES), bulk delete (≤100, <14 d) | Delete | ✅ | `DELETE /api/messages/:id`, `/messages/bulk-delete` | Not audit-logged (`MESSAGE_DELETE`/`MESSAGE_BULK_DELETE`) |
| Pins (≤50 → 250 in 2025), pinned list | Pins | ✅ | `PUT /messages/:id/pin`, `PinnedMessagesPopover.jsx` | Limit 50; Discord raised it to 250 with PIN_MESSAGES. Pins are not audit-logged |
| Forward to channel/DM with optional comment, "Forwarded" label, snapshot | 2024 | 🟡 | `ForwardMessageModal.jsx`, `App.jsx` L2385 | Re-sends as a new message. No `message_reference.type=1` snapshot, no source link, no comment |
| Crosspost (publish) | Announcement | ✅ | `services/following.js` | — |
| Mark unread | Context menu | ✅ | `POST /read-states/:id/unread` | — |
| Copy link / copy text / copy ID | Context menu | ✅ | `MessageContextMenu.jsx` | — |
| Report message | Report flow | ✅ | `POST /api/reports` | Local mod queue |
| Ephemeral messages ("only you can see this") | Bot replies | ✅ | `messages.ephemeral_user_id` | — |
| Jump to present / new-messages bar / load older | Navigation | ✅ | `ChatArea.jsx` | — |
| Typing indicator | "X is typing" | ✅ | `realtime.js` | — |
| Draft persistence per channel | Drafts | ✅ | `ChatArea.jsx` L43 | — |
| Message send failure → retry | Retry | ✅ | `ChatArea.jsx` `chat.retry` | — |

### 5c. Reactions and polls

| Feature | Discord behaviour | Status | Our files | Gap / next step |
|---|---|---|---|---|
| Reactions (unicode + custom), who reacted, ≤20 distinct | Reactions | ✅ | `PUT /messages/:id/reactions/:emoji`, `MAX_REACTIONS` | — |
| Super Reactions (burst colours, separate count) | Nitro-limited burst | 🟡 | `SuperReaction.jsx`, `realtime.js` `super_reaction` | Animation is broadcast only. It is not persisted (no `burst` column) and not counted separately |
| Remove all reactions / remove one emoji (mod) | MANAGE_MESSAGES | ❌ | `services/messages.js` `toggleReaction` | Add `DELETE /messages/:id/reactions[/emoji]` |
| Polls: question, ≤10 answers with emoji, multi-select, 1h–2w duration, voters list, end early | Polls | ✅ | `services/polls.js`, `CreatePollModal.jsx`, `PollCard.jsx` | — |
| Poll result message when a poll closes (type 46) | System message | ❌ | `services/polls.js` | Post a `poll_result` embed on close |
| Soundmoji (sound inside a message) | 2024 | ❌ | — | Low priority |

### 5d. Search

| Feature | Discord behaviour | Status | Our files | Gap / next step |
|---|---|---|---|---|
| Full-text search (incl. Thai) | Search box | ✅ | `messages_fts` (trigram), `services/messages.js` `searchMessages` | — |
| `from:`, `mentions:`, `in:`, `has:` (link, embed, file, image, video, sound, sticker, poll, forward), `before:/after:/during:`, `pinned:` | Operators | ✅ | `lib/searchQuery.js` | `has:forward` is missing (needs snapshots) |
| Author type filter (user / bot / webhook), `authorType:` | "More filters" | ❌ | `lib/searchQuery.js` | Add operator and join on `users.is_bot` / `webhook_id` |
| Sort by newest / oldest / relevant | Sort | 🟡 | `SearchResultsPanel.jsx` | Verify relevance option (FTS rank) |
| Search in DMs, across servers ("search everywhere") | Scopes | 🟡 | `GET /api/search/messages` | Per-server/channel only |

---

## 6. Notifications

Sources: [Notifications Settings 101](https://support.discord.com/hc/en-us/articles/215253258-Notifications-Settings-101), [Stop @everyone from select servers](https://support.discord.com/hc/en-us/articles/215253148-How-do-I-stop-everyone-mentions-from-select-servers), [Mute specific channels](https://support.discord.com/hc/en-us/articles/209791877-How-do-I-mute-and-disable-notifications-for-specific-channels).

| Feature | Discord behaviour | Status | Our files | Gap / next step |
|---|---|---|---|---|
| Server notification level: all / mentions / nothing | Per-server | 🟡 | `server_settings.notification_level`, `NotificationSettingsPopover.jsx` | Stored, but neither `services/messages.js` (only creates `mention` rows) nor `App.jsx` (desktop only for DMs) reads it. "All messages" never notifies, and "Nothing" still notifies on mentions |
| Channel override: inherit / all / mentions / nothing | Per-channel | 🟡 | `channel_settings.notification_level` | Stored only |
| Server default notifications fallback | Server setting | 🟡 | `servers.default_notifications` | Not used as the default |
| Mute server / channel for 15m/1h/3h/8h/24h/until I turn it back on | Timed mute | 🟡 | `muted_until` on both tables | Channel mute honours expiry. The server mute ignores `server_settings.muted_until`, and the UI has no server timed mute |
| Mute category | Category mute cascades | ❌ | — | Treat category mute as the parent fallback |
| Suppress @everyone and @here | Per-server toggle | 🟡 | `server_settings.suppress_everyone` | Column only: no UI, no enforcement |
| Suppress all role @mentions | Per-server toggle | 🟡 | `server_settings.suppress_roles` | Column only |
| Suppress highlights / mute new events | Toggles | ❌ | — | Needs event notifications first |
| Mobile push notifications | Per-server toggle | ❌ | `push_tokens` table | Web Push (ROADMAP P0-1) |
| Thread notifications: all / mentions / none, auto-follow | Per-thread | ❌ | — | Add `channel_settings` rows for threads and notify thread members |
| Forum "follow post" | Follow | ❌ | — | Same as threads |
| Notification inbox: mentions tab, unreads tab, "for you" | Inbox (Ctrl+I) | 🟡 | `NotificationsInbox.jsx`, `GET /api/notifications/:userId` | Mentions list works. No unreads tab or filters |
| Mark as read (channel, server, all) | Actions | ✅ | `POST /read-states/:id`, keybinds Esc/Shift+Esc | — |
| Unread badges + mention counts | Sidebar and rail | ✅ | `read_states`, `ServerRail.jsx`, `ChannelSidebar.jsx` | — |
| DND suppresses notifications | Status | ✅ | `utils/notifier.js` | — |
| Streamer-mode suppression | Toggle | ✅ | `utils/notifier.js` | — |
| Friend request / reply / reaction notifications | Inbox types | ✅ | `notifications.type` (mention, dm, friend_request, reply…) | Reaction notifications are 🚫 on Discord too |
| Keyword notifications | Not in Discord (long-requested) | 🚫 | — | N/A; could be a later bonus |
| Email notifications | Email | 🚫 | — | Optional later |

---

## 7. Moderation and safety

Sources: [AutoMod FAQ](https://support.discord.com/hc/en-us/articles/4421269296535-AutoMod-FAQ), [Activity Alerts + Security Actions](https://support.discord.com/hc/en-us/articles/17439993574167-Activity-Alerts-Security-Actions), [Discord Safety Alerts](https://support.discord.com/hc/en-us/articles/18210977897239-Discord-Safety-Alerts), [Verification Levels](https://support.discord.com/hc/en-us/articles/216679607-Verification-Levels), [Rules Screening FAQ](https://support.discord.com/hc/en-us/articles/1500000466882-Rules-Screening-FAQ). AutoMod enums from `discord-api-types`: triggers Keyword=1, Spam=3, KeywordPreset=4 (Profanity, SexualContent, Slurs), MentionSpam=5, MemberProfile=6; actions BlockMessage=1, SendAlertMessage=2, Timeout=3, BlockMemberInteraction=4; events MessageSend=1, MemberUpdate=2.

### 7a. AutoMod

| Feature | Discord behaviour | Status | Our files | Gap / next step |
|---|---|---|---|---|
| Custom keyword rule (≤6 rules, 1000 keywords, wildcards `*`) | Keyword filter | 🟡 | `services/automod.js` `matches` (`keyword`) | Plain substring. No `*word*` wildcard semantics and no per-guild rule limits |
| Regex patterns (≤10 per rule, Rust regex) | In keyword rules | ✅ | `automod.js` `safeRegex` | One pattern per rule; Discord allows 10 |
| Allow list (exempt words) | Per rule | ❌ | `trigger_metadata` | Add `allow_list` |
| Keyword presets: profanity, sexual content, slurs | Commonly Flagged Words | ❌ | — | Ship curated TH+EN lists in `db/automod-presets/` |
| Spam content detection | ML spam | 🟡 | `automod.js` `spam` (rate + duplicate heuristic) | Heuristic, not ML; fine |
| Mention spam (limit ≤50) + mention raid protection | Mention rule | 🟡 | `automod.js` `mention_spam` | No raid protection mode (burst across users) |
| Link filter / allowed domains | Ours (Discord uses keywords) | ✅ | `automod.js` `link` | Beyond Discord |
| Member profile rule (names/bio) → block interaction | 2023 | ❌ | — | Evaluate on join/nickname change; quarantine flag |
| Action: block message + custom response | Block, custom message | 🟡 | `automod.js` block | No custom response text |
| Action: send alert to channel | Alert message in a mod channel | 🟡 | `ACTIONS` includes `alert`, `AutoModTab.jsx` | **Accepted but does nothing**: no alert channel, and a non-blocking rule has no effect |
| Action: timeout (≤28 d) | Timeout | ✅ | `automod.js` L24 | — |
| Exempt roles / channels | Exemptions | ✅ | `exempt_roles`, `exempt_channels` | — |
| AutoMod applies to edits | Yes | ✅ | `services/messages.js` L741 | — |
| AutoMod audit events (rule create/update/delete, block, flag, timeout, quarantine) | 140-146 | 🟡 | `AUTOMOD_BLOCK` only | Add rule CRUD and flag/timeout events |

### 7b. Server safety settings

| Feature | Discord behaviour | Status | Our files | Gap / next step |
|---|---|---|---|---|
| Verification level: none / low (verified email) / medium (5 min account) / high (10 min member) / highest (phone) | 0-4 | ✅ | `services/guilds.js` L563-576, Overview select | "Highest" uses MFA instead of phone. Documented |
| Explicit media content filter: off / members without roles / all members | 0-2 | 🟡 | `servers.explicit_content_filter` | **Stored only: no UI, no scanning.** Needs an optional classifier sidecar (nsfwjs/ONNX) or honest removal |
| Raid protection (join-rate lockdown) + CAPTCHA for suspicious joiners | Raid alerts + captcha | 🟡 | `services/insights.js` `guardJoin`, `guild_lockdowns`, `InsightsTab.jsx` | Lockdown works. There is no CAPTCHA (see ROADMAP ALTCHA) and no raid alert message |
| Activity alerts (join raid / DM raid) to safety channel | Alerts | ❌ | — | Post a system message to `safety_alerts_channel_id` |
| Security actions: pause invites (≤24 h), pause DMs | Lockdown buttons | 🟡 | manual lockdown `POST /raid/lockdown` | Lockdown refuses joins. Pause-DMs and time-boxed invite pause are missing |
| Require 2FA for moderation | MFA level | ❌ | — | See §3 |
| Rules screening (must accept rules) | Member verification gate | ✅ | `OnboardingTab.jsx`, `member_onboarding.rules_accepted_at`, `RULES_NOT_ACCEPTED` | — |
| Pending members can't talk/react/DM | Gate | ✅ | `server_members.pending` | Verify DM path |

### 7c. Member actions

| Feature | Discord behaviour | Status | Our files | Gap / next step |
|---|---|---|---|---|
| Kick with reason | Kick | ✅ | `POST /servers/:id/kicks/:user` | — |
| Ban with reason + delete message history (1 h … 7 d) | Ban | ✅ | `POST /servers/:id/bans/:user`, `bans.delete_message_seconds` | — |
| Bulk ban (≤200) | 2024 | ❌ | — | `POST /servers/:id/bulk-ban` |
| Unban | Bans list | ✅ | `DELETE /servers/:id/bans/:user` | — |
| Timeout 60 s … 1 week (≤28 d) | Timeout | ✅ | `POST /servers/:id/timeouts/:user`, `automod.js` `assertCanSpeak` | — |
| Prune inactive members (7/30 d, roles) | Prune | ❌ | — | `POST /servers/:id/prune` with dry-run count; audit `MEMBER_PRUNE` |
| Server mute / deafen in voice | Right-click | ❌ | `voice_states.server_mute/server_deaf` | Columns unused. Add socket actions guarded by MUTE/DEAFEN_MEMBERS |
| Move member between voice channels / disconnect | Drag or menu | ❌ | — | MOVE_MEMBERS; audit MEMBER_MOVE/DISCONNECT |
| Change nickname of others | MANAGE_NICKNAMES | ✅ | `services/guildAdmin.js` `setNickname` | — |
| Mod View (member overview for mods, 2023) | Panel | ❌ | — | Member drawer: roles, join date, recent messages, timeouts |
| Warnings / notes for mods | Not in Discord | 🚫 | — | ROADMAP P1 idea |
| Report message/user → server mods | T&S report | ✅ | `services/reports.js`, Reports tab | Local |

### 7d. Audit log event types

Discord's list from `AuditLogEvent`: GuildUpdate 1; Channel Create/Update/Delete 10-12; Overwrite Create/Update/Delete 13-15; MemberKick 20, Prune 21, BanAdd 22, BanRemove 23, MemberUpdate 24, MemberRoleUpdate 25, MemberMove 26, MemberDisconnect 27, BotAdd 28; Role 30-32; Invite 40-42; Webhook 50-52; Emoji 60-62; MessageDelete 72, BulkDelete 73, Pin 74, Unpin 75; Integration 80-82; StageInstance 83-85; Sticker 90-92; ScheduledEvent 100-102; Thread 110-112; AppCommandPermissionUpdate 121; Soundboard 130-132; AutoMod 140-146; CreatorMonetization 150-151; Onboarding 163-167; HomeSettings (Server Guide) 190-191; VoiceChannelStatus 192-193.

| Group | Status | Ours (`audit_logs.action_type`) | Gap |
|---|---|---|---|
| Guild, channel, overwrite, member kick/ban/unban/update/role, role, webhook create/delete, emoji create/delete, sticker create/delete, bot add/remove | ✅ | `SERVER_UPDATE`, `CHANNEL_*`, `CHANNEL_OVERWRITE_UPDATE/DELETE`, `MEMBER_*`, `ROLE_*`, `WEBHOOK_CREATE/DELETE`, `EMOJI_*`, `STICKER_*`, `BOT_ADD/REMOVE`, `SERVER_OWNER_TRANSFER`, `MEMBER_TIMEOUT` | — |
| Invite create/update | 🟡 | `INVITE_DELETE` only | Log `INVITE_CREATE` |
| Message delete (by mod), bulk delete, pin, unpin | ❌ | — | Log in `services/messages.js` |
| Thread, scheduled event, soundboard, onboarding, stage, voice status, member move/disconnect/prune, webhook/emoji/sticker update, AutoMod rule CRUD | ❌ | — | Each owning service should call `writeAuditLog` |
| Filters in UI (by user, by action) | 🟡 | Audit tab lists all | Add query params `user_id`, `action_type`, `before` |

---

## 8. Roles and permissions

Sources: [Discord developer docs – Permissions](https://discord.com/developers/docs/topics/permissions) (bit values checked against `discord-api-types@0.38.55` `PermissionFlagsBits`); announcement of the PIN_MESSAGES / BYPASS_SLOWMODE split ([API change-log](https://discord.com/developers/docs/change-log), [discord-api-docs PR #8002](https://github.com/discord/discord-api-docs/pull/8002), enforcement from 2026-02-23 per search snippets); [Slowmode FAQ](https://support.discord.com/hc/en-us/articles/360016150952-Slowmode-FAQ).

### 8a. Role features

| Feature | Discord behaviour | Status | Our files | Gap / next step |
|---|---|---|---|---|
| Create / delete / rename role, colour | Roles page | ✅ | `ServerSettingsModal.jsx` Roles, `services/guildAdmin.js` | — |
| Drag to reorder, hierarchy enforcement | Role position | ✅ | `PUT /servers/:id/roles/order` | — |
| Display separately (hoist), mentionable | Toggles | ✅ | `roles.hoist/mentionable` | — |
| Gradient / holographic role colours | Enhanced role styles | 🟡 | `roles.color_secondary`, `MemberList.jsx` | No editor in the Roles UI |
| Role icon (image or emoji) | Boost L2 | 🟡 | `roles.icon_url` accepted by `services/guildAdmin.js` | No upload UI, and not rendered next to names |
| Manage members in role (list, add, remove) | "Manage Members" tab | ❌ | — | Add a tab listing members with this role |
| View server as role | Preview | ❌ | — | Client-side permission simulation |
| Permission search, "clear permissions" | Roles page | ❌ | — | Minor UX |
| Linked roles (connections-based) | 2022 | 🚫 | — | Needs connections/OAuth |
| Role subscriptions (paid roles) | Monetisation | 🚫 | — | Paid |
| Channel overwrites: allow/deny/inherit for role or member, sync with category | Advanced perms | ✅ | `ChannelPermissionsTab.jsx`, `services/channelPerms.js`, `computeChannelPermissions` | Sync button missing (§4) |
| Effective-permission viewer | ours | ✅ | `GET /channels/:id/permissions/:user/effective` | Beyond Discord |

### 8b. Permission flags (full current list, bit value)

"Enforced" means some code path actually checks the flag, not just lists it.

| Flag (bit) | Status | Where enforced / gap |
|---|---|---|
| CREATE_INSTANT_INVITE (0) | ✅ | `server.js` L560 |
| KICK_MEMBERS (1) | ✅ | kicks route |
| BAN_MEMBERS (2) | ✅ | bans routes |
| ADMINISTRATOR (3) | ✅ | `lib/permissions.js` `has` |
| MANAGE_CHANNELS (4) | ✅ | `services/guilds.js` |
| MANAGE_GUILD (5) | ✅ | settings routes |
| ADD_REACTIONS (6) | ✅ | reactions |
| VIEW_AUDIT_LOG (7) | ✅ | audit route |
| PRIORITY_SPEAKER (8) | 🟡 | Listed, never checked: no ducking of others |
| STREAM (9) | 🟡 | Listed, never checked: anyone can screen-share/video |
| VIEW_CHANNEL (10) | ✅ | `services/access.js` |
| SEND_MESSAGES (11) | ✅ | `services/messages.js` |
| SEND_TTS_MESSAGES (12) | 🟡 | Never checked |
| MANAGE_MESSAGES (13) | ✅ | delete/pin |
| EMBED_LINKS (14) | 🟡 | Never checked: previews are always generated |
| ATTACH_FILES (15) | ✅ | messages + composer |
| READ_MESSAGE_HISTORY (16) | ✅ | list messages |
| MENTION_EVERYONE (17) | ✅ | `services/messages.js` L638 |
| USE_EXTERNAL_EMOJIS (18) | ✅ | `services/messages.js` L322, L852 |
| VIEW_GUILD_INSIGHTS (19) | 🟡 | Insights uses MANAGE_GUILD instead |
| CONNECT (20) | ✅ | `realtime.js` L290 |
| SPEAK (21) | 🟡 | Never checked: users without it can talk |
| MUTE_MEMBERS (22) | 🟡 | Stage only (`realtime.js` L342, L432); no server-mute in voice |
| DEAFEN_MEMBERS (23) | 🟡 | Never checked (no feature) |
| MOVE_MEMBERS (24) | 🟡 | Never checked (no feature) |
| USE_VAD (25) | 🟡 | Never checked: should force push-to-talk |
| CHANGE_NICKNAME (26) | ✅ | `guildAdmin.setNickname` |
| MANAGE_NICKNAMES (27) | ✅ | same |
| MANAGE_ROLES (28) | ✅ | roles routes |
| MANAGE_WEBHOOKS (29) | ✅ | webhooks |
| MANAGE_GUILD_EXPRESSIONS (30) | ✅ | named `MANAGE_EMOJIS`; rename for clarity |
| USE_APPLICATION_COMMANDS (31) | ❌ | Missing; gate `/commands` |
| REQUEST_TO_SPEAK (32) | ❌ | Missing; stage hand-raise is ungated |
| MANAGE_EVENTS (33) | ❌ | Missing; events use MANAGE_GUILD |
| MANAGE_THREADS (34) | ✅ | threads |
| CREATE_PUBLIC_THREADS (35) | ✅ | `services/threads.js` |
| CREATE_PRIVATE_THREADS (36) | 🟡 | Listed; no private threads |
| USE_EXTERNAL_STICKERS (37) | ❌ | Missing |
| SEND_MESSAGES_IN_THREADS (38) | ✅ | messages |
| USE_EMBEDDED_ACTIVITIES (39) | ❌ | Missing (no Activities) |
| MODERATE_MEMBERS (40) | ✅ | timeouts |
| VIEW_CREATOR_MONETIZATION_ANALYTICS (41) | 🚫 | Monetisation |
| USE_SOUNDBOARD (42) | ❌ | Missing; soundboard ungated |
| CREATE_GUILD_EXPRESSIONS (43) | ❌ | Missing (create vs manage split) |
| CREATE_EVENTS (44) | ❌ | Missing |
| USE_EXTERNAL_SOUNDS (45) | ❌ | Missing |
| SEND_VOICE_MESSAGES (46) | ❌ | Missing; voice notes ungated |
| SET_VOICE_CHANNEL_STATUS (48) | ❌ | Missing (no voice status) |
| SEND_POLLS (49) | ❌ | Missing; polls ungated |
| USE_EXTERNAL_APPS (50) | ❌ | Missing (no user-installed apps) |
| PIN_MESSAGES (51) | ❌ | **Missing. Discord enforces it since 2026-02-23**; pins still use MANAGE_MESSAGES |
| BYPASS_SLOWMODE (52) | ❌ | **Missing.** `services/automod.js` `assertCanSpeak` still lets MANAGE_MESSAGES / MANAGE_CHANNELS bypass slowmode, which is Discord's pre-2026 rule |

---

## 9. Community, onboarding, events, voice/stage extras, activities, apps and bots

Sources: [Community Onboarding FAQ](https://support.discord.com/hc/en-us/articles/11074987197975-Community-Onboarding-FAQ), [Server Guide FAQ](https://support.discord.com/hc/en-us/articles/13497665141655-Server-Guide-FAQ), [Community Welcome Screen](https://support.discord.com/hc/en-us/articles/360043913591-Community-Server-Welcome-Screen), [Enabling Server Discovery](https://support.discord.com/hc/en-us/articles/360030843331-Enabling-Server-Discovery), [Scheduled Events](https://support.discord.com/hc/en-us/articles/4409494125719-Scheduled-Events), [Soundboard Guide](https://support.discord.com/hc/en-us/articles/12612888127767-Discord-Soundboard-Guide-Using-Adding-and-Managing-Sounds), [Stage Channels FAQ](https://support.discord.com/hc/en-us/articles/1500005513722-Stage-Channels-FAQ), [Using Apps on Discord](https://support.discord.com/hc/en-us/articles/21334461140375-Using-Apps-on-Discord), developer docs for [Interactions](https://discord.com/developers/docs/interactions/receiving-and-responding), [Application Commands](https://discord.com/developers/docs/interactions/application-commands), [Message Components](https://discord.com/developers/docs/components/reference) and [Webhooks](https://discord.com/developers/docs/resources/webhook). Enums (`ComponentType` 1-23, `InteractionResponseType`, `ApplicationCommandOptionType` 1-11, `GuildScheduledEventRecurrenceRuleFrequency`, `GuildOnboardingMode`) come from `discord-api-types`.

### 9a. Onboarding, Server Guide, welcome, discovery, insights

| Feature | Discord behaviour | Status | Our files | Gap / next step |
|---|---|---|---|---|
| Welcome screen (description + ≤5 channels) | Community | ✅ | `welcome_channels`, `PATCH /onboarding/welcome`, `OnboardingModal.jsx` | — |
| Onboarding questions (single/multi, required, options grant channels + roles) | Prompts | ✅ | `onboarding_prompts/options`, `OnboardingTab.jsx`, `services/onboarding.js` | — |
| Pre-join vs post-join questions, dropdown type | Prompt types | 🟡 | `single_select` | No `in_onboarding` flag and no dropdown |
| Default channels (≥7, ≥5 chattable) | Required set | ❌ | — | Add `onboarding_default_channels` |
| Opt-in channels ("Channels & Roles" / Browse channels, hide unfollowed) | Customise | ❌ | — | Per-member channel opt-in (`member_channel_optins`) + sidebar filter |
| Onboarding mode (default / advanced) and enable toggle | Settings | 🟡 | `OnboardingTab.jsx` | No mode; always on when prompts exist |
| Server Guide: welcome sign, new-member to-dos (3-5), resource pages | Home | ❌ | — | `server_guide` JSON + a "Guide" page (audit 190-191) |
| Discovery (instance-local directory, categories, keywords) | Discover | ❌ | — | Instance-wide `/discover` listing opt-in servers |
| Announcement follow | Follow | ✅ | `services/following.js` | — |
| Server Insights (growth, engagement, retention, audience) | Insights | ✅ | `services/insights.js`, `InsightsTab.jsx` | Should gate on VIEW_GUILD_INSIGHTS (§8) |

### 9b. Events

| Feature | Discord behaviour | Status | Our files | Gap / next step |
|---|---|---|---|---|
| Create event: stage / voice / external location, name, description, start/end, cover image | Events | ✅ | `services/events.js`, `EventsPanel.jsx` | Cover image is URL-only; add upload |
| Interested / RSVP list, count | Interested | ✅ | `event_interest`, `GET /events/:id/interested` | — |
| Start / end / cancel, auto-start channel events | Lifecycle | ✅ | `services/events.js` | — |
| Recurring events (daily/weekly/monthly/yearly, 2024) | Recurrence rule | ❌ | — | Add `recurrence_rule` JSON and next-occurrence roll |
| Event reminder notifications to interested users | Push at start | ❌ | — | Notify at start via `services/notifications.js` |
| Share event link / event invite | Invite with `event=` | ❌ | — | Add `?event=` to invites |

### 9c. Voice, soundboard, stage, activities

| Feature | Discord behaviour | Status | Our files | Gap / next step |
|---|---|---|---|---|
| Voice channels: join, mute/deafen self, video, screen share, speaking indicator | Voice | ✅ | `VoiceRoom.jsx`, `useVoicePeers.js`, `realtime.js` | P2P mesh; LiveKit optional per ROADMAP |
| Soundboard: play server + default sounds, volume, cooldown | Soundboard | ✅ | `SoundboardPanel.jsx`, `soundboard_sounds` | Default sounds pack 🚫. No USE_SOUNDBOARD check |
| Entrance sounds (Nitro) | Join sound | 🚫 | — | Nitro |
| Stage: see §4 | — | ✅ | — | Stage instance missing (§4) |
| Activities (Watch Together, games) | Embedded apps | 🚫 | — | Discord Embedded App SDK |
| Clips (record last 30 s) | Desktop | 🚫 | — | Native |
| Go Live stream to non-voice viewers / stream previews | Stream | 🟡 | `useVoiceMedia.js` | Only inside the room, with no thumbnails |

### 9d. Apps, bots, interactions, webhooks

| Feature | Discord behaviour | Status | Our files | Gap / next step |
|---|---|---|---|---|
| Create application + bot user + token (reset) | Developer portal | ✅ | `settings/ApplicationsTab.jsx`, `services/applications.js` | — |
| Add bot to server with permission picker (OAuth2 URL) | Invite flow | ✅ | `POST /applications/:id/invite` | Not a real OAuth2 authorisation-code flow |
| Bot gateway connection | Gateway | ✅ | `realtime.js` L58 (bot token on socket), `interaction_created` event | — |
| Slash commands (global + guild), options string/int/bool/user/channel/role | Type 1 | ✅ | `application_commands`, `PUT /applications/:id/commands` | Missing option types: subcommand(s), number, mentionable, attachment; min/max, choices limits |
| User and message context-menu commands | Types 2/3 | ✅ | `application_commands.type` | — |
| Autocomplete (type 4) | Dynamic choices | ❌ | — | Add interaction type + response type 8 |
| Modals + text inputs (type 5 / response 9) | Forms | ❌ | — | Add modal renderer and `modal_submit` interaction |
| Deferred responses, follow-ups, edit original | Responses 5/6/7 | 🟡 | `POST /interactions/:id/callback` | Verify defer + follow-up webhook endpoints |
| Buttons (styles 1-5), string select | Components v1 | ✅ | `services/applications.js` L428-470, `RichEmbed.jsx` | — |
| User/role/mentionable/channel selects | Types 5-8 | ❌ | — | Extend validator + renderer |
| Components V2 (section, text display, thumbnail, media gallery, file, separator, container, label, file upload, radio/checkbox) | 2025 | ❌ | — | Large; later |
| Command permissions per role/channel (Integrations) | Overrides | ❌ | — | `application_command_permissions` table |
| User-installed apps, install contexts (guild / DM / private) | 2024 | ❌ | — | Requires USE_EXTERNAL_APPS |
| Incoming webhooks: create, delete, execute | Webhooks | ✅ | `services/webhooks.js`, `WebhooksTab.jsx`, `POST /webhooks/:id/:token` | — |
| Webhook edit (name, avatar, channel), username/avatar override on execute, `thread_id`, `?wait`, edit/delete webhook message | Webhook API | 🟡 | `services/webhooks.js` | Create/delete/execute only |
| Slack- and GitHub-compatible webhook endpoints | `/slack`, `/github` | ❌ | — | Common for CI integrations |
| Channel-follower webhooks | Type 2 | ✅ | `webhooks.type='follower'` | — |
| App Directory, premium apps, entitlements | Store | 🚫 | — | Paid |

---

## 10. Prioritised implementation backlog (top 30)

Ranking follows the ROADMAP rule: first fix things that are **silently wrong**,
where a setting is shown but does nothing; then things that change Discord
semantics (permissions); then missing features, weighted by community impact.

| # | Item | Why | Batch |
|---|---|---|---|
| 1 | Enforce notification levels (server/channel/inherit/default) and server `muted_until` | Settings visibly do nothing today | B1 |
| 2 | Suppress @everyone/@here and role mentions: UI + enforcement | Columns exist, dead | B1 |
| 3 | Web Push / PWA notifications (ROADMAP P0-1) | #1 reason communities leave | B1 |
| 4 | Thread and forum-post notification settings (follow/all/mentions/none) | Threads are silent today | B1 |
| 5 | Add the 16 missing permission flags (bits 31-52; bit 41 stays out of scope) and permission catalogue UI | Parity with Discord 2026 semantics | B0 (flags) + B3 (UI) |
| 6 | Enforce voice perms: SPEAK, STREAM, USE_VAD, PRIORITY_SPEAKER, REQUEST_TO_SPEAK | Listed but ignored | B3 |
| 7 | Moderator voice actions: server mute/deafen, move, disconnect (+ audit MEMBER_MOVE/DISCONNECT) | Basic mod tooling | B3 |
| 8 | Stage instances (topic, start/end, stage system messages) | Stage is half-built | B3 |
| 9 | AutoMod alert action + alert channel + custom block message | Option is selectable and does nothing | B4 |
| 10 | AutoMod keyword presets (TH/EN), allow list, wildcards, rule limits, member-profile rule | Core AutoMod parity | B4 |
| 11 | Security actions: pause invites / pause DMs (time-boxed) + activity (raid) alerts | Raid response | B4 |
| 12 | BYPASS_SLOWMODE semantics + forum default post slowmode enforcement | New Discord permission | B4 |
| 13 | Explicit content filter: UI + optional classifier sidecar (or remove setting) | Stored but fake | B4 |
| 14 | Message-path permissions: PIN_MESSAGES, SEND_VOICE_MESSAGES, SEND_TTS_MESSAGES, EMBED_LINKS; pin limit 250; audit MESSAGE_DELETE/BULK_DELETE/PIN/UNPIN | Permission semantics | B2 |
| 15 | `@silent` (flag 4096), suppress embeds (flag 4, `<url>`), reply-ping toggle | Everyday messaging parity | B2 |
| 16 | Real forwarding with snapshots (`message_reference.type=1`) + optional comment + `has:forward` | Current forward is a copy | B2 |
| 17 | Attachment alt-text editor + render `alt` | Accessibility; column already exists | B2 |
| 18 | Search: `authorType:`, relevance sort, DM search; syntax highlighting in code blocks | Search/format parity | B2 |
| 19 | Private threads + thread member list + add-by-mention | Common mod workflow | B5 |
| 20 | Channel Settings parity: permissions/invites/webhooks tabs, sync-to-category, voice bitrate/limit 99/video quality, default archive, announcement⇄text, forum guidelines shown | Settings incomplete | B5 |
| 21 | Voice channel status (SET_VOICE_CHANNEL_STATUS) + clone channel | Popular 2023+ feature | B5 |
| 22 | Role editor: gradient colours, role icons, members-in-role tab, view-as-role | Backend exists, no UI | B6 |
| 23 | Server overview: banner/splash upload, explicit filter select, system-channel flags, Community toggle, mod-2FA requirement | Settings gaps | B6 |
| 24 | Members page: prune (dry run), filters, join method, bulk ban; audit log filters; bans search | Moderation at scale | B6 |
| 25 | Onboarding: default channels, opt-in channels/Browse Channels, Server Guide | Community onboarding parity | B6 |
| 26 | Account: change username/email, disable account, regenerate backup codes, passkeys | Account basics | B7 |
| 27 | Message requests + per-server "allow DMs" override + Ignore user | Safety for open communities | B7 |
| 28 | Accessibility/keybind extras: OS-synced reduced motion, underline links, dyslexia font, Ctrl+/ sheet, unread-nav keybinds, custom-status expiry | Cheap wins | B7 |
| 29 | Apps: autocomplete, modals, deferred/follow-ups, more option types, entity selects, command permissions; webhook edit/overrides/`thread_id`/`?wait`/Slack-GitHub endpoints | Bot ecosystem parity | B8 |
| 30 | Recurring events + event reminders + cover upload; poll result message; soundboard/event/expression permission checks (USE_SOUNDBOARD, CREATE/MANAGE_EVENTS, CREATE_GUILD_EXPRESSIONS); persisted super reactions counter | Expressions/events parity | B9 |

---

## 11. Parallel batches: disjoint file ownership

Rule: **each file below belongs to exactly one batch.** A batch that needs
something from another batch's file uses the **contract** written for it, not an
edit. Every batch writes audit-log entries for its own features through the
existing `writeAuditLog` helper. It does not edit other batches' services to add
them.

### B0: Prep (one engineer, about 1 day, merge before the others start)

This batch removes the hotspots every other batch would otherwise edit at the same time.

| Change | Files |
|---|---|
| i18n: load `src/i18n/parts/*.{en,th}.js` with `import.meta.glob` and merge them into the dictionaries. Each batch then adds `src/i18n/parts/<batch>.en.js` and `<batch>.th.js` and **never edits `en.js`/`th.js`** | `src/i18n/index.jsx` |
| Migrations: load `db/migrations/*.js` after the built-in `MIGRATIONS`. Version ranges per batch: B1 101-119, B2 120-139, B3 140-159, B4 160-179, B5 180-199, B6 200-219, B7 220-239, B8 240-259, B9 260-279 | `db.js`, new `db/migrations/README.md` |
| Routes: auto-mount every `routes/*.js` router under `/api`. New endpoints go into new `routes/<feature>.js` files, **not `server.js`** | `server.js` |
| Extract the notification fan-out (`services/messages.js` ≈ L600-712) into a new `services/notifications.js` with `fanOut({ message, channel, authorPermissions })`. Contract: `messages.js` passes `message.flags`, and `notifications.js` must skip when `flags & 4096` | `services/messages.js`, new `services/notifications.js` |
| Add permission bits 31-52 (and alias `MANAGE_GUILD_EXPRESSIONS` = `MANAGE_EMOJIS`) to `PERMISSIONS`. Do not add them to defaults yet | `lib/permissions.js` |
| App-shell extension points: `src/extensions.js` registry (`registerSocketHandler`, `registerSidebarItem`, `registerChannelSettingsTab`) so batches don't have to edit `App.jsx` | `src/App.jsx`, new `src/extensions.js` |

### B1: Notifications (items 1-4)

Files: `services/notifications.js`, new `services/push.js`, new `routes/notifications.js`, new `routes/push.js`, `src/components/NotificationSettingsPopover.jsx`, `src/components/NotificationsInbox.jsx`, `src/components/settings/NotificationsTab.jsx`, `src/utils/notifier.js`, new `public/sw.js`, new `public/manifest.webmanifest`, `index.html`, `lib/middleware.js` (CSP `worker-src`), `src/i18n/parts/b1.*`, `db/migrations/101-*.js`.
Contract: B7 does not touch the notification preferences stored in `server_settings`/`channel_settings`. The notification endpoints move into `routes/notifications.js`, and the old `PUT /api/settings/*` stays as a thin alias.

### B2: Message pipeline (items 14-18)

Files: `services/messages.js`, `services/linkEmbeds.js`, `lib/searchQuery.js`, `src/components/ChatArea.jsx`, `src/components/MessageContextMenu.jsx`, `src/components/ForwardMessageModal.jsx`, `src/components/PinnedMessagesPopover.jsx`, `src/components/SearchResultsPanel.jsx`, `src/components/LinkEmbed.jsx`, `src/components/SuperReaction.jsx`, `src/utils/markdownParser.jsx`, `src/components/ComposerAutocomplete.jsx`, `src/i18n/parts/b2.*`, `db/migrations/120-*.js`.
(The persisted super-reaction count lives here because reactions live in `messages.js`.)

### B3: Permissions UI, voice and stage (items 5-8)

Files: `src/utils/permissionCatalog.js`, `realtime.js`, `src/components/VoiceRoom.jsx`, `src/components/CallPanel.jsx`, `src/hooks/useVoicePeers.js`, `src/hooks/useVoiceMedia.js`, `services/calls.js`, new `services/stage.js`, new `routes/stage.js`, `src/i18n/parts/b3.*`, `db/migrations/140-*.js`.

### B4: AutoMod and safety (items 9-13)

Files: `services/automod.js`, `src/components/settings/AutoModTab.jsx`, `services/insights.js`, `src/components/settings/InsightsTab.jsx`, new `services/contentFilter.js`, new `db/automod-presets/{en,th}.json`, `src/i18n/parts/b4.*`, `db/migrations/160-*.js`.
Contract: pause-DMs is exposed as `insights.isDmPaused(serverId)`, and B7 calls it from `services/users.js`. The explicit-filter select UI is in B6's Overview, which writes `servers.explicit_content_filter`; B4 enforces it on upload through `contentFilter.scan()`, called from `routes/files.js`, which B4 owns for this change.
Owns `routes/files.js`.

### B5: Channels and threads (items 19-21)

Files: `services/threads.js`, `services/forum.js`, `services/guilds.js`, `services/access.js`, `services/channelPerms.js`, `src/components/ChannelSettingsModal.jsx`, `src/components/CreateChannelModal.jsx`, `src/components/ForumView.jsx`, `src/components/ChannelSidebar.jsx`, `src/components/settings/ChannelPermissionsTab.jsx`, `src/i18n/parts/b5.*`, `db/migrations/180-*.js`.

### B6: Server settings and community (items 22-25)

Files: `src/components/ServerSettingsModal.jsx`, `services/guildAdmin.js`, `services/onboarding.js`, `services/templates.js`, `src/components/settings/OnboardingTab.jsx`, `src/components/OnboardingModal.jsx`, `src/components/MemberList.jsx`, `src/components/MemberContextMenu.jsx`, `src/components/ServerDropdown.jsx`, new `routes/guildAdmin.js`, new `src/components/ServerGuide.jsx`, `src/i18n/parts/b6.*`, `db/migrations/200-*.js`.
(The banner/splash upload endpoint goes in `routes/guildAdmin.js`, not `routes/files.js`.)
Contract: the join system message is written in `services/guilds.js` (B5). B6 exports `guildAdmin.systemChannelAllows(server, 'join')`, and B5 calls it at that single point.

### B7: Account, privacy, app settings (items 26-28)

Files: `routes/auth.js`, `routes/accountSecurity.js`, `services/accountSecurity.js`, `services/users.js`, `services/dataRights.js`, `services/userSettings.js`, `lib/totp.js`, `src/components/settings/AccountSecurityTab.jsx`, `ProfileTab.jsx`, `PrivacyTab.jsx`, `AccessibilityTab.jsx`, `AppearanceTab.jsx`, `KeybindsTab.jsx`, `ChatTab.jsx`, `src/hooks/useKeybinds.js`, `src/hooks/useUserSettings.js`, `src/components/UserSettingsModal.jsx`, `src/components/UserStatusMenu.jsx`, `src/components/HomeDirectMessages.jsx`, `src/components/UserProfileModal.jsx`, `src/index.css`, `src/i18n/parts/b7.*`, `db/migrations/220-*.js`.

### B8: Apps, bots and webhooks (item 29)

Files: `services/applications.js`, `services/webhooks.js`, `src/components/settings/ApplicationsTab.jsx`, `src/components/settings/WebhooksTab.jsx`, `src/components/RichEmbed.jsx`, `src/utils/slashCommands.js`, new `src/components/InteractionModal.jsx`, new `routes/applications.js`, new `routes/webhooks.js`, `src/i18n/parts/b8.*`, `db/migrations/240-*.js`.
Contract: `ComposerAutocomplete.jsx` belongs to B2. B8 exposes `getCommandSuggestions()` from `slashCommands.js`, and B2 renders what it returns.

### B9: Events, polls and expressions (item 30)

Files: `services/events.js`, `services/polls.js`, `src/components/EventsPanel.jsx`, `src/components/PollCard.jsx`, `src/components/CreatePollModal.jsx`, `src/components/SoundboardPanel.jsx`, `src/components/StickerPicker.jsx`, `src/components/EmojiPicker.jsx`, new `routes/events.js`, `src/i18n/parts/b9.*`, `db/migrations/260-*.js`.
Contract: the poll-close result message is posted with `messages.createMessage({ type: 'poll', skipModeration: true })`, which B9 calls without editing it. Event reminders go through `notifications.notifyUsers()`, which B1 exports.

### Conflict check

- No file appears in two batches. The only shared files are touched by B0, which merges first.
- `App.jsx`, `server.js`, `db.js`, `en.js`, `th.js`, `lib/permissions.js` and `services/messages.js` (lines outside the extraction) are frozen after B0, except for B2's ownership of `services/messages.js`.
- Cross-batch dependencies are call contracts only: B2→B1 (`flags`), B5→B6 (`systemChannelAllows`), B7→B4 (`isDmPaused`), B9→B1 (`notifyUsers`), B9→B2 (`createMessage`), B2→B8 (`getCommandSuggestions`). Stub each on the caller's side if the callee has not landed yet.
