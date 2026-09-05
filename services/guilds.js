// ============================================================================
//  Guild service — servers, roles, members, channels, permission resolution.
//
//  The wire format keeps the two flat fields the current UI depends on:
//    channel.category  → the parent category's name
//    member.role       → 'owner' | 'admin' | 'bot' | 'member'
//  Both are *derived* from the normalised tables, so the UI keeps working while
//  the data model underneath is the real one.
// ============================================================================

import { runQuery, getQuery, allQuery, transaction } from '../db.js';
import { generateId } from '../lib/snowflake.js';
import { ApiError } from '../lib/httpUtils.js';
import {
  DEFAULT_PERMISSIONS, PERMISSIONS, has, toBigInt,
  computeBasePermissions, computeChannelPermissions, applyTimeout, isActiveTimeout
} from '../lib/permissions.js';

const DEFAULT_CATEGORY_NAMES = { text: 'TEXT CHANNELS', voice: 'VOICE CHANNELS' };

// --- permissions -------------------------------------------------------------

/**
 * Effective permissions for a member, optionally within one channel.
 * Everything that gates an action should route through here.
 */
export async function resolvePermissions({ userId, serverId, channelId = null }) {
  if (!serverId) return { permissions: '0', isMember: false, isOwner: false };

  const server = await getQuery(
    `SELECT id, owner_id FROM servers WHERE id = ? AND deleted_at IS NULL`, [serverId]
  );
  if (!server) throw ApiError.notFound('Server');

  const member = await getQuery(
    `SELECT * FROM server_members WHERE server_id = ? AND user_id = ? AND left_at IS NULL`,
    [serverId, userId]
  );
  if (!member) return { permissions: '0', isMember: false, isOwner: false };

  const roles = await allQuery(
    `SELECT r.id, r.permissions, r.position
       FROM member_roles mr JOIN roles r ON r.id = mr.role_id
      WHERE mr.server_id = ? AND mr.user_id = ?`,
    [serverId, userId]
  );

  // @everyone applies to every member unconditionally. Its row is normally in
  // member_roles, but a member added by an older code path may be missing it,
  // and Discord's model does not let anyone opt out of @everyone.
  if (!roles.some((r) => r.id === serverId)) {
    const everyone = await getQuery(
      `SELECT id, permissions, position FROM roles WHERE id = ? AND server_id = ?`,
      [serverId, serverId]
    );
    if (everyone) roles.push(everyone);
  }

  const isOwner = server.owner_id === userId;
  // A member who has not yet passed membership screening (rules / onboarding)
  // is "pending": Discord lets them look but not talk, exactly like a timeout.
  const pending = Boolean(member.pending) && !isOwner;
  const timedOut = isActiveTimeout(member.timeout_until) || pending;
  const base = computeBasePermissions({
    isOwner, rolePermissions: roles.map((r) => r.permissions)
  });

  if (!channelId) {
    return {
      permissions: timedOut ? applyTimeout(base) : base,
      isMember: true, isOwner, timedOut, pending, roleIds: roles.map((r) => r.id), member
    };
  }

  const overwrites = await allQuery(
    `SELECT target_type, target_id, allow, deny FROM channel_overwrites WHERE channel_id = ?`,
    [channelId]
  );
  const resolved = computeChannelPermissions({
    base,
    overwrites,
    everyoneRoleId: serverId, // @everyone role id === server id, by convention
    memberRoleIds: roles.map((r) => r.id),
    userId
  });
  // A timeout is applied last, after overwrites: no channel grant can restore
  // what the timeout took away.
  const permissions = timedOut ? applyTimeout(resolved) : resolved;

  return { permissions, isMember: true, isOwner, timedOut, pending, roleIds: roles.map((r) => r.id), member };
}

/** Throw unless the member holds `permission` in this scope. */
export async function assertPermission({ userId, serverId, channelId = null, permission }) {
  const resolved = await resolvePermissions({ userId, serverId, channelId });
  if (!resolved.isMember) throw ApiError.forbidden('You are not a member of this server');
  if (!has(resolved.permissions, permission)) {
    throw ApiError.forbidden(`Missing permission: ${permission}`);
  }
  return resolved;
}

/**
 * Collapse a member's roles into the single label the member list renders.
 * Owner wins, then ADMINISTRATOR, then a managed bot role, then plain member.
 */
function deriveRoleLabel({ isOwner, isBot, rolePermissions, managed }) {
  if (isOwner) return 'owner';
  if (rolePermissions.some((p) => has(p, 'ADMINISTRATOR'))) return 'admin';
  if (isBot || managed) return 'bot';
  return 'member';
}

// --- reads -------------------------------------------------------------------

/** Everything the client needs on boot. */
export async function getInitialData(userId) {
  const currentUser = await getQuery(
    // Same column set as /api/auth/me: the client replaces its user object with
    // this one, so dropping email or mfa_enabled here would blank the account tab.
    `SELECT id, username, discriminator, display_name, avatar_url, banner_url, bio,
            pronouns, status, custom_status, accent_color, theme, locale, email,
            email_verified, mfa_enabled, storage_used, storage_quota, is_bot, created_at
       FROM users WHERE id = ? AND deleted_at IS NULL`,
    [userId]
  );
  if (!currentUser) throw ApiError.notFound('User');

  const servers = await allQuery(
    `SELECT s.*, ss.position AS user_position, ss.muted, ss.hidden
       FROM servers s
       JOIN server_members sm ON sm.server_id = s.id AND sm.left_at IS NULL
       LEFT JOIN server_settings ss ON ss.server_id = s.id AND ss.user_id = sm.user_id
      WHERE sm.user_id = ? AND s.deleted_at IS NULL
      ORDER BY COALESCE(ss.position, 999), s.created_at ASC`,
    [userId]
  );

  // Friends, from either direction of the relation.
  const friends = await allQuery(
    `SELECT u.id, u.username, u.discriminator, u.display_name, u.avatar_url,
            u.status, u.custom_status, u.bio,
            f.status AS friend_status, f.requested_by, f.id AS request_id, f.nickname AS friend_nickname,
            CASE WHEN f.requested_by = ? THEN 'outgoing' ELSE 'incoming' END AS direction
       FROM friends f
       JOIN users u ON u.id = CASE WHEN f.user_id = ? THEN f.friend_id ELSE f.user_id END
      WHERE (f.user_id = ? OR f.friend_id = ?)
        AND u.deleted_at IS NULL
        AND f.status != 'declined'`,
    [userId, userId, userId, userId]
  );

  const dms = await listDirectMessageChannels(userId);
  const unread = await allQuery(
    `SELECT channel_id, mention_count, last_read_message_id FROM read_states WHERE user_id = ?`,
    [userId]
  );

  return { currentUser, servers, friends, dms, unread };
}

