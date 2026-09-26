#!/usr/bin/env node
// ============================================================================
//  Integration round (schema v43): forwarding v2 (server-built copies with
//  snapshot metadata, read-access check, 5-destination cap, socket path),
//  reply pings (allowed_mentions.replied_user), age-restricted channels
//  enforced on the server, message requests that do not notify, generic
//  "unreachable" DM refusals, invisible friends/DM recipients, instance
//  admins closing guildless reports, invite accept landing channel, and the
//  guild-wide voice roster.
//
//  Runs on both drivers (npm test / npm run test:pg).
// ============================================================================

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { io as ioClient } from 'socket.io-client';

import { startServer, stopServer, BASE } from './testHarness.mjs';

before(startServer);
after(stopServer);

const as = (userId) => ({ 'x-user-id': userId });
const thisYear = new Date().getUTCFullYear();

async function api(method, url, body, headers = {}) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

const db = () => import('../db.js');

async function makeUser(prefix, { birthYear = thisYear - 30 } = {}) {
  const { runQuery } = await db();
  const id = `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
  await runQuery(
    `INSERT INTO users (id, username, display_name, email, birth_year, birth_month) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, id, id, `${id}@example.test`, birthYear, birthYear == null ? null : 1]
  );
  return id;
}

async function makeServer(owner, name = 'Integration') {
  const res = await api('POST', '/api/servers', { name }, as(owner));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.id;
}

async function invite(serverId, owner, channelId = undefined) {
  const res = await api('POST', `/api/servers/${serverId}/invites`, { maxAge: 0, channelId }, as(owner));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.code;
}

async function join(serverId, owner, userId) {
  const code = await invite(serverId, owner);
  const res = await api('POST', `/api/invites/${code}/accept`, undefined, as(userId));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

const detail = async (serverId, userId) => (await api('GET', `/api/servers/${serverId}`, undefined, as(userId))).body;
const firstText = (d) => d.channels.find((c) => c.type === 'text').id;
const send = (userId, body) => api('POST', '/api/messages', body, as(userId));

async function createChannel(owner, serverId, patch = {}) {
  const res = await api('POST', '/api/channels', { server_id: serverId, name: `c${crypto.randomBytes(2).toString('hex')}`, type: 'text', ...patch }, as(owner));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

let sockets = [];
after(() => { for (const s of sockets) s.close(); sockets = []; });
function connectAs(userId) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(BASE, { transports: ['websocket'], forceNew: true, reconnection: false });
    const fail = setTimeout(() => reject(new Error('socket did not identify')), 5000);
    socket.on('connect', () => socket.emit('identify', { userId }));
    socket.on('identified', () => { clearTimeout(fail); sockets.push(socket); resolve(socket); });
    socket.on('connect_error', (err) => { clearTimeout(fail); reject(err); });
  });
}
const emitAck = (socket, event, payload) => new Promise((resolve) => {
  socket.emit(event, payload, resolve);
  setTimeout(() => resolve(null), 3000);
});
const waitFor = (socket, event, predicate = () => true, ms = 3000) => new Promise((resolve) => {
  const timer = setTimeout(() => { socket.off(event, handler); resolve(null); }, ms);
  function handler(payload) {
    if (!predicate(payload)) return;
    clearTimeout(timer); socket.off(event, handler); resolve(payload ?? true);
  }
  socket.on(event, handler);
});

// ---------------------------------------------------------------------------

