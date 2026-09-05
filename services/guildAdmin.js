// ============================================================================
//  Guild administration — the write side of Server Settings.
//
//  Roles, emojis, invites, bans and guild profile edits. Every mutation goes
//  through assertPermission() and leaves an audit-log entry, because a settings
//  screen without an audit trail is how servers get quietly wrecked.
// ============================================================================

import { runQuery, getQuery, allQuery, transaction } from '../db.js';
import { generateId } from '../lib/snowflake.js';
import { ApiError } from '../lib/httpUtils.js';
import { toBigInt, ALL_PERMISSIONS } from '../lib/permissions.js';
import { addReference, releaseReference, findFileByPublicUrl } from '../storageService.js';
import { assertPermission, resolvePermissions, writeAuditLog } from './guilds.js';

// --- guild profile -----------------------------------------------------------

const GUILD_FIELDS = [
  'name', 'description', 'icon_url', 'banner_url', 'splash_url', 'vanity_url',
  'verification_level', 'explicit_content_filter', 'default_notifications',
  'system_channel_id', 'rules_channel_id', 'afk_channel_id', 'afk_timeout', 'locale'
];

/**
 * A vanity slug is a URL segment, so it is held to URL rules: lowercase
 * letters, digits and hyphens, 2–32 characters, unique across servers. It is
 * also checked against real invite codes, or a slug could shadow someone's
 * invite link.
 */
async function validateVanity(slug, serverId) {
  if (slug === null || slug === '') return null;
  const clean = String(slug).trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]$/.test(clean)) {
    throw new ApiError('Vanity URL may use lowercase letters, digits and hyphens (2–32 characters)',
      { code: 'VANITY_INVALID' });
  }
  const taken = await getQuery(
    `SELECT id FROM servers WHERE vanity_url = ? AND id != ? AND deleted_at IS NULL`, [clean, serverId]
  );
  if (taken) throw new ApiError('That vanity URL is already taken', { status: 409, code: 'VANITY_TAKEN' });
  const collides = await getQuery(`SELECT 1 FROM invites WHERE code = ?`, [clean]);
  if (collides) throw new ApiError('That vanity URL collides with an invite code', { status: 409, code: 'VANITY_TAKEN' });
  return clean;
}

export async function updateGuild({ serverId, actorId, patch }) {
  await assertPermission({ userId: actorId, serverId, permission: 'MANAGE_GUILD' });
  const before = await getQuery(`SELECT * FROM servers WHERE id = ?`, [serverId]);
  if (!before) throw ApiError.notFound('Server');

  if (patch.vanity_url !== undefined) {
    patch = { ...patch, vanity_url: await validateVanity(patch.vanity_url, serverId) };
  }
  if (patch.verification_level !== undefined) {
    const level = Number(patch.verification_level);
    if (!Number.isInteger(level) || level < 0 || level > 4) {
      throw new ApiError('verification_level must be 0–4', { code: 'INVALID_VERIFICATION_LEVEL' });
    }
    patch = { ...patch, verification_level: level };
  }
  if (patch.afk_timeout !== undefined) {
    // Discord offers 1, 5, 15, 30 and 60 minutes.
    const seconds = Number(patch.afk_timeout);
    if (![60, 300, 900, 1800, 3600].includes(seconds)) {
      throw new ApiError('afk_timeout must be 60, 300, 900, 1800 or 3600 seconds', { code: 'INVALID_AFK_TIMEOUT' });
    }
    patch = { ...patch, afk_timeout: seconds };
  }

  const sets = [];
  const params = [];
  const changes = [];
  for (const field of GUILD_FIELDS) {
    if (patch[field] === undefined || patch[field] === before[field]) continue;
    sets.push(`${field} = ?`);
    params.push(patch[field]);
    changes.push({ key: field, old: before[field], new: patch[field] });
  }
  if (!sets.length) return before;

  sets.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
  params.push(serverId);

  await transaction(async () => {
    await runQuery(`UPDATE servers SET ${sets.join(', ')} WHERE id = ?`, params);

    // Track icon/banner file references so a replaced icon becomes collectable.
    for (const [urlField, idField] of [['icon_url', 'icon_file_id'], ['banner_url', 'banner_file_id']]) {
      if (patch[urlField] === undefined) continue;
      const file = await findFileByPublicUrl(patch[urlField]);
      if (before[idField] && before[idField] !== file?.id) await releaseReference(before[idField]);
      if (file) {
        await addReference(file.id);
        await runQuery(`UPDATE servers SET ${idField} = ? WHERE id = ?`, [file.id, serverId]);
      }
    }
    await writeAuditLog({
      serverId, userId: actorId, actionType: 'SERVER_UPDATE',
      targetType: 'server', targetId: serverId, changes
    });
  });

  return getQuery(`SELECT * FROM servers WHERE id = ?`, [serverId]);
}

