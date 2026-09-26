// ============================================================================
//  Integration tests, part 4: regression tests for the production-hardening
//  pass — role hierarchy, invite-only guilds, MFA at login, storage IDORs,
//  socket room hygiene, implicit permissions, SSRF address checks and more.
// ============================================================================

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { io as ioClient } from 'socket.io-client';

import {
  startServer, stopServer, api, get, asSession, login, uploadFile, PNG, BASE
} from './testHarness.mjs';
import { generateCode } from '../lib/totp.js';
import { computeChannelPermissions, PERMISSIONS, has } from '../lib/permissions.js';
import { isPrivateAddress, decodeEntities } from '../services/linkEmbeds.js';

// The harness forwards this process's environment to the server it spawns,
// so TURN can be configured for the ICE endpoint test.
process.env.TURN_URLS = 'turn:turn.test:3478';
process.env.TURN_SECRET = 'test-turn-secret';
process.env.TURN_TTL_SECONDS = '600';

before(startServer);
after(stopServer);

const as = (userId) => ({ 'x-user-id': userId });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let counter = 0;
const unique = (prefix) => `${prefix}${Date.now().toString(36)}${(counter += 1)}`;

async function register(prefix) {
  const username = unique(prefix);
  const { status, body } = await api('POST', '/api/auth/register', {
    username, password: 'correct-horse-battery'
  }, { 'x-user-id': '' });
  assert.equal(status, 201, JSON.stringify(body));
  return { username, token: body.token, id: body.user.id };
}

async function inviteInto(serverId, token) {
  const invite = await api('POST', `/api/servers/${serverId}/invites`, { maxUses: 0, maxAge: 3600 });
  const accepted = await asSession(token, 'POST', `/api/invites/${invite.body.code}/accept`);
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
}

function connect({ userId = null, token = null } = {}) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(BASE, { transports: ['websocket'], forceNew: true });
    const fail = setTimeout(() => reject(new Error('socket did not identify in time')), 5000);
    socket.on('connect', () => {
      if (!userId && !token) { clearTimeout(fail); resolve(socket); return; }
      socket.emit('identify', token ? { token } : { userId });
    });
    socket.on('identified', () => { clearTimeout(fail); resolve(socket); });
    socket.on('connect_error', (err) => { clearTimeout(fail); reject(err); });
  });
}

const received = (socket, event, ms = 800) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve(null), ms);
  socket.once(event, (payload) => { clearTimeout(timer); resolve(payload ?? true); });
});

const emitAck = (socket, event, payload) => new Promise((resolve) => {
  socket.emit(event, payload, resolve);
  setTimeout(() => resolve(null), 3000);
});

// ---------------------------------------------------------------------------

