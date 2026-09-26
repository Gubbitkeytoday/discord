# Discord chat, messaging and expression UI (2023–2026): research and recommendations

Author: product design research pass, 2026-09-26.
Scope: Discord's changes to the message list, the composer, expressions (emoji, stickers, GIFs, reactions, soundboard) and the chat surfaces around voice. For each item this doc gives what Discord ships, what we already have, and what to build.

**How to read the sources.** Every claim links to a source and the date it was published or checked. `[unverified]` marks a claim that comes only from third-party or community reporting, or from memory of the product, with no first-party confirmation found. discord.com and several news sites were blocked by the research proxy (egress policy), so first-party blog posts are cited from search-result snippets and not read in full. Treat any exact numbers taken from snippets as approximate.

**What we inspected (read-only):** `src/components/ChatArea.jsx` (2,248 lines), `EmojiPicker.jsx`, `StickerPicker.jsx`, `SoundboardPanel.jsx`, `SuperReaction.jsx`, `PollCard.jsx`, `VoiceNote.jsx`, `LinkEmbed.jsx`, `RichEmbed.jsx`, `ForumView.jsx`, `ForwardMessageModal.jsx`, `ComposerAutocomplete.jsx`, `VoiceRoom.jsx`, `settings/AppearanceTab.jsx`, `src/index.css`, and the forward handler in `src/App.jsx`. `src/components/chat/**` does not exist; all message rendering lives in `ChatArea.jsx`.

---

## 0. TL;DR

We are further along than most clones. We already have Discord's unread bar, jump-to-present, a hover action bar with quick reactions, shift-click super reactions with a reduced-motion guard, polls with live tallies, voice notes with a waveform scrubber, stickers with an animation preference, rich embeds plus buttons and selects, spoilers, forum list and gallery views, a soundboard, stage channels, text-in-voice, and PiP for calls.

The largest gaps, ranked by delight × effort:

1. **Forwarding is a silent copy.** `App.jsx` re-posts the content as a new message by the forwarder. There is no "Forwarded" label, no source link and no note. This is a correctness problem as well as a UX one: it misattributes words.
2. **No GIF picker at all.** Discord treats GIFs as a first-class tab next to emoji and stickers. Tenor's API shuts down on 2026-06-30, so any new build should target Klipy or GIPHY behind a server-side proxy.
3. **Multi-image messages lay out as a `flex-wrap` row.** Discord uses a mosaic (1, 2, 3, 4+ layouts) that keeps the message compact.
4. **Emoji picker has no names, so search cannot find unicode emoji.** It also lacks favorites, skin tones and a hover preview. There are no Stickers or GIFs tabs in the same popover.
5. **Quick reactions are hard-coded** (`QUICK_EMOJIS` in `ChatArea.jsx:57`) instead of being derived from the user's frequently used emoji.
6. **The typing indicator uses `animate-bounce`.** It is covered by the global reduced-motion block, but it reads louder than Discord's soft pulse.

The fastest high-delight wins are forwarding, frequency-based quick reactions, the image mosaic and emoji search names. Each is S–M effort.

---

## 1. Message layout: cozy, compact and the 2025 refresh

