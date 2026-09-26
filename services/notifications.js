// ============================================================================
//  Notification fan-out for a new message, and per-user notification settings.
//
//  services/messages.js calls fanOutMessageNotifications() once, after the
//  message has committed. Everything here is set-based: a fixed handful of
//  queries per message regardless of how many members the guild has, then one
//  or a few multi-row writes. Unread state itself is lazy — a channel is
//  unread when channels.last_message_id > read_states.last_read_message_id —
//  so the only per-member counter maintained on send is mention_count.
//
//  Semantics (Discord parity):
//
//    level      thread → parent channel → category → server, first explicit
//               value wins. The server's value is the member's own choice
//               (server_settings.level_override), else the guild's
//               default_notifications. Levels: all_messages | only_mentions |
//               nothing.
//    mention    a direct @user; a role mention (role mentionable, or author
//               holds MENTION_EVERYONE); @everyone / @here (author holds
//               MENTION_EVERYONE; @here only reaches people not offline).
//               suppress_everyone / suppress_roles on the member's server
//               settings drop those kinds entirely, badge included.
//    keyword    a highlight keyword of the recipient appears in the text. It
//               notifies like a mention but does not bump the mention badge.
//    mute       an active mute (muted = 1 and muted_until unset or in the
//               future) anywhere in the chain. In a guild a mute silences
//               "all messages" but a mention still comes through, as on
//               Discord ("…unless you are mentioned"). In a DM a mute
//               silences everything. An expired timed mute is simply inactive
//               (and the sweeper clears it).
//    blocked    nothing reaches someone who blocked the author: no badge, no
//               inbox row, no push.
//    DM         every message notifies unless the DM is muted or its level
//               says otherwise; every DM message counts toward the badge.
//
//  Outputs per message: mention_count bumps, inbox rows (type mention /
//  keyword / dm), realtime "notification_ping"s for all-messages-level
//  recipients (no inbox row), and web push for every notified recipient
//  (services/push.js decides device, focus and privacy).
// ============================================================================

import { runQuery, getQuery, allQuery, transaction } from '../db.js';
import { generateId } from '../lib/snowflake.js';
import { ApiError } from '../lib/httpUtils.js';
import {
  computeBasePermissions, computeChannelPermissions, has, ALL_PERMISSIONS
} from '../lib/permissions.js';
import * as push from './push.js';

export const LEVELS = ['all_messages', 'only_mentions', 'nothing'];
export const CHANNEL_LEVELS = ['inherit', ...LEVELS];
export const PUSH_CONTENT = ['full', 'name_only', 'hidden'];
const MAX_KEYWORDS = 25;
const MAX_KEYWORD_LENGTH = 50;
const WRITE_CHUNK = 300;

// Realtime handle for notification_ping. Set by routes/push.js; without it the
// pings are simply not delivered (inbox rows and push still are).
let gateway = null;
export function setNotificationGateway(io) { gateway = io; }

// --- pure helpers (exported for tests) ---------------------------------------

/** Is this settings row's mute in force right now? */
export function isMuteActive(row, now = Date.now()) {
  if (!row || !Number(row.muted)) return false;
  if (!row.muted_until) return true;
  const until = Date.parse(row.muted_until);
  return Number.isFinite(until) ? until > now : true;
}

/** The member's server-wide level: their own choice, else the guild default. */
export function resolveServerLevel(serverRow, guildDefault = 'all_messages') {
  if (serverRow?.level_override && LEVELS.includes(serverRow.level_override)) return serverRow.level_override;
  // Rows written before level_override existed only carried notification_level,
  // and 'all_messages' there is indistinguishable from "never chosen".
  if (serverRow?.notification_level && serverRow.notification_level !== 'all_messages'
      && LEVELS.includes(serverRow.notification_level)) {
    return serverRow.notification_level;
  }
  return LEVELS.includes(guildDefault) ? guildDefault : 'all_messages';
}

