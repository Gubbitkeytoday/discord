#!/usr/bin/env bash
# ============================================================================
#  Start the app on a throwaway database for load testing.
#
#    scripts/load/start-server.sh <workdir> [--cpu-prof]
#
#  Everything lands in <workdir>: discord.db, uploads/, probe.jsonl, server.log,
#  server.pid and (with --cpu-prof) *.cpuprofile. Stop it with
#    kill -TERM "$(cat <workdir>/server.pid)"
#  (SIGTERM runs the graceful shutdown, which is also when the CPU profile and
#  the probe's SQL summary are written.)
# ============================================================================
set -euo pipefail

WORK="${1:?usage: start-server.sh <workdir> [--cpu-prof]}"
shift || true
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
mkdir -p "$WORK/uploads"
WORK="$(cd "$WORK" && pwd)"

NODE_FLAGS=(--import "$ROOT/scripts/load/probe.mjs")
if [[ "${1:-}" == "--cpu-prof" ]]; then
  NODE_FLAGS+=(--cpu-prof --cpu-prof-dir "$WORK")
fi

if curl -fsS "http://127.0.0.1:${PORT:-5750}/api/live" >/dev/null 2>&1; then
  echo "port ${PORT:-5750} is already serving something; stop it first" >&2
  exit 1
fi

cd "$ROOT"
env \
  PORT="${PORT:-5750}" \
  NODE_ENV="${NODE_ENV:-development}" \
  DB_PATH="$WORK/discord.db" \
  STORAGE_ROOT="$WORK/uploads" \
  SEED_DATABASE=0 \
  LOG_LEVEL="${LOG_LEVEL:-warn}" \
  LOG_FORMAT=json \
  RATE_LIMIT_WRITE_PER_MIN="${RATE_LIMIT_WRITE_PER_MIN:-1000000}" \
  RATE_LIMIT_REGISTER_PER_HOUR="${RATE_LIMIT_REGISTER_PER_HOUR:-1000000}" \
  UV_THREADPOOL_SIZE="${UV_THREADPOOL_SIZE:-4}" \
  PROBE_OUT="$WORK/probe.jsonl" \
  nohup node "${NODE_FLAGS[@]}" server.js >"$WORK/server.log" 2>&1 &
echo $! >"$WORK/server.pid"

for _ in $(seq 1 100); do
  if ! kill -0 "$(cat "$WORK/server.pid")" 2>/dev/null; then
    echo "server exited; see $WORK/server.log" >&2
    exit 1
  fi
  if curl -fsS "http://127.0.0.1:${PORT:-5750}/api/live" >/dev/null 2>&1; then
    echo "server up: pid $(cat "$WORK/server.pid") port ${PORT:-5750} workdir $WORK"
    exit 0
  fi
  sleep 0.2
done
echo "server did not come up; see $WORK/server.log" >&2
exit 1
