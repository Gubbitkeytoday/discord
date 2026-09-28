#!/usr/bin/env node
// ============================================================================
//  Realtime load: N connected Socket.IO users chatting in their guilds.
//
//    node scripts/load/socket-load.mjs --fixture fixture.json --users 1000 \
//         --duration 60 --rate 0.1 --workers 4 [--mode reconnect] [--out r.json]
//
//  Each virtual user behaves like the SPA (src/App.jsx):
//    connect → identify {token} → join_server(guild) → join_channel(channel)
//  then, as a Poisson process at --rate messages/s, optionally emits
//  typing_start ~1.5 s before send_message (like a person typing).
//
//  Measured:
//    ack      send_message → ack (server write path: permission + insert +
//             unread fan-out + hydrate)
//    fanout   send → new_message received by every *other* viewer of the
//             channel (the latency people perceive); delivery ratio compares
//             deliveries received before the run ends against
//             sent × (viewers − 1) — below 1 means a backlog or drops
//    ready    connect → identified → both rooms joined
//  --mode reconnect: after --warmup seconds every socket drops at once and
//  reconnects spread over --storm-jitter ms (socket.io's own backoff is
//  0.5–1.5 s), optionally re-fetching history over REST (--refetch), as the SPA
//  does. Chat traffic keeps flowing during the storm. --storm-timeout (s,
//  default 180) bounds the wait for everyone to be back.
//
//  --probe <server probe.jsonl> summarises server CPU / RSS / event-loop lag /
//  SQL rate over the measurement window.
//
//  Clients are spread over --workers worker threads so the generator itself is
//  not the bottleneck; its own event-loop utilisation is reported (> 0.85
//  means the numbers are generator-bound, add workers or another machine).
// ============================================================================

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { io } from 'socket.io-client';
import { parseArgs, readJson, writeJson, Histogram, round, sleep, scrapeMetrics } from './lib.mjs';

const now = () => performance.timeOrigin + performance.now();

if (isMainThread) await main(); else await worker();

