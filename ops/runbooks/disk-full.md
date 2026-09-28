# Runbook: disk full

**Alerts:** `AntigravityDiskLow` (< 10% free, ticket), `AntigravityDiskCritical`
(< 3% free, page). `/api/ready` turns 503 (`checks.disk.status = "critical"`)
below `READY_DISK_MIN_FREE_MB` (default 256 MB) and reports `low` below
`READY_DISK_WARN_FREE_MB` (default 1 GB).

**Impact:** uploads fail; SQLite (and Postgres, if on the same disk) stops
accepting writes — messages cannot be sent. Reads keep working. Postgres may
shut down to protect itself when WAL cannot be written.

## Triage

```bash
df -h                                                    # which filesystem
docker system df                                         # images/containers/volumes
sudo du -xh --max-depth=2 /var/lib/docker/volumes | sort -h | tail -15
curl -s https://<host>/api/ready | jq .checks.disk
```

The `volume` label on `app_disk_free_bytes` says whether it is the upload
storage or the SQLite directory.

## Free space quickly (safe, in this order)

1. **Docker leftovers:** `docker image prune -a` (old image layers from
   rebuilds are the usual culprit) and `docker builder prune`.
2. **Container logs:** compose rotates them (`max-size: 10m`, `max-file: 5`);
   a service without that option can grow unbounded — `truncate -s 0` its
   `*-json.log` only as a last resort.
3. **Old backups on the same disk:** `docker compose exec app node scripts/backup.mjs prune --keep 3`
   — but **copy them off the host first** if they are the only copies.
4. **Upload garbage:** `docker compose exec app node scripts/storage.js gc`
   removes abandoned uploads and expired files (it also runs every 6 h).
5. **Postgres bloat** (only once there is room to work): `VACUUM (VERBOSE)` on
   the biggest tables; `VACUUM FULL` needs free space equal to the table and
   locks it — schedule it.
6. **Observability stack:** the `lgtm-data` volume keeps metrics/traces/logs;
   `docker compose --profile observability down` and remove the volume if it is
   the one that grew (you lose history, not app data).

Never delete files under `/data/uploads` by hand: the database references them
by storage key, and `storage:verify` will then report missing objects.

## After

- `/api/ready` → `ready`; send a test message and upload a file.
- If SQLite hit `SQLITE_FULL` mid-write: `pragma integrity_check` on a copy (see [db-down.md](db-down.md)).
- Durable fix: grow the volume, move uploads to object storage (DEPLOYMENT.md
  §7, S3/R2 — the disk check then covers only the database), lower
  per-user `storage_quota`, or keep backups on another disk/host.