describe('pure rules', () => {
  test('without VIEW_CHANNEL every other permission is implicitly denied', () => {
    const base = (PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.CREATE_PUBLIC_THREADS
      | PERMISSIONS.ADD_REACTIONS).toString();
    const result = computeChannelPermissions({
      base,
      overwrites: [{ target_type: 'role', target_id: 'g', allow: '0', deny: PERMISSIONS.VIEW_CHANNEL.toString() }],
      everyoneRoleId: 'g', memberRoleIds: ['g'], userId: 'u'
    });
    assert.equal(result, '0');
  });

  test('without SEND_MESSAGES, attach/embed/mention-everyone go with it', () => {
    const base = (PERMISSIONS.VIEW_CHANNEL | PERMISSIONS.SEND_MESSAGES | PERMISSIONS.ATTACH_FILES
      | PERMISSIONS.EMBED_LINKS | PERMISSIONS.MENTION_EVERYONE | PERMISSIONS.ADD_REACTIONS).toString();
    const result = computeChannelPermissions({
      base,
      overwrites: [{ target_type: 'member', target_id: 'u', allow: '0', deny: PERMISSIONS.SEND_MESSAGES.toString() }],
      everyoneRoleId: 'g', memberRoleIds: ['g'], userId: 'u'
    });
    assert.ok(!has(result, 'ATTACH_FILES'));
    assert.ok(!has(result, 'EMBED_LINKS'));
    assert.ok(!has(result, 'MENTION_EVERYONE'));
    assert.ok(has(result, 'ADD_REACTIONS'));
  });

  test('unfurl entity decoding is single-pass (no double unescaping)', () => {
    assert.equal(decodeEntities('Tom &amp; Jerry &lt;3 &quot;hi&quot; &#39;x&#039; &#x41;&#66;'), 'Tom & Jerry <3 "hi" \'x\' AB');
    assert.equal(decodeEntities('&amp;lt;script&amp;gt;'), '&lt;script&gt;');
    assert.equal(decodeEntities('&#38;lt;'), '&lt;');
    assert.equal(decodeEntities('&bogus; &#x110000;'), '&bogus; &#x110000;');
  });

  test('SSRF guard refuses mapped, private and reserved addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '::1', '::ffff:127.0.0.1',
      '::ffff:7f00:1', '::ffff:a9fe:a9fe', '64:ff9b::a9fe:a9fe', 'fe80::1', 'fd00::1',
      '0.0.0.0', '224.0.0.1', '255.255.255.255', '::']) {
      assert.equal(isPrivateAddress(ip), true, `${ip} should be refused`);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) {
      assert.equal(isPrivateAddress(ip), false, `${ip} should be allowed`);
    }
  });

  test('a production database is never seeded unless asked', async () => {
    const { shouldSeed } = await import('../db.js');
    assert.equal(shouldSeed({ NODE_ENV: 'production' }), false);
    assert.equal(shouldSeed({ NODE_ENV: 'production', SEED_DATABASE: '1' }), true);
    assert.equal(shouldSeed({ NODE_ENV: 'development' }), true);
    assert.equal(shouldSeed({ NODE_ENV: 'development', SEED_DATABASE: '0' }), false);
  });
});

describe('role hierarchy (MANAGE_ROLES is not a path to admin)', () => {
  let managerRoleId;

  before(async () => {
    const role = await api('POST', '/api/servers/server-1/roles', {
      name: 'Role manager', permissions: PERMISSIONS.MANAGE_ROLES.toString()
    });
    assert.equal(role.status, 200);
    managerRoleId = role.body.id;
    const moved = await api('PATCH', `/api/servers/server-1/roles/${managerRoleId}`, { position: 50 });
    assert.equal(moved.status, 200);
    const given = await api('PUT', `/api/servers/server-1/members/user-5/roles/${managerRoleId}`);
    assert.equal(given.status, 200);
  });

  test('cannot create a role with a permission you do not hold', async () => {
    const res = await api('POST', '/api/servers/server-1/roles', {
      name: 'sneaky', permissions: PERMISSIONS.ADMINISTRATOR.toString()
    }, as('user-5'));
    assert.equal(res.status, 403);
  });

  test('cannot assign a role at or above your own highest role', async () => {
    const res = await api('PUT', '/api/servers/server-1/members/user-5/roles/role-1-admin', undefined, as('user-5'));
    assert.equal(res.status, 403);
    const perms = await get('/api/servers/server-1/permissions/user-5', as('user-5'));
    assert.ok(!perms.body.roleIds.includes('role-1-admin'));
  });

  test('can still assign a role below your own', async () => {
    const res = await api('PUT', '/api/servers/server-1/members/user-4/roles/role-1-dev', undefined, as('user-5'));
    assert.equal(res.status, 200);
  });

  test('cannot remove a role above your own from someone else', async () => {
    const res = await api('DELETE', '/api/servers/server-1/members/user-2/roles/role-1-admin', undefined, as('user-5'));
    assert.equal(res.status, 403);
  });

  test('cannot move a role above your own highest role', async () => {
    const res = await api('PATCH', '/api/servers/server-1/roles/role-1-dev', { position: 95 }, as('user-5'));
    assert.equal(res.status, 403);
  });

  test('cannot assign a role to someone who is not a member', async () => {
    const res = await api('PUT', '/api/servers/server-3/members/user-2/roles/role-3-admin');
    assert.equal(res.status, 404);
  });
});

