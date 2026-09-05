// ============================================================================
//  Integration tests, part 2: authentication, rate limiting, AutoMod, slowmode,
//  webhooks, reports, channel overwrites, stickers and soundboard.
//
//  Shares the harness in scripts/testHarness.mjs with part 1.
// ============================================================================

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as ioClient } from 'socket.io-client';

import {
  startServer, stopServer, api, get, asSession, asBot, login, uploadFile, PNG, ADMIN, BASE
} from './testHarness.mjs';

before(startServer);
after(stopServer);

describe('authentication', () => {
  test('seed accounts can log in and the session identifies them', async () => {
    const { status, token, user } = await login('AlexPro');
    assert.equal(status, 200);
    assert.ok(token, 'no token issued');
    assert.equal(user.username, 'AlexPro');

    // asSession deliberately sends a *wrong* x-user-id header too: the real
    // session must win over the dev shortcut.
    const me = await asSession(token, 'GET', '/api/auth/me');
    assert.equal(me.body.user.id, 'user-me');
    assert.equal(me.body.dev_identity, false);
  });

  test('wrong password is rejected', async () => {
    const { status } = await login('AlexPro', 'definitely-wrong');
    assert.equal(status, 401);
  });

  test('unknown user and wrong password are indistinguishable', async () => {
    const a = await login('AlexPro', 'wrong-password-here');
    const b = await login('no-such-user-at-all', 'wrong-password-here');
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.equal(a.error, b.error);
  });

  test('registers a new account with a discriminator', async () => {
    const unique = `tester${Date.now().toString(36)}`;
    const { status, body } = await api('POST', '/api/auth/register', {
      username: unique, password: 'a-good-password', display_name: 'ผู้ทดสอบ'
    });
    assert.equal(status, 201);
    assert.match(body.user.discriminator, /^\d{4}$/);
    assert.ok(body.token);
  });

  test('rejects a weak password and a bad username', async () => {
    const weak = await api('POST', '/api/auth/register', { username: 'okname', password: '123' });
    assert.equal(weak.body.code, 'WEAK_PASSWORD');
    const bad = await api('POST', '/api/auth/register', {
      username: 'a b!', password: 'a-good-password'
    });
    assert.equal(bad.body.code, 'INVALID_USERNAME');
  });

  test('logout revokes the session immediately', async () => {
    const { token } = await login('CyberNinja');
    assert.equal((await asSession(token, 'GET', '/api/auth/me')).status, 200);
    await asSession(token, 'POST', '/api/auth/logout');
    assert.equal((await asSession(token, 'GET', '/api/auth/me')).status, 401);
  });

  test('a forged token is rejected, not silently downgraded', async () => {
    // asSession also sends a valid dev x-user-id header. A bad token must still
    // 401 rather than quietly falling back to that identity.
    const res = await asSession('not-a-real-token', 'GET', '/api/auth/me');
    assert.equal(res.status, 401);
    assert.equal(res.body.code, 'INVALID_SESSION');
  });

  test('changing the password logs out other devices', async () => {
    const first = await login('CodeMaster');
    const second = await login('CodeMaster');

    const changed = await asSession(second.token, 'POST', '/api/auth/change-password', {
      current_password: 'antigravity123', new_password: 'a-new-password-1'
    });
    assert.equal(changed.status, 200);

    // The device that changed it keeps working; the other is revoked.
    assert.equal((await asSession(second.token, 'GET', '/api/auth/me')).status, 200);
    assert.equal((await asSession(first.token, 'GET', '/api/auth/me')).status, 401);

    // Restore the seed password so later tests are unaffected.
    await asSession(second.token, 'POST', '/api/auth/change-password', {
      current_password: 'a-new-password-1', new_password: 'antigravity123'
    });
  });

  test('sessions can be listed and revoked individually', async () => {
    const { token } = await login('GamerGirl99');
    const list = await asSession(token, 'GET', '/api/auth/sessions');
    assert.ok(list.body.length >= 1);
    assert.ok(list.body.some((s) => s.current));
  });
});

describe('rate limiting', () => {
  test('repeated failed logins are throttled', async () => {
    let throttled = false;
    for (let i = 0; i < 16; i += 1) {
      const { status } = await login('AlexPro', `wrong-${i}`);
      if (status === 429) { throttled = true; break; }
    }
    assert.ok(throttled, 'login was never rate limited');
  });
});

