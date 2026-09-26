# Discord profile & identity customization (2023–2026): research and a free, open design for our app

Researched: 2026-09-26. Scope: everything Discord lets a person change about how they look to others:
avatar and banner, decorations, effects, name styling, server identity, badges, widgets, status and
presence. The goal is a **free, original, self-hostable** version for this codebase. We give every
feature to every user, we ship no Discord assets, and admins can extend the sets.

> **Source notes.** From this sandbox, `support.discord.com`, `discord.com` and `docs.discord.food`
> could not be fetched (the egress proxy blocked them). Claims from those pages come from search-result
> snippets and are marked **(snippet)**. Anything confirmed against Discord's official API docs repo
> (`github.com/discord/discord-api-docs`, commit of 2026-09-25) is marked **(API docs ✔)**. Claims that
> come only from third-party blogs or leak accounts are marked **(unverified)**. None of this was
> tested hands-on in the Discord client.

---

## สรุปภาษาไทย (Thai summary)

**ภาพรวม:** ตั้งแต่ปี 2023 Discord เปลี่ยนโปรไฟล์ให้เป็นทั้งช่องทางหารายได้และช่องทางแสดงตัวตน ในปี 2023 เปิด Shop ที่ขาย
กรอบอวาตาร์ (Avatar Decorations) และเอฟเฟกต์โปรไฟล์ (Profile Effects) ในปี 2025 เพิ่ม Nameplates (พื้นหลังชื่อใน
member list), Server Tags (แท็ก 4 ตัวอักษรพร้อมไอคอนต่อท้ายชื่อ ปลดล็อกด้วย 3 boosts), Orbs (สกุลเงินที่ได้จากการทำ Quest
ซึ่งเป็นโฆษณา), Display Name Styles (ฟอนต์/สีไล่ระดับ/เอฟเฟกต์ของชื่อ ต้องมี Nitro) และ Profile Widgets (เกมโปรด,
Wishlist) ในปี 2026 เพิ่ม Profile Frames, Profile Privacy ที่ละเอียดขึ้น, bio ยาวได้ 300 ตัวอักษรพร้อม editor แบบ WYSIWYG
และฟอนต์ชื่อใหม่อีก 4 แบบ

**ของที่แอปเรามีอยู่แล้ว:** avatar, banner, accent_color, bio (190), pronouns (40), profile_visibility, custom
status + emoji (ยังไม่มีเวลาหมดอายุ), โปรไฟล์ต่อเซิร์ฟเวอร์ (nickname/avatar/banner/bio/pronouns ใช้ได้ฟรีอยู่แล้ว),
โน้ตส่วนตัว (user_notes), ชื่อ role แบบไล่สี (color_secondary) และ mutual_servers ที่ API ส่งมาแต่ UI ยังไม่แสดง

**หลักการของเรา:** ทุกอย่างฟรี ไม่มีสกุลเงินหรือโฆษณา ของตกแต่งทั้งหมดเป็นงานออกแบบของเราเองด้วย CSS/SVG ขนาดเล็ก
ไม่ใช้ asset ของ Discord และไม่ใช้ Lottie ทุกแอนิเมชันต้องเคารพ `prefers-reduced-motion` และการตั้งค่า reducedMotion
ของแอป ผู้ดูแลระบบ (instance admin) อัปโหลด "แพ็ก" ของตกแต่งเพิ่มได้ ส่วนผู้ดูแลเซิร์ฟเวอร์ปิดการแสดงผลในเซิร์ฟเวอร์ตัวเองได้

**ลำดับที่แนะนำ:**
1. (S) แท็บ Mutual servers/friends, เวลาหมดอายุของ custom status, ป้าย 🌱 สมาชิกใหม่, Markdown ใน bio (เพิ่มเป็น 300 ตัวอักษร)
2. (M) Profile theme แบบสองสี (primary/accent ไล่ระดับ) พร้อม preview สด และ crop avatar/banner
3. (M) Display name styles (ฟอนต์ 6 แบบจาก Google Fonts OFL + gradient/อีก 3 เอฟเฟกต์) โดยตรวจ contrast ให้อัตโนมัติ
4. (M) Server tags (4 ตัวอักษร + ไอคอน) ใช้ฟรี ผู้ดูแลเซิร์ฟเวอร์เปิดได้ และมี automod/รายงาน
5. (L) ระบบ Collectibles: กรอบอวาตาร์, เอฟเฟกต์โปรไฟล์, nameplate, profile frame แบบ CSS/SVG พร้อมแพ็กที่แอดมินอัปโหลดได้
6. (M) Badges ของ instance (ผู้ก่อตั้ง, ผู้พัฒนาบอท, ผู้สนับสนุนรุ่นแรก, ความสำเร็จ) และ (L) Connections/Widgets

**ความเสี่ยงหลัก:** การปลอมตัว (ใช้ฟอนต์/สี/แท็กให้เหมือนแอดมินหรือบอท), แท็กหรือชื่อที่หยาบคาย, แอนิเมชันที่กระตุ้นอาการ
ชักหรืออาการเวียนหัว และภาระด้านประสิทธิภาพใน member list ที่ยาวมาก ข้อเสนอด้านล่างมีมาตรการรับมือทุกข้อ

---

## 0. What we already have (from code, read-only)