/** Server detail: channels (categories flattened into a label) and members. */
export async function getServerDetail(serverId, viewerId = null) {
  const server = await getQuery(
    `SELECT * FROM servers WHERE id = ? AND deleted_at IS NULL`, [serverId]
  );
  if (!server) throw ApiError.notFound('Server');

  // Only members may read a guild — and each member only sees the channels
  // they hold VIEW_CHANNEL in, exactly as Discord hides private channels.
  let viewer = null;
  if (viewerId) {
    viewer = await resolvePermissions({ userId: viewerId, serverId });
    if (!viewer.isMember) throw ApiError.forbidden('You are not a member of this server');
  }

  let allChannels = await allQuery(
    `SELECT * FROM channels
      WHERE server_id = ? AND deleted_at IS NULL
      ORDER BY position ASC, created_at ASC`,
    [serverId]
  );

  if (viewer && !viewer.isOwner && !has(viewer.permissions, 'ADMINISTRATOR')) {
    const overwriteRows = await allQuery(
      `SELECT channel_id, target_type, target_id, allow, deny FROM channel_overwrites
        WHERE channel_id IN (SELECT id FROM channels WHERE server_id = ?)`,
      [serverId]
    );
    const overwritesByChannel = new Map();
    for (const o of overwriteRows) {
      if (!overwritesByChannel.has(o.channel_id)) overwritesByChannel.set(o.channel_id, []);
      overwritesByChannel.get(o.channel_id).push(o);
    }
    const visible = new Set();
    for (const c of allChannels) {
      // Threads inherit their parent's visibility; categories are always listed.
      const permChannelId = c.type === 'thread' && c.parent_id ? c.parent_id : c.id;
      const effective = computeChannelPermissions({
        base: viewer.permissions,
        overwrites: overwritesByChannel.get(permChannelId) ?? [],
        everyoneRoleId: serverId,
        memberRoleIds: viewer.roleIds ?? [],
        userId: viewerId
      });
      if (c.type === 'category' || has(effective, 'VIEW_CHANNEL')) visible.add(c.id);
    }
    allChannels = allChannels.filter((c) => visible.has(c.id));
  }

  const categoryNames = new Map(
    allChannels.filter((c) => c.type === 'category').map((c) => [c.id, c.name])
  );

  // A channel is "private" when @everyone is denied VIEW_CHANNEL on it — the
  // same rule Discord uses to draw the padlock.
  const everyoneDenials = await allQuery(
    `SELECT channel_id, deny FROM channel_overwrites
      WHERE target_type = 'role' AND target_id = ?
        AND channel_id IN (SELECT id FROM channels WHERE server_id = ?)`,
    [serverId, serverId]
  );
  const privateChannelIds = new Set(
    everyoneDenials
      // A raw bit test, not has(): has() treats the ADMINISTRATOR bit as "all
      // permissions", which is meaningless on a deny mask.
      .filter((row) => (toBigInt(row.deny) & PERMISSIONS.VIEW_CHANNEL) === PERMISSIONS.VIEW_CHANNEL)
      .map((row) => row.channel_id)
  );

  const channels = allChannels
    .filter((c) => c.type !== 'category' && c.type !== 'thread')
    .map((c) => ({
      ...c,
      is_private: privateChannelIds.has(c.id),
      // Derived compatibility field for the sidebar's grouping.
      category: categoryNames.get(c.parent_id)
        ?? DEFAULT_CATEGORY_NAMES[c.type]
        ?? 'TEXT CHANNELS'
    }));

  const categories = allChannels
    .filter((c) => c.type === 'category')
    .map((c) => ({ id: c.id, name: c.name, position: c.position }));

  const memberRows = await allQuery(
    `SELECT u.id, u.username, u.discriminator, u.display_name, u.avatar_url,
            u.status, u.custom_status, u.bio, u.is_bot,
            sm.nickname, sm.avatar_url AS member_avatar_url, sm.joined_at, sm.timeout_until
       FROM server_members sm
       JOIN users u ON u.id = sm.user_id
      WHERE sm.server_id = ? AND sm.left_at IS NULL AND u.deleted_at IS NULL`,
    [serverId]
  );

  const roleRows = await allQuery(
    `SELECT mr.user_id, r.id, r.name, r.color, r.position, r.permissions, r.hoist, r.managed, r.icon_url
       FROM member_roles mr JOIN roles r ON r.id = mr.role_id
      WHERE mr.server_id = ?
      ORDER BY r.position DESC`,
    [serverId]
  );
  const rolesByUser = new Map();
  for (const r of roleRows) {
    if (!rolesByUser.has(r.user_id)) rolesByUser.set(r.user_id, []);
    rolesByUser.get(r.user_id).push(r);
  }

  const members = memberRows.map((m) => {
    const roles = rolesByUser.get(m.id) ?? [];
    const topColoured = roles.find((r) => r.color && !r.name.startsWith('@'));
    // Discord shows the icon of the highest role that has one, beside the name.
    const topIcon = roles.find((r) => r.icon_url);
    return {
      ...m,
      display_name: m.nickname || m.display_name,
      avatar_url: m.member_avatar_url || m.avatar_url,
      roles: roles.map(({ id, name, color, position, hoist, icon_url }) => ({
        id, name, color, position, hoist: Boolean(hoist), icon_url: icon_url ?? null
      })),
      role_color: topColoured?.color ?? null,
      role_icon: topIcon ? { url: topIcon.icon_url, name: topIcon.name } : null,
      // Derived compatibility field for MemberList's badge logic.
      role: deriveRoleLabel({
        isOwner: server.owner_id === m.id,
        isBot: Boolean(m.is_bot),
        managed: roles.some((r) => r.managed),
        rolePermissions: roles.map((r) => r.permissions)
      })
    };
  });

  const roles = await allQuery(
    `SELECT * FROM roles WHERE server_id = ? ORDER BY position DESC`, [serverId]
  );
  const emojis = await allQuery(
    `SELECT * FROM emojis WHERE server_id = ? AND available = 1`, [serverId]
  );

  const viewerPermissions = viewer ? viewer.permissions : null;
  // Tell the client whether *this* viewer still has to pass screening, and
  // whether the server has anything to show a newcomer at all.
  const onboardingRequired = Boolean(viewer?.pending);
  const hasOnboarding = Boolean(server.screening_enabled) || Boolean(server.welcome_enabled)
    || Boolean(await getQuery(`SELECT 1 FROM onboarding_prompts WHERE server_id = ? LIMIT 1`, [serverId]));

  return {
    server, channels, categories, members, roles, emojis, viewerPermissions,
    viewer_pending: onboardingRequired, has_onboarding: hasOnboarding
  };
}