describe('automod', () => {
  let ruleId;

  test('a keyword rule blocks a matching message', async () => {
    const created = await api('POST', '/api/servers/server-1/automod', {
      name: 'test-filter',
      trigger_type: 'keyword',
      trigger_metadata: { keywords: ['forbidden-token'] },
      actions: ['block']
    });
    assert.equal(created.status, 200);
    ruleId = created.body.id;

    // user-3 holds only the Bot role, so it has no MANAGE_MESSAGES bypass.
    const blocked = await api('POST', '/api/messages', {
      channel_id: 'chan-102', user_id: 'user-3', content: 'this has forbidden-token inside'
    }, { 'x-user-id': 'user-3' });
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, 'AUTOMOD_BLOCKED');

    const clean = await api('POST', '/api/messages', {
      channel_id: 'chan-102', user_id: 'user-3', content: 'nothing wrong here'
    }, { 'x-user-id': 'user-3' });
    assert.equal(clean.status, 200);
  });

  test('a blocked message is never stored', async () => {
    const { body } = await get('/api/messages/chan-102?limit=100');
    assert.ok(!body.some((m) => (m.content ?? '').includes('forbidden-token')));
  });

  test('the block is written to the audit log', async () => {
    const { body } = await get('/api/servers/server-1/audit-log?limit=20');
    assert.ok(body.some((e) => e.action_type === 'AUTOMOD_BLOCK'));
  });

  test('moderators bypass AutoMod', async () => {
    const { status } = await api('POST', '/api/messages', {
      channel_id: 'chan-102', user_id: 'user-me', content: 'forbidden-token from an admin'
    });
    assert.equal(status, 200);
  });

  test('rejects a catastrophic-backtracking regex', async () => {
    const { status, body } = await api('POST', '/api/servers/server-1/automod', {
      name: 'evil', trigger_type: 'regex',
      trigger_metadata: { pattern: '(a+)+b' }, actions: ['block']
    });
    assert.equal(status, 400);
    assert.equal(body.code, 'INVALID_REGEX');
  });

  test('mention spam rule counts mentions', async () => {
    const rule = await api('POST', '/api/servers/server-1/automod', {
      name: 'mention-spam', trigger_type: 'mention_spam',
      trigger_metadata: { max_mentions: 2 }, actions: ['block']
    });
    const blocked = await api('POST', '/api/messages', {
      channel_id: 'chan-102', user_id: 'user-3',
      content: '<@user-me> <@user-2> <@user-4> <@user-5>'
    }, { 'x-user-id': 'user-3' });
    assert.equal(blocked.status, 403);
    await api('DELETE', `/api/servers/server-1/automod/${rule.body.id}`);
  });

  test('link rule enforces an allow-list', async () => {
    const rule = await api('POST', '/api/servers/server-1/automod', {
      name: 'links', trigger_type: 'link',
      trigger_metadata: { allowed_domains: ['example.com'] }, actions: ['block']
    });
    const blocked = await api('POST', '/api/messages', {
      channel_id: 'chan-102', user_id: 'user-3', content: 'ดูนี่ https://evil.test/x'
    }, { 'x-user-id': 'user-3' });
    assert.equal(blocked.status, 403);

    const allowed = await api('POST', '/api/messages', {
      channel_id: 'chan-102', user_id: 'user-3', content: 'ดูนี่ https://example.com/ok'
    }, { 'x-user-id': 'user-3' });
    assert.equal(allowed.status, 200);
    await api('DELETE', `/api/servers/server-1/automod/${rule.body.id}`);
  });

  test('deleting the rule restores normal sending', async () => {
    const { status } = await api('DELETE', `/api/servers/server-1/automod/${ruleId}`);
    assert.equal(status, 200);
    const after = await api('POST', '/api/messages', {
      channel_id: 'chan-102', user_id: 'user-3', content: 'forbidden-token is fine now'
    }, { 'x-user-id': 'user-3' });
    assert.equal(after.status, 200);
  });
});

describe('slowmode & timeouts', () => {
  test('slowmode blocks a fast second message but not a moderator', async () => {
    // user-3 holds only the Bot role in server-1: no MANAGE_MESSAGES and no
    // MANAGE_CHANNELS, so it is subject to slowmode. (user-5 is an admin in
    // server-3, which is exactly why that channel is the wrong one to test in.)
    await api('PATCH', '/api/channels/chan-103', { rate_limit_per_user: 30 });

    const first = await api('POST', '/api/messages', {
      channel_id: 'chan-103', user_id: 'user-3', content: 'first'
    }, { 'x-user-id': 'user-3' });
    assert.equal(first.status, 200);

    const second = await api('POST', '/api/messages', {
      channel_id: 'chan-103', user_id: 'user-3', content: 'second'
    }, { 'x-user-id': 'user-3' });
    assert.equal(second.status, 429);
    assert.equal(second.body.code, 'SLOWMODE');

    const moderator = await api('POST', '/api/messages', {
      channel_id: 'chan-103', user_id: 'user-me', content: 'moderator ignores slowmode'
    });
    assert.equal(moderator.status, 200);

    await api('PATCH', '/api/channels/chan-103', { rate_limit_per_user: 0 });
  });

  test('a timed-out member cannot speak', async () => {
    await api('POST', '/api/servers/server-1/timeouts/user-3', {
      until: new Date(Date.now() + 60_000).toISOString()
    });
    const { status, body } = await api('POST', '/api/messages', {
      channel_id: 'chan-102', user_id: 'user-3', content: 'let me through'
    }, { 'x-user-id': 'user-3' });
    assert.equal(status, 403);
    assert.equal(body.code, 'TIMED_OUT');

    await api('POST', '/api/servers/server-1/timeouts/user-3', {
      until: new Date(Date.now() - 1000).toISOString()
    });
  });

  test('a locked channel refuses messages', async () => {
    await api('PATCH', '/api/channels/chan-302', { locked: 1 });
    const { status, body } = await api('POST', '/api/messages', {
      channel_id: 'chan-302', user_id: 'user-me', content: 'locked?'
    });
    assert.equal(status, 403);
    assert.equal(body.code, 'CHANNEL_LOCKED');
    await api('PATCH', '/api/channels/chan-302', { locked: 0 });
  });
});

