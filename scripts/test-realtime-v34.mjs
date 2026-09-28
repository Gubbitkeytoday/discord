#!/usr/bin/env node
// ============================================================================
//  Realtime reliability & horizontal scale:
//    - search: permission filtering inside SQL, full pages, cursor pagination
//    - catch-up REST: /api/channels/:id/messages?after=, /api/sync?since=
//    - Socket.IO connection-state recovery (missed events replayed; refused
//      when a permission was revoked during the disconnect)
//    - flood protection, typing throttle, payload cap
//    - several instances sharing Redis/Valkey: cross-instance fan-out,
//      presence across instances, shared rate limits, drain + recovery on
//      another instance.
// ============================================================================

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { io as ioClient } from 'socket.io-client';

import { startServer, stopServer, BASE, PORT } from './testHarness.mjs';

before(startServer);
after(stopServer);

const as = (userId) => ({ 'x-user-id': userId });

/** The harness's api(), plus which instance to call. */
async function api(method, url, body, headers = {}, base = BASE) {
  const res = await fetch(`${base}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-user-id': 'user-me', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const VIEW_CHANNEL = String(1n << 10n);

async function makeUser(prefix) {
  const { runQuery } = await import('../db.js');
  const id = `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
  await runQuery(`INSERT INTO users (id, username, display_name, email) VALUES (?, ?, ?, ?)`,
    [id, id, id, `${id}@example.test`]);
  return id;
}

/** A guild with a public and a private (@everyone denied VIEW) channel, and a member. */
async function makeGuild(base = BASE) {
  const call = (method, url, body, h) => api(method, url, body, h, base);
  const owner = await makeUser('own');
  const member = await makeUser('mem');
  const server = await call('POST', '/api/servers', { name: 'Scale test' }, as(owner));
  assert.equal(server.status, 200, JSON.stringify(server.body));
  const serverId = server.body.id ?? server.body.server?.id;
  const mk = async (name) => {
    const res = await call('POST', '/api/channels', { server_id: serverId, name }, as(owner));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.id;
  };
  const pub = await mk('pub');
  const priv = await mk('priv');
  const deny = await call('PUT', `/api/channels/${priv}/permissions/role/${serverId}`, { deny: VIEW_CHANNEL }, as(owner));
  assert.equal(deny.status, 200, JSON.stringify(deny.body));
  const invite = await call('POST', `/api/servers/${serverId}/invites`, { maxUses: 0, maxAge: 0 }, as(owner));
  const joined = await call('POST', `/api/invites/${invite.body.code}/accept`, {}, as(member));
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  return { owner, member, serverId, pub, priv };
}

async function post(channelId, userId, content, base) {
  const res = await api('POST', '/api/messages', { channel_id: channelId, content }, as(userId), base);
  assert.ok([200, 201].includes(res.status), JSON.stringify(res.body));
  return res.body;
}

function connect(userId, { base = BASE, ...opts } = {}) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(base, { transports: ['websocket'], forceNew: true, reconnection: false, ...opts });
    const fail = setTimeout(() => reject(new Error('socket did not identify')), 5000);
    socket.once('connect', () => socket.emit('identify', { userId }));
    socket.once('identified', () => { clearTimeout(fail); resolve(socket); });
    socket.once('identify_error', (e) => { clearTimeout(fail); reject(new Error(JSON.stringify(e))); });
  });
}
const waitFor = (socket, event, ms = 3000, match = () => true) => new Promise((resolve) => {
  const timer = setTimeout(() => { socket.off(event, handler); resolve(null); }, ms);
  function handler(payload) {
    if (!match(payload)) return;
    clearTimeout(timer);
    socket.off(event, handler);
    resolve(payload ?? true);
  }
  socket.on(event, handler);
});
const ack = (socket, event, payload) => new Promise((resolve) => socket.emit(event, payload, resolve));

/** Drop the transport as a network blip would (a recoverable disconnect). */
async function blip(socket) {
  const gone = waitFor(socket, 'disconnect', 3000);
  socket.io.engine.close();
  await gone;
}
async function reconnect(socket, uri = null) {
  if (uri) socket.io.uri = uri;
  const connected = waitFor(socket, 'connect', 5000);
  socket.connect();
  assert.ok(await connected, 'reconnected');
}

