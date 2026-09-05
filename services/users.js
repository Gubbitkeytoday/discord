// ============================================================================
//  User service — profiles, presence, friends, blocks, per-user settings.
// ============================================================================

import { runQuery, getQuery, allQuery, transaction } from '../db.js';
import { generateId } from '../lib/snowflake.js';
import { ApiError } from '../lib/httpUtils.js';
import {
  addReference, releaseReference, getStorageUsage, findFileByPublicUrl
} from '../storageService.js';
import { getCategory } from './userSettings.js';

const PUBLIC_COLUMNS = `
  id, username, discriminator, display_name, avatar_url, banner_url, accent_color,
  bio, pronouns, status, custom_status, custom_status_emoji, is_bot, created_at,
  profile_visibility
`;

export function listUsers() {
  return allQuery(
    `SELECT ${PUBLIC_COLUMNS} FROM users WHERE deleted_at IS NULL ORDER BY display_name`
  );
}

export async function getUser(userId, viewerId = null) {
  const user = await getQuery(
    `SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = ? AND deleted_at IS NULL`, [userId]
  );
  if (!user) throw ApiError.notFound('User');
  const mutualServers = await allQuery(
    `SELECT s.id, s.name, s.icon_url
       FROM server_members sm JOIN servers s ON s.id = sm.server_id
      WHERE sm.user_id = ? AND sm.left_at IS NULL AND s.deleted_at IS NULL`,
    [userId]
  );

  const shaped = { ...user, mutual_servers: mutualServers };

  // Private profile (Discord, Aug 2026): the bio and banner are what a
  // profile "shows", so those are what visibility hides. Name, avatar and
  // status stay — you have to be able to tell who you are talking to.
  if (viewerId && viewerId !== userId && !(await canSeeProfile(user, viewerId))) {
    shaped.bio = null;
    shaped.banner_url = null;
    shaped.pronouns = null;
    shaped.profile_hidden = true;
  }
  return shaped;
}

/**
 * Who may see a user's full profile.
 *   everyone — anyone
 *   mutual   — people who share a server (or are friends)
 *   friends  — accepted friends only
 */
async function canSeeProfile(user, viewerId) {
  const mode = user.profile_visibility ?? 'everyone';
  if (mode === 'everyone') return true;

  const friends = await getQuery(
    `SELECT 1 FROM friends WHERE status = 'accepted'
       AND ((user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?))`,
    [user.id, viewerId, viewerId, user.id]
  );
  if (friends) return true;
  if (mode === 'friends') return false;

  const shared = await getQuery(
    `SELECT 1 FROM server_members a JOIN server_members b ON a.server_id = b.server_id
      WHERE a.user_id = ? AND b.user_id = ? AND a.left_at IS NULL AND b.left_at IS NULL LIMIT 1`,
    [user.id, viewerId]
  );
  return Boolean(shared);
}

/* --- private notes ------------------------------------------------------------ */

const NOTE_MAX = 256;

/** The note this viewer wrote about someone. Nobody else can ever read it. */
export async function getNote({ authorId, subjectId }) {
  const row = await getQuery(
    `SELECT note, updated_at FROM user_notes WHERE author_id = ? AND subject_id = ?`,
    [authorId, subjectId]
  );
  return row ?? { note: '', updated_at: null };
}

export async function setNote({ authorId, subjectId, note }) {
  const text = String(note ?? '').trim().slice(0, NOTE_MAX);
  if (authorId === subjectId) {
    throw new ApiError('You cannot leave a note on yourself', { code: 'NOTE_SELF' });
  }
  if (!text) {
    await runQuery(`DELETE FROM user_notes WHERE author_id = ? AND subject_id = ?`, [authorId, subjectId]);
    return { note: '', updated_at: null };
  }
  await runQuery(
    `INSERT INTO user_notes (author_id, subject_id, note, updated_at)
     VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(author_id, subject_id) DO UPDATE SET
       note = excluded.note, updated_at = excluded.updated_at`,
    [authorId, subjectId, text]
  );
  return getNote({ authorId, subjectId });
}

/**
 * Patch a profile. Only listed fields are writable, and avatar/banner file
 * references are counted so replacing an avatar releases the old file.
 */
