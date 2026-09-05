// ============================================================================
//  Threads — a thread is a channel with type='thread' whose parent_id is the
//  text channel it hangs off. Messages, reactions and read state all work
//  unchanged because a thread *is* a channel.
// ============================================================================

import { runQuery, getQuery, allQuery, transaction } from '../db.js';
import { generateId } from '../lib/snowflake.js';
import { ApiError } from '../lib/httpUtils.js';
import { assertPermission } from './guilds.js';
import { assertChannelAccess } from './access.js';

/**
 * Start a thread, optionally anchored to an existing message.
 * The starter message stays in the parent channel and gains a thread_id, which
 * is what renders the "N messages ›" footer on it.
 */
/**
 * The channel must exist, be a thread, and be one this user may already read.
 * Returns the thread row.
 */
async function assertIsVisibleThread(threadId, userId) {
  const thread = await getQuery(
    `SELECT * FROM channels WHERE id = ? AND deleted_at IS NULL`, [threadId]
  );
  if (!thread || thread.type !== 'thread') throw ApiError.notFound('Thread');
  if (userId) await assertChannelAccess({ channelId: threadId, userId });
  return thread;
}

export async function createThread({
  parentChannelId, messageId = null, name, userId, autoArchiveDuration = 1440
}) {
  const parent = await getQuery(
    `SELECT * FROM channels WHERE id = ? AND deleted_at IS NULL`, [parentChannelId]
  );
  if (!parent) throw ApiError.notFound('Channel');
  if (parent.type === 'thread') throw ApiError.conflict('ไม่สามารถสร้างเธรดในเธรดได้');

  if (parent.server_id) {
    await assertPermission({
      userId, serverId: parent.server_id, channelId: parentChannelId,
      permission: 'CREATE_PUBLIC_THREADS'
    });
  }

  const trimmed = String(name ?? '').trim().slice(0, 100);
  if (!trimmed) throw new ApiError('ต้องตั้งชื่อเธรด', { code: 'INVALID_NAME' });

  const threadId = generateId();

  await transaction(async () => {
    await runQuery(
      `INSERT INTO channels (id, server_id, parent_id, name, type, owner_id,
                             auto_archive_duration, member_count, message_count)
       VALUES (?, ?, ?, ?, 'thread', ?, ?, 1, 0)`,
      [threadId, parent.server_id, parentChannelId, trimmed, userId, autoArchiveDuration]
    );
    await runQuery(
      `INSERT INTO channel_recipients (channel_id, user_id) VALUES (?, ?)`,
      [threadId, userId]
    );

    if (messageId) {
      await runQuery(`UPDATE messages SET thread_id = ? WHERE id = ?`, [threadId, messageId]);
      // A system message marks the branch point in the parent channel.
      const systemId = generateId();
      await runQuery(
        `INSERT INTO messages (id, channel_id, server_id, user_id, content, type, thread_id)
         VALUES (?, ?, ?, ?, ?, 'thread_created', ?)`,
        [systemId, parentChannelId, parent.server_id, userId, trimmed, threadId]
      );
    }
  });

  return getThread(threadId, userId);
}

export async function getThread(threadId, viewerId = null) {
  const thread = await getQuery(
    `SELECT c.*, p.name AS parent_name
       FROM channels c LEFT JOIN channels p ON p.id = c.parent_id
      WHERE c.id = ? AND c.type = 'thread' AND c.deleted_at IS NULL`,
    [threadId]
  );
  if (!thread) throw ApiError.notFound('Thread');

  const members = await allQuery(
    `SELECT u.id, u.username, u.display_name, u.avatar_url
       FROM channel_recipients cr JOIN users u ON u.id = cr.user_id
      WHERE cr.channel_id = ?`,
    [threadId]
  );
  return {
    ...thread,
    archived: Boolean(thread.archived),
    locked: Boolean(thread.locked),
    members,
    joined: viewerId ? members.some((m) => m.id === viewerId) : false
  };
}

export async function listThreads(parentChannelId, { includeArchived = false } = {}) {
  return allQuery(
    `SELECT c.*, (
       SELECT count(*) FROM messages m WHERE m.channel_id = c.id AND m.deleted_at IS NULL
     ) AS message_count
     FROM channels c
     WHERE c.parent_id = ? AND c.type = 'thread' AND c.deleted_at IS NULL
       ${includeArchived ? '' : 'AND c.archived = 0'}
     ORDER BY COALESCE(c.last_message_id, c.id) DESC`,
    [parentChannelId]
  );
}

export async function joinThread({ threadId, userId }) {
  // channel_recipients is also what makes someone a party to a DM, so writing a
  // row here without checking the target is a thread — and one this user can
  // already see — would hand out access to any conversation by id.
  const thread = await assertIsVisibleThread(threadId, userId);
  if (thread.archived) throw ApiError.conflict('เธรดนี้ถูกเก็บถาวรแล้ว');
  await runQuery(
    `INSERT OR IGNORE INTO channel_recipients (channel_id, user_id) VALUES (?, ?)`,
    [threadId, userId]
  );
  await runQuery(
    `UPDATE channels SET member_count = (
       SELECT count(*) FROM channel_recipients WHERE channel_id = ?
     ) WHERE id = ?`,
    [threadId, threadId]
  );
  return getThread(threadId, userId);
}

export async function leaveThread({ threadId, userId }) {
  await assertIsVisibleThread(threadId, userId);
  await runQuery(
    `DELETE FROM channel_recipients WHERE channel_id = ? AND user_id = ?`, [threadId, userId]
  );
  await runQuery(
    `UPDATE channels SET member_count = (
       SELECT count(*) FROM channel_recipients WHERE channel_id = ?
     ) WHERE id = ?`,
    [threadId, threadId]
  );
  return { success: true };
}

export async function setThreadArchived({ threadId, userId, archived, locked = undefined }) {
  const thread = await getQuery(`SELECT * FROM channels WHERE id = ?`, [threadId]);
  if (!thread) throw ApiError.notFound('Thread');
  // The creator may archive their own thread; anyone else needs MANAGE_THREADS.
  // Locking is always a moderator action.
  if (userId && (thread.owner_id !== userId || locked !== undefined)) {
    await assertPermission({
      userId, serverId: thread.server_id, channelId: thread.parent_id, permission: 'MANAGE_THREADS'
    });
  }

  const sets = [`archived = ?`, `archive_timestamp = strftime('%Y-%m-%dT%H:%M:%fZ','now')`];
  const params = [archived ? 1 : 0];
  if (locked !== undefined) { sets.push('locked = ?'); params.push(locked ? 1 : 0); }
  params.push(threadId);

  await runQuery(`UPDATE channels SET ${sets.join(', ')} WHERE id = ?`, params);
  return getThread(threadId, userId);
}

/**
 * Archive threads whose last activity is older than their auto-archive window.
 * Discord does this server-side; a periodic sweep is the simplest equivalent.
 */
export async function sweepStaleThreads() {
  const threads = await allQuery(
    `SELECT id, auto_archive_duration, updated_at FROM channels
      WHERE type = 'thread' AND archived = 0 AND deleted_at IS NULL`
  );
  let archived = 0;
  for (const thread of threads) {
    const idleMs = Date.now() - Date.parse(thread.updated_at);
    if (idleMs > (thread.auto_archive_duration ?? 1440) * 60_000) {
      await runQuery(
        `UPDATE channels SET archived = 1,
           archive_timestamp = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
        [thread.id]
      );
      archived += 1;
    }
  }
  return { archived };
}