// ---------------------------------------------------------------------------

describe('search: permissions in SQL, cursor pagination', () => {
  let g;
  const needle = `needle${crypto.randomBytes(3).toString('hex')}`;
  before(async () => {
    g = await makeGuild();
    // Old matches in the public channel, then a burst of *newer* matches in
    // the private one: a post-LIMIT filter returns an empty first page here.
    for (let i = 0; i < 12; i += 1) await post(g.pub, g.owner, `${needle} public ${i}`);
    for (let i = 0; i < 15; i += 1) await post(g.priv, g.owner, `${needle} private ${i}`);
  });

  test('pages are full, never leak the private channel, and the cursor walks to the end', async () => {
    const seen = [];
    let cursor = null;
    for (let page = 0; page < 10; page += 1) {
      const url = `/api/search/messages?q=${needle}&limit=5${cursor ? `&before=${cursor}` : ''}`;
      const res = await fetch(`${BASE}${url}`, { headers: as(g.member) });
      assert.equal(res.status, 200);
      const rows = await res.json();
      assert.ok(rows.every((m) => m.channel_id === g.pub), 'only the readable channel');
      if (page < 2) assert.equal(rows.length, 5, `page ${page} is full`);
      seen.push(...rows);
      cursor = res.headers.get('x-next-cursor');
      if (!cursor) break;
    }
    assert.equal(seen.length, 12);
    assert.equal(new Set(seen.map((m) => m.id)).size, 12, 'no duplicates across pages');
    const ids = seen.map((m) => BigInt(m.id));
    assert.ok(ids.every((id, i) => i === 0 || id < ids[i - 1]), 'newest first, strictly descending');
  });

  test('scoped to the guild or the private channel, the member still sees nothing private', async () => {
    const scoped = await api('GET', `/api/search/messages?q=${needle}&serverId=${g.serverId}&limit=100`, undefined, as(g.member));
    assert.equal(scoped.body.length, 12);
    const direct = await api('GET', `/api/search/messages?q=${needle}&channelId=${g.priv}`, undefined, as(g.member));
    assert.deepEqual(direct.body, []);
    const inOp = await api('GET', `/api/search/messages?q=${encodeURIComponent(`in:priv ${needle}`)}`, undefined, as(g.member));
    assert.deepEqual(inOp.body, []);
  });

  test('the owner sees both channels, newest (private) first', async () => {
    const res = await api('GET', `/api/search/messages?q=${needle}&limit=20`, undefined, as(g.owner));
    assert.equal(res.body.length, 20);
    assert.ok(res.body.slice(0, 15).every((m) => m.channel_id === g.priv));
  });

  test('short (non-trigram) and operator-only queries are filtered the same way', async () => {
    const short = await api('GET', `/api/search/messages?q=${encodeURIComponent(`from:${g.owner}`)}&limit=100`, undefined, as(g.member));
    assert.ok(short.body.length >= 12);
    assert.ok(short.body.every((m) => m.channel_id !== g.priv));
  });
});