/** First explicit level along [thread, channel, category], else the server level. */
export function resolveLevel(channelRows, serverLevel) {
  for (const row of channelRows) {
    if (row?.notification_level && row.notification_level !== 'inherit' && LEVELS.includes(row.notification_level)) {
      return row.notification_level;
    }
  }
  return serverLevel;
}

/**
 * What a recipient gets for one message.
 * @returns 'mention' | 'keyword' | 'dm' | 'message' | null
 *   mention/keyword/dm → inbox row + push; message → realtime ping + push.
 */
export function decideNotification({ isDm, level, muted, mentioned, keyword }) {
  if (level === 'nothing') return null;
  if (isDm) {
    if (muted) return null;
    if (level === 'only_mentions') return mentioned ? 'dm' : null;
    return 'dm';
  }
  if (mentioned) return 'mention';
  if (keyword) return 'keyword';
  if (level === 'all_messages' && !muted) return 'message';
  return null;
}

/** Clean a keyword list: trimmed, deduplicated case-insensitively, bounded. */
export function normaliseKeywords(input) {
  if (!Array.isArray(input)) throw new ApiError('keywords must be an array of strings', { code: 'INVALID_KEYWORDS' });
  const seen = new Set();
  const out = [];
  for (const raw of input) {
    if (typeof raw !== 'string') throw new ApiError('keywords must be an array of strings', { code: 'INVALID_KEYWORDS' });
    const word = raw.trim().replace(/\s+/g, ' ');
    if (!word) continue;
    if (word.length > MAX_KEYWORD_LENGTH) {
      throw new ApiError(`A keyword is at most ${MAX_KEYWORD_LENGTH} characters`, { code: 'INVALID_KEYWORDS' });
    }
    const key = word.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(word);
  }
  if (out.length > MAX_KEYWORDS) {
    throw new ApiError(`At most ${MAX_KEYWORDS} keywords`, { code: 'INVALID_KEYWORDS' });
  }
  return out;
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A matcher for a keyword list. Keywords made of letters/digits match on word
 * boundaries ("art" does not fire on "start"); anything else — including
 * scripts written without spaces, like Thai — matches as a substring.
 */
export function keywordMatcher(keywords) {
  const parts = keywords.map((k) => {
    const body = escapeRegExp(k);
    return /^[\p{L}\p{N}_ ]+$/u.test(k) && /^[\x20-\x7e]+$/.test(k)
      ? `(?<![\\p{L}\\p{N}_])${body}(?![\\p{L}\\p{N}_])`
      : body;
  });
  if (!parts.length) return () => false;
  const re = new RegExp(parts.join('|'), 'iu');
  return (text) => re.test(text);
}

const parseKeywords = (json) => {
  try { const v = JSON.parse(json); return Array.isArray(v) ? v.filter((k) => typeof k === 'string') : []; }
  catch { return []; }
};

// --- bulk permission resolution ----------------------------------------------

/**
 * VIEW_CHANNEL for many members at once: the same rules as
 * services/guilds.js resolvePermissions + computeChannelPermissions, computed
 * from four queries instead of four per member. Members sharing a role set
 * (the vast majority) share one computation.
 */
async function viewersOf({ serverId, permissionChannelId, userIds }) {
  const [server, roles, memberRoles, overwrites] = await Promise.all([
    getQuery(`SELECT owner_id, default_notifications FROM servers WHERE id = ?`, [serverId]),
    allQuery(`SELECT id, permissions, mentionable FROM roles WHERE server_id = ?`, [serverId]),
    allQuery(`SELECT user_id, role_id FROM member_roles WHERE server_id = ?`, [serverId]),
    allQuery(
      `SELECT target_type, target_id, allow, deny FROM channel_overwrites WHERE channel_id = ?`,
      [permissionChannelId]
    )
  ]);
  const rolePerms = new Map(roles.map((r) => [r.id, r.permissions]));
  const rolesByUser = new Map();
  for (const { user_id: uid, role_id: rid } of memberRoles) {
    if (!rolesByUser.has(uid)) rolesByUser.set(uid, []);
    rolesByUser.get(uid).push(rid);
  }
  const memberOverwrite = new Set(overwrites.filter((o) => o.target_type === 'member').map((o) => o.target_id));
  const cache = new Map();
  const permissionsOf = new Map();
  const visible = new Set();
  for (const uid of userIds) {
    let perms;
    if (server?.owner_id === uid) {
      perms = ALL_PERMISSIONS;
    } else {
      // @everyone always applies, even when its member_roles row is missing.
      const ids = [...new Set([serverId, ...(rolesByUser.get(uid) ?? [])])].filter((id) => rolePerms.has(id)).sort();
      const key = memberOverwrite.has(uid) ? `${ids.join(',')}#${uid}` : ids.join(',');
      perms = cache.get(key);
      if (perms === undefined) {
        const base = computeBasePermissions({ isOwner: false, rolePermissions: ids.map((id) => rolePerms.get(id)) });
        perms = computeChannelPermissions({
          base, overwrites, everyoneRoleId: serverId, memberRoleIds: ids, userId: uid
        });
        cache.set(key, perms);
      }
    }
    permissionsOf.set(uid, perms);
    // A timeout keeps VIEW_CHANNEL, so it does not matter here.
    if (has(perms, 'VIEW_CHANNEL')) visible.add(uid);
  }
  return { visible, server, roles, rolesByUser };
}

/**
 * Which of these guild channels may one user view? `rows` carry channel_id,
 * server_id, channel_type and parent_id (a thread is judged by its parent).
 * Three queries per guild, however many channels.
 */
export async function visibleChannelIds(userId, rows) {
  const byServer = new Map();
  for (const row of rows) {
    if (!row.server_id) continue;
    if (!byServer.has(row.server_id)) byServer.set(row.server_id, []);
    byServer.get(row.server_id).push(row);
  }
  const visible = new Set();
  for (const [serverId, list] of byServer) {
    const [member, roles, overwrites] = await Promise.all([
      getQuery(
        `SELECT s.owner_id FROM server_members sm JOIN servers s ON s.id = sm.server_id
          WHERE sm.server_id = ? AND sm.user_id = ? AND sm.left_at IS NULL AND s.deleted_at IS NULL`,
        [serverId, userId]
      ),
      allQuery(
        `SELECT r.id, r.permissions FROM roles r
          WHERE r.server_id = ?
            AND (r.id = ? OR r.id IN (SELECT role_id FROM member_roles WHERE server_id = ? AND user_id = ?))`,
        [serverId, serverId, serverId, userId]
      ),
      allQuery(
        `SELECT o.channel_id, o.target_type, o.target_id, o.allow, o.deny
           FROM channel_overwrites o JOIN channels c ON c.id = o.channel_id
          WHERE c.server_id = ?`,
        [serverId]
      )
    ]);
    if (!member) continue;
    const isOwner = member.owner_id === userId;
    const base = computeBasePermissions({ isOwner, rolePermissions: roles.map((r) => r.permissions) });
    const roleIds = roles.map((r) => r.id);
    const overwritesOf = new Map();
    for (const o of overwrites) {
      if (!overwritesOf.has(o.channel_id)) overwritesOf.set(o.channel_id, []);
      overwritesOf.get(o.channel_id).push(o);
    }
    const verdict = new Map();
    for (const row of list) {
      const permissionChannelId = row.channel_type === 'thread' && row.parent_id ? row.parent_id : row.channel_id;
      if (!verdict.has(permissionChannelId)) {
        const perms = computeChannelPermissions({
          base, overwrites: overwritesOf.get(permissionChannelId) ?? [],
          everyoneRoleId: serverId, memberRoleIds: roleIds, userId
        });
        verdict.set(permissionChannelId, has(perms, 'VIEW_CHANNEL'));
      }
      if (verdict.get(permissionChannelId)) visible.add(row.channel_id);
    }
  }
  return visible;
}

// --- fan-out -----------------------------------------------------------------

async function loadChain(channelId) {
  return getQuery(
    `SELECT c.id, c.type, c.server_id, c.parent_id, c.name,
            p.type AS parent_type, p.parent_id AS grandparent_id
       FROM channels c LEFT JOIN channels p ON p.id = c.parent_id
      WHERE c.id = ?`,
    [channelId]
  );
}

async function loadAudience({ channel, isThread, serverId }) {
  if (isThread) {
    // Thread members who are still in the guild.
    return allQuery(
      `SELECT cr.user_id, u.status FROM channel_recipients cr
         JOIN users u ON u.id = cr.user_id
         JOIN server_members sm ON sm.server_id = ? AND sm.user_id = cr.user_id AND sm.left_at IS NULL
        WHERE cr.channel_id = ?`,
      [serverId, channel.id]
    );
  }
  if (serverId) {
    return allQuery(
      `SELECT sm.user_id, u.status FROM server_members sm
         JOIN users u ON u.id = sm.user_id
        WHERE sm.server_id = ? AND sm.left_at IS NULL`,
      [serverId]
    );
  }
  return allQuery(
    `SELECT cr.user_id, u.status FROM channel_recipients cr
       JOIN users u ON u.id = cr.user_id
      WHERE cr.channel_id = ?`,
    [channel.id]
  );
}

/** Multi-row write in chunks: `rowSql` is "(?, ?, …)", `rows` arrays of params. */
async function insertChunked(head, rowSql, rows, tail = '') {
  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    const chunk = rows.slice(i, i + WRITE_CHUNK);
    await runQuery(
      `${head} VALUES ${chunk.map(() => rowSql).join(', ')} ${tail}`,
      chunk.flat()
    );
  }
}

