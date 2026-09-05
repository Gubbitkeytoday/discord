// ============================================================================
//  Message service — the read/write path for chat.
//
//  Storage is normalised (attachments, reactions and mentions are their own
//  tables) but the wire format stays flat and denormalised, because that is
//  what a chat client needs to render a row without extra round trips.
// ============================================================================

import { runQuery, getQuery, allQuery, transaction } from '../db.js';
import { generateId } from '../lib/snowflake.js';
import { getFile, addReference, releaseReference, formatBytes } from '../storageService.js';
import { validateEmbeds, validateComponents } from './applications.js';
import { getFileType } from '../lib/mediaProbe.js';
import { ApiError } from '../lib/httpUtils.js';
import { computeBasePermissions, ALL_PERMISSIONS, has } from '../lib/permissions.js';
import * as automod from './automod.js';
import { assertChannelAccess, canInChannel } from './access.js';
import { validatePollInput, writePollRows, attachPolls } from './polls.js';
import { parseSearchQuery, hasFilters, periodBounds } from '../lib/searchQuery.js';

const MENTION_USER    = /<@!?(\d+|user-[\w-]+)>/g;
const MENTION_ROLE    = /<@&([\w-]+)>/g;
const MENTION_CHANNEL = /<#([\w-]+)>/g;

/** Extract mention targets from raw content. */
export function parseMentions(content = '') {
  const users = new Set();
  const roles = new Set();
  const channels = new Set();
  for (const m of content.matchAll(MENTION_USER)) users.add(m[1]);
  for (const m of content.matchAll(MENTION_ROLE)) roles.add(m[1]);
  for (const m of content.matchAll(MENTION_CHANNEL)) channels.add(m[1]);
  return {
    users: [...users],
    roles: [...roles],
    channels: [...channels],
    // Discord treats these differently: @everyone pings every member,
    // @here only those currently online.
    everyone: /@everyone\b/.test(content),
    here: /@here\b/.test(content)
  };
}

/**
 * Role ids for a sender. Permissions come from the channel-aware access check,
 * so a channel overwrite that grants MANAGE_MESSAGES really does exempt the
 * sender from slowmode; only the role list is needed separately, for AutoMod's
 * per-role exemptions.
 */
async function resolveSenderContext(serverId, userId) {
  const server = await getQuery(`SELECT owner_id FROM servers WHERE id = ?`, [serverId]);
  const roles = await allQuery(
    `SELECT r.id, r.permissions FROM member_roles mr JOIN roles r ON r.id = mr.role_id
      WHERE mr.server_id = ? AND mr.user_id = ?`,
    [serverId, userId]
  );
  const permissions = computeBasePermissions({
    isOwner: server?.owner_id === userId,
    rolePermissions: roles.map((r) => r.permissions)
  });
  return { permissions, roleIds: roles.map((r) => r.id) };
}

/**
 * Attach delivery metadata that the gateway needs but no client should see.
 * Non-enumerable keeps it out of JSON.stringify and out of socket payloads.
 */
function withDelivery(message, { notifications = [], audience = [], duplicate = false } = {}) {
  if (!message) return message;
  Object.defineProperty(message, 'notifications', { value: notifications, enumerable: false });
  Object.defineProperty(message, 'audience', { value: audience, enumerable: false });
  Object.defineProperty(message, 'duplicate', { value: duplicate, enumerable: false });
  return message;
}

function safeParse(json, fallback) {
  if (!json) return fallback;
  try { return JSON.parse(json); } catch { return fallback; }
}

/** Aggregate reaction rows into the `{ emoji: count }` shape the UI renders. */
function aggregateReactions(rows, viewerId = null) {
  const counts = {};
  const detailed = {};
  for (const r of rows) {
    counts[r.emoji] = (counts[r.emoji] ?? 0) + 1;
    detailed[r.emoji] ??= { emoji: r.emoji, count: 0, me: false, user_ids: [] };
    detailed[r.emoji].count += 1;
    detailed[r.emoji].user_ids.push(r.user_id);
    if (viewerId && r.user_id === viewerId) detailed[r.emoji].me = true;
  }
  return { counts, detailed: Object.values(detailed) };
}

/**
 * Clamp a client-supplied waveform into something safe to store and render.
 *
 * It arrives as an array of 0–100 amplitudes. Untrusted input, so: cap the
 * length (a 10,000-point waveform would bloat every history response for a bar
 * chart 120px wide), clamp each value, and drop anything non-numeric.
 */
const WAVEFORM_POINTS = 64;

function normaliseWaveform(input) {
  if (!Array.isArray(input) || input.length === 0) return null;
  const points = input
    .slice(0, WAVEFORM_POINTS)
    .map((value) => {
      const n = Math.round(Number(value));
      return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : 0;
    });
  return points.join(',');
}

function attachmentToWire(row) {
  return {
    id: row.id,
    file_id: row.file_id,
    url: row.url,
    thumbnail_url: row.thumbnail_url ?? row.url,
    filename: row.filename,
    file_type: getFileType(row.content_type),
    mimetype: row.content_type,
    size: row.size,
    size_human: formatBytes(row.size ?? 0),
    width: row.width,
    height: row.height,
    duration_secs: row.duration_secs,
    // Present only on a voice note; its presence is what tells the client to
    // render a player instead of a file chip.
    waveform: row.waveform ? row.waveform.split(',').map(Number) : null,
    placeholder: row.placeholder ?? null,
    description: row.description,
    is_spoiler: Boolean(row.is_spoiler)
  };
}

/**
 * Hydrate a set of messages with author, attachments, reactions and reply
 * preview — three batched queries regardless of message count, never N+1.
 */