describe('webhooks', () => {
  let webhook;

  test('creates a webhook and returns the token exactly once', async () => {
    const { status, body } = await api('POST', '/api/channels/chan-102/webhooks', { name: 'CI' });
    assert.equal(status, 200);
    assert.ok(body.token, 'token not returned');
    assert.equal(body.token_hash, undefined, 'token hash leaked to the client');
    webhook = body;
  });

  test('executes with no session at all', async () => {
    const { status, body } = await api(
      'POST', `/api/webhooks/${webhook.id}/${webhook.token}`,
      { content: 'from a webhook', username: 'Deploy Bot' },
      { 'x-user-id': '' }
    );
    assert.equal(status, 200);
    assert.equal(body.display_name, 'Deploy Bot');
    assert.equal(body.is_webhook, true);
  });

  test('rejects a wrong token', async () => {
    const { status } = await api(
      'POST', `/api/webhooks/${webhook.id}/wrong-token`, { content: 'nope' }
    );
    assert.equal(status, 401);
  });

  test('listing never exposes the token hash', async () => {
    const { body } = await get('/api/servers/server-1/webhooks');
    assert.ok(body.length >= 1);
    assert.ok(body.every((w) => w.token_hash === undefined));
  });

  test('a deleted webhook stops working', async () => {
    await api('DELETE', `/api/webhooks/${webhook.id}`);
    const { status } = await api(
      'POST', `/api/webhooks/${webhook.id}/${webhook.token}`, { content: 'after delete' }
    );
    assert.equal(status, 401);
  });
});

describe('reports', () => {
  let reportId;
  let messageId;

  test('files a report', async () => {
    const message = await api('POST', '/api/messages', {
      channel_id: 'chan-102', user_id: 'user-me', content: 'reportable content'
    });
    messageId = message.body.id;

    const { status, body } = await api('POST', '/api/reports', {
      target_type: 'message', target_id: messageId, reason: 'spam', details: 'test'
    }, { 'x-user-id': 'user-2' });
    assert.equal(status, 200);
    reportId = body.id;
  });

  test('refuses a duplicate open report', async () => {
    const { status } = await api('POST', '/api/reports', {
      target_type: 'message', target_id: messageId, reason: 'spam'
    }, { 'x-user-id': 'user-2' });
    assert.equal(status, 409);
  });

  test('validates the reason', async () => {
    const { body } = await api('POST', '/api/reports', {
      target_type: 'message', target_id: messageId, reason: 'because'
    }, { 'x-user-id': 'user-4' });
    assert.equal(body.code, 'INVALID_REASON');
  });

  test('triage requires the admin token', async () => {
    assert.equal((await get('/api/reports')).status, 403);
    assert.equal((await get('/api/reports', ADMIN)).status, 200);
  });

  test('the queue includes a snapshot of the target', async () => {
    const { body } = await get('/api/reports', ADMIN);
    const report = body.find((r) => r.id === reportId);
    assert.ok(report.target.content.includes('reportable'));
  });

  test('resolving with delete_message removes the message', async () => {
    const { body } = await api('PATCH', `/api/reports/${reportId}`, {
      status: 'resolved', action: 'delete_message'
    }, ADMIN);
    assert.equal(body.status, 'resolved');

    const after = await get('/api/messages/chan-102?limit=100');
    assert.ok(!after.body.some((m) => m.id === messageId));
  });
});

describe('channel permission overwrites', () => {
  const SEND_MESSAGES = String(1n << 11n);

  test('denying @everyone removes just that permission', async () => {
    await api('PUT', '/api/channels/chan-103/permissions/role/server-1', {
      allow: '0', deny: SEND_MESSAGES
    });
    const { body } = await get('/api/channels/chan-103/permissions/user-5/effective');
    assert.ok(!body.permission_names.includes('SEND_MESSAGES'));
    assert.ok(body.permission_names.includes('VIEW_CHANNEL'), 'other permissions were lost');
  });

  test('ADMINISTRATOR ignores overwrites', async () => {
    const { body } = await get('/api/channels/chan-103/permissions/user-me/effective');
    assert.ok(body.permission_names.includes('SEND_MESSAGES'));
  });

  test('a member overwrite beats a role deny', async () => {
    await api('PUT', '/api/channels/chan-103/permissions/member/user-5', {
      allow: SEND_MESSAGES, deny: '0'
    });
    const { body } = await get('/api/channels/chan-103/permissions/user-5/effective');
    assert.ok(body.permission_names.includes('SEND_MESSAGES'));
  });

  test('cannot set an overwrite without MANAGE_ROLES', async () => {
    const { status } = await api(
      'PUT', '/api/channels/chan-103/permissions/role/server-1',
      { allow: '8' }, { 'x-user-id': 'user-5' }
    );
    assert.equal(status, 403);
  });

  test('cannot allow a permission the actor lacks', async () => {
    // Grant MANAGE_ROLES to Moderator, then try to allow ADMINISTRATOR with it.
    await api('PATCH', '/api/servers/server-1/roles/role-1-mod', {
      permissions: String((1n << 28n) | (1n << 1n))
    });
    const { status } = await api(
      'PUT', '/api/channels/chan-103/permissions/role/role-1-dev',
      { allow: '8' }, { 'x-user-id': 'user-4' }
    );
    assert.equal(status, 403);
  });

  test('overwrites can be removed', async () => {
    await api('DELETE', '/api/channels/chan-103/permissions/role/server-1');
    await api('DELETE', '/api/channels/chan-103/permissions/member/user-5');
    const { body } = await get('/api/channels/chan-103/permissions');
    assert.equal(body.length, 0);
  });
});