// --- writes ------------------------------------------------------------------

export async function createServer({ name, iconUrl = null, iconFileId = null, ownerId }) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) throw new ApiError('Server name is required', { code: 'INVALID_NAME' });

  const serverId = generateId();
  const icon = iconUrl || `https://api.dicebear.com/7.x/identicon/svg?seed=${encodeURIComponent(trimmed)}`;

  await transaction(async () => {
    await runQuery(
      `INSERT INTO servers (id, name, icon_url, icon_file_id, owner_id, member_count)
       VALUES (?, ?, ?, ?, ?, 1)`,
      [serverId, trimmed, icon, iconFileId, ownerId]
    );

    // @everyone always exists and its id equals the server id.
    await runQuery(
      `INSERT INTO roles (id, server_id, name, position, permissions, is_everyone)
       VALUES (?, ?, '@everyone', 0, ?, 1)`,
      [serverId, serverId, DEFAULT_PERMISSIONS]
    );

    await runQuery(
      `INSERT INTO server_members (server_id, user_id) VALUES (?, ?)`, [serverId, ownerId]
    );
    await runQuery(
      `INSERT INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)`,
      [serverId, ownerId, serverId]
    );
    await runQuery(
      `INSERT INTO server_settings (user_id, server_id) VALUES (?, ?)`, [ownerId, serverId]
    );

    const textCategory  = generateId();
    const voiceCategory = generateId();
    const generalText   = generateId();
    const generalVoice  = generateId();

    await runQuery(`INSERT INTO channels (id, server_id, name, type, position) VALUES (?, ?, 'TEXT CHANNELS', 'category', 0)`, [textCategory, serverId]);
    await runQuery(`INSERT INTO channels (id, server_id, parent_id, name, type, position) VALUES (?, ?, ?, 'general', 'text', 1)`, [generalText, serverId, textCategory]);
    await runQuery(`INSERT INTO channels (id, server_id, name, type, position) VALUES (?, ?, 'VOICE CHANNELS', 'category', 2)`, [voiceCategory, serverId]);
    await runQuery(`INSERT INTO channels (id, server_id, parent_id, name, type, position, bitrate) VALUES (?, ?, ?, 'General Voice', 'voice', 3, 64000)`, [generalVoice, serverId, voiceCategory]);

    await runQuery(`UPDATE servers SET system_channel_id = ? WHERE id = ?`, [generalText, serverId]);
    await writeAuditLog({ serverId, userId: ownerId, actionType: 'SERVER_CREATE', targetId: serverId });
  });

  return getQuery(`SELECT * FROM servers WHERE id = ?`, [serverId]);
}

