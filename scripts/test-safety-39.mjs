// ============================================================================
//  Safety & privacy (schema v39–v40): dead sessions, age gate and teen
//  defaults, invisible / profile-visibility leaks, generic refusals, message
//  requests, report routing, the instance admin console, registration modes
//  and limits, 2FA step-up.
//
//  Runs on both drivers (npm test / npm run test:pg).
// ============================================================================

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.RATE_LIMIT_REGISTER_INVITE_PER_HOUR ??= '3';

const { startServer, stopServer, api, get, asSession, login, BASE } = await import('./testHarness.mjs');

before(startServer);
after(stopServer);

let n = 0;
const unique = (prefix) => `${prefix}${Date.now().toString(36).slice(-5)}${(n += 1)}`;
const thisYear = new Date().getUTCFullYear();

async function register(body) {
  const res = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json, headers: res.headers };
}

async function account(extra = {}) {
  const username = unique('s');
  const res = await register({ username, password: 'a-good-password', ...extra });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { id: res.body.user.id, token: res.body.token, username, user: res.body.user };
}

/** Raw SQL against the test database (same one the server uses). */
async function sqlRun(query, params = []) {
  const { runQuery } = await import('../db.js');
  return runQuery(query, params);
}

const as = (acct, method, url, body) => asSession(acct.token, method, url, body);

// ---------------------------------------------------------------------------

describe('a dead session no longer bricks the device', () => {
  test('a revoked cookie is cleared, /me says INVALID_SESSION, and login works again', async () => {
    const a = await account();
    await as(a, 'POST', '/api/auth/logout');

    const me = await fetch(`${BASE}/api/auth/me`, { headers: { Cookie: `antigravity_session=${a.token}` } });
    assert.equal(me.status, 401);
    assert.equal((await me.json()).code, 'INVALID_SESSION');
    const cookies = me.headers.getSetCookie();
    assert.ok(cookies.some((c) => /^antigravity_session=;.*Max-Age=0/.test(c)), 'dead cookie cleared');
    assert.ok(cookies.some((c) => /^antigravity_signed_out=1/.test(c)), 'signed-out marker set');

    // The same stale cookie must not block signing in again.
    const relogin = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `antigravity_session=${a.token}` },
      body: JSON.stringify({ username: a.username, password: 'a-good-password' })
    });
    assert.equal(relogin.status, 200);

    // Public endpoints answer normally instead of 401.
    const reg = await fetch(`${BASE}/api/auth/registration`, { headers: { Cookie: 'antigravity_session=forged' } });
    assert.equal(reg.status, 200);
  });

  test('a dead token never falls back to the dev identity header', async () => {
    const res = await asSession('not-a-real-token', 'GET', '/api/users/@me/emojis');
    assert.equal(res.status, 401);
  });
});

