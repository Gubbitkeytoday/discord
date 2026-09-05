# Antigravity Discord

A self-hosted chat platform built to Discord's actual model — snowflake IDs,
permission bitfields with channel overwrites, threads, roles, AutoMod, webhooks,
audit logs, WebRTC voice — running as **one Node process with a SQLite file**.
No message broker, no separate cache, no cloud dependency required.

Interface available in **English** and **ไทย**, switchable at runtime.

```bash
npm ci
npm run dev        # client on :5173
npm run server     # API + realtime on :3001
```

Then, for demo data (6 accounts, 3 servers, sample messages; password
`antigravity123`):

```bash
npm run seed
```

Or run the whole thing as one production process:

```bash
npm run build
NODE_ENV=production SERVE_STATIC=1 node server.js
```

See **[DEPLOYMENT.md](DEPLOYMENT.md)** to put it on the internet, and
**[ARCHITECTURE.md](ARCHITECTURE.md)** for how it works and why.

---

## What it does

**Messaging** — servers, categories, text, voice, announcement and forum
channels, private channels, threads, DMs and group DMs, replies, edit and
delete, forwarding, pins, mark-as-unread, per-user reactions, full Markdown
(bold, italic, strikethrough, spoilers, quotes, headings, lists, inline and
fenced code with syntax labels), `@user` / `#channel` / `@role` / `@everyone` /
`@here` mentions with autocomplete, custom emoji and stickers with a composer
picker, link previews, optimistic send with retry on failure, typing indicators,
unread counts, a mention inbox, a new-message divider, full-text search with
channel/author/attachment filters that works in Thai, and a quick switcher.

**Files** — content-addressable storage keyed by SHA-256 with two-level
sharding, reference counting and garbage collection, per-user quotas, image
variants via sharp when available, video and audio duration probing, magic-byte
type sniffing that rejects an HTML file renamed `.png`, signed URLs for private
files, and optional S3-compatible object storage (SigV4 written by hand, verified
against AWS's published vectors).

**Permissions** — the real Discord model: 40 permission flags as bitfields
resolved `@everyone` → role union → `@everyone` overwrite → role overwrites →
member overwrite, with tri-state channel overrides, role hierarchy enforcement
(you cannot grant a permission you lack, edit or reorder a role at or above your
own, or moderate someone who outranks you), private channels that are genuinely
hidden — from the channel list, from search, from unread badges and from the
gateway's own rooms — and an audit log. Every read and write goes through one
access gate, so the REST API and the websocket agree on who may see what.

**Moderation** — AutoMod rules (keywords, regex with a catastrophic-backtracking
guard, link allow-lists, mention limits, spam detection) that run *before* a
message is stored, so a blocked message never exists; timeouts that actually
strip permissions the way Discord's do (read-only, capped at 28 days,
administrators exempt), kicks, bans, nicknames, ownership transfer, and a
per-guild report queue moderators can triage themselves.

**Accounts** — scrypt password hashing, session tokens stored only as SHA-256,
TOTP two-factor with recovery codes, e-mail verification and password reset,
session listing and revocation — all of it reachable from the Account &
Security tab, not just the API.

**Voice and video** — WebRTC full mesh built on perfect negotiation, with three
fixed transceivers per peer (microphone, camera, screen) so turning a camera on
mid-call swaps a track instead of renegotiating the connection. Camera and
screen share both reach the other side and render in a real video grid you can
pin, stage or drop back to a tile layout. Mute, deafen and per-user local mute
each silence exactly what they claim to. Push-to-talk with a configurable key
and release delay, voice-activity detection with automatic sensitivity that
tracks the room's noise floor, echo cancellation / noise suppression / auto
gain, input and output device selection with a live mic test, output
attenuation that ducks everyone else while you speak, per-participant volume up
to 200%, and a camera blur that runs entirely on a canvas — no model download,
no CDN, works offline.

**Settings** — a full user-settings surface, split the way Discord splits it.
*User settings*: profile, account and security, privacy and safety, activity
privacy. *App settings*: appearance, accessibility, voice and video,
notifications, keybinds, text and images, streamer mode. Nine categories of
preference live on the account, sync to every signed-in tab over the gateway,
and are validated and clamped server-side. The two privacy categories are
**enforced by the server**, not merely honoured by the client: "who can DM me"
and "who can send me a friend request" are refused at the API, so a modified
client gains nothing.

**Interface** — five themes (light, ash, dark, onyx, sync-with-system), cozy and
compact message density, three UI densities, zoom, independent chat font scale
and message group spacing, high-contrast mode, reduced motion, a saturation
control, role colours as names / dots / off, text-to-speech, English and Thai,
keyboard-navigable with a clean accessibility audit.

**Operations** — liveness and readiness probes, Prometheus metrics, structured
JSON logs with request correlation IDs, graceful shutdown that drains in-flight
requests, versioned automatic migrations, and a backup tool that snapshots a live
database consistently.

---

## Requirements

- Node.js 20+ (22 recommended)
- No database server, no Redis
- `sharp` is optional — without it, images are stored unchanged

---

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Vite dev server for the client |
| `npm run server` | API and WebSocket gateway |
| `npm run build` | Production client bundle into `dist/` |
| `npm run seed` | Demo data |
| `npm test` | 242 integration tests |
| `npm run jsx:check` | Structural check of the client: JSX balance, imports, undefined components |
| `npm run a11y` | Accessibility audit |
| `npm run i18n:audit` | Translation coverage and consistency |
| `npm run verify` | Build + tests + a11y + i18n, all of it |
| `npm run backup` | Consistent snapshot of database and files |
| `npm run storage:stats` | Storage usage, orphans, quotas |
| `npm run storage:gc` | Delete unreferenced files |
| `npm run search:reindex` | Rebuild the full-text index |
| `npm run docker:up` | App + Caddy with automatic HTTPS |

---

## Adding a language

1. Copy `src/i18n/en.js` to `src/i18n/<code>.js` and translate the values.
2. Register it in `src/i18n/index.jsx` — add the import to `DICTIONARIES` and an
   entry to `LOCALES`, plus a BCP 47 tag in `INTL_LOCALE` so dates and numbers
   format correctly.
3. `npm run i18n:audit` — it fails on any key present in English but missing from
   your file, and on placeholder mismatches like a `{name}` that got dropped.

The audit also reports how many hardcoded strings remain outside the
dictionaries, so gaps stay visible instead of accumulating quietly.

---

## Project layout

```
server.js            API, realtime, static serving, lifecycle
db.js                connection, promise helpers, migrations
db/schema.sql        45 tables
db/seed.js           demo data
lib/                 snowflake, permissions, auth, totp, storage, s3, config, middleware
routes/              files, auth, account security
services/            messages, guilds, users, automod, webhooks, threads, reports
src/                 React client
src/i18n/            dictionaries and the provider
scripts/             tests, audits, storage tools, backups
```

`ARCHITECTURE.md` explains the design decisions — why snowflakes rather than
autoincrement, why content-addressable storage, why the trigram tokenizer is
required for Thai — and documents the known limits honestly.

---

## Licence

Unlicensed personal project. Not affiliated with Discord Inc.
