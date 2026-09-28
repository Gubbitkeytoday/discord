#!/usr/bin/env node
// ============================================================================
//  UX persona panel — group "mobile-lowbandwidth".
//
//  Personas: Boonmee (budget Android, Slow 3G, 6x CPU, Thai), Grace (iPhone 13,
//  dark mode, night-shift catch-up), Omar (Android tablet landscape, Turkish,
//  hands-free voice).
//
//  Measures cold/warm load on three networks, bytes downloaded, offline and
//  reconnect behaviour, image upload on a slow link, touch-target sizes,
//  gestures, soft-keyboard layout, landscape layout and PWA installability.
//
//  Usage: node scripts/ux/mobile-lowbandwidth.mjs
//  Env:   UX_BASE (server already running, e.g. http://localhost:7070),
//         otherwise boots server.js on UX_PORT (default 7070) with a throwaway
//         DB like scripts/e2e/run.mjs. UX_PHASES=perf,boonmee,grace,omar
//         CHROMIUM_PATH, UX_SHOTS
//  Output: JSON results to $UX_SHOTS/persona-mobile-lowbandwidth-results.json
// ============================================================================
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.UX_PORT || 7070);
const BASE = process.env.UX_BASE || `http://localhost:${PORT}`;
const SHOTS = process.env.UX_SHOTS
  || '/tmp/claude-0/-home-user-discord/663d99e8-07c9-5b0f-8b1a-38c6a8c33dc1/scratchpad/shots';
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const PHASES = new Set((process.env.UX_PHASES || 'perf,boonmee,grace,omar').split(','));
const RUN = crypto.randomBytes(3).toString('hex');
const PASSWORD = 'correct-horse-battery-9';
const G = 'persona-mobile-lowbandwidth';
fs.mkdirSync(SHOTS, { recursive: true });

// DevTools presets (same numbers Chrome's Network panel uses).
const NET = {
  wifi: null,
  fast3g: { offline: false, latency: 562.5, downloadThroughput: (1.6 * 1024 * 1024 / 8) * 0.9, uploadThroughput: (750 * 1024 / 8) * 0.9 },
  slow3g: { offline: false, latency: 2000, downloadThroughput: (500 * 1024 / 8) * 0.8, uploadThroughput: (500 * 1024 / 8) * 0.8 }
};

const results = { run: RUN, base: BASE, perf: [], tasks: [], notes: [], touch: {} };
const log = (...a) => console.log(...a);
const note = (who, text) => { results.notes.push({ who, text }); log(`  [${who}] ${text}`); };
const shot = async (page, name) => {
  const file = path.join(SHOTS, `${G}-${name}.png`);
  await page.screenshot({ path: file }).catch((e) => log('shot failed', name, e.message));
  return file;
};

async function task(who, name, fn) {
  const t0 = Date.now();
  const rec = { who, name, ok: false, ms: 0, taps: 0, detail: '' };
  const ctx = { tap: () => { rec.taps += 1; }, detail: (d) => { rec.detail += (rec.detail ? '; ' : '') + d; } };
  try {
    await fn(ctx);
    rec.ok = true;
  } catch (err) {
    rec.detail += (rec.detail ? '; ' : '') + 'FAIL: ' + String(err.message).split('\n')[0].slice(0, 200);
  }
  rec.ms = Date.now() - t0;
  results.tasks.push(rec);
  log(`${rec.ok ? 'PASS' : 'FAIL'} [${who}] ${name} ${rec.ms}ms taps=${rec.taps} ${rec.detail}`);
  return rec.ok;
}

// --- server ------------------------------------------------------------------
let server;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ux-mlb-'));
async function boot() {
  if (process.env.UX_BASE) return;
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env, NODE_ENV: 'development', PORT: String(PORT), HOST: '127.0.0.1', PUBLIC_URL: BASE,
      CORS_ORIGIN: '', DB_PATH: path.join(tmp, 'ux.db'), STORAGE_ROOT: path.join(tmp, 'uploads'),
      SERVE_STATIC: '1', ALLOW_DEV_IDENTITY: '0', MAIL_TRANSPORT: 'console', LOG_LEVEL: 'warn'
    },
    stdio: 'ignore'
  });
  for (let i = 0; i < 120; i += 1) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* not yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not start');
}

// --- browser helpers ------------------------------------------------------------
async function newPersona(browser, who, opts) {
  const { net = null, cpu = 1, ...ctxOpts } = opts;
  const context = await browser.newContext({ ...ctxOpts });
  // No request interception: Playwright routing disables the HTTP cache, which
  // would make every warm load look like a cold one. The app self-hosts fonts.
  context.setDefaultTimeout(30_000);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  const bytes = { total: 0, byType: {} };
  const reqTypes = new Map();
  cdp.on('Network.responseReceived', (e) => reqTypes.set(e.requestId, e.type));
  cdp.on('Network.loadingFinished', (e) => {
    bytes.total += e.encodedDataLength;
    const ty = reqTypes.get(e.requestId) || 'Other';
    bytes.byType[ty] = (bytes.byType[ty] || 0) + e.encodedDataLength;
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 200)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  const p = { who, context, page, cdp, bytes, errors, net, cpu };
  p.setNet = async (n) => {
    p.net = n;
    if (!n) await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    else await cdp.send('Network.emulateNetworkConditions', n);
  };
  if (net) await p.setNet(net);
  if (cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
  p.resetBytes = () => { bytes.total = 0; bytes.byType = {}; };
  return p;
}

const composer = (page) => page.locator('textarea[aria-label^="Message"], [role="textbox"][aria-label^="Message"], #message-composer').first();
const msgRow = (page, text) => page.locator('[id^="message-"]').filter({ hasText: text });

async function registerViaApi(username) {
  // Used only for the scripted "friend" accounts that are not being studied.
  const r = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: PASSWORD })
  });
  if (!r.ok) throw new Error(`register ${username}: ${r.status} ${await r.text()}`);
}

