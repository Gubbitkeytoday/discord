#!/usr/bin/env bash
# ============================================================================
#  End-to-end run of every scenario against a fresh throwaway server.
#
#    scripts/load/run-suite.sh <workdir> [users=500] [chat_users=users]
#
#  Needs k6 on PATH (or K6=/path/to/k6). Results land in <workdir>/results:
#  one JSON per scenario (k6 --summary-export / socket-load --out) plus a
#  *.probe.txt with server CPU, RSS, event-loop lag and the SQL profile for
#  that scenario's window. Only the server this script started is stopped.
#
#  Tunables (env): LOGIN_RATE (60), READ_RATE (40), UPLOAD_RATE (5),
#  CHAT_RATE (0.1 msg/s/user), DURATION (45 s), HISTORY (200), WORKERS (4),
#  PORT (5750).
# ============================================================================
set -euo pipefail

WORK="${1:?usage: run-suite.sh <workdir> [users] [chat_users]}"
USERS="${2:-500}"
CHAT_USERS="${3:-$USERS}"
K6="${K6:-k6}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DUR="${DURATION:-45}"
export PORT="${PORT:-5750}"
URL="http://127.0.0.1:$PORT"

mkdir -p "$WORK/results"
WORK="$(cd "$WORK" && pwd)"
R="$WORK/results"
cd "$ROOT"

"$ROOT/scripts/load/start-server.sh" "$WORK"
PID="$(cat "$WORK/server.pid")"
trap 'kill -TERM "$PID" 2>/dev/null || true' EXIT

node scripts/load/seed.mjs --url "$URL" --users "$USERS" --guilds 10 --channels 2 \
  --history "${HISTORY:-200}" --out "$WORK/fixture.json"
node scripts/load/gen-images.mjs --dir "$WORK/img" --count 300 --w 200 --h 150

# Each scenario: reset the probe's SQL summary, run, dump it, report the window.
scenario() {
  local name="$1"; shift
  kill -USR2 "$PID"; sleep 0.3
  local start; start="$(date +%s%3N)"
  echo "=== $name"
  "$@" || echo "(scenario $name exited non-zero — thresholds crossed?)"
  local end; end="$(date +%s%3N)"
  kill -USR2 "$PID"; sleep 0.5
  node scripts/load/probe-report.mjs "$WORK/probe.jsonl" --from "$start" --to "$end" >"$R/$name.probe.txt"
}

scenario login "$K6" run -q -e FIXTURE="$WORK/fixture.json" -e MAX_RATE="${LOGIN_RATE:-60}" \
  -e STEPS=3 -e STEP_SECS=15 --summary-export "$R/login.json" scripts/load/k6/login-storm.js
scenario reads "$K6" run -q -e FIXTURE="$WORK/fixture.json" -e RATE="${READ_RATE:-40}" \
  -e DURATION="${DUR}s" --summary-export "$R/reads.json" scripts/load/k6/reads.js
scenario upload "$K6" run -q -e FIXTURE="$WORK/fixture.json" -e RATE="${UPLOAD_RATE:-5}" \
  -e DURATION="${DUR}s" -e IMG_DIR="$WORK/img" -e IMG_COUNT=300 \
  --summary-export "$R/upload.json" scripts/load/k6/upload.js
scenario steady node scripts/load/socket-load.mjs --fixture "$WORK/fixture.json" \
  --users "$CHAT_USERS" --rate "${CHAT_RATE:-0.1}" --duration "$DUR" --ramp 20 \
  --workers "${WORKERS:-4}" --probe "$WORK/probe.jsonl" --out "$R/steady.json"
scenario reconnect node scripts/load/socket-load.mjs --fixture "$WORK/fixture.json" \
  --users "$USERS" --mode reconnect --rate 0.002 --warmup 10 --settle 5 --refetch \
  --ramp 20 --workers "${WORKERS:-4}" --probe "$WORK/probe.jsonl" --out "$R/reconnect.json"

echo "results in $R"