describe('forwarding v2', () => {
  let owner; let member; let outsider; let serverId; let general; let other; let source;

  before(async () => {
    owner = await makeUser('fo');
    member = await makeUser('fm');
    outsider = await makeUser('fx');
    serverId = await makeServer(owner);
    await join(serverId, owner, member);
    const d = await detail(serverId, owner);
    general = firstText(d);
    other = (await createChannel(owner, serverId)).id;
    const res = await send(owner, { channel_id: general, content: 'the original words <@' + member + '>' });
    assert.equal(res.status, 200);
    source = res.body;
  });

  test('the copy is built from the source on the server and carries snapshot metadata', async () => {
    const res = await send(member, {
      channel_id: other, content: 'a lie the client made up',
      forwarded_from: { message_id: source.id, channel_id: 'spoofed', guild_id: 'spoofed' }
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.content, source.content, 'content comes from the source message');
    const snap = res.body.forwarded_from;
    assert.equal(snap.message_id, source.id);
    assert.equal(snap.channel_id, general);
    assert.equal(snap.guild_id, serverId);
    assert.ok(snap.channel_name, 'channel name kept');
    assert.equal(snap.author_name, owner);
    assert.equal(snap.created_at, source.created_at);

    // History returns it too (hydrate), not only the send echo.
    const history = await api('GET', `/api/messages/${other}?limit=5`, undefined, as(owner));
    const copy = (history.body.messages ?? history.body).find((m) => m.id === res.body.id);
    assert.equal(copy.forwarded_from.message_id, source.id);
  });

  test('a forward of a forward still points at the origin', async () => {
    const first = await send(member, { channel_id: other, forwarded_from: { message_id: source.id } });
    const second = await send(owner, { channel_id: general, forwarded_from: { message_id: first.body.id } });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(second.body.forwarded_from.message_id, source.id);
  });

  test('someone who cannot read the source gets a plain 404', async () => {
    const dm = await api('POST', '/api/dms', { recipientId: owner }, as(outsider));
    // The outsider may or may not be able to DM the owner; either way the
    // forward itself must be refused as if the message did not exist.
    const target = dm.status === 200 ? dm.body.id : general;
    const res = await send(outsider, { channel_id: target, forwarded_from: { message_id: source.id } });
    assert.equal(res.status, 404);
  });

  test('a missing message_id is a validation error', async () => {
    const res = await send(member, { channel_id: other, forwarded_from: {} });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'INVALID_FORWARD');
  });

  test('one message goes to at most five destinations a minute', async () => {
    const fresh = (await send(owner, { channel_id: general, content: 'cap me' })).body;
    const codes = [];
    for (let i = 0; i < 6; i += 1) {
      const res = await send(owner, { channel_id: other, forwarded_from: { message_id: fresh.id } });
      codes.push(res.status === 200 ? 200 : res.body.code);
    }
    assert.deepEqual(codes, [200, 200, 200, 200, 200, 'FORWARD_LIMIT']);
  });

  test('a forward pings nobody, even when the source mentions someone', async () => {
    const { allQuery } = await db();
    const res = await send(owner, { channel_id: other, forwarded_from: { message_id: source.id } });
    const rows = await allQuery(`SELECT * FROM mentions WHERE message_id = ?`, [res.body.id]);
    assert.equal(rows.length, 0);
  });

  test('the socket send path accepts forwarded_from too', async () => {
    const socket = await connectAs(member);
    const ack = await emitAck(socket, 'send_message', {
      channel_id: other, content: 'ignored', forwarded_from: { message_id: source.id }, nonce: `n-${Date.now()}`
    });
    assert.equal(ack?.ok, true, JSON.stringify(ack));
    assert.equal(ack.message.forwarded_from.message_id, source.id);
    assert.equal(ack.message.content, source.content);
    socket.close();
  });
});

describe('reply pings (allowed_mentions.replied_user)', () => {
  test('a reply pings its author by default and not when the toggle is off', async () => {
    const { allQuery } = await db();
    const owner = await makeUser('ro');
    const member = await makeUser('rm');
    const serverId = await makeServer(owner);
    await join(serverId, owner, member);
    const general = firstText(await detail(serverId, owner));
    const original = (await send(owner, { channel_id: general, content: 'question?' })).body;

    const pinging = await send(member, { channel_id: general, content: 'answer', reply_to_id: original.id });
    const silent = await send(member, {
      channel_id: general, content: 'quiet answer', reply_to_id: original.id,
      allowed_mentions: { replied_user: false }
    });
    const explicit = await send(member, {
      channel_id: general, content: 'explicit', reply_to_id: original.id,
      allowed_mentions: { replied_user: true }
    });
    const mentioned = async (id) => (await allQuery(
      `SELECT target_id FROM mentions WHERE message_id = ? AND target_type = 'user'`, [id]
    )).map((r) => r.target_id);
    assert.deepEqual(await mentioned(pinging.body.id), [owner]);
    assert.deepEqual(await mentioned(silent.body.id), []);
    assert.deepEqual(await mentioned(explicit.body.id), [owner]);

    const rs = await allQuery(`SELECT mention_count FROM read_states WHERE user_id = ? AND channel_id = ?`, [owner, general]);
    assert.equal(Number(rs[0]?.mention_count), 2, 'two pinging replies → two mentions');

    // Replying to yourself never pings.
    const self = await send(owner, { channel_id: general, content: 'me again', reply_to_id: original.id });
    assert.deepEqual(await mentioned(self.body.id), []);
  });
});