async function uiRegister(page, username, { signUpName = /Sign up|สมัคร|Kaydol|Kayıt/i } = {}) {
  const signUp = page.getByRole('button', { name: signUpName }).first();
  await signUp.click();
  await page.locator('input[autocomplete="username"], input[name="username"]').first().fill(username);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.locator('form button[type=submit]').click();
  // After sign-up from an invite link the app shows the invite card, not the shell.
  await page.getByRole('navigation').or(page.getByRole('button', { name: ACCEPT })).first().waitFor({ timeout: 90_000 });
}
const ACCEPT = /Accept invite|รับคำเชิญ|Daveti kabul et/;

/** Every visible interactive element smaller than 44x44 CSS px. */
async function smallTargets(page) {
  return page.evaluate(() => {
    const out = [];
    const els = document.querySelectorAll('button, a[href], [role="button"], [role="menuitem"], [role="tab"], input[type="checkbox"], input[type="radio"], select, summary');
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
      const st = getComputedStyle(el);
      if (st.visibility === 'hidden' || st.display === 'none' || Number(st.opacity) === 0) continue;
      if (r.width < 44 || r.height < 44) {
        out.push({
          label: (el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 40),
          w: Math.round(r.width), h: Math.round(r.height)
        });
      }
    }
    return { total: els.length, small: out };
  });
}

async function swipe(page, cdp, x0, y0, x1, y1, steps = 8) {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y: y0 }] });
  for (let i = 1; i <= steps; i += 1) {
    const x = x0 + ((x1 - x0) * i) / steps;
    const y = y0 + ((y1 - y0) * i) / steps;
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
    await page.waitForTimeout(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

/** A noisy photo-sized PNG (does not compress) of roughly `kb` kilobytes. */
function makePhoto(kb) {
  const w = 512; const h = Math.max(8, Math.round((kb * 1024) / (w * 3)));
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = []; for (let y = 0; y < h; y += 1) rows.push(Buffer.concat([Buffer.from([0]), crypto.randomBytes(w * 3)]));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows), { level: 0 })), chunk('IEND', Buffer.alloc(0))]);
}

// Friend accounts drive the other side over the real UI in a desktop context.
async function friendSetup(browser, name, serverName, channelName, { voice = false } = {}) {
  const f = await newPersona(browser, name, { viewport: { width: 1366, height: 860 }, locale: 'en-US' });
  const { page } = f;
  await page.goto(BASE + '/');
  await uiRegister(page, name);
  await page.getByRole('button', { name: 'Add a server' }).click();
  await page.getByRole('button', { name: /Create my own/ }).click();
  await page.getByPlaceholder('e.g. Chill Squad HQ').fill(serverName);
  await page.getByRole('button', { name: /^Create$/ }).click();
  await page.getByText(serverName).first().waitFor();
  const offer = page.getByRole('dialog', { name: /Invite friends/ });
  if (await offer.waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false)) await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Create text channel' }).or(page.getByTitle('Create text channel')).first().click();
  await page.getByPlaceholder('new-channel').fill(channelName);
  await page.locator('[role="dialog"]').getByRole('button', { name: /Create channel/ }).click();
  await composer(page).waitFor();
  await page.getByText(serverName).first().click();
  await page.getByRole('menuitem', { name: 'Invite people' }).or(page.getByRole('button', { name: 'Invite people' })).first().click();
  await page.waitForFunction(() => /\/invite\//.test(document.getElementById('invite-link')?.value ?? ''));
  f.invite = await page.locator('#invite-link').inputValue();
  await page.keyboard.press('Escape');
  f.channelName = channelName;
  f.serverName = serverName;
  f.send = async (text) => {
    const box = composer(page);
    await box.click(); await box.fill(text); await box.press('Enter');
    await msgRow(page, text).first().waitFor();
  };
  return f;
}