describe('guild membership', () => {
  test('a private server cannot be joined by id alone', async () => {
    const outsider = await register('outsider');
    const res = await asSession(outsider.token, 'POST', '/api/servers/server-3/join');
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'INVITE_REQUIRED');
  });

  test('a kicked member who comes back starts with no roles', async () => {
    const member = await register('kicked');
    await inviteInto('server-1', member.token);
    assert.equal((await api('PUT', `/api/servers/server-1/members/${member.id}/roles/role-1-mod`)).status, 200);

    assert.equal((await api('POST', `/api/servers/server-1/kicks/${member.id}`, {})).status, 200);
    await inviteInto('server-1', member.token);

    const perms = await asSession(member.token, 'GET', `/api/servers/server-1/permissions/${member.id}`);
    assert.deepEqual(perms.body.roleIds, ['server-1']);
  });

  test('nicknames are capped at 32 characters', async () => {
    const res = await api('PATCH', '/api/servers/server-1/members/user-me', { nickname: 'x'.repeat(40) });
    assert.equal(res.status, 400);
  });

  test('a channel cannot be parented under another server\'s category', async () => {
    const res = await api('PATCH', '/api/channels/chan-103', { parent_id: 'cat-2-text' });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'INVALID_PARENT');
  });
});

describe('MFA is enforced at login', () => {
  test('a password alone does not sign in to an account with 2FA', async () => {
    const account = await register('mfa');
    const begun = await asSession(account.token, 'POST', '/api/auth/mfa/begin');
    const confirmed = await asSession(account.token, 'POST', '/api/auth/mfa/confirm', {
      code: generateCode(begun.body.secret)
    });
    assert.equal(confirmed.status, 200);

    const bare = await login(account.username, 'correct-horse-battery');
    assert.equal(bare.status, 401);
    assert.equal(bare.token, undefined, 'a session was issued without the second factor');

    const wrong = await api('POST', '/api/auth/login', {
      username: account.username, password: 'correct-horse-battery', mfa_code: '000000'
    });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.code, 'INVALID_MFA_CODE');

    const good = await api('POST', '/api/auth/login', {
      username: account.username, password: 'correct-horse-battery',
      mfa_code: generateCode(begun.body.secret)
    });
    assert.equal(good.status, 200);
    assert.ok(good.body.token);
  });
});

describe('storage access control', () => {
  test('anonymous uploads are refused', async () => {
    const form = new FormData();
    form.append('files', new Blob([PNG], { type: 'image/png' }), 'anon.png');
    const res = await fetch(`${BASE}/api/upload/attachments`, { method: 'POST', body: form });
    assert.equal(res.status, 401);
  });

  test('another user\'s file inventory is not readable', async () => {
    assert.equal((await get('/api/files/usage?userId=user-2')).status, 403);
    assert.equal((await get('/api/files?userId=user-2')).status, 403);
    assert.equal((await get('/api/files/usage')).status, 200);
  });

  test('reference counts cannot be changed without the admin token', async () => {
    const { body } = await uploadFile(Buffer.concat([PNG, Buffer.from('p4-ref')]), 'r.png', 'image/png');
    const id = body.attachments[0].id;
    assert.equal((await api('DELETE', `/api/files/${id}/reference`)).status, 403);
    assert.equal((await api('POST', `/api/files/${id}/reference`, { count: 5 })).status, 403);
    const meta = await fetch(`${BASE}/api/files/${id}/meta`);
    assert.equal(meta.status, 401);
  });

  test('bulk delete releases attachment references', async () => {
    const { body } = await uploadFile(Buffer.concat([PNG, Buffer.from('p4-bulk')]), 'b.png', 'image/png');
    const fileId = body.attachments[0].id;
    const ids = [];
    for (let i = 0; i < 2; i += 1) {
      const sent = await api('POST', '/api/messages', {
        channel_id: 'chan-102', content: `bulk ${i}`, attachments: [{ file_id: fileId }]
      });
      ids.push(sent.body.id);
    }
    assert.equal((await get(`/api/files/${fileId}/meta`)).body.ref_count, 2);
    const bulk = await api('POST', '/api/channels/chan-102/messages/bulk-delete', { message_ids: ids });
    assert.equal(bulk.status, 200);
    assert.equal((await get(`/api/files/${fileId}/meta`)).body.ref_count, 0);
  });
});