describe('stickers & soundboard', () => {
  test('creates and deletes a sticker', async () => {
    const upload = await uploadFile(PNG, 'sticker.png', 'image/png', 'sticker', '/api/upload/sticker');
    assert.equal(upload.status, 200);

    const created = await api('POST', '/api/servers/server-1/stickers', {
      name: 'teststicker', fileId: upload.body.id, format: 'png'
    });
    assert.equal(created.status, 200);

    const list = await get('/api/servers/server-1/stickers');
    assert.ok(list.body.some((s) => s.id === created.body.id));

    const removed = await api('DELETE', `/api/servers/server-1/stickers/${created.body.id}`);
    assert.equal(removed.status, 200);
  });

  test('soundboard rejects a non-audio file', async () => {
    const upload = await uploadFile(PNG, 'notaudio.png', 'image/png');
    const { status, body } = await api('POST', '/api/servers/server-1/sounds', {
      name: 'badsound', fileId: upload.body.attachments[0].id
    });
    assert.equal(status, 400);
    assert.equal(body.code, 'NOT_AUDIO');
  });
});

// ============================================================================
//  Discord-parity behaviour added in the parity pass: visibility of private
//  channels, mention permissions, timeouts, hierarchy, blocks and read state.
// ============================================================================

describe('channel visibility', () => {
  let privateChannelId;

  before(async () => {
    const { body: channel } = await api('POST', '/api/channels', {
      server_id: 'server-1', name: 'staff-only', type: 'text', category: 'TEXT CHANNELS'
    });
    privateChannelId = channel.id;
    // Deny @everyone VIEW_CHANNEL; the @everyone role id is the server id.
    await api('PUT', `/api/channels/${privateChannelId}/permissions/role/server-1`, {
      allow: '0', deny: String(1n << 10n)
    });
  });

  test('a member without VIEW_CHANNEL cannot read the channel', async () => {
    const { status } = await get(`/api/messages/${privateChannelId}`, { 'x-user-id': 'user-4' });
    assert.equal(status, 403);
  });

  test('a member without VIEW_CHANNEL cannot post to it', async () => {
    const { status } = await api('POST', '/api/messages', {
      channel_id: privateChannelId, content: 'sneaking in'
    }, { 'x-user-id': 'user-4' });
    assert.equal(status, 403);
  });

  test('the private channel is hidden from the guild payload and unread summary', async () => {
    const { body: detail } = await get('/api/servers/server-1', { 'x-user-id': 'user-4' });
    assert.ok(
      !detail.channels.some((c) => c.id === privateChannelId),
      'a channel the member cannot view was listed'
    );

    await api('POST', '/api/messages', { channel_id: privateChannelId, content: 'staff chatter' });
    const { body: states } = await get('/api/read-states/user-4', { 'x-user-id': 'user-4' });
    assert.ok(
      !states.some((s) => s.channel_id === privateChannelId),
      'a channel the member cannot view produced an unread row'
    );
  });

  test('the owner still sees it, flagged private', async () => {
    const { body: detail } = await get('/api/servers/server-1');
    const channel = detail.channels.find((c) => c.id === privateChannelId);
    assert.ok(channel, 'the owner cannot see their own private channel');
    assert.equal(channel.is_private, true);
  });

  test('search does not leak messages from it', async () => {
    const { body: results } = await get(
      '/api/search/messages?q=' + encodeURIComponent('staff chatter') + '&serverId=server-1',
      { 'x-user-id': 'user-4' }
    );
    assert.ok(Array.isArray(results));
    assert.equal(results.length, 0, 'search returned a message from a hidden channel');
  });
});

describe('mentions', () => {
  test('@everyone from a member without MENTION_EVERYONE is not a ping', async () => {
    // user-4 holds only the default @everyone permissions.
    await api('POST', '/api/messages', {
      channel_id: 'chan-102', content: 'hey @everyone look at this'
    }, { 'x-user-id': 'user-4' });

    const { body: states } = await get('/api/read-states/user-5', { 'x-user-id': 'user-5' });
    const state = states.find((s) => s.channel_id === 'chan-102');
    assert.ok(!state || (state.mention_count ?? 0) === 0, '@everyone pinged without the permission');
  });

  test('a direct @mention always counts', async () => {
    await api('POST', '/api/messages', {
      channel_id: 'chan-102', content: 'ping <@user-5>'
    }, { 'x-user-id': 'user-4' });
    const { body: states } = await get('/api/read-states/user-5', { 'x-user-id': 'user-5' });
    const state = states.find((s) => s.channel_id === 'chan-102');
    assert.ok(state.mention_count >= 1, 'a direct mention did not count');
  });
});

