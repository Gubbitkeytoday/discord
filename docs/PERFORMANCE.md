# Performance and load testing

This document covers how the load suite in `scripts/load/` works, what it measured on the SQLite
build (September 2026), which bottlenecks it found, and a prioritised list of fixes.

**Short version:** the realtime layer can hold 2,000 idle websocket connections in about 250–390 MB.
Chat is a different story. With the target traffic of one message per user every 10 s, **the
highest load that stays healthy is about 100 users chatting at once in 50-member guilds (about
9–10 msg/s)**. Beyond that the server falls over rather than slowing down gradually. In guilds of
200 members, chat stops keeping up at about 4 msg/s in total. The causes are not CPU (the main
thread was 40–60 % busy) or the event loop. Each message costs about 6 SQL round trips per guild
member, and every statement runs one at a time on a single connection. Fixes 1–3 below remove that
per-member cost and should raise chat throughput 15–60×.

---

## 1. Methodology

### Environment

| | |
|---|---|
| Host | 4 vCPU, 16 GB RAM, Linux 6.18, Node 22.22 |
| App | branch `claude/dreamy-goldberg-p3o5ao` (merged into the load-test branch), SQLite (`sqlite3` 5.1.7, WAL, `synchronous=NORMAL`), `sharp` installed |
| Server env | `PORT=5750`, throwaway `DB_PATH` / `STORAGE_ROOT`, `LOG_LEVEL=warn`, `RATE_LIMIT_WRITE_PER_MIN` and `RATE_LIMIT_REGISTER_PER_HOUR` raised, everything else default (`NODE_ENV=development`, `UV_THREADPOOL_SIZE=4`) |
| Load generators | k6 v0.54.0 (REST); `socket.io-client` 4.8 inside Node worker threads (realtime). Both ran on the same host as the server. |

**Caveat:** other agents' servers and browsers shared the host, and the load average reached
7–14 on 4 cores during some runs. Absolute numbers are therefore conservative and noisy by about
±30 %. The *shape* of the results (where each scenario falls over, and the per-message SQL counts)
does not depend on that noise: statement counts are deterministic.

### Tools (all under `scripts/load/`, no new dependencies)

| File | Purpose |
|---|---|
| `start-server.sh <dir> [--cpu-prof]` | Starts `server.js` on port 5750 with a throwaway DB, uploads dir and raised limits, with `probe.mjs` preloaded. It refuses to start if the port is already in use. |
| `probe.mjs` | Loaded with `node --import`, so no app code changes. Every second it appends to `probe.jsonl`: event-loop lag (p50/p99/max), ELU, CPU %, RSS/heap, SQLite calls/s, caller wait (mean/p99), queue depth and `sql_busy`. `sql_busy` is the share of wall time the single connection spent executing statements; ≈1.0 means the database connection is the bottleneck. It also keeps a per-SQL-shape profile (count, caller wait, estimated service time), dumped on `SIGUSR2` or at exit. |
| `probe-report.mjs` | Summarises a `probe.jsonl` window plus the latest SQL profile. |
| `seed.mjs` | Seeds through the public API only. Owners register, create 10 guilds × N text channels and post history while the guilds are still small. Then members register (with distinct `X-Forwarded-For`, which the server trusts from loopback) and accept invites. Writes `fixture.json`, which every other script reads. |
| `socket-load.mjs` | Realtime scenarios (see below), spread over worker threads. |
| `k6/login-storm.js` | (a) `POST /api/auth/login` followed by `GET /api/auth/me`, on a ramping arrival rate with a random client IP per iteration. `SAME_IP=1` demonstrates the per-IP limit. |
| `k6/reads.js` | (c) Newest 50 messages, then two `before=` pages, plus a guild-scoped full-text search on 30 % of iterations. |
| `k6/upload.js`, `gen-images.mjs` | (d) Distinct noise PNGs (about 90 KB, 200×150) sent to `POST /api/upload/attachments`, then `POST /api/messages` with the attachment. |
| `cpuprofile-top.mjs` | Summarises a `--cpu-prof` profile: self time by file and hottest functions (self and inclusive). |
| `run-suite.sh <dir> [users] [chat_users]` | Runs every scenario end to end against a fresh server, then stops that server. |

