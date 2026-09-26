#!/bin/sh
# ============================================================================
#  Backup / restore for the docker compose stack (PostgreSQL or SQLite).
#
#    scripts/ops/docker-backup.sh backup  [DIR]        DIR default: ./backups
#    scripts/ops/docker-backup.sh verify  DIR/<stamp>
#    scripts/ops/docker-backup.sh restore DIR/<stamp>  (stops the app, restores, starts it)
#    scripts/ops/docker-backup.sh drill   [DIR]        backup + verify into a scratch
#                                                     database: proves the dump restores
#
#  Run from the directory holding docker-compose.yml. Each backup is a folder
#  DIR/<YYYYmmdd-HHMMSS>/ with
#    discord.dump   pg_dump --format=custom (PostgreSQL, the compose default), or
#    discord.db     a consistent SQLite snapshot (DATABASE_URL= empty)
#    uploads/       every uploaded file (content-addressed: safe to re-copy)
#
#  Why not `docker compose exec app node scripts/backup.mjs` with PostgreSQL:
#  the app image is distroless and has no pg_dump. The postgres container
#  always has tools matching the server, so the dump runs there and streams
#  to this host. Nothing here needs a shell inside the app container.
#
#  Environment: COMPOSE (default "docker compose"), APP_SERVICE (app),
#  PG_SERVICE (postgres), PG_USER / PG_DB (antigravity), APP_UID (1000).
#  Copy backups off this machine: a backup on the same disk is not a backup.
# ============================================================================
set -eu

COMPOSE=${COMPOSE:-docker compose}
APP=${APP_SERVICE:-app}
PG=${PG_SERVICE:-postgres}
PG_USER=${PG_USER:-antigravity}
PG_DB=${PG_DB:-antigravity}
APP_UID=${APP_UID:-1000}

say() { printf '%s\n' "$*" >&2; }
die() { say "error: $*"; exit 1; }
abspath() { (cd "$1" && pwd); }

# Which engine the running app uses: DATABASE_URL set → postgres.
engine() {
  if [ -n "${ENGINE:-}" ]; then echo "$ENGINE"; return; fi
  $COMPOSE exec -T "$APP" node -e "process.stdout.write(process.env.DATABASE_URL ? 'postgres' : 'sqlite')"
}

backup() {
  root=${1:-./backups}
  stamp=$(date +%Y%m%d-%H%M%S)
  dir="$root/$stamp"
  mkdir -p "$dir"
  kind=$(engine)
  say "backing up ($kind) into $dir"
  if [ "$kind" = postgres ]; then
    # Consistent snapshot without blocking writers; custom format is compressed
    # and restorable table by table.
    $COMPOSE exec -T "$PG" pg_dump -U "$PG_USER" -d "$PG_DB" --format=custom --no-owner --no-privileges \
      > "$dir/discord.dump.partial"
    mv "$dir/discord.dump.partial" "$dir/discord.dump"
  else
    # VACUUM INTO inside the app container (the file is live), then copy out.
    name=$($COMPOSE exec -T "$APP" node scripts/backup.mjs create --out /backups | sed -n 's/.*\(discord-[0-9-]*\.db\).*/\1/p' | tail -n 1)
    [ -n "$name" ] || die "could not find the snapshot name in backup.mjs output"
    $COMPOSE cp "$APP:/backups/$name" "$dir/discord.db"
  fi
  # docker compose cp reads the container filesystem directly: no shell or tar
  # needed inside the (distroless) image, and it works on a stopped container.
  $COMPOSE cp "$APP:/data/uploads" "$dir/uploads"
  say "done: $dir ($(du -sh "$dir" | cut -f1))"
  echo "$dir"
}