async function hydrate(rows, viewerId = null) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');

  const [attachmentRows, reactionRows] = await Promise.all([
    allQuery(
      `SELECT a.*, f.storage_key, f.visibility, f.mime_type AS file_mime
         FROM attachments a
         JOIN files f ON f.id = a.file_id
        WHERE a.message_id IN (${placeholders})
        ORDER BY a.position ASC`,
      ids
    ),
    allQuery(
      `SELECT message_id, user_id, emoji FROM reactions WHERE message_id IN (${placeholders})`,
      ids
    )
  ]);

  // Resolve URLs through the storage layer so visibility rules are respected.
  const attachmentsByMessage = new Map();
  for (const row of attachmentRows) {
    const file = await getFile(row.file_id);
    const wire = attachmentToWire({
      ...row,
      url: file?.url ?? null,
      placeholder: file?.blurhash ?? null,
      thumbnail_url: file?.variants?.thumb?.url ?? file?.variants?.medium?.url ?? file?.url ?? null
    });
    if (!attachmentsByMessage.has(row.message_id)) attachmentsByMessage.set(row.message_id, []);
    attachmentsByMessage.get(row.message_id).push(wire);
  }

  const reactionsByMessage = new Map();
  for (const r of reactionRows) {
    if (!reactionsByMessage.has(r.message_id)) reactionsByMessage.set(r.message_id, []);
    reactionsByMessage.get(r.message_id).push(r);
  }

  const shaped = rows.map((row) => {
    const { counts, detailed } = aggregateReactions(reactionsByMessage.get(row.id) ?? [], viewerId);
    return {
      id: row.id,
      channel_id: row.channel_id,
      server_id: row.server_id,
      user_id: row.user_id,
      content: row.content,
      type: row.type,
      // Echoed back so a client can replace its optimistic placeholder instead
      // of rendering the message twice.
      nonce: row.nonce ?? null,
      username: row.username,
      // A webhook (incoming, or a channel-follow relay) presents as itself,
      // not as the account that created it.
      display_name: row.webhook_id && row.webhook_name ? row.webhook_name : (row.nickname || row.display_name),
      avatar_url: row.webhook_id && row.webhook_avatar_url ? row.webhook_avatar_url : (row.member_avatar_url || row.avatar_url),
      is_bot: Boolean(row.is_bot),
      is_webhook: Boolean(row.webhook_id),
      webhook_type: row.webhook_type ?? null,
      attachments: attachmentsByMessage.get(row.id) ?? [],
      reactions: counts,           // { '🎉': 4 } — what the current UI reads
      reaction_details: detailed,  // richer form, includes `me` and user ids
      reply_to_id: row.reply_to_id,
      replyToMsg: row.reply_content !== undefined && row.reply_to_id
        ? { content: row.reply_content, display_name: row.reply_author }
        : null,
      mention_everyone: Boolean(row.mention_everyone),
      webhook_id: row.webhook_id ?? null,
      embeds: safeParse(row.embeds, []),
      components: safeParse(row.components, []),
      application_id: row.application_id ?? null,
      ephemeral: Boolean(row.ephemeral_user_id),
      ephemeral_for: row.ephemeral_user_id ?? null,
      sticker: row.sticker_id
        ? { id: row.sticker_id, name: row.sticker_name, url: row.sticker_url, format: row.sticker_format }
        : null,
      pinned: Boolean(row.pinned),
      crossposted: Boolean(Number(row.flags ?? 0) & 1),
      edited_at: row.edited_at,
      created_at: row.created_at
    };
  });

  // Every read path funnels through hydrate(), so attaching polls here is the
  // one place that guarantees history, a single fetch, search results and the
  // realtime echo all carry the same shape.
  return attachPolls(shaped, viewerId);
}

const SELECT_MESSAGE = `
  SELECT m.*,
         u.username, u.display_name, u.avatar_url, u.is_bot,
         sm.nickname, sm.avatar_url AS member_avatar_url,
         rm.content AS reply_content,
         ru.display_name AS reply_author,
         st.name AS sticker_name, st.url AS sticker_url, st.format AS sticker_format,
         wh.name AS webhook_name, wh.avatar_url AS webhook_avatar_url, wh.type AS webhook_type
    FROM messages m
    LEFT JOIN users u  ON u.id = m.user_id
    LEFT JOIN server_members sm ON sm.user_id = m.user_id AND sm.server_id = m.server_id
    LEFT JOIN messages rm ON rm.id = m.reply_to_id
    LEFT JOIN users ru ON ru.id = rm.user_id
    LEFT JOIN stickers st ON st.id = m.sticker_id
    LEFT JOIN webhooks wh ON wh.id = m.webhook_id
`;

/**
 * Fetch a page of channel history, newest last (chat order).
 * Pagination is by snowflake, so it is stable under concurrent inserts —
 * offset pagination would duplicate or skip rows as new messages arrive.
 */
export async function listMessages(channelId, {
  limit = 50, before = null, after = null, around = null, viewerId = null
} = {}) {
  // History is gated exactly like Discord: VIEW_CHANNEL + READ_MESSAGE_HISTORY
  // in a guild, recipient membership in a DM.
  if (viewerId) await assertChannelAccess({ channelId, userId: viewerId, permission: 'READ_MESSAGE_HISTORY' });
  const params = [channelId];
  // An ephemeral reply is a real row (moderation and audit still see it) but
  // only its recipient ever reads it back.
  let where = 'm.channel_id = ? AND m.deleted_at IS NULL'
    + ' AND (m.ephemeral_user_id IS NULL OR m.ephemeral_user_id = ?)';
  params.push(viewerId ?? '');
  let order = 'DESC';

  if (around) {
    // Half the window each side of the anchor.
    const half = Math.floor(limit / 2);
    const older = await allQuery(
      `${SELECT_MESSAGE} WHERE ${where} AND m.id <= ? ORDER BY m.id DESC LIMIT ?`,
      [channelId, viewerId ?? '', around, half + 1]
    );
    const newer = await allQuery(
      `${SELECT_MESSAGE} WHERE ${where} AND m.id > ? ORDER BY m.id ASC LIMIT ?`,
      [channelId, viewerId ?? '', around, half]
    );
    return hydrate([...older.reverse(), ...newer], viewerId);
  }

  if (before) { where += ' AND m.id < ?'; params.push(before); }
  if (after)  { where += ' AND m.id > ?'; params.push(after); order = 'ASC'; }
  params.push(Math.min(limit, 100));

  const rows = await allQuery(
    `${SELECT_MESSAGE} WHERE ${where} ORDER BY m.id ${order} LIMIT ?`, params
  );
  // Always hand back oldest-first; the client appends downward.
  return hydrate(order === 'DESC' ? rows.reverse() : rows, viewerId);
}

export async function getMessage(messageId, viewerId = null) {
  const row = await getQuery(`${SELECT_MESSAGE} WHERE m.id = ? AND m.deleted_at IS NULL`, [messageId]);
  if (!row) return null;
  const [message] = await hydrate([row], viewerId);
  return message;
}

/**
 * Create a message.
 *
 * `attachments` accepts the descriptors returned by /api/upload/attachments —
 * we only trust the file ids in them and re-read the real metadata from the
 * files table, so a client cannot lie about size or dimensions.
 */
