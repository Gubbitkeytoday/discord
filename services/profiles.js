// ============================================================================
//  Profiles — identity beyond the basic fields: theme colours, name styles,
//  custom status expiry, server tags, badges, the compact "identity" payload
//  every surface renders, profile reports and moderator resets.
//
//  Text a person shows to others (display name, bio, pronouns, status, server
//  tag, per-server fields) is checked on save with AutoMod's normalisation
//  (services/admin/textNormalize.js): global fields against the instance-wide
//  severe lists, server-scoped fields additionally against that server's
//  keyword rules.
// ============================================================================

import { runQuery, getQuery, allQuery, sql } from '../db.js';
import { generateId } from '../lib/snowflake.js';
import { ApiError } from '../lib/httpUtils.js';
import { normaliseColor } from '../lib/validate.js';
import { has } from '../lib/permissions.js';
import { findKeyword, baseNormalize, deLeet } from './admin/textNormalize.js';
import { AUTOMOD_PRESETS, expandKeywords } from './admin/automodPresets.js';
import * as cosmetics from './cosmetics.js';

const parseJson = (text, fallback = null) => { try { return text ? JSON.parse(text) : fallback; } catch { return fallback; } };
const nowIso = () => new Date().toISOString();

// --- limits -----------------------------------------------------------------------

export const LIMITS = Object.freeze({ bio: 300, pronouns: 40, custom_status: 128, display_name: 32, tag: 4 });

// --- AutoMod on identity text ------------------------------------------------------

// Always refused in anything shown to others, on every server.
const GLOBAL_LISTS = ['slurs', 'spam_links'];
// Server tags are four letters worn everywhere: stricter.
const TAG_LISTS = ['slurs', 'profanity_en', 'profanity_th', 'sexual'];

function presetWords(ids) {
  const words = []; const allow = [];
  for (const id of ids) {
    const preset = AUTOMOD_PRESETS[id];
    if (!preset) continue;
    words.push(...preset.words); allow.push(...preset.allow);
  }
  return { words, allow };
}

/**
 * Names that would pass as the instance, a moderator or a bot. A display
 * name, server nickname or tag that *is* one of these (after normalisation
 * and de-leeting) is refused for anyone but instance staff.
 */
export const RESERVED_NAMES = Object.freeze([
  'admin', 'administrator', 'admins', 'moderator', 'moderators', 'mod', 'mods', 'staff', 'system',
  'official', 'support', 'bot', 'root', 'owner', 'security', 'trustandsafety',
  'แอดมิน', 'ผู้ดูแล', 'ผู้ดูแลระบบ', 'ระบบ', 'ทีมงาน', 'เจ้าหน้าที่'
]);
export const RESERVED_TAGS = Object.freeze([
  'ADMN', 'ADM', 'ADMI', 'MOD', 'MODS', 'STAF', 'STFF', 'BOT', 'BOTS', 'SYS', 'SYST', 'DEV', 'DEVS',
  'OFCL', 'OFFL', 'HELP', 'SUPP', 'TEAM', 'ROOT', 'OWNR', 'SAFE', 'TNS', 'แอด'
]);

const squash = (text) => deLeet(baseNormalize(text)).replace(/[^\p{L}\p{N}]+/gu, '');

export function isReservedName(text) {
  const key = squash(text);
  return Boolean(key) && RESERVED_NAMES.some((r) => squash(r) === key);
}

function blocked(field, message = 'This contains words that are not allowed here') {
  return new ApiError(message, { code: 'PROFILE_TEXT_BLOCKED', details: { field } });
}

/**
 * Check identity text. `fields` maps field → text. With `serverId`, that
 * server's enabled keyword rules also apply (Discord's "member profile" rule).
 */
export async function checkIdentityText(fields, { serverId = null, lists = GLOBAL_LISTS } = {}) {
  const { words, allow } = presetWords(lists);
  let serverRules = [];
  if (serverId) {
    const rows = await allQuery(
      `SELECT trigger_metadata FROM automod_rules WHERE server_id = ? AND enabled = 1 AND trigger_type = 'keyword'`,
      [serverId]
    );
    serverRules = rows.map((r) => expandKeywords(parseJson(r.trigger_metadata, {})));
  }
  for (const [field, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue;
    const text = String(value);
    if (findKeyword(text, words, { allowList: allow })) throw blocked(field);
    for (const rule of serverRules) {
      if (findKeyword(text, rule.keywords, { allowList: rule.allow })) {
        throw blocked(field, 'This server’s AutoMod does not allow that');
      }
    }
  }
}

/** display_name / nickname impersonation guard (instance staff and bots exempt). */
export async function assertNotReservedName(field, text, userId) {
  if (!text || !isReservedName(text)) return;
  const row = await getQuery(`SELECT is_bot, instance_admin FROM users WHERE id = ?`, [userId]);
  if (row && (Number(row.is_bot) || Number(row.instance_admin))) return;
  throw new ApiError('That name is reserved', { code: 'NAME_RESERVED', details: { field } });
}

// --- bio -------------------------------------------------------------------------------

const BIDI_AND_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‎‏‪-‮⁦-⁩]/g;

