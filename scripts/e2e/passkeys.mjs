#!/usr/bin/env node
// ============================================================================
//  Browser passkey round-trip against a real server, using Chromium's CDP
//  virtual authenticator (WebAuthn.addVirtualAuthenticator) — a real
//  navigator.credentials.create()/get() through Chrome's WebAuthn stack.
//
//    register → step-up with password → create passkey → sign out →
//    sign in with the passkey (no password) → rename → delete (sudo'd)
//
//  Setup:  npm i --no-save playwright-core   (CHROMIUM_PATH, default /opt/pw-browsers/chromium)
//  Usage:  node scripts/e2e/passkeys.mjs      Env: E2E_PASSKEY_PORT (default 4551)
// ============================================================================

import { spawn } from 'node:child_process';
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
const PORT = Number(process.env.E2E_PASSKEY_PORT || 4551);
const BASE = `http://localhost:${PORT}`;
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-passkeys-'));

let serverLog = '';
const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
  cwd: ROOT,
  env: {
    ...process.env,
    DATABASE_URL: '',
    NODE_ENV: 'development',
    PORT: String(PORT),
    HOST: '127.0.0.1',
    PUBLIC_URL: BASE,
    RP_ID: 'localhost',
    RP_ORIGIN: BASE,
    CORS_ORIGIN: '',
    DB_PATH: path.join(tmp, 'e2e.db'),
    STORAGE_ROOT: path.join(tmp, 'uploads'),
    ALLOW_DEV_IDENTITY: '0',
    LOG_LEVEL: 'warn'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});
server.stdout.on('data', (d) => { serverLog += d; });
server.stderr.on('data', (d) => { serverLog += d; });

