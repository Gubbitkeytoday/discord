#!/usr/bin/env node
// ============================================================================
//  PWA check in a real browser: manifest valid and installable-shaped, icons
//  real PNGs of the declared size, service worker registers and precaches the
//  app shell, offline navigation falls back to offline.html, and the app does
//  not ask for notifications on first load.
//
//  Setup:  npm i --no-save playwright-core   (CHROMIUM_PATH, default /opt/pw-browsers/chromium)
//  Usage:  npm run e2e:pwa [-- --build]
//  Env:    E2E_PWA_PORT (4560), CHROMIUM_PATH
// ============================================================================

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let chromium;
try {
  ({ chromium } = await import('playwright-core'));
} catch {
  console.error('playwright-core is not installed. Run: npm i --no-save playwright-core');
  process.exit(2);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.E2E_PWA_PORT || 4560);
const BASE = `http://localhost:${PORT}`;
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-pwa-'));

const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } catch (err) {
    results.push({ name, ok: false, error: err.message });
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}: ${err.message}`);
  }
}
const assert = (cond, message) => { if (!cond) throw new Error(message); };

/** Width/height from a PNG's IHDR chunk. */
function pngSize(buffer) {
  assert(buffer.subarray(1, 4).toString('ascii') === 'PNG', 'not a PNG');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

if (process.argv.includes('--build') || !fs.existsSync(path.join(ROOT, 'dist/index.html'))) {
  const r = spawnSync('npx', ['vite', 'build'], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) process.exit(1);
}

let log = '';
const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    NODE_ENV: 'development', PORT: String(PORT), HOST: '127.0.0.1', PUBLIC_URL: BASE,
    DB_PATH: path.join(tmp, 'pwa.db'), STORAGE_ROOT: path.join(tmp, 'uploads'),
    SERVE_STATIC: '1', ALLOW_DEV_IDENTITY: '0', LOG_LEVEL: 'warn', SEED_DATABASE: '0'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
server.stdout.on('data', (d) => { log += d; });
server.stderr.on('data', (d) => { log += d; });

let browser;
try {
  const deadline = Date.now() + 30_000;
  for (;;) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* booting */ }
    if (Date.now() > deadline || server.exitCode !== null) throw new Error(`server did not start:\n${log}`);
    await new Promise((r) => setTimeout(r, 250));
  }

  let manifest;
  await step('manifest is served as JSON with the fields an install needs', async () => {
    const res = await fetch(`${BASE}/manifest.webmanifest`);
    assert(res.ok, `HTTP ${res.status}`);
    assert(/application\/manifest\+json|application\/json/.test(res.headers.get('content-type') ?? ''), `content-type ${res.headers.get('content-type')}`);
    manifest = await res.json();
    for (const key of ['name', 'short_name', 'start_url', 'scope', 'display', 'icons', 'theme_color', 'background_color', 'id']) {
      assert(manifest[key] !== undefined, `missing ${key}`);
    }
    assert(manifest.display === 'standalone', 'display must be standalone');
    assert(Array.isArray(manifest.shortcuts) && manifest.shortcuts.length > 0, 'no shortcuts');
  });

  await step('icons exist at their declared sizes, including maskable 192/512', async () => {
    const pngs = manifest.icons.filter((i) => i.type === 'image/png');
    for (const size of ['192x192', '512x512']) {
      assert(pngs.some((i) => i.sizes === size && (i.purpose ?? 'any').includes('any')), `no ${size} icon`);
      assert(pngs.some((i) => i.sizes === size && i.purpose?.includes('maskable')), `no maskable ${size} icon`);
    }
    for (const icon of [...pngs, ...manifest.shortcuts.flatMap((s) => s.icons ?? [])]) {
      const res = await fetch(`${BASE}${icon.src}`);
      assert(res.ok, `${icon.src}: HTTP ${res.status}`);
      const { width, height } = pngSize(Buffer.from(await res.arrayBuffer()));
      assert(`${width}x${height}` === icon.sizes, `${icon.src} is ${width}x${height}, declared ${icon.sizes}`);
    }
    const apple = await fetch(`${BASE}/icons/apple-touch-icon.png`);
    assert(apple.ok, 'apple-touch-icon missing');
  });

  await step('index.html links the manifest, theme colours and apple-touch-icon', async () => {
    const html = await (await fetch(`${BASE}/`)).text();
    assert(/<link rel="manifest" href="\/manifest.webmanifest"/.test(html), 'no manifest link');
    assert((html.match(/name="theme-color"/g) ?? []).length >= 2, 'theme-color for light and dark');
    assert(/rel="apple-touch-icon"/.test(html), 'no apple-touch-icon');
  });

  let precache = [];
  await step('sw.js is uncached, stamped with a build id and a precache list that exists', async () => {
    const res = await fetch(`${BASE}/sw.js`);
    assert(res.ok, `HTTP ${res.status}`);
    assert(/no-cache|max-age=0/.test(res.headers.get('cache-control') ?? ''), `cache-control ${res.headers.get('cache-control')}`);
    const source = await res.text();
    const id = /const BUILD_ID = "([0-9a-f]{12})"/.exec(source)?.[1];
    assert(id, 'BUILD_ID was not stamped by the build');
    precache = JSON.parse(/const PRECACHE = (\[.*?\]);/.exec(source)?.[1] ?? '[]');
    assert(precache.length > 0 && precache.some((f) => f.endsWith('.js')), 'empty precache');
    for (const file of precache) assert((await fetch(`${BASE}${file}`)).ok, `${file} missing`);
    assert((await fetch(`${BASE}/offline.html`)).ok, 'offline.html missing');
  });

  browser = await chromium.launch({ executablePath: CHROMIUM, args: ['--no-sandbox'] });
  const context = await browser.newContext();
  await context.route((url) => !url.href.startsWith(BASE) && /^https?:/.test(url.href), (route) => route.abort());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));

  // Signed in, so the app (and its socket) is fully running.
  const username = `pwa${Date.now().toString(36)}`;
  const reg = await page.request.post(`${BASE}/api/auth/register`, {
    data: { username, password: 'correct-horse-battery-9', email: `${username}@example.test` }
  });
  if (!reg.ok()) throw new Error(`register failed: ${reg.status()} ${await reg.text()}`);

  await step('the service worker registers, activates and controls the page', async () => {
    await page.goto(`${BASE}/channels/@me`);
    const info = await page.evaluate(async () => {
      const reg = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((_, reject) => setTimeout(() => reject(new Error('sw not ready in 15s')), 15_000))
      ]);
      return { script: reg.active?.scriptURL, scope: reg.scope };
    });
    assert(info.script?.endsWith('/sw.js'), `active worker ${info.script}`);
    assert(info.scope === `${BASE}/`, `scope ${info.scope}`);
    await page.reload();
    const controlled = await page.evaluate(() => Boolean(navigator.serviceWorker.controller));
    assert(controlled, 'page is not controlled after reload');
  });

  await step('the app shell and offline page are precached', async () => {
    const cached = await page.evaluate(async (files) => {
      const out = {};
      for (const f of ['/offline.html', ...files]) out[f] = Boolean(await caches.match(f));
      return out;
    }, precache);
    const missing = Object.entries(cached).filter(([, ok]) => !ok).map(([f]) => f);
    assert(missing.length === 0, `not cached: ${missing.join(', ')}`);
  });

  await step('API responses are never cached by the worker', async () => {
    await page.evaluate(() => fetch('/api/auth/me').then((r) => r.text()));
    const leaked = await page.evaluate(async () => {
      for (const key of await caches.keys()) {
        const cache = await caches.open(key);
        for (const req of await cache.keys()) if (new URL(req.url).pathname.startsWith('/api/')) return req.url;
      }
      return null;
    });
    assert(!leaked, `cached ${leaked}`);
  });

  await step('no notification prompt on first load', async () => {
    await page.waitForTimeout(2500);
    const banner = await page.locator('#pwa-root [role="status"]').count();
    assert(banner === 0, 'a PWA banner appeared on first load');
    const permission = await page.evaluate(() => Notification.permission);
    assert(permission === 'default', `permission was requested (${permission})`);
  });

  await step('offline navigation falls back to offline.html', async () => {
    await context.setOffline(true);
    try {
      await page.goto(`${BASE}/channels/@me/somewhere`, { waitUntil: 'domcontentloaded' });
      const text = await page.textContent('body');
      assert(/offline/i.test(text ?? ''), 'offline page not shown');
    } finally {
      await context.setOffline(false);
    }
  });

  await step('no page errors', async () => {
    assert(errors.length === 0, errors.join(' | '));
  });
} catch (err) {
  results.push({ name: 'setup', ok: false, error: err.message });
  console.log(`  \x1b[31mFAIL\x1b[0m setup: ${err.message}`);
} finally {
  await browser?.close().catch(() => {});
  if (server.exitCode === null) server.kill('SIGTERM');
  fs.rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} PWA checks passed`);
process.exit(failed.length ? 1 : 0);