/**
 * Every <:name:id> in `content` must be an emoji the sender may use: this
 * server's own, or (with USE_EXTERNAL_EMOJIS) one from another server the
 * sender belongs to. Unknown ids are refused rather than rendered as broken
 * images.
 */
async function assertExternalEmojiAllowed({ content, userId, channel, senderPermissions }) {
  const ids = [...new Set([...String(content).matchAll(/<a?:\w+:(\d+)>/g)].map((m) => m[1]))];
  if (ids.length === 0) return;
  const rows = await allQuery(
    `SELECT e.id, e.server_id FROM emojis e WHERE e.available = 1 AND e.id IN (${ids.map(() => '?').join(',')})`, ids
  );
  if (rows.length !== ids.length) throw new ApiError('Unknown custom emoji', { code: 'EMOJI_UNKNOWN' });
  const foreign = rows.filter((r) => channel.server_id && r.server_id !== channel.server_id);
  if (foreign.length === 0) return;
  if (channel.server_id && !has(senderPermissions, 'USE_EXTERNAL_EMOJIS')) {
    throw ApiError.forbidden('Missing permission: USE_EXTERNAL_EMOJIS');
  }
  const memberOf = new Set((await allQuery(
    `SELECT server_id FROM server_members WHERE user_id = ? AND left_at IS NULL`, [userId]
  )).map((r) => r.server_id));
  if (foreign.some((r) => !memberOf.has(r.server_id))) {
    throw ApiError.forbidden('You can only use emoji from servers you are in');
  }
}