/**
 * Bump mention counters, write inbox rows, ping and push, for one new message.
 *
 * Returns the inbox rows (the gateway emits them as `notification`), with a
 * non-enumerable `reached` — everyone who may see the channel — used to scope
 * channel_activity.
 */
export async function fanOutMessageNotifications({
  channelId, authorId, mentions, messageId, content = '', authorPermissions = '0'
}) {
  const channel = await loadChain(channelId);
  const notifications = [];
  if (!channel) {
    Object.defineProperty(notifications, 'reached', { value: [], enumerable: false });
    return notifications;
  }
  const serverId = channel.server_id ?? null;
  const isThread = channel.type === 'thread';
  const isDm = !serverId;
  const preview = String(content ?? '').slice(0, 200);

  // Settings chain, nearest first: thread → parent channel → category.
  const chain = [channel.id];
  if (channel.parent_id) chain.push(channel.parent_id);
  if (isThread && channel.grandparent_id) chain.push(channel.grandparent_id);
  const permissionChannelId = isThread && channel.parent_id ? channel.parent_id : channel.id;

  const audienceRows = await loadAudience({ channel, isThread, serverId });
  const candidates = audienceRows.filter((r) => r.user_id !== authorId);
  const statusOf = new Map(candidates.map((r) => [r.user_id, r.status]));

  let visible;
  let guild = null;
  if (serverId) {
    guild = await viewersOf({ serverId, permissionChannelId, userIds: candidates.map((r) => r.user_id) });
    visible = guild.visible;
  } else {
    visible = new Set(candidates.map((r) => r.user_id));
  }
  const reached = candidates.map((r) => r.user_id).filter((uid) => visible.has(uid));

  const recipientScope = serverId && !isThread
    ? { sql: `SELECT user_id FROM server_members WHERE server_id = ? AND left_at IS NULL`, param: serverId }
    : { sql: `SELECT user_id FROM channel_recipients WHERE channel_id = ?`, param: channel.id };

  const [serverRows, channelRows, blockers, keywordRows] = await Promise.all([
    serverId
      ? allQuery(
          `SELECT user_id, muted, muted_until, notification_level, level_override,
                  suppress_everyone, suppress_roles
             FROM server_settings WHERE server_id = ?`,
          [serverId]
        )
      : [],
    allQuery(
      `SELECT user_id, channel_id, muted, muted_until, notification_level
         FROM channel_settings WHERE channel_id IN (${chain.map(() => '?').join(',')})`,
      chain
    ),
    authorId ? allQuery(`SELECT user_id FROM blocks WHERE blocked_id = ?`, [authorId]) : [],
    preview
      ? allQuery(
          `SELECT user_id, keywords FROM notification_prefs
            WHERE keywords <> '[]' AND user_id IN (${recipientScope.sql})`,
          [recipientScope.param]
        )
      : []
  ]);

  const serverByUser = new Map(serverRows.map((r) => [r.user_id, r]));
  const channelByUser = new Map();
  for (const row of channelRows) {
    if (!channelByUser.has(row.user_id)) channelByUser.set(row.user_id, new Map());
    channelByUser.get(row.user_id).set(row.channel_id, row);
  }
  const blockedBy = new Set(blockers.map((r) => r.user_id));
  const keywordsOf = new Map(keywordRows.map((r) => [r.user_id, keywordMatcher(parseKeywords(r.keywords))]));

  const canMentionEveryone = has(authorPermissions, 'MENTION_EVERYONE');
  const mentionedUsers = new Set(mentions?.users ?? []);
  // A role mention pings when the role is mentionable or the author may ping anyone.
  const pingRoles = new Set();
  if (serverId && mentions?.roles?.length) {
    for (const role of guild.roles) {
      if (mentions.roles.includes(role.id) && (Number(role.mentionable) || canMentionEveryone)) pingRoles.add(role.id);
    }
  }
  const guildDefault = guild?.server?.default_notifications ?? 'all_messages';
  const now = Date.now();

  const mentionBumps = [];
  const decisions = [];
  for (const uid of reached) {
    if (blockedBy.has(uid)) continue;
    const serverRow = serverByUser.get(uid);
    const perChannel = channelByUser.get(uid);
    const chainRows = chain.map((id) => perChannel?.get(id));

    let mentioned;
    if (isDm) {
      mentioned = true;   // every DM message counts toward the badge
    } else {
      mentioned = mentionedUsers.has(uid);
      if (!mentioned && canMentionEveryone && !Number(serverRow?.suppress_everyone)) {
        const status = statusOf.get(uid);
        if (mentions?.everyone) mentioned = true;
        else if (mentions?.here && status && status !== 'offline' && status !== 'invisible') mentioned = true;
      }
      if (!mentioned && pingRoles.size && !Number(serverRow?.suppress_roles)) {
        mentioned = (guild.rolesByUser.get(uid) ?? []).some((rid) => pingRoles.has(rid));
      }
    }
    if (mentioned) mentionBumps.push(uid);

    const muted = chainRows.some((row) => isMuteActive(row, now)) || isMuteActive(serverRow, now);
    const level = isDm
      ? resolveLevel(chainRows, 'all_messages')
      : resolveLevel(chainRows, resolveServerLevel(serverRow, guildDefault));
    const keyword = !mentioned && !isDm && (keywordsOf.get(uid)?.(preview) ?? false);
    const kind = decideNotification({
      isDm, level, muted,
      // In a DM, "only @mentions" (group DMs) means an explicit @user.
      mentioned: isDm ? mentionedUsers.has(uid) : mentioned,
      keyword
    });
    if (kind) decisions.push({ uid, kind });
  }

  const inbox = decisions.filter((d) => d.kind !== 'message');
  if (mentionBumps.length || inbox.length) {
    await transaction(async () => {
      if (mentionBumps.length) {
        await insertChunked(
          `INSERT INTO read_states (user_id, channel_id, mention_count)`,
          '(?, ?, 1)',
          mentionBumps.map((uid) => [uid, channelId]),
          `ON CONFLICT(user_id, channel_id) DO UPDATE SET mention_count = read_states.mention_count + 1`
        );
      }
      if (inbox.length) {
        const rows = inbox.map((d) => {
          const id = generateId();
          const type = d.kind === 'message' ? 'mention' : d.kind;
          notifications.push({
            id, user_id: d.uid, type, server_id: serverId, channel_id: channelId,
            message_id: messageId, actor_id: authorId, body: preview, preview
          });
          return [id, d.uid, type, serverId, channelId, messageId, authorId, preview];
        });
        await insertChunked(
          `INSERT INTO notifications (id, user_id, type, server_id, channel_id, message_id, actor_id, body)`,
          '(?, ?, ?, ?, ?, ?, ?, ?)',
          rows
        );
      }
    }, { isolation: 'read committed' });
  }

  const pings = decisions.filter((d) => d.kind === 'message').map((d) => d.uid);
  if (gateway && pings.length) {
    const payload = {
      channel_id: channelId, server_id: serverId, message_id: messageId,
      actor_id: authorId, preview, type: 'message'
    };
    for (const uid of pings) gateway.to(`user-${uid}`).emit('notification_ping', payload);
  }

  if (decisions.length && push.isEnabled()) {
    // Fire-and-forget: a slow push service must never hold up a send.
    push.sendMessagePush({
      recipients: decisions,
      channel, serverId, messageId, authorId, preview
    }).catch((err) => console.warn('push fan-out failed:', err.message));
  }

  Object.defineProperty(notifications, 'reached', { value: reached, enumerable: false });
  return notifications;
}

