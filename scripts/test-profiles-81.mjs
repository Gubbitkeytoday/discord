#!/usr/bin/env node
// ============================================================================
//  Profiles (schema v44–v45): cosmetics catalogue and equip, the SVG
//  sanitiser for admin packs, custom status expiry, bio length / markdown
//  safety, name styles and profile themes, server tags with AutoMod and the
//  reserved list, badges, per-server cosmetics toggle, moderator reset with
//  audit log, profile reports with a snapshot, and permission checks.
//  Runs against SQLite and PostgreSQL (npm run test:pg).
// ============================================================================

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

process.env.STATUS_SWEEP_MS ??= '5000';
const { startServer, stopServer, BASE } = await import('./testHarness.mjs');

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
  return { status: res.status, body: json, headers: res.headers };
}

const db = () => import('../db.js');

async function makeUser(prefix, { admin = false, bot = false } = {}) {
  const { runQuery } = await db();
  const id = `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
  await runQuery(`INSERT INTO users (id, username, display_name, email) VALUES (?, ?, ?, ?)`,
    [id, id, id, `${id}@example.test`]);
  if (admin) await runQuery(`UPDATE users SET instance_admin = 1 WHERE id = ?`, [id]);
  if (bot) await runQuery(`UPDATE users SET is_bot = 1 WHERE id = ?`, [id]);
  return id;
}

async function makeServer(owner, name = 'Profiles') {
  const res = await api('POST', '/api/servers', { name }, as(owner));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.id;
}

async function join(serverId, owner, userId) {
  const invite = await api('POST', `/api/servers/${serverId}/invites`, { maxAge: 0 }, as(owner));
  assert.equal(invite.status, 200, JSON.stringify(invite.body));
  const res = await api('POST', `/api/invites/${invite.body.code}/accept`, undefined, as(userId));
  assert.equal(res.status, 200, JSON.stringify(res.body));
}

const identity = async (viewer, userId, serverId = null) => {
  const q = serverId ? `&server_id=${serverId}` : '';
  const res = await api('GET', `/api/identities?ids=${userId}${q}`, undefined, as(viewer));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body[userId];
};

// ---------------------------------------------------------------------------

describe('cosmetics catalogue and equipping', () => {
  test('the built-in pack has the promised items, including a Thai set', async () => {
    const me = await makeUser('cat');
    const res = await api('GET', '/api/cosmetics', undefined, as(me));
    assert.equal(res.status, 200);
    const count = (kind) => res.body.items.filter((i) => i.kind === kind).length;
    assert.ok(count('avatar_decoration') >= 8);
    assert.ok(count('profile_effect') >= 5);
    assert.ok(count('nameplate') >= 6);
    assert.ok(count('profile_frame') >= 3);
    const thai = res.body.items.filter((i) => i.tags.includes('thai')).map((i) => i.slug);
    for (const slug of ['lotus', 'kranok', 'songkran', 'krathong', 'elephant']) assert.ok(thai.includes(slug), slug);
    assert.ok(res.body.items.every((i) => i.asset_url.startsWith('/cosmetics/') && i.builtin));
    assert.equal((await api('GET', '/api/cosmetics')).status, 401, 'signed-in only');
  });

  test('equip, wrong kind, unknown item, unequip', async () => {
    const me = await makeUser('eq');
    const deco = 'builtin-deco-lotus';
    let res = await api('PUT', '/api/cosmetics/@me', { avatar_decoration: deco, nameplate: 'builtin-plate-kranok' }, as(me));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.equipped.avatar_decoration.id, deco);
    assert.equal(res.body.equipped.nameplate.slug, 'kranok');

    res = await api('PUT', '/api/cosmetics/@me', { avatar_decoration: 'builtin-effect-confetti' }, as(me));
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'WRONG_COSMETIC_KIND');
    res = await api('PUT', '/api/cosmetics/@me', { profile_effect: 'nope' }, as(me));
    assert.equal(res.status, 404);
    res = await api('PUT', '/api/cosmetics/@me', { hat: 'x' }, as(me));
    assert.equal(res.status, 200, 'unknown keys are ignored');

    const other = await makeUser('eqv');
    const id = await identity(other, me);
    assert.equal(id.decoration.id, deco);
    assert.equal(id.nameplate.slug, 'kranok');

    res = await api('PUT', '/api/cosmetics/@me', { avatar_decoration: null }, as(me));
    assert.equal(res.body.equipped.avatar_decoration, null);
    assert.equal((await identity(other, me)).decoration, null);
  });

  test('per-server overrides, inherit, and the server-wide hide toggle', async () => {
    const owner = await makeUser('own');
    const member = await makeUser('mem');
    const serverId = await makeServer(owner);
    await join(serverId, owner, member);
    await api('PUT', '/api/cosmetics/@me', { avatar_decoration: 'builtin-deco-orbit' }, as(member));
    let res = await api('PUT', `/api/cosmetics/@me?server_id=${serverId}`, { avatar_decoration: 'builtin-deco-kranok' }, as(member));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await identity(owner, member, serverId)).decoration.slug, 'kranok');
    assert.equal((await identity(owner, member)).decoration.slug, 'orbit');

    res = await api('PUT', `/api/cosmetics/@me?server_id=${serverId}`, { avatar_decoration: 'inherit' }, as(member));
    assert.equal((await identity(owner, member, serverId)).decoration.slug, 'orbit');

    const outsider = await makeUser('out');
    res = await api('PUT', `/api/cosmetics/@me?server_id=${serverId}`, { avatar_decoration: 'builtin-deco-kranok' }, as(outsider));
    assert.equal(res.status, 403);

    // Only MANAGE_GUILD may hide cosmetics for the whole server.
    res = await api('PATCH', `/api/servers/${serverId}/cosmetics-settings`, { cosmetics_hidden: true }, as(member));
    assert.equal(res.status, 403);
    res = await api('PATCH', `/api/servers/${serverId}/cosmetics-settings`, { cosmetics_hidden: true, new_member_badge_days: 3 }, as(owner));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body, { cosmetics_hidden: true, new_member_badge_days: 3 });
    const hidden = await identity(owner, member, serverId);
    assert.equal(hidden.decoration, null);
    assert.equal(hidden.cosmetics_hidden, true);
    assert.equal((await identity(owner, member)).decoration.slug, 'orbit', 'still shown outside that server');
    res = await api('PATCH', `/api/servers/${serverId}/cosmetics-settings`, { new_member_badge_days: 99 }, as(owner));
    assert.equal(res.status, 400);
    const { allQuery } = await db();
    const logs = await allQuery(`SELECT action_type FROM audit_logs WHERE server_id = ? AND action_type = 'SERVER_COSMETICS_UPDATE'`, [serverId]);
    assert.equal(logs.length, 1);
  });
});

// ---------------------------------------------------------------------------

describe('admin packs and the SVG sanitiser', () => {
  const GOOD = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120"><defs><linearGradient id="g"><stop offset="0" stop-color="#f0c"/></linearGradient></defs><style>.r{animation:spin 4s linear infinite;transform-origin:60px 60px}@keyframes spin{to{transform:rotate(1turn)}}</style><circle class="r" cx="60" cy="60" r="55" fill="none" stroke="url(#g)" stroke-width="4"/><!-- comment --><metadata><rdf:RDF/></metadata></svg>';
  const MALICIOUS = {
    script: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    onload: '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="1" height="1"/></svg>',
    onclickUpper: '<svg xmlns="http://www.w3.org/2000/svg"><rect ONCLICK="alert(1)" width="1" height="1"/></svg>',
    remoteHref: '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="https://evil.test/x.svg#a"/></svg>',
    jsHref: '<svg xmlns="http://www.w3.org/2000/svg"><use href="javascript:alert(1)"/></svg>',
    cssUrl: '<svg xmlns="http://www.w3.org/2000/svg"><style>rect{fill:url(https://evil.test/p.png)}</style><rect width="1" height="1"/></svg>',
    styleAttrUrl: '<svg xmlns="http://www.w3.org/2000/svg"><rect style="background:url(//evil.test/x)" width="1" height="1"/></svg>',
    cssImport: '<svg xmlns="http://www.w3.org/2000/svg"><style>@import "https://evil.test/a.css";</style></svg>',
    cssEscape: '<svg xmlns="http://www.w3.org/2000/svg"><style>rect{fill:u\\72l(https://evil.test/)}</style></svg>',
    foreignObject: '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject></svg>',
    image: '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://evil.test/a.png"/></svg>',
    smil: '<svg xmlns="http://www.w3.org/2000/svg"><a><animate attributeName="href" values="javascript:alert(1)"/></a></svg>',
    entity: '<!DOCTYPE svg [<!ENTITY x "y">]><svg xmlns="http://www.w3.org/2000/svg">&x;</svg>',
    fillUrl: '<svg xmlns="http://www.w3.org/2000/svg"><rect fill="url(https://evil.test/#g)" width="1" height="1"/></svg>',
    fastFlash: '<svg xmlns="http://www.w3.org/2000/svg"><style>.a{animation:blink 0.1s infinite}</style></svg>',
    notSvg: '<html><body>hi</body></html>'
  };

  test('the sanitiser keeps safe art and rejects every malicious payload', async () => {
    const { sanitizeSvg } = await import('../services/cosmetics.js');
    const clean = sanitizeSvg(GOOD);
    assert.match(clean, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/);
    assert.ok(clean.includes('@keyframes spin'));
    assert.ok(!clean.includes('metadata') && !clean.includes('comment'), 'editor noise dropped');
    for (const [name, payload] of Object.entries(MALICIOUS)) {
      assert.throws(() => sanitizeSvg(payload), (err) => err.code === 'SVG_UNSAFE', name);
    }
  });

  test('pack upload is admin-only, validated, served locked-down, and can be disabled', async () => {
    const admin = await makeUser('adm', { admin: true });
    const user = await makeUser('usr');
    const pack = { slug: `pack-${crypto.randomBytes(3).toString('hex')}`, name: 'Test pack', items: [
      { kind: 'avatar_decoration', slug: 'ring', name: 'Ring', svg: GOOD }
    ] };
    let res = await api('POST', '/api/admin/cosmetic-packs', pack, as(user));
    assert.equal(res.status, 403);

    for (const [name, payload] of Object.entries(MALICIOUS).slice(0, 6)) {
      res = await api('POST', '/api/admin/cosmetic-packs', { ...pack, slug: `${pack.slug}-${name.toLowerCase()}`, items: [{ kind: 'nameplate', slug: 'x', name: 'x', svg: payload }] }, as(admin));
      assert.equal(res.status, 400, name);
      assert.equal(res.body.code, 'SVG_UNSAFE', name);
    }
    res = await api('POST', '/api/admin/cosmetics/validate-svg', { svg: MALICIOUS.foreignObject }, as(admin));
    assert.equal(res.status, 400);

    // A PNG that is really text is refused.
    res = await api('POST', '/api/admin/cosmetic-packs', { ...pack, slug: `${pack.slug}-png`, items: [{ kind: 'nameplate', slug: 'p', name: 'p', image: { type: 'image/png', data: Buffer.from('<svg/>').toString('base64') } }] }, as(admin));
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'INVALID_IMAGE');

    res = await api('POST', '/api/admin/cosmetic-packs', pack, as(admin));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const item = res.body.items[0];
    assert.equal(item.asset_url, `/api/cosmetics/items/${item.id}/asset`);

    const asset = await fetch(`${BASE}${item.asset_url}`);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get('content-type'), 'image/svg+xml');
    assert.match(asset.headers.get('content-security-policy'), /default-src 'none'.*sandbox/);
    assert.equal(asset.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(!(await asset.text()).includes('<!--'));

    res = await api('PUT', '/api/cosmetics/@me', { avatar_decoration: item.id }, as(user));
    assert.equal(res.status, 200);
    // Disabling the pack removes the item from the catalogue and unequips it.
    res = await api('PATCH', `/api/admin/cosmetic-packs/${res.body.equipped.avatar_decoration.pack_id}`, { enabled: false }, as(admin));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const cat = await api('GET', '/api/cosmetics', undefined, as(user));
    assert.ok(!cat.body.items.some((i) => i.id === item.id));
    assert.equal((await api('GET', '/api/cosmetics/@me', undefined, as(user))).body.equipped.avatar_decoration, null);

    res = await api('DELETE', '/api/admin/cosmetic-packs/builtin-core', undefined, as(admin));
    assert.equal(res.status, 403, 'the built-in pack cannot be deleted');
    const { allQuery } = await db();
    const log = await allQuery(`SELECT action FROM instance_audit_log WHERE action LIKE 'cosmetic_pack.%'`);
    assert.ok(log.length >= 2);
  });
});

// ---------------------------------------------------------------------------

describe('custom status with expiry', () => {
  test('presets set an absolute expiry; invalid input is refused', async () => {
    const me = await makeUser('st');
    const t0 = Date.now();
    let res = await api('PUT', '/api/profiles/@me/custom-status', { text: 'Lunch', emoji: '🍜', clear_after: '30m' }, as(me));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const at = new Date(res.body.custom_status_expires_at).getTime();
    assert.ok(at >= t0 + 29 * 60e3 && at <= Date.now() + 31 * 60e3);
    assert.equal(res.body.custom_status_emoji, '🍜');

    res = await api('PUT', '/api/profiles/@me/custom-status', { text: 'x', clear_after: '2d' }, as(me));
    assert.equal(res.status, 400);
    res = await api('PUT', '/api/profiles/@me/custom-status', { text: 'x', clear_after: 'today' }, as(me));
    assert.equal(res.status, 400, 'today needs the client midnight');
    res = await api('PUT', '/api/profiles/@me/custom-status', { text: 'x', clear_after: 'today', expires_at: new Date(Date.now() + 3 * 86400e3).toISOString() }, as(me));
    assert.equal(res.status, 400, 'at most a day away');
    res = await api('PUT', '/api/profiles/@me/custom-status', { text: 'x', clear_after: 'today', expires_at: new Date(Date.now() + 5 * 3600e3).toISOString() }, as(me));
    assert.equal(res.status, 200);
    res = await api('PUT', '/api/profiles/@me/custom-status', { text: 'x', emoji: 'abc' }, as(me));
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'INVALID_EMOJI');
    res = await api('PUT', '/api/profiles/@me/custom-status', { text: 'y'.repeat(129) }, as(me));
    assert.equal(res.status, 400);
    res = await api('PUT', '/api/profiles/@me/custom-status', { text: 'Never', clear_after: 'never' }, as(me));
    assert.equal(res.body.custom_status_expires_at, null);
    // A client cannot smuggle an expiry through the plain profile update.
    res = await api('PUT', `/api/users/${me}`, { custom_status_expires_at: '2000-01-01T00:00:00.000Z' }, as(me));
    assert.equal(res.status, 200);
    assert.equal(res.body.custom_status, 'Never');
  });

  test('an expired status is hidden on read and cleared by the sweeper', async () => {
    const me = await makeUser('exp');
    const viewer = await makeUser('expv');
    await api('PUT', '/api/profiles/@me/custom-status', { text: 'Brb', clear_after: '1h' }, as(me));
    const { runQuery, getQuery } = await db();
    await runQuery(`UPDATE users SET custom_status_expires_at = ? WHERE id = ?`, [new Date(Date.now() - 1000).toISOString(), me]);
    const read = await api('GET', `/api/users/${me}`, undefined, as(viewer));
    assert.equal(read.status, 200);
    assert.equal(read.body.custom_status, null, 'masked before the sweep');
    const deadline = Date.now() + 15_000;
    let row;
    while (Date.now() < deadline) {
      row = await getQuery(`SELECT custom_status, custom_status_expires_at FROM users WHERE id = ?`, [me]);
      if (row.custom_status === null) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.equal(row.custom_status, null, 'the sweeper cleared it');
    assert.equal(row.custom_status_expires_at, null);
  });
});

// ---------------------------------------------------------------------------

describe('bio, names and AutoMod on identity fields', () => {
  test('bio: 300 characters, cleaned markdown, refused words', async () => {
    const me = await makeUser('bio');
    let res = await api('PUT', `/api/users/${me}`, { bio: 'b'.repeat(300) }, as(me));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    res = await api('PUT', `/api/users/${me}`, { bio: 'b'.repeat(301) }, as(me));
    assert.equal(res.status, 400);
    res = await api('PUT', `/api/users/${me}`, {
      bio: '**hi** [click](javascript:alert(1)) [ok](https://example.com)‮gnp.exe\n\n\n\n\n<script>x</script>'
    }, as(me));
    assert.equal(res.status, 200);
    assert.equal(res.body.bio, '**hi** click [ok](https://example.com)gnp.exe\n\n<script>x</script>',
      'masked js link unwrapped, bidi override removed, blank lines collapsed; HTML stays text');
    res = await api('PUT', `/api/users/${me}`, { bio: 'I am a n1gger' }, as(me));
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'PROFILE_TEXT_BLOCKED');
    res = await api('PUT', `/api/users/${me}`, { pronouns: 'f a g g o t' }, as(me));
    assert.equal(res.status, 400, 'spaced letters are caught');
    res = await api('PUT', `/api/users/${me}`, { custom_status: 'free nitro here' }, as(me));
    assert.equal(res.status, 400);
    res = await api('PUT', '/api/profiles/@me/custom-status', { text: 'free-nitro giveaway' }, as(me));
    assert.equal(res.status, 400);
  });

  test('reserved display names are refused for regular accounts only', async () => {
    const me = await makeUser('rsv');
    let res = await api('PUT', `/api/users/${me}`, { display_name: 'Adm1n' }, as(me));
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'NAME_RESERVED');
    res = await api('PUT', `/api/users/${me}`, { display_name: 'แอดมิน' }, as(me));
    assert.equal(res.status, 400);
    res = await api('PUT', `/api/users/${me}`, { display_name: 'Admiral Kim' }, as(me));
    assert.equal(res.status, 200);
    const staff = await makeUser('stf', { admin: true });
    res = await api('PUT', `/api/users/${staff}`, { display_name: 'Admin' }, as(staff));
    assert.equal(res.status, 200);
  });

  test('name styles and profile themes are validated; staff styles are reserved', async () => {
    const me = await makeUser('ns');
    let res = await api('PATCH', '/api/profiles/@me/identity', { name_style: { font: 'kanit', effect: 'gradient', colors: ['#ff5f6d', '#ffc371'] }, theme_colors: ['#1e3a8a', '#9333ea'] }, as(me));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.name_style, { font: 'kanit', effect: 'gradient', colors: ['#ff5f6d', '#ffc371'] });
    assert.deepEqual(res.body.theme_colors, ['#1e3a8a', '#9333ea']);
    res = await api('PATCH', '/api/profiles/@me/identity', { name_style: { font: 'comic', effect: 'solid', colors: ['#fff'] } }, as(me));
    assert.equal(res.status, 400);
    res = await api('PATCH', '/api/profiles/@me/identity', { name_style: { font: 'mali', effect: 'gradient', colors: ['#ff0000'] } }, as(me));
    assert.equal(res.status, 400);
    res = await api('PATCH', '/api/profiles/@me/identity', { name_style: { font: 'mali', effect: 'solid', colors: ['red;background:url(x)'] } }, as(me));
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'INVALID_COLOR');
    res = await api('PATCH', '/api/profiles/@me/identity', { name_style: { effect: 'staff', font: 'default' } }, as(me));
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'NAME_STYLE_RESERVED');
    const bot = await makeUser('bt', { bot: true });
    res = await api('PATCH', '/api/profiles/@me/identity', { name_style: { effect: 'staff', font: 'default' } }, as(bot));
    assert.equal(res.status, 200);
    res = await api('PATCH', '/api/profiles/@me/identity', { theme_colors: ['#123456'] }, as(me));
    assert.equal(res.status, 400);
    const viewer = await makeUser('nsv');
    const id = await identity(viewer, me);
    assert.equal(id.name_style.font, 'kanit');
    assert.deepEqual(id.theme_colors, ['#1e3a8a', '#9333ea']);
  });
});

// ---------------------------------------------------------------------------

describe('server tags', () => {
  test('validation, reserved words, AutoMod, permissions, wearing and leaving', async () => {
    const owner = await makeUser('tgo');
    const member = await makeUser('tgm');
    const serverId = await makeServer(owner, 'Tag server');
    await join(serverId, owner, member);

    const put = (body, who = owner) => api('PUT', `/api/servers/${serverId}/tag`, body, as(who));
    let res = await put({ tag: 'GG', icon: 'star' }, member);
    assert.equal(res.status, 403, 'MANAGE_GUILD required');
    for (const bad of ['G', 'GAMER', 'g g!', '😀😀']) {
      res = await put({ tag: bad });
      assert.equal(res.status, 400, bad);
      assert.equal(res.body.code, 'INVALID_TAG', bad);
    }
    for (const reserved of ['MOD', 'm0d', 'ADMN', 'B0T5']) {
      res = await put({ tag: reserved });
      assert.equal(res.status, 400, reserved);
      assert.equal(res.body.code, 'TAG_RESERVED', reserved);
    }
    res = await put({ tag: 'FUCK' });
    assert.equal(res.body.code, 'PROFILE_TEXT_BLOCKED');
    res = await put({ tag: 'GG', icon: 'skull' });
    assert.equal(res.body.code, 'INVALID_TAG_ICON');

    // The server's own keyword rules apply to its tag.
    res = await api('POST', `/api/servers/${serverId}/automod`, { name: 'no raid', trigger_type: 'keyword', trigger_metadata: { keywords: ['raid'] }, actions: ['block'] }, as(owner));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    res = await put({ tag: 'RAID' });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'PROFILE_TEXT_BLOCKED');

    res = await put({ tag: 'ไทย', icon: 'lotus', color: '#f59e0b' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.tag.tag, 'ไทย');
    res = await put({ tag: 'gg', icon: 'star', color: '#22c55e' });
    assert.equal(res.body.tag.tag, 'GG', 'upper-cased');

    const outsider = await makeUser('tgx');
    res = await api('PATCH', '/api/profiles/@me/identity', { primary_server_tag_id: serverId }, as(outsider));
    assert.equal(res.status, 403);
    res = await api('PATCH', '/api/profiles/@me/identity', { primary_server_tag_id: serverId }, as(member));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.wearable_tags.some((t) => t.server_id === serverId));
    let id = await identity(outsider, member);
    assert.equal(id.tag.tag, 'GG');
    assert.equal(id.tag.icon, 'star');

    // Moderator reset hides the worn tag inside the server, audit-logged.
    const stranger = await makeUser('tgs');
    await join(serverId, owner, stranger);
    res = await api('POST', `/api/servers/${serverId}/members/${member}/profile-reset`, {}, as(stranger));
    assert.equal(res.status, 403, 'MANAGE_NICKNAMES required');
    await api('PUT', `/api/cosmetics/@me?server_id=${serverId}`, { nameplate: 'builtin-plate-aurora' }, as(member));
    res = await api('POST', `/api/servers/${serverId}/members/${member}/profile-reset`, { reason: 'offensive' }, as(owner));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    id = await identity(owner, member, serverId);
    assert.equal(id.tag, null);
    assert.equal(id.nameplate, null, 'per-server cosmetics cleared');
    assert.equal((await identity(owner, member)).tag.tag, 'GG', 'still worn elsewhere');
    const { allQuery } = await db();
    const logs = await allQuery(`SELECT reason FROM audit_logs WHERE server_id = ? AND action_type = 'MEMBER_PROFILE_RESET'`, [serverId]);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].reason, 'offensive');
    res = await api('POST', `/api/servers/${serverId}/members/${owner}/profile-reset`, {}, as(stranger));
    assert.equal(res.status, 403);
    res = await api('POST', `/api/servers/${serverId}/members/${member}/profile-reset`, { unhide_tag: true }, as(owner));
    assert.equal(res.body.tag_hidden, false, 'a moderator can undo the tag hiding');
    assert.equal((await identity(owner, member, serverId)).tag.tag, 'GG');

    // Leaving the server takes the tag off.
    res = await api('POST', `/api/servers/${serverId}/leave`, undefined, as(member));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await identity(outsider, member)).tag, null);
  });
});

// ---------------------------------------------------------------------------

describe('badges, new members, full profile and reports', () => {
  test('system badges: staff, bot, early member, verified email', async () => {
    const staff = await makeUser('bst', { admin: true });
    const bot = await makeUser('bbt', { bot: true });
    const { runQuery } = await db();
    await runQuery(`UPDATE users SET email_verified = 1 WHERE id = ?`, [staff]);
    const viewer = await makeUser('bvw');
    const slugs = async (id) => (await identity(viewer, id)).badges.map((b) => b.slug);
    assert.ok((await slugs(staff)).includes('staff'));
    assert.ok((await slugs(staff)).includes('verified'));
    assert.ok((await slugs(bot)).includes('bot'));
    assert.ok(!(await slugs(bot)).includes('early'), 'bots are never early members');
    assert.ok((await slugs(viewer)).includes('early'), 'fewer than 100 people so far');
  });

  test('server badges: create, grant, visible only in that server; permissions and limits', async () => {
    const owner = await makeUser('sbo');
    const member = await makeUser('sbm');
    const serverId = await makeServer(owner, 'Badge server');
    await join(serverId, owner, member);
    let res = await api('POST', `/api/servers/${serverId}/badges`, { name: 'Event winner', icon: 'trophy', color: '#eab308' }, as(member));
    assert.equal(res.status, 403);
    res = await api('POST', `/api/servers/${serverId}/badges`, { name: 'Staff', icon: 'trophy' }, as(owner));
    assert.equal(res.status, 400, 'reserved badge name');
    res = await api('POST', `/api/servers/${serverId}/badges`, { name: 'Event winner', icon: 'trophy', color: '#eab308', description: 'Won the 2026 LAN' }, as(owner));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const badgeId = res.body.id;
    res = await api('PUT', `/api/servers/${serverId}/badges/${badgeId}/members/${member}`, {}, as(member));
    assert.equal(res.status, 403, 'MANAGE_ROLES required');
    res = await api('PUT', `/api/servers/${serverId}/badges/${badgeId}/members/${member}`, {}, as(owner));
    assert.equal(res.status, 200);
    const inServer = await identity(owner, member, serverId);
    assert.ok(inServer.badges.some((b) => b.id === badgeId && b.kind === 'server' && b.name === 'Event winner'));
    assert.equal(inServer.new_member, true, '🌱 joined just now');
    const elsewhere = await identity(owner, member);
    assert.ok(!elsewhere.badges.some((b) => b.id === badgeId));
    assert.equal(elsewhere.new_member, false);

    for (let i = 0; i < 9; i += 1) {
      res = await api('POST', `/api/servers/${serverId}/badges`, { name: `Badge ${i}`, icon: 'star' }, as(owner));
      assert.equal(res.status, 201);
    }
    res = await api('POST', `/api/servers/${serverId}/badges`, { name: 'One too many', icon: 'star' }, as(owner));
    assert.equal(res.body.code, 'TOO_MANY_BADGES');
    res = await api('DELETE', `/api/servers/${serverId}/badges/${badgeId}/members/${member}`, undefined, as(owner));
    assert.equal(res.status, 200);
    assert.ok(!(await identity(owner, member, serverId)).badges.some((b) => b.id === badgeId));
  });

  test('instance badges are granted by instance admins only', async () => {
    const admin = await makeUser('iba', { admin: true });
    const user = await makeUser('ibu');
    let res = await api('POST', '/api/admin/badges', { name: 'Translator', icon: 'book' }, as(user));
    assert.equal(res.status, 403);
    res = await api('POST', '/api/admin/badges', { name: 'Translator', icon: 'book' }, as(admin));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    res = await api('PUT', `/api/admin/badges/${res.body.id}/users/${user}`, {}, as(admin));
    assert.equal(res.status, 200);
    assert.ok((await identity(admin, user)).badges.some((b) => b.name === 'Translator' && b.kind === 'instance'));
  });

  test('the full profile carries mutual servers and friends, and a report snapshots the profile', async () => {
    const a = await makeUser('pfa');
    const b = await makeUser('pfb');
    const c = await makeUser('pfc');
    const serverId = await makeServer(a, 'Mutual');
    await join(serverId, a, b);
    const { runQuery } = await db();
    for (const [x, y] of [[a, c], [b, c]]) {
      await runQuery(`INSERT INTO friends (id, user_id, friend_id, status, requested_by) VALUES (?, ?, ?, 'accepted', ?)`,
        [crypto.randomUUID(), x, y, x]);
    }
    await api('PUT', `/api/users/${b}`, { bio: 'Hello **world**', pronouns: 'they/them' }, as(b));
    let res = await api('GET', `/api/profiles/${b}?server_id=${serverId}`, undefined, as(a));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.mutual_servers.map((s) => s.id), [serverId]);
    assert.deepEqual(res.body.mutual_friends.map((u) => u.id), [c]);
    assert.equal(res.body.viewer.can_moderate, true, 'the owner can moderate');
    assert.ok(res.body.member.joined_at);
    res = await api('GET', `/api/profiles/${a}?server_id=${serverId}`, undefined, as(b));
    assert.equal(res.body.viewer.can_moderate, false);

    res = await api('POST', `/api/profiles/${b}/report`, { reason: 'impersonation', details: 'pretends to be staff', server_id: serverId }, as(a));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.context.profile.user.bio, 'Hello **world**');
    assert.equal(res.body.context.profile.user.pronouns, 'they/them');
    const { getQuery } = await db();
    const row = await getQuery(`SELECT context, escalated FROM reports WHERE id = ?`, [res.body.id]);
    assert.equal(JSON.parse(row.context).profile.user.id, b);
    res = await api('POST', `/api/profiles/${b}/report`, { reason: 'bogus' }, as(c));
    assert.equal(res.status, 400);

    // A report filed by the generic dialog gets the snapshot attached — only by its reporter, once.
    const generic = await api('POST', '/api/reports', { target_type: 'user', target_id: b, reason: 'harassment' }, as(c));
    assert.equal(generic.status, 200, JSON.stringify(generic.body));
    res = await api('POST', `/api/reports/${generic.body.id}/profile-snapshot`, {}, as(a));
    assert.equal(res.status, 404, 'not your report');
    res = await api('POST', `/api/reports/${generic.body.id}/profile-snapshot`, { server_id: serverId }, as(c));
    assert.deepEqual(res.body, { attached: true });
    res = await api('POST', `/api/reports/${generic.body.id}/profile-snapshot`, {}, as(c));
    assert.deepEqual(res.body, { attached: false });
    const snap = await getQuery(`SELECT context FROM reports WHERE id = ?`, [generic.body.id]);
    assert.equal(JSON.parse(snap.context).profile.user.pronouns, 'they/them');
  });
});
