// ============================================================================
//  /api/voice/* — voice mode discovery, LiveKit tokens and webhook, and the
//  moderator voice actions (server mute / deafen / move / disconnect).
//
//  The moderator actions work in both media modes: the roster and the target's
//  client obey them in mesh mode; with LiveKit the SFU additionally enforces
//  them (revoked publish/subscribe permission, removed participant).
// ============================================================================

import express from 'express';

import { getQuery, runQuery } from '../db.js';
import { generateId } from '../lib/snowflake.js';
import { ApiError, asyncRoute, requireUser } from '../lib/httpUtils.js';
import { rateLimit } from '../lib/rateLimit.js';
import { has } from '../lib/permissions.js';
import { assertChannelAccess } from '../services/access.js';
import { resolvePermissions, writeAuditLog } from '../services/guilds.js';
import * as livekit from '../services/livekit.js';
import {
  broadcastVoice, moveVoiceMember, disconnectVoiceMember, setServerVoiceState
} from '../realtime.js';

const VOICE_CHANNEL_TYPES = new Set(['voice', 'stage']);

// Tokens are cheap to mint but each one is a ticket into a media server;
// a client reconnecting in a loop should not be able to mint thousands.
const tokenLimit = rateLimit({ name: 'livekit-token', limit: 30, windowMs: 60_000 });
const moderationLimit = rateLimit({ name: 'voice-moderation', limit: 60, windowMs: 60_000 });

/**
 * Resolve the moderation context: the channel the target is in, the actor's
 * permission there, and the usual hierarchy guard (nobody moderates the owner
 * except the owner).
 */
async function moderationContext({ channelId, actorId, targetId, permission }) {
  const { channel, permissions, isDm } = await assertChannelAccess({ channelId, userId: actorId });
  if (isDm || !channel.server_id || !VOICE_CHANNEL_TYPES.has(channel.type)) {
    throw new ApiError('Not a server voice channel', { status: 400, code: 'NOT_VOICE_CHANNEL' });
  }
  if (!has(permissions, permission)) throw ApiError.forbidden(`Missing permission: ${permission}`);
  const state = await getQuery(
    `SELECT user_id FROM voice_states WHERE user_id = ? AND channel_id = ?`, [targetId, channelId]
  );
  if (!state) throw new ApiError('That member is not in this voice channel', { status: 404, code: 'NOT_IN_VOICE' });
  const server = await getQuery(`SELECT owner_id FROM servers WHERE id = ?`, [channel.server_id]);
  if (server?.owner_id === targetId && actorId !== targetId) {
    throw ApiError.forbidden('The server owner cannot be moderated');
  }
  return { channel };
}

const bool = (value, name) => {
  if (typeof value !== 'boolean') throw new ApiError(`${name} must be true or false`, { status: 400, code: 'VALIDATION' });
  return value;
};

/**
 * Bring voice_states in line with what the SFU reports. The gateway remains
 * the source of truth for anyone with a live socket in the room; the webhook
 * covers the rest (a session that reached LiveKit before the gateway saw it,
 * a tab that died without its socket noticing).
 */