// --- settings ----------------------------------------------------------------

function parseMute({ muted, muted_until: mutedUntil, mute_minutes: minutes }) {
  if (muted === undefined && mutedUntil === undefined && minutes === undefined) return null;
  if (minutes !== undefined && minutes !== null) {
    const n = Number(minutes);
    if (!Number.isFinite(n) || n < 0 || n > 60 * 24 * 365) {
      throw new ApiError('mute_minutes must be between 0 and 525600', { code: 'INVALID_MUTE' });
    }
    // 0 = until I turn it back on.
    return { muted: 1, muted_until: n === 0 ? null : new Date(Date.now() + n * 60_000).toISOString() };
  }
  if (muted === false) return { muted: 0, muted_until: null };
  let until = null;
  if (mutedUntil !== undefined && mutedUntil !== null && mutedUntil !== '') {
    const at = new Date(mutedUntil);
    if (Number.isNaN(at.getTime())) throw new ApiError('muted_until must be a valid date', { code: 'INVALID_MUTE' });
    until = at.toISOString();
  }
  return { muted: muted === undefined ? 1 : (muted ? 1 : 0), muted_until: until };
}

const flag = (v) => (v === undefined ? undefined : (v ? 1 : 0));

async function assertMember(userId, serverId) {
  const row = await getQuery(
    `SELECT 1 AS ok FROM server_members WHERE server_id = ? AND user_id = ? AND left_at IS NULL`,
    [serverId, userId]
  );
  if (!row) throw ApiError.notFound('Server');
}

