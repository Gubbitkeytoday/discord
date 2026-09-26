// ============================================================================
//  Server appearance — the free half of what Discord sells as boosts.
//
//  Role styles (solid / gradient / holographic) and role icons, channel emoji,
//  server banner / invite splash / animated icon bookkeeping, the server
//  profile card and the instance-local Discover listing.
//
//  Pure validators live here so guildAdmin.js (the write path for roles and
//  the guild row) and routes/serverAppearance.js share one definition.
// ============================================================================

import { runQuery, getQuery, allQuery, isPostgres, sql } from '../db.js';
import { ApiError } from '../lib/httpUtils.js';
import { normaliseColor } from '../lib/validate.js';
import { assertPermission, resolvePermissions, writeAuditLog, resolveVanity } from './guilds.js';

// --- role styles -------------------------------------------------------------

export const ROLE_STYLES = ['solid', 'gradient', 'holographic'];

/** Role icons are shown at 16–20 px; Discord caps them at 256 KB too. */
export const ROLE_ICON_MAX_BYTES = 256 * 1024;
export const ROLE_ICON_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/** Banners and splashes: generous, but still an image and not a video. */
export const GUILD_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const GUILD_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

/**
 * Normalise the style part of a role patch. Returns only the fields that were
 * present, validated: `style`, `gradient_angle`, `color_secondary`,
 * `unicode_emoji`. Throws ApiError(400) with a stable code otherwise.
 */
export function validateRoleStyle(patch = {}) {
  const out = {};
  if (patch.style !== undefined) {
    if (!ROLE_STYLES.includes(patch.style)) {
      throw new ApiError(`style must be one of ${ROLE_STYLES.join(', ')}`, { code: 'INVALID_ROLE_STYLE' });
    }
    out.style = patch.style;
  }
  if (patch.gradient_angle !== undefined) {
    const angle = Number(patch.gradient_angle);
    if (!Number.isInteger(angle) || angle < 0 || angle > 360) {
      throw new ApiError('gradient_angle must be a whole number of degrees from 0 to 360', { code: 'INVALID_GRADIENT_ANGLE' });
    }
    out.gradient_angle = angle;
  }
  if (patch.color_secondary !== undefined) out.color_secondary = normaliseColor(patch.color_secondary, 'color_secondary');
  if (patch.unicode_emoji !== undefined) out.unicode_emoji = validateUnicodeEmoji(patch.unicode_emoji, 'unicode_emoji');
  return out;
}

/**
 * The style a role ends up with once a patch is applied: a gradient without a
 * second colour is meaningless, so it is refused rather than stored.
 */
export function assertRoleStyleComplete(next) {
  if ((next.style === 'gradient' || next.style === 'holographic') && !next.color) {
    throw new ApiError('A gradient or holographic role needs a primary colour', { code: 'ROLE_STYLE_NEEDS_COLOR' });
  }
  if (next.style === 'gradient' && !next.color_secondary) {
    throw new ApiError('A gradient role needs a second colour', { code: 'ROLE_STYLE_NEEDS_COLOR' });
  }
}

// --- emoji -------------------------------------------------------------------

const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter
  ? new Intl.Segmenter('en', { granularity: 'grapheme' }) : null;
const EMOJI_GRAPHEME = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}{2}|[#*0-9]️?⃣)/u;
const CUSTOM_EMOJI = /^<(a?):([A-Za-z0-9_]{2,32}):(\d{1,20})>$/;

/** Exactly one unicode emoji (a single grapheme cluster), or null. */
export function validateUnicodeEmoji(value, field = 'emoji') {
  if (value === null || value === '') return null;
  const text = String(value).trim();
  const graphemes = segmenter ? [...segmenter.segment(text)] : [...text];
  if (!text || text.length > 32 || graphemes.length !== 1 || !EMOJI_GRAPHEME.test(text)) {
    throw new ApiError(`${field} must be a single emoji`, { code: 'INVALID_EMOJI', details: { field } });
  }
  return text;
}

/**
 * A channel's emoji: one unicode emoji, or one of this server's own custom
 * emoji written as <:name:id> / <a:name:id>. Returns the stored form or null.
 */
export async function validateChannelEmoji(value, serverId) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  const custom = CUSTOM_EMOJI.exec(text);
  if (custom) {
    const emoji = await getQuery(
      `SELECT id, name, animated FROM emojis WHERE id = ? AND server_id = ? AND available = 1`, [custom[3], serverId]
    );
    if (!emoji) throw new ApiError('That emoji does not belong to this server', { code: 'INVALID_EMOJI' });
    return `<${emoji.animated ? 'a' : ''}:${emoji.name}:${emoji.id}>`;
  }
  return validateUnicodeEmoji(text, 'icon_emoji');
}