export async function updateProfile({ userId, patch }) {
  const current = await getQuery(`SELECT * FROM users WHERE id = ? AND deleted_at IS NULL`, [userId]);
  if (!current) throw ApiError.notFound('User');

  const writable = [
    'display_name', 'bio', 'pronouns', 'status', 'custom_status', 'custom_status_emoji',
    'avatar_url', 'banner_url', 'accent_color', 'theme', 'locale',
    'avatar_file_id', 'banner_file_id', 'profile_visibility'
  ];
  if (patch.profile_visibility !== undefined
      && !['everyone', 'mutual', 'friends'].includes(patch.profile_visibility)) {
    throw new ApiError('profile_visibility must be everyone, mutual or friends',
      { code: 'INVALID_VISIBILITY' });
  }

  // Clients send the URL they got back from an upload, not the file id. Resolve
  // it so the file gets a reference and survives garbage collection.
  const resolved = { ...patch };
  for (const [urlField, idField] of [['avatar_url', 'avatar_file_id'], ['banner_url', 'banner_file_id']]) {
    if (resolved[urlField] === undefined || resolved[idField] !== undefined) continue;
    const file = await findFileByPublicUrl(resolved[urlField]);
    if (file) resolved[idField] = file.id;
  }

  const sets = [];
  const params = [];
  for (const key of writable) {
    if (resolved[key] === undefined) continue;
    sets.push(`${key} = ?`);
    params.push(resolved[key]);
  }
  if (!sets.length) return getUser(userId);

  sets.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
  params.push(userId);

  await transaction(async () => {
    await runQuery(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);

    // Keep file ref counts honest across avatar/banner swaps.
    for (const field of ['avatar_file_id', 'banner_file_id']) {
      if (resolved[field] === undefined) continue;
      if (current[field] === resolved[field]) continue;
      if (current[field]) await releaseReference(current[field]);
      if (resolved[field]) await addReference(resolved[field]);
    }
  });

  return getUser(userId);
}