export async function getServerSettings(userId, serverId) {
  const [row, guild] = await Promise.all([
    getQuery(`SELECT * FROM server_settings WHERE user_id = ? AND server_id = ?`, [userId, serverId]),
    getQuery(`SELECT default_notifications FROM servers WHERE id = ?`, [serverId])
  ]);
  return shapeServer(row, serverId, guild?.default_notifications);
}

function shapeServer(row, serverId, guildDefault = 'all_messages') {
  return {
    server_id: serverId,
    // null = follow the server default
    level: row?.level_override ?? (row?.notification_level && row.notification_level !== 'all_messages' ? row.notification_level : null),
    effective_level: resolveServerLevel(row, guildDefault),
    server_default: guildDefault,
    muted: isMuteActive(row),
    muted_until: isMuteActive(row) ? row?.muted_until ?? null : null,
    suppress_everyone: Boolean(Number(row?.suppress_everyone ?? 0)),
    suppress_roles: Boolean(Number(row?.suppress_roles ?? 0)),
    // Mirrors of the raw columns the legacy client state reads.
    notification_level: row?.notification_level ?? 'all_messages'
  };
}

export async function updateServerSettings(userId, serverId, body = {}) {
  await assertMember(userId, serverId);
  const sets = {};
  if (body.level !== undefined) {
    if (body.level !== null && body.level !== 'inherit' && !LEVELS.includes(body.level)) {
      throw new ApiError(`level must be one of ${LEVELS.join(', ')} or null`, { code: 'INVALID_LEVEL' });
    }
    const explicit = body.level === 'inherit' ? null : body.level;
    sets.level_override = explicit;
    // Keep the legacy column meaningful for older clients.
    sets.notification_level = explicit ?? 'all_messages';
  }
  const mute = parseMute(body);
  if (mute) Object.assign(sets, mute);
  if (body.suppress_everyone !== undefined) sets.suppress_everyone = flag(body.suppress_everyone);
  if (body.suppress_roles !== undefined) sets.suppress_roles = flag(body.suppress_roles);
  const cols = Object.keys(sets);
  if (cols.length) {
    await runQuery(`INSERT INTO server_settings (user_id, server_id) VALUES (?, ?) ON CONFLICT DO NOTHING`, [userId, serverId]);
    await runQuery(
      `UPDATE server_settings SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE user_id = ? AND server_id = ?`,
      [...cols.map((c) => sets[c]), userId, serverId]
    );
  }
  return getServerSettings(userId, serverId);
}