`socket-load.mjs` models the SPA's behaviour (`src/App.jsx`). Each virtual user connects over the
websocket transport, sends `identify {token}`, then `join_server(guild)` and `join_channel(channel)`
and waits for their acks. Users are spread evenly over each guild's text channels. Messages follow
a Poisson process at `--rate` per user; 60 % of them are preceded by `typing_start` about 1.5 s
earlier. The script records:

- **ack**: time from `send_message` to its ack. This covers the full write path: permission
  check, automod, insert, unread fan-out and re-hydrate.
- **fanout**: time from send until `new_message` arrives at every *other* viewer of the channel.
  Every message carries its send timestamp, and sender and receivers share one clock. The
  delivery ratio is deliveries received ÷ (sent × (viewers − 1)).
- **ready**: time from connect until identified and both rooms are joined.
- **reconnect** (`--mode reconnect`): after a warm-up, every socket drops at the same moment and
  reconnects spread over 1 s, mimicking socket.io's backoff after a server restart. With
  `--refetch` each client also re-reads its channel history, as the SPA does. The script records
  time-to-ready per socket, time until all are back, and the refetch latency. Chat keeps running
  during the storm.
- The load generator's own ELU, so runs where the generator itself was the bottleneck can be
  spotted. The highest observed was 0.5, so no run was generator-bound.

### Reproduce

```bash
# one-shot, everything (k6 on PATH or K6=/path/to/k6):
scripts/load/run-suite.sh /tmp/lt 500            # 500 users, all chatting

# or step by step:
scripts/load/start-server.sh /tmp/lt                      # add --cpu-prof to profile
node scripts/load/seed.mjs --users 2000 --guilds 10 --channels 2 --history 500 --out /tmp/lt/fixture.json
k6 run -e FIXTURE=/tmp/lt/fixture.json -e MAX_RATE=160 scripts/load/k6/login-storm.js
k6 run -e FIXTURE=/tmp/lt/fixture.json -e RATE=40 -e DURATION=30s scripts/load/k6/reads.js
node scripts/load/gen-images.mjs --dir /tmp/lt/img --count 600
k6 run -e FIXTURE=/tmp/lt/fixture.json -e IMG_DIR=/tmp/lt/img -e IMG_COUNT=600 -e RATE=10 scripts/load/k6/upload.js
node scripts/load/socket-load.mjs --fixture /tmp/lt/fixture.json --users 1000 --duration 60 \
     --rate 0.1 --workers 4 --probe /tmp/lt/probe.jsonl --out /tmp/lt/steady-1000.json
node scripts/load/socket-load.mjs --fixture /tmp/lt/fixture.json --users 1000 --mode reconnect \
     --rate 0.002 --refetch --probe /tmp/lt/probe.jsonl
kill -USR2 $(cat /tmp/lt/server.pid) && node scripts/load/probe-report.mjs /tmp/lt/probe.jsonl
kill -TERM $(cat /tmp/lt/server.pid)                      # writes the .cpuprofile if enabled
node scripts/load/cpuprofile-top.mjs /tmp/lt/CPU.*.cpuprofile
```

These commands are not wired into `package.json`, because another workstream owns that file. Add
them later if you want them there, for example
`"load:suite": "scripts/load/run-suite.sh /tmp/lt"`.

### Datasets

| Dataset | Users | Guilds × text channels | Members per guild | History |
|---|---|---|---|---|
| `lt` (2000) | 2,000 + 10 owners | 10 × 2 | 201 | 500 per channel (10k messages) |
| `lt1000` | 1,000 + 10 | 10 × 2 | 101 | 200 per channel |
| `lt500` | 500 + 10 | 10 × 2 | 51 | 200 per channel |

Seeding the 2000-user dataset through the API took 155 s: history at 120 msg/s while guilds had
1 member, registration at 37/s (scrypt-bound) and invite accepts at 118/s.

---

## 2. Results

### (b) Steady chat: 1 msg / 10 s / user, 60 % with a typing indicator first

