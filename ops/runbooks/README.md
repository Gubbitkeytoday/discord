# Runbooks

One page per failure mode. Each alert in `ops/alerts/` links to one of these.
Start with **Triage** in the page, stop as soon as the service is healthy, and
write down what you did (time, command, result) as you go — it becomes the
incident report.

| Runbook | Alerts | Typical first signal |
| --- | --- | --- |
| [db-down.md](db-down.md) | AntigravityDown, AntigravityDatabaseErrors | `/api/ready` 503 with `checks.database.ok=false`, 5xx spike |
| [high-latency.md](high-latency.md) | AntigravityHighLatency, AntigravityHighErrorRate, AntigravityEventLoopLag, AntigravitySlowQueries, AntigravityDbPoolSaturated, AntigravityPoorLcp | slow UI, p95 > 1 s |
| [disk-full.md](disk-full.md) | AntigravityDiskLow, AntigravityDiskCritical | uploads fail, `SQLITE_FULL`, `/api/ready` disk `critical` |
| [turn-livekit.md](turn-livekit.md) | AntigravitySocketsDropped | "Can't connect" in voice, one-way audio |
| [restore-from-backup.md](restore-from-backup.md) | — | data loss, corrupted database, bad migration |
| [pdpa-breach-72h.md](pdpa-breach-72h.md) | — | suspected personal-data breach: **the 72-hour clock starts when you become aware** |

## Where to look

| What | Where |
| --- | --- |
| Is the process up? | `curl -fsS https://<host>/api/live` |
| Can it serve? (DB, Redis, disk) | `curl -s https://<host>/api/ready \| jq .checks` |
| Logs | `docker compose logs -f --since 15m app` (JSON; filter with `jq 'select(.level=="error")'`), or Grafana → Explore → Loki `{service_name="antigravity-discord"}` |
| One failing request | the `request_id` from the error body / `X-Request-Id` header: `docker compose logs app \| grep <request_id>`; with tracing on, the log line's `trace_id` opens the trace in Tempo |
| Metrics | Grafana → Dashboards → Antigravity → *Antigravity Discord — Overview*, or `curl -H "Authorization: Bearer $METRICS_TOKEN" https://<host>/metrics` |
| Errors with stack traces | the error tracker (GlitchTip/Sentry) when `SENTRY_DSN` is set; filter by tag `request_id` |

## Severity

- **page** — users are affected now; act immediately, any hour.
- **ticket** — degradation or a trend toward an outage; act the next working day.

Declaring an incident: one person is the incident lead (decides), one does the
hands-on work, and one writes the timeline. On a small team that may be the same
person — the timeline still gets written.