// ============================================================================
async function main() {
  const args = parseArgs(undefined, {
    fixture: 'fixture.json', url: '', users: 0, workers: 4, duration: 60, ramp: 20,
    rate: 0.1, typing: 0.6, mode: 'steady', warmup: 20, stormJitter: 1000, stormTimeout: 180, refetch: false,
    settle: 15, transport: 'websocket', out: '', probe: '', label: ''
  });
  const fx = readJson(args.fixture);
  const url = args.url || fx.url;
  const users = fx.users.slice(0, args.users || fx.users.length);
  const G = fx.guilds.length;

  // Spread each guild's members over its text channels.
  const viewers = new Map();
  const assigned = users.map((u, i) => {
    const guild = fx.guilds[u.guild];
    const channel = guild.channels[Math.floor(i / G) % guild.channels.length];
    viewers.set(channel, (viewers.get(channel) ?? 0) + 1);
    return { id: u.id, token: u.token, guild: guild.id, channel };
  });

  const W = Math.max(1, Math.min(args.workers, users.length));
  const slices = Array.from({ length: W }, (_, w) => assigned.filter((_, i) => i % W === w));
  console.log(`[main] ${users.length} users, ${G} guilds, ${viewers.size} channels `
    + `(~${Math.round(users.length / viewers.size)} viewers/channel), ${W} workers, mode=${args.mode}`);

  const workers = slices.map((slice, w) => new Worker(fileURLToPath(import.meta.url), {
    workerData: { w, url, slice, args: { ...args, ramp: args.ramp } }
  }));

  const state = workers.map(() => ({ ready: 0, final: null, prog: null }));
  let resolveAll; const allFinal = new Promise((r) => { resolveAll = r; });
  workers.forEach((wk, w) => {
    wk.on('message', (m) => {
      if (m.type === 'ready') state[w].ready = m.ready;
      if (m.type === 'progress') state[w].prog = m;
      if (m.type === 'final') { state[w].final = m; if (state.every((s) => s.final)) resolveAll(); }
    });
    wk.on('error', (e) => console.error(`[worker ${w}]`, e));
  });

  // --- connect phase -------------------------------------------------------
  const tConnect = Date.now();
  const deadline = tConnect + (args.ramp + 60) * 1000;
  while (Date.now() < deadline) {
    const ready = state.reduce((a, s) => a + s.ready, 0);
    if (ready >= users.length) break;
    await sleep(500);
  }
  const readyCount = state.reduce((a, s) => a + s.ready, 0);
  console.log(`[main] ${readyCount}/${users.length} ready after ${((Date.now() - tConnect) / 1000).toFixed(1)}s`);

  // --- measurement phase ---------------------------------------------------
  const tStart = Date.now();
  workers.forEach((wk) => wk.postMessage({ type: 'start' }));
  let stormAt = null; let allBackS = null; let stormBack = 0;
  const progress = setInterval(async () => {
    const p = state.map((s) => s.prog).filter(Boolean);
    const sum = (k) => p.reduce((a, x) => a + (x[k] ?? 0), 0);
    const m = await scrapeMetrics(url);
    console.log(`[t+${Math.round((Date.now() - tStart) / 1000)}s] ready ${sum('ready')} sent ${sum('sent')} `
      + `acked ${sum('acked')} err ${sum('errors')} recv ${sum('recv')} `
      + `fanout~mean ${round(sum('fanSum') / Math.max(1, sum('fanN')))}ms `
      + `srv sockets ${m?.app_socket_connections ?? '?'} rss ${m ? Math.round(m.process_resident_memory_bytes / 1048576) : '?'}MB`);
  }, 5000);

  if (args.mode === 'reconnect') {
    await sleep(args.warmup * 1000);
    stormAt = Date.now();
    console.log('[main] >>> reconnect storm: dropping every socket');
    workers.forEach((wk) => wk.postMessage({ type: 'storm' }));
    // Wait for everyone to come back (or --storm-timeout to run out).
    const stormDeadline = stormAt + args.stormTimeout * 1000;
    let back = 0;
    while (Date.now() < stormDeadline) {
      back = state.reduce((a, s) => a + (s.prog?.reconnected ?? 0), 0);
      if (back >= readyCount) break;
      await sleep(250);
    }
    stormBack = back;
    if (back >= readyCount) {
      allBackS = (Date.now() - stormAt) / 1000;
      console.log(`[main] all ${back} back after ${allBackS.toFixed(1)}s; settling ${args.settle}s`);
    } else {
      console.log(`[main] only ${back}/${readyCount} back after ${args.stormTimeout}s (timeout); settling ${args.settle}s`);
    }
    await sleep(args.settle * 1000);
  } else {
    await sleep(args.duration * 1000);
  }
  const tEnd = Date.now();
  workers.forEach((wk) => wk.postMessage({ type: 'stop' }));
  await allFinal;
  clearInterval(progress);
  await Promise.all(workers.map((wk) => wk.terminate()));

  // --- merge ---------------------------------------------------------------
  const H = { ack: new Histogram(), fanout: new Histogram(), ready: new Histogram(), reconnect: new Histogram(), refetch: new Histogram() };
  const C = {};
  const sentByChannel = new Map();
  let genElu = 0; let genLagMax = 0;
  for (const { final } of state) {
    for (const k of Object.keys(H)) H[k].merge(Histogram.from(final.hist[k]));
    for (const [k, v] of Object.entries(final.counters)) {
      if (typeof v === 'number') C[k] = (C[k] ?? 0) + v;
      else { C[k] ??= {}; for (const [kk, vv] of Object.entries(v)) C[k][kk] = (C[k][kk] ?? 0) + vv; }
    }
    for (const [ch, n] of final.sentByChannel) sentByChannel.set(ch, (sentByChannel.get(ch) ?? 0) + n);
    genElu += final.elu / state.length; genLagMax = Math.max(genLagMax, final.lagMax);
  }
  let expected = 0;
  for (const [ch, n] of sentByChannel) expected += n * ((viewers.get(ch) ?? 1) - 1);
  const secs = (tEnd - tStart) / 1000;

  const result = {
    label: args.label || `${args.mode}-${users.length}`,
    mode: args.mode, users: users.length, guilds: G, channels: viewers.size,
    rate_per_user: args.rate, duration_s: round(secs), workers: W,
    connected: readyCount,
    msgs_sent: C.sent ?? 0, msgs_acked: C.acked ?? 0,
    msgs_per_s: round((C.acked ?? 0) / secs),
    send_errors: C.errors ?? 0, error_codes: C.errorCodes ?? {},
    ack_timeouts: C.ackTimeouts ?? 0,
    deliveries: C.recv ?? 0, deliveries_expected: expected,
    delivery_ratio: expected ? round((C.recv ?? 0) / expected, 4) : null,
    deliveries_per_s: round((C.recv ?? 0) / secs),
    typing_events_recv: C.typingRecv ?? 0, presence_events_recv: C.presenceRecv ?? 0,
    channel_activity_recv: C.activityRecv ?? 0,
    unexpected_disconnects: C.dropped ?? 0, connect_errors: C.connectErrors ?? 0,
    latency_ms: {
      ack: H.ack.summary(), fanout: H.fanout.summary(), ready: H.ready.summary(),
      ...(args.mode === 'reconnect' ? { reconnect: H.reconnect.summary(), refetch: H.refetch.summary() } : {})
    },
    generator: { elu: round(genElu, 2), lag_max_ms: round(genLagMax) }
  };
  if (stormAt) { result.storm_all_back_s = round(allBackS, 2); result.storm_reconnected = stormBack; }
  if (args.probe) result.server = summariseProbe(args.probe, tStart, tEnd);

  console.log(JSON.stringify(result, null, 2));
  if (args.out) writeJson(args.out, result);
  if (result.generator.elu > 0.85) console.warn('⚠️  load generator saturated — latencies are inflated');
  process.exit(0);
}

