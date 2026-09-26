#!/usr/bin/env node
// ============================================================================
//  Voice moderation: "Mute everyone" / "Unmute everyone" (the teacher's button)
//  in a regular voice channel, mesh mode (no SFU configured).
//
//    POST /api/voice/channels/:channelId/mute-all  { mute: boolean }
//
//  Covers: permission (MUTE_MEMBERS), validation, non-voice channels, who is
//  skipped (the caller, the owner, other moderators), the target being told,
//  the roster, persistence across a rejoin, unmute-all, and the audit log.
//  Runs on SQLite (`npm test`) and PostgreSQL (`npm run test:pg`).
// ============================================================================

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as ioClient } from 'socket.io-client';
import { startServer, stopServer, api, BASE } from './testHarness.mjs';

before(startServer);
after(stopServer);

const as = (userId) => ({ 'x-user-id': userId });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHANNEL = 'chan-104';   // "General Voice" in the seeded server-1

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
const waitFor = (socket, event, predicate = () => true, ms = 3000) => new Promise((resolve) => {
  const timer = setTimeout(() => { socket.off(event, handler); resolve(null); }, ms);
  function handler(payload) {
    if (!predicate(payload)) return;
    clearTimeout(timer); socket.off(event, handler); resolve(payload ?? true);
  }
  socket.on(event, handler);
});
const muteAll = (actor, mute, channelId = CHANNEL) =>
  api('POST', `/api/voice/channels/${channelId}/mute-all`, { mute }, as(actor));

describe('voice: mute everyone (mesh mode)', () => {
  test('mode is mesh here, so the endpoint cannot lean on an SFU', async () => {
    const { body } = await api('GET', '/api/voice/config', undefined, as('user-5'));
    assert.equal(body.mode, 'mesh');
  });

  test('moderator mutes the room: plain members muted; self, owner and co-moderators skipped', async () => {
    // user-4 = Moderator role (MUTE_MEMBERS); user-2 = Admin; user-me = owner;
    // user-5 = plain member.
    const teacher = await connectAs('user-4');
    const student = await connectAs('user-5');
    const coHost = await connectAs('user-2');
    const owner = await connectAs('user-me');
    for (const s of [teacher, student, coHost, owner]) {
      assert.equal((await emitAck(s, 'join_voice', { channelId: CHANNEL }))?.ok, true);
    }

    // A plain member cannot do it.
    assert.equal((await muteAll('user-5', true)).status, 403);
    // Validation.
    assert.equal((await api('POST', `/api/voice/channels/${CHANNEL}/mute-all`, { mute: 'yes' }, as('user-4'))).status, 400);
    assert.equal((await api('POST', `/api/voice/channels/${CHANNEL}/mute-all`, {}, as('user-4'))).status, 400);
    // A text channel is not a voice channel.
    assert.equal((await muteAll('user-4', true, 'chan-102')).status, 400);
    // Not signed in.
    assert.equal((await api('POST', `/api/voice/channels/${CHANNEL}/mute-all`, { mute: true }, as(''))).status, 401);

    const told = waitFor(student, 'voice_server_state', (p) => p.serverMute === true && p.channelId === CHANNEL);
    const roster = waitFor(teacher, 'voice_participants',
      (p) => p.channelId === CHANNEL && p.participants.some((x) => x.userId === 'user-5' && x.isServerMuted));
    const res = await muteAll('user-4', true);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.affected, ['user-5']);
    assert.ok(res.body.skipped.includes('user-4'), 'the caller is not muted');
    assert.ok(res.body.skipped.includes('user-me'), 'the owner is not muted');
    assert.ok(res.body.skipped.includes('user-2'), 'another moderator is not muted');
    assert.ok(await told, 'the muted member was told');
    const snapshot = await roster;
    assert.ok(snapshot, 'roster shows the server mute');
    const byId = Object.fromEntries(snapshot.participants.map((p) => [p.userId, p]));
    assert.equal(byId['user-4'].isServerMuted, false);
    assert.equal(byId['user-2'].isServerMuted, false);
    assert.equal(byId['user-me'].isServerMuted, false);

    // Running it again changes nobody (and logs nothing new).
    const again = await muteAll('user-4', true);
    assert.equal(again.status, 200);
    assert.deepEqual(again.body.affected, []);

    // The mute belongs to the member: leaving and rejoining keeps it.
    student.emit('leave_voice', { channelId: CHANNEL });
    await sleep(150);
    const rejoined = waitFor(teacher, 'voice_participants',
      (p) => p.channelId === CHANNEL && p.participants.some((x) => x.userId === 'user-5'));
    assert.equal((await emitAck(student, 'join_voice', { channelId: CHANNEL }))?.ok, true);
    const afterRejoin = await rejoined;
    assert.equal(afterRejoin.participants.find((x) => x.userId === 'user-5').isServerMuted, true);

    // A server-muted member cannot talk their way out by self-unmuting: the
    // roster keeps the server flag.
    student.emit('voice_state_change', { channelId: CHANNEL, isMuted: false });
    await sleep(150);

    // Unmute everyone lifts it.
    const lifted = waitFor(student, 'voice_server_state', (p) => p.serverMute === false);
    const unmuted = await muteAll('user-4', false);
    assert.equal(unmuted.status, 200);
    assert.deepEqual(unmuted.body.affected, ['user-5']);
    assert.ok(await lifted, 'the member was told they are unmuted');

    // Audit log: one entry per member for each change, with the reason.
    const audit = await api('GET', '/api/servers/server-1/audit-log', undefined, as('user-me'));
    assert.equal(audit.status, 200);
    const entries = audit.body.filter((e) => e.target_id === 'user-5' && e.action_type === 'MEMBER_UPDATE' && e.user_id === 'user-4');
    assert.ok(entries.some((e) => e.reason === 'Mute everyone'), 'mute-all is in the audit log');
    assert.ok(entries.some((e) => e.reason === 'Unmute everyone'), 'unmute-all is in the audit log');
    assert.ok(!audit.body.some((e) => e.reason === 'Mute everyone' && ['user-2', 'user-me', 'user-4'].includes(e.target_id)),
      'skipped members are not logged as muted');

    for (const s of [teacher, student, coHost, owner]) s.emit('leave_voice', { channelId: CHANNEL });
    await sleep(150);
  });

  test('an empty room is a no-op', async () => {
    const made = await api('POST', '/api/channels', { server_id: 'server-1', name: `class-${Date.now()}`, type: 'voice' }, as('user-me'));
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const empty = await muteAll('user-4', true, made.body.id);
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.affected, []);
  });
});