// ============================================================================
async function perf(browser) {
  log('\n== PERF: cold + warm load per network ==');
  const combos = [
    { name: 'wifi', net: NET.wifi, cpu: 1 },
    { name: 'fast3g-cpu4x', net: NET.fast3g, cpu: 4 },
    { name: 'slow3g-cpu6x', net: NET.slow3g, cpu: 6 }
  ];
  // One logged-in account for the "open the app into a channel" measurements.
  const uname = `perf_${RUN}`;
  await registerViaApi(uname);
  for (const c of combos) {
    const p = await newPersona(browser, 'perf', { viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, net: c.net, cpu: c.cpu });
    const t0 = Date.now();
    await p.page.goto(BASE + '/', { waitUntil: 'commit', timeout: 180_000 });
    await p.page.locator('form button[type=submit]').waitFor({ timeout: 180_000 });
    const tInteractive = Date.now() - t0;
    const paint = await p.page.evaluate(() => {
      const fcp = performance.getEntriesByName('first-contentful-paint')[0]?.startTime ?? null;
      const nav = performance.getEntriesByType('navigation')[0];
      return { fcp: fcp && Math.round(fcp), dcl: nav && Math.round(nav.domContentLoadedEventEnd), load: nav && Math.round(nav.loadEventEnd) };
    });
    await p.page.waitForTimeout(1500);
    const coldBytes = p.bytes.total;
    const byType = { ...p.bytes.byType };
    // Log in, then measure a warm (cached) reload into the app shell.
    await p.page.locator('input[autocomplete="username"], input[name="username"]').first().fill(uname);
    await p.page.locator('input[type="password"]').first().fill(PASSWORD);
    const tl = Date.now();
    await p.page.locator('form button[type=submit]').click();
    await p.page.getByRole('navigation').first().waitFor({ timeout: 180_000 });
    const tLogin = Date.now() - tl;
    await p.page.waitForTimeout(2000);
    const afterLoginBytes = p.bytes.total - coldBytes;
    p.resetBytes();
    const t1 = Date.now();
    await p.page.reload({ waitUntil: 'commit', timeout: 180_000 });
    await p.page.getByRole('navigation').first().waitFor({ timeout: 180_000 });
    const tWarm = Date.now() - t1;
    await p.page.waitForTimeout(1500);
    const rec = {
      network: c.name, coldFcpMs: paint.fcp, coldLoginFormInteractiveMs: tInteractive, coldLoadEventMs: paint.load,
      coldBytes, coldByType: byType, loginToShellMs: tLogin, afterLoginBytes, warmReloadToShellMs: tWarm, warmBytes: p.bytes.total
    };
    results.perf.push(rec);
    log(JSON.stringify(rec));
    if (c.name === 'slow3g-cpu6x') await shot(p.page, 'perf-slow3g-shell');
    await p.context.close();
  }
  // Loading skeleton on slow 3G: what does Boonmee stare at for 10 seconds?
  const p = await newPersona(browser, 'perf', { viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2, net: NET.slow3g, cpu: 6 });
  await p.page.goto(BASE + '/', { waitUntil: 'commit' });
  await p.page.waitForTimeout(3000); await shot(p.page, 'perf-slow3g-at-3s');
  await p.page.waitForTimeout(4000); await shot(p.page, 'perf-slow3g-at-7s');
  // PWA installability.
  const pwa = await p.page.evaluate(async () => {
    const link = document.querySelector('link[rel="manifest"]');
    const regs = navigator.serviceWorker ? await navigator.serviceWorker.getRegistrations() : [];
    return {
      manifestLink: link?.href ?? null, serviceWorkers: regs.length,
      themeColor: document.querySelector('meta[name="theme-color"]')?.content ?? null,
      appleTouchIcon: Boolean(document.querySelector('link[rel="apple-touch-icon"]')),
      viewport: document.querySelector('meta[name="viewport"]')?.content ?? null
    };
  });
  const manifest = await p.cdp.send('Page.getAppManifest').catch((e) => ({ error: e.message }));
  const install = await p.cdp.send('Page.getInstallabilityErrors').catch((e) => ({ error: e.message }));
  results.pwa = { ...pwa, cdpManifestUrl: manifest.url ?? null, manifestErrors: manifest.errors, installabilityErrors: install.installabilityErrors };
  log('PWA', JSON.stringify(results.pwa));
  // Offline reload: what happens when Boonmee opens the app in a dead zone.
  await p.setNet(null);
  await p.page.waitForTimeout(500);
  await p.context.setOffline(true);
  await p.page.reload().catch((e) => note('perf', `offline reload: ${e.message.split('\n')[0]}`));
  await p.page.waitForTimeout(1500);
  await shot(p.page, 'perf-offline-reload');
  await p.context.close();
}

