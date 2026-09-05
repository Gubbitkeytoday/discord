// ============================================================================
//  Channel following (Discord "Follow" on announcement channels).
//
//  Following creates a `follower` webhook in the *target* channel whose name
//  and avatar are the source server's, then records the pair. Publishing a
//  message in the source relays it through every follower webhook — so the
//  relayed copy is a real message row in the target channel (history, search,
//  reactions all work) that displays as "<Source Server> #announcements".
//  message_crossposts remembers the mapping so a publish is idempotent and an
//  upstream delete removes the copies.
// ============================================================================

import crypto from 'crypto';
import { runQuery, getQuery, allQuery, transaction } from '../db.js';
import { generateId } from '../lib/snowflake.js';
import { ApiError } from '../lib/httpUtils.js';
import { assertPermission } from './guilds.js';
import { assertChannelAccess } from './access.js';
import { createMessage, getMessage, deleteMessage } from './messages.js';

export const FOLLOW_LIMITS = Object.freeze({ followersPerChannel: 50 });

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

async function getAnnouncementChannel(channelId) {
  const channel = await getQuery(
    `SELECT c.*, s.name AS server_name, s.icon_url AS server_icon
       FROM channels c JOIN servers s ON s.id = c.server_id
      WHERE c.id = ? AND c.deleted_at IS NULL AND s.deleted_at IS NULL`, [channelId]
  );
  if (!channel) throw ApiError.notFound('Channel');
  if (channel.type !== 'announcement') {
    throw new ApiError('Only announcement channels can be followed', { code: 'NOT_ANNOUNCEMENT' });
  }
  return channel;
}

function shape(row) {
  return {
    id: row.id,
    source_channel_id: row.source_channel_id,
    source_channel_name: row.source_channel_name,
    source_server_id: row.source_server_id,
    source_server_name: row.source_server_name,
    target_channel_id: row.target_channel_id,
    target_channel_name: row.target_channel_name,
    target_server_id: row.target_server_id,
    created_at: row.created_at
  };
}

const FOLLOW_SELECT = `
  SELECT f.*, sc.name AS source_channel_name, sc.server_id AS source_server_id, ss.name AS source_server_name,
         tc.name AS target_channel_name, tc.server_id AS target_server_id
    FROM channel_follows f
    JOIN channels sc ON sc.id = f.source_channel_id
    JOIN servers  ss ON ss.id = sc.server_id
    JOIN channels tc ON tc.id = f.target_channel_id
`;

/**
 * Follow `sourceChannelId` from `targetChannelId`. The actor must be able to
 * see the source and manage webhooks in the target's server — the same two
 * checks Discord makes.
 */
export async function follow({ sourceChannelId, targetChannelId, userId }) {
  const source = await getAnnouncementChannel(sourceChannelId);
  await assertChannelAccess({ channelId: sourceChannelId, userId });

  const target = await getQuery(`SELECT * FROM channels WHERE id = ? AND deleted_at IS NULL`, [targetChannelId]);
  if (!target || !target.server_id || !['text', 'announcement'].includes(target.type)) {
    throw new ApiError('Follow into a text channel of a server', { code: 'INVALID_TARGET' });
  }
  if (target.id === source.id) throw new ApiError('A channel cannot follow itself', { code: 'INVALID_TARGET' });
  await assertPermission({ userId, serverId: target.server_id, channelId: target.id, permission: 'MANAGE_WEBHOOKS' });

  const existing = await getQuery(
    `SELECT id FROM channel_follows WHERE source_channel_id = ? AND target_channel_id = ?`, [source.id, target.id]
  );
  if (existing) throw new ApiError('Already following', { status: 409, code: 'ALREADY_FOLLOWING' });

  const count = (await getQuery(`SELECT count(*) AS n FROM channel_follows WHERE source_channel_id = ?`, [source.id])).n;
  if (count >= FOLLOW_LIMITS.followersPerChannel) {
    throw new ApiError('This channel has too many followers', { code: 'FOLLOW_LIMIT' });
  }

  const followId = generateId();
  const webhookId = generateId();
  await transaction(async () => {
    // The relay webhook has no usable token on purpose: nobody may execute it
    // from outside; only publish() writes through it.
    await runQuery(
      `INSERT INTO webhooks (id, channel_id, server_id, name, avatar_url, token_hash, type, creator_id)
       VALUES (?, ?, ?, ?, ?, ?, 'follower', ?)`,
      [webhookId, target.id, target.server_id, `${source.server_name} #${source.name}`.slice(0, 80),
       source.server_icon, hashToken(crypto.randomBytes(32).toString('hex')), userId]
    );
    await runQuery(
      `INSERT INTO channel_follows (id, source_channel_id, target_channel_id, webhook_id, created_by) VALUES (?, ?, ?, ?, ?)`,
      [followId, source.id, target.id, webhookId, userId]
    );
  });
  return shape(await getQuery(`${FOLLOW_SELECT} WHERE f.id = ?`, [followId]));
}