export async function setChannelEmoji({ channelId, userId, emoji }) {
  const channel = await getQuery(`SELECT * FROM channels WHERE id = ? AND deleted_at IS NULL`, [channelId]);
  if (!channel || !channel.server_id) throw ApiError.notFound('Channel');
  if (channel.type === 'thread') throw new ApiError('Threads cannot have a channel emoji', { code: 'INVALID_CHANNEL_TYPE' });
  await assertPermission({ userId, serverId: channel.server_id, channelId, permission: 'MANAGE_CHANNELS' });
  const value = await validateChannelEmoji(emoji, channel.server_id);
  if (value === (channel.icon_emoji ?? null)) return channel;
  await runQuery(`UPDATE channels SET icon_emoji = ? WHERE id = ?`, [value, channelId]);
  await writeAuditLog({
    serverId: channel.server_id, userId, actionType: 'CHANNEL_UPDATE',
    targetType: 'channel', targetId: channelId,
    changes: [{ key: 'icon_emoji', old: channel.icon_emoji ?? null, new: value }]
  });
  return getQuery(`SELECT * FROM channels WHERE id = ?`, [channelId]);
}

// --- images ------------------------------------------------------------------

/** The real type of an image buffer from its magic bytes (never the header). */
export function sniffImageMime(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (buffer[0] === 0x89 && buffer.toString('ascii', 1, 4) === 'PNG') return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
  if (buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

export function assertRoleIconFile(buffer) {
  if (!buffer?.length) throw new ApiError('No icon uploaded', { code: 'NO_FILE' });
  if (buffer.length > ROLE_ICON_MAX_BYTES) {
    throw new ApiError('Role icons can be at most 256 KB', { status: 413, code: 'ROLE_ICON_TOO_LARGE' });
  }
  const mime = sniffImageMime(buffer);
  if (!mime || !ROLE_ICON_MIMES.includes(mime)) {
    throw new ApiError('Role icons must be PNG, JPEG, WebP or GIF', { status: 415, code: 'ROLE_ICON_TYPE' });
  }
  return mime;
}

export function assertGuildImageFile(buffer) {
  if (!buffer?.length) throw new ApiError('No image uploaded', { code: 'NO_FILE' });
  if (buffer.length > GUILD_IMAGE_MAX_BYTES) {
    throw new ApiError('Images can be at most 10 MB', { status: 413, code: 'IMAGE_TOO_LARGE' });
  }
  const mime = sniffImageMime(buffer);
  if (!mime || !GUILD_IMAGE_MIMES.includes(mime)) {
    throw new ApiError('Use a PNG, JPEG, WebP or GIF image', { status: 415, code: 'IMAGE_TYPE' });
  }
  return mime;
}

// --- vanity URLs -------------------------------------------------------------

/**
 * Slugs that would shadow an app route, impersonate the instance's staff, or
 * read as an official channel. Compared after lowercasing.
 */
export const RESERVED_VANITY = new Set([
  'admin', 'administrator', 'api', 'app', 'apps', 'assets', 'auth', 'billing', 'channels', 'discover',
  'discovery', 'download', 'everyone', 'help', 'here', 'home', 'invite', 'invites', 'join', 'login',
  'logout', 'mail', 'me', 'moderator', 'mod', 'mods', 'new', 'null', 'oauth', 'oauth2', 'official',
  'register', 'root', 'security', 'server', 'servers', 'settings', 'signup', 'staff', 'static', 'status',
  'support', 'system', 'template', 'templates', 'undefined', 'uploads', 'www', 'discord', 'nitro'
]);

export function isReservedVanity(slug) {
  return RESERVED_VANITY.has(String(slug ?? '').trim().toLowerCase());
}

// --- server profile ----------------------------------------------------------

export const DISCOVERY_CATEGORIES = [
  'gaming', 'music', 'entertainment', 'education', 'science', 'art', 'community', 'other'
];
const MAX_TRAITS = 5;

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

export function featuresOf(server) {
  const list = parseJson(server?.features, []);
  return Array.isArray(list) ? list.map(String) : [];
}

/** ≤5 traits of { emoji: one emoji or null, label: 1–24 characters }. */
export function validateTraits(value) {
  if (value === null) return [];
  if (!Array.isArray(value)) throw new ApiError('traits must be a list', { code: 'INVALID_TRAITS' });
  if (value.length > MAX_TRAITS) throw new ApiError(`At most ${MAX_TRAITS} traits`, { code: 'INVALID_TRAITS' });
  return value.map((trait) => {
    const label = String(trait?.label ?? '').trim();
    if (!label || label.length > 24) throw new ApiError('Each trait needs a label of 1–24 characters', { code: 'INVALID_TRAITS' });
    const emoji = trait?.emoji ? validateUnicodeEmoji(trait.emoji, 'traits.emoji') : null;
    return { emoji, label };
  });
}

const PROFILE_COLUMNS = `s.id, s.name, s.description, s.icon_url, s.icon_animated, s.banner_url, s.banner_animated,
  s.splash_url, s.vanity_url, s.accent_color, s.traits, s.discovery_category, s.features, s.member_count,
  s.verification_level, s.created_at`;

function onlineCountSql(alias = 's') {
  return `(SELECT count(*) FROM server_members sm JOIN users u ON u.id = sm.user_id
            WHERE sm.server_id = ${alias}.id AND sm.left_at IS NULL AND u.deleted_at IS NULL
              AND u.status NOT IN ('offline','invisible'))`;
}

/** The card shape used by discovery, the invite page and tag clicks. */
export function toProfile(row, { viewerIsMember = false } = {}) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? null,
    icon_url: row.icon_url ?? null,
    icon_animated: Boolean(row.icon_animated),
    banner_url: row.banner_url ?? null,
    banner_animated: Boolean(row.banner_animated),
    splash_url: row.splash_url ?? null,
    vanity_url: row.vanity_url ?? null,
    accent_color: row.accent_color ?? null,
    traits: parseJson(row.traits, []) ?? [],
    discovery_category: row.discovery_category ?? null,
    discoverable: featuresOf(row).includes('DISCOVERABLE'),
    member_count: Number(row.member_count ?? 0),
    online_count: Number(row.online_count ?? 0),
    verification_level: Number(row.verification_level ?? 0),
    created_at: row.created_at,
    joined: Boolean(viewerIsMember)
  };
}

