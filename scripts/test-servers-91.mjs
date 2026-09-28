#!/usr/bin/env node
// ============================================================================
//  Free server customisation (schema v46–v47).
//
//  Role styles (solid / gradient / holographic, angle bounds, colours) and
//  role icons (size and type), banner / splash / icon uploads gated on
//  MANAGE_GUILD (animation kept), vanity URLs (uniqueness, reserved words),
//  instance Discover (only opt-in servers, search, categories, join rules),
//  channel emoji validation, and templates carrying the new fields.
//  Runs against SQLite and PostgreSQL (npm run test:pg).
// ============================================================================

// A fixed port: the harness derives one from the digits in the file name, and
// 91 % 90 lands on the same slot as test.mjs.
process.env.TEST_PORT ??= String(Number(process.env.TEST_PORT_BASE || 3900) + 84);

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import sharp from 'sharp';

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

async function upload(url, field, buffer, filename, type, headers = {}) {
  const form = new FormData();
  form.append(field, new Blob([buffer], { type }), filename);
  const res = await fetch(`${BASE}${url}`, { method: 'POST', body: form, headers });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

const db = () => import('../db.js');

async function makeUser(prefix) {
  const { runQuery } = await db();
  const id = `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
  await runQuery(`INSERT INTO users (id, username, display_name, email, status) VALUES (?, ?, ?, ?, 'online')`,
    [id, id, id, `${id}@example.test`]);
  return id;
}

async function makeServer(owner, name = 'Custom') {
  const res = await api('POST', '/api/servers', { name }, as(owner));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.id;
}

async function join(serverId, owner, userId) {
  const invite = await api('POST', `/api/servers/${serverId}/invites`, { maxAge: 0 }, as(owner));
  assert.equal(invite.status, 200, JSON.stringify(invite.body));
  const res = await api('POST', `/api/invites/${invite.body.code}/accept`, undefined, as(userId));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return invite.body.code;
}

async function makeRole(serverId, owner, body = {}) {
  const res = await api('POST', `/api/servers/${serverId}/roles`, { name: 'styled', color: '#5865f2', ...body }, as(owner));
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

const detail = async (serverId, userId) => (await api('GET', `/api/servers/${serverId}`, undefined, as(userId))).body;
const png = (size = 64, colour = '#e91e63') =>
  sharp({ create: { width: size, height: size, channels: 4, background: colour } }).png().toBuffer();

// --- role styles ------------------------------------------------------------

describe('role styles', () => {
  let owner; let serverId; let role;
  before(async () => {
    owner = await makeUser('rs');
    serverId = await makeServer(owner);
    role = await makeRole(serverId, owner);
  });
  const patch = (body, who = owner) => api('PATCH', `/api/servers/${serverId}/roles/${role.id}`, body, as(who));

  test('an unknown style is refused', async () => {
    const res = await patch({ style: 'rainbow' });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'INVALID_ROLE_STYLE');
  });

  test('a gradient needs its second colour', async () => {
    const res = await patch({ style: 'gradient' });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'ROLE_STYLE_NEEDS_COLOR');
  });

  test('gradient angle is a whole number of degrees, 0–360', async () => {
    for (const angle of [-1, 361, 12.5, 'north']) {
      const res = await patch({ style: 'gradient', color_secondary: '#ff00aa', gradient_angle: angle });
      assert.equal(res.status, 400, `angle ${angle}`);
      assert.equal(res.body.code, 'INVALID_GRADIENT_ANGLE');
    }
    for (const angle of [0, 360, 135]) {
      const res = await patch({ style: 'gradient', color_secondary: '#ff00aa', gradient_angle: angle });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.gradient_angle, angle);
      assert.equal(res.body.style, 'gradient');
      assert.equal(res.body.color_secondary, '#ff00aa');
    }
  });

  test('colours must be hex', async () => {
    const res = await patch({ style: 'gradient', color_secondary: 'pink' });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'INVALID_COLOR');
    const bad = await patch({ color: 'rgb(1,2,3)' });
    assert.equal(bad.body.code, 'INVALID_COLOR');
  });

  test('holographic needs only a primary colour; solid drops the second colour', async () => {
    const holo = await patch({ style: 'holographic' });
    assert.equal(holo.status, 200, JSON.stringify(holo.body));
    assert.equal(holo.body.style, 'holographic');
    const solid = await patch({ style: 'solid' });
    assert.equal(solid.body.style, 'solid');
    assert.equal(solid.body.color_secondary, null);
    const noColour = await makeRole(serverId, owner, { color: null, name: 'plain' });
    const res = await api('PATCH', `/api/servers/${serverId}/roles/${noColour.id}`, { style: 'holographic' }, as(owner));
    assert.equal(res.body.code, 'ROLE_STYLE_NEEDS_COLOR');
  });

  test('a unicode emoji icon is one emoji', async () => {
    for (const bad of ['ab', '🔥🔥', 'x🔥']) {
      const res = await patch({ unicode_emoji: bad });
      assert.equal(res.status, 400, bad);
      assert.equal(res.body.code, 'INVALID_EMOJI');
    }
    const ok = await patch({ unicode_emoji: '🔥' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.unicode_emoji, '🔥');
    assert.equal(ok.body.icon_url, null);
  });

  test('members without MANAGE_ROLES cannot restyle', async () => {
    const member = await makeUser('rsm');
    await join(serverId, owner, member);
    const res = await patch({ style: 'holographic' }, member);
    assert.equal(res.status, 403);
  });

  test('the server detail carries the style for every role', async () => {
    await patch({ style: 'gradient', color_secondary: '#00d4ff', gradient_angle: 45 });
    const d = await detail(serverId, owner);
    const r = d.roles.find((x) => x.id === role.id);
    assert.equal(r.style, 'gradient');
    assert.equal(r.gradient_angle, 45);
  });
});

// --- role icons ---------------------------------------------------------------

describe('role icons', () => {
  let owner; let serverId; let role; let member;
  before(async () => {
    owner = await makeUser('ri');
    serverId = await makeServer(owner);
    role = await makeRole(serverId, owner);
    member = await makeUser('rim');
    await join(serverId, owner, member);
  });
  const url = () => `/api/servers/${serverId}/roles/${role.id}/icon`;

  test('a small PNG becomes the icon and replaces an emoji icon', async () => {
    await api('PATCH', `/api/servers/${serverId}/roles/${role.id}`, { unicode_emoji: '⭐' }, as(owner));
    const res = await upload(url(), 'icon', await png(64), 'star.png', 'image/png', as(owner));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.icon_url);
    assert.equal(res.body.unicode_emoji, null);
    assert.ok(res.body.icon_file_id);
  });

  test('over 256 KB is refused with 413', async () => {
    const big = Buffer.concat([await png(64), crypto.randomBytes(300 * 1024)]);
    const res = await upload(url(), 'icon', big, 'big.png', 'image/png', as(owner));
    assert.equal(res.status, 413);
    assert.equal(res.body.code, 'ROLE_ICON_TOO_LARGE');
  });

  test('only images: text or SVG is refused with 415, whatever the header says', async () => {
    const text = await upload(url(), 'icon', Buffer.from('hello there, not an image'), 'x.png', 'image/png', as(owner));
    assert.equal(text.status, 415);
    assert.equal(text.body.code, 'ROLE_ICON_TYPE');
    const svg = await upload(url(), 'icon', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'x.svg', 'image/svg+xml', as(owner));
    assert.equal(svg.status, 415);
  });

  test('a member without MANAGE_ROLES is refused before the upload', async () => {
    const res = await upload(url(), 'icon', await png(64), 'x.png', 'image/png', as(member));
    assert.equal(res.status, 403);
  });

  test('DELETE removes the icon', async () => {
    const res = await api('DELETE', url(), undefined, as(owner));
    assert.equal(res.status, 200);
    assert.equal(res.body.icon_url, null);
    assert.equal(res.body.icon_file_id, null);
  });
});

// --- banner / splash / icon -----------------------------------------------------

describe('banner, splash and animated icon', () => {
  let owner; let serverId; let member;
  before(async () => {
    owner = await makeUser('bn');
    serverId = await makeServer(owner);
    member = await makeUser('bnm');
    await join(serverId, owner, member);
  });

  test('a member without MANAGE_GUILD cannot upload or set a banner or splash', async () => {
    const image = await png(320);
    for (const kind of ['banner', 'splash', 'icon']) {
      const res = await upload(`/api/servers/${serverId}/appearance/${kind}`, 'image', image, 'b.png', 'image/png', as(member));
      assert.equal(res.status, 403, kind);
    }
    const patched = await api('PATCH', `/api/servers/${serverId}`, { banner_url: '/uploads/x.png', splash_url: '/uploads/y.png' }, as(member));
    assert.equal(patched.status, 403);
    const removed = await api('DELETE', `/api/servers/${serverId}/appearance/banner`, undefined, as(member));
    assert.equal(removed.status, 403);
  });

  test('the owner uploads a banner and a splash', async () => {
    const banner = await upload(`/api/servers/${serverId}/appearance/banner`, 'image',
      await sharp({ create: { width: 960, height: 540, channels: 3, background: '#335' } }).jpeg().toBuffer(),
      'banner.jpg', 'image/jpeg', as(owner));
    assert.equal(banner.status, 200, JSON.stringify(banner.body));
    assert.ok(banner.body.server.banner_url);
    assert.ok(banner.body.server.banner_file_id);
    assert.equal(banner.body.server.banner_animated, 0);

    const splash = await upload(`/api/servers/${serverId}/appearance/splash`, 'image', await png(400), 'splash.png', 'image/png', as(owner));
    assert.equal(splash.status, 200, JSON.stringify(splash.body));
    assert.ok(splash.body.server.splash_url);
    assert.ok(splash.body.server.splash_file_id);

    const cleared = await api('DELETE', `/api/servers/${serverId}/appearance/splash`, undefined, as(owner));
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.server.splash_url, null);
    assert.equal(cleared.body.server.splash_file_id, null);
  });

  test('an unknown kind or a non-image is refused', async () => {
    const kind = await upload(`/api/servers/${serverId}/appearance/avatar`, 'image', await png(), 'a.png', 'image/png', as(owner));
    assert.equal(kind.status, 404);
    const text = await upload(`/api/servers/${serverId}/appearance/banner`, 'image', Buffer.from('not an image at all'), 'a.png', 'image/png', as(owner));
    assert.equal(text.status, 415);
    assert.equal(text.body.code, 'IMAGE_TYPE');
  });

  test('an animated GIF icon keeps its animation and is flagged', async () => {
    const frames = await Promise.all(['#f00', '#0f0', '#00f'].map((c) =>
      sharp({ create: { width: 128, height: 128, channels: 4, background: c } }).png().toBuffer()));
    const gif = await sharp(frames, { join: { animated: true } }).gif({ delay: [100, 100, 100], loop: 0 }).toBuffer();
    const res = await upload(`/api/servers/${serverId}/appearance/icon`, 'image', gif, 'party.gif', 'image/gif', as(owner));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.file.is_animated, true);
    assert.equal(res.body.server.icon_animated, 1);
    // The stored original still has every frame.
    const bytes = Buffer.from(await (await fetch(`${BASE}${res.body.server.icon_url}`, { headers: as(owner) })).arrayBuffer());
    assert.equal((await sharp(bytes, { animated: true }).metadata()).pages, 3);
    // A static replacement clears the flag.
    const still = await upload(`/api/servers/${serverId}/appearance/icon`, 'image', await png(128), 'still.png', 'image/png', as(owner));
    assert.equal(still.body.server.icon_animated, 0);
  });
});

// --- vanity URLs ---------------------------------------------------------------

describe('vanity URLs', () => {
  test('reserved words are refused', async () => {
    const owner = await makeUser('va');
    const serverId = await makeServer(owner);
    for (const slug of ['admin', 'API', 'invite', 'discover']) {
      const res = await api('PATCH', `/api/servers/${serverId}`, { vanity_url: slug }, as(owner));
      assert.equal(res.status, 409, slug);
      assert.equal(res.body.code, 'VANITY_RESERVED');
    }
  });

  test('a slug is unique across servers, case-insensitively', async () => {
    const a = await makeUser('vb');
    const b = await makeUser('vc');
    const one = await makeServer(a);
    const two = await makeServer(b);
    const slug = `cozy-${crypto.randomBytes(3).toString('hex')}`;
    const first = await api('PATCH', `/api/servers/${one}`, { vanity_url: slug.toUpperCase() }, as(a));
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.vanity_url, slug);
    const second = await api('PATCH', `/api/servers/${two}`, { vanity_url: slug }, as(b));
    assert.equal(second.status, 409);
    assert.equal(second.body.code, 'VANITY_TAKEN');
    const invalid = await api('PATCH', `/api/servers/${two}`, { vanity_url: '-no-' }, as(b));
    assert.equal(invalid.status, 400);
    // The vanity resolves to the server profile card.
    const card = await api('GET', `/api/invites/${slug}/profile`);
    assert.equal(card.status, 200);
    assert.equal(card.body.id, one);
  });
});

// --- discovery -------------------------------------------------------------------

describe('discovery', () => {
  let owner; let listed; let hidden; let viewer; let tag;
  before(async () => {
    tag = crypto.randomBytes(3).toString('hex');
    owner = await makeUser('dc');
    viewer = await makeUser('dcv');
    listed = await makeServer(owner, `Listed ${tag}`);
    hidden = await makeServer(owner, `Hidden ${tag}`);
  });

  test('opting in needs a description and MANAGE_GUILD', async () => {
    const early = await api('PATCH', `/api/servers/${listed}/profile`, { discoverable: true }, as(owner));
    assert.equal(early.status, 400);
    assert.equal(early.body.code, 'DISCOVERY_NEEDS_DESCRIPTION');
    await api('PATCH', `/api/servers/${listed}`, { description: `A friendly place for ${tag}` }, as(owner));
    const denied = await api('PATCH', `/api/servers/${listed}/profile`, { discoverable: true }, as(viewer));
    assert.equal(denied.status, 403);
    const ok = await api('PATCH', `/api/servers/${listed}/profile`, {
      discoverable: true, discovery_category: 'gaming', accent_color: '#ff7a00',
      traits: [{ emoji: '🎮', label: 'Co-op' }, { label: 'Chill' }]
    }, as(owner));
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.discoverable, true);
    assert.deepEqual(ok.body.traits, [{ emoji: '🎮', label: 'Co-op' }, { emoji: null, label: 'Chill' }]);
  });

  test('profile validation: category, traits, accent colour', async () => {
    const bad = [
      [{ discovery_category: 'crypto' }, 'INVALID_CATEGORY'],
      [{ traits: Array.from({ length: 6 }, (_, i) => ({ label: `t${i}` })) }, 'INVALID_TRAITS'],
      [{ traits: [{ label: '' }] }, 'INVALID_TRAITS'],
      [{ traits: [{ emoji: 'ab', label: 'x' }] }, 'INVALID_EMOJI'],
      [{ accent_color: 'orange' }, 'INVALID_COLOR']
    ];
    for (const [body, code] of bad) {
      const res = await api('PATCH', `/api/servers/${listed}/profile`, body, as(owner));
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.code, code);
    }
  });

  test('the listing shows only opted-in servers, with search and categories', async () => {
    const all = await api('GET', `/api/discover?q=${tag}`, undefined, as(viewer));
    assert.equal(all.status, 200);
    const ids = all.body.servers.map((s) => s.id);
    assert.ok(ids.includes(listed));
    assert.ok(!ids.includes(hidden), 'a server that did not opt in is never listed');
    const card = all.body.servers.find((s) => s.id === listed);
    assert.equal(card.joined, false);
    assert.equal(card.accent_color, '#ff7a00');
    assert.ok(card.member_count >= 1);

    const byTrait = await api('GET', '/api/discover?q=co-op', undefined, as(viewer));
    assert.ok(byTrait.body.servers.some((s) => s.id === listed));
    const wrongCategory = await api('GET', `/api/discover?q=${tag}&category=music`, undefined, as(viewer));
    assert.equal(wrongCategory.body.servers.length, 0);
    const rightCategory = await api('GET', `/api/discover?q=${tag}&category=gaming`, undefined, as(viewer));
    assert.equal(rightCategory.body.servers.length, 1);
    const badCategory = await api('GET', '/api/discover?category=nope', undefined, as(viewer));
    assert.equal(badCategory.status, 400);
    const anonymous = await api('GET', '/api/discover');
    assert.equal(anonymous.status, 401);
  });

  test('joining follows the existing rules: opt-in servers only, bans respected', async () => {
    const privateJoin = await api('POST', `/api/servers/${hidden}/join`, undefined, as(viewer));
    assert.equal(privateJoin.status, 403);
    assert.equal(privateJoin.body.code, 'INVITE_REQUIRED');
    const joined = await api('POST', `/api/servers/${listed}/join`, undefined, as(viewer));
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    const after = await api('GET', `/api/discover?q=${tag}`, undefined, as(viewer));
    assert.equal(after.body.servers.find((s) => s.id === listed).joined, true);
  });

  test('a hidden server profile is not readable by strangers; opting out delists', async () => {
    const stranger = await makeUser('dcs');
    const res = await api('GET', `/api/servers/${hidden}/profile`, undefined, as(stranger));
    assert.equal(res.status, 404);
    const listedCard = await api('GET', `/api/servers/${listed}/profile`, undefined, as(stranger));
    assert.equal(listedCard.status, 200);
    await api('PATCH', `/api/servers/${listed}/profile`, { discoverable: false }, as(owner));
    const gone = await api('GET', `/api/discover?q=${tag}`, undefined, as(stranger));
    assert.equal(gone.body.servers.length, 0);
  });
});

// --- channel emoji -----------------------------------------------------------------

describe('channel emoji', () => {
  let owner; let serverId; let channelId; let member;
  before(async () => {
    owner = await makeUser('ce');
    serverId = await makeServer(owner);
    const d = await detail(serverId, owner);
    channelId = d.channels.find((c) => c.type === 'text').id;
    member = await makeUser('cem');
    await join(serverId, owner, member);
  });
  const set = (icon_emoji, who = owner) => api('PATCH', `/api/channels/${channelId}/icon-emoji`, { icon_emoji }, as(who));

  test('one unicode emoji is accepted, including flags, keycaps and ZWJ sequences', async () => {
    for (const emoji of ['🎮', '🇹🇭', '1️⃣', '👩‍💻', '❤️']) {
      const res = await set(emoji);
      assert.equal(res.status, 200, `${emoji} ${JSON.stringify(res.body)}`);
      assert.equal(res.body.icon_emoji, emoji);
    }
    const d = await detail(serverId, owner);
    assert.equal(d.channels.find((c) => c.id === channelId).icon_emoji, '❤️');
  });

  test('text, two emoji and over-long values are refused', async () => {
    for (const bad of ['a', 'general', '🎮🎮', '🎮 x', 'x'.repeat(40)]) {
      const res = await set(bad);
      assert.equal(res.status, 400, bad);
      assert.equal(res.body.code, 'INVALID_EMOJI');
    }
  });

  test('custom emoji must belong to this server', async () => {
    const res = await set('<:party:123456789012345678>');
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'INVALID_EMOJI');
    const { runQuery } = await db();
    const id = String(Date.now());
    await runQuery(`INSERT INTO emojis (id, server_id, name, url) VALUES (?, ?, 'party', '/uploads/p.png')`, [id, serverId]);
    const ok = await set(`<:party:${id}>`);
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.icon_emoji, `<:party:${id}>`);
  });

  test('MANAGE_CHANNELS is required; null clears', async () => {
    const denied = await set('🎮', member);
    assert.equal(denied.status, 403);
    const cleared = await set(null);
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.icon_emoji, null);
  });
});

// --- templates ------------------------------------------------------------------------

describe('templates carry the new fields', () => {
  test('role style and unicode channel emoji survive a template round trip', async () => {
    const owner = await makeUser('tp');
    const serverId = await makeServer(owner);
    const role = await makeRole(serverId, owner, { name: 'holo' });
    await api('PATCH', `/api/servers/${serverId}/roles/${role.id}`, { style: 'holographic', unicode_emoji: '✨' }, as(owner));
    const d = await detail(serverId, owner);
    const channelId = d.channels.find((c) => c.type === 'text').id;
    await api('PATCH', `/api/channels/${channelId}/icon-emoji`, { icon_emoji: '📣' }, as(owner));
    const tpl = await api('POST', `/api/servers/${serverId}/template`, { name: 'Styled' }, as(owner));
    assert.equal(tpl.status, 201, JSON.stringify(tpl.body));
    const made = await api('POST', `/api/templates/${tpl.body.code}/servers`, { name: 'Copy' }, as(owner));
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const copy = await detail(made.body.server.id, owner);
    const holo = copy.roles.find((r) => r.name === 'holo');
    assert.equal(holo.style, 'holographic');
    assert.equal(holo.unicode_emoji, '✨');
    assert.ok(copy.channels.some((c) => c.icon_emoji === '📣'));
  });
});
