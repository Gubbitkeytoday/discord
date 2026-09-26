# Runbook: database down / unreachable

**Alerts:** `AntigravityDown`, `AntigravityDatabaseErrors`
**Impact:** every API call that touches the database fails (5xx); sockets stay
connected but sends fail. `/api/live` stays 200 on purpose — the process is fine,
so the orchestrator must not restart it in a loop.

## Triage (5 minutes)

```bash
curl -s https://<host>/api/ready | jq           # checks.database.ok, database.error
docker compose ps                               # is postgres/app running and healthy?
docker compose logs --since 10m app | jq -c 'select(.level=="error" or .level=="fatal")' | tail -20
```

`AntigravityDown` with **no** telemetry at all usually means the app process
itself is down (crash loop) — check `docker compose ps app` and
`docker compose logs --tail 100 app` first; a fatal line at boot names the cause
(bad config, migration failure, `SQLITE_CANTOPEN`, `ECONNREFUSED`).

## PostgreSQL (DATABASE_URL set)

1. **Is Postgres running?** `docker compose ps postgres` → if not healthy:
   `docker compose logs --tail 100 postgres`.
   - `No space left on device` → [disk-full.md](disk-full.md).
   - `database system is in recovery mode` / crash recovery → wait; it finishes on its own. Do not delete `pg-data`.
   - `FATAL: password authentication failed` → `.env` `POSTGRES_PASSWORD` changed after the volume was initialised; restore the old value (the volume keeps the first password).
2. **Connection exhaustion?** App logs `too many clients already` / pool `waiting` > 0 on the dashboard:
   ```bash
   docker compose exec postgres psql -U antigravity -c \
     "select state, count(*) from pg_stat_activity group by 1;"
   ```
   `max_connections` must exceed `DB_POOL_MAX` × app instances + admin headroom.
   Kill idle-in-transaction sessions older than a few minutes:
   `select pg_terminate_backend(pid) from pg_stat_activity where state='idle in transaction' and now()-state_change > interval '5 min';`
3. **Locks / long queries?**
   `select pid, now()-query_start as age, state, left(query,120) from pg_stat_activity where state<>'idle' order by age desc limit 10;`
   Cancel with `select pg_cancel_backend(<pid>);` (terminate only if cancel does not work).
4. Restart order once Postgres is healthy: nothing — the pool reconnects on
   its own. If the app still reports errors after a minute, `docker compose restart app`.

## SQLite (no DATABASE_URL)

1. `SQLITE_BUSY` in logs → a long write or an external process (a backup copying
   the file with `cp`, a `sqlite3` shell) holds the lock. Stop it. Backups must
   use `npm run backup` (online backup API), never `cp` of a live file.
2. `SQLITE_FULL` / `disk I/O error` → [disk-full.md](disk-full.md).
3. `SQLITE_CORRUPT` / `database disk image is malformed` → stop the app, keep a
   copy of `discord.db*` (including `-wal` and `-shm`), then
   [restore-from-backup.md](restore-from-backup.md). Run
   `sqlite3 discord.db 'pragma integrity_check'` on the *copy* for the report.
4. `SQLITE_CANTOPEN` → the volume is not mounted or not writable by uid 65532
   (the image user): `docker compose exec app ls -ln /data`.

## After recovery

- `curl -s https://<host>/api/ready | jq .status` → `"ready"`.
- 5xx rate back to baseline on the dashboard for 15 minutes.
- If data may have been lost (restore, corruption), note the window and consider
  whether users must be told.
- Write the timeline; open follow-ups (alert fired late? missing metric?).
