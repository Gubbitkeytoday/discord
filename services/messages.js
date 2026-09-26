// ============================================================================
//  Message service — the read/write path for chat.
//
//  Storage is normalised (attachments, reactions and mentions are their own
//  tables) but the wire format stays flat and denormalised, because that is
//  what a chat client needs to render a row without extra round trips.
// ============================================================================

import { runQuery, getQuery, allQuery, transaction, sql, isPostgres } from '../db.js';
import { generateId } from '../lib/snowflake.js';
import { withUrls, addReference, releaseReference, formatBytes } from '../storageService.js';
import { validateEmbeds, validateComponents } from './applications.js';
import { getFileType } from '../lib/mediaProbe.js';
import { ApiError } from '../lib/httpUtils.js';
import { computeBasePermissions, ALL_PERMISSIONS, has } from '../lib/permissions.js';
import * as automod from './automod.js';
import { assertChannelAccess, canInChannel, readableChannelIds } from './access.js';
import { validatePollInput, writePollRows, attachPolls } from './polls.js';
import { parseSearchQuery, hasFilters, periodBounds } from '../lib/searchQuery.js';
import { fanOutMessageNotifications, visibleChannelIds } from './notifications.js';
import { consumeShared } from '../lib/rateLimit.js';

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

/**
 * The wire shape of one attachment. `row` is the attachments row; `file` is
 * the files row resolved through storageService.withUrls (null when the file
 * is gone). Media fields come from the file, because the media pipeline fills
 * them in *after* the message is posted (dimensions of a HEIC, a video's
 * poster, renditions finishing in the background) — the copies on the
 * attachments row are only what was known at send time.
 *
 * Everything the client needs to render without layout shift and at the right
 * size, matching the /api/upload descriptor (routes/files.js toDescriptor):
 *   width/height    display size, EXIF orientation applied
 *   thumbhash       ~25-byte placeholder (base64), `placeholder` the older data URI
 *   renditions      [{ format, width, height, url, … }] and `srcset` per format
 *   display_url     /api/media/<id>: best format for the browser (?w=<px>)
 *   poster_url      first frame of a video
 *   media_status    'ready' | 'processing' | 'failed' | 'unsupported' | null
 *   download_url    the original, as an attachment
 */
function attachmentToWire(row, file = null) {
  const variants = file?.variants ?? {};
  return {
    id: row.id,
    file_id: row.file_id,
    url: file?.url ?? null,
    thumbnail_url: variants.thumb?.url ?? variants.medium?.url ?? file?.url ?? null,
    download_url: file?.download_url ?? (row.file_id ? `/api/files/${row.file_id}?download=1` : null),
    display_url: file?.display_url ?? null,
    poster_url: variants.poster?.url ?? null,
    filename: row.filename,
    // withUrls downgrades undisplayable media (HEIC without a decoder) to 'file'.
    file_type: file?.file_type ?? getFileType(row.content_type),
    mimetype: row.content_type,
    size: row.size,
    size_human: formatBytes(row.size ?? 0),
    width: file?.width ?? row.width,
    height: file?.height ?? row.height,
    duration_secs: file?.duration_secs ?? row.duration_secs,
    is_animated: Boolean(file?.is_animated),
    // Present only on a voice note; its presence is what tells the client to
    // render a player instead of a file chip.
    waveform: row.waveform ? row.waveform.split(',').map(Number) : null,
    placeholder: file?.blurhash ?? null,
    thumbhash: file?.thumbhash ?? null,
    media_status: file?.media_status ?? null,
    renditions: file?.renditions ?? [],
    srcset: file?.srcset ?? {},
    description: row.description,
    is_spoiler: Boolean(row.is_spoiler)
  };
}

/**
 * files + file_variants + file_renditions for many ids in three queries —
 * the same result as storageService.getFile() per id (which is three queries
 * *each*, and was the N+1 in hydrate: docs/PERFORMANCE.md, "Smaller items").
 */