**Discord.**
- The desktop redesign began as an experiment on 2025-02-03 and was announced on 2025-03-25. It brings higher contrast, rounded corners, new themes (Onyx, Ash, Dark and a new Light) and a resizable channel list. [Dexerto, 2025-03](https://www.dexerto.com/entertainment/discord-announces-massive-desktop-redesign-with-tons-of-new-features-3168810/), [whop blog, 2025](https://whop.com/blog/discord-new-design/), [Discord community post, 2025-03](https://support.discord.com/hc/en-us/community/posts/30928210948247-New-Discord-UI-March-2025).
- It added UI density (Spacious, Default, Compact) as a setting separate from message display (Cozy or Compact). [Engadget via search snippet, 2025-03-25](https://www.engadget.com/gaming/pc/discords-redesigned-pc-app-has-multiple-dark-modes-a-new-overlay-and-more-160019822.html)
- The 2026 mobile refresh gave the chat bar a rounded-rectangle field and a squircle send button, and aims to unify mobile and desktop. Users pushed back hard on the Nitro gift button placed inside the message bar. [Friendcord, 2026](https://friendcordapp.com/blog/discord-mobile-ui-squarer-you-bar-2026), [Unstar, 2026](https://unstar.app/blog/discord-new-ui-gift-button-square-redesign-reviews-2026)

**Ours.** `AppearanceTab.jsx` already has both `uiDensity` (compact, default, spacious) and message display (cozy or compact). Parity is good.

**Recommendation (S).**
- Keep the composer free of promotional or low-frequency buttons. The gift-button backlash is the lesson: slots near the thumb are for high-frequency actions only.
- Check that compact mode keeps hover timestamps readable. In `ChatArea.jsx:1244` the timestamp gutter is `opacity-0 group-hover:opacity-100`. Also show it on `:focus-within` so keyboard users get it.

## 2. Reply, forward and quote

**Discord.**
- **Reply** shows a curved "spine" connector, the author's avatar and name, and a one-line excerpt. Clicking the excerpt jumps to the original and flashes it. A mention toggle (`@ ON`) appears in the reply bar above the composer. [unverified: long-standing product behaviour]
- **Forwarding** rolled out to 2% of users on 2024-07-09 and to everyone by 2024-10. It is available from the hover bar and from the context menu. You can pick several destinations (up to five, per reports) and add an optional note. The forwarded copy shows a "Forwarded" label and a link to the source, and hides the original author. [Beebom, 2024](https://beebom.com/discord-message-forwarding-rolls-out/), [Discord Help: Message Forwarding](https://support.discord.com/hc/en-us/articles/24640649961367-Message-Forwarding), [whop, 2024](https://whop.com/blog/discord-message-forwarding/)
- **Quote** uses the `> ` markdown blockquote with no dedicated action. [unverified]

**Ours.**
- Reply: we show a reply header with a `Reply` icon, `@name` and an excerpt that jumps and flashes (`jumpToMessage`, `ChatArea.jsx:722`). Escape cancels the reply. This works.
- Forward: `ForwardMessageModal.jsx` supports multiple destinations. However, the handler in `App.jsx:2699` **re-posts `content`, `attachments` and `sticker_id` as a brand-new message by the forwarder**. There is no forwarded flag, no source reference, no note field and no destination cap.
- Quote: the parser supports it and the formatting toolbar exists.

**Recommendation.**
- **Forward v2 (M, high priority).**
  - Add `forwarded_from: { message_id, channel_id, guild_id, created_at }` to the message and send it with the payload.
  - Render a `ForwardedSnapshot` block (new component, `src/components/ForwardedSnapshot.jsx`): a left border in `d-divider`, a small "↪ Forwarded" label in `text-d-text3`, the original body rendered with our markdown parser, and a footer "#channel • date" that links back when the viewer can read the source.
  - Add an optional note `<textarea>` to the modal, max 2,000 characters. The note is sent as the message content and the snapshot sits below it.
  - Cap destinations at 5 and show a counter, so forwarding cannot become a spam tool.
  - Put a Forward button (`Forward` / `CornerUpRight` icon) in the hover bar, and hide it for messages under safety hold.
  - Accessibility: the label is real text, not only an icon, and the snapshot is a `<blockquote>` with an `aria-label` that says it was forwarded from a channel.
- **Reply polish (S).** Add the curved spine as an SVG `::before` on cozy rows. Add the `@ ON/OFF` mention toggle to the reply bar and pass it through as `allowed_mentions.replied_user`. Let Shift+click on Reply start a reply without a mention. [unverified: Discord shortcut]
- **Quote action (S).** Add "Quote" to `MessageContextMenu.jsx`. It inserts `> ` + the text + `\n` and a mention into the composer, which covers the common case where a reply is too heavy.

## 3. Message hover bar and quick reactions

**Discord.**
- The hover bar in the top-right of a message holds three quick-react emoji taken from the user's frequently used set, then Add Reaction, Reply, Forward, and More.
- Users complain that the three quick reactions are distracting and cannot be customised. [Discord community, 2020+](https://support.discord.com/hc/en-us/community/posts/360056524231-Remove-quick-reactions-in-the-newest-update), [Guiding Tech](https://www.guidingtech.com/how-to-react-to-messages-on-discord/)
- On mobile, "Tap to React" (double-tap) arrived in 2026. [releasebot summary of 2026 patch notes](https://releasebot.io/updates/discord), [jotme, 2026](https://www.jotme.io/blog/discord-update)

**Ours.** The hover bar is in `ChatArea.jsx:1486`. It has `role="toolbar"`, uses `QUICK_EMOJIS.slice(0,3)` (a fixed list: ❤️ 🔥 👍), and includes add reaction, reply, translate, edit, delete and more. It opens on hover, on keyboard focus and on long-press for touch.

**Recommendation (S, high delight).**
- Derive the three quick reactions from a frequency store. We already have `antigravity.recentEmojis`; add counts and decay (for example, score = count × 0.9^days). Fall back to the current list when there is no history.
- Add a setting, "Show quick reactions in the hover bar", so the Discord complaint is solved from day one.
- Add Forward (see §2). Keep delete behind More, or require shift-hover for delete, to reduce misclicks. [unverified: Discord shows delete and pin directly only while Shift is held]
- Keyboard: the toolbar needs roving tabindex (arrow keys move, Tab leaves). Check that this is implemented.
- Mobile: add double-tap to react with the user's top emoji. It needs a 250 ms double-tap window, and must not fire over links or spoilers.

## 4. Super reactions (burst)

**Discord.** Super Reactions launched in 2023 for Nitro. The emoji bursts with an animation over the message, and the reaction pill gets a distinct animated style. Everyone can see them; sending them is limited. [Discord blog](https://discord.com/blog/super-reactions-make-emoji-burst-to-life-discord-nitro), [Reactions & Super Reactions FAQ](https://support.discord.com/hc/en-us/articles/12102061808663-Reactions-and-Super-Reactions-FAQ). The 2026 patch notes still fix bugs in super reactions, so the feature is alive. [releasebot, 2026](https://releasebot.io/updates/discord)

**Ours.** `SuperReaction.jsx` uses 12 CSS particles for 1.1 s with no library. It is suppressed by the `reducedMotion` preference, the OS `prefers-reduced-motion` setting, and `playAnimatedEmoji === false`. It is triggered by shift-click and broadcast over the socket. This is well done.

**Gaps and recommendations (S).**
- Discoverability: shift-click is invisible. Add "Super React" to the reaction picker as a toggle (✨) at the top, as Discord does.
- Give super reaction pills their own look in `ReactionChip` (`ChatArea.jsx:2092`): a gradient ring and a count split between normal and super. Do not rely on colour alone; add a small ✨ glyph and put the split count in the `aria-label`.
- Limits: this is self-hosted, so there is nothing to sell. Rate-limit per user (for example, 5 per minute on the server) to keep channels calm, and do not gate the feature.
- Fallback: with reduced motion, show a static 300 ms outline highlight on the pill instead of particles, so the event is still noticed.

## 5. Emoji and the unified expression picker

**Discord.**
- The expression picker is one popover with GIFs, Stickers and Emoji tabs. [unverified: tab order recalled from product; not in a first-party source retrieved]
- Emoji features: search by name and keywords, Frequently Used, Favorites (Alt+click to favorite), a skin-tone selector next to the search box, one section per server for server emoji, and a hover preview footer showing the large emoji and `:name:`. [Discord Fandom wiki: Emojis](https://discord.fandom.com/wiki/Emojis), [community post on skin tone and frequently used](https://support.discord.com/hc/en-us/community/posts/360052838953-Changing-emoji-skin-tone-intermittently-hides-emoji-from-Frequently-Used-list), [skin tone request, 2024](https://support.discord.com/hc/en-us/community/posts/23409450969239-Changing-Emoji-Skin-Tones)
- No 2025–2026 emoji picker redesign was found in any source. The 2025 desktop refresh reskinned the picker but did not change its structure. [unverified]

**Ours.** `EmojiPicker.jsx` has recents, a This Server section, sections for other servers, 9 unicode categories and search. Its limitations:
- Unicode emoji have **no names**. The code comments that search can only match category labels, so searching "fire" does not find 🔥.
- There are no favorites, no skin tones and no hover preview.
- The tab strip scrolls horizontally instead of using a vertical sidebar, and category tabs switch views instead of scrolling one long list.
- Stickers live in a separate `StickerPicker.jsx` popover, and there are no GIFs.

**Recommendation.**
- **Emoji names and search (M, high value).** Ship a compact name and keyword table generated at build time from `emojibase-data` (compact, English plus our locales). Lazy-load it (`import()`) the first time the picker opens so the main bundle is unaffected. Rank results: exact name, then prefix, then keyword, then custom.
- **Favorites (S).** Alt+click, or a star in the preview footer, toggles a favorite. Store favorites in user settings on the server (they should sync across devices, as Discord's do), not in localStorage.
- **Skin tones (S–M).** Add a hand swatch button next to search with a popover of 6 tones. Apply the tone to emoji that support modifiers (`emojibase` has a `skins` field). Persist in user settings.
- **Preview footer (S).** Show a 40 px emoji, `:name:` and its source server. This is also where you favorite. It helps screen-reader users too: set `aria-describedby` on the grid to point to it.
- **Layout (M).** Use a vertical category rail on the left (server icons, then unicode groups) and one continuous virtualised grid on the right, with an `IntersectionObserver` that syncs the active rail item. Arrow keys move through the grid as `role="grid"` with `aria-activedescendant`; Enter picks; Shift+Enter picks and keeps the picker open (Discord's multi-pick pattern).
- **Unified `ExpressionPicker` (M).** Create `src/components/ExpressionPicker.jsx` with tabs GIFs | Stickers | Emoji (`role="tablist"`) that host `GifPicker`, `StickerPicker` and `EmojiPicker` as panels. Remember the last tab per context (composer versus reaction). Reactions open straight into Emoji with no tabs.
- **Motion.** The current `hover:scale-110` on grid cells is fine. Wrap it in `motion-safe:` so the global kill switch is not the only guard.

## 6. Stickers (APNG and Lottie)

**Discord.** Stickers are PNG, APNG or Lottie JSON at 320×320 and at most 512 KB. Lottie is used for Discord's own packs; Lottie upload for servers has been reported as gated. [Emote Resizer, 2026](https://emoteresizer.net/blog/discord-sticker-size), [AllImgTools, 2026](https://allimgtools.app/blog/discord-sticker-size-guide-2026) (third-party guides, [unverified] on gating). Sticker animation is set in Accessibility: Always, On interaction, or Never. [unverified]

**Ours.** Rendering uses `StillImage` and respects `a11yPrefs.stickerAnimation` (always, interaction, never), which is good. The picker is a flat 3-column grid with a filter; there are no pack headers and no recents.

**Recommendation (S–M).**
- Group the picker by server pack with a header, and add a "Recent" row at the top.
- Suggest stickers while typing: when the composer text exactly matches a sticker tag, show a small strip above the composer. [unverified: Discord calls these sticker suggestions]
- Skip Lottie. APNG covers self-hosted needs; Lottie means shipping `lottie-web` (~250 KB) for little gain. If it is ever added, load it lazily and render the first frame as static when motion is reduced.

## 7. GIF picker (Tenor to Klipy/GIPHY)

**Discord.**
- Google announced that the Tenor API would be decommissioned on 2026-06-30. Discord tested GIPHY against Klipy (2026-01), and users reported the picker switching to "Search Klipy" by mid-2026. Favorited GIFs survive because Discord stores them. [PiunikaWeb, 2026-01-14](https://piunikaweb.com/2026/01/14/discord-gif-search-change-tenor-api-shutdown/), [PCGamesN](https://www.pcgamesn.com/discord/not-losing-gifs), [@DiscordPreviews on X, 2026-01](https://x.com/DiscordPreviews/status/2011310131796197546), [user report on X, 2026](https://x.com/Jolo_AITSF/status/2071913156255834325)
- UX: an initial view of trending category tiles (reaction words), then a masonry grid of results, a star to favorite on hover, and a Favorites tab. GIFs autoplay according to the Accessibility setting. [unverified: layout from product memory]

**Ours.** Nothing. The only mentions of Klipy are unrelated translation strings.

**Recommendation (M–L, high delight).**
- Server: add `GET /api/gifs/search?q=` and `/api/gifs/trending` that proxy to a configurable provider (`GIF_PROVIDER=klipy|giphy|none`, API key in env). Never call the provider from the client: that leaks users' IPs to a third party and exposes the key. Cache for 10 minutes. When no key is set, hide the GIFs tab entirely.
- Store favorites in our own database as `{url, preview_url, width, height}`, so they are independent of the provider, as Discord's are.
- Client: create `src/components/GifPicker.jsx` with a 2-column masonry grid, lazy `<video>` previews (MP4 or WebM are much lighter than GIF), a favorite star on hover or focus, and search debounced at 300 ms.
- Sending: post the GIF URL as a message and let `LinkEmbed` render it, or post it as an embed of type `gifv`.
- Reduced motion or `autoplayGifs=false`: show the static preview frame and play on hover or focus. Every tile gets `aria-label` from the provider's title.

## 8. Soundboard and voice effects

**Discord.**
- The soundboard launched in 2023. It is a grid of sounds per server with emoji and a name. Nitro users can use sounds across servers, and uploads are limited by boost slots. [Discord blog: Soundboard](https://discord.com/blog/ready-your-airhorns-discord-soundboard-is-coming), [Soundboard guide](https://support.discord.com/hc/en-us/articles/12612888127767-Discord-Soundboard-Guide-Using-Adding-and-Managing-Sounds)
- Other known soundboard details: favorites, hover-to-preview locally, a per-user soundboard volume slider, and entrance sounds. [unverified: from product memory]
- Voice Filters (a voice changer with about 15 effects, some rotating free and some for Nitro) started limited testing on Windows in early 2025. [Discord Help: Voice Filters](https://support.discord.com/hc/en-us/articles/30152512891543-How-to-Use-Voice-Filters-on-Discord), [TechIssuesToday, 2025](https://techissuestoday.com/discord-releases-new-voice-filters-feature-to-select-users/)

**Ours.** `SoundboardPanel.jsx` broadcasts `play_sound` and every client plays it locally. That gives better fidelity than mixing into the mic, which is a good call. It has a 1.5 s client cooldown and a 3-column grid, but no preview, no favorites, no volume control and no search.

**Recommendation (S–M).**
- Add a preview button (▶) on each tile, visible on hover or focus, that plays locally only. Favorites go at the top, and search appears when there are more than 12 sounds.
- Add a soundboard volume slider in Voice settings (0–100%) with a "Mute soundboard for me" toggle. This is an accessibility need: sudden loud audio is a real problem for some users.
- Show visual feedback when someone plays a sound: a small emoji chip floats above that user's tile in `VoiceRoom` for 2 s, with a static badge under reduced motion. Announce it through the existing screen-reader live region only if the user opted into speaking announcements.
- Make the cooldown ring visible (a conic-gradient sweep). The current behaviour just dims everything at `opacity-40`.
- Voice filters: **skip**. They need DSP in the audio pipeline (AudioWorklet) and the delight-to-effort ratio is poor. Revisit if LiveKit adds a simple processor hook.

## 9. Voice messages

**Discord.** Voice messages launched on mobile on 2023-04-14. You hold the mic to record and swipe up to lock. They can be up to 20 minutes long, and all platforms can play them. The player is a play button, a waveform and a duration. [Discord blog](https://discord.com/blog/discord-voice-messages), [PC Gamer, 2023](https://www.pcgamer.com/discord-has-finally-added-voice-messages/). Playback speed control is available. [unverified]

**Ours.** `VoiceNote.jsx` has a recorder plus a player with a scrubbable waveform driven by `timeupdate`. This is strong parity.

**Recommendation (S).**
- Add a playback speed chip (1×, 1.5×, 2×) remembered per user.
- Add keyboard seeking on the waveform: `role="slider"` with `aria-valuenow` in seconds, and Left and Right arrow keys seek by 5 s.
- Only one note should play at a time: pause others when a new one starts, using a small module-level "current player" ref.
- Transcripts are a stretch goal (see §17).

## 10. Polls

**Discord.** Polls launched on 2024-03-21 and reached every server by 2024-04-08. They allow up to 10 answers with optional emoji, durations from 1 hour to 7 days, single or multiple choice, a "Show results" option for people who have not voted, live updates, and a check mark on your own choice. [Android Police, 2024](https://www.androidpolice.com/discord-polls-launch/), [Polls FAQ](https://support.discord.com/hc/en-us/articles/22163184112407-Polls-FAQ). When a poll ends, a system message announces the winner. [unverified]

**Ours.** `PollCard.jsx` always shows the tally, uses optimistic votes, `aria-pressed` toggles, voter lists and a time-left label. `CreatePollModal.jsx` creates polls.

**Recommendation (S).**
- Consider **hiding the tally until the viewer votes or taps "Show results"**. This matches Discord and reduces bandwagon voting. Make it a per-poll creator option ("Hide results until vote"), not a global change.
- When the poll closes, post a system line such as "Poll ended: *Pizza* won with 62%", with a jump link.
- Animate bar widths with `transition-[width] duration-300 motion-reduce:transition-none`.

## 11. Message components and Components V2

**Discord.** Components V2 (2025) lets bots compose whole messages from Container (an accent-coloured border), Section (text plus a thumbnail or button accessory), TextDisplay, MediaGallery (1–10 items with descriptions and spoilers), Separator and File. A V2 message cannot also carry `content` or embeds. [discord.py writeup, 2025-08-17](https://about.abstractumbra.dev/discord.py/2025/08/17/components-v2.html), [Discord component reference](https://docs.discord.com/developers/components/reference), [discord.js guide](https://discordjs.guide/legacy/popular-topics/display-components)

**Ours.** `RichEmbed.jsx` renders rich embeds plus `MessageComponents` (buttons and a string select). There are no V2 layout components.

**Recommendation (M, medium delight; high for bot authors).**
- Add a `ComponentsV2` renderer (`src/components/ComponentsV2.jsx`) that switches on `type`. Reuse the §12 mosaic for MediaGallery and render Separator as `<hr>` with spacing variants.
- Keep interactive components keyboard-first: buttons are real `<button>`s, and selects use a listbox pattern with `aria-expanded`.
- Enforce the same limits server-side (40 components, nesting depth) so a malicious webhook cannot render a huge message.

## 12. Media mosaic (multiple images)

**Discord.** Up to 10 attachments render as a **mosaic**: 1 image is large; 2 are side by side; 3 are one large plus two stacked; 4 form a 2×2 grid; more continue in rows of 3. Tapping any tile opens a gallery lightbox you can swipe through. Patch notes in 2025 repeatedly reference the "media mosaic" and the 10-image limit. [Discord Patch Notes 2025-04-03](https://discord.com/blog/discord-patch-notes-april-3-2025), [Patch Notes 2025-10-06](https://discord.com/blog/discord-patch-notes-october-6-2025) (from search snippets). The exact per-count layout is [unverified].

**Ours.** Attachments render in `mt-2 flex flex-wrap gap-2` (`ChatArea.jsx:1432`), each at its own size. `ImageLightboxModal.jsx` opens one image at a time.

**Recommendation (M, high delight).**
- Create `src/components/MediaMosaic.jsx`: a CSS grid with `max-width: 550px`, `gap: 4px`, rounded outer corners only, and a `grid-template` for each count from 1 to 10. Tiles use `object-fit: cover`. Include video and GIF tiles with a ▶ badge.
- Non-media files (documents, voice notes) stay in a list below the mosaic.
- Reserve space from `width` and `height` in attachment metadata (`aspect-ratio`) to avoid layout shift. This matters for the scroll anchoring the unread jump depends on.
- Make the lightbox a gallery: left and right arrows, a counter "3 / 7", swipe on touch, Escape to close, and focus returns to the tile.
- Spoilers apply per tile (blurred until clicked), and alt text shows as a caption in the lightbox.

## 13. Spoilers and link embeds

**Discord.** Text spoilers use `||`. Attachment spoilers are blurred behind a "SPOILER" pill. Link embeds show a coloured side bar, the site name, the title, the description and a thumbnail, and YouTube and similar links play inline. The `<url>` syntax suppresses an embed, and the author can remove it with an × on hover. [unverified: long-standing behaviour]

**Ours.** Spoilers work, with a `renderSpoilers` mode (click, owned, always) and a `safetyHold` blur for media from strangers. `LinkEmbed` is gated by `showLinkPreviews`.

**Recommendation (S).**
- Add a "Remove embeds" × on hover for the author, and honour `<url>` suppression in the parser if it is not already honoured.
- Reveal a spoiler with a 150 ms blur-to-clear transition, instant under reduced motion. The revealed spoiler needs `aria-expanded`.

## 14. Message requests

**Discord.** DMs from non-friends go to a separate "Message Requests" inbox. You accept (✓) or ignore, and nothing reaches your main list until you accept. This is on by default for teens. Discord also added a way to "Ignore" a user quietly (2025-02). [Discord Help: Message Requests](https://support.discord.com/hc/en-us/articles/7924992471191-Message-Requests), [AlternativeTo, 2025-02](https://alternativeto.net/news/2025/2/discord-introduces-a-feature-that-lets-you-quietly-ignore-users-without-them-knowing)

**Ours.** There is no requests inbox. We do have `safetyHold` media blurring for strangers, which is a partial answer.

**Recommendation (M, high trust value).**
- Add `dm_channels.request_state` (`pending`, `accepted`, `ignored`) on the server. Add a "Message Requests (n)" row at the top of `HomeDirectMessages.jsx`.
- The request view shows a read-only preview with Accept, Ignore and Report actions. The sender gets no read receipts and no typing indicator.
- Add a setting in the Privacy tab.

## 15. Slash commands, the Apps menu and the App Launcher

**Discord.**
- Typing `/` opens the command picker. It has a Frequently Used section at the top and an app icon rail, commands are alphabetised within each app, and options autocomplete (users, roles, channels, dynamic values). [Discord blog: New era of apps](https://discord.com/blog/welcome-to-the-new-era-of-discord-apps), [Slash Commands FAQ](https://support-apps.discord.com/hc/en-us/articles/26501837786775-Slash-Commands-FAQ)
- 2024 brought user-installable apps and an **App Launcher** button next to the chat bar with Recents, collections and search. It launches activities from text channels. [Using Apps on Discord](https://support.discord.com/hc/en-us/articles/21334461140375-Using-Apps-on-Discord), [AlternativeTo, 2024-05](https://alternativeto.net/news/2024/5/discord-can-now-initiate-an-activity-whithin-text-channels-and-ask-everyone-with-polls). Users disliked that the new buttons could not be removed. [Technology.org, 2024-08-21](https://www.technology.org/2024/08/21/users-are-outraged-by-the-new-discord-buttons-there-is-no-way-to-get-rid-of-them/)

**Ours.** `ComposerAutocomplete.jsx` handles `/` with built-in and bot commands through `matchCommands`. There is no frequently-used section, no app rail and no option-level chips.

**Recommendation (S–M).**
- Order the `/` picker as: frequently used (localStorage counts are fine because this is a convenience), then built-ins, then one group per bot with its avatar as the group header.
- Once a command is chosen, render its options as inline chips in the composer (`name: [value]`), and Tab moves to the next option. This is Discord's key slash-command affordance. [unverified: chip rendering]
- Put the App Launcher behind the existing `PlusCircle` menu, not as a new permanent button, given the 2024 backlash.
- Activities (embedded iframes): **skip for now** (L effort; sandboxing and security cost).

## 16. Mentions, unread bar, jump to present, typing indicator

**Discord.** Messages that mention you get a gold left bar and a tinted background. A red "NEW" divider marks unread messages, and a top banner reads "X new messages since …" with Mark as Read. A "Jump to Present" pill appears when you have scrolled up. The typing indicator is three dots in a soft wave next to "X is typing…", and with several people it becomes "Several people are typing…". [unverified: long-standing behaviour]

**Ours.** All four exist: `mentionsMe` highlighting, the unread bar with `role="status"`, the `data-first-unread` divider, the jump-to-present pill (`ChatArea.jsx:1580`) and a typing gutter with a `formatTypingText` helper.

**Recommendation (S).**
- Typing dots: replace `animate-bounce` (large vertical travel) with a 1.2 s opacity and 2 px translate wave, which is closer to Discord and calmer. Under reduced motion, show static dots at 60% opacity. Add `aria-live="polite"` on the text, throttled so it announces at most once every 10 s per channel.
- Jump to present: show the unread count on the pill ("12 new ↓") when messages arrive while you are scrolled up. Keyboard: Shift+PageDown or Escape. [unverified: Discord binds Esc to mark-as-read and Shift+PageDown to jump]
- Mention highlight: check that the gold bar has at least 3:1 contrast in the Light theme. Also add a visually hidden "Mentions you" prefix so the highlight is not conveyed by colour alone.

## 17. Conversation Summaries (AI)

**Discord.** Announced in March 2023. It clustered recent channel messages into topics with a title, a snippet and participants, opened from a Summaries button in the channel header. Admins toggled it per channel. It was a beta and has since faded. [TechCrunch, 2023-03-09](https://techcrunch.com/2023/03/09/discord-updates-its-bot-with-chatgpt-like-features-rolls-out-ai-generated-conversation-summaries-and-more), [In-Channel Conversation Summaries](https://support.discord.com/hc/en-us/articles/12926016807575-In-Channel-Conversation-Summaries), [Fandom](https://discord.fandom.com/wiki/Summaries_AI). Current availability is [unverified]; it appears no longer to ship broadly.

**Ours.** None.

**Recommendation (L, optional).** For a self-hosted product, make this opt-in per server with an admin-configured LLM endpoint.
- UI: a "Catch up" chip inside the existing unread bar ("48 new since 3:42 PM · ✨ Catch up"). It opens a side panel of topic cards with "jump to" links.
- Label every card as AI-generated, with a "Report inaccurate" option.
- Never summarise channels the viewer cannot read, and never send DMs.

## 18. Threads, forum and media channels

**Discord.**
- Forums launched in 2022 with List and Gallery views, tags, a post guidelines banner and sort or filter options. [TechCrunch, 2022-09-14](https://techcrunch.com/2022/09/14/discord-forum-channels), [Forum FAQ](https://support.discord.com/hc/en-us/articles/6208479917079-Forum-Channels-FAQ)
- Media channels (2023) are gallery-first grids for posts led by images. [Musically, 2023-06-21](https://musically.com/2023/06/21/discord-adds-media-channels-and-tests-server-shop-feature/)
- Threads open in a side panel (split view) with a "N messages ›" thread chip under the parent message. [unverified]

**Ours.** `ForumView.jsx` (959 lines) has list and gallery modes (`LayoutGrid`), tags, moderated tags, pins and sorting. The `media` channel type exists in `CreateChannelModal`. Threads open as a channel, reached through the parent crumb.

**Recommendation (M).**
- Open threads in a side panel on wide screens (≥1280 px), keeping the parent channel visible. On narrow screens, keep full-screen navigation.
- Forum gallery cards: use `aspect-ratio: 4/3` with `object-fit: contain` on a blurred backdrop of the same image. This addresses the top Discord complaint that gallery view crops art. [community post](https://support.discord.com/hc/en-us/community/posts/12161216374807-Gallery-View-in-Forum-Channels-should-inset-images-inside-a-buffer-frame-instead-of-cropping-them)
- Check that media channels reuse `ForumView` in gallery mode by default and hide the text-only composer path.

## 19. Voice-side chat surfaces

### 19a. Text-in-voice
**Discord.** Launched 2022-06 (everywhere by 2022-06-29). Each voice channel has a chat bubble icon, and new-message previews pop up while you are in the call. [TechCrunch, 2022-06-01](https://techcrunch.com/2022/06/01/discord-text-chat-for-voice-channels/)
**Ours.** We have it: `App.jsx:2154` reuses `ChatArea` with `hideHeader`.
**Recommendation (S).** Add an unread badge on the call view's chat toggle, and a toast-style preview of the newest message (3 s, with a static fade under reduced motion).

### 19b. Stage
**Discord.** Speakers and audience, raise hand, and later video, screen share and text chat. [Stage FAQ](https://support.discord.com/hc/en-us/articles/1500005513722-Stage-Channels-FAQ), [Discord blog](https://discord.com/blog/introducing-video-screen-share-text-chat-support-for-stage-channels)
**Ours.** We have it (`VoiceRoom.jsx` `isStage`, suppressed audience, `stage_speaker_changed`).
**Recommendation.** No major work. Add a raise-hand queue sorted by time for moderators.

### 19c. Voice channel status and Hang Status
**Discord.**
- Voice channel status (a beta in 2023) is a short line under the voice channel name, set by members in the channel. [Discord community, 2023](https://support.discord.com/hc/en-us/community/posts/16262860634647-Voice-Channel-Status-Permissions-Beta-Feature), [API docs PR #6398](https://github.com/discord/discord-api-docs/pull/6398). Its visibility later regressed. [community, 2023-12](https://support.discord.com/hc/en-us/community/posts/20160170737047-Channel-Status)
- Hang Status offered 7 presets such as "Chilling" or "Gaming", or a custom value, shown under the member's name while they were in voice. It was **disabled by 2024-08**. [whop](https://whop.com/blog/discord-hang-status/), [community post](https://support.discord.com/hc/en-us/community/posts/20132038290199--Hang-Status-experimental-feature)
- The 2026 patch notes include seeing who is in a voice channel before joining. [jotme summary, 2026](https://www.jotme.io/blog/discord-update)

**Ours.** There is no channel status. The sidebar already lists voice participants (`ChannelSidebar.jsx:355`).
**Recommendation (S).**
- Implement **voice channel status** (one line of at most 100 characters, with emoji, under the channel name in the sidebar), gated by a `SET_VOICE_CHANNEL_STATUS` permission. The community asked for that permission specifically.
- **Skip Hang Status.** Discord removed it, and the one complaint on record is about an unwanted default value.

### 19d. Go Live, screen share and PiP
**Discord.** Stream previews appear in the voice channel; you click to watch, and you can pop the call out into PiP. Quality tiers are gated by Nitro. [Go Live and Screen Share](https://support.discord.com/hc/en-us/articles/360040816151-Go-Live-and-Screen-Share), [Voice, Video & Streaming Guide](https://support.discord.com/hc/en-us/articles/33030151293079-Discord-Voice-Video-Streaming-Guide)
**Ours.** We have screen share (`getDisplayMedia`), a stage-pinned tile and Document PiP (`voice/pip.js`, `PictureInPicture2`).
**Recommendation (S).** Add a "LIVE" red badge next to the streaming user in the sidebar voice list, and a hover thumbnail of the stream (a low-rate snapshot every 5 s) so people can see what is being shared before they join.

### 19e. Clips
**Discord.** Clips entered beta in 2023-08. A hotkey saves the last 30 s, 60 s or 2 min of your stream locally (Windows, Nitro early access). [Discord Help: Clips](https://support.discord.com/hc/en-us/articles/16861982215703-Clips), [Shacknews](https://www.shacknews.com/article/147003/how-to-use-discord-clips)
**Ours.** None. The "clips" strings in the code refer to soundboard clips.
**Recommendation (L, low priority).** A browser-side `MediaRecorder` ring buffer of the viewer's own received stream is possible, but memory-heavy and has consent implications. Defer it.

---

## 20. Prioritised backlog (delight × effort)

Effort: S is 1 day or less, M is 2–5 days, L is more than a week. Delight is 1–5.

| # | Item | Files | Delight | Effort | Notes |
|---|------|-------|---------|--------|-------|
| 1 | **Forward v2**: label, source link, note, cap of 5 | `ForwardMessageModal.jsx`, new `ForwardedSnapshot.jsx`, `App.jsx`, server | 4 | M | Fixes misattribution; also a correctness fix |
| 2 | **Frequency-based quick reactions** plus a hide option | `ChatArea.jsx` (`QUICK_EMOJIS`), `EmojiPicker.jsx` recents store | 4 | S | Solves Discord's top complaint in one go |
| 3 | **Media mosaic** plus gallery lightbox | new `MediaMosaic.jsx`, `ImageLightboxModal.jsx` | 5 | M | Also reused by Components V2 MediaGallery |
| 4 | **Emoji names and search**, favorites, skin tones, preview footer | `EmojiPicker.jsx`, lazy `emojibase` data, user settings | 5 | M | Search not finding 🔥 is the most visible picker bug |
| 5 | Super reaction discoverability: ✨ toggle in picker, distinct pill | `EmojiPicker.jsx`, `ReactionChip` | 4 | S | Motion fallback: static ring |
| 6 | Typing dots calmer, polite live region | `ChatArea.jsx:1900` | 3 | S | |
| 7 | **GIF picker** via server proxy (Klipy/GIPHY), favorites in our DB | new `GifPicker.jsx`, `/api/gifs/*` | 5 | M–L | Tenor is dead after 2026-06-30 |
| 8 | Unified **ExpressionPicker** (GIFs, Stickers, Emoji tabs) | new `ExpressionPicker.jsx` | 4 | M | Needs 4 and 7 first |
| 9 | Soundboard: preview, favorites, per-user volume and mute, cooldown ring | `SoundboardPanel.jsx`, `VoiceSettings.jsx` | 4 | S–M | Volume control is also accessibility |
| 10 | Voice channel status | `ChannelSidebar.jsx`, server permission | 3 | S | |
| 11 | Voice note speed control and keyboard slider | `VoiceNote.jsx` | 3 | S | |
| 12 | Reply spine, @ON toggle, Quote action | `ChatArea.jsx`, `MessageContextMenu.jsx` | 3 | S | |
| 13 | Message requests inbox | `HomeDirectMessages.jsx`, server | 3 (trust 5) | M | Safety value is higher than delight |
| 14 | `/` picker: frequently used, per-app groups, option chips | `ComposerAutocomplete.jsx` | 3 | M | |
| 15 | Poll "hide results until vote" and closing system message | `PollCard.jsx`, `CreatePollModal.jsx` | 3 | S | |
| 16 | Thread side panel on wide screens | `App.jsx`, `ChatArea.jsx` | 4 | M | |
| 17 | Components V2 renderer | new `ComponentsV2.jsx` | 2 (bots 4) | M | |
| 18 | Stickers: packs and recents, tag suggestions | `StickerPicker.jsx` | 3 | S–M | |
| 19 | LIVE badge and stream hover preview | `ChannelSidebar.jsx`, `VoiceRoom.jsx` | 3 | S–M | |
| 20 | AI "Catch up" summaries (opt-in, self-hosted LLM) | new panel | 3 | L | Optional |
| — | Skip: Hang Status (removed by Discord), voice filters, Lottie, Clips, Activities | | | | |

**Suggested sequencing.** Sprint A: items 1, 2, 5, 6, 12. Sprint B: items 3 and 4. Sprint C: items 7 and 8. Then items 9, 10, 11 and 15 as fillers.

## 21. Cross-cutting motion and accessibility rules

- **One motion gate.** Every new animation checks `motionAllowed()` from `SuperReaction.jsx` in JS, or uses Tailwind's `motion-safe:`/`motion-reduce:` in CSS. The global `:root[data-reduced-motion="true"]` block in `index.css:193` is the backstop, not the design.
- **Replacing motion when it is reduced.** Swap motion for a static state change (outline, badge, opacity), never for nothing. The event must still be perceivable.
- **Durations.** Micro-interactions take 120–200 ms, bursts at most 1.2 s, and nothing loops forever except the typing indicator, which stops when typing stops.
- **Pickers.** Use `role="grid"` or `role="listbox"` with `aria-activedescendant`, keep focus in the search box while arrow keys move the selection (Discord's pattern), and have Escape return focus to the trigger.
- **Autoplay.** GIFs, stickers and animated emoji respect `autoplayGifs`, `stickerAnimation` and `playAnimatedEmoji` independently, as today.
- **Colour.** Mention highlight, super-reaction pills, the LIVE badge and poll leaders each carry a non-colour cue (glyph, text or pattern).

---

## สรุปภาษาไทย

**ภาพรวม:** แอปของเรามีฟีเจอร์แชตแบบ Discord ครบกว่าโคลนทั่วไปมาก มีทั้งแถบ "ข้อความใหม่ตั้งแต่…" ปุ่ม Jump to Present แถบปุ่มตอนชี้เมาส์ที่มี Quick Reactions, Super Reactions (Shift+คลิก) ที่ปิดแอนิเมชันเองเมื่อผู้ใช้ตั้ง Reduced Motion, โพลที่นับคะแนนสด, ข้อความเสียงที่มีเวฟฟอร์มเลื่อนได้, สติกเกอร์, Rich Embed พร้อมปุ่ม/เมนูเลือก, สปอยเลอร์, Forum แบบ List/Gallery, Soundboard, Stage, แชตในห้องเสียง และ PiP

**ช่องว่างสำคัญ (เรียงตามความคุ้มค่า):**
1. **การส่งต่อข้อความ (Forward) ยังเป็นการคัดลอกเงียบ ๆ** ระบบโพสต์ซ้ำในชื่อผู้ส่งต่อ ไม่มีป้าย "Forwarded" ไม่มีลิงก์ต้นทาง และใส่โน้ตไม่ได้ ซึ่งทำให้ข้อความดูเหมือนเป็นคำพูดของผู้ส่งต่อ ควรแก้ก่อน (M)
2. **Quick Reactions ถูกกำหนดตายตัว** ควรเลือกจากอีโมจิที่ผู้ใช้ใช้บ่อย และมีตัวเลือกให้ซ่อนได้ (S)
3. **รูปหลายรูปยังเรียงแบบ flex-wrap** ควรทำ Media Mosaic (1/2/3/4+ รูป) และ Lightbox ที่เลื่อนดูได้ทั้งชุด (M)
4. **Emoji Picker ค้นหาอีโมจิ Unicode ด้วยชื่อไม่ได้** (พิมพ์ "fire" ไม่เจอ 🔥) และยังไม่มี Favorites, Skin Tone หรือช่องพรีวิว (M)
5. **ยังไม่มี GIF Picker** Tenor API ปิดวันที่ 30 มิ.ย. 2026 และ Discord ย้ายไปใช้ Klipy แล้ว เราควรทำผ่านพร็อกซีฝั่งเซิร์ฟเวอร์ (ไม่เปิด IP ผู้ใช้หรือ API key ให้บุคคลภายนอก) และเก็บ Favorites ในฐานข้อมูลของเราเอง (M–L)
6. รวมเป็น **Expression Picker** เดียวที่มีแท็บ GIF / สติกเกอร์ / อีโมจิ
7. อื่น ๆ: Soundboard (พรีวิว, รายการโปรด, ปรับเสียงแยก), สถานะห้องเสียง, ปรับความเร็ว Voice Note, กล่อง Message Requests, ปรับเมนู `/` ให้แสดงคำสั่งที่ใช้บ่อย และเปิดเธรดเป็นแผงข้าง

**ไม่แนะนำให้ทำตอนนี้:** Hang Status (Discord ถอดออกแล้วตั้งแต่ ส.ค. 2024), Voice Filters, สติกเกอร์ Lottie, Clips และ Activities เพราะต้องใช้แรงมากเมื่อเทียบกับความสนุกที่ผู้ใช้จะได้

**หลักการด้านแอนิเมชันและการเข้าถึง:** ทุกแอนิเมชันต้องผ่าน `motionAllowed()` หรือ `motion-safe:` และเมื่อลดการเคลื่อนไหว ต้องมีสิ่งบอกสถานะแบบนิ่งมาแทน (เส้นขอบ, ป้าย, ความโปร่งใส) ไม่ใช่ตัดทิ้งไปเฉย ๆ Picker ทุกตัวต้องใช้คีย์บอร์ดได้ (grid/listbox + aria-activedescendant) และสิ่งที่สื่อด้วยสีต้องมีสัญลักษณ์หรือข้อความประกอบเสมอ

**ลำดับที่แนะนำ:** Sprint A: Forward v2, Quick Reactions ตามการใช้งาน, Super Reaction ที่ค้นพบง่ายขึ้น, จุดพิมพ์ที่นุ่มนวลขึ้น, Reply/Quote. Sprint B: Media Mosaic และ Emoji Picker ใหม่. Sprint C: GIF Picker และ Expression Picker