describe('message hardening', () => {
  test('reactions reject oversized emoji and cap distinct reactions at 20', async () => {
    const { body: msg } = await api('POST', '/api/messages', { channel_id: 'chan-102', content: 'react to me' });
    const long = await api('PUT', `/api/messages/${msg.id}/reactions/${encodeURIComponent('x'.repeat(200))}`);
    assert.equal(long.status, 400);
    for (let i = 0; i < 20; i += 1) {
      assert.equal((await api('PUT', `/api/messages/${msg.id}/reactions/r${i}`)).status, 200);
    }
    const over = await api('PUT', `/api/messages/${msg.id}/reactions/r20`);
    assert.equal(over.status, 400);
    assert.equal(over.body.code, 'MAX_REACTIONS');
  });

  test('AutoMod also applies to edits', async () => {
    const rule = await api('POST', '/api/servers/server-1/automod', {
      name: 'edit-filter', trigger_type: 'keyword',
      trigger_metadata: { keywords: ['edit-banned-word'] }, actions: ['block']
    });
    try {
      const sent = await api('POST', '/api/messages', { channel_id: 'chan-102', content: 'innocent' }, as('user-3'));
      assert.equal(sent.status, 200);
      const edited = await api('PATCH', `/api/messages/${sent.body.id}`, { content: 'now edit-banned-word' }, as('user-3'));
      assert.equal(edited.status, 403);
      assert.equal(edited.body.code, 'AUTOMOD_BLOCKED');
    } finally {
      await api('DELETE', `/api/servers/server-1/automod/${rule.body.id}`);
    }
  });

  test('deleting your last message does not reset slowmode', async () => {
    await api('PATCH', '/api/channels/chan-103', { rate_limit_per_user: 60 });
    try {
      const first = await api('POST', '/api/messages', { channel_id: 'chan-103', content: 'one' }, as('user-3'));
      assert.equal(first.status, 200);
      await api('DELETE', `/api/messages/${first.body.id}`, undefined, as('user-3'));
      const second = await api('POST', '/api/messages', { channel_id: 'chan-103', content: 'two' }, as('user-3'));
      assert.equal(second.status, 429);
      assert.equal(second.body.code, 'SLOWMODE');
    } finally {
      await api('PATCH', '/api/channels/chan-103', { rate_limit_per_user: 0 });
    }
  });

  test('search never returns someone else\'s ephemeral message', async () => {
    const { runQuery, isPostgres } = await import('../db.js');
    const { generateId } = await import('../lib/snowflake.js');
    const id = generateId();
    await runQuery(
      `INSERT INTO messages (id, channel_id, server_id, user_id, content, ephemeral_user_id)
       VALUES (?, 'chan-102', 'server-1', 'user-3', 'ephemeralsecretxyz', 'user-2')`, [id]
    );
    // SQLite searches a separate FTS table; Postgres indexes messages.content.
    if (!isPostgres) {
      await runQuery(
        `INSERT INTO messages_fts (content, message_id, channel_id) VALUES ('ephemeralsecretxyz', ?, 'chan-102')`, [id]
      );
    }
    const mine = await get('/api/search/messages?q=ephemeralsecretxyz');
    assert.ok(!mine.body.some((m) => m.id === id), 'ephemeral reply leaked through search');
    const theirs = await get('/api/search/messages?q=ephemeralsecretxyz', as('user-2'));
    assert.ok(theirs.body.some((m) => m.id === id));
  });
});