describe('age-restricted channels are enforced on the server', () => {
  let owner; let teen; let adult; let unknown; let serverId; let nsfw; let general;

  before(async () => {
    owner = await makeUser('ao');
    teen = await makeUser('at', { birthYear: thisYear - 15 });
    adult = await makeUser('aa');
    unknown = await makeUser('au', { birthYear: null });
    serverId = await makeServer(owner);
    for (const u of [teen, adult, unknown]) await join(serverId, owner, u);
    general = firstText(await detail(serverId, owner));
    nsfw = (await createChannel(owner, serverId)).id;
    const patch = await api('PATCH', `/api/channels/${nsfw}`, { nsfw: true }, as(owner));
    assert.equal(patch.status, 200, JSON.stringify(patch.body));
    await send(owner, { channel_id: nsfw, content: 'grown-up talk' });
  });

  test('a member under 18 can neither read nor send there', async () => {
    const read = await api('GET', `/api/messages/${nsfw}`, undefined, as(teen));
    assert.equal(read.status, 403);
    assert.equal(read.body.code, 'AGE_RESTRICTED');
    const post = await send(teen, { channel_id: nsfw, content: 'hi' });
    assert.equal(post.status, 403);
    assert.equal(post.body.code, 'AGE_RESTRICTED');
    // Ordinary channels are unaffected.
    assert.equal((await send(teen, { channel_id: general, content: 'hi' })).status, 200);
  });

  test('adults (and accounts the client still has to ask) are let through', async () => {
    assert.equal((await api('GET', `/api/messages/${nsfw}`, undefined, as(adult))).status, 200);
    assert.equal((await send(adult, { channel_id: nsfw, content: 'ok' })).status, 200);
    assert.equal((await api('GET', `/api/messages/${nsfw}`, undefined, as(unknown))).status, 200);
  });

  test('a thread under an age-restricted channel is restricted too', async () => {
    const parent = (await send(owner, { channel_id: nsfw, content: 'thread root' })).body;
    const thread = await api('POST', `/api/channels/${nsfw}/threads`, { name: 'deeper', messageId: parent.id }, as(owner));
    assert.equal(thread.status, 200, JSON.stringify(thread.body));
    const read = await api('GET', `/api/messages/${thread.body.id}`, undefined, as(teen));
    assert.equal(read.status, 403);
    assert.equal(read.body.code, 'AGE_RESTRICTED');
  });

  test('a teen cannot join the channel room over the socket', async () => {
    const socket = await connectAs(teen);
    const ack = await emitAck(socket, 'join_channel', nsfw);
    assert.equal(ack?.ok, false);
    socket.close();
  });

  test('search does not surface the channel to a teen', async () => {
    await send(owner, { channel_id: nsfw, content: 'zebracorn unique phrase' });
    await send(owner, { channel_id: general, content: 'zebracorn in general' });
    const res = await api('GET', `/api/search/messages?q=zebracorn&serverId=${serverId}`, undefined, as(teen));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const list = res.body.messages ?? res.body.results ?? [];
    const flat = list.flat ? list.flat() : list;
    assert.ok(flat.every((m) => m.channel_id !== nsfw), 'no age-restricted hits');
  });
});

describe('message requests do not notify', () => {
  test('a stranger\'s DM gives an unread but no inbox row, live notification or push', async () => {
    const { allQuery, runQuery } = await db();
    const owner = await makeUser('mo');
    const stranger = await makeUser('ms');
    const serverId = await makeServer(owner);
    await join(serverId, owner, stranger);
    // Message requests are on for the recipient.
    const prefs = await api('PATCH', '/api/settings/preferences/privacy', { messageRequests: true }, as(owner));
    assert.ok([200, 204].includes(prefs.status), JSON.stringify(prefs.body));

    const dm = await api('POST', '/api/dms', { recipientId: owner }, as(stranger));
    assert.equal(dm.status, 200, JSON.stringify(dm.body));
    const socket = await connectAs(owner);
    const ping = waitFor(socket, 'notification', (p) => p.channel_id === dm.body.id, 1500);
    const sent = await send(stranger, { channel_id: dm.body.id, content: 'hello stranger' });
    assert.equal(sent.status, 200);
    assert.equal(await ping, null, 'no live notification for a pending request');
    const inbox = await allQuery(`SELECT * FROM notifications WHERE user_id = ? AND channel_id = ?`, [owner, dm.body.id]);
    assert.equal(inbox.length, 0);

    // Once accepted, the next message pings as usual.
    await runQuery(`INSERT INTO dm_requests (user_id, channel_id, state) VALUES (?, ?, 'accepted')`, [owner, dm.body.id]);
    const ping2 = waitFor(socket, 'notification', (p) => p.channel_id === dm.body.id, 3000);
    await send(stranger, { channel_id: dm.body.id, content: 'hello again' });
    assert.ok(await ping2, 'accepted conversation notifies');
    const after = await allQuery(`SELECT * FROM notifications WHERE user_id = ? AND channel_id = ?`, [owner, dm.body.id]);
    assert.equal(after.length, 1);
    socket.close();
  });
});