describe('catch-up REST', () => {
  let g;
  before(async () => { g = await makeGuild(); });

  test('GET /api/channels/:id/messages?after= pages forward and is gated', async () => {
    const first = await post(g.pub, g.owner, 'catchup 0');
    for (let i = 1; i <= 4; i += 1) await post(g.pub, g.owner, `catchup ${i}`);
    const page = await api('GET', `/api/channels/${g.pub}/messages?after=${first.id}&limit=3`, undefined, as(g.member));
    assert.equal(page.status, 200);
    assert.deepEqual(page.body.map((m) => m.content), ['catchup 1', 'catchup 2', 'catchup 3']);
    const next = await api('GET', `/api/channels/${g.pub}/messages?after=${page.body[2].id}&limit=3`, undefined, as(g.member));
    assert.deepEqual(next.body.map((m) => m.content), ['catchup 4']);
    const denied = await api('GET', `/api/channels/${g.priv}/messages?after=0`, undefined, as(g.member));
    assert.equal(denied.status, 403);
  });

  test('GET /api/sync reports activity since a cursor, only for readable channels', async () => {
    const oldPub = await post(g.pub, g.owner, 'will be edited');
    const oldPub2 = await post(g.pub, g.owner, 'will be deleted');
    await post(g.priv, g.owner, 'private before');
    const fresh = await api('GET', '/api/sync', undefined, as(g.member));
    assert.equal(fresh.status, 200);
    assert.equal(fresh.body.reset, true, 'no cursor → full reload');
    await sleep(2300);   // past the overlap window
    const start = await api('GET', `/api/sync?since=${fresh.body.cursor}`, undefined, as(g.member));
    assert.equal(start.body.reset, false);
    const cursor = start.body.cursor;
    const hashBefore = start.body.guilds.find((x) => x.server_id === g.serverId)?.state_hash;
    assert.ok(hashBefore, 'every guild has a state hash');

    await post(g.pub, g.owner, 'new 1');
    await post(g.pub, g.owner, 'new 2');
    await post(g.priv, g.owner, 'private after');
    assert.equal((await api('PATCH', `/api/messages/${oldPub.id}`, { content: 'edited!' }, as(g.owner))).status, 200);
    assert.equal((await api('DELETE', `/api/messages/${oldPub2.id}`, undefined, as(g.owner))).status, 200);

    const res = await api('GET', `/api/sync?since=${cursor}`, undefined, as(g.member));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const pub = res.body.channels.find((c) => c.channel_id === g.pub);
    assert.ok(pub, JSON.stringify(res.body.channels));
    assert.equal(pub.new_messages, 2);
    assert.equal(pub.edited_messages, 1);
    assert.equal(pub.deleted_messages, 1);
    assert.ok(pub.last_message_id);
    assert.ok(!res.body.channels.some((c) => c.channel_id === g.priv), 'private activity never reported');
    assert.equal(res.body.guilds.find((x) => x.server_id === g.serverId).state_hash, hashBefore,
      'nothing structural changed');

    // A permission change alters the member's guild state hash.
    await api('PUT', `/api/channels/${g.priv}/permissions/member/${g.member}`, { allow: VIEW_CHANNEL }, as(g.owner));
    const after = await api('GET', `/api/sync?since=${cursor}`, undefined, as(g.member));
    assert.notEqual(after.body.guilds.find((x) => x.server_id === g.serverId).state_hash, hashBefore);
    await api('DELETE', `/api/channels/${g.priv}/permissions/member/${g.member}`, undefined, as(g.owner));
  });

  test('bad or ancient cursors are handled', async () => {
    const bad = await api('GET', '/api/sync?since=%7Bnot-a-cursor', undefined, as(g.member));
    assert.equal(bad.status, 400);
    const ancient = await api('GET', `/api/sync?since=${Date.now() - 30 * 86400_000}`, undefined, as(g.member));
    assert.equal(ancient.body.reset, true);
    const anon = await api('GET', '/api/sync', undefined, { 'x-user-id': '' });
    assert.equal(anon.status, 401);
  });
});