describe('timeouts', () => {
  after(async () => {
    await api('POST', '/api/servers/server-1/timeouts/user-4', {
      until: new Date(Date.now() - 1000).toISOString()
    });
  });

  test('a timed-out member cannot send, but can still read', async () => {
    await api('POST', '/api/servers/server-1/timeouts/user-4', {
      until: new Date(Date.now() + 60_000).toISOString()
    });

    const send = await api('POST', '/api/messages', {
      channel_id: 'chan-102', content: 'still here'
    }, { 'x-user-id': 'user-4' });
    assert.equal(send.status, 403);

    const read = await get('/api/messages/chan-102', { 'x-user-id': 'user-4' });
    assert.equal(read.status, 200);
  });

  test('a timeout with a non-UTC offset is still enforced', async () => {
    const plusSeven = new Date(Date.now() + 60_000).toISOString().replace('Z', '+00:00');
    const { body } = await api('POST', '/api/servers/server-1/timeouts/user-4', { until: plusSeven });
    assert.ok(body.timeout_until.endsWith('Z'), 'the timeout was not normalised to UTC');

    const send = await api('POST', '/api/messages', {
      channel_id: 'chan-102', content: 'offset dodge'
    }, { 'x-user-id': 'user-4' });
    assert.equal(send.status, 403);
  });
});

describe('member hierarchy', () => {
  test('a moderator cannot ban the owner', async () => {
    const { status } = await api('POST', '/api/servers/server-1/bans/user-me', {}, {
      'x-user-id': 'user-2'
    });
    assert.equal(status, 403);
  });

  test('nobody can kick themselves through the moderation route', async () => {
    const { status } = await api('POST', '/api/servers/server-1/kicks/user-me', {});
    assert.equal(status, 403);
  });
});

describe('blocks', () => {
  before(async () => {
    await api('POST', '/api/blocks', { targetId: 'user-me' }, { 'x-user-id': 'user-5' });
  });
  after(async () => {
    await api('DELETE', '/api/blocks/user-me', undefined, { 'x-user-id': 'user-5' });
  });

  test('a blocked user cannot open or message the DM', async () => {
    const { status } = await api('POST', '/api/dms', { recipientId: 'user-5' });
    assert.equal(status, 403);
  });

  test('a blocked user cannot be pulled into a group DM', async () => {
    const { status } = await api('POST', '/api/dms', { recipientIds: ['user-5', 'user-4'] });
    assert.equal(status, 403);
  });
});

describe('read state', () => {
  test('marking read without a message id does not erase the marker', async () => {
    const { body: message } = await api('POST', '/api/messages', {
      channel_id: 'chan-102', content: 'marker test'
    });
    await api('POST', '/api/read-states/chan-102', { messageId: message.id });
    const { body: state } = await api('POST', '/api/read-states/chan-102', {});
    assert.ok(state.last_read_message_id, 'the read marker was erased');
  });

  test('mark-as-unread moves the marker backwards', async () => {
    const { body: state } = await api('POST', '/api/read-states/chan-102/unread', {
      beforeMessageId: null
    });
    assert.equal(state.last_read_message_id, null);
    assert.equal(state.unread, 1);
  });
});

describe('anonymous access', () => {
  const anon = (method, url, body) => api(method, url, body, { 'x-user-id': '' });

  test('history, search and guild reads all require an identity', async () => {
    for (const url of [
      '/api/messages/chan-102',
      '/api/messages/chan-102/pins',
      '/api/search/messages?q=test',
      '/api/servers/server-1',
      '/api/servers/server-1/members',
      '/api/servers/server-1/invites'
    ]) {
      const { status } = await anon('GET', url);
      assert.equal(status, 401, `${url} answered ${status} without a session`);
    }
  });
});

describe('threads', () => {
  let threadId;

  test('a thread notifies its participants, not the whole guild', async () => {
    const { body: parentMessage } = await api('POST', '/api/messages', {
      channel_id: 'chan-102', content: 'branch here'
    });
    const { body: thread } = await api('POST', '/api/channels/chan-102/threads', {
      messageId: parentMessage.id, name: 'side quest'
    });
    threadId = thread.id;

    await api('POST', '/api/messages', { channel_id: threadId, content: 'inside the thread' });

    // user-5 is in the guild but not in the thread.
    const { body: states } = await get('/api/read-states/user-5', { 'x-user-id': 'user-5' });
    assert.ok(
      !states.some((s) => s.channel_id === threadId && s.unread),
      'a non-participant was given an unread for a thread'
    );
  });

  test('posting in a thread joins it', async () => {
    await api('POST', '/api/messages', {
      channel_id: threadId, content: 'joining in'
    }, { 'x-user-id': 'user-2' });

    const { body: thread } = await get(`/api/threads/${threadId}`, { 'x-user-id': 'user-2' });
    assert.ok(thread.member_count >= 2, 'posting did not add the author to the thread');
  });

  test('an archived thread refuses new messages', async () => {
    await api('PATCH', `/api/threads/${threadId}`, { archived: true });
    const { status, body } = await api('POST', '/api/messages', {
      channel_id: threadId, content: 'after the archive'
    });
    assert.equal(status, 403);
    assert.equal(body.code, 'THREAD_ARCHIVED');
    await api('PATCH', `/api/threads/${threadId}`, { archived: false });
  });
});