describe('age gate and teen defaults', () => {
  test('under 13 is refused and no account is created', async () => {
    const username = unique('kid');
    const res = await register({
      username, password: 'a-good-password', birth_date: { year: thisYear - 10, month: 1, day: 1 }
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'AGE_TOO_YOUNG');
    assert.equal((await login(username, 'a-good-password')).status, 401);
  });

  test('an impossible date is rejected', async () => {
    const res = await register({ username: unique('x'), password: 'a-good-password', birth_date: { year: 2000, month: 2, day: 31 } });
    assert.equal(res.body.code, 'INVALID_BIRTHDATE');
  });

  test('a teen gets protective privacy defaults; only year and month are stored', async () => {
    const teen = await account({ birth_date: { year: thisYear - 15, month: 6, day: 14 } });
    assert.equal(teen.user.age_group, 'minor');
    assert.equal(teen.user.birthdate_set, true);
    assert.equal(teen.user.birth_day, undefined);
    const privacy = (await as(teen, 'GET', '/api/settings/preferences')).body;
    const p = privacy.privacy ?? privacy;
    assert.equal(p.allowDmsFrom, 'friends');
    assert.equal(p.allowServerMemberDms, false);
    assert.equal(p.messageRequests, true);
    assert.equal(p.dmScanning, 'everyone');
    assert.equal(p.friendRequests, 'friends_of_friends');
    const exported = await as(teen, 'GET', '/api/users/@me/export');
    if (exported.status === 200) {
      const u = exported.body.user;
      assert.equal(u.birth_year, thisYear - 15);
      assert.equal(u.birth_month, 6);
      assert.equal(u.birth_day, undefined, 'the day is never stored');
    }
  });

  test('an adult keeps the normal defaults', async () => {
    const adult = await account({ birth_date: { year: thisYear - 30, month: 1, day: 1 } });
    assert.equal(adult.user.age_group, 'adult');
    const privacy = (await as(adult, 'GET', '/api/settings/preferences')).body;
    assert.equal((privacy.privacy ?? privacy).allowDmsFrom, 'everyone');
  });

  test('an account without a birth date is asked once; it cannot be changed after', async () => {
    const a = await account();
    assert.equal(a.user.birthdate_set, false);
    assert.equal(a.user.age_group, 'unknown');
    const set = await as(a, 'PUT', '/api/auth/age', { year: thisYear - 16, month: 3, day: 2 });
    assert.equal(set.status, 200);
    assert.equal(set.body.age_group, 'minor');
    const again = await as(a, 'PUT', '/api/auth/age', { year: thisYear - 40, month: 3, day: 2 });
    assert.equal(again.status, 409);
    assert.equal(again.body.code, 'BIRTHDATE_ALREADY_SET');
    const privacy = (await as(a, 'GET', '/api/settings/preferences')).body;
    assert.equal((privacy.privacy ?? privacy).allowDmsFrom, 'friends', 'teen defaults applied on the prompt too');
  });

  test('a stranger sharing a server cannot friend-request a teen (friends of friends only)', async () => {
    const teen = await account({ birth_date: { year: thisYear - 14, month: 1, day: 1 } });
    await sqlRun(`INSERT INTO server_members (server_id, user_id) VALUES ('server-1', ?)`, [teen.id]);
    const res = await api('POST', '/api/friends/requests', { targetId: teen.id }, { 'x-user-id': 'user-5' });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'USER_UNREACHABLE');
  });
});

describe('refusals do not reveal a block', () => {
  test('blocked and privacy-filtered refusals are identical', async () => {
    const victim = await account();
    const harasser = await account();
    const stranger = await account();
    // The victim blocks the harasser; the stranger simply shares no server.
    await as(victim, 'POST', '/api/blocks', { targetId: harasser.id });

    const fromBlocked = await as(harasser, 'POST', '/api/friends/requests', { targetId: victim.id });
    await as(victim, 'PATCH', '/api/settings/preferences/privacy', { friendRequests: 'none' });
    const fromStranger = await as(stranger, 'POST', '/api/friends/requests', { targetId: victim.id });
    assert.equal(fromBlocked.status, 403);
    assert.deepEqual(
      { status: fromBlocked.status, code: fromBlocked.body.code, error: fromBlocked.body.error },
      { status: fromStranger.status, code: fromStranger.body.code, error: fromStranger.body.error }
    );
    assert.equal(fromBlocked.body.code, 'USER_UNREACHABLE');

    const dmBlocked = await as(harasser, 'POST', '/api/dms', { recipient_id: victim.id, recipientId: victim.id });
    const dmStranger = await as(stranger, 'POST', '/api/dms', { recipient_id: victim.id, recipientId: victim.id });
    assert.equal(dmStranger.body.code, 'USER_UNREACHABLE');
    assert.equal(dmBlocked.status, 403);
  });
});

