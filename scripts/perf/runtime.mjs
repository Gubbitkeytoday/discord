#!/usr/bin/env node
// ============================================================================
//  Runtime performance of the chat view with a long channel, measured with
//  Playwright + the Chrome DevTools Protocol against the production build.
//
//  Seeds (through the real HTTP API) one channel with PERF_MESSAGES (default
//  5000) messages plus 20 short channels, then measures:
//    1. channel open: pointerdown on the sidebar entry -> newest row painted
//    2. keystroke -> next frame latency in the composer (50 rows, then N rows),
//       at 1x and 4x CPU throttle (event.timeStamp -> rAF+task after it; an
//       INP proxy — headless Chromium does not emit Event Timing for CDP input)
//    3. history loading: time per 50-message page, DOM nodes, JS heap
//    4. scroll smoothness: rAF frame intervals + long tasks during a scripted
//       scroll, at 50 rows and at N rows
//    5. incoming burst: (a) end-to-end, 10 authors POST at 100 msg/s target
//       (server-bound; achieved rate is reported) and (b) synthetic: exactly
//       100 socket.io `new_message` frames/s injected into the page's real
//       WebSocket (Playwright routeWebSocket) -> render lag, long tasks,
//       dropped frames, mark_read emits back to the server
//    6. leak check: 20-channel switching x2 and leaving the 5000-row channel,
//       forced GC, JS heap / DOM nodes / listeners / detached DOM (heap
//       snapshot) against a baseline
//    7. network: requests per channel switch (duplicates), image bytes vs
//       rendered size (avatars/attachments), lazy-loading coverage
//
//  Setup:  npm i --no-save playwright-core
//  Usage:  node scripts/perf/runtime.mjs [--headed]
//  Env:    PERF_MESSAGES, PERF_PORT (5950), PERF_OUT, CHROMIUM_PATH
//  Output: $PERF_OUT/runtime.json
// ============================================================================
import { chromium } from 'playwright-core';
import { bootServer, seedWorld, BASE, CHROMIUM, cookieFor, sleep, writeJson } from './lib.mjs';

const N = Number(process.env.PERF_MESSAGES || 5000);
const headed = process.argv.includes('--headed');
const R = { config: { messages: N, viewport: '1366x860', chromium: CHROMIUM } };
const log = (...a) => console.log(...a);
const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return +s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))].toFixed(1); };
const stats = (arr) => ({ n: arr.length, p50: pct(arr, 50), p95: pct(arr, 95), max: arr.length ? +Math.max(...arr).toFixed(1) : null });

const srv = await bootServer();
log(`seeding ${N} messages…`);
const world = await seedWorld({ messages: N, channels: 21, authors: 10, imageEvery: 100, log });
const others = world.channels.slice(1);
const longName = world.long.name ?? 'long-channel';
const newestLongId = async () => { const m = await world.viewer.get(`/api/messages/${world.long.id}?limit=1`); return m[m.length - 1].id; };
let lastId = await newestLongId();
const template = (await world.viewer.get(`/api/messages/${world.long.id}?limit=5`)).find((m) => !m.attachments?.length);

const browser = await chromium.launch({ executablePath: CHROMIUM, headless: !headed, args: ['--enable-precise-memory-info', '--js-flags=--expose-gc'] });
const context = await browser.newContext({ viewport: { width: 1366, height: 860 } });
await context.addCookies([cookieFor(world.viewer)]);
await context.route((u) => !u.href.startsWith(BASE) && /^https?:/.test(u.href), (r) => r.abort()); // no third-party noise
// Pass-through proxy of the app's socket.io WebSocket, so the benchmark can
// inject server->client frames at an exact rate.
let pageWs = null;
await context.routeWebSocket(/\/socket\.io\//, (ws) => { ws.connectToServer(); pageWs = ws; });
await context.addInitScript(() => {
  const P = window.__perf = { longtasks: [], shifts: [], events: [], keys: [], lastDown: 0 };
  const describe = (n) => n ? `${n.nodeName.toLowerCase()}${n.id ? '#' + n.id : ''}.${String(n.className || '').split(' ').slice(0, 3).join('.')}` : null;
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) P.longtasks.push({ start: e.startTime, dur: e.duration }); }).observe({ type: 'longtask', buffered: true }); } catch { /* */ }
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) P.shifts.push({ t: e.startTime, v: e.value, sources: (e.sources || []).map((s) => describe(s.node)) }); }).observe({ type: 'layout-shift', buffered: true }); } catch { /* */ }
  addEventListener('pointerdown', () => { P.lastDown = performance.now(); }, true);
  // keystroke (hardware timestamp) -> the frame after the one that handles it
  addEventListener('keydown', (e) => {
    const t0 = e.timeStamp;
    requestAnimationFrame(() => setTimeout(() => P.keys.push(performance.now() - t0), 0));
  }, true);
});

