// ============================================================================
//  User service — profiles, presence, friends, blocks, per-user settings.
// ============================================================================

import { runQuery, getQuery, allQuery, transaction, sql } from '../db.js';
import { generateId } from '../lib/snowflake.js';
import { ApiError } from '../lib/httpUtils.js';
import { normaliseColor } from '../lib/validate.js';
import { proxiedImageUrl } from '../lib/mediaUrls.js';
import {
  addReference, releaseReference, getStorageUsage, findFileByPublicUrl
} from '../storageService.js';
import {
  getCategory, getAgeGroup, checkBirthdate, applyMinorDefaults, ageGroupOf
} from './userSettings.js';
import { publicStatus } from '../lib/presence.js';
import { forgetAgeGroup } from './access.js';
import {
  LIMITS as PROFILE_LIMITS, cleanBio, cleanStatusEmoji, checkIdentityText, assertNotReservedName,
  maskExpiredStatus
} from './profiles.js';

/**
 * The one refusal for "you cannot reach this person": blocked, DMs limited to
 * friends, friend requests off, no shared server. Every reason answers with
 * the same status, code and words, so a harasser cannot compare two refusals
 * to find out that he was blocked rather than filtered by a privacy setting.
 */
export function unreachable() {
  return new ApiError("This person isn't accepting messages or requests from you right now.",
    { status: 403, code: 'USER_UNREACHABLE' });
}

const PUBLIC_COLUMNS = `
  id, username, discriminator, display_name, avatar_url, banner_url, accent_color,
  bio, pronouns, status, custom_status, custom_status_emoji, custom_status_expires_at, is_bot, created_at,
  profile_visibility
`;

/**
 * The people `viewerId` can legitimately know about: themselves, anyone who
 * shares a server with them, anyone in a DM or group DM with them, and anyone
 * in a friend relationship (including pending requests) with them. Never the
 * whole instance — that would let any single account scrape every member and
 * track everyone's presence.
 */
export function listUsers(viewerId) {
  if (!viewerId) return Promise.resolve([]);
  return allQuery(
    `SELECT ${PUBLIC_COLUMNS} FROM users u
      WHERE u.deleted_at IS NULL
        AND (
          u.id = ?
          OR u.id IN (
            SELECT them.user_id FROM server_members them
              JOIN server_members me ON me.server_id = them.server_id
             WHERE me.user_id = ? AND me.left_at IS NULL AND them.left_at IS NULL)
          OR u.id IN (
            SELECT them.user_id FROM channel_recipients them
              JOIN channel_recipients me ON me.channel_id = them.channel_id
             WHERE me.user_id = ?)
          OR u.id IN (SELECT friend_id FROM friends WHERE user_id = ?)
          OR u.id IN (SELECT user_id FROM friends WHERE friend_id = ?)
        )
      ORDER BY u.display_name`,
    [viewerId, viewerId, viewerId, viewerId, viewerId]
  // An expired custom status is hidden on read, not only once the sweeper
  // has cleared it (it runs every 30 s).
  ).then((rows) => rows.map(maskExpiredStatus));
}

