# Frontend Performance Audit

Audit date: 2026-09-26 · Build: `vite build` of this branch (React 19.2, Vite 6, Tailwind 4) · Browser: Chromium 141 headless (`/opt/pw-browsers/chromium`) · Lighthouse 13.5 · Playwright-core 1.63.
All measurements came from the scripts in [`scripts/perf/`](../scripts/perf). They boot the real `server.js` with `SERVE_STATIC=1` on a throwaway SQLite DB (port 5950) and seed data through the real HTTP API. See [How to reproduce](#how-to-reproduce).

---

## สรุปสำหรับผู้บริหาร (ภาษาไทย)

**ภาพรวม:** แอปโหลดครั้งแรกบน desktop ได้เร็วพอใช้ (Lighthouse login desktop 93 คะแนน) แต่ **บนมือถือและในห้องแชทที่มีข้อความเยอะ ประสิทธิภาพตกลงมาก** Core Web Vitals ไม่ผ่านเกือบทุกตัว:

| หน้า | LCP (เป้า ≤ 2.5 s) | CLS (เป้า ≤ 0.1) | TBT (เป้า ≤ 200 ms) |
|---|---|---|---|
| Login, มือถือ | 7.2 s ❌ | 0 ✅ | 5 ms ✅ |
| แชท, มือถือ | **23.5 s** ❌ | 0.05–0.39 ❌ | 409 ms ❌ |
| แชท, desktop | 5.1 s ❌ | **0.35** ❌ | 67 ms ✅ |

**ต้นเหตุหลัก 5 ข้อ (เรียงตามผลกระทบ):**

1. **รายการข้อความไม่ได้ virtualize** แถวข้อความทุกแถวถูก render ใหม่ทั้งหมดทุกครั้งที่พิมพ์ 1 ตัวอักษร เพราะ state ของช่องพิมพ์อยู่ใน component เดียวกับรายการ ในห้องที่โหลดไว้ประมาณ 5,000 แถว **การกดแป้น 1 ครั้งใช้เวลา 0.4–0.7 วินาทีกว่าจะขึ้นจอ** (p95 0.9–1.7 s) และถ้าจำลอง CPU มือถือจะ **ช้าถึง 4.8 วินาที** ตอน scroll ได้ 25–42 fps มีเฟรมค้างนานสุด 0.7–1.9 s DOM มี 230,000 nodes และใช้ heap 110 MB
2. **ไฟล์ JS/CSS ไม่ถูก cache และไม่ถูกบีบอัดที่ origin** regex ใน `server.js:2018` ไม่ match ชื่อไฟล์ของ Vite (`index-B3oiM5lP.js`) ไฟล์ที่มี hash จึงได้ `Cache-Control: no-cache` และ Node ไม่มี gzip/brotli ทำให้ส่ง JS 908 KiB แบบไม่บีบอัด เมื่อทดลองแก้ด้วย proxy ในเครื่อง **Login บนมือถือขึ้นจาก 61 เป็น 88 คะแนน FCP ลดจาก 6.1 s เหลือ 2.2 s และ LCP ลดจาก 7.2 s เหลือ 3.5 s**
3. **รูปภาพไม่ถูกย่อ** avatar ขนาด 1024² (~520 KB) แสดงที่ 32–40 px (ใหญ่เกินจริง 32 เท่า) ส่วนไฟล์แนบ PNG ขนาด 1600 px (633 KB) แสดงที่ ≤ 384 px ทั้งที่ server สร้าง WebP 64/128/256/800 px ไว้แล้ว (`storageService.js:61,69`) แต่ client ไม่เคยใช้ รูป 2,950 จาก 2,954 รูปไม่มี `loading="lazy"` ห้องแชทจึงโหลดรูป 3.7–4.2 MB ต่อการเปิด 1 ครั้ง
4. **รับข้อความจำนวนมากไม่ไหว** เมื่อมีข้อความเข้า 100 ข้อความ/วินาที client ส่ง `mark_read` กลับ 1 ครั้งต่อข้อความ และ server ส่ง `read_state_updated` กลับมาอีก 1 ครั้ง รวมเป็น 300+300 เฟรม แต่ละเฟรมทำให้ทั้งแอป render ใหม่ ผลคือประมาณ 73% ของเฟรมหลุด (ในห้อง 5k แถวหลุด 90–95%) และข้อความสุดท้ายขึ้นจอช้า 0.3–4.4 s
5. **bundle เดียวขนาด 929 KB** (gzip 253 KB) ไม่มี `React.lazy` เลย หน้า settings, voice, forum และ modal ทั้งหมดถูกโหลดตั้งแต่หน้า login Lighthouse นับ unused JS ได้ 611 KiB

**สิ่งที่ทำงานดีอยู่แล้ว:** i18n แยก locale เป็น chunk ที่โหลดเมื่อเลือกภาษา มีเฉพาะภาษาอังกฤษใน bundle หลัก lucide-react ถูก tree-shake แล้ว (132 icons, ~3%) ไม่พบ dependency ซ้ำ การสลับ 20 ห้อง × 2 รอบไม่ทำให้หน่วยความจำรั่ว (heap, DOM nodes, listeners กลับมาเท่า baseline และไม่มี detached DOM) และไฟล์ใน `/uploads` ตั้ง `immutable` ถูกต้องแล้ว

**ลำดับที่แนะนำ:** ทำ quick wins ที่แก้ไม่กี่บรรทัดก่อน (F2 แก้ cache regex และเปิด compression, F3 ใช้รูป variant ที่มีอยู่แล้วและใส่ lazy, F4 รวม mark_read) จากนั้นทำ F1 (virtualize ด้วย `@tanstack/react-virtual` และแยก Composer/MessageRow ใส่ memo) ซึ่งเป็นงานใหญ่ที่สุดแต่ได้ผลมากที่สุด แล้วตามด้วย F5 (code splitting) คาดว่าหลังทำครบ Lighthouse มือถือจะได้ ≥ 85 ทั้ง 2 หน้า และการพิมพ์จะใช้ไม่เกิน 30 ms ไม่ว่าห้องจะยาวแค่ไหน

---

## Contents

1. [Metrics: current vs target](#1-metrics-current-vs-target)
2. [Ranked findings and fixes](#2-ranked-findings-and-fixes)
3. [Expected gain summary](#3-expected-gain-summary)
4. [What is fine already](#4-what-is-fine-already)
5. [How to reproduce](#how-to-reproduce)
6. [Methodology notes and caveats](#methodology-notes-and-caveats)

---

## 1. Metrics: current vs target

Targets are the Core Web Vitals "good" thresholds (LCP ≤ 2.5 s, INP ≤ 200 ms, CLS ≤ 0.1, measured at p75). Lab proxies: TBT ≤ 200 ms (Lighthouse mobile), FCP ≤ 1.8 s, TTI ≤ 3.8 s. For a chat app, we add a keystroke-to-paint target of ≤ 50 ms, because typing is the most frequent interaction.

### 1.1 Lighthouse, median of 3 runs

The server is Node directly, with no reverse proxy. Google Fonts are fetched live through the sandbox proxy. The chat view is a guild channel with 300 seeded messages (1 in 25 carries a 1600×1200 PNG) and 6 authors with 1024² avatars.

| Page · preset | Perf score | FCP | LCP | TBT | CLS | Speed Index | TTI | Transfer | Requests |
|---|---|---|---|---|---|---|---|---|---|
| Login · mobile | **61** | 6.07 s | **7.20 s** | 5 ms | 0 | 6.07 s | 7.20 s | 1,037 KiB | 11 |
| Login · desktop | 93 | 1.11 s | 1.46 s | 0 | 0 | 1.11 s | 1.46 s | 1,037 KiB | 11 |
| Chat · mobile | **50** | 6.08 s | **23.5 s** | **409 ms** | 0.046 (0.39 in the no-fonts and what-if medians) | 6.08 s | 24.0 s | **4,771 KiB** | 35 |
| Chat · desktop | **56** | 1.18 s | **5.06 s** | 67 ms | **0.350** | 1.18 s | 5.09 s | **5,286 KiB** | 36 |
| **Target** | ≥ 90 | ≤ 1.8 s | ≤ 2.5 s | ≤ 200 ms | ≤ 0.1 | ≤ 3.4 s | ≤ 3.8 s | < 1,600 KiB | — |

Breakdown of the transfer, chat · desktop: JS 908 KiB (one file, uncompressed), CSS 77 KiB, 1 webfont 48 KiB, images **4,178 KiB** (10 avatars at ~515 KiB each plus 1 attachment at 633 KiB), API 72 KiB.

**What-if runs** (same pages, same data):

| Variant | Login mob. score / FCP / LCP | Chat mob. score / FCP / LCP | JS transfer |
|---|---|---|---|
| Current | 61 / 6.07 s / 7.20 s | 50 / 6.08 s / 23.5 s | 908 KiB |
| Google Fonts blocked (self-hosting proxy) | 61 / 6.16 s / 6.72 s | 35–52 (CLS noise) / 6.08 s / 21.5 s | 908 KiB |
| **Brotli + immutable cache** (`PERF_LH_WHATIF=1` front proxy) | **88** / **2.19 s** / **3.50 s** | 42 / 2.22 s / 20.1 s | **199 KiB** |

The chat LCP stays at about 20 s after the compression fix because the LCP element is a lazy-loaded, full-size attachment image behind 3.6 MiB of avatars. Only F3 (images) fixes it.

Render-blocking resources on mobile: `fonts.googleapis.com/css2` costs about 810 ms and `index-*.css` about 1,060 ms, because the CSS is uncompressed.

### 1.2 Bundle

From `node scripts/perf/bundle.mjs`, which uses rollup-plugin-visualizer. Sizes are for the files as emitted.

| Chunk | Raw | gzip | brotli | Loaded |
|---|---|---|---|---|
| `index-*.js` (entry, everything) | **928.7 KB** | **252.9 KB** | 203.0 KB | always |
| `index-*.css` | 75.6 KB | 13.6 KB | 11.0 KB | always, render-blocking |
| 31 locale chunks (`th`, `ja`, `hi`…) | 70–129 KB each | 23–30 KB | 19–25 KB | only when that language is picked ✅ |
| **Target, initial JS** | — | **≤ 170 KB** | — | |

The table below breaks down the entry chunk. Shares are of rollup's pre-minify rendered bytes (1.91 MB), so treat them as proportions.

| Part | Share | Notes |
|---|---|---|
| App source | 59.4% | settings tabs 11.0%, `App.jsx` 5.1%, `ServerSettingsModal` 4.6%, `ChatArea` 4.2%, `en.js` 4.2%, `ForumView` 2.9%, `VoiceRoom` + voice hooks 3.6%, `EventsPanel` 1.3% … |
| react-dom | 29.3% | unavoidable |
| lucide-react | 3.2% | 132 icon modules, tree-shaken correctly ✅ |
| socket.io-client + engine.io | 5.7% | |
| **Lazy-loadable** (modals, settings, voice, forum, events, pickers) | **≈ 30%** | about 575 KB pre-minify, about 280 KB min, about 75 KB gzip |

No package is duplicated in the client graph: react, react-dom, scheduler and socket.io each resolve once.

### 1.3 Origin headers (Node, `SERVE_STATIC=1`)

From `node scripts/perf/headers.mjs`.

| Resource | Cache-Control | Content-Encoding | Raw → gzip → br |
|---|---|---|---|
| `/` (SPA shell) | `no-cache` ✅ | none | 1.1 KB |
| `/assets/index-*.js` (hashed) | **`no-cache`** ❌ (should be `immutable`) | **none** ❌ | 929 KB → 253 KB → 203 KB |
| `/assets/index-*.css` (hashed) | **`no-cache`** ❌ | **none** ❌ | 76 KB → 14 KB → 11 KB |
| `/uploads/avatars/*.png` | `public, max-age=31536000, immutable` ✅ | none (binary) | 521 KB (a 40 px avatar) |
| `/api/messages/:id?limit=50` | (none) | **none** ❌ | 41 KB → 2.2 KB → 1.7 KB |

Protocol: Node speaks HTTP/1.1 only. In the Docker deployment, Caddy (`Caddyfile`) terminates TLS with HTTP/2 and HTTP/3 and applies `encode zstd gzip`, so JS and CSS are gzip/zstd-compressed there, but **not brotli**. Caddy passes the wrong `no-cache` through unchanged. Deployments that follow `nginx.conf.example` or expose Node directly (`SERVE_STATIC` without a proxy) have no compression at all.

### 1.4 Runtime, chat view (Playwright + CDP, 1366×860, CPU 1× unless noted)

The channel was seeded with 5,000 messages through the API. "N rows" means rows actually rendered after scrolling history. Most quiet-machine runs rendered 5,050–5,500 rows (see [caveats](#methodology-notes-and-caveats)).

| Metric | 50 rows (fresh open) | ≈ 5,000 rows loaded | Target |
|---|---|---|---|
| Channel open (pointerdown → newest row painted), warm | p50 196–373 ms, p95 327–450 ms (15 requests) | — | ≤ 200 ms |
| **Keystroke → next frame**, 1× CPU | p50 19–22 ms, p95 44–58 ms | **p50 420–708 ms, p95 0.92–1.71 s, max 2.8 s** | ≤ 50 ms |
| **Keystroke → next frame**, 4× CPU (mid-tier phone) | p50 76–104 ms, p95 115–187 ms | **p50 3.7–5.0 s** (n=3) | ≤ 100 ms |
| Scroll 1.5 kpx/s (rAF-driven) | 59–60 fps, 0 long tasks | **25–42 fps, worst frame 0.7–1.9 s**, 2.2–5.2 s of long tasks | 60 fps, no frame > 50 ms |
| History page (50 older msgs) scroll-top → painted | p50 371 ms (first 5 pages) | **p50 1.50 s** (last 5 pages), growing linearly | ≤ 300 ms |
| DOM nodes | 2,826 | **230,613** (43.4 nodes per row) | < 10,000 (virtualized) |
| JS heap after GC | 5.9 MB | **106–117 MB** (≈ 21 KB per row) | < 30 MB |
| JS event listeners | 695 | 52,000 after GC (up to 113,000 before) | flat |
| **Burst: 100 `new_message`/s for 3 s** (synthetic socket frames) | render lag 312–590 ms; **≈ 73% of frames dropped** (37/51–48/66); 21–23 long tasks = 1.8–2.1 s; worst 155–202 ms | render lag **3.3–4.4 s**; **90–95% of frames dropped** (19/20–20/22); worst frame 1.1–1.45 s; long tasks 6.8–8.1 s | lag < 100 ms, no frame > 50 ms |
| Client → server socket emits during the burst | **300 `mark_read`** (1 per message) | 300 | ≤ 3 (throttled) |
| Server → client echoes | **300 `read_state_updated`** | 300 | ≤ 3 |
| End-to-end burst (10 authors POST at a 100/s target) | server sustained 37–61 msg/s; lag 1.5–2.0 s; 36–42 long tasks | — | — |

**React re-render counts** come from `node scripts/perf/renders.mjs`, which uses an unminified production build and a DevTools-style fiber walk in a channel with 200 rows loaded:

| Event | Commits | Component renders | What re-renders |
|---|---|---|---|
| 1 incoming message | 2 | **3,360** | App, ServerRail, ChannelSidebar, ChatArea and, for **every** row, the 4 hover-toolbar icons (`SmilePlus`/`Reply`/`Trash2`/`Ellipsis`, each 2 fibers) |
| 1 keystroke in the composer | 2 | **1,641** | ChatArea, then every row's toolbar icons plus `Attachment` |
| 1 reaction by another user | 1 | 1,681 | whole tree |
| Typing indicator from another user | 1 | 1,681 | whole tree |
| **Target** | 1 | ≤ 20 | only the affected row, or the composer/typing bar |

The number of component renders grows linearly with rows: about 8 per row per keystroke. At 5,000 rows that is about 40,000 per keystroke.

**Leak check:**

| Scenario | Heap after GC | DOM nodes | Listeners | Detached DOM |
|---|---|---|---|---|
| Baseline (short channel) | 6.6 MB | 2,049 | 598 | 0 |
| After 42 channel switches (20 channels × 2 + long channel) | 5.9 MB | 2,049 | 598 | 0 |
| After leaving a channel whose history was loaded by 2 scroll events per frame | 88–96 MB | 162k–180k (**3,730–4,130 stale rows of the old channel stay on screen**) | 37k–41k | 0 (still attached) |

Normal channel switching does not leak. The last row is a real bug; see [F6](#f6-history-pagination-race--duplicate-react-keys--stale-rows-and-memory-after-switching).

### 1.5 Network on load (chat deep link, logged in)

37 requests before the composer is usable, 937 ms locally. The critical chain is:

```
GET /channels/:s/:c ─► index.js (908 KiB) ─► /api/auth/me ─► /api/initial-data/:uid ─► /api/servers/:s (+/permissions, /stickers)
                                         └► socket.io polling ×4 (handshake before WS upgrade)          └► /api/messages/:c?limit=50 (+pins, commands, threads)
                                         └► fonts.googleapis.com css ─► fonts.gstatic.com woff2      └► 10 × /uploads/avatars/*.png (≈ 515 KiB each)
                                         └► favicon from assets-global.website-files.com (3rd party)
                                         └► api.dicebear.com identicon (3rd party, default server icon)
```

The messages request starts after **4 sequential API round trips**: at 580 ms on desktop Lighthouse and much later on slow 4G. Each channel open issues 15 requests: 4 API requests (`messages`, `pins`, `commands`, `threads`, with no caching between visits) and 10+ avatar and image requests. The API requests are not duplicated within one navigation.

---

## 2. Ranked findings and fixes

The ranking is impact × reach. Each finding lists the evidence, the exact fix and the expected gain.

### F1. The message list renders every row, every time (no virtualization, no memoization, composer state inside the list)

**Evidence**
- `src/components/ChatArea.jsx:915` renders `decorated.map((msg) => …)`, about 330 lines of inline JSX per row with no row component and no `React.memo`. The repository has **no `React.memo`/`memo(` anywhere**.
- `ChatArea.jsx:108` keeps `const [inputText, setInputText] = useState('')` in the same component, and `ChatArea.jsx:1513` has `onChange → setInputText`, so **every keystroke re-renders every row**. There are 1,641 component renders per keystroke at 200 rows. Keystroke-to-frame latency is 19 ms at 50 rows and 420–708 ms at about 5,000 rows (4× CPU: 3.7–5 s).
- `ChatArea.jsx:1236-1300` has the hover action toolbar (3 quick emoji + 4 lucide icons) mounted for **every** row and only hidden by CSS `hidden group-hover:flex`. That is about 8 components and about 15 DOM nodes per row that nobody sees.
- `src/App.jsx:1664` remaps all messages to new objects whenever `messages` or `memberColors` change, and `utils/messageGrouping.js:23-48` does the same again. Row props therefore never keep their identity, so `memo` alone would not help.
- `src/App.jsx:564` grows `setMessages((prev) => [...older, ...prev])` without bound: 110 MB heap and 230k DOM nodes at about 5,000 rows. Each history page costs 371 ms at the start and 1.5 s at 5k rows, because the whole list is reconciled again.
- Scrolling at about 5,000 rows runs at 25–42 fps, with single frames of 0.7–1.9 s. Style and layout cost grows with DOM size.

**Fix**
1. Extract **`<Composer>`** (textarea, attachments, autocomplete, emoji and sticker pickers) into its own component that owns `inputText`. The list must not re-render on typing. This is the biggest single win: keystroke cost becomes independent of history length.
2. Extract **`const MessageRow = memo(function MessageRow({ msg, isOwn, isEditing, … }))`** and pass stable callbacks: `useCallback`, or one `useEvent`-style ref dispatcher (`ChatArea.jsx:198-203` already uses this pattern for Markdown). Make decoration identity-preserving: cache decorated objects in a `WeakMap<rawMsg, decorated>` keyed on `(msg, prevUserId, isNewDay, isFirstUnread)`, and in `App.jsx:1664` only clone messages whose `role_color` actually changes.
3. **Virtualize** with `@tanstack/react-virtual`. Use `useVirtualizer({ count, getScrollElement, estimateSize: () => 56, overscan: 8, measureElement })` with dynamic measurement, then:
   - keep scroll anchoring on prepend: use the index shift and `scrollToIndex(prevFirstIndex + added, { align: 'start' })`, or `shouldAdjustScrollPositionOnItemSizeChange`, in place of the `prependAnchorRef` math at `ChatArea.jsx:255-266`;
   - stick to the bottom when `isAtBottom`;
   - leave the date dividers and "new messages" bar as items in the list, since they are already flags on `decorated` rows.
4. Render the **action toolbar only for the hovered, focused or long-pressed row**. Track `hoveredId` with `onPointerEnter` on the row, or render one floating toolbar positioned over the hovered row.
5. **Window the data:** keep at most about 300–500 messages in state. When the user scrolls back down, drop pages from the far end and re-fetch on demand with `after=`, which `server.js:679` already supports.
6. Optional, complementary: enable the **React Compiler** (`babel-plugin-react-compiler` via `react({ babel: { plugins: [['babel-plugin-react-compiler', { target: '19' }]] } })` in `vite.config.js`). It auto-memoizes the 2,481-line `App.jsx` and 1,789-line `ChatArea.jsx`, which are full of inline closures (`App.jsx:1786-1880` passes about 20 new arrow functions to `ChatArea` on every render). Do this after step 1: the compiler cannot fix state that is co-located in the wrong component.

**Expected gain:** keystroke → frame about 16–25 ms at any history length (from 420–708 ms at 5k rows; mobile 4× from about 4–5 s to under 60 ms). This is the INP fix. Scrolling at a steady 60 fps. DOM about 3–5k nodes and heap under 25 MB regardless of history. History pages about 50–80 ms. Per-keystroke renders fall from 1,641 to about 5.

### F2. Hashed assets are served `no-cache` and uncompressed

**Evidence**
- `server.js:2018` uses the regex `/\.[0-9a-zA-Z_-]{8,}\.(js|css|woff2?|png|jpe?g|svg|webp)$/`. It expects `name.HASH.ext`, but Vite emits `name-HASH.ext` (`assets/index-B3oiM5lP.js`). Nothing ever matches, so every asset falls into the `no-cache` branch. The measured header on the JS and CSS is `Cache-Control: no-cache`.
- There is no compression middleware in `server.js`. The JS goes out as 929 KB raw, where gzip gives 253 KB and brotli 203 KB. API JSON is 41 KB where gzip gives 2.2 KB.
- Lighthouse what-if (brotli + immutable via a local front proxy): Login mobile **61 → 88**, FCP 6.07 → 2.19 s, LCP 7.20 → 3.50 s. Chat mobile FCP 6.08 → 2.22 s. JS transfer 908 → 199 KiB.

**Fix**
- `server.js:2018`: test the directory, not the file name: `if (filePath.includes(`${path.sep}assets${path.sep}`)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')`. Alternatively, fix the regex to `/[-.][0-9A-Za-z_-]{8,}\.(js|css|woff2?|png|jpe?g|svg|webp)$/`.
- Precompress at build time (`vite-plugin-compression2`, which emits `.br` and `.gz`) and serve the precompressed files with `express-static-gzip` (`{ enableBrotli: true, orderPreference: ['br'] }`) in place of `express.static` at `server.js:2015`. Add `compression()` before the API routes for JSON. Exclude `/socket.io` and `/uploads`, which are already binary.
- Caddy: keep `encode zstd gzip`, or let Caddy serve `/assets/*` directly with `file_server { precompressed br zstd gzip }` from a shared volume so that it uses brotli-11 files.

**Expected gain:** about 700 KiB less on every cold load and 0 bytes on warm loads (no revalidation round trip for hashed files). Mobile FCP drops by about 3.9 s and LCP (login) by about 3.7 s. Lighthouse mobile gains about 25 points.

### F3. Images are the chat's LCP and payload: originals shown at thumbnail size, nothing lazy

**Evidence**
- Avatars render the uploaded original. `ChatArea.jsx:1003` uses `src={msg.avatar_url}`, `MemberList.jsx:90,134` uses `member.avatar_url`, and similar `<img>` tags exist in `ChannelSidebar.jsx:351,401`, `HomeDirectMessages.jsx:203,270,444` and `ServerRail.jsx:232,295`. A 1024² PNG of about 520 KB is shown at 32–40 px, measured at **32× oversized**.
- Attachments render `att.url`, the 1600×1200 PNG of 633 KB, in a box at most 384 px wide (`ChatArea.jsx:1695-1705`).
- The server already builds WebP variants: avatars at 64/128/256 px (`storageService.js:61`) and attachments at 200/800 px (`storageService.js:69`, measured: a 64 px avatar WebP is 94 B for the synthetic image). The wire format carries `thumbnail_url` (`routes/files.js:45`), but the client only uses it in the composer preview (`ChatArea.jsx:1360`). The `variants` object is not attached to message attachments or avatars.
- 2,950 of 2,954 `<img>` elements are eager (`loading` missing). Only stickers and attachments are lazy, and the **LCP image itself is `loading="lazy"`**, which makes Lighthouse fail `lcp-discovery-insight`.
- Lighthouse `image-delivery-insight` estimates savings of 2,590 KiB (mobile) and 4,154 KiB (desktop). Chat mobile LCP is 23.5 s.

**Fix**
- Server: have the message and member serializers return `avatar_variants` and `attachment.variants` (URL per kind), or derive them by convention, since the variant key is `<hash>.<kind>.webp` next to the original. Add a 96 px avatar kind for 2× displays.
- Client: add one `<Avatar size={40} user={…} />` component that renders `src=thumb`, `srcSet="thumb 1x, small 2x"`, `width`/`height`, `loading="lazy"` and `decoding="async"`. Use it everywhere the avatar `<img>` tags above appear. For attachments, use `srcSet="{thumb} 200w, {medium} 800w, {url} {width}w"` with `sizes="(max-width: 640px) 90vw, 384px"`. Make the **last 2–3 attachments** in view `loading="eager" fetchPriority="high"`.
- `index.html:5`: self-host the favicon, which is currently loaded from `assets-global.website-files.com`. `services/guilds.js:326` and `services/templates.js:163`: replace the `api.dicebear.com` default icon with an initials SVG generated locally, so there is no third-party request and it still works offline or behind a firewall.

**Expected gain:** chat image bytes fall from 3.7–4.2 MiB to about 60–120 KiB (−97%). Chat mobile LCP goes from 23.5 s to about 3 s, and to about 2.2 s together with F2. Chat Lighthouse mobile rises to 80+. On cellular this saves about 4 MB of data per channel open.

### F4. Every incoming message triggers a `mark_read` emit, a server echo and 2–3 full-app renders

**Evidence**
- `src/App.jsx:608`: `onNewMessage → markChannelRead(msg.channel_id, msg.id)` runs for **every** message. `markChannelRead` (`App.jsx:442-448`) emits over the socket and calls `setReadStates`. The server (`realtime.js:225-233`) writes to the DB and emits `read_state_updated` back to the user, and `App.jsx:729` then runs `setReadStates` again.
- Measured at 100 msg/s for 3 s: **300 `mark_read` emits and 300 `read_state_updated` echoes**. About 73% of frames were dropped at 50 rows and 90–95% at about 5,000 rows. Render lag was up to 4.4 s. There were 2 commits and 3,360 component renders per message at 200 rows (see the renders table).
- Each socket event is its own task, so React 19's automatic batching does not merge them.

**Fix**
- Throttle read acknowledgements: keep only the latest id per channel and flush it at most once a second (trailing) or on `visibilitychange`/blur. In `onNewMessage`, update local read state without emitting.
- Server: do not echo `read_state_updated` to the socket that sent `mark_read` (`socket.to(`user-${userId}`)` in place of `io.to(...)`). Better still, coalesce by channel.
- Client: queue incoming `new_message` events in a ref and flush once per animation frame (`requestAnimationFrame(() => setMessages(prev => merge(prev, queue)))`). Do the same for `reaction_updated` and `typing_*`.
- Combined with F1 (memo rows), a flush should only mount the new rows.

**Expected gain:** socket traffic from 600 frames to under 10 per burst. React commits from about 2 per message to 1 per frame (60/s at most). At 100 msg/s: 0–2 dropped frames and under 50 ms lag, whatever the history length.

### F5. A single 929 KB entry chunk with no code splitting

**Evidence:** one entry chunk (253 KB gzip). `React.lazy`/`Suspense` count: 0. `App.jsx:5-35` statically imports about 30 components, including `UserSettingsModal`, `ServerSettingsModal` and its 30+ settings tabs (15.6% of the chunk), `ForumView`, `VoiceRoom` plus `useVoiceMedia`/`useVoicePeers`, `EventsPanel`, `OnboardingModal`, and `CreateServerModal`. `ChatArea.jsx:15-24` statically imports `EmojiPicker`, `StickerPicker`, `CreatePollModal`, `ImageLightboxModal` and `PinnedMessagesPopover`. The login screen downloads the entire app: Lighthouse reports **611 KiB of unused JS** on `/`, and 3.0 s of estimated LCP savings on mobile.

**Fix**
- `const UserSettingsModal = lazy(() => import('./components/UserSettingsModal'))`, and the same for `ServerSettingsModal`, `ChannelSettingsModal`, `ForumView`, `VoiceRoom`, `EventsPanel`, `OnboardingModal`, `CreateServerModal`, `UserProfileModal`, `SearchResultsPanel`, `QuickSwitcher`, `ForwardMessageModal`, `CreateGroupDmModal`, `EditHistoryModal`, and inside ChatArea `EmojiPicker`, `StickerPicker`, `CreatePollModal` and `ImageLightboxModal`. Wrap each in `<Suspense fallback={null}>` because they are all modals or overlays. Prefetch on intent: hover or focus on the gear icon calls `import()`.
- Split **logged-out and logged-in**: `main.jsx` renders a small `AuthGate` that lazy-loads `App` after `/api/auth/me` succeeds and `LoginScreen` otherwise. The login page then needs only react-dom plus about 30 KB.
- `vite.config.js`: `build.rollupOptions.output.manualChunks: { react: ['react', 'react-dom'], realtime: ['socket.io-client'] }` gives vendor chunks that stay cached across app deploys, once F2 makes caching work.
- Keep `src/api.js` from being both statically and dynamically imported (the build warns about this; `i18n/index.jsx` imports it dynamically).

**Expected gain:** initial JS from 253 KB gzip to about 160–175 KB for the chat view and about 70 KB for login. Mobile bootup and TBT drop by about 30% (chat TBT 409 ms → about 250 ms). Warm deploys re-download only app chunks.

### F6. History pagination race → duplicate React keys → stale rows and memory after switching

**Evidence**
- `App.jsx:556-569` (`handleLoadMore`) guards with `isLoadingHistory` state that is read from a render closure. `ChatArea.jsx:249` calls it from every scroll event under 80 px. When two scroll events arrive before React re-renders (in the benchmark: a native scroll event plus one synthetic scroll event; in real use: scrollbar drag, `Home` key or momentum at the top), two requests with the same `before=` are sent, and the page is prepended twice. No merge step deduplicates by id.
- Measured: after an aggressive history load, **5,500 rows rendered for only 750 unique messages**. Duplicate `key={msg.id}` breaks reconciliation. After switching to another channel, **3,730–4,130 rows of the old channel stayed in the DOM** (88–96 MB heap), and a minimal reproduction left 1,030 rows. A realistic wheel scroll did not reproduce it (400/400 unique, clean switch), so this needs a racing event, but nothing in the code prevents one.

**Fix:** keep an in-flight ref (`loadingRef.current`) checked at the top of `handleLoadMore`, merge pages through a `Map` by `id` (also for the socket `new_message` path), and cancel with an `AbortController` when `activeChannelId` changes. Virtualization (F1) with stable keys prevents the DOM part.

**Expected gain:** correctness, plus bounded memory. It removes a 90 MB and 180k-node leak in the worst case.

### F7. Layout shift of 0.35 on the chat view

**Evidence:** the `layout-shift` sources recorded by the runtime script (Lighthouse desktop CLS 0.350, mobile 0.046–0.391):
1. About 740 ms, 0.168: `ServerRail.jsx:307` (`div.relative.group.flex`, the server list populating after `/api/initial-data`) and the whole chat pane `ChatArea.jsx:660` (`div.flex-1.bg-d-canvas…`), which moves when the rail and channel sidebar get their content or width.
2. About 1.3 s, 0.133: the message list wrapper. `ChatArea.jsx:895` shows the "Welcome to #channel" header whenever `!hasMoreHistory && !isLoadingMessages`, which is true on the first render, before the channel's history request has even started. It is then replaced by the skeleton, then by the messages.

**Fix:** give the rail and sidebar fixed widths and skeleton items from the first paint (`w-[72px]`/`w-60` shells, not content-sized). Initialize `isLoadingMessages` to `true` when the URL contains a channel id (`App.jsx:143`), and show the welcome header only after a completed load with `hasMoreHistory === false`. Reserve avatar boxes with `width`/`height` (F3).

**Expected gain:** CLS from 0.35 to under 0.05. Chat desktop Lighthouse gains about 15 points on its own.

### F8. Critical request chain: messages wait for 4 sequential API round trips

**Evidence:** Lighthouse waterfall (chat, desktop): `auth/me` (261 ms) → `initial-data` (352 ms) → `servers/:id` + `permissions` + `stickers` (353–400 ms) → `messages` (**580 ms**). The load order is in `App.jsx:218`, `App.jsx:282` and `App.jsx:367-373`. The message effect (`App.jsx:461-470`) waits for `channelExists`, which requires the server detail. socket.io also does 4 polling XHRs before upgrading (`App.jsx:48`).

**Fix:**
- Once `/api/auth/me` resolves and the URL names a channel, start `GET /api/messages/:channelId?limit=50` immediately, in parallel with `initial-data`. It needs only the channel id, and the server already checks access. Keep the promise in a module-level map and let the effect consume it.
- Better: add an optional `?channel=` parameter to `/api/initial-data` that embeds the server detail and the first page, which makes the whole chain 1 round trip.
- Add `<link rel="preload" href="/api/auth/me" as="fetch" crossorigin="use-credentials">` in `index.html`.
- `io({ withCredentials: true, transports: ['websocket', 'polling'] })` tries WebSocket first and saves 3 round trips before realtime is live.
- Cache `pins`, `commands` and `threads` per channel with stale-while-revalidate, so a re-open costs 1 request.

**Expected gain:** messages visible 2–3 RTT earlier, about 300 ms on desktop and 0.6–1.2 s on 4G. Channel re-open goes from 4 API requests to 1.

### F9. Render-blocking Google Fonts from a third-party origin

**Evidence:** `index.html:8-10` loads `fonts.googleapis.com/css2?family=Inter:300..800&family=Kanit:300..700`. It is render-blocking at about 810 ms on mobile and 260 ms on desktop. It needs 2 extra origins (DNS, TLS), and the privacy and CSP surface grows (`lib/middleware.js:32-33`). 11 weights are declared. Only Inter latin (48 KB) was actually fetched for the English UI.

**Fix:** self-host the fonts: `@fontsource-variable/inter` (one variable woff2, latin subset about 48 KB) and a Kanit **thai subset** with `unicode-range: U+0E00-0E7F`, so it downloads only when Thai text appears. Add `<link rel="preload" as="font" type="font/woff2" crossorigin href="/assets/inter-latin-var.woff2">` and use `font-display: swap`. Drop the preconnects and the googleapis entries from the CSP. With F2, fonts get `immutable` too.

**Expected gain:** FCP −250 ms (desktop) to −800 ms (mobile), no third-party dependency (the app also works on a LAN without internet), and CSP tightened.

### F10. No service worker or precache

**Evidence:** the repository has no `serviceWorker` registration. Every visit goes to the network for the shell and assets. After F2, hashed assets are cached, but the shell, the first API calls and the avatars still need round trips.

**Fix:** `vite-plugin-pwa` (Workbox `generateSW`) with `globPatterns: ['**/*.{js,css,woff2,svg}']` precaches the hashed build without the locale chunks (runtime-cache those). Add `navigateFallback: '/index.html'` and a `navigateFallbackDenylist` for `/api`, `/uploads` and `/socket.io`. Runtime caching: `CacheFirst` for `/uploads/*` (content-addressed, immutable) with a 500-entry and 30-day expiry, and `StaleWhileRevalidate` for `/api/users/@me/emojis` and `stickers`. Use `registerType: 'prompt'` and show a toast when a new version is ready.

**Expected gain:** repeat-visit FCP under 0.5 s on mobile (shell from cache), instant avatars, and offline shell and read-only history.

### F11. Channel open costs 15 requests and a full list reset

**Evidence:** warm channel open measured p50 196–373 ms locally. `App.jsx:491` clears the messages (`setMessages([])`) and re-fetches on every visit, even to a channel the user viewed seconds earlier. There is no per-channel cache.

**Fix:** keep an LRU of the last 10 channels' newest page (messages plus scroll position) in a ref or store. Render from the cache immediately and revalidate with `after=<newest cached id>`. Prefetch a channel's first page on sidebar hover or focus.

**Expected gain:** re-open under 50 ms (a cache hit renders in one frame), and fewer API reads, relevant to the 600/min read rate limit.

### F12. Smaller items

- `index.html:5` declares the favicon `type="image/svg+xml"` but it is a PNG on a third-party CDN. Self-host an SVG.
- `bf-cache` is ineligible (1 reason reported by Lighthouse). Back/forward navigation reloads the whole app. Check the `unload` listeners and the `Cache-Control: no-store` responses (`server.js:1502`).
- `ChatArea.jsx:126-130` (`nameFor`) and `ChatArea.jsx:205-221` (`markdownContext`) do `members.find` or `flatMap` per lookup. Build `Map`s once per `members` or `customEmojis` change. This is O(rows × members) during parse at 5k rows.
- Tailwind CSS is 75.6 KB raw and 13.6 KB gzip, and Lighthouse reports 0 unused CSS at first paint. No action beyond compression (F2).

---

## 3. Expected gain summary

"Effort" is S (≤ 1 day), M (2–4 days) or L (≥ 1 week).

| # | Fix | Effort | Primary metric | Now | Expected |
|---|---|---|---|---|---|
| F2 | Fix immutable regex, add brotli/gzip | **S** | Login mobile LCP / FCP / score | 7.2 s / 6.1 s / 61 | **3.5 s / 2.2 s / 88** (measured what-if) |
| F3 | Use existing WebP variants, `<Avatar>`, lazy/eager, srcset | S–M | Chat mobile LCP / bytes | 23.5 s / 4.8 MiB | about 2.5–3 s / about 1 MiB |
| F4 | Throttle `mark_read`, no echo, rAF-batched socket updates | S | Frames dropped at 100 msg/s | 73% (50 rows) to 95% (5k rows) | under 5% |
| F7 | Fixed shell and skeleton, loading state from first render | S | CLS chat | 0.35 | under 0.05 |
| F6 | In-flight guard and id-dedupe for history | S | Stale rows or heap after switching (worst case) | 4k rows / 90 MB | 0 |
| F1 | Composer split, memo `MessageRow`, react-virtual, windowing, hover-only toolbar | **L** | Keystroke → frame at 5k rows (INP) | 420–708 ms (4×: 4–5 s) | **under 25 ms** (4×: under 60 ms) |
| F1 | ″ | ″ | Scroll fps at 5k rows / heap | 25–42 fps / 106–117 MB | 60 fps / under 25 MB |
| F5 | `React.lazy` modals, auth-gate split, vendor chunks | M | Initial JS gzip (chat / login) | 253 / 253 KB | about 165 / about 70 KB |
| F8 | Parallel first-page fetch, WS-first socket, SWR per-channel extras | M | Time to messages request | 580 ms after the JS | about 250 ms |
| F9 | Self-host Inter variable + Kanit thai subset | S | Render-blocking time (mobile) | about 810 ms | 0 |
| F11 | Per-channel LRU cache and hover prefetch | M | Warm channel open | p50 196–373 ms | under 50 ms |
| F10 | Workbox precache and uploads CacheFirst | M | Repeat-visit FCP (mobile) | about 2.2 s after F2 | under 0.5 s |

After F2, F3, F4, F7 and F9 (all S effort), expect Lighthouse mobile of about 85–90 for login and about 75–85 for chat. F1 is what makes long channels usable and the INP pass.

---

## 4. What is fine already

- **i18n** (`src/i18n/index.jsx:18-25`): `import.meta.glob` makes each of the 31 locales a lazy chunk, and only `en.js` (4% of the entry) is bundled.
- **lucide-react** named imports tree-shake: 132 icons, 3.2% of the entry. The cost is in rendering them per row (F1), not in their size.
- **No duplicate packages** in the client graph.
- **Channel switching does not leak** when history is loaded normally. Over 42 switches, heap went 6.6 → 5.9 MB, nodes 2,049 → 2,049, listeners 598 → 598, and there was no detached DOM.
- **Markdown parsing is cached** per message (`ChatArea.jsx:228-241`). The remaining cost is the JSX and reconcile per row, not parsing.
- **Uploads** (`/uploads/*`) are content-addressed and served `public, max-age=31536000, immutable`, and attachments reserve their aspect ratio with a tiny WebP placeholder. That is good for CLS.
- **CSS** has no unused rules at first paint (Tailwind v4 JIT).

---

## How to reproduce

```bash
git merge --no-edit claude/dreamy-goldberg-p3o5ao        # if not already merged
npm ci && npm run build
npm i --no-save playwright-core lighthouse rollup-plugin-visualizer   # install together: a later --no-save install prunes the others
export PERF_OUT=/tmp/discord-perf CHROME_PATH=/opt/pw-browsers/chromium

node scripts/perf/headers.mjs                     # cache + compression headers           → headers.json
node scripts/perf/bundle.mjs                      # chunk sizes, entry composition, dups  → bundle.json, bundle-treemap.html
node scripts/perf/lighthouse.mjs                  # login + chat, mobile + desktop, 3 runs → lighthouse-summary.json, lh-*.report.html
PERF_LH_BLOCK_FONTS=1 node scripts/perf/lighthouse.mjs   # counterfactual: no Google Fonts
PERF_LH_WHATIF=1      node scripts/perf/lighthouse.mjs   # counterfactual: brotli + immutable (front proxy on PERF_PORT+1)
node scripts/perf/runtime.mjs                     # 5,000-msg channel: open, typing, scroll, burst, leaks, images → runtime.json (about 20 min)
node scripts/perf/renders.mjs                     # React component render counts per event → renders.json
```

| Script | What it does |
|---|---|
| `scripts/perf/lib.mjs` | Boots `server.js` (`SERVE_STATIC=1`, temp DB and storage, port `PERF_PORT`=5950, write and register rate limits raised), and stops only its own PID. Includes an API client, a PNG generator, and `seedWorld()` (users with 1024² avatars, a guild, N channels, a long channel with mixed Markdown, code and Thai text, and image attachments). |
| `headers.mjs` | Origin `Cache-Control` and `Content-Encoding`, raw vs gzip vs brotli per resource. `PERF_BASE=https://host` audits a deployed instance. |
| `bundle.mjs` | Rebuilds with the app's `vite.config.js` plus the visualizer into `$PERF_OUT/bundle-dist` (the real `dist/` is untouched). |
| `lighthouse.mjs` | Lighthouse node API with `chrome-launcher`. Chat is authenticated with a `Cookie` extra header. Takes the median of `PERF_LH_RUNS`. |
| `runtime.mjs` | Playwright and CDP: `Performance.getMetrics`, `HeapProfiler` snapshots (detached DOM), `Emulation.setCPUThrottlingRate`, longtask and layout-shift observers, and `routeWebSocket` to inject exact-rate socket.io frames. |
| `renders.mjs` | Unminified production build served via `STATIC_DIR`, plus a minimal `__REACT_DEVTOOLS_GLOBAL_HOOK__` that counts rendered fibers per commit, the way React DevTools does (PerformedWork flag, subtrees only where the child pointer changed). |

Rerun `runtime.mjs` and `renders.mjs` after F1 and F4. They are the regression suite for those fixes. A reasonable CI budget: keystroke p95 under 50 ms at 1,000 rows, burst dropped frames under 10%, component renders per keystroke under 20.

## Methodology notes and caveats

- **Localhost:** there is no real network latency. Lighthouse's mobile preset simulates slow 4G (150 ms RTT, 1.6 Mbps) and 4× CPU with Lantern. The runtime script runs at 1× CPU on a 4-core container, unless noted as 4×.
- **Noisy machine:** other workloads shared the container (load average up to 30 on 4 cores during the last run). Each number is a range over the four quiet runtime runs, A–D (run A stopped before the burst at 5k rows). One run under heavy contention is excluded; it roughly doubled every latency (typing at 3,950 rows timed out at 180 s, and scroll fell to 14.7 fps).
- **Row count at "≈5,000":** runs B, C and D loaded history with a native scroll event plus a synthetic `scroll` dispatch per page. That exposed F6, so those runs rendered 5,050–5,500 rows, of which only about 750 were unique ids in run D. The render, typing and scroll costs depend on rendered rows, so those numbers stand. The script now issues one native scroll per page. A clean run with unique rows reproduced the same per-row costs: 43.7 nodes per row and about 23 KB of heap per row (92 MB at 3,950 unique rows).
- **INP:** headless Chromium does not emit Event Timing entries for CDP-dispatched input, so "keystroke → next frame" (from `event.timeStamp` to the task after the next rAF) stands in for INP's input-delay plus processing plus presentation.
- **Synthetic images:** the seeded PNGs are noisy gradients. Real photos compress differently, but the ratio between original and variant (1024² vs 64², 1600 px vs 800 px) is what matters for F3.
- **Burst rate:** the end-to-end API burst was limited by the server (37–61 msg/s with SQLite and fan-out on this box). The 100/s client measurement therefore injects `new_message` frames into the page's real socket through Playwright's `routeWebSocket`, while the real server connection stays live, so the `mark_read` emits and echoes are genuine.
