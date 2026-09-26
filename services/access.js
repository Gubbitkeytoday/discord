// ============================================================================
//  Channel access — the single place that answers "may this user do X here?"
//
//  Discord's rule set, condensed:
//    guild channel  → must be a member, must hold VIEW_CHANNEL after overwrites,
//                     plus whatever action permission the caller names.
//    DM / group DM  → must be a recipient; a 1:1 DM is also closed when either
//                     side has blocked the other.
//    thread         → inherits the parent channel's permissions.
// ============================================================================

import { getQuery, allQuery } from '../db.js';
import { ApiError } from '../lib/httpUtils.js';
import {
  has, computeBasePermissions, computeChannelPermissions, applyTimeout, isActiveTimeout
} from '../lib/permissions.js';
import {
  guildState, memberState, allMembers, knownChannelGuild, rememberChannelGuild
} from './permCache.js';

/**
 * Permissions of `member` (a permCache member entry) in `state`'s guild,
 * optionally inside channel `channelId` — the same computation, in the same
 * order, as guilds.resolvePermissions: base from roles (+@everyone, owner →
 * all) → overwrites → timeout/pending.
 */
function permissionsFromState(state, member, userId, channelId = null) {
  const isOwner = state.ownerId === userId;
  // Member roles that still exist, plus @everyone, which nobody can opt out of.
  const roleIds = member.roleIds.filter((id) => state.roles.has(id));
  if (!roleIds.includes(state.serverId) && state.roles.has(state.serverId)) roleIds.push(state.serverId);
  const pending = Boolean(Number(member.pending)) && !isOwner;
  const timedOut = isActiveTimeout(member.timeout_until) || pending;
  const base = computeBasePermissions({ isOwner, rolePermissions: roleIds.map((id) => state.roles.get(id)) });
  let permissions = base;
  if (channelId) {
    permissions = computeChannelPermissions({
      base,
      overwrites: state.overwrites.get(channelId) ?? [],
      everyoneRoleId: state.serverId,
      memberRoleIds: roleIds,
      userId
    });
  }
  return {
    permissions: timedOut ? applyTimeout(permissions) : permissions,
    isMember: true, isOwner, timedOut, pending, roleIds,
    member: { timeout_until: member.timeout_until, pending: member.pending }
  };
}

/**
 * Cached equivalent of guilds.resolvePermissions({ userId, serverId,
 * channelId }) for callers on hot paths (socket joins, access checks).
 * A missing guild resolves to "not a member" rather than throwing.
 */
export async function resolveMemberPermissions({ userId, serverId, channelId = null }) {
  const state = await guildState(serverId);
  if (!state) return { permissions: '0', isMember: false, isOwner: false };
  const member = await memberState(state, userId);
  if (!member) return { permissions: '0', isMember: false, isOwner: false };
  return permissionsFromState(state, member, userId, channelId);
}

/**
 * Resolve the channel and the caller's effective permissions inside it.
 * Returns `{ channel, permissions, isDm }`; throws 403/404 when access is denied.
 *
 * `permission` (optional) is an extra flag that must also be present, e.g.
 * SEND_MESSAGES, MANAGE_MESSAGES, ADD_REACTIONS.
 */
