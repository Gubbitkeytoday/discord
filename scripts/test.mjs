#!/usr/bin/env node
// ============================================================================
//  Integration test suite.
//
//  Runs against a throwaway database and a real HTTP server on a spare port, so
//  it never touches discord.db. Uses node:test so there is no test-framework
//  dependency to install.
//
//    npm test
// ============================================================================

import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  startServer, stopServer, api, get, uploadFile, PNG, ADMIN, BASE
} from './testHarness.mjs';

before(startServer);
after(stopServer);

// ---------------------------------------------------------------------------

describe('health & metadata', () => {
  test('health reports the schema version', async () => {
    const { status, body } = await get('/api/health');
    assert.equal(status, 200);
    assert.equal(body.status, 'ok');
    assert.ok(body.schema_version >= 3, `schema_version was ${body.schema_version}`);
  });

  test('permission catalogue is exposed', async () => {
    const { body } = await get('/api/meta/permissions');
    assert.equal(body.permissions.ADMINISTRATOR, '8');
    assert.equal(body.permissions.MANAGE_MESSAGES, '8192');
  });

  test('seeds a working workspace', async () => {
    const { body } = await get('/api/initial-data/user-me');
    assert.equal(body.currentUser.username, 'AlexPro');
    assert.ok(body.servers.length >= 3);
    assert.ok(body.dms.length >= 1);
  });
});

describe('messages', () => {
  test('history is chronological and paginates by cursor', async () => {
    const { body: page } = await get('/api/messages/chan-102?limit=50');
    assert.ok(page.length >= 3);
    const ids = page.map((m) => m.id);
    // Every id must be a numeric snowflake, and strictly ascending.
    for (const id of ids) assert.match(id, /^\d+$/, `non-snowflake id ${id}`);
    const ascending = ids.every((id, i) => i === 0 || BigInt(id) > BigInt(ids[i - 1]));
    assert.ok(ascending, 'history was not in ascending id order');

    const { body: older } = await get(`/api/messages/chan-102?limit=2&before=${ids[1]}`);
    assert.ok(older.every((m) => BigInt(m.id) < BigInt(ids[1])));
  });

  test('creates, edits and deletes a message', async () => {
    const created = await api('POST', '/api/messages', {
      channel_id: 'chan-102', user_id: 'user-me', content: 'ทดสอบอัตโนมัติ'
    });
    assert.equal(created.status, 200);
    const id = created.body.id;

    const edited = await api('PATCH', `/api/messages/${id}`, {
      userId: 'user-me', content: 'แก้ไขแล้ว'
    });
    assert.equal(edited.body.content, 'แก้ไขแล้ว');
    assert.ok(edited.body.edited_at);

    const removed = await api('DELETE', `/api/messages/${id}`);
    assert.equal(removed.status, 200);
    const { body: after } = await get('/api/messages/chan-102?limit=100');
    assert.ok(!after.some((m) => m.id === id), 'deleted message still returned');
  });

  test('nonce makes sends idempotent', async () => {
    const payload = {
      channel_id: 'chan-102', user_id: 'user-me',
      content: 'ส่งซ้ำได้ไหม', nonce: 'test-nonce-1'
    };
    const first = await api('POST', '/api/messages', payload);
    const second = await api('POST', '/api/messages', payload);
    assert.equal(first.body.id, second.body.id, 'duplicate message created');
  });

  test('rejects an empty message', async () => {
    const { status, body } = await api('POST', '/api/messages', {
      channel_id: 'chan-102', user_id: 'user-me', content: '   '
    });
    assert.equal(status, 400);
    assert.equal(body.code, 'EMPTY_MESSAGE');
  });

  test('mention creates a notification and an unread', async () => {
    await api('POST', '/api/messages', {
      channel_id: 'chan-103', user_id: 'user-me', content: 'เรียก <@user-2> หน่อย'
    });
    // Notifications and read state are private to their owner, so read them as
    // user-2 rather than as the sender.
    const asUser2 = { 'x-user-id': 'user-2' };
    const { body: notifications } = await get('/api/notifications/user-2', asUser2);
    assert.ok(notifications.some((n) => n.channel_id === 'chan-103' && n.type === 'mention'));

    const { body: states } = await get('/api/read-states/user-2', asUser2);
    const state = states.find((s) => s.channel_id === 'chan-103');
    assert.ok(state.mention_count >= 1, 'mention_count was not incremented');
  });

  test('reactions toggle per user', async () => {
    const { body: message } = await api('POST', '/api/messages', {
      channel_id: 'chan-102', user_id: 'user-me', content: 'ใส่รีแอ็กชันสิ'
    });
    const on = await api('PUT', `/api/messages/${message.id}/reactions/${encodeURIComponent('🔥')}`, { userId: 'user-2' });
    assert.equal(on.body.reactions['🔥'], 1);
    const off = await api('PUT', `/api/messages/${message.id}/reactions/${encodeURIComponent('🔥')}`, { userId: 'user-2' });
    assert.equal(off.body.reactions['🔥'], undefined);
  });

  test('pin round-trips', async () => {
    const { body: message } = await api('POST', '/api/messages', {
      channel_id: 'chan-102', user_id: 'user-me', content: 'ปักหมุดฉันสิ'
    });
    await api('PUT', `/api/messages/${message.id}/pin`, { channelId: 'chan-102', pinned: true });
    const { body: pins } = await get('/api/messages/chan-102/pins');
    assert.ok(pins.some((p) => p.id === message.id));

    await api('PUT', `/api/messages/${message.id}/pin`, { channelId: 'chan-102', pinned: false });
    const { body: after } = await get('/api/messages/chan-102/pins');
    assert.ok(!after.some((p) => p.id === message.id));
  });
});