async function assertCanSeeChannel(userId, channelId) {
  const { assertChannelAccess } = await import('./access.js');
  try {
    await assertChannelAccess({ channelId, userId });
  } catch (err) {
    // Never confirm that a channel the caller cannot see exists.
    if (err?.status === 403) throw ApiError.notFound('Channel');
    throw err;
  }
}

export async function getChannelSettings(userId, channelId) {
  const row = await getQuery(
    `SELECT * FROM channel_settings WHERE user_id = ? AND channel_id = ?`, [userId, channelId]
  );
  const effective = await effectiveFor(userId, channelId);
  return {
    channel_id: channelId,
    level: row?.notification_level ?? 'inherit',
    notification_level: row?.notification_level ?? 'inherit',
    muted: isMuteActive(row),
    muted_until: isMuteActive(row) ? row?.muted_until ?? null : null,
    collapsed: Boolean(Number(row?.collapsed ?? 0)),
    ...effective
  };
}

/** The level and mute a channel resolves to for this user, and where it came from. */
export async function effectiveFor(userId, channelId) {
  const channel = await loadChain(channelId);
  if (!channel) throw ApiError.notFound('Channel');
  const chain = [channel.id];
  if (channel.parent_id) chain.push(channel.parent_id);
  if (channel.type === 'thread' && channel.grandparent_id) chain.push(channel.grandparent_id);
  const rows = await allQuery(
    `SELECT channel_id, muted, muted_until, notification_level FROM channel_settings
      WHERE user_id = ? AND channel_id IN (${chain.map(() => '?').join(',')})`,
    [userId, ...chain]
  );
  const byId = new Map(rows.map((r) => [r.channel_id, r]));
  const chainRows = chain.map((id) => byId.get(id));
  let serverLevel = 'all_messages';
  let serverMuted = false;
  if (channel.server_id) {
    const s = await getServerSettings(userId, channel.server_id);
    serverLevel = s.effective_level;
    serverMuted = s.muted;
  }
  const source = chainRows.findIndex((r) => r?.notification_level && r.notification_level !== 'inherit');
  return {
    effective_level: resolveLevel(chainRows, serverLevel),
    inherited_from: source === -1 ? (channel.server_id ? 'server' : 'default') : (source === 0 ? 'channel' : chain[source]),
    effective_muted: chainRows.some((r) => isMuteActive(r)) || serverMuted
  };
}