export async function assertChannelAccess({ channelId, userId, permission = null }) {
  if (!userId) throw ApiError.unauthorized();

  // A guild channel never moves to another guild, so once its guild is known
  // the per-guild cache (version-checked, see services/permCache.js) answers
  // everything else: one point query on a warm cache instead of five.
  let serverId = knownChannelGuild(channelId);
  let channel = null;
  if (!serverId) {
    channel = await getQuery(
      `SELECT id, type, server_id, parent_id FROM channels WHERE id = ? AND deleted_at IS NULL`,
      [channelId]
    );
    if (!channel) throw ApiError.notFound('Channel');
    serverId = channel.server_id;
    rememberChannelGuild(channelId, serverId);
  }

  // --- direct messages -------------------------------------------------------
  if (!serverId) {
    const recipient = await getQuery(
      `SELECT 1 FROM channel_recipients WHERE channel_id = ? AND user_id = ?`, [channelId, userId]
    );
    if (!recipient) throw ApiError.forbidden('You are not in this conversation');

    // A block closes the conversation in both directions — not only for
    // sending, but for reacting and pinning too. Reading old history stays
    // allowed, as it does on Discord.
    const WRITE_ACTIONS = ['SEND_MESSAGES', 'ADD_REACTIONS', 'MANAGE_MESSAGES', 'ATTACH_FILES'];
    if (channel.type === 'dm' && WRITE_ACTIONS.includes(permission)) {
      const blocked = await getQuery(
        `SELECT 1 FROM blocks b
           JOIN channel_recipients cr ON cr.channel_id = ?
          WHERE (b.user_id = cr.user_id AND b.blocked_id = ?)
             OR (b.user_id = ? AND b.blocked_id = cr.user_id)
          LIMIT 1`,
        [channelId, userId, userId]
      );
      if (blocked) throw ApiError.forbidden('You cannot message this user');
    }
    // Everyone in a DM holds the full conversational permission set.
    return { channel, permissions: null, isDm: true };
  }

  // --- guild channels ----------------------------------------------------------
  const state = await guildState(serverId);
  if (!state) throw ApiError.notFound('Server');
  const cached = state.channels.get(channelId);
  if (!cached) throw ApiError.notFound('Channel');          // deleted
  channel = { id: cached.id, type: cached.type, server_id: cached.server_id, parent_id: cached.parent_id };

  // Threads take their permission set from the parent channel.
  const permissionChannelId = channel.type === 'thread' && channel.parent_id
    ? channel.parent_id
    : channel.id;

  const member = await memberState(state, userId);
  if (!member) throw ApiError.forbidden('You are not a member of this server');
  const resolved = permissionsFromState(state, member, userId, permissionChannelId);
  if (!has(resolved.permissions, 'VIEW_CHANNEL')) {
    throw ApiError.forbidden('Missing permission: VIEW_CHANNEL');
  }
  if (permission && !has(resolved.permissions, permission)) {
    // A timeout is the most common reason a member suddenly cannot act, and
    // "missing SEND_MESSAGES" would be a confusing way to say so.
    if (resolved.timedOut) {
      throw new ApiError('You are timed out and cannot send messages yet', {
        status: 403, code: 'TIMED_OUT',
        details: { until: resolved.member?.timeout_until ?? null }
      });
    }
    throw ApiError.forbidden(`Missing permission: ${permission}`);
  }
  return { channel, permissions: resolved.permissions, isDm: false, isOwner: resolved.isOwner };
}

/** Non-throwing variant: does the user hold `permission` in this channel? */
export async function canInChannel({ channelId, userId, permission }) {
  try {
    const { permissions, isDm } = await assertChannelAccess({ channelId, userId, permission });
    return isDm ? true : has(permissions, permission);
  } catch {
    return false;
  }
}

// ============================================================================
//  Bulk permission evaluation.
//
//  assertChannelAccess answers one (user, channel) question with ~5 queries.
//  Fan-out ("who in this guild may see channel X?") and search ("which
//  channels may this user read?") ask hundreds of those questions at once, so
//  they load the same inputs — members, role assignments, @everyone, channels,
//  overwrites — in a handful of set-based queries and evaluate in memory with
//  the *same* functions from lib/permissions.js, in the same order:
//  base(roles, owner) → overwrites (thread → parent) → timeout.
//
//  Nothing here is cached across calls on purpose: a permission cache needs
//  invalidation on every role/overwrite/member write, cluster-wide, and a
//  stale "allowed" is a data leak. Each context lives for one operation.
// ============================================================================

/**
 * Build an evaluator from raw rows. `members` are server_members rows (with
 * server_id), `roles` are { server_id, user_id, id, permissions } assignments,
 * `everyone` is { server_id, id, permissions } per guild, `owners` maps
 * server_id → owner_id, `channels` rows { id, type, server_id, parent_id },
 * `overwrites` rows { channel_id, target_type, target_id, allow, deny }.
 */