| Area | Where | State |
|---|---|---|
| `users` columns | `db/schema.pg.sql` L44–81 | `avatar_url/_file_id`, `banner_url/_file_id`, `accent_color`, `bio`, `pronouns`, `profile_visibility` (everyone/mutual/friends), `status`, `custom_status`, `custom_status_emoji`, `flags INTEGER` (unused for badges) |
| Limits | `services/users.js` `updateProfile` | display_name 32, bio 190, pronouns 40, custom_status 128; avatar/banner URLs are proxied and ref-counted |
| Per-server profile | `server_members.nickname/avatar_url/banner_url/bio/pronouns`; `GET/PATCH /api/servers/:id/profile/...`; `GuildProfileEditor` in `UserProfileModal.jsx` | **Already free.** It lacks a per-server theme and decoration |
| Notes | `user_notes` + `PUT /api/users/:id/note` + `PrivateNote` | Done (autosave) |
| Mutual servers | `getUser()` returns `mutual_servers` | **The API returns it, but no UI shows it** |
| Profile UI | `UserProfileModal.jsx` (single modal, max-w-sm) | Banner, avatar, status dot, name, pronouns, custom status, bio (plain `whitespace-pre-wrap`, **no markdown**), roles, member-since. No popout vs. full-profile split |
| Profile editor | `settings/ProfileTab.jsx` | Avatar 10 MB / banner 15 MB, optimistic preview, single accent colour. No crop, no live card preview |
| Role gradient | `roles.color_secondary` | Precedent for gradient names |
| Motion | `prefs.accessibility.reducedMotion`, `StillImage` (play on hover) | Reusable for every animated cosmetic |
| Instance admin | `ADMIN_TOKEN` (`lib/config.js`) | Enough to gate pack uploads |
| File categories | `files.category` CHECK | Needs `'cosmetics'` added |

---

## 1. Avatar decorations

