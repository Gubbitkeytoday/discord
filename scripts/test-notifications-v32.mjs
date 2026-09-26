#!/usr/bin/env node
// ============================================================================
//  Notifications & Web Push (schema v32–v33):
//    - notification level semantics matrix (server / category / channel /
//      thread inheritance, guild default), mentions, suppressions, keywords,
//      blocks, private channels, DMs;
//    - timed mutes (expiry and the sweeper);
//    - unread counters: lazy unread + set-based mention counts;
//    - push subscription lifecycle (validation, per-session ownership,
//      logout / revoke cleanup), delivery through a local HTTPS push service
//      (headers, encrypted declarative payload, privacy, focus skip, 410
//      pruning, per-user rate limit).
//
//  Runs on both drivers (npm test / npm run test:pg).
// ============================================================================

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { io as ioClient } from 'socket.io-client';
import webpush from 'web-push';
import ece from 'http_ece';

import { startServer, stopServer, api, get, asSession, BASE } from './testHarness.mjs';

// --- a local push service (HTTPS, self-signed) ---------------------------------

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'push-test-'));
let tlsReady = false;
try {
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-keyout', path.join(TMP, 'key.pem'), '-out', path.join(TMP, 'cert.pem'), '-days', '1',
    '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'
  ], { stdio: 'ignore' });
  tlsReady = true;
} catch { /* no openssl: delivery tests are skipped, the rest still run */ }

const received = [];   // { path, headers, body }
let pushServer = null;
let pushPort = 0;
if (tlsReady) {
  pushServer = https.createServer({
    key: fs.readFileSync(path.join(TMP, 'key.pem')), cert: fs.readFileSync(path.join(TMP, 'cert.pem'))
  }, (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(req.url.includes('/gone/') ? 410 : 201);
      res.end();
    });
  });
  await new Promise((resolve) => pushServer.listen(0, '127.0.0.1', resolve));
  pushPort = pushServer.address().port;
}

const vapid = webpush.generateVAPIDKeys();
Object.assign(process.env, {
  VAPID_PUBLIC_KEY: vapid.publicKey,
  VAPID_PRIVATE_KEY: vapid.privateKey,
  VAPID_SUBJECT: 'mailto:test@example.test',
  PUSH_ENDPOINT_HOSTS: 'localhost',
  PUSH_USER_LIMIT_PER_MIN: '6',
  PUBLIC_URL: 'https://chat.example.test'
});
if (tlsReady) process.env.PUSH_EXTRA_CA_FILE = path.join(TMP, 'cert.pem');