describe('connection state recovery (single node)', () => {
  let g;
  before(async () => { g = await makeGuild(); });

  test('a brief disconnect resumes the same socket and replays missed messages', async () => {
    const sock = await connect(g.member);
    assert.deepEqual(await ack(sock, 'join_channel', g.pub), { ok: true });
    // Receive one broadcast so the client holds a replay offset.
    const warm = waitFor(sock, 'new_message', 3000, (m) => m.content === 'warm-up');
    await post(g.pub, g.owner, 'warm-up');
    assert.ok(await warm);
    const id = sock.id;

    await blip(sock);
    await post(g.pub, g.owner, 'sent while you were away');
    const missed = waitFor(sock, 'new_message', 4000, (m) => m.content === 'sent while you were away');
    await reconnect(sock);
    assert.equal(sock.recovered, true, 'state recovered');
    assert.equal(sock.id, id, 'same socket id');
    assert.ok(await missed, 'missed message replayed');

    // Rooms came back too: live events keep flowing without re-joining.
    const live = waitFor(sock, 'new_message', 3000, (m) => m.content === 'after resume');
    await post(g.pub, g.owner, 'after resume');
    assert.ok(await live);
    sock.disconnect();
  });

  test('a permission revoked during the disconnect refuses the resume and replays nothing', async () => {
    const sock = await connect(g.member);
    await api('PUT', `/api/channels/${g.priv}/permissions/member/${g.member}`, { allow: VIEW_CHANNEL }, as(g.owner));
    assert.deepEqual(await ack(sock, 'join_channel', g.priv), { ok: true });
    const warm = waitFor(sock, 'new_message', 3000, (m) => m.content === 'priv warm-up');
    await post(g.priv, g.owner, 'priv warm-up');
    assert.ok(await warm);

    await blip(sock);
    await api('DELETE', `/api/channels/${g.priv}/permissions/member/${g.member}`, undefined, as(g.owner));
    await post(g.priv, g.owner, 'secret after revoke');
    const leaked = waitFor(sock, 'new_message', 1500, (m) => m.content === 'secret after revoke');
    await reconnect(sock);
    assert.equal(sock.recovered, false, 'resume refused');
    assert.equal(await leaked, null, 'the missed private message was not replayed');
    sock.disconnect();
  });

  test('a session revoked during the disconnect refuses the resume', async () => {
    const { recoveryAllowed } = await import('../realtime.js');
    const ok = await recoveryAllowed({ sid: 's1', rooms: ['s1', `user-${g.member}`, g.pub], data: { userId: g.member } });
    assert.equal(ok, true);
    const revoked = await recoveryAllowed({
      sid: 's1', rooms: ['s1'], data: { userId: g.member, sessionId: 'no-such-session' }
    });
    assert.equal(revoked, false);
    const voice = await recoveryAllowed({ sid: 's1', rooms: ['s1', 'voice-x'], data: { userId: g.member } });
    assert.equal(voice, false, 'voice rooms force a fresh connection');
    const foreign = await recoveryAllowed({ sid: 's1', rooms: ['s1', g.priv], data: { userId: g.member } });
    assert.equal(foreign, false);
  });
});

describe('permission cache', () => {
  let g;
  before(async () => { g = await makeGuild(); });

  test('a revoke through the API applies to the very next check', async () => {
    const url = `/api/channels/${g.pub}/messages?limit=1`;
    assert.equal((await api('GET', url, undefined, as(g.member))).status, 200);
    assert.equal((await api('GET', url, undefined, as(g.member))).status, 200);   // warm
    await api('PUT', `/api/channels/${g.pub}/permissions/member/${g.member}`, { deny: VIEW_CHANNEL }, as(g.owner));
    assert.equal((await api('GET', url, undefined, as(g.member))).status, 403);
    await api('DELETE', `/api/channels/${g.pub}/permissions/member/${g.member}`, undefined, as(g.owner));
    assert.equal((await api('GET', url, undefined, as(g.member))).status, 200);
  });

  test('a change made directly in SQL (no app hook at all) is honoured too — database triggers', async () => {
    const { runQuery } = await import('../db.js');
    const url = `/api/channels/${g.pub}/messages?limit=1`;
    assert.equal((await api('GET', url, undefined, as(g.member))).status, 200);
    await runQuery(`UPDATE server_members SET left_at = ? WHERE server_id = ? AND user_id = ?`,
      [new Date().toISOString(), g.serverId, g.member]);
    assert.equal((await api('GET', url, undefined, as(g.member))).status, 403, 'left member refused at once');
    await runQuery(`UPDATE server_members SET left_at = NULL WHERE server_id = ? AND user_id = ?`, [g.serverId, g.member]);
    assert.equal((await api('GET', url, undefined, as(g.member))).status, 200);
    // Role permission edit straight in the table.
    const { getQuery } = await import('../db.js');
    const { permissions } = await getQuery(`SELECT permissions FROM roles WHERE id = ?`, [g.serverId]);
    await runQuery(`UPDATE roles SET permissions = '0' WHERE id = ?`, [g.serverId]);
    try {
      assert.equal((await api('GET', url, undefined, as(g.member))).status, 403, '@everyone stripped');
    } finally {
      await runQuery(`UPDATE roles SET permissions = ? WHERE id = ?`, [permissions, g.serverId]);
    }
    assert.equal((await api('GET', url, undefined, as(g.member))).status, 200);
  });

  test('timeouts apply from the cached timeout_until without invalidation', async () => {
    const { runQuery } = await import('../db.js');
    const until = new Date(Date.now() + 1500).toISOString();
    await runQuery(`UPDATE server_members SET timeout_until = ? WHERE server_id = ? AND user_id = ?`, [until, g.serverId, g.member]);
    const blocked = await api('POST', '/api/messages', { channel_id: g.pub, content: 'x' }, as(g.member));
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, 'TIMED_OUT');
    await sleep(1700);
    const ok = await api('POST', '/api/messages', { channel_id: g.pub, content: 'after timeout' }, as(g.member));
    assert.equal(ok.status, 200);
  });

  test('batch join_rooms re-joins only what is still allowed', async () => {
    const sock = await connect(g.member);
    const res = await ack(sock, 'join_rooms', { servers: [g.serverId, 'no-such-guild'], channels: [g.pub, g.priv] });
    assert.equal(res.ok, true);
    assert.deepEqual(res.joined.sort(), [g.pub, g.serverId].sort());
    assert.deepEqual(res.refused.sort(), ['no-such-guild', g.priv].sort());
    sock.disconnect();
  });
});

