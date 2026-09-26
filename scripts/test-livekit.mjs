#!/usr/bin/env node
// ============================================================================
//  LiveKit SFU integration: voice mode discovery, token authorization and
//  grants (CONNECT / SPEAK / STREAM / stage audience vs speaker), moderator
//  voice actions (server mute / deafen / move / disconnect) and the webhook's
//  signature check and voice_states sync.
//
//  No LiveKit server is needed: tokens are checked with the SDK's
//  TokenVerifier, and LIVEKIT_HOST points at a small fake RoomService in this
//  process that records the Twirp calls the app makes.
// ============================================================================

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { io as ioClient } from 'socket.io-client';
import { AccessToken, TokenVerifier } from 'livekit-server-sdk';

// The harness derives its port from digits in the file name; this file has
// none, so pick an explicit, distinct one before the harness is loaded.
process.env.TEST_PORT ??= String(Number(process.env.TEST_PORT_BASE || 3900) + 71);

const API_KEY = 'APItestkey';
const API_SECRET = 'test-secret-that-is-at-least-32-characters-long';

// --- fake RoomService ----------------------------------------------------------
const calls = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let json = null;
    try { json = JSON.parse(body || '{}'); } catch { /* not JSON */ }
    calls.push({ path: req.url, method: req.url.split('/').pop(), body: json, auth: req.headers.authorization });
    res.setHeader('Content-Type', 'application/json');
    res.end('{}');
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const FAKE_PORT = fake.address().port;

process.env.LIVEKIT_URL = 'ws://127.0.0.1:7880';
process.env.LIVEKIT_HOST = `http://127.0.0.1:${FAKE_PORT}`;
process.env.LIVEKIT_API_KEY = API_KEY;
process.env.LIVEKIT_API_SECRET = API_SECRET;
// A tiny mesh cap proves the SFU lifts it.
process.env.VOICE_MESH_LIMIT = '2';

const { startServer, stopServer, api, BASE } = await import('./testHarness.mjs');
const { readLivekitConfig, computeGrants } = await import('../services/livekit.js');

before(startServer);
after(async () => { await stopServer(); fake.close(); });