before(startServer);
after(async () => {
  await stopServer();
  pushServer?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

// --- helpers -----------------------------------------------------------------

const as = (userId) => ({ 'x-user-id': userId });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(fn, { timeout = 3000, every = 50 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) return value;
    await sleep(every);
  }
}
const unique = (p) => `${p}${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;

async function send(content, { channel, author = 'user-me' } = {}) {
  const { status, body } = await api('POST', '/api/messages', { channel_id: channel, content }, as(author));
  assert.equal(status, 200, JSON.stringify(body));
  return body.id;
}
async function inboxRow(userId, messageId) {
  const { body } = await get(`/api/notifications/${userId}?limit=100`, as(userId));
  return body.find((n) => n.message_id === messageId);
}
async function readState(userId, channelId) {
  const { body } = await get(`/api/read-states/${userId}`, as(userId));
  return body.find((s) => s.channel_id === channelId);
}
const mentionCount = async (userId, channelId) => Number((await readState(userId, channelId))?.mention_count ?? 0);
const putServer = (userId, serverId, body) => api('PUT', `/api/notification-settings/servers/${serverId}`, body, as(userId));
const putChannel = (userId, channelId, body) => api('PUT', `/api/notification-settings/channels/${channelId}`, body, as(userId));

function connect(auth) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(BASE, { transports: ['websocket'], forceNew: true, reconnection: false });
    const fail = setTimeout(() => reject(new Error('socket did not identify')), 5000);
    socket.on('connect', () => socket.emit('identify', auth));
    socket.on('identified', () => { clearTimeout(fail); resolve(socket); });
    socket.on('identify_error', (e) => { clearTimeout(fail); reject(new Error(JSON.stringify(e))); });
  });
}

/** Collects notification_ping / notification events for one user. */
async function listen(userId) {
  const socket = await connect({ userId });
  const events = { pings: [], notifications: [] };
  socket.on('notification_ping', (p) => events.pings.push(p));
  socket.on('notification', (n) => events.notifications.push(n));
  return {
    socket,
    events,
    pinged: (messageId, ms = 600) => waitUntil(() => events.pings.some((p) => p.message_id === messageId), { timeout: ms }),
    close: () => socket.close()
  };
}

// A lab channel of our own under its own category, so nothing else in the
// suite disturbs the matrix.
let lab;          // text channel in server-1
let labCategory;  // its category
let labThread;
let listener;     // user-5's socket

before(async () => {
  const cat = await api('POST', '/api/channels', { server_id: 'server-1', name: 'NOTIF LAB', type: 'category' });
  assert.equal(cat.status, 200, JSON.stringify(cat.body));
  labCategory = cat.body.id;
  const ch = await api('POST', '/api/channels', { server_id: 'server-1', name: 'notif-lab', type: 'text', parent_id: labCategory });
  assert.equal(ch.status, 200, JSON.stringify(ch.body));
  lab = ch.body.id;
  listener = await listen('user-5');
});
after(() => listener?.close());

/** Reset user-5's settings for server-1 and the lab chain. */
async function reset() {
  await putServer('user-5', 'server-1', { level: null, muted: false, suppress_everyone: false, suppress_roles: false });
  for (const id of [lab, labCategory, labThread].filter(Boolean)) {
    await putChannel('user-5', id, { level: 'inherit', muted: false });
  }
}

// --- level matrix ------------------------------------------------------------

describe('notification levels', () => {
  test('default (all messages): a plain message pings, a mention creates an inbox row and a badge', async () => {
    await reset();
    const before = await mentionCount('user-5', lab);
    const plain = await send('just chatting', { channel: lab });
    assert.ok(await listener.pinged(plain), 'no all-messages ping');
    assert.equal(await inboxRow('user-5', plain), undefined, 'a plain message must not reach the mention inbox');

    const mention = await send('hey <@user-5>', { channel: lab });
    const row = await inboxRow('user-5', mention);
    assert.equal(row?.type, 'mention');
    assert.equal(await mentionCount('user-5', lab), before + 1);
    assert.ok(!listener.events.pings.some((p) => p.message_id === mention), 'a mention is not also a ping');
  });

  test('server "only @mentions": plain messages are silent, mentions still notify', async () => {
    await reset();
    const put = await putServer('user-5', 'server-1', { level: 'only_mentions' });
    assert.equal(put.status, 200, JSON.stringify(put.body));
    assert.equal(put.body.effective_level, 'only_mentions');
    const plain = await send('quiet please', { channel: lab });
    assert.equal(await listener.pinged(plain, 400), false);
    const mention = await send('<@user-5> look', { channel: lab });
    assert.equal((await inboxRow('user-5', mention))?.type, 'mention');
  });

  test('server "nothing": no inbox row even for a mention; the mention badge still counts', async () => {
    await reset();
    await putServer('user-5', 'server-1', { level: 'nothing' });
    const before = await mentionCount('user-5', lab);
    const mention = await send('<@user-5> anyone?', { channel: lab });
    await sleep(150);
    assert.equal(await inboxRow('user-5', mention), undefined);
    assert.equal(await mentionCount('user-5', lab), before + 1);
  });

  test('a channel override beats the server level', async () => {
    await reset();
    await putServer('user-5', 'server-1', { level: 'only_mentions' });
    await putChannel('user-5', lab, { level: 'all_messages' });
    const plain = await send('override works', { channel: lab });
    assert.ok(await listener.pinged(plain));
    await putChannel('user-5', lab, { level: 'nothing' });
    const mention = await send('<@user-5> nothing here', { channel: lab });
    await sleep(150);
    assert.equal(await inboxRow('user-5', mention), undefined);
  });

  test('a channel set to "use default" inherits from its category before the server', async () => {
    await reset();
    await putChannel('user-5', labCategory, { level: 'only_mentions' });
    const { body } = await get(`/api/notification-settings/channels/${lab}`, as('user-5'));
    assert.equal(body.level, 'inherit');
    assert.equal(body.effective_level, 'only_mentions');
    const plain = await send('category rules', { channel: lab });
    assert.equal(await listener.pinged(plain, 400), false);
  });

  test('a thread inherits its parent channel, and can override it', async () => {
    await reset();
    const created = await api('POST', `/api/channels/${lab}/threads`, { name: 'lab thread' });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    labThread = created.body.id;
    // Posting joins the thread (thread notifications go to thread members).
    await send('joining', { channel: labThread, author: 'user-5' });

    await putChannel('user-5', lab, { level: 'only_mentions' });
    const quiet = await send('thread chatter', { channel: labThread });
    assert.equal(await listener.pinged(quiet, 400), false, 'thread did not inherit the parent level');

    await putChannel('user-5', labThread, { level: 'all_messages' });
    const loud = await send('thread chatter 2', { channel: labThread });
    assert.ok(await listener.pinged(loud), 'thread override ignored');
  });

  test('the guild default applies until the member picks a level', async () => {
    await reset();
    const patched = await api('PATCH', '/api/servers/server-1', { default_notifications: 'only_mentions' });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    try {
      const { body } = await get('/api/notification-settings/servers/server-1', as('user-5'));
      assert.equal(body.level, null);
      assert.equal(body.effective_level, 'only_mentions');
      const quiet = await send('default says mentions only', { channel: lab });
      assert.equal(await listener.pinged(quiet, 400), false);
      await putServer('user-5', 'server-1', { level: 'all_messages' });
      const loud = await send('member says all', { channel: lab });
      assert.ok(await listener.pinged(loud));
    } finally {
      await api('PATCH', '/api/servers/server-1', { default_notifications: 'all_messages' });
    }
  });

  test('invalid levels are rejected', async () => {
    assert.equal((await putServer('user-5', 'server-1', { level: 'loud' })).status, 400);
    assert.equal((await putChannel('user-5', lab, { level: 'sometimes' })).status, 400);
    assert.equal((await putChannel('user-5', lab, { muted_until: 'not a date' })).status, 400);
    // Not a member / cannot see: 404, not a hint that it exists.
    assert.equal((await putServer('user-5', 'server-2', { level: 'nothing' })).status, 404);
  });
});

// --- mentions: suppressions, roles, keywords, blocks, private channels -----------

describe('mentions and suppressions', () => {
  test('@everyone notifies unless the member suppresses it (badge included)', async () => {
    await reset();
    const before = await mentionCount('user-5', lab);
    const loud = await send('@everyone standup', { channel: lab });
    assert.equal((await inboxRow('user-5', loud))?.type, 'mention');
    assert.equal(await mentionCount('user-5', lab), before + 1);

    await putServer('user-5', 'server-1', { suppress_everyone: true, level: 'only_mentions' });
    const quiet = await send('@everyone standup again', { channel: lab });
    await sleep(150);
    assert.equal(await inboxRow('user-5', quiet), undefined);
    assert.equal(await mentionCount('user-5', lab), before + 1);
  });

  test('@here only reaches people who are not offline', async () => {
    await reset();
    // user-5 is offline in the seed data (the listener identified with the dev
    // header, which does not change a stored "offline" to online for this check).
    const { getQuery } = await import('../db.js');
    const status = (await getQuery(`SELECT status FROM users WHERE id = 'user-5'`))?.status;
    const here = await send('@here quick one', { channel: lab });
    await sleep(150);
    const row = await inboxRow('user-5', here);
    if (status === 'offline' || status === 'invisible') assert.equal(row, undefined);
    else assert.equal(row?.type, 'mention');
  });

  test('role mentions notify role members unless suppressed', async () => {
    await reset();
    const hit = await send('<@&role-1-dev> review please', { channel: lab });
    assert.equal((await inboxRow('user-5', hit))?.type, 'mention');
    await putServer('user-5', 'server-1', { suppress_roles: true });
    const miss = await send('<@&role-1-dev> review again', { channel: lab });
    await sleep(150);
    assert.equal(await inboxRow('user-5', miss), undefined);
  });

  test('a non-mentionable role is not a ping from someone without MENTION_EVERYONE', async () => {
    // role-1-bot (user-3) is not mentionable; user-4 lacks MENTION_EVERYONE.
    const id = await send('<@&role-1-bot> hello bots', { channel: lab, author: 'user-4' });
    await sleep(150);
    assert.equal(await inboxRow('user-3', id), undefined);
  });

  test('keyword highlights notify like a mention, on word boundaries, without a badge', async () => {
    await reset();
    const saved = await api('PUT', '/api/notification-settings/prefs', { keywords: ['Pineapple', ' pineapple ', 'deploy', 'สวัสดี'] }, as('user-5'));
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.keywords, ['Pineapple', 'deploy', 'สวัสดี'], 'keywords are trimmed and deduplicated');
    await putServer('user-5', 'server-1', { level: 'only_mentions' });
    const before = await mentionCount('user-5', lab);

    const hit = await send('who wants PINEAPPLE pizza', { channel: lab });
    assert.equal((await inboxRow('user-5', hit))?.type, 'keyword');
    const thai = await send('ทุกคนสวัสดีครับ', { channel: lab });
    assert.equal((await inboxRow('user-5', thai))?.type, 'keyword');
    const miss = await send('pineapples are different', { channel: lab });
    await sleep(150);
    assert.equal(await inboxRow('user-5', miss), undefined);
    assert.equal(await mentionCount('user-5', lab), before);

    const bad = await api('PUT', '/api/notification-settings/prefs', { keywords: 'nope' }, as('user-5'));
    assert.equal(bad.status, 400);
    await api('PUT', '/api/notification-settings/prefs', { keywords: [] }, as('user-5'));
  });

  test('someone who blocked the author gets nothing: no badge, no inbox, no ping', async () => {
    await reset();
    const blocked = await api('POST', '/api/blocks', { targetId: 'user-4' }, as('user-5'));
    assert.equal(blocked.status, 200, JSON.stringify(blocked.body));
    try {
      const before = await mentionCount('user-5', lab);
      const id = await send('<@user-5> it is me', { channel: lab, author: 'user-4' });
      assert.equal(await listener.pinged(id, 400), false);
      assert.equal(await inboxRow('user-5', id), undefined);
      assert.equal(await mentionCount('user-5', lab), before);
    } finally {
      await api('DELETE', '/api/blocks/user-4', undefined, as('user-5'));
    }
  });

  test('a mention in a channel the member cannot view never reaches them', async () => {
    const ch = await api('POST', '/api/channels', { server_id: 'server-1', name: 'notif-private', type: 'text', parent_id: labCategory });
    await api('PUT', `/api/channels/${ch.body.id}/permissions/role/server-1`, { allow: '0', deny: String(1n << 10n) });
    const id = await send('<@user-5> secret', { channel: ch.body.id });
    await sleep(150);
    assert.equal(await inboxRow('user-5', id), undefined);
    assert.equal(await readState('user-5', ch.body.id), undefined, 'the private channel leaked into the unread summary');
  });
});

// --- mutes -------------------------------------------------------------------

describe('mutes', () => {
  test('a muted channel is silent for plain messages but a mention still comes through (Discord)', async () => {
    await reset();
    await putChannel('user-5', lab, { mute_minutes: 0 });
    const plain = await send('muted chatter', { channel: lab });
    assert.equal(await listener.pinged(plain, 400), false);
    const mention = await send('<@user-5> muted but mentioned', { channel: lab });
    assert.equal((await inboxRow('user-5', mention))?.type, 'mention');
  });

  test('a timed mute expires on its own', async () => {
    await reset();
    const until = new Date(Date.now() + 1500).toISOString();
    const put = await putServer('user-5', 'server-1', { muted: true, muted_until: until });
    assert.equal(put.body.muted, true);
    const during = await send('while muted', { channel: lab });
    assert.equal(await listener.pinged(during, 400), false, 'timed mute ignored');
    await sleep(1700);
    const { body } = await get('/api/notification-settings/servers/server-1', as('user-5'));
    assert.equal(body.muted, false, 'an expired mute still reads as muted');
    const afterwards = await send('mute is over', { channel: lab });
    assert.ok(await listener.pinged(afterwards), 'expired mute still silenced the channel');
  });

  test('the sweeper clears expired mutes so every reader sees them as over', async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    // Written through the legacy settings endpoint, as older clients do.
    const legacy = await api('PUT', `/api/settings/channels/${lab}`, { muted: true, mutedUntil: past }, as('user-5'));
    assert.equal(legacy.status, 200, JSON.stringify(legacy.body));
    const { sweepExpiredMutes } = await import('../services/notifications.js');
    assert.ok(await sweepExpiredMutes() >= 1);
    const { body } = await get('/api/settings/me', as('user-5'));
    const row = body.channels.find((c) => c.channel_id === lab);
    assert.equal(Number(row.muted), 0);
    assert.equal(row.muted_until, null);
  });

  test('DMs always notify unless the DM is muted', async () => {
    const dm = await api('POST', '/api/dms', { recipientId: 'user-2' }, as('user-me'));
    assert.equal(dm.status, 200, JSON.stringify(dm.body));
    const first = await send('dm ping', { channel: dm.body.id });
    assert.equal((await inboxRow('user-2', first))?.type, 'dm');
    await putChannel('user-2', dm.body.id, { mute_minutes: 60 });
    const second = await send('dm while muted', { channel: dm.body.id });
    await sleep(150);
    assert.equal(await inboxRow('user-2', second), undefined);
    await putChannel('user-2', dm.body.id, { muted: false });
    const third = await send('dm unmuted', { channel: dm.body.id });
    assert.equal((await inboxRow('user-2', third))?.type, 'dm');
  });
});

// --- unread counters ---------------------------------------------------------------

describe('unread counters', () => {
  test('unread is lazy: a plain message writes no read_states rows for the audience', async () => {
    const ch = await api('POST', '/api/channels', { server_id: 'server-1', name: 'notif-unread', type: 'text', parent_id: labCategory });
    const channelId = ch.body.id;
    await send('one', { channel: channelId });
    await send('two', { channel: channelId });
    const { allQuery } = await import('../db.js');
    const rows = await allQuery(`SELECT user_id FROM read_states WHERE channel_id = ?`, [channelId]);
    assert.deepEqual(rows.map((r) => r.user_id), ['user-me'], 'only the author has a read state');

    // …and yet everyone sees it unread, with no mentions.
    const state = await readState('user-4', channelId);
    assert.equal(state.unread, 1);
    assert.equal(Number(state.mention_count ?? 0), 0);

    // Mentions are counted exactly, once per mention.
    await send('<@user-4> one', { channel: channelId });
    await send('<@user-4> two @everyone', { channel: channelId });
    assert.equal(await mentionCount('user-4', channelId), 2);

    // Reading clears both.
    const read = await api('POST', `/api/read-states/${channelId}`, {}, as('user-4'));
    assert.equal(read.status, 200);
    const cleared = await readState('user-4', channelId);
    assert.equal(cleared.unread, 0);
    assert.equal(Number(cleared.mention_count), 0);
    // The author's own message never makes the channel unread for them.
    assert.equal((await readState('user-me', channelId)).unread, 0);
  });
});

// --- push: API & lifecycle ----------------------------------------------------------

async function register(prefix) {
  const username = unique(prefix);
  const { status, body } = await api('POST', '/api/auth/register', {
    username, password: 'correct-horse-battery'
  }, { 'x-user-id': '' });
  assert.equal(status, 201, JSON.stringify(body));
  return { username, token: body.token, id: body.user.id };
}

function makeSubscription(tag) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    subscription: {
      endpoint: `https://localhost:${pushPort || 9}/push/${tag}/${crypto.randomBytes(6).toString('hex')}`,
      keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') }
    },
    decrypt: (body) => JSON.parse(ece.decrypt(body, { version: 'aes128gcm', privateKey: ecdh, authSecret: auth.toString('base64url') }).toString('utf8'))
  };
}