export async function createMessage({
  channelId, userId, content = '', attachments = [], replyToId = null,
  nonce = null, type = 'default', tts = false, skipModeration = false, stickerId = null,
  poll = null, embeds = null, components = null, applicationId = null, ephemeralUserId = null
}) {
  const channel = await getQuery(
    `SELECT id, server_id, rate_limit_per_user, locked, archived, type AS channel_type
       FROM channels WHERE id = ? AND deleted_at IS NULL`,
    [channelId]
  );
  if (!channel) throw ApiError.notFound('Channel');
  if (channel.channel_type === 'forum') {
    // Discord: a forum holds posts, not messages. The body of a post is the
    // first message of its thread — see services/forum.js createPost.
    throw new ApiError('Create a post instead of sending a message in a forum', { code: 'FORUM_NEEDS_POST' });
  }
  if (channel.locked) {
    throw new ApiError('ห้องนี้ถูกล็อก ส่งข้อความไม่ได้', { status: 403, code: 'CHANNEL_LOCKED' });
  }
  if (channel.archived) {
    throw new ApiError('เธรดนี้ถูกเก็บถาวรแล้ว', { status: 403, code: 'THREAD_ARCHIVED' });
  }

  // Webhooks and system messages skip moderation and carry no user; every real
  // sender must be able to see the channel and hold SEND_MESSAGES in it.
  let senderPermissions = '0';
  if (!skipModeration && userId) {
    const access = await assertChannelAccess({
      channelId, userId,
      // Discord gates thread posts on SEND_MESSAGES_IN_THREADS, not SEND_MESSAGES.
      permission: channel.channel_type === 'thread' ? 'SEND_MESSAGES_IN_THREADS' : 'SEND_MESSAGES'
    });
    senderPermissions = access.isDm ? String(ALL_PERMISSIONS) : access.permissions;
    if (!access.isDm && attachments.length > 0 && !has(access.permissions, 'ATTACH_FILES')) {
      throw ApiError.forbidden('Missing permission: ATTACH_FILES');
    }
  }

  // Trim before the emptiness check: a message of only spaces or newlines is
  // empty as far as the user is concerned, and Discord rejects it too.
  const trimmed = String(content ?? '').trim().slice(0, 4000);
  let sticker = null;
  if (stickerId) {
    sticker = await getQuery(`SELECT id, server_id FROM stickers WHERE id = ? AND available = 1`, [stickerId]);
    if (!sticker) throw ApiError.notFound('Sticker');
    // Guild stickers are usable in that guild and in DMs (Discord lets you use
    // stickers from servers you are in when messaging friends).
    if (sticker.server_id && channel.server_id && sticker.server_id !== channel.server_id) {
      throw ApiError.forbidden('That sticker belongs to another server');
    }
  }
  // A bot may say nothing but show an embed or a set of buttons.
  const richEmbeds = embeds ? validateEmbeds(embeds) : [];
  const messageComponents = components ? validateComponents(components) : [];
  if (!trimmed && attachments.length === 0 && !sticker && !poll
      && richEmbeds.length === 0 && messageComponents.length === 0) {
    throw new ApiError('A message needs content or an attachment', { code: 'EMPTY_MESSAGE' });
  }

  // Custom emoji from *another* server need USE_EXTERNAL_EMOJIS here, and the
  // sender must actually be in that server — otherwise anyone could paste any
  // emoji id. Emoji of this server, and any emoji in a DM, are always fine.
  if (userId && !skipModeration && trimmed.includes('<')) {
    await assertExternalEmojiAllowed({ content: trimmed, userId, channel, senderPermissions });
  }

  // A poll message's substance lives in the polls table, so it is created with
  // type 'poll' and the question is validated before the message row exists —
  // an invalid poll must not leave an empty message behind.
  let pollInput = null;
  if (poll) {
    pollInput = validatePollInput(poll);
    type = 'poll';
  }

  // Client-supplied nonce makes retries idempotent: a dropped ack must not
  // produce a duplicate message.
  if (nonce) {
    const existing = await getQuery(
      `SELECT id FROM messages WHERE channel_id = ? AND user_id = ? AND nonce = ?`,
      [channelId, userId, nonce]
    );
    if (existing) {
      // A retried send must not fan out again — the first attempt already did.
      return withDelivery(await getMessage(existing.id, userId), {
        notifications: [], audience: [], duplicate: true
      });
    }
  }

  // Moderation runs before anything is written, so a blocked message never
  // exists — not even as a soft-deleted row.
  if (!skipModeration) {
    const { roleIds } = channel.server_id
      ? await resolveSenderContext(channel.server_id, userId)
      : { roleIds: [] };
    const permissions = senderPermissions;

    await automod.assertCanSpeak({
      serverId: channel.server_id, channelId, userId, permissions
    });

    const verdict = await automod.evaluate({
      serverId: channel.server_id, channelId, userId,
      content: trimmed, memberRoleIds: roleIds, permissions
    });
    if (verdict.blocked) {
      await automod.logHit({
        serverId: channel.server_id, userId, channelId,
        rule: verdict.rule, reason: verdict.reason, content: trimmed
      });
      throw new ApiError(`ข้อความถูกบล็อกโดย AutoMod: ${verdict.reason}`, {
        status: 403, code: 'AUTOMOD_BLOCKED',
        details: { rule: verdict.rule?.name, reason: verdict.reason }
      });
    }
  }

  if (replyToId) {
    const target = await getQuery(
      `SELECT id FROM messages WHERE id = ? AND channel_id = ? AND deleted_at IS NULL`, [replyToId, channelId]
    );
    // Replying to a message that is gone is allowed on Discord too — the reply
    // just renders without its quote — but a reply must stay inside its channel.
    if (!target) replyToId = null;
  }

  const mentions = parseMentions(trimmed);
  const messageId = generateId();
  let notifications = [];

  await transaction(async () => {
    await runQuery(
      `INSERT INTO messages (id, channel_id, server_id, user_id, content, type,
                             reply_to_id, mention_everyone, tts, nonce, sticker_id,
                             embeds, components, application_id, ephemeral_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [messageId, channelId, channel.server_id, userId, trimmed,
       replyToId ? 'reply' : type, replyToId, mentions.everyone ? 1 : 0, tts ? 1 : 0, nonce,
       sticker?.id ?? null, JSON.stringify(richEmbeds), JSON.stringify(messageComponents),
       applicationId, ephemeralUserId]
    );

    await runQuery(
      `INSERT INTO messages_fts (content, message_id, channel_id) VALUES (?, ?, ?)`,
      [trimmed, messageId, channelId]
    );

    let position = 0;
    for (const descriptor of attachments) {
      // `file_id` first: an attachment coming back from the API carries the
      // attachments-row id in `id`, and forwarding one would otherwise look up
      // the wrong table and silently drop the file.
      const fileId = descriptor?.file_id ?? descriptor?.id;
      if (!fileId) continue;
      const file = await getQuery(
        `SELECT * FROM files WHERE id = ? AND deleted_at IS NULL`, [fileId]
      );
      if (!file) continue; // silently drop unknown ids rather than 500

      // The waveform is the one field the client is the authority on — it is a
      // visual summary of audio the browser already decoded, and re-deriving it
      // server-side would mean decoding every upload for a purely cosmetic bar
      // chart. Duration comes from the server's own probe, because that one
      // matters and a client could lie about it.
      const waveform = normaliseWaveform(descriptor.waveform);

      await runQuery(
        `INSERT INTO attachments (id, message_id, file_id, filename, description,
                                  content_type, size, width, height, duration_secs,
                                  waveform, is_spoiler, position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [generateId(), messageId, file.id, file.original_name,
         descriptor.description ?? null, file.mime_type, file.size,
         file.width, file.height, file.duration_secs ?? null,
         waveform, descriptor.is_spoiler ? 1 : 0, position++]
      );
      await addReference(file.id);
    }

    if (pollInput) {
      await writePollRows({ messageId, channelId, clean: pollInput });
    }

    for (const [targetType, list] of [['user', mentions.users], ['role', mentions.roles], ['channel', mentions.channels]]) {
      for (const targetId of list) {
        await runQuery(
          `INSERT OR IGNORE INTO mentions (message_id, target_type, target_id) VALUES (?, ?, ?)`,
          [messageId, targetType, targetId]
        );
      }
    }

    await runQuery(
      `UPDATE channels
          SET last_message_id = ?, message_count = message_count + 1,
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
      [messageId, channelId]
    );

    // Posting in a thread joins it, so you receive its later messages —
    // Discord does the same.
    if (channel.channel_type === 'thread' && userId) {
      await runQuery(
        `INSERT OR IGNORE INTO channel_recipients (channel_id, user_id) VALUES (?, ?)`,
        [channelId, userId]
      );
      await runQuery(
        `UPDATE channels SET member_count = (
           SELECT count(*) FROM channel_recipients WHERE channel_id = ?
         ) WHERE id = ?`,
        [channelId, channelId]
      );
    }

    // A new message re-opens a DM the recipient had closed, as on Discord.
    if (!channel.server_id) {
      await runQuery(`UPDATE channel_recipients SET closed = 0 WHERE channel_id = ?`, [channelId]);
    }

    // The author has, by definition, read their own message. A webhook whose
    // creator has since been deleted posts with no user at all, and
    // read_states.user_id is NOT NULL — so skip rather than fail the insert.
    if (userId) {
      await runQuery(
        `INSERT INTO read_states (user_id, channel_id, last_read_message_id, mention_count, last_viewed_at)
         VALUES (?, ?, ?, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(user_id, channel_id)
         DO UPDATE SET last_read_message_id = excluded.last_read_message_id,
                       last_viewed_at = excluded.last_viewed_at`,
        [userId, channelId, messageId]
      );
    }
  });

  // Everyone else in the channel gains an unread, and a mention if named.
  //
  // Deliberately outside the transaction above: resolving VIEW_CHANNEL for each
  // member is several queries per person, and holding SQLite's single write
  // lock for a 500-member guild would serialise every other write behind one
  // message. A failure here must also not un-send a message that was accepted.
  try {
    notifications = await bumpUnreadCounters({
      channelId, serverId: channel.server_id, authorId: userId, mentions,
      messageId, preview: trimmed.slice(0, 200), authorPermissions: senderPermissions,
      channelType: channel.channel_type
    });
  } catch (err) {
    console.error('unread fan-out failed for', messageId, err.message);
    notifications = [];
  }

  const message = await getMessage(messageId, userId);
  // Delivery metadata for the caller's fan-out. Non-enumerable so it never
  // reaches a client: `audience` is the id list of everyone who can see the
  // channel, and `notifications` carries other people's ids and the preview.
  return withDelivery(message, { notifications, audience: notifications.reached ?? [] });
}

/**
 * Bump unread/mention counters and write a notification row per mentioned user.
 *
 * This lives in the service, not the socket layer, so a message created over
 * REST produces exactly the same side effects as one created over the gateway.
 * Returns the notification rows so the caller can push them to live clients.
 */
async function bumpUnreadCounters({
  channelId, serverId, authorId, mentions, messageId, preview, authorPermissions = '0',
  channelType = 'text'
}) {
  // A thread notifies the people in it, not the whole guild — otherwise every
  // member collects an unread for every thread anyone opens.
  const isThread = channelType === 'thread';
  const audience = isThread
    ? await allQuery(
        `SELECT cr.user_id, u.status FROM channel_recipients cr
           JOIN users u ON u.id = cr.user_id
          WHERE cr.channel_id = ?`,
        [channelId]
      )
    : serverId
    ? await allQuery(
        `SELECT sm.user_id, u.status FROM server_members sm
           JOIN users u ON u.id = sm.user_id
          WHERE sm.server_id = ? AND sm.left_at IS NULL`,
        [serverId]
      )
    : await allQuery(
        `SELECT cr.user_id, u.status FROM channel_recipients cr
           JOIN users u ON u.id = cr.user_id
          WHERE cr.channel_id = ?`,
        [channelId]
      );

  const mentionedUsers = new Set(mentions.users);
  const mentionedRoles = new Set(mentions.roles);
  // @everyone / @here are only mentions when the author may actually use them.
  const canMentionEveryone = has(authorPermissions, 'MENTION_EVERYONE');
  const notifications = [];
  const reached = [];

  for (const { user_id: uid, status } of audience) {
    if (uid === authorId) continue;

    // Nobody gets an unread for a channel they cannot see — the unread marker
    // alone would leak the existence of a private channel, and the notification
    // body would leak its content.
    if (serverId && !(await canInChannel({ channelId, userId: uid, permission: 'VIEW_CHANNEL' }))) {
      continue;
    }
    reached.push(uid);

    let isMention = !serverId || mentionedUsers.has(uid);
    if (!isMention && canMentionEveryone) {
      if (mentions.everyone) isMention = true;
      else if (mentions.here && status && status !== 'offline' && status !== 'invisible') isMention = true;
    }
    if (!isMention && mentionedRoles.size > 0 && serverId) {
      const hit = await getQuery(
        `SELECT 1 FROM member_roles
          WHERE server_id = ? AND user_id = ? AND role_id IN (${[...mentionedRoles].map(() => '?').join(',')})
          LIMIT 1`,
        [serverId, uid, ...mentionedRoles]
      );
      if (hit) isMention = true;
    }

    await runQuery(
      `INSERT INTO read_states (user_id, channel_id, mention_count)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id, channel_id)
       DO UPDATE SET mention_count = mention_count + ?`,
      [uid, channelId, isMention ? 1 : 0, isMention ? 1 : 0]
    );

    if (!isMention) continue;

    // Muting the channel or the whole server both suppress the notification.
    const muted = await getQuery(
      `SELECT 1 FROM channel_settings
        WHERE user_id = ? AND channel_id = ? AND muted = 1
          AND (muted_until IS NULL OR muted_until > strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      [uid, channelId]
    );
    if (muted) continue;
    if (serverId) {
      const serverMuted = await getQuery(
        `SELECT 1 FROM server_settings WHERE user_id = ? AND server_id = ? AND muted = 1`,
        [uid, serverId]
      );
      if (serverMuted) continue;
    }

    const id = generateId();
    const type = serverId ? 'mention' : 'dm';
    await runQuery(
      `INSERT INTO notifications (id, user_id, type, server_id, channel_id, message_id, actor_id, body)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, uid, type, serverId, channelId, messageId, authorId, preview]
    );
    notifications.push({
      id, user_id: uid, type, server_id: serverId, channel_id: channelId,
      message_id: messageId, actor_id: authorId, body: preview, preview
    });
  }

  // `reached` is who may see the channel — the gateway uses it so a private
  // channel's activity ping does not go to the whole guild. Non-enumerable so
  // it cannot be mistaken for a notification row by anything iterating this.
  Object.defineProperty(notifications, 'reached', { value: reached, enumerable: false });
  return notifications;
}

export async function editMessage({ messageId, userId, content, embeds = undefined, components = undefined }) {
  const message = await getQuery(
    `SELECT * FROM messages WHERE id = ? AND deleted_at IS NULL`, [messageId]
  );
  if (!message) throw ApiError.notFound('Message');
  if (message.user_id !== userId) throw ApiError.forbidden('You can only edit your own messages');

  // An edit may change the text, the embeds, the components, or any mix. A
  // bot updating only its buttons should not have to resend the text.
  const keepsContent = content === undefined || content === null;
  const trimmed = keepsContent ? String(message.content ?? '') : String(content).trim().slice(0, 4000);
  const nextEmbeds = embeds === undefined ? null : JSON.stringify(validateEmbeds(embeds));
  const nextComponents = components === undefined ? null : JSON.stringify(validateComponents(components));
  const willHaveEmbeds = nextEmbeds !== null ? nextEmbeds !== '[]' : (message.embeds ?? '[]') !== '[]';
  const willHaveComponents = nextComponents !== null ? nextComponents !== '[]' : (message.components ?? '[]') !== '[]';
  if (!trimmed && !willHaveEmbeds && !willHaveComponents) {
    throw new ApiError('An edit cannot empty a message — delete it instead', { code: 'EMPTY_MESSAGE' });
  }
  const mentions = parseMentions(trimmed);

  await transaction(async () => {
    // Keep the previous revision so an edit history is possible later.
    await runQuery(
      `INSERT INTO message_edits (id, message_id, content) VALUES (?, ?, ?)`,
      [generateId(), messageId, message.content]
    );
    await runQuery(
      `UPDATE messages
          SET content = ?, mention_everyone = ?,
              embeds = COALESCE(?, embeds), components = COALESCE(?, components),
              edited_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?`,
      [trimmed, mentions.everyone ? 1 : 0, nextEmbeds, nextComponents, messageId]
    );
    await runQuery(`DELETE FROM messages_fts WHERE message_id = ?`, [messageId]);
    await runQuery(
      `INSERT INTO messages_fts (content, message_id, channel_id) VALUES (?, ?, ?)`,
      [trimmed, messageId, message.channel_id]
    );
  });

  return getMessage(messageId, userId);
}

/**
 * Soft-delete a message and release its attachment references so the bytes
 * become GC-eligible once nothing else points at them.
 */
export async function deleteMessage({ messageId, userId, canManageMessages = false }) {
  const message = await getQuery(
    `SELECT * FROM messages WHERE id = ? AND deleted_at IS NULL`, [messageId]
  );
  if (!message) return null;
  if (message.user_id !== userId && !canManageMessages) {
    // Not the author: a moderator with MANAGE_MESSAGES in this channel may still delete.
    let allowed = false;
    if (userId) {
      try {
        const access = await assertChannelAccess({ channelId: message.channel_id, userId });
        allowed = !access.isDm && has(access.permissions, 'MANAGE_MESSAGES');
      } catch { allowed = false; }
    }
    if (!allowed) throw ApiError.forbidden('You cannot delete this message');
  }

  await transaction(async () => {
    const attachments = await allQuery(
      `SELECT file_id FROM attachments WHERE message_id = ?`, [messageId]
    );
    for (const a of attachments) await releaseReference(a.file_id);

    await runQuery(
      `UPDATE messages SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      [messageId]
    );
    await runQuery(`DELETE FROM messages_fts WHERE message_id = ?`, [messageId]);
    await runQuery(
      `UPDATE channels SET message_count = MAX(0, message_count - 1) WHERE id = ?`,
      [message.channel_id]
    );
  });

  return { id: messageId, channel_id: message.channel_id };
}

/** Toggle one user's reaction. Returns the fresh aggregate for broadcasting. */
export async function toggleReaction({ messageId, userId, emoji, emojiId = null }) {
  const message = await getQuery(
    `SELECT id, channel_id FROM messages WHERE id = ? AND deleted_at IS NULL`, [messageId]
  );
  if (!message) throw ApiError.notFound('Message');
  if (userId) {
    const access = await assertChannelAccess({ channelId: message.channel_id, userId });
    // Discord: ADD_REACTIONS is needed to start a *new* reaction; joining an
    // existing one only needs VIEW_CHANNEL.
    if (!access.isDm && !has(access.permissions, 'ADD_REACTIONS')) {
      const already = await getQuery(
        `SELECT 1 FROM reactions WHERE message_id = ? AND emoji = ? LIMIT 1`, [messageId, emoji]
      );
      if (!already) throw ApiError.forbidden('Missing permission: ADD_REACTIONS');
    }
    if (emojiId) {
      const custom = await getQuery(`SELECT server_id FROM emojis WHERE id = ? AND available = 1`, [emojiId]);
      if (!custom) throw new ApiError('Unknown custom emoji', { code: 'EMOJI_UNKNOWN' });
      const msgChannel = await getQuery(`SELECT server_id FROM channels WHERE id = ?`, [message.channel_id]);
      if (msgChannel?.server_id && custom.server_id !== msgChannel.server_id) {
        if (!access.isDm && !has(access.permissions, 'USE_EXTERNAL_EMOJIS')) {
          throw ApiError.forbidden('Missing permission: USE_EXTERNAL_EMOJIS');
        }
        const member = await getQuery(
          `SELECT 1 FROM server_members WHERE user_id = ? AND server_id = ? AND left_at IS NULL`, [userId, custom.server_id]
        );
        if (!member) throw ApiError.forbidden('You can only use emoji from servers you are in');
      }
    }
  }

  const existing = await getQuery(
    `SELECT 1 FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?`,
    [messageId, userId, emoji]
  );

  if (existing) {
    await runQuery(
      `DELETE FROM reactions WHERE message_id = ? AND user_id = ? AND emoji = ?`,
      [messageId, userId, emoji]
    );
  } else {
    await runQuery(
      `INSERT INTO reactions (message_id, user_id, emoji, emoji_id) VALUES (?, ?, ?, ?)`,
      [messageId, userId, emoji, emojiId]
    );
  }

  const rows = await allQuery(
    `SELECT message_id, user_id, emoji FROM reactions WHERE message_id = ?`, [messageId]
  );
  const { counts, detailed } = aggregateReactions(rows, userId);
  return {
    messageId,
    channelId: message.channel_id,
    reactions: counts,
    reaction_details: detailed,
    added: !existing
  };
}

export async function setPinned({ messageId, channelId, userId, pinned }) {
  const message = await getQuery(
    `SELECT id, channel_id FROM messages WHERE id = ? AND deleted_at IS NULL`, [messageId]
  );
  if (!message) throw ApiError.notFound('Message');
  // Trust the message's own channel, not whatever the client claimed.
  channelId = message.channel_id;
  if (userId) {
    const access = await assertChannelAccess({ channelId, userId });
    if (!access.isDm && !has(access.permissions, 'MANAGE_MESSAGES')) {
      throw ApiError.forbidden('Missing permission: MANAGE_MESSAGES');
    }
  }
  if (pinned) {
    const { n } = await getQuery(`SELECT count(*) AS n FROM pins WHERE channel_id = ?`, [channelId]);
    if (n >= 50) throw new ApiError('ปักหมุดได้สูงสุด 50 ข้อความต่อห้อง', { code: 'MAX_PINS' });
  }
  await transaction(async () => {
    await runQuery(`UPDATE messages SET pinned = ? WHERE id = ?`, [pinned ? 1 : 0, messageId]);
    if (pinned) {
      await runQuery(
        `INSERT OR IGNORE INTO pins (channel_id, message_id, pinned_by) VALUES (?, ?, ?)`,
        [channelId, messageId, userId]
      );
      await runQuery(
        `UPDATE channels SET last_pin_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
        [channelId]
      );
    } else {
      await runQuery(
        `DELETE FROM pins WHERE channel_id = ? AND message_id = ?`, [channelId, messageId]
      );
    }
  });
  return getMessage(messageId, userId);
}

export async function listPins(channelId, viewerId = null) {
  if (viewerId) {
    await assertChannelAccess({ channelId, userId: viewerId, permission: 'READ_MESSAGE_HISTORY' });
  }
  const rows = await allQuery(
    `${SELECT_MESSAGE}
      JOIN pins p ON p.message_id = m.id
     WHERE p.channel_id = ? AND m.deleted_at IS NULL
     ORDER BY p.pinned_at DESC`,
    [channelId]
  );
  return hydrate(rows, viewerId);
}

/** Full-text search, optionally scoped to a channel or a server. */
export async function searchMessages({
  query, channelId = null, serverId = null, authorId = null, hasAttachment = false,
  limit = 25, viewerId = null
}) {
  // `from:`, `in:`, `has:` and the date operators are part of the query string
  // itself, exactly as they are on Discord.
  const parsed = parseSearchQuery(query);
  const term = parsed.term;
  // A query that is nothing but operators is still a search — "everything user-2
  // ever posted here" is a perfectly ordinary thing to ask for.
  if (!term && !hasFilters(parsed.filters)) return [];

  const where = ['m.deleted_at IS NULL'];
  const filterParams = [];
  if (channelId) { where.push('m.channel_id = ?'); filterParams.push(channelId); }
  if (serverId)  { where.push('m.server_id = ?');  filterParams.push(serverId); }
  if (authorId)  { where.push('m.user_id = ?');    filterParams.push(authorId); }
  if (hasAttachment) where.push('EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id)');

  // --- operator filters ------------------------------------------------------
  // Names are resolved to ids here rather than in the parser, because a name
  // lookup needs the database and an id must never be guessed from user text.
  const resolveUsers = async (names) => {
    const ids = [];
    for (const name of names) {
      const row = await getQuery(
        `SELECT id FROM users WHERE (id = ? OR username = ? OR display_name = ?) AND deleted_at IS NULL LIMIT 1`,
        [name, name, name]
      );
      // An unmatched name must narrow to nothing, not widen to everything.
      ids.push(row?.id ?? '~none~');
    }
    return ids;
  };

  const inList = (column, values) => {
    where.push(`${column} IN (${values.map(() => '?').join(',')})`);
    filterParams.push(...values);
  };

  if (parsed.filters.from.length) inList('m.user_id', await resolveUsers(parsed.filters.from));

  if (parsed.filters.mentions.length) {
    const mentionIds = await resolveUsers(parsed.filters.mentions);
    where.push(`EXISTS (SELECT 1 FROM mentions mn WHERE mn.message_id = m.id
                          AND mn.target_type = 'user' AND mn.target_id IN (${
      mentionIds.map(() => '?').join(',')}))`);
    filterParams.push(...mentionIds);
  }

  if (parsed.filters.in.length) {
    const channelIds = [];
    for (const name of parsed.filters.in) {
      const row = await getQuery(
        `SELECT id FROM channels WHERE (id = ? OR name = ?) AND deleted_at IS NULL
           ${serverId ? 'AND server_id = ?' : ''} LIMIT 1`,
        serverId ? [name, name, serverId] : [name, name]
      );
      channelIds.push(row?.id ?? '~none~');
    }
    inList('m.channel_id', channelIds);
  }

  for (const kind of parsed.filters.has) {
    if (kind === 'link' || kind === 'embed') {
      where.push(kind === 'link'
        ? `m.content LIKE '%http%'`
        : `(m.embeds IS NOT NULL AND m.embeds <> '[]')`);
    } else if (kind === 'poll') {
      where.push(`EXISTS (SELECT 1 FROM polls p WHERE p.message_id = m.id)`);
    } else if (kind === 'sticker') {
      where.push(`m.sticker_id IS NOT NULL`);
    } else if (kind === 'image' || kind === 'video' || kind === 'sound') {
      const prefix = kind === 'sound' ? 'audio/' : `${kind}/`;
      where.push(`EXISTS (SELECT 1 FROM attachments a JOIN files f ON f.id = a.file_id
                           WHERE a.message_id = m.id AND f.mime_type LIKE ?)`);
      filterParams.push(`${prefix}%`);
    } else {
      where.push(`EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id)`);
    }
  }

  if (parsed.filters.pinned !== null) where.push(`m.pinned = ${parsed.filters.pinned ? 1 : 0}`);

  // Dates compare against created_at, which is ISO-8601 UTC text — so a plain
  // string comparison is also a chronological one.
  if (parsed.filters.before) { where.push('m.created_at < ?'); filterParams.push(`${parsed.filters.before}T00:00:00.000Z`); }
  if (parsed.filters.after)  { where.push('m.created_at > ?'); filterParams.push(`${parsed.filters.after}T23:59:59.999Z`); }
  if (parsed.filters.during) {
    const bounds = periodBounds(parsed.filters.during);
    where.push('m.created_at BETWEEN ? AND ?');
    filterParams.push(bounds.from, bounds.to);
  }

  const cap = Math.min(limit, 100);
  const projection = `
    SELECT m.*,
           u.username, u.display_name, u.avatar_url, u.is_bot,
           sm.nickname, sm.avatar_url AS member_avatar_url,
           NULL AS reply_content, NULL AS reply_author
  `;
  const joins = `
      LEFT JOIN users u ON u.id = m.user_id
      LEFT JOIN server_members sm ON sm.user_id = m.user_id AND sm.server_id = m.server_id
  `;

  let rows;
  if (!term) {
    // Operators only — no text to match, so the filters are the whole query.
    rows = await allQuery(
      `${projection} FROM messages m ${joins}
        WHERE ${where.join(' AND ')} ORDER BY m.id DESC LIMIT ?`,
      [...filterParams, cap]
    );
  } else if (term.length >= 3) {
    // The trigram tokenizer treats a double-quoted string as a literal
    // substring, so no FTS operators can leak in from user input.
    const ftsQuery = `"${term.replace(/"/g, '""')}"`;
    rows = await allQuery(
      `${projection}
         FROM messages_fts fts
         JOIN messages m ON m.id = fts.message_id
         ${joins}
        WHERE messages_fts MATCH ? AND ${where.join(' AND ')}
        ORDER BY m.id DESC LIMIT ?`,
      [ftsQuery, ...filterParams, cap]
    );
  } else {
    // Trigram needs three characters. One- and two-character searches (common
    // in Thai and CJK) fall back to a scan, bounded by the same filters.
    rows = await allQuery(
      `${projection}
         FROM messages m
         ${joins}
        WHERE m.content LIKE ? ESCAPE '\\' AND ${where.join(' AND ')}
        ORDER BY m.id DESC LIMIT ?`,
      [`%${term.replace(/[\\%_]/g, '\\$&')}%`, ...filterParams, cap]
    );
  }
  // Results are filtered to channels the viewer can actually see — a search
  // must never leak content from a private channel or someone else's DM.
  if (viewerId) {
    const verdicts = new Map();
    const visible = [];
    for (const row of rows) {
      if (!verdicts.has(row.channel_id)) {
        verdicts.set(row.channel_id, await canInChannel({
          channelId: row.channel_id, userId: viewerId, permission: 'READ_MESSAGE_HISTORY'
        }));
      }
      if (verdicts.get(row.channel_id)) visible.push(row);
    }
    rows = visible;
  }
  return hydrate(rows, viewerId);
}

/**
 * Attach resolved link previews to a stored message.
 *
 * Deliberately separate from createMessage: unfurling makes an outbound HTTP
 * request, and a slow or hostile site must never delay the message reaching the
 * channel. The caller sends the message first, then calls this and emits an
 * update when embeds arrive.
 */
export async function attachEmbeds(messageId, embeds) {
  if (!embeds?.length) return null;
  await runQuery(`UPDATE messages SET embeds = ? WHERE id = ?`, [JSON.stringify(embeds), messageId]);
  return getMessage(messageId);
}

/**
 * Move the read marker. Passing no messageId means "read everything currently
 * in this channel" — writing NULL instead would erase the pointer and make the
 * whole channel unread again. Passing an explicit null marker (mark-as-unread)
 * is done through `markUnread` below.
 */
export async function markRead({ userId, channelId, messageId }) {
  if (userId) await assertChannelAccess({ channelId, userId });
  let target = messageId ?? null;
  if (!target) {
    const channel = await getQuery(`SELECT last_message_id FROM channels WHERE id = ?`, [channelId]);
    target = channel?.last_message_id ?? null;
  }
  await runQuery(
    `INSERT INTO read_states (user_id, channel_id, last_read_message_id, mention_count, last_viewed_at)
     VALUES (?, ?, ?, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(user_id, channel_id)
     DO UPDATE SET last_read_message_id = COALESCE(excluded.last_read_message_id, read_states.last_read_message_id),
                   mention_count = 0,
                   last_viewed_at = excluded.last_viewed_at`,
    [userId, channelId, target]
  );
  return { channel_id: channelId, last_read_message_id: target, mention_count: 0, unread: 0 };
}

/** Deliberately move the marker backwards — Discord's "Mark as unread". */
export async function markUnread({ userId, channelId, beforeMessageId = null }) {
  if (userId) await assertChannelAccess({ channelId, userId });
  await runQuery(
    `INSERT INTO read_states (user_id, channel_id, last_read_message_id, last_viewed_at)
     VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     ON CONFLICT(user_id, channel_id)
     DO UPDATE SET last_read_message_id = excluded.last_read_message_id`,
    [userId, channelId, beforeMessageId]
  );
  return { channel_id: channelId, last_read_message_id: beforeMessageId, unread: 1 };
}

/** Unread counts for every channel the user can see — drives the sidebar badges. */
export async function getUnreadSummary(userId) {
  const rows = await allQuery(
    `SELECT c.id AS channel_id, c.server_id,
            rs.last_read_message_id, rs.mention_count,
            c.last_message_id,
            CASE WHEN c.last_message_id IS NOT NULL
                  AND (rs.last_read_message_id IS NULL
                       OR c.last_message_id > rs.last_read_message_id)
                 THEN 1 ELSE 0 END AS unread
       FROM channels c
       LEFT JOIN read_states rs ON rs.channel_id = c.id AND rs.user_id = ?
      WHERE c.deleted_at IS NULL
        AND c.type NOT IN ('category', 'voice')
        AND (
          -- Guild channels you are a member of, but a thread only once you are
          -- actually in it: Discord does not badge every thread in the server.
          (c.server_id IN (SELECT server_id FROM server_members WHERE user_id = ? AND left_at IS NULL)
           AND (c.type != 'thread'
                OR c.id IN (SELECT channel_id FROM channel_recipients WHERE user_id = ?)))
          -- DMs and group DMs you have not closed.
          OR c.id IN (
            SELECT channel_id FROM channel_recipients WHERE user_id = ? AND closed = 0
          )
        )`,
    [userId, userId, userId, userId]
  );

  // Filter to what the member may actually view, so the sidebar cannot reveal
  // the existence of a private channel through an unread badge.
  const visible = [];
  for (const row of rows) {
    if (!row.server_id) { visible.push(row); continue; }
    if (await canInChannel({ channelId: row.channel_id, userId, permission: 'VIEW_CHANNEL' })) {
      visible.push(row);
    }
  }
  return visible;
}

/**
 * The edit trail of one message, newest first.
 *
 * Every edit already writes a `message_edits` row; until now nothing read them
 * back. Discord shows the trail to anyone who can read the channel, which is
 * the right default: an edited message that quietly changed meaning is exactly
 * what people want to check.
 */
export async function listEditHistory(messageId, viewerId) {
  const message = await getQuery(
    `SELECT id, channel_id, content, edited_at FROM messages WHERE id = ? AND deleted_at IS NULL`,
    [messageId]
  );
  if (!message) throw ApiError.notFound('Message');
  await assertChannelAccess({
    channelId: message.channel_id, userId: viewerId, permission: 'READ_MESSAGE_HISTORY'
  });

  const revisions = await allQuery(
    `SELECT id, content, edited_at FROM message_edits WHERE message_id = ? ORDER BY edited_at DESC`,
    [messageId]
  );
  // The current text is the head of the trail, so the client can diff pairs
  // without special-casing "now".
  return {
    message_id: messageId,
    revisions: [
      { id: 'current', content: message.content, edited_at: message.edited_at, current: true },
      ...revisions
    ]
  };
}

// Discord's bulk delete: at most 100 at a time, and nothing older than two
// weeks — the age limit is what stops it being a "wipe the channel" button.
const BULK_DELETE_MAX = 100;
const BULK_DELETE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Delete many messages in one action. Returns the ids actually removed, so the
 * caller can emit one `messages_bulk_deleted` rather than a hundred events.
 */
export async function bulkDeleteMessages({ channelId, messageIds, userId }) {
  await assertChannelAccess({ channelId, userId, permission: 'MANAGE_MESSAGES' });

  const ids = [...new Set((messageIds ?? []).map(String))];
  if (ids.length < 2) {
    throw new ApiError('Bulk delete needs at least two messages', { code: 'BULK_TOO_FEW' });
  }
  if (ids.length > BULK_DELETE_MAX) {
    throw new ApiError(`Bulk delete is limited to ${BULK_DELETE_MAX} messages`, { code: 'BULK_TOO_MANY' });
  }

  const cutoff = new Date(Date.now() - BULK_DELETE_MAX_AGE_MS).toISOString();
  const rows = await allQuery(
    `SELECT id, created_at FROM messages
      WHERE id IN (${ids.map(() => '?').join(',')}) AND channel_id = ? AND deleted_at IS NULL`,
    [...ids, channelId]
  );
  // A message from another channel, or one already gone, is not an error — but
  // an over-age message is, because silently skipping it would leave the
  // moderator believing the channel was cleared when it was not.
  const tooOld = rows.filter((r) => r.created_at < cutoff);
  if (tooOld.length) {
    throw new ApiError('Bulk delete cannot remove messages older than 14 days', {
      code: 'BULK_TOO_OLD', details: { count: tooOld.length }
    });
  }

  const deletable = rows.map((r) => r.id);
  if (!deletable.length) return { channel_id: channelId, ids: [] };

  await runQuery(
    `UPDATE messages SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id IN (${deletable.map(() => '?').join(',')})`,
    deletable
  );
  return { channel_id: channelId, ids: deletable };
}