/**
 * The stored bio: the safe markdown subset is decided by the renderer, but
 * the text is cleaned here so every client gets the same thing — no bidi
 * overrides (they disguise links), no control characters, at most 2 blank
 * lines in a row, and masked links only to http(s) (the label is kept).
 */
export function cleanBio(value) {
  if (value === null || value === undefined) return value;
  let text = String(value).replace(/\r\n?/g, '\n').replace(BIDI_AND_CONTROL, '');
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.replace(/\[([^\]\n]{1,200})\]\(\s*(?!https?:\/\/)(?:[^()\n]|\([^()\n]*\))*\)/gi, '$1');
  return text.trim();
}

// --- name style & theme ----------------------------------------------------------------

export const NAME_FONTS = Object.freeze(['default', 'kanit', 'sarabun', 'mali', 'itim', 'chakra', 'trirong']);
export const NAME_EFFECTS = Object.freeze(['solid', 'gradient', 'glow']);
/** Reserved for instance staff and bots: the verified look. */
export const RESERVED_EFFECTS = Object.freeze(['staff']);

const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
function luminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
// The app's darkest and lightest message backgrounds.
const THEME_BACKGROUNDS = ['#1c1d22', '#ffffff'];

export async function cleanNameStyle(value, userId) {
  if (value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new ApiError('name_style must be an object', { code: 'INVALID_NAME_STYLE' });
  }
  const font = value.font ?? 'default';
  const effect = value.effect ?? 'solid';
  if (!NAME_FONTS.includes(font)) throw new ApiError('Unknown font', { code: 'INVALID_NAME_STYLE' });
  if (RESERVED_EFFECTS.includes(effect)) {
    const row = await getQuery(`SELECT is_bot, instance_admin FROM users WHERE id = ?`, [userId]);
    if (!row || !(Number(row.is_bot) || Number(row.instance_admin))) {
      throw new ApiError('That style is reserved for staff and bots', { status: 403, code: 'NAME_STYLE_RESERVED' });
    }
  } else if (!NAME_EFFECTS.includes(effect)) {
    throw new ApiError('Unknown effect', { code: 'INVALID_NAME_STYLE' });
  }
  const colors = (Array.isArray(value.colors) ? value.colors : []).slice(0, 2)
    .map((c, i) => normaliseColor(c, `name_style.colors[${i}]`)).filter(Boolean);
  const needed = effect === 'gradient' ? 2 : 1;
  if (effect !== 'staff' && font === 'default' && colors.length === 0) return null; // nothing to style
  if (effect !== 'staff' && colors.length < needed) {
    throw new ApiError(`The ${effect} effect needs ${needed} colour${needed > 1 ? 's' : ''}`, { code: 'INVALID_NAME_STYLE' });
  }
  // Contrast guard: a colour must stay readable (3:1, large-text level) on at
  // least one of the app's themes; the client adds an outline on the other.
  for (const c of colors) {
    if (!THEME_BACKGROUNDS.some((bg) => contrast(c, bg) >= 3)) {
      throw new ApiError('That colour is too hard to read', { code: 'INSUFFICIENT_CONTRAST', details: { color: c } });
    }
  }
  return { font, effect, colors: colors.slice(0, needed) };
}

export function cleanThemeColors(value) {
  if (value === null) return null;
  if (!Array.isArray(value) || value.length !== 2) {
    throw new ApiError('theme_colors must be [primary, accent]', { code: 'INVALID_THEME' });
  }
  return value.map((c, i) => normaliseColor(c, `theme_colors[${i}]`) ?? '#000000');
}

// --- custom status -----------------------------------------------------------------------

export const STATUS_DURATIONS = Object.freeze({ '30m': 30 * 60e3, '1h': 60 * 60e3, '4h': 4 * 60 * 60e3 });
const MAX_EXPIRY_MS = 25 * 60 * 60e3; // "today" is at most ~24 h away in any time zone

let segmenter = null;
const graphemes = (text) => {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  return [...segmenter.segment(String(text))].map((s) => s.segment);
};

export function cleanStatusEmoji(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (/^<a?:\w{2,32}:[\w-]{1,32}>$/.test(text)) return text;       // server emoji
  if (text.length <= 32 && graphemes(text).length === 1 && !/[\x00-\x7f]/.test(text)) return text;
  throw new ApiError('The status emoji must be a single emoji', { code: 'INVALID_EMOJI' });
}

/**
 * Resolve "clear after" to an absolute instant. 'today' needs the client's
 * local midnight (expires_at), since only the client knows its time zone.
 */