export async function createChannel({
  serverId, name, type = 'text', parentId = null, categoryName = null, userId, topic = null
}) {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) throw new ApiError('Channel name is required', { code: 'INVALID_NAME' });
  if (userId) await assertPermission({ userId, serverId, permission: 'MANAGE_CHANNELS' });
  // A "media" channel is Discord's name for a forum whose default layout is
  // the gallery. It is stored as a forum so every forum code path applies.
  const isMedia = type === 'media';
  if (isMedia) type = 'forum';
  if (!['text', 'voice', 'announcement', 'forum', 'stage', 'category'].includes(type)) {
    throw new ApiError(`Unsupported channel type '${type}'`, { code: 'INVALID_TYPE' });
  }

  // Text-ish channel names are slugs; voice, category and forum names are not.
  const finalName = ['text', 'announcement', 'forum'].includes(type)
    ? trimmed.toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '')
    : trimmed;

  let resolvedParent = parentId;
  if (!resolvedParent && categoryName) {
    const existing = await getQuery(
      `SELECT id FROM channels WHERE server_id = ? AND type = 'category' AND name = ? AND deleted_at IS NULL`,
      [serverId, categoryName]
    );
    if (existing) {
      resolvedParent = existing.id;
    } else {
      resolvedParent = generateId();
      const { maxPos } = await getQuery(
        `SELECT COALESCE(MAX(position), -1) AS maxPos FROM channels WHERE server_id = ?`, [serverId]
      );
      await runQuery(
        `INSERT INTO channels (id, server_id, name, type, position) VALUES (?, ?, ?, 'category', ?)`,
        [resolvedParent, serverId, categoryName, maxPos + 1]
      );
    }
  }

  const { maxPos } = await getQuery(
    `SELECT COALESCE(MAX(position), -1) AS maxPos FROM channels WHERE server_id = ?`, [serverId]
  );
  const channelId = generateId();

  await runQuery(
    `INSERT INTO channels (id, server_id, parent_id, name, type, topic, position, bitrate, default_layout)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [channelId, serverId, resolvedParent, finalName, type, topic, maxPos + 1,
     type === 'voice' ? 64000 : null, isMedia ? 'gallery' : 'list']
  );
  await writeAuditLog({ serverId, userId, actionType: 'CHANNEL_CREATE', targetType: 'channel', targetId: channelId });

  const channel = await getQuery(`SELECT * FROM channels WHERE id = ?`, [channelId]);
  const category = resolvedParent
    ? await getQuery(`SELECT name FROM channels WHERE id = ?`, [resolvedParent])
    : null;

  return { ...channel, category: category?.name ?? DEFAULT_CATEGORY_NAMES[type] ?? 'TEXT CHANNELS' };
}

export async function updateChannel({ channelId, patch, userId }) {
  const channel = await getQuery(
    `SELECT * FROM channels WHERE id = ? AND deleted_at IS NULL`, [channelId]
  );
  if (!channel) throw ApiError.notFound('Channel');

  if (userId) {
    if (channel.type === 'thread') {
      // Discord: the thread creator may manage their own thread; otherwise MANAGE_THREADS.
      if (channel.owner_id !== userId) {
        await assertPermission({ userId, serverId: channel.server_id, channelId: channel.parent_id, permission: 'MANAGE_THREADS' });
      }
    } else if (channel.type === 'group_dm') {
      if (channel.owner_id !== userId) throw ApiError.forbidden('Only the group owner can edit this group');
    } else if (channel.server_id) {
      await assertPermission({ userId, serverId: channel.server_id, channelId, permission: 'MANAGE_CHANNELS' });
    }
  }

  const allowed = ['name', 'topic', 'position', 'nsfw', 'rate_limit_per_user',
                   'bitrate', 'user_limit', 'parent_id', 'locked', 'archived'];
  const sets = [];
  const params = [];
  for (const key of allowed) {
    if (patch[key] === undefined) continue;
    let value = patch[key];
    if (key === 'name') {
      value = String(value).trim();
      if (!value) throw new ApiError('Channel name is required', { code: 'INVALID_NAME' });
      if (['text', 'announcement', 'forum'].includes(channel.type)) {
        value = value.toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{N}_-]/gu, '');
      }
      value = value.slice(0, 100);
    }
    if (key === 'topic') value = value === null ? null : String(value).slice(0, 1024);
    if (key === 'rate_limit_per_user') value = Math.max(0, Math.min(21600, Number(value) || 0));
    if (key === 'user_limit') value = Math.max(0, Math.min(99, Number(value) || 0));
    if (['nsfw', 'locked', 'archived'].includes(key)) value = value ? 1 : 0;
    sets.push(`${key} = ?`); params.push(value);
  }
  if (!sets.length) return channel;

  sets.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
  params.push(channelId);
  await runQuery(`UPDATE channels SET ${sets.join(', ')} WHERE id = ?`, params);

  if (channel.server_id) {
    await writeAuditLog({
      serverId: channel.server_id, userId, actionType: 'CHANNEL_UPDATE',
      targetType: 'channel', targetId: channelId,
      changes: Object.entries(patch).map(([key, value]) => ({ key, old: channel[key], new: value }))
    });
  }
  const updated = await getQuery(`SELECT * FROM channels WHERE id = ?`, [channelId]);
  const category = updated.parent_id
    ? await getQuery(`SELECT name FROM channels WHERE id = ? AND type = 'category'`, [updated.parent_id])
    : null;
  return { ...updated, category: category?.name ?? DEFAULT_CATEGORY_NAMES[updated.type] ?? (updated.type === 'thread' ? null : 'TEXT CHANNELS') };
}

export async function deleteChannel({ channelId, userId }) {
  const channel = await getQuery(`SELECT * FROM channels WHERE id = ?`, [channelId]);
  if (!channel) throw ApiError.notFound('Channel');
  if (userId && channel.server_id) {
    if (channel.type === 'thread') {
      if (channel.owner_id !== userId) {
        await assertPermission({ userId, serverId: channel.server_id, channelId: channel.parent_id, permission: 'MANAGE_THREADS' });
      }
    } else {
      await assertPermission({ userId, serverId: channel.server_id, channelId, permission: 'MANAGE_CHANNELS' });
    }
  }
  // Threads die with their parent, as on Discord.
  await runQuery(
    `UPDATE channels SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE parent_id = ? AND type = 'thread' AND deleted_at IS NULL`,
    [channelId]
  );
  await runQuery(
    `UPDATE channels SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    [channelId]
  );
  if (channel.server_id) {
    await writeAuditLog({
      serverId: channel.server_id, userId, actionType: 'CHANNEL_DELETE',
      targetType: 'channel', targetId: channelId
    });
  }
  return { id: channelId, server_id: channel.server_id };
}

// --- membership --------------------------------------------------------------

/**
 * Discord's verification levels, applied at the door.
 *   0 none      — anyone
 *   1 low       — verified e-mail
 *   2 medium    — verified e-mail + account older than 5 minutes
 *   3 high      — verified e-mail + account older than 10 minutes
 *   4 very high — verified phone (we have no phone; MFA stands in for it)
 * Checked on join rather than on every message: the column is a gate, and a
 * member who was let in stays in — Discord behaves the same way.
 */
