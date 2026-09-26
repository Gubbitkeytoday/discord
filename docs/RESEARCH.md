# Research: what real chat platforms do, and what it means here

Research date: 2026-09-26. Sources are linked inline. Some primary pages (Hacker
News, Wikipedia, some blogs) could not be fetched from the research environment,
so a few findings rest on search-result summaries of those pages; they are
marked *(summary)*. Treat vendor benchmark numbers as indicative, not measured.

Companion document: [ROADMAP.md](ROADMAP.md).

---

## 0. Where this project stands (baseline for the comparison)

Read from README.md, DEPLOYMENT.md, `server.js`, `realtime.js`, `lib/`,
`services/`, `src/` on the merged `claude/dreamy-goldberg-p3o5ao` base.

| Area | State in code |
| --- | --- |
| Runtime | One Node process: Express REST + Socket.IO gateway + static SPA. SQLite (WAL). In-memory rate-limit buckets (`lib/rateLimit.js`), in-memory Socket.IO rooms/presence. |
| Text | Markdown, replies, edits w/ history, pins, reactions, super reactions, forwarding, polls, threads, forums, media channels, stickers, custom emoji, link previews w/ SSRF guard. |
| Search | SQLite FTS5 `trigram` tokenizer (substring search works for Thai) + `from:`/`has:`/`before:` operators. |
| Voice/video | WebRTC **full mesh**, capped by `VOICE_MESH_LIMIT=8`. `/api/voice/ice-servers` now mints coturn REST credentials (`server.js` ~L1488); compose has a `turn` profile. No SFU, no E2EE. |
| Moderation | AutoMod (keyword/regex/link/mention/spam; block/alert/timeout), bans, timeouts, reports (server-scoped queue in ServerSettingsModal; instance-level only via `x-admin-token` API), audit log, raid protection, verification levels. |
| Accounts | scrypt, hashed session tokens, TOTP + backup codes, email verification (optional; enforced only via server verification level), data export + anonymising deletion (`services/dataRights.js`). |
| Ops | CSP + HSTS + COOP headers (`lib/middleware.js`), JSON logs w/ request id, hand-rolled Prometheus `/metrics`, `/api/health` + `/api/ready`, graceful shutdown, backup/restore/prune scripts, S3 option, sharp-based image variants (optional dep). |
| Client | React 19 SPA, `App.jsx` ~2.5k lines, `ChatArea.jsx` ~1.8k lines, no route/code splitting (Vite warns main chunk > 500 kB), no message-list virtualization, no service worker / manifest, EN + TH i18n. On socket reconnect the client re-identifies and rejoins rooms, but there is no evidence of a gap-fill of messages missed while disconnected. |
| Missing entirely | Push notifications, PWA install, native apps, instance-admin UI, captcha, SFU, E2EE, OAuth2, multi-node. |

---

## 1. Discord (2025–2026)