function buildEvaluator({ members, roles, everyone, owners, channels, overwrites }) {
  const memberByKey = new Map(members.map((m) => [`${m.server_id}:${m.user_id}`, m]));
  const rolesByKey = new Map();
  for (const r of roles) {
    const k = `${r.server_id}:${r.user_id}`;
    if (!rolesByKey.has(k)) rolesByKey.set(k, []);
    rolesByKey.get(k).push(r);
  }
  const everyoneByServer = new Map(everyone.map((r) => [r.server_id, r]));
  const channelById = new Map(channels.map((c) => [c.id, c]));
  const overwritesByChannel = new Map();
  for (const o of overwrites) {
    if (!overwritesByChannel.has(o.channel_id)) overwritesByChannel.set(o.channel_id, []);
    overwritesByChannel.get(o.channel_id).push(o);
  }
  // Base permissions and role ids depend only on (server, user).
  const baseCache = new Map();
  const baseFor = (serverId, userId) => {
    const k = `${serverId}:${userId}`;
    if (baseCache.has(k)) return baseCache.get(k);
    const member = memberByKey.get(k);
    let value = null;
    if (member) {
      const held = [...(rolesByKey.get(k) ?? [])];
      const ev = everyoneByServer.get(serverId);
      if (ev && !held.some((r) => r.id === serverId)) held.push(ev);
      const isOwner = owners.get(serverId) === userId;
      const pending = Boolean(Number(member.pending)) && !isOwner;
      value = {
        base: computeBasePermissions({ isOwner, rolePermissions: held.map((r) => r.permissions) }),
        roleIds: held.map((r) => r.id),
        timedOut: isActiveTimeout(member.timeout_until) || pending
      };
    }
    baseCache.set(k, value);
    return value;
  };

  /** Effective permission bitfield of `userId` in guild channel `channelId`, or null. */
  const permissionsIn = (userId, channelId) => {
    const channel = channelById.get(channelId);
    if (!channel?.server_id) return null;
    const b = baseFor(channel.server_id, userId);
    if (!b) return null;
    const permChannelId = channel.type === 'thread' && channel.parent_id ? channel.parent_id : channel.id;
    const resolved = computeChannelPermissions({
      base: b.base,
      overwrites: overwritesByChannel.get(permChannelId) ?? [],
      everyoneRoleId: channel.server_id,
      memberRoleIds: b.roleIds,
      userId
    });
    return b.timedOut ? applyTimeout(resolved) : resolved;
  };

  /** Mirrors canInChannel for guild channels (VIEW_CHANNEL is always required). */
  const can = (userId, channelId, permission = 'VIEW_CHANNEL') => {
    const bits = permissionsIn(userId, channelId);
    if (bits === null) return false;
    return has(bits, 'VIEW_CHANNEL') && (!permission || has(bits, permission));
  };

  return { can, permissionsIn, members, channels, channelById };
}

/**
 * Evaluator for every member of one guild, used by the gateway to decide who
 * may receive a channel's events. Served from the permission cache.
 */
export async function loadGuildPermissionContext(serverId) {
  const state = await guildState(serverId);
  if (!state) return null;
  const ids = await allMembers(state);
  const can = (userId, channelId, permission = 'VIEW_CHANNEL') => {
    const member = state.members.get(userId);
    const channel = state.channels.get(channelId);
    if (!member || !channel) return false;
    const permChannel = channel.type === 'thread' && channel.parent_id ? channel.parent_id : channel.id;
    const { permissions } = permissionsFromState(state, member, userId, permChannel);
    return has(permissions, 'VIEW_CHANNEL') && (!permission || has(permissions, permission));
  };
  return { members: ids.map((id) => ({ user_id: id })), can, channels: [...state.channels.values()] };
}

/**
 * Who in the channel's guild may VIEW it: `{ allowed: Set, denied: Set }` of
 * user ids over current members. Null for a DM or unknown channel.
 */
export async function channelAudience(channelId, permission = 'VIEW_CHANNEL') {
  const channel = await getQuery(
    `SELECT id, server_id FROM channels WHERE id = ? AND deleted_at IS NULL`, [channelId]
  );
  if (!channel?.server_id) return null;
  const ctx = await loadGuildPermissionContext(channel.server_id);
  if (!ctx) return null;
  const allowed = new Set();
  const denied = new Set();
  for (const m of ctx.members) {
    (ctx.can(m.user_id, channelId, permission) ? allowed : denied).add(m.user_id);
  }
  return { allowed, denied };
}