export async function assertVerificationLevel(serverId, userId) {
  const server = await getQuery(`SELECT verification_level FROM servers WHERE id = ?`, [serverId]);
  const level = Number(server?.verification_level ?? 0);
  if (level <= 0) return;

  const user = await getQuery(
    `SELECT email_verified, mfa_enabled, created_at FROM users WHERE id = ?`, [userId]
  );
  if (!user) throw ApiError.notFound('User');

  if (level >= 1 && !user.email_verified) {
    throw new ApiError('This server requires a verified e-mail address',
      { status: 403, code: 'VERIFICATION_EMAIL' });
  }
  const ageMs = Date.now() - new Date(user.created_at).getTime();
  if (level >= 2 && ageMs < 5 * 60 * 1000) {
    throw new ApiError('This server requires an account at least 5 minutes old',
      { status: 403, code: 'VERIFICATION_AGE' });
  }
  if (level >= 3 && ageMs < 10 * 60 * 1000) {
    throw new ApiError('This server requires an account at least 10 minutes old',
      { status: 403, code: 'VERIFICATION_AGE' });
  }
  if (level >= 4 && !user.mfa_enabled) {
    throw new ApiError('This server requires two-factor authentication',
      { status: 403, code: 'VERIFICATION_MFA' });
  }
}

export async function joinServer({ serverId, userId }) {
  const banned = await getQuery(
    `SELECT 1 FROM bans WHERE server_id = ? AND user_id = ?`, [serverId, userId]
  );
  if (banned) throw ApiError.forbidden('You are banned from this server');
  await assertVerificationLevel(serverId, userId);

  const existing = await getQuery(
    `SELECT * FROM server_members WHERE server_id = ? AND user_id = ?`, [serverId, userId]
  );

  await transaction(async () => {
    if (existing) {
      await runQuery(
        `UPDATE server_members SET left_at = NULL, joined_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE server_id = ? AND user_id = ?`,
        [serverId, userId]
      );
    } else {
      await runQuery(`INSERT INTO server_members (server_id, user_id) VALUES (?, ?)`, [serverId, userId]);
    }
    // Membership screening: the new member is pending until they accept the
    // rules / finish onboarding. Rejoining members are screened again.
    const gate = await getQuery(`SELECT screening_enabled FROM servers WHERE id = ?`, [serverId]);
    await runQuery(
      `UPDATE server_members SET pending = ? WHERE server_id = ? AND user_id = ?`,
      [gate?.screening_enabled ? 1 : 0, serverId, userId]
    );
    await runQuery(
      `INSERT OR IGNORE INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)`,
      [serverId, userId, serverId]
    );
    await runQuery(
      `INSERT OR IGNORE INTO server_settings (user_id, server_id) VALUES (?, ?)`, [userId, serverId]
    );
    await runQuery(
      `UPDATE servers SET member_count = (
         SELECT count(*) FROM server_members WHERE server_id = ? AND left_at IS NULL
       ) WHERE id = ?`,
      [serverId, serverId]
    );
  });

  return getServerDetail(serverId, userId);
}

export async function leaveServer({ serverId, userId }) {
  const server = await getQuery(`SELECT owner_id FROM servers WHERE id = ?`, [serverId]);
  if (!server) throw ApiError.notFound('Server');
  if (server.owner_id === userId) {
    throw ApiError.conflict('Transfer ownership before leaving your own server');
  }
  await transaction(async () => {
    await runQuery(
      `UPDATE server_members SET left_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE server_id = ? AND user_id = ?`,
      [serverId, userId]
    );
    await runQuery(`DELETE FROM member_roles WHERE server_id = ? AND user_id = ?`, [serverId, userId]);
    await runQuery(
      `UPDATE servers SET member_count = (
         SELECT count(*) FROM server_members WHERE server_id = ? AND left_at IS NULL
       ) WHERE id = ?`,
      [serverId, serverId]
    );
  });
  return { success: true };
}

// --- roles -------------------------------------------------------------------