const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send('Performance.enable');
const wsSent = []; const wsRecv = [];
page.on('websocket', (ws) => {
  ws.on('framesent', (f) => { if (typeof f.payload === 'string') wsSent.push({ t: Date.now(), p: f.payload.slice(0, 40) }); });
  ws.on('framereceived', (f) => { if (typeof f.payload === 'string') wsRecv.push({ t: Date.now(), p: f.payload.slice(0, 40) }); });
});
/** Wait until the main thread has had no long task for `quietMs`; returns ms waited. */
async function drain(quietMs = 2000, maxMs = 600_000) {
  const t = Date.now();
  while (Date.now() - t < maxMs) {
    const busy = await page.evaluate((q) => { const now = performance.now(); return window.__perf.longtasks.some((x) => x.start + x.dur > now - q); }, quietMs);
    if (!busy && Date.now() - t > quietMs) break;
    await sleep(500);
  }
  return Date.now() - t - quietMs;
}
const requests = [];
page.on('request', (r) => requests.push({ t: Date.now(), url: r.url().replace(BASE, ''), type: r.resourceType() }));

const metrics = async ({ gc = false } = {}) => {
  if (gc) { await cdp.send('HeapProfiler.collectGarbage'); await sleep(300); await cdp.send('HeapProfiler.collectGarbage'); }
  const { metrics: m } = await cdp.send('Performance.getMetrics');
  const g = (k) => m.find((x) => x.name === k)?.value;
  const rows = await page.locator('[id^="message-"]').count();
  const uniqueRows = await page.evaluate(() => new Set([...document.querySelectorAll('[id^="message-"]')].map((e) => e.id)).size);
  const channel = new URL(page.url()).pathname.split('/').pop().slice(-6);
  return { rows, uniqueRows, channel, heapMB: +(g('JSHeapUsedSize') / 1048576).toFixed(1), nodes: g('Nodes'), listeners: g('JSEventListeners'), documents: g('Documents'), layoutCount: g('LayoutCount'), recalcStyle: g('RecalcStyleCount') };
};
const detachedNodes = async () => {
  let chunks = '';
  const onChunk = (e) => { chunks += e.chunk; };
  cdp.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
  cdp.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
  const snap = JSON.parse(chunks);
  const f = snap.snapshot.meta.node_fields; const nameIdx = f.indexOf('name'); const stride = f.length;
  let detached = 0; const kinds = {};
  for (let i = 0; i < snap.nodes.length; i += stride) {
    const name = snap.strings[snap.nodes[i + nameIdx]];
    if (name.startsWith('Detached ')) { detached += 1; const k = name.split(' ')[1]; kinds[k] = (kinds[k] ?? 0) + 1; }
  }
  return { detached, top: Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 6) };
};
const composer = () => page.locator('textarea[aria-label^="Message"], [role="textbox"][aria-label^="Message"]').first();
const channelLink = (name) => page.getByText(name, { exact: true }).first();
const scroller = 'div.overflow-y-auto.select-text';
const afterPaint = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => setTimeout(() => r(performance.now()), 0))));

async function openChannel(name, waitSelector) {
  await channelLink(name).click();
  await page.locator(waitSelector).first().waitFor({ state: 'attached', timeout: 20_000 });
  const painted = await afterPaint();
  const down = await page.evaluate(() => window.__perf.lastDown);
  return painted - down;
}

async function typing(label, { throttle = 1, text = 'the quick brown fox jumps over the lazy dog' } = {}) {
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
  const box = composer();
  await box.click();
  await page.evaluate(() => { window.__perf.keys = []; });
  await box.pressSequentially(text, { delay: 60, timeout: 180_000 });
  await sleep(300);
  const r = await page.evaluate(() => ({ keys: window.__perf.keys }));
  await box.fill('', { timeout: 60_000 });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const out = { label, throttle, keyToFrameMs: stats(r.keys) };
  log('  typing', label, `${throttle}x`, JSON.stringify(out.keyToFrameMs));
  return out;
}

