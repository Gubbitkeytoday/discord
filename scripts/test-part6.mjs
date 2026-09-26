#!/usr/bin/env node
// ============================================================================
//  Security regressions: account takeover paths, enumeration, session
//  lifecycle, voice eviction, TOTP replay, input hygiene, the image proxy —
//  and the audit's proof-of-concept scripts run against a server booted
//  exactly as in production.
// ============================================================================

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { io as ioClient } from 'socket.io-client';

import {
  startServer, stopServer, api, get, asSession, login, BASE, TEST_DATABASE_URL
} from './testHarness.mjs';
import { generateCode } from '../lib/totp.js';

const run = promisify(execFile);
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const unique = (p) => `${p}${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;

before(startServer);
after(stopServer);

async function register(prefix, extra = {}) {
  const username = unique(prefix);
  const { status, body } = await api('POST', '/api/auth/register', {
    username, password: 'correct-horse-battery', ...extra
  }, { 'x-user-id': '' });
  assert.equal(status, 201, JSON.stringify(body));
  return { username, token: body.token, id: body.user.id, body };
}

function connect(auth) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(BASE, { transports: ['websocket'], forceNew: true, reconnection: false });
    const fail = setTimeout(() => reject(new Error('socket did not identify')), 5000);
    socket.on('connect', () => socket.emit('identify', auth));
    socket.on('identified', () => { clearTimeout(fail); resolve(socket); });
    socket.on('identify_error', (e) => { clearTimeout(fail); reject(new Error(JSON.stringify(e))); });
  });
}
const waitFor = (socket, event, ms = 3000) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve(null), ms);
  socket.once(event, (payload) => { clearTimeout(timer); resolve(payload ?? true); });
});

// ---------------------------------------------------------------------------

describe('registration and login', () => {
  test('a taken username is a clean 409 USERNAME_TAKEN, in English', async () => {
    const first = await register('dupe');
    const again = await api('POST', '/api/auth/register', {
      username: first.username, password: 'another-password-1'
    }, { 'x-user-id': '' });
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'USERNAME_TAKEN');
    assert.ok(!/[฀-๿]/.test(again.body.error), 'error text must be English');
    assert.ok(!/SQLITE|constraint|23505/i.test(JSON.stringify(again.body)));
  });

  test('registering with someone else\'s e-mail is indistinguishable and does not take it', async () => {
    const owner = await register('owner', { email: `${unique('o')}@example.test` });
    const email = owner.body.user.email;
    const fresh = await register('fresh', { email: `${unique('f')}@example.test` });
    const squatter = await register('squat', { email });

    // Same status and shape as a registration with a new address.
    assert.deepEqual(Object.keys(squatter.body).sort(), Object.keys(fresh.body).sort());
    assert.equal(squatter.body.user.email, email);
    // …but the address stays with its owner.
    const { getQuery } = await import('../db.js');
    assert.equal((await getQuery(`SELECT email FROM users WHERE id = ?`, [squatter.id])).email, null);
    assert.equal((await getQuery(`SELECT email FROM users WHERE id = ?`, [owner.id])).email, email);
  });

  test('login matches exactly one account: username, or e-mail when it contains @', async () => {
    const account = await register('who', { email: `${unique('w')}@example.test` });
    assert.equal((await login(account.username, 'correct-horse-battery')).status, 200);
    assert.equal((await login(account.body.user.email, 'correct-horse-battery')).status, 200);
    // An internal id is not a login name.
    assert.equal((await login(account.id, 'correct-horse-battery')).status, 401);
    const bad = await login(account.username, 'wrong-password');
    assert.equal(bad.status, 401);
  });

  test('auth errors carry stable machine codes', async () => {
    const res = await api('POST', '/api/auth/login', { username: 'nobody-at-all', password: 'x' }, { 'x-user-id': '' });
    assert.equal(res.body.code, 'INVALID_CREDENTIALS');
    assert.ok(!/[฀-๿]/.test(res.body.error));
    const weak = await api('POST', '/api/auth/register', { username: unique('weak'), password: 'short' }, { 'x-user-id': '' });
    assert.equal(weak.body.code, 'WEAK_PASSWORD');
  });
});

describe('sessions', () => {
  test('logging out disconnects the sockets of that session only', async () => {
    const account = await register('sock');
    const second = await login(account.username, 'correct-horse-battery');
    const a = await connect({ token: account.token });
    const b = await connect({ token: second.token });
    try {
      const revokedA = waitFor(a, 'session_revoked');
      const droppedA = waitFor(a, 'disconnect');
      const droppedB = waitFor(b, 'disconnect', 800);
      const out = await asSession(account.token, 'POST', '/api/auth/logout');
      assert.equal(out.status, 200);
      assert.ok(await revokedA, 'session_revoked not delivered');
      assert.ok(await droppedA, 'socket of the revoked session stayed connected');
      assert.equal(await droppedB, null, 'another device\'s socket was dropped too');
    } finally {
      a.close(); b.close();
    }
  });

  test('revoking a device from the sessions list drops its socket', async () => {
    const account = await register('dev');
    const other = await login(account.username, 'correct-horse-battery');
    const socket = await connect({ token: other.token });
    try {
      const sessions = await asSession(account.token, 'GET', '/api/auth/sessions');
      const target = sessions.body.find((s) => !s.current);
      const dropped = waitFor(socket, 'disconnect');
      await asSession(account.token, 'DELETE', `/api/auth/sessions/${target.id}`);
      assert.ok(await dropped);
      assert.equal((await asSession(other.token, 'GET', '/api/auth/me')).status, 401);
    } finally {
      socket.close();
    }
  });

  test('an idle session expires even within its lifetime', async () => {
    const account = await register('idle');
    assert.equal((await asSession(account.token, 'GET', '/api/auth/me')).status, 200);
    const { runQuery } = await import('../db.js');
    const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
    await runQuery(`UPDATE sessions SET last_seen_at = ? WHERE user_id = ?`, [old, account.id]);
    assert.equal((await asSession(account.token, 'GET', '/api/auth/me')).status, 401);
  });
});

describe('two-factor authentication', () => {
  test('a TOTP code cannot be used twice', async () => {
    const account = await register('replay');
    const begun = await asSession(account.token, 'POST', '/api/auth/mfa/begin');
    await asSession(account.token, 'POST', '/api/auth/mfa/confirm', { code: generateCode(begun.body.secret) });
    const code = generateCode(begun.body.secret);
    const first = await api('POST', '/api/auth/login', {
      username: account.username, password: 'correct-horse-battery', mfa_code: code
    }, { 'x-user-id': '' });
    assert.equal(first.status, 200);
    const replay = await api('POST', '/api/auth/login', {
      username: account.username, password: 'correct-horse-battery', mfa_code: code
    }, { 'x-user-id': '' });
    assert.equal(replay.status, 401);
    assert.equal(replay.body.code, 'INVALID_MFA_CODE');
    // An older code after a newer one is refused as well.
    const older = await api('POST', '/api/auth/login', {
      username: account.username, password: 'correct-horse-battery',
      mfa_code: generateCode(begun.body.secret, { timestamp: Date.now() - 30_000 })
    }, { 'x-user-id': '' });
    assert.equal(older.status, 401);
  });

  test('turning MFA off needs the password as well as a code', async () => {
    const account = await register('off');
    const begun = await asSession(account.token, 'POST', '/api/auth/mfa/begin');
    await asSession(account.token, 'POST', '/api/auth/mfa/confirm', { code: generateCode(begun.body.secret) });
    const noPassword = await asSession(account.token, 'POST', '/api/auth/mfa/disable', {
      code: generateCode(begun.body.secret)
    });
    assert.equal(noPassword.status, 401);
    assert.equal(noPassword.body.code, 'PASSWORD_REQUIRED');
    const ok = await asSession(account.token, 'POST', '/api/auth/mfa/disable', {
      code: generateCode(begun.body.secret, { timestamp: Date.now() + 30_000 }), password: 'correct-horse-battery'
    });
    assert.equal(ok.status, 200);
  });

  test('deleting an account with MFA needs the second factor too', async () => {
    const account = await register('delmfa');
    const begun = await asSession(account.token, 'POST', '/api/auth/mfa/begin');
    await asSession(account.token, 'POST', '/api/auth/mfa/confirm', { code: generateCode(begun.body.secret) });
    const noCode = await asSession(account.token, 'DELETE', '/api/users/@me', { password: 'correct-horse-battery' });
    assert.equal(noCode.status, 401);
    assert.equal(noCode.body.code, 'MFA_REQUIRED');
    const done = await asSession(account.token, 'DELETE', '/api/users/@me', {
      password: 'correct-horse-battery', mfa_code: generateCode(begun.body.secret)
    });
    assert.equal(done.status, 200);
  });
});

describe('moderation reaches voice', () => {
  test('a kicked member is removed from the voice channel', async () => {
    const { getQuery, runQuery } = await import('../db.js');
    // user-5 is a plain member of server-1; make sure they are in it.
    await runQuery(`UPDATE server_members SET left_at = NULL WHERE server_id = 'server-1' AND user_id = 'user-5'`);
    const victim = await connect({ userId: 'user-5' });
    try {
      const joined = await new Promise((resolve) => victim.emit('join_voice', { channelId: 'chan-104' }, resolve));
      assert.equal(joined?.ok, true, JSON.stringify(joined));
      assert.ok(await getQuery(`SELECT 1 FROM voice_states WHERE user_id = 'user-5'`));

      const evicted = waitFor(victim, 'voice_disconnected');
      const kicked = await api('POST', '/api/servers/server-1/kicks/user-5', { reason: 'test' });
      assert.equal(kicked.status, 200, JSON.stringify(kicked.body));
      assert.ok(await evicted, 'the client was not told to leave the call');
      assert.equal(await getQuery(`SELECT 1 FROM voice_states WHERE user_id = 'user-5'`), undefined);
    } finally {
      victim.close();
      // Put user-5 back so later suites see the seeded membership.
      await runQuery(`UPDATE server_members SET left_at = NULL WHERE server_id = 'server-1' AND user_id = 'user-5'`);
    }
  });
});

describe('directory and input hygiene', () => {
  test('GET /api/users lists only people you share something with', async () => {
    const loner = await register('loner');
    const dir = await asSession(loner.token, 'GET', '/api/users');
    assert.equal(dir.status, 200);
    assert.deepEqual(dir.body.map((u) => u.id), [loner.id]);
    const member = await get('/api/users');   // user-me shares servers with the seed users
    assert.ok(member.body.length > 1);
    assert.ok(member.body.every((u) => !u.id.startsWith('loner')));
  });

  test('presence changes reach related users only, not every socket', async () => {
    const stranger = await register('stranger');
    const outsider = await connect({ token: stranger.token });
    const friend = await connect({ userId: 'user-2' });   // shares server-1 with user-me
    try {
      const strangerHeard = waitFor(outsider, 'presence_updated', 1200);
      const friendHeard = new Promise((resolve) => {
        const t = setTimeout(() => resolve(null), 3000);
        friend.on('presence_updated', (p) => { if (p.userId === 'user-me') { clearTimeout(t); resolve(p); } });
      });
      const res = await api('PATCH', '/api/users/user-me/presence', { status: 'idle' });
      assert.equal(res.status, 200);
      assert.equal((await friendHeard)?.status, 'idle');
      assert.equal(await strangerHeard, null, 'an unrelated account learned user-me\'s presence');
    } finally {
      outsider.close(); friend.close();
      await api('PATCH', '/api/users/user-me/presence', { status: 'online' });
    }
  });

  test('colours must be hex', async () => {
    const bad = await api('PUT', '/api/users/user-me', { accent_color: 'red;background:url(//evil)' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'INVALID_COLOR');
    const ok = await api('PUT', '/api/users/user-me', { accent_color: '#ABCDEF' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.accent_color, '#abcdef');
    const role = await api('POST', '/api/servers/server-1/roles', { name: 'hexcheck', color: 'expression(alert(1))' });
    assert.equal(role.status, 400);
    assert.equal(role.body.code, 'INVALID_COLOR');
  });
});

describe('image proxy', () => {
  test('requires a session and refuses private or non-http targets', async () => {
    const anon = await fetch(`${BASE}/api/media/proxy?url=${encodeURIComponent('https://example.com/a.png')}`);
    assert.equal(anon.status, 401);
    const local = await get(`/api/media/proxy?url=${encodeURIComponent('http://127.0.0.1:22/x.png')}`);
    assert.equal(local.status, 400);
    assert.equal(local.body.code, 'URL_NOT_ALLOWED');
    const meta = await get(`/api/media/proxy?url=${encodeURIComponent('http://169.254.169.254/latest/meta-data')}`);
    assert.equal(meta.status, 400);
    const scheme = await get(`/api/media/proxy?url=${encodeURIComponent('file:///etc/passwd')}`);
    assert.equal(scheme.status, 400);
    assert.equal(scheme.body.code, 'INVALID_URL');
  });

  test('remote avatars are stored as same-origin proxy URLs and the CSP allows only self', async () => {
    const res = await api('PUT', '/api/users/user-me', { avatar_url: 'https://images.example.com/me.png' });
    assert.equal(res.status, 200);
    assert.equal(res.body.avatar_url, `/api/media/proxy?url=${encodeURIComponent('https://images.example.com/me.png')}`);
    const page = await fetch(`${BASE}/api/health`);
    const csp = page.headers.get('content-security-policy');
    assert.match(csp, /img-src 'self' data: blob:(;|$)/);
  });

  test('only real images pass the byte check', async () => {
    const { acceptableImage } = await import('../services/mediaProxy.js');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAYAAABm6xu2AAAAFElEQVR42mP8z8Dwn4GBgYGBgQEAFwUCAeVKGYUAAAAASUVORK5CYII=', 'base64');
    assert.equal(acceptableImage(png), 'image/png');
    assert.equal(acceptableImage(Buffer.from('<!doctype html><script>alert(1)</script>')), null);
    assert.equal(acceptableImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), 'image/svg+xml');
  });
});

// ---------------------------------------------------------------------------
//  A second server, configured exactly as a production deployment that
//  forgot MAIL_TRANSPORT and METRICS_TOKEN — the audit's reproduction setup.
// ---------------------------------------------------------------------------

describe('production configuration (audit PoCs)', () => {
  let port;
  let base;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-prod-'));
  let child;
  let pgName = null;

  before(async () => {
    // An OS-assigned free port: a fixed offset could collide with another
    // suite running concurrently on a different TEST_PORT_BASE.
    port = await new Promise((resolve, reject) => {
      const probe = net.createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const { port: free } = probe.address();
        probe.close(() => resolve(free));
      });
    });
    base = `http://127.0.0.1:${port}`;
    const env = { ...process.env };
    delete env.DATABASE_URL;
    delete env.NODE_TEST_CONTEXT;
    if (TEST_DATABASE_URL) {
      const { default: pg } = await import('pg');
      pgName = `prod_${crypto.randomBytes(4).toString('hex')}`;
      const c = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await c.connect();
      await c.query(`CREATE DATABASE "${pgName}"`);
      await c.end();
      const u = new URL(TEST_DATABASE_URL);
      u.pathname = `/${pgName}`;
      env.DATABASE_URL = u.toString();
    }
    delete env.MAIL_TRANSPORT;
    delete env.METRICS_TOKEN;
    child = spawn(process.execPath, ['server.js'], {
      cwd: repo,
      env: {
        ...env,
        NODE_ENV: 'production', PORT: String(port), HOST: '127.0.0.1',
        DB_PATH: path.join(tmp, 'prod.db'), STORAGE_ROOT: path.join(tmp, 'uploads'),
        STORAGE_URL_SECRET: crypto.randomBytes(32).toString('base64'),
        ALLOW_DEV_IDENTITY: '0', SERVE_STATIC: '0', PUBLIC_URL: base,
        RATE_LIMIT_REGISTER_PER_HOUR: '10000', RATE_LIMIT_WRITE_PER_MIN: '10000'
      },
      stdio: ['ignore', 'ignore', 'pipe']
    });
    child.stderr.on('data', () => {});
    const deadline = Date.now() + 40_000;
    for (;;) {
      try { if ((await fetch(`${base}/api/live`)).ok) break; } catch { /* not up */ }
      if (Date.now() > deadline) throw new Error('production server did not start');
      await new Promise((r) => setTimeout(r, 250));
    }
  });

  after(async () => {
    if (child && child.exitCode === null) {
      const exited = new Promise((r) => child.once('exit', r));
      child.kill();
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    }
    if (pgName) {
      const { default: pg } = await import('pg');
      const c = new pg.Client({ connectionString: TEST_DATABASE_URL });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS "${pgName}" WITH (FORCE)`);
      await c.end();
    }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const poc = (name) => run(process.execPath, [`scripts/security/${name}`], {
    cwd: repo, env: { ...process.env, SEC_BASE: base }
  }).then((r) => ({ code: 0, out: r.stdout }), (e) => ({ code: e.code, out: `${e.stdout}${e.stderr}` }));

  test('C-1: no reset token is ever returned over HTTP (PoC 01)', async () => {
    const { code, out } = await poc('poc-01-reset-token-disclosure.mjs');
    assert.match(out, /NOT VULNERABLE/, out);
    assert.equal(code, 0);
  });

  test('M-1, M-2, M-4: metrics closed, no e-mail oracle, no global directory (PoC 02)', async () => {
    const { code, out } = await poc('poc-02-disclosure-and-enumeration.mjs');
    assert.match(out, /NOT VULNERABLE/, out);
    assert.equal(code, 0);
  });

  test('without a mail transport, reset and verification refuse instead of leaking', async () => {
    const reg = await fetch(`${base}/api/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: unique('p'), password: 'Passw0rd-long', email: `${unique('p')}@example.test` })
    });
    const { token } = await reg.json();
    const forgot = await fetch(`${base}/api/auth/forgot-password`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'x@example.test' })
    });
    assert.equal(forgot.status, 503);
    assert.equal((await forgot.json()).code, 'MAIL_NOT_CONFIGURED');
    const verify = await fetch(`${base}/api/auth/verify-email/request`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}` }
    });
    assert.equal(verify.status, 503);
    assert.ok(!('dev_token' in (await verify.json())));
    assert.equal((await fetch(`${base}/metrics`)).status, 404);
  });
});