export async function getUser(userId, viewerId = null) {
  const user = await getQuery(
    `SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = ? AND deleted_at IS NULL`, [userId]
  );
  if (!user) throw ApiError.notFound('User');
  // "Mutual" means shared with the viewer. Listing every server the target
  // is in would disclose private servers to anyone who can look them up.
  const mutualServers = !viewerId || viewerId === userId
    ? await allQuery(
        `SELECT s.id, s.name, s.icon_url
           FROM server_members sm JOIN servers s ON s.id = sm.server_id
          WHERE sm.user_id = ? AND sm.left_at IS NULL AND s.deleted_at IS NULL`,
        [userId]
      )
    : await allQuery(
        `SELECT s.id, s.name, s.icon_url
           FROM server_members sm
           JOIN server_members me ON me.server_id = sm.server_id AND me.user_id = ? AND me.left_at IS NULL
           JOIN servers s ON s.id = sm.server_id
          WHERE sm.user_id = ? AND sm.left_at IS NULL AND s.deleted_at IS NULL`,
        [viewerId, userId]
      );

  // SQLite has no boolean type; normalise on the way out so the wire shape is
  // the same here as it is on a message.
  // An expired custom status is hidden even before the sweeper clears it.
  const shaped = { ...maskExpiredStatus(user), is_bot: Boolean(user.is_bot), mutual_servers: mutualServers };
  // "Invisible" is only ever revealed to its owner, and a payload built
  // without a viewer (a broadcast) is for everyone else.
  shaped.status = publicStatus(shaped.status, viewerId, userId);

  // Private profile (Discord, Aug 2026): the bio and banner are what a
  // profile "shows", so those are what visibility hides. Name, avatar and
  // status stay — you have to be able to tell who you are talking to.
  if (viewerId && viewerId !== userId && !(await canViewProfile(user, viewerId))) {
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
export async function canViewProfile(user, viewerId) {
  const mode = user.profile_visibility ?? 'everyone';
  if (mode === 'everyone') return true;
  if (!viewerId) return false;
  if (viewerId === user.id) return true;

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
     VALUES (?, ?, ?, ${sql.now})
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
    'avatar_file_id', 'banner_file_id', 'profile_visibility', 'custom_status_expires_at'
  ];
  if (patch.profile_visibility !== undefined
      && !['everyone', 'mutual', 'friends'].includes(patch.profile_visibility)) {
    throw new ApiError('profile_visibility must be everyone, mutual or friends',
      { code: 'INVALID_VISIBILITY' });
  }

  // Clients send the URL they got back from an upload, not the file id. Resolve
  // it so the file gets a reference and survives garbage collection.
  // Discord's limits; unbounded text here ends up in every member list,
  // message header and broadcast.
  const LIMITS = {
    display_name: PROFILE_LIMITS.display_name, bio: PROFILE_LIMITS.bio, pronouns: PROFILE_LIMITS.pronouns,
    custom_status: PROFILE_LIMITS.custom_status, locale: 16, theme: 32
  };
  for (const [field, max] of Object.entries(LIMITS)) {
    if (patch[field] === undefined || patch[field] === null) continue;
    if (typeof patch[field] !== 'string' || patch[field].length > max) {
      throw new ApiError(`${field} must be text of at most ${max} characters`, { code: 'INVALID_FIELD' });
    }
  }
  if (patch.status !== undefined
      && !['online', 'idle', 'dnd', 'offline', 'invisible'].includes(patch.status)) {
    throw new ApiError(`Invalid status '${patch.status}'`, { code: 'INVALID_STATUS' });
  }
  for (const field of ['avatar_url', 'banner_url']) {
    const value = patch[field];
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string' || value.length > 2048
        || !(value.startsWith('/') || /^https?:\/\//i.test(value))) {
      throw new ApiError(`${field} must be an http(s) or same-origin URL`, { code: 'INVALID_URL' });
    }
  }

  const resolved = { ...patch };
  // Bio markdown is rendered from a safe subset; the stored text is cleaned
  // (no bidi overrides or control characters, http(s)-only masked links).
  if (typeof patch.bio === 'string') resolved.bio = cleanBio(patch.bio) || null;
  if (patch.custom_status_emoji !== undefined) resolved.custom_status_emoji = cleanStatusEmoji(patch.custom_status_emoji);
  // A status typed here has no "clear after"; the status menu sets one.
  delete resolved.custom_status_expires_at;
  if (patch.custom_status !== undefined) resolved.custom_status_expires_at = null;
  // What others see is checked with AutoMod's normalisation before it is saved.
  await checkIdentityText({
    display_name: patch.display_name, bio: resolved.bio, pronouns: patch.pronouns, custom_status: patch.custom_status
  });
  if (typeof patch.display_name === 'string' && patch.display_name !== current.display_name) {
    await assertNotReservedName('display_name', patch.display_name, userId);
  }
  if (patch.accent_color !== undefined) resolved.accent_color = normaliseColor(patch.accent_color, 'accent_color');
  // A remote avatar/banner is stored as its same-origin proxy URL, so viewers'
  // browsers never contact the third-party host (see services/mediaProxy.js).
  for (const field of ['avatar_url', 'banner_url']) {
    if (typeof resolved[field] === 'string') resolved[field] = proxiedImageUrl(resolved[field]);
  }
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
  if (!sets.length) return getUser(userId, userId);

  sets.push(`updated_at = ${sql.now}`);
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

  return getUser(userId, userId);
}

export async function setPresence({ userId, status, customStatus = undefined }) {
  const valid = ['online', 'idle', 'dnd', 'offline', 'invisible'];
  if (!valid.includes(status)) {
    throw new ApiError(`Invalid status '${status}'`, { code: 'INVALID_STATUS' });
  }
  const sets = [`status = ?`, `presence_updated_at = ${sql.now}`];
  const params = [status];
  if (typeof customStatus === 'string') {
    if (customStatus.length > PROFILE_LIMITS.custom_status) {
      throw new ApiError(`custom_status must be at most ${PROFILE_LIMITS.custom_status} characters`, { code: 'INVALID_FIELD' });
    }
    await checkIdentityText({ custom_status: customStatus });
  }
  if (customStatus !== undefined) {
    // A status set this way (socket, /status) never expires by itself.
    sets.push('custom_status = ?', 'custom_status_expires_at = NULL');
    params.push(customStatus);
  }
  params.push(userId);
  await runQuery(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`, params);
  return getQuery(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = ?`, [userId]);
}

export async function touchLastSeen(userId) {
  await runQuery(
    `UPDATE users SET last_seen_at = ${sql.now} WHERE id = ?`, [userId]
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
  if (blocked) throw unreachable();

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
  if (privacy.friendRequests === 'none') throw unreachable();
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
  // For a teen, "friends of friends" means exactly that: sharing a big public
  // server with a stranger is not an introduction.
  if (sharedServer && (await getAgeGroup(targetId)) !== 'minor') return;

  throw unreachable();
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

  if (privacy.allowDmsFrom === 'friends') throw unreachable();
  if (!privacy.allowServerMemberDms) throw unreachable();

  const sharedServer = await getQuery(
    `SELECT 1 FROM server_members a
       JOIN server_members b ON a.server_id = b.server_id
      WHERE a.user_id = ? AND b.user_id = ? AND a.left_at IS NULL AND b.left_at IS NULL
      LIMIT 1`,
    [senderId, recipientId]
  );
  if (!sharedServer) throw unreachable();
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
    `UPDATE friends SET status = 'accepted', accepted_at = ${sql.now}
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
      `INSERT INTO blocks (user_id, blocked_id) VALUES (?, ?) ON CONFLICT DO NOTHING`, [userId, targetId]
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
  // Stored as a timestamp and compared against "now", so it must be a real
  // instant — normalised to ISO so both database engines store the same thing.
  let mutedUntil = null;
  if (patch.mutedUntil !== undefined && patch.mutedUntil !== null && patch.mutedUntil !== '') {
    const at = new Date(patch.mutedUntil);
    if (Number.isNaN(at.getTime())) {
      throw new ApiError('mutedUntil must be a valid date', { code: 'INVALID_MUTED_UNTIL' });
    }
    mutedUntil = at.toISOString();
  }
  await runQuery(
    `INSERT INTO channel_settings (user_id, channel_id, muted, muted_until, notification_level, collapsed)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, channel_id) DO UPDATE SET
       muted = COALESCE(excluded.muted, channel_settings.muted),
       muted_until = excluded.muted_until,
       notification_level = COALESCE(excluded.notification_level, channel_settings.notification_level),
       collapsed = COALESCE(excluded.collapsed, channel_settings.collapsed)`,
    [userId, channelId, patch.muted ? 1 : 0, mutedUntil,
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

// ============================================================================
//  Message requests.
//
//  A 1:1 DM from someone who is not your friend waits in "Message requests"
//  until you accept it (or reply, which is the same decision). Nothing is
//  stored for the pending state: a DM is a request for `userId` while
//    - the privacy setting `messageRequests` is on,
//    - the other person is not an accepted friend,
//    - `userId` has not answered in it and has not accepted / ignored it
//      (dm_requests), and
//    - the other person has actually said something.
// ============================================================================

const REQUEST_PREVIEW_CHARS = 200;

function pendingRequestRows(userId, channelId = null) {
  return allQuery(
    `SELECT c.id AS channel_id, other.user_id AS other_id
       FROM channels c
       JOIN channel_recipients me ON me.channel_id = c.id AND me.user_id = ?
       JOIN channel_recipients other ON other.channel_id = c.id AND other.user_id <> ?
      WHERE c.type = 'dm' AND c.deleted_at IS NULL AND me.closed = 0
        AND NOT EXISTS (SELECT 1 FROM dm_requests d WHERE d.user_id = ? AND d.channel_id = c.id)
        AND NOT EXISTS (SELECT 1 FROM friends f WHERE f.status = 'accepted'
                          AND ((f.user_id = ? AND f.friend_id = other.user_id)
                            OR (f.friend_id = ? AND f.user_id = other.user_id)))
        AND NOT EXISTS (SELECT 1 FROM blocks b WHERE b.user_id = ? AND b.blocked_id = other.user_id)
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.channel_id = c.id AND m.user_id = ?)
        AND EXISTS (SELECT 1 FROM messages m WHERE m.channel_id = c.id AND m.user_id = other.user_id
                      AND m.deleted_at IS NULL)${channelId ? ' AND c.id = ?' : ''}`,
    [userId, userId, userId, userId, userId, userId, userId, ...(channelId ? [channelId] : [])]
  );
}

/** The viewer's pending message requests, newest first, with a short preview. */
export async function listMessageRequests(userId) {
  const privacy = await getCategory(userId, 'privacy');
  if (!privacy.messageRequests) return { enabled: false, blur_previews: false, requests: [] };
  const rows = await pendingRequestRows(userId);
  const requests = [];
  for (const row of rows) {
    const [user, last, count, shared] = await Promise.all([
      getQuery(`SELECT id, username, display_name, avatar_url, created_at FROM users WHERE id = ?`, [row.other_id]),
      getQuery(
        `SELECT id, content, created_at FROM messages
          WHERE channel_id = ? AND deleted_at IS NULL ORDER BY id DESC LIMIT 1`, [row.channel_id]),
      getQuery(`SELECT count(*) AS n FROM messages WHERE channel_id = ? AND deleted_at IS NULL`, [row.channel_id]),
      getQuery(
        `SELECT count(*) AS n FROM server_members a JOIN server_members b ON a.server_id = b.server_id
          WHERE a.user_id = ? AND b.user_id = ? AND a.left_at IS NULL AND b.left_at IS NULL`,
        [userId, row.other_id])
    ]);
    if (!user) continue;
    requests.push({
      channel_id: row.channel_id,
      user,
      mutual_server_count: Number(shared?.n ?? 0),
      message_count: Number(count?.n ?? 0),
      last_message: last
        ? { id: last.id, content: String(last.content ?? '').slice(0, REQUEST_PREVIEW_CHARS), created_at: last.created_at }
        : null
    });
  }
  // Snowflake ids sort by time once they are the same length.
  const key = (r) => String(r.last_message?.id ?? '').padStart(24, '0');
  requests.sort((a, b) => key(b).localeCompare(key(a)));
  // Previews of a stranger's words are blurred for teens until tapped.
  return { enabled: true, blur_previews: (await getAgeGroup(userId)) === 'minor', requests };
}

/** Channel ids that are pending requests for `userId` (for list filtering). */
export async function pendingRequestChannelIds(userId) {
  const privacy = await getCategory(userId, 'privacy');
  if (!privacy.messageRequests) return [];
  return (await pendingRequestRows(userId)).map((r) => r.channel_id);
}

/**
 * Of `userIds` (recipients of 1:1 DM `channelId`), those for whom it is still a
 * pending message request — they get the unread, but no ping or push.
 */
export async function pendingRequestRecipients(channelId, userIds) {
  const out = new Set();
  for (const uid of userIds) {
    const privacy = await getCategory(uid, 'privacy');
    if (!privacy.messageRequests) continue;
    if ((await pendingRequestRows(uid, channelId)).length) out.add(uid);
  }
  return out;
}

async function assertDmRecipient(userId, channelId) {
  const row = await getQuery(
    `SELECT c.type FROM channels c JOIN channel_recipients cr ON cr.channel_id = c.id AND cr.user_id = ?
      WHERE c.id = ? AND c.deleted_at IS NULL`,
    [userId, channelId]
  );
  if (!row || row.type !== 'dm') throw ApiError.notFound('Message request');
}

async function setRequestState(userId, channelId, state) {
  await runQuery(
    `INSERT INTO dm_requests (user_id, channel_id, state, updated_at) VALUES (?, ?, ?, ${sql.now})
     ON CONFLICT(user_id, channel_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`,
    [userId, channelId, state]
  );
}

/** Accept: the conversation moves into the normal DM list. */
export async function acceptMessageRequest({ userId, channelId }) {
  await assertDmRecipient(userId, channelId);
  await setRequestState(userId, channelId, 'accepted');
  await runQuery(`UPDATE channel_recipients SET closed = 0 WHERE channel_id = ? AND user_id = ?`, [channelId, userId]);
  return { channel_id: channelId, state: 'accepted' };
}

/** Ignore: hidden from both lists; the sender is not told. */
export async function ignoreMessageRequest({ userId, channelId }) {
  await assertDmRecipient(userId, channelId);
  await setRequestState(userId, channelId, 'ignored');
  await runQuery(`UPDATE channel_recipients SET closed = 1 WHERE channel_id = ? AND user_id = ?`, [channelId, userId]);
  return { channel_id: channelId, state: 'ignored' };
}

// ============================================================================
//  Date of birth.
// ============================================================================

/** What the client needs to know about the account's age, never the date. */
export async function getAgeStatus(userId) {
  const row = await getQuery(`SELECT birth_year, birth_month FROM users WHERE id = ?`, [userId]);
  return { birthdate_set: row?.birth_year != null, age_group: ageGroupOf(row) };
}

/**
 * Record a date of birth once (sign-up, or the one-time prompt for accounts
 * made before the age gate). Only year and month are kept. It cannot be
 * changed afterwards from the client: a teen "correcting" their age upward
 * would switch the protections off.
 */
export async function setBirthdate({ userId, year, month, day }) {
  const current = await getQuery(`SELECT birth_year FROM users WHERE id = ? AND deleted_at IS NULL`, [userId]);
  if (!current) throw ApiError.notFound('User');
  if (current.birth_year != null) {
    throw new ApiError('Your date of birth is already set', { status: 409, code: 'BIRTHDATE_ALREADY_SET' });
  }
  const checked = checkBirthdate({ year, month, day });
  await runQuery(`UPDATE users SET birth_year = ?, birth_month = ? WHERE id = ?`, [checked.year, checked.month, userId]);
  forgetAgeGroup(userId);
  const status = await getAgeStatus(userId);
  if (status.age_group === 'minor') await applyMinorDefaults(userId);
  return status;
}
