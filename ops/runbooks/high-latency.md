# Runbook: high latency / error rate

**Alerts:** `AntigravityHighLatency` (p95 > 1 s), `AntigravityHighErrorRate`
(> 5% 5xx), `AntigravityEventLoopLag` (> 200 ms), `AntigravitySlowQueries`
(DB p95 > 250 ms), `AntigravityDbPoolSaturated`, `AntigravityPoorLcp`,
`AntigravityNotificationFailures`.

The app is one Node.js process: anything that blocks the event loop delays
*every* request and socket event at once. So the first question is always
"loop, database, or something outside?"

## Triage

Open the **Antigravity Discord — Overview** dashboard and compare these panels
over the same window:

| Looks like | Probably | Go to |
| --- | --- | --- |
| Event-loop lag high, DB p95 normal | CPU-bound work in the process | [A](#a-event-loop-blocked) |
| DB p95 high or pool `waiting` > 0 | database | [B](#b-database-slow) |
| One route dominates "p95 — slowest routes" | a specific endpoint | [C](#c-one-route) |
| 5xx high, latency normal | a failing dependency or a bug | [D](#d-errors-without-latency) |
| Only browser LCP poor, server fine | client bundle / network / CDN | [E](#e-browser-only) |

With tracing on (`OTEL_EXPORTER_OTLP_ENDPOINT`), Grafana → Explore → Tempo →
search `service.name=antigravity-discord`, `duration > 1s` shows where a slow
request spent its time (HTTP → route handler → each `SELECT …` span).

## A. Event loop blocked

- `docker stats` — CPU at 100% of one core? Memory near the limit (GC thrash)?
- Recent deploy? Roll back first, investigate second (`git checkout <prev>` + `docker compose up -d --build`).
- Image processing without `sharp` falls back to slower paths — the boot log says `sharp detected` or not.
- Big fan-outs: a message to a server with many online members emits to all of them; check `app_socket_events_total` for a spike of one event (a client bug in a loop, or abuse). Rate limits apply per user; block an abusive account via the admin tools.
- Take a CPU profile for 30 s without restarting: `docker compose exec app node -e "process.kill(1,'SIGUSR1')"` is **not** available in the distroless image; instead run a second instance with `--cpu-prof` against a copy, or enable Pyroscope in the observability stack.

## B. Database slow

PostgreSQL:
```bash
docker compose exec postgres psql -U antigravity -c "select now()-query_start age, state, wait_event_type, left(query,120) from pg_stat_activity where state<>'idle' order by 1 desc limit 15;"
docker compose logs --since 30m postgres | grep 'duration:'    # log_min_duration_statement=1000
```
- Lock waits (`wait_event_type = Lock`) → find the blocker: `select pg_blocking_pids(<pid>);`.
- Pool `waiting` > 0 while Postgres is idle → the pool is too small: raise `DB_POOL_MAX` (and `max_connections`). Busy → the queries are slow, not the pool.
- After a bulk import or restore: `ANALYZE;`.
- Disk nearly full or I/O saturated (`iostat -x 5`) → [disk-full.md](disk-full.md).

SQLite: writes are serialised. Sustained write load (big imports, a bot flooding
messages) queues everything behind it. Stop the source; long-term, move to
PostgreSQL (DEPLOYMENT.md §11).

## C. One route

Look up that route's handler in `server.js` / `routes/`. Common causes: a search
with a very short term (`/api/search`) scanning a large table, an export/data
request (`dataRights`), a link-preview fetch to a slow third-party host (runs in
the background, but check `linkEmbeds`). A per-route rate limit or a query fix
is the durable answer; a restart is not.

## D. Errors without latency

- Logs: `docker compose logs --since 15m app | jq -c 'select(.level=="error") | {msg, err: .err.message, path: .path, request_id}' | sort | uniq -c | sort -rn | head`
- Error tracker: new issue since the last release (`release` = git sha)?
- S3/object storage, SMTP, TURN are external: their failures show as errors on the routes that use them.
- Notification failures (`app_push_sends_total{result!="ok"}`): the push service (web push / e-mail) is failing or subscriptions expired; expired ones are pruned automatically, a provider outage is not ours to fix — note it and watch.

## E. Browser only

LCP/INP come from real browsers (sampled by `WEB_VITALS_SAMPLE_RATE`). Server
fine + LCP poor → the proxy is not compressing or caching (Caddy config), a
large new chunk shipped (check `npm run build` output sizes vs the last
release), or users are on slow networks (compare by time of day). INP poor →
main-thread work in the client after an update.

## Mitigations that are always safe

- Roll back to the previous image/commit.
- `docker compose restart app` — drains gracefully; clears in-memory state (presence, typing, rate-limit buckets).
- Scale the VM up (the app is single-node by design; see DEPLOYMENT.md "Scaling").