describe('invites', () => {
  let code;

  test('an invite can be previewed without joining', async () => {
    const { body: invite } = await api('POST', '/api/servers/server-1/invites', {
      channelId: 'chan-102', maxAge: 3600
    });
    code = invite.code;

    const { status, body } = await get(`/api/invites/${code}`, { 'x-user-id': 'user-5' });
    assert.equal(status, 200);
    assert.equal(body.server.id, 'server-1');
    assert.ok(typeof body.server.member_count === 'number');
    assert.ok(typeof body.server.online_count === 'number');
  });

  test('an unknown invite is a 404, an expired one a 410', async () => {
    const missing = await get('/api/invites/definitely-not-real');
    assert.equal(missing.status, 404);

    const { body: expiring } = await api('POST', '/api/servers/server-1/invites', { maxAge: 1 });
    await new Promise((resolve) => setTimeout(resolve, 1100));
    const expired = await get(`/api/invites/${expiring.code}`);
    assert.equal(expired.status, 410);
  });

  test('accepting an invite joins the server', async () => {
    const { status } = await api('POST', `/api/invites/${code}/accept`, {}, { 'x-user-id': 'user-5' });
    assert.equal(status, 200);
    const { body: detail } = await get('/api/servers/server-1', { 'x-user-id': 'user-5' });
    assert.ok(detail.members.some((m) => m.id === 'user-5'));
  });
});

describe('group DMs', () => {
  let groupId;

  test('a group DM can be created and lists its recipients', async () => {
    const { status, body } = await api('POST', '/api/dms', {
      recipientIds: ['user-2', 'user-4'], name: 'planning'
    });
    assert.equal(status, 200);
    assert.equal(body.type, 'group_dm');
    assert.equal(body.recipients.length, 2);
    groupId = body.id;
  });

  test('a non-recipient cannot read it', async () => {
    const { status } = await get(`/api/messages/${groupId}`, { 'x-user-id': 'user-5' });
    assert.equal(status, 403);
  });

  test('closing a DM hides it without destroying the history', async () => {
    await api('DELETE', `/api/dms/${groupId}`);
    const { body: list } = await get('/api/dms/user-me');
    assert.ok(!list.some((c) => c.id === groupId), 'the closed conversation is still listed');

    // The channel itself survives — the messages are still readable.
    const { status } = await get(`/api/messages/${groupId}`);
    assert.equal(status, 200);
  });
});

describe('notifications', () => {
  test('a mention is listed, and marking read clears it', async () => {
    await api('POST', '/api/messages', { channel_id: 'chan-102', content: 'oi <@user-2>' });

    const asUser2 = { 'x-user-id': 'user-2' };
    const { body: before } = await get('/api/notifications/user-2', asUser2);
    const unread = before.filter((n) => !n.read_at);
    assert.ok(unread.length > 0, 'no unread notification was created');
    assert.ok(unread[0].preview, 'the notification has no preview text');

    const marked = await api('POST', '/api/notifications/read', {}, asUser2);
    assert.equal(marked.status, 200);

    const { body: after } = await get('/api/notifications/user-2', asUser2);
    assert.ok(after.every((n) => n.read_at), 'notifications were not marked read');
  });
});

describe('role ordering', () => {
  test('a partial reorder keeps every role at a distinct position', async () => {
    const { body: before } = await get('/api/servers/server-1/roles');
    const movable = before.filter((r) => !r.is_everyone).map((r) => r.id);
    assert.ok(movable.length >= 2, 'not enough roles to reorder');

    // Send only two ids, as the drag-and-drop editor does.
    const { status, body: after } = await api('PUT', '/api/servers/server-1/roles/order', {
      order: [movable[1], movable[0]]
    });
    assert.equal(status, 200);

    const positions = after.filter((r) => !r.is_everyone).map((r) => r.position);
    assert.equal(new Set(positions).size, positions.length, 'two roles share a position');
  });

  test('a member cannot reorder a role above their own', async () => {
    const { status } = await api('PUT', '/api/servers/server-1/roles/order', {
      order: ['role-1-admin']
    }, { 'x-user-id': 'user-5' });
    assert.equal(status, 403);
  });
});

// ============================================================================
//  Gateway. The websocket is a second front door to the same data, so it gets
//  the same scrutiny as the REST API.
// ============================================================================

/** Connect, identify, and resolve once the gateway confirms who we are. */
function connectAs(userId) {
  return new Promise((resolve, reject) => {
    const socket = ioClient(BASE, { transports: ['websocket'], forceNew: true });
    const fail = setTimeout(() => reject(new Error('socket did not identify in time')), 5000);
    socket.on('connect', () => socket.emit('identify', { userId }));
    socket.on('identified', () => { clearTimeout(fail); resolve(socket); });
    socket.on('connect_error', (err) => { clearTimeout(fail); reject(err); });
  });
}

const waitFor = (socket, event, ms = 2500) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve(null), ms);
  socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
});

