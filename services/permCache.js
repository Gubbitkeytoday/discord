// ============================================================================
//  Guild permission cache.
//
//  Resolving a member's permissions in a channel took five queries (channel,
//  server, member, member roles, overwrites) on every send, join, history page
//  and search — the top five statements in every load-test scenario
//  (docs/PERFORMANCE.md #2). The inputs change rarely, so they are cached per
//  guild in memory:
//
//    guild  → owner, @everyone and role permissions, live channels
//             (type/parent), channel overwrites
//    member → role ids, timeout_until, pending          (loaded lazily)
//    channel id → guild id                                (never changes)
//
//  Invalidation is exact and cluster-wide, without any hook in the mutation
//  code: database triggers (schema v34) bump `guild_perm_versions.version`
//  for the guild whenever roles, member roles, membership/timeout/pending,
//  overwrites, the channel set/hierarchy, the owner or deletion change. Every
//  check reads that one row (an indexed point lookup) and reloads the guild if
//  the version moved — so a revoke committed by any instance, any code path
//  or a manual SQL edit is honoured by the very next check. Cost per check:
//  1 query instead of 5, 0 extra round trips on a hit.
//
//  Timeouts are evaluated at check time from the cached timeout_until, so a
//  timeout expiring needs no invalidation.
// ============================================================================

import { getQuery, allQuery } from '../db.js';

const MAX_GUILDS = Math.max(16, Number(process.env.PERM_CACHE_GUILDS) || 2000);
const MAX_MEMBERS_PER_GUILD = 20_000;

const guilds = new Map();         // serverId -> state
const channelGuild = new Map();   // channelId -> serverId (guild channels only)

const stats = { hits: 0, reloads: 0, memberLoads: 0 };
export const permCacheStats = () => ({ ...stats, guilds: guilds.size, channels: channelGuild.size });

async function currentVersion(serverId) {
  const row = await getQuery(`SELECT version FROM guild_perm_versions WHERE server_id = ?`, [serverId]);
  return Number(row?.version ?? 0);
}

async function loadGuild(serverId, version) {
  const server = await getQuery(
    `SELECT id, owner_id FROM servers WHERE id = ? AND deleted_at IS NULL`, [serverId]
  );
  if (!server) return { version, missing: true };
  const [roles, channels, overwrites] = await Promise.all([
    allQuery(`SELECT id, permissions FROM roles WHERE server_id = ?`, [serverId]),
    allQuery(
      `SELECT id, type, server_id, parent_id FROM channels WHERE server_id = ? AND deleted_at IS NULL`, [serverId]),
    allQuery(
      `SELECT o.channel_id, o.target_type, o.target_id, o.allow, o.deny
         FROM channel_overwrites o JOIN channels c ON c.id = o.channel_id
        WHERE c.server_id = ?`, [serverId])
  ]);
  const overwritesByChannel = new Map();
  for (const o of overwrites) {
    if (!overwritesByChannel.has(o.channel_id)) overwritesByChannel.set(o.channel_id, []);
    overwritesByChannel.get(o.channel_id).push(o);
  }
  const state = {
    version,
    missing: false,
    serverId,
    ownerId: server.owner_id,
    roles: new Map(roles.map((r) => [r.id, r.permissions])),
    channels: new Map(channels.map((c) => [c.id, c])),
    overwrites: overwritesByChannel,
    members: new Map(),       // userId -> { roleIds, timeout_until, pending } (positive entries only)
    allMembersLoaded: false
  };
  for (const c of channels) channelGuild.set(c.id, serverId);
  return state;
}

/**
 * The guild's cached permission inputs, current as of this call. Null when
 * the guild does not exist (or is deleted).
 */
export async function guildState(serverId) {
  if (!serverId) return null;
  const version = await currentVersion(serverId);
  let state = guilds.get(serverId);
  if (!state || state.version !== version) {
    stats.reloads += 1;
    state = await loadGuild(serverId, version);
    if (guilds.size >= MAX_GUILDS) guilds.delete(guilds.keys().next().value);
    guilds.set(serverId, state);
  } else {
    stats.hits += 1;
    // Refresh recency for the simple LRU above.
    guilds.delete(serverId);
    guilds.set(serverId, state);
  }
  return state.missing ? null : state;
}

/** A member's cached inputs in this guild state, or null if not a member. */
export async function memberState(state, userId) {
  if (!state || !userId) return null;
  const cached = state.members.get(userId);
  if (cached) return cached;
  if (state.allMembersLoaded) return null;
  stats.memberLoads += 1;
  const member = await getQuery(
    `SELECT user_id, timeout_until, pending FROM server_members
      WHERE server_id = ? AND user_id = ? AND left_at IS NULL`, [state.serverId, userId]
  );
  // Non-members are not cached: a join bumps the version anyway, but a
  // negative entry buys nothing and is the one a bug would make dangerous.
  if (!member) return null;
  const roles = await allQuery(
    `SELECT role_id FROM member_roles WHERE server_id = ? AND user_id = ?`, [state.serverId, userId]
  );
  const entry = { roleIds: roles.map((r) => r.role_id), timeout_until: member.timeout_until, pending: member.pending };
  if (state.members.size < MAX_MEMBERS_PER_GUILD) state.members.set(userId, entry);
  return entry;
}

/** Load every member of the guild into the state (fan-out needs them all). */
export async function allMembers(state) {
  if (!state) return [];
  if (!state.allMembersLoaded) {
    const [members, roles] = await Promise.all([
      allQuery(
        `SELECT user_id, timeout_until, pending FROM server_members WHERE server_id = ? AND left_at IS NULL`,
        [state.serverId]),
      allQuery(`SELECT user_id, role_id FROM member_roles WHERE server_id = ?`, [state.serverId])
    ]);
    const byUser = new Map();
    for (const r of roles) {
      if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
      byUser.get(r.user_id).push(r.role_id);
    }
    state.members = new Map(members.map((m) => [m.user_id, {
      roleIds: byUser.get(m.user_id) ?? [], timeout_until: m.timeout_until, pending: m.pending
    }]));
    state.allMembersLoaded = true;
  }
  return [...state.members.keys()];
}

/** Guild of a guild channel if known without a query; undefined otherwise. */
export const knownChannelGuild = (channelId) => channelGuild.get(channelId);
export function rememberChannelGuild(channelId, serverId) {
  if (!serverId) return;
  if (channelGuild.size > 200_000) channelGuild.clear();
  channelGuild.set(channelId, serverId);
}

/** Test seam. */
export function clearPermCache() {
  guilds.clear();
  channelGuild.clear();
}
