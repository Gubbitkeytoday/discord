#!/usr/bin/env node
// ============================================================================
//  Lighthouse (performance category) on the login screen and on the main chat
//  view of a seeded guild, in mobile (default Moto G Power, 4x CPU, slow 4G
//  simulated) and desktop presets. Runs each (page x preset) PERF_LH_RUNS
//  times (default 3) and reports the median run.
//
//  The chat view is authenticated by sending the session cookie as an extra
//  header on every request (the SPA's API/socket calls are same-origin).
//
//  Google Fonts are third-party: by default Chrome reaches them through the
//  sandbox HTTPS proxy when HTTPS_PROXY is set; PERF_LH_BLOCK_FONTS=1 blocks
//  them instead to measure the "self-hosted / no webfont" counterfactual.
//
//  PERF_LH_WHATIF=1 puts a local front proxy (port PERF_PORT+1) between
//  Chrome and the app that does what the recommended server fixes would do:
//  brotli-compresses text responses and marks hashed /assets/* immutable.
//  Comparing its numbers with a normal run isolates the gain of those fixes.
//
//  Setup:  npm i --no-save lighthouse
//  Usage:  CHROME_PATH=/opt/pw-browsers/chromium node scripts/perf/lighthouse.mjs
//  Output: $PERF_OUT/lighthouse-summary.json + one .report.html per median run
// ============================================================================
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import lighthouse from 'lighthouse';
import desktopConfig from 'lighthouse/core/config/desktop-config.js';
import * as chromeLauncher from 'chrome-launcher';
import { bootServer, seedWorld, BASE as APP_BASE, PORT, OUT, CHROMIUM, writeJson } from './lib.mjs';

const RUNS = Number(process.env.PERF_LH_RUNS || 3);
const BLOCK_FONTS = process.env.PERF_LH_BLOCK_FONTS === '1';
const WHATIF = process.env.PERF_LH_WHATIF === '1';
const SUFFIX = `${BLOCK_FONTS ? '-nofonts' : ''}${WHATIF ? '-whatif' : ''}`;