export async function updateChannelSettings(userId, channelId, body = {}) {
  await assertCanSeeChannel(userId, channelId);
  const sets = {};
  if (body.level !== undefined) {
    const level = body.level === null ? 'inherit' : body.level;
    if (!CHANNEL_LEVELS.includes(level)) {
      throw new ApiError(`level must be one of ${CHANNEL_LEVELS.join(', ')}`, { code: 'INVALID_LEVEL' });
    }
    sets.notification_level = level;
  }
  const mute = parseMute(body);
  if (mute) Object.assign(sets, mute);
  const cols = Object.keys(sets);
  if (cols.length) {
    await runQuery(`INSERT INTO channel_settings (user_id, channel_id) VALUES (?, ?) ON CONFLICT DO NOTHING`, [userId, channelId]);
    await runQuery(
      `UPDATE channel_settings SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE user_id = ? AND channel_id = ?`,
      [...cols.map((c) => sets[c]), userId, channelId]
    );
  }
  return getChannelSettings(userId, channelId);
}

export async function getPrefs(userId) {
  const row = await getQuery(`SELECT keywords, push_content FROM notification_prefs WHERE user_id = ?`, [userId]);
  return { keywords: parseKeywords(row?.keywords ?? '[]'), push_content: row?.push_content ?? 'full' };
}