export function resolveExpiry({ clearAfter = 'never', expiresAt = null, now = Date.now() } = {}) {
  if (clearAfter === 'never' || clearAfter === null) {
    if (!expiresAt) return null;
  } else if (STATUS_DURATIONS[clearAfter]) {
    return new Date(now + STATUS_DURATIONS[clearAfter]).toISOString();
  } else if (clearAfter !== 'today' && clearAfter !== 'custom') {
    throw new ApiError('clear_after must be 30m, 1h, 4h, today or never', { code: 'INVALID_EXPIRY' });
  }
  const at = new Date(expiresAt ?? NaN).getTime();
  if (!Number.isFinite(at) || at <= now + 30e3 || at > now + MAX_EXPIRY_MS) {
    throw new ApiError('expires_at must be a time within the next 24 hours', { code: 'INVALID_EXPIRY' });
  }
  return new Date(at).toISOString();
}

export function isExpired(expiresAt, now = Date.now()) {
  if (!expiresAt) return false;
  const at = new Date(expiresAt).getTime();
  return Number.isFinite(at) && at <= now;
}

/** Hide an expired status on read, even before the sweeper has run. */
export function maskExpiredStatus(row) {
  if (!row || !isExpired(row.custom_status_expires_at)) return row;
  return { ...row, custom_status: null, custom_status_emoji: null, custom_status_expires_at: null };
}

export async function setCustomStatus({ userId, text, emoji, clearAfter = 'never', expiresAt = null }) {
  const clean = text === null || text === undefined ? '' : String(text).replace(BIDI_AND_CONTROL, '').trim();
  if (clean.length > LIMITS.custom_status) {
    throw new ApiError(`custom_status must be at most ${LIMITS.custom_status} characters`, { code: 'INVALID_FIELD' });
  }
  const cleanEmoji = cleanStatusEmoji(emoji);
  if (!clean && !cleanEmoji) {
    await runQuery(
      `UPDATE users SET custom_status = NULL, custom_status_emoji = NULL, custom_status_expires_at = NULL,
              updated_at = ${sql.now} WHERE id = ?`, [userId]
    );
    return { custom_status: null, custom_status_emoji: null, custom_status_expires_at: null };
  }
  await checkIdentityText({ custom_status: clean });
  const expires = resolveExpiry({ clearAfter, expiresAt });
  await runQuery(
    `UPDATE users SET custom_status = ?, custom_status_emoji = ?, custom_status_expires_at = ?,
            updated_at = ${sql.now} WHERE id = ? AND deleted_at IS NULL`,
    [clean || null, cleanEmoji, expires, userId]
  );
  return { custom_status: clean || null, custom_status_emoji: cleanEmoji, custom_status_expires_at: expires };
}

/** Clear every expired custom status; returns the user ids that changed. */
export async function sweepExpiredStatuses(now = nowIso()) {
  const rows = await allQuery(
    `SELECT id FROM users WHERE custom_status_expires_at IS NOT NULL AND custom_status_expires_at <= ? LIMIT 500`,
    [now]
  );
  const cleared = [];
  for (const { id } of rows) {
    const res = await runQuery(
      `UPDATE users SET custom_status = NULL, custom_status_emoji = NULL, custom_status_expires_at = NULL
        WHERE id = ? AND custom_status_expires_at IS NOT NULL AND custom_status_expires_at <= ?`,
      [id, now]
    );
    if (res?.changes) cleared.push(id);
  }
  return cleared;
}

// --- server tags --------------------------------------------------------------------------

export const TAG_ICONS = Object.freeze([
  'leaf', 'star', 'heart', 'bolt', 'flame', 'moon', 'sun', 'gem', 'music', 'gamepad', 'sword',
  'flower', 'lotus', 'elephant', 'paw', 'coffee', 'rocket', 'cloud', 'snowflake', 'anchor', 'code', 'book'
]);

/**
 * Normalise and validate a tag: 2–4 characters (graphemes, so Thai counts
 * right), A–Z, 0–9 or Thai; not reserved; not caught by AutoMod.
 */
export async function cleanServerTag(raw, { serverId = null } = {}) {
  const tag = String(raw ?? '').normalize('NFKC').trim().toUpperCase().replace(/\s+/g, '');
  const count = graphemes(tag).length;
  if (count < 2 || count > LIMITS.tag) {
    throw new ApiError('A server tag is 2 to 4 characters', { code: 'INVALID_TAG' });
  }
  if (!/^[A-Z0-9ก-๎]+$/u.test(tag)) {
    throw new ApiError('Use letters A–Z, digits or Thai letters', { code: 'INVALID_TAG' });
  }
  const key = squash(tag).toUpperCase();
  if (RESERVED_TAGS.some((r) => squash(r).toUpperCase() === key)) {
    throw new ApiError('That tag is reserved', { code: 'TAG_RESERVED' });
  }
  await checkIdentityText({ tag }, { serverId, lists: TAG_LISTS });
  // Leet-speak spellings of listed words ("B1TC") are caught too.
  await checkIdentityText({ tag: deLeet(tag.toLowerCase()) }, { lists: TAG_LISTS });
  return tag;
}

export async function getServerTag(serverId) {
  const row = await getQuery(`SELECT server_id, tag, icon, color, enabled, updated_at FROM server_tags WHERE server_id = ?`, [serverId]);
  return row ? { ...row, enabled: Boolean(Number(row.enabled)) } : null;
}