verify() {
  dir=${1:?usage: verify DIR/<stamp>}
  [ -d "$dir" ] || die "$dir is not a backup folder"
  if [ -f "$dir/discord.dump" ]; then
    # pg_restore --list reads the whole table of contents: a truncated or
    # corrupt dump fails here.
    count=$($COMPOSE exec -T "$PG" pg_restore --list < "$dir/discord.dump" | grep -c ' TABLE DATA ' || true)
    [ "$count" -gt 0 ] || die "$dir/discord.dump has no table data"
    say "ok: $dir/discord.dump lists $count tables with data"
  elif [ -f "$dir/discord.db" ]; then
    abs=$(abspath "$dir")
    $COMPOSE run --rm --no-deps -v "$abs:/restore:ro" "$APP" node scripts/backup.mjs verify /restore/discord.db
  else
    die "$dir has neither discord.dump nor discord.db"
  fi
  [ -d "$dir/uploads" ] && say "ok: $(find "$dir/uploads" -type f | wc -l | tr -d ' ') uploaded files"
  return 0
}

restore() {
  dir=${1:?usage: restore DIR/<stamp>}
  [ -d "$dir" ] || die "$dir is not a backup folder"
  abs=$(abspath "$dir")
  say "restoring $dir — the app is stopped meanwhile"
  # app-2 exists only with the scale profile; stopping a missing service is a no-op.
  $COMPOSE stop "$APP" app-2 2>/dev/null || $COMPOSE stop "$APP"
  if [ -f "$dir/discord.dump" ]; then
    # --clean --if-exists drops what the dump recreates; one transaction, so a
    # failed restore leaves the database exactly as it was.
    $COMPOSE exec -T "$PG" pg_restore -U "$PG_USER" -d "$PG_DB" --clean --if-exists \
      --no-owner --no-privileges --single-transaction --exit-on-error < "$dir/discord.dump"
  elif [ -f "$dir/discord.db" ]; then
    $COMPOSE run --rm --no-deps -v "$abs:/restore:ro" "$APP" node scripts/backup.mjs restore /restore/discord.db --force
  else
    die "$dir has neither discord.dump nor discord.db"
  fi
  if [ -d "$dir/uploads" ]; then
    # Copy with the app image's node as root, then hand the files to the app
    # user: `docker cp` would leave them owned by root (or your host uid).
    $COMPOSE run --rm --no-deps --user 0:0 -v "$abs/uploads:/restore:ro" --entrypoint node "$APP" -e "
      const fs = require('fs'), path = require('path');
      fs.cpSync('/restore', '/data/uploads', { recursive: true, force: true });
      const own = (p) => { fs.lchownSync(p, $APP_UID, $APP_UID);
        if (fs.lstatSync(p).isDirectory()) for (const e of fs.readdirSync(p)) own(path.join(p, e)); };
      own('/data/uploads');
      console.log('uploads restored');"
  fi
  $COMPOSE start "$APP"
  $COMPOSE start app-2 2>/dev/null || true
  say "restored from $dir; migrations (if any) run on this boot"
}

# Restore drill: take a backup, restore it into a throwaway database next to the
# real one, compare row counts, drop it. The live database is not touched.
drill() {
  dir=$(backup "${1:-./backups}")
  verify "$dir"
  if [ -f "$dir/discord.dump" ]; then
    scratch="drill_$(date +%s)"
    $COMPOSE exec -T "$PG" createdb -U "$PG_USER" "$scratch"
    trap '$COMPOSE exec -T "$PG" dropdb -U "$PG_USER" --if-exists "$scratch" >/dev/null 2>&1 || true' EXIT
    $COMPOSE exec -T "$PG" pg_restore -U "$PG_USER" -d "$scratch" --no-owner --no-privileges --exit-on-error < "$dir/discord.dump"
    q="SELECT (SELECT count(*) FROM users) || '/' || (SELECT count(*) FROM messages) || '/' || (SELECT max(version) FROM schema_migrations)"
    live=$($COMPOSE exec -T "$PG" psql -U "$PG_USER" -d "$PG_DB" -tAc "$q")
    copy=$($COMPOSE exec -T "$PG" psql -U "$PG_USER" -d "$scratch" -tAc "$q")
    say "users/messages/schema  live: $live   restored copy: $copy"
    [ "$copy" = "$live" ] || say "note: counts differ if people posted during the drill; the schema version must match"
  fi
  say "drill ok: $dir restores"
}

cmd=${1:-}
[ $# -gt 0 ] && shift
case "$cmd" in
  backup) backup "$@" >/dev/null ;;
  verify) verify "$@" ;;
  restore) restore "$@" ;;
  drill) drill "$@" ;;
  *) sed -n '3,12p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
