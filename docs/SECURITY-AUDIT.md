# Security Audit — Antigravity Discord (second-opinion / adversarial pass)

Independent appsec review focused on what an earlier remediation pass **missed**.
Scope: Node 22 / Express + Socket.IO + SQLite backend and the React 19 SPA.
A large amount of the codebase is already well-hardened — SSRF unfurling with
DNS-rebind protection at connect time, magic-byte upload sniffing with a
`sandbox` CSP on served blobs, constant-time token/password comparison, a proper
Discord-style permission/hierarchy model, parameterised SQL and FTS, socket-room
access checks, and per-socket rate limits. The findings below are the gaps that
remain.

**Method.** Findings were reproduced against a disposable instance booted as in
production (`NODE_ENV=production`, `ALLOW_DEV_IDENTITY=0`, strong
`STORAGE_URL_SECRET`). Each proof-of-concept lives in `scripts/security/` and
prints `VULNERABLE` / `NOT VULNERABLE`, so they double as regression tests.

```
NODE_ENV=production PORT=5300 HOST=127.0.0.1 DB_PATH=/tmp/sec.db \
STORAGE_ROOT=/tmp/sec-up STORAGE_URL_SECRET=$(openssl rand -base64 32) \
ALLOW_DEV_IDENTITY=0 SERVE_STATIC=0 PUBLIC_URL=http://localhost:5300 node server.js
SEC_BASE=http://127.0.0.1:5300 node scripts/security/poc-01-reset-token-disclosure.mjs
SEC_BASE=http://127.0.0.1:5300 node scripts/security/poc-02-disclosure-and-enumeration.mjs
```

| ID | Severity | Title |
|----|----------|-------|
| C-1 | Critical | Unauthenticated account takeover via password-reset token in the HTTP response |
| H-1 | High | E-mail-verification token likewise disclosed in the response (verification bypass) |
| M-1 | Medium | `/metrics` exposed without authentication by default |
| M-2 | Medium | E-mail existence oracle on `POST /api/auth/register` |
| M-3 | Medium | No image proxy — recipient IP/User-Agent leaks to attacker-controlled hosts |
| M-4 | Medium | Global user directory: `GET /api/users` returns every account to any member |
| L-1 | Low | Non-constant-time comparison of the `/metrics` bearer token |
| L-2 | Low | Unvalidated `color` / `accent_color` written into inline `style` (CSS injection) |
| L-3 | Low | 30-day sessions with no absolute lifetime or re-auth for sensitive changes |

---

## C-1 — Unauthenticated account takeover via password-reset token disclosure