**Discord behaviour.** An animated frame drawn over and around the circular avatar, shown in chat, the
member list, popouts and voice. It launched in 2023. When the Shop opened (Oct 2023 for Nitro,
opened to everyone by 29 Nov 2023) bought decorations became permanent collection items
([TechCrunch 2023-11-29](https://techcrunch.com/2023/11/29/discord-shop-avatars-profile-decorations/)).
The API exposes `avatar_decoration_data { asset, sku_id }` on users and **per guild member**. The
asset is a PNG/APNG under `avatar-decoration-presets/` **(API docs ✔)**.
- **Free vs paid:** paid Shop items with a Nitro discount. Nitro-only sets (e.g. DISXCORE) work only
  while subscribed. Free ones come from Quests (sponsored) and from events such as the Marvel Rivals
  Ultron decoration or the "10 Days of Discord" gift, 1–11 Dec 2025
  ([Avatar Decorations FAQ](https://support.discord.com/hc/en-us/articles/13410113109911) (snippet);
  [Winter collection](https://support.discord.com/hc/en-us/articles/36295105643415) (snippet)). Nitro
  members keep Quest decorations longer
  ([blog](https://discord.com/blog/nitro-members-keep-quest-rewards-longer) (snippet)).
- **UX:** Settings → Profiles → "Change decoration". It opens a picker grid with the owned and Shop
  tabs and shows a live preview on your avatar. Buying happens on desktop or web only, but everyone
  sees the decoration on every platform.
- **Abuse:** decorations are curated, so there's little abuse. People complain that animation
  distracts; Reduced Motion stops it.

**Our recommendation (all free, original art).**
- **Data:** a generic collectibles catalogue (reused by §2, §3, §17):
  ```sql
  CREATE TABLE cosmetic_packs (id TEXT PK, slug TEXT UNIQUE, name TEXT, author TEXT, license TEXT,
    version TEXT, source TEXT CHECK (source IN ('builtin','admin')), enabled INTEGER DEFAULT 1,
    created_at TIMESTAMPTZ);
  CREATE TABLE cosmetic_items (id TEXT PK, pack_id TEXT REFERENCES cosmetic_packs ON DELETE CASCADE,
    kind TEXT CHECK (kind IN ('avatar_decoration','profile_effect','nameplate','profile_frame','badge')),
    slug TEXT, name TEXT, renderer TEXT CHECK (renderer IN ('css','svg','image')),
    asset_file_id TEXT REFERENCES files(id), css_vars JSONB, params_schema JSONB,
    tags TEXT[], available_from TIMESTAMPTZ, available_until TIMESTAMPTZ,   -- event items
    is_seasonal INTEGER DEFAULT 0, position INTEGER, UNIQUE (pack_id, slug));
  CREATE TABLE user_cosmetics (user_id, item_id, acquired_at, source TEXT,     -- 'default'|'event'|'achievement'|'admin_grant'
    PRIMARY KEY (user_id, item_id));
  ALTER TABLE users ADD COLUMN avatar_decoration_id TEXT REFERENCES cosmetic_items(id) ON DELETE SET NULL,
                    ADD COLUMN avatar_decoration_params JSONB;   -- e.g. {"hue":210}
  ALTER TABLE server_members ADD COLUMN avatar_decoration_id TEXT, ADD COLUMN avatar_decoration_params JSONB;
  ```
  Most items are "always owned", so `user_cosmetics` only records **event / achievement** items. That
  preserves the collectible feel without paywalls.
- **API:** `GET /api/cosmetics?kind=` (catalogue plus the `owned` flag), `PATCH /api/users/@me`
  (`avatar_decoration_id`, `avatar_decoration_params`), `PATCH /api/servers/:id/profile/@me` (per
  guild), and admin endpoints `POST /api/admin/cosmetic-packs` (zip upload),
  `PATCH/DELETE /api/admin/cosmetic-packs/:id`, `POST /api/admin/cosmetics/:id/grant`.
- **UI:** a new `<Avatar>` wrapper component (`src/components/profile/Avatar.jsx`) that renders
  `<AvatarDecoration item params size />` as an absolutely positioned `svg`/`div` at 1.2× the avatar
  size. Use it everywhere avatars appear so every surface stays consistent.
  `settings/DecorationPicker.jsx` holds a grid with a hue slider and a live preview. A **"Try on"**
  button on any decoration seen on someone else's profile opens the picker with that item
  preselected.
- **Assets (original):** ship a `builtin-core` pack of about 12 CSS/SVG frames: *Orbit* (dots on a
  rotating ring), *Leafy vine*, *Neon ring* (conic-gradient spin), *Pixel border*, *Sakura* (5 SVG
  petals), *Thai lai kranok* line-art ring (a local nod), *Cat ears*, *Headphones*, *Stars*,
  *Flame*, *Frost*, *Rainbow dash*. The rules:
  - The CSS uses `transform`/`opacity` only (GPU friendly). Each frame is under 4 KB, recoloured via
    `--deco-hue`.
  - `@media (prefers-reduced-motion: reduce)` **and** `[data-reduced-motion]` set
    `animation: none` and show a designed static pose.
  - The member list and chat show a **static pose**. The animation plays on hover and in popouts,
    mirroring Discord's GIF-avatar behaviour and our `StillImage`.
  - The `image` renderer takes admin-uploaded APNG/WebP (≤ 512 KB, 256×256, ≤ 4 s loop) and needs a
    static first frame poster.
- **Moderation:** only curated packs (instance admin); users can't upload decorations. A server
  setting `servers.allow_cosmetics` (all / static only / off) plus a user preference "Show others'
  decorations: always / hover / never".
- **Effort:** **L** (catalogue + renderer + picker + packs). A first cut of builtin CSS frames
  without admin packs is **M**.

## 2. Profile effects

**Discord behaviour.** A full-card animated overlay (falling petals, shattering glass) that plays
**when someone opens your popout or full profile**, then settles or loops
([Profile Effects](https://support.discord.com/hc/en-us/articles/17828465914263) (snippet);
[TechCrunch](https://techcrunch.com/2023/11/29/discord-shop-avatars-profile-decorations/)). They are
bought in the Shop, some are Nitro-only, and they're per-server capable. The community asked for an
accessibility toggle
([forum](https://support.discord.com/hc/en-us/community/posts/18598192237591)), and Reduced Motion
now disables them (snippet).

**Recommendation.** Reuse `cosmetic_items.kind='profile_effect'`. Add the column
`users.profile_effect_id` (plus the `server_members` twin). Render `<ProfileEffect>` as an
`pointer-events:none` overlay layer inside the card, with SVG sprites animated by CSS keyframes. The
effect **plays once for ≤ 3 s, then holds the last frame**; there are no infinite loops, which cuts
motion sickness and CPU use. Original set: *Confetti burst*, *Bubbles*, *Fireflies*, *Rain on glass*,
*Songkran splash*, *Loy Krathong lanterns*, *Snowfall*, *Paper planes*. Keep it under 30 animated
nodes. Run it in reduced motion and in background tabs (`document.hidden`). Viewers get a "Replay"
button. **No flashing:** WCAG 2.3.1, no more than 3 flashes per second; the review checklist for
packs enforces it. **Effort M** once §1 exists.

## 3. Nameplates (2025)

**Discord behaviour.** An art strip behind your name in the **member list and DM list**. It came from
Shop experiments starting 30 Mar 2025 and launched in April 2025
([blog "Nameplates land in the Shop"](https://discord.com/blog/nameplates-land-in-the-shop);
[Nameplates FAQ](https://support.discord.com/hc/en-us/articles/30408457944215) (snippet);
[techissuestoday](https://techissuestoday.com/discord-begins-rolling-out-nameplates-heres-how-to-get-it/)).
The API shape is `collectibles.nameplate { sku_id, asset, label, palette }`, where `palette` is one of
`crimson, berry, sky, teal, forest, bubble_gum, violet, cobalt, clover, lemon, white` **(API docs ✔)**.
Purchases are paid (Nitro discount), bought on desktop, and visible everywhere. Reports say the art
animates on hover (unverified).

**Recommendation.** `kind='nameplate'`; `users.nameplate_id`, `users.nameplate_palette TEXT` (reuse
the 11-name palette idea with our own hex values). Render a CSS gradient + SVG motif at **≤ 18 %
opacity behind the row**, with text contrast checked against the theme. Static in lists; a subtle
shimmer on hover only. The member list is virtualised, so a nameplate must be a single
`background-image` (a data-URI SVG) with no extra DOM. **Effort S–M.**

## 4. Display name styles (fonts, gradients, effects; Oct 2025 onward)

**Discord behaviour.** Nitro users pick a **font**, **colour(s)** and an **effect** for their display
name, shown in chat, the member list and the profile
([Display Name Styles FAQ](https://support.discord.com/hc/en-us/articles/33833879643927) (snippet);
[@discord 2025-10-28](https://x.com/discord/status/1983224573752397900)). Effects: *Gradient*
(2 colours), later *Prism* (5 colours) and *Gummy* (alternating colour per letter). More fonts
arrived later: Playpen Sans, then Mainframe, Monkey Bars, Headbang and Journal in the
**25 Sep 2026** update
([Discord Update 2026-09-25](https://discord.com/blog/discord-update-september-25-2026) (snippet);
[DiscordPreviews](https://x.com/DiscordPreviews/status/2067456631256830390)). **Non-Nitro users can
preview but not save.** Mobile shows no animation. Separately, since June 2025 servers can spend
boosts on "Enhanced Role Styles" (animated gradient / holographic role colours)
([blog](https://discord.com/blog/get-more-from-your-boosts-with-new-server-perks) (snippet)).

**Abuse.** Stylised names can imitate staff/bot styling or reduce legibility, and Discord's
AutoMod can quarantine names (`AUTOMOD_QUARANTINED_USERNAME` **(API docs ✔)**).

**Recommendation.**
- **Data:** `users.name_style JSONB` = `{font:'default'|'rounded'|'serif'|'mono'|'hand'|'display'|'pixel',
  effect:'solid'|'gradient'|'prism'|'alternate'|'glow', colors:['#rrggbb', …≤5], animate:bool}`, plus
  `server_members.name_style` (per-server override). Validate on the server: whitelisted keys, hex
  only, ≤ 5 colours.
- **Fonts:** self-hosted OFL fonts subset to Latin + Thai where possible (Thai coverage matters). For
  example Mali (hand), Itim (rounded), Chakra Petch (display/tech), IBM Plex Sans Thai Looped, Sarabun
  (serif-ish), Silkscreen (pixel, Latin-only, falls back). Load them lazily with `font-display: swap`,
  and only after a styled name appears in view.
- **Rendering:** `background-clip:text` gradients. The animation is a slow `background-position` pan,
  paused under reduced motion and in lists by default. **Contrast guard:** compute the WCAG contrast
  of each colour against the current theme background and, below 3:1, auto-add a text-shadow outline
  or reject the colour in the picker with a message. **Role colour wins inside servers** unless the
  server enables "member name styles". That keeps role signalling (mods, bots) intact.
- **Impersonation guard:** reserve the styles used by the SYSTEM/BOT/admin labels. Names are always
  shown with `@username` in popouts. Font styling never changes the `username`.
- **UI:** a "Name style" section in `ProfileTab` with a live preview in three contexts (chat line,
  member row, profile card) and dark and light theme toggles.
- **Effort M.**

## 5. Profile themes (primary/accent colours, gradient profile)

**Discord behaviour.** Nitro users choose a **primary** and an **accent** colour. The profile card
background becomes a gradient from primary (below the banner) to accent (bottom), and text and
buttons adapt ([Custom Profiles](https://support.discord.com/hc/en-us/articles/4403147417623)
(snippet); [Netcord/Medium](https://medium.com/netcord/custom-profile-themes-are-coming-to-discord-711340627d19)).
Free users only get the banner colour (`accent_color` **(API docs ✔)**). People asked for a way to
turn off others' themes
([forum](https://support.discord.com/hc/en-us/community/posts/9840018373783)). This is separate from
the 2025 client-wide **Custom Themes** (up to 5 colours).

**Recommendation.** Add `users.theme_colors TEXT[2]` (primary, accent) plus the `server_members` twin.
Keep `accent_color` for the banner fallback. The card computes `--profile-bg: linear-gradient(...)`
and chooses `--profile-fg` (light or dark) by luminance. The overlay panel (`bg-d-sunken`) becomes
semi-transparent `color-mix()` so it stays readable. Viewer preference: "Show custom profile
colours" (on by default; high-contrast mode forces off). Presets plus an eyedropper that suggests
colours from the avatar or banner (canvas average; cheap). **Effort S–M.**

## 6. Banners (static/animated) and 7. animated avatars and crop

**Discord behaviour.** Banner: ~600×240 profile / 680×240 server profile, PNG/JPG/GIF < 10 MB;
animated banners and GIF avatars are Nitro-only
([Per-Server Profiles](https://support.discord.com/hc/en-us/articles/4409388345495) (snippet);
[size guides](https://www.linearity.io/blog/discord-size-guide/) (unverified numbers)). The avatar
upload flow has a crop/zoom step. Animated hashes are prefixed `a_` and served as animated WebP
**(API docs ✔)**. GIF avatars don't animate in chat under reduced motion; they play on hover or in
the profile
([Reduced Motion](https://support.discord.com/hc/en-us/articles/360040613412) (snippet)).

**Recommendation.**
- Free animated avatars and banners (GIF / animated WebP / APNG). On upload, `lib/imageVariants.js`
  already exists, so **extend it** to produce (a) a static first-frame poster (`*_still.webp`),
  (b) an animated WebP ≤ 2 MB at 256 px for avatars, ≤ 5 MB at 960×384 for banners, (c) strip
  metadata. Add `users.avatar_animated BOOLEAN`, `banner_animated BOOLEAN` and
  `avatar_still_url`/`banner_still_url` (or derive from the file id).
- `AvatarCropper.jsx` / `BannerCropper.jsx`: pan/zoom with a circle mask (avatar) or a 5:2 mask
  (banner), keyboard accessible (arrow keys nudge, +/- zoom). Crop client-side on a canvas for
  statics. For animated files, send `crop {x,y,w,h}` to the server and crop there (the frames can't
  be re-encoded well in the browser).
- Everywhere else use `StillImage` (`animate` false in lists, plays on hover).
- **Abuse:** existing `scan_status` pipeline; reject files with > 3 flashes/s? (a frame-luminance
  delta heuristic is cheap; flag for review instead of rejecting).
- **Effort M** (crop + variants). Banner and avatar storage already exist.

## 8. Per-server profiles

**Discord behaviour.** The nickname is free. Nitro adds a server avatar, banner, bio, theme and
decoration per server
([Per-Server Profiles](https://support.discord.com/hc/en-us/articles/4409388345495) (snippet)). The
guild member object carries `nick`, `avatar`, `banner`, `avatar_decoration_data`, `collectibles`
**(API docs ✔)**. The entry point is right-click avatar → "Edit Per-server Profile". Discord's 2026
Profile Frames also support per server (snippet).

**Recommendation.** Ours is **already free and mostly done**. Gaps:
(1) a banner/avatar upload UI inside `GuildProfileEditor` (today it edits nickname/bio/pronouns);
(2) add `server_members.theme_colors`, `name_style`, `avatar_decoration_id`, `profile_effect_id`,
`nameplate_id` with "inherit" = NULL;
(3) move it to `ProfileTab` as a "Server profiles" sub-tab with a server selector and the same live
preview;
(4) server-level toggles: `servers.allow_member_avatars`, `allow_member_name_styles`, which moderators
can use to force global identity in strict communities;
(5) moderators can **reset** a member's server nickname/avatar/bio (audit-logged). **Effort M.**

## 9. Pronouns

**Discord behaviour.** Free, ≤ 40 characters, global plus per-server, rolled out May 2023
([tweet](https://twitter.com/advaithj1/status/1658401939309334529)). Under 2026 Profile Privacy,
pronouns are hidden from non-audience viewers
([Profile Privacy](https://support.discord.com/hc/en-us/articles/38859942749463) (snippet)).

**Recommendation.** Done (40, global + server). Add: suggestion chips (localised, including Thai
options), and the pronouns follow `profile_visibility` like the bio. Run AutoMod keyword rules on
pronouns too (they're a common abuse vector for slurs). **Effort S.**

## 10. "About me" with markdown

**Discord behaviour.** 190 characters with markdown, emoji and links. In **2026** the limit rose to
**300** with a desktop WYSIWYG formatting toolbar
([2026-09-25 update](https://discord.com/blog/discord-update-september-25-2026) (snippet);
[DiscordPreviews](https://x.com/DiscordPreviews/status/2086899071931826320)).

**Recommendation.** Raise `LIMITS.bio` to 300 (and the server bio). Render with the existing
`src/utils/markdownParser.jsx` in a **restricted profile mode**: bold, italic, underline, strike,
spoiler, inline code, links (with an external-link confirmation, if one doesn't exist yet, add it), custom emoji,
**no** headings larger than h3, no mentions pinging, max 6 lines before "Show more". Add a small
formatting toolbar to the bio textarea (B/I/S/‖spoiler‖/link/emoji). **Effort S.**

## 11. Badges

**Discord behaviour.** A row of icons on the profile. The `public_flags` bit set includes STAFF,
PARTNER, HYPESQUAD, HYPESQUAD_ONLINE_HOUSE_1–3 (Bravery/Brilliance/Balance), BUG_HUNTER 1/2,
PREMIUM_EARLY_SUPPORTER, VERIFIED_DEVELOPER, CERTIFIED_MODERATOR **(API docs ✔)**. Others are
computed: Nitro (with tenure tiers), Server Booster (tenure), **Active Developer** (owns an app whose
slash command ran in the last ~30 days; it lapses otherwise
([summary](https://www.vibebot.gg/blog/how-to-get-active-developer-badge) (unverified detail))),
**Quest** badge (completed a Quest), **Orbs Apprentice** (bought for Orbs, permanent)
([techissuestoday](https://techissuestoday.com/heres-how-to-get-discords-all-new-orbs-apprentice-badge/)
(unverified)), and legacy "Originally known as" / "Legacy username". See
[Profile Badges 101](https://support.discord.com/hc/en-us/articles/360035962891) (snippet).

**Abuse.** Badges signal trust. Fake "staff" badges drawn into avatars or banners are a known scam
pattern.

**Recommendation.**
- `badges (id, slug, name, description, icon_file_id | svg, kind CHECK ('system','instance','server','achievement'),
  server_id NULL, rule JSONB, position, created_by)` and `user_badges (user_id, badge_id, server_id NULL,
  granted_at, granted_by, expires_at NULL, note)`.
- **System (automatic, computed):** *Instance staff* (admin-granted, **only** by `ADMIN_TOKEN`
  holders), *Early member* (first N accounts or joined before date X), *Bot developer* (owns a bot
  whose command ran in 30 days; this reuses `application_commands` plus an invocation timestamp), *Server owner*, *Verified email*
  (don't show; privacy), *Translator*, *Bug hunter* (admin-granted), *Years on instance* tiers (1/2/5
  years, like Nitro tenure but free).
- **Server badges:** a server can define up to 10 badges shown only inside that server
  (`server_id` set), for example "Event winner". Moderators grant them. This is our replacement for
  "achievement" badges without ads or Quests.
- Clicking a badge shows a tooltip with its name, the grant date and "granted by" for server badges.
  Reserve the "staff" shield icon for system badges. Server badges render inside a **distinct
  shape** (rounded square) so they can never pass as system badges.
- Badges follow Profile Privacy (Discord hides them for non-audience viewers).
- **Effort M.**

## 12. Server tags (Guild tags; June 2025) and 13. clan tags (2024 Guilds experiment)

**Discord behaviour.** The 2024 **Guilds/Clans** experiment gave ≤ 200-member "guilds" a 4-character
tag plus badge, games and playstyle. It was closed later
([Guilds FAQ](https://support.discord.com/hc/en-us/articles/23187611406999) (snippet);
[DiscordLookup](https://discordlookup.com/experiments/2024-04_clan_guilds)). It returned as
**Server Tags on 16 Jun 2025**: a server spends **3 boosts** to unlock a ≤ 4-character alphanumeric
tag plus a small badge icon. A member picks **one** server's tag to "adopt", and it shows after their
name everywhere ([Server Tags](https://support.discord.com/hc/en-us/articles/31444248479639)
(snippet); [GamingHQ 2025-06-18](https://gaminghq.eu/2025/06/18/discord-server-tags-extra-boosts/)).
API: `primary_guild { identity_guild_id, identity_enabled, tag, badge }`. `identity_enabled` becomes
null if the server loses the feature, false if the user removes it. Badge PNG at
`guild-tag-badges/{guild}/{hash}`. Member flag `AUTOMOD_QUARANTINED_GUILD_TAG` exists **(API docs ✔)**.
Tags are not unique across servers.

**Abuse.** A tag reading "MOD", "ADMN" or "DSCD", or slurs in 4 characters. Discord lets AutoMod
quarantine members whose tag matches a rule.

**Recommendation (free, no boosts).**
- `server_tags (server_id PK, tag TEXT CHECK (length BETWEEN 2 AND 4), badge_icon TEXT
  -- builtin glyph slug or file id --, badge_color TEXT, enabled INTEGER, requires_role_id NULL,
  updated_at)`; `users.primary_server_tag_id TEXT REFERENCES servers(id) ON DELETE SET NULL`,
  `users.server_tag_enabled INTEGER`.
- Charset: `[A-Z0-9]` plus Thai letters (a 4-grapheme limit; count graphemes via
  `Intl.Segmenter`). Normalise confusables (NFKC and a small confusable map) and check a
  **reserved list** (`ADMIN, MOD, STAFF, BOT, SYS, DEV, OFFICIAL`, the instance name) plus the
  global bad-words list.
- Server settings → "Server Tag" (owner/admin with MANAGE_GUILD): 24 builtin SVG glyphs (sword,
  leaf, star, etc.) × colour, or an uploaded 32×32 image. Optional `requires_role_id` so a server
  only lets verified members wear it.
- Member adoption: from the server dropdown ("Wear tag") or `ProfileTab` → "Server tag" picker, which
  lists servers you're in that have tags.
- Render the `[🗡 GANG]` chip after the display name in chat headers, the member list, popouts and
  mentions autocomplete. Clicking it opens the server's public preview/invite, if it has one.
- **Moderation:** our AutoMod gains a "block server tags matching…" rule (quarantine means the tag is
  hidden in that server). Leaving or being banned from the server clears the tag automatically, so a
  tag can't be kept after a ban. The instance admin can disable a server's tag globally.
- **Effort M.**

## 14. Profile widgets / game widgets (Nov 2025) and the "Personal widgets" follow-up

**Discord behaviour.** A **Profile Board** on desktop with widgets: Favorite Game (one, plus a
blurb), Currently Playing (≤ 5), Want to Play (≤ 20), Games I've Played (≤ 20), Game Stats. Edited in
Settings → Profiles → Profile Widgets; not shown on mobile
([@discord 2025-11](https://x.com/discord/status/1988734415363797501);
[@discord_support](https://x.com/discord_support/status/1988736510116663416);
[Widgets FAQ](https://support.discord.com/hc/en-us/articles/35344672307607) (snippet)). Reports
describe 2026 "Personal Widgets" (images plus fields as extra bio space) (unverified). Widgets are
hidden by Profile Privacy (snippet).

**Recommendation.** A generic, game-agnostic board:
`profile_widgets (id, user_id, kind CHECK ('favorites','list','links','image','fields','now'),
title TEXT ≤ 40, data JSONB, position, visibility)`, max 6 widgets per user and max 20 items per
list. Kinds:
- *Favorites* (games, books, anime, music; a free-text title plus optional cover image).
- *List* ("Want to play" / "Reading").
- *Fields* (key/value, e.g. "Timezone: ICT", "Main: Support").
- *Image* (≤ 3 images, scanned).
- *Links* (see §15).

Endpoints: `GET/PUT /api/users/@me/widgets` (full replace, ordered). UI: a "Board" tab on the full
profile; the editor has drag reorder. **Effort M–L.**

## 15. Connections

**Discord behaviour.** OAuth-verified accounts shown on the profile. Services include Amazon Music,
Bluesky, Bungie, Crunchyroll, Domain, eBay, Epic, Facebook, GitHub, Instagram, Mastodon, PayPal,
PlayStation, Reddit, Roblox, Spotify, Steam, TikTok, Twitch, X, Xbox, YouTube **(API docs ✔)**.
Spotify enables Listen Along and presence
([Spotify Connection](https://support.discord.com/hc/en-us/articles/360000167212) (snippet)).
Hidden by Profile Privacy.

**Recommendation.** OAuth apps can't be assumed on a self-hosted instance, so use tiers:
1. **Verified without OAuth** (S–M): *Domain* (DNS TXT `our-app-verify=<token>` or
   `/.well-known/…`), *GitHub* (public gist containing the token), *Mastodon/Fediverse* (a
   `rel="me"` link back to the profile URL), *Bluesky* (handle DID doc / post containing the token),
   *Website*.
2. **OAuth, optional per instance** (M each): Steam OpenID, Twitch, GitHub OAuth, Spotify (needed
   for now-playing), configured by the admin via env.
3. **Unverified links** clearly labelled "unverified" (a grey icon, no checkmark), ≤ 5.

Table: `user_connections (id, user_id, type, external_id, name, url, verified_at, visibility
('everyone','friends','hidden'), show_activity INTEGER, access_token_enc, refresh_token_enc,
metadata JSONB)`. Endpoints: `GET/POST/DELETE /api/users/@me/connections`,
`POST /api/users/@me/connections/:type/verify`. Icons use Simple Icons (CC0) SVG where trademark use
is nominative; otherwise a generic link glyph. **Effort M–L.**

## 16. Rich presence and activity cards

**Discord behaviour.** Game, Spotify or streaming activity is shown as a card in the popout, with
buttons (Join, Listen Along), elapsed time and art. Only one of Spotify or a game at a time.
Activity sharing can be toggled
([Activity Sharing FAQ](https://support.discord.com/hc/en-us/articles/7931156448919) (snippet)).

**Recommendation.** Our `ActivityTab.jsx` already offers a custom activity line. Extend the presence
to an `activities` array held **in memory / Redis** (not the DB), with the same shape as Discord's
(`type, name, details, state, timestamps, assets, buttons≤2`). Sources:
- **Voice/Stage presence**: "In voice: #lounge (Server)" with a Join button, respecting channel
  permissions.
- **Now playing** via the Spotify connection or a **browser Media Session** opt-in (web: only our
  own tab; desktop build: OS media API).
- **Bot/API rich presence** (`PUT /api/users/@me/activity`, rate-limited, for third-party
  scrobblers).

Card component: `ActivityCard.jsx`. The privacy toggle already exists (`shareActivity`). **Effort M.**

## 17. Custom status with emoji and expiry

**Discord behaviour.** Emoji (custom emoji need Nitro) plus text ≤ 128, "Clear after": don't clear /
30 min / 1 h / 4 h / Today
([Custom Status](https://support.discord.com/hc/en-us/articles/360035407531) (snippet);
[wiki](https://discord.fandom.com/wiki/Custom_Status)). Can also set status (Online / Idle / DND /
Invisible) with a duration.

**Recommendation.** Add `users.custom_status_expires_at TIMESTAMPTZ`, plus `status_expires_at` for
timed DND. Expiry is enforced at read time (`getUser` masks expired values) plus a 1-minute sweeper
that clears them and broadcasts the presence update. "Today" means local midnight, computed by the
client and sent as an absolute timestamp. `UserStatusMenu.jsx` gains an emoji button (custom server
emoji allowed for everyone, but a viewer who can't access that emoji sees the name as a text
fallback) and a duration select. Keep a "recent statuses" list client-side (localStorage, 5 entries).
**Effort S.**

## 18. Orbs and Quests, Shop items and collectibles, wishlist gifting

**Discord behaviour.** The **Shop** opened Oct 2023 (Nitro) and Nov 2023 (everyone), selling
decorations, effects, nameplates (2025), profile frames (2026) and bundles; purchases are
permanent. **Quests** are sponsored, opt-in ads (watch a video / play 15 min), with rewards that are
decorations or Orbs. **Orbs** launched globally on 14 Jul 2025; ~700 per quest; redeem for Shop items
or 3-day Nitro; not transferable
([press release](https://discord.com/press-releases/discord-launches-orbs-globally);
[blog](https://discord.com/blog/discord-orbs);
[GIGAZINE 2025-07-15](https://gigazine.net/gsc_news/en/20250715-discord-orbs-released/)).
**Wishlist** (2025) is a profile tab where friends can gift Shop items or selected game items.
Owned, Orb-exclusive and bundle items are excluded
([Wishlist FAQ](https://support.discord.com/hc/en-us/articles/36288192746903) (snippet);
[PocketGamer.biz](https://www.pocketgamer.biz/discord-launches-wishlist-feature-for-saving-and-showcasing-cosmetic-items/)).

**Recommendation.** **Do not copy the currency or the ads.** They're the monetisation layer, and
they conflict with "all free". Keep the *good* parts:
- A **"Collection" browser** (`CollectiblesPage.jsx`, reachable from the profile editor) that looks
  like a shop and has previews and "Try on", but everything is free to equip. Event items
  (`available_from/until`) are claimable during a window ("Songkran 2027 set"), which gives the
  scarcity fun without money. Achievements (such as "Hosted 5 events", granted by server mods or
  system rules) unlock a few items.
- **Gifting without money:** a friend can "Send as gift" any event item they own during its window
  (it grants a `user_cosmetics` row to the recipient, with a DM system message). Cap it at 3 gifts
  per day to prevent farming.
- **Wishlist** → skip, or fold into widgets (§14, "Want to play" list).
- **Effort:** Collection page **M** (on top of §1). Gifting **S**.

## 19. Profile Frames (2026)

**Discord behaviour.** A decorative border around the **whole profile card**, per server capable.
Nitro early access on 2 Aug 2026, wider later
([Profile Frames FAQ](https://support.discord.com/hc/en-us/articles/40775065582615) (snippet);
[Aug 11 2026 changelog](https://discord.com/blog/discord-update-august-11-2026-changelog) (snippet)).

**Recommendation.** `kind='profile_frame'`, `users.profile_frame_id`. A CSS `border-image` using an
SVG 9-slice, so it's cheap and scales. It ships in the same pack format. **Effort S** after §1.

## 20. Try it out / profile preview

**Discord behaviour.** Settings → Profiles shows a **live preview card** beside the form. Non-Nitro
users can apply Nitro options in preview ("Try it out") but can't save
([Display Name Styles FAQ](https://support.discord.com/hc/en-us/articles/33833879643927) (snippet)).
Shop items preview on your own avatar.

**Recommendation.** A `ProfilePreview.jsx` split view in `ProfileTab` (sticky right column on
desktop, a "Preview" sheet on mobile). It renders the **real** `ProfileCard` component with the
draft state, and toggles for popout / full profile / member row / chat message plus dark/light.
"Try on" from other users' profiles loads their item into the draft. Since everything is free,
"Try it out" simply becomes "Apply". **Effort S–M.** This is the most valuable UX piece because
every other cosmetic depends on it.

## 21. New-member badge (🌱)

**Discord behaviour.** In Community servers, a sprout icon next to the names of members who joined
within the last ~week, with a "new here, say hi" tooltip. Mods see it in the member list
([mezotv/discord-badges](https://github.com/mezotv/discord-badges); a
[forum complaint](https://support.discord.com/hc/en-us/community/posts/5541583364759) says it
lasts "too long") (unverified duration).

**Recommendation.** Computed from `server_members.joined_at`; no schema. Add
`servers.new_member_badge_days INTEGER DEFAULT 7` (0 disables). Render a small SVG sprout
(original) with a tooltip "Joined 3 days ago — say hi!" (i18n). Also useful for raid review (our
raid protection exists). **Effort S.**

## 22. User popout vs full profile (2024–2025 redesign)

**Discord behaviour.** In April 2024 Discord tested and then shipped a denser **popout** (banner,
avatar, name, status bubble, a short bio, roles collapsed, "View full profile") and a separate
**full profile** modal with tabs: *Activity*, *Mutual Servers*, *Mutual Friends*, later *Wishlist*
and *Board/Widgets*. The redesign got mixed reviews on readability
([DiscordPreviews 2024-04](https://x.com/DiscordPreviews/status/1780297750619316603);
[forum](https://support.discord.com/hc/en-us/community/posts/24425749696663)). The custom status
now appears as a thought-bubble near the avatar (unverified detail).

**Recommendation.** Split `UserProfileModal.jsx` into:
- `ProfilePopout.jsx`: anchored to the clicked avatar or name (Floating UI style positioning;
  focus-trapped; Esc closes). Contents: banner, avatar with decoration, name with style, tag,
  badges, custom status, pronouns, the first 3 lines of bio, roles (first 6 + "+N"), a
  "Message @x" input, "View full profile".
- `ProfileFullModal.jsx`: a larger two-column layout. Left: identity (as above plus member since,
  notes, connections). Right: tabs **About / Activity / Mutual servers (N) / Mutual friends (N) /
  Board**. `mutual_servers` is already returned; add `mutual_friends` in `getUser()` (a query over
  `friends`, capped at 100 and only when the viewer is allowed).
- Keep a shared `ProfileCard` primitive (theme gradient, effect layer, frame) used by the popout,
  the full modal and the editor preview.
- Profile Privacy parity (Discord Aug 2026: *Friends & all servers / Friends & small servers (≤ 200)
  / Friends only*; the avatar, banner, names, server tag and mutuals stay visible;
  [Profile Privacy](https://support.discord.com/hc/en-us/articles/38859942749463) (snippet)):
  extend our `profile_visibility` enum with `'small_servers'`, and apply it to bio, pronouns,
  badges, widgets, connections and activity, not just the bio.
- **Effort M.**

## 23. Notes on users

**Discord behaviour.** A private note on any profile, visible only to you. **Ours:** done
(`user_notes`, autosave). Small additions: a note preview in the member-list hover, and include
notes in the data export (check the `/api/users/@me/export` coverage). **Effort S.**

---

## Cross-cutting design

### Asset strategy (no Discord assets)
- **Builtin pack** `packs/builtin-core/` in the repo: `manifest.json` plus `*.svg` and `*.css`. We
  own all art (commissioned or made in-house, CC-BY-4.0 or MIT), including a **Thai culture set**
  (lai Thai ring, Songkran water effect, Loy Krathong lanterns, jasmine garland).
- **Pack format for admins** (zip ≤ 5 MB): `manifest.json` `{slug, name, version, author, license,
  items:[{kind, slug, name, renderer:'svg'|'css'|'image', file, poster?, params?}]}`. The server
  validates the manifest.
  - SVGs are sanitised: DOMPurify-style whitelist, no `<script>`, no `foreignObject`, no external
    `href`, no event attributes.
  - CSS is **not** accepted raw from admin packs. Instead there's a declarative animation
    vocabulary: `params` choose from builtin keyframes (`spin`, `pulse`, `float`, `twinkle`,
    `fall`) with duration ≥ 1.5 s. This prevents CSS injection and seizure-inducing timings.
  - Images: APNG/WebP ≤ 512 KB with a required static poster.
- Assets are served from our storage with long-cache immutable URLs (`/api/media/...`). Clients
  fetch the catalogue once (`ETag`) and lazy-load item assets.

### Motion and performance rules (apply to every cosmetic)
1. Honour `prefers-reduced-motion` **and** the app's `a11y.reducedMotion`, via a single
   `useMotionAllowed()` hook plus `html[data-reduced-motion]` CSS.
2. **Static in dense surfaces** (member list, chat, mentions); animate on hover/focus or in
   popouts/profiles only. Effects play once.
3. Only `transform`/`opacity` animations; `will-change` only while animating; pause with
   `IntersectionObserver` and `document.hidden`.
4. No more than 3 flashes/second (WCAG 2.3.1); the pack review checklist enforces it.
5. Viewer controls in **Settings → Appearance → "Other people's profiles"**: decorations (always /
   hover / off), effects (on/off), name styles (on/off), custom profile colours (on/off).
   Streamer mode hides all of them.

### Moderation and impersonation
- **Server-level:** `servers.cosmetics_policy JSONB` `{decorations:'all'|'static'|'off',
  name_styles:bool, member_avatars:bool, server_tags_from_other_servers:bool}`.
- **AutoMod** extends to the display name, server nickname, pronouns, bio, custom status and adopted
  server tag (matching Discord's `AUTOMOD_QUARANTINED_USERNAME` / `_GUILD_TAG` flags). A quarantined
  member shows a neutral name ("Member 1234") in that server until fixed.
- **Report profile** action (reasons: impersonation, offensive image, offensive text, scam). It
  reuses the existing `reports` table (`target_type='user'`, which already exists) and adds a
  `snapshot JSONB` column that captures the reported profile at report time, since profiles change.
- **Moderator reset:** mods can reset a member's server nickname/avatar/bio/name style; instance
  admins can reset global fields and revoke any cosmetic. Both are audit-logged.
- **Impersonation guards:** styles and icons for BOT/SYSTEM/staff are reserved. Display names that
  are confusable with a server's owner or mods, *within that server*, are flagged (NFKC plus a
  skeleton comparison, as in Unicode TR39). The popout always shows `@username`.
- **Banners and avatars:** existing `scan_status` pipeline; show a blurred placeholder while
  `pending`/`flagged`.

### Consolidated schema delta (one migration, `db/migrations/NNN_profile_identity.sql`, SQLite + PG)
```
users            + theme_colors, name_style, avatar_decoration_id, avatar_decoration_params,
                   profile_effect_id, nameplate_id, nameplate_palette, profile_frame_id,
                   primary_server_tag_id, server_tag_enabled, custom_status_expires_at,
                   status_expires_at, avatar_animated, banner_animated
                   profile_visibility enum += 'small_servers'
server_members   + theme_colors, name_style, avatar_decoration_id, avatar_decoration_params,
                   profile_effect_id, nameplate_id, profile_frame_id
servers          + new_member_badge_days, cosmetics_policy, allow_member_avatars
new tables       cosmetic_packs, cosmetic_items, user_cosmetics, badges, user_badges,
                 server_tags, profile_widgets, user_connections
files.category   += 'cosmetics'
```
Keep the public user payload small. Denormalise equipped cosmetics into a compact
`cosmetics: {deco:'slug@pack', effect:…, plate:…, frame:…, style:{…}, tag:{t:'GANG', i:'sword', c:'#…'}}`
that is sent in `READY`/member chunks, and the catalogue once.

---

## Prioritized implementation list

| # | Item | Why first | Effort |
|---|---|---|---|
| 1 | Popout / full-profile split with Mutual servers and Mutual friends tabs (§22) | API data is already there; biggest UX gain | M |
| 2 | Live `ProfilePreview` + shared `ProfileCard` (§20) | Every cosmetic below depends on it | S–M |
| 3 | Custom status expiry + emoji picker (§17), bio markdown at 300 characters (§10), 🌱 new-member badge (§21) | Quick parity wins | S each |
| 4 | Profile theme gradient (§5), avatar/banner crop + animated variants (§6–7) | Visible and free on our side (Nitro-only on Discord) | M |
| 5 | Display name styles with contrast and impersonation guards (§4) | Headline 2025–26 feature | M |
| 6 | Server tags (§12) + AutoMod coverage of identity fields + profile reports | Community identity; needs moderation from day 1 | M |
| 7 | Collectibles core: catalogue, builtin CSS/SVG pack, avatar decorations (§1), then effects, nameplates, frames (§2, §3, §19) | Largest; the pack format unlocks admin creativity | L (core) + S–M each |
| 8 | Badges: system, instance and server-defined (§11) | Trust signals; low risk | M |
| 9 | Per-server profile gaps (§8) | Extends existing free feature | M |
| 10 | Connections (verified without OAuth first) and activity cards (§15–16) | Needs admin config for OAuth | M–L |
| 11 | Profile board widgets (§14), collection page, event claims, gifting (§18) | Nice-to-have delight | M–L |

**Explicitly not doing:** a paid Shop, a virtual currency (Orbs), sponsored Quests, wishlist-for-purchase,
or any Discord-branded or copied art, fonts or badge icons.