describe('invisible and profile visibility do not leak', () => {
  test('member list and profile endpoints show invisible as offline to others only', async () => {
    await sqlRun(`UPDATE users SET status = 'invisible' WHERE id = 'user-5'`);

    const members = await api('GET', '/api/servers/server-1/members', undefined, { 'x-user-id': 'user-2' });
    assert.equal(members.status, 200);
    assert.equal(members.body.find((m) => m.id === 'user-5').status, 'offline');
    assert.ok(!members.body.some((m) => m.status === 'invisible'));

    const detail = await api('GET', '/api/servers/server-1', undefined, { 'x-user-id': 'user-2' });
    const row = detail.body.members.find((m) => m.id === 'user-5');
    assert.equal(row.status, 'offline');
    assert.equal(row.bio, undefined, 'bio is not part of the member list');

    const self = await api('GET', '/api/servers/server-1/members', undefined, { 'x-user-id': 'user-5' });
    assert.equal(self.body.find((m) => m.id === 'user-5').status, 'invisible', 'the owner still sees it');

    const profile = await api('GET', '/api/users/user-5', undefined, { 'x-user-id': 'user-2' });
    assert.equal(profile.body.status, 'offline');
    await sqlRun(`UPDATE users SET status = 'offline' WHERE id = 'user-5'`);
  });

  test('a friends-only profile hides bio and pronouns in the server profile', async () => {
    await sqlRun(`UPDATE users SET profile_visibility = 'friends', bio = 'secret bio', pronouns = 'sie/ihr' WHERE id = 'user-4'`);
    await sqlRun(`UPDATE server_members SET pronouns = 'she/her' WHERE server_id = 'server-1' AND user_id = 'user-4'`);
    // user-5 is not user-4's friend.
    const stranger = await api('GET', '/api/servers/server-1/profile/user-4', undefined, { 'x-user-id': 'user-5' });
    assert.equal(stranger.status, 200);
    assert.equal(stranger.body.effective.bio, null);
    assert.equal(stranger.body.effective.pronouns, null);
    assert.equal(stranger.body.pronouns, null);
    assert.equal(stranger.body.profile_hidden, true);

    const list = await api('GET', '/api/servers/server-1/members', undefined, { 'x-user-id': 'user-5' });
    assert.equal(list.body.find((m) => m.id === 'user-4').pronouns, null);

    const own = await api('GET', '/api/servers/server-1/profile/user-4', undefined, { 'x-user-id': 'user-4' });
    assert.equal(own.body.effective.bio, 'secret bio');
    await sqlRun(`UPDATE users SET profile_visibility = 'everyone' WHERE id = 'user-4'`);
  });
});

describe('message requests', () => {
  test('a DM from a non-friend waits as a request until accepted', async () => {
    const recipient = await account({ birth_date: { year: thisYear - 25, month: 1, day: 1 } });
    const sender = await account();
    await sqlRun(`INSERT INTO server_members (server_id, user_id) VALUES ('server-3', ?), ('server-3', ?)`, [recipient.id, sender.id]);

    const dm = await as(sender, 'POST', '/api/dms', { recipient_id: recipient.id, recipientId: recipient.id });
    assert.equal(dm.status, 200, JSON.stringify(dm.body));
    const sent = await as(sender, 'POST', '/api/messages', { channel_id: dm.body.id, content: 'hi, saw you in the server' });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));

    const inbox = await as(recipient, 'GET', '/api/message-requests');
    assert.equal(inbox.status, 200);
    assert.equal(inbox.body.enabled, true);
    const request = inbox.body.requests.find((r) => r.channel_id === dm.body.id);
    assert.ok(request, 'listed as a request');
    assert.equal(request.user.id, sender.id);
    assert.match(request.last_message.content, /saw you/);
    assert.equal(inbox.body.blur_previews, false);

    // The sender never sees their own DM as a request.
    assert.equal((await as(sender, 'GET', '/api/message-requests')).body.requests.length, 0);

    const accepted = await as(recipient, 'POST', `/api/message-requests/${dm.body.id}/accept`);
    assert.equal(accepted.status, 200);
    assert.equal((await as(recipient, 'GET', '/api/message-requests')).body.requests.length, 0);
  });

  test('ignore hides it; a teen sees previews blurred; outsiders cannot act on it', async () => {
    const teen = await account({ birth_date: { year: thisYear - 16, month: 1, day: 1 } });
    // Let server members DM the teen so the request can arrive.
    await as(teen, 'PATCH', '/api/settings/preferences/privacy', { allowDmsFrom: 'everyone', allowServerMemberDms: true });
    const sender = await account();
    await sqlRun(`INSERT INTO server_members (server_id, user_id) VALUES ('server-3', ?), ('server-3', ?)`, [teen.id, sender.id]);
    const dm = await as(sender, 'POST', '/api/dms', { recipient_id: teen.id, recipientId: teen.id });
    await as(sender, 'POST', '/api/messages', { channel_id: dm.body.id, content: 'hey' });

    const inbox = await as(teen, 'GET', '/api/message-requests');
    assert.equal(inbox.body.blur_previews, true);
    assert.equal(inbox.body.requests.length, 1);

    const outsider = await account();
    assert.equal((await as(outsider, 'POST', `/api/message-requests/${dm.body.id}/ignore`)).status, 404);

    assert.equal((await as(teen, 'POST', `/api/message-requests/${dm.body.id}/ignore`)).status, 200);
    assert.equal((await as(teen, 'GET', '/api/message-requests')).body.requests.length, 0);
  });
});

