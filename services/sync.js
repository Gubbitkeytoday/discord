// ============================================================================
//  Catch-up sync — "what changed for me since cursor X?"
//
//  Socket.IO connection-state recovery replays missed events after a short
//  drop (see realtime.js). Anything longer — a laptop that slept, a phone that
//  was offline, a restore that was refused because a permission changed — has
//  to catch up over REST. Refetching every channel is what a naive client does
//  and what melts a server after a deploy; this endpoint instead returns a
//  small, bounded summary the client can act on selectively:
//
//    channels[]  per readable channel with activity since the cursor:
//                new / edited / deleted message counts and the newest id.
//                The client fetches `GET /api/channels/:id/messages?after=`
//                only for channels it has cached/open, and re-reads the
//                visible window where edits/deletes happened.
//    guilds[]    every guild the user is in, with a `state_hash` over the
//                roles and the channels the user can see (and their
//                effective permissions). A hash that differs from the one
//                the client holds means "refetch this guild's detail".
//                A guild missing from the list means the user left/was
//                removed; a new id means they joined. (channels.updated_at
//                moves on every message, so it is not a structure signal;
//                the hash covers the structural columns instead.)
//
//  Cursor: opaque (base64url JSON); ISO timestamps and epoch ms are accepted
//  too. Windows overlap by a couple of seconds so a row committed just as the
//  previous sync ran is never missed — clients dedupe by message id. Cursors
//  older than SYNC_MAX_AGE (7 days) answer `reset: true`: do a full reload.
// ============================================================================

import crypto from 'node:crypto';
import { allQuery } from '../db.js';
import { ApiError } from '../lib/httpUtils.js';
import { DISCORD_EPOCH } from '../lib/snowflake.js';
import { userChannelContext } from './access.js';

export const SYNC_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const OVERLAP_MS = 2000;
const MAX_CHANNELS = 1000;
const CHUNK = 500;

export function encodeCursor(ms) {
  return Buffer.from(JSON.stringify({ v: 1, t: ms })).toString('base64url');
}

/** Cursor → epoch ms, or null if unparseable. */
export function decodeCursor(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const text = String(raw).slice(0, 200);
  if (/^\d{10,15}$/.test(text)) return Number(text);
  if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
    const ms = Date.parse(text);
    return Number.isFinite(ms) ? ms : null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
    return parsed?.v === 1 && Number.isFinite(parsed.t) ? parsed.t : null;
  } catch {
    return null;
  }
}

/** Smallest snowflake minted at or after `ms`, as the decimal string ids use. */
function snowflakeAt(ms) {
  const delta = BigInt(Math.max(0, Math.floor(ms))) - DISCORD_EPOCH;
  return (delta > 0n ? delta << 22n : 0n).toString();
}

async function chunked(ids, fn) {
  const out = [];
  for (let i = 0; i < ids.length; i += CHUNK) out.push(...(await fn(ids.slice(i, i + CHUNK))));
  return out;
}

const marks = (list) => list.map(() => '?').join(',');

