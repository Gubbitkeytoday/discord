// ============================================================================
//  Forum channels.
//
//  Discord's model, which we copy exactly: a forum post *is* a thread whose
//  parent_id is the forum channel, and the post body is the thread's first
//  message. Everything a thread already does — messages, reactions, read
//  state, archiving, membership — therefore works for posts unchanged. What
//  this module adds on top is the forum-only vocabulary: tags, pinning,
//  sorting/filtering the post list, and creating a post in one transaction so
//  a post can never exist without its body.
// ============================================================================

import { runQuery, getQuery, allQuery, transaction } from '../db.js';
import { generateId } from '../lib/snowflake.js';
import { ApiError } from '../lib/httpUtils.js';
import { assertPermission } from './guilds.js';
import { assertChannelAccess, canInChannel } from './access.js';
import { createMessage } from './messages.js';
import { getThread } from './threads.js';
import { getFile } from '../storageService.js';

export const FORUM_LIMITS = Object.freeze({
  tagsPerForum: 20,
  tagsPerPost: 5,
  tagName: 20,
  postTitle: 100,
  postBody: 2000,
  pageSize: 25
});

const FORUM_TYPES = new Set(['forum']);

async function getForum(channelId) {
  const channel = await getQuery(
    `SELECT * FROM channels WHERE id = ? AND deleted_at IS NULL`, [channelId]
  );
  if (!channel || !FORUM_TYPES.has(channel.type)) throw ApiError.notFound('Forum channel');
  return channel;
}

async function getPostRow(threadId) {
  const post = await getQuery(
    `SELECT c.*, f.type AS parent_type
       FROM channels c JOIN channels f ON f.id = c.parent_id
      WHERE c.id = ? AND c.type = 'thread' AND c.deleted_at IS NULL`,
    [threadId]
  );
  if (!post || !FORUM_TYPES.has(post.parent_type)) throw ApiError.notFound('Forum post');
  return post;
}

