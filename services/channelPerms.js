// ============================================================================
//  Channel permission overwrites, stickers and soundboard sounds.
// ============================================================================

import { runQuery, getQuery, allQuery, transaction } from '../db.js';
import { generateId } from '../lib/snowflake.js';
import { ApiError } from '../lib/httpUtils.js';
import { toBigInt } from '../lib/permissions.js';
import { assertPermission, resolvePermissions, writeAuditLog } from './guilds.js';
import { addReference, releaseReference, findFileByPublicUrl } from '../storageService.js';

// --- channel overwrites ------------------------------------------------------

export async function listOverwrites(channelId) {
  const rows = await allQuery(
    `SELECT o.*,
            r.name AS role_name, r.color AS role_color,
            u.username, u.display_name, u.avatar_url
       FROM channel_overwrites o
       LEFT JOIN roles r ON o.target_type = 'role' AND r.id = o.target_id
       LEFT JOIN users u ON o.target_type = 'member' AND u.id = o.target_id
      WHERE o.channel_id = ?`,
    [channelId]
  );
  return rows;
}

/**
 * Upsert one overwrite.
 *
 * Same hierarchy rule as role editing: you cannot allow a permission you do not
 * hold yourself, or MANAGE_ROLES on a single channel becomes a way to grant
 * yourself anything.
 */
export async function setOverwrite({
  channelId, actorId, targetType, targetId, allow = '0', deny = '0'
}) {
  if (!['role', 'member'].includes(targetType)) {
    throw new ApiError("target_type ต้องเป็น 'role' หรือ 'member'", { code: 'INVALID_TARGET' });
  }

  const channel = await getQuery(
    `SELECT id, server_id FROM channels WHERE id = ? AND deleted_at IS NULL`, [channelId]
  );
  if (!channel) throw ApiError.notFound('Channel');
  if (!channel.server_id) throw ApiError.conflict('ตั้งค่าสิทธิ์ได้เฉพาะห้องในเซิร์ฟเวอร์');

  const actor = await assertPermission({
    userId: actorId, serverId: channel.server_id, permission: 'MANAGE_ROLES'
  });

  if (!actor.isOwner) {
    const granting = (toBigInt(allow) | toBigInt(deny)) & ~toBigInt(actor.permissions);
    if (granting !== 0n) {
      throw ApiError.forbidden('คุณไม่สามารถกำหนดสิทธิ์ที่ตัวเองไม่มี');
    }
  }

  // An overwrite that allows and denies nothing is noise; remove it instead.
  if (toBigInt(allow) === 0n && toBigInt(deny) === 0n) {
    return deleteOverwrite({ channelId, actorId, targetType, targetId });
  }

  await runQuery(
    `INSERT INTO channel_overwrites (channel_id, target_type, target_id, allow, deny)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(channel_id, target_type, target_id)
     DO UPDATE SET allow = excluded.allow, deny = excluded.deny`,
    [channelId, targetType, targetId, String(allow), String(deny)]
  );

  await writeAuditLog({
    serverId: channel.server_id, userId: actorId, actionType: 'CHANNEL_OVERWRITE_UPDATE',
    targetType: 'channel', targetId: channelId,
    changes: [{ key: `${targetType}:${targetId}`, new: `allow=${allow} deny=${deny}` }]
  });

  return listOverwrites(channelId);
}

export async function deleteOverwrite({ channelId, actorId, targetType, targetId }) {
  const channel = await getQuery(`SELECT server_id FROM channels WHERE id = ?`, [channelId]);
  if (!channel) throw ApiError.notFound('Channel');
  await assertPermission({
    userId: actorId, serverId: channel.server_id, permission: 'MANAGE_ROLES'
  });

  await runQuery(
    `DELETE FROM channel_overwrites WHERE channel_id = ? AND target_type = ? AND target_id = ?`,
    [channelId, targetType, targetId]
  );
  await writeAuditLog({
    serverId: channel.server_id, userId: actorId, actionType: 'CHANNEL_OVERWRITE_DELETE',
    targetType: 'channel', targetId: channelId,
    changes: [{ key: `${targetType}:${targetId}`, old: 'overwrite' }]
  });
  return listOverwrites(channelId);
}

/** What a specific member can actually do in a specific channel. */
export async function effectivePermissions({ channelId, userId }) {
  const channel = await getQuery(`SELECT server_id FROM channels WHERE id = ?`, [channelId]);
  if (!channel) throw ApiError.notFound('Channel');
  return resolvePermissions({ userId, serverId: channel.server_id, channelId });
}

// --- stickers ----------------------------------------------------------------

const STICKER_FORMATS = ['png', 'apng', 'lottie', 'gif'];

export async function listStickers(serverId) {
  return allQuery(
    `SELECT s.*, u.display_name AS creator_name
       FROM stickers s LEFT JOIN users u ON u.id = s.creator_id
      WHERE s.server_id = ? AND s.available = 1 ORDER BY s.name`,
    [serverId]
  );
}