async function loadFilesWithUrls(fileIds) {
  const ids = [...new Set(fileIds.filter(Boolean))];
  const byId = new Map();
  if (!ids.length) return byId;
  const marks = ids.map(() => '?').join(',');
  const [files, variants, renditions] = await Promise.all([
    allQuery(`SELECT * FROM files WHERE id IN (${marks}) AND deleted_at IS NULL`, ids),
    allQuery(
      `SELECT file_id, kind, storage_key, mime_type, width, height, size
         FROM file_variants WHERE file_id IN (${marks})`,
      ids
    ),
    allQuery(
      `SELECT file_id, bucket, format, storage_key, mime_type, width, height, size, animated
         FROM file_renditions WHERE file_id IN (${marks}) ORDER BY format, bucket`,
      ids
    )
  ]);
  const group = (rows) => {
    const map = new Map();
    for (const { file_id: fileId, ...rest } of rows) {
      if (!map.has(fileId)) map.set(fileId, []);
      map.get(fileId).push(rest);
    }
    return map;
  };
  const variantsByFile = group(variants);
  const renditionsByFile = group(renditions);
  for (const file of files) {
    byId.set(file.id, withUrls(file, variantsByFile.get(file.id) ?? [], renditionsByFile.get(file.id) ?? []));
  }
  return byId;
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

  // Resolve URLs through the storage layer (withUrls) so visibility rules are
  // respected — batched: three queries for every attachment on the page.
  const filesById = await loadFilesWithUrls(attachmentRows.map((row) => row.file_id));
  const attachmentsByMessage = new Map();
  for (const row of attachmentRows) {
    const wire = attachmentToWire(row, filesById.get(row.file_id) ?? null);
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
      // Forwarding v2: where a forwarded copy came from (snapshot metadata
      // taken at send time, after the sender's read access was checked).
      forwarded_from: safeParse(row.forwarded_from, null),
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
  poll = null, embeds = null, components = null, applicationId = null, ephemeralUserId = null,
  forwardedFrom = null, allowedMentions = null
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
    throw new ApiError('This channel is locked', { status: 403, code: 'CHANNEL_LOCKED' });
  }
  if (channel.archived) {
    throw new ApiError('This thread is archived', { status: 403, code: 'THREAD_ARCHIVED' });
  }

  // Forwarding: the copy is built from the *source* message on the server,
  // never from what the client says it contained, and only once the sender
  // has shown they can read the source. See loadForwardSource.
  let forward = null;
  if (forwardedFrom) {
    forward = await loadForwardSource({ forwardedFrom, userId });
    content = forward.content;
    attachments = forward.attachments;
    stickerId = forward.stickerId;
    poll = null;
  }

  // Webhooks and system messages skip moderation and carry no user; every real
  // sender must be able to see the channel and hold SEND_MESSAGES in it.
  if (!Array.isArray(attachments)) attachments = [];
  if (attachments.length > 10) {
    throw new ApiError('A message can carry at most 10 attachments', { code: 'TOO_MANY_ATTACHMENTS' });
  }
  let senderPermissions = '0';
  let senderRoleIds = null;
  if (!skipModeration && userId) {
    const access = await assertChannelAccess({
      channelId, userId,
      // Discord gates thread posts on SEND_MESSAGES_IN_THREADS, not SEND_MESSAGES.
      permission: channel.channel_type === 'thread' ? 'SEND_MESSAGES_IN_THREADS' : 'SEND_MESSAGES'
    });
    senderPermissions = access.isDm ? String(ALL_PERMISSIONS) : access.permissions;
    senderRoleIds = access.isDm ? [] : access.roleIds ?? null;
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
  // produce a duplicate message. The unique index idx_messages_nonce
  // (channel_id, user_id, nonce) is the check: the INSERT below does nothing
  // on a conflict, so an ordinary send no longer pays a SELECT first. This
  // looks up the original only once we know there is one.
  const replayOf = async () => {
    if (!nonce) return null;
    const existing = await getQuery(
      `SELECT id FROM messages WHERE channel_id = ? AND user_id = ? AND nonce = ?`,
      [channelId, userId, nonce]
    );
    if (!existing) return null;
    // A retried send must not fan out again — the first attempt already did.
    return withDelivery(await getMessage(existing.id, userId), {
      notifications: [], audience: [], duplicate: true
    });
  };

  // Moderation runs before anything is written, so a blocked message never
  // exists — not even as a soft-deleted row. A retry of a send that already
  // went through can trip slowmode (the original *is* the last message); it
  // gets the original back rather than an error.
  if (!skipModeration) {
    try {
      await moderate();
    } catch (err) {
      const replay = await replayOf();
      if (replay) return replay;
      throw err;
    }
  }

  async function moderate() {
    // The access check above already resolved the sender's roles.
    const { roleIds } = senderRoleIds
      ? { roleIds: senderRoleIds }
      : channel.server_id
      ? await resolveSenderContext(channel.server_id, userId)
      : { roleIds: [] };
    const permissions = senderPermissions;

    await automod.assertCanSpeak({
      serverId: channel.server_id, channelId, userId, permissions,
      slowmodeSeconds: Number(channel.rate_limit_per_user) || 0
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
      throw new ApiError(`Blocked by AutoMod: ${verdict.reason}`, {
        status: 403, code: 'AUTOMOD_BLOCKED',
        details: { rule: verdict.rule?.name, reason: verdict.reason }
      });
    }
  }

  let repliedUserId = null;
  if (replyToId) {
    const target = await getQuery(
      `SELECT id, user_id FROM messages WHERE id = ? AND channel_id = ? AND deleted_at IS NULL`, [replyToId, channelId]
    );
    // Replying to a message that is gone is allowed on Discord too — the reply
    // just renders without its quote — but a reply must stay inside its channel.
    if (!target) replyToId = null;
    else repliedUserId = target.user_id ?? null;
  }

  // A forwarded copy pings nobody: the words are someone else's, quoted.
  const mentions = forward
    ? { users: [], roles: [], channels: [], everyone: false, here: false }
    : parseMentions(trimmed);
  // allowed_mentions.replied_user: a reply pings the author of the message it
  // answers unless the sender turned the "@ mention" toggle off. Without an
  // allowed_mentions object at all it pings, as Discord's client does.
  const pingReplied = allowedMentions && typeof allowedMentions === 'object'
    ? Boolean(allowedMentions.replied_user)
    : true;
  if (repliedUserId && pingReplied && repliedUserId !== userId && !mentions.users.includes(repliedUserId)) {
    mentions.users.push(repliedUserId);
  }
  const messageId = generateId();
  let notifications = [];

  let duplicateNonce = false;
  await transaction(async () => {
    duplicateNonce = false;   // the callback can be retried
    const inserted = await runQuery(
      `INSERT INTO messages (id, channel_id, server_id, user_id, content, type,
                             reply_to_id, mention_everyone, tts, nonce, sticker_id,
                             embeds, components, application_id, ephemeral_user_id, forwarded_from)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)${nonce ? ' ON CONFLICT DO NOTHING' : ''}`,
      [messageId, channelId, channel.server_id, userId, trimmed,
       replyToId ? 'reply' : type, replyToId, mentions.everyone ? 1 : 0, tts ? 1 : 0, nonce,
       sticker?.id ?? null, JSON.stringify(richEmbeds), JSON.stringify(messageComponents),
       applicationId, ephemeralUserId, forward ? JSON.stringify(forward.snapshot) : null]
    );
    // Same (channel, author, nonce) already stored: this is a retry. Write
    // nothing else; the original is returned below.
    if (nonce && Number(inserted?.changes) === 0) {
      duplicateNonce = true;
      return;
    }

    await indexForSearch(messageId, channelId, trimmed);

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
      // Someone else's private upload cannot be re-posted by id: that would
      // publish its name, size and dimensions and pin it against GC.
      // A forward may carry the source's files: the sender was just shown to
      // be able to read the message they are attached to.
      if (file.visibility === 'private' && file.uploader_id !== userId
          && !forward?.fileIds.has(file.id)) continue;

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
          `INSERT INTO mentions (message_id, target_type, target_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
          [messageId, targetType, targetId]
        );
      }
    }

    // Monotonic: when two sends commit out of order, the pointer still ends
    // on the newest id (ids are same-length snowflakes, so text order is
    // numeric order).
    await runQuery(
      `UPDATE channels
          SET last_message_id = CASE WHEN last_message_id IS NULL OR last_message_id < ?
                                     THEN ? ELSE last_message_id END,
              message_count = message_count + 1,
              updated_at = ${sql.now}
        WHERE id = ?`,
      [messageId, messageId, channelId]
    );

    // Posting in a thread joins it, so you receive its later messages —
    // Discord does the same.
    if (channel.channel_type === 'thread' && userId) {
      await runQuery(
        `INSERT INTO channel_recipients (channel_id, user_id) VALUES (?, ?) ON CONFLICT DO NOTHING`,
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
         VALUES (?, ?, ?, 0, ${sql.now})
         ON CONFLICT(user_id, channel_id)
         DO UPDATE SET last_read_message_id = excluded.last_read_message_id,
                       last_viewed_at = excluded.last_viewed_at`,
        [userId, channelId, messageId]
      );
    }
    // The hot path. Every statement above is an insert, an upsert or an atomic
    // update of a counter/pointer, so READ COMMITTED is enough; SERIALIZABLE
    // would make every concurrent send in a busy channel conflict on the
    // channel row and retry.
  }, { isolation: 'read committed' });

  if (duplicateNonce) {
    const replay = await replayOf();
    if (replay) return replay;
    // Unreachable unless the original was hard-deleted in between.
    throw new ApiError('A message with this nonce is already being sent', { status: 409, code: 'DUPLICATE_NONCE' });
  }

  // Everyone else in the channel gains an unread (lazily: last_message_id
  // moved past their marker), a mention badge if named, and whatever their
  // notification settings ask for — see services/notifications.js.
  //
  // Deliberately outside the transaction above: a failure here must not
  // un-send a message that was accepted, and the send's write lock is not
  // held while the audience is resolved. The fan-out itself is set-based: a
  // fixed number of queries however large the guild.
  try {
    notifications = await fanOutMessageNotifications({
      channelId, authorId: userId, mentions, messageId,
      content: trimmed, authorPermissions: senderPermissions
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

/** Destinations one message may be forwarded to per minute (per sender). */
export const FORWARD_DESTINATIONS_MAX = 5;

/**
 * Resolve `forwarded_from` ({ message_id } or an id) into what the copy is
 * made of. The sender must be able to read the source (READ_MESSAGE_HISTORY
 * in a guild, recipient in a DM, and not refused by age); anything else looks
 * like a missing message, so a forward cannot probe for ids. Forwarding one
 * message is capped at FORWARD_DESTINATIONS_MAX destinations a minute.
 */
async function loadForwardSource({ forwardedFrom, userId }) {
  if (!userId) throw ApiError.unauthorized();
  const sourceId = typeof forwardedFrom === 'object' ? forwardedFrom?.message_id : forwardedFrom;
  if (!sourceId || typeof sourceId !== 'string' || sourceId.length > 64) {
    throw new ApiError('forwarded_from.message_id is required', { code: 'INVALID_FORWARD' });
  }
  const source = await getQuery(
    `SELECT m.id, m.channel_id, m.server_id, m.content, m.created_at, m.sticker_id,
            m.ephemeral_user_id, m.forwarded_from, m.type,
            c.name AS channel_name, c.type AS channel_type,
            u.username, u.display_name, sm.nickname
       FROM messages m
       JOIN channels c ON c.id = m.channel_id
       LEFT JOIN users u ON u.id = m.user_id
       LEFT JOIN server_members sm ON sm.user_id = m.user_id AND sm.server_id = m.server_id
      WHERE m.id = ? AND m.deleted_at IS NULL`,
    [sourceId]
  );
  if (!source || (source.ephemeral_user_id && source.ephemeral_user_id !== userId)) {
    throw ApiError.notFound('Message');
  }
  try {
    await assertChannelAccess({ channelId: source.channel_id, userId, permission: 'READ_MESSAGE_HISTORY' });
  } catch {
    throw ApiError.notFound('Message');
  }
  if (source.type === 'poll') {
    throw new ApiError('Polls cannot be forwarded', { code: 'FORWARD_UNSUPPORTED' });
  }
  const budget = await consumeShared(`forward:${userId}:${source.id}`, {
    limit: FORWARD_DESTINATIONS_MAX, windowMs: 60_000
  });
  if (!budget.allowed) {
    throw new ApiError(`A message can be forwarded to at most ${FORWARD_DESTINATIONS_MAX} places at a time`, {
      status: 429, code: 'FORWARD_LIMIT', details: { retry_after_ms: budget.retryAfterMs }
    });
  }
  const files = await allQuery(
    `SELECT file_id, description, is_spoiler FROM attachments WHERE message_id = ? ORDER BY position ASC`,
    [source.id]
  );
  // A forward of a forward still points at where the words first appeared.
  const origin = safeParse(source.forwarded_from, null);
  const snapshot = origin?.message_id ? origin : {
    message_id: source.id,
    channel_id: source.channel_id,
    channel_name: source.server_id ? source.channel_name ?? null : null,
    guild_id: source.server_id ?? null,
    author_name: source.nickname || source.display_name || source.username || null,
    created_at: source.created_at
  };
  return {
    content: source.content ?? '',
    stickerId: source.sticker_id ?? null,
    attachments: files.map((f) => ({ file_id: f.file_id, description: f.description, is_spoiler: Boolean(f.is_spoiler) })),
    fileIds: new Set(files.map((f) => f.file_id)),
    snapshot
  };
}

export async function editMessage({ messageId, userId, content, embeds = undefined, components = undefined }) {
  const message = await getQuery(
    `SELECT * FROM messages WHERE id = ? AND deleted_at IS NULL`, [messageId]
  );
  if (!message) throw ApiError.notFound('Message');
  if (message.user_id !== userId) throw ApiError.forbidden('You can only edit your own messages');
  // The author must still be able to see the channel — someone kicked, or
  // hidden from it by an overwrite, cannot keep rewriting what others read.
  const access = await assertChannelAccess({ channelId: message.channel_id, userId });

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

  // AutoMod applies to edits exactly as to sends; otherwise posting something
  // harmless and editing the blocked words in afterwards defeats every rule.
  if (!keepsContent && trimmed !== message.content && message.server_id) {
    const { roleIds } = await resolveSenderContext(message.server_id, userId);
    const verdict = await automod.evaluate({
      serverId: message.server_id, channelId: message.channel_id, userId,
      content: trimmed, memberRoleIds: roleIds, permissions: access.permissions ?? '0'
    });
    if (verdict.blocked) {
      await automod.logHit({
        serverId: message.server_id, userId, channelId: message.channel_id,
        rule: verdict.rule, reason: verdict.reason, content: trimmed
      });
      throw new ApiError(`Blocked by AutoMod: ${verdict.reason}`, {
        status: 403, code: 'AUTOMOD_BLOCKED',
        details: { rule: verdict.rule?.name, reason: verdict.reason }
      });
    }
  }

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
              edited_at = ${sql.now}
        WHERE id = ?`,
      [trimmed, mentions.everyone ? 1 : 0, nextEmbeds, nextComponents, messageId]
    );
    await unindexForSearch([messageId]);
    await indexForSearch(messageId, message.channel_id, trimmed);
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
      `UPDATE messages SET deleted_at = ${sql.now} WHERE id = ?`,
      [messageId]
    );
    await unindexForSearch([messageId]);
    await runQuery(
      `UPDATE channels SET message_count = ${sql.greatest(0, 'message_count - 1')} WHERE id = ?`,
      [message.channel_id]
    );
  });

  return { id: messageId, channel_id: message.channel_id };
}

/** Toggle one user's reaction. Returns the fresh aggregate for broadcasting. */
// Discord allows 20 distinct reactions per message; the emoji key itself is a
// unicode sequence or `name:id`, never kilobytes of text.
const MAX_UNIQUE_REACTIONS = 20;
const MAX_EMOJI_LENGTH = 64;

export async function toggleReaction({ messageId, userId, emoji, emojiId = null }) {
  emoji = String(emoji ?? '').trim();
  if (!emoji || emoji.length > MAX_EMOJI_LENGTH) {
    throw new ApiError('Invalid emoji', { code: 'INVALID_EMOJI' });
  }
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

  if (!existing) {
    const known = await getQuery(
      `SELECT 1 FROM reactions WHERE message_id = ? AND emoji = ? LIMIT 1`, [messageId, emoji]
    );
    if (!known) {
      const { n } = await getQuery(
        `SELECT count(DISTINCT emoji) AS n FROM reactions WHERE message_id = ?`, [messageId]
      );
      if (n >= MAX_UNIQUE_REACTIONS) {
        throw new ApiError('Maximum number of reactions reached', { code: 'MAX_REACTIONS' });
      }
    }
  }

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
    if (n >= 50) throw new ApiError('A channel can have at most 50 pinned messages', { code: 'MAX_PINS' });
  }
  await transaction(async () => {
    await runQuery(`UPDATE messages SET pinned = ? WHERE id = ?`, [pinned ? 1 : 0, messageId]);
    if (pinned) {
      await runQuery(
        `INSERT INTO pins (channel_id, message_id, pinned_by) VALUES (?, ?, ?) ON CONFLICT DO NOTHING`,
        [channelId, messageId, userId]
      );
      await runQuery(
        `UPDATE channels SET last_pin_at = ${sql.now} WHERE id = ?`,
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

// --- search index ------------------------------------------------------------
//
// SQLite searches through messages_fts, an FTS5 trigram table that has to be
// kept in step with messages by hand. Postgres searches messages.content
// directly through a pg_trgm GIN index that the database maintains itself, so
// both helpers are no-ops there.

async function indexForSearch(messageId, channelId, content) {
  if (isPostgres) return;
  await runQuery(
    `INSERT INTO messages_fts (content, message_id, channel_id) VALUES (?, ?, ?)`,
    [content, messageId, channelId]
  );
}

async function unindexForSearch(messageIds) {
  if (isPostgres || !messageIds.length) return;
  await runQuery(
    `DELETE FROM messages_fts WHERE message_id IN (${messageIds.map(() => '?').join(',')})`,
    messageIds
  );
}

/** Escape LIKE wildcards so user text matches literally (with ESCAPE '\'). */
const escapeLike = (text) => text.replace(/[\\%_]/g, '\\$&');

/** Full-text search, optionally scoped to a channel or a server. */
export async function searchMessages({
  query, channelId = null, serverId = null, authorId = null, hasAttachment = false,
  limit = 25, viewerId = null, before = null
}) {
  // `from:`, `in:`, `has:` and the date operators are part of the query string
  // itself, exactly as they are on Discord.
  const parsed = parseSearchQuery(query);
  const term = parsed.term;
  // A query that is nothing but operators is still a search — "everything user-2
  // ever posted here" is a perfectly ordinary thing to ask for.
  if (!term && !hasFilters(parsed.filters)) return [];

  // An ephemeral reply exists for exactly one person; search must not surface
  // it to anyone else.
  const where = ['m.deleted_at IS NULL', '(m.ephemeral_user_id IS NULL OR m.ephemeral_user_id = ?)'];
  const filterParams = [viewerId ?? ''];
  if (channelId) { where.push('m.channel_id = ?'); filterParams.push(channelId); }
  if (serverId)  { where.push('m.server_id = ?');  filterParams.push(serverId); }
  if (authorId)  { where.push('m.user_id = ?');    filterParams.push(authorId); }
  if (hasAttachment) where.push('EXISTS (SELECT 1 FROM attachments a WHERE a.message_id = m.id)');
  // Cursor pagination: the next page is everything older than the last id of
  // this one. Ids are snowflakes, so this is stable under concurrent inserts.
  if (before) { where.push('m.id < ?'); filterParams.push(String(before)); }

  // Permissions are applied *inside* the query, before LIMIT: the viewer's
  // readable channels are computed in bulk and the rows are restricted to
  // them. Filtering after LIMIT (as this used to) returned short or empty
  // pages whenever the newest matches sat in channels the viewer cannot see,
  // and made "load more" impossible to implement correctly.
  if (viewerId) {
    let readable = await readableChannelIds(viewerId, { serverId });
    if (channelId) readable = readable.filter((id) => id === channelId);
    if (!readable.length) return [];
    where.push(`m.channel_id IN (${readable.map(() => '?').join(',')})`);
    filterParams.push(...readable);
  }

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
        ? `m.content ${sql.like} '%http%'`
        : `(m.embeds IS NOT NULL AND m.embeds <> '[]')`);
    } else if (kind === 'poll') {
      where.push(`EXISTS (SELECT 1 FROM polls p WHERE p.message_id = m.id)`);
    } else if (kind === 'sticker') {
      where.push(`m.sticker_id IS NOT NULL`);
    } else if (kind === 'image' || kind === 'video' || kind === 'sound') {
      const prefix = kind === 'sound' ? 'audio/' : `${kind}/`;
      where.push(`EXISTS (SELECT 1 FROM attachments a JOIN files f ON f.id = a.file_id
                           WHERE a.message_id = m.id AND f.mime_type ${sql.like} ?)`);
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
  } else if (isPostgres) {
    // Postgres: one path for every length. The pg_trgm GIN index on
    // messages.content serves ILIKE '%term%' once the term has three
    // characters; shorter terms are a scan bounded by the same filters.
    rows = await allQuery(
      `${projection}
         FROM messages m
         ${joins}
        WHERE m.content ILIKE ? ESCAPE '\\' AND ${where.join(' AND ')}
        ORDER BY m.id DESC LIMIT ?`,
      [`%${escapeLike(term)}%`, ...filterParams, cap]
    );
  } else if (term.length >= 3) {
    // SQLite: the trigram tokenizer treats a double-quoted string as a literal
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
      [`%${escapeLike(term)}%`, ...filterParams, cap]
    );
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
     VALUES (?, ?, ?, 0, ${sql.now})
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
     VALUES (?, ?, ?, ${sql.now})
     ON CONFLICT(user_id, channel_id)
     DO UPDATE SET last_read_message_id = excluded.last_read_message_id`,
    [userId, channelId, beforeMessageId]
  );
  return { channel_id: channelId, last_read_message_id: beforeMessageId, unread: 1 };
}

/** Unread counts for every channel the user can see — drives the sidebar badges. */
export async function getUnreadSummary(userId) {
  const rows = await allQuery(
    `SELECT c.id AS channel_id, c.server_id, c.type AS channel_type, c.parent_id,
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
  // the existence of a private channel through an unread badge. Resolved per
  // guild in bulk (a few queries per server, not per channel).
  const viewable = await visibleChannelIds(userId, rows);
  return rows
    .filter((row) => !row.server_id || viewable.has(row.channel_id))
    .map(({ channel_type: _type, parent_id: _parent, ...row }) => row);
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

  const marks = deletable.map(() => '?').join(',');
  // Same bookkeeping as a single delete: attachment references are released
  // (or the bytes are never garbage-collected) and the search index forgets
  // the text.
  await transaction(async () => {
    const attachments = await allQuery(
      `SELECT file_id FROM attachments WHERE message_id IN (${marks})`, deletable
    );
    for (const a of attachments) await releaseReference(a.file_id);
    await runQuery(
      `UPDATE messages SET deleted_at = ${sql.now}
        WHERE id IN (${marks})`,
      deletable
    );
    await unindexForSearch(deletable);
    await runQuery(
      `UPDATE channels SET message_count = ${sql.greatest(0, 'message_count - ?')} WHERE id = ?`,
      [deletable.length, channelId]
    );
  });
  return { channel_id: channelId, ids: deletable };
}