describe('admission control and login limits', () => {
  test('the limiter admits `concurrency`, queues `maxQueue`, refuses the rest with RETRY_LATER', async () => {
    const { createAdmission } = await import('../lib/admission.js');
    const lim = createAdmission({ name: 't', concurrency: 1, maxQueue: 1, maxWaitMs: 200 });
    let release;
    const first = lim.run(() => new Promise((r) => { release = r; }));
    const second = lim.run(async () => 'second');
    await assert.rejects(lim.run(async () => 'third'), (e) => e.code === 'RETRY_LATER' && e.status === 503);
    release('first');
    assert.equal(await first, 'first');
    assert.equal(await second, 'second');
    // Queued work that waits too long is refused rather than run late.
    let hold;
    const busy = lim.run(() => new Promise((r) => { hold = r; }));
    await assert.rejects(lim.run(async () => 'late'), (e) => e.code === 'RETRY_LATER');
    hold();
    await busy;
    assert.equal(lim.snapshot().active, 0);
  });

  test('login attempts are limited per IP and username, not per IP alone', async () => {
    const target = `nobody${crypto.randomBytes(3).toString('hex')}`;
    const statuses = [];
    for (let i = 0; i < 11; i += 1) {
      statuses.push((await api('POST', '/api/auth/login', { username: target, password: `wrong-${i}` }, { 'x-user-id': '' })).status);
    }
    assert.equal(statuses.at(-1), 429, statuses.join(','));
    const other = await api('POST', '/api/auth/login', { username: `${target}x`, password: 'wrong' }, { 'x-user-id': '' });
    assert.notEqual(other.status, 429, 'another account from the same address is still allowed');
  });
});

describe('flood protection and fan-out throttles', () => {
  let g;
  before(async () => { g = await makeGuild(); });

  test('typing is re-broadcast at most once per interval', async () => {
    const a = await connect(g.owner);
    const b = await connect(g.member);
    await ack(a, 'join_channel', g.pub);
    await ack(b, 'join_channel', g.pub);
    let count = 0;
    b.on('typing', () => { count += 1; });
    for (let i = 0; i < 6; i += 1) a.emit('typing_start', { channelId: g.pub, displayName: 'x'.repeat(500) });
    await sleep(600);
    assert.equal(count, 1);
    a.disconnect(); b.disconnect();
  });

  test('a socket flooding events is throttled, then disconnected', async () => {
    const sock = await connect(g.member);
    const limited = waitFor(sock, 'rate_limited', 5000);
    const dropped = waitFor(sock, 'disconnect', 5000);
    for (let i = 0; i < 400; i += 1) sock.emit('typing_start', { channelId: g.pub });
    assert.deepEqual(await limited, { reason: 'flood' });
    assert.equal(await dropped, 'io server disconnect');
  });

  test('over-budget events with an ack are answered RATE_LIMITED', async () => {
    const sock = await connect(g.member);
    const answers = await Promise.all(Array.from({ length: 70 }, () => ack(sock, 'join_channel', g.pub)));
    assert.ok(answers.some((a) => a.code === 'RATE_LIMITED'));
    assert.ok(answers.filter((a) => a.ok).length >= 60);
    sock.disconnect();
  });

  test('frames above the payload cap close the connection', async () => {
    const sock = await connect(g.member);
    const dropped = waitFor(sock, 'disconnect', 5000);
    sock.emit('typing_start', { channelId: g.pub, displayName: 'x'.repeat(700 * 1024) });
    assert.ok(await dropped, 'oversized frame dropped the connection');
  });

  test('health reports the gateway mode', async () => {
    const res = await api('GET', '/api/health');
    assert.equal(res.body.realtime.mode, 'single');
    assert.equal(res.body.realtime.redis, 'disabled');
  });
});

