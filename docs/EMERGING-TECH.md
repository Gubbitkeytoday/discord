# Emerging technology scan (2025–2026)

Research date: **2026-09-26**. Scope: what is *new* since, or not covered by,
[ROADMAP.md](ROADMAP.md), [RESEARCH.md](RESEARCH.md) and
[DISCORD-PARITY.md](DISCORD-PARITY.md). Items those documents already settle
(Web Push basics, TURN, LiveKit-as-SFU choice, Litestream-as-idea, ALTCHA, FTS5
trigram, `Intl.Segmenter`, `role="log"`) are only revisited when something
changed in 2025–2026 that alters the *how*.

Stack assumed (from `package.json`, `realtime.js`, `src/`): React 19 + Vite 6 +
Tailwind v4.3 SPA (plain JSX, `App.jsx` ~2.5k lines, `ChatArea.jsx` ~1.8k
lines), Node 22 + Express 4 + Socket.IO 4.8 (in-memory adapter, no
`connectionStateRecovery` yet), `sqlite3` with FTS5, WebRTC mesh
(`src/hooks/useVoicePeers.js`, `useVoiceMedia.js`) moving to LiveKit.

**Maturity labels:** `Production` (stable API, shipped in all engines we need or
a stable 1.0+ library) · `Maturing` (stable in some engines / 1.0 but young) ·
`Experimental` (flags, drafts, one engine). **Effort:** S ≤ 2 days · M ≤ 2 weeks ·
L > 2 weeks. Some sources are search-result summaries of pages that were not
fetched in full; those are marked *(summary)*. Vendor performance numbers are
indicative only.

---

## สรุปภาษาไทย

**ภาพรวม:** ปี 2025–2026 เป็นปีที่ "แพลตฟอร์มเว็บตามทันแอป native" หลายอย่างที่เมื่อก่อนต้องใช้ไลบรารีหนักๆ
หรือทำได้แค่ใน Chrome ตอนนี้ใช้ได้ทุกเบราว์เซอร์แล้ว (Baseline) เช่น Popover + CSS Anchor Positioning
(แทน Floating UI), Navigation API, Trusted Types, WebTransport (Safari 26.4), WebGPU (Safari 26 / Firefox 141),
Encoded Transform สำหรับ E2EE ของสื่อ และ Document Picture-in-Picture (Chrome + Firefox 151)
ฝั่ง React มี React Compiler 1.0, React 19.2 (`<Activity>`), Vite 8 (Rolldown), TypeScript 7 (คอมไพเลอร์ Go เร็วขึ้น ~10 เท่า)
และ Vitest 4 (browser mode เสถียร) ฝั่งเซิร์ฟเวอร์ Node 24 เป็น LTS หลัก (type-stripping และ permission model เสถียร)
ส่วน Node 22 จะหมดอายุ 30 เม.ย. 2027

**สิ่งที่ควรทำทันที (Adopt):**
1. Socket.IO Connection State Recovery + Redis Streams adapter (รองรับ Valkey) + ดึงข้อความที่พลาดผ่าน REST และใช้ BroadcastChannel/Web Locks ให้หลายแท็บใช้ socket เดียว
2. Web Push แบบ Declarative (Safari 18.4+) + Badging API (ตัวเลขบนไอคอน PWA ใน iOS)
3. Passkeys ตาม WebAuthn Level 3 (เป็น W3C Recommendation ส.ค. 2026): autofill (conditional UI), อัปเกรดเป็น passkey อัตโนมัติ, Signal API
4. LiveKit + multi-codec simulcast (VP8 สำรอง + AV1/VP9 SVC) และ E2EE ของ LiveKit (Encoded Transform เป็น Baseline แล้ว)
5. Trusted Types + CSP แบบ nonce/strict-dynamic (Trusted Types เป็น Baseline ก.พ. 2026)
6. Frontend: TypeScript + TanStack Query v5 + Zustand + React Compiler 1.0 + Vite 8, ใช้ Popover/Anchor/View Transitions ใน design system
7. OpenTelemetry JS SDK 2.0 ฝั่งเซิร์ฟเวอร์ + `grafana/otel-lgtm` เป็น compose profile, Litestream 0.5 สำหรับ PITR, ย้ายไป Node 24

**ลองใช้ (Trial):** หน้าต่างเสียง/วิดีโอลอย (Document PiP) แบบ Discord, ลดเสียงรบกวนฝั่ง client ด้วย RNNoise WASM,
แปลข้อความแบบ on-device (Chrome Translator API) + LibreTranslate ที่ host เอง, ถอดเสียงข้อความเสียงด้วย Whisper/Moonshine ในเบราว์เซอร์ (WebGPU),
WHIP ingress สำหรับ "Go Live" จาก OBS, ค้นหาเชิงความหมายด้วย sqlite-vec, Biome 2, TypeScript 7, Docker Hardened Images + SBOM + cosign

**ติดตามดู (Assess):** local-first sync (Zero 1.0, Electric + TanStack DB), Media over QUIC, E2EE ของ DM ด้วย MLS (ts-mls),
Element Capture, Centrifugo, DeepFilterNet, WebLLM, Bun/Deno

**ยังไม่ควรใช้ (Hold):** Shared Storage (Chrome เลิกแล้ว), Opus DRED (เบราว์เซอร์ยังไม่รองรับ), AV1 เป็น codec หลัก (Safari เข้ารหัสไม่ได้),
LiteFS, React Server Components (เราเป็น SPA), CRDT สำหรับข้อความแชท, ระบบ Orbs/Quests แบบ Discord

**ความเสี่ยงหลัก:** ฟีเจอร์ AI ต้องเป็นแบบ opt-in และประมวลผลบนเครื่องผู้ใช้หรือเซิร์ฟเวอร์ที่ host เองเป็นค่าเริ่มต้น
(ไม่ส่งข้อความไปบุคคลที่สาม) เพื่อไม่ขัดหลักการ "ไม่ต้องมีบัญชีบุคคลที่สาม" ใน ROADMAP และ PDPA

---

## Contents