export async function syncSince({ userId, since }) {
  if (!userId) throw ApiError.unauthorized();
  const now = Date.now();
  const cursor = encodeCursor(now);
  const sinceMs = decodeCursor(since);
  if (since !== undefined && since !== null && since !== '' && sinceMs === null) {
    throw new ApiError('since is not a valid cursor', { code: 'INVALID_CURSOR' });
  }
  if (sinceMs === null || now - sinceMs > SYNC_MAX_AGE_MS || sinceMs > now + 60_000) {
    return { cursor, server_time: new Date(now).toISOString(), reset: true, channels: [], guilds: [] };
  }

  const ctx = await userChannelContext(userId);
  const visible = ctx.guildChannels.filter((c) => ctx.can(c.id, 'VIEW_CHANNEL'));
  const readable = [
    ...visible.filter((c) => ctx.can(c.id, 'READ_MESSAGE_HISTORY')).map((c) => c.id),
    ...ctx.dmChannelIds
  ];

  const fromMs = sinceMs - OVERLAP_MS;
  const fromIso = new Date(fromMs).toISOString();
  const fromId = snowflakeAt(fromMs);

  // New messages: served by idx_messages_channel (channel_id, id).
  const created = await chunked(readable, (ids) => allQuery(
    `SELECT channel_id, COUNT(*) AS n, MAX(id) AS last_id FROM messages
      WHERE channel_id IN (${marks(ids)}) AND id > ? AND deleted_at IS NULL
        AND (ephemeral_user_id IS NULL OR ephemeral_user_id = ?)
      GROUP BY channel_id`, [...ids, fromId, userId]));
  // Edits and deletions of messages the client may already hold (older than
  // the window). Served by the partial indexes added in schema v34.
  const edited = await chunked(readable, (ids) => allQuery(
    `SELECT channel_id, COUNT(*) AS n FROM messages
      WHERE channel_id IN (${marks(ids)}) AND edited_at IS NOT NULL AND edited_at > ?
        AND deleted_at IS NULL AND id <= ?
      GROUP BY channel_id`, [...ids, fromIso, fromId]));
  const deleted = await chunked(readable, (ids) => allQuery(
    `SELECT channel_id, COUNT(*) AS n FROM messages
      WHERE channel_id IN (${marks(ids)}) AND deleted_at IS NOT NULL AND deleted_at > ? AND id <= ?
      GROUP BY channel_id`, [...ids, fromIso, fromId]));

  const serverOf = new Map(ctx.guildChannels.map((c) => [c.id, c.server_id]));
  const activity = new Map();
  const entry = (channelId) => {
    if (!activity.has(channelId)) {
      activity.set(channelId, {
        channel_id: channelId, server_id: serverOf.get(channelId) ?? null,
        new_messages: 0, edited_messages: 0, deleted_messages: 0, last_message_id: null
      });
    }
    return activity.get(channelId);
  };
  for (const r of created) Object.assign(entry(r.channel_id), { new_messages: Number(r.n), last_message_id: r.last_id });
  for (const r of edited) entry(r.channel_id).edited_messages = Number(r.n);
  for (const r of deleted) entry(r.channel_id).deleted_messages = Number(r.n);
  let channels = [...activity.values()];
  const truncated = channels.length > MAX_CHANNELS;
  if (truncated) {
    channels.sort((a, b) => b.new_messages - a.new_messages);
    channels = channels.slice(0, MAX_CHANNELS);
  }

  // Structure: roles + visible channels (with effective permissions).
  const serverIds = ctx.memberships.map((m) => m.server_id);
  const roles = await chunked(serverIds, (ids) => allQuery(
    `SELECT server_id, id, name, color, position, permissions, hoist, mentionable
       FROM roles WHERE server_id IN (${marks(ids)}) ORDER BY server_id, id`, ids));
  const hashes = new Map(serverIds.map((id) => [id, crypto.createHash('sha256')]));
  for (const r of roles) {
    hashes.get(r.server_id)?.update(`r|${r.id}|${r.name}|${r.color}|${r.position}|${r.permissions}|${r.hoist}|${r.mentionable}\n`);
  }
  for (const c of [...visible].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    hashes.get(c.server_id)?.update([
      'c', c.id, c.type, c.name, c.topic, c.position, c.parent_id, c.nsfw,
      c.rate_limit_per_user, c.archived, c.locked, ctx.permissionsIn(c.id)
    ].join('|') + '\n');
  }
  const guilds = serverIds.map((id) => ({
    server_id: id,
    state_hash: hashes.get(id).digest('base64url').slice(0, 22)
  }));

  return {
    cursor,
    server_time: new Date(now).toISOString(),
    reset: false,
    since: new Date(sinceMs).toISOString(),
    channels,
    truncated,
    guilds
  };
}
