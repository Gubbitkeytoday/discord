#!/usr/bin/env node
// ============================================================================
//  Browser checks for the client integrations of passkeys, message
//  translation and realtime catch-up, against a real server process:
//
//    1. the login screen offers "Sign in with a passkey" (server has passkeys
//       on via PUBLIC_URL / RP_ID / RP_ORIGIN, as scripts/e2e/passkeys.mjs
//       does) and the username field carries autocomplete="username webauthn";
//       clicking it signs in through Chromium's CDP virtual authenticator
//    2. a Thai message gets a Translate button in the hover bar and shows the
//       translation from a mock LibreTranslate served by this process
//    3. the server restarts (SIGTERM → server_draining): the reconnect banner
//       appears; a message posted while the client is away shows up after it
//       reconnects (REST catch-up, since a restarted single instance cannot
//       recover the socket session), and the banner goes away
//
//  Setup:  npm run build && npm i --no-save playwright-core
//  Usage:  node scripts/e2e/integration.mjs     Env: E2E_INTEGRATION_PORT (default 6951), CHROMIUM_PATH
// ============================================================================

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
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
const PORT = Number(process.env.E2E_INTEGRATION_PORT || 6951);
const BASE = `http://localhost:${PORT}`;
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const PASSWORD = 'correct-horse-battery-9';
const T = 10_000;
const ACCOUNT_TAB = 'Account & security';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-integration-'));

if (!fs.existsSync(path.join(ROOT, 'dist/index.html'))) {
  console.error('dist/ is missing. Run: npm run build');
  process.exit(2);
}

// --- mock LibreTranslate ------------------------------------------------------------
const mock = { calls: 0 };
const mockServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url !== '/translate') { res.statusCode = 404; res.end('{}'); return; }
    mock.calls += 1;
    const body = raw ? JSON.parse(raw) : {};
    const q = Array.isArray(body.q) ? body.q : [body.q];
    res.end(JSON.stringify({
      translatedText: q.map((s) => `EN[${s}]`),
      detectedLanguage: q.map(() => ({ confidence: 95, language: 'th' }))
    }));
  });
});
await new Promise((r) => mockServer.listen(0, '127.0.0.1', r));
const mockUrl = `http://127.0.0.1:${mockServer.address().port}`;

// --- app server (restartable, same DB) ---------------------------------------------
let server = null;
let serverLog = '';
async function bootServer() {
  serverLog = '';
  server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATABASE_URL: '',
      REDIS_URL: '',
      NODE_ENV: 'development',
      PORT: String(PORT),
      HOST: '127.0.0.1',
      PUBLIC_URL: BASE,
      RP_ID: 'localhost',
      RP_ORIGIN: BASE,
      CORS_ORIGIN: '',
      DB_PATH: path.join(tmp, 'e2e.db'),
      STORAGE_ROOT: path.join(tmp, 'uploads'),
      SERVE_STATIC: '1',
      ALLOW_DEV_IDENTITY: '0',
      MAIL_TRANSPORT: 'console',
      LOG_LEVEL: 'warn',
      LIBRETRANSLATE_URL: `${mockUrl}/`,
      TRANSLATION_PROVIDERS: 'libretranslate',
      // Force the server path: headless Chromium may expose a Translator API
      // that would try to download a language pack.
      TRANSLATION_CLIENT_ENABLED: '0'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (server.exitCode !== null) throw new Error(`server exited:\n${serverLog}`);
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* booting */ }
    if (Date.now() > deadline) throw new Error(`server not healthy:\n${serverLog}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}
async function stopServer() {
  if (!server || server.exitCode !== null) return;
  const exited = new Promise((r) => server.once('exit', r));
  server.kill('SIGTERM');
  await Promise.race([exited, new Promise((r) => setTimeout(r, 15_000))]);
  if (server.exitCode === null) server.kill('SIGKILL');
}

// --- tiny runner --------------------------------------------------------------------
const results = [];
const SHOTS = process.env.E2E_SHOTS || null;
let currentPage = null;
async function step(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } catch (err) {
    results.push({ name, ok: false });
    if (SHOTS && currentPage) {
      const file = path.join(SHOTS, `integration-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 50)}.png`);
      await currentPage.screenshot({ path: file }).catch(() => {});
      console.log(`       screenshot: ${file}`);
    }
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}: ${String(err?.message ?? err).split('\n')[0]}`);
  }
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const visible = (loc, what, timeout = T) =>
  loc.first().waitFor({ state: 'visible', timeout }).catch(() => { throw new Error(`not visible: ${what}`); });
