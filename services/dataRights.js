// ============================================================================
//  Data export and account deletion — the two things a person is entitled to
//  do with their own account, and the two that are easiest to get wrong.
//
//  Export
//    A single JSON document containing what this account has produced: the
//    profile, the servers joined, the messages sent, friends, and settings.
//    Deliberately *not* everything the account can see — a chat is other
//    people's data too, and handing one person a copy of a private channel
//    because they happened to read it would be the opposite of a privacy
//    feature.
//
//  Deletion
//    Soft, and anonymising. Discord's model, and the right one: the account
//    stops existing, but the conversations other people had do not develop
//    holes. Messages stay, attributed to a tombstoned user; everything
//    personal — email, password, avatar, bio, sessions, friendships — is
//    removed outright.
// ============================================================================

import { getQuery, allQuery, runQuery, transaction } from '../db.js';
import { ApiError } from '../lib/httpUtils.js';

// A guard against a runaway export on a very old account. Anything larger than
// this is a support request, not a download.
const EXPORT_MESSAGE_CAP = 50_000;

/**
 * Everything this account produced, as one plain object ready to be written
 * out as JSON.
 */
export async function exportAccount(userId) {
  const user = await getQuery(
    `SELECT id, username, discriminator, display_name, email, bio, pronouns,
            accent_color, avatar_url, banner_url, locale, theme, status,
            custom_status, created_at
       FROM users WHERE id = ? AND deleted_at IS NULL`,
    [userId]
  );
  if (!user) throw ApiError.notFound('User');

  const [servers, messages, friends, settings, sessions] = await Promise.all([
    allQuery(
      `SELECT s.id, s.name, sm.joined_at, sm.nickname
         FROM server_members sm JOIN servers s ON s.id = sm.server_id
        WHERE sm.user_id = ? AND sm.left_at IS NULL AND s.deleted_at IS NULL
        ORDER BY sm.joined_at`,
      [userId]
    ),
    allQuery(
      `SELECT id, channel_id, server_id, content, type, created_at, edited_at
         FROM messages
        WHERE user_id = ? AND deleted_at IS NULL
        ORDER BY id DESC LIMIT ?`,
      [userId, EXPORT_MESSAGE_CAP]
    ),
    allQuery(
      `SELECT u.username, u.display_name, f.status, f.created_at
         FROM friends f
         JOIN users u ON u.id = CASE WHEN f.user_id = ? THEN f.friend_id ELSE f.user_id END
        WHERE (f.user_id = ? OR f.friend_id = ?) AND f.status = 'accepted'`,
      [userId, userId, userId]
    ),
    allQuery(`SELECT category, data FROM user_settings WHERE user_id = ?`, [userId]),
    allQuery(
      `SELECT device_name, platform, created_at, last_seen_at FROM sessions
        WHERE user_id = ? AND revoked_at IS NULL`,
      [userId]
    )
  ]);

  return {
    generated_at: new Date().toISOString(),
    // Named so that a reader opening the file six months later knows what it
    // is and, just as importantly, what it is not.
    about: 'Data produced by this account. It does not include other people’s messages.',
    user,
    servers,
    messages: messages.reverse(),
    message_count: messages.length,
    truncated: messages.length >= EXPORT_MESSAGE_CAP,
    friends,
    settings: Object.fromEntries(settings.map((row) => {
      try { return [row.category, JSON.parse(row.data)]; }
      catch { return [row.category, row.data]; }
    })),
    sessions
  };
}

/**
 * Delete the account. Messages survive as the tombstoned author; everything
 * that identifies the person does not.
 *
 * A server owner must hand the server over first — deleting an account that
 * owns a community would either destroy it or leave it ownerless, and neither
 * is something to do silently on someone's behalf.
 */
export async function deleteAccount({ userId }) {
  const user = await getQuery(`SELECT id FROM users WHERE id = ? AND deleted_at IS NULL`, [userId]);
  if (!user) throw ApiError.notFound('User');

  const owned = await allQuery(
    `SELECT id, name FROM servers WHERE owner_id = ? AND deleted_at IS NULL`, [userId]
  );
  if (owned.length) {
    throw new ApiError('Transfer or delete the servers you own before deleting your account', {
      status: 409, code: 'OWNS_SERVERS', details: { servers: owned }
    });
  }

  await transaction(async () => {
    await runQuery(
      `UPDATE users
          SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              display_name = 'Deleted User',
              username = 'deleted_' || id,
              email = NULL, password_hash = NULL, mfa_secret = NULL, mfa_enabled = 0,
              avatar_url = NULL, banner_url = NULL, bio = NULL, pronouns = NULL,
              custom_status = NULL, custom_status_emoji = NULL, status = 'offline'
        WHERE id = ?`,
      [userId]
    );
    // Every way back in, closed.
    await runQuery(
      `UPDATE sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE user_id = ? AND revoked_at IS NULL`, [userId]
    );
    await runQuery(`DELETE FROM account_tokens WHERE user_id = ?`, [userId]);
    await runQuery(`DELETE FROM push_tokens WHERE user_id = ?`, [userId]);
    // Relationships are mutual, so they go rather than linger as half a row.
    await runQuery(`DELETE FROM friends WHERE user_id = ? OR friend_id = ?`, [userId, userId]);
    await runQuery(`DELETE FROM blocks WHERE user_id = ? OR blocked_id = ?`, [userId, userId]);
    await runQuery(`DELETE FROM user_settings WHERE user_id = ?`, [userId]);
    // Leaving every server also removes the per-guild profiles.
    await runQuery(
      `UPDATE server_members SET left_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
              nickname = NULL, avatar_url = NULL, banner_url = NULL, bio = NULL, pronouns = NULL
        WHERE user_id = ? AND left_at IS NULL`,
      [userId]
    );
  });

  return { deleted: true };
}