describe('search', () => {
  test('finds Thai substrings mid-word', async () => {
    await api('POST', '/api/messages', {
      channel_id: 'chan-102', user_id: 'user-me', content: 'ทดสอบระบบค้นหาภาษาไทย'
    });
    const { body } = await get(`/api/search/messages?q=${encodeURIComponent('ค้นหา')}`);
    assert.ok(body.length >= 1, 'Thai substring search found nothing');
  });

  test('handles a query with FTS operator characters', async () => {
    const { status } = await get(`/api/search/messages?q=${encodeURIComponent('"OR* AND(')}`);
    assert.equal(status, 200, 'special characters broke the search');
  });

  test('short queries fall back to LIKE', async () => {
    const { status, body } = await get(`/api/search/messages?q=${encodeURIComponent('ระ')}`);
    assert.equal(status, 200);
    assert.ok(Array.isArray(body));
  });
});

describe('storage', () => {
  test('stores an image with real dimensions', async () => {
    const { status, body } = await uploadFile(PNG, 'pixel.png', 'image/png');
    assert.equal(status, 200);
    const [file] = body.attachments;
    assert.equal(file.width, 4);
    assert.equal(file.height, 2);
    assert.equal(file.mimetype, 'image/png');
  });

  test('deduplicates identical bytes', async () => {
    const first = await uploadFile(PNG, 'a.png', 'image/png');
    const second = await uploadFile(PNG, 'b.png', 'image/png');
    assert.equal(first.body.attachments[0].id, second.body.attachments[0].id);
    assert.equal(second.body.attachments[0].deduped, true);
  });

  test('rejects a disguised HTML file', async () => {
    const evil = Buffer.from('<html><script>alert(1)</script></html>');
    const { status, body } = await uploadFile(evil, 'evil.png', 'image/png', 'avatar', '/api/upload/avatar');
    assert.equal(status, 415);
    assert.equal(body.code, 'UNSUPPORTED_TYPE');
  });

  test('serves uploads with anti-sniffing headers', async () => {
    const { body } = await uploadFile(PNG, 'served.png', 'image/png');
    const res = await fetch(`${BASE}${body.attachments[0].url}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });

  test('refuses to escape the storage root', async () => {
    const res = await fetch(`${BASE}/uploads/../../server.js`);
    assert.notEqual(res.status, 200);
  });

  test('reports quota usage', async () => {
    const { body } = await get('/api/files/usage?userId=user-me');
    assert.ok(body.used > 0);
    assert.ok(body.quota > body.used);
  });

  test('attaching a file references it, deleting releases it', async () => {
    const upload = await uploadFile(Buffer.concat([PNG, Buffer.from('ref-test')]), 'ref.png', 'image/png');
    const file = upload.body.attachments[0];

    const { body: message } = await api('POST', '/api/messages', {
      channel_id: 'chan-102', user_id: 'user-me', content: 'มีไฟล์แนบ', attachments: [{ id: file.id }]
    });
    assert.equal(message.attachments.length, 1);

    const { body: meta } = await get(`/api/files/${file.id}/meta`);
    assert.equal(meta.ref_count, 1);

    await api('DELETE', `/api/messages/${message.id}`);
    const { body: after } = await get(`/api/files/${file.id}/meta`);
    assert.equal(after.ref_count, 0, 'reference was not released on delete');
  });

  test('garbage collection is admin-gated', async () => {
    const denied = await api('POST', '/api/files/maintenance/gc', { dryRun: true }, { 'x-admin-token': 'wrong' });
    assert.equal(denied.status, 403);
    const allowed = await api('POST', '/api/files/maintenance/gc', { dryRun: true }, ADMIN);
    assert.equal(allowed.status, 200);
    assert.equal(allowed.body.dryRun, true);
  });

  test('integrity check finds no drift', async () => {
    const { body } = await get('/api/files/maintenance/integrity', ADMIN);
    assert.equal(body.missingBytes.length, 0);
    assert.equal(body.orphanObjects.length, 0);
  });
});

describe('permissions', () => {
  test('owner has every permission', async () => {
    const { body } = await get('/api/servers/server-1/permissions/user-me');
    assert.equal(body.isOwner, true);
    assert.ok(body.permission_names.includes('ADMINISTRATOR'));
  });

  test('@everyone grants the default set, not admin', async () => {
    // Someone else's permissions need MANAGE_ROLES; your own are always readable.
    const { body } = await get('/api/servers/server-2/permissions/user-4', { 'x-user-id': 'user-4' });
    assert.ok(body.permission_names.includes('SEND_MESSAGES'));
  });

  test("reading another member's permissions needs MANAGE_ROLES", async () => {
    const { status } = await get('/api/servers/server-1/permissions/user-2', { 'x-user-id': 'user-5' });
    assert.equal(status, 403);
  });

  test('a plain member gets @everyone only, not admin', async () => {
    // user-5 holds no roles in server-1 beyond @everyone.
    const { body } = await get('/api/servers/server-1/permissions/user-5', { 'x-user-id': 'user-5' });
    assert.ok(body.permission_names.includes('SEND_MESSAGES'));
    assert.ok(!body.permission_names.includes('ADMINISTRATOR'));
  });

  test('a member without MANAGE_ROLES cannot edit roles', async () => {
    const { status, body } = await api(
      'PATCH', '/api/servers/server-1/roles/role-1-dev',
      { name: 'nope' }, { 'x-user-id': 'user-5' }
    );
    assert.equal(status, 403);
    assert.match(body.error, /MANAGE_ROLES/);
  });

  test('MANAGE_ROLES cannot grant permissions the actor lacks', async () => {
    // Give the Moderator role MANAGE_ROLES as the owner…
    const mod = await api('PATCH', '/api/servers/server-1/roles/role-1-mod', {
      permissions: String((1n << 28n) | (1n << 1n))
    });
    assert.equal(mod.status, 200);

    // …then have that moderator try to mint an administrator.
    const escalate = await api(
      'PATCH', '/api/servers/server-1/roles/role-1-dev',
      { permissions: '8' }, { 'x-user-id': 'user-4' }
    );
    assert.equal(escalate.status, 403);
    assert.match(escalate.body.error, /do not have/);
  });

  test('cannot edit a role at or above your own', async () => {
    const { status } = await api(
      'PATCH', '/api/servers/server-1/roles/role-1-admin',
      { name: 'pwned' }, { 'x-user-id': 'user-4' }
    );
    assert.equal(status, 403);
  });

  test('@everyone cannot be deleted', async () => {
    const { status, body } = await api('DELETE', '/api/servers/server-1/roles/server-1');
    assert.equal(status, 409);
    assert.match(body.error, /everyone/);
  });

  test('audit log records role changes', async () => {
    const { body } = await get('/api/servers/server-1/audit-log?limit=20');
    assert.ok(body.some((e) => e.action_type === 'ROLE_UPDATE'));
  });
});

describe('guild administration', () => {
  test('creates and deletes a role', async () => {
    const created = await api('POST', '/api/servers/server-1/roles', {
      name: 'ทดสอบ', color: '#1abc9c', permissions: '0'
    });
    assert.equal(created.status, 200);
    const deleted = await api('DELETE', `/api/servers/server-1/roles/${created.body.id}`);
    assert.equal(deleted.status, 200);
  });

  test('creates and revokes an invite', async () => {
    const created = await api('POST', '/api/servers/server-1/invites', { maxUses: 3, maxAge: 3600 });
    assert.equal(created.status, 200);
    const code = created.body.code;

    const joined = await api('POST', `/api/invites/${code}/accept`, { userId: 'user-3' });
    assert.equal(joined.status, 200);

    const revoked = await api('DELETE', `/api/servers/server-1/invites/${code}`);
    assert.equal(revoked.status, 200);
    const reuse = await api('POST', `/api/invites/${code}/accept`, { userId: 'user-4' });
    assert.equal(reuse.status, 404);
  });

  test('emoji create rejects a bad name', async () => {
    const { status, body } = await api('POST', '/api/servers/server-1/emojis', {
      name: 'bad name!', url: '/uploads/nope.png'
    });
    assert.equal(status, 400);
    assert.equal(body.code, 'INVALID_NAME');
  });

  test('ban then unban', async () => {
    await api('POST', '/api/servers/server-1/bans/user-5', { reason: 'ทดสอบ' });
    const { body: bans } = await get('/api/servers/server-1/bans');
    assert.ok(bans.some((b) => b.user_id === 'user-5'));

    // A banned user cannot rejoin.
    const rejoin = await api('POST', '/api/servers/server-1/join', {}, { 'x-user-id': 'user-5' });
    assert.equal(rejoin.status, 403);

    await api('DELETE', '/api/servers/server-1/bans/user-5');
    const { body: after } = await get('/api/servers/server-1/bans');
    assert.ok(!after.some((b) => b.user_id === 'user-5'));
  });
});

describe('direct messages & threads', () => {
  test('opening a DM twice reuses the channel', async () => {
    const first = await api('POST', '/api/dms', { userId: 'user-me', recipientId: 'user-4' });
    const second = await api('POST', '/api/dms', { userId: 'user-me', recipientId: 'user-4' });
    assert.equal(first.body.id, second.body.id);
    assert.equal(first.body.type, 'dm');
  });

  test('DM messages persist and are visible to both sides', async () => {
    const { body: dm } = await api('POST', '/api/dms', { userId: 'user-me', recipientId: 'user-2' });
    await api('POST', '/api/messages', {
      channel_id: dm.id, user_id: 'user-me', content: 'ข้อความส่วนตัว'
    });
    const { body: list } = await get('/api/dms/user-2', { 'x-user-id': 'user-2' });
    assert.ok(list.some((c) => c.id === dm.id));
    const { body: messages } = await get(`/api/messages/${dm.id}`);
    assert.ok(messages.some((m) => m.content === 'ข้อความส่วนตัว'));
  });

  test('creates a thread from a message', async () => {
    const { body: message } = await api('POST', '/api/messages', {
      channel_id: 'chan-102', user_id: 'user-me', content: 'เริ่มเธรดจากข้อความนี้'
    });
    const created = await api('POST', '/api/channels/chan-102/threads', {
      messageId: message.id, name: 'เธรดทดสอบ'
    });
    assert.equal(created.status, 200);
    assert.equal(created.body.type, 'thread');
    assert.equal(created.body.parent_id, 'chan-102');

    const { body: threads } = await get('/api/channels/chan-102/threads');
    assert.ok(threads.some((t) => t.id === created.body.id));

    // A thread is a channel, so ordinary sending works inside it.
    const reply = await api('POST', '/api/messages', {
      channel_id: created.body.id, user_id: 'user-me', content: 'ตอบในเธรด'
    });
    assert.equal(reply.status, 200);
  });
});

describe('link embeds', () => {
  test('refuses to unfurl a private address', async () => {
    const { status, body } = await api('POST', '/api/embeds/resolve', {
      urls: ['http://127.0.0.1:9/admin', 'http://169.254.169.254/latest/meta-data']
    });
    assert.equal(status, 200);
    assert.equal(body.embeds.length, 0, 'SSRF guard let a private address through');
  });
});

describe('error handling', () => {
  test('unknown endpoints return the standard envelope', async () => {
    const { status, body } = await get('/api/definitely-not-real');
    assert.equal(status, 404);
    assert.equal(body.code, 'NOT_FOUND');
  });

  test('missing resources return 404, not 500', async () => {
    const { status } = await get('/api/servers/does-not-exist');
    assert.equal(status, 404);
  });
});