export async function setPresence({ userId, status, customStatus = undefined }) {
  const valid = ['online', 'idle', 'dnd', 'offline', 'invisible'];
  if (!valid.includes(status)) {
    throw new ApiError(`Invalid status '${status}'`, { code: 'INVALID_STATUS' });
  }
  const sets = [`status = ?`, `presence_updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`];
  const params = [status];
  if (customStatus !== undefined) { sets.push('custom_status = ?'); params.push(customStatus); }
  params.push(userId);
  await runQuery(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);
  return getQuery(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = ?`, [userId]);
}

export async function touchLastSeen(userId) {
  await runQuery(
    `UPDATE users SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`, [userId]
  );
}

// --- friends -----------------------------------------------------------------

export async function sendFriendRequest({ userId, targetUsername = null, targetId = null, note = null }) {
  const target = targetId
    ? await getQuery(`SELECT id FROM users WHERE id = ? AND deleted_at IS NULL`, [targetId])
    : await getQuery(`SELECT id FROM users WHERE username = ? AND deleted_at IS NULL`, [targetUsername]);

  if (!target) throw ApiError.notFound('User');
  if (target.id === userId) throw new ApiError('You cannot add yourself', { code: 'INVALID_TARGET' });

  const blocked = await getQuery(
    `SELECT 1 FROM blocks WHERE user_id = ? AND blocked_id = ?`, [target.id, userId]
  );
  if (blocked) throw ApiError.forbidden('Cannot send a request to this user');

  // Privacy & Safety › who can send you a friend request. Enforced here rather
  // than in the client, so the setting means something.
  await assertCanFriendRequest({ senderId: userId, targetId: target.id });

  // Check both directions — an incoming request should be accepted, not duplicated.
  const existing = await getQuery(
    `SELECT * FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)`,
    [userId, target.id, target.id, userId]
  );
  if (existing) {
    if (existing.status === 'accepted') throw ApiError.conflict('Already friends');
    if (existing.user_id === target.id && existing.status === 'pending') {
      return acceptFriendRequest({ userId, requestId: existing.id });
    }
    throw ApiError.conflict('A friend request is already pending');
  }

  const id = generateId();
  // A short line so the recipient knows who this is — "we met at the LAN".
  const cleanNote = note ? String(note).trim().slice(0, 200) : null;
  await runQuery(
    `INSERT INTO friends (id, user_id, friend_id, status, requested_by, note)
     VALUES (?, ?, ?, 'pending', ?, ?)`,
    [id, userId, target.id, userId, cleanNote || null]
  );
  return getQuery(`SELECT * FROM friends WHERE id = ?`, [id]);
}

/**
 * The recipient's "who can add you as a friend" setting.
 *   everyone            — anyone may ask
 *   friends_of_friends  — only someone you already share a friend with
 *   none                — nobody
 * A shared server also counts, matching Discord's default.
 */
async function assertCanFriendRequest({ senderId, targetId }) {
  const privacy = await getCategory(targetId, 'privacy');
  if (privacy.friendRequests === 'none') {
    throw ApiError.forbidden('This user is not accepting friend requests');
  }
  if (privacy.friendRequests === 'everyone') return;

  const mutualFriend = await getQuery(
    `SELECT 1 FROM friends a JOIN friends b ON (
        (a.user_id = ? AND b.user_id = ? AND a.friend_id = b.friend_id)
     OR (a.user_id = ? AND b.friend_id = ? AND a.friend_id = b.user_id)
     OR (a.friend_id = ? AND b.user_id = ? AND a.user_id = b.friend_id)
     OR (a.friend_id = ? AND b.friend_id = ? AND a.user_id = b.user_id))
      WHERE a.status = 'accepted' AND b.status = 'accepted' LIMIT 1`,
    [senderId, targetId, senderId, targetId, senderId, targetId, senderId, targetId]
  );
  if (mutualFriend) return;

  const sharedServer = await getQuery(
    `SELECT 1 FROM server_members a
       JOIN server_members b ON a.server_id = b.server_id
      WHERE a.user_id = ? AND b.user_id = ? AND a.left_at IS NULL AND b.left_at IS NULL
      LIMIT 1`,
    [senderId, targetId]
  );
  if (sharedServer) return;

  throw ApiError.forbidden('This user only accepts requests from people they have a friend in common with');
}

/**
 * The recipient's "who can send you a direct message" setting.
 * Friends always get through; otherwise a shared server may be required.
 */
export async function assertCanDirectMessage({ senderId, recipientId }) {
  if (senderId === recipientId) return;
  const privacy = await getCategory(recipientId, 'privacy');

  const friends = await getQuery(
    `SELECT 1 FROM friends
      WHERE status = 'accepted'
        AND ((user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?))`,
    [senderId, recipientId, recipientId, senderId]
  );
  if (friends) return;

  if (privacy.allowDmsFrom === 'friends') {
    throw ApiError.forbidden('This user only accepts direct messages from friends');
  }

  if (!privacy.allowServerMemberDms) {
    throw ApiError.forbidden('This user does not accept direct messages from server members');
  }

  const sharedServer = await getQuery(
    `SELECT 1 FROM server_members a
       JOIN server_members b ON a.server_id = b.server_id
      WHERE a.user_id = ? AND b.user_id = ? AND a.left_at IS NULL AND b.left_at IS NULL
      LIMIT 1`,
    [senderId, recipientId]
  );
  if (!sharedServer) {
    throw ApiError.forbidden('You can only message people you share a server with');
  }
}

export async function acceptFriendRequest({ userId, requestId }) {
  const request = await getQuery(`SELECT * FROM friends WHERE id = ?`, [requestId]);
  if (!request) throw ApiError.notFound('Friend request');
  if (request.status === 'accepted') return request;
  // Only the person who received it may accept — otherwise the sender could
  // befriend anyone unilaterally by accepting their own outgoing request.
  const recipientId = request.requested_by === request.user_id ? request.friend_id : request.user_id;
  if (recipientId !== userId) {
    throw ApiError.forbidden('Only the recipient can accept this request');
  }
  await runQuery(
    `UPDATE friends SET status = 'accepted', accepted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`,
    [requestId]
  );
  return getQuery(`SELECT * FROM friends WHERE id = ?`, [requestId]);
}

export async function removeFriend({ userId, otherId }) {
  await runQuery(
    `DELETE FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)`,
    [userId, otherId, otherId, userId]
  );
  return { success: true };
}

export async function blockUser({ userId, targetId }) {
  await transaction(async () => {
    await runQuery(
      `INSERT OR IGNORE INTO blocks (user_id, blocked_id) VALUES (?, ?)`, [userId, targetId]
    );
    await runQuery(
      `DELETE FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)`,
      [userId, targetId, targetId, userId]
    );
  });
  return { success: true };
}

export async function unblockUser({ userId, targetId }) {
  await runQuery(`DELETE FROM blocks WHERE user_id = ? AND blocked_id = ?`, [userId, targetId]);
  return { success: true };
}

export function listBlocked(userId) {
  return allQuery(
    `SELECT u.id, u.username, u.display_name, u.avatar_url
       FROM blocks b JOIN users u ON u.id = b.blocked_id
      WHERE b.user_id = ?`,
    [userId]
  );
}

// --- settings ----------------------------------------------------------------

export async function updateChannelSettings({ userId, channelId, patch }) {
  await runQuery(
    `INSERT INTO channel_settings (user_id, channel_id, muted, muted_until, notification_level, collapsed)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, channel_id) DO UPDATE SET
       muted = COALESCE(excluded.muted, channel_settings.muted),
       muted_until = excluded.muted_until,
       notification_level = COALESCE(excluded.notification_level, channel_settings.notification_level),
       collapsed = COALESCE(excluded.collapsed, channel_settings.collapsed)`,
    [userId, channelId, patch.muted ? 1 : 0, patch.mutedUntil ?? null,
     patch.notificationLevel ?? 'inherit', patch.collapsed ? 1 : 0]
  );
  return getQuery(
    `SELECT * FROM channel_settings WHERE user_id = ? AND channel_id = ?`, [userId, channelId]
  );
}

export async function updateServerSettings({ userId, serverId, patch }) {
  await runQuery(
    `INSERT INTO server_settings (user_id, server_id, muted, notification_level, position, hidden)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, server_id) DO UPDATE SET
       muted = COALESCE(excluded.muted, server_settings.muted),
       notification_level = COALESCE(excluded.notification_level, server_settings.notification_level),
       position = COALESCE(excluded.position, server_settings.position),
       hidden = COALESCE(excluded.hidden, server_settings.hidden)`,
    [userId, serverId, patch.muted ? 1 : 0, patch.notificationLevel ?? 'all_messages',
     patch.position ?? 0, patch.hidden ? 1 : 0]
  );
  return getQuery(
    `SELECT * FROM server_settings WHERE user_id = ? AND server_id = ?`, [userId, serverId]
  );
}

export { getStorageUsage };