| Connected users | Members per guild | Target msg/s | **Acked msg/s** | Send errors | Ack p50 / p95 / p99 (ms) | Fan-out p50 / p95 (ms) | Delivered | Server CPU avg (% of 1 core) | RSS max | Loop lag p99 avg / max | SQL/s | Verdict |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 50 | 51 | 5 | 5.6 | 0 | 121 / 497 / 658 | 123 / 501 | 100 % | 31 % | 114 MB | 5 / 70 ms | 1,777 | ✅ healthy |
| 100 | 51 | 10 | 9.4 | 0 | 321 / 1,373 / 1,499 | 321 / 1,373 | 100 % | 50 % | 243 MB | 6 / 42 ms | 3,000 | ⚠️ **max sustainable** |
| 150 | 51 | 15 | 14.2 | 0 | 456 / 1,582 / 1,738 | 454 / 1,589 | 100 % | 60 % | 134 MB | 5 / 71 ms | 4,463 | ⚠️ at the knee |
| 200 | 51 | 20 | 15.3 | 0 | 5,573 / 13,761 / 14,064 | 5,573 / 13,761 | 100 % (late) | 59 % | 244 MB | 16 / 266 ms | 4,734 | ❌ backlog growing |
| 500 | 51 | 50 | 6.0 | 1,266 timeouts | 10,027 / 25,719 / 29,198 | 24,192 / 46,151 | late | 60 % | 167 MB | 16 / 73 ms | 4,016 | ❌ collapsed |
| 1,000 | 101 | 100 | 1.6 | 3,141 timeouts | 18,635 / 28,277 / 29,909 | 38,054 / 56,824 | 4 % in window | 72 % | 390 MB | 10 / 109 ms | 4,226 | ❌ collapsed |
| 2,000 | 201 | 200 | 0 | 6,211 timeouts | – | – | 0 % | 82 % | 279 MB | 19 / 345 ms | 2,860 | ❌ dead (connect took 90 s; 84 joins timed out) |