**DAVE end-to-end encryption.** Discord finished migrating *every* voice and
video call (DMs, group calls, voice channels, Go Live) to its DAVE E2EE
protocol in March 2026; stage channels are excluded "due to their architecture".
DAVE is open source, audited by Trail of Bits, and built on MLS for group keys +
WebRTC encoded transforms (insertable streams) for frame encryption. No plans for
text E2EE.
[Discord blog](https://discord.com/blog/every-voice-and-video-call-on-discord-is-now-end-to-end-encrypted) ·
[support article](https://support.discord.com/hc/en-us/articles/25968222946071-End-to-End-Encryption-for-Audio-and-Video) ·
[BleepingComputer](https://www.bleepingcomputer.com/news/security/discord-rolls-out-end-to-end-encryption-on-voice-video-calls/)

*Implication:* E2EE media in Discord requires an SFU that forwards opaque
frames plus MLS key management. For a mesh deployment, media is already
DTLS-SRTP peer-to-peer (no server sees it). E2EE only matters here once an SFU
exists, and then LiveKit's built-in E2EE is the realistic path.

**Age assurance / "teen by default".** Announced 2026-02-09 for global rollout
(face estimation or government ID), partly postponed to H2 2026 after backlash;
a 2025 vendor breach exposed ~70k ID photos. Searches for "Discord alternatives"
spiked and Stoat was overwhelmed.
[Comparison gist (Feb 2026)](https://gist.github.com/SturmB/0c75dfbf61b9416370310dcc4b065733) ·
[TechBuzz](https://www.techbuzz.ai/articles/discord-s-age-verification-sparks-privacy-exodus) ·
[WebProNews](https://www.webpronews.com/the-great-discord-exodus-age-verification-backlash-sends-gamers-scrambling-to-alternatives-that-cant-keep-up/)

*Implication:* the demand spike is real and privacy-motivated. It also means a
self-hosted operator inherits the child-safety duties Discord was trying to
discharge (see §7).

**Activities / Embedded App SDK.** Iframe apps with an RPC bridge, launched in
voice/text channels and DMs; open to all developers.
[Embedded App SDK docs](https://docs.discord.com/developers/developer-tools/embedded-app-sdk) ·
[GitHub](https://github.com/discord/embedded-app-sdk)

**Recent product changes.** Channel pinning to all servers, `@silent` forwards,
tap-to-react on mobile, faster uploads, React Native Fabric on iOS (~20% faster
start), system-wide echo cancellation on Windows, game commerce and Orbs.
[Discord update Sep 25 2026](https://discord.com/blog/discord-update-september-25-2026) ·
[Jotme summary](https://www.jotme.io/blog/discord-update) *(summary)*

**AutoMod.** Discord-maintained keyword presets (slurs, severe profanity, sexual
content, with obfuscation handling), custom keywords/regex with allow-lists,
mention-spam limit, spam detection, and "Block Words in Member Profile Names".
[AutoMod FAQ](https://support.discord.com/hc/en-us/articles/4421269296535-AutoMod-FAQ) ·
[setup guide](https://valt.gg/blog/discord-automod-setup-guide/)

*Gap here:* no presets, no profile-name scanning.

**Permissions.** New bits keep being split out: `PIN_MESSAGES` (1<<51) split
from `MANAGE_MESSAGES` (enforced 2026-02-23), `BYPASS_SLOWMODE` (1<<52),
`CREATE_EVENTS` for bots, `SEND_POLLS`, `USE_EXTERNAL_APPS`.
[discord-api-docs PR #8002](https://github.com/discord/discord-api-docs/pull/8002/files)

*Gap here:* 36 flags implemented; none of the 2025–26 splits.

**Gateway & rate limits (developer docs).** Gateway sessions are *resumable*:
client sends `session_id` + last sequence `s`; the server replays missed
dispatches, then `RESUMED`. REST has a 50 req/s global limit plus per-route
buckets identified by `X-RateLimit-Bucket`; `X-RateLimit-Global` on global 429s.
[Gateway docs](https://docs.discord.com/developers/events/gateway) ·
[Rate limits](https://github.com/discord/discord-api-docs/blob/main/developers/topics/rate-limits.mdx)

*Implication:* the single most copied reliability idea is "every realtime event
has a sequence; reconnect replays or tells you to resync". Socket.IO offers the
same via Connection State Recovery (§4).

**Trust & safety process.** Warning System (users see what rule they broke and
their account standing), formal appeals, DSA statements of reasons and
transparency reports.
[Warning System](https://support.discord.com/hc/en-us/articles/18210965981847-Discord-Warning-System) ·
[DSA architecture blog](https://discord.com/blog/evolving-our-safety-architecture-for-the-digital-services-act)

---

## 2. Open-source and alternative platforms

| Platform | Does well | Does badly / lesson |
| --- | --- | --- |
| **Stoat (ex-Revolt)** | Closest Discord UX; servers/roles/bots; self-hostable ([GitHub](https://github.com/stoatchat/self-hosted)). Rebranded Oct 2025 after a trademark C&D ([AlternativeTo](https://alternativeto.net/news/2025/10/chat-app-revolt-rebrands-to-stoat-keeps-all-services-features-and-core-values-unchanged)). Moved voice to **LiveKit** in 2025. | Feb 2026 influx "acted like a DDoS"; they hit an architectural limit and **turned off typing indicators and profile updates** to survive ([GameGPU](https://en.gamegpu.com/news/igry/naplyv-novoj-auditorii-obrushil-servery-analoga-discord-pod-nazvaniem-stoat)). New LiveKit voice initially "not usable in production deployment" *(summary)*. Legacy voice unreliable on Linux; not actually federated ([Lemmy thread](https://lemmy.world/post/164827)). **Lesson:** fan-out events (typing, presence) are the first thing to melt; have kill-switches and per-event rate limits. |
| **Spacebar (ex-Fosscord)** | Reimplements Discord's API so existing clients/bots work ([docs](https://docs.spacebar.chat/), [server](https://github.com/spacebarchat/server)). | Still incompatible in places; no admin GUI ([FAQ](https://docs.spacebar.chat/faq/)). **Lesson:** API-compatibility is a treadmill—Discord changes monthly. Do not chase it. |
| **Matrix / Element** | Federation, E2EE by default, institutional adoption, bridges; calls via **Element Call = MatrixRTC + LiveKit SFU + lk-jwt-service + coturn** ([Element blog](https://element.io/blog/end-to-end-encrypted-voice-and-video-for-self-hosted-community-users/), [setup guide](https://derg.nz/sysadmin/kb/2026/02/14/how-to-set-up-videovoice-calling-with-matrix/)). Android push via **UnifiedPush** ([element-android docs](https://github.com/element-hq/element-android/blob/develop/docs/unifiedpush.md)). | Synapse RAM blow-ups joining large rooms ([#7339](https://github.com/matrix-org/synapse/issues/7339)), 2–4 GB RAM typical *(summary)*; sliding-sync bugs; "UX gap vs Discord"; no voice channels/PTT/custom emoji parity ([gist](https://gist.github.com/SturmB/0c75dfbf61b9416370310dcc4b065733)). **Lesson:** E2EE + federation cost a lot of UX and ops. The LiveKit+JWT-service pattern is a good template for voice. |
| **Rocket.Chat** | Feature-rich, omnichannel. | Push through their gateway is capped for Community (1k–10k/month) unless you build your own apps + gateway ([docs](https://docs.rocket.chat/docs/push), [#17461](https://github.com/RocketChat/Rocket.Chat/issues/17461)); MongoDB upgrade pain; federation paywalled ([LWN](https://lwn.net/Articles/1059739/)). **Lesson:** mobile push is where self-hosting gets hard; Web Push avoids the gateway problem entirely. |
| **Mattermost** | Postgres-first, Redis cache, HA reference architectures to 100k+ users ([docs](https://docs.mattermost.com/administration-guide/scale/scaling-for-enterprise.html)). | Mobile push goes through Mattermost's hosted HPNS (US-hosted) or your own compiled apps + [push proxy](https://github.com/mattermost/mattermost-push-proxy). Feels nothing like Discord. |
| **Zulip** | Topic-based threading: every message has a stream + topic, making catch-up after days feasible ([Why Zulip](https://zulip.com/why-zulip/)). | Unfamiliar to Discord users. **Lesson:** "catch up on what I missed" is a first-class feature; this project's forum/threads + inbox are the nearest equivalent. |
| **Guilded** | Calendars, docs, tournaments. | Forced Roblox-account linking (2024) drove users away; shut down 2025-12-19 ([Massively OP](https://massivelyop.com/2025/09/30/roblox-announces-that-it-will-shut-down-guilded-at-the-end-of-2025/), [Roblox devforum](https://devforum.roblox.com/t/update-on-guilded-and-communities/3966775)). **Lesson:** platform neutrality and data ownership are the reasons people self-host. |
| **Fluxer** | AGPLv3, one-command self-host, voice/video + screen share, custom CSS ([OpenAlternative](https://openalternative.co/fluxer), [self-host repo](https://github.com/shadowflee3/fluxer-selfhost)). | Single-developer risk; no E2EE yet. |
| **TeamSpeak** | 20-year track record for low-latency voice. | Voice only. |

### Why people leave self-hosted Discord alternatives (pain points)

Synthesised from the sources above plus
[HN: "any good self-hosted alternative?"](https://news.ycombinator.com/item?id=28340095) and
[HN 2023 thread](https://news.ycombinator.com/item?id=35847615) *(summary)*,
[How-To Geek](https://www.howtogeek.com/5-self-hosted-discord-alternatives-that-are-actually-great/) *(summary)*:

1. **Network effect** — friends are on Discord. Mitigation: frictionless invite links that work on a phone browser without an app install.
2. **No mobile notifications** — the #1 practical killer. If a DM doesn't buzz your phone, the community goes back to Discord.
3. **Voice that doesn't connect or doesn't scale** — NAT failures, echo, 5+ people with cameras.
4. **Outages / slowness under load** (Stoat Feb 2026).
5. **Admin burden** — painful upgrades (Rocket.Chat/MongoDB), RAM (Synapse), broken compose files.
6. **UX gap** — "feels like a 2015 IRC client" (Matrix critiques).
7. **Moderation tooling gaps** when raids arrive.

---

## 3. Voice/video architecture

- **TURN is not optional:** 8–30% of WebRTC sessions need a relay; large vendors report ~20% ([webrtcHacks on coturn](https://webrtchacks.com/coturn/), [L7mp analysis](https://medium.com/l7mp-technologies/use-of-turn-in-webrtc-revisited-it-may-be-more-useful-than-you-thought-856059fd27a3), [webrtc.org](https://webrtc.org/getting-started/turn-server)). This project now has the credential endpoint and a coturn compose profile; it needs to be *on by default* in the deployment path and tested.
- **SFU choice.** LiveKit (Go/Pion) ships signalling, SDKs, JWT auth, E2EE, recording (egress) and is what Stoat and Element Call converged on. mediasoup (C++ workers driven from Node) is faster per CPU but you build the platform yourself ([Trembit](https://trembit.com/blog/livekit-vs-mediasoup/), [Forasoft](https://www.forasoft.com/learn/video-streaming/articles-streaming/sfu-comparison-mediasoup-janus-livekit-jitsi-pion), [OpenVidu](https://openvidu.io/3.1.0/docs/comparing-openvidu/)).
  *Recommendation:* optional LiveKit sidecar, mesh stays default for ≤4 people / no-SFU installs. Mirror Element's `lk-jwt-service` pattern: this server mints LiveKit tokens after its own permission check.
- **E2EE media:** only meaningful with an SFU; LiveKit supports insertable-streams E2EE. DAVE itself is open source but significant work; not a goal.

## 4. Realtime and horizontal scaling

- **Socket.IO multi-node** needs an adapter (Redis, Redis Streams, Postgres, cluster) and sticky sessions for long-polling ([Adapter docs](https://socket.io/docs/v4/adapter/), [Redis Streams adapter](https://socket.io/docs/v4/redis-streams-adapter/)). Only the in-memory, Redis Streams and MongoDB adapters support **Connection State Recovery** ([docs](https://socket.io/docs/v4/connection-state-recovery)), which replays missed events after a short disconnect — Socket.IO's analogue of Discord RESUME. Recovery can fail, so the client still needs a REST resync path (fetch messages `after` last seen id per open channel).
- **SQLite vs Postgres.** SQLite WAL: one writer, readers never block; 10k+ writes/s on NVMe is plausible *(vendor summaries)* ([Sesame Disk benchmarks](https://sesamedisk.com/sqlite-in-production-2026-benchmarks-limits/), [DEV: backups](https://dev.to/helperx/sqlite-backup-strategy-for-production-saas-wal-litestream-recovery-tests-11jg)). **Litestream** gives continuous WAL streaming to S3 with point-in-time restore. For a community-sized self-hosted chat, SQLite is not the bottleneck; in-process fan-out and the single Node event loop are. Postgres is the right move only when you need >1 app node.

## 5. Notifications, PWA, mobile

- **Web Push** = RFC 8291 (aes128gcm payload encryption) + RFC 8292 (VAPID). No vendor account, no gateway, works in Chrome/Edge/Firefox desktop + Android ([RFC 8292](https://datatracker.ietf.org/doc/html/rfc8292), libraries e.g. `web-push`, [node-webpush](https://github.com/SourceRegistry/node-webpush)).
- **iOS**: Web Push works only for PWAs **added to Home Screen** (iOS/iPadOS 16.4+), needs a manifest and a user-gesture permission prompt; Safari 18.4 added Declarative Web Push ([MagicBell](https://www.magicbell.com/blog/pwa-ios-limitations-safari-support-complete-guide), [OneSignal](https://documentation.onesignal.com/docs/en/web-push-for-ios)).
- **UnifiedPush** lets Android native clients receive push without Google FCM (Element supports it) ([docs](https://github.com/element-hq/element-android/blob/develop/docs/unifiedpush.md)). Only relevant if a native app ever exists.
- Contrast with Rocket.Chat/Mattermost, whose native-app push depends on vendor gateways. **Web Push + PWA is the one path where a self-hoster gets phone notifications with zero third-party accounts.** This is the highest-leverage feature for this project.

## 6. Search, media, i18n (Thai)

- **Search:** FTS5 trigram (current) handles Thai substrings but not ranking/typos. Postgres FTS doesn't segment Thai; pg_trgm gives similarity not typo tolerance. **Meilisearch** has Thai dictionary segmentation in its tokenizer charabia ([charabia](https://github.com/meilisearch/charabia), [Thai issue #2686](https://github.com/meilisearch/meilisearch/issues/2686), [Thai PR #384](https://github.com/meilisearch/charabia/pull/384)) and typo tolerance ([comparison](https://www.meilisearch.com/docs/resources/comparisons/postgresql)). But it is another service and must enforce per-channel permissions on the result set. *Keep FTS5; revisit only on user complaints.*
- **Thai text handling:** Thai has no spaces between words; `split(' ')` is wrong. `Intl.Segmenter` (Baseline in all engines) gives word boundaries for Thai ([MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/Segmenter), [MDN blog](https://developer.mozilla.org/en-US/blog/javascript-intl-segmenter-i18n/)). Use it for: highlighting search hits, ctrl+arrow word jumps in the composer, mention/emoji autocomplete boundaries, and truncation (never cut a combining vowel/tone mark — segment by grapheme). CSS `word-break`/`line-break` already defers to the browser's dictionary for line wrapping.
- **Media:** content-addressed storage + sharp variants exist. Missing: video poster thumbnails, EXIF/GPS stripping confirmation for all uploads, `Cache-Control: immutable` + CDN guidance for hashed paths, blurhash placeholders.

## 7. Trust & safety

- **CSAM:** PhotoDNA requires approval; Meta open-sourced **PDQ/TMK+PDQF** and **Hasher-Matcher-Actioner (HMA)**, but PDQ is useless without a hash list (NCMEC/Tech Coalition access). **Cloudflare's CSAM Scanning Tool** is free for sites proxied through Cloudflare and matches against NCMEC hashes ([Prostasia comparison](https://medium.com/prostasia-foundation/csam-filtering-options-compared-a8f03d5d834e), [Unitary overview](https://www.unitary.ai/articles/the-present-and-future-of-detecting-child-sexual-abuse-material-on-social-media)).
  *Honest take:* a small self-hoster cannot run hash-matching in-house. The project should (a) document Cloudflare's tool for public instances, (b) give admins a fast "purge file by hash everywhere + ban uploader + preserve evidence" action, (c) default public instances to invite-only registration.
- **Report flows:** Discord's model — reporter picks a reason, moderator sees context, action is logged, affected user sees what happened and can appeal ([Warning System](https://support.discord.com/hc/en-us/articles/18210965981847-Discord-Warning-System)). This project has reports + audit log; missing an **instance-admin** UI and user-facing "why was I actioned".
- **Abuse prevention:** Cloudflare Turnstile (free, but a third party, and accessibility/VPN false positives), hCaptcha, or **self-hosted proof-of-work (ALTCHA, Cap)** that needs no third party ([ALTCHA](https://altcha.org/), [Cap comparison](https://trycap.dev/guide/alternatives), [Turnstile docs](https://developers.cloudflare.com/turnstile/)). PoW fits a self-hosted, privacy-first product; combine with email verification and invite-only registration modes.

## 8. Operations, security, privacy law

- **Observability:** OpenTelemetry Node auto-instrumentation covers Express, HTTP, and has a Socket.IO instrumentation ([OTel Node](https://opentelemetry.io/docs/languages/js/getting-started/nodejs/), [instrumentation-socket.io](https://www.npmjs.com/package/@opentelemetry/instrumentation-socket.io)). The existing hand-rolled Prometheus endpoint is adequate for one node; add business gauges (connected sockets, event fan-out/s, voice rooms, SQLite busy/wal size, event-loop lag) before adding OTel.
- **Backups:** existing snapshot scripts + prune. Litestream adds continuous PITR. The rule that matters: restores must be tested on a schedule.
- **Security headers:** CSP already strict in production except `style-src 'unsafe-inline'` (Tailwind runtime). HSTS preload, COOP, frame-ancestors none present. Remaining: `Cross-Origin-Resource-Policy` on uploads, CSP `report-to`, and dependency advisories (`npm audit` reports 13, mostly the `sqlite3` build chain).
- **Thailand PDPA:** rights of access, portability, erasure, objection; breach notice to the PDPC **within 72 hours** where feasible (≤15 days with justification) unless no risk, and to data subjects when high risk ([IAPP](https://iapp.org/news/a/thailand-s-pdpc-clarifies-data-breach-notification-requirements), [DLA Piper](https://privacymatters.dlapiper.com/2025/02/thailand-pdpcs-clarification-on-personal-data-breach-notification/), [Lex Bangkok](https://lexbangkok.com/data-breach-notification-thailand/)). GDPR is analogous. The operator is the data controller; the software must make compliance *possible*: export (exists), erasure (exists), retention settings, a privacy-policy/ToS page slot, breach runbook, and an access log for admin actions on user data.
- **Accessibility:** chat transcripts should use `role="log"` (implicit `aria-live="polite"`), a named landmark, and be tested with NVDA/JAWS/VoiceOver; WCAG 2.2 SC 4.1.3 status messages ([W3C ARIA23](https://www.w3.org/WAI/WCAG21/Techniques/aria/ARIA23), [W3C working example](https://www.w3.org/WAI/WCAG21/working-examples/aria-role-log/chatlog.html), [MDN log role](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Reference/Roles/log_role)). Current `npm run a11y` is a static linter, not a screen-reader test.
