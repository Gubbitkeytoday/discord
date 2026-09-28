#!/usr/bin/env node
// ============================================================================
//  Voice moderation: "Mute everyone" with the LiveKit SFU configured.
//
//  Same endpoint as test-voice-46.mjs, but here the SFU must enforce it: each
//  muted member's publish permission loses MICROPHONE through RoomService
//  UpdateParticipant, skipped members are left alone, and "Unmute everyone"
//  gives it back. LIVEKIT_HOST points at a tiny fake RoomService in this
//  process (no LiveKit server needed), as in test-livekit.mjs.
// ============================================================================

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { io as ioClient } from 'socket.io-client';

const calls = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let json = null;
    try { json = JSON.parse(body || '{}'); } catch { /* not JSON */ }
    calls.push({ method: req.url.split('/').pop(), body: json });
    res.setHeader('Content-Type', 'application/json');
    res.end('{}');
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));

process.env.LIVEKIT_URL = 'ws://127.0.0.1:7880';
process.env.LIVEKIT_HOST = `http://127.0.0.1:${fake.address().port}`;
process.env.LIVEKIT_API_KEY = 'APItestkey';
process.env.LIVEKIT_API_SECRET = 'test-secret-that-is-at-least-32-characters-long';

const { startServer, stopServer, api, BASE } = await import('./testHarness.mjs');

before(startServer);
after(async () => { await stopServer(); fake.close(); });

const as = (userId) => ({ 'x-user-id': userId });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHANNEL = 'chan-104';

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
  setTimeout(() => resolve(null), 2500);
});
const updatesFor = (identity) => calls.filter((c) => c.method === 'UpdateParticipant' && c.body?.identity === identity);

describe('voice: mute everyone (LiveKit mode)', () => {
  test('the SFU revokes the microphone of each muted member only, and gives it back', async () => {
    const { body } = await api('GET', '/api/voice/config', undefined, as('user-5'));
    assert.equal(body.mode, 'livekit');

    const teacher = await connectAs('user-4');
    const student = await connectAs('user-5');
    const coHost = await connectAs('user-2');
    for (const s of [teacher, student, coHost]) {
      assert.equal((await emitAck(s, 'join_voice', { channelId: CHANNEL }))?.ok, true);
    }

    const before5 = updatesFor('user-5').length;
    const before2 = updatesFor('user-2').length;
    const res = await api('POST', `/api/voice/channels/${CHANNEL}/mute-all`, { mute: true }, as('user-4'));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.affected, ['user-5']);

    const muted = updatesFor('user-5').slice(before5).at(-1);
    assert.ok(muted, 'mute-all reached the RoomService');
    assert.equal(muted.body.room, CHANNEL);
    assert.ok(!muted.body.permission.canPublishSources.includes('MICROPHONE'), 'microphone revoked');
    assert.ok(muted.body.permission.canPublishSources.includes('CAMERA'), 'camera left alone');
    assert.equal(updatesFor('user-2').length, before2, 'a skipped moderator is not touched on the SFU');

    // A fresh token for the muted member carries it too.
    const token = await api('POST', '/api/voice/livekit/token', { channelId: CHANNEL }, as('user-5'));
    assert.equal(token.status, 200);
    assert.equal(token.body.grants.serverMute, true);

    const unmuted = await api('POST', `/api/voice/channels/${CHANNEL}/mute-all`, { mute: false }, as('user-4'));
    assert.equal(unmuted.status, 200);
    assert.deepEqual(unmuted.body.affected, ['user-5']);
    const restored = updatesFor('user-5').at(-1);
    assert.ok(restored.body.permission.canPublishSources.includes('MICROPHONE'), 'microphone restored');

    for (const s of [teacher, student, coHost]) s.emit('leave_voice', { channelId: CHANNEL });
    await sleep(150);
  });
});