export async function updatePrefs(userId, body = {}) {
  const current = await getPrefs(userId);
  const keywords = body.keywords === undefined ? current.keywords : normaliseKeywords(body.keywords);
  const pushContent = body.push_content === undefined ? current.push_content : body.push_content;
  if (!PUSH_CONTENT.includes(pushContent)) {
    throw new ApiError(`push_content must be one of ${PUSH_CONTENT.join(', ')}`, { code: 'INVALID_PUSH_CONTENT' });
  }
  await runQuery(
    `INSERT INTO notification_prefs (user_id, keywords, push_content) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET keywords = excluded.keywords, push_content = excluded.push_content`,
    [userId, JSON.stringify(keywords), pushContent]
  );
  return getPrefs(userId);
}

/** Everything the settings UI needs in one call. */
export async function getAllSettings(userId) {
  const [servers, channels, prefs] = await Promise.all([
    allQuery(
      `SELECT sm.server_id, ss.muted, ss.muted_until, ss.notification_level, ss.level_override,
              ss.suppress_everyone, ss.suppress_roles, s.default_notifications
         FROM server_members sm
         JOIN servers s ON s.id = sm.server_id
         LEFT JOIN server_settings ss ON ss.server_id = sm.server_id AND ss.user_id = sm.user_id
        WHERE sm.user_id = ? AND sm.left_at IS NULL`,
      [userId]
    ),
    allQuery(`SELECT channel_id, muted, muted_until, notification_level FROM channel_settings WHERE user_id = ?`, [userId]),
    getPrefs(userId)
  ]);
  return {
    servers: servers.map((row) => shapeServer(row, row.server_id, row.default_notifications)),
    channels: channels.map((row) => ({
      channel_id: row.channel_id,
      level: row.notification_level ?? 'inherit',
      muted: isMuteActive(row),
      muted_until: isMuteActive(row) ? row.muted_until ?? null : null
    })),
    prefs
  };
}

/**
 * Clear timed mutes that have run out, so every reader — including clients that
 * only look at the `muted` flag — sees them as over. The fan-out never relies
 * on this: it checks muted_until itself.
 */
export async function sweepExpiredMutes(now = new Date()) {
  const cutoff = now.toISOString();
  let cleared = 0;
  for (const table of ['channel_settings', 'server_settings']) {
    const result = await runQuery(
      `UPDATE ${table} SET muted = 0, muted_until = NULL
        WHERE muted = 1 AND muted_until IS NOT NULL AND muted_until <= ?`,
      [cutoff]
    );
    cleared += result.changes ?? 0;
  }
  return cleared;
}