const hidden = (loc, what, timeout = T) =>
  loc.first().waitFor({ state: 'hidden', timeout }).catch(() => { throw new Error(`still visible: ${what}`); });

const B64 = `
  window.__b64 = {
    toBuf: (s) => { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)); return Uint8Array.from(b, (c) => c.charCodeAt(0)).buffer; },
    fromBuf: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '')
  };
  window.__api = async (method, url, body) => {
    const res = await fetch(url, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
`;
const pageApi = (page, method, url, body) => page.evaluate(
  ([m, u, b]) => window.__api(m, u, b), [method, url, body]
);

let browser;
const errors = [];
try {
  await bootServer();
  browser = await chromium.launch({ executablePath: CHROMIUM, headless: true });
  const context = await browser.newContext({ viewport: { width: 1366, height: 860 } });
  await context.route((url) => !url.href.startsWith(BASE) && /^https?:/.test(url.href), (route) => route.abort());
  context.setDefaultTimeout(T);
  await context.addInitScript({ content: B64 });
  const page = await context.newPage();
  currentPage = page;
  page.on('pageerror', (e) => errors.push(String(e.stack ?? e).slice(0, 300)));

  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true
    }
  });

  const username = `int${Date.now().toString(36)}`;
  let serverId;
  let channelId;
  // Node-side requests ride on the browser's session cookie.
  const cookieHeader = async () => (await context.cookies(BASE)).map((c) => `${c.name}=${c.value}`).join('; ');

  await step('login screen offers "Sign in with a passkey" + webauthn autofill', async () => {
    await page.goto(`${BASE}/`);
    await visible(page.getByRole('button', { name: 'Sign in with a passkey' }), 'passkey button');
    const ac = await page.getByLabel(/Username/).getAttribute('autocomplete');
    expect(ac === 'username webauthn', `autocomplete is "${ac}"`);
  });

  await step('register, create a passkey, sign out, sign in with the passkey button', async () => {
    const reg = await pageApi(page, 'POST', '/api/auth/register', { username, password: PASSWORD });
    expect(reg.status === 201, `register ${reg.status}`);
    const sudo = await pageApi(page, 'POST', '/api/passkeys/reauth/password', { password: PASSWORD });
    expect(sudo.status === 200, `reauth ${sudo.status}`);
    const created = await page.evaluate(async () => {
      const { body: { flow_id: flowId, options } } = await window.__api('POST', '/api/passkeys/register/options', {});
      const { toBuf, fromBuf } = window.__b64;
      const cred = await navigator.credentials.create({
        publicKey: {
          ...options,
          challenge: toBuf(options.challenge),
          user: { ...options.user, id: toBuf(options.user.id) },
          excludeCredentials: (options.excludeCredentials ?? []).map((c) => ({ ...c, id: toBuf(c.id) }))
        }
      });
      return window.__api('POST', '/api/passkeys/register/verify', {
        flow_id: flowId,
        name: 'Virtual authenticator',
        response: {
          id: cred.id, rawId: fromBuf(cred.rawId), type: cred.type,
          authenticatorAttachment: cred.authenticatorAttachment,
          clientExtensionResults: cred.getClientExtensionResults(),
          response: {
            clientDataJSON: fromBuf(cred.response.clientDataJSON),
            attestationObject: fromBuf(cred.response.attestationObject),
            transports: cred.response.getTransports?.() ?? []
          }
        }
      });
    });
    expect(created.status === 201, `passkey ${created.status} ${JSON.stringify(created.body)}`);
    await pageApi(page, 'POST', '/api/auth/logout');
    // Only the button path here: with automatic presence simulation the
    // virtual authenticator could also satisfy the autofill (conditional)
    // request on its own, which would race the click.
    await page.addInitScript(() => {
      if (window.PublicKeyCredential) window.PublicKeyCredential.isConditionalMediationAvailable = async () => false;
    });
    await page.goto(`${BASE}/`);
    await page.getByRole('button', { name: 'Sign in with a passkey' }).click();
    await visible(page.getByRole('navigation', { name: 'Servers' }), 'app shell after passkey sign-in');
    const me = await pageApi(page, 'GET', '/api/auth/me');
    expect(me.body?.user?.username === username, 'signed in as the passkey owner');
  });

  await step('Security settings list the passkey', async () => {
    await page.getByRole('button', { name: 'User settings' }).first().click();
    await page.getByRole('dialog').getByRole('button', { name: ACCOUNT_TAB }).first().click();
    await visible(page.getByRole('heading', { name: 'Passkeys' }), 'Passkeys section');
    await visible(page.getByText('Virtual authenticator'), 'registered passkey listed');
    await page.keyboard.press('Escape');
  });

  await step('Translate button on a Thai message shows the mocked translation', async () => {
    const created = await pageApi(page, 'POST', '/api/servers', { name: 'Integration guild' });
    expect(created.status === 200, `create server ${created.status}`);
    serverId = created.body.id;
    const detail = await pageApi(page, 'GET', `/api/servers/${serverId}`);
    channelId = detail.body.channels.find((c) => c.type === 'text').id;
    const thai = 'สวัสดีครับ วันนี้อากาศดีมาก';
    const sent = await pageApi(page, 'POST', '/api/messages', { channel_id: channelId, content: thai });
    expect(sent.status === 200, `post ${sent.status}`);
    await page.goto(`${BASE}/channels/${serverId}/${channelId}`);
    const row = page.locator('[id^="message-"]').filter({ hasText: thai }).first();
    await visible(row, 'Thai message');
    await row.hover();
    const button = row.getByRole('button', { name: 'Translate', exact: true });
    await visible(button, 'Translate button in the hover bar');
    await button.click();
    await visible(row.getByText(`EN[${thai}]`), 'translated text');
    await visible(row.getByText(/Translated from/), 'translation attribution');
    expect(mock.calls >= 1, 'mock LibreTranslate was called');
    await row.getByRole('button', { name: 'Show original' }).first().click();
    await hidden(row.getByText(`EN[${thai}]`), 'translation hidden again');
  });

  await step('server restart: reconnect banner, then missed messages appear', async () => {
    // Warm up so the gateway is identified and in the channel room.
    await visible(page.locator('[id^="message-"]').first(), 'channel loaded');
    const stopping = stopServer();
    // SIGTERM → server_draining → the quiet "Reconnecting…" strip.
    await visible(page.getByTestId('connection-banner'), 'reconnect banner on drain', 8000);
    await stopping;
    // Keep the client away while a message is posted, so it can only arrive
    // through the REST catch-up after the reconnect.
    await context.setOffline(true);
    await bootServer();
    const missed = `missed while away ${Date.now().toString(36)}`;
    const res = await fetch(`${BASE}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: await cookieHeader() },
      body: JSON.stringify({ channel_id: channelId, content: missed })
    });
    expect(res.ok, `post while away ${res.status}`);
    await visible(page.getByTestId('connection-banner'), 'banner while offline');
    await context.setOffline(false);
    await visible(page.locator('[id^="message-"]').filter({ hasText: missed }), 'missed message after reconnect', 20_000);
    await hidden(page.getByTestId('connection-banner'), 'banner gone after reconnect', 10_000);
  });

  await step('crash (no drain): "Connection lost" banner, "Retry now" reconnects', async () => {
    const exited = new Promise((r) => server.once('exit', r));
    server.kill('SIGKILL');
    await exited;
    const banner = page.getByTestId('connection-banner');
    await visible(banner.getByText(/Connection lost/), '"Connection lost" banner', 8000);
    expect(await banner.getAttribute('data-status') === 'reconnecting', 'status is reconnecting');
    // Hold the client in "reconnecting" while the server is down, then press
    // Retry the moment it is back. The automatic backoff may win the race and
    // reconnect first — that is correct behaviour too, so either way the
    // banner must disappear.
    const retry = banner.getByRole('button', { name: 'Retry now' });
    await visible(retry, '"Retry now" button', 5000);
    await bootServer();
    await retry.click({ timeout: 3000 }).catch(async () => {
      expect(!(await banner.isVisible().catch(() => false)), 'Retry now clickable or already reconnected');
    });
    await hidden(banner, 'banner gone after retry', 10_000);
  });
} catch (err) {
  console.error(err);
  results.push({ name: 'harness', ok: false });
} finally {
  await browser?.close().catch(() => {});
  await stopServer();
  mockServer.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (errors.length) console.log(`page errors:\n  ${errors.join('\n  ')}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed || errors.length ? 1 : 0);
