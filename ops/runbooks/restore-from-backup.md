# Runbook: restore from backup

Use when the database is corrupted, a migration or bad deploy damaged data, or
data was deleted by mistake. **A restore loses everything written after the
backup was taken** — decide explicitly that this is acceptable, and record the
window (backup time → restore time) for the incident report and, if personal
data was affected, for [pdpa-breach-72h.md](pdpa-breach-72h.md).

## 0. Before touching anything

1. Announce maintenance (status page / a message in the community).
2. **Preserve the current state**, even if broken — it is evidence and a
   fallback:
   ```bash
   docker compose stop app
   # SQLite: copy the whole data dir, including -wal/-shm
   docker run --rm -v <project>_app-data:/data -v "$PWD":/out busybox \
     tar czf /out/pre-restore-$(date +%Y%m%d-%H%M%S).tgz /data/discord.db /data/discord.db-wal /data/discord.db-shm
   # PostgreSQL
   docker compose exec -T postgres pg_dump -U antigravity -d antigravity --format=custom > pre-restore-$(date +%Y%m%d-%H%M%S).dump
   ```
3. Pick the backup: `docker compose run --rm app node scripts/backup.mjs list`
   (or your off-host copy). Verify it before restoring:
   `docker compose run --rm app node scripts/backup.mjs verify /backups/<file>`.

## 1. Restore the database

The app must be stopped (restore refuses otherwise without `--force`).

```bash
# SQLite (.db) or PostgreSQL (.dump) — the script picks the engine from the file
docker compose run --rm app node scripts/backup.mjs restore /backups/<file> --force
```

- PostgreSQL restores use `pg_restore --clean --single-transaction`: a failed
  restore changes nothing. The client tools must be at least the server's major
  version; if the app image lacks them, restore from the postgres container:
  ```bash
  docker compose exec -T postgres pg_restore -U antigravity -d antigravity --clean --if-exists --single-transaction < discord-<stamp>.dump
  ```
- A backup copied from off-host: `docker compose cp ./discord-<stamp>.db app:/backups/` first.

## 2. Restore uploaded files (if they were lost)

`backup.mjs create --files` mirrors `/data/uploads` into `/backups/uploads`
(incrementally — objects are content-addressed and never rewritten). Copy the
missing objects back without overwriting anything, with the image user's
ownership (uid 65532):

```bash
docker run --rm -v <project>_app-backups:/backups -v <project>_app-data:/data busybox \
  sh -c 'mkdir -p /data/uploads && cp -a -n /backups/uploads/. /data/uploads/ && chown -R 65532:65532 /data/uploads'
```

With object storage (S3/R2) the files were never on the host: restore the
bucket from its own versioning/replication if objects were deleted.

## 3. Start and verify

```bash
docker compose up -d app
curl -s https://<host>/api/ready | jq .status             # "ready"
curl -s https://<host>/api/health | jq '{schema_version, code_schema_version}'
docker compose exec app node scripts/storage.js verify     # DB rows ↔ stored objects
```

- `schema_version` older than `code_schema_version` is fine: migrations run at
  boot and bring it forward. **Newer** than the code means the backup came from
  a later release — deploy that release instead of downgrading.
- Log in, open a busy channel, send a message, upload an image.

## 4. After

- Tell users what window of messages/uploads is gone.
- Keep the pre-restore snapshot until you are sure it is not needed (it holds
  personal data: store it encrypted, delete it on a date you write down).
- Test restores regularly (quarterly): an untested backup is a hope, not a plan.