async function applyWebhookEvent(io, event) {
  const channelId = event.room?.name;
  const userId = event.participant?.identity;
  if (!channelId) return;

  if (event.event === 'room_finished') {
    const stale = await getQuery(`SELECT COUNT(*) AS n FROM voice_states WHERE channel_id = ? AND socket_id IS NULL`, [channelId]);
    if (Number(stale?.n) > 0) {
      await runQuery(`DELETE FROM voice_states WHERE channel_id = ? AND socket_id IS NULL`, [channelId]);
      await broadcastVoice(io, channelId);
    }
    return;
  }
  if (!userId) return;
  const liveSockets = (await io.in(`user-${userId}`).fetchSockets())
    .filter((s) => s.rooms.has(`voice-${channelId}`));

  if (event.event === 'participant_joined') {
    // Someone we would not have given a token to (lost CONNECT since) is out.
    let channel;
    try {
      ({ channel } = await assertChannelAccess({ channelId, userId, permission: 'CONNECT' }));
    } catch {
      await livekit.removeParticipant(channelId, userId, { revoke: true });
      return;
    }
    const row = await getQuery(`SELECT channel_id FROM voice_states WHERE user_id = ?`, [userId]);
    if (row?.channel_id === channelId) return;
    const previous = row?.channel_id ?? null;
    const isStage = channel.type === 'stage';
    const stageMod = isStage && has((await resolvePermissions({
      userId, serverId: channel.server_id, channelId
    })).permissions, 'MUTE_MEMBERS');
    const member = channel.server_id
      ? await getQuery(`SELECT is_mute, is_deaf FROM server_members WHERE server_id = ? AND user_id = ?`, [channel.server_id, userId])
      : null;
    await runQuery(
      `INSERT INTO voice_states (user_id, channel_id, server_id, session_id, socket_id, suppress, server_mute, server_deaf)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         channel_id = excluded.channel_id, server_id = excluded.server_id,
         session_id = excluded.session_id, socket_id = NULL, suppress = excluded.suppress,
         server_mute = excluded.server_mute, server_deaf = excluded.server_deaf,
         request_to_speak_at = NULL`,
      [userId, channelId, channel.server_id ?? null, generateId(),
        isStage && !stageMod ? 1 : 0, member?.is_mute ? 1 : 0, member?.is_deaf ? 1 : 0]
    );
    if (previous) await broadcastVoice(io, previous);
    await broadcastVoice(io, channelId);
    return;
  }

  if (event.event === 'participant_left' || event.event === 'participant_connection_aborted') {
    // A socket still in the voice room owns this session (it may be
    // reconnecting to the SFU); the gateway cleans up when that socket goes.
    if (liveSockets.length) return;
    const { changes } = await runQuery(
      `DELETE FROM voice_states WHERE user_id = ? AND channel_id = ?`, [userId, channelId]
    );
    if (changes) await broadcastVoice(io, channelId);
  }
}