export async function deleteGuild({ serverId, actorId }) {
  const server = await getQuery(`SELECT owner_id FROM servers WHERE id = ?`, [serverId]);
  if (!server) throw ApiError.notFound('Server');
  if (server.owner_id !== actorId) throw ApiError.forbidden('Only the owner can delete a server');

  await runQuery(
    `UPDATE servers SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    [serverId]
  );
  return { success: true };
}

export async function transferOwnership({ serverId, actorId, newOwnerId }) {
  const server = await getQuery(`SELECT owner_id FROM servers WHERE id = ?`, [serverId]);
  if (!server) throw ApiError.notFound('Server');
  if (server.owner_id !== actorId) throw ApiError.forbidden('Only the owner can transfer ownership');

  const member = await getQuery(
    `SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ? AND left_at IS NULL`,
    [serverId, newOwnerId]
  );
  if (!member) throw new ApiError('That user is not a member', { code: 'NOT_A_MEMBER' });

  await runQuery(`UPDATE servers SET owner_id = ? WHERE id = ?`, [newOwnerId, serverId]);
  await writeAuditLog({
    serverId, userId: actorId, actionType: 'SERVER_OWNER_TRANSFER',
    targetType: 'user', targetId: newOwnerId
  });
  return { success: true };
}

// --- roles -------------------------------------------------------------------

/**
 * A member may never grant a permission they do not themselves hold, nor edit a
 * role at or above their own highest role. Without both checks, MANAGE_ROLES is
 * a straight path to administrator.
 */
async function assertRoleHierarchy({ serverId, actorId, targetRole, nextPermissions }) {
  const resolved = await resolvePermissions({ userId: actorId, serverId });
  if (resolved.isOwner) return resolved;

  const actorRoles = await allQuery(
    `SELECT r.position FROM member_roles mr JOIN roles r ON r.id = mr.role_id
      WHERE mr.server_id = ? AND mr.user_id = ?`,
    [serverId, actorId]
  );
  const highest = actorRoles.reduce((max, r) => Math.max(max, r.position), 0);

  if (targetRole && targetRole.position >= highest) {
    throw ApiError.forbidden('You cannot manage a role at or above your highest role');
  }
  if (nextPermissions !== undefined) {
    const granting = toBigInt(nextPermissions) & ~toBigInt(resolved.permissions);
    if (granting !== 0n) {
      throw ApiError.forbidden('You cannot grant permissions you do not have');
    }
  }
  return resolved;
}

export async function listRoles(serverId) {
  const roles = await allQuery(
    `SELECT r.*, (
       SELECT count(*) FROM member_roles mr WHERE mr.role_id = r.id
     ) AS member_count
     FROM roles r WHERE r.server_id = ? ORDER BY r.position DESC`,
    [serverId]
  );
  return roles.map((r) => ({
    ...r,
    hoist: Boolean(r.hoist),
    mentionable: Boolean(r.mentionable),
    managed: Boolean(r.managed),
    is_everyone: Boolean(r.is_everyone)
  }));
}

export async function updateRole({ serverId, roleId, actorId, patch }) {
  await assertPermission({ userId: actorId, serverId, permission: 'MANAGE_ROLES' });
  const role = await getQuery(
    `SELECT * FROM roles WHERE id = ? AND server_id = ?`, [roleId, serverId]
  );
  if (!role) throw ApiError.notFound('Role');
  if (role.managed) throw ApiError.conflict('Managed roles cannot be edited');

  await assertRoleHierarchy({
    serverId, actorId,
    // @everyone sits at position 0 and is edited by anyone with MANAGE_ROLES.
    targetRole: role.is_everyone ? null : role,
    nextPermissions: patch.permissions
  });

  // `color_secondary` turns the name into a gradient; NULL keeps it flat.
  const writable = ['name', 'color', 'color_secondary', 'permissions', 'hoist',
                    'mentionable', 'position', 'icon_url'];
  const sets = [];
  const params = [];
  const changes = [];
  for (const field of writable) {
    if (patch[field] === undefined) continue;
    // @everyone cannot be renamed, coloured or hoisted.
    if (role.is_everyone && field !== 'permissions') continue;
    const value = ['hoist', 'mentionable'].includes(field)
      ? (patch[field] ? 1 : 0)
      : field === 'permissions' ? String(patch[field]) : patch[field];
    sets.push(`${field} = ?`);
    params.push(value);
    changes.push({ key: field, old: role[field], new: value });
  }
  if (!sets.length) return role;

  params.push(roleId);
  await runQuery(`UPDATE roles SET ${sets.join(', ')} WHERE id = ?`, params);
  await writeAuditLog({
    serverId, userId: actorId, actionType: 'ROLE_UPDATE',
    targetType: 'role', targetId: roleId, changes
  });
  return getQuery(`SELECT * FROM roles WHERE id = ?`, [roleId]);
}

export async function deleteRole({ serverId, roleId, actorId }) {
  await assertPermission({ userId: actorId, serverId, permission: 'MANAGE_ROLES' });
  const role = await getQuery(
    `SELECT * FROM roles WHERE id = ? AND server_id = ?`, [roleId, serverId]
  );
  if (!role) throw ApiError.notFound('Role');
  if (role.is_everyone) throw ApiError.conflict('@everyone cannot be deleted');
  if (role.managed) throw ApiError.conflict('Managed roles cannot be deleted');

  await assertRoleHierarchy({ serverId, actorId, targetRole: role });

  await runQuery(`DELETE FROM roles WHERE id = ?`, [roleId]); // member_roles cascades
  await writeAuditLog({
    serverId, userId: actorId, actionType: 'ROLE_DELETE',
    targetType: 'role', targetId: roleId, changes: [{ key: 'name', old: role.name }]
  });
  return { success: true };
}

/** Reorder roles in one shot; positions are dense and unique per guild. */
export async function reorderRoles({ serverId, actorId, order }) {
  await assertPermission({ userId: actorId, serverId, permission: 'MANAGE_ROLES' });
  if (!Array.isArray(order) || order.length === 0) {
    throw new ApiError('order must be a non-empty array of role ids', { code: 'INVALID_ORDER' });
  }

  const roles = await allQuery(
    `SELECT id, position, is_everyone, managed FROM roles WHERE server_id = ?`, [serverId]
  );
  const byId = new Map(roles.map((r) => [r.id, r]));
  for (const roleId of order) {
    const role = byId.get(roleId);
    if (!role) throw ApiError.notFound('Role');
    if (role.is_everyone) throw ApiError.conflict('@everyone cannot be moved');
  }

  // The client may send only the roles it moved. Merge them into the guild's
  // current ordering so positions stay dense and unique across *all* roles —
  // renumbering a subset on its own would collide with the untouched ones.
  const ranked = roles
    .filter((r) => !r.is_everyone)
    .sort((a, b) => b.position - a.position)
    .map((r) => r.id);
  const moved = new Set(order);
  const merged = [];
  let cursor = 0;
  for (const id of ranked) {
    if (moved.has(id)) {
      // Take the next entry from the submitted order at each moved slot.
      while (cursor < order.length && !moved.has(order[cursor])) cursor += 1;
      merged.push(order[cursor]);
      cursor += 1;
    } else {
      merged.push(id);
    }
  }

  // Hierarchy applies to a reorder too: you may not touch a role at or above
  // your own, and you may not lift one past it either. Positions are assigned
  // top-down from the merged list, so compare against those final numbers.
  const resolved = await resolvePermissions({ userId: actorId, serverId });
  if (!resolved.isOwner) {
    const actorRoles = await allQuery(
      `SELECT r.position FROM member_roles mr JOIN roles r ON r.id = mr.role_id
        WHERE mr.server_id = ? AND mr.user_id = ?`,
      [serverId, actorId]
    );
    const highest = actorRoles.reduce((max, r) => Math.max(max, r.position), 0);
    merged.forEach((roleId, index) => {
      if (!moved.has(roleId)) return;   // untouched roles keep their place
      const role = byId.get(roleId);
      const nextPosition = merged.length - index;
      if (role.position >= highest || nextPosition >= highest) {
        throw ApiError.forbidden('You cannot move a role at or above your highest role');
      }
    });
  }

  await transaction(async () => {
    for (const [index, roleId] of merged.entries()) {
      await runQuery(
        `UPDATE roles SET position = ? WHERE id = ? AND server_id = ? AND is_everyone = 0`,
        [merged.length - index, roleId, serverId]
      );
    }
  });
  return listRoles(serverId);
}

// --- members -----------------------------------------------------------------

export async function listMembers(serverId, { limit = 200, search = null } = {}) {
  const params = [serverId];
  let where = 'sm.server_id = ? AND sm.left_at IS NULL';
  if (search) {
    where += ' AND (u.username LIKE ? OR u.display_name LIKE ? OR sm.nickname LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  params.push(Math.min(limit, 1000));

  const members = await allQuery(
    `SELECT u.id, u.username, u.discriminator, u.display_name, u.avatar_url, u.status, u.is_bot,
            sm.nickname, sm.joined_at, sm.timeout_until, sm.pending,
            sm.avatar_url AS member_avatar_url, sm.pronouns AS member_pronouns
       FROM server_members sm JOIN users u ON u.id = sm.user_id
      WHERE ${where} ORDER BY sm.joined_at ASC LIMIT ?`,
    params
  );

  const roleRows = await allQuery(
    `SELECT mr.user_id, r.id, r.name, r.color, r.position, r.icon_url
       FROM member_roles mr JOIN roles r ON r.id = mr.role_id
      WHERE mr.server_id = ? ORDER BY r.position DESC`,
    [serverId]
  );

  const byUser = new Map();
  for (const row of roleRows) {
    if (!byUser.has(row.user_id)) byUser.set(row.user_id, []);
    byUser.get(row.user_id).push(row);
  }
  return members.map((m) => {
    const roles = byUser.get(m.id) ?? [];
    // Discord shows the icon of the member's highest role that has one, next
    // to their name. Roles arrive ordered by position DESC, so first wins.
    const iconed = roles.find((r) => r.icon_url);
    return {
      ...m,
      // A per-server avatar wins over the account one, as it does in Discord.
      avatar_url: m.member_avatar_url || m.avatar_url,
      pronouns: m.member_pronouns ?? null,
      pending: Boolean(m.pending),
      roles,
      role_icon: iconed ? { url: iconed.icon_url, name: iconed.name } : null
    };
  });
}

/**
 * A member's per-server profile: nickname, avatar, banner, bio, pronouns.
 * You may edit your own; changing someone else's nickname needs
 * MANAGE_NICKNAMES, and the decorative fields are always your own only —
 * nobody should be able to write words into another person's profile.
 */
export async function setGuildProfile({ serverId, userId, actorId, patch }) {
  const member = await getQuery(
    `SELECT * FROM server_members WHERE server_id = ? AND user_id = ? AND left_at IS NULL`, [serverId, userId]
  );
  if (!member) throw ApiError.notFound('Member');
  if (actorId !== userId) {
    throw ApiError.forbidden('You can only edit your own server profile');
  }
  const sets = []; const params = [];
  const text = (value, max) => (value ? String(value).trim().slice(0, max) : null);
  if (patch.avatar_url !== undefined) { sets.push('avatar_url = ?'); params.push(patch.avatar_url || null); }
  if (patch.banner_url !== undefined) { sets.push('banner_url = ?'); params.push(patch.banner_url || null); }
  if (patch.bio !== undefined) { sets.push('bio = ?'); params.push(text(patch.bio, 190)); }
  if (patch.pronouns !== undefined) { sets.push('pronouns = ?'); params.push(text(patch.pronouns, 40)); }
  if (patch.nickname !== undefined) { sets.push('nickname = ?'); params.push(text(patch.nickname, 32)); }
  if (sets.length) {
    await runQuery(
      `UPDATE server_members SET ${sets.join(', ')} WHERE server_id = ? AND user_id = ?`,
      [...params, serverId, userId]
    );
  }
  return getGuildProfile({ serverId, userId });
}

/** The per-server profile, with the global one filled in behind it. */
export async function getGuildProfile({ serverId, userId }) {
  const row = await getQuery(
    `SELECT sm.nickname, sm.avatar_url, sm.banner_url, sm.bio, sm.pronouns, sm.joined_at,
            u.username, u.display_name, u.avatar_url AS global_avatar_url, u.banner_url AS global_banner_url,
            u.bio AS global_bio, u.pronouns AS global_pronouns
       FROM server_members sm JOIN users u ON u.id = sm.user_id
      WHERE sm.server_id = ? AND sm.user_id = ? AND sm.left_at IS NULL`,
    [serverId, userId]
  );
  if (!row) throw ApiError.notFound('Member');
  return {
    server_id: serverId,
    user_id: userId,
    nickname: row.nickname ?? null,
    avatar_url: row.avatar_url ?? null,
    banner_url: row.banner_url ?? null,
    bio: row.bio ?? null,
    pronouns: row.pronouns ?? null,
    joined_at: row.joined_at,
    // What the member actually looks like here, once the overrides are applied.
    effective: {
      display_name: row.nickname || row.display_name || row.username,
      avatar_url: row.avatar_url || row.global_avatar_url,
      banner_url: row.banner_url || row.global_banner_url,
      bio: row.bio ?? row.global_bio,
      pronouns: row.pronouns ?? row.global_pronouns
    }
  };
}

export async function setNickname({ serverId, userId, actorId, nickname }) {
  const permission = userId === actorId ? 'CHANGE_NICKNAME' : 'MANAGE_NICKNAMES';
  await assertPermission({ userId: actorId, serverId, permission });
  await runQuery(
    `UPDATE server_members SET nickname = ? WHERE server_id = ? AND user_id = ?`,
    [nickname || null, serverId, userId]
  );
  await writeAuditLog({
    serverId, userId: actorId, actionType: 'MEMBER_UPDATE',
    targetType: 'user', targetId: userId, changes: [{ key: 'nickname', new: nickname }]
  });
  return { success: true };
}

// --- bans --------------------------------------------------------------------

export async function listBans(serverId) {
  return allQuery(
    `SELECT b.*, u.username, u.display_name, u.avatar_url,
            mod.display_name AS moderator_name
       FROM bans b
       JOIN users u ON u.id = b.user_id
       LEFT JOIN users mod ON mod.id = b.moderator_id
      WHERE b.server_id = ? ORDER BY b.created_at DESC`,
    [serverId]
  );
}

export async function unban({ serverId, userId, actorId }) {
  await assertPermission({ userId: actorId, serverId, permission: 'BAN_MEMBERS' });
  await runQuery(`DELETE FROM bans WHERE server_id = ? AND user_id = ?`, [serverId, userId]);
  await writeAuditLog({
    serverId, userId: actorId, actionType: 'MEMBER_BAN_REMOVE',
    targetType: 'user', targetId: userId
  });
  return { success: true };
}

// --- invites -----------------------------------------------------------------

export async function listInvites(serverId) {
  return allQuery(
    `SELECT i.*, u.username AS inviter_name, u.avatar_url AS inviter_avatar,
            c.name AS channel_name
       FROM invites i
       LEFT JOIN users u ON u.id = i.inviter_id
       LEFT JOIN channels c ON c.id = i.channel_id
      WHERE i.server_id = ? AND i.revoked_at IS NULL
      ORDER BY i.created_at DESC`,
    [serverId]
  );
}

export async function revokeInvite({ serverId, code, actorId }) {
  await assertPermission({ userId: actorId, serverId, permission: 'MANAGE_GUILD' });
  await runQuery(
    `UPDATE invites SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE code = ? AND server_id = ?`,
    [code, serverId]
  );
  await writeAuditLog({
    serverId, userId: actorId, actionType: 'INVITE_DELETE',
    targetType: 'invite', targetId: code
  });
  return { success: true };
}

// --- emojis ------------------------------------------------------------------

const EMOJI_NAME = /^[a-zA-Z0-9_]{2,32}$/;

export async function listEmojis(serverId) {
  return allQuery(
    `SELECT e.*, u.display_name AS creator_name
       FROM emojis e LEFT JOIN users u ON u.id = e.creator_id
      WHERE e.server_id = ? ORDER BY e.name`,
    [serverId]
  );
}

export async function createEmoji({ serverId, actorId, name, fileId, url, animated = false }) {
  await assertPermission({ userId: actorId, serverId, permission: 'MANAGE_EMOJIS' });
  if (!EMOJI_NAME.test(name ?? '')) {
    throw new ApiError('ชื่ออีโมจิใช้ได้เฉพาะ a-z, 0-9 และ _ ยาว 2-32 ตัว', { code: 'INVALID_NAME' });
  }
  const clash = await getQuery(
    `SELECT 1 FROM emojis WHERE server_id = ? AND name = ?`, [serverId, name]
  );
  if (clash) throw ApiError.conflict('มีอีโมจิชื่อนี้อยู่แล้ว');

  const resolvedFile = fileId
    ? await getQuery(`SELECT * FROM files WHERE id = ?`, [fileId])
    : await findFileByPublicUrl(url);
  if (!resolvedFile && !url) throw new ApiError('ต้องมีรูปภาพ', { code: 'MISSING_IMAGE' });

  const id = generateId();
  await transaction(async () => {
    await runQuery(
      `INSERT INTO emojis (id, server_id, name, file_id, url, animated, creator_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, serverId, name, resolvedFile?.id ?? null, resolvedFile ? `/uploads/${resolvedFile.storage_key}` : url,
       animated || Boolean(resolvedFile?.is_animated) ? 1 : 0, actorId]
    );
    if (resolvedFile) await addReference(resolvedFile.id);
    await writeAuditLog({
      serverId, userId: actorId, actionType: 'EMOJI_CREATE',
      targetType: 'emoji', targetId: id, changes: [{ key: 'name', new: name }]
    });
  });
  return getQuery(`SELECT * FROM emojis WHERE id = ?`, [id]);
}

export async function deleteEmoji({ serverId, emojiId, actorId }) {
  await assertPermission({ userId: actorId, serverId, permission: 'MANAGE_EMOJIS' });
  const emoji = await getQuery(
    `SELECT * FROM emojis WHERE id = ? AND server_id = ?`, [emojiId, serverId]
  );
  if (!emoji) throw ApiError.notFound('Emoji');

  await transaction(async () => {
    await runQuery(`DELETE FROM emojis WHERE id = ?`, [emojiId]);
    if (emoji.file_id) await releaseReference(emoji.file_id);
    await writeAuditLog({
      serverId, userId: actorId, actionType: 'EMOJI_DELETE',
      targetType: 'emoji', targetId: emojiId, changes: [{ key: 'name', old: emoji.name }]
    });
  });
  return { success: true };
}

export { ALL_PERMISSIONS };
