# Discord Server-Level UI & Navigation (2023 – 2026) — Research & Recommendations

Author: product design research pass, 2026-09-26. Scope: server rail, channel list, member list,
server identity (banner / splash / icon / tags), role styling, home/DM, inbox, switcher/search,
chrome, and mobile navigation. Read-only review of `src/components/ServerRail.jsx`,
`ChannelSidebar.jsx`, `MemberList.jsx`, `ServerSettingsModal.jsx`, `src/App.jsx` (layout) and
`db/schema.pg.sql`, `services/guilds.js`, `services/guildAdmin.js`.

**Sourcing note.** `discord.com`, `support.discord.com` and most press sites were blocked by the
egress proxy, so claims below come from search-engine snippets of the cited pages (titles/URLs are
real search results; dates are the article's publication date where known, otherwise the date of
access, 2026-09-26). Anything not confirmed by at least one Discord-owned URL is marked
**(unverified)**.

Effort scale: **S** ≤ 1 day, **M** 2–5 days, **L** > 1 week. Priority **P0** (do next) → **P3**.

---

## 0. What we already have (baseline)

| Area | Status in our app | Where |
|---|---|---|
| Server folders (drag server onto server → folder, colour, collapse, rename, unread/mention roll-up) | Done, stored per user in `user_settings.layout` JSON (`serverFolders`, `serverOrder`) | `ServerRail.jsx` `buildRows`, `foldTogether` |
| Unread pill (white left pill 8px/20px/40px) + red mention badge, muted dimming | Done | `ServerRail.jsx` `RailButton` |
| Role gradient (`roles.color_secondary`) + role icon (`roles.icon_url`) rendering | Rendered in `MemberList.jsx` **but broken end-to-end** (see bug below) and **no editor UI** | `MemberList.jsx`, `services/guilds.js` |
| Server banner / invite splash / vanity URL columns | Columns exist (`servers.banner_url`, `splash_url`, `vanity_url`), backend writable (`guildAdmin.js:21`). Only vanity has UI. Banner and splash are never shown. | `ServerSettingsModal.jsx` `overviewForm` |
| Pinned channels group, threads under parent, private lock glyph | Done | `ChannelSidebar.jsx` |
| Voice users under channel | **Only for the channel *you* are in** (`isConnectedVoice && activeVoiceParticipants`) | `ChannelSidebar.jsx` |
| Hoisted-role groups + Online/Offline in member list, custom status line | Done | `MemberList.jsx` `groupMembers` |
| Onboarding, Insights, Welcome screen tables | Exist (`onboarding_prompts`, `welcome_channels`, `InsightsTab.jsx`) | settings |
| Themes Light/Ash/Dark/Onyx + density Compact/Default/Spacious | Done (matches Discord Mar-2025) | `settings/AppearanceTab.jsx` |
| Inbox | Single flat list, no tabs | `NotificationsInbox.jsx` |
| Quick switcher (Ctrl+K) | Prefix/substring scoring, no sigil filters | `QuickSwitcher.jsx` |
| Mobile | Rail + channel list slide in together as one drawer (`mobileSidebarOpen`); no bottom tab bar, no swipe-to-open | `App.jsx`, `ServerRail.jsx` |

### Bug found during review (fix first, S)
`services/guilds.js` ~line 261 selects role rows **without `r.color_secondary`**:

```sql
SELECT mr.user_id, r.id, r.name, r.color, r.position, r.permissions, r.hoist, r.managed, r.icon_url
```

…but lines 282–289 destructure `color_secondary` and emit `role_color_secondary`. It is therefore
always `null`, so gradient role names never render even though the column, the admin write path
(`guildAdmin.js:212`) and the renderer (`MemberList.jsx`) all exist. Add `r.color_secondary` to the
SELECT. (Also: RolesTab in `ServerSettingsModal.jsx` has no control to set it or `icon_url`.)

---

## 1. Server list (rail)