const pushesTo = (endpoint) => received.filter((r) => endpoint.endsWith(r.path));

describe('push subscriptions', () => {
  test('config exposes the public key only', async () => {
    const { status, body } = await get('/api/push/config');
    assert.equal(status, 200);
    assert.equal(body.enabled, true);
    assert.equal(body.public_key, vapid.publicKey);
    assert.ok(!JSON.stringify(body).includes(vapid.privateKey));
  });

  test('endpoints must be real push services and keys well-formed', async () => {
    const { subscription } = makeSubscription('val');
    const internal = await api('POST', '/api/push/subscriptions', { ...subscription, endpoint: 'https://169.254.169.254/latest' }, as('user-2'));
    assert.equal(internal.status, 400);
    assert.equal(internal.body.code, 'PUSH_ENDPOINT_NOT_ALLOWED');
    const plain = await api('POST', '/api/push/subscriptions', { ...subscription, endpoint: subscription.endpoint.replace('https:', 'http:') }, as('user-2'));
    assert.equal(plain.body.code, 'PUSH_ENDPOINT_NOT_ALLOWED');
    const badKeys = await api('POST', '/api/push/subscriptions', { ...subscription, keys: { p256dh: 'x', auth: 'y' } }, as('user-2'));
    assert.equal(badKeys.status, 400);
    assert.equal(badKeys.body.code, 'INVALID_SUBSCRIPTION');
    const anon = await api('POST', '/api/push/subscriptions', subscription, { 'x-user-id': '' });
    assert.equal(anon.status, 401);
  });

  test('a subscription belongs to its session: listed without secrets, removed on logout', async () => {
    const alice = await register('pusha');
    const { subscription } = makeSubscription('alice');
    const created = await asSession(alice.token, 'POST', '/api/push/subscriptions', subscription);
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const listed = await asSession(alice.token, 'GET', '/api/push/subscriptions');
    assert.equal(listed.body.length, 1);
    assert.equal(listed.body[0].current_session, true);
    assert.equal(listed.body[0].host, 'localhost');
    assert.ok(!JSON.stringify(listed.body).includes(subscription.keys.auth), 'keys leaked');
    assert.ok(!JSON.stringify(listed.body).includes(subscription.endpoint), 'endpoint leaked');

    const out = await asSession(alice.token, 'POST', '/api/auth/logout');
    assert.ok([200, 204].includes(out.status), JSON.stringify(out.body));
    const { getQuery } = await import('../db.js');
    const gone = await waitUntil(async () => !(await getQuery(
      `SELECT 1 AS x FROM push_subscriptions WHERE endpoint = ?`, [subscription.endpoint]
    )));
    assert.ok(gone, 'logout left the push subscription behind');
  });

  test('revoking a session from another device removes that device\'s subscription', async () => {
    const bob = await register('pushb');
    const second = await api('POST', '/api/auth/login', { username: bob.username, password: 'correct-horse-battery' }, { 'x-user-id': '' });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    const phone = makeSubscription('bob-phone').subscription;
    const laptop = makeSubscription('bob-laptop').subscription;
    await asSession(second.body.token, 'POST', '/api/push/subscriptions', phone);
    await asSession(bob.token, 'POST', '/api/push/subscriptions', laptop);

    const sessions = await asSession(bob.token, 'GET', '/api/auth/sessions');
    const listedPhone = (await asSession(second.body.token, 'GET', '/api/push/subscriptions')).body.find((s) => s.current_session);
    assert.ok(listedPhone);
    const phoneSession = sessions.body.sessions?.find?.((s) => !s.current) ?? sessions.body.find?.((s) => !s.current);
    assert.ok(phoneSession, JSON.stringify(sessions.body));
    const revoked = await asSession(bob.token, 'DELETE', `/api/auth/sessions/${phoneSession.id}`);
    assert.ok([200, 204].includes(revoked.status), JSON.stringify(revoked.body));

    const { getQuery } = await import('../db.js');
    assert.ok(await waitUntil(async () => !(await getQuery(`SELECT 1 AS x FROM push_subscriptions WHERE endpoint = ?`, [phone.endpoint]))));
    assert.ok(await getQuery(`SELECT 1 AS x FROM push_subscriptions WHERE endpoint = ?`, [laptop.endpoint]), 'the other device lost its subscription');
  });

  test('re-subscribing an endpoint moves it to the new owner; unsubscribe removes only your own', async () => {
    const { subscription } = makeSubscription('shared');
    await api('POST', '/api/push/subscriptions', subscription, as('user-4'));
    await api('POST', '/api/push/subscriptions', subscription, as('user-2'));
    const { allQuery } = await import('../db.js');
    let rows = await allQuery(`SELECT user_id FROM push_subscriptions WHERE endpoint = ?`, [subscription.endpoint]);
    assert.deepEqual(rows.map((r) => r.user_id), ['user-2']);
    const notMine = await api('DELETE', '/api/push/subscriptions', { endpoint: subscription.endpoint }, as('user-4'));
    assert.equal(notMine.body.removed, 0);
    const mine = await api('DELETE', '/api/push/subscriptions', { endpoint: subscription.endpoint }, as('user-2'));
    assert.equal(mine.body.removed, 1);
    rows = await allQuery(`SELECT user_id FROM push_subscriptions WHERE endpoint = ?`, [subscription.endpoint]);
    assert.equal(rows.length, 0);
  });
});