const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}: ${err.message}`);
    throw err;
  }
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

// Runs in the page: JSON (base64url) ⇄ ArrayBuffer for navigator.credentials.
const PAGE_HELPERS = `
  window.__b64 = {
    toBuf: (s) => { const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)); return Uint8Array.from(b, (c) => c.charCodeAt(0)).buffer; },
    fromBuf: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '')
  };
  window.__api = async (method, url, body) => {
    const res = await fetch(url, { method, credentials: 'same-origin', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, body: await res.json().catch(() => null) };
  };
`;

let browser;
try {
  const deadline = Date.now() + 30_000;
  for (;;) {
    if (server.exitCode !== null) throw new Error(`server exited:\n${serverLog}`);
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* booting */ }
    if (Date.now() > deadline) throw new Error(`server not healthy:\n${serverLog}`);
    await new Promise((r) => setTimeout(r, 250));
  }

  browser = await chromium.launch({ executablePath: CHROMIUM, headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`${BASE}/api/health`);
  await page.addScriptTag({ content: PAGE_HELPERS });

  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true
    }
  });

  const username = `pk${Date.now().toString(36)}`;
  let passkeyId;

  await step('register an account and step up with the password', async () => {
    const reg = await page.evaluate((u) => window.__api('POST', '/api/auth/register', { username: u, password: 'correct-horse-battery-9' }), username);
    expect(reg.status === 201, `register ${reg.status}`);
    const sudo = await page.evaluate(() => window.__api('POST', '/api/passkeys/reauth/password', { password: 'correct-horse-battery-9' }));
    expect(sudo.status === 200, `reauth ${sudo.status} ${JSON.stringify(sudo.body)}`);
  });

  await step('create a passkey with navigator.credentials.create()', async () => {
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
      const response = {
        id: cred.id, rawId: fromBuf(cred.rawId), type: cred.type,
        authenticatorAttachment: cred.authenticatorAttachment,
        clientExtensionResults: cred.getClientExtensionResults(),
        response: {
          clientDataJSON: fromBuf(cred.response.clientDataJSON),
          attestationObject: fromBuf(cred.response.attestationObject),
          transports: cred.response.getTransports?.() ?? []
        }
      };
      return window.__api('POST', '/api/passkeys/register/verify', { flow_id: flowId, response, name: 'Virtual authenticator' });
    });
    expect(created.status === 201, `verify ${created.status} ${JSON.stringify(created.body)}`);
    passkeyId = created.body.id;
    const { credentials } = await cdp.send('WebAuthn.getCredentials', { authenticatorId });
    expect(credentials.length === 1 && credentials[0].isResidentCredential, 'resident credential stored in the authenticator');
  });

  await step('sign out, then sign in with the passkey alone', async () => {
    await page.evaluate(() => window.__api('POST', '/api/auth/logout'));
    const me = await page.evaluate(() => window.__api('GET', '/api/auth/me'));
    expect(me.status === 401, 'signed out');
    const login = await page.evaluate(async () => {
      const { body: { flow_id: flowId, options } } = await window.__api('POST', '/api/passkeys/login/options', {});
      const { toBuf, fromBuf } = window.__b64;
      const cred = await navigator.credentials.get({
        publicKey: { ...options, challenge: toBuf(options.challenge), allowCredentials: [] }
      });
      const response = {
        id: cred.id, rawId: fromBuf(cred.rawId), type: cred.type,
        authenticatorAttachment: cred.authenticatorAttachment,
        clientExtensionResults: cred.getClientExtensionResults(),
        response: {
          clientDataJSON: fromBuf(cred.response.clientDataJSON),
          authenticatorData: fromBuf(cred.response.authenticatorData),
          signature: fromBuf(cred.response.signature),
          userHandle: cred.response.userHandle ? fromBuf(cred.response.userHandle) : undefined
        }
      };
      return window.__api('POST', '/api/passkeys/login/verify', { flow_id: flowId, response });
    });
    expect(login.status === 200, `login ${login.status} ${JSON.stringify(login.body)}`);
    expect(login.body.user.username === username, 'signed in as the right account');
    const after = await page.evaluate(() => window.__api('GET', '/api/auth/me'));
    expect(after.status === 200, 'session cookie works');
  });

  await step('rename, then delete after a passkey step-up', async () => {
    const renamed = await page.evaluate((id) => window.__api('PATCH', `/api/passkeys/${id}`, { name: 'Laptop' }), passkeyId);
    expect(renamed.status === 200 && renamed.body.name === 'Laptop', 'renamed');
    const early = await page.evaluate((id) => window.__api('DELETE', `/api/passkeys/${id}`), passkeyId);
    expect(early.status === 401, 'delete needs sudo on a fresh session');
    const sudo = await page.evaluate(async () => {
      const { body: { flow_id: flowId, options } } = await window.__api('POST', '/api/passkeys/reauth/options', {});
      const { toBuf, fromBuf } = window.__b64;
      const cred = await navigator.credentials.get({
        publicKey: {
          ...options, challenge: toBuf(options.challenge),
          allowCredentials: options.allowCredentials.map((c) => ({ ...c, id: toBuf(c.id) }))
        }
      });
      const response = {
        id: cred.id, rawId: fromBuf(cred.rawId), type: cred.type, clientExtensionResults: {},
        response: {
          clientDataJSON: fromBuf(cred.response.clientDataJSON),
          authenticatorData: fromBuf(cred.response.authenticatorData),
          signature: fromBuf(cred.response.signature),
          userHandle: cred.response.userHandle ? fromBuf(cred.response.userHandle) : undefined
        }
      };
      return window.__api('POST', '/api/passkeys/reauth/verify', { flow_id: flowId, response });
    });
    expect(sudo.status === 200, `passkey step-up ${sudo.status} ${JSON.stringify(sudo.body)}`);
    const gone = await page.evaluate((id) => window.__api('DELETE', `/api/passkeys/${id}`), passkeyId);
    expect(gone.status === 200, `delete ${gone.status}`);
  });
} catch (err) {
  if (!results.some((r) => !r.ok)) console.error(err);
} finally {
  await browser?.close().catch(() => {});
  if (server.exitCode === null) server.kill('SIGTERM');
  fs.rmSync(tmp, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
const passed = results.length - failed;
console.log(`\npasskeys e2e: ${passed}/4 passed`);
process.exit(failed === 0 && passed === 4 ? 0 : 1);
