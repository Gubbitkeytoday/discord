# Discord appearance system (2023–2026) and our open equivalent

Research date: 2026-09-26. Scope: everything Discord exposes under *Appearance*, *Accessibility* and the Nitro personalisation perks, plus what we should build, give away free, and how.

**How to read the citations.** `[S#]` points to the source table at the end, which gives each source's link and date. Items marked **(unverified)** come from one secondary source, a search-engine snippet, or our own reverse engineering, and were not checked against the live client or an official Discord page. The research proxy blocked support.discord.com, discord.com, fandom, PC Gamer and Engadget, so official pages were read through search-result snippets. Colour values come from Discord client CSS that the community extracted and published on GitHub `[S20–S24]`. Contrast ratios were computed by us with the WCAG 2.x relative-luminance formula (the script is described in Appendix B).

---

## สรุปภาษาไทย (Thai summary)

**Discord ทำอะไรบ้าง**
- **ธีมพื้นฐาน 4 แบบ ฟรีทั้งหมด:** Light, Ash, Dark และ Onyx พร้อมตัวเลือก "Sync with computer" มาพร้อมการปรับโฉมเดสก์ท็อปเมื่อ 25 มี.ค. 2025 `[S1][S2]`
  - Ash คือธีมมืดแบบเดิม (#313338) ที่ปรับคอนทราสต์ให้ดีขึ้น
  - Dark เข้มกว่า Ash
  - Onyx เกือบดำสนิทสำหรับจอ OLED (บนมือถือเคยชื่อ "Midnight")
  - ส.ค. 2026 มือถือได้ทั้ง 4 ธีมตามมา พร้อมรูปทรง "squircle" และความหนาแน่น Compact/Default/Spacious `[S5][S6]`
- **ธีมไล่สี (gradient) ต้องใช้ Nitro:** เริ่ม มี.ค. 2023 ด้วย 16 ธีม แล้วเพิ่มอีก 5 ใน เม.ย. 2023 `[S8][S9]`
  - ก.ย. 2025 เพิ่ม "Custom Theme" เลือกได้สูงสุด 5 สี ปรับทิศทางการไล่สีและความเข้มของสีได้ `[S10]`
  - ทางเทคนิค Discord ผสมสีธีมเข้ากับทุกพื้นผิวด้วย `color-mix(in oklab, …, var(--theme-base-color) var(--theme-base-color-amount))` `[S20][S21]`
- **ไอคอนแอปแบบกำหนดเอง:** สำหรับ Nitro ตั้งแต่ ก.ย. 2023 `[S15]`
- **การตั้งค่าที่ฟรี:**
  - ขนาดฟอนต์แชท 12–24px, ซูม
  - โหมดแสดงข้อความ Cozy/Compact, ระยะห่างระหว่างกลุ่มข้อความ
  - ความอิ่มตัวของสี (saturation), คอนทราสต์, High Contrast
  - Reduced Motion, "Always underline links"
  - การแสดงสีของ role, การเล่นอีโมจิ/GIF/สติกเกอร์อัตโนมัติ `[S7][S13]`
- **สิ่งที่ Discord ยังไม่มี:** ฟอนต์สำหรับผู้มีภาวะดิสเล็กเซีย แม้ผู้ใช้จะขอมาหลายปี `[S14][S25]`
- **ธีมตามเทศกาล:** Snowsgiving (ธีมหิมะ, เสียง, แอนิเมชันโหลด ปิดได้ด้วย "Show Seasonal Theme") และ "Event Sound Pack" ของ Halloween 2024 และ Winter 2025 `[S16][S17]`
- **เสียงตอบรับจากผู้ใช้:** การออกแบบใหม่ทั้งปี 2023 (มือถือ) และ 2025 (เดสก์ท็อป) โดนต่อต้านหนัก จนมีคำร้อง Change.org `[S11][S12][S19]`
  - บทเรียนคือ ต้องให้ผู้ใช้เลือกความหนาแน่นเองได้ และห้ามลดขนาดเป้าคลิกหรือคอนทราสต์

**แอปของเรามีอะไรแล้ว (จาก `src/index.css` และ `useUserSettings.js`)**
- มีแล้ว: ธีม light/ash/dark/onyx + system, UI density, message display, zoom, font scale, group spacing, saturation, high contrast, reduced motion และ role colors
- **ปัญหาที่พบ:**
  1. ธีม Ash ปัจจุบันไม่ผ่าน WCAG AA: text3 = 3.87:1, text4 = 2.90:1
  2. `text4` (#80848e) ไม่ผ่านใน dark (3.68:1) และ light (3.74:1)
  3. saturation ใช้ `filter: saturate()` ทั้งหน้า จึงทำให้รูปภาพ/อวาตาร์ซีดไปด้วย ต่างจาก Discord ที่ลดเฉพาะสี UI
  4. "system" ถูกบังคับเป็น dark เสมอ เลือกไม่ได้ว่าจะใช้ Ash/Dark/Onyx

**ข้อเสนอ (ทำฟรีทั้งหมด ไม่มี paywall)**
1. ใช้โทเคนชุดใหม่ที่ตรวจคอนทราสต์แล้ว (ตารางในหัวข้อที่ 3) โดยข้อความรองทุกระดับต้อง ≥ 4.5:1 บนทุกพื้นผิว — **S**
2. แก้ saturation ให้คูณค่า chroma ใน OKLCH ของโทเคน แทนการใช้ filter — **M**
3. ธีมไล่สีฟรี 12 แบบ (ชื่อและสีเป็นของเราเอง) พร้อม custom theme สูงสุด 5 สี วางชั้นพื้นหลังแบบ "scrim" เพื่อให้ข้อความผ่าน 4.5:1 ทุกจุด — **M**
4. เพิ่ม "Always underline links", แถบ contrast, ตัวเลือกฟอนต์อ่านง่าย (Atkinson Hyperlegible / OpenDyslexic), การเลือกธีมมืดสำหรับโหมด system และสวิตช์ธีมเทศกาล — **S–M**

---

## 1. Timeline at a glance

| Date | Change | Free / Nitro | Source |
|---|---|---|---|
| 2022-12-01 → early 2023 | Font changes from Whitney to **gg sans**. Users complain about readability, especially people with dyslexia or astigmatism. | Everyone | `[S14]` |
| 2023-03 (≈03-17) | **Nitro Themes** launch on desktop with 16 gradient/colour themes. Anyone can preview them. | Nitro | `[S8]` |
| 2023-04 | 5 more themes: Retro Storm, Strawberry Lemonade, Aurora, Sepia, Neon Nights | Nitro | `[S9]` |
| 2023-09 | **Custom app icons**: they change the home-screen icon on mobile, but only the in-app icon on desktop | Nitro and Nitro Basic | `[S15]` |
| 2023-12-05 | Mobile redesign: separate Servers/Messages tabs, a "You" tab and a Midnight theme | Everyone | `[S11]` |
| 2024-05-22 | Partial rollback: the unified server+DM view returns, and a **contrast slider** joins the saturation slider on mobile | Everyone | `[S12]` |
| 2024-10 | First **Event Sound Pack** (Halloween) | Everyone, desktop only | `[S17]` |
| 2025-03-25 | Desktop **"new look"**. Four free base themes (Light, Ash, Dark, Onyx). UI density Compact/Default/Spacious. Resizable channel list. Squircle icons, rounded containers, a taller title bar and a floating user panel. Petitions follow. | Everyone | `[S1][S2][S3][S19]` |
| 2025 (mid) | **Enhanced Role Styles**: gradient and holographic role colours | Server perk, costs 3 boosts | `[S18]` |
| 2025-09-04 | **Custom Themes**: up to 5 colours, a gradient-direction slider, an intensity slider, and "Surprise me" | Nitro | `[S10]` |
| 2025-12-19 → 2026-01-05 | Winter event sound pack | Everyone, desktop only | `[S17]` |
| 2026-08-06 | Mobile visual refresh ("Squircles, Styles, and Spacing"). Ash, Dark and Onyx come to mobile, Midnight is renamed Onyx, and density plus Default/Compact message spacing arrive. | Everyone | `[S5][S6]` |

---

## 2. Base themes

### 2.1 What Discord does

- **Themes and cost.** Light, Ash, Dark, Onyx and **Sync with computer**. Since 2025-03 all of them are free. Before that, free users only had light and dark. `[S1][S7]`
- **Ash** is "the same dark theme longtime players know and love, now with improved contrast" `[S1][S6]`. It is described as "mid-grey background with white text" `[S6]`.
- **Dark** is described as "dark grey background". **Onyx** is "gray and black" and true black on mobile, to save OLED power `[S6]`.
- **Sync with device.** The toggle is labelled "Same as Device Theme" on mobile. It maps OS light to Light and OS dark to your chosen dark theme **(unverified; the mapping is inferred from a support-page snippet)**. It takes priority over "Sync across devices". `[S6]`
- **Legacy names.** Before 2025, desktop had Dark (#313338) and Light, and Nitro users could experimentally pick "Darker"/"Midnight". In the client CSS these still exist as classes:
  - `.theme-dark` is Ash
  - `.theme-darker` is Dark
  - `.theme-midnight` is Onyx
  - **(reverse engineered from the community override sheet `[S21]`, which targets exactly those classes)**

**Screenshot description (desktop, 2025).**
- A narrow server rail of squircle icons on the far left, with the lowest surface colour.
- A channel sidebar in the same tone. The user panel floats as a rounded card at the bottom-left, inset from the edges.
- A title bar across the top that shows the server name.
- The chat area in a slightly lighter tone, with 8px-radius message hover states.
- In Onyx, the chat and rail are black and only the popovers stay grey.

### 2.2 Reverse-engineered palettes

Discord's 2024+ system is a **100-step neutral ramp** (`--neutral-1` … `--neutral-100`, hue 240°, 5–9 % saturation, scaled by `--saturation-factor`). Semantic tokens pick steps from it `[S20][S22]`.

**Semantic background tokens, 2025 client (`.theme-dark` = Ash), from `[S22]`:**

| Discord token | Neutral step | Hex | Used for (observed) |
|---|---|---|---|
| `--background-base-lowest` | neutral-73 | `#2c2d32` | server rail / deepest layer |
| `--background-base-lower` | neutral-69 | `#323339` | sidebars, chat |
| `--background-base-low` | neutral-66 | `#36373e` | secondary panels |
| `--background-surface-high` | neutral-64 | `#393a41` | cards |
| `--background-surface-higher` | neutral-62 | `#3c3d45` | popovers |
| `--background-surface-highest` | neutral-60 | `#3f4048` | modals, menus |
| `--app-frame-background` | neutral-78 | `#25262a` | title bar / frame |
| `--text-strong` | neutral-1 | `#ffffff` | headings |
| `--text-default` | neutral-10 | `#dcdcdf` | body |
| `--text-subtle` | neutral-16 | `#c5c6ca` | secondary labels |
| `--text-muted` | neutral-23 | `#abacb2` | timestamps, hints |
| `--text-link` | blue-new-27 | `#76aff6` | links |
| `--text-brand` | blurple-26 | `#94a8ff` | brand text |
| `--border-subtle / normal / strong` | `#97979f` at 12 % / 20 % / 44 % | — | dividers, inputs |
| `--interactive-background-hover / active / selected` | `#97979f` at 8 % / 16 % / 20 % | — | row states |
| `--brand-500` | — | `#5865f2` | primary buttons |

**Dark and Onyx overrides (approximate, unverified).** These come from a community sheet that mirrors Discord's `.theme-darker` / `.theme-midnight` rules `[S21]`:

| Role | Dark (`.theme-darker`) | Onyx (`.theme-midnight`) |
|---|---|---|
| primary surface | neutral-80 `#232327` | neutral-96 `#0a0a0c` |
| secondary surface | neutral-84 `#1d1d21` | neutral-98 `#050506` |
| deepest | neutral-89 `#161619` | neutral-100 `#000000` |
| floating (menus) | neutral-95 `#0c0c0e` | neutral-100 `#000000` |

**Legacy Dark, 2023–2024, from `[S20]`:**
- bg-primary `#313338`
- bg-secondary `#2b2d31`
- bg-tertiary `#1e1f22`
- floating `#111214`
- text-normal `#dbdee1`
- text-muted `#949ba4`
- link `#00a8fc`

Our current default dark theme is exactly this palette.

**How the tint works.** Every semantic token is written as
`color-mix(in oklab, var(--neutral-N) 100%, var(--custom-theme-base-color, #000) var(--custom-theme-base-color-amount, 0%))`, with a parallel `--custom-theme-text-color` / `-amount` for text `[S21][S22]`. This one mechanism powers Nitro colour themes, custom themes and profile themes. Every surface and text colour is pulled toward the theme colour by a small percentage, and a gradient is painted behind `html.custom-theme-background`.

**Saturation.** Every HSL value is written as `hsl(H calc(var(--saturation-factor,1) * S%) L%)` `[S20]`. The accessibility slider therefore desaturates **UI tokens only**, not user images. (The saturation slider affects "buttons, status indicators, and clickable links" `[S13]`.)

### 2.3 Contrast of Discord's palettes (computed by us)

| Pair | Ratio | WCAG AA text (4.5) |
|---|---|---|
| Legacy dark text-normal `#dbdee1` on `#313338` | 9.36 | pass |
| Legacy dark text-muted `#949ba4` on `#313338` | **4.50** | borderline pass |
| Legacy dark channel names `#80848e` on `#2b2d31` | **3.68** | fail |
| Legacy dark link `#00a8fc` on `#313338` | 4.82 | pass |
| 2025 Ash text-default on base-lower | 9.20 | pass |
| 2025 Ash text-muted `#abacb2` on base-lower | 5.56 | pass |
| 2025 Ash text-muted on surface-highest | 4.55 | pass |
| Dark (approx) text-muted on `#232327` | 6.92 | pass |
| White on blurple `#5865f2` | 4.61 | pass |

Takeaway: the 2025 "improved contrast" claim holds up. Muted text rose from 4.50 to 5.56, and the fail-level `#80848e` channel grey disappeared.

### 2.4 Our current state (read from `src/index.css`)

| Our token | Theme | Ratio | Verdict |
|---|---|---|---|
| `text3 #949ba4` on canvas `#313338` | dark | 4.50 | borderline |
| `text4 #80848e` on surface `#2b2d31` | dark | **3.68** | fail |
| `text4 #80848e` on canvas `#ffffff` | light | **3.74** | fail |
| `text3 #949ba4` on canvas `#3b3d42` | ash | **3.87** | fail |
| `text4 #80848e` on canvas `#3b3d42` | ash | **2.90** | fail |
| `text4 #80848e` on canvas `#181a1e` | onyx | 4.65 | pass |

There are three other gaps:
- Our "dark" is Discord's *legacy* dark. It is lighter than Discord's 2025 "Dark", so our ordering Ash > Dark > Onyx is right, but our Ash is lighter than Discord's Ash.
- `appearance.theme === 'system'` always resolves to `dark` (`useUserSettings.js:285`). Users cannot pick Ash or Onyx as their "system dark".
- Saturation uses `filter: saturate()` on `:root`. That desaturates avatars, images, video and emoji too, unlike Discord.

### 2.5 Recommendation (all free)

- **Token architecture.** Keep Tailwind v4 `@theme` for the *utility names*, but give them **semantic** names that mirror Discord's layer model. Themes override only raw values under `:root[data-theme=…]`. See section 3.
- **System theme.** Add `appearance.systemDarkTheme: 'ash'|'dark'|'onyx'` and `systemLightTheme: 'light'`. Resolve through `matchMedia('(prefers-color-scheme: dark)')`. **S**
- **OLED.** Onyx keeps the chat at pure `#000` and lifts only floating surfaces. On mobile or PWA, set `<meta name="theme-color">` per theme. The PWA observer already watches `data-theme`. **S**
- **Palette effort.** Replacing the palette values is **S**. Renaming tokens across components is **M**, because it touches every `bg-d-*` class. Do it with a codemod: map old names to new names and keep the old names as aliases for one release.

---

## 3. Proposed token palette (contrast-checked)

### 3.1 Token set

The names are ours. The layering mirrors Discord's base/surface split, so community theme authors can map to them easily.

| Token (`--color-*` in `@theme`) | Role |
|---|---|
| `bg-app` | window frame, server rail, title bar |
| `bg-sidebar` | channel list, member list, DM list |
| `bg-chat` | message area |
| `bg-surface` | cards, embeds, settings panels |
| `bg-raised` | popovers, menus, modals |
| `bg-input` | composer, text fields |
| `bg-hover` | row hover (opaque; see the note in 3.4) |
| `bg-selected` | selected channel / row |
| `text-strong` | headings, usernames |
| `text-default` | message body |
| `text-muted` | timestamps, secondary labels, channel names |
| `text-faint` | placeholders and disabled only; never on `bg-selected` |
| `text-link` | links |
| `text-brand` | brand-coloured text, mentions |
| `text-danger`, `text-positive` | status text |
| `border-subtle` | decorative dividers (no contrast requirement) |
| `border-strong` | input outlines, toggles (≥ 3:1, WCAG 1.4.11) |
| `focus-ring` | `:focus-visible` outline (≥ 3:1 against adjacent surfaces) |
| `brand`, `on-brand` | primary button fill and its label |

### 3.2 Values

| Token | Light | Ash | Dark | Onyx |
|---|---|---|---|---|
| bg-app | `#e3e4e8` | `#2a2b30` | `#121214` | `#000000` |
| bg-sidebar | `#f0f1f4` | `#303137` | `#18181b` | `#08080a` |
| bg-chat | `#fbfbfc` | `#35363c` | `#1c1c20` | `#000000` |
| bg-surface | `#ffffff` | `#3b3c43` | `#232328` | `#131316` |
| bg-raised | `#ffffff` | `#3f4048` | `#28282e` | `#18181c` |
| bg-input | `#e8e9ec` | `#40414a` | `#26262b` | `#141417` |
| bg-hover | `#e6e7ea` | `#3a3b41` | `#222226` | `#111114` |
| bg-selected | `#d9dade` | `#44454d` | `#2c2c32` | `#1d1d22` |
| text-strong | `#060607` | `#ffffff` | `#ffffff` | `#ffffff` |
| text-default | `#2e3035` | `#e0e0e3` | `#dcdcdf` | `#d6d6da` |
| text-muted | `#5b5d66` | `#b1b2b8` | `#a3a4ab` | `#9c9da4` |
| text-faint | `#62646d` | `#aeafb5` | `#97989f` | `#8a8b93` |
| text-link | `#0063a6` | `#8cbdf8` | `#76aff6` | `#76aff6` |
| text-brand | `#4450c9` | `#a4b1ff` | `#9aa6ff` | `#9aa6ff` |
| text-danger | `#b3261e` | `#ff9d98` | `#ff7b75` | `#ff7b75` |
| text-positive | `#18693a` | `#6fcf8b` | `#5fc47d` | `#5fc47d` |
| border-subtle | `#c9cbd1` | `#56575f` | `#3a3a41` | `#2c2c31` |
| border-strong | `#7d7f88` | `#8a8b93` | `#6e6f78` | `#65666e` |
| focus-ring | `#4450c9` | `#a4b1ff` | `#9aa6ff` | `#9aa6ff` |
| brand / on-brand | `#5865f2` / `#ffffff` | same | same | same |

Onyx deliberately softens `text-default` to `#d6d6da`, which is still 14.5:1. Pure white on pure black causes halation for many readers with astigmatism.

### 3.3 Minimum contrast over all eight backgrounds (computed)

The minimum is taken across app, sidebar, chat, surface, raised, input, hover and selected.

| Foreground | Light | Ash | Dark | Onyx |
|---|---|---|---|---|
| text-strong | 14.50 | 9.53 | 13.88 | 16.79 |
| text-default | 9.45 | 7.23 | 10.14 | 11.58 |
| text-muted | 4.69 | 4.50 | 5.59 | 6.21 |
| text-link | 4.51 | 4.88 | 6.10 | 7.38 |
| text-brand | 4.64 | 4.68 | 6.13 | 7.41 |
| text-danger | 4.68 | 4.78 | 5.51 | 6.67 |
| text-positive | 4.82 | 4.98 | 6.40 | 7.74 |
| focus-ring | 4.64 | 4.68 | 6.13 | 7.41 |
| text-faint (excl. selected) | 4.64 | 4.63 | 4.83 | 4.95 |
| text-faint on bg-selected | 4.22 ✗ | 4.35 ✗ | 4.83 | 4.95 |
| border-strong vs chat / surface / raised | 3.86 / 3.99 / 3.99 | 3.55 / 3.24 / 3.04 | 3.40 / 3.13 / 2.94 ✗ | 3.68 / 3.25 / 3.10 |
| on-brand (white on `#5865f2`) | 4.61 | 4.61 | 4.61 | 4.61 |

Every text token passes AA 4.5:1 on every surface. The two exceptions are `text-faint` on `bg-selected` in Light and Ash, so lint for that pairing. In Dark, `border-strong` should not be used on `bg-raised`; use `#74757e` there, or simply use `text-muted` as the outline.

### 3.4 CSS approach (Tailwind v4)

```css
@import "tailwindcss";

/* 1. Raw values: the Dark theme is the default. */
@theme {
  --color-bg-app: #121214;   --color-bg-sidebar: #18181b;  --color-bg-chat: #1c1c20;
  --color-bg-surface: #232328; --color-bg-raised: #28282e; --color-bg-input: #26262b;
  --color-bg-hover: #222226; --color-bg-selected: #2c2c32;
  --color-text-strong: #fff; --color-text-default: #dcdcdf; --color-text-muted: #a3a4ab;
  --color-text-faint: #97989f; --color-text-link: #76aff6; --color-text-brand: #9aa6ff;
  --color-border-subtle: #3a3a41; --color-border-strong: #6e6f78; --color-focus-ring: #9aa6ff;
  --color-brand: #5865f2; --color-on-brand: #fff;
}
/* 2. Theme overrides: values only, never new names. */
:root[data-theme="light"] { --color-bg-app: #e3e4e8; /* … */ color-scheme: light; }
:root[data-theme="ash"]   { --color-bg-app: #2a2b30; /* … */ }
:root[data-theme="onyx"]  { --color-bg-app: #000;    /* … */ }

/* 3. Legacy aliases for one release: existing bg-d-* utilities keep working. */
@theme inline {
  --color-d-canvas: var(--color-bg-chat);
  --color-d-surface: var(--color-bg-sidebar);
  /* … */
}
```

- **Hover and selected.** Discord uses translucent overlays (`#97979f` at 8 %, 16 % or 20 %). We propose **opaque** hover and selected values instead, so contrast is deterministic and checkable. Translucent overlays are only needed on gradient themes (section 4.3).
- **Saturation (M).** Replace `filter: saturate()` with `--sat: 1` and author accent and status tokens in OKLCH:

  ```css
  --color-brand: oklch(58.5% calc(0.2 * var(--sat)) 277);
  ```

  Neutral greys are already near-zero chroma, so they are unaffected. Images and avatars stay untouched, which matches Discord's behaviour. It also removes the containing-block hazard documented in `index.css`.
- **Contrast slider (S).** Discord added one in 2024 `[S12]`. Implement `--contrast: 0…1` by interpolating each theme between its normal values and its high-contrast values: `color-mix(in oklab, var(--hc-text-muted) calc(var(--contrast)*100%), var(--base-text-muted))`. Keep the existing `data-contrast="high"` as the value 1.

---

## 4. Nitro colour themes, gradient themes and custom themes

### 4.1 What Discord does

- **Preset themes (Nitro).**
  - 2023-03: 16 themes. 2023-04: 5 more `[S8][S9]`. Later lists show about 23 presets, including Crimson Moon, Blurple Twilight and an Easter-egg theme `[S20]`.
  - Each preset is either a **light** or a **dark** gradient.
  - Anyone can *preview* a preset; applying it needs Nitro.
- **Custom Theme (Nitro, 2025-09-04).**
  - Pick light or dark as the base.
  - Choose **up to 5 colours** with a colour field, a hue slider, an eyedropper or hex input.
  - Set **gradient direction** and **colour intensity** with sliders. "Surprise Me" randomises.
  - The theme syncs across clients. `[S10]`
- **How a gradient is applied.**
  - A `linear-gradient(<angle>, stops…)` is set as `--custom-theme-background` on `html.custom-theme-background` `[S23]`.
  - Every surface token is then `color-mix`ed toward `--custom-theme-base-color` by `--custom-theme-base-color-amount`, and text toward `--custom-theme-text-color`. Surfaces become partly transparent, so the gradient shows through the sidebar and chat `[S21][S22]`.

**Preset gradient stops.** These are Discord's own colours, extracted from the 2024 client CSS `[S20]`. They are listed for **reference only**; we must not ship these names or exact combinations.

| Discord preset | Base | Stops (hex) |
|---|---|---|
| Mint Apple | light | `#56b69f` `#63bc61` `#9eca67` |
| Citrus Sherbert | light | `#f3b336` `#ee8558` |
| Retro Raincloud | light | `#3a7ca1` `#7f7eb9` |
| Hanami | light | `#efaab3` `#efd696` `#a6daa2` |
| Sunrise | light | `#9f4175` `#c49064` `#a6953d` |
| Cotton Candy | light | `#f4abb8` `#b1c2fc` |
| Lofi Vibes | light | `#a4c0f7` `#a9e4e8` `#b0e2b8` `#cfdfa2` |
| Desert Khaki | light | `#e7dbd0` `#dfd0b2` `#e0d6a3` |
| Sunset | dark | `#48288c` `#db7f4b` |
| Chroma Glow | dark | `#0eb5bf` `#4c0ce0` `#a308a7` `#9a53ff` `#218be0` |
| Forest | dark | `#142215` `#2d4d39` `#454c32` `#5a7c58` `#a98e4b` |
| Crimson Moon | dark | `#950909` `#000000` |
| Midnight Blurple | dark | `#5348ca` `#140730` |
| Mars | dark | `#895240` `#8f4343` |
| Dusk | dark | `#665069` `#91a3d1` |
| Under the Sea | dark | `#647962` `#588575` `#6a8482` |
| Retro Storm | dark | `#3a7ca1` `#58579a` |
| Neon Nights | dark | `#01a89e` `#7d60ba` `#b43898` |
| Strawberry Lemonade | dark | `#af1a6c` `#c26b20` `#e7a525` |
| Aurora | dark | `#062053` `#191fbb` `#13929a` `#218573` `#051a81` |
| Sepia | dark | `#857664` `#5b4421` |

Several Discord presets are risky for contrast. Mint Apple's `#63bc61` behind dark text scores about 2.5:1 unless the surfaces are heavily tinted. Chroma Glow's `#4c0ce0` against muted grey text is also low. Discord relies on opaque-ish tinted surfaces to stay legible. **(unverified: we did not measure the live client.)**

### 4.2 Recommendation: free gradient themes with original names

- Ship **12 presets free**, plus a **custom builder** (up to 5 stops, angle, intensity, shuffle). Nothing here costs us money to serve, so paywalling it would only copy Discord's business model, not its value.
- Store the choice as a user preference, e.g. `{ kind: 'gradient', base: 'dark', stops: [...], angle, intensity }`, so it syncs across devices.

**Contrast rule we enforce.**
- Text never sits directly on a raw gradient stop.
- Each stop is first mixed toward a **scrim**: `#0d0d10` at 45 % for dark bases, `#ffffff` at 55 % for light bases.
- Text uses the base theme's tokens (Dark or Light).
- The table reports the **worst stop**.

| Name (ours) | Base | Angle | Stops | Worst text-default | Worst text-muted | Worst link |
|---|---|---|---|---|---|---|
| Tidepool | dark | 160° | `#0f3b4a` `#155e63` `#1d4e6e` | 9.03 | 4.98 | 5.44 |
| Ember Dusk | dark | 145° | `#4a1d2f` `#7a2e2a` `#3a1f4d` | 10.24 | 5.64 | 6.16 |
| Deep Orchard | dark | 170° | `#16311f` `#2f4a2a` `#4a4a24` | 9.94 | 5.48 | 5.98 |
| Ultraviolet | dark | 135° | `#241a5c` `#4b1f73` `#16254f` | 11.52 | 6.35 | 6.93 |
| Night Market | dark | 120° | `#0b3a3a` `#3d2466` `#6a1f4f` | 11.05 | 6.09 | 6.65 |
| Graphite Rose | dark | 180° | `#2a2427` `#4a2e38` | 11.41 | 6.29 | 6.87 |
| Monsoon | dark | 155° | `#1f2f45` `#2e3f5c` `#35506a` | 9.55 | 5.26 | 5.75 |
| Peach Soda | light | 160° | `#ffd3b6` `#ffb5a7` `#f9c6d9` | 10.49 | 5.21 | 5.00 |
| Matcha Milk | light | 170° | `#d8ecc6` `#c7e3d4` `#e6edc0` | 11.49 | 5.71 | 5.48 |
| Paper Lantern | light | 150° | `#f6e7c1` `#f3d2a6` `#ecd9e6` | 11.27 | 5.60 | 5.38 |
| Glacier | light | 180° | `#cfe6f7` `#d9ddfb` `#e3f3f1` | 11.64 | 5.78 | 5.55 |
| Lilac Hour | light | 140° | `#e2d4fb` `#f6d2ea` `#d4dcfb` | 11.44 | 5.68 | 5.45 |

Every preset clears 4.5:1 for all text tokens at its worst point, and 7:1 for body text.

**Implementation (M).**

```css
:root[data-gradient] {
  --grad: linear-gradient(var(--grad-angle), var(--grad-stops));
  --scrim: #0d0d10; --scrim-amt: 45%;           /* light base: #fff and 55% */
}
:root[data-gradient][data-theme="light"] { --scrim: #fff; --scrim-amt: 55%; }
:root[data-gradient] body { background: var(--grad) fixed; }
/* Surfaces become translucent scrims over the gradient, stepped by elevation. */
:root[data-gradient] {
  --color-bg-app:     color-mix(in oklab, var(--scrim) calc(var(--scrim-amt) + 20%), transparent);
  --color-bg-sidebar: color-mix(in oklab, var(--scrim) calc(var(--scrim-amt) + 10%), transparent);
  --color-bg-chat:    color-mix(in oklab, var(--scrim) var(--scrim-amt), transparent);
  --color-bg-raised:  var(--color-bg-surface-solid); /* menus and modals stay opaque */
}
```

- **Keep floating surfaces opaque.** Menus, modals and tooltips should not show the gradient through them. Discord does the same, making surface-highest nearly solid.
- **Custom builder guardrail.** On every change, compute the worst-case contrast of `text-muted` over the mixed stops, as in Appendix B. If it drops below 4.5, auto-raise the scrim amount and show "Adjusted for readability". Never block the choice.
- **Intensity slider.** This maps to `--scrim-amt`, in the range 30–70 %. Clamp it at the minimum that satisfies the contrast guard.
- **Performance.** Use `background-attachment: fixed` on `body` only. Do not use `backdrop-filter` blur, which is expensive on low-end Android. Under reduced motion, never animate gradients.
- **Honour forced colours.** Under `@media (forced-colors: active)` and our own high-contrast mode, ignore `data-gradient`.

---

## 5. Custom app icons

- **What Discord does.** About 20 alternative icons for Nitro and Nitro Basic. On iOS and Android they change the home-screen icon; on desktop the change is in-app only `[S15]`.
- **For us.** A PWA cannot switch its installed icon at runtime (the manifest is fixed once installed). We can:
  1. switch the **favicon and tab icon** live with `<link rel="icon">` (**S**);
  2. offer icon variants in the Capacitor/Expo native wrapper later, using `UIApplication.setAlternateIconName` or Android activity-aliases (**L**, and only if we ship native).
- Make it free. Design 6–8 original icons; the brand mark in each theme colour is enough.

---

## 6. The 2025 desktop "new look" and density

### 6.1 What Discord did (2025-03-25)

- **Four base themes.** Covered in section 2.
- **UI density.** Compact, Default and Spacious control spacing around *everything*. This is separate from message display (Cozy/Compact) `[S1][S2]`.
- **Resizable channel list.** `[S1]`
- **Shapes and icons.**
  - Squircle server icons: "people are circles, things are squircles" `[S5]`.
  - Rounded containers, a new icon set **(icon-set details unverified)**.
- **Chrome.**
  - A taller title bar showing the server name, which users called redundant.
  - A larger floating user panel, bottom-left.
  - Voice controls moved centre-bottom with clearer mute and camera colour states `[S1][S19]`.
- **Backlash.** Change.org petitions and support-forum threads complained about:
  - smaller server icons;
  - more padding and less information density;
  - the redundant title bar;
  - eye strain `[S19]`.

  Discord did not roll the refresh back, but compact density partly answers the density complaint.

### 6.2 The 2023 mobile redesign and its rollback

- **2023-12.** The redesign split Servers and DMs into tabs, added a "You" tab and introduced the Midnight theme `[S11]`.
- **2024-05-22.** After sustained feedback, Discord **restored the unified server+DM view**, added double-tap Home to switch, and shipped a contrast slider `[S12]`.
- **2026-08.** The mobile visual refresh aligned mobile with desktop:
  - all four themes;
  - squircles;
  - density settings;
  - message spacing Default/Compact, where Compact hides avatars;
  - a decluttered chat bar `[S5][S6]`.

Some users again objected to the "squarer" look **(unverified; from blog-aggregator snippets)**.

### 6.3 Lessons and recommendation

1. **Density must be a user choice, never imposed.** We already have `data-ui-density` with a `--ui-density` multiplier. Make sure it scales these (**S**):
   - server icon size (48 / 40 / 32 px)
   - channel row height (34 / 32 / 28 px)
   - title bar height
   - user panel height
2. **Minimum target size.** Never shrink a target below 24×24 px (WCAG 2.2 SC 2.5.8), even in compact. **S**
3. **Resizable sidebars** (channel list 200–360 px; member list): store the width per user. **M**
4. **Radii as tokens.** Use `--radius-sm: 4px`, `--radius-md: 8px`, `--radius-lg: 12px`, `--radius-avatar: 50%`, `--radius-guild: 30%` (squircle-like). Use the CSS `corner-shape: squircle` where it is supported, with `border-radius` as the fallback. **S**
5. **Never ship a layout change without an opt-out period.** Add a `layout: 'classic'|'refresh'` preference flag for any future chrome redesign. This is policy, not effort.

---

## 7. Appearance settings

| Setting | Discord (free unless noted) | Ours today | Recommendation | Effort |
|---|---|---|---|---|
| Chat font scaling | 12–24 px slider, chat text only `[S7]` | `chatFontScale` % | Show the value in px with steps 12, 14, 15, 16, 18, 20, 24. Scale line-height with `--message-font-size * 1.375`. | S |
| Zoom | 50–200 % desktop app zoom; Ctrl +/− | `--app-zoom` on root font-size | Keep it. Bind Ctrl/Cmd +/−/0 in the web app. The browser already zooms, so show a hint when the browser's own zoom ≠ 100 %. | S |
| Message display | Cozy / Compact; compact removes avatars `[S6][S7]` | `messageDisplay` | Keep it. Add "Show avatars in compact" **(Discord legacy toggle; unverified in 2025 builds)**. | S |
| Space between message groups | 0–24 px slider `[S7]` (a snippet claims the default is 0 px; our understanding is 16 px, **unverified**) | `messageGroupSpacing` (16) | Keep it. | — |
| UI density | Compact / Default / Spacious `[S1]` | `uiDensity` | See section 6.3. | S |
| Role colours | Show in names / next to names / don't show `[S13]` | `roleColors` | Also add "Enhanced role styles": gradient role names, **free** in our app (Discord charges 3 boosts `[S18]`). Render as `background-clip:text`, but **always** verify a solid fallback colour at ≥ 4.5:1 against `bg-chat`, and use that fallback under reduced motion or high contrast. | M |
| Saturation | 0–100 % slider; UI only `[S13]` | CSS filter on root | Switch to the token multiplier (section 3.4). Add "Apply to role colours" as a sub-toggle, as Discord does. | M |
| Contrast | Slider (2024, mobile) and High Contrast mode `[S12][S13]` | `highContrast` boolean | Add the slider and keep the boolean as its preset. Follow `prefers-contrast: more` and `forced-colors`. | S |
| Reduced motion | Toggle, can sync with OS `[S13]` | Yes, and it honours the OS setting | Add a "Sync with computer" tri-state. | S |
| Always underline links | Toggle `[S13]` | **Missing** | Use `:root[data-underline-links="true"] a { text-decoration: underline }`, and make it the **default ON** when saturation < 50 % or contrast is high. | S |
| Animated emoji, GIF autoplay, stickers | Play animated emoji; autoplay GIFs when focused; stickers always / on interaction / never `[S13]` | Yes | Tie defaults to `prefers-reduced-motion`. Pause all animated media when the window is blurred. | S |
| Custom emoticons (`:)` → 🙂) | "Convert emoticons" in Text & Images | `convertEmoticons` | Keep it. | — |
| Dyslexia-friendly font | **Not offered**, despite repeated requests `[S25]`. gg sans drew complaints from dyslexic users `[S14]`. | Inter + Kanit | Add a **free font choice**: Default (Inter/Kanit), Atkinson Hyperlegible, OpenDyslexic, System UI. Self-host WOFF2 (no Google CDN). Add letter-spacing and line-height sliders (WCAG 1.4.12 text spacing). | M |
| Sync across devices | "Sync across clients" `[S6]` | `syncAcrossDevices` | Keep it. Theme, gradient and fonts sync; zoom stays per device (as Discord does). | — |

---

## 8. Seasonal and event themes, loading screen, sounds

**What Discord does.**
- **Snowsgiving** (December) swaps in a winter loading animation, snowy sounds and new icons, and runs quests. It can be disabled with **Appearance › "Show Seasonal Theme"** `[S16]`.
- **Event Sound Packs.**
  - Halloween 2024 and Winter from 2025-12-19 to 2026-01-05.
  - Set under **Notifications › Event Sound Pack**, desktop only `[S17]`.
- **Loading screen.** Rotating tips and quotes on the connecting screen, and occasional easter eggs such as April Fools **(well known, not re-verified this session)**.
- **Soundboard.** The soundboard exists separately; soundboard packs are cross-server with Nitro `[S17]`.

**Recommendation.**
- **Seasonal themes: opt-out toggle, S.**
  - Ship a `seasonal` layer: a set of accent-token overrides plus an optional loading illustration, gated by date and by `appearance.showSeasonal` (default on).
  - Never alter base contrast.
  - Respect reduced motion: no falling snow.
- **Localized seasons: S per event.** Our Thai audience suggests Songkran (April) and Loy Krathong (November) alongside winter. They must stay regionally optional, via `i18n` locale and date.
- **Sound packs: M.**
  - `notifications.soundPack: 'default'|'soft'|'retro'|<event>`, with the pack decided in `src/voice/sounds.js`.
  - Each pack is a manifest of ≤ 10 short files (message, mention, join, leave, mute, unmute, deafen, undeafen, call).
  - Use original, CC0 or self-made audio only.
- **Loading tips: S.** Add an i18n'd array of tips (EN/TH) on the connecting screen. Keep them short, give them a text alternative, and do not autoplay animation under reduced motion.

---

## 9. Accessibility of themes: checklist

1. **Text.** Every text token is ≥ 4.5:1 on every surface it can appear on, and body text is ≥ 7:1 (section 3.3). Add a CI script that recomputes the matrix from `index.css`. **S**
2. **Non-text (WCAG 1.4.11).**
   - Input outlines, toggles and the focus ring are ≥ 3:1. Use `border-strong` and `focus-ring`, not the brand fill: `#5865f2` on Ash `bg-chat` is only 2.61:1.
   - Status dots (online, idle, dnd) also need a shape difference (a notch, moon or bar), not just colour (WCAG 1.4.1). Discord already does this with masks.
3. **Brand buttons.** White on `#5865f2` is 4.61:1, which passes AA but fails AAA. In high-contrast mode, darken the fill to `#4450c9` (6.49:1 with white).
4. **Forced colours.** Under `@media (forced-colors: active)`, drop gradients, translucent overlays and custom role colours, and use `CanvasText`, `LinkText` and `Highlight`.
5. **Motion.** Theme swaps are instant. We already suspend transitions with `.theme-switching`. There is no animated gradient under reduced motion.
6. **OLED halation.** In Onyx, body text is `#d6d6da`, not `#fff`.
7. **Colour-vision safety.** Mentions and highlights must not rely on hue alone. Keep the left bar plus background tint that Discord uses for mentions.
8. **Personal choice beats defaults.** Font, spacing, contrast, saturation and underline links are all free and all independent of theme.

---

## 10. Prioritised implementation list

| # | Item | Why | Effort |
|---|---|---|---|
| 1 | Replace theme values with the contrast-checked palette (section 3.2). Fix failing Ash and `text4`. | Four current AA failures | S |
| 2 | Add `text-faint`/`border-strong`/`focus-ring` tokens and a CI contrast matrix script | Prevents regressions | S |
| 3 | "Always underline links" plus a contrast slider (high contrast = 1) | Discord parity; cheap a11y win | S |
| 4 | System theme picks which dark (Ash/Dark/Onyx); per-theme `theme-color` meta | Discord parity | S |
| 5 | Saturation through an OKLCH token multiplier instead of `filter` | Stops desaturating user media; removes the fixed-position hazard | M |
| 6 | Semantic token rename with a legacy alias layer (codemod `bg-d-*` → `bg-*`) | Enables gradients and community themes | M |
| 7 | 12 free gradient presets plus a custom 5-stop builder with scrim and contrast guard | Headline "Nitro-for-free" feature | M |
| 8 | Font choice (Atkinson Hyperlegible, OpenDyslexic, System), letter and line spacing | Something Discord doesn't offer; WCAG 1.4.12 | M |
| 9 | Density scales icon, row, title bar and user panel sizes; 24 px minimum targets; radius tokens | 2025 refresh lessons | S |
| 10 | Resizable channel and member lists | Discord 2025 parity | M |
| 11 | Gradient role names (free) with a solid fallback | Parity with Enhanced Role Styles | M |
| 12 | Seasonal layer with opt-out, plus Thai seasonal variants | Delight, localized | S each |
| 13 | Notification sound packs | Parity with Event Sound Packs | M |
| 14 | Live favicon / icon variants; native alternate icons later | Parity with app icons | S / L |
| 15 | User-authored CSS themes (import a token JSON, never raw CSS) | Community themes, safely | L |

---

## Appendix A: Sources

| ID | Source | Date |
|---|---|---|
| S1 | Engadget / Yahoo Tech, "Discord's redesigned PC app has multiple dark modes, a new overlay and more": https://www.engadget.com/gaming/pc/discords-redesigned-pc-app-has-multiple-dark-modes-a-new-overlay-and-more-160019822.html (mirror https://tech.yahoo.com/general/article/discords-redesigned-pc-app-has-multiple-dark-modes-a-new-overlay-and-more-160019822.html) | 2025-03-25 (read via search snippet) |
| S2 | PC Gamer, "Discord drops big update with 'completely new' in-game overlay and new dark themes": https://www.pcgamer.com/software/discord-drops-big-update-with-completely-new-in-game-overlay-and-new-dark-themes-for-the-desktop-client/ ; also Beebom https://beebom.com/discord-desktop-update-new-themes-game-overlay-rolling-out/ and Lowyat https://www.lowyat.net/2025/346381/discord-revamps-game-overlay-refreshes-desktop-app/ | 2025-03 (snippets) |
| S3 | TechCrunch, "Discord made its streaming overlay a lot more user friendly": https://techcrunch.com/2025/03/25/discord-made-its-streaming-overlay-a-lot-more-user-friendly/ | 2025-03-25 |
| S5 | Discord Blog, "Squircles, Styles, and Spacing: How Your Feedback is Helping Improve Mobile": https://discord.com/blog/improving-mobile-with-squircles-styles-and-spacing | 2026-08-06 (the date comes from a search snippet; **unverified**) |
| S6 | Discord Support, "Mobile Visual Refresh: What's Changing": https://support.discord.com/hc/en-us/articles/42383370736023 | 2026 (snippet) |
| S7 | Discord Support, "How to Change Discord Color Themes and Customize Appearance Settings": https://support.discord.com/hc/en-us/articles/207260127 | accessed 2026-09-26 (snippet) |
| S8 | Discord Blog, "Bring your vibe to Discord with new Themes in Nitro": https://discord.com/blog/bring-your-vibe-to-discord-with-new-themes-in-nitro ; TechTimes https://www.techtimes.com/articles/289192/20230319/discord-now-offers-nitro-subscribers-16-new-themes.htm ; DT Next https://www.dtnext.in/technology/2023/03/18/discord-rolling-out-themes-for-nitro-subscribers-on-desktop-2 | 2023-03-17/19 |
| S9 | Discord Blog, "April Showers Bring Super-Cool Nitro Powers": https://discord.com/blog/april-showers-bring-super-cool-nitro-powers ; GodisaGeek https://godisageek.com/2023/04/discord-nitro-gets-host-of-new-features/ | 2023-04 |
| S10 | Discord on X: https://x.com/discord/status/1963695484587196735 ; AlternativeTo https://alternativeto.net/news/2025/9/discord-introduces-custom-theme-support ; TechIssuesToday https://techissuestoday.com/discord-custom-themes-rolling-out-nitro/ | 2025-09-04 |
| S11 | TechCrunch, "Discord app redesign": https://techcrunch.com/2023/12/05/discord-app-redesign-mobile ; Discord Blog https://discord.com/blog/improving-our-mobile-experience | 2023-12-05 |
| S12 | Discord Blog, "Discord Patch Notes: May 2024": https://discord.com/blog/discord-patch-notes-may-2024 ; AlternativeTo https://alternativeto.net/news/2024/5/discord-brings-back-unified-view-to-mobile-and-improves-search-and-accessibility-features ; Dexerto https://www.dexerto.com/tech/discord-reveals-mobile-layout-update-performance-improvements-2736879/ | 2024-05-22 |
| S13 | Discord Support, "Accessibility Settings Tab": https://support.discord.com/hc/en-us/articles/1500010454681 ; Discord Blog https://canary.discord.com/blog/improving-app-accessibility-a11y-updates | accessed 2026-09-26 (snippet) |
| S14 | Discord Support, "gg sans: Font Update FAQ": https://support.discord.com/hc/en-us/articles/9507780972951 ; Gamepur https://www.gamepur.com/news/discords-new-font-change-is-a-literal-headache-for-those-with-astigmatism-and-dyslexia | 2022-12 / 2023 |
| S15 | 9to5Google, "Discord Nitro subscribers may soon get the option to change the app's icon": https://9to5google.com/2023/09/15/discord-app-icon-nitro/ ; Discord on X https://x.com/discord/status/1706353266152341554 ; Support https://support.discord.com/hc/en-us/articles/17503907209239 | 2023-09-15 / 2023-09 |
| S16 | Discord Blog, "What We Did During Snowsgiving 2022": https://discord.com/blog/snowsgiving-2022 ; MakeUseOf https://www.makeuseof.com/what-is-discord-snowsgiving/ | 2022-12 |
| S17 | Discord Support, "Winter Ringtone and Sounds 2025 FAQ": https://support.discord.com/hc/en-us/articles/28692828968215 ; Saiga NAK https://saiganak.com/news/discord-halloween-event-2024/ | 2024-10 / 2025-12 |
| S18 | Discord Support, "Enhanced Role Styles": https://support.discord.com/hc/en-us/articles/31444213087255 ; Discord Blog https://discord.com/blog/get-more-from-your-boosts-with-new-server-perks | 2025 |
| S19 | Change.org, "Roll back the new Discord PC UI update (2025)": https://www.change.org/p/roll-back-the-new-discord-pc-ui-update-2025 ; Medium (S. Negi) https://medium.com/@negi28.sumit/discords-march-2025-ui-overhaul-loved-or-hated-fff69f5eaebe ; ResetEra https://www.resetera.com/threads/the-new-discord-ui-refresh-just-happened.1145268/ | 2025-03/04 |
| S20 | SparkleCord, "LITERALLY DISCORD'S VARIABLES (Dark Mode)", a 2024-era client CSS dump: https://github.com/SparkleCord/SparkleCord-Client/blob/main/src/css/base/variables-dark.css | fetched 2026-09-26 |
| S21 | milbits/oldcord `vars.css` (overrides targeting `.theme-darker`, `.theme-midnight`, `.custom-theme-background`): https://github.com/milbits/oldcord/blob/main/src/components/vars.css | fetched 2026-09-26 |
| S22 | ArchReactor/hardware-monitor `discord.css`, a 2025-era client CSS dump with `--background-base-*` tokens: https://github.com/ArchReactor/hardware-monitor/blob/84d875d8c87558d163fbeef470f75f318b73f281/monitor/public/discord.css | fetched 2026-09-26 |
| S23 | MiniDiscordThemes/Nitrate (gradient angles and positions of the Nitro presets): https://github.com/MiniDiscordThemes/Nitrate/blob/main/Nitrate.theme.css | fetched 2026-09-26 |
| S24 | LuckFire/amoled-cord (`.theme-midnight` overrides): https://github.com/LuckFire/amoled-cord | fetched 2026-09-26 |
| S25 | Discord Support community requests, "Accessibility font for Dyslexia": https://support.discord.com/hc/en-us/community/posts/10472390758551 ; "Dyslexia/Irlen syndrome/SEND accessibility" https://support.discord.com/hc/en-us/community/posts/11326242035735 | 2023 |

Mobbin was available as a connector but was not used; no screenshots are reproduced here. The screenshot descriptions above come from the cited articles.

## Appendix B: Contrast method

- **Formula.** WCAG 2.x relative luminance, `(L1 + 0.05) / (L2 + 0.05)`, on sRGB hex.
- **Gradient worst case.** Each stop is linearly mixed with the scrim in sRGB, and the text token is checked against every mixed stop. The table reports the minimum.
- **Discord values.** Taken from `hsl(H, S*saturation-factor, L)` at saturation-factor 1, converted to hex and rounded to 8 bits.
- **Reproducing.** The throwaway Python script lived in the session scratchpad, not the repo. Re-derive with any WCAG contrast tool, using the hex tables above.