const verifier = new TokenVerifier(API_KEY, API_SECRET);
const as = (userId) => ({ 'x-user-id': userId });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const unique = (p) => `${p}-${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;
const PERM = { CONNECT: 1n << 20n, SPEAK: 1n << 21n, STREAM: 1n << 9n };

async function tokenFor(userId, channelId) {
  const res = await api('POST', '/api/voice/livekit/token', { channelId }, as(userId));
  if (res.status !== 200) return { status: res.status, body: res.body };
  const claims = await verifier.verify(res.body.token);
  return { status: 200, body: res.body, claims, video: claims.video };
}

let sockets = [];
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
  setTimeout(() => resolve(null), 2500);
});
const waitFor = (socket, event, predicate = () => true, ms = 3000) => new Promise((resolve) => {
  const timer = setTimeout(() => { socket.off(event, handler); resolve(null); }, ms);
  function handler(payload) {
    if (!predicate(payload)) return;
    clearTimeout(timer); socket.off(event, handler); resolve(payload ?? true);
  }
  socket.on(event, handler);
});
const callsFor = (method, identity) => calls.filter((c) => c.method === method && (!identity || c.body?.identity === identity));
after(() => { for (const s of sockets) s.close(); sockets = []; });

async function makeChannel(type = 'voice') {
  const made = await api('POST', '/api/channels', { server_id: 'server-1', name: unique(type), type });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  return made.body.id;
}

// ---------------------------------------------------------------------------

describe('configuration', () => {
  test('missing env disables LiveKit (mesh fallback); a short secret or bad URL is refused', () => {
    assert.equal(readLivekitConfig({}).enabled, false);
    assert.equal(readLivekitConfig({}).reason, 'not_configured');
    const short = readLivekitConfig({ LIVEKIT_URL: 'wss://lk.example.com', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: 'short' });
    assert.equal(short.enabled, false);
    assert.equal(short.reason, 'misconfigured');
    assert.ok(!JSON.stringify(short).includes('short"'), 'the secret itself is never echoed');
    const badUrl = readLivekitConfig({ LIVEKIT_URL: 'https://lk.example.com', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: API_SECRET });
    assert.equal(badUrl.enabled, false);
    const ok = readLivekitConfig({ LIVEKIT_URL: 'wss://lk.example.com', LIVEKIT_API_KEY: 'k', LIVEKIT_API_SECRET: API_SECRET });
    assert.equal(ok.enabled, true);
    assert.equal(ok.host, 'https://lk.example.com', 'server API host derives from the client URL');
  });

  test('GET /api/voice/config reports livekit mode, the public URL and ICE, never the secret', async () => {
    assert.equal((await api('GET', '/api/voice/config', undefined, as(''))).status, 401);
    const { status, body } = await api('GET', '/api/voice/config', undefined, as('user-5'));
    assert.equal(status, 200);
    assert.equal(body.mode, 'livekit');
    assert.equal(body.livekit.url, 'ws://127.0.0.1:7880');
    assert.ok(Array.isArray(body.iceServers));
    const text = JSON.stringify(body);
    assert.ok(!text.includes(API_SECRET) && !text.includes(API_KEY), 'no credentials in the client config');
    const health = await api('GET', '/api/voice/health', undefined, as(''));
    assert.equal(health.status, 200);
    assert.deepEqual(health.body, { mode: 'livekit', livekit: 'configured', problems: [] });
  });

  test('stage grants: audience subscribe-only, speakers and moderators publish', () => {
    const channel = { type: 'stage' };
    const all = ((1n << 41n) - 1n).toString();
    const everyone = (PERM.CONNECT | PERM.SPEAK | PERM.STREAM).toString();
    assert.equal(computeGrants({ channel, permissions: everyone, state: { suppress: 1 } }).canPublish, false);
    assert.equal(computeGrants({ channel, permissions: everyone, state: null }).canPublish, false);
    assert.equal(computeGrants({ channel, permissions: everyone, state: { suppress: 0 } }).summary.audio, true);
    assert.equal(computeGrants({ channel, permissions: all, state: null }).summary.stageRole, 'moderator');
  });
});

describe('token endpoint', () => {
  test('requires a user, a channel id, and an existing channel', async () => {
    assert.equal((await api('POST', '/api/voice/livekit/token', { channelId: 'chan-104' }, as(''))).status, 401);
    assert.equal((await api('POST', '/api/voice/livekit/token', {}, as('user-5'))).status, 400);
    assert.equal((await api('POST', '/api/voice/livekit/token', { channelId: 'nope' }, as('user-5'))).status, 404);
  });

  test('a member gets a short-lived token: identity = user, room = channel, speak + stream grants', async () => {
    const t = await tokenFor('user-5', 'chan-104');
    assert.equal(t.status, 200, JSON.stringify(t.body));
    assert.equal(t.claims.sub, 'user-5');
    assert.equal(t.claims.name, 'David G.');
    assert.equal(t.video.room, 'chan-104');
    assert.equal(t.video.roomJoin, true);
    assert.ok(!t.video.roomAdmin && !t.video.roomCreate && !t.video.roomList, 'no admin grants for a client');
    assert.deepEqual([...t.video.canPublishSources].sort(), ['camera', 'microphone', 'screen_share', 'screen_share_audio']);
    assert.equal(t.video.canSubscribe, true);
    assert.equal(t.video.canPublishData, false);
    const lifetime = t.claims.exp - t.claims.nbf;
    assert.ok(lifetime > 0 && lifetime <= 3600, `token lives ${lifetime}s`);
    assert.equal(t.body.url, 'ws://127.0.0.1:7880');
    assert.ok(!JSON.stringify(t.body).includes(API_SECRET));
  });

  test('no token for a channel without CONNECT; a non-member gets none either', async () => {
    const channelId = await makeChannel('voice');
    const denied = await api('PUT', `/api/channels/${channelId}/permissions/role/server-1`, {
      allow: '0', deny: PERM.CONNECT.toString()
    });
    assert.equal(denied.status, 200, JSON.stringify(denied.body));
    const t = await tokenFor('user-5', channelId);
    assert.equal(t.status, 403);
    // An administrator still may.
    assert.equal((await tokenFor('user-2', channelId)).status, 200);
    // A fresh account is in no server at all.
    const reg = await api('POST', '/api/auth/register', {
      username: unique('lk').replace(/-/g, ''), password: 'correct-horse-battery'
    }, as(''));
    assert.equal(reg.status, 201, JSON.stringify(reg.body));
    const outsider = await tokenFor(reg.body.user.id, 'chan-104');
    assert.equal(outsider.status, 403);
  });

  test('a full channel gives no token to newcomers, but still to those already in it', async () => {
    const channelId = await makeChannel('voice');
    assert.equal((await api('PATCH', `/api/channels/${channelId}`, { user_limit: 1 })).status, 200);
    const inside = await connectAs('user-2');
    assert.equal((await emitAck(inside, 'join_voice', { channelId }))?.ok, true);
    const full = await tokenFor('user-5', channelId);
    assert.equal(full.status, 403);
    assert.equal(full.body.code, 'VOICE_FULL');
    assert.equal((await tokenFor('user-2', channelId)).status, 200);
    inside.emit('leave_voice', { channelId });
    await sleep(150);
  });

  test('a text channel is not a voice room', async () => {
    assert.equal((await tokenFor('user-5', 'chan-102')).status, 400);
  });

  test('SPEAK and STREAM denials remove the microphone and the camera/screen', async () => {
    const channelId = await makeChannel('voice');
    await api('PUT', `/api/channels/${channelId}/permissions/role/server-1`, { allow: '0', deny: PERM.SPEAK.toString() });
    let t = await tokenFor('user-5', channelId);
    assert.equal(t.status, 200);
    assert.ok(!t.video.canPublishSources.includes('microphone'));
    assert.ok(t.video.canPublishSources.includes('camera'));
    await api('PUT', `/api/channels/${channelId}/permissions/role/server-1`, { allow: '0', deny: PERM.STREAM.toString() });
    t = await tokenFor('user-5', channelId);
    assert.ok(t.video.canPublishSources.includes('microphone'));
    assert.ok(!t.video.canPublishSources.includes('camera') && !t.video.canPublishSources.includes('screen_share'));
  });

  test('stage: the audience subscribes only; a moderator publishes; promotion is pushed to the SFU', async () => {
    const stageId = await makeChannel('stage');
    const audience = await tokenFor('user-5', stageId);
    assert.equal(audience.status, 200);
    assert.equal(audience.video.canPublish, false);
    assert.deepEqual(audience.video.canPublishSources ?? [], []);
    assert.equal(audience.video.canSubscribe, true);
    assert.equal(audience.body.grants.stageRole, 'audience');

    const mod = await tokenFor('user-2', stageId);
    assert.equal(mod.video.canPublish, true);
    assert.ok(mod.video.canPublishSources.includes('microphone'));

    const listener = await connectAs('user-5');
    const moderator = await connectAs('user-2');
    assert.equal((await emitAck(listener, 'join_voice', { channelId: stageId }))?.ok, true);
    assert.equal((await emitAck(moderator, 'join_voice', { channelId: stageId }))?.ok, true);

    const before = callsFor('UpdateParticipant', 'user-5').length;
    assert.equal((await emitAck(moderator, 'stage_set_speaker', { channelId: stageId, userId: 'user-5', speaker: true }))?.ok, true);
    const update = callsFor('UpdateParticipant', 'user-5').slice(before).at(-1);
    assert.ok(update, 'promotion did not reach the RoomService');
    assert.equal(update.body.room, stageId);
    assert.ok(update.body.permission.canPublishSources.includes('MICROPHONE'), JSON.stringify(update.body));
    assert.ok(update.auth?.startsWith('Bearer '), 'RoomService call is authenticated');

    const speaker = await tokenFor('user-5', stageId);
    assert.ok(speaker.video.canPublishSources.includes('microphone'));
    assert.equal(speaker.body.grants.stageRole, 'speaker');

    // Demotion revokes publishing again.
    assert.equal((await emitAck(moderator, 'stage_set_speaker', { channelId: stageId, userId: 'user-5', speaker: false }))?.ok, true);
    const demote = callsFor('UpdateParticipant', 'user-5').at(-1);
    assert.equal(demote.body.permission.canPublish ?? false, false);
    listener.emit('leave_voice', { channelId: stageId });
    moderator.emit('leave_voice', { channelId: stageId });
    await sleep(200);
  });

  test('the SFU lifts the mesh size cap', async () => {
    // VOICE_MESH_LIMIT is 2 for this server; with LiveKit a 4th joiner is fine.
    const channelId = await makeChannel('voice');
    const users = ['user-me', 'user-2', 'user-3', 'user-5'];
    for (const u of users) {
      const s = await connectAs(u);
      assert.equal((await emitAck(s, 'join_voice', { channelId }))?.ok, true);
    }
    for (const s of sockets) s.emit('leave_voice', { channelId });
    await sleep(200);
  });
});

describe('moderator voice actions', () => {
  test('server mute / deafen need MUTE_MEMBERS / DEAFEN_MEMBERS and are enforced on the SFU', async () => {
    const target = await connectAs('user-5');
    const mod = await connectAs('user-2');
    assert.equal((await emitAck(target, 'join_voice', { channelId: 'chan-104' }))?.ok, true);
    assert.equal((await emitAck(mod, 'join_voice', { channelId: 'chan-104' }))?.ok, true);

    const url = '/api/voice/channels/chan-104/members/user-5';
    // A plain member cannot moderate.
    assert.equal((await api('POST', `/api/voice/channels/chan-104/members/user-2/mute`, { mute: true }, as('user-5'))).status, 403);
    // Validation.
    assert.equal((await api('POST', `${url}/mute`, { mute: 'yes' }, as('user-2'))).status, 400);
    // Not in that channel.
    assert.equal((await api('POST', '/api/voice/channels/chan-105/members/user-5/mute', { mute: true }, as('user-2'))).status, 404);
    // Nobody moderates the owner.
    const owner = await connectAs('user-me');
    assert.equal((await emitAck(owner, 'join_voice', { channelId: 'chan-104' }))?.ok, true);
    assert.equal((await api('POST', '/api/voice/channels/chan-104/members/user-me/mute', { mute: true }, as('user-2'))).status, 403);
    owner.emit('leave_voice', { channelId: 'chan-104' });

    const told = waitFor(target, 'voice_server_state', (p) => p.serverMute === true);
    const roster = waitFor(mod, 'voice_participants', (p) => p.participants.some((x) => x.userId === 'user-5' && x.isServerMuted));
    const before = callsFor('UpdateParticipant', 'user-5').length;
    const muted = await api('POST', `${url}/mute`, { mute: true }, as('user-2'));
    assert.equal(muted.status, 200, JSON.stringify(muted.body));
    assert.ok(await told, 'target was not told about the server mute');
    assert.ok(await roster, 'roster does not show the server mute');
    const call = callsFor('UpdateParticipant', 'user-5').slice(before).at(-1);
    assert.ok(call, 'mute did not reach the RoomService');
    assert.ok(!call.body.permission.canPublishSources.includes('MICROPHONE'));
    assert.ok(call.body.permission.canPublishSources.includes('CAMERA'));
    // A fresh token carries it too, and so does a rejoin.
    assert.ok(!(await tokenFor('user-5', 'chan-104')).video.canPublishSources.includes('microphone'));
    target.emit('leave_voice', { channelId: 'chan-104' });
    await sleep(150);
    assert.equal((await emitAck(target, 'join_voice', { channelId: 'chan-104' }))?.ok, true);
    assert.equal((await tokenFor('user-5', 'chan-104')).body.grants.serverMute, true, 'server mute survives a rejoin');
    assert.equal((await api('POST', `${url}/mute`, { mute: false }, as('user-2'))).status, 200);
    assert.ok((await tokenFor('user-5', 'chan-104')).video.canPublishSources.includes('microphone'));

    const deafened = await api('POST', `${url}/deafen`, { deaf: true }, as('user-2'));
    assert.equal(deafened.status, 200);
    const deafCall = callsFor('UpdateParticipant', 'user-5').at(-1);
    assert.equal(deafCall.body.permission.canSubscribe ?? false, false);
    assert.equal((await tokenFor('user-5', 'chan-104')).video.canSubscribe, false);
    assert.equal((await api('POST', `${url}/deafen`, { deaf: false }, as('user-2'))).status, 200);
    assert.equal((await tokenFor('user-5', 'chan-104')).video.canSubscribe, true);

    const audit = await api('GET', '/api/servers/server-1/audit-log', undefined, as('user-me'));
    assert.equal(audit.status, 200);
    assert.ok(audit.body.some((e) => e.action_type === 'MEMBER_UPDATE' && e.target_id === 'user-5'),
      'audit log records the voice moderation');
  });

  test('move needs MOVE_MEMBERS, a voice destination in the same server; the SFU session is dropped', async () => {
    const t5 = await connectAs('user-5');
    assert.equal((await emitAck(t5, 'join_voice', { channelId: 'chan-104' }))?.ok, true);
    const url = '/api/voice/channels/chan-104/members/user-5';
    assert.equal((await api('POST', `${url}/move`, { channelId: 'chan-105' }, as('user-3'))).status, 403);
    assert.equal((await api('POST', `${url}/move`, { channelId: 'chan-102' }, as('user-2'))).status, 400);
    assert.equal((await api('POST', `${url}/move`, {}, as('user-2'))).status, 400);

    const moved = waitFor(t5, 'voice_moved', (p) => p.to === 'chan-105');
    const before = callsFor('RemoveParticipant', 'user-5').length;
    const res = await api('POST', `${url}/move`, { channelId: 'chan-105' }, as('user-2'));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await moved)?.from, 'chan-104');
    const removed = callsFor('RemoveParticipant', 'user-5').slice(before);
    assert.ok(removed.some((c) => c.body.room === 'chan-104'), 'old SFU session was not removed');

    // Disconnect: MOVE_MEMBERS, voice_disconnected to the target, token revoked on the SFU.
    assert.equal((await api('DELETE', '/api/voice/channels/chan-105/members/user-5', undefined, as('user-3'))).status, 403);
    const gone = waitFor(t5, 'voice_disconnected');
    const dropBefore = callsFor('RemoveParticipant', 'user-5').length;
    const kicked = await api('DELETE', '/api/voice/channels/chan-105/members/user-5', undefined, as('user-2'));
    assert.equal(kicked.status, 200, JSON.stringify(kicked.body));
    assert.ok(await gone, 'target was not told it was disconnected');
    const drop = callsFor('RemoveParticipant', 'user-5').slice(dropBefore).at(-1);
    assert.equal(drop?.body.room, 'chan-105');
    assert.ok(drop?.body.revokeTokenTs, 'disconnect revokes the current token');
    assert.equal((await api('DELETE', '/api/voice/channels/chan-105/members/user-5', undefined, as('user-2'))).status, 404);
  });
});

describe('webhook', () => {
  async function signed(body, { secret = API_SECRET, key = API_KEY, hashOf = body } = {}) {
    const at = new AccessToken(key, secret, { ttl: 60 });
    at.sha256 = crypto.createHash('sha256').update(hashOf).digest('base64');
    return at.toJwt();
  }
  async function deliver(body, authorization, contentType = 'application/webhook+json') {
    const res = await fetch(`${BASE}/api/voice/livekit/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': contentType, ...(authorization ? { Authorization: authorization } : {}) },
      body
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }
  const event = (name, identity, room, id = crypto.randomUUID()) => JSON.stringify({
    event: name, id, createdAt: String(Math.floor(Date.now() / 1000)),
    room: { name: room, sid: 'RM_x' }, participant: { identity, sid: 'PA_x' }
  });

  test('rejects missing, forged and body-mismatched signatures', async () => {
    const body = event('participant_joined', 'user-3', 'chan-105');
    assert.equal((await deliver(body)).status, 401);
    assert.equal((await deliver(body, await signed(body, { secret: 'x'.repeat(40) }))).status, 401);
    assert.equal((await deliver(body, await signed(body, { key: 'someone-else' }))).status, 401);
    assert.equal((await deliver(body, await signed(body, { hashOf: `${body} ` }))).status, 401, 'tampered body');
    assert.equal((await deliver(body, 'not-a-jwt')).status, 401);
    // Parsed by express.json first → the raw bytes are gone → cannot verify.
    assert.equal((await deliver(body, await signed(body), 'application/json')).status, 401);
  });

  test('participant_joined / participant_left sync voice_states; re-deliveries are ignored', async () => {
    const watcher = await connectAs('user-me');
    assert.equal((await emitAck(watcher, 'join_voice', { channelId: 'chan-105' }))?.ok, true);

    const id = crypto.randomUUID();
    const joined = event('participant_joined', 'user-3', 'chan-105', id);
    const shown = waitFor(watcher, 'voice_participants', (p) => p.participants.some((x) => x.userId === 'user-3'));
    const res = await deliver(joined, await signed(joined));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(await shown, 'a participant who joined on the SFU did not appear in the roster');
    // Same event again: acknowledged, no effect.
    assert.equal((await deliver(joined, await signed(joined))).status, 200);

    const left = event('participant_left', 'user-3', 'chan-105');
    const hidden = waitFor(watcher, 'voice_participants', (p) => !p.participants.some((x) => x.userId === 'user-3'));
    assert.equal((await deliver(left, await signed(left))).status, 200);
    assert.ok(await hidden, 'a participant who left the SFU stayed in the roster');

    // Someone without CONNECT who somehow reached the room is thrown out.
    const channelId = await makeChannel('voice');
    await api('PUT', `/api/channels/${channelId}/permissions/role/server-1`, { allow: '0', deny: PERM.CONNECT.toString() });
    const before = callsFor('RemoveParticipant', 'user-5').length;
    const sneaky = event('participant_joined', 'user-5', channelId);
    assert.equal((await deliver(sneaky, await signed(sneaky))).status, 200);
    assert.ok(callsFor('RemoveParticipant', 'user-5').length > before, 'unauthorised participant was not removed');
    watcher.emit('leave_voice', { channelId: 'chan-105' });
  });
});