**Severity: Critical.** PoC: `scripts/security/poc-01-reset-token-disclosure.mjs`
(reproduced: unauthenticated caller reset a victim's password and logged in).

`requestPasswordReset` returns the raw, single-use reset token in the JSON body
whenever the `MAIL_TRANSPORT` environment variable is **undefined**:

`services/accountSecurity.js:208`
```js
return { sent: true, ...(process.env.MAIL_TRANSPORT ? {} : { dev_token: token }) };
```

The endpoint (`routes/accountSecurity.js` → `POST /api/auth/forgot-password`) is
unauthenticated and takes only an e-mail address. The guard is on *whether the
variable exists*, not on whether a real transport is configured, and
`lib/config.js` performs **no** production check for it. `MAIL_TRANSPORT` is
optional and commented in `.env.example`, and `docker-compose.yml` does not set
it — so a deployment that simply forgets it turns this into a one-request
account-takeover for any known address:

```
POST /api/auth/forgot-password {"email":"victim@x"}  -> {"sent":true,"dev_token":"…"}
POST /api/auth/reset-password  {"token":"…","password":"attacker"}  -> {"reset":true}
```

The identical pattern in `requestEmailVerification` (`services/accountSecurity.js:158`)
is **H-1** below.

**Fix.** Never return a secret to the client. Gate on a *real* transport and
never expose the token over HTTP:

`services/accountSecurity.js:208` (and `:158`)
```js
// import { currentTransport } from '../lib/mailer.js';
const devToken = process.env.NODE_ENV !== 'production' && currentTransport() === 'console';
return { sent: true, ...(devToken ? { dev_token: token } : {}) };
```
Additionally, add a boot guard in `lib/config.js` `loadConfig()` (production
`errors`): refuse to start when `mailTransport === 'console'` so password reset
cannot silently ship in a mode that either leaks tokens or delivers nothing.

---

## H-1 — E-mail-verification token disclosed in the response

**Severity: High.** Same root cause as C-1 at `services/accountSecurity.js:158`.
`POST /api/auth/verify-email/request` (authenticated) returns `dev_token` when
`MAIL_TRANSPORT` is unset, so a user can verify their own address without ever
receiving the mail — defeating verification-gated join requirements
(`assertVerificationLevel`, `services/guilds.js:551`, level ≥ 1 requires a
verified e-mail). **Fix:** as C-1 — use `currentTransport() === 'console'` and
never emit the token in production.

---

## M-1 — `/metrics` exposed without authentication by default

**Severity: Medium.** PoC: `poc-02` check [1] (`GET /metrics` → 200 with no
credentials). In `lib/config.js`, `enableMetrics` defaults **true** and
`metricsToken` defaults **null**; `server.js:161` then serves full Prometheus
metrics (request counts by route/status, latency percentiles, socket counts,
RSS/heap) to anyone. The shipped Caddyfile/nginx configs block `/metrics`, but
the application itself is open — any deployment that exposes the port directly,
or uses a different proxy, leaks operational data useful for reconnaissance.

**Fix.** Default to closed. In `server.js:161`, refuse the endpoint unless a
token is set (or bind metrics to a separate internal listener):
```js
if (config.enableMetrics && !config.metricsToken && config.isProduction) {
  // do not mount, or require the token unconditionally
}
```
At minimum, in `lib/config.js` add a production `warning`/`error` when
`enableMetrics && !metricsToken`.

---

## M-2 — E-mail existence oracle on registration

**Severity: Medium.** PoC: `poc-02` check [2]. `POST /api/auth/register`
(`routes/auth.js:66-70`) returns `409 CONFLICT "อีเมลนี้ถูกใช้แล้ว"` when an
address is already registered. `forgot-password` was deliberately built **not**
to enumerate; registration hands the same information back directly, so any
address can be tested for an account.

**Fix.** Do not distinguish "e-mail taken" from success at registration time.
Either (a) accept the registration and send a "this address already has an
account" e-mail out-of-band instead of a synchronous 409, or (b) return a
generic validation error indistinguishable from other input errors. The current
timing-equalised login (`routes/auth.js:105`) shows the intended discipline;
apply it here too.

---

## M-3 — No image proxy: recipient IP/User-Agent leaks to third-party hosts

**Severity: Medium.** Confirmed that `avatar_url`/`banner_url` accept any
`https://` host (`services/users.js:161-167` validates scheme/length only), and
`img-src 'self' data: blob: https:` in the CSP (`lib/middleware.js:29`) permits
loading them. The client renders these directly (`<img src=…>`, `url(${…})` in
`UserProfileModal.jsx`, `ChatArea.jsx`, `LinkEmbed.jsx`, `RichEmbed.jsx`). An
attacker sets their avatar — or pastes a link whose `og:image` points — at a
logging endpoint; every user who views the profile / DM / message deanonymises
themselves (IP, User-Agent, timing). Discord solves this with an image proxy for
exactly this reason.

**Fix.** Route remote images through a same-origin caching proxy (reuse the
guarded fetch in `services/linkEmbeds.js` — `assertPublicUrl` + `guardedLookup`)
and rewrite `embed.image`, `avatar_url` etc. to the proxied URL before they
reach the client; then tighten CSP `img-src` to `'self' data: blob:`. If a full
proxy is out of scope, document the deanonymisation risk prominently.

---

## M-4 — Global user directory enumerable by any member

**Severity: Medium.** PoC: `poc-02` check [3] — a brand-new account received the
full user list. `GET /api/users` (`server.js:206`) →
`userService.listUsers()` (`services/users.js:19`) returns **every**
non-deleted account (id, username, discriminator, presence) with no scoping to
shared servers/friends. This enables complete membership scraping and presence
tracking of the whole instance by any single registered user. (E-mail is not
exposed — `PUBLIC_COLUMNS` correctly omits it.)

**Fix.** Scope the endpoint to users the caller can legitimately see (shared
servers, DM recipients, friends), mirroring the `getUser` mutual-servers logic
(`services/users.js:31-48`), or remove the bulk endpoint in favour of the
per-id and per-server member listings that already exist.

---

## L-1 — Non-constant-time metrics-token comparison

`server.js:163` compares the bearer token with `!==`. `routes/files.js:355`
already uses `crypto.timingSafeEqual` for `ADMIN_TOKEN`; do the same here.

## L-2 — CSS injection via unvalidated colour fields

`accent_color` (`services/users.js:updateProfile` — not in the `LIMITS` map or
the URL check) and role `color` / `color_secondary`
(`services/guildAdmin.js:206`) are stored unvalidated and interpolated into
inline `style` (`MemberList.jsx:119`, `UserProfileModal.jsx`, `markdownParser.jsx`
role mentions). Modern CSSOM rejects malformed single-property values so this is
not script execution, but it is unhygienic. **Fix:** validate against
`/^#[0-9a-f]{6}$/i` (role colour edits already do this in `RichEmbed.jsx` for
embeds; apply server-side on write).

## L-3 — Long-lived sessions, no re-auth for sensitive actions

`SESSION_TTL_MS = 30 days` (`lib/auth.js:24`) with sliding `last_seen_at` and no
absolute cap. `POST /api/auth/change-password` requires the current password
(good), but MFA disable relies on a TOTP/recovery code only and profile/e-mail
changes need nothing beyond the session. Consider an absolute session lifetime
and step-up re-auth for e-mail change and MFA disable.

---

## Checked and found solid (no action)

- **SSRF / link unfurl** — `services/linkEmbeds.js`: per-hop `assertPublicUrl`,
  private-range denylist incl. IPv4-mapped IPv6 and cloud metadata, and
  `guardedLookup` that re-checks the resolved address at connect time (closes
  DNS rebinding). Redirects are followed by hand and re-validated.
- **Upload safety** — magic-byte sniffing (`lib/mediaProbe.js`), category MIME
  allowlists, `X-Content-Type-Options: nosniff` + `Content-Security-Policy:
  default-src 'none'; sandbox` on both the static mount and `/api/files`
  (`server.js:123`, `routes/files.js`), `Content-Disposition: attachment` for
  non-image types. SVG is served sandboxed; HTML uploads are rejected.
- **XSS** — no `dangerouslySetInnerHTML`; `markdownParser.jsx` builds React
  nodes and the link grammar only admits `https?://` / root-relative URLs;
  `RichEmbed`/`LinkEmbed` gate hrefs and images through an `http(s)`-only check.
- **AuthZ** — permission/role hierarchy (`assertCanManageRole`,
  `assertMemberHierarchy`, `assertRoleHierarchy`) prevents privilege escalation
  via role edits/overwrites/reorder/bot-invite; `assertChannelAccess` gates
  message/DM/thread access; socket rooms are access-checked on join and
  revalidated on permission change.
- **Rate-limit / XFF** — numeric `trust proxy` (production default `1`) means a
  single forged `X-Forwarded-For` does not bypass the IP-keyed login limiter
  (verified: rotating XFF still throttled). Socket sends have their own bucket.
- **Crypto** — scrypt password hashing, SHA-256-hashed session/webhook/bot
  tokens stored (never raw), `timingSafeEqual` on password/webhook/file-URL
  verification, TOTP per RFC 6238 with constant-time compare.
- **Invites** — codes minted with `crypto.randomInt`; last-use claimed with an
  atomic conditional `UPDATE` (no TOCTOU on limited invites).

---

## CodeQL triage

Local run of the CodeQL bundle (`javascript-security-extended.qls`, build-mode
none, same `paths-ignore` as `.github/workflows/codeql.yml`). Fixed in code:

| Rule | Location | Fix |
|------|----------|-----|
| `js/double-escaping` | `services/linkEmbeds.js` `decodeEntities` | Single-pass decode; `&amp;lt;` now yields `&lt;`, not `<` (test in `test-part4.mjs`). |
| `js/remote-property-injection` | `services/userSettings.js` `merge` | Built with `Object.fromEntries`; `__proto__`/`constructor`/`prototype` keys dropped (a body key `__proto__` used to swap the merged object's prototype). |
| `js/log-injection` | `lib/middleware.js` request logger | Control characters (CR/LF, ANSI) stripped from the logged path. |
| `js/log-injection` | `services/translation.js` failure log | Logs the database row's message id, not the request's. |
| `js/user-controlled-bypass` | `services/passkeys.js` `verifyAssertion` | Whether the WebAuthn user handle may be absent is decided by the stored challenge purpose (required for discoverable sign-in per WebAuthn §7.2), not by the request omitting it (tests in `test-passkeys.mjs`). |
| (hardening) | `routes/auth.js` change-password | Per-user limiter (10 / 15 min) instead of only the global 600/min read budget for current-password guesses (test in `test-part2.mjs`). |
| (hardening) | `lib/mailer.js` `sendMail` | Recipients containing control characters are refused (SMTP command / header / log injection). |
| `js/missing-rate-limiting` (15 routes) | `lib/rateLimit.js` `rateLimit()` | Every limiter is now an `express-rate-limit` instance on `TokenBucketStore`, a Store adapter over the existing token buckets (in memory, or the shared Redis bucket with fail-open to local). Budgets, env knobs, keys, 429 `RATE_LIMITED`, `Retry-After` and `X-RateLimit-Limit/Remaining` are unchanged (plus `X-RateLimit-Reset`). The global `/api` budget is `[readOnly, mutating]`, each skipping the other's methods (test in `test-part2.mjs`). |
| `js/xss-through-dom` | `ForumView.jsx`, `ServerSettingsModal.jsx` file previews | Previews come from `filePreviewUrl()` (`src/utils/media.js`): only a `blob:` URL, URI-encoded, else no preview. |
| `js/insecure-randomness` | `src/App.jsx` send nonce | `crypto.getRandomValues` instead of `Math.random`. |
| `js/weak-cryptographic-algorithm` | `services/livekit.js` `buildIceServers` | The TURN username is expiry + random UUID, as in `server.js`, not the user id. HMAC-SHA1 stays because coturn's REST API (`use-auth-secret`) requires it (test in `test-livekit.mjs`). |
| `js/regex/missing-regexp-anchor` | `services/mediaPipeline.js` `directUploadMode` | `isR2Endpoint()` parses the URL and matches the host exactly (`r2.cloudflarestorage.com` or a subdomain) (test in `test-media38.mjs`). |
| `js/missing-origin-check` | `public/sw.js` message handler | Messages whose `event.origin` is not the worker's own origin are ignored. |
| `js/file-system-race` | `vite.config.js` SW build step | `readFileSync` in try/catch (ENOENT = skip) replaces `existsSync` + read. |
| (config) | `.github/workflows/codeql.yml` | `scripts/ux/**` (persona/UX harnesses) added to `paths-ignore`. |

The remaining alerts are false positives; dismiss them in the GitHub UI with
the reason given.

- **`js/request-forgery` — `services/linkEmbeds.js` `safeGet`** (critical).
  Won't fix / false positive. Fetching a user-supplied URL is the feature (link
  previews). Every hop, including each redirect, goes through
  `assertPublicUrl` (http(s) only, every resolved address checked against
  private, loopback, link-local/metadata, CGNAT, multicast and IPv4-mapped
  ranges), and the socket connects through `guardedLookup`, which re-checks
  the address actually dialled (DNS rebinding). CodeQL does not model either
  function as a sanitizer. Do not weaken them to silence this.
- **`js/insufficient-password-hash` — `lib/totp.js` `hashRecoveryCode`.**
  False positive: the input is a server-generated random recovery code, not a
  user-chosen password, so a salted slow hash is not required (same as the
  SHA-256 session/reset tokens). The digest is also the lookup key for an
  atomic "burn once" `UPDATE`, which a salted hash would prevent. A recovery
  code is only a second factor; the password (scrypt) is still needed. Optional
  future hardening: more code entropy than the current 40 bits.
- **`js/regex-injection` — `services/automod.js` `safeRegex`.** By design:
  `regex` automod rules are server-admin-authored patterns (MANAGE_GUILD). They
  are length-capped (200), rejected when they contain lookbehind or nested
  quantifiers, compiled with the `u` flag, and invalid patterns are refused.
- **`js/cors-permissive-configuration` — `server.js` CORS setup.** False
  positive: the origin comes from the operator's `CORS_ORIGIN`. Production
  defaults to same-origin, and `lib/config.js` warns about `CORS_ORIGIN=*` in
  production. With `*`, browsers refuse credentialed responses.
- **`js/http-to-file-access` — `storageService.js` `writeLocalObject`** (the
  purpose of an upload). The object key is the SHA-256 of the content (content-addressed), and the bytes are
  magic-byte sniffed first. **`lib/mailer.js` file transport**: the operator
  opts in with `MAIL_TRANSPORT=file` for CI, the path comes from `MAIL_FILE`,
  and the line is `JSON.stringify`-encoded.
- **`js/log-injection` — `lib/mailer.js` console transport.** False positive:
  `sendMail` now refuses any recipient containing a control character before
  logging, and registration already rejects whitespace in addresses. CodeQL
  does not model a reject-guard as a sanitizer.
- **`js/file-access-to-http` — `lib/s3Client.js` `request`.** False
  positive: sending stored upload bytes to the operator's configured S3/R2
  bucket (SigV4-signed, endpoint from `S3_ENDPOINT`) is the storage backend's
  purpose. No user input chooses the destination.

After these changes the local run reports eight alerts, all listed above as
false positives: `js/request-forgery` (linkEmbeds), `js/insufficient-password-hash`
(totp), `js/regex-injection` (automod), `js/cors-permissive-configuration`
(server.js), `js/http-to-file-access` ×2 (storageService, mailer),
`js/log-injection` (mailer) and `js/file-access-to-http` (s3Client).
