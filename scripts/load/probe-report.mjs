#!/usr/bin/env node
// Summarise a probe.jsonl written by scripts/load/probe.mjs.
//
//   node scripts/load/probe-report.mjs <probe.jsonl> [--from ms] [--to ms] [--top 15]
//
// Prints per-window resource stats and the most recent SQL summary (send the
// server SIGUSR2 to emit one without stopping it).
import fs from 'node:fs';
import { parseArgs, round } from './lib.mjs';

const file = process.argv[2];
const args = parseArgs(process.argv.slice(3), { from: 0, to: 0, top: 15 });
const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const ticks = lines.filter((l) => l.t && (!args.from || l.t >= args.from) && (!args.to || l.t <= args.to));
const summary = lines.filter((l) => l.type === 'summary').at(-1);

if (ticks.length) {
  const avg = (k) => round(ticks.reduce((a, r) => a + r[k], 0) / ticks.length);
  const max = (k) => round(Math.max(...ticks.map((r) => r[k])));
  console.table({
    cpu_pct: { avg: avg('cpu_pct'), max: max('cpu_pct') },
    elu: { avg: avg('elu'), max: max('elu') },
    rss_mb: { avg: avg('rss_mb'), max: max('rss_mb') },
    loop_p99_ms: { avg: avg('loop_p99_ms'), max: max('loop_p99_ms') },
    loop_max_ms: { avg: avg('loop_max_ms'), max: max('loop_max_ms') },
    sql_per_s: { avg: avg('sql_per_s'), max: max('sql_per_s') },
    sql_mean_ms: { avg: avg('sql_mean_ms'), max: max('sql_mean_ms') },
    sql_queue_max: { avg: avg('sql_queue_max'), max: max('sql_queue_max') },
    sql_busy: { avg: round(ticks.reduce((a, r) => a + (r.sql_busy ?? 0), 0) / ticks.length, 3), max: Math.max(...ticks.map((r) => r.sql_busy ?? 0)) }
  });
}
if (summary) {
  console.log(`\nSQL calls: ${summary.total_calls}, total execution ${summary.total_exec_ms} ms`);
  console.log('Top SQL by count:');
  for (const r of summary.top_by_count.slice(0, args.top)) console.log(String(r.n).padStart(9), ' ', r.sql);
  console.log('\nTop SQL by estimated service time (ms):');
  for (const r of summary.top_by_exec ?? []) {
    if (summary.top_by_exec.indexOf(r) >= args.top) break;
    console.log(String(r.exec_ms).padStart(9), String(r.n).padStart(8), ' ', r.sql);
  }
  console.log('\nTop SQL by caller wait (ms, queue + execution):');
  for (const r of summary.top_by_time.slice(0, args.top)) console.log(String(r.total_ms).padStart(9), ' ', r.sql);
}