async function scrollFps(label, px = 3000) {
  await page.evaluate(() => { window.__perf.longtasks = []; });
  const r = await page.evaluate(async ({ sel, px }) => {
    const el = document.querySelector(sel);
    el.scrollTop = el.scrollHeight;
    await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
    const deltas = []; let last = performance.now(); let moved = 0;
    const start = performance.now();
    await new Promise((res) => {
      const step = (t) => {
        deltas.push(t - last); last = t;
        const before = el.scrollTop;
        el.scrollTop = Math.max(el.scrollHeight - el.clientHeight - px, el.scrollTop - 25); // ~1500px/s
        moved += before - el.scrollTop;
        if (before === el.scrollTop || moved >= px) res(); else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    const dur = performance.now() - start;
    return { frames: deltas.length, durMs: dur, fps: (deltas.length / dur) * 1000, dropped: deltas.filter((d) => d > 20).length, worstFrame: Math.max(...deltas), moved };
  }, { sel: scroller, px });
  const lt = await page.evaluate(() => window.__perf.longtasks);
  const out = { label, fps: +r.fps.toFixed(1), frames: r.frames, dropped: r.dropped, worstFrameMs: +r.worstFrame.toFixed(1), movedPx: r.moved, longTasks: lt.length, longTaskMs: +lt.reduce((s, x) => s + x.dur, 0).toFixed(0) };
  log('  scroll', JSON.stringify(out));
  return out;
}

async function burst(label, { rate = 100, seconds = 3 } = {}) {
  await page.evaluate((sel) => { const el = document.querySelector(sel); el.scrollTop = el.scrollHeight; window.__perf.longtasks = []; window.__perf.frames = []; let last = performance.now(); const f = (t) => { window.__perf.frames.push(t - last); last = t; if (!window.__perf.stopFrames) requestAnimationFrame(f); }; window.__perf.stopFrames = false; requestAnimationFrame(f); }, scroller);
  const ws0 = wsSent.length;
  const before = await page.locator('[id^="message-"]').count();
  await cdp.send('Performance.enable');
  const m0 = (await cdp.send('Performance.getMetrics')).metrics;
  const total = rate * seconds; const sent = []; const t0 = Date.now();
  const tag = `burst-${label}-${Date.now()}`;
  const promises = [];
  for (let i = 0; i < total; i += 1) {
    const due = t0 + (i * 1000) / rate;
    const wait = due - Date.now(); if (wait > 0) await sleep(wait);
    const a = world.authors[i % world.authors.length];
    promises.push(a.post('/api/messages', { channel_id: world.long.id, content: `${tag} #${i} incoming message text` }).then((m) => sent.push({ id: m.id, at: Date.now() })));
  }
  await Promise.all(promises);
  const sendDur = Date.now() - t0;
  const lastSent = sent.sort((a, b) => a.at - b.at)[sent.length - 1];
  const lastMsgId = sent.map((s) => s.id).sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1)).pop();
  await page.locator(`#message-${lastMsgId}`).waitFor({ state: 'attached', timeout: 60_000 });
  const lagMs = Date.now() - lastSent.at;
  await afterPaint();
  const m1 = (await cdp.send('Performance.getMetrics')).metrics;
  const d = (k) => +(((m1.find((x) => x.name === k)?.value ?? 0) - (m0.find((x) => x.name === k)?.value ?? 0)) * 1000).toFixed(0);
  const r = await page.evaluate(() => { window.__perf.stopFrames = true; return { lt: window.__perf.longtasks, frames: window.__perf.frames }; });
  const ws = wsSent.slice(ws0);
  const out = {
    label, sent: total, achievedRate: +((total / sendDur) * 1000).toFixed(0), rowsBefore: before,
    renderLagAfterLastSendMs: lagMs,
    scriptMs: d('ScriptDuration'), taskMs: d('TaskDuration'), layoutMs: d('LayoutDuration'), recalcStyleMs: d('RecalcStyleDuration'),
    longTasks: r.lt.length, longTaskMs: +r.lt.reduce((s, x) => s + x.dur, 0).toFixed(0), worstLongTaskMs: r.lt.length ? +Math.max(...r.lt.map((x) => x.dur)).toFixed(0) : 0,
    frames: r.frames.length, droppedFrames: r.frames.filter((f) => f > 20).length, worstFrameMs: +Math.max(...r.frames).toFixed(0),
    clientSocketEmits: ws.length, markReadEmits: ws.filter((w) => w.p.includes('mark_read')).length
  };
  log('  burst', JSON.stringify(out));
  return out;
}

/** Inject `rate` new_message frames/s for `seconds` into the page's socket. */
async function syntheticBurst(label, { rate = 100, seconds = 3 } = {}) {
  await page.evaluate((sel) => { const el = document.querySelector(sel); el.scrollTop = el.scrollHeight; window.__perf.longtasks = []; window.__perf.frames = []; let last = performance.now(); const f = (t) => { window.__perf.frames.push(t - last); last = t; if (!window.__perf.stopFrames) requestAnimationFrame(f); }; window.__perf.stopFrames = false; requestAnimationFrame(f); }, scroller);
  const ws0 = wsSent.length; const wr0 = wsRecv.length;
  const before = await page.locator('[id^="message-"]').count();
  const m0 = (await cdp.send('Performance.getMetrics')).metrics;
  const total = rate * seconds; const t0 = Date.now();
  let id = BigInt(lastId) + 10_000_000n + BigInt(Date.now() % 1_000_000) * 1000n;
  let lastInjected = null;
  for (let i = 0; i < total; i += 1) {
    const due = t0 + (i * 1000) / rate;
    const wait = due - Date.now(); if (wait > 0) await sleep(wait);
    id += 1n; lastInjected = String(id);
    const a = world.authors[i % world.authors.length].user;
    const msg = { ...template, id: lastInjected, nonce: null, user_id: a.id, username: a.username, display_name: a.username, content: `synthetic ${label} #${i} hello there`, created_at: new Date().toISOString() };
    pageWs.send(`42${JSON.stringify(['new_message', msg])}`);
  }
  const injectDur = Date.now() - t0; const tEnd = Date.now();
  await page.locator(`#message-${lastInjected}`).waitFor({ state: 'attached', timeout: 60_000 });
  const lagMs = Date.now() - tEnd;
  await afterPaint(); await sleep(200);
  const m1 = (await cdp.send('Performance.getMetrics')).metrics;
  const r = await page.evaluate(() => { window.__perf.stopFrames = true; return { lt: window.__perf.longtasks, frames: window.__perf.frames }; });
  const wallMs = Date.now() - t0;
  const r0 = await page.evaluate(() => ({ lt: window.__perf.longtasks.length }));
  const backlogMs = await drain();
  const recv = wsRecv.slice(wr0);
  const d = (k) => +(((m1.find((x) => x.name === k)?.value ?? 0) - (m0.find((x) => x.name === k)?.value ?? 0)) * 1000).toFixed(0);
  const ws = wsSent.slice(ws0);
  const out = {
    label, kind: 'synthetic socket frames', injected: total, achievedRate: +((total / injectDur) * 1000).toFixed(0), rowsBefore: before,
    renderLagAfterLastFrameMs: lagMs, wallMs,
    scriptMs: d('ScriptDuration'), taskMs: d('TaskDuration'), layoutMs: d('LayoutDuration'), recalcStyleMs: d('RecalcStyleDuration'),
    longTasks: r.lt.length, longTaskMs: +r.lt.reduce((s2, x) => s2 + x.dur, 0).toFixed(0), worstLongTaskMs: r.lt.length ? +Math.max(...r.lt.map((x) => x.dur)).toFixed(0) : 0,
    frames: r.frames.length, droppedFrames: r.frames.filter((f) => f > 20).length, worstFrameMs: +Math.max(...r.frames).toFixed(0),
    clientSocketEmits: ws.length, markReadEmits: ws.filter((w) => w.p.includes('mark_read')).length,
    readStateEchoesReceived: recv.filter((w) => w.p.includes('read_state_updated')).length,
    mainThreadBusyAfterLastRowMs: backlogMs, longTasksDuringBacklog: (await page.evaluate(() => window.__perf.longtasks.length)) - r0.lt
  };
  log('  synthetic burst', JSON.stringify(out));
  return out;
}

try {
  // --- warm-up + baseline ----------------------------------------------------
  const t0 = Date.now();
  await page.goto(`${BASE}/channels/${world.serverId}/${others[0].id}`);
  await composer().waitFor({ timeout: 20_000 });
  R.bootToComposerMs = Date.now() - t0;
  R.bootRequests = requests.length;
  R.bootRequestList = requests.map((r) => `${r.type} ${r.url.slice(0, 90)}`);
  await sleep(1000);

  // --- 1. channel open (50 newest rows) --------------------------------------
  log('channel open…');
  const opens = []; const reqPerSwitch = [];
  for (let i = 0; i < 6; i += 1) {
    const r0 = requests.length;
    opens.push(await openChannel(longName, `#message-${lastId}`));
    await sleep(400);
    reqPerSwitch.push(requests.slice(r0).map((r) => r.url.replace(/\d{10,}/g, ':id').replace(/\?.*$/, '')));
    await openChannel(others[0].name, `textarea[aria-label^="Message"]`);
    await sleep(300);
  }
  R.channelOpenMs = stats(opens.slice(1)); // first is cold
  R.channelOpenColdMs = +opens[0].toFixed(0);
  const perSwitch = reqPerSwitch[1];
  const dupCount = {}; for (const u of perSwitch) dupCount[u] = (dupCount[u] ?? 0) + 1;
  R.requestsPerChannelOpen = { count: perSwitch.length, urls: dupCount };
  log('  open', JSON.stringify(R.channelOpenMs), 'requests/open', perSwitch.length);

  // --- baseline memory -------------------------------------------------------
  await openChannel(longName, `#message-${lastId}`);
  await sleep(500);
  R.at50 = await metrics({ gc: true });
  R.nodesPerRow = null;
  log('  at50', JSON.stringify(R.at50));

  // --- 2/4. typing + scroll at 50 rows --------------------------------------
  log('typing / scroll at 50 rows…');
  R.typing = [await typing('50 rows', { throttle: 1 }), await typing('50 rows', { throttle: 4 })];
  R.scroll = [await scrollFps('50 rows', 2500)];

  // --- 5. burst at 50 rows ----------------------------------------------------
  log('burst at ~50 rows…');
  R.burst = [await syntheticBurst('~50 rows'), await burst('~50 rows (end-to-end API)')];
  lastId = await newestLongId();

  // --- 6a. leak check: 20 channels x2 ----------------------------------------
  log('channel switching leak check…');
  await openChannel(others[0].name, 'textarea[aria-label^="Message"]');
  await sleep(500);
  const base = await metrics({ gc: true });
  const baseDetached = await detachedNodes();
  const switchTimes = [];
  for (let round = 0; round < 2; round += 1) {
    for (const c of [...others, world.long]) {
      const t = Date.now();
      await channelLink(c.name).click();
      await page.locator('[id^="message-"]').first().waitFor({ state: 'attached', timeout: 20_000 });
      switchTimes.push(Date.now() - t);
    }
  }
  await openChannel(others[0].name, 'textarea[aria-label^="Message"]');
  await sleep(800);
  const afterSwitch = await metrics({ gc: true });
  const afterDetached = await detachedNodes();
  R.leakSwitching = { baseline: { ...base, detached: baseDetached }, after42Switches: { ...afterSwitch, detached: afterDetached }, switchMs: stats(switchTimes) };
  log('  leak', JSON.stringify({ base, afterSwitch, baseDetached: baseDetached.detached, afterDetached: afterDetached.detached }));

  // --- 3. history load to N --------------------------------------------------
  log('loading history…');
  await openChannel(longName, `#message-${lastId}`);
  const pages = []; const checkpoints = [];
  const marks = new Set([500, 1000, 2000, 3000, 4000, 5000]);
  let rows = await page.locator('[id^="message-"]').count();
  let stalled = 0;
  while (rows < N && stalled < 3) {
    const t = await page.evaluate(async (sel) => {
      const el = document.querySelector(sel);
      const before = document.querySelectorAll('[id^="message-"]').length;
      const start = performance.now();
      // One native scroll event, like dragging the scrollbar to the top. (Dispatching
      // an extra synthetic 'scroll' here races two onLoadMore calls — see F-dup.)
      el.scrollTop = 0;
      return await new Promise((res) => {
        const deadline = start + 8000;
        const check = () => {
          const n = document.querySelectorAll('[id^="message-"]').length;
          if (n > before) requestAnimationFrame(() => setTimeout(() => res({ ms: performance.now() - start, n }), 0));
          else if (performance.now() > deadline) res({ ms: -1, n });
          else setTimeout(check, 5);
        };
        check();
      });
    }, scroller);
    if (t.ms < 0) { stalled += 1; await page.evaluate((sel) => { document.querySelector(sel).scrollTop = 300; }, scroller); await sleep(150); continue; }
    pages.push({ rows: t.n, ms: +t.ms.toFixed(0) });
    rows = t.n;
    for (const m of marks) if (rows >= m) { marks.delete(m); checkpoints.push(await metrics()); log('  checkpoint', JSON.stringify(checkpoints.at(-1))); }
    await sleep(120); // stay well under the 600 req/min read limit
  }
  R.historyPages = pages;
  R.historyPageMs = { first5: stats(pages.slice(0, 5).map((p) => p.ms)), last5: stats(pages.slice(-5).map((p) => p.ms)) };
  R.checkpoints = checkpoints;
  const atN = await metrics({ gc: true });
  R.atN = atN;
  R.nodesPerRow = +((atN.nodes - R.at50.nodes) / Math.max(1, atN.rows - R.at50.rows)).toFixed(1);
  log('  atN', JSON.stringify(atN), 'nodes/row', R.nodesPerRow);

  // --- 2/4/5 at N rows -------------------------------------------------------
  log(`typing / scroll / burst at ${atN.rows} rows…`);
  R.scroll.push(await scrollFps(`${atN.rows} rows`, 6000));
  R.typing.push(await typing(`${atN.rows} rows`, { throttle: 1 }), await typing(`${atN.rows} rows`, { throttle: 4, text: 'fox' }).catch((e) => ({ label: `${atN.rows} rows`, throttle: 4, error: String(e.message).split('\n')[0] })));
  R.burst.push(await syntheticBurst(`${atN.rows} rows`));

  // --- 6b. leave the long channel: does memory come back? -------------------
  await openChannel(others[0].name, 'textarea[aria-label^="Message"]');
  await page.waitForFunction(() => document.querySelectorAll('[id^="message-"]').length <= 50, null, { timeout: 30_000 }).catch(() => {});
  await sleep(1000);
  const afterLeave = await metrics({ gc: true });
  const afterLeaveDetached = await detachedNodes();
  R.leakLeaveLong = { ...afterLeave, detached: afterLeaveDetached };
  log('  after leaving long channel', JSON.stringify(R.leakLeaveLong));

  // --- 7. images -------------------------------------------------------------
  await openChannel(longName, `#message-${lastId}`);
  await sleep(1500);
  R.images = await page.evaluate(() => [...document.images].filter((i) => i.currentSrc && !i.currentSrc.startsWith('data:')).map((i) => ({
    src: i.currentSrc.replace(location.origin, '').slice(0, 60), natural: `${i.naturalWidth}x${i.naturalHeight}`, rendered: `${i.clientWidth}x${i.clientHeight}`,
    overscale: i.clientWidth ? +(i.naturalWidth / (i.clientWidth * devicePixelRatio)).toFixed(1) : null, loading: i.loading || 'eager', decoding: i.decoding || 'auto'
  })));
  const imgRes = await page.evaluate(() => performance.getEntriesByType('resource').filter((e) => e.initiatorType === 'img' || /\/uploads\//.test(e.name)).map((e) => ({ url: e.name.replace(location.origin, '').slice(0, 60), bytes: e.encodedBodySize })));
  const uniq = new Map(imgRes.map((x) => [x.url, x.bytes]));
  R.imageBytes = { distinct: uniq.size, totalKB: Math.round([...uniq.values()].reduce((s, b) => s + b, 0) / 1024) };
  const eager = R.images.filter((i) => i.loading !== 'lazy');
  R.imagesSummary = { total: R.images.length, eager: eager.length, eagerSample: [...new Set(eager.map((e) => e.rendered))].slice(0, 5), maxOverscale: Math.max(...R.images.map((i) => i.overscale ?? 0)) };
  log('  images', JSON.stringify(R.imagesSummary), JSON.stringify(R.imageBytes));

  R.layoutShifts = await page.evaluate(() => window.__perf.shifts.slice(0, 15));
} catch (err) {
  console.error('runtime failed:', err);
  R.error = String(err?.stack ?? err);
  await page.screenshot({ path: '/tmp/perf-runtime-fail.png' }).catch(() => {});
} finally {
  log('wrote', writeJson('runtime.json', R));
  await browser.close();
  srv.stop();
  process.exit(R.error ? 1 : 0);
}