// ============================================================================
async function boonmee(browser) {
  log('\n== BOONMEE (th, 360x740, slow 3G, 6x CPU) ==');
  const friend = await friendSetup(browser, `somchai_${RUN}`, 'ไรเดอร์ สายไหม', 'งานวันนี้');
  await friend.send('วันนี้ออเดอร์เยอะมาก ใครว่างรับงานบางเขนบ้าง');
  const B = await newPersona(browser, 'boonmee', {
    viewport: { width: 360, height: 740 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2,
    locale: 'th-TH', timezoneId: 'Asia/Bangkok',
    userAgent: 'Mozilla/5.0 (Linux; Android 12; SM-A035F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36',
    permissions: ['microphone'], net: NET.slow3g, cpu: 6
  });
  const b = B.page;
  const uname = `boonmee_${RUN}`;

  await task('Boonmee', 'Open invite link from LINE (cold, Slow 3G)', async (c) => {
    const t0 = Date.now();
    await b.goto(friend.invite, { waitUntil: 'commit', timeout: 120_000 });
    await b.locator('form button[type=submit]').waitFor({ timeout: 120_000 });
    c.detail(`first usable screen ${Date.now() - t0}ms, ${Math.round(B.bytes.total / 1024)} KB`);
    await b.waitForTimeout(1500);
    await shot(b, 'boonmee-01-invite-cold');
    const txt = await b.locator('body').innerText();
    c.detail(`mentions server name: ${txt.includes('ไรเดอร์')}`);
  });

  await task('Boonmee', 'Register (Thai UI auto-detected)', async (c) => {
    const txt = await b.locator('body').innerText();
    c.detail(`thai detected: ${/[฀-๿]/.test(txt)}`);
    c.tap(); c.tap(); c.tap(); c.tap();
    await uiRegister(b, uname);
    await b.waitForTimeout(2000);
    await shot(b, 'boonmee-02-after-register');
  });

  await task('Boonmee', 'Accept invite and reach the channel', async (c) => {
    const accept = b.getByRole('button', { name: ACCEPT }).first();
    if (await accept.isVisible().catch(() => false)) { c.tap(); await accept.click(); c.detail('invite screen shown again after sign-up'); } else {
      c.detail('no accept button after sign-up; re-opening invite link');
      await b.goto(friend.invite, { timeout: 120_000 });
      await b.getByRole('button', { name: ACCEPT }).first().click({ timeout: 60_000 }); c.tap();
    }
    await b.waitForTimeout(3000);
    await shot(b, 'boonmee-03-after-accept');
    const chan = b.locator('#channel-list').getByText(/^งานว/).first();
    // The new member lands on #general with the drawer open; the job channel
    // has to be picked by hand.
    await chan.tap({ timeout: 60_000 }); c.tap();
    await composer(b).waitFor({ timeout: 60_000 });
    await msgRow(b, 'ออเดอร์เยอะมาก').first().waitFor({ timeout: 60_000 });
    await shot(b, 'boonmee-04-channel');
    // The friend typed "งานวันนี้"; the create-channel slug strips Thai vowel/tone marks.
    c.detail(`channel name as shown: "${(await chan.innerText()).trim()}" (typed "งานวันนี้")`);
  });

  results.touch.boonmeeChat = await smallTargets(b);
  log('touch targets (chat):', results.touch.boonmeeChat.small.length, '/', results.touch.boonmeeChat.total);

  await task('Boonmee', 'Send a text message (one thumb)', async (c) => {
    const t = `รับครับ อยู่แถวรามอินทรา ${RUN}`;
    const box = composer(b);
    c.tap(); await box.tap();
    await box.fill(t);
    const send = b.getByRole('button', { name: /ส่ง|Send/ }).last();
    const sendBox = await send.boundingBox().catch(() => null);
    c.detail(`send button ${sendBox ? `${Math.round(sendBox.width)}x${Math.round(sendBox.height)} at y=${Math.round(sendBox.y)}` : 'NOT VISIBLE (Enter only)'}`);
    if (sendBox) { c.tap(); await send.tap(); } else await box.press('Enter');
    const t0 = Date.now();
    await msgRow(b, t).first().waitFor();
    await msgRow(friend.page, t).first().waitFor({ timeout: 30_000 });
    c.detail(`delivered to friend in ${Date.now() - t0}ms`);
  });

  await task('Boonmee', 'Soft keyboard open: composer still visible', async (c) => {
    await composer(b).tap();
    await b.setViewportSize({ width: 360, height: 740 - 290 }); // Android resizes the layout viewport
    await b.waitForTimeout(800);
    const bb = await composer(b).boundingBox();
    c.detail(`composer box ${bb ? `y=${Math.round(bb.y)} h=${Math.round(bb.height)} (viewport 450)` : 'none'}`);
    await shot(b, 'boonmee-05-keyboard-open');
    if (!bb || bb.y + bb.height > 450) throw new Error('composer hidden under keyboard');
    await b.setViewportSize({ width: 360, height: 740 });
  });

  await task('Boonmee', 'Swipe right from left edge to open channel drawer', async (c) => {
    await b.waitForTimeout(500);
    const before = await b.locator('#channel-list').getByText(/^งานว/).first().boundingBox().catch(() => null);
    const urlBefore = b.url();
    // Start 24px in: a swipe from x<20 is Chrome's back gesture (checked
    // separately below), which is not what we want to measure here.
    await swipe(b, B.cdp, 24, 400, 300, 400);
    await b.waitForTimeout(800);
    await shot(b, 'boonmee-06-after-swipe');
    c.detail(`url changed by swipe: ${b.url() !== urlBefore} (${b.url().replace(BASE, '')})`);
    if (b.url() !== urlBefore) { await b.goto(urlBefore, { timeout: 120_000 }); await composer(b).waitFor({ timeout: 120_000 }); }
    const drawerVisible = await b.getByRole('navigation').first().isVisible().catch(() => false);
    const rail = await b.getByRole('navigation').first().boundingBox().catch(() => null);
    c.detail(`after swipe: nav visible=${drawerVisible} x=${rail ? Math.round(rail.x) : 'n/a'}; before=${JSON.stringify(before)}`);
    if (!rail || rail.x < 0 || rail.x > 300) throw new Error('drawer did not open by swipe');
  });

  await task('Boonmee', 'Android edge back-gesture (swipe from x=4) while chatting', async (c) => {
    const urlBefore = b.url();
    await swipe(b, B.cdp, 4, 400, 300, 400);
    await b.waitForTimeout(1500);
    const after = b.url();
    c.detail(`url before ${urlBefore.replace(BASE, '')} → after ${after.replace(BASE, '') || after}`);
    await shot(b, 'boonmee-06b-edge-back');
    const left = after !== urlBefore;
    if (left) {
      await b.goto(urlBefore, { timeout: 120_000 });
      await composer(b).waitFor({ timeout: 120_000 });
      throw new Error(`edge swipe navigated away to "${after}" (app lost, cold reload needed)`);
    }
  });

  // Ensure we are on the chat (close drawer if it is open).
  const openChannel = async () => {
    if (await composer(b).isVisible().catch(() => false)) {
      const bb = await composer(b).boundingBox();
      if (bb && bb.x >= 0 && bb.x < 360) return;
    }
    await b.locator('#channel-list').getByText(/^งานว/).first().click().catch(() => {});
    await b.waitForTimeout(800);
  };
  await openChannel();

  await task('Boonmee', 'Find the menu / drawer by tapping (hamburger)', async (c) => {
    const btns = await b.evaluate(() => [...document.querySelectorAll('button')].filter((x) => {
      const r = x.getBoundingClientRect(); return r.top < 70 && r.left < 80 && r.width > 0;
    }).map((x) => ({ l: x.getAttribute('aria-label') || x.title || x.innerText, w: Math.round(x.getBoundingClientRect().width), h: Math.round(x.getBoundingClientRect().height) })));
    c.detail(`top-left buttons: ${JSON.stringify(btns)}`);
    await shot(b, 'boonmee-07-chat-header');
  });

  await task('Boonmee', 'Swipe message left to reply (LINE/WhatsApp habit)', async (c) => {
    const row = msgRow(b, 'ออเดอร์เยอะมาก').first();
    const bb = await row.boundingBox();
    await swipe(b, B.cdp, 300, bb.y + bb.height / 2, 120, bb.y + bb.height / 2);
    await b.waitForTimeout(600);
    const replying = await b.getByText(/ตอบกลับ|Replying/).first().isVisible().catch(() => false);
    c.detail(`reply bar after swipe: ${replying}`);
    await shot(b, 'boonmee-08-swipe-reply');
    if (!replying) throw new Error('swipe-to-reply not supported');
  });

  await task('Boonmee', 'Long-press message to reply', async (c) => {
    const row = msgRow(b, 'ออเดอร์เยอะมาก').first();
    const bb = await row.boundingBox();
    await B.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: bb.x + 150, y: bb.y + bb.height / 2 }] });
    await b.waitForTimeout(900);
    await B.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await b.waitForTimeout(800);
    c.tap();
    await shot(b, 'boonmee-09-longpress');
    const reply = b.getByRole('button', { name: /ตอบกลับ|Reply/ }).first();
    const vis = await reply.isVisible().catch(() => false);
    c.detail(`reply action visible after long-press: ${vis}`);
    if (vis) {
      const rb = await reply.boundingBox(); c.detail(`reply button ${Math.round(rb.width)}x${Math.round(rb.height)}`);
      await reply.tap(); c.tap();
      await b.getByText(/ตอบกลับ|Replying/).first().waitFor({ timeout: 5000 });
      await composer(b).fill(`ได้ครับพี่ ${RUN}`);
      await composer(b).press('Enter');
      await msgRow(friend.page, `ได้ครับพี่ ${RUN}`).first().waitFor({ timeout: 30_000 });
    } else throw new Error('no reply after long-press');
  });

  await task('Boonmee', 'Upload a 400 KB photo on Slow 3G (progress / cancel)', async (c) => {
    const photo = makePhoto(400);
    const input = b.locator('input[type="file"]').first();
    const t0 = Date.now();
    await input.setInputFiles({ name: 'slip-โอนเงิน.png', mimeType: 'image/png', buffer: photo });
    await b.waitForTimeout(2500);
    const prog = b.locator('[data-testid="upload-progress"]');
    const progVisible = await prog.isVisible().catch(() => false);
    c.detail(`progress visible=${progVisible}`);
    await shot(b, 'boonmee-10-upload-progress');
    const cancel = await b.getByRole('button', { name: /ยกเลิก|Cancel/ }).count();
    c.detail(`cancel buttons on screen: ${cancel}`);
    // wait until uploaded (attachment preview appears)
    await b.waitForFunction(() => !document.querySelector('[data-testid="upload-progress"]'), null, { timeout: 120_000 });
    c.detail(`upload finished in ${Date.now() - t0}ms`);
    await shot(b, 'boonmee-11-upload-done');
    await composer(b).fill(`สลิปครับ ${RUN}`);
    await composer(b).press('Enter');
    await msgRow(friend.page, `สลิปครับ ${RUN}`).locator('img').first().waitFor({ timeout: 90_000 });
  });

  await task('Boonmee', 'Photo upload drops offline midway (tunnel) — retry?', async (c) => {
    const photo = makePhoto(300);
    await b.locator('input[type="file"]').first().setInputFiles({ name: 'photo2.png', mimeType: 'image/png', buffer: photo });
    await b.waitForTimeout(2500);
    await B.context.setOffline(true);
    await b.waitForTimeout(4000);
    await shot(b, 'boonmee-12-upload-offline');
    const body = await b.locator('body').innerText();
    const err = body.match(/(อัปโหลด[^\n]{0,60}|Upload[^\n]{0,60})/);
    c.detail(`message shown: ${err ? err[0] : 'none'}`);
    const retry = await b.getByRole('button', { name: /ลองใหม่|Retry|Try again/ }).count();
    c.detail(`retry buttons: ${retry}`);
    await B.context.setOffline(false);
    await b.waitForTimeout(3000);
    if (!retry) throw new Error('no retry for failed upload; photo must be re-picked');
  });
  await B.context.setOffline(false);
  // dismiss any upload error
  await b.getByRole('button', { name: /ปิด|Close/ }).first().click({ timeout: 2000 }).catch(() => {});

  await task('Boonmee', 'Offline 20 s mid-conversation: send while offline, catch up after', async (c) => {
    const offlineMsg = `ส่งตอนไม่มีเน็ต ${RUN}`;
    await B.context.setOffline(true);
    await B.cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    await b.waitForTimeout(2000);
    await shot(b, 'boonmee-13-offline-2s');
    const bodyOff = await b.locator('body').innerText();
    c.detail(`offline banner shown: ${/ออฟไลน์|offline|ขาดการเชื่อมต่อ|เชื่อมต่อใหม่|connect/i.test(bodyOff)}`);
    await composer(b).fill(offlineMsg);
    await composer(b).press('Enter');
    await b.waitForTimeout(1000);
    await shot(b, 'boonmee-14-offline-sent');
    const pendingRow = msgRow(b, offlineMsg).first();
    const rowTxt = await pendingRow.innerText().catch(() => '');
    const pendingOpacity = await pendingRow.evaluate((el) => getComputedStyle(el.querySelector('[class*="opacity"]') ?? el).opacity).catch(() => 'n/a');
    c.detail(`offline msg row: "${rowTxt.replace(/\s+/g, ' ').slice(0, 80)}" opacity=${pendingOpacity}`);
    // Friend keeps talking while Boonmee is in the dead zone.
    await friend.send(`งานใหม่ 1 เซ็นทรัลรามอินทรา ${RUN}`);
    await friend.send(`งานใหม่ 2 ด่วน! ${RUN}`);
    await b.waitForTimeout(18_000 - 3000);
    await shot(b, 'boonmee-15-offline-20s');
    await B.context.setOffline(false);
    await B.setNet(NET.slow3g);
    const t0 = Date.now();
    const got1 = await msgRow(b, `งานใหม่ 2 ด่วน! ${RUN}`).first().waitFor({ timeout: 45_000 }).then(() => Date.now() - t0, () => null);
    c.detail(`missed msgs appeared after reconnect: ${got1 === null ? 'NO (45s)' : `${got1}ms`}`);
    const delivered = await msgRow(friend.page, offlineMsg).first().waitFor({ timeout: 45_000 }).then(() => Date.now() - t0, () => null);
    c.detail(`offline-sent msg reached friend: ${delivered === null ? 'NO' : `${delivered}ms`}`);
    await shot(b, 'boonmee-16-after-reconnect');
    const failedTxt = await msgRow(b, offlineMsg).first().innerText().catch(() => '');
    c.detail(`own row after reconnect: "${failedTxt.replace(/\s+/g, ' ').slice(0, 80)}"`);
    const dup = await msgRow(friend.page, offlineMsg).count();
    c.detail(`copies at friend: ${dup}`);
    if (got1 === null || delivered === null) throw new Error('lost messages across a 20s drop');
  });

  await task('Boonmee', 'Offline 150 s (beyond 2-min recovery window) then catch up', async (c) => {
    await B.context.setOffline(true);
    await B.cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    await friend.send(`ลูกค้ายกเลิกออเดอร์ ${RUN}`);
    await b.waitForTimeout(150_000);
    await B.context.setOffline(false);
    await B.setNet(NET.slow3g);
    const t0 = Date.now();
    const got = await msgRow(b, `ลูกค้ายกเลิกออเดอร์ ${RUN}`).first().waitFor({ timeout: 60_000 }).then(() => Date.now() - t0, () => null);
    c.detail(`missed msg after long drop: ${got === null ? 'NOT SHOWN within 60s (needs manual reload)' : `${got}ms`}`);
    await shot(b, 'boonmee-17-after-long-drop');
    if (got === null) throw new Error('messages missed during a long drop never appear');
  });

  await task('Boonmee', 'Voice note: find and record 3 s', async (c) => {
    const rec = b.getByRole('button', { name: /บันทึก|ข้อความเสียง|Record|voice/i }).first();
    const vis = await rec.isVisible().catch(() => false);
    const bb = vis ? await rec.boundingBox() : null;
    c.detail(`record button visible=${vis}${bb ? ` ${Math.round(bb.width)}x${Math.round(bb.height)}` : ''}`);
    await shot(b, 'boonmee-18-composer-icons');
    if (!vis) throw new Error('no voice-note button in the composer');
    await rec.tap(); c.tap();
    await b.waitForTimeout(3000);
    await shot(b, 'boonmee-19-recording');
    const send = b.getByRole('button', { name: /ส่งข้อความเสียง|ส่ง|Send/ }).last();
    await send.tap(); c.tap();
    await b.waitForTimeout(8000);
    await shot(b, 'boonmee-20-voice-sent');
  });

  results.touch.boonmeeDrawer = await (async () => {
    await swipe(b, B.cdp, 4, 400, 300, 400).catch(() => {});
    const menuBtn = b.getByRole('button', { name: /แสดงรายการห้อง|Show channels/i }).first();
    if (await menuBtn.isVisible().catch(() => false)) await menuBtn.tap().catch(() => {});
    await b.waitForTimeout(800);
    await shot(b, 'boonmee-21-drawer');
    return smallTargets(b);
  })();
  results.boonmeeBytes = B.bytes.total;
  results.boonmeeErrors = B.errors.slice(0, 20);
  await B.context.close();
  await friend.context.close();
}

