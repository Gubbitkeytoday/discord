#!/usr/bin/env node
// ============================================================================
//  Voice room browser check: two real users in one voice channel over the
//  peer mesh, with Chromium's fake camera/microphone.
//
//  - Call controls render with words under the icons, meet 44px targets on a
//    phone, carry their keyboard shortcuts, and never sit on top of the tiles.
//  - The phone layout has a labelled red "Leave" and a "More" menu.
//  - Mute / deafen changes are sent to the global announcer (app:announce).
//  - "Mute everyone" reaches the other person; "Unmute everyone" lifts it.
//  - Push-to-talk on a touch screen is a hold-to-talk button: holding it
//    transmits, letting go stops, and tapping it never turns PTT off.
//
//  Setup:  npm i --no-save playwright-core ; CHROMIUM_PATH (default /opt/pw-browsers/chromium)
//  Usage:  npm run e2e:voice [-- --build] [-- --headed] [-- --keep]
//  Env:    E2E_VOICE_PORT (default 4570), E2E_SHOTS
// ============================================================================

import crypto from 'node:crypto';
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
const args = new Set(process.argv.slice(2));
const PORT = Number(process.env.E2E_VOICE_PORT || process.env.E2E_PORT || 4570);
const BASE = `http://localhost:${PORT}`;
const SHOTS = process.env.E2E_SHOTS
  || path.join(os.tmpdir(), 'e2e-voice-shots');
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const RUN = crypto.randomBytes(3).toString('hex');
const PASSWORD = 'correct-horse-battery-9';
const T = 10_000;

fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
let pages = {};
async function step(name, fn, { critical = false } = {}) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  \x1b[32mPASS\x1b[0m ${name} (${Date.now() - t0}ms)`);
  } catch (err) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50);
    for (const [who, p] of Object.entries(pages)) {
      if (p && !p.isClosed()) await p.screenshot({ path: path.join(SHOTS, `e2e-voice-${slug}-${who}.png`) }).catch(() => {});
    }
    results.push({ name, ok: false, error: String(err?.message ?? err).split('\n')[0] });
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}: ${String(err?.message ?? err).split('\n')[0]}`);
    if (critical) throw new Error(`critical step failed: ${name}`);
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }
const visible = (loc, what, timeout = T) =>
  loc.first().waitFor({ state: 'visible', timeout }).catch(() => { throw new Error(`not visible: ${what}`); });

// --- server -------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-voice-'));
let server;
let serverLog = '';
async function bootServer() {
  if (args.has('--build') || !fs.existsSync(path.join(ROOT, 'dist/index.html'))) {
    const r = spawnSync('npx', ['vite', 'build'], { cwd: ROOT, stdio: 'inherit' });
    if (r.status !== 0) throw new Error('vite build failed');
  }
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(PORT),
      HOST: '127.0.0.1',
      PUBLIC_URL: BASE,
      CORS_ORIGIN: '',
      DB_PATH: path.join(tmp, 'e2e.db'),
      STORAGE_ROOT: path.join(tmp, 'uploads'),
      SERVE_STATIC: '1',
      ALLOW_DEV_IDENTITY: '0',
      MAIL_TRANSPORT: 'console',
      LOG_LEVEL: 'warn',
      // Mesh mode: no SFU, whatever the shell has.
      LIVEKIT_URL: '', LIVEKIT_API_KEY: '', LIVEKIT_API_SECRET: ''
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited early:\n${serverLog}`);
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not become healthy:\n${serverLog}`);
}
function stopServer() {
  if (server && server.exitCode === null) server.kill('SIGTERM');
  if (!args.has('--keep')) fs.rmSync(tmp, { recursive: true, force: true });
}