describe('report routing and the instance admin console', () => {
  let adminAcct;
  let victim;
  let harasser;
  let dmMessageId;
  let dmReportId;

  before(async () => {
    adminAcct = await account();
    await sqlRun(`UPDATE users SET instance_admin = 1 WHERE id = ?`, [adminAcct.id]);
    victim = await account();
    harasser = await account();
    await sqlRun(`INSERT INTO server_members (server_id, user_id) VALUES ('server-3', ?), ('server-3', ?)`, [victim.id, harasser.id]);
  });

  test('/auth/me tells the client who administers the instance', async () => {
    assert.equal((await as(adminAcct, 'GET', '/api/auth/me')).body.user.is_instance_admin, true);
    assert.equal((await as(victim, 'GET', '/api/auth/me')).body.user.is_instance_admin, false);
  });

  test('a DM report reaches the instance queue with evidence', async () => {
    const dm = await as(harasser, 'POST', '/api/dms', { recipient_id: victim.id, recipientId: victim.id });
    await as(harasser, 'POST', '/api/messages', { channel_id: dm.body.id, content: 'first line' });
    const bad = await as(harasser, 'POST', '/api/messages', { channel_id: dm.body.id, content: 'a threatening line' });
    dmMessageId = bad.body.id;

    const report = await as(victim, 'POST', '/api/reports', {
      target_type: 'message', target_id: dmMessageId, reason: 'harassment', details: 'scared'
    });
    assert.equal(report.status, 200, JSON.stringify(report.body));
    assert.equal(report.body.escalated, true);
    assert.equal(report.body.server_id, null);
    assert.equal(report.body.target_user_id, harasser.id);
    dmReportId = report.body.id;

    const queue = await as(adminAcct, 'GET', '/api/admin/reports');
    assert.equal(queue.status, 200);
    const row = queue.body.find((r) => r.id === dmReportId);
    assert.ok(row, 'in the instance queue');
    assert.equal(row.context.message.content, 'a threatening line');
    assert.equal(row.context.before.at(-1).content, 'first line');
  });

  test('new categories are accepted; severe server reports escalate, others stay with the mods', async () => {
    const hate = await as(victim, 'POST', '/api/reports', { target_type: 'user', target_id: harasser.id, reason: 'hate' });
    assert.equal(hate.status, 200);
    assert.equal(hate.body.escalated, true);

    const msg = await api('POST', '/api/messages', { channel_id: 'chan-102', content: 'server content' }, { 'x-user-id': 'user-2' });
    const spam = await api('POST', '/api/reports', { target_type: 'message', target_id: msg.body.id, reason: 'spam' }, { 'x-user-id': 'user-4' });
    assert.equal(spam.body.escalated, false);
    assert.equal(spam.body.server_id, 'server-1');
    const severe = await api('POST', '/api/reports', { target_type: 'message', target_id: msg.body.id, reason: 'minor_safety' }, { 'x-user-id': 'user-5' });
    assert.equal(severe.body.escalated, true);
    assert.equal(severe.body.server_id, 'server-1', 'the server mods see it too');

    const queue = (await as(adminAcct, 'GET', '/api/admin/reports')).body.map((r) => r.id);
    assert.ok(queue.includes(severe.body.id));
    assert.ok(!queue.includes(spam.body.id));
  });

  test('the reporter can follow their own reports, without seeing who handled them', async () => {
    const mine = await as(victim, 'GET', '/api/reports/mine');
    assert.equal(mine.status, 200);
    const row = mine.body.find((r) => r.id === dmReportId);
    assert.equal(row.status, 'open');
    assert.equal(row.resolved_by, undefined);
    assert.equal(row.details, undefined);
  });

  test('every admin endpoint refuses non-admins', async () => {
    for (const [method, url, body] of [
      ['GET', '/api/admin/overview'], ['GET', '/api/admin/reports'], ['GET', `/api/admin/reports/${dmReportId}`],
      ['PATCH', `/api/admin/reports/${dmReportId}`, { status: 'dismissed' }],
      ['GET', '/api/admin/users'], ['POST', `/api/admin/users/${harasser.id}/disable`, {}],
      ['POST', `/api/admin/users/${harasser.id}/enable`, {}], ['DELETE', `/api/admin/users/${harasser.id}`],
      ['GET', '/api/admin/servers'], ['GET', '/api/admin/registration'],
      ['PUT', '/api/admin/registration', { mode: 'closed' }], ['GET', '/api/admin/audit-log']
    ]) {
      const res = await as(victim, method, url, body);
      assert.equal(res.status, 403, `${method} ${url}`);
      assert.equal(res.body.code, 'NOT_INSTANCE_ADMIN');
    }
    const anon = await fetch(`${BASE}/api/admin/overview`);
    assert.equal(anon.status, 401);
  });

  test('resolve with ban: the account is disabled instance-wide and audited', async () => {
    const acted = await as(adminAcct, 'PATCH', `/api/admin/reports/${dmReportId}`, {
      status: 'resolved', action: 'ban_user', note: 'threats'
    });
    assert.equal(acted.status, 200, JSON.stringify(acted.body));
    assert.equal(acted.body.status, 'resolved');

    assert.equal((await as(harasser, 'GET', '/api/auth/me')).status, 401, 'sessions revoked');
    const relogin = await login(harasser.username, 'a-good-password');
    assert.equal(relogin.status, 403);

    const users = (await as(adminAcct, 'GET', `/api/admin/users?search=${harasser.username}`)).body;
    assert.ok(users[0].disabled_at);

    const audit = (await as(adminAcct, 'GET', '/api/admin/audit-log')).body;
    assert.ok(audit.some((a) => a.action === 'user_disable' && a.target_id === harasser.id));
    assert.ok(audit.some((a) => a.action === 'report_resolve' && a.target_id === dmReportId));

    const mine = (await as(victim, 'GET', '/api/reports/mine')).body.find((r) => r.id === dmReportId);
    assert.equal(mine.status, 'resolved');

    assert.equal((await as(adminAcct, 'POST', `/api/admin/users/${harasser.id}/enable`, {})).status, 200);
    assert.equal((await login(harasser.username, 'a-good-password')).status, 200);
  });

  test('an admin cannot ban themself or another admin', async () => {
    const self = await as(adminAcct, 'POST', `/api/admin/users/${adminAcct.id}/disable`, {});
    assert.equal(self.body.code, 'CANNOT_TARGET_SELF');
    const other = await account();
    await sqlRun(`UPDATE users SET instance_admin = 1 WHERE id = ?`, [other.id]);
    const res = await as(adminAcct, 'POST', `/api/admin/users/${other.id}/disable`, {});
    assert.equal(res.body.code, 'CANNOT_TARGET_ADMIN');
  });

  test('delete content from a report; list servers; delete a user', async () => {
    const msg = await api('POST', '/api/messages', { channel_id: 'chan-102', content: 'to be removed' }, { 'x-user-id': 'user-2' });
    const report = await as(victim, 'POST', '/api/reports', { target_type: 'message', target_id: msg.body.id, reason: 'illegal' });
    const res = await as(adminAcct, 'PATCH', `/api/admin/reports/${report.body.id}`, { status: 'resolved', action: 'delete_message' });
    assert.equal(res.status, 200);
    const after = await get('/api/messages/chan-102?limit=100');
    assert.ok(!after.body.some((m) => m.id === msg.body.id));

    const servers = await as(adminAcct, 'GET', '/api/admin/servers');
    assert.ok(servers.body.some((s) => s.id === 'server-1' && s.member_count > 0));

    const doomed = await account();
    assert.equal((await as(adminAcct, 'DELETE', `/api/admin/users/${doomed.id}`)).status, 200);
    assert.equal((await login(doomed.username, 'a-good-password')).status, 401);
  });

  test('registration modes: invite-only needs a real invite, closed refuses, default restores', async () => {
    const invite = await api('POST', '/api/servers/server-1/invites', { maxUses: 0 }, { 'x-user-id': 'user-me' });
    const code = invite.body.code;
    assert.ok(code);

    assert.equal((await as(adminAcct, 'PUT', '/api/admin/registration', { mode: 'invite' })).body.mode, 'invite');
    const pub = await (await fetch(`${BASE}/api/auth/registration`)).json();
    assert.equal(pub.invite_required, true);

    const without = await register({ username: unique('r'), password: 'a-good-password' });
    assert.equal(without.status, 403);
    assert.equal(without.body.code, 'INVITE_REQUIRED');
    const bogus = await register({ username: unique('r'), password: 'a-good-password', invite_code: 'nope-nope' });
    assert.equal(bogus.body.code, 'INVITE_REQUIRED');
    const withInvite = await register({ username: unique('r'), password: 'a-good-password', invite_code: code });
    assert.equal(withInvite.status, 201);

    await as(adminAcct, 'PUT', '/api/admin/registration', { mode: 'closed' });
    const closed = await register({ username: unique('r'), password: 'a-good-password', invite_code: code });
    assert.equal(closed.body.code, 'REGISTRATION_CLOSED');

    const reset = await as(adminAcct, 'PUT', '/api/admin/registration', { mode: 'default' });
    assert.equal(reset.body.mode, 'open');
    assert.equal(reset.body.source, 'default');
    const audit = (await as(adminAcct, 'GET', '/api/admin/audit-log')).body;
    assert.ok(audit.filter((a) => a.action === 'registration_mode').length >= 3);
  });

  test('invite sign-ups draw on their own budget, with a friendly wait time', async () => {
    const invite = await api('POST', '/api/servers/server-1/invites', { maxUses: 0 }, { 'x-user-id': 'user-me' });
    const code = invite.body.code;
    // Budget of 3 per hour (set above); the previous test used one.
    let limited = null;
    for (let i = 0; i < 4 && !limited; i += 1) {
      const res = await register({ username: unique('i'), password: 'a-good-password', invite_code: code });
      if (res.status === 429) limited = res;
    }
    assert.ok(limited, 'the invite bucket ran out');
    assert.equal(limited.body.code, 'REGISTER_RATE_LIMITED');
    assert.ok(limited.body.details.minutes >= 1);
    assert.match(limited.body.error, /Try again in \d+ minute/);
    // …while plain sign-ups still have their own budget.
    assert.equal((await register({ username: unique('p'), password: 'a-good-password' })).status, 201);
  });
});

describe('2FA step-up', () => {
  test('an old session must re-enter the password to begin enrolment', async () => {
    const a = await account();
    await sqlRun(`UPDATE sessions SET created_at = ? WHERE user_id = ?`,
      [new Date(Date.now() - 60 * 60_000).toISOString(), a.id]);
    const noPassword = await as(a, 'POST', '/api/auth/mfa/begin');
    assert.equal(noPassword.status, 401);
    assert.equal(noPassword.body.code, 'PASSWORD_REQUIRED');
    const wrong = await as(a, 'POST', '/api/auth/mfa/begin', { password: 'wrong-password' });
    assert.equal(wrong.body.code, 'PASSWORD_REQUIRED');
    const ok = await as(a, 'POST', '/api/auth/mfa/begin', { password: 'a-good-password' });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.secret);
  });
});