describe('voice ICE servers', () => {
  test('requires a session and returns STUN plus coturn REST credentials', async () => {
    assert.equal((await get('/api/voice/ice-servers', { 'x-user-id': '' })).status, 401);
    const res = await fetch(`${BASE}/api/voice/ice-servers`, { headers: { 'x-user-id': 'user-me' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const body = await res.json();
    assert.ok(Array.isArray(body.iceServers) && body.iceServers.length >= 1);
    assert.ok(body.iceServers[0].urls.some((u) => u.startsWith('stun:')));
    assert.equal(body.iceTransportPolicy, 'all');
    const turn = body.iceServers.find((s) => s.urls.includes('turn:turn.test:3478'));
    assert.ok(turn, 'TURN server missing');
    const [expiry, nonce] = turn.username.split(':');
    assert.match(nonce, /^[0-9a-f-]{36}$/, 'TURN username must not carry the user id');
    const ttl = Number(expiry) - Math.floor(Date.now() / 1000);
    assert.ok(ttl > 500 && ttl <= 600, `unexpected ttl ${ttl}`);
    // Recompute with the coturn REST algorithm. The MAC input is the opaque
    // expiry:nonce string just returned, not account data.
    const expected = crypto.createHmac('sha1', 'test-turn-secret').update(String(expiry) + ':' + nonce).digest('base64');
    assert.equal(turn.credential, expected);
  });
});

describe('user privacy', () => {
  test('the user directory requires a session', async () => {
    assert.equal((await get('/api/users', { 'x-user-id': '' })).status, 401);
  });

  test('mutual_servers lists only servers shared with the viewer', async () => {
    const { body } = await get('/api/users/user-me', as('user-4'));
    const ids = body.mutual_servers.map((s) => s.id);
    assert.ok(!ids.includes('server-3'), 'a server the viewer is not in was disclosed');
    assert.ok(ids.includes('server-1'));
  });

  test('invisible is shown as offline to everyone else', async () => {
    await api('PATCH', '/api/users/user-5/presence', { status: 'invisible' }, as('user-5'));
    assert.equal((await get('/api/users/user-5')).body.status, 'offline');
    assert.equal((await get('/api/users/user-5', as('user-5'))).body.status, 'invisible');
    await api('PATCH', '/api/users/user-5/presence', { status: 'online' }, as('user-5'));
  });

  test('profile fields are length-limited', async () => {
    const res = await api('PUT', '/api/users/user-me', { bio: 'b'.repeat(500) });
    assert.equal(res.status, 400);
  });

  test('a user who blocked you cannot be pulled into your group DM', async () => {
    const group = await api('POST', '/api/dms', { recipientIds: ['user-2', 'user-4'] });
    assert.equal(group.status, 200);
    await api('POST', '/api/blocks', { targetId: 'user-me' }, as('user-3'));
    const added = await api('PUT', `/api/dms/${group.body.id}/recipients`, { recipientIds: ['user-3'] });
    assert.equal(added.status, 403);
    await api('DELETE', '/api/blocks/user-me', undefined, as('user-3'));
  });
});

describe('gateway hardening', () => {
  const sockets = [];
  const track = (s) => { sockets.push(s); return s; };
  after(() => { for (const s of sockets) s.close(); });

  test('WebRTC signalling cannot be broadcast to a room or sent anonymously', async () => {
    const listener = track(await connect({ userId: 'user-2' }));
    assert.equal((await emitAck(listener, 'join_channel', 'chan-102')).ok, true);

    const attacker = track(await connect({ userId: 'user-me' }));
    const viaRoom = received(listener, 'webrtc_offer');
    attacker.emit('webrtc_offer', { targetSocketId: 'chan-102', offer: { sdp: 'x' } });
    assert.equal(await viaRoom, null, 'offer was broadcast to a channel room');

    const anon = track(await connect());
    const direct = received(listener, 'webrtc_offer');
    anon.emit('webrtc_offer', { targetSocketId: listener.id, offer: { sdp: 'x' } });
    assert.equal(await direct, null, 'an anonymous socket delivered an offer');
  });

  test('WebRTC signalling is relayed between sockets in the same voice room', async () => {
    const a = track(await connect({ userId: 'user-2' }));
    const b = track(await connect({ userId: 'user-me' }));
    assert.equal((await emitAck(a, 'join_voice', { channelId: 'chan-104' }))?.ok, true);
    // Not in any voice room yet: refused.
    const early = received(a, 'webrtc_offer');
    b.emit('webrtc_offer', { targetSocketId: a.id, offer: { sdp: 'early' } });
    assert.equal(await early, null);

    assert.equal((await emitAck(b, 'join_voice', { channelId: 'chan-104' }))?.ok, true);
    const offer = received(a, 'webrtc_offer', 2000);
    b.emit('webrtc_offer', { targetSocketId: a.id, offer: { sdp: 'hello' } });
    const got = await offer;
    assert.equal(got?.senderSocketId, b.id);
    a.emit('leave_voice', { channelId: 'chan-104' });
    b.emit('leave_voice', { channelId: 'chan-104' });
  });

  test('typing only reaches a channel the sender joined', async () => {
    const listener = track(await connect({ userId: 'user-2' }));
    await emitAck(listener, 'join_channel', 'chan-102');
    const outsider = await register('typist');
    const typist = track(await connect({ token: outsider.token }));
    const typingEvent = received(listener, 'typing');
    typist.emit('typing_start', { channelId: 'chan-102', displayName: 'ghost' });
    assert.equal(await typingEvent, null);
  });

  test('speaking state cannot be spoofed into a voice room you are not in', async () => {
    const listener = track(await connect({ userId: 'user-2' }));
    const joined = await emitAck(listener, 'join_voice', { channelId: 'chan-105' });
    assert.equal(joined?.ok, true, JSON.stringify(joined));
    const spoofer = track(await connect({ userId: 'user-4' }));
    const speaking = received(listener, 'voice_speaking');
    spoofer.emit('voice_state_change', { channelId: 'chan-105', isSpeaking: true });
    assert.equal(await speaking, null);
    listener.emit('leave_voice', { channelId: 'chan-105' });
  });

  test('a kicked member stops receiving the channel', async () => {
    const member = await register('stale');
    await inviteInto('server-1', member.token);
    const socket = track(await connect({ token: member.token }));
    assert.equal((await emitAck(socket, 'join_channel', 'chan-102')).ok, true);

    assert.equal((await api('POST', `/api/servers/server-1/kicks/${member.id}`, {})).status, 200);
    await sleep(400);
    const leak = received(socket, 'new_message');
    await api('POST', '/api/messages', { channel_id: 'chan-102', content: 'after the kick' });
    assert.equal(await leak, null, 'kicked member still received messages');
  });

  test('losing VIEW_CHANNEL evicts the socket and hides the channel update', async () => {
    const member = await register('hidden');
    await inviteInto('server-1', member.token);
    const created = await api('POST', '/api/channels', { server_id: 'server-1', name: unique('secret') });
    const channelId = created.body.id;

    const socket = track(await connect({ token: member.token }));
    assert.equal((await emitAck(socket, 'join_server', 'server-1')).ok, true);
    assert.equal((await emitAck(socket, 'join_channel', channelId)).ok, true);

    const update = received(socket, 'channel_updated');
    const hidden = await api('PUT', `/api/channels/${channelId}/permissions/role/server-1`, {
      allow: '0', deny: PERMISSIONS.VIEW_CHANNEL.toString()
    });
    assert.equal(hidden.status, 200);
    assert.equal(await update, null, 'a hidden channel\'s update reached a member who cannot see it');
    await sleep(400);

    const leak = received(socket, 'new_message');
    await api('POST', '/api/messages', { channel_id: channelId, content: 'now private' });
    assert.equal(await leak, null, 'socket kept receiving a channel it can no longer view');
  });

  test('a socket cannot be re-identified as a second user', async () => {
    const socket = track(await connect({ userId: 'user-4' }));
    const refused = received(socket, 'identify_error', 1500);
    socket.emit('identify', { userId: 'user-2' });
    assert.ok(await refused);
  });
});