**Statements per message:** 50-member guilds: 326 SQL statements per message (82,670 ÷ 254 and
138,429 ÷ 424). 200-member guilds: about 1,240 per message (the upload scenario below). The
fixed part is about 20 statements; the rest is about 6 per guild member (see bottleneck #1).

The server's CPU never passed about 100 % of one core (of 4), and the event loop stayed
responsive (p99 lag 5–19 ms). `sql_busy` sat at 0.95–1.0 in every run that failed. Throughput is
set by the single, serialised SQLite connection.

### (e) Reconnect storm: every socket drops and reconnects within 1 s, then re-fetches history

| Users | Time until all back | Reconnect p50 / p95 | History refetch p50 / p95 | `presence_updated` events delivered | Server RSS max | Loop lag max | SQL queue max |
|---|---|---|---|---|---|---|---|
| 500 | **17.8 s** | 15.5 s / 16.5 s | 5.3 s / 6.0 s | 625,408 | 206 MB | 403 ms | 1,484 |
| 1,000 | **42.8 s** | 40.4 s / 40.9 s | 4.0 s / 4.9 s | 2,500,683 | 389 MB | 259 ms | 2,982 |
| 2,000 | **> 71 s**: not one socket had rejoined its rooms within the 71 s window | – | – | 6,622,173 | 250 MB | 141 ms | 5,881 |

Initial connection (ramped): 500 users in 20 s gave ready p95 = 272 ms; 1,000 in 30 s gave
172 ms; 2,000 in 60 s gave 10.4 s. Chat messages sent during the 1,000-user storm had a fan-out
p95 of 47 s. The presence broadcast is O(N²): N users coming back emit N × N `presence_updated`
events (bottleneck #5).

### (a) Login storm

Arrival rate is constant per step. Each iteration is login plus `/auth/me`, from a random client IP.

| Offered logins/s | Achieved | Login p50 / p95 / p99 | `/auth/me` p50 / p95 | Server CPU | SQL caller wait (mean) |
|---|---|---|---|---|---|
| 30 | 28/s | 57 / 98 / 160 ms | 2 / 9 ms | 142 % | 1.3 ms |
| 45 | 40/s (69 dropped) | 121 / 1,733 / 1,933 ms | 26 / 946 ms | 206 % | 123 ms |
| 16 → 160 (ramping) | 40/s (4,298 dropped) | 4.7 s / 20.1 s / 20.9 s | 2.4 s / 13.1 s | 200 % (max 337) | **2.7 s** |
| 60 (noisy host), `UV_THREADPOOL_SIZE=4` | 21.5/s | 15.2 s p50 | 4.3 s | 108 % | 4.1 s |
| 60 (noisy host), `UV_THREADPOOL_SIZE=16` | 27.2/s | 8.2 s p50 | 4.6 s | 140 % | 2.5 s |

Login capacity is **about 40/s**, bounded by scrypt (N=16384) on 4 cores. The side effect matters
more than the ceiling. scrypt runs on the libuv thread pool, and so does every `sqlite3` query. A
login storm therefore starves the database: `/auth/me` is one indexed SELECT plus one UPDATE, yet
its p50 rose to 2.4 s, and chat stalls with it (bottleneck #6). No request failed; everything
queued.

### (c) History pagination + search (2,000-user dataset, 10k messages)

| Offered iterations/s (≈3.3 requests each) | Achieved req/s | History page p50 / p95 / p99 | Search p50 / p95 | `sql_busy` |
|---|---|---|---|---|
| 40 | 132 | 14 / 274 / 385 ms | 31 / 436 ms | 0.80 |
| 50 | 133 (172 dropped) | 761 / 1,264 / 1,534 ms | 1,275 / 2,009 ms | ≈1.0 |
| 80 | 128 (890 dropped) | 1,910 / 4,504 / 5,158 ms | 2,892 / 6,190 ms | 0.98 |

Read ceiling is about **130 requests/s** in total. Each history page costs 10.5 statements: 2 for
the session (including a write), 5 for the permission check, the page query at about 2.3 ms, and
attachments and reactions. Server CPU was only 76–81 %; the serialised connection is again the
limit.

### (d) Small image uploads + message with the attachment (2,000-user dataset, 200-member guilds)

| Offered | Achieved | Upload p50 / p95 / p99 | Post-with-attachment p50 / p95 | Statements |
|---|---|---|---|---|
| 10/s | 3.6/s (150 dropped) | 190 / 1,166 / 1,682 ms | **15.0 s / 18.8 s** | 187,544 (≈1,240 per message) |

The upload itself is fine: multer, sha256, sharp variants and blurhash take about 190 ms at p50.
The message that references the upload is not. Posting into a 200-member guild costs about 1,240
statements, so the combined flow is capped at about 4/s.

### CPU profile: steady chat, 500 users (`node --cpu-prof`, 90 s)

`node scripts/load/cpuprofile-top.mjs CPU.*.cpuprofile` output:

- The main thread was busy **39 % of wall time**. The process is waiting on I/O, not computing.
- By file, as a share of busy time:
  - `(program)` 50 %: native and V8 work not attributed to JS, mostly the libuv/sqlite glue.
  - `(native)` 15 %, almost all of it `writev`: websocket frame writes.
  - `sqlite3/lib/sqlite3.js` 8 %.
  - GC 5.8 %.
  - `probe.mjs` 4 % (instrumentation overhead; now reduced by caching SQL normalisation).
  - engine.io, socket.io-adapter and socket.io-parser about 1 % each.
  - `db.js` 1.1 %. `services/messages.js` 0.7 %. `services/guilds.js` 0.3 %.
- By inclusive time: `BroadcastOperator.emit` → `in-memory-adapter.broadcast` → engine.io
  `flush`/`sendFrame` → `writev` accounts for **16 % of busy time**. Almost all of it comes from
  the `identify` handler (`realtime.js:85`, 6.3 %) broadcasting `presence_updated` to every socket.
  Application JS is under 2 %: permission maths, hydrate and JSON shaping are **not** hot.

Conclusion: faster JavaScript won't help. What will help is fewer database round trips per
message, not serialising every statement, and not broadcasting presence to everyone.

### PostgreSQL

A PostgreSQL server was reachable at `postgres://localhost:55432`, but the branch merged here has no
`DATABASE_URL` support: `db.js` is SQLite-only. That run was therefore skipped. Once the Postgres
adapter lands, rerun `run-suite.sh` with `DATABASE_URL` exported; `start-server.sh` passes the
environment through. Expect the per-member statement count (#1) to dominate there as well, because
every awaited round trip costs about 0.1–0.3 ms over TCP. A connection pool removes #3, but not #1.

---

## 3. Bottlenecks and fixes, in priority order

The numbered list below is the priority order. Expected impact figures come from the measured
statement counts and service times.

### 1. Unread fan-out runs a permission check and an upsert for every guild member on every message
`services/messages.js:642-676` (`bumpUnreadCounters`), called from `createMessage` at `:583`.

For each member of the guild (online or not) the code awaits `canInChannel` (5 queries: channel,
server, member, roles, overwrites; see #2) and then an `INSERT … ON CONFLICT` into `read_states`.
All of it runs serially, outside the transaction. That is about 6 statements × members per
message: 326 statements for 51 members and 1,240 for 201. It sets both the throughput ceiling
(about 4,000–5,000 statements/s ÷ 6·members) and the latency floor, because the round trips run
one after another.

**Fix:** stop storing per-member unread rows. Compute unread status the way Discord does: a
channel is unread when `channels.last_message_id > read_states.last_read_message_id`, and
`createMessage` already updates `last_message_id`. Write `read_states`/`notifications` rows only
for users actually mentioned (and for `@everyone`/`@here`/role mentions, as one set-based
`INSERT … SELECT` over `server_members`/`member_roles`). Compute the "who can view" audience once
per role set rather than per member (see #2); for a channel without member-level overwrites it is a
single role-set test. **Expected impact:** 326 → about 20 statements per message in 50-member
guilds and 1,240 → about 20 in 200-member guilds, which is **15–60× the chat throughput**. Ack
latency stops growing with guild size.

### 2. Permission resolution: 5 uncached queries on every check
`services/access.js:24-84` (`assertChannelAccess` / `canInChannel`) → `services/guilds.js:29-90`
(`resolvePermissions`).

Every `send_message`, `join_channel`, `join_server`, history page and search result channel
repeats the same queries: `channels`, `servers`, `server_members`, `member_roles⋈roles`,
`channel_overwrites`. These are the top 5 statements by count in every scenario.

**Fix:** keep an in-process cache of guild structure: roles, channel overwrites, the owner, and
each member's role ids. Invalidate on the existing mutation paths, which already call
`revalidateRooms` and `emitToChannelViewers`, by bumping a per-guild version on role, overwrite,
member or timeout changes. Resolve permissions in memory. **Expected impact:** about −5
statements on each of the paths above. History pages go from 10.5 to about 5 statements (roughly
2× read throughput), and it is a prerequisite for making #1 cheap.

### 3. One SQLite connection in `db.serialize()` mode: every statement is a thread-pool round trip, one at a time
`db.js:412` (`db.serialize()`), plus the helpers at `db.js:416-437`.

Reads and writes, from every request and socket, go through a single queue. Each statement waits
for the previous one to finish and for its callback to run on the main thread. As a result
`sql_busy` reaches 1.0 at only about 1,300 statements/s on the history mix and about 4,000–9,000/s
on point lookups, while CPU stays below one core. Main-thread work such as a big broadcast also
stalls the database pipeline: the `SELECT … FROM users` after `setPresence` shows 8–20 ms of
"service time", which is really the `io.emit` to 2,000 sockets. Statements are never cached as
prepared statements either.

**Fix, in order of effort:**
- **(a)** Drop the global `serialize()`. Transactions are already serialised by `transaction()`'s
  own queue. Use separate read-only connections (WAL allows concurrent readers) for `getQuery` and
  `allQuery` outside transactions.
- **(b)** Switch to `better-sqlite3`: synchronous, cached prepared statements, about 5–20 µs per
  point query instead of 250–500 µs. Keep writes on one connection.
- **(c)** Use the PostgreSQL adapter with a pool.

**Expected impact:** (a) about 2–3× read throughput; (b) about 10× more statements/s and much lower
per-message latency, even before #1.

### 4. Every authenticated request writes to `sessions`
`lib/auth.js:97-116` (`resolveSession`): a SELECT plus `UPDATE sessions SET last_seen_at` for every
HTTP request and every socket `identify`.

On the read path that is 2 of the 10.5 statements, one of them a write that takes the WAL write
lock. **Fix:** cache resolved sessions in memory for 30–60 s, keyed by token hash, and invalidate
on revoke or logout. Throttle `last_seen_at` to at most once per 5 minutes per session.
**Expected impact:** −2 statements and −1 write per request, about 20 % more read throughput. It
also removes write contention with chat.

### 5. Presence is broadcast to every connected socket: O(N²) on connect, disconnect and reconnect
`realtime.js:113` (`io.emit('presence_updated')` on identify), `realtime.js:551` (on disconnect),
and `realtime.js:271` (`update_presence`). Each identify also runs 4 statements
(`realtime.js:110-115`: status select, `setPresence` = UPDATE + SELECT, `touchLastSeen`), and each
disconnect runs about 5 (`:530-551`).

In the 1,000-user reconnect storm this produced 2.5 M events and took 42.8 s. At 2,000 users it
produced 6.6 M events and had not recovered after 71 s. Broadcasting accounts for 16 % of CPU time
in the profile. **Fix:**
- Send presence only to rooms that care: the guild rooms the user belongs to, plus a
  `friends-of-<id>` room.
- Coalesce presence changes into one batched `presence_bulk` event about every 1 s.
- Skip the DB write when the status does not actually change. On reconnect it goes offline →
  online inside the same second.
- Debounce the offline transition by a few seconds so a quick reconnect emits nothing.

**Expected impact:** a reconnect storm becomes O(N × guild size / batching). At 1,000 users that is
about 50× fewer events, with recovery bounded by #3/#4 rather than broadcasting: **seconds instead
of 40 s or more**.

### 6. scrypt shares the 4-thread libuv pool with every SQLite query
`lib/auth.js:30-60` (`hashPassword`/`verifyPassword` through `crypto.scrypt`). node-sqlite3 runs
queries on the same pool.

During a 40/s login storm the mean SQL caller wait was 2.7 s, and `/auth/me` p50 was 2.4 s. Chat
freezes along with it. **Fix:**
- Set `UV_THREADPOOL_SIZE=16` in the Dockerfile/compose file (measured under host noise: 21 → 27
  logins/s, caller wait 4.1 → 2.5 s).
- Better: run password hashing in a dedicated `worker_threads` pool with a concurrency cap, and
  return 503 with `Retry-After` when that queue is long.

**Expected impact:** DB latency no longer depends on login traffic. Login capacity remains
CPU-bound at about 40/s per 4 cores, which is expected for a memory-hard KDF.

### 7. `channel_activity` is emitted per member on every message
`realtime.js:728-731` calls `io.to('user-<id>').except(channelId).emit(...)` once per member of the
audience.

That is O(members) broadcast-operator allocations and room lookups for every message: 200 per
message in the 2,000-user dataset. **Fix:** emit once to the guild room with
`.except(channelId)`, since the payload has no per-user data. For private channels, emit to a
per-channel "viewers" role room. **Expected impact:** about −200 adapter operations per message at
200 members. The main-thread saving is small today, but it becomes significant once #1 is fixed.

### 8. `createMessage` fixed overhead: about 20 statements before and after the insert
`services/messages.js`:
- `:338` channel lookup, then `:364` `assertChannelAccess` (channel looked up again, plus 4).
- `:431` `resolveSenderContext` (reads the roles again).
- `:439` `automod.evaluate`, which runs `SELECT * FROM automod_rules` for every message at
  `services/automod.js:42`.
- `:414` nonce lookup.
- `:593` `getMessage` re-reads and re-hydrates the row it just wrote: a 7-way join plus
  attachments, reactions and polls.

**Fix:**
- Reuse the channel row and the permission result.
- Cache automod rules per guild, invalidated on rule changes.
- Make the nonce a unique-index `INSERT OR IGNORE`, since the unique index `idx_messages_nonce`
  already exists.
- Build the outgoing message from data already in memory, using the author and member rows that
  are already cached.

**Expected impact:** about 20 → 6 statements per message; about −1 ms of DB time per message.

### 9. No admission control or backpressure anywhere on the write path
`realtime.js:147-181` (`send_message`) and `server.js:690` (`POST /api/messages`).

When the database falls behind, work queues without bound. In the 500-user run messages were
still processed and fanned out 40–60 s later, after clients had given up waiting for the ack. The
SQL queue reached 5,881 and RSS grew. Clients retry with a fresh nonce, which multiplies the load.
**Fix:**
- Put a bounded concurrency limiter in front of `createMessage` (for example 32 in flight).
- Reject with `RETRY_LATER` when the wait queue is over a threshold, or when the oldest queued item
  is over about 5 s old.
- Drop fan-out for messages whose sender disconnected long ago.
- Expose queue depth in `/metrics`.

**Expected impact:** the server degrades gracefully and keeps p99 bounded for accepted messages,
instead of collapsing completely.

### 10. Rate-limit configuration blocks real traffic patterns
`lib/rateLimit.js:79-88` and `server.js:118`.

- `readRateLimit` (600 per minute per user) applies to all of `/api`, writes included, and cannot
  be changed via env. Seeding tripped it.
- `loginRateLimit` is a fixed 10 per 5 minutes per IP. An office NAT or a carrier-grade NAT hits it
  immediately after an outage (demonstrate with `SAME_IP=1`).
- `uploadRateLimit` is a fixed 30 per minute.
- Buckets live in process memory, so they do not survive a restart and are not shared across
  nodes.

**Fix:** add `RATE_LIMIT_READ_PER_MIN`, `RATE_LIMIT_LOGIN_PER_5MIN` and
`RATE_LIMIT_UPLOAD_PER_MIN` env settings. Key login limits on IP **and** username, which makes a
larger per-IP budget safe. Stop applying the read bucket to routes that already have a write
bucket.

### Smaller items (lower priority)

- **N+1 in `hydrate`:** `services/messages.js:165` awaits `getFile(row.file_id)` once per
  attachment row. Batch the file and variant lookups.
- **Search:** `services/messages.js:1107` runs `canInChannel` for each distinct channel in the
  results (5 queries each). This is cheap with #2. FTS5 trigram search held p95 at 436 ms under 40
  iterations/s, which is acceptable.
- **`/metrics` sorting:** it copies and sorts the durations array on every scrape
  (`lib/middleware.js:172`, `:211`). Keep a fixed histogram instead.
- **Synchronous filesystem call:** `routes/files.js:253` uses `fs.statSync` on the file download
  path. Switch to `fs.promises.stat`.
- **Invite accept response:** it returns the full guild detail, and its cost grows with guild size
  (p50 132 ms, p95 183 ms at 200 members). Return the slim payload and let the client lazy-load
  members.

### Suggested order of work

Do #1, #2 and #4 first. They are pure application changes, and together they take a message in a
200-member guild from about 1,240 statements to about 15. Then #5 (presence) and #9 (backpressure).
Then #3: replace the driver or finish the Postgres adapter. Rerun `run-suite.sh` after each step; the
`SQL calls ÷ messages` figure in `*.probe.txt` is the number to track.

---

## สรุปภาษาไทย

**วิธีทดสอบ:** ชุดทดสอบอยู่ที่ `scripts/load/` ใช้ k6 สำหรับ REST (login storm, อ่านประวัติข้อความและค้นหา, อัปโหลดรูป) และสคริปต์ Node (`socket-load.mjs` ใช้ socket.io-client บน worker threads) สำหรับ realtime จำลองผู้ใช้ที่เชื่อมต่อ เข้าร่วมกิลด์และห้อง พิมพ์ (typing) และส่งข้อความในอัตรา 1 ข้อความต่อ 10 วินาทีต่อคน วัดความหน่วงตั้งแต่ส่งจนผู้ใช้อื่นได้รับ (p50/p95/p99) และมี probe ที่โหลดเข้าเซิร์ฟเวอร์ด้วย `--import` (ไม่แก้โค้ดแอป) เพื่อเก็บ CPU, หน่วยความจำ, event-loop lag และสถิติ SQL ทุกคำสั่ง ข้อมูลทดสอบสร้างผ่าน API ลงฐานข้อมูลชั่วคราว

**ผลลัพธ์หลัก (SQLite, 4 vCPU, เครื่องที่ใช้ร่วมกับงานอื่น):**
- รองรับการแชทได้ราว **100 ผู้ใช้ที่แชทพร้อมกัน (~10 ข้อความ/วินาที) ในกิลด์ขนาด 50 คน** (p95 ≈ 1.4 วินาที ไม่มีข้อผิดพลาด) ที่ 200 คนขึ้นไปคิวงานโตไม่หยุด และที่ 500/1,000/2,000 คนระบบล่ม (ack timeout, ส่งข้อความได้ 0–6 ข้อความ/วินาที) ในกิลด์ขนาด 200 คน ส่งข้อความได้สูงสุดราว 4 ข้อความ/วินาทีทั้งระบบ
- การเชื่อมต่อค้างไว้ 2,000 socket ใช้หน่วยความจำ 250–390 MB แต่ **reconnect storm** ใช้เวลา 17.8 วินาที (500 คน), 42.8 วินาที (1,000 คน) และเกิน 71 วินาที (2,000 คน) เพราะ presence ถูกกระจายไปทุก socket (O(N²), 2.5–6.6 ล้าน event)
- Login ได้ราว 40 ครั้ง/วินาที (scrypt) แต่ระหว่าง login storm คำสั่ง SQL ต้องรอเฉลี่ย 2.7 วินาที เพราะ scrypt กับ sqlite3 ใช้ libuv thread pool (4 เธรด) ร่วมกัน
- อ่านประวัติข้อความและค้นหาได้ราว 130 คำขอ/วินาที
- อัปโหลดรูปเร็ว (p50 190 ms) แต่การโพสต์ข้อความพร้อมไฟล์ในกิลด์ 200 คนใช้เวลา 15 วินาที

**คอขวดสำคัญ:** CPU และ event loop ไม่ใช่ปัญหา (main thread ทำงานเพียง 39% ของเวลา) ปัญหาคือ **จำนวน round trip ไปฐานข้อมูลต่อข้อความ** และ **การรันคำสั่ง SQL ทีละคำสั่งบน connection เดียว**:
1. `bumpUnreadCounters` ตรวจสิทธิ์ (5 query) และ upsert `read_states` ให้สมาชิกกิลด์ทุกคนในทุกข้อความ (≈6 คำสั่งต่อสมาชิก: 326 คำสั่งต่อข้อความในกิลด์ 50 คน, 1,240 คำสั่งในกิลด์ 200 คน) → ควรคำนวณ unread จาก `last_message_id` แบบ Discord และเขียนแถวเฉพาะผู้ถูก mention คาดว่าเร็วขึ้น 15–60 เท่า
2. การคำนวณสิทธิ์ไม่มี cache (5 query ต่อครั้ง) → cache โครงสร้างกิลด์ในหน่วยความจำ
3. `db.serialize()` บน connection เดียว → แยก connection สำหรับอ่าน / เปลี่ยนเป็น better-sqlite3 / PostgreSQL pool
4. ทุก request เขียน `sessions.last_seen_at` → cache session และลดความถี่การเขียน
5. presence กระจายไปทุก socket → ส่งเฉพาะกิลด์หรือเพื่อน และรวมเป็น batch
6. scrypt แย่ง thread pool กับ SQLite → เพิ่ม `UV_THREADPOOL_SIZE` หรือแยก worker pool
7. `channel_activity` ส่งทีละคน → ส่งครั้งเดียวไปห้องกิลด์
8. `createMessage` มี query ซ้ำซ้อนราว 20 คำสั่ง (automod rules, ตรวจ nonce, re-hydrate)
9. ไม่มี backpressure → งานค้างไม่จำกัดและส่งข้อความถึงผู้รับช้า 40–60 วินาที
10. rate limit บางตัวปรับผ่าน env ไม่ได้ และใช้ bucket อ่านกับการเขียนด้วย

PostgreSQL ยังไม่ได้ทดสอบ เพราะ branch ที่ merge มายังไม่รองรับ `DATABASE_URL`
