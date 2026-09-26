#!/usr/bin/env node
// ============================================================================
//  Admin & moderation polish (schema v41–v42).
//
//  Categories (create, delete keeps children, category overwrites that stay in
//  step with synced children), localised default channels and built-in
//  templates, new roles at the bottom, an audit log that names its target,
//  AutoMod normalisation / presets / alerts / validation, raid protection
//  defaults, lockdown refusals and join-spike alerts, ban message cleanup, and
//  recurring events. Runs against SQLite and PostgreSQL (npm run test:pg).
// ============================================================================

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { startServer, stopServer, BASE } from './testHarness.mjs';

before(startServer);
after(stopServer);

const as = (userId) => ({ 'x-user-id': userId });

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

async function makeUser(prefix, { locale = null } = {}) {
  const { runQuery } = await db();
  const id = `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
  await runQuery(`INSERT INTO users (id, username, display_name, email) VALUES (?, ?, ?, ?)`,
    [id, id, id, `${id}@example.test`]);
  if (locale) await runQuery(`UPDATE users SET locale = ? WHERE id = ?`, [locale, id]);
  return id;
}

async function makeServer(owner, name = 'Admin polish') {
  const res = await api('POST', '/api/servers', { name }, as(owner));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.id;
}

async function join(serverId, owner, userId) {
  const invite = await api('POST', `/api/servers/${serverId}/invites`, { maxAge: 0 }, as(owner));
  assert.equal(invite.status, 200, JSON.stringify(invite.body));
  return api('POST', `/api/invites/${invite.body.code}/accept`, undefined, as(userId));
}

const detail = async (serverId, userId) => (await api('GET', `/api/servers/${serverId}`, undefined, as(userId))).body;
const send = (userId, channelId, content) => api('POST', '/api/messages', { channel_id: channelId, content }, as(userId));
const VIEW = String(1n << 10n);
const SEND = String(1n << 11n);

describe('localised defaults and built-in templates', () => {
  test('a new server is named in the creator\'s saved language', async () => {
    const owner = await makeUser('th', { locale: 'th' });
    const serverId = await makeServer(owner);
    const d = await detail(serverId, owner);
    assert.deepEqual(d.categories.map((c) => c.name).sort(), ['ช่องข้อความ', 'ช่องเสียง'].sort());
    assert.ok(d.channels.some((c) => c.name === 'ทั่วไป' && c.type === 'text'));
    assert.ok(d.channels.some((c) => c.type === 'voice' && c.category === 'ช่องเสียง'));
  });

  test('the schema default locale (th-TH, never chosen) keeps English names', async () => {
    const owner = await makeUser('df');
    const d = await detail(await makeServer(owner), owner);
    assert.ok(d.channels.some((c) => c.name === 'general'));
    assert.ok(d.categories.some((c) => c.name === 'TEXT CHANNELS'));
  });

  test('new servers get raid protection on, with screening as the response', async () => {
    const owner = await makeUser('rd');
    const serverId = await makeServer(owner);
    const raid = await api('GET', `/api/servers/${serverId}/raid`, undefined, as(owner));
    assert.equal(raid.status, 200);
    assert.equal(raid.body.enabled, true);
    assert.equal(raid.body.action, 'screen');
    assert.equal(raid.body.join_threshold, 20);
  });

  test('built-in templates preview and create localised servers', async () => {
    const owner = await makeUser('tp');
    const preview = await api('GET', '/api/templates/builtin-gaming-th', undefined, as(owner));
    assert.equal(preview.status, 200, JSON.stringify(preview.body));
    assert.ok(preview.body.preview.channels.some((c) => c.name === 'หาทีม'));
    const created = await api('POST', '/api/templates/builtin-club-en/servers', { name: 'Class 5B' }, as(owner));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.server.name, 'Class 5B');
    assert.ok(created.body.channels.some((c) => c.name === 'homework-help' && c.type === 'forum'));
    assert.ok(created.body.roles.some((r) => r.name === 'Teacher'));
    // Announcements are read-only for @everyone out of the box.
    const ann = created.body.channels.find((c) => c.name === 'announcements');
    const { allQuery } = await db();
    const ow = await allQuery(`SELECT * FROM channel_overwrites WHERE channel_id = ?`, [ann.id]);
    assert.equal(ow.length, 1);
    assert.equal(ow[0].deny, SEND);
    const raid = await api('GET', `/api/servers/${created.body.server.id}/raid`, undefined, as(owner));
    assert.equal(raid.body.enabled, true);
    assert.equal((await api('GET', '/api/templates/builtin-nope', undefined, as(owner))).status, 404);
  });
});

describe('categories', () => {
  let owner; let serverId;
  before(async () => { owner = await makeUser('cat'); serverId = await makeServer(owner); });

  test('create a category, put a channel in it, delete it: the channel survives at the top', async () => {
    const cat = await api('POST', '/api/channels', { server_id: serverId, name: 'Games', type: 'category' }, as(owner));
    assert.equal(cat.status, 200, JSON.stringify(cat.body));
    assert.equal(cat.body.type, 'category');
    assert.equal(cat.body.parent_id, null);
    const child = await api('POST', '/api/channels', { server_id: serverId, name: 'ข่าวสาร อัปเดต', parent_id: cat.body.id }, as(owner));
    assert.equal(child.status, 200);
    assert.equal(child.body.name, 'ข่าวสาร-อัปเดต');
    assert.equal(child.body.category, 'Games');

    const del = await api('DELETE', `/api/channels/${cat.body.id}`, undefined, as(owner));
    assert.equal(del.status, 200);
    const d = await detail(serverId, owner);
    const moved = d.channels.find((c) => c.id === child.body.id);
    assert.ok(moved, 'child channel still exists');
    assert.equal(moved.parent_id, null);
    assert.equal(moved.category, null);
    assert.ok(!d.categories.some((c) => c.id === cat.body.id));
  });

  test('category overwrites follow into synced children only', async () => {
    const cat = (await api('POST', '/api/channels', { server_id: serverId, name: 'Staff', type: 'category' }, as(owner))).body;
    const a = (await api('POST', '/api/channels', { server_id: serverId, name: 'synced', parent_id: cat.id }, as(owner))).body;
    const b = (await api('POST', '/api/channels', { server_id: serverId, name: 'custom', parent_id: cat.id }, as(owner))).body;
    // b gets its own overwrite, so it is no longer synced.
    let r = await api('PUT', `/api/channels/${b.id}/permissions/role/${serverId}`, { allow: '0', deny: SEND }, as(owner));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await api('PUT', `/api/channels/${cat.id}/permissions/role/${serverId}`, { allow: '0', deny: VIEW }, as(owner));
    assert.equal(r.status, 200, JSON.stringify(r.body));

    const { allQuery } = await db();
    const owA = await allQuery(`SELECT * FROM channel_overwrites WHERE channel_id = ?`, [a.id]);
    const owB = await allQuery(`SELECT * FROM channel_overwrites WHERE channel_id = ?`, [b.id]);
    assert.equal(owA.length, 1);
    assert.equal(owA[0].deny, VIEW, 'synced child follows the category');
    assert.equal(owB[0].deny, SEND, 'customised child is left alone');

    const d = await detail(serverId, owner);
    assert.equal(d.channels.find((c) => c.id === a.id).permissions_synced, true);
    assert.equal(d.channels.find((c) => c.id === b.id).permissions_synced, false);
    assert.equal(d.categories.find((c) => c.id === cat.id).is_private, true);

    // Removing the category overwrite also clears it on the synced child.
    r = await api('DELETE', `/api/channels/${cat.id}/permissions/role/${serverId}`, undefined, as(owner));
    assert.equal(r.status, 200);
    assert.equal((await allQuery(`SELECT * FROM channel_overwrites WHERE channel_id = ?`, [a.id])).length, 0);
    // Re-sync b.
    r = await api('POST', `/api/channels/${b.id}/permissions/sync`, undefined, as(owner));
    assert.equal(r.status, 200);
    assert.equal((await detail(serverId, owner)).channels.find((c) => c.id === b.id).permissions_synced, true);
  });

  test('an overwrite for a role from another server is refused', async () => {
    const other = await makeServer(owner, 'Other');
    const ch = (await detail(serverId, owner)).channels[0];
    const r = await api('PUT', `/api/channels/${ch.id}/permissions/role/${other}`, { allow: VIEW, deny: '0' }, as(owner));
    assert.equal(r.status, 404);
  });

  test('keyboard/drag reorder moves a channel between categories', async () => {
    const d = await detail(serverId, owner);
    const [first, second] = d.categories;
    const ch = d.channels.find((c) => c.parent_id === first.id);
    const order = [
      ...d.categories.map((c) => ({ id: c.id, parent_id: null })),
      ...d.channels.map((c) => ({ id: c.id, parent_id: c.id === ch.id ? second.id : c.parent_id }))
    ];
    const r = await api('PATCH', `/api/servers/${serverId}/channels/order`, { order }, as(owner));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await detail(serverId, owner)).channels.find((c) => c.id === ch.id).parent_id, second.id);
  });
});

describe('roles and audit log', () => {
  test('a new role is created at the bottom, just above @everyone', async () => {
    const owner = await makeUser('rl');
    const serverId = await makeServer(owner);
    const a = await api('POST', `/api/servers/${serverId}/roles`, { name: 'First' }, as(owner));
    const b = await api('POST', `/api/servers/${serverId}/roles`, { name: 'Second' }, as(owner));
    assert.equal(a.status, 200); assert.equal(b.status, 200);
    const roles = (await detail(serverId, owner)).roles;
    const pos = Object.fromEntries(roles.map((r) => [r.name, r.position]));
    assert.equal(pos.Second, 1);
    assert.equal(pos.First, 2);
    assert.equal(pos['@everyone'], 0);
  });

  test('a two-colour role reaches the member list as a gradient', async () => {
    const owner = await makeUser('gr');
    const member = await makeUser('grm');
    const serverId = await makeServer(owner);
    await join(serverId, owner, member);
    const role = await api('POST', `/api/servers/${serverId}/roles`, { name: 'Shiny', color: '#ff0000' }, as(owner));
    const patched = await api('PATCH', `/api/servers/${serverId}/roles/${role.body.id}`, { color_secondary: '#0000ff' }, as(owner));
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    assert.equal((await api('PUT', `/api/servers/${serverId}/members/${member}/roles/${role.body.id}`, undefined, as(owner))).status, 200);
    const m = (await detail(serverId, owner)).members.find((x) => x.id === member);
    assert.equal(m.role_color, '#ff0000');
    assert.equal(m.role_color_secondary, '#0000ff');
    assert.equal(m.roles.find((r) => r.id === role.body.id).color_secondary, '#0000ff');
  });

  test('audit entries name their target, and can be filtered', async () => {
    const owner = await makeUser('au');
    const victim = await makeUser('victim');
    const serverId = await makeServer(owner);
    assert.equal((await join(serverId, owner, victim)).status, 200);
    const ban = await api('POST', `/api/servers/${serverId}/bans/${victim}`, { reason: 'raid' }, as(owner));
    assert.equal(ban.status, 200);
    const log = await api('GET', `/api/servers/${serverId}/audit-log`, undefined, as(owner));
    assert.equal(log.status, 200);
    const entry = log.body.find((e) => e.action_type === 'MEMBER_BAN_ADD');
    assert.equal(entry.target.type, 'user');
    assert.equal(entry.target.id, victim);
    assert.equal(entry.target.name, victim);
    assert.equal(entry.user_id, owner);

    const { listAuditLog } = await import('../services/guilds.js');
    const bans = await listAuditLog(serverId, { actionType: 'MEMBER_BAN_ADD' });
    assert.ok(bans.length >= 1 && bans.every((e) => e.action_type === 'MEMBER_BAN_ADD'));
    const channelOnes = await listAuditLog(serverId, { actionType: 'CHANNEL_*' });
    assert.ok(channelOnes.every((e) => e.action_type.startsWith('CHANNEL_')));
    const byActor = await listAuditLog(serverId, { userId: 'nobody' });
    assert.equal(byActor.length, 0);
  });

  test('ban can delete the member\'s recent messages', async () => {
    const owner = await makeUser('bo');
    const spammer = await makeUser('spam');
    const serverId = await makeServer(owner);
    await join(serverId, owner, spammer);
    const general = (await detail(serverId, owner)).channels.find((c) => c.type === 'text');
    const m = await send(spammer, general.id, 'buy cheap stuff');
    assert.equal(m.status, 200, JSON.stringify(m.body));
    await api('POST', `/api/servers/${serverId}/bans/${spammer}`, { deleteMessageSeconds: 3600 }, as(owner));
    const { getQuery } = await db();
    const row = await getQuery(`SELECT deleted_at FROM messages WHERE id = ?`, [m.body.id]);
    assert.ok(row.deleted_at, 'message removed with the ban');
  });
});

describe('automod', () => {
  let owner; let member; let serverId; let general; let alerts;
  before(async () => {
    owner = await makeUser('am');
    member = await makeUser('amm');
    serverId = await makeServer(owner);
    assert.equal((await join(serverId, owner, member)).status, 200);
    general = (await detail(serverId, owner)).channels.find((c) => c.type === 'text');
    alerts = (await api('POST', '/api/channels', { server_id: serverId, name: 'mod-alerts' }, as(owner))).body;
  });

  test('empty or nameless rules are refused', async () => {
    let r = await api('POST', `/api/servers/${serverId}/automod`, { name: 'x', trigger_type: 'keyword', trigger_metadata: { keywords: [' '] }, actions: ['block'] }, as(owner));
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'EMPTY_RULE');
    r = await api('POST', `/api/servers/${serverId}/automod`, { name: '  ', trigger_type: 'spam', actions: ['block'] }, as(owner));
    assert.equal(r.status, 400);
    r = await api('POST', `/api/servers/${serverId}/automod`, { name: 'bad', trigger_type: 'keyword', trigger_metadata: { keywords: ['x'], alert_channel_id: 'nope' }, actions: ['alert'] }, as(owner));
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'INVALID_ALERT_CHANNEL');
  });

  test('keyword filter sees through zero-width, spacing, leetspeak and Thai tone marks', async () => {
    const rule = await api('POST', `/api/servers/${serverId}/automod`, {
      name: 'words', trigger_type: 'keyword', trigger_metadata: { keywords: ['ควย', 'scam'] }, actions: ['block']
    }, as(owner));
    assert.equal(rule.status, 200, JSON.stringify(rule.body));
    for (const text of ['ค​วย', 'ค ว ย', 'คว่ย', 'this is a sc4m', 's c a m', 'S̶C̶A̶M̶']) {
      const r = await send(member, general.id, text);
      assert.equal(r.status, 403, `${JSON.stringify(text)} got through`);
      assert.equal(r.body.code, 'AUTOMOD_BLOCKED');
    }
    assert.equal((await send(member, general.id, 'ข่าวสาร อัปเดต วันนี้')).status, 200);
    await api('DELETE', `/api/servers/${serverId}/automod/${rule.body.id}`, undefined, as(owner));
  });

  test('presets expand server-side and honour the allow-list', async () => {
    const rule = await api('POST', `/api/servers/${serverId}/automod`, {
      name: 'invites', trigger_type: 'keyword',
      trigger_metadata: { presets: ['invite_links', 'not-a-preset'], allow_list: ['discord.gg/ourserver'] }, actions: ['block']
    }, as(owner));
    assert.equal(rule.status, 200, JSON.stringify(rule.body));
    assert.deepEqual(rule.body.trigger_metadata.presets, ['invite_links']);
    assert.equal((await send(member, general.id, 'join discord.gg/freestuff')).status, 403);
    assert.equal((await send(member, general.id, 'our link: discord.gg/ourserver')).status, 200);
    await api('DELETE', `/api/servers/${serverId}/automod/${rule.body.id}`, undefined, as(owner));
  });

  test('@everyone and @here count as mentions', async () => {
    const rule = await api('POST', `/api/servers/${serverId}/automod`, {
      name: 'mentions', trigger_type: 'mention_spam', trigger_metadata: { max_mentions: 3 }, actions: ['block']
    }, as(owner));
    assert.equal(rule.status, 200);
    assert.equal((await send(member, general.id, '@everyone @everyone @here @everyone')).status, 403);
    assert.equal((await send(member, general.id, '@everyone hi')).status, 200);
    await api('DELETE', `/api/servers/${serverId}/automod/${rule.body.id}`, undefined, as(owner));
  });

  test('"alert" posts into the chosen channel and does not hide a blocking rule', async () => {
    const alertRule = await api('POST', `/api/servers/${serverId}/automod`, {
      name: 'watch', trigger_type: 'keyword', trigger_metadata: { keywords: ['giveaway'], alert_channel_id: alerts.id }, actions: ['alert']
    }, as(owner));
    assert.equal(alertRule.status, 200, JSON.stringify(alertRule.body));
    const blockRule = await api('POST', `/api/servers/${serverId}/automod`, {
      name: 'block links', trigger_type: 'link', trigger_metadata: {}, actions: ['block']
    }, as(owner));
    assert.equal(blockRule.status, 200);

    // Alert only: the message goes through, the moderators hear about it.
    assert.equal((await send(member, general.id, 'big giveaway tonight')).status, 200);
    // Alert + block: blocked, and still alerted.
    assert.equal((await send(member, general.id, 'giveaway at https://evil.example')).status, 403);

    const msgs = await api('GET', `/api/messages/${alerts.id}`, undefined, as(owner));
    assert.equal(msgs.status, 200);
    const list = Array.isArray(msgs.body) ? msgs.body : msgs.body.messages;
    const texts = list.map((m) => m.content).join('\n');
    assert.match(texts, /AutoMod flagged a message/);
    assert.match(texts, /AutoMod blocked a message/);
    assert.ok(list.every((m) => m.embeds?.length === 1));

    const log = (await api('GET', `/api/servers/${serverId}/audit-log`, undefined, as(owner))).body;
    assert.ok(log.some((e) => e.action_type === 'AUTOMOD_ALERT'));
    assert.ok(log.some((e) => e.action_type === 'AUTOMOD_BLOCK'));
  });
});

describe('raid tools', () => {
  test('a manual lockdown refuses joins and counts the refusals', async () => {
    const owner = await makeUser('lk');
    const serverId = await makeServer(owner);
    await api('PATCH', `/api/servers/${serverId}/raid`, { enabled: false }, as(owner));
    const invite = await api('POST', `/api/servers/${serverId}/invites`, { maxAge: 0 }, as(owner));
    await api('POST', `/api/servers/${serverId}/raid/lockdown`, { reason: 'test' }, as(owner));
    for (let i = 0; i < 2; i += 1) {
      const late = await makeUser('late');
      const r = await api('POST', `/api/invites/${invite.body.code}/accept`, undefined, as(late));
      assert.equal(r.status, 403);
      assert.equal(r.body.code, 'SERVER_LOCKDOWN');
    }
    const raid = await api('GET', `/api/servers/${serverId}/raid`, undefined, as(owner));
    assert.equal(raid.body.lockdown.joins, 2);
  });

  test('a join spike alerts the moderators in the alert channel', async () => {
    const owner = await makeUser('sp');
    const serverId = await makeServer(owner);
    const alerts = (await api('POST', '/api/channels', { server_id: serverId, name: 'mods' }, as(owner))).body;
    let r = await api('PATCH', `/api/servers/${serverId}/raid`, { join_threshold: 3, join_window_secs: 60, action: 'screen', alert_channel_id: alerts.id }, as(owner));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.alert_channel_id, alerts.id);
    r = await api('PATCH', `/api/servers/${serverId}/raid`, { alert_channel_id: 'nope' }, as(owner));
    assert.equal(r.status, 400);

    for (let i = 0; i < 3; i += 1) {
      const u = await makeUser('raider');
      assert.equal((await join(serverId, owner, u)).status, 200);
    }
    const msgs = (await api('GET', `/api/messages/${alerts.id}`, undefined, as(owner))).body;
    const list = Array.isArray(msgs) ? msgs : msgs.messages;
    assert.ok(list.some((m) => /Join spike/.test(m.content)), 'spike alert posted');
    const raid = (await api('GET', `/api/servers/${serverId}/raid`, undefined, as(owner))).body;
    assert.ok(raid.joins_last_10_min >= 3);
    const log = (await api('GET', `/api/servers/${serverId}/audit-log`, undefined, as(owner))).body;
    assert.ok(log.some((e) => e.action_type === 'RAID_DETECTED'));
  });
});

describe('recurring events', () => {
  test('next-occurrence arithmetic (monthly clamps to the month end)', async () => {
    const { nextOccurrence } = await import('../services/events.js');
    assert.equal(nextOccurrence('2026-01-31T10:00:00.000Z', 'monthly'), '2026-02-28T10:00:00.000Z');
    assert.equal(nextOccurrence('2026-01-01T10:00:00.000Z', 'weekly'), '2026-01-08T10:00:00.000Z');
    assert.equal(nextOccurrence('2026-01-01T10:00:00.000Z', 'biweekly'), '2026-01-15T10:00:00.000Z');
    assert.equal(nextOccurrence('2026-01-01T10:00:00.000Z', 'daily'), '2026-01-02T10:00:00.000Z');
  });

  test('a weekly event creates its next occurrence when it ends, until the end date', async () => {
    const owner = await makeUser('ev');
    const serverId = await makeServer(owner);
    const start = new Date(Date.now() + 3600_000);
    const bad = await api('POST', `/api/servers/${serverId}/events`, {
      name: 'Class', location: 'Room 5', starts_at: start.toISOString(), recurrence: 'hourly'
    }, as(owner));
    assert.equal(bad.status, 400);

    const created = await api('POST', `/api/servers/${serverId}/events`, {
      name: 'History class', location: 'Room 5', starts_at: start.toISOString(),
      ends_at: new Date(start.getTime() + 3600_000).toISOString(),
      recurrence: 'weekly', recurrence_until: new Date(start.getTime() + 8 * 24 * 3600_000).toISOString()
    }, as(owner));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.recurrence, 'weekly');
    assert.equal(created.body.series_id, created.body.id);

    // Pretend the first class already happened.
    const { runQuery } = await db();
    const past = new Date(Date.now() - 2 * 3600_000);
    await runQuery(`UPDATE scheduled_events SET starts_at = ?, ends_at = ? WHERE id = ?`,
      [past.toISOString(), new Date(past.getTime() + 3600_000).toISOString(), created.body.id]);
    const list = await api('GET', `/api/servers/${serverId}/events`, undefined, as(owner));
    assert.equal(list.status, 200);
    const next = list.body.filter((e) => e.series_id === created.body.id);
    assert.equal(next.length, 1, 'exactly one upcoming occurrence');
    assert.equal(next[0].recurrence, 'weekly');
    assert.ok(new Date(next[0].starts_at) > new Date());
    assert.equal(next[0].interested, true, 'interest carries over');

    // The occurrence after that would fall past recurrence_until: the series ends.
    const nextStart = new Date(Date.now() - 2 * 3600_000);
    await runQuery(`UPDATE scheduled_events SET starts_at = ?, ends_at = ?, recurrence_until = ? WHERE id = ?`,
      [nextStart.toISOString(), new Date(nextStart.getTime() + 3600_000).toISOString(),
       new Date(Date.now() + 3600_000).toISOString(), next[0].id]);
    const after = await api('GET', `/api/servers/${serverId}/events`, undefined, as(owner));
    assert.equal(after.body.filter((e) => e.series_id === created.body.id).length, 0);
  });
});