export async function unfollow({ followId, userId }) {
  const row = await getQuery(`${FOLLOW_SELECT} WHERE f.id = ?`, [followId]);
  if (!row) throw ApiError.notFound('Follow');
  await assertPermission({ userId, serverId: row.target_server_id, channelId: row.target_channel_id, permission: 'MANAGE_WEBHOOKS' });
  await transaction(async () => {
    await runQuery(`DELETE FROM channel_follows WHERE id = ?`, [followId]);
    await runQuery(`UPDATE webhooks SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`, [row.webhook_id]);
  });
  return { ok: true };
}

/** Follows *of* a source channel (who is subscribed) — visible to source staff. */
export async function listFollowers(sourceChannelId, userId) {
  const source = await getAnnouncementChannel(sourceChannelId);
  await assertPermission({ userId, serverId: source.server_id, channelId: source.id, permission: 'MANAGE_WEBHOOKS' });
  return (await allQuery(`${FOLLOW_SELECT} WHERE f.source_channel_id = ? ORDER BY f.created_at ASC`, [source.id])).map(shape);
}

/** Follows *into* a target server (what this server subscribes to). */
export async function listFollowing(serverId, userId) {
  await assertPermission({ userId, serverId, permission: 'MANAGE_WEBHOOKS' });
  return (await allQuery(`${FOLLOW_SELECT} WHERE tc.server_id = ? ORDER BY f.created_at ASC`, [serverId])).map(shape);
}

/**
 * Publish (crosspost) a message: relay to every follower. Idempotent — a
 * follower that already has the copy is skipped. Returns the relayed messages
 * so the caller can emit them into each target channel.
 */
export async function publish({ messageId, userId }) {
  const message = await getMessage(messageId, userId);
  if (!message) throw ApiError.notFound('Message');
  const source = await getAnnouncementChannel(message.channel_id);
  // Own messages need SEND_MESSAGES; others' need MANAGE_MESSAGES (Discord).
  const permission = message.user_id === userId ? 'SEND_MESSAGES' : 'MANAGE_MESSAGES';
  await assertPermission({ userId, serverId: source.server_id, channelId: source.id, permission });

  const follows = await allQuery(
    `SELECT f.*, w.creator_id, w.revoked_at FROM channel_follows f JOIN webhooks w ON w.id = f.webhook_id
      WHERE f.source_channel_id = ?`, [source.id]
  );
  const relayed = [];
  for (const f of follows) {
    if (f.revoked_at) continue;
    const done = await getQuery(
      `SELECT relayed_message_id FROM message_crossposts WHERE source_message_id = ? AND follow_id = ?`, [messageId, f.id]
    );
    if (done) continue;
    const content = message.content ?? '';
    let copy;
    try {
      copy = await createMessage({
        channelId: f.target_channel_id,
        userId: f.creator_id ?? userId,
        content,
        attachments: (message.attachments ?? []).map((a) => ({ id: a.id, file_id: a.file_id, filename: a.filename, description: a.description ?? null, is_spoiler: a.is_spoiler })),
        skipModeration: true
      });
    } catch (err) {
      // A follower channel that vanished, is locked, etc. must not block the
      // other followers. Skip it; the webhook stays for a later publish.
      if (err instanceof ApiError) continue;
      throw err;
    }
    await runQuery(`UPDATE messages SET webhook_id = ? WHERE id = ?`, [f.webhook_id, copy.id]);
    await runQuery(
      `INSERT INTO message_crossposts (source_message_id, follow_id, relayed_message_id) VALUES (?, ?, ?)`,
      [messageId, f.id, copy.id]
    );
    relayed.push(await getMessage(copy.id));
  }
  await runQuery(`UPDATE messages SET flags = flags | 1 WHERE id = ?`, [messageId]);   // 1 = CROSSPOSTED
  return { published: true, relayed, followers: follows.filter((f) => !f.revoked_at).length };
}

/** Mirror an upstream delete into every relayed copy. */
export async function retractCrossposts(sourceMessageId) {
  const copies = await allQuery(
    `SELECT relayed_message_id FROM message_crossposts WHERE source_message_id = ?`, [sourceMessageId]
  );
  const removed = [];
  for (const c of copies) {
    try {
      const gone = await deleteMessage({ messageId: c.relayed_message_id, userId: null, canManageMessages: true });
      if (gone) removed.push(gone);
    } catch { /* already gone */ }
  }
  return removed;
}