// --- push: delivery -----------------------------------------------------------------

describe('push delivery', { skip: !tlsReady && 'openssl not available for the local push service' }, () => {
  let carol;
  let dmId;
  let device;

  before(async () => {
    carol = await register('pushc');
    const dm = await asSession(carol.token, 'POST', '/api/dms', { recipientId: 'user-me' });
    assert.equal(dm.status, 200, JSON.stringify(dm.body));
    dmId = dm.body.id;
    device = makeSubscription('carol');
    const created = await asSession(carol.token, 'POST', '/api/push/subscriptions', device.subscription);
    assert.equal(created.status, 201, JSON.stringify(created.body));
  });

  test('a DM is pushed: VAPID auth, aes128gcm, TTL/urgency/topic, declarative payload', async () => {
    const id = await send('hello <@user-me> over push', { channel: dmId });
    const pushes = await waitUntil(() => pushesTo(device.subscription.endpoint).length ? pushesTo(device.subscription.endpoint) : null);
    assert.ok(pushes, 'no push arrived');
    const push = pushes.at(-1);
    assert.match(push.headers.authorization, /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);
    assert.equal(push.headers['content-encoding'], 'aes128gcm');
    assert.ok(Number(push.headers.ttl) > 0);
    assert.equal(push.headers.urgency, 'high');
    assert.equal(push.headers.topic, `c${dmId}`.slice(0, 32));

    const payload = device.decrypt(push.body);
    assert.equal(payload.web_push, 8030);
    assert.match(payload.notification.title, /Alex/);
    assert.equal(payload.notification.body, 'hello @Alex (You) over push');
    assert.equal(payload.notification.navigate, `https://chat.example.test/channels/@me/${dmId}/${id}`);
    assert.equal(payload.notification.tag, `channel-${dmId}`);
    assert.equal(typeof payload.notification.app_badge, 'string');
    assert.ok(Number(payload.notification.app_badge) >= 1);
  });

  test('privacy: "hidden" pushes carry no names or content', async () => {
    await asSession(carol.token, 'PUT', '/api/notification-settings/prefs', { push_content: 'hidden' });
    const count = pushesTo(device.subscription.endpoint).length;
    await send('top secret launch codes', { channel: dmId });
    const pushes = await waitUntil(() => pushesTo(device.subscription.endpoint).length > count && pushesTo(device.subscription.endpoint));
    const payload = device.decrypt(pushes.at(-1).body);
    assert.ok(!JSON.stringify(payload.notification).includes('launch codes'));
    assert.ok(!JSON.stringify(payload.notification).includes('Alex'));
    await asSession(carol.token, 'PUT', '/api/notification-settings/prefs', { push_content: 'full' });
  });

  test('no push while the user has a focused client; pushes resume when it loses focus', async () => {
    const socket = await connect({ token: carol.token });
    try {
      socket.emit('client_state', { focused: true });
      await sleep(150);
      const count = pushesTo(device.subscription.endpoint).length;
      await send('you are looking at it', { channel: dmId });
      await sleep(600);
      assert.equal(pushesTo(device.subscription.endpoint).length, count, 'pushed to a focused user');

      socket.emit('client_state', { focused: false });
      await sleep(150);
      await send('now you are not', { channel: dmId });
      assert.ok(await waitUntil(() => pushesTo(device.subscription.endpoint).length > count));
    } finally {
      socket.close();
    }
  });

  test('the test endpoint pushes to the caller\'s devices', async () => {
    const count = pushesTo(device.subscription.endpoint).length;
    const { status, body } = await asSession(carol.token, 'POST', '/api/push/test');
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.sent, 1);
    assert.equal(pushesTo(device.subscription.endpoint).length, count + 1);
    assert.equal(device.decrypt(pushesTo(device.subscription.endpoint).at(-1).body).notification.tag, 'push-test');
  });

  test('a 410 from the push service deletes the subscription', async () => {
    const dave = await register('pushd');
    const dm = await asSession(dave.token, 'POST', '/api/dms', { recipientId: 'user-me' });
    const dead = makeSubscription('gone').subscription;
    await asSession(dave.token, 'POST', '/api/push/subscriptions', dead);
    await send('are you there', { channel: dm.body.id });
    const { getQuery } = await import('../db.js');
    assert.ok(await waitUntil(async () => !(await getQuery(`SELECT 1 AS x FROM push_subscriptions WHERE endpoint = ?`, [dead.endpoint]))),
      'expired subscription was not pruned');
  });

  test('pushes are rate-limited per user', async () => {
    const erin = await register('pushe');
    const dm = await asSession(erin.token, 'POST', '/api/dms', { recipientId: 'user-me' });
    const sub = makeSubscription('erin');
    await asSession(erin.token, 'POST', '/api/push/subscriptions', sub.subscription);
    for (let i = 0; i < 10; i += 1) await send(`burst ${i}`, { channel: dm.body.id });
    await sleep(800);
    const n = pushesTo(sub.subscription.endpoint).length;
    assert.ok(n >= 1 && n <= 6, `expected 1..6 pushes under PUSH_USER_LIMIT_PER_MIN=6, got ${n}`);
  });
});