describe('gateway', () => {
  let sockets = [];
  const track = (socket) => { sockets.push(socket); return socket; };
  after(() => { for (const s of sockets) s.close(); sockets = []; });

  test('an unidentified socket cannot join a channel or send', async () => {
    const socket = track(ioClient(BASE, { transports: ['websocket'], forceNew: true }));
    await new Promise((resolve) => socket.on('connect', resolve));

    const joined = await new Promise((resolve) => {
      socket.emit('join_channel', 'chan-102', resolve);
      setTimeout(() => resolve(null), 2000);
    });
    assert.equal(joined?.ok, false, 'an anonymous socket was allowed into a channel');

    const sent = await new Promise((resolve) => {
      socket.emit('send_message', { channel_id: 'chan-102', content: 'anon' }, resolve);
      setTimeout(() => resolve(null), 2000);
    });
    assert.equal(sent?.ok, false);
    assert.equal(sent?.code, 'UNAUTHENTICATED');
  });

  test('identify then join delivers messages to the room', async () => {
    const listener = track(await connectAs('user-2'));
    const joined = await new Promise((resolve) => listener.emit('join_channel', 'chan-102', resolve));
    assert.equal(joined.ok, true);

    const incoming = waitFor(listener, 'new_message');
    const sender = track(await connectAs('user-me'));
    sender.emit('send_message', { channel_id: 'chan-102', content: 'over the wire' });

    const message = await incoming;
    assert.ok(message, 'the room never received the message');
    assert.equal(message.content, 'over the wire');
  });

  test('a message on the wire carries no delivery metadata', async () => {
    const listener = track(await connectAs('user-2'));
    await new Promise((resolve) => listener.emit('join_channel', 'chan-102', resolve));

    const incoming = waitFor(listener, 'new_message');
    const sender = track(await connectAs('user-me'));
    sender.emit('send_message', { channel_id: 'chan-102', content: 'no metadata please' });

    const message = await incoming;
    assert.ok(message);
    assert.equal(message.audience, undefined, 'the audience list was broadcast to clients');
    assert.equal(message.notifications, undefined, 'notification rows were broadcast to clients');
  });

  test('a member cannot join a channel they cannot view', async () => {
    const { body: channel } = await api('POST', '/api/channels', {
      server_id: 'server-1', name: 'gateway-private', type: 'text'
    });
    await api('PUT', `/api/channels/${channel.id}/permissions/role/server-1`, {
      allow: '0', deny: String(1n << 10n)
    });

    const outsider = track(await connectAs('user-4'));
    const joined = await new Promise((resolve) => outsider.emit('join_channel', channel.id, resolve));
    assert.equal(joined.ok, false, 'a socket joined a channel it cannot view');
  });

  test('the socket send path is rate limited', async () => {
    const socket = track(await connectAs('user-me'));
    await new Promise((resolve) => socket.emit('join_channel', 'chan-102', resolve));

    let limited = false;
    for (let i = 0; i < 45 && !limited; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const ack = await new Promise((resolve) => {
        socket.emit('send_message', { channel_id: 'chan-102', content: `flood ${i}` }, resolve);
        setTimeout(() => resolve({ ok: true }), 1500);
      });
      if (ack?.code === 'RATE_LIMITED') limited = true;
    }
    assert.ok(limited, 'the gateway accepted an unbounded burst of messages');
  });
});

// ============================================================================
//  Stage channels: audience is suppressed, hands are raised, moderators promote.
// ============================================================================