export async function createRole({ serverId, name, color = null, permissions = '0', hoist = false, mentionable = false, userId }) {
  const { maxPos } = await getQuery(
    `SELECT COALESCE(MAX(position), 0) AS maxPos FROM roles WHERE server_id = ?`, [serverId]
  );
  const roleId = generateId();
  await runQuery(
    `INSERT INTO roles (id, server_id, name, color, position, permissions, hoist, mentionable)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [roleId, serverId, name, color, maxPos + 1, String(permissions), hoist ? 1 : 0, mentionable ? 1 : 0]
  );
  await writeAuditLog({ serverId, userId, actionType: 'ROLE_CREATE', targetType: 'role', targetId: roleId });
  return getQuery(`SELECT * FROM roles WHERE id = ?`, [roleId]);
}

export async function assignRole({ serverId, userId: targetId, roleId, actorId }) {
  const role = await getQuery(`SELECT * FROM roles WHERE id = ? AND server_id = ?`, [roleId, serverId]);
  if (!role) throw ApiError.notFound('Role');
  await runQuery(
    `INSERT OR IGNORE INTO member_roles (server_id, user_id, role_id, assigned_by) VALUES (?, ?, ?, ?)`,
    [serverId, targetId, roleId, actorId]
  );
  await writeAuditLog({
    serverId, userId: actorId, actionType: 'MEMBER_ROLE_UPDATE',
    targetType: 'user', targetId, changes: [{ key: '$add', new: role.name }]
  });
  return { success: true };
}

export async function removeRole({ serverId, userId: targetId, roleId, actorId }) {
  if (roleId === serverId) throw ApiError.conflict('@everyone cannot be removed');
  await runQuery(
    `DELETE FROM member_roles WHERE server_id = ? AND user_id = ? AND role_id = ?`,
    [serverId, targetId, roleId]
  );
  await writeAuditLog({
    serverId, userId: actorId, actionType: 'MEMBER_ROLE_UPDATE',
    targetType: 'user', targetId, changes: [{ key: '$remove', new: roleId }]
  });
  return { success: true };
}

// --- direct messages ---------------------------------------------------------

/** Open (or reuse) a 1:1 DM channel. */
export async function openDirectMessage({ userId, recipientId }) {
  if (userId === recipientId) throw new ApiError('Cannot DM yourself', { code: 'INVALID_RECIPIENT' });

  const blocked = await getQuery(
    `SELECT 1 FROM blocks WHERE (user_id = ? AND blocked_id = ?) OR (user_id = ? AND blocked_id = ?)`,
    [recipientId, userId, userId, recipientId]
  );
  if (blocked) throw ApiError.forbidden('Cannot message this user');

  // Privacy & Safety › who can direct-message you.
  const { assertCanDirectMessage } = await import('./users.js');
  await assertCanDirectMessage({ senderId: userId, recipientId });

  // A DM is the channel of type 'dm' whose recipient set is exactly these two.
  const existing = await getQuery(
    `SELECT c.id FROM channels c
      WHERE c.type = 'dm' AND c.deleted_at IS NULL
        AND (SELECT count(*) FROM channel_recipients cr WHERE cr.channel_id = c.id) = 2
        AND EXISTS (SELECT 1 FROM channel_recipients WHERE channel_id = c.id AND user_id = ?)
        AND EXISTS (SELECT 1 FROM channel_recipients WHERE channel_id = c.id AND user_id = ?)`,
    [userId, recipientId]
  );

  if (existing) {
    await runQuery(
      `UPDATE channel_recipients SET closed = 0 WHERE channel_id = ? AND user_id = ?`,
      [existing.id, userId]
    );
    return getDirectMessageChannel(existing.id, userId);
  }

  const channelId = generateId();
  await transaction(async () => {
    await runQuery(`INSERT INTO channels (id, type) VALUES (?, 'dm')`, [channelId]);
    for (const uid of [userId, recipientId]) {
      await runQuery(
        `INSERT INTO channel_recipients (channel_id, user_id) VALUES (?, ?)`, [channelId, uid]
      );
    }
  });
  return getDirectMessageChannel(channelId, userId);
}

export async function createGroupDM({ userId, recipientIds = [], name = null }) {
  const unique = [...new Set(recipientIds.filter((id) => id && id !== userId))];
  if (unique.length === 0) throw new ApiError('A group needs at least one other person', { code: 'INVALID_RECIPIENTS' });
  if (unique.length > 9) throw new ApiError('กลุ่มรับได้สูงสุด 10 คน', { code: 'GROUP_FULL' });

  // A block works both ways here too — you cannot pull someone who blocked you
  // into a group, and you cannot be pulled into one with someone you blocked.
  for (const recipientId of unique) {
    const exists = await getQuery(`SELECT 1 FROM users WHERE id = ? AND deleted_at IS NULL`, [recipientId]);
    if (!exists) throw ApiError.notFound('User');
    const blocked = await getQuery(
      `SELECT 1 FROM blocks WHERE (user_id = ? AND blocked_id = ?) OR (user_id = ? AND blocked_id = ?)`,
      [recipientId, userId, userId, recipientId]
    );
    if (blocked) throw ApiError.forbidden('Cannot start a group with this user');
    const { assertCanDirectMessage } = await import('./users.js');
    await assertCanDirectMessage({ senderId: userId, recipientId });
  }
  recipientIds = unique;

  const channelId = generateId();
  await transaction(async () => {
    await runQuery(
      `INSERT INTO channels (id, type, name, owner_id) VALUES (?, 'group_dm', ?, ?)`,
      [channelId, name, userId]
    );
    for (const uid of new Set([userId, ...recipientIds])) {
      await runQuery(
        `INSERT INTO channel_recipients (channel_id, user_id) VALUES (?, ?)`, [channelId, uid]
      );
    }
  });
  return getDirectMessageChannel(channelId, userId);
}

export async function getDirectMessageChannel(channelId, viewerId) {
  const channel = await getQuery(
    `SELECT * FROM channels WHERE id = ? AND deleted_at IS NULL`, [channelId]
  );
  if (!channel) throw ApiError.notFound('Channel');
  const recipients = await allQuery(
    `SELECT u.id, u.username, u.display_name, u.avatar_url, u.status, u.custom_status
       FROM channel_recipients cr JOIN users u ON u.id = cr.user_id
      WHERE cr.channel_id = ? AND u.id != ?`,
    [channelId, viewerId]
  );
  return {
    ...channel,
    recipients,
    // A 1:1 DM shows the other person; a group shows its name or a joined list.
    display_name: channel.type === 'dm'
      ? recipients[0]?.display_name ?? 'Unknown user'
      : channel.name || recipients.map((r) => r.display_name).join(', '),
    avatar_url: channel.type === 'dm' ? recipients[0]?.avatar_url ?? null : channel.icon_url
  };
}

export async function listDirectMessageChannels(userId) {
  const rows = await allQuery(
    `SELECT c.id FROM channels c
       JOIN channel_recipients cr ON cr.channel_id = c.id
      WHERE cr.user_id = ? AND cr.closed = 0 AND c.deleted_at IS NULL
        AND c.type IN ('dm','group_dm')
      ORDER BY COALESCE(c.last_message_id, c.id) DESC`,
    [userId]
  );
  return Promise.all(rows.map((r) => getDirectMessageChannel(r.id, userId)));
}

// --- invites -----------------------------------------------------------------

const INVITE_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function generateInviteCode(length = 8) {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += INVITE_ALPHABET[Math.floor(Math.random() * INVITE_ALPHABET.length)];
  }
  return out;
}

export async function createInvite({ serverId, channelId, inviterId, maxUses = 0, maxAge = 86400, temporary = false }) {
  let code = generateInviteCode();
  // Codes are short; retry on the rare collision rather than trusting luck.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const clash = await getQuery(`SELECT 1 FROM invites WHERE code = ?`, [code]);
    if (!clash) break;
    code = generateInviteCode();
  }
  const expiresAt = maxAge > 0 ? new Date(Date.now() + maxAge * 1000).toISOString() : null;
  await runQuery(
    `INSERT INTO invites (code, server_id, channel_id, inviter_id, max_uses, max_age, temporary, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [code, serverId, channelId, inviterId, maxUses, maxAge, temporary ? 1 : 0, expiresAt]
  );
  return getQuery(`SELECT * FROM invites WHERE code = ?`, [code]);
}

/** Public invite preview: what the join screen shows before you commit. */
/**
 * A vanity URL is a permanent, human-readable invite: /join/gamers-haven.
 * It is resolved by looking for a server whose slug matches, and behaves like
 * an invite with no expiry and no use limit.
 */
export async function resolveVanity(slug) {
  if (!slug) return null;
  return getQuery(
    `SELECT id FROM servers WHERE vanity_url = ? AND deleted_at IS NULL`, [String(slug).toLowerCase()]
  );
}

export async function getInvitePreview(code) {
  const vanity = await resolveVanity(code);
  if (vanity) {
    const server = await getQuery(
      `SELECT id, name, icon_url, member_count, description FROM servers WHERE id = ?`, [vanity.id]
    );
    return {
      code, vanity: true, expires_at: null, max_uses: 0, uses: 0,
      server: { id: server.id, name: server.name, icon_url: server.icon_url,
                member_count: server.member_count, description: server.description },
      channel: null, inviter: null
    };
  }
  const invite = await getQuery(
    `SELECT i.*, s.name AS server_name, s.icon_url AS server_icon, s.member_count,
            s.description AS server_description, c.name AS channel_name,
            u.display_name AS inviter_name, u.username AS inviter_username
       FROM invites i
       JOIN servers s ON s.id = i.server_id AND s.deleted_at IS NULL
       LEFT JOIN channels c ON c.id = i.channel_id
       LEFT JOIN users u ON u.id = i.inviter_id
      WHERE i.code = ? AND i.revoked_at IS NULL`,
    [code]
  );
  if (!invite) throw ApiError.notFound('Invite');
  const expired = invite.expires_at && invite.expires_at < new Date().toISOString();
  const exhausted = invite.max_uses > 0 && invite.uses >= invite.max_uses;
  if (expired || exhausted) {
    throw new ApiError(expired ? 'This invite has expired' : 'This invite has been used up', {
      status: 410, code: expired ? 'INVITE_EXPIRED' : 'INVITE_EXHAUSTED'
    });
  }
  const online = await getQuery(
    `SELECT count(*) AS n FROM server_members sm JOIN users u ON u.id = sm.user_id
      WHERE sm.server_id = ? AND sm.left_at IS NULL AND u.status NOT IN ('offline','invisible')`,
    [invite.server_id]
  );
  return {
    code: invite.code,
    server: {
      id: invite.server_id, name: invite.server_name, icon_url: invite.server_icon,
      description: invite.server_description, member_count: invite.member_count,
      online_count: online?.n ?? 0
    },
    channel: invite.channel_id ? { id: invite.channel_id, name: invite.channel_name } : null,
    inviter: invite.inviter_id
      ? { id: invite.inviter_id, display_name: invite.inviter_name, username: invite.inviter_username }
      : null,
    expires_at: invite.expires_at
  };
}

/** Hide a DM from the sidebar. The channel and its history survive — reopening restores it. */
export async function closeDirectMessage({ channelId, userId }) {
  const result = await runQuery(
    `UPDATE channel_recipients SET closed = 1 WHERE channel_id = ? AND user_id = ?`,
    [channelId, userId]
  );
  if (!result?.changes) throw ApiError.notFound('Conversation');
  return { success: true, channel_id: channelId };
}

/** Add people to a group DM (or upgrade a 1:1 DM into a new group). */
export async function addGroupRecipients({ channelId, userId, recipientIds = [] }) {
  const channel = await getQuery(
    `SELECT * FROM channels WHERE id = ? AND deleted_at IS NULL AND type IN ('dm','group_dm')`,
    [channelId]
  );
  if (!channel) throw ApiError.notFound('Channel');
  const isRecipient = await getQuery(
    `SELECT 1 FROM channel_recipients WHERE channel_id = ? AND user_id = ?`, [channelId, userId]
  );
  if (!isRecipient) throw ApiError.forbidden('You are not in this conversation');

  if (channel.type === 'dm') {
    const others = await allQuery(
      `SELECT user_id FROM channel_recipients WHERE channel_id = ?`, [channelId]
    );
    return createGroupDM({
      userId, recipientIds: [...others.map((r) => r.user_id), ...recipientIds]
    });
  }
  const { n } = await getQuery(
    `SELECT count(*) AS n FROM channel_recipients WHERE channel_id = ?`, [channelId]
  );
  if (n + recipientIds.length > 10) throw new ApiError('กลุ่มรับได้สูงสุด 10 คน', { code: 'GROUP_FULL' });
  for (const rid of recipientIds) {
    await runQuery(
      `INSERT OR IGNORE INTO channel_recipients (channel_id, user_id) VALUES (?, ?)`, [channelId, rid]
    );
  }
  return getDirectMessageChannel(channelId, userId);
}

export async function removeGroupRecipient({ channelId, userId, targetId }) {
  const channel = await getQuery(
    `SELECT * FROM channels WHERE id = ? AND deleted_at IS NULL AND type = 'group_dm'`, [channelId]
  );
  if (!channel) throw ApiError.notFound('Channel');
  if (targetId !== userId && channel.owner_id !== userId) {
    throw ApiError.forbidden('Only the group owner can remove members');
  }
  await runQuery(`DELETE FROM channel_recipients WHERE channel_id = ? AND user_id = ?`, [channelId, targetId]);
  const remaining = await getQuery(
    `SELECT count(*) AS n FROM channel_recipients WHERE channel_id = ?`, [channelId]
  );
  // An empty group is dead weight; Discord deletes it once the last person leaves.
  if ((remaining?.n ?? 0) === 0) {
    await runQuery(
      `UPDATE channels SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`, [channelId]
    );
  }
  return { success: true, channel_id: channelId, user_id: targetId };
}

export async function acceptInvite({ code, userId }) {
  const vanity = await resolveVanity(code);
  if (vanity) return joinServer({ serverId: vanity.id, userId });

  const invite = await getQuery(
    `SELECT * FROM invites WHERE code = ? AND revoked_at IS NULL`, [code]
  );
  if (!invite) throw ApiError.notFound('Invite');
  if (invite.expires_at && invite.expires_at < new Date().toISOString()) {
    throw new ApiError('This invite has expired', { status: 410, code: 'INVITE_EXPIRED' });
  }
  if (invite.max_uses > 0 && invite.uses >= invite.max_uses) {
    throw new ApiError('This invite has been used up', { status: 410, code: 'INVITE_EXHAUSTED' });
  }

  await runQuery(`UPDATE invites SET uses = uses + 1 WHERE code = ?`, [code]);
  return joinServer({ serverId: invite.server_id, userId });
}

// --- moderation --------------------------------------------------------------

/**
 * Discord's member hierarchy rule: you may only act on someone whose highest
 * role sits strictly below your own, never on the owner, and never on yourself.
 * The owner is exempt from the role comparison but still cannot be targeted.
 */
export async function assertMemberHierarchy({ serverId, actorId, targetId, action }) {
  if (actorId === targetId) {
    throw ApiError.forbidden(`You cannot ${action} yourself`);
  }
  const server = await getQuery(`SELECT owner_id FROM servers WHERE id = ?`, [serverId]);
  if (!server) throw ApiError.notFound('Server');
  if (server.owner_id === targetId) {
    throw ApiError.forbidden(`You cannot ${action} the server owner`);
  }
  if (server.owner_id === actorId) return;

  const highestOf = async (userId) => {
    const rows = await allQuery(
      `SELECT r.position FROM member_roles mr JOIN roles r ON r.id = mr.role_id
        WHERE mr.server_id = ? AND mr.user_id = ?`,
      [serverId, userId]
    );
    return rows.reduce((max, r) => Math.max(max, r.position), 0);
  };

  const [actorTop, targetTop] = await Promise.all([highestOf(actorId), highestOf(targetId)]);
  if (targetTop >= actorTop) {
    throw ApiError.forbidden(`You cannot ${action} someone with a role at or above your own`);
  }
}

export async function banMember({ serverId, userId: targetId, moderatorId, reason = null, deleteMessageSeconds = 0 }) {
  if (moderatorId) {
    await assertMemberHierarchy({ serverId, actorId: moderatorId, targetId, action: 'ban' });
  }
  await transaction(async () => {
    await runQuery(
      `INSERT OR REPLACE INTO bans (server_id, user_id, moderator_id, reason, delete_message_seconds)
       VALUES (?, ?, ?, ?, ?)`,
      [serverId, targetId, moderatorId, reason, deleteMessageSeconds]
    );
    await runQuery(
      `UPDATE server_members SET left_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE server_id = ? AND user_id = ?`,
      [serverId, targetId]
    );
    if (deleteMessageSeconds > 0) {
      const cutoff = new Date(Date.now() - deleteMessageSeconds * 1000).toISOString();
      await runQuery(
        `UPDATE messages SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
          WHERE server_id = ? AND user_id = ? AND created_at > ?`,
        [serverId, targetId, cutoff]
      );
    }
    await writeAuditLog({
      serverId, userId: moderatorId, actionType: 'MEMBER_BAN_ADD',
      targetType: 'user', targetId, reason
    });
  });
  return { success: true };
}

export async function kickMember({ serverId, userId: targetId, moderatorId, reason = null }) {
  if (moderatorId) {
    await assertMemberHierarchy({ serverId, actorId: moderatorId, targetId, action: 'kick' });
  }
  await runQuery(
    `UPDATE server_members SET left_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE server_id = ? AND user_id = ?`,
    [serverId, targetId]
  );
  await writeAuditLog({
    serverId, userId: moderatorId, actionType: 'MEMBER_KICK',
    targetType: 'user', targetId, reason
  });
  return { success: true };
}

export async function timeoutMember({ serverId, userId: targetId, moderatorId, untilIso, reason = null }) {
  if (moderatorId) {
    await assertMemberHierarchy({ serverId, actorId: moderatorId, targetId, action: 'time out' });
  }
  // Normalise to UTC. Everything downstream compares timestamps, and an offset
  // like +07:00 would silently void the timeout on a naive comparison.
  const parsed = Date.parse(untilIso);
  if (!Number.isFinite(parsed)) {
    throw new ApiError('until must be an ISO 8601 timestamp', { code: 'INVALID_TIMEOUT' });
  }
  // Discord caps a timeout at 28 days.
  const MAX_MS = 28 * 24 * 60 * 60 * 1000;
  const capped = Math.min(parsed, Date.now() + MAX_MS);
  const normalised = capped <= Date.now() ? null : new Date(capped).toISOString();

  await runQuery(
    `UPDATE server_members SET timeout_until = ? WHERE server_id = ? AND user_id = ?`,
    [normalised, serverId, targetId]
  );
  untilIso = normalised;

  await writeAuditLog({
    serverId, userId: moderatorId, actionType: 'MEMBER_TIMEOUT',
    targetType: 'user', targetId, reason, changes: [{ key: 'timeout_until', new: normalised }]
  });
  return { success: true, timeout_until: normalised };
}

export async function writeAuditLog({
  serverId, userId, actionType, targetType = null, targetId = null, changes = [], reason = null
}) {
  if (!serverId) return;
  await runQuery(
    `INSERT INTO audit_logs (id, server_id, user_id, action_type, target_type, target_id, changes, reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [generateId(), serverId, userId, actionType, targetType, targetId, JSON.stringify(changes), reason]
  );
}

export async function listAuditLog(serverId, { limit = 50, before = null } = {}) {
  const params = [serverId];
  let where = 'al.server_id = ?';
  if (before) { where += ' AND al.id < ?'; params.push(before); }
  params.push(Math.min(limit, 100));
  const rows = await allQuery(
    `SELECT al.*, u.username, u.display_name, u.avatar_url
       FROM audit_logs al LEFT JOIN users u ON u.id = al.user_id
      WHERE ${where} ORDER BY al.id DESC LIMIT ?`,
    params
  );
  return rows.map((r) => ({ ...r, changes: JSON.parse(r.changes || '[]') }));
}

export { PERMISSIONS };