describe('privacy: generic refusals and invisible status', () => {
  test('opening a DM with someone who blocked you says USER_UNREACHABLE (same as a privacy setting)', async () => {
    const a = await makeUser('ba');
    const b = await makeUser('bb');
    const serverId = await makeServer(a);
    await join(serverId, a, b);
    const { runQuery } = await db();
    await runQuery(`INSERT INTO blocks (user_id, blocked_id) VALUES (?, ?)`, [a, b]);
    const res = await api('POST', '/api/dms', { recipientId: a }, as(b));
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'USER_UNREACHABLE');
    const group = await api('POST', '/api/dms', { recipientIds: [a, await makeUser('bc')] }, as(b));
    assert.equal(group.status, 403);
    assert.equal(group.body.code, 'USER_UNREACHABLE');
  });

  test('an invisible friend and DM recipient read as offline', async () => {
    const { runQuery } = await db();
    const me = await makeUser('im');
    const ghost = await makeUser('ig');
    await runQuery(`UPDATE users SET status = 'invisible' WHERE id = ?`, [ghost]);
    await runQuery(
      `INSERT INTO friends (id, user_id, friend_id, status, requested_by) VALUES (?, ?, ?, 'accepted', ?)`,
      [crypto.randomUUID(), me, ghost, me]
    );
    const dm = await api('POST', '/api/dms', { recipientId: ghost }, as(me));
    assert.equal(dm.status, 200, JSON.stringify(dm.body));
    assert.equal(dm.body.recipients[0].status, 'offline');
    const boot = (await api('GET', `/api/initial-data/${me}`, undefined, as(me))).body;
    const friend = boot.friends.find((f) => f.id === ghost);
    assert.equal(friend.status, 'offline');
    assert.equal(boot.dms.find((d) => d.id === dm.body.id).recipients[0].status, 'offline');
  });
});

describe('reports and invites', () => {
  test('an instance admin can close a report that has no server', async () => {
    const { runQuery } = await db();
    const admin = await makeUser('ra');
    const victim = await makeUser('rv');
    const harasser = await makeUser('rh');
    const mod = await makeUser('rx');
    await runQuery(`UPDATE users SET instance_admin = 1 WHERE id = ?`, [admin]);
    const report = await api('POST', '/api/reports', { target_type: 'user', target_id: harasser, reason: 'harassment' }, as(victim));
    assert.equal(report.status, 200, JSON.stringify(report.body));
    const id = report.body.id;

    const refused = await api('PATCH', `/api/reports/${id}`, { status: 'resolved' }, as(mod));
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'NOT_INSTANCE_ADMIN');

    const closed = await api('PATCH', `/api/reports/${id}`, { status: 'resolved' }, as(admin));
    assert.equal(closed.status, 200, JSON.stringify(closed.body));
  });

  test('accepting an invite says which channel to open', async () => {
    const owner = await makeUser('io');
    const guest = await makeUser('ig');
    const serverId = await makeServer(owner);
    const target = await createChannel(owner, serverId);
    const code = await invite(serverId, owner, target.id);
    const res = await api('POST', `/api/invites/${code}/accept`, undefined, as(guest));
    assert.equal(res.status, 200);
    assert.equal(res.body.channel_id, target.id);
  });
});

describe('guild-wide voice roster', () => {
  test('server detail lists voice occupants, and joins are pushed to members who can see the channel', async () => {
    // Seeded server-1: chan-104 is a voice channel; user-2 and user-5 are members.
    const watcher = await connectAs('user-5');
    const roster = waitFor(watcher, 'voice_roster',
      (p) => p.channelId === 'chan-104' && p.participants.some((x) => x.userId === 'user-2'), 4000);
    const speaker = await connectAs('user-2');
    const joined = await emitAck(speaker, 'join_voice', { channelId: 'chan-104' });
    assert.equal(joined?.ok, true, JSON.stringify(joined));
    const event = await roster;
    assert.ok(event, 'voice_roster reached a guild member outside the voice room');
    assert.equal(event.serverId, 'server-1');
    assert.equal(event.participants[0].socketId, undefined, 'socket ids never leave the voice room');

    const d = await detail('server-1', 'user-5');
    assert.ok(d.voice_states?.['chan-104']?.some((p) => p.userId === 'user-2'));

    const left = waitFor(watcher, 'voice_roster',
      (p) => p.channelId === 'chan-104' && !p.participants.some((x) => x.userId === 'user-2'), 4000);
    speaker.emit('leave_voice', { channelId: 'chan-104' });
    speaker.close();
    assert.ok(await left, 'leaving is pushed too');
    watcher.close();
  });
});