export default function createLivekitRouter({ io }) {
  const router = express.Router();

  // --- discovery -----------------------------------------------------------

  /** Which media path to use, plus ICE servers for the mesh. No secrets. */
  router.get('/voice/config', requireUser, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(livekit.clientVoiceConfig(req.userId));
  });

  /**
   * Operator health: which media path is active, and if LiveKit is half-
   * configured, which variables are wrong (names only, never values).
   */
  router.get('/voice/health', (_req, res) => {
    const cfg = livekit.livekitConfig();
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      mode: cfg.enabled ? 'livekit' : 'mesh',
      livekit: cfg.enabled ? 'configured' : cfg.reason,
      problems: cfg.enabled ? [] : cfg.problems
    });
  });

  // --- tokens ----------------------------------------------------------------

  router.post('/voice/livekit/token', requireUser, tokenLimit, asyncRoute(async (req, res) => {
    const channelId = req.body?.channelId ?? req.body?.channel_id;
    if (typeof channelId !== 'string' || !channelId || channelId.length > 64) {
      throw new ApiError('channelId is required', { status: 400, code: 'VALIDATION' });
    }
    res.setHeader('Cache-Control', 'no-store');
    res.json(await livekit.issueToken({ channelId, userId: req.userId }));
  }));

  // --- webhook -----------------------------------------------------------------
  //
  // LiveKit posts `application/webhook+json` with `Authorization: <jwt>` whose
  // sha256 claim covers the exact body bytes, so the body must stay raw.
  // express.json() (mounted globally) only parses application/json and leaves
  // this alone; a delivery it did parse cannot be verified and is refused.
  router.post(
    '/voice/livekit/webhook',
    express.raw({ type: () => true, limit: '256kb' }),
    asyncRoute(async (req, res) => {
      if (!livekit.isLivekitEnabled()) {
        throw new ApiError('LiveKit is not configured on this server', { status: 503, code: 'LIVEKIT_DISABLED' });
      }
      if (!Buffer.isBuffer(req.body)) {
        throw new ApiError('Invalid webhook signature', { status: 401, code: 'INVALID_SIGNATURE' });
      }
      const event = await livekit.receiveWebhook(req.body.toString('utf8'), req.get('authorization'));
      if (event) await applyWebhookEvent(io, event);
      res.json({ ok: true });
    })
  );

  // --- moderator actions -------------------------------------------------------

  const base = '/voice/channels/:channelId/members/:userId';

  router.post(`${base}/mute`, requireUser, moderationLimit, asyncRoute(async (req, res) => {
    const mute = bool(req.body?.mute, 'mute');
    const { channelId, userId } = req.params;
    const { channel } = await moderationContext({ channelId, actorId: req.userId, targetId: userId, permission: 'MUTE_MEMBERS' });
    await setServerVoiceState(io, { serverId: channel.server_id, channelId, userId, mute, by: req.userId });
    await writeAuditLog({
      serverId: channel.server_id, userId: req.userId, actionType: 'MEMBER_UPDATE',
      targetType: 'user', targetId: userId, changes: [{ key: 'mute', new: mute }]
    });
    res.json({ ok: true, userId, channelId, serverMute: mute });
  }));

  router.post(`${base}/deafen`, requireUser, moderationLimit, asyncRoute(async (req, res) => {
    const deaf = bool(req.body?.deaf, 'deaf');
    const { channelId, userId } = req.params;
    const { channel } = await moderationContext({ channelId, actorId: req.userId, targetId: userId, permission: 'DEAFEN_MEMBERS' });
    await setServerVoiceState(io, { serverId: channel.server_id, channelId, userId, deaf, by: req.userId });
    await writeAuditLog({
      serverId: channel.server_id, userId: req.userId, actionType: 'MEMBER_UPDATE',
      targetType: 'user', targetId: userId, changes: [{ key: 'deaf', new: deaf }]
    });
    res.json({ ok: true, userId, channelId, serverDeaf: deaf });
  }));

  router.post(`${base}/move`, requireUser, moderationLimit, asyncRoute(async (req, res) => {
    const { channelId, userId } = req.params;
    const to = req.body?.channelId ?? req.body?.channel_id;
    if (typeof to !== 'string' || !to || to.length > 64) {
      throw new ApiError('channelId (destination) is required', { status: 400, code: 'VALIDATION' });
    }
    const { channel } = await moderationContext({ channelId, actorId: req.userId, targetId: userId, permission: 'MOVE_MEMBERS' });
    if (to === channelId) { res.json({ ok: true, userId, channelId: to }); return; }
    const dest = await getQuery(
      `SELECT id, server_id, type FROM channels WHERE id = ? AND deleted_at IS NULL`, [to]
    );
    if (!dest || dest.server_id !== channel.server_id || !VOICE_CHANNEL_TYPES.has(dest.type)) {
      throw new ApiError('Destination must be a voice channel in the same server', { status: 400, code: 'INVALID_DESTINATION' });
    }
    // Discord's rule: the mover needs CONNECT on the destination. We also
    // require it of the member, because the token endpoint would refuse them.
    await assertChannelAccess({ channelId: to, userId: req.userId, permission: 'CONNECT' });
    try {
      await assertChannelAccess({ channelId: to, userId, permission: 'CONNECT' });
    } catch {
      throw ApiError.forbidden('That member cannot connect to the destination channel');
    }
    await moveVoiceMember(io, userId, channelId, to, 'moved');
    await writeAuditLog({
      serverId: channel.server_id, userId: req.userId, actionType: 'MEMBER_MOVE',
      targetType: 'user', targetId: userId, changes: [{ key: 'channel_id', old: channelId, new: to }]
    });
    res.json({ ok: true, userId, channelId: to });
  }));

  router.delete(base, requireUser, moderationLimit, asyncRoute(async (req, res) => {
    const { channelId, userId } = req.params;
    const { channel } = await moderationContext({ channelId, actorId: req.userId, targetId: userId, permission: 'MOVE_MEMBERS' });
    await disconnectVoiceMember(io, userId, channelId);
    await writeAuditLog({
      serverId: channel.server_id, userId: req.userId, actionType: 'MEMBER_DISCONNECT',
      targetType: 'user', targetId: userId, changes: [{ key: 'channel_id', old: channelId, new: null }]
    });
    res.json({ ok: true, userId, channelId });
  }));

  return router;
}