function summariseProbe(file, from, to) {
  try {
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
      .filter((r) => r.t && r.t >= from && r.t <= to);
    if (!rows.length) return null;
    const avg = (k) => round(rows.reduce((a, r) => a + r[k], 0) / rows.length);
    const max = (k) => round(Math.max(...rows.map((r) => r[k])));
    return {
      cpu_pct_avg: avg('cpu_pct'), cpu_pct_max: max('cpu_pct'), elu_avg: avg('elu'),
      rss_mb_max: max('rss_mb'), heap_mb_max: max('heap_mb'),
      loop_lag_p99_ms_avg: avg('loop_p99_ms'), loop_lag_max_ms: max('loop_max_ms'),
      sql_per_s_avg: avg('sql_per_s'), sql_mean_ms_avg: avg('sql_mean_ms'),
      sql_p99_ms_max: max('sql_p99_ms'), sql_queue_max: max('sql_queue_max')
    };
  } catch (e) { return { error: e.message }; }
}

// ============================================================================
async function worker() {
  const { w, url, slice, args } = workerData;
  const H = { ack: new Histogram(), fanout: new Histogram(), ready: new Histogram(), reconnect: new Histogram(), refetch: new Histogram() };
  const C = {
    sent: 0, acked: 0, errors: 0, ackTimeouts: 0, recv: 0, typingRecv: 0, presenceRecv: 0,
    activityRecv: 0, dropped: 0, connectErrors: 0, errorCodes: {}
  };
  const sentByChannel = new Map();
  let fanSum = 0; let fanN = 0;
  let running = false; let stopping = false;
  let readyN = 0; let reconnected = 0;

  const eld = monitorEventLoopDelay({ resolution: 20 }); eld.enable();
  const elu0 = performance.eventLoopUtilization();

  const vus = slice.map((u) => ({ ...u, sock: null, ready: false, timer: null, storming: false, connectStart: 0, seq: 0 }));

  function wire(vu) {
    const sock = io(url, { transports: [args.transport], reconnection: false, forceNew: true, timeout: 30_000 });
    vu.sock = sock;
    sock.on('connect', () => { sock.emit('identify', { token: vu.token }); });
    sock.on('identified', () => {
      sock.timeout(30_000).emit('join_server', vu.guild, (e1, r1) => {
        if (e1 || !r1?.ok) { C.connectErrors += 1; return; }
        sock.timeout(30_000).emit('join_channel', vu.channel, async (e2, r2) => {
          if (e2 || !r2?.ok) { C.connectErrors += 1; return; }
          const ms = now() - vu.connectStart;
          if (vu.storming) {
            H.reconnect.record(ms); reconnected += 1; vu.storming = false;
            if (args.refetch) {
              const s = now();
              try {
                const res = await fetch(`${url}/api/messages/${vu.channel}?limit=50`, { headers: { Authorization: `Bearer ${vu.token}` } });
                await res.arrayBuffer();
                if (!res.ok) C.errorCodes[`refetch_${res.status}`] = (C.errorCodes[`refetch_${res.status}`] ?? 0) + 1;
              } catch { C.errorCodes.refetch_fail = (C.errorCodes.refetch_fail ?? 0) + 1; }
              H.refetch.record(now() - s);
            }
          } else {
            H.ready.record(ms); readyN += 1;
            parentPort.postMessage({ type: 'ready', ready: readyN });
          }
          vu.ready = true;
        });
      });
    });
    sock.on('identify_error', () => { C.connectErrors += 1; });
    sock.on('connect_error', () => { C.connectErrors += 1; });
    sock.on('disconnect', (reason) => {
      vu.ready = false;
      if (!vu.storming && !stopping && reason !== 'io client disconnect') C.dropped += 1;
    });
    sock.on('new_message', (msg) => {
      const c = msg?.content;
      if (typeof c !== 'string' || !c.startsWith('lt|')) return;
      if (msg.user_id === vu.id) return;           // own echo, not a fan-out
      const ts = Number(c.slice(3, c.indexOf('|', 3)));
      const ms = now() - ts;
      H.fanout.record(ms); C.recv += 1; fanSum += ms; fanN += 1;
    });
    sock.on('typing', () => { C.typingRecv += 1; });
    sock.on('presence_updated', () => { C.presenceRecv += 1; });
    sock.on('channel_activity', () => { C.activityRecv += 1; });
  }

  function send(vu) {
    if (!vu.ready || !running) return;
    const t = now();
    vu.seq += 1;
    C.sent += 1;
    sentByChannel.set(vu.channel, (sentByChannel.get(vu.channel) ?? 0) + 1);
    vu.sock.timeout(30_000).emit('send_message', {
      channel_id: vu.channel,
      content: `lt|${t}|load test message ${vu.seq} from worker ${w} — deploy latency cache socket`,
      nonce: `${vu.id}-${vu.seq}-${Math.random().toString(36).slice(2, 8)}`
    }, (err, res) => {
      if (err) { C.ackTimeouts += 1; C.errors += 1; return; }
      if (!res?.ok) {
        C.errors += 1; const code = res?.code ?? 'UNKNOWN';
        C.errorCodes[code] = (C.errorCodes[code] ?? 0) + 1; return;
      }
      C.acked += 1; H.ack.record(now() - t);
    });
  }

  // Poisson arrivals: exponential inter-send gaps with mean 1/rate.
  function schedule(vu) {
    if (!running) return;
    const gap = -Math.log(1 - Math.random()) / args.rate * 1000;
    const typing = Math.random() < args.typing;
    vu.timer = setTimeout(() => {
      if (typing && vu.ready) {
        vu.sock.emit('typing_start', { channelId: vu.channel, displayName: 'load' });
        vu.timer = setTimeout(() => { send(vu); schedule(vu); }, 1500);
      } else { send(vu); schedule(vu); }
    }, Math.max(0, gap - (typing ? 1500 : 0)));
  }

  parentPort.on('message', async (m) => {
    if (m.type === 'start') { running = true; vus.forEach(schedule); }
    if (m.type === 'storm') {
      for (const vu of vus) { vu.storming = true; vu.ready = false; vu.sock.disconnect(); }
      for (const vu of vus) {
        setTimeout(() => { vu.connectStart = now(); vu.sock.connect(); }, Math.random() * args.stormJitter);
      }
    }
    if (m.type === 'stop') {
      running = false; stopping = true;
      vus.forEach((vu) => clearTimeout(vu.timer));
      await sleep(3000);                     // let in-flight acks/fan-outs land
      const elu = performance.eventLoopUtilization(elu0).utilization;
      parentPort.postMessage({
        type: 'final', counters: C, sentByChannel: [...sentByChannel],
        hist: Object.fromEntries(Object.entries(H).map(([k, h]) => [k, h.toJSON()])),
        elu, lagMax: eld.max / 1e6
      });
      vus.forEach((vu) => vu.sock.close());
    }
  });

  setInterval(() => {
    parentPort.postMessage({
      type: 'progress', ready: vus.filter((v) => v.ready).length, reconnected,
      sent: C.sent, acked: C.acked, errors: C.errors, recv: C.recv, fanSum, fanN
    });
    fanSum = 0; fanN = 0;
  }, 1000).unref();

  // Ramp connections evenly over --ramp seconds.
  const gap = (args.ramp * 1000) / Math.max(1, vus.length);
  for (const vu of vus) {
    vu.connectStart = now();
    wire(vu);
    await sleep(gap);
  }
}