/**
 * Every channel id `userId` may use with `permission` (default: read
 * history), across all their guilds and DMs, in five queries. Optionally
 * narrowed to one guild (`serverId`) — DMs are then excluded.
 *
 * This is the set search filters by *inside SQL*, so a result page is always
 * full and never contains a channel the viewer cannot read.
 */
export async function readableChannelIds(userId, { serverId = null, permission = 'READ_MESSAGE_HISTORY' } = {}) {
  if (!userId) return [];
  const { guildChannels, dmChannelIds, can } = await userChannelContext(userId, { serverId });
  const ids = guildChannels.filter((c) => can(c.id, permission)).map((c) => c.id);
  return [...ids, ...dmChannelIds];
}

/**
 * Everything needed to answer "what can this user do where" across all their
 * guilds in one go: guild channels (non-category) with a `can(channelId,
 * permission)` / `permissionsIn(channelId)` evaluator, their memberships and
 * the DM/group-DM channels they belong to.
 */
export async function userChannelContext(userId, { serverId = null } = {}) {
  const scope = serverId ? ' AND sm.server_id = ?' : '';
  const scopeParams = serverId ? [serverId] : [];
  const [memberships, roles, everyone, channels, overwrites, dms] = await Promise.all([
    allQuery(
      `SELECT sm.server_id, sm.user_id, sm.timeout_until, sm.pending, s.owner_id
         FROM server_members sm JOIN servers s ON s.id = sm.server_id AND s.deleted_at IS NULL
        WHERE sm.user_id = ? AND sm.left_at IS NULL${scope}`, [userId, ...scopeParams]),
    allQuery(
      `SELECT mr.server_id, mr.user_id, r.id, r.permissions
         FROM member_roles mr JOIN roles r ON r.id = mr.role_id
        WHERE mr.user_id = ?`, [userId]),
    allQuery(
      `SELECT r.server_id, r.id, r.permissions
         FROM roles r JOIN server_members sm ON sm.server_id = r.server_id
        WHERE r.id = r.server_id AND sm.user_id = ? AND sm.left_at IS NULL${scope}`, [userId, ...scopeParams]),
    allQuery(
      `SELECT c.id, c.type, c.server_id, c.parent_id, c.name, c.topic, c.position,
              c.nsfw, c.rate_limit_per_user, c.archived, c.locked
         FROM channels c JOIN server_members sm ON sm.server_id = c.server_id
        WHERE sm.user_id = ? AND sm.left_at IS NULL AND c.deleted_at IS NULL
          AND c.type <> 'category'${scope}`, [userId, ...scopeParams]),
    allQuery(
      `SELECT o.channel_id, o.target_type, o.target_id, o.allow, o.deny
         FROM channel_overwrites o
         JOIN channels c ON c.id = o.channel_id
         JOIN server_members sm ON sm.server_id = c.server_id
        WHERE sm.user_id = ? AND sm.left_at IS NULL
          AND (o.target_type = 'role' OR o.target_id = ?)${scope}`, [userId, userId, ...scopeParams]),
    serverId ? Promise.resolve([]) : allQuery(
      `SELECT cr.channel_id FROM channel_recipients cr
         JOIN channels c ON c.id = cr.channel_id
        WHERE cr.user_id = ? AND c.deleted_at IS NULL AND c.type IN ('dm', 'group_dm')`, [userId])
  ]);
  const ev = buildEvaluator({
    members: memberships,
    roles,
    everyone,
    owners: new Map(memberships.map((m) => [m.server_id, m.owner_id])),
    channels,
    overwrites
  });
  return {
    memberships,
    guildChannels: channels,
    dmChannelIds: dms.map((d) => d.channel_id),
    can: (channelId, permission = 'VIEW_CHANNEL') => ev.can(userId, channelId, permission),
    permissionsIn: (channelId) => ev.permissionsIn(userId, channelId)
  };
}