1. [Web platform](#1-web-platform)
2. [Realtime and data](#2-realtime-and-data)
3. [Voice and video](#3-voice-and-video)
4. [Security and identity](#4-security-and-identity)
5. [React / frontend toolchain](#5-react--frontend-toolchain)
6. [Runtime and operations](#6-runtime-and-operations)
7. [Practical, privacy-respecting AI](#7-practical-privacy-respecting-ai)
8. [Competitor moves 2025–2026](#8-competitor-moves-20252026)
9. [Technology radar](#9-technology-radar)
10. [Top 15 recommendations mapped to phases](#10-top-15-recommendations-mapped-to-phases)

---

## 1. Web platform

### 1.1 Document Picture-in-Picture — pop-out voice/video panel
- **What:** `documentPictureInPicture.requestWindow()` opens an always-on-top
  window that can hold *arbitrary DOM*, not just a `<video>`. This is exactly
  Discord desktop's pop-out call window, in a browser tab.
- **Maturity / support:** `Maturing`. Chromium desktop since 116; **Firefox 151
  shipped it (May 2026)**; Safari has no support (fallback: classic video PiP via
  `requestPictureInPicture()` on one `<video>`). Not on mobile.
  [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Document_Picture-in-Picture_API) ·
  [Chrome docs](https://developer.chrome.com/docs/web-platform/document-picture-in-picture) ·
  [Firefox bug 2006594](https://bugzilla.mozilla.org/show_bug.cgi?id=2006594) ·
  [Jitsi shipped it for meetings](https://jitsi.org/blog/introducing-document-pip-for-browser-meetings/)
- **Here:** a "Pop out" button in `src/components/VoiceRoom.jsx` / `CallPanel.jsx`
  that moves the participant grid + mute/deafen/leave controls into the PiP
  window via a React portal (copy stylesheets into the PiP document; Tailwind v4
  emits one CSS file so this is simple). Keeps voice usable while the user browses
  other channels or other tabs.
- **Effort:** S/M. **Impact:** high (visible "feels like Discord desktop" moment).
  **Risk:** low — pure progressive enhancement; must feature-detect.

### 1.2 Popover API, CSS anchor positioning, `popover="hint"`, `interestfor`, customizable `<select>`
- **What:** native top-layer popovers with light-dismiss, positioned relative to
  an anchor in pure CSS; `hint` popovers + interest invokers for hover cards and
  tooltips; `appearance: base-select` for styleable selects.
- **Maturity / support:** Popover API is Baseline (2024). **Anchor positioning
  became Baseline in January 2026** when Firefox 147 shipped (Chrome 125, Safari
  26); newer sub-features (`position-visibility`, `anchor-size()`) still have
  interop bugs. `popover="hint"`, `interestfor` and customizable select are
  Chromium-first (`Experimental`/`Maturing`); `hint` falls back to `manual`.
  [web-features #3558](https://github.com/web-platform-dx/web-features/issues/3558) ·
  [OddBird update](https://www.oddbird.net/2025/10/13/anchor-position-area-update/) ·
  [MDN position-anchor](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/position-anchor) ·
  [Chrome: customizable select](https://developer.chrome.com/blog/a-customizable-select) ·
  [MDN Popover](https://developer.mozilla.org/en-US/docs/Web/API/Popover_API/Using)
- **Here:** the app has many hand-positioned floating layers: `ContextMenu.jsx`,
  `MessageContextMenu.jsx`, `MemberContextMenu.jsx`, `EmojiPicker.jsx`,
  `StickerPicker.jsx`, `NotificationSettingsPopover.jsx`,
  `PinnedMessagesPopover.jsx`, `UserStatusMenu.jsx`, `ServerDropdown.jsx`,
  `ComposerAutocomplete.jsx`. Rebuild these on `popover` + anchor positioning
  as Phase 3 design-system primitives (`<Popover>`, `<Menu>`, `<Tooltip>`,
  `<HoverCard>` for user mini-profiles). Removes z-index fights, focus-trap code
  (`useFocusTrap.js` shrinks to modal-only) and viewport-edge math.
- **Effort:** M (part of design system). **Impact:** medium-high (less code, fewer
  a11y bugs). **Risk:** low for popover/anchor; keep a JS fallback for
  `hint`/`interestfor`.

### 1.3 View Transitions (same-document)
- **What:** `document.startViewTransition()` animates between DOM states.
- **Support:** same-document is **Baseline** (Chrome 111, Safari 18, Firefox 144).
  Cross-document is not Baseline (Firefox missing) — irrelevant for our SPA.
  [web.dev](https://web.dev/blog/same-document-view-transitions-are-now-baseline-newly-available) ·
  [CSS-Tricks cross-doc gotchas](https://css-tricks.com/cross-document-view-transitions-part-1/)
- **Here:** server switch in `ServerRail.jsx`, channel switch, opening a thread
  side panel, image lightbox (`ImageLightboxModal.jsx`) morph from thumbnail.
  Wrap state updates in `startViewTransition` inside a small `useViewTransition`
  hook; respect `prefers-reduced-motion` (already an accessibility setting).
- **Effort:** S. **Impact:** medium (polish). **Risk:** low.

### 1.4 Navigation API
- **What:** `navigation.navigate()` / `navigate` event interception replaces
  `history.pushState` + popstate hacks.
- **Support:** **Baseline Newly Available January 2026** (Chrome, Firefox 147,
  Safari 26.2; Safari lacks `precommitHandler`).
  [web.dev](https://web.dev/blog/baseline-navigation-api) ·
  [InfoQ](https://www.infoq.com/news/2026/05/navigation-api-browser/)
- **Here:** the SPA has no router today (state lives in `App.jsx`). If Phase 3
  adopts TanStack Router it handles history for us; otherwise a tiny router on the
  Navigation API gives deep links `/channels/:guild/:channel/:message` (needed for
  push-notification click targets and share links).
- **Effort:** S (if bundled with the router work). **Impact:** medium. **Risk:** low.

### 1.5 Web Push: Declarative Web Push + Badging API
- **What's new beyond ROADMAP P0-1:** Safari 18.4 (iOS) / 18.5 (macOS) accept a
  **declarative push payload** (JSON with `web_push: 8030`, title, body,
  `navigate` URL, `app_badge`) that the OS displays *without waking a service
  worker* — more reliable on iOS where SW wake-ups are throttled and silent pushes
  can revoke permission. It is a W3C Working Draft; Chromium/Firefox have not
  shipped it, but the payload degrades to a normal push event there, so one
  format works everywhere. The **Badging API** (`navigator.setAppBadge(n)`) works
  for iOS 16.4+ Home-Screen apps and installed Chrome/Edge PWAs on Windows/macOS.
  [WebKit: Meet Declarative Web Push](https://webkit.org/blog/16535/meet-declarative-web-push/) ·
  [Safari 18.4 features](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/) ·
  [W3C Push API WD 2025-09](https://www.w3.org/TR/2025/WD-push-api-20250910) ·
  [WebKit badging](https://webkit.org/blog/14112/badging-for-home-screen-web-apps/) ·
  [MDN badge](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/How_to/Display_badge_on_app_icon)
- **Here:** in the planned `services/push.js`, emit the declarative JSON shape
  (with `app_badge` = total unread mentions) and keep a `push` handler in
  `public/sw.js` for Chromium/Firefox. Call `setAppBadge` from
  `src/utils/notifier.js` whenever unread-mention totals change.
- **Effort:** S on top of P0-1. **Impact:** high on iOS. **Risk:** low.

### 1.6 Multi-tab coordination: BroadcastChannel + Web Locks
- **What:** both Baseline for years, but rarely used in chat SPAs. Web Locks
  elect a "leader" tab; BroadcastChannel fans events to the others.
- **Here:** today every tab opens its own Socket.IO connection, receives the same
  fan-out and plays the same notification sound (`soundEffects.js`,
  `notifier.js`). Leader tab holds the socket and relays events; follower tabs
  send via the channel. Halves server fan-out for multi-tab users, dedupes
  notifications/sounds, and keeps read-state consistent across tabs.
  [MDN Web Locks](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API) ·
  [MDN BroadcastChannel](https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel)
- **Effort:** M. **Impact:** medium (server load + UX). **Risk:** medium (leader
  hand-off edge cases; keep a per-tab fallback flag).

### 1.7 Screen capture improvements
- **What:** `CaptureController.setFocusBehavior('no-focus-change')` keeps focus
  on our app after the user picks a tab to share; Captured Surface Control lets
  the sharer scroll/zoom the shared tab from our UI; **Region Capture**
  (`cropTo`) and **Element Capture** (`restrictTo`) share only part of the own
  tab. `displaySurface`/`monitorTypeSurfaces`/`surfaceSwitching` hints tune the
  picker.
- **Support:** `Maturing`/`Experimental`, Chromium-only for controller extras and
  element/region capture.
  [MDN setFocusBehavior](https://developer.mozilla.org/en-US/docs/Web/API/CaptureController/setFocusBehavior) ·
  [Chrome Element Capture](https://developer.chrome.com/docs/web-platform/element-capture) ·
  [MDN Captured Surface Control](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Capture_API/Captured_Surface_Control)
- **Here:** `src/hooks/useVoiceMedia.js` `getDisplayMedia` call (~L378): pass a
  `CaptureController` with `no-focus-change` when available, add
  `surfaceSwitching: 'include'` so users can switch shared tab without
  restarting Go Live. Element Capture could later share an Activity iframe only.
- **Effort:** S. **Impact:** medium. **Risk:** low (feature-detected).

### 1.8 WebCodecs, Compression Streams, WebGPU
- **WebCodecs:** Safari 26 added `AudioEncoder`/`AudioDecoder`, so WebCodecs is
  near-Baseline (Firefox Android gaps). `Maturing`.
  [WebKit Safari 26.0](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/) ·
  [Codec data from 1M devices](https://webcodecsfundamentals.org/datasets/codec-analysis-2026/)
  **Here:** client-side video poster frames and downscaled previews before upload
  (offloads the optional ffmpeg in ROADMAP P1-9), Opus voice notes
  (`src/utils/voiceNote.js`) encoded at a fixed bitrate instead of
  `MediaRecorder` container quirks. Effort M, impact medium.
- **Compression Streams:** gzip/deflate Baseline; Chrome and Firefox also accept
  `brotli`/`zstd` formats *(summary)*.
  [MDN](https://developer.mozilla.org/en-US/docs/API/CompressionStream/CompressionStream) ·
  **Here:** compress data-export downloads and large offline caches client-side.
  Effort S, impact low.
- **WebGPU:** shipped in Chrome, Firefox 141 (Windows) and Safari 26 (all Apple
  platforms). `Production` for inference use.
  [SitePoint benchmarks](https://www.sitepoint.com/webgpu-vs-webasm-transformers-js/) —
  enabler for §7 on-device AI, not a feature by itself.

### 1.9 Speculation Rules, Storage Buckets, Shared Storage, File System Access, scroll-driven animations
- **Speculation Rules:** Chromium-only; Safari behind a flag; built for MPAs.
  Minimal value for a SPA — at most prerender `/invite/:code` landing pages.
  [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Speculation_Rules_API). *Hold.*
- **Storage Buckets:** Chrome 122+, Safari 18+ *(summary)*, not Firefox. Could
  isolate an offline message cache from drafts so the browser evicts the cache
  first. [Chrome docs](https://developer.chrome.com/docs/web-platform/storage-buckets). *Assess.*
- **Shared Storage:** **deprecated and being removed from Chrome** after Privacy
  Sandbox was wound down. [blink-dev intent](https://groups.google.com/a/chromium.org/g/blink-dev/c/uh5Ke6qyegc). *Hold.*
- **File System Access:** Chromium-only for the picker APIs; OPFS is Baseline and
  is what matters (model weight caches, SQLite-WASM). *Hold* the picker; use OPFS.
- **Scroll-driven animations:** Chrome + Safari 26; Firefox still flagged as of
  152 (Interop 2026 focus). Nice for "jump to present" pill fade, but progressive
  only. [web-features](https://web-platform-dx.github.io/web-features-explorer/features/scroll-driven-animations/). *Assess.*

---

## 2. Realtime and data

### 2.1 Socket.IO: connection-state recovery + the right adapter
- **Status:** Socket.IO 4.8 (Sep 2024; 4.8.x patches through 2025) added pluggable
  transport implementations including a built-in **WebTransport** transport and
  `tryAllTransports`. Connection State Recovery (CSR) works only with the
  in-memory, **Redis Streams** (also Valkey-compatible) and MongoDB adapters; the
  Postgres adapter announced CSR "in the next release" but it is not a safe bet
  today.
  [4.8.0 changelog](https://socket.io/docs/v4/changelog/4.8.0) ·
  [CSR docs](https://socket.io/docs/v4/connection-state-recovery) ·
  [Redis Streams adapter](https://socket.io/docs/v4/redis-streams-adapter/) ·
  [Postgres adapter](https://socket.io/docs/v4/postgres-adapter/)
- **Here (beyond ROADMAP P0-2):** `realtime.js` has neither CSR nor an adapter.
  Step 1: in-memory CSR + REST `after=` gap-fill (already planned). Step 2
  (Phase 2 "Redis"): Redis Streams adapter on **Valkey** (BSD-licensed Redis fork)
  as an *optional* compose profile, so multi-node keeps CSR. Also move
  `lib/rateLimit.js` buckets to the same Valkey when the profile is on. Skip the
  Postgres adapter even after a Postgres migration until it supports CSR.
- **Effort:** S (step 1) / M (step 2). **Impact:** high. **Risk:** low.

### 2.2 Alternatives to Socket.IO (uWebSockets.js, Centrifugo, NATS)
- **Centrifugo v6** (Jan 2025, active v6.x releases in 2026): Go server with
  WebSocket/SSE/HTTP-streaming/**WebTransport**, history + recovery by stream
  offsets, presence, Redis/NATS brokers.
  [v6 announcement](https://centrifugal.dev/blog/2025/01/16/centrifugo-v6-released) ·
  [releases](https://github.com/centrifugal/centrifugo/releases)
- **uWebSockets.js:** far lower memory per socket, but no rooms/ack/CSR — we
  would rebuild Socket.IO.
- **NATS:** good inter-node bus (JetStream gives replay), not a browser protocol
  for us.
- **Verdict:** *Assess* Centrifugo only if P0-6 load tests show the Node event
  loop saturating on fan-out at <1k sockets; otherwise Socket.IO + Valkey is the
  lowest-risk path. Re-writing the gateway is L effort and high risk.

### 2.3 WebTransport and Media over QUIC (MoQ)
- **WebTransport is Baseline since Safari 26.4 (March/April 2026)**; Chrome 97,
  Firefox 114. Some libraries still keep Safari on the WebSocket fallback due to
  WebKit bugs in long sessions *(summary)*.
  [webrtc.ventures](https://webrtc.ventures/2026/04/webtransport-is-now-baseline-what-it-means-for-real-time-media/)
- **MoQ:** IETF draft (draft-17, Mar 2026), not an RFC; Cloudflare/Akamai/Wowza
  have implementations; interop testing ongoing.
  [IETF moq WG](https://datatracker.ietf.org/group/moq/about/) ·
  [moq.dev](https://doc.moq.dev/concept/transport) ·
  [Trembit: WebRTC vs MoQ](https://trembit.com/blog/webrtc-vs-media-over-quic-moq-what-startups-need-to-know-in-2026/)
- **Here:** Socket.IO's WebTransport transport needs an HTTP/3 server
  (`@fails-components/webtransport` or a QUIC-capable proxy) — our Caddy/nginx
  front would need HTTP/3 pass-through for the upgrade. Gains (no head-of-line
  blocking on lossy mobile links) are real but modest for chat text. MoQ is the
  interesting long-term path for **large one-to-many Go Live / stage** fan-out
  (thousands of viewers) but not before it is an RFC with a self-hostable relay.
- **Verdict:** WebTransport *Assess*; MoQ *Assess* (revisit 2027).

### 2.4 Local-first sync engines (Zero, Electric + TanStack DB, PowerSync, Replicache) and CRDTs
- **Zero 1.0** (Rocicorp, **8 June 2026**): client library + read-only Postgres
  cache; queries run locally, instant UI.
  [InfoQ](https://www.infoq.com/news/2026/06/zero-version-1/) ·
  [When to use Zero](https://zero.rocicorp.dev/docs/when-to-use)
- **Electric 1.0** (GA March 2025) syncs Postgres "shapes"; **TanStack DB 0.6**
  (March 2026) adds SQLite-backed persistence in browser/Node/React Native.
  [Electric 1.0](https://electric-sql.com/blog/2025/03/17/electricsql-1.0-released) ·
  [TanStack DB 0.6](https://electric-sql.com/blog/2026/03/25/tanstack-db-0.6-app-ready-with-persistence-and-includes)
- **Replicache** is effectively superseded by Zero; **PowerSync** targets
  Postgres/Mongo → SQLite on device.
- **CRDTs:** Automerge 3.0 (July 2025) cut memory ~10× by keeping the columnar
  format in memory; Yjs remains the default for collaborative text.
  [Automerge 3.0](https://automerge.org/blog/automerge-3/)
- **Here:** all mature sync engines require **Postgres logical replication**; we
  are SQLite-first and permissions are computed per channel in
  `services/channelPerms.js` — a sync engine must re-express that permission
  model as sync rules, which is the hard part. Chat messages are append-mostly
  with a single authoritative order: a CRDT adds nothing there. Better near-term
  pattern: **TanStack Query cache persisted to IndexedDB + an outbox of unsent
  messages** (client-generated snowflake/nonce, idempotent `POST`, retry on
  reconnect, "failed — retry" UI). Yjs is worth it only for a future collaborative
  feature (shared notes/canvas in a channel, Slack-canvas style).
- **Verdict:** Zero/Electric/TanStack DB *Assess* (only after a Postgres move);
  offline outbox *Adopt* in Phase 3; CRDT-for-messages *Hold*; Yjs *Assess* for
  canvases.

### 2.5 Postgres LISTEN/NOTIFY, logical replication, pgvector
- LISTEN/NOTIFY is fine as a cross-node invalidation bus at small scale (payload
  ≤ 8 kB, no persistence, one global queue lock on commit under heavy NOTIFY);
  logical replication is what sync engines and CDC use.
- **pgvector 0.8** (Nov 2024) added *iterative index scans* so filtered ANN
  queries (e.g. `WHERE channel_id IN (visible channels)`) no longer under-return
  results — essential for permission-filtered semantic search.
  [PostgreSQL news](https://www.postgresql.org/about/news/pgvector-080-released-2952)
- SQLite counterpart: **sqlite-vec** (`vec0` virtual tables, pure C, no deps).
- **Here:** no Postgres code exists yet (`db.js` is `sqlite3`). If Phase 2+ adds
  semantic search, start with sqlite-vec next to `messages_fts`
  (`db/schema.sql` ~L403) and a hybrid rank (FTS5 BM25 + vector), then pgvector if
  and when Postgres lands. **Effort** M, **Impact** medium, **Risk** medium
  (embedding cost/storage; must respect channel permissions server-side).

---

## 3. Voice and video

### 3.1 LiveKit in 2026: what changed that matters to us
- **Multi-codec simulcast:** publisher sends AV1 (or VP9) SVC *plus* a VP8
  simulcast backup so Safari subscribers (no AV1/VP9 encode) still receive video.
  In 2026 simulcast is default for VP8/H.264; SVC default for VP9/AV1 in
  Chromium.
  [LiveKit codecs](https://docs.livekit.io/transport/media/advanced/) ·
  [SVC vs simulcast 2026](https://www.digitalsamba.com/blog/svc-vs-simulcast-in-webrtc)
- **Noise cancellation:** Krisp / ai-coustics "enhanced NC" is a **LiveKit Cloud**
  feature; self-hosted SFUs can use ai-coustics with their own licence key, or
  self-hosted open models (DTLN, DeepFilterNet3 plugins) inside *agents*.
  [LiveKit NC docs](https://docs.livekit.io/transport/media/noise-cancellation/) ·
  [livekit-plugins-dtln](https://github.com/aloware/livekit-plugins-dtln)
- **Agents** (Python/Node, 1.6.x in July 2026): server-side participants for
  STT/TTS/LLM. Note a reported break between server v1.9.9+ and agents 1.3.10 —
  pin versions together.
  [agents releases](https://github.com/livekit/agents/releases) ·
  [issue #4223](https://github.com/livekit/livekit/issues/4223)
- **Ingress/Egress:** RTMP and **WHIP** ingress (OBS → room), egress for
  recording or RTMP out. Self-hosted ingress/egress are separate services.
  [Ingress docs](https://docs.livekit.io/transport/self-hosting/ingress/) ·
  [livekit/ingress](https://github.com/livekit/ingress)
- **Peer evidence:** Stoat moved to LiveKit in Feb 2026 and added per-node
  latency checks and `restrictOwnAudio` for screen share.
  [Stoat updates](https://stoat.chat/updates) ·
  [releases](https://github.com/stoatchat/stoatchat/releases)
- **Here (ROADMAP P1-2 refinements):** in the LiveKit client path replacing
  `useVoicePeers.js`: enable `dynacast`, `adaptiveStream`, `red: true` for audio,
  `videoCodec: 'vp9'` or `'av1'` with `backupCodec: { codec: 'vp8' }`;
  screenshare with `restrictOwnAudio`/`suppressLocalAudioPlayback`. Keep
  agents/ingress/egress as *separate optional profiles* in `docker-compose.yml`.
- **Effort:** L (already planned). **Impact:** high. **Risk:** medium (ops of an
  extra service; version pinning).

### 3.2 Client-side noise suppression: RNNoise / DeepFilterNet in WASM
- **What:** run a denoiser in an `AudioWorklet` on the mic track before it is
  published. RNNoise-WASM (Jitsi) is tiny and free; DeepFilterNet3 is clearly
  better on non-stationary noise but heavier.
  [jitsi/rnnoise-wasm](https://github.com/jitsi/rnnoise-wasm) ·
  [boredland/noise (DFN3 WASM)](https://github.com/boredland/noise) ·
  [Fora Soft comparison](https://www.forasoft.com/learn/ai-for-video-engineering/articles-ai/real-time-noise-suppression-krisp-rnnoise-deepfilternet-integration) *(summary)*
- **Maturity:** RNNoise `Production`; DFN3-in-browser `Experimental`.
- **Here:** `useVoiceMedia.js` builds the mic stream (~L113) with the browser's
  `noiseSuppression` flag; add a setting in `VoiceSettings.jsx`: *Noise
  suppression: Off / Standard (browser) / Enhanced (RNNoise)*. Works identically
  on mesh and LiveKit, and gives "Krisp-like" UX with zero third parties. CSP
  needs `'wasm-unsafe-eval'` in `script-src` (`lib/middleware.js`).
- **Effort:** M. **Impact:** high (voice quality is a top churn reason). **Risk:**
  low-medium (CPU on low-end phones → default off on mobile).

### 3.3 Opus DRED / in-band FEC / RED
- **DRED** (Opus 1.5, improved in Opus 1.6 Dec 2025) carries up to ~1 s of
  neural redundancy per packet; IETF draft-05 (Jan 2026). **Not in libwebrtc /
  browsers yet.** [bloggeek DRED](https://bloggeek.me/webrtcglossary/dred/) ·
  [IETF draft](https://datatracker.ietf.org/doc/draft-ietf-mlcodec-opus-dred/)
- **Usable today:** Opus in-band FEC (`useinbandfec=1`, default in Chrome) and
  **RED** (redundant audio, supported by LiveKit via `red: true`).
- **Verdict:** DRED *Hold*; RED via LiveKit *Adopt* (config flag).

### 3.4 E2EE media: DAVE / MLS / Encoded Transform
- **Discord DAVE:** MLS (RFC 9420) group key agreement with the server as
  external sender + per-frame AEAD via encoded transforms; all Discord calls
  E2EE-only since 1 March 2026; `libdave` (C++/JS) is open source.
  [libdave](https://github.com/discord/libdave) ·
  [whitepaper](https://daveprotocol.com/) ·
  [voice docs](https://docs.discord.com/developers/topics/voice-connections)
- **Browser primitive:** the standard `RTCRtpScriptTransform` is now in Safari,
  Firefox and Chrome *(summary; Chrome's legacy `createEncodedStreams` is still
  common in libraries)*.
  [antmedia 2026 support guide](https://antmedia.io/webrtc-browser-support/)
- **Here:** RESEARCH/ROADMAP already reject a home-grown DAVE. What's new: the
  browser side is no longer the blocker, and LiveKit's E2EE (shared key or
  key-provider) runs on it. Recommended: a per-room **"E2EE" toggle for DMs and
  private voice channels on the LiveKit path**, keys distributed through our
  authenticated socket (server-known key = "transport E2EE", honest labelling),
  with MLS-based key agreement as an *Assess* upgrade using `libdave`'s JS build
  or `ts-mls`.
- **Effort:** M (LiveKit E2EE toggle) / L (MLS). **Impact:** medium (marketing +
  trust after Discord's move). **Risk:** medium (breaks server-side recording and
  any future transcription agent in that room — must be mutually exclusive).

### 3.5 AV1 / SVC
- Chrome encodes AV1 in real time (CPU-heavy); **Safari exposes no AV1 or VP9
  encode in WebRTC**; broad cross-browser AV1 SVC is not expected before ~2028
  *(summary)*. [Forasoft on SVC/simulcast](https://www.forasoft.com/learn/video-streaming/articles-streaming/simulcast-svc-sfu)
- **Verdict:** AV1 as *primary* codec *Hold*; AV1/VP9 SVC **with VP8 backup** on
  LiveKit *Trial* for screen share (where AV1's screen-content tools shine).

### 3.6 Spatial audio
- Web Audio `PannerNode` (HRTF) per remote participant. Only compelling for
  "proximity" activities or stage rooms; cheap to prototype on the receive side
  (`VoiceRoom.jsx` already has per-user volume).
- **Verdict:** *Assess* (S effort, niche impact).

### 3.7 WHIP/WHEP for "Go Live"
- **WHIP** (RFC 9725, 2025) = one HTTP POST to publish WebRTC; OBS 30+ has a WHIP
  output; **WHEP** (draft) for playback. LiveKit ingress speaks WHIP.
- **Here:** "Stream from OBS" in a voice channel: server calls LiveKit
  `CreateIngress` after a `STREAM` permission check in a new route, returns a
  WHIP URL + bearer token shown in channel settings.
- **Effort:** M. **Impact:** medium (streamers). **Risk:** low (optional profile).

---

## 4. Security and identity

### 4.1 Passkeys with WebAuthn Level 3
- **Status:** **WebAuthn L3 published as a W3C Recommendation (25 Aug 2026).**
  New: JSON (de)serialisation (`PublicKeyCredential.parseCreationOptionsFromJSON`),
  **conditional mediation for create** ("automatic passkey upgrade" after a
  password autofill), `getClientCapabilities()`, **Signal API** (tell the
  password manager a credential was deleted / user renamed), related-origin
  requests, `prf` extension. Signal API is Chromium-first; others uneven.
  [startwithidentity](https://startwithidentity.com/blog/2026-08-31-webauthn-level-3-becomes-a-w3c-recommendation/) ·
  [Corbado L3 capability benchmark](https://www.corbado.com/passkey-benchmark-2026/webauthn-client-capabilities) ·
  [Tim Cappalli](https://blog.timcappalli.me/p/webauthn-3/)
- **Here:** ROADMAP P1-10 lists passkeys as a 2FA option. Go further:
  passkey **as primary login** with conditional UI (`autocomplete="username
  webauthn"` on the `LoginScreen.jsx` username field), automatic upgrade after
  password login, Signal API calls when a passkey is removed in
  `AccountSecurityTab.jsx`. Server: `routes/accountSecurity.js` +
  new `webauthn_credentials` table; use `@simplewebauthn/server` (maintained,
  L3-aware) rather than hand-rolling CBOR/COSE. `prf` could later derive a key
  for encrypted DM backups.
- **Effort:** M. **Impact:** high (phishing-resistant, fewer password resets,
  reduces TOTP support burden). **Risk:** low.

### 4.2 OAuth 2.1 for the bot/app platform
- OAuth 2.1 is still an Internet-Draft (draft-15, Mar 2026), but its rules
  (PKCE mandatory, no implicit grant, exact redirect matching, refresh-token
  rotation) are the de-facto baseline.
  [draft-ietf-oauth-v2-1-15](https://datatracker.ietf.org/doc/html/draft-ietf-oauth-v2-1-15) ·
  [oauth.net/2.1](https://oauth.net/2.1/)
- **Here:** `services/applications.js` has bot tokens; a "Login with <instance>"
  / "authorize app to server" flow (Discord's OAuth2 bot-invite) should be
  OAuth 2.1-shaped from day one. Matrix's move to native OIDC (MAS) shows the
  direction for self-hosted chat.
  [Matrix native OIDC](https://matrix.org/blog/2024/10/29/matrix-2.0-is-here/)
- **Effort:** M. **Impact:** medium. **Risk:** medium (auth code is
  security-critical — use a vetted library such as `oidc-provider`).

### 4.3 Trusted Types, CSP strict-dynamic, SRI, COOP/COEP
- **Trusted Types is Baseline since Feb 2026** (Firefox 148; Safari 26; Chrome 83).
  [caniuse](https://caniuse.com/trusted-types) ·
  [URIports guide](https://www.uriports.com/blog/csp-trusted-types/)
- **Here:** `lib/middleware.js` sets CSP + COOP. Add
  `require-trusted-types-for 'script'; trusted-types default dompurify` in
  report-only first, then enforce. Audit `dangerouslySetInnerHTML` in
  `markdownParser.jsx`, `RichEmbed.jsx`, `LinkEmbed.jsx`. Nonce-based
  `script-src 'nonce-…' 'strict-dynamic'` is only needed if we ever inline
  scripts (Vite output is external files, so `'self'` is already strict). **SRI**
  on Vite chunks is low value when same-origin. **COEP `require-corp`/
  `credentialless`** would unlock `SharedArrayBuffer` (faster WASM threads for
  DFN3/Whisper) but breaks third-party embeds in `LinkEmbed.jsx` — only enable on
  a dedicated worker route if needed.
- **Effort:** S/M. **Impact:** high (DOM-XSS class eliminated in a UGC app).
  **Risk:** low with report-only rollout.

### 4.4 MLS (RFC 9420) for E2EE DMs
- Libraries: **ts-mls** (TypeScript, browser + Node, PQ ciphersuites incl.
  X-Wing), **OpenMLS** (Rust→WASM).
  [ts-mls](https://github.com/LukaJCB/ts-mls) · [OpenMLS](https://github.com/openmls/openmls)
- ROADMAP explicitly says *no text E2EE* (breaks search, AutoMod, reports). That
  still holds for servers. For **1:1 and group DMs only**, an opt-in "secret DM"
  mode is now technically feasible with ts-mls + passkey-PRF-protected key
  backup. It is a large, security-sensitive project (device management,
  key backup, multi-device).
- **Verdict:** *Assess* (L effort, medium impact, high risk).

---

## 5. React / frontend toolchain

### 5.1 React Compiler 1.0 + React 19.2
- **React Compiler 1.0** shipped **7 Oct 2025**: automatic memoization, no
  `useMemo`/`useCallback`/`memo` boilerplate. With **Vite 8 + `@vitejs/plugin-react`
  v6 (oxc, no Babel)** it is wired via `@rolldown/plugin-babel` *(summary)*.
  [React blog](https://react.dev/blog/2025/10/07/react-compiler-1) ·
  [Vite 8 wiring note](https://recca0120.github.io/en/2026/04/14/react-compiler-vite-v6/)
- **React 19.2** (1 Oct 2025): `<Activity mode="hidden">` keeps a subtree's state
  while unmounting its effects; `useEffectEvent`.
  [React 19.2](https://www.react.dev/blog/2025/10/01/react-19-2)
- **Here:** `App.jsx` (2.5k lines) and `ChatArea.jsx` (1.8k lines) re-render
  widely; the compiler is the cheapest perf win before the refactor.
  `<Activity>` lets the last 2–3 visited channels stay mounted-but-hidden so
  switching back is instant with scroll position intact. `useEffectEvent` removes
  stale-closure bugs in socket listeners inside `App.jsx`.
  `useOptimistic` + actions for message send (pending → sent → failed) pair with
  the outbox in §2.4.
- **Effort:** S (compiler) / M (Activity + optimistic send). **Impact:** high.
  **Risk:** low (compiler bails out on rule-breaking components; run
  `eslint-plugin-react-hooks` compiler rules first).

### 5.2 Server Components
- Irrelevant for this self-hosted SPA: no SSR server framework, auth is
  cookie/token per socket, and the UI is realtime-driven. **Hold.**

### 5.3 State and data: TanStack Query v5 + Zustand (+ TanStack Router)
- Query v5 is the standard server-state cache (suspense stable, `useMutationState`
  for optimistic lists); Zustand v5 for client state (open modals, voice UI,
  composer drafts). Jotai fits fine-grained atoms but adds a second mental model.
  TanStack Router gives typed routes/search params for an SPA.
  [TanStack Query v5](https://tanstack.com/query/v5) ·
  [Does Query replace client state?](https://tanstack.com/query/v5/docs/react/guides/does-this-replace-client-state)
- **Here (Phase 3):** `src/api.js` → typed query/mutation hooks; socket events
  write into the Query cache (`queryClient.setQueryData(['messages', channelId],
  …)`) instead of `App.jsx` `useState`; Zustand stores for voice
  (`useVoicePeers`/`useVoiceMedia` state), UI, and settings
  (`useUserSettings.js`). Persist Query cache to IndexedDB for instant
  cold-start.
- **Effort:** L (whole refactor). **Impact:** high. **Risk:** medium
  (incremental migration by feature slice).

### 5.4 Vite 8 / Rolldown, Tailwind v4.1–4.3
- **Vite 8** stable **12 Mar 2026** with Rolldown as the single bundler (reported
  10–30× faster builds); Rolldown 1.0 on 7 May 2026.
  [Vite 8 announcement](https://vite.dev/blog/announcing-vite8) ·
  [InfoQ](https://www.infoq.com/news/2026/05/vite-v8-rust/)
- **Tailwind v4.1** added `text-shadow-*`, `mask-*`, better old-browser
  compatibility; **v4.2** logical-property utilities (good for RTL locales —
  the repo now ships 30+ locales), new palettes; **v4.3** scrollbar utilities.
  [v4.1](https://tailwindcss.com/blog/tailwindcss-v4-1) ·
  [v4.3](https://tailwindcss.com/blog/tailwindcss-v4-3)
- **Here:** `vite.config.js` on Vite 6 → 8 (check `manualChunks` → Rolldown
  `advancedChunks`, plugin-react v6). Use Tailwind `@theme` tokens as the design
  system source of truth; logical utilities (`ps-*`, `me-*`) for RTL.
- **Effort:** S/M. **Impact:** medium (dev speed, RTL). **Risk:** low.

### 5.5 TypeScript 7 (native Go compiler)
- **TS 7.0 stable 8 July 2026** (native `tsc`, ~10× faster type-check). **No
  stable programmatic API until 7.1**, so typescript-eslint type-aware rules still
  need TS 6.x side-by-side.
  [InfoQ](https://www.infoq.com/news/2026/08/typescript-7-released/) ·
  [VS Magazine RC](https://visualstudiomagazine.com/articles/2026/06/22/typescript-7-0-rc-moves-microsofts-go-rewrite-into-the-mainline-compiler.aspx)
- **Here:** Phase 3 TS migration: `allowJs` + `checkJs` incrementally, `tsc
  --noEmit` in `npm run verify`; Vite/oxc strips types. Server can stay JS with
  JSDoc types, or run `.ts` directly on Node 24 type-stripping (§6.1).
- **Effort:** L (migration) / S (tooling). **Impact:** high (refactor safety).
  **Risk:** low-medium (keep TS 6 for lint until 7.1 API).

### 5.6 Lint/format and tests: Biome 2, Vitest 4, Playwright
- **Biome 2** does type-aware linting (e.g. `noFloatingPromises`) without tsc,
  ~450 rules; ESLint still wins on plugin breadth (jsx-a11y, react-hooks compiler
  rules). [Better Stack comparison](https://betterstack.com/community/guides/scaling-nodejs/biome-eslint/)
- **Vitest 4** (22 Oct 2025): **Browser Mode stable**, visual regression,
  Playwright traces. [Vitest 4](https://vitest.dev/blog/vitest-4)
- **Here:** repo has no linter/formatter and tests are `node --test` scripts
  (`scripts/test*.mjs`) + custom `jsx-check`, `a11y-audit`. Add Biome for
  format + lint (fast, one binary) and keep `eslint-plugin-react-hooks` +
  `jsx-a11y` only. Use Vitest 4 browser mode for component tests of the new
  design-system primitives; keep `scripts/e2e` for flows.
- **Effort:** S/M. **Impact:** medium. **Risk:** low.

---

## 6. Runtime and operations

### 6.1 Node 24 LTS (and Node 26)
- **Node 24** is Active LTS: stable **permission model** (`--permission`),
  stable **type stripping** for erasable TS, Undici 7 + `WebSocketStream`, global
  `URLPattern`, native `.env` loading; `node:sqlite` still evolving (RAII
  helpers landed in 24.20). **Node 22 enters EOL 30 Apr 2027**; Node 26 becomes
  LTS 28 Oct 2026.
  [LogRocket Node 24](https://blog.logrocket.com/node-js-24-features/) ·
  [endoflife.date](https://endoflife.date/nodejs) ·
  [Node 24.20 / 26.8](https://www.warp2search.net/story/nodejs-2680-and-24200-krypton-released-native-zip-sqlite-raii-and-permission-updates)
- **Here:** Dockerfile base → Node 24. Run in production with
  `--permission --allow-fs-read=/app --allow-fs-write=/data` (uploads, DB) to
  contain an RCE. `node:sqlite` (synchronous, no native build) is the path to
  drop the `sqlite3` + node-gyp chain behind most `npm audit` advisories (ROADMAP
  P1-10 mentions it) — but `db.js` is callback/async-shaped, so it is an M
  refactor; prototype behind the existing `db.js` interface.
- **Effort:** S (upgrade) / M (node:sqlite). **Impact:** high (security,
  supported runtime). **Risk:** low.

### 6.2 Bun / Deno
- Bun ~95% Node-compatible for Express-class apps; Deno 2 runs npm packages but
  native addons (our `sqlite3`, `sharp`) are the friction.
  [2026 comparison](https://stacknotice.com/blog/bun-deno-nodejs-comparison-2026) *(summary)*
- **Verdict:** *Assess* only as a dev-loop tool; production stays on Node LTS.

### 6.3 Observability: OpenTelemetry JS SDK 2.0 + Grafana LGTM
- **OTel JS SDK 2.0** (2025): traces and metrics stable; logs still
  experimental; browser instrumentation experimental (new
  `opentelemetry-browser` repo).
  [OTel JS 2.0](https://opentelemetry.io/blog/2025/otel-js-sdk-2-0/) ·
  [opentelemetry-browser](https://github.com/open-telemetry/opentelemetry-browser)
- **`grafana/otel-lgtm`**: one container with Collector + Prometheus/Mimir +
  Tempo + Loki + Pyroscope + Grafana — ideal as an opt-in `observability`
  compose profile for self-hosters. Grafana **Alloy** is the production collector.
  [docker-otel-lgtm](https://github.com/grafana/docker-otel-lgtm)
- **Here:** ROADMAP P1-8 plans OTel; concretely: `--import ./otel.mjs` preload
  with `@opentelemetry/sdk-node` + auto-instrumentations + socket.io
  instrumentation, env-gated by `OTEL_EXPORTER_OTLP_ENDPOINT`; keep the existing
  `/metrics` for users who only run Prometheus; ship a Grafana dashboard JSON;
  client Web Vitals + voice `getStats()` (RTT, jitter, packet loss) posted to a
  rate-limited `/api/telemetry` (opt-in).
- **Effort:** M. **Impact:** high (you cannot fix voice you cannot measure).
  **Risk:** low.

### 6.4 SQLite replication: Litestream 0.5 vs LiteFS
- **Litestream 0.5.0** (Oct 2025): new LTX format, fast PITR from a handful of
  files, CGO-free builds; Fly.io re-focused on Litestream over LiteFS. Some early
  adopters advised waiting for 0.5.x patch releases.
  [Fly blog](https://fly.io/blog/litestream-v050-is-here/) ·
  [Simon Willison](https://simonwillison.net/2025/Oct/3/litestream/) ·
  [mtlynch: hold off on 0.5.0](https://mtlynch.io/notes/hold-off-on-litestream-0.5.0/)
- **Here:** P0-7 backup path → Litestream **≥ 0.5.2** sidecar in
  `docker-compose.yml` writing to S3/MinIO; `backup:verify` restores from it.
  LiteFS (FUSE, read replicas) *Hold*.
- **Effort:** S. **Impact:** high. **Risk:** low.

### 6.5 Container supply chain
- **Docker Hardened Images are free** (distroless, non-root, SBOM, SLSA L3
  provenance, signed); cosign keyless signing via GitHub OIDC is standard.
  [Docker press release](https://www.docker.com/press-release/docker-makes-hardened-images-free-open-and-transparent-for-everyone/) ·
  [SBOM + signing on Actions](https://nineliveszerotrust.com/blog/container-sbom-signing-attestation/)
- **Here:** multi-stage `Dockerfile`: build on `node:24`, run on a hardened/
  distroless Node 24 image as UID 65532, read-only rootfs + `/data` volume;
  CI generates SBOM (syft) + `cosign sign --keyless` + `actions/attest-build-provenance`.
  `sharp` prebuilt binaries work on glibc distroless.
- **Effort:** S/M. **Impact:** medium (trust for self-hosters, CRA-readiness).
  **Risk:** low (lose shell in container; document `docker debug`).

---

## 7. Practical, privacy-respecting AI

Principle (from ROADMAP): zero third-party accounts by default. Every AI feature
below is **opt-in per instance and per user**, runs **on-device or on a
self-hosted sidecar first**, and never runs on E2EE rooms.

### 7.1 Message translation (Phase 2)
Tiered, cheapest-and-most-private first:
1. **On-device, browser-native:** Chrome 138+ desktop ships the **Translator
   API** and **Language Detector API** (on-device models downloaded on demand;
   not on mobile; not in Firefox/Safari).
   [Chrome Translator API](https://developer.chrome.com/docs/ai/translator-api?hl=en) ·
   [Language detection](https://developer.chrome.com/docs/ai/language-detection)
2. **On-device, any browser:** Mozilla's **Bergamot** (Marian NMT in WASM — what
   powers Firefox Translations) or Transformers.js with an OPUS-MT/NLLB-distilled
   model on WebGPU. Model downloads are 15–100 MB per pair: cache in OPFS.
   [Bergamot in Firefox](https://firefox-source-docs.mozilla.org/toolkit/components/translations/resources/03_bergamot.html)
3. **Self-hosted server:** **LibreTranslate** (Argos) compose profile;
   server caches translations per `(message_id, target_lang)`.
4. **Optional third-party:** DeepL/LLM API key set by the operator, clearly
   disclosed in the privacy policy (PDPA: cross-border transfer).
- **Here:** "Translate" in `MessageContextMenu.jsx` + auto-translate toggle per
  channel; language detection via `Intl`/LanguageDetector to show the button only
  for foreign-language messages; `services/translate.js` for tier 3/4.
  Thai↔English quality: server/LLM tiers are much stronger than small on-device
  models — test with native speakers.
- **Effort:** M. **Impact:** high for multilingual communities (repo ships 30+
  UI locales). **Risk:** medium (quality, cost if tier 4; privacy disclosure).

### 7.2 Voice-message transcription and live captions
- **Whisper / Moonshine in the browser** via Transformers.js on WebGPU (WASM
  fallback); Moonshine tiny/base (~30–60 MB, English) is fast enough for voice
  notes. **Transformers.js v4** (2026) rewrote its WebGPU runtime in C++ (with
  ONNX Runtime) and supports Safari 26 WebGPU.
  [Transformers.js 4.3.0](https://github.com/huggingface/transformers.js/releases/tag/4.3.0) ·
  [browser-whisper](https://github.com/tanpreetjolly/browser-whisper) ·
  [whisper-web](https://github.com/xenova/whisper-web)
- **Here:** `VoiceNote.jsx` / `src/utils/voiceNote.js`: "Show transcript" runs
  locally on the *listener's* device (no server cost, nothing leaves the device);
  optional server-side `whisper.cpp` sidecar stores a transcript for search and
  screen-reader users. Live captions in voice: a LiveKit agent with a
  self-hosted STT (only when room is not E2EE). `src/utils/speech.js` (Web Speech
  API) sends audio to Google/Apple clouds in some browsers — label it.
- **Effort:** M (voice notes) / L (live captions). **Impact:** high for
  accessibility. **Risk:** medium (model size on mobile; opt-in).

### 7.3 Semantic search and summaries
- sqlite-vec / pgvector (§2.5) with a small multilingual embedding model
  (e.g. multilingual-e5-small via Transformers.js on the server, ONNX CPU) for
  "find messages about X". "Catch-up summaries" (Discord, Slack, Telegram all
  shipped AI summaries in 2025–26) need an LLM: offer only with an
  operator-configured, self-hosted OpenAI-compatible endpoint (llama.cpp/vLLM).
  [Telegram AI summaries](https://telegram.org/blog/new-design-ai-summaries) ·
  [Slack AI 2026](https://www.eesel.ai/blog/slack-ai) *(summary)*
- **WebLLM / in-browser LLMs:** possible on WebGPU but multi-GB downloads —
  *Assess*.
- **Effort:** M/L. **Impact:** medium. **Risk:** medium (hallucinated summaries
  of moderation-relevant content; permission leakage in embeddings).

---

## 8. Competitor moves 2025–2026

| Who | Move | Take-away for us |
| --- | --- | --- |
| **Discord** | All calls E2EE via DAVE since 1 Mar 2026 ([libdave](https://github.com/discord/libdave)); server tags, Server Shop, spoiler channels, "AutoMod AI", conversation summaries, redesigned "You" bar, Orbs + Quests currency ([PeakBot](https://peakbot.pro/blog/new-discord-features-2026-server-owners), [Orbs FAQ](https://support.discord.com/hc/en-us/articles/30593690165783-Discord-Orbs-FAQ)); mobile RN upgrade ~5% faster launches ([Aug 2026 changelog](https://discord.com/blog/discord-update-august-11-2026-changelog)); Apps usable anywhere / App Directory. | Copy: **server tags** (a user shows one guild tag next to their name — cheap, social), **spoiler channels**, **summaries** (self-hosted LLM only), **E2EE toggle** for DM calls. Skip: Orbs/Quests/Shop (monetisation; ROADMAP says no). |
| **Stoat (ex-Revolt)** | Rebrand Oct 2025; LiveKit voice + new web app Feb 2026; Voice Chats v2 UI (voice members in sidebar, persistent call when navigating); LiveKit node latency picker. [updates](https://stoat.chat/updates) | Validates LiveKit path. "Voice stays connected while navigating" + sidebar voice roster are table stakes; pair with Document PiP to exceed them. |
| **Element X / Matrix 2.0** | Native OIDC via MAS, simplified sliding sync (MSC4186) native in Synapse, MatrixRTC + LiveKit calls. [Matrix 2.0](https://matrix.org/blog/2024/10/29/matrix-2.0-is-here/) · [native sliding sync](https://matrix.org/blog/2024/11/14/moving-to-native-sliding-sync/) | Their "sliding sync" = load only the visible room list + counts at startup. Our cold start loads everything in `App.jsx`; a **lean "ready" payload + lazy per-guild hydration** is the same idea. OIDC → our OAuth 2.1 track. |
| **Slack** | AI recaps, huddle notes, canvases, Lists (tasks from messages), translations on paid tiers. [Slack feature drop Jan 2026](https://slack.com/blog/news/feature-drop-jan26) | Worth copying without AI: **"Save for later" with reminders**, **message → task list** per channel (lightweight Lists). Canvases only if Yjs lands. |
| **Telegram** | AI summaries on open models via its Cocoon network, member tags, welcome packs for groups, sharing prevention, Liquid Glass UI. [Telegram blog](https://telegram.org/blog/new-design-ai-summaries) · [Neowin](https://www.neowin.net/news/telegram-gets-big-update-with-sharing-prevention-member-tags-and-more/) | **Welcome pack** maps onto our onboarding; **forward/save protection** per channel (disable forward + download, watermark) is cheap and valued by creators. |
| **Guilded** | Shut down 19 Dec 2025. (RESEARCH §2) | Offer an **import path** for orphaned communities (ROADMAP P2 Discord import can accept Guilded exports too). |

---

## 9. Technology radar

ThoughtWorks-style rings. **Adopt** = use now as default; **Trial** = build
behind a flag in a real feature; **Assess** = spike/prototype, decide later;
**Hold** = don't start.

### Adopt
| Tech | Area | Why now |
| --- | --- | --- |
| Socket.IO CSR + REST gap-fill; Redis Streams adapter on Valkey (optional profile) | Realtime | Only adapters that keep CSR; unblocks multi-node without losing resume |
| BroadcastChannel + Web Locks leader-tab socket | Web | Baseline; cuts duplicate fan-out and notifications |
| Web Push with Declarative payload + Badging API | Web | Safari 18.4+ reliability; one payload works everywhere |
| Passkeys (WebAuthn L3: conditional get/create, JSON, capabilities) | Identity | W3C Rec Aug 2026; universal client support |
| Trusted Types (report-only → enforce) | Security | Baseline Feb 2026; UGC app with HTML rendering |
| Popover API + CSS anchor positioning; same-doc View Transitions | Web/UI | Baseline; replaces hand-positioned menus |
| Navigation API (or TanStack Router) for deep links | Web | Baseline Jan 2026 |
| React Compiler 1.0; React 19.2 `useEffectEvent`, `useOptimistic` | React | Stable, low-risk perf/correctness |
| TanStack Query v5 + Zustand | React | Standard SPA server/client state split |
| Vite 8 (Rolldown) + Tailwind v4.2+ logical utilities | Tooling | Stable; faster builds; RTL |
| Vitest 4 browser mode | Testing | Stable Oct 2025 |
| LiveKit: dynacast, adaptive stream, RED, VP8 simulcast | Voice | Config-level wins on the planned SFU |
| Node 24 LTS + permission model | Runtime | Node 22 EOL Apr 2027 |
| OTel JS SDK 2.0 (server traces/metrics) + `grafana/otel-lgtm` profile | Ops | Stable signals; one-container backend |
| Litestream ≥ 0.5.2 | Ops | PITR with fast restore |

### Trial
| Tech | Area | Note |
| --- | --- | --- |
| Document Picture-in-Picture pop-out call | Web/Voice | Chrome + Firefox 151; Safari fallback to video PiP |
| RNNoise WASM "Enhanced noise suppression" | Voice | Free, self-hosted Krisp-alternative |
| LiveKit E2EE toggle for DM/private calls | Voice/Sec | Encoded Transform cross-browser |
| AV1/VP9 SVC + VP8 backup codec (screen share first) | Voice | Multi-codec simulcast |
| WHIP ingress ("Go Live from OBS") | Voice | Optional LiveKit ingress profile |
| `CaptureController.setFocusBehavior`, `surfaceSwitching` | Web | Small Go Live UX wins |
| Translation tiers: Chrome Translator API → LibreTranslate → optional DeepL/LLM | AI | Opt-in, privacy-first order |
| Whisper/Moonshine voice-note transcripts via Transformers.js v4 (WebGPU) | AI/a11y | On listener's device |
| sqlite-vec hybrid semantic search | Data | Keeps SQLite-first |
| TypeScript 7 `tsc` for type-check (TS 6 for lint until 7.1) | Tooling | 10× faster checks |
| Biome 2 (format + lint) alongside react-hooks/jsx-a11y ESLint rules | Tooling | Repo has no linter today |
| React 19.2 `<Activity>` for recently visited channels | React | Instant channel switching |
| WebCodecs client-side video poster/preview | Media | Safari 26 closed audio gap |
| Docker Hardened Images / distroless + SBOM + cosign keyless | Ops | Free since 2025 |
| Offline outbox (IndexedDB) + idempotent send | Data | Pairs with optimistic UI |
| TanStack Router | React | If a typed router is wanted over hand-rolled Navigation API |

### Assess
| Tech | Why not yet |
| --- | --- |
| Zero 1.0 / Electric + TanStack DB 0.6 / PowerSync | Require Postgres logical replication; permission rules must be re-modelled |
| Yjs for channel canvases/notes | Only if a collaborative-document feature is prioritised |
| WebTransport transport for Socket.IO | Baseline since Safari 26.4, but needs HTTP/3 edge; modest gain |
| Media over QUIC for large Go Live/stage | IETF draft-17; revisit 2027 |
| Centrifugo v6 / NATS | Only if load tests show Node gateway saturation |
| MLS (ts-mls / libdave JS) for E2EE DMs and call keys | Large, security-critical; ROADMAP excludes server text E2EE |
| DeepFilterNet3 in-browser | Quality vs CPU on phones |
| Element Capture / Region Capture | Chromium-only |
| Spatial audio (PannerNode HRTF) | Niche |
| OAuth 2.1 / OIDC provider for apps ("Login with instance") | After bot API stabilises |
| Storage Buckets; scroll-driven animations | Firefox gaps |
| WebLLM / in-browser LLM summaries | Multi-GB models |
| Bun / Deno for production | Native addons (`sqlite3`, `sharp`) |
| `node:sqlite` replacing `sqlite3` | Promising (drops node-gyp chain) but API still evolving; needs `db.js` refactor |
| Postgres + pgvector + LISTEN/NOTIFY | Only when a second app node is justified by metrics |

### Hold
| Tech | Reason |
| --- | --- |
| Shared Storage API | Deprecated/removed in Chrome |
| Opus DRED | Not in libwebrtc/browsers |
| AV1 as the only/primary video codec | No Safari encode |
| LiteFS | Upstream refocused on Litestream |
| React Server Components / SSR framework migration | SPA with realtime socket; no benefit |
| CRDTs for chat messages | Server-ordered append log; CRDT adds cost, no benefit |
| Speculation Rules | MPA feature; Chromium-only |
| Cross-document View Transitions | We're a SPA |
| File System Access picker APIs | Chromium-only; OPFS is enough |
| Orbs/Quests/Server Shop-style monetisation | Against project principles |
| Socket.IO Postgres adapter | No CSR support yet |

---

## 10. Top 15 recommendations mapped to phases

Ranked by (impact × confidence) ÷ effort, respecting the existing phase plan.

| # | Recommendation | Phase / track | Effort | Impact | Key files |
| --- | --- | --- | --- | --- | --- |
| 1 | **Socket.IO CSR + REST gap-fill now; Redis Streams adapter on Valkey as optional profile; leader-tab socket via Web Locks + BroadcastChannel** | P2 · Socket.IO recovery/Redis | S → M | High | `realtime.js`, `src/App.jsx`, `src/api.js`, `lib/rateLimit.js`, `docker-compose.yml` |
| 2 | **Web Push with Declarative Web Push payload + Badging API** (extends ROADMAP P0-1) | P2 · Web Push | S (on top of P0-1) | High | `services/push.js`, `public/sw.js`, `src/utils/notifier.js` |
| 3 | **Passkeys as primary login (WebAuthn L3 conditional UI + automatic upgrade + Signal API)** via `@simplewebauthn` | P2 · Passkeys | M | High | `routes/accountSecurity.js`, `LoginScreen.jsx`, `AccountSecurityTab.jsx`, migration |
| 4 | **LiveKit client tuned for 2026**: dynacast, adaptive stream, RED audio, VP8 simulcast baseline, AV1/VP9 SVC with VP8 backup for screen share; pin server/agents versions | P2 · LiveKit | L (planned) | High | `useVoicePeers.js`, `useVoiceMedia.js`, `realtime.js`, `docker-compose.yml` |
| 5 | **"Enhanced noise suppression" (RNNoise WASM AudioWorklet)** for mesh + LiveKit; CSP `'wasm-unsafe-eval'` | P2 · LiveKit/voice quality | M | High | `useVoiceMedia.js`, `VoiceSettings.jsx`, `lib/middleware.js` |
| 6 | **Document PiP pop-out call window** (video-PiP fallback on Safari) + `CaptureController`/`surfaceSwitching` for Go Live | P2 · LiveKit/voice UX | S/M | High | `VoiceRoom.jsx`, `CallPanel.jsx`, `useVoiceMedia.js` |
| 7 | **Message translation, privacy-tiered**: Chrome Translator/LanguageDetector on-device → LibreTranslate profile → optional operator key; per-message cache | P2 · Translation | M | High | new `services/translate.js`, `MessageContextMenu.jsx`, `ChatArea.jsx`, i18n |
| 8 | **Observability: OTel SDK 2.0 preload + socket.io instrumentation, `grafana/otel-lgtm` compose profile, client WebRTC `getStats()` + Web Vitals opt-in** | P2 · Observability | M | High | new `otel.mjs`, `lib/middleware.js`, `realtime.js`, `docker-compose.yml` |
| 9 | **Media pipeline: WebCodecs client-side poster/preview, on-device voice-note transcripts (Transformers.js v4 + Moonshine/Whisper), immutable caching** | P2 · Media pipeline | M | Medium-high | `VoiceNote.jsx`, `utils/voiceNote.js`, `storageService.js`, `routes/files.js` |
| 10 | **Node 24 LTS + permission model + hardened/distroless image with SBOM + cosign; Litestream ≥ 0.5.2** | P2 · Ops/security | S/M | High | `Dockerfile`, `docker-compose.yml`, CI, `scripts/backup.mjs` |
| 11 | **Trusted Types (report-only → enforce) + CSP reporting** | P2 · Security | S/M | High | `lib/middleware.js`, `markdownParser.jsx`, `RichEmbed.jsx`, `LinkEmbed.jsx` |
| 12 | **React Compiler 1.0 on Vite 8** as the first step of the refactor (before any rewrite) | P3 · Frontend refactor | S | High | `vite.config.js`, `package.json` |
| 13 | **TS migration + TanStack Query v5 (socket events → query cache, IndexedDB persistence) + Zustand stores + offline outbox with `useOptimistic`** | P3 · TS + Query/Zustand | L | High | `src/api.js`, `src/App.jsx`, `ChatArea.jsx`, `src/hooks/*` |
| 14 | **Design system on native primitives**: Popover + anchor positioning (menus, pickers, hover cards), View Transitions, Tailwind `@theme` tokens + logical utilities, Vitest 4 browser-mode component tests | P3 · Design system | M/L | Medium-high | `src/components/*Menu*.jsx`, `*Popover*.jsx`, `EmojiPicker.jsx`, `index.css` |
| 15 | **React 19.2 `<Activity>` keep-alive for recent channels + Navigation API/TanStack Router deep links** (`/channels/:g/:c/:m`, needed by push click-through) | P3 · Frontend refactor | M | Medium-high | `src/App.jsx`, `ChatArea.jsx`, `main.jsx` |

**Next after the top 15 (Assess backlog):** LiveKit E2EE toggle for DM calls →
MLS key agreement; WHIP "Go Live from OBS"; sqlite-vec semantic search; server
tags and spoiler channels (Discord parity); forward/save protection
(Telegram); Zero/Electric only after a Postgres decision; WebTransport once the
edge proxy speaks HTTP/3.