// ============================================================================
async function grace(browser) {
  log('\n== GRACE (en, iPhone 13 390x844, dark, night shift) ==');
  const friend = await friendSetup(browser, `charge_nurse_${RUN}`, 'Ward 5B Night Crew', 'handover');
  const G1 = await newPersona(browser, 'grace', {
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3,
    locale: 'en-PH', timezoneId: 'Asia/Manila', colorScheme: 'dark',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    net: NET.fast3g, cpu: 2
  });
  const g = G1.page;
  const uname = `grace_${RUN}`;

  await task('Grace', 'Open invite + sign up (dark mode followed?)', async (c) => {
    await g.goto(friend.invite, { timeout: 60_000 });
    await g.locator('form button[type=submit]').waitFor({ timeout: 90_000 });
    await shot(g, 'grace-01-invite');
    const bg = await g.evaluate(() => getComputedStyle(document.body).backgroundColor);
    c.detail(`body bg with prefers-color-scheme:dark = ${bg}`);
    c.tap(); c.tap(); c.tap(); c.tap();
    await uiRegister(g, uname);
    const accept = g.getByRole('button', { name: ACCEPT }).first();
    if (await accept.isVisible({ timeout: 5000 }).catch(() => false)) { await accept.tap(); c.tap(); } else {
      await g.goto(friend.invite); await g.getByRole('button', { name: ACCEPT }).first().tap(); c.tap(); c.detail('had to reopen invite');
    }
    await g.getByText('handover').first().waitFor({ timeout: 30_000 });
    if (!(await composer(g).isVisible().catch(() => false))) { await g.getByText('handover').first().tap(); c.tap(); }
    await composer(g).waitFor();
    await shot(g, 'grace-02-channel');
  });

  await task('Grace', 'Turn on push/desktop notifications', async (c) => {
    // Grace looks for a bell in the channel header, then settings.
    const bell = g.getByRole('button', { name: /Notification/i }).first();
    const vis = await bell.isVisible().catch(() => false);
    c.detail(`notification control in header visible=${vis}`);
    await shot(g, 'grace-03-header');
    const perm = await g.evaluate(() => (typeof Notification === 'undefined' ? 'unsupported' : Notification.permission));
    c.detail(`Notification.permission=${perm}`);
    // Open user settings -> Notifications
    const gear = g.getByRole('button', { name: /User settings|Settings/i }).first();
    if (await gear.isVisible().catch(() => false)) {
      await gear.tap(); c.tap();
      await g.waitForTimeout(800);
      const notifTab = g.getByRole('tab', { name: /Notifications/ }).or(g.getByRole('button', { name: /^Notifications$/ })).first();
      if (await notifTab.isVisible().catch(() => false)) { await notifTab.tap(); c.tap(); }
      await g.waitForTimeout(800);
      await shot(g, 'grace-04-notif-settings');
      const txt = await g.locator('[role="dialog"]').first().innerText().catch(() => '');
      c.detail(`settings mentions push/desktop: ${/desktop|push|browser/i.test(txt)}`);
      await g.keyboard.press('Escape');
    } else c.detail('no settings gear visible on phone chat screen');
  });

  // Grace goes to work: closes the tab. The ward chat keeps going.
  await G1.context.close();
  const burst = [];
  for (let i = 1; i <= 24; i += 1) burst.push(`Bed ${i}: vitals stable, meds given 0${(i % 9) + 1}:00`);
  for (const m of burst.slice(0, 12)) await friend.send(m);
  await friend.send(`@${uname} can you cover bed 14 at 3am? ${RUN}`);
  for (const m of burst.slice(12)) await friend.send(m);

  const G2 = await newPersona(browser, 'grace', {
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3,
    locale: 'en-PH', timezoneId: 'Asia/Manila', colorScheme: 'dark', net: NET.fast3g, cpu: 2
  });
  const g2 = G2.page;
  await task('Grace', 'Break-time catch-up: "what did I miss?" (login, find mention)', async (c) => {
    const t0 = Date.now();
    await g2.goto(BASE + '/', { timeout: 60_000 });
    await g2.locator('input[autocomplete="username"], input[name="username"]').first().fill(uname);
    await g2.locator('input[type="password"]').first().fill(PASSWORD);
    await g2.locator('form button[type=submit]').tap(); c.tap();
    await g2.getByRole('navigation').first().waitFor({ timeout: 60_000 });
    await g2.waitForTimeout(1500);
    await shot(g2, 'grace-05-reopen');
    const body = await g2.locator('body').innerText();
    c.detail(`landing shows unread/mention badge: ${/\b1\b|@/.test(body)}`);
    // she taps the server, then the channel
    const srvBadge = await g2.evaluate(() => [...document.querySelectorAll('nav *')].filter((e) => /^\d+$/.test(e.textContent.trim()) && e.children.length === 0).map((e) => e.closest('[title],[aria-label]')?.getAttribute('aria-label') || e.closest('[title]')?.title));
    c.detail(`numeric badges sit on: ${JSON.stringify(srvBadge)}`);
    const srv = g2.getByRole('button', { name: 'Ward 5B Night Crew' }).first();
    if (await srv.isVisible().catch(() => false)) { await srv.tap(); c.tap(); await g2.waitForTimeout(1500); await shot(g2, 'grace-05b-server-open'); }
    const ch = g2.locator('#channel-list').getByText('handover').first();
    if (await ch.isVisible().catch(() => false)) { await ch.tap(); c.tap(); }
    await composer(g2).waitFor({ timeout: 30_000 });
    await g2.waitForTimeout(1500);
    await shot(g2, 'grace-06-channel-catchup');
    const banner = g2.getByText(/new messages? since/i).first();
    const hasBanner = await banner.isVisible().catch(() => false);
    c.detail(`"N new messages since" banner: ${hasBanner ? await banner.innerText() : 'no'}`);
    const divider = await g2.getByText(/^New messages$|NEW/).first().isVisible().catch(() => false);
    c.detail(`"New" divider visible: ${divider}`);
    const mentionVisible = await msgRow(g2, `cover bed 14`).first().isVisible().catch(() => false);
    c.detail(`mention visible without scrolling: ${mentionVisible}`);
    c.detail(`time to catch-up screen ${Date.now() - t0}ms`);
    // Inbox for mentions
    const inbox = g2.getByTitle('Inbox').or(g2.getByRole('button', { name: /Inbox/ })).first();
    const inboxVis = await inbox.isVisible().catch(() => false);
    c.detail(`Inbox button on phone: ${inboxVis}`);
    if (inboxVis) { await inbox.tap(); c.tap(); await g2.waitForTimeout(1000); await shot(g2, 'grace-07-inbox'); await g2.keyboard.press('Escape'); }
  });

  await task('Grace', 'Background tab 30 s (socket drops), messages arrive meanwhile', async (c) => {
    await G2.context.setOffline(true);
    await G2.cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
    await friend.send(`Doctor rounds moved to 6am ${RUN}`);
    await g2.waitForTimeout(30_000);
    await G2.context.setOffline(false); await G2.setNet(NET.fast3g);
    const t0 = Date.now();
    const got = await msgRow(g2, `Doctor rounds moved`).first().waitFor({ timeout: 30_000 }).then(() => Date.now() - t0, () => null);
    c.detail(`missed message after 30s drop: ${got === null ? 'NOT SHOWN' : `${got}ms`}`);
    await shot(g2, 'grace-08-after-drop');
    if (got === null) throw new Error('missed message not recovered');
  });

  await task('Grace', 'Mute the noisy channel for 8 hours (sleep after shift)', async (c) => {
    const ch = g2.locator('#channel-list').getByText('handover').first();
    // on phone, first open the drawer
    const menuBtn = g2.getByRole('button', { name: /Show channels|menu/i }).first();
    if (await menuBtn.isVisible().catch(() => false)) { await menuBtn.tap(); c.tap(); await g2.waitForTimeout(600); }
    const bb = await ch.boundingBox();
    if (!bb) throw new Error('channel not reachable');
    // long-press channel (mobile habit) → context menu?
    await G2.cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: bb.x + 20, y: bb.y + bb.height / 2 }] });
    await g2.waitForTimeout(900);
    await G2.cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await g2.waitForTimeout(700); c.tap();
    await shot(g2, 'grace-09-longpress-channel');
    const mute = g2.getByRole('menuitem', { name: /Mute/ }).or(g2.getByRole('button', { name: /Mute channel/ })).first();
    const vis = await mute.isVisible().catch(() => false);
    c.detail(`mute option after long-press channel: ${vis}`);
    if (!vis) throw new Error('long-press on channel does nothing on touch');
    await mute.tap(); c.tap();
    await g2.waitForTimeout(600);
    await shot(g2, 'grace-10-mute-menu');
  });
  results.touch.graceChat = await smallTargets(g2);
  results.graceErrors = G2.errors.slice(0, 20);
  await G2.context.close();
  await friend.context.close();
}