/** Front proxy emulating the fixed server: brotli + immutable hashed assets. */
function startWhatIfProxy(port) {
  const server = http.createServer((req, res) => {
    const headers = { ...req.headers, host: `127.0.0.1:${PORT}` };
    delete headers['accept-encoding'];
    const up = http.request({ host: '127.0.0.1', port: PORT, path: req.url, method: req.method, headers }, (ur) => {
      const h = { ...ur.headers };
      const type = String(h['content-type'] ?? '');
      if (/^\/assets\//.test(req.url)) h['cache-control'] = 'public, max-age=31536000, immutable';
      const compressible = /text|javascript|json|css|svg/.test(type) && /\bbr\b/.test(req.headers['accept-encoding'] ?? '');
      if (compressible && ur.statusCode === 200) {
        delete h['content-length']; h['content-encoding'] = 'br'; h.vary = 'Accept-Encoding';
        res.writeHead(ur.statusCode, h);
        ur.pipe(zlib.createBrotliCompress({ params: { [zlib.constants.BROTLI_PARAM_QUALITY]: /^\/assets\//.test(req.url) ? 11 : 4 } })).pipe(res);
      } else { res.writeHead(ur.statusCode, h); ur.pipe(res); }
    });
    up.on('error', () => res.destroy());
    req.pipe(up);
  });
  server.on('upgrade', (req, sock, head) => {
    const up = net.connect(PORT, '127.0.0.1', () => {
      up.write(`${req.method} ${req.url} HTTP/1.1\r\n${Object.entries(req.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
      up.write(head); sock.pipe(up).pipe(sock);
    });
    up.on('error', () => sock.destroy()); sock.on('error', () => up.destroy());
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r(server)));
}
const front = WHATIF ? await startWhatIfProxy(PORT + 1) : null;
const BASE = WHATIF ? `http://localhost:${PORT + 1}` : APP_BASE;

const srv = await bootServer();
const world = await seedWorld({ messages: Number(process.env.PERF_LH_MESSAGES || 300), channels: 4, authors: 6, imageEvery: 25 });
const chatUrl = `${BASE}/channels/${world.serverId}/${world.long.id}`;

const chromeFlags = ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'];
const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
if (proxy && !BLOCK_FONTS) {
  chromeFlags.push(`--proxy-server=${proxy}`, '--proxy-bypass-list=localhost;127.0.0.1', '--ignore-certificate-errors');
}
const chrome = await chromeLauncher.launch({ chromePath: CHROMIUM, chromeFlags });

const pick = (lhr) => {
  const a = lhr.audits;
  const num = (id) => a[id]?.numericValue ?? null;
  const reqs = a['network-requests']?.details?.items ?? [];
  const byType = {};
  for (const r of reqs) {
    const t = r.resourceType ?? 'Other';
    byType[t] ??= { count: 0, transfer: 0 };
    byType[t].count += 1; byType[t].transfer += r.transferSize ?? 0;
  }
  const failing = Object.values(a)
    .filter((x) => x.score !== null && x.score < 0.9 && x.scoreDisplayMode !== 'informative' && x.scoreDisplayMode !== 'notApplicable')
    .map((x) => ({ id: x.id, title: x.title, score: x.score, display: x.displayValue ?? '', savingsMs: x.metricSavings?.LCP ?? x.metricSavings?.FCP ?? null, bytes: x.details?.overallSavingsBytes ?? null }));
  return {
    score: Math.round((lhr.categories.performance.score ?? 0) * 100),
    FCP: num('first-contentful-paint'),
    LCP: num('largest-contentful-paint'),
    TBT: num('total-blocking-time'),
    CLS: num('cumulative-layout-shift'),
    SI: num('speed-index'),
    TTI: num('interactive'),
    maxPotentialFID: num('max-potential-fid'),
    totalBytes: num('total-byte-weight'),
    bootupMs: num('bootup-time'),
    mainThreadMs: num('mainthread-work-breakdown'),
    requests: reqs.length,
    byType,
    unusedJsBytes: a['unused-javascript']?.details?.overallSavingsBytes ?? null,
    unusedCssBytes: a['unused-css-rules']?.details?.overallSavingsBytes ?? null,
    renderBlocking: (a['render-blocking-insight']?.details?.items ?? a['render-blocking-resources']?.details?.items ?? []).map((i) => ({ url: i.url, wastedMs: i.wastedMs ?? null, transfer: i.totalBytes ?? i.transferSize ?? null })),
    lcpElement: a['lcp-breakdown-insight']?.details?.items?.find((i) => i.type === 'node')?.snippet
      ?? a['largest-contentful-paint-element']?.details?.items?.[0]?.items?.[0]?.node?.snippet ?? null,
    layoutShifts: (a['layout-shifts']?.details?.items ?? []).map((i) => ({ score: i.score, node: i.node?.snippet?.slice(0, 160), causes: (i.subItems?.items ?? []).map((s) => s.cause) })),
    waterfall: reqs.map((r) => ({
      url: r.url.replace(BASE, '').slice(0, 110), type: r.resourceType, status: r.statusCode,
      transfer: r.transferSize, resource: r.resourceSize, startMs: Math.round(r.networkRequestTime ?? r.startTime ?? 0), endMs: Math.round(r.networkEndTime ?? r.endTime ?? 0), protocol: r.protocol
    })),
    failing
  };
};

const pages = [
  { name: 'login', url: `${BASE}/`, headers: {} },
  { name: 'chat', url: chatUrl, headers: { Cookie: `antigravity_session=${encodeURIComponent(world.lhUser.token)}` } }
];
const presets = [
  { name: 'mobile', config: undefined },
  { name: 'desktop', config: desktopConfig }
];

const summary = { runs: RUNS, blockFonts: BLOCK_FONTS, whatIf: WHATIF, results: {} };
for (const page of pages) {
  for (const preset of presets) {
    const runs = [];
    for (let i = 0; i < RUNS; i += 1) {
      const flags = {
        port: chrome.port, output: 'html', logLevel: 'error', onlyCategories: ['performance'],
        extraHeaders: page.headers,
        blockedUrlPatterns: BLOCK_FONTS ? ['*fonts.googleapis.com*', '*fonts.gstatic.com*', '*website-files.com*'] : [],
        disableStorageReset: false
      };
      const result = await lighthouse(page.url, flags, preset.config);
      runs.push({ metrics: pick(result.lhr), report: result.report, finalUrl: result.lhr.finalDisplayedUrl });
      process.stdout.write('.');
    }
    runs.sort((x, y) => x.metrics.score - y.metrics.score);
    const median = runs[Math.floor(runs.length / 2)];
    const key = `${page.name}-${preset.name}`;
    fs.writeFileSync(path.join(OUT, `lh-${key}${SUFFIX}.report.html`), median.report);
    summary.results[key] = { ...median.metrics, finalUrl: median.finalUrl, scores: runs.map((r) => r.metrics.score) };
    const m = median.metrics;
    console.log(`\n${key}: score ${m.score} LCP ${Math.round(m.LCP)}ms TBT ${Math.round(m.TBT)}ms CLS ${m.CLS?.toFixed(3)} TTI ${Math.round(m.TTI)}ms bytes ${Math.round(m.totalBytes / 1024)}KiB reqs ${m.requests} (${median.finalUrl})`);
  }
}
console.log('wrote', writeJson(`lighthouse-summary${SUFFIX}.json`, summary));
front?.close();
await chrome.kill();
srv.stop();
process.exit(0);