async function loadProfileRow(serverId) {
  return getQuery(
    `SELECT ${PROFILE_COLUMNS}, ${onlineCountSql()} AS online_count
       FROM servers s WHERE s.id = ? AND s.deleted_at IS NULL`,
    [serverId]
  );
}

/** A member (or anyone, for a discoverable server) may read the card. */
export async function getServerProfile({ serverId, viewerId }) {
  const row = await loadProfileRow(serverId);
  if (!row) throw ApiError.notFound('Server');
  const viewer = viewerId ? await resolvePermissions({ userId: viewerId, serverId }) : { isMember: false };
  if (!viewer.isMember && !featuresOf(row).includes('DISCOVERABLE')) throw ApiError.notFound('Server');
  return toProfile(row, { viewerIsMember: viewer.isMember });
}

/**
 * The card behind an invite code or vanity slug, for the invite page's splash.
 * Same rules as the invite preview: an expired or revoked code reveals nothing.
 */
export async function getInviteProfile({ code, viewerId = null }) {
  let serverId = (await resolveVanity(code))?.id ?? null;
  if (!serverId) {
    const invite = await getQuery(
      `SELECT server_id, expires_at, max_uses, uses FROM invites WHERE code = ? AND revoked_at IS NULL`, [code]
    );
    const expired = invite?.expires_at && invite.expires_at < new Date().toISOString();
    const exhausted = invite && invite.max_uses > 0 && invite.uses >= invite.max_uses;
    if (!invite || expired || exhausted) throw ApiError.notFound('Invite');
    serverId = invite.server_id;
  }
  const row = await loadProfileRow(serverId);
  if (!row) throw ApiError.notFound('Invite');
  const viewer = viewerId ? await resolvePermissions({ userId: viewerId, serverId }) : { isMember: false };
  return toProfile(row, { viewerIsMember: viewer.isMember });
}