**What Discord does**
- Folders: drag a server onto another to create a folder; right-click → Folder Settings to rename
  and pick a colour; "Mark Folder as Read"; up to 100 servers per folder; badges aggregate.
  ([Server Folders 101](https://support.discord.com/hc/en-us/articles/360030853132-Server-Folders-101), accessed 2026-09-26)
- White unread pill / tall active pill; red mention badge; muted servers greyed.
- Discover (compass) sits at the bottom of the rail and opens the Discover tab (servers, Quests).
  ([Discover Tab](https://support.discord.com/hc/en-us/articles/25323248535319-Discover-Tab))
- Mobile Aug-2026 refresh: "people are circles, things are squircles" — servers become squircles
  everywhere, including the server list. ([Mobile Visual Refresh](https://support.discord.com/hc/en-us/articles/42383370736023-Mobile-Visual-Refresh-What-s-Changing); [blog: Squircles, Styles, and Spacing](https://discord.com/blog/improving-mobile-with-squircles-styles-and-spacing), Aug 2026)
- Paywall: none for folders.

**Recommendations**
1. **Folder settings popover** replacing `window.prompt` in `renameFolder`: name field + 8–12 colour
   swatches + custom hex, "Mark folder as read", "Ungroup". Reuse `ContextMenu.jsx`. **S, P1**.
2. **Mark server/folder as read** on right-click (rail context menu already exists via
   `onServerContextMenu`). **S, P1**.
3. **Keyboard reordering** (Alt+↑/↓ on focused rail item) — drag-and-drop is mouse-only today;
   an a11y gap. **M, P2**.
4. **Voice-activity indicator** on server icon (small speaker glyph when friends/you are in voice)
   — Discord shows this; needs `voice_states` per server in `perServer` map. **S, P2**.
5. **Server-side persistence of folders**: current JSON in `user_settings.layout` is fine (Discord
   also stores folders in user settings). Keep; no table needed. If sync conflicts appear, add
   `user_server_folders(user_id, folder_id, name, color, position, collapsed)` +
   `server_settings.folder_id`. **Defer**.
6. Mentions for un-hydrated servers are currently unknown (comment in `ServerRail.jsx`). Add a
   `GET /api/users/@me/unread-summary` returning `{server_id, unread, mentions}` so the rail is
   correct at boot. **M, P1**.

## 2. Server tags

**What Discord does:** Server Tags (June 2025) — a ≤4-character tag (+ small badge icon) a member
"adopts" and displays next to their name across Discord (chat, member list, profile, DMs); clicking
it opens the server profile / join. Now sold as an "Additional Perk" that costs boosts outside level
progression. ([Server Tags](https://support.discord.com/hc/en-us/articles/31444248479639-Server-Tags); [June 30 2025 changelog](https://discord.com/blog/discord-update-june-30-2025-changelog); boost-cost detail **(unverified)**, [nitroloot 2026](https://nitroloot.com/blog/posts/how-discord-server-boosts-work-2026-new-perks-explained/))

**Paywall:** yes (boosts). **We make it free.**

**Recommendation (M, P2):**
- `servers.tag TEXT CHECK(length(tag) BETWEEN 2 AND 4)`, `servers.tag_badge_url TEXT`,
  `servers.tag_color TEXT`.
- `users.primary_server_tag_id TEXT REFERENCES servers(id)` (the server whose tag the user wears;
  must be a member; clear on leave).
- Render a `<ServerTagChip>` next to display names in `ChatArea` message header, `MemberList`,
  `UserProfileModal`. Click → server profile card (see §4) with Join button.
- Settings: Server Settings › Overview "Server Tag" block; User Settings › Profile "Display tag".

## 3. Role styling: icons, gradients, holographic

**What Discord does**
- Custom role icons (image or unicode emoji next to name) — Boost Level 2. ([Boosting FAQ](https://support.discord.com/hc/en-us/articles/360028038352-Server-Boosting-FAQ))
- **Enhanced Role Styles** (2025): gradient (2 colours, sometimes 3) and **holographic** (animated
  iridescent shimmer) role names; unlocked by 3 boosts as an additional perk, unlimited roles once
  unlocked; renders on all platforms. ([Enhanced Role Styles](https://support.discord.com/hc/en-us/articles/31444213087255-Enhanced-Role-Styles); [discord.js RoleColors: primary/secondary/tertiary](https://discord.js.org/docs/packages/discord.js/main/RoleColors:Interface))

**Paywall:** yes. **We make all of it free.**

**Recommendations**
1. Fix the `color_secondary` SELECT bug (§0). **S, P0**.
2. RolesTab editor: "Style: Solid / Gradient / Holographic", two colour pickers, live preview
   using the same style object as `MemberList`. Role icon: upload (reuse emoji upload path) or pick
   unicode emoji. **M, P0**.
3. Schema: add `roles.color_tertiary TEXT`, `roles.style TEXT CHECK (style IN ('solid','gradient','holographic')) DEFAULT 'solid'`,
   `roles.unicode_emoji TEXT` (icon alternative). **S**.
4. Extract `roleNameStyle(member, mode)` into `src/utils/roleStyle.js` and use it in
   **ChatArea message author names**, mentions (`@role` pills), autocomplete and profile — today the
   gradient only exists in `MemberList`. **S, P0**.
5. Holographic = CSS `background: linear-gradient(90deg, …6 stops…)` + `background-size:200%` +
   keyframe `background-position` 4s loop; **respect `prefers-reduced-motion` and our
   Accessibility › Role Colors setting** (dots/none modes) — falls back to static gradient. **S**.
6. Contrast guard: warn in editor if either stop fails 3:1 against Dark/Light backgrounds.

## 4. Server identity: banner, animated icon, invite splash, vanity URL, server profile

**What Discord does**
- Level 1 (2 boosts): invite splash background, animated icon. Level 2 (7): server banner at top of
  channel list, role icons. Level 3 (14): vanity URL. ([Boosting FAQ](https://support.discord.com/hc/en-us/articles/360028038352-Server-Boosting-FAQ); [Server Banners & Invite Splash](https://support.discord.com/hc/en-us/articles/360028716472-Server-Banners))
- Splash 1920×1080 full-screen behind invite UI with dark bottom gradient; banner 960×540 (16:9). **(sizes unverified, third-party guides)**
- **Server Profile** (2025): card with icon, banner (or colour), description, games, and emoji
  "traits"; shown in discovery/invites/tag clicks. ([Server Profile](https://support.discord.com/hc/en-us/articles/30715364399511-Server-Profile))

**Paywall:** all of the above except basic icon. **Make all free.**

**Recommendations**
1. **Banner in channel sidebar header** (`ChannelSidebar.jsx` server header): when
   `currentServer.banner_url`, render a 135px image header with the server name overlaid; collapse
   to the 48px bar as the channel list scrolls (Discord behaviour). **S, P0**.
2. **Upload controls** for banner + splash in `OverviewTab` (fields already whitelisted in
   `guildAdmin.js`; reuse icon upload; add `splash_file_id` column for GC parity with
   `banner_file_id`). **S, P0**.
3. **Invite page splash** (`InviteJoinScreen.jsx`): full-bleed `splash_url` with
   `bg-gradient-to-t from-black/80`; card shows icon, name, description, online/member counts
   (already returned as `online_count`, `member_count`), inviter, and banner strip. Include
   `splash_url, banner_url, description` in the invite preview query (`services/guilds.js` ~923). **S, P0**.
4. **Animated icon/banner**: accept GIF/APNG/WebP; show static first frame (we have `StillImage.jsx`)
   and animate on hover / when the server is active, honouring reduced motion. **S, P1**.
5. **Server profile card**: `servers.traits JSONB` (≤5 `{emoji,label}`), `servers.accent_color`;
   component `ServerProfileCard.jsx` reused by discovery, invite page, tag click. **M, P2**.
6. Vanity URL already free — keep.

## 5. Channel list

**What Discord does**
- Categories (collapsible, collapsed categories still show unread/active channels).
- Channel names with emoji prefixes are a *community convention* (emoji typed into the name);
  Discord has no native per-channel icon field. ([ProSettings how-to](https://www.prosettings.com/emojis-discord-channel-names/); feature request thread [Channel Icons](https://support.discord.com/hc/en-us/community/posts/360040862772-Channel-Icons)). Native channel emoji experiment **(unverified)**.
- **Channels & Roles** entry above the list (Onboarding servers): edit onboarding answers, **Browse
  Channels** to add/remove opt-in channels; **Server Guide** entry (welcome message, new-member
  to-dos, resource pages). ([Community Onboarding FAQ](https://support.discord.com/hc/en-us/articles/11074987197975-Community-Onboarding-FAQ); [Server Guide FAQ](https://support.discord.com/hc/en-us/articles/13497665141655-Server-Guide-FAQ))
- **Events** row at top of channel list with count of upcoming events. ([Scheduled Events](https://support.discord.com/hc/en-us/articles/4409494125719-Scheduled-Events))
- Voice channels list **every** connected member (avatar, speaking ring, mute/deaf/stream/video
  icons, "LIVE" badge) whether or not you are connected; user limit shown as `3/10`.
- Mar-2025 desktop: resizable channel-list width. ([Engadget, 2025-03-25](https://www.engadget.com/gaming/pc/discords-redesigned-pc-app-has-multiple-dark-modes-a-new-overlay-and-more-160019822.html))
- Paywall: none.

**Recommendations**
1. **Show voice occupants for all voice channels** — `ChannelSidebar.jsx` currently only renders
   `activeVoiceParticipants` for the connected channel. Feed a `voiceStatesByChannel` map from the
   existing `voice_states` table/realtime events. Add `LIVE`/camera glyphs and `n/limit`. **M, P0**.
2. **Native channel icon/emoji** (improves on Discord, free): `channels.icon_emoji TEXT` (unicode
   or custom emoji id). Render in place of `#`/speaker glyph with the type glyph as a tiny corner
   badge (same pattern as the private-lock overlay). **S, P1**.
3. **Top-of-list shortcuts block**: "Events (n)", "Channels & Roles", "Server Guide", "Browse
   Channels" rows under the banner. Onboarding data exists (`onboarding_prompts/options`,
   `member_onboarding`); add `member_channel_optins(server_id,user_id,channel_id,opted_in)` for
   Browse Channels and filter `grouped` by it. **M, P1** (Server Guide page itself **M, P2**:
   `server_guide_resources(server_id, id, title, description, channel_id, image_url, position)` and
   `server_guide_actions(...)` for new-member to-dos).
4. **Resizable sidebar** (drag handle, 200–360px, persisted in `prefs.layout.channelListWidth`). **S, P2**.
5. Collapse-state persistence: `collapsed` is component state and resets on navigation; persist in
   `prefs.layout.collapsedCategories[serverId]`. **S, P1**.
6. Keyboard: Alt+↑/↓ next channel, Alt+Shift+↑/↓ next unread (verify existing keybinds in
   `KeybindsTab.jsx`). **S, P2**.

## 6. Member list

**What Discord does**
- Hoisted role groups ordered by position, then Online, then Offline; role colour/gradient/icon;
  custom status or rich-presence line ("Playing X").
- **Recent Activity** section (rolled out 2024-08-28): top of member list shows what members are
  playing/listening to, most-played game, streaks; per-server and per-game privacy toggles.
  ([Members List Recent Activity FAQ](https://support.discord.com/hc/en-us/articles/22045487931799-Members-List-Recent-Activity-FAQ); [PC Gamer](https://www.pcgamer.com/software/platforms/discord-activity-tracking-log-update/))
- Server tag chip next to names (2025).
- Paywall: none (visual flair from role styles is boost-gated, see §3).

**Recommendations**
1. **Virtualise** the list (react-window style windowing) — current render is O(members); needed
   before large servers. **M, P1**.
2. **Activity header**: "Active now" card listing members in voice (per channel) and members with
   a shared activity (`users.custom_status` + ActivityTab's `customActivity`). No game detection on
   web, so scope to voice + custom activity + events-going-live. Respect ActivityTab privacy
   switch; add per-server opt-out in `server_settings.share_activity`. **M, P2**.
3. Show role icon **before** gradient name's end consistently; move BOT/owner/pending badges into a
   shared `<NameBadges>` so ChatArea matches. **S, P1**.
4. Member list toggle + width persist (`prefs.layout.memberListOpen`). **S, P3**.

## 7. Server discovery, welcome screen, onboarding visuals

**What Discord does:** Discover tab from rail compass: categories, search, featured servers, also
Quests. ([Discover Tab](https://support.discord.com/hc/en-us/articles/25323248535319-Discover-Tab)).
Welcome screen (pre-onboarding modal with description + up to 5 recommended channels with emoji);
Onboarding questions with images/emoji; Server Guide. Discovery requires Community + eligibility.

**Recommendations (self-hosted twist)**
1. Our compass button currently means "join with invite". Make it open **`DiscoverPage.jsx`**
   listing *instance-local* servers flagged `features @> '["DISCOVERABLE"]'`, cards = §4 server
   profile card (banner, icon, name, description, online/member counts, traits). Search by
   name/trait. **M, P2**. Keep "Join with invite" as the first card/input.
2. Welcome screen: ensure recommended channels render their emoji/icon (§5.2) and the banner. **S, P2**.
3. Onboarding option images: `onboarding_options.image_url`. **S, P3**.

## 8. Invite page — see §4.3 (**S, P0**). Also add OG meta (server name, icon, member count) to the
server-rendered `/invite/:code` HTML so links unfurl in other apps. **S, P1**.

## 9. Server insights

Discord keeps Server Insights (Community servers ≥ some size), still being maintained as of
2025-09-03 patch notes. ([Server Insights FAQ](https://support.discord.com/hc/en-us/articles/360032807371-Server-Insights-FAQ); [Patch Notes 2025-09-03](https://discord.com/blog/discord-patch-notes-september-3-2025))
Size-gated → **free for every server** in ours (`settings/InsightsTab.jsx` already exists). Add
join-source (invite code/vanity), retention (D1/D7 of new members), top channels, and
"members who completed onboarding". **M, P3**.

## 10. Event cards

Discord: Events row atop channel list; cards with cover image, time, host, location/channel,
"Interested" count and button; native recurring events (2024). ([Scheduled Events](https://support.discord.com/hc/en-us/articles/4409494125719-Scheduled-Events); recurrence detail from [PeakBot 2026](https://peakbot.pro/blog/how-to-set-up-discord-events-2026) **(unverified)**)
**Recommend:** "Events (n)" shortcut row (§5.3) + "Live now" green banner in channel list when an
event starts; cover image column `scheduled_events.image_url` if missing; recurrence
`scheduled_events.recurrence_rule TEXT` (RRULE subset). `EventsPanel.jsx`. **M, P2**.

## 11. Home: DM list, friends list, Nitro/Shop placement

**What Discord does:** Home = DM list with Friends / Nitro / Shop rows above DMs (users request
hiding Nitro/Shop — [feedback thread](https://support.discord.com/hc/en-us/community/posts/18237735948695-Option-to-hide-tabs-Nitro-Shop-in-DM-screen)); Friends page tabs Online/All/Pending/Blocked/Add Friend, and an **Active Now** column showing friends in voice/games. ([feedback on Active Now](https://support.discord.com/hc/en-us/community/posts/19628228447767-Option-to-remove-Active-Now-sections-on-both-Desktop-and-Mobile))

**Recommendations:** No Nitro/Shop (nothing to sell) — use that space for **"Message Requests"**
and **"Saved / Bookmarks"** if built. Add a collapsible **Active Now** column to the Friends view in
`HomeDirectMessages.jsx` (friends in voice channels of mutual servers + custom status). Add DM
list filtering (type-to-filter) and pin DMs. **M, P2**.

## 12. User panel (bottom-left)

**What Discord does (Mar-2025 refresh):** the panel grew and now spans *under the server rail*
(full left width), showing avatar+status, name, status/activity line, mic/deafen/settings; call
controls moved to a central bottom bar during calls; brighter red for muted mic. Users criticised
the height. ([Engadget 2025-03-25](https://www.engadget.com/gaming/pc/discords-redesigned-pc-app-has-multiple-dark-modes-a-new-overlay-and-more-160019822.html); [BetaNews 2025-03-25](https://betanews.com/2025/03/25/discord-game-overlay-update-desktop-customization-pc-gaming/); [Medium analysis](https://medium.com/@negi28.sumit/discords-march-2025-ui-overhaul-loved-or-hated-fff69f5eaebe))

**Recommendations:** keep our compact 56px panel in `ChannelSidebar.jsx` (the backlash says
compact wins), but (a) show the user's **activity line** ("In voice: #lounge" / custom activity)
instead of `@username` when set; (b) merge the voice-connected bar into the panel as one card with
ping/quality indicator + Disconnect + camera/screen buttons; (c) mic-muted red state already
present — add a subtle red background tint; (d) on Home view render the same panel (verify it
exists in `HomeDirectMessages.jsx`). Extract `UserPanel.jsx`. **S–M, P1**.

## 13. Title bar & window chrome

**What Discord does (2025):** a new title bar shows the current server icon/name centred plus
Inbox and Help buttons next to the window controls; criticised as redundant vertical space.
([Techissuestoday](https://techissuestoday.com/discord-begins-rolling-out-redesigned-ui-for-desktop-app/); [feedback thread](https://support.discord.com/hc/en-us/community/posts/30924970312983-UI-refresh-adds-redundant-separate-title-bar))
**Recommendation:** we're a web/PWA app — **don't add a title bar**. Keep inbox bell in the chat
header. For the PWA install, use `display_override: ["window-controls-overlay"]` so the header can
occupy the title-bar area on desktop. **S, P3**.

## 14. Notifications inbox

**What Discord does:** Inbox with **For You** (friend requests, events, highlights — desktop "For
You" presence **(unverified)** beyond mobile), **Unreads** (channel-by-channel catch-up incl.
@here), **Mentions** (direct, @everyone, @role) with filter "this server / all servers" and
"include @everyone/@roles". ([Inbox FAQ](https://support.discord.com/hc/en-us/articles/360045027712-Inbox-FAQ)). Mobile 2023 Notifications tab combined mentions, friend requests, events, replies. ([TechCrunch 2023-12-05](https://techcrunch.com/2023/12/05/discord-app-redesign-mobile))

**Recommendations** (`NotificationsInbox.jsx`, **M, P1**):
- Tabs: **Mentions** (current list) | **Unreads** (per-channel collapsible groups from
  `readStates`, jump + mark-read per channel) | **For You** (friend requests, event reminders,
  replies, role grants).
- Filters on Mentions: current server only, include @everyone, include @roles.
- `notifications.type` add `friend_request`, `event_start`, `reply`, `role_grant`.
- Make it a right-side panel on desktop and a full-screen sheet on mobile, rather than an
  absolutely-positioned 360px popover.

## 15. Quick switcher & search

**What Discord does:** Ctrl/⌘+K; sigils `*` servers, `@` users/DMs, `#` text channels, `!` voice
channels; unread and mention badges; recent first. ([Quick Switcher](https://support.discord.com/hc/en-us/articles/115000070311-Quick-Switcher); [Commands & Navigation Guide](https://support.discord.com/hc/en-us/articles/31232432266647-Discord-Commands-Shortcuts-and-Navigation-Guide)). Search: inline filter chips `from:`, `in:`, `has:`, `before:` etc. with prompts (2024 mobile improvement). ([AlternativeTo 2024-05](https://alternativeto.net/news/2024/5/discord-brings-back-unified-view-to-mobile-and-improves-search-and-accessibility-features))

**Recommendations:** `QuickSwitcher.jsx`: sigil filters, section headers, unread/mention badges,
recency boost (MRU list in `prefs.layout.recentDestinations`), server name as secondary text.
**S, P1**. `SearchResultsPanel`: token chips with autocomplete for `from:/in:/has:/before:/after:
/mentions:` and "Jump" per result. **M, P2**.

## 16. Keyboard navigation

Discord: Alt+↑/↓ channels, Alt+Shift+↑/↓ unread channels, Ctrl+Alt+↑/↓ servers, Ctrl+/ shortcut
sheet, Esc mark read, Shift+Esc mark server read, F6 region cycling. ([Discord keyboard shortcuts blog](https://discord.com/blog/how-to-use-keyboard-shortcuts-on-discord-create-custom-keybinds))
**Recommend:** audit `KeybindsTab.jsx` / `ShortcutsModal.jsx` against that list; add F6 region
cycling (rail → channels → messages → composer → members) using existing landmark ids; roving
tabindex in the rail. **M, P1**.

## 17. Mobile navigation 2023 – 2026

**Timeline**
- **2023-12**: redesign with bottom tabs **Servers / Messages / Notifications / You**; servers and
  DMs split. ([TechCrunch 2023-12-05](https://techcrunch.com/2023/12/05/discord-app-redesign-mobile); [New Mobile App Updates & Layout](https://support.discord.com/hc/en-us/articles/12654190110999-New-Mobile-App-Updates-Layout))
- **2024-05**: partial reversal — DMs back into the server list as a Messages icon at top of the
  rail; Home tab bottom-left contains rail + DMs. ([Improving Our Mobile Experience](https://discord.com/blog/improving-our-mobile-experience); [AlternativeTo 2024-05](https://alternativeto.net/news/2024/5/discord-brings-back-unified-view-to-mobile-and-improves-search-and-accessibility-features))
- **2026-08**: Mobile Visual Refresh — squircles for things/circles for people, Ash/Onyx themes,
  decluttered chat bar, closer to desktop. ([Mobile Visual Refresh](https://support.discord.com/hc/en-us/articles/42383370736023-Mobile-Visual-Refresh-What-s-Changing); [Squircles blog](https://discord.com/blog/improving-mobile-with-squircles-styles-and-spacing))
- Swipe right from chat reveals rail + channel list; swipe left reveals member list (long-standing
  pattern, not newly documented — **(unverified via source)**).

**Lesson:** Discord's own experiment showed splitting servers and DMs hurts; the winning pattern
is *rail + channel list as one panel, DMs as the top rail item, plus a small bottom tab bar
(Home / Notifications / You)*.

**Recommendations**
1. **Edge-swipe gestures** in `App.jsx`: swipe right (from left 24px or anywhere on chat with
   horizontal intent) opens the existing drawer; swipe left opens `MemberList` (already
   `max-lg:fixed`). Follow finger (translateX), snap at 40%. **M, P1**.
2. **Bottom tab bar** below `md` when the drawer is open: Home (rail+channels) / Notifications
   (inbox full screen) / You (profile + settings). Hide when in a chat. **M, P2**.
3. Apply "people circles / servers squircles": server icons `rounded-[16px]` at rest on mobile
   (desktop keeps circle→squircle hover morph). **S, P3**.
4. Safe-area insets (`env(safe-area-inset-*)`) on drawer and composer. **S, P1**.

---

## Paywall map — what we make free

| Discord feature | Discord gate | Ours |
|---|---|---|
| Animated server icon | Boost L1 | Free |
| Invite splash | Boost L1 | Free |
| Server banner | Boost L2 | Free |
| Role icons | Boost L2 | Free |
| Vanity URL | Boost L3 | Free (already) |
| Gradient / holographic roles | 3 boosts (additional perk) | Free |
| Server tag | Boosts (additional perk) | Free |
| Emoji/sticker/soundboard slot caps, upload size, audio bitrate | Boost levels | Admin-configurable instance limits |
| Server Insights | Community + size | Free for all |
| Nitro/Shop in Home | Upsell | Removed |

---

## Prioritised backlog

| # | Item | Files | Data | Effort | Pri |
|---|---|---|---|---|---|
| 1 | Fix `color_secondary` missing in member role SELECT | `services/guilds.js` | — | S | P0 |
| 2 | Role style editor (solid/gradient/holo, icon/emoji) + shared `roleStyle` util used in chat | `ServerSettingsModal.jsx` RolesTab, `utils/roleStyle.js`, `ChatArea.jsx` | `roles.style`, `color_tertiary`, `unicode_emoji` | M | P0 |
| 3 | Banner + splash upload in Overview; banner header in channel list | `ServerSettingsModal.jsx`, `ChannelSidebar.jsx` | `servers.splash_file_id` | S | P0 |
| 4 | Invite page with splash, banner, description | `InviteJoinScreen.jsx`, `services/guilds.js` | — | S | P0 |
| 5 | Voice occupants under every voice channel | `ChannelSidebar.jsx`, `App.jsx` | `voice_states` (exists) | M | P0 |
| 6 | Inbox tabs Mentions / Unreads / For You | `NotificationsInbox.jsx` | `notifications.type` values | M | P1 |
| 7 | Folder settings popover + mark read | `ServerRail.jsx` | — | S | P1 |
| 8 | Unread summary endpoint for rail at boot | `routes/`, `ServerRail.jsx` | — | M | P1 |
| 9 | Channel icon emoji + persisted category collapse | `ChannelSidebar.jsx`, `ChannelSettingsModal.jsx` | `channels.icon_emoji` | S | P1 |
| 10 | Channels & Roles / Browse Channels / Events shortcut rows | `ChannelSidebar.jsx`, `OnboardingModal.jsx` | `member_channel_optins` | M | P1 |
| 11 | Quick switcher sigils, badges, MRU | `QuickSwitcher.jsx` | prefs | S | P1 |
| 12 | User panel: activity line, merged voice card, `UserPanel.jsx` | `ChannelSidebar.jsx` | — | S–M | P1 |
| 13 | Mobile swipe gestures + safe areas | `App.jsx` | — | M | P1 |
| 14 | Keyboard nav audit (F6, Alt+arrows, rail roving tabindex) | `KeybindsTab.jsx`, `ServerRail.jsx` | — | M | P1 |
| 15 | Member list virtualisation | `MemberList.jsx` | — | M | P1 |
| 16 | Server tags (free) | `ChatArea`, `MemberList`, profile | `servers.tag*`, `users.primary_server_tag_id` | M | P2 |
| 17 | Server profile card + Discover page (instance-local) | new `ServerProfileCard.jsx`, `DiscoverPage.jsx` | `servers.traits`, `accent_color` | M | P2 |
| 18 | Activity header in member list; Active Now on Friends | `MemberList.jsx`, `HomeDirectMessages.jsx` | `server_settings.share_activity` | M | P2 |
| 19 | Event cards: live banner, cover, recurrence | `EventsPanel.jsx` | `scheduled_events.image_url`, `recurrence_rule` | M | P2 |
| 20 | Server Guide page | new `ServerGuide.jsx` | `server_guide_resources`, `server_guide_actions` | M | P2 |
| 21 | Search filter chips | `SearchResultsPanel.jsx` | — | M | P2 |
| 22 | Mobile bottom tab bar | `App.jsx` | — | M | P2 |
| 23 | Resizable channel list | `ChannelSidebar.jsx` | prefs | S | P2 |
| 24 | Insights extras (join source, retention) | `settings/InsightsTab.jsx` | invite-use log | M | P3 |
| 25 | PWA window-controls-overlay; mobile squircles | `public/manifest`, CSS | — | S | P3 |

---

## สรุปภาษาไทย

**ภาพรวม:** ระหว่างปี 2023–2026 Discord เปลี่ยน UI หลายรอบ — มือถือแยกแท็บ Servers/Messages ในปี
2023 แล้วถอยกลับรวม DM ไว้ในแถบเซิร์ฟเวอร์ในปี 2024, เดสก์ท็อปปรับใหม่มีนาคม 2025 (ธีม
Light/Ash/Dark/Onyx, ความหนาแน่น 3 ระดับ, title bar ใหม่ที่ถูกวิจารณ์ว่าเปลืองพื้นที่, แผงผู้ใช้
มุมซ้ายล่างใหญ่ขึ้น), ปี 2025 เพิ่ม Server Tags และ Enhanced Role Styles (ชื่อยศไล่สี/โฮโลแกรม)
ที่ต้องใช้บูสต์, และสิงหาคม 2026 มือถือปรับภาพ "คนเป็นวงกลม สิ่งของเป็น squircle"

**สิ่งที่แอปเรามีแล้ว:** โฟลเดอร์เซิร์ฟเวอร์ (ลากวางสร้างโฟลเดอร์ มีสี), จุด unread และตัวเลข
mention, ธีมและความหนาแน่นครบ, คอลัมน์ banner/splash/vanity ในฐานข้อมูล, การแสดงชื่อยศไล่สีและ
ไอคอนยศใน MemberList

**บั๊กที่พบ:** `services/guilds.js` ไม่ได้ SELECT `r.color_secondary` ทำให้ชื่อยศไล่สีไม่เคย
แสดงผลจริง — แก้ได้ในบรรทัดเดียว (ด่วนที่สุด)

**ฟีเจอร์ที่ Discord เก็บเงิน แต่เราจะให้ฟรี:** ไอคอนเคลื่อนไหว, พื้นหลังหน้าเชิญ (splash),
แบนเนอร์เซิร์ฟเวอร์, ไอคอนยศ, ยศไล่สี/โฮโลแกรม, Server Tag, vanity URL, Server Insights

**ลำดับความสำคัญ:**
- **P0:** แก้บั๊ก color_secondary (S), หน้าแก้ไขสไตล์ยศ + ใช้ในแชท (M), อัปโหลดแบนเนอร์/
  splash และแสดงแบนเนอร์หัวรายการช่อง (S), หน้าเชิญพร้อม splash (S), แสดงผู้ใช้ในทุกห้องเสียง (M)
- **P1:** Inbox แบบแท็บ Mentions/Unreads/For You (M), ตั้งค่าโฟลเดอร์แบบ popover (S),
  อีโมจิประจำช่อง (S), Channels & Roles/Browse Channels (M), Quick Switcher รองรับ `* @ # !` (S),
  แผงผู้ใช้ใหม่ (S–M), ท่าปัดบนมือถือ (M), คีย์บอร์ด (M), virtualise รายชื่อสมาชิก (M)
- **P2–P3:** Server Tag, การ์ดโปรไฟล์เซิร์ฟเวอร์ + หน้า Discover ภายในอินสแตนซ์, Activity ใน
  รายชื่อสมาชิก, การ์ดอีเวนต์, Server Guide, แท็บบาร์ด้านล่างบนมือถือ, Insights เพิ่มเติม

**บทเรียนสำคัญ:** อย่าแยก DM ออกจากรายการเซิร์ฟเวอร์บนมือถือ (Discord ลองแล้วถอยกลับ) และ
อย่าเพิ่ม title bar ที่กินพื้นที่แนวตั้ง — ให้คงความกะทัดรัดไว้