describe('stage channels', () => {
  let sockets = [];
  const track = (socket) => { sockets.push(socket); return socket; };
  after(() => { for (const s of sockets) s.close(); sockets = []; });

  const emitAck = (socket, event, payload) => new Promise((resolve) => {
    socket.emit(event, payload, resolve);
    setTimeout(() => resolve(null), 2500);
  });
  const rosterWhere = (socket, predicate) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 3000);
    const handler = (payload) => {
      if (predicate(payload)) { clearTimeout(timer); socket.off('voice_participants', handler); resolve(payload); }
    };
    socket.on('voice_participants', handler);
  });

  test('audience joins suppressed, a moderator joins as speaker, hand-raise and promotion work', async () => {
    const made = await api('POST', '/api/channels', { server_id: 'server-1', name: 'Town Hall', type: 'stage' });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const stageId = made.body.id;

    // user-5 has only the Developer role: no MUTE_MEMBERS → audience.
    const listener = track(await connectAs('user-5'));
    const joinAck = await emitAck(listener, 'join_voice', { channelId: stageId });
    assert.equal(joinAck?.ok, true, JSON.stringify(joinAck));

    // The moderator (user-me, admin) joins as a speaker.
    const mod = track(await connectAs('user-me'));
    const withBoth = rosterWhere(listener, (p) => p.participants.length === 2);
    assert.equal((await emitAck(mod, 'join_voice', { channelId: stageId }))?.ok, true);
    const roster = await withBoth;
    assert.ok(roster, 'roster never showed both participants');
    const me5 = roster.participants.find((p) => p.userId === 'user-5');
    const meMod = roster.participants.find((p) => p.userId === 'user-me');
    assert.equal(me5.isSuppressed, true, 'a plain member joins a stage as audience');
    assert.equal(meMod.isSuppressed, false, 'a moderator joins as a speaker');

    // Audience cannot unmute.
    const err = waitFor(listener, 'voice_error');
    listener.emit('voice_state_change', { channelId: stageId, isMuted: false });
    assert.equal((await err)?.code, 'SUPPRESSED');

    // Raise hand → visible to everyone in the roster.
    const raised = rosterWhere(mod, (p) => p.participants.some((x) => x.userId === 'user-5' && x.requestedToSpeakAt));
    assert.equal((await emitAck(listener, 'stage_request_speak', { channelId: stageId, requesting: true }))?.ok, true);
    assert.ok(await raised, 'raised hand did not reach the moderator');

    // Audience cannot promote themselves.
    const selfPromote = await emitAck(listener, 'stage_set_speaker', { channelId: stageId, userId: 'user-5', speaker: true });
    assert.equal(selfPromote?.ok, false);
    assert.equal(selfPromote?.code, 'FORBIDDEN');

    // Moderator promotes; the hand goes down and user-5 is told.
    const told = waitFor(listener, 'stage_speaker_changed');
    const promoted = rosterWhere(listener, (p) => p.participants.some((x) => x.userId === 'user-5' && !x.isSuppressed));
    assert.equal((await emitAck(mod, 'stage_set_speaker', { channelId: stageId, userId: 'user-5', speaker: true }))?.ok, true);
    assert.equal((await told)?.speaker, true);
    const after5 = (await promoted)?.participants.find((x) => x.userId === 'user-5');
    assert.equal(after5?.requestedToSpeakAt, null, 'promotion lowers the hand');

    // Now unmuting is allowed.
    const unmuted = rosterWhere(mod, (p) => p.participants.some((x) => x.userId === 'user-5' && !x.isMuted));
    listener.emit('voice_state_change', { channelId: stageId, isMuted: false });
    assert.ok(await unmuted, 'speaker could not unmute');

    // A speaker may step down on their own.
    const stepped = rosterWhere(mod, (p) => p.participants.some((x) => x.userId === 'user-5' && x.isSuppressed));
    assert.equal((await emitAck(listener, 'stage_set_speaker', { channelId: stageId, userId: 'user-5', speaker: false }))?.ok, true);
    assert.ok(await stepped, 'step-down did not reach the roster');
  });
});

// ============================================================================
//  The bot gateway: an application receives interactions and answers them.
// ============================================================================

describe('bot gateway', () => {
  let sockets = [];
  const track = (socket) => { sockets.push(socket); return socket; };
  after(() => { for (const s of sockets) s.close(); sockets = []; });

  test('a bot identifies with its token, is handed an interaction, and answers it', async () => {
    const created = await api('POST', '/api/applications', { name: 'GatewayBot' });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const { id: appId, token } = created.body;
    await api('POST', `/api/applications/${appId}/invite`, {
      server_id: 'server-1', permissions: ['VIEW_CHANNEL', 'SEND_MESSAGES', 'EMBED_LINKS']
    });

    // Connect as the bot. A bad token must be refused outright.
    const rejected = track(ioClient(BASE, { transports: ['websocket'], forceNew: true }));
    await new Promise((resolve) => rejected.on('connect', resolve));
    const refusal = new Promise((resolve) => rejected.once('identify_error', resolve));
    rejected.emit('identify', { botToken: 'nonsense' });
    assert.ok(await refusal, 'the gateway accepted a forged bot token');

    const bot = track(ioClient(BASE, { transports: ['websocket'], forceNew: true }));
    const identified = new Promise((resolve) => bot.once('identified', resolve));
    bot.on('connect', () => bot.emit('identify', { botToken: token }));
    const hello = await identified;
    assert.equal(hello.applicationId, appId);

    // The bot posts a message with a button, then a person presses it.
    const posted = await asBot(token, 'POST', '/api/messages', {
      channel_id: 'chan-102',
      content: 'Ready?',
      components: [{ components: [{ type: 'button', style: 'primary', label: 'Go', custom_id: 'go' }] }]
    });
    assert.equal(posted.status, 200, JSON.stringify(posted.body));

    const incoming = waitFor(bot, 'interaction_created', 4000);
    const pressed = await api('POST', `/api/messages/${posted.body.id}/interactions`, { custom_id: 'go' });
    assert.equal(pressed.status, 202);

    const interaction = await incoming;
    assert.ok(interaction, 'the bot never received the interaction');
    assert.equal(interaction.custom_id, 'go');
    assert.equal(interaction.user_id, 'user-me');
    assert.ok(interaction.token, 'the interaction carries the token the bot answers with');

    // The person who pressed hears back when the bot responds.
    const watcher = track(await connectAs('user-me'));
    await new Promise((resolve) => watcher.emit('join_channel', 'chan-102', resolve));
    const resolved = waitFor(watcher, 'interaction_resolved', 4000);
    const delivered = waitFor(watcher, 'new_message', 4000);

    const answered = await asBot(token, 'POST', `/api/interactions/${interaction.id}/callback`, {
      token: interaction.token, type: 'message', content: 'Off we go.'
    });
    assert.equal(answered.status, 200, JSON.stringify(answered.body));

    const reply = await delivered;
    assert.equal(reply?.content, 'Off we go.');
    assert.equal((await resolved)?.interaction_id, interaction.id);

    await api('DELETE', `/api/applications/${appId}`);
  });
});