/** MANAGE_GUILD: accent colour, traits, discovery opt-in and category. */
export async function updateServerProfile({ serverId, actorId, patch = {} }) {
  await assertPermission({ userId: actorId, serverId, permission: 'MANAGE_GUILD' });
  const before = await getQuery(`SELECT * FROM servers WHERE id = ? AND deleted_at IS NULL`, [serverId]);
  if (!before) throw ApiError.notFound('Server');

  const sets = [];
  const params = [];
  const changes = [];
  const set = (column, value, old) => {
    sets.push(`${column} = ?`);
    params.push(value);
    changes.push({ key: column, old: old ?? null, new: value });
  };

  if (patch.accent_color !== undefined) set('accent_color', normaliseColor(patch.accent_color, 'accent_color'), before.accent_color);
  if (patch.traits !== undefined) set('traits', JSON.stringify(validateTraits(patch.traits)), before.traits);
  if (patch.discovery_category !== undefined) {
    const category = patch.discovery_category || null;
    if (category !== null && !DISCOVERY_CATEGORIES.includes(category)) {
      throw new ApiError(`discovery_category must be one of ${DISCOVERY_CATEGORIES.join(', ')}`, { code: 'INVALID_CATEGORY' });
    }
    set('discovery_category', category, before.discovery_category);
  }
  if (patch.discoverable !== undefined) {
    const features = featuresOf(before).filter((f) => f !== 'DISCOVERABLE');
    if (patch.discoverable) {
      // A listing with nothing to read is not worth showing: ask for a
      // description first, as Discord's discovery checklist does.
      const description = String(patch.description ?? before.description ?? '').trim();
      if (!description) {
        throw new ApiError('Add a server description before listing it in Discover', { code: 'DISCOVERY_NEEDS_DESCRIPTION' });
      }
      features.push('DISCOVERABLE');
    }
    set('features', JSON.stringify(features), before.features);
  }
  if (!sets.length) return getServerProfile({ serverId, viewerId: actorId });

  sets.push(`updated_at = ${sql.now}`);
  params.push(serverId);
  await runQuery(`UPDATE servers SET ${sets.join(', ')} WHERE id = ?`, params);
  await writeAuditLog({
    serverId, userId: actorId, actionType: 'SERVER_UPDATE', targetType: 'server', targetId: serverId, changes
  });
  return getServerProfile({ serverId, viewerId: actorId });
}

// --- discovery ---------------------------------------------------------------

const discoverableSql = isPostgres
  ? `s.features @> '["DISCOVERABLE"]'::jsonb`
  : `EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(s.features) THEN s.features ELSE '[]' END) WHERE json_each.value = 'DISCOVERABLE')`;

/**
 * Servers on this instance that opted into Discover, most members first.
 * `q` matches name, description and trait labels; `category` narrows to one
 * discovery category. Pages with `offset` (a listing is small on one instance).
 */
export async function listDiscoverable({ viewerId, q = '', category = null, limit = 24, offset = 0 } = {}) {
  const where = ['s.deleted_at IS NULL', discoverableSql];
  const params = [];
  if (category) {
    if (!DISCOVERY_CATEGORIES.includes(category)) {
      throw new ApiError(`category must be one of ${DISCOVERY_CATEGORIES.join(', ')}`, { code: 'INVALID_CATEGORY' });
    }
    where.push('s.discovery_category = ?');
    params.push(category);
  }
  const term = String(q ?? '').trim().slice(0, 100);
  if (term) {
    const like = `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(`(s.name ${sql.like} ? ESCAPE '\\' OR COALESCE(s.description, '') ${sql.like} ? ESCAPE '\\'
                 OR COALESCE(${sql.text('s.traits')}, '') ${sql.like} ? ESCAPE '\\')`);
    params.push(like, like, like);
  }
  const size = Math.min(50, Math.max(1, Number(limit) || 24));
  const skip = Math.max(0, Number(offset) || 0);
  const rows = await allQuery(
    `SELECT ${PROFILE_COLUMNS}, ${onlineCountSql()} AS online_count,
            ${viewerId ? `(SELECT count(*) FROM server_members me WHERE me.server_id = s.id AND me.user_id = ? AND me.left_at IS NULL)` : '0'} AS viewer_member
       FROM servers s
      WHERE ${where.join(' AND ')}
      ORDER BY s.member_count DESC, s.id ASC
      LIMIT ${size + 1} OFFSET ${skip}`,
    viewerId ? [viewerId, ...params] : params
  );
  return {
    servers: rows.slice(0, size).map((row) => toProfile(row, { viewerIsMember: Number(row.viewer_member) > 0 })),
    has_more: rows.length > size,
    categories: DISCOVERY_CATEGORIES
  };
}