// --- several instances sharing Redis ------------------------------------------

const redisBin = spawnSync('sh', ['-c', 'command -v valkey-server || command -v redis-server']).stdout?.toString().trim();
const redisUrlFromEnv = process.env.TEST_REDIS_URL || '';
const clusterSkip = (redisBin || redisUrlFromEnv) ? false : 'needs redis-server/valkey-server on PATH or TEST_REDIS_URL';

describe('multi-instance with Redis', { skip: clusterSkip }, () => {
  const redisPort = PORT + 3;
  const ports = [PORT + 1, PORT + 2];
  const bases = ports.map((p) => `http://localhost:${p}`);
  const prefix = `agtest${crypto.randomBytes(3).toString('hex')}:`;
  let redis;
  const procs = [];
  let g;

  function spawnInstance(port) {
    const child = spawn(process.execPath, ['server.js'], {
      env: {
        ...process.env,
        PORT: String(port),
        ADMIN_TOKEN: 'test-admin-token',
        ALLOW_DEV_IDENTITY: '1',
        RATE_LIMIT_WRITE_PER_MIN: '10000',
        RATE_LIMIT_REGISTER_PER_HOUR: '10000',
        REDIS_URL: redisUrlFromEnv || `redis://127.0.0.1:${redisPort}`,
        REDIS_KEY_PREFIX: prefix,
        SHUTDOWN_TIMEOUT_MS: '8000',
        PRESENCE_OFFLINE_GRACE_MS: '600',
        SESSION_CACHE_TTL_MS: '30000'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stdout.on('data', () => {});
    child.stderr.on('data', (c) => { if (process.env.TEST_SERVER_LOG === '1') process.stderr.write(`[inst ${port}] ${c}`); });
    procs.push(child);
    return child;
  }
  async function healthy(base) {
    const deadline = Date.now() + 40_000;
    while (Date.now() < deadline) {
      try { if ((await fetch(`${base}/api/ready`)).ok) return; } catch { /* booting */ }
      await sleep(200);
    }
    throw new Error(`${base} did not become ready`);
  }

  before(async () => {
    if (!redisUrlFromEnv) {
      redis = spawn(redisBin, ['--port', String(redisPort), '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
      await sleep(300);
    }
    for (const port of ports) spawnInstance(port);
    await Promise.all(bases.map(healthy));
    g = await makeGuild(bases[0]);
  });

  after(async () => {
    for (const child of procs) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((r) => child.once('exit', r));
        child.kill('SIGTERM');
        await Promise.race([exited, sleep(8000)]);
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }
    }
    if (redis) redis.kill('SIGKILL');
  });

  test('both instances run in cluster mode', async () => {
    for (const base of bases) {
      const res = await api('GET', '/api/health', undefined, {}, base);
      assert.equal(res.body.realtime.mode, 'cluster');
      assert.equal(res.body.realtime.redis, 'connected');
    }
  });

  test('a message posted on one instance reaches a socket on the other', async () => {
    const sock = await connect(g.member, { base: bases[0] });
    assert.deepEqual(await ack(sock, 'join_channel', g.pub), { ok: true });
    const got = waitFor(sock, 'new_message', 4000, (m) => m.content === 'cross-instance');
    await post(g.pub, g.owner, 'cross-instance', bases[1]);
    assert.ok(await got);
    // Visibility-filtered channel events cross instances too.
    const listener = await connect(g.owner, { base: bases[1] });
    await ack(sock, 'join_server', g.serverId);
    const hidden = waitFor(sock, 'channel_updated', 1500, (c) => c.id === g.priv);
    const seen = waitFor(listener, 'channel_updated', 1500, (c) => c.id === g.priv);
    await ack(listener, 'join_server', g.serverId);
    await api('PATCH', `/api/channels/${g.priv}`, { topic: 'secret topic' }, as(g.owner), bases[0]);
    assert.equal(await hidden, null, 'member without VIEW never hears about the private channel');
    assert.ok(await seen, 'owner on the other instance does');
    sock.disconnect(); listener.disconnect();
  });

  test('presence counts connections across instances', async () => {
    const watcher = await connect(g.owner, { base: bases[0] });
    const x1 = await connect(g.member, { base: bases[0] });
    const x2 = await connect(g.member, { base: bases[1] });
    await sleep(300);
    const early = waitFor(watcher, 'presence_updated', 1200, (p) => p.userId === g.member && p.status === 'offline');
    x1.disconnect();
    assert.equal(await early, null, 'still connected on the other instance → not offline');
    // A reconnect inside the grace window (here: to the *other* instance) is
    // invisible to everyone else: no offline, no online.
    const flap = waitFor(watcher, 'presence_updated', 1500, (p) => p.userId === g.member);
    x2.disconnect();
    const x3 = await connect(g.member, { base: bases[0] });
    assert.equal(await flap, null, 'quick reconnect emits no presence change');
    const offline = waitFor(watcher, 'presence_updated', 4000, (p) => p.userId === g.member && p.status === 'offline');
    x3.disconnect();
    assert.ok(await offline, 'last connection anywhere → offline after the grace period');
    watcher.disconnect();
  });

  test('a session revoked on one instance is refused at once by the other (session cache)', async () => {
    const username = `sc${crypto.randomBytes(4).toString('hex')}`;
    const reg = await api('POST', '/api/auth/register', { username, password: 'correct-horse-battery' },
      { 'x-user-id': '' }, bases[0]);
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const bearer = { Authorization: `Bearer ${reg.body.token}`, 'x-user-id': '' };
    // Warm both instances' caches.
    assert.equal((await api('GET', '/api/auth/me', undefined, bearer, bases[0])).status, 200);
    assert.equal((await api('GET', '/api/auth/me', undefined, bearer, bases[1])).status, 200);
    assert.equal((await api('POST', '/api/auth/logout', {}, bearer, bases[0])).status, 200);
    await sleep(150);   // pub/sub hop
    assert.equal((await api('GET', '/api/auth/me', undefined, bearer, bases[1])).status, 401);
    assert.equal((await api('GET', '/api/auth/me', undefined, bearer, bases[0])).status, 401);
  });

  test('rate limits are shared between instances', async () => {
    const statuses = [];
    for (let i = 0; i < 12; i += 1) {
      const res = await api('POST', '/api/auth/login', { username: 'nobody-here', password: 'wrong-password' },
        { 'x-user-id': '' }, bases[i % 2]);
      statuses.push(res.status);
    }
    assert.equal(statuses.filter((s) => s === 429).length, 2, statuses.join(','));
  });

  test('draining one instance lets its clients resume on the other with missed events', async () => {
    const sock = await connect(g.member, { base: bases[0] });
    await ack(sock, 'join_channel', g.pub);
    const warm = waitFor(sock, 'new_message', 3000, (m) => m.content === 'pre-drain');
    await post(g.pub, g.owner, 'pre-drain', bases[1]);
    assert.ok(await warm);
    const id = sock.id;

    const draining = waitFor(sock, 'server_draining', 5000);
    const gone = waitFor(sock, 'disconnect', 8000);
    procs[0].kill('SIGTERM');
    assert.equal((await draining)?.reconnect, true);
    assert.ok(await gone);
    await post(g.pub, g.owner, 'during failover', bases[1]);

    const missed = waitFor(sock, 'new_message', 5000, (m) => m.content === 'during failover');
    await reconnect(sock, bases[1]);
    assert.equal(sock.recovered, true, 'session restored from Redis on another instance');
    assert.equal(sock.id, id);
    assert.ok(await missed, 'missed message replayed after failover');
    sock.disconnect();
  });
});