/** Staff = anyone who may manage threads in this forum (or the guild). */
async function isStaff({ userId, channelId }) {
  return canInChannel({ channelId, userId, permission: 'MANAGE_THREADS' });
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

function shapeTag(row) {
  return {
    id: row.id, channel_id: row.channel_id, name: row.name,
    emoji: row.emoji ?? null, moderated: Boolean(row.moderated), position: row.position
  };
}

export async function listTags(channelId) {
  const rows = await allQuery(
    `SELECT * FROM forum_tags WHERE channel_id = ? ORDER BY position ASC, name ASC`, [channelId]
  );
  return rows.map(shapeTag);
}

function validateTagInput({ name, emoji }) {
  const clean = String(name ?? '').trim();
  if (!clean || clean.length > FORUM_LIMITS.tagName) {
    throw new ApiError(`Tag name must be 1–${FORUM_LIMITS.tagName} characters`, { code: 'TAG_INVALID' });
  }
  const cleanEmoji = emoji === undefined || emoji === null || emoji === '' ? null : String(emoji).slice(0, 64);
  return { name: clean, emoji: cleanEmoji };
}

export async function createTag({ channelId, userId, name, emoji = null, moderated = false }) {
  const forum = await getForum(channelId);
  await assertPermission({ userId, serverId: forum.server_id, channelId, permission: 'MANAGE_CHANNELS' });

  const count = (await getQuery(`SELECT count(*) AS n FROM forum_tags WHERE channel_id = ?`, [channelId])).n;
  if (count >= FORUM_LIMITS.tagsPerForum) {
    throw new ApiError(`A forum may have at most ${FORUM_LIMITS.tagsPerForum} tags`, { code: 'TAG_LIMIT' });
  }
  const input = validateTagInput({ name, emoji });
  const dup = await getQuery(
    `SELECT id FROM forum_tags WHERE channel_id = ? AND lower(name) = lower(?)`, [channelId, input.name]
  );
  if (dup) throw new ApiError('A tag with that name already exists', { status: 409, code: 'TAG_DUPLICATE' });

  const id = generateId();
  await runQuery(
    `INSERT INTO forum_tags (id, channel_id, name, emoji, moderated, position) VALUES (?, ?, ?, ?, ?, ?)`,
    [id, channelId, input.name, input.emoji, moderated ? 1 : 0, count]
  );
  return shapeTag(await getQuery(`SELECT * FROM forum_tags WHERE id = ?`, [id]));
}

export async function updateTag({ channelId, tagId, userId, patch }) {
  const forum = await getForum(channelId);
  await assertPermission({ userId, serverId: forum.server_id, channelId, permission: 'MANAGE_CHANNELS' });
  const tag = await getQuery(`SELECT * FROM forum_tags WHERE id = ? AND channel_id = ?`, [tagId, channelId]);
  if (!tag) throw ApiError.notFound('Tag');

  const next = { name: tag.name, emoji: tag.emoji, moderated: tag.moderated };
  if (patch.name !== undefined || patch.emoji !== undefined) {
    const v = validateTagInput({ name: patch.name ?? tag.name, emoji: patch.emoji === undefined ? tag.emoji : patch.emoji });
    next.name = v.name; next.emoji = v.emoji;
    const dup = await getQuery(
      `SELECT id FROM forum_tags WHERE channel_id = ? AND lower(name) = lower(?) AND id != ?`,
      [channelId, next.name, tagId]
    );
    if (dup) throw new ApiError('A tag with that name already exists', { status: 409, code: 'TAG_DUPLICATE' });
  }
  if (patch.moderated !== undefined) next.moderated = patch.moderated ? 1 : 0;

  await runQuery(
    `UPDATE forum_tags SET name = ?, emoji = ?, moderated = ? WHERE id = ?`,
    [next.name, next.emoji, next.moderated, tagId]
  );
  return shapeTag(await getQuery(`SELECT * FROM forum_tags WHERE id = ?`, [tagId]));
}

export async function deleteTag({ channelId, tagId, userId }) {
  const forum = await getForum(channelId);
  await assertPermission({ userId, serverId: forum.server_id, channelId, permission: 'MANAGE_CHANNELS' });
  const { changes } = await runQuery(`DELETE FROM forum_tags WHERE id = ? AND channel_id = ?`, [tagId, channelId]);
  if (!changes) throw ApiError.notFound('Tag');
  return { ok: true };
}

/**
 * Resolve the tag ids a user wants on a post: every id must belong to this
 * forum, at most five, and moderated tags need staff. Returns tag rows.
 */
async function resolveTags({ channelId, userId, tagIds, forum }) {
  const ids = [...new Set((Array.isArray(tagIds) ? tagIds : []).map(String))];
  if (ids.length > FORUM_LIMITS.tagsPerPost) {
    throw new ApiError(`A post may carry at most ${FORUM_LIMITS.tagsPerPost} tags`, { code: 'TAG_LIMIT' });
  }
  if (forum.require_tag && ids.length === 0) {
    throw new ApiError('This forum requires at least one tag', { code: 'TAG_REQUIRED' });
  }
  if (ids.length === 0) return [];

  const rows = await allQuery(
    `SELECT * FROM forum_tags WHERE channel_id = ? AND id IN (${ids.map(() => '?').join(',')})`,
    [channelId, ...ids]
  );
  if (rows.length !== ids.length) throw new ApiError('Unknown tag for this forum', { code: 'TAG_INVALID' });
  if (rows.some((r) => r.moderated) && !(await isStaff({ userId, channelId }))) {
    throw new ApiError('Only moderators may apply that tag', { status: 403, code: 'TAG_MODERATED' });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------

async function attachPostMeta(posts) {
  if (posts.length === 0) return [];
  const ids = posts.map((p) => p.id);
  const ph = ids.map(() => '?').join(',');

  const tagRows = await allQuery(
    `SELECT pt.thread_id, t.* FROM forum_post_tags pt JOIN forum_tags t ON t.id = pt.tag_id
      WHERE pt.thread_id IN (${ph}) ORDER BY t.position ASC`, ids
  );
  const tagsByPost = new Map();
  for (const r of tagRows) {
    if (!tagsByPost.has(r.thread_id)) tagsByPost.set(r.thread_id, []);
    tagsByPost.get(r.thread_id).push(shapeTag(r));
  }

  // First message = post body. One query, oldest per thread.
  const firstRows = await allQuery(
    `SELECT m.channel_id, m.id, m.content, m.user_id, m.created_at,
            u.username, u.display_name, u.avatar_url,
            (SELECT count(*) FROM attachments a WHERE a.message_id = m.id) AS attachment_count,
            (SELECT a.file_id FROM attachments a WHERE a.message_id = m.id
               AND a.content_type LIKE 'image/%' ORDER BY a.position LIMIT 1) AS thumbnail_file_id
       FROM messages m JOIN users u ON u.id = m.user_id
      WHERE m.channel_id IN (${ph}) AND m.deleted_at IS NULL
        AND m.id = (SELECT min(m2.id) FROM messages m2 WHERE m2.channel_id = m.channel_id AND m2.deleted_at IS NULL)`,
    ids
  );
  const firstByPost = new Map(firstRows.map((r) => [r.channel_id, r]));
  // Resolve thumbnails through the storage layer so private files stay private.
  const thumbs = new Map();
  for (const r of firstRows) {
    if (!r.thumbnail_file_id) continue;
    const file = await getFile(r.thumbnail_file_id);
    thumbs.set(r.channel_id, file?.variants?.medium?.url ?? file?.variants?.thumb?.url ?? file?.url ?? null);
  }

  const lastRows = await allQuery(
    `SELECT m.channel_id, max(m.created_at) AS last_activity_at, count(*) AS message_count
       FROM messages m WHERE m.channel_id IN (${ph}) AND m.deleted_at IS NULL GROUP BY m.channel_id`, ids
  );
  const lastByPost = new Map(lastRows.map((r) => [r.channel_id, r]));

  // Reaction totals on the starter message — the "👍 12" shown on the card.
  const starterIds = firstRows.map((r) => r.id);
  const reactions = starterIds.length ? await allQuery(
    `SELECT message_id, emoji, count(*) AS n FROM reactions
      WHERE message_id IN (${starterIds.map(() => '?').join(',')}) GROUP BY message_id, emoji`, starterIds
  ) : [];
  const reactionsByMsg = new Map();
  for (const r of reactions) {
    if (!reactionsByMsg.has(r.message_id)) reactionsByMsg.set(r.message_id, []);
    reactionsByMsg.get(r.message_id).push({ emoji: r.emoji, count: r.n });
  }

  return posts.map((p) => {
    const first = firstByPost.get(p.id);
    const last = lastByPost.get(p.id);
    return {
      id: p.id,
      parent_id: p.parent_id,
      server_id: p.server_id,
      name: p.name,
      owner_id: p.owner_id,
      archived: Boolean(p.archived),
      locked: Boolean(p.locked),
      pinned: Boolean(p.pinned),
      created_at: p.created_at,
      tags: tagsByPost.get(p.id) ?? [],
      message_count: last?.message_count ?? 0,
      reply_count: Math.max(0, (last?.message_count ?? 0) - 1),
      last_activity_at: last?.last_activity_at ?? p.created_at,
      author: first ? {
        id: first.user_id, username: first.username,
        display_name: first.display_name, avatar_url: first.avatar_url
      } : null,
      preview: first ? String(first.content ?? '').slice(0, 300) : '',
      attachment_count: first?.attachment_count ?? 0,
      thumbnail_url: thumbs.get(p.id) ?? null,
      starter_message_id: first?.id ?? null,
      reactions: first ? (reactionsByMsg.get(first.id) ?? []) : []
    };
  });
}

/**
 * List posts. Pinned first, then by the requested sort. `tag` filters to
 * posts carrying *all* the given tag ids; `q` matches title or body.
 */
export async function listPosts(channelId, {
  viewerId, sort = null, tagIds = [], q = '', includeArchived = false, before = null, limit = FORUM_LIMITS.pageSize
} = {}) {
  const forum = await getForum(channelId);
  if (viewerId) await assertChannelAccess({ channelId, userId: viewerId });

  const order = ['latest_activity', 'creation_date'].includes(sort) ? sort : forum.default_sort_order;
  const ids = [...new Set((Array.isArray(tagIds) ? tagIds : []).filter(Boolean).map(String))];
  const where = [`c.parent_id = ?`, `c.type = 'thread'`, `c.deleted_at IS NULL`];
  const params = [channelId];
  if (!includeArchived) where.push(`c.archived = 0`);
  for (const id of ids) {
    where.push(`EXISTS (SELECT 1 FROM forum_post_tags pt WHERE pt.thread_id = c.id AND pt.tag_id = ?)`);
    params.push(id);
  }
  const needle = String(q ?? '').trim();
  if (needle) {
    where.push(`(c.name LIKE ? ESCAPE '\\' OR EXISTS (
       SELECT 1 FROM messages m WHERE m.channel_id = c.id AND m.deleted_at IS NULL AND m.content LIKE ? ESCAPE '\\'))`);
    const like = `%${needle.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    params.push(like, like);
  }

  const activityExpr = `COALESCE((SELECT max(m.created_at) FROM messages m WHERE m.channel_id = c.id AND m.deleted_at IS NULL), c.created_at)`;
  const sortExpr = order === 'creation_date' ? `c.created_at` : activityExpr;
  if (before) { where.push(`${sortExpr} < ?`); params.push(String(before)); }

  const cap = Math.min(Math.max(1, Number(limit) || FORUM_LIMITS.pageSize), 100);
  const rows = await allQuery(
    `SELECT c.*, ${sortExpr} AS sort_key FROM channels c
      WHERE ${where.join(' AND ')}
      ORDER BY c.pinned DESC, sort_key DESC
      LIMIT ?`,
    [...params, cap + 1]
  );
  const hasMore = rows.length > cap;
  const page = rows.slice(0, cap);
  const posts = await attachPostMeta(page);
  return {
    posts,
    has_more: hasMore,
    next_before: hasMore ? page[page.length - 1].sort_key : null,
    sort: order
  };
}

export async function getPost(threadId, viewerId) {
  const row = await getPostRow(threadId);
  if (viewerId) await assertChannelAccess({ channelId: threadId, userId: viewerId });
  const [post] = await attachPostMeta([row]);
  const thread = await getThread(threadId, viewerId);
  return { ...post, members: thread.members, joined: thread.joined };
}

/**
 * Create a post: title + body (+ attachments, tags) in one transaction, so a
 * thread with no starter message cannot exist. Needs CREATE_PUBLIC_THREADS
 * *and* SEND_MESSAGES in the forum, same as Discord.
 */
export async function createPost({ channelId, userId, title, content = '', attachments = [], tagIds = [], nonce = null }) {
  const forum = await getForum(channelId);
  await assertPermission({ userId, serverId: forum.server_id, channelId, permission: 'CREATE_PUBLIC_THREADS' });
  await assertPermission({ userId, serverId: forum.server_id, channelId, permission: 'SEND_MESSAGES' });

  const cleanTitle = String(title ?? '').trim().slice(0, FORUM_LIMITS.postTitle);
  if (!cleanTitle) throw new ApiError('A post needs a title', { code: 'INVALID_TITLE' });
  const body = String(content ?? '').trim();
  if (body.length > FORUM_LIMITS.postBody) {
    throw new ApiError(`Post body may be at most ${FORUM_LIMITS.postBody} characters`, { code: 'BODY_TOO_LONG' });
  }
  if (!body && (!Array.isArray(attachments) || attachments.length === 0)) {
    throw new ApiError('A post needs a body or an attachment', { code: 'EMPTY_POST' });
  }
  const tags = await resolveTags({ channelId, userId, tagIds, forum });

  const threadId = generateId();
  let message;
  await transaction(async () => {
    await runQuery(
      `INSERT INTO channels (id, server_id, parent_id, name, type, owner_id,
                             auto_archive_duration, member_count, message_count)
       VALUES (?, ?, ?, ?, 'thread', ?, ?, 1, 0)`,
      [threadId, forum.server_id, channelId, cleanTitle, userId, forum.auto_archive_duration || 4320]
    );
    await runQuery(`INSERT INTO channel_recipients (channel_id, user_id) VALUES (?, ?)`, [threadId, userId]);
    for (const tag of tags) {
      await runQuery(`INSERT INTO forum_post_tags (thread_id, tag_id) VALUES (?, ?)`, [threadId, tag.id]);
    }
    message = await createMessage({ channelId: threadId, userId, content: body, attachments, nonce });
  });

  const post = await getPost(threadId, userId);
  return { post, message };
}

export async function setPostTags({ threadId, userId, tagIds }) {
  const post = await getPostRow(threadId);
  const forum = await getForum(post.parent_id);
  const staff = await isStaff({ userId, channelId: post.parent_id });
  if (post.owner_id !== userId && !staff) {
    throw new ApiError('Only the author or a moderator may edit tags', { status: 403, code: 'FORBIDDEN' });
  }
  const tags = await resolveTags({ channelId: post.parent_id, userId, tagIds, forum });
  await transaction(async () => {
    await runQuery(`DELETE FROM forum_post_tags WHERE thread_id = ?`, [threadId]);
    for (const tag of tags) {
      await runQuery(`INSERT INTO forum_post_tags (thread_id, tag_id) VALUES (?, ?)`, [threadId, tag.id]);
    }
  });
  return getPost(threadId, userId);
}

export async function setPostPinned({ threadId, userId, pinned }) {
  const post = await getPostRow(threadId);
  if (!(await isStaff({ userId, channelId: post.parent_id }))) {
    throw new ApiError('Only moderators may pin posts', { status: 403, code: 'FORBIDDEN' });
  }
  await runQuery(`UPDATE channels SET pinned = ? WHERE id = ?`, [pinned ? 1 : 0, threadId]);
  return getPost(threadId, userId);
}

/** Forum-level settings editable by MANAGE_CHANNELS. */
export async function updateForumSettings({ channelId, userId, patch }) {
  const forum = await getForum(channelId);
  await assertPermission({ userId, serverId: forum.server_id, channelId, permission: 'MANAGE_CHANNELS' });
  const sets = []; const params = [];
  if (patch.default_sort_order !== undefined) {
    if (!['latest_activity', 'creation_date'].includes(patch.default_sort_order)) {
      throw new ApiError('Invalid sort order', { code: 'INVALID_SORT' });
    }
    sets.push('default_sort_order = ?'); params.push(patch.default_sort_order);
  }
  if (patch.default_reaction_emoji !== undefined) {
    const v = patch.default_reaction_emoji ? String(patch.default_reaction_emoji).slice(0, 64) : null;
    sets.push('default_reaction_emoji = ?'); params.push(v);
  }
  if (patch.require_tag !== undefined) { sets.push('require_tag = ?'); params.push(patch.require_tag ? 1 : 0); }
  if (patch.default_layout !== undefined) {
    if (!['list', 'gallery'].includes(patch.default_layout)) throw new ApiError('Invalid layout', { code: 'INVALID_LAYOUT' });
    sets.push('default_layout = ?'); params.push(patch.default_layout);
  }
  if (sets.length) await runQuery(`UPDATE channels SET ${sets.join(', ')} WHERE id = ?`, [...params, channelId]);
  return getQuery(`SELECT * FROM channels WHERE id = ?`, [channelId]);
}
