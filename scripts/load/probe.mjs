// ============================================================================
//  Server-side probe, preloaded into the app process without touching app code:
//
//    PROBE_OUT=/tmp/probe.jsonl node --import ./scripts/load/probe.mjs server.js
//
//  Every PROBE_INTERVAL_MS (default 1000) it appends one JSON line with:
//    - event-loop delay (p50/p99/max, ms) and event-loop utilisation
//    - process CPU % (user+system, of one core), RSS / heap
//    - SQLite calls per second, mean/p99 call latency (queue wait + execution;
//      db.js serialises every statement on one connection, so this is the time a
//      caller actually waits), the in-flight queue depth, and sql_busy — the
//      share of wall time the one connection spent servicing statements
//      (≈1.0 means the database connection is the bottleneck)
//  On exit it appends a {"type":"summary"} line with the top SQL shapes by
//  count and by total time — the cheapest possible "query profiler".
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

const OUT = process.env.PROBE_OUT;
const INTERVAL = Number(process.env.PROBE_INTERVAL_MS) || 1000;

if (OUT) {
  const require = createRequire(path.join(process.cwd(), 'package.json'));
  const sqlite3 = require('sqlite3');

  // --- SQLite instrumentation ------------------------------------------------
  const shapes = new Map();          // normalised sql -> { n, ms, exec }
  let execMs = 0; let lastDone = 0;
  let calls = 0; let callMs = 0; let inflight = 0; let maxInflight = 0;
  let lat = [];

  const normCache = new Map();
  const normalise = (sql) => {
    let key = normCache.get(sql);
    if (key === undefined) {
      key = String(sql).replace(/\s+/g, ' ').replace(/\?(, ?\?)+/g, '?…').trim().slice(0, 110);
      if (normCache.size < 5000) normCache.set(sql, key);
    }
    return key;
  };

  for (const method of ['run', 'get', 'all', 'exec']) {
    const orig = sqlite3.Database.prototype[method];
    sqlite3.Database.prototype[method] = function patched(sql, ...rest) {
      const cbIndex = rest.findIndex((a) => typeof a === 'function');
      if (cbIndex === -1) return orig.call(this, sql, ...rest);
      const cb = rest[cbIndex];
      const started = performance.now();
      inflight += 1; if (inflight > maxInflight) maxInflight = inflight;
      rest[cbIndex] = function wrapped(...a) {
        const done = performance.now();
        const ms = done - started;
        // db.js runs the connection in serialize mode, so statements execute
        // one after another: a statement's service time is the gap since the
        // previous completion (or since it was issued, if the queue was idle).
        // sqlite's own profile hook only has 1 ms resolution — useless here.
        const service = done - Math.max(started, lastDone);
        lastDone = done;
        inflight -= 1; calls += 1; callMs += ms; execMs += service; lat.push(ms);
        const key = normalise(sql);
        const s = shapes.get(key) ?? { n: 0, ms: 0, exec: 0 };
        s.n += 1; s.ms += ms; s.exec += service; shapes.set(key, s);
        return cb.apply(this, a);
      };
      return orig.call(this, sql, ...rest);
    };
  }

  // --- event loop / cpu / memory ---------------------------------------------
  // The histogram records the timer interval itself, so the lag is the value
  // minus the sampling resolution.
  const RESOLUTION_MS = 10;
  const eld = monitorEventLoopDelay({ resolution: RESOLUTION_MS });
  const lagMs = (ns) => +Math.max(0, ns / 1e6 - RESOLUTION_MS).toFixed(2);
  eld.enable();
  let lastElu = performance.eventLoopUtilization();
  let lastCpu = process.cpuUsage();
  let lastT = performance.now();

  const fd = fs.openSync(OUT, 'a');
  const write = (obj) => fs.writeSync(fd, `${JSON.stringify(obj)}\n`);

  const tick = setInterval(() => {
    const now = performance.now();
    const dt = (now - lastT) / 1000;
    const elu = performance.eventLoopUtilization(lastElu);
    const cpu = process.cpuUsage(lastCpu);
    const mem = process.memoryUsage();
    lat.sort((a, b) => a - b);
    write({
      t: Date.now(),
      loop_p50_ms: lagMs(eld.percentile(50)),
      loop_p99_ms: lagMs(eld.percentile(99)),
      loop_max_ms: lagMs(eld.max),
      elu: +elu.utilization.toFixed(3),
      cpu_pct: +(((cpu.user + cpu.system) / 1e6 / dt) * 100).toFixed(1),
      rss_mb: +(mem.rss / 1048576).toFixed(1),
      heap_mb: +(mem.heapUsed / 1048576).toFixed(1),
      sql_per_s: Math.round(calls / dt),
      sql_mean_ms: calls ? +(callMs / calls).toFixed(2) : 0,
      sql_p99_ms: lat.length ? +lat[Math.floor(lat.length * 0.99)].toFixed(1) : 0,
      sql_queue_max: maxInflight,
      // share of wall time the single connection spent executing statements
      sql_busy: +(execMs / (dt * 1000)).toFixed(3)
    });
    eld.reset();
    lastElu = performance.eventLoopUtilization(); lastCpu = process.cpuUsage(); lastT = now;
    calls = 0; callMs = 0; execMs = 0; lat = []; maxInflight = inflight;
  }, INTERVAL);
  tick.unref();

  const summary = () => {
    const all = [...shapes.entries()].map(([sql, s]) => ({
      sql, n: s.n, total_ms: Math.round(s.ms), exec_ms: Math.round(s.exec)
    }));
    write({
      type: 'summary',
      t: Date.now(),
      total_calls: all.reduce((a, r) => a + r.n, 0),
      total_exec_ms: all.reduce((a, r) => a + r.exec_ms, 0),
      top_by_count: [...all].sort((a, b) => b.n - a.n).slice(0, 25),
      top_by_time: [...all].sort((a, b) => b.total_ms - a.total_ms).slice(0, 25),
      top_by_exec: [...all].sort((a, b) => b.exec_ms - a.exec_ms).slice(0, 25)
    });
  };
  process.on('exit', summary);
  // SIGUSR2 dumps a summary without stopping the server (between scenarios).
  process.on('SIGUSR2', () => { summary(); shapes.clear(); });
}