export async function createSticker({
  serverId, actorId, name, description = null, tags = null, fileId = null, url = null, format = 'png'
}) {
  await assertPermission({ userId: actorId, serverId, permission: 'MANAGE_EMOJIS' });

  const trimmed = String(name ?? '').trim();
  if (trimmed.length < 2 || trimmed.length > 30) {
    throw new ApiError('ชื่อสติกเกอร์ต้องยาว 2-30 ตัวอักษร', { code: 'INVALID_NAME' });
  }
  if (!STICKER_FORMATS.includes(format)) {
    throw new ApiError(`format ต้องเป็นหนึ่งใน ${STICKER_FORMATS.join(', ')}`, { code: 'INVALID_FORMAT' });
  }

  const file = fileId
    ? await getQuery(`SELECT * FROM files WHERE id = ?`, [fileId])
    : await findFileByPublicUrl(url);
  if (!file && !url) throw new ApiError('ต้องมีรูปภาพ', { code: 'MISSING_IMAGE' });

  const id = generateId();
  await transaction(async () => {
    await runQuery(
      `INSERT INTO stickers (id, server_id, name, description, tags, file_id, url, format, creator_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, serverId, trimmed, description, tags, file?.id ?? null,
       file ? `/uploads/${file.storage_key}` : url, format, actorId]
    );
    if (file) await addReference(file.id);
    await writeAuditLog({
      serverId, userId: actorId, actionType: 'STICKER_CREATE',
      targetType: 'sticker', targetId: id, changes: [{ key: 'name', new: trimmed }]
    });
  });
  return getQuery(`SELECT * FROM stickers WHERE id = ?`, [id]);
}

export async function deleteSticker({ serverId, stickerId, actorId }) {
  await assertPermission({ userId: actorId, serverId, permission: 'MANAGE_EMOJIS' });
  const sticker = await getQuery(
    `SELECT * FROM stickers WHERE id = ? AND server_id = ?`, [stickerId, serverId]
  );
  if (!sticker) throw ApiError.notFound('Sticker');

  await transaction(async () => {
    await runQuery(`DELETE FROM stickers WHERE id = ?`, [stickerId]);
    if (sticker.file_id) await releaseReference(sticker.file_id);
    await writeAuditLog({
      serverId, userId: actorId, actionType: 'STICKER_DELETE',
      targetType: 'sticker', targetId: stickerId, changes: [{ key: 'name', old: sticker.name }]
    });
  });
  return { success: true };
}

// --- soundboard --------------------------------------------------------------

export async function listSounds(serverId) {
  return allQuery(
    `SELECT s.*, u.display_name AS creator_name
       FROM soundboard_sounds s LEFT JOIN users u ON u.id = s.creator_id
      WHERE s.server_id = ? ORDER BY s.name`,
    [serverId]
  );
}

export async function createSound({
  serverId, actorId, name, fileId = null, url = null, emoji = null, volume = 1
}) {
  await assertPermission({ userId: actorId, serverId, permission: 'MANAGE_EMOJIS' });

  const trimmed = String(name ?? '').trim();
  if (trimmed.length < 2 || trimmed.length > 32) {
    throw new ApiError('ชื่อเสียงต้องยาว 2-32 ตัวอักษร', { code: 'INVALID_NAME' });
  }

  const file = fileId
    ? await getQuery(`SELECT * FROM files WHERE id = ?`, [fileId])
    : await findFileByPublicUrl(url);
  if (!file && !url) throw new ApiError('ต้องมีไฟล์เสียง', { code: 'MISSING_AUDIO' });
  if (file && !file.mime_type.startsWith('audio/')) {
    throw new ApiError('ไฟล์ต้องเป็นเสียง', { code: 'NOT_AUDIO' });
  }

  const id = generateId();
  await transaction(async () => {
    await runQuery(
      `INSERT INTO soundboard_sounds (id, server_id, name, file_id, url, volume, emoji, creator_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, serverId, trimmed, file?.id ?? null,
       file ? `/uploads/${file.storage_key}` : url,
       Math.min(2, Math.max(0, Number(volume) || 1)), emoji, actorId]
    );
    if (file) await addReference(file.id);
  });
  return getQuery(`SELECT * FROM soundboard_sounds WHERE id = ?`, [id]);
}

export async function deleteSound({ serverId, soundId, actorId }) {
  await assertPermission({ userId: actorId, serverId, permission: 'MANAGE_EMOJIS' });
  const sound = await getQuery(
    `SELECT * FROM soundboard_sounds WHERE id = ? AND server_id = ?`, [soundId, serverId]
  );
  if (!sound) throw ApiError.notFound('Sound');
  await transaction(async () => {
    await runQuery(`DELETE FROM soundboard_sounds WHERE id = ?`, [soundId]);
    if (sound.file_id) await releaseReference(sound.file_id);
  });
  return { success: true };
}