// --- users --------------------------------------------------------------------
const pageErrors = [];
async function newUser(browser, who, contextOpts = {}) {
  const context = await browser.newContext({
    viewport: { width: 1366, height: 860 },
    permissions: ['microphone', 'camera'],
    ...contextOpts
  });
  await context.route((url) => !url.href.startsWith(BASE) && /^https?:/.test(url.href), (route) => route.abort());
  context.setDefaultTimeout(T);
  // Record what the voice room asks the global announcer to say.
  await context.addInitScript(() => {
    window.__announced = [];
    window.addEventListener('app:announce', (e) => window.__announced.push(e.detail?.message));
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => pageErrors.push(`${who}: ${String(e).slice(0, 200)}`));
  page.httpErrors = [];
  page.on('response', (r) => { if (r.status() >= 400 && r.url().startsWith(BASE)) page.httpErrors.push(`${r.status()} ${r.url().replace(BASE, '')}`); });
  return { context, page };
}

async function call(context, method, url, data) {
  const res = await context.request.fetch(BASE + url, {
    method, data, headers: { 'Content-Type': 'application/json', Origin: BASE }
  });
  const body = await res.json().catch(() => null);
  if (!res.ok()) throw new Error(`${method} ${url} → ${res.status()} ${JSON.stringify(body)?.slice(0, 200)}`);
  return body;
}
const register = (context, username) => call(context, 'POST', '/api/auth/register', { username, password: PASSWORD });

const controls = (page) => page.getByTestId('voice-controls');
const tiles = (page) => page.getByTestId('voice-tile');

async function openVoice(page, serverId, channelId) {
  await page.goto(`${BASE}/channels/${serverId}/${channelId}`);
  await visible(controls(page), 'voice controls');
}

// ============================================================================
async function main() {
  console.log(`e2e voice run ${RUN} → ${BASE}`);
  await bootServer();
  const browser = await chromium.launch({
    executablePath: CHROMIUM,
    headless: !args.has('--headed'),
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required']
  });
  const A = await newUser(browser, 'alice');
  const B = await newUser(browser, 'bob');
  pages = { alice: A.page, bob: B.page };
  const a = A.page;
  const b = B.page;
  let serverId;
  let voiceId;
  let invite;

  try {
    await step('set up: two users, a server, its voice channel', async () => {
      await register(A.context, `alice_${RUN}`);
      await register(B.context, `bob_${RUN}`);
      const guild = await call(A.context, 'POST', '/api/servers', { name: `Voice ${RUN}` });
      serverId = guild.id;
      const detail = await call(A.context, 'GET', `/api/servers/${serverId}`);
      voiceId = (detail.channels ?? []).find((c) => c.type === 'voice')?.id;
      assert(voiceId, 'the new server has a voice channel');
      invite = await call(A.context, 'POST', `/api/servers/${serverId}/invites`, { maxAge: 0 });
      await call(B.context, 'POST', `/api/invites/${invite.code}/accept`, {});
    }, { critical: true });

    await step('both join the voice channel over the mesh', async () => {
      await openVoice(a, serverId, voiceId);
      await openVoice(b, serverId, voiceId);
      await a.waitForFunction(() => document.querySelectorAll('[data-testid="voice-tile"]').length === 2, null, { timeout: T });
      await b.waitForFunction(() => document.querySelectorAll('[data-testid="voice-tile"]').length === 2, null, { timeout: T });
      const backend = a.getByTestId('voice-backend');
      assert(await backend.getAttribute('data-backend') === 'mesh', 'mesh mode');
      await a.waitForFunction(() => document.querySelector('[data-testid="voice-backend"]')?.dataset.state === 'connected', null, { timeout: 15_000 });
      const text = await backend.innerText();
      assert(!/P2P|SFU/.test(text), `transport jargon is hidden (got "${text}")`);
    }, { critical: true });

    await step('desktop: every control has a visible word; shortcuts are declared', async () => {
      for (const [id, word] of [['voice-mute', 'Mute'], ['voice-deafen', 'Deafen'], ['voice-camera', 'Camera'], ['voice-leave', 'Leave'], ['voice-noise', 'Noise filter']]) {
        const btn = a.getByTestId(id);
        await visible(btn, id);
        const shown = await btn.innerText();
        assert(shown.includes(word), `${id} shows "${word}" (got "${shown}")`);
        const box = await btn.boundingBox();
        assert(box.width >= 44 && box.height >= 44, `${id} is at least 44×44 (got ${Math.round(box.width)}×${Math.round(box.height)})`);
      }
      assert(await a.getByTestId('voice-mute').getAttribute('aria-keyshortcuts') === 'Control+Shift+M', 'mute declares Ctrl+Shift+M');
      assert(await a.getByTestId('voice-deafen').getAttribute('aria-keyshortcuts') === 'Control+Shift+D', 'deafen declares Ctrl+Shift+D');
      // The old push-to-talk toggle in the bar is gone (it lives in settings).
      assert(await a.getByRole('button', { name: /^Push to talk$/ }).count() === 0, 'no PTT mode toggle in the call bar');
      await a.screenshot({ path: path.join(SHOTS, 'polish-voice-e2e-desktop.png') });
    });

    await step('controls sit below the tiles, never on top of them', async () => {
      const bar = await controls(a).boundingBox();
      const lastTile = await tiles(a).last().boundingBox();
      const grid = await tiles(a).first().evaluate((el) => el.parentElement.getBoundingClientRect().bottom);
      assert(grid <= bar.y + 1, `tile area (bottom ${Math.round(grid)}) ends above the controls (top ${Math.round(bar.y)})`);
      assert(lastTile.y < bar.y, 'the last tile starts above the controls');
    });

    await step('labels fold away on wide screens and come back', async () => {
      await a.getByTestId('voice-labels-toggle').click();
      await a.waitForFunction(() => document.querySelector('[data-testid="voice-controls"]')?.dataset.labels === 'off');
      const name = await a.getByTestId('voice-mute').getAttribute('aria-label');
      assert(name === 'Mute', 'the accessible name stays when the word is hidden');
      await a.getByTestId('voice-labels-toggle').click();
      await a.waitForFunction(() => document.querySelector('[data-testid="voice-controls"]')?.dataset.labels === 'on');
    });

    await step('Ctrl+Shift+M mutes and is announced to screen readers', async () => {
      await a.evaluate(() => { window.__announced = []; document.activeElement?.blur?.(); });
      await a.keyboard.press('Control+Shift+M');
      await a.waitForFunction(() => document.querySelector('[data-testid="voice-mute"]')?.getAttribute('aria-pressed') === 'true');
      await a.waitForFunction(() => window.__announced.some((m) => /muted/i.test(m)));
      await a.keyboard.press('Control+Shift+M');
      await a.waitForFunction(() => document.querySelector('[data-testid="voice-mute"]')?.getAttribute('aria-pressed') === 'false');
      await a.waitForFunction(() => window.__announced.some((m) => /Microphone on/i.test(m)));
    });

    await step('owner mutes everyone; the other person is told, then unmuted', async () => {
      await visible(a.getByTestId('voice-mod-strip'), 'moderator strip for the owner');
      assert(await b.getByTestId('voice-mod-strip').count() === 0, 'a plain member has no moderator strip');
      await a.getByRole('button', { name: 'Mute everyone' }).click();
      await visible(b.getByTestId('voice-server-muted'), 'server-muted banner on bob');
      await visible(a.getByRole('button', { name: 'Unmute everyone' }), 'unmute everyone appears');
      await a.getByRole('button', { name: 'Unmute everyone' }).click();
      await b.getByTestId('voice-server-muted').waitFor({ state: 'hidden', timeout: T });
    });

    // --- phone ---------------------------------------------------------------
    const M = await newUser(browser, 'carol-phone', {
      viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2
    });
    pages['carol-phone'] = M.page;
    const m = M.page;

    await step('phone: push-to-talk user joins; hold-to-talk button, no keyboard wording', async () => {
      await register(M.context, `carol_${RUN}`);
      await call(M.context, 'POST', `/api/invites/${invite.code}/accept`, {});
      await call(M.context, 'PATCH', '/api/settings/preferences/voice', { inputMode: 'ptt', pushToTalk: true });
      await openVoice(m, serverId, voiceId);
      const ptt = m.getByTestId('voice-ptt');
      await visible(ptt, 'hold-to-talk button').catch(async (err) => {
        const server = await m.evaluate(() => fetch('/api/settings/preferences').then((r) => r.json()).then((j) => j.voice?.inputMode));
        throw new Error(`${err.message} (server inputMode=${server}; http errors: ${m.httpErrors.join(', ')})`);
      });
      const box = await ptt.boundingBox();
      const coarse = await m.evaluate(() => matchMedia('(pointer: coarse)').matches);
      if (coarse) assert(box.height >= 72, `hold-to-talk is at least 72px tall on touch (got ${Math.round(box.height)})`);
      const shown = await ptt.innerText();
      assert(/Hold to talk/.test(shown), `says "Hold to talk" (got "${shown}")`);
      if (coarse) assert(!/Space|hold Space|key/i.test(shown), `no keyboard wording on touch (got "${shown}")`);
      assert(await ptt.getAttribute('aria-pressed') === 'false', 'not transmitting before holding');
    });

    await step('phone: holding the button transmits, releasing stops, PTT stays on', async () => {
      const ptt = m.getByTestId('voice-ptt');
      const box = await ptt.boundingBox();
      const x = box.x + box.width / 2;
      const y = box.y + box.height / 2;
      const cdp = await M.context.newCDPSession(m);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
      await m.waitForFunction(() => document.querySelector('[data-testid="voice-ptt"]')?.getAttribute('aria-pressed') === 'true', null, { timeout: 3000 });
      const held = await ptt.innerText();
      assert(/Talking/.test(held), `shows "Talking" while held (got "${held}")`);
      await m.waitForTimeout(400);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await m.waitForFunction(() => document.querySelector('[data-testid="voice-ptt"]')?.getAttribute('aria-pressed') === 'false', null, { timeout: 3000 });
      // A quick tap (what used to switch PTT off) leaves the mode alone.
      await ptt.tap();
      await m.waitForTimeout(300);
      await visible(m.getByTestId('voice-ptt'), 'hold-to-talk still there after a tap');
    });

    await step('phone: labelled red Leave, More menu, 44px targets, no sideways scroll', async () => {
      const leave = m.getByTestId('voice-leave');
      const text = await leave.innerText();
      assert(/Leave/.test(text), `Leave has its word (got "${text}")`);
      const lb = await leave.boundingBox();
      assert(lb.height >= 44 && lb.width >= 88, `Leave is a big pill (got ${Math.round(lb.width)}×${Math.round(lb.height)})`);
      for (const id of ['voice-mute', 'voice-deafen', 'voice-camera', 'voice-more']) {
        const bb = await m.getByTestId(id).boundingBox();
        assert(bb && bb.width >= 44 && bb.height >= 44, `${id} ≥ 44px on the phone (got ${bb && `${Math.round(bb.width)}×${Math.round(bb.height)}`})`);
      }
      const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert(overflow <= 1, `no horizontal overflow (${overflow}px)`);
      await m.getByTestId('voice-more').tap();
      await visible(m.getByRole('group', { name: 'More' }).getByRole('button', { name: /Noise filter/ }), 'noise filter in More');
      await m.screenshot({ path: path.join(SHOTS, 'polish-voice-e2e-phone.png') });
      await m.getByTestId('voice-more').tap();
    });

    await step('three people are in the room for everyone', async () => {
      await a.waitForFunction(() => document.querySelectorAll('[data-testid="voice-tile"]').length === 3, null, { timeout: T });
    });

    await step('no page errors', async () => {
      assert(pageErrors.length === 0, pageErrors.join(' | '));
    });
  } finally {
    await browser.close().catch(() => {});
    stopServer();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} voice steps passed`);
  for (const f of failed) console.log(`  - ${f.name}: ${f.error}`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  stopServer();
  process.exit(1);
});