// ============================================================================
async function omar(browser) {
  log('\n== OMAR (tr, tablet landscape 1280x800, voice hands-free) ==');
  const friend = await friendSetup(browser, `mehmet_${RUN}`, 'Taksi Durağı Kadıköy', 'genel-sohbet');
  const O = await newPersona(browser, 'omar', {
    viewport: { width: 1280, height: 800 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1.5,
    locale: 'tr-TR', timezoneId: 'Europe/Istanbul',
    userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-X200) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    permissions: ['microphone', 'camera'], net: NET.fast3g, cpu: 2
  });
  const o = O.page;
  await task('Omar', 'Open invite, sign up in Turkish, join', async (c) => {
    await o.goto(friend.invite, { timeout: 60_000 });
    await o.locator('form button[type=submit]').waitFor({ timeout: 90_000 });
    await shot(o, 'omar-01-invite');
    const txt = await o.locator('body').innerText();
    c.detail(`turkish UI: ${/[ığüşöçİ]/.test(txt)}`);
    c.tap(); c.tap(); c.tap(); c.tap();
    await uiRegister(o, `omar_${RUN}`);
    const accept = o.getByRole('button', { name: ACCEPT }).first();
    if (await accept.isVisible({ timeout: 5000 }).catch(() => false)) { await accept.tap(); c.tap(); } else {
      await o.goto(friend.invite); await o.getByRole('button', { name: ACCEPT }).first().tap(); c.tap(); c.detail('had to reopen invite');
    }
    await o.waitForTimeout(2000);
    await shot(o, 'omar-02-joined-landscape');
  });

  await task('Omar', 'Join voice channel hands-free', async (c) => {
    const voiceCh = o.locator('[aria-label*="ses" i], [aria-label*="voice" i]').filter({ hasText: /Genel|General|Lounge|Sohbet/i }).first();
    let target = voiceCh;
    if (!(await voiceCh.isVisible().catch(() => false))) {
      // Fall back to any voice channel row in the sidebar.
      const names = await o.evaluate(() => [...document.querySelectorAll('#channel-list button, #channel-list a, #channel-list [role="button"]')].map((e) => (e.getAttribute('aria-label') || e.innerText).trim()).slice(0, 20));
      c.detail(`sidebar rows: ${JSON.stringify(names)}`);
      target = o.locator('#channel-list').getByText(/Genel|General/).last();
    }
    await target.tap(); c.tap();
    await o.waitForTimeout(4000);
    await shot(o, 'omar-03-voice-joined');
    const body = await o.locator('body').innerText();
    c.detail(`voice connected text: ${(body.match(/(Ses Bağlant[^\n]*|Voice Connected|Bağlandı[^\n]*)/) || ['none'])[0]}`);
    const mute = o.getByRole('button', { name: /Sesi kapat|Mikrofonu kapat|Sustur|Mute/i }).first();
    const mb = await mute.boundingBox().catch(() => null);
    c.detail(`mute button ${mb ? `${Math.round(mb.width)}x${Math.round(mb.height)}` : 'not found'}`);
    const leave = o.getByRole('button', { name: /Bağlantıyı kes|Ayrıl|Disconnect|Leave/i }).first();
    const lb = await leave.boundingBox().catch(() => null);
    c.detail(`leave button ${lb ? `${Math.round(lb.width)}x${Math.round(lb.height)}` : 'not found'}`);
    results.touch.omarVoice = await smallTargets(o);
  });

  await task('Omar', 'Friend joins voice too; Omar sees who is talking', async (c) => {
    const fp = friend.page;
    await fp.locator('#channel-list').getByText(/General|Genel/).last().click().catch(() => {});
    await fp.waitForTimeout(4000);
    await shot(o, 'omar-04-two-in-voice');
    const body = await o.locator('body').innerText();
    c.detail(`friend listed in voice for Omar: ${body.includes('mehmet_')}`);
  });

  await task('Omar', 'Rotate to portrait and back while in voice', async (c) => {
    await o.setViewportSize({ width: 800, height: 1280 });
    await o.waitForTimeout(1200);
    await shot(o, 'omar-05-portrait');
    await o.setViewportSize({ width: 1280, height: 800 });
    await o.waitForTimeout(1200);
    const still = await o.locator('body').innerText();
    c.detail(`still in voice after rotate: ${/Bağlı|Connected|Bağlantı/.test(still)}`);
  });

  await task('Omar', 'Find push-to-talk / voice activity settings (Turkish)', async (c) => {
    const gear = o.getByRole('button', { name: /Kullanıcı Ayarları|Ayarlar|User settings/i }).first();
    await gear.tap(); c.tap();
    await o.waitForTimeout(800);
    const voiceTab = o.getByRole('tab', { name: /Ses ve Görüntü|Ses|Voice/i }).or(o.getByRole('button', { name: /Ses ve Görüntü|Voice & Video/i })).first();
    if (await voiceTab.isVisible().catch(() => false)) { await voiceTab.tap(); c.tap(); }
    await o.waitForTimeout(800);
    await shot(o, 'omar-06-voice-settings');
    const txt = await o.locator('[role="dialog"]').first().innerText().catch(() => '');
    const englishLeft = (txt.match(/\b(Push to Talk|Voice Activity|Input Device|Output Device|Noise|Echo)\b/g) || []);
    c.detail(`PTT option: ${/Bas-Konuş|Bas Konuş|Push to Talk/i.test(txt)}; english leftovers: ${JSON.stringify(englishLeft)}`);
    await o.keyboard.press('Escape');
  });
  results.omarErrors = O.errors.slice(0, 20);
  await O.context.close();
  await friend.context.close();
}

// ============================================================================
await boot();
const browser = await chromium.launch({
  executablePath: CHROMIUM,
  args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required']
});
try {
  if (PHASES.has('perf')) await perf(browser).catch((e) => note('perf', 'phase crashed: ' + e.message));
  if (PHASES.has('boonmee')) await boonmee(browser).catch((e) => note('boonmee', 'phase crashed: ' + e.message));
  if (PHASES.has('grace')) await grace(browser).catch((e) => note('grace', 'phase crashed: ' + e.message));
  if (PHASES.has('omar')) await omar(browser).catch((e) => note('omar', 'phase crashed: ' + e.message));
} finally {
  await browser.close();
  if (server) server.kill('SIGTERM');
  fs.rmSync(tmp, { recursive: true, force: true });
  const out = path.join(SHOTS, `${G}-results-${[...PHASES].join('_')}.json`);
  fs.writeFileSync(out, JSON.stringify(results, null, 2));
  log('\nresults →', out);
}