export async function setServerTag({ serverId, actorId, tag, icon = 'leaf', color = null, enabled = true }) {
  const clean = await cleanServerTag(tag, { serverId });
  if (!TAG_ICONS.includes(icon)) throw new ApiError('Unknown tag icon', { code: 'INVALID_TAG_ICON' });
  const hex = normaliseColor(color, 'color');
  await runQuery(
    `INSERT INTO server_tags (server_id, tag, icon, color, enabled, updated_by, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ${sql.now})
     ON CONFLICT (server_id) DO UPDATE SET tag = excluded.tag, icon = excluded.icon, color = excluded.color,
       enabled = excluded.enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    [serverId, clean, icon, hex, enabled ? 1 : 0, actorId]
  );
  await writeAudit({ serverId, userId: actorId, actionType: 'SERVER_TAG_UPDATE', targetType: 'server', targetId: serverId,
    changes: [{ key: 'tag', new: clean }, { key: 'icon', new: icon }, { key: 'enabled', new: Boolean(enabled) }] });
  return getServerTag(serverId);
}

export async function deleteServerTag({ serverId, actorId }) {
  await runQuery(`DELETE FROM server_tags WHERE server_id = ?`, [serverId]);
  await writeAudit({ serverId, userId: actorId, actionType: 'SERVER_TAG_DELETE', targetType: 'server', targetId: serverId });
  return { deleted: true };
}

/** Servers the user is in that offer a tag — the "wear a tag" picker. */
export function listWearableTags(userId) {
  return allQuery(
    `SELECT t.server_id, t.tag, t.icon, t.color, s.name AS server_name, s.icon_url AS server_icon
       FROM server_tags t
       JOIN servers s ON s.id = t.server_id AND s.deleted_at IS NULL
       JOIN server_members sm ON sm.server_id = t.server_id AND sm.user_id = ? AND sm.left_at IS NULL
      WHERE t.enabled = 1
      ORDER BY s.name`, [userId]
  );
}

// --- audit helper (server audit log) ----------------------------------------------------

async function writeAudit({ serverId, userId, actionType, targetType = null, targetId = null, changes = [], reason = null }) {
  if (!serverId) return;
  await runQuery(
    `INSERT INTO audit_logs (id, server_id, user_id, action_type, target_type, target_id, changes, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [generateId(), serverId, userId, actionType, targetType, targetId, JSON.stringify(changes), reason]
  );
}

// --- identity settings (theme, name style, worn tag) ------------------------------------

export async function getIdentitySettings(userId) {
  const row = await getQuery(
    `SELECT theme_colors, name_style, primary_server_tag_id, avatar_decoration_id, profile_effect_id,
            nameplate_id, profile_frame_id, custom_status, custom_status_emoji, custom_status_expires_at
       FROM users WHERE id = ? AND deleted_at IS NULL`, [userId]
  );
  if (!row) throw ApiError.notFound('User');
  const status = maskExpiredStatus(row);
  return {
    theme_colors: parseJson(row.theme_colors, null),
    name_style: parseJson(row.name_style, null),
    primary_server_tag_id: row.primary_server_tag_id ?? null,
    avatar_decoration_id: row.avatar_decoration_id ?? null,
    profile_effect_id: row.profile_effect_id ?? null,
    nameplate_id: row.nameplate_id ?? null,
    profile_frame_id: row.profile_frame_id ?? null,
    custom_status: status.custom_status ?? null,
    custom_status_emoji: status.custom_status_emoji ?? null,
    custom_status_expires_at: status.custom_status_expires_at ?? null,
    wearable_tags: await listWearableTags(userId)
  };
}

export async function updateIdentitySettings({ userId, patch = {} }) {
  const sets = []; const params = [];
  if (patch.theme_colors !== undefined) {
    const v = cleanThemeColors(patch.theme_colors);
    sets.push('theme_colors = ?'); params.push(v ? JSON.stringify(v) : null);
  }
  if (patch.name_style !== undefined) {
    const v = await cleanNameStyle(patch.name_style, userId);
    sets.push('name_style = ?'); params.push(v ? JSON.stringify(v) : null);
  }
  if (patch.primary_server_tag_id !== undefined) {
    const serverId = patch.primary_server_tag_id;
    if (serverId !== null) {
      const ok = await getQuery(
        `SELECT 1 FROM server_tags t JOIN server_members sm ON sm.server_id = t.server_id
          WHERE t.server_id = ? AND t.enabled = 1 AND sm.user_id = ? AND sm.left_at IS NULL`,
        [String(serverId), userId]
      );
      if (!ok) throw new ApiError('You can only wear the tag of a server you are in', { status: 403, code: 'TAG_NOT_AVAILABLE' });
    }
    sets.push('primary_server_tag_id = ?'); params.push(serverId);
  }
  const equipPatch = {};
  for (const kind of cosmetics.KINDS) {
    const col = cosmetics.KIND_COLUMN[kind];
    if (patch[col] !== undefined) equipPatch[kind] = patch[col];
  }
  if (Object.keys(equipPatch).length) await cosmetics.equip({ userId, patch: equipPatch });
  if (sets.length) {
    await runQuery(`UPDATE users SET ${sets.join(', ')}, updated_at = ${sql.now} WHERE id = ?`, [...params, userId]);
  }
  return getIdentitySettings(userId);
}

// --- badges --------------------------------------------------------------------------------

export const BADGE_ICONS = Object.freeze([
  'star', 'trophy', 'heart', 'bolt', 'flame', 'gem', 'music', 'gamepad', 'book', 'code', 'leaf',
  'flower', 'lotus', 'elephant', 'rocket', 'medal', 'palette', 'camera', 'mic', 'handshake'
]);
const MAX_SERVER_BADGES = 10;
const EARLY_MEMBERS = Math.max(1, Number(process.env.PROFILE_EARLY_MEMBERS) || 100);

let earlyCutoff = { at: 0, row: null, total: 0 };
async function earlyMemberCutoff() {
  if (Date.now() - earlyCutoff.at < 60_000) return earlyCutoff;
  const row = await getQuery(
    `SELECT id, created_at FROM users WHERE is_bot = 0 AND is_system = 0
      ORDER BY created_at ASC, id ASC LIMIT 1 OFFSET ${EARLY_MEMBERS - 1}`
  );
  earlyCutoff = { at: Date.now(), row: row ?? null };
  return earlyCutoff;
}

function isEarly(user, cutoff) {
  if (Number(user.is_bot) || Number(user.is_system)) return false;
  if (!cutoff.row) return true; // fewer than N people have ever joined
  const a = String(user.created_at); const b = String(cutoff.row.created_at);
  return a < b || (a === b && String(user.id) <= String(cutoff.row.id));
}

function systemBadges(user, cutoff, { isAdmin }) {
  const out = [];
  if (isAdmin) out.push({ id: 'system:staff', kind: 'system', slug: 'staff', icon: 'shield' });
  if (Number(user.is_bot)) out.push({ id: 'system:bot', kind: 'system', slug: 'bot', icon: 'bot' });
  if (isEarly(user, cutoff)) out.push({ id: 'system:early', kind: 'system', slug: 'early', icon: 'sparkles' });
  if (Number(user.email_verified)) out.push({ id: 'system:verified', kind: 'system', slug: 'verified', icon: 'mail' });
  // Donated to the instance (services/payments). Cosmetic only — the one and
  // only thing a payment gets — and the supporter may choose to hide it.
  if (user.supporter_since && !Number(user.supporter_badge_hidden)) {
    out.push({ id: 'system:supporter', kind: 'system', slug: 'supporter', icon: 'supporter', granted_at: user.supporter_since });
  }
  return out;
}

const shapeBadge = (b) => ({
  id: b.id, kind: b.kind, server_id: b.server_id ?? null, name: b.name, description: b.description ?? null,
  icon: b.icon, color: b.color ?? null, granted_at: b.granted_at ?? null
});

export async function listServerBadges(serverId) {
  const rows = await allQuery(
    `SELECT b.*, (SELECT count(*) FROM user_badges ub WHERE ub.badge_id = b.id) AS holders
       FROM badges b WHERE b.kind = 'server' AND b.server_id = ? ORDER BY b.position, b.created_at`, [serverId]
  );
  return rows.map((b) => ({ ...shapeBadge(b), holders: Number(b.holders) }));
}

export function listInstanceBadges() {
  return allQuery(`SELECT * FROM badges WHERE kind = 'instance' ORDER BY position, created_at`).then((r) => r.map(shapeBadge));
}

function cleanBadgeInput(input) {
  const name = String(input?.name ?? '').replace(BIDI_AND_CONTROL, '').trim().slice(0, 32);
  if (name.length < 2) throw new ApiError('A badge needs a name (2–32 characters)', { code: 'INVALID_BADGE' });
  const description = String(input?.description ?? '').replace(BIDI_AND_CONTROL, '').trim().slice(0, 120) || null;
  const icon = input?.icon ?? 'star';
  if (!BADGE_ICONS.includes(icon)) throw new ApiError('Unknown badge icon', { code: 'INVALID_BADGE' });
  return { name, description, icon, color: normaliseColor(input?.color ?? null, 'color') };
}

export async function createBadge({ kind, serverId = null, actorId, input }) {
  const clean = cleanBadgeInput(input);
  if (isReservedName(clean.name)) throw new ApiError('That badge name is reserved', { code: 'NAME_RESERVED' });
  await checkIdentityText({ name: clean.name, description: clean.description }, { serverId, lists: TAG_LISTS });
  if (kind === 'server') {
    const n = await getQuery(`SELECT count(*) AS n FROM badges WHERE kind = 'server' AND server_id = ?`, [serverId]);
    if (Number(n?.n ?? 0) >= MAX_SERVER_BADGES) {
      throw new ApiError(`A server can have at most ${MAX_SERVER_BADGES} badges`, { code: 'TOO_MANY_BADGES' });
    }
  }
  const id = generateId();
  await runQuery(
    `INSERT INTO badges (id, kind, server_id, name, description, icon, color, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, kind, kind === 'server' ? serverId : null, clean.name, clean.description, clean.icon, clean.color, actorId]
  );
  if (kind === 'server') {
    await writeAudit({ serverId, userId: actorId, actionType: 'BADGE_CREATE', targetType: 'badge', targetId: id,
      changes: [{ key: 'name', new: clean.name }] });
  }
  return shapeBadge(await getQuery(`SELECT * FROM badges WHERE id = ?`, [id]));
}

export async function getBadge(badgeId) {
  const row = await getQuery(`SELECT * FROM badges WHERE id = ?`, [badgeId]);
  if (!row) throw ApiError.notFound('Badge');
  return row;
}

export async function deleteBadge({ badge, actorId }) {
  await runQuery(`DELETE FROM user_badges WHERE badge_id = ?`, [badge.id]);
  await runQuery(`DELETE FROM badges WHERE id = ?`, [badge.id]);
  if (badge.server_id) {
    await writeAudit({ serverId: badge.server_id, userId: actorId, actionType: 'BADGE_DELETE', targetType: 'badge',
      targetId: badge.id, changes: [{ key: 'name', old: badge.name }] });
  }
  return { deleted: true };
}

export async function grantBadge({ badge, userId, actorId, note = null, revoke = false }) {
  if (badge.kind === 'server') {
    const member = await getQuery(
      `SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ? AND left_at IS NULL`, [badge.server_id, userId]
    );
    if (!member && !revoke) throw new ApiError('That person is not a member of this server', { status: 404, code: 'NOT_A_MEMBER' });
  } else if (!(await getQuery(`SELECT 1 FROM users WHERE id = ? AND deleted_at IS NULL`, [userId]))) {
    throw ApiError.notFound('User');
  }
  if (revoke) {
    await runQuery(`DELETE FROM user_badges WHERE user_id = ? AND badge_id = ?`, [userId, badge.id]);
  } else {
    await runQuery(
      `INSERT INTO user_badges (user_id, badge_id, granted_by, note) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING`,
      [userId, badge.id, actorId, note ? String(note).slice(0, 120) : null]
    );
  }
  if (badge.server_id) {
    await writeAudit({ serverId: badge.server_id, userId: actorId, actionType: revoke ? 'BADGE_REVOKE' : 'BADGE_GRANT',
      targetType: 'user', targetId: userId, changes: [{ key: 'badge', new: badge.name }] });
  }
  return { granted: !revoke };
}

// --- identity (the compact payload every surface renders) --------------------------------

const IDENTITY_USER_COLUMNS = `id, is_bot, is_system, created_at, email, email_verified, instance_admin, disabled_at,
  deleted_at, theme_colors, name_style, avatar_decoration_id, profile_effect_id, nameplate_id, profile_frame_id,
  primary_server_tag_id, supporter_since, supporter_badge_hidden`;

/**
 * Identity for up to 200 users, keyed by id. With `serverId`: that server's
 * per-member overrides, hide-cosmetics setting, 🌱 new-member flag, server
 * badges and moderator tag hiding apply.
 */
export async function identities(userIds, { serverId = null } = {}) {
  const ids = [...new Set((userIds ?? []).map(String).filter(Boolean))].slice(0, 200);
  if (!ids.length) return Object.create(null);
  const marks = ids.map(() => '?').join(',');
  const users = await allQuery(
    `SELECT ${IDENTITY_USER_COLUMNS} FROM users WHERE id IN (${marks}) AND deleted_at IS NULL`, ids
  );
  const admin = await import('./instanceAdmin.js');

  let server = null; const members = new Map();
  if (serverId) {
    server = await getQuery(
      `SELECT id, cosmetics_hidden, new_member_badge_days FROM servers WHERE id = ? AND deleted_at IS NULL`, [serverId]
    );
    if (server) {
      const rows = await allQuery(
        `SELECT user_id, joined_at, profile_overrides, tag_hidden FROM server_members
          WHERE server_id = ? AND left_at IS NULL AND user_id IN (${marks})`, [serverId, ...ids]
      );
      for (const r of rows) members.set(r.user_id, r);
    }
  }

  // Worn tags: only while still a member of that server, and while enabled.
  const tagServerIds = [...new Set(users.map((u) => u.primary_server_tag_id).filter(Boolean))];
  const tags = new Map();
  if (tagServerIds.length) {
    const rows = await allQuery(
      `SELECT t.server_id, t.tag, t.icon, t.color, s.name AS server_name
         FROM server_tags t JOIN servers s ON s.id = t.server_id AND s.deleted_at IS NULL
        WHERE t.enabled = 1 AND t.server_id IN (${tagServerIds.map(() => '?').join(',')})`, tagServerIds
    );
    for (const r of rows) tags.set(r.server_id, r);
  }
  const wearing = new Set();
  if (tagServerIds.length) {
    const rows = await allQuery(
      `SELECT user_id, server_id FROM server_members WHERE left_at IS NULL AND user_id IN (${marks})
          AND server_id IN (${tagServerIds.map(() => '?').join(',')})`, [...ids, ...tagServerIds]
    );
    for (const r of rows) wearing.add(`${r.user_id}:${r.server_id}`);
  }

  const badgeRows = await allQuery(
    `SELECT ub.user_id, ub.granted_at, b.* FROM user_badges ub JOIN badges b ON b.id = ub.badge_id
      WHERE ub.user_id IN (${marks}) AND (b.kind = 'instance' ${serverId ? 'OR (b.kind = \'server\' AND b.server_id = ?)' : ''})
      ORDER BY b.kind, b.position, b.created_at`, serverId ? [...ids, serverId] : ids
  );
  const badgesByUser = new Map();
  for (const b of badgeRows) {
    if (!badgesByUser.has(b.user_id)) badgesByUser.set(b.user_id, []);
    badgesByUser.get(b.user_id).push(shapeBadge(b));
  }

  const cutoff = await earlyMemberCutoff();
  const equippedIds = new Map();
  const allItemIds = [];
  for (const u of users) {
    const overrides = parseJson(members.get(u.id)?.profile_overrides, {}) ?? {};
    const pick = {};
    for (const kind of cosmetics.KINDS) {
      const col = cosmetics.KIND_COLUMN[kind];
      pick[kind] = Object.prototype.hasOwnProperty.call(overrides, col) ? overrides[col] : u[col];
      if (pick[kind]) allItemIds.push(pick[kind]);
    }
    equippedIds.set(u.id, pick);
  }
  const items = await cosmetics.itemsById(allItemIds);
  const hideCosmetics = Boolean(Number(server?.cosmetics_hidden ?? 0));
  const newDays = Number(server?.new_member_badge_days ?? 7);

  // Keyed by user id: no prototype, so an id can never reach Object.prototype.
  const out = Object.create(null);
  for (const u of users) {
    const pick = equippedIds.get(u.id);
    const member = members.get(u.id);
    const tagRow = u.primary_server_tag_id && wearing.has(`${u.id}:${u.primary_server_tag_id}`)
      ? tags.get(u.primary_server_tag_id) : null;
    const joinedMs = member?.joined_at ? new Date(member.joined_at).getTime() : NaN;
    const isNew = Boolean(server) && newDays > 0 && Number.isFinite(joinedMs)
      && Date.now() - joinedMs < newDays * 86400e3 && !Number(u.is_bot);
    const badges = [
      ...systemBadges(u, cutoff, { isAdmin: admin.isAdminRow(u) }),
      ...(badgesByUser.get(u.id) ?? [])
    ];
    out[u.id] = {
      user_id: u.id,
      decoration: hideCosmetics ? null : (items.get(pick.avatar_decoration) ?? null),
      effect: hideCosmetics ? null : (items.get(pick.profile_effect) ?? null),
      nameplate: hideCosmetics ? null : (items.get(pick.nameplate) ?? null),
      frame: hideCosmetics ? null : (items.get(pick.profile_frame) ?? null),
      name_style: hideCosmetics ? null : parseJson(u.name_style, null),
      theme_colors: parseJson(u.theme_colors, null),
      tag: tagRow && !Number(member?.tag_hidden ?? 0)
        ? { server_id: tagRow.server_id, tag: tagRow.tag, icon: tagRow.icon, color: tagRow.color ?? null, server_name: tagRow.server_name }
        : null,
      badges,
      new_member: isNew,
      joined_at: member?.joined_at ?? null,
      cosmetics_hidden: hideCosmetics
    };
  }
  return out;
}

export async function identityOf(userId, opts) {
  const all = await identities([userId], opts);
  return Object.hasOwn(all, userId) ? all[userId] : null;
}

// --- mutual friends ------------------------------------------------------------------------

export async function mutualFriends(viewerId, userId, limit = 100) {
  if (!viewerId || viewerId === userId) return [];
  return allQuery(
    `SELECT u.id, u.username, u.display_name, u.avatar_url
       FROM users u
      WHERE u.deleted_at IS NULL AND u.id <> ? AND u.id <> ?
        AND EXISTS (SELECT 1 FROM friends f WHERE f.status = 'accepted'
                      AND ((f.user_id = ? AND f.friend_id = u.id) OR (f.friend_id = ? AND f.user_id = u.id)))
        AND EXISTS (SELECT 1 FROM friends f WHERE f.status = 'accepted'
                      AND ((f.user_id = ? AND f.friend_id = u.id) OR (f.friend_id = ? AND f.user_id = u.id)))
      ORDER BY u.display_name LIMIT ${Math.max(1, Math.min(100, Number(limit) || 100))}`,
    [viewerId, userId, viewerId, viewerId, userId, userId]
  );
}

// --- moderation ------------------------------------------------------------------------------

export async function assertServerPermission(guilds, { userId, serverId, permission }) {
  const resolved = await guilds.resolvePermissions({ userId, serverId });
  if (!resolved.isMember) throw ApiError.forbidden('You are not a member of this server');
  if (!resolved.isOwner && !has(resolved.permissions, permission)) {
    throw ApiError.forbidden(`You need the ${permission} permission`);
  }
  return resolved;
}

/**
 * A moderator resets a member's look *in this server*: per-server cosmetics
 * are cleared and, unless `hide_tag` is false, their worn tag stops showing
 * here. `unhide_tag` reverses the tag part. Audit-logged.
 */
export async function resetMemberIdentity({ serverId, actorId, userId, hideTag = true, unhideTag = false, reason = null }) {
  const member = await getQuery(
    `SELECT profile_overrides, tag_hidden FROM server_members WHERE server_id = ? AND user_id = ? AND left_at IS NULL`,
    [serverId, userId]
  );
  if (!member) throw ApiError.notFound('Member');
  const server = await getQuery(`SELECT owner_id FROM servers WHERE id = ?`, [serverId]);
  if (server?.owner_id === userId && actorId !== userId) throw ApiError.forbidden('The server owner cannot be reset');
  const tagHidden = unhideTag ? 0 : (hideTag ? 1 : Number(member.tag_hidden ?? 0));
  await runQuery(
    `UPDATE server_members SET profile_overrides = NULL, tag_hidden = ? WHERE server_id = ? AND user_id = ?`,
    [tagHidden, serverId, userId]
  );
  await writeAudit({
    serverId, userId: actorId, actionType: 'MEMBER_PROFILE_RESET', targetType: 'user', targetId: userId,
    reason: reason ? String(reason).slice(0, 512) : null,
    changes: [
      { key: 'profile_overrides', old: parseJson(member.profile_overrides, null), new: null },
      { key: 'tag_hidden', old: Boolean(Number(member.tag_hidden)), new: Boolean(tagHidden) }
    ]
  });
  return { reset: true, tag_hidden: Boolean(tagHidden) };
}

export async function setServerCosmeticsSettings({ serverId, actorId, patch }) {
  const sets = []; const params = []; const changes = [];
  if (patch.cosmetics_hidden !== undefined) {
    sets.push('cosmetics_hidden = ?'); params.push(patch.cosmetics_hidden ? 1 : 0);
    changes.push({ key: 'cosmetics_hidden', new: Boolean(patch.cosmetics_hidden) });
  }
  if (patch.new_member_badge_days !== undefined) {
    const days = Math.round(Number(patch.new_member_badge_days));
    if (!Number.isFinite(days) || days < 0 || days > 30) {
      throw new ApiError('new_member_badge_days must be 0–30', { code: 'INVALID_FIELD' });
    }
    sets.push('new_member_badge_days = ?'); params.push(days);
    changes.push({ key: 'new_member_badge_days', new: days });
  }
  if (sets.length) {
    await runQuery(`UPDATE servers SET ${sets.join(', ')} WHERE id = ?`, [...params, serverId]);
    await writeAudit({ serverId, userId: actorId, actionType: 'SERVER_COSMETICS_UPDATE', targetType: 'server', targetId: serverId, changes });
  }
  return getServerCosmeticsSettings(serverId);
}

export async function getServerCosmeticsSettings(serverId) {
  const row = await getQuery(`SELECT cosmetics_hidden, new_member_badge_days FROM servers WHERE id = ?`, [serverId]);
  if (!row) throw ApiError.notFound('Server');
  return { cosmetics_hidden: Boolean(Number(row.cosmetics_hidden)), new_member_badge_days: Number(row.new_member_badge_days) };
}

// --- profile report snapshot -----------------------------------------------------------------

/**
 * What a reported profile looked like when it was reported — profiles
 * change, and a moderator must judge what the reporter saw.
 */
export async function profileSnapshot(userId, { serverId = null } = {}) {
  const user = await getQuery(
    `SELECT id, username, display_name, avatar_url, banner_url, bio, pronouns, custom_status,
            custom_status_emoji, accent_color, created_at FROM users WHERE id = ?`, [userId]
  );
  if (!user) throw ApiError.notFound('User');
  const identity = await identityOf(userId, { serverId });
  let member = null;
  if (serverId) {
    member = await getQuery(
      `SELECT nickname, bio, pronouns, avatar_url, joined_at FROM server_members WHERE server_id = ? AND user_id = ?`,
      [serverId, userId]
    );
  }
  return {
    captured_at: nowIso(),
    user,
    member,
    identity: identity && {
      decoration: identity.decoration?.id ?? null,
      effect: identity.effect?.id ?? null,
      nameplate: identity.nameplate?.id ?? null,
      frame: identity.frame?.id ?? null,
      name_style: identity.name_style,
      theme_colors: identity.theme_colors,
      tag: identity.tag,
      badges: identity.badges.map((b) => b.name ?? b.slug)
    }
  };
}
