// ============================================================================
//  Realtime layer — Socket.IO gateway.
//
//  Event names and payload shapes are unchanged from the prototype so the
//  existing client keeps working; what is new is that state (voice membership,
//  presence, read markers) is persisted rather than living only in a module
//  variable that dies with the process.
// ============================================================================

import { runQuery, getQuery, allQuery } from './db.js';
import { generateId } from './lib/snowflake.js';
import * as messageService from './services/messages.js';
import * as userService from './services/users.js';
import * as linkEmbeds from './services/linkEmbeds.js';
import { resolveSession, SESSION_COOKIE } from './lib/auth.js';
import { config } from './lib/config.js';
import { assertChannelAccess, canInChannel } from './services/access.js';
import { checkSocketLimit } from './lib/rateLimit.js';
import { resolvePermissions } from './services/guilds.js';

// Ephemeral state: typing indicators and the socket↔user mapping. These are
// intentionally in-memory — they are meaningless after a restart.
const typing = new Map();        // channelId -> Map<userId, timeoutId>
const socketsByUser = new Map(); // userId -> Set<socketId>

const TYPING_TTL_MS = 8000;

// Soundboard rate limit. Per user rather than per channel: one person spamming
// should not stop everyone else, and a held key must not machine-gun the room.
const soundCooldown = new Map();  // userId -> last play timestamp
const SOUND_COOLDOWN_MS = 1500;

// AFK detection. Discord moves you to the AFK channel after N minutes without
// speaking. "Speaking" already streams through here many times a second and is
// deliberately never written to disk, so the last-heard timestamp lives in
// memory too — a restart simply gives everyone a fresh timer, which is the
// gentler failure.
const lastSpokeAt = new Map();    // userId -> timestamp

/** Pull the session cookie out of the websocket handshake, if the browser sent one. */
function cookieToken(socket) {
  const header = socket.request?.headers?.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === SESSION_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return null;
}

/**
 * Who is this socket? Order of trust: a session token in the payload, then the
 * HttpOnly cookie from the handshake, then — only with ALLOW_DEV_IDENTITY — the
 * bare userId the client claims. Production never trusts a claimed id.
 */
async function authenticateSocket(socket, { userId, token }) {
  const candidate = token || cookieToken(socket);
  if (candidate) {
    const session = await resolveSession(candidate);
    if (session) return session.userId;
  }
  if (config.allowDevIdentity && userId) return userId;
  return null;
}

// Upper bound on a full-mesh voice room. Each participant uploads one stream per
// other participant, so bandwidth grows linearly and quality collapses past this
// without a selective-forwarding unit.
const MESH_LIMIT = Number(process.env.VOICE_MESH_LIMIT) || 8;

export function registerRealtime(io) {
  io.on('connection', (socket) => {
    // --- identity ------------------------------------------------------------
    // The client announces who it is; replace with session-token validation
    // when auth lands (see lib/httpUtils.js identify()).
    socket.on('identify', async ({ userId, token } = {}) => {
      const resolvedId = await authenticateSocket(socket, { userId, token });
      if (!resolvedId) {
        socket.emit('identify_error', { error: 'Authentication required', code: 'UNAUTHENTICATED' });
        return;
      }
      userId = resolvedId;
      socket.data.userId = userId;
      if (!socketsByUser.has(userId)) socketsByUser.set(userId, new Set());
      socketsByUser.get(userId).add(socket.id);

      // A user's own room makes it easy to push notifications to every device.
      socket.join(`user-${userId}`);

      // First socket for this user means they just came online. A user who
      // chose "invisible" stays invisible to others, as on Discord.
      if (socketsByUser.get(userId).size === 1) {
        const current = await getQuery(`SELECT status FROM users WHERE id = ?`, [userId]);
        const status = current?.status === 'invisible' ? 'invisible' : 'online';
        const user = await userService.setPresence({ userId, status });
        io.emit('presence_updated', { userId, status: user.status === 'invisible' ? 'offline' : user.status });
      }
      await userService.touchLastSeen(userId);
      socket.emit('identified', { userId });
    });

    // Rooms decide who receives new_message, typing and reaction events, so
    // joining one is an access decision, not bookkeeping. Without this check a
    // client could subscribe to any private channel by guessing its id.
    socket.on('join_server', async (serverId, ack) => {
      const userId = socket.data.userId;
      if (!serverId || !userId) return ack?.({ ok: false, error: 'Authentication required' });
      const resolved = await resolvePermissions({ userId, serverId }).catch(() => null);
      if (!resolved?.isMember) return ack?.({ ok: false, error: 'Not a member of this server' });
      socket.join(serverId);
      ack?.({ ok: true });
    });

    socket.on('join_channel', async (channelId, ack) => {
      const userId = socket.data.userId;
      if (!channelId || !userId) return ack?.({ ok: false, error: 'Authentication required' });
      const allowed = await canInChannel({ channelId, userId, permission: 'VIEW_CHANNEL' });
      if (!allowed) {
        socket.emit('action_error', { action: 'join_channel', error: 'You cannot view this channel', code: 'FORBIDDEN' });
        return ack?.({ ok: false, error: 'You cannot view this channel' });
      }
      socket.join(channelId);
      ack?.({ ok: true });
    });

    socket.on('leave_channel', (channelId) => { if (channelId) socket.leave(channelId); });

    // --- messages ------------------------------------------------------------

    socket.on('send_message', async (data, ack) => {
      try {
        const {
          channel_id: channelId, content,
          attachments = [], reply_to_id: replyToId, nonce, sticker_id: stickerId
        } = data ?? {};
        const userId = socket.data.userId;
        if (!channelId) return;
        if (!userId) {
          ack?.({ ok: false, error: 'Authentication required', code: 'UNAUTHENTICATED' });
          return;
        }
        // The gateway bypasses Express, so it needs its own budget or the HTTP
        // write limit is trivially sidestepped by sending over the socket.
        const budget = checkSocketLimit(userId, 'send_message', { limit: 30, windowMs: 10_000 });
        if (!budget.allowed) {
          ack?.({
            ok: false, code: 'RATE_LIMITED',
            error: `ส่งเร็วเกินไป ลองใหม่ในอีก ${Math.ceil(budget.retryAfterMs / 1000)} วินาที`
          });
          return;
        }

        const message = await messageService.createMessage({
          channelId, userId, content, attachments, replyToId, nonce, stickerId
        });

        clearTyping(io, channelId, userId);
        ack?.({ ok: true, message });
        fanOutMessage(io, message);
      } catch (err) {
        console.error('send_message failed:', err.message);
        ack?.({ ok: false, error: err.message, code: err.code });
        socket.emit('message_error', { error: err.message, code: err.code, nonce: data?.nonce });
      }
    });

    socket.on('edit_message', async ({ messageId, content }, ack) => {
      try {
        const userId = socket.data.userId;
        if (!userId) throw new Error('Authentication required');
        const message = await messageService.editMessage({ messageId, userId, content });
        io.to(message.channel_id).emit('message_updated', message);
        ack?.({ ok: true, message });
      } catch (err) {
        ack?.({ ok: false, error: err.message });
      }
    });

    socket.on('delete_message', async ({ messageId }, ack) => {
      try {
        const userId = socket.data.userId;
        if (!userId) throw new Error('Authentication required');
        const result = await messageService.deleteMessage({ messageId, userId });
        if (result) io.to(result.channel_id).emit('message_deleted', messageId);
        ack?.({ ok: true });
      } catch (err) {
        ack?.({ ok: false, error: err.message });
      }
    });

    socket.on('toggle_reaction', async ({ messageId, channelId, emoji }, ack) => {
      try {
        const userId = socket.data.userId;
        if (!userId) throw new Error('Authentication required');
        const result = await messageService.toggleReaction({ messageId, userId, emoji });
        io.to(result.channelId ?? channelId).emit('reaction_updated', {
          messageId: result.messageId,
          reactions: result.reactions,
          reaction_details: result.reaction_details
        });
        ack?.({ ok: true });
      } catch (err) {
        ack?.({ ok: false, error: err.message, code: err.code });
        socket.emit('action_error', { action: 'toggle_reaction', error: err.message, code: err.code });
      }
    });

    socket.on('mark_read', async ({ channelId, messageId }) => {
      try {
        const userId = socket.data.userId;
        if (!userId || !channelId) return;
        const state = await messageService.markRead({ userId, channelId, messageId });
        io.to(`user-${userId}`).emit('read_state_updated', state);
      } catch (err) {
        console.error('mark_read failed:', err.message);
      }
    });

    // --- typing --------------------------------------------------------------

    socket.on('typing_start', ({ channelId, displayName }) => {
      const userId = socket.data.userId;
      if (!channelId || !userId) return;
      if (!typing.has(channelId)) typing.set(channelId, new Map());
      const channelTyping = typing.get(channelId);

      clearTimeout(channelTyping.get(userId));
      // Self-expiring: a client that disconnects mid-typing must not leave a
      // permanent "… is typing" in everyone else's UI.
      channelTyping.set(userId, setTimeout(() => clearTyping(io, channelId, userId), TYPING_TTL_MS));

      socket.to(channelId).emit('typing', { channelId, userId, displayName });
    });

    socket.on('typing_stop', ({ channelId }) => {
      if (socket.data.userId) clearTyping(io, channelId, socket.data.userId);
    });

    // --- presence ------------------------------------------------------------

    socket.on('update_presence', async ({ status, customStatus }) => {
      try {
        const userId = socket.data.userId;
        if (!userId) return;
        // Remember the chosen status so a reconnect restores it instead of
        // snapping back to "online".
        socket.data.chosenStatus = status;
        const user = await userService.setPresence({ userId, status, customStatus });
        // Others see an invisible user as offline; only the user's own devices
        // learn the real value.
        io.except(`user-${userId}`).emit('presence_updated', {
          userId, status: user.status === 'invisible' ? 'offline' : user.status,
          custom_status: user.custom_status
        });
        io.to(`user-${userId}`).emit('presence_updated', {
          userId, status: user.status, custom_status: user.custom_status
        });
      } catch (err) {
        console.error('update_presence failed:', err.message);
      }
    });

    // --- voice ---------------------------------------------------------------

    socket.on('join_voice', async ({ channelId }, ack) => {
      const userId = socket.data.userId;
      if (!channelId || !userId) return;
      const user = { id: userId };
      try {
        await assertChannelAccess({ channelId, userId, permission: 'CONNECT' });
      } catch (err) {
        ack?.({ ok: false, error: err.message, code: err.code });
        socket.emit('voice_error', { channelId, code: err.code ?? 'FORBIDDEN', error: err.message });
        return;
      }
      // One voice channel per user: joining another leaves the old one first.
      const previous = await getQuery(`SELECT channel_id FROM voice_states WHERE user_id = ?`, [userId]);
      if (previous && previous.channel_id !== channelId) {
        socket.leave(`voice-${previous.channel_id}`);
        await runQuery(`DELETE FROM voice_states WHERE user_id = ?`, [userId]);
        await broadcastVoice(io, previous.channel_id);
      }

      // A full mesh costs each participant N-1 upstreams, so the room size is
      // capped rather than letting audio quietly degrade for everyone. Beyond
      // this an SFU is required — see ARCHITECTURE.md.
      const channel = await getQuery(
        `SELECT server_id, user_limit, type FROM channels WHERE id = ?`, [channelId]
      );
      const occupants = await allQuery(
        `SELECT user_id FROM voice_states WHERE channel_id = ? AND user_id != ?`,
        [channelId, user.id]
      );
      const limit = Number(channel?.user_limit) || MESH_LIMIT;
      if (occupants.length + 1 > Math.min(limit, MESH_LIMIT)) {
        ack?.({ ok: false, error: `ห้องเสียงนี้เต็ม (สูงสุด ${Math.min(limit, MESH_LIMIT)} คน)`, code: 'VOICE_FULL' });
        socket.emit('voice_error', {
          channelId,
          code: 'VOICE_FULL',
          error: `ห้องเสียงนี้รับได้สูงสุด ${Math.min(limit, MESH_LIMIT)} คน`
        });
        return;
      }

      socket.join(`voice-${channelId}`);
      socket.data.voiceChannelId = channelId;

      await runQuery(
        `INSERT INTO voice_states (user_id, channel_id, server_id, session_id, socket_id, joined_at)
         VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         ON CONFLICT(user_id) DO UPDATE SET
           channel_id = excluded.channel_id, server_id = excluded.server_id,
           session_id = excluded.session_id, socket_id = excluded.socket_id,
           joined_at = excluded.joined_at`,
        [user.id, channelId, channel?.server_id ?? null, generateId(), socket.id]
      );

      // Stage channels: everyone joins as audience (suppressed) except stage
      // moderators — those who may mute members. Speakers are promoted by a
      // moderator or by having their raised hand accepted.
      const isStage = channel?.type === 'stage';
      const isStageMod = isStage && await canInChannel({ channelId, userId, permission: 'MUTE_MEMBERS' });
      await runQuery(
        `UPDATE voice_states SET suppress = ?, request_to_speak_at = NULL WHERE user_id = ?`,
        [isStage && !isStageMod ? 1 : 0, userId]
      );

      lastSpokeAt.set(userId, Date.now());
      await broadcastVoice(io, channelId);
      ack?.({ ok: true, participants: occupants.length + 1 });
    });

    socket.on('voice_state_change', async ({
      channelId, isMuted, isDeafened, isSpeaking, isVideo, isStreaming
    }) => {
      const userId = socket.data.userId;
      if (!userId || !channelId) return;
      const sets = [];
      const params = [];
      if (isMuted !== undefined) {
        // A suppressed stage-audience member cannot unmute; the roster keeps
        // showing them muted and the client keeps the track disabled.
        if (isMuted === false) {
          const st = await getQuery(`SELECT suppress FROM voice_states WHERE user_id = ?`, [userId]);
          if (st?.suppress) { socket.emit('voice_error', { channelId, code: 'SUPPRESSED', error: 'You are in the audience' }); return; }
        }
        sets.push('self_mute = ?'); params.push(isMuted ? 1 : 0);
      }
      if (isDeafened !== undefined)  { sets.push('self_deaf = ?');   params.push(isDeafened ? 1 : 0); }
      // Camera and screen share are part of the voice state too, so the roster
      // can show who is on video without waiting for a track to arrive.
      if (isVideo !== undefined)     { sets.push('self_video = ?');  params.push(isVideo ? 1 : 0); }
      if (isStreaming !== undefined) { sets.push('self_stream = ?'); params.push(isStreaming ? 1 : 0); }
      if (sets.length) {
        params.push(userId);
        await runQuery(`UPDATE voice_states SET ${sets.join(', ')} WHERE user_id = ?`, params);
      }
      // isSpeaking changes many times per second — never write it to disk.
      if (isSpeaking !== undefined) {
        if (isSpeaking) lastSpokeAt.set(userId, Date.now());
        io.to(`voice-${channelId}`).emit('voice_speaking', { channelId, userId, isSpeaking });
      }
      if (sets.length) await broadcastVoice(io, channelId);
    });

    /**
     * Soundboard.
     *
     * The clip is *not* mixed into the sender's microphone track. Everyone in
     * the room is told which sound to play and plays it locally, which keeps it
     * at full quality (a voice track is aggressively compressed and noise-gated,
     * which is exactly wrong for a sound effect) and costs the sender no extra
     * upstream — the thing that limits a full-mesh call.
     *
     * The trade is that a listener who has muted the sender still hears the
     * clip. Discord behaves the same way, and the alternative — routing effects
     * through the voice track — sounds terrible.
     */
    /**
     * Stage channels (Discord "Stage"): the audience raises a hand; a stage
     * moderator (MUTE_MEMBERS in the channel) invites them to speak or sends a
     * speaker back to the audience. Suppressed users cannot transmit — the
     * client disables the mic track, and the roster shows them as audience.
     */
    socket.on('stage_request_speak', async ({ channelId, requesting }, ack) => {
      const userId = socket.data.userId;
      if (!userId || !channelId) return;
      const state = await getQuery(
        `SELECT vs.channel_id, c.type FROM voice_states vs JOIN channels c ON c.id = vs.channel_id WHERE vs.user_id = ?`, [userId]
      );
      if (!state || state.channel_id !== channelId || state.type !== 'stage') {
        ack?.({ ok: false, code: 'NOT_ON_STAGE' }); return;
      }
      await runQuery(
        `UPDATE voice_states SET request_to_speak_at = ? WHERE user_id = ?`,
        [requesting ? new Date().toISOString() : null, userId]
      );
      await broadcastVoice(io, channelId);
      ack?.({ ok: true });
    });

    socket.on('stage_set_speaker', async ({ channelId, userId: targetId, speaker }, ack) => {
      const actorId = socket.data.userId;
      if (!actorId || !channelId || !targetId) return;
      const channel = await getQuery(`SELECT type FROM channels WHERE id = ? AND deleted_at IS NULL`, [channelId]);
      if (channel?.type !== 'stage') { ack?.({ ok: false, code: 'NOT_A_STAGE' }); return; }
      // A speaker may step down on their own; promoting anyone needs MUTE_MEMBERS.
      const selfDemote = actorId === targetId && !speaker;
      if (!selfDemote && !(await canInChannel({ channelId, userId: actorId, permission: 'MUTE_MEMBERS' }))) {
        ack?.({ ok: false, code: 'FORBIDDEN' }); return;
      }
      const { changes } = await runQuery(
        `UPDATE voice_states SET suppress = ?, request_to_speak_at = NULL WHERE user_id = ? AND channel_id = ?`,
        [speaker ? 0 : 1, targetId, channelId]
      );
      if (!changes) { ack?.({ ok: false, code: 'NOT_IN_CHANNEL' }); return; }
      for (const sid of socketsByUser.get(targetId) ?? []) {
        io.to(sid).emit('stage_speaker_changed', { channelId, speaker: Boolean(speaker), by: actorId });
      }
      await broadcastVoice(io, channelId);
      ack?.({ ok: true });
    });

    socket.on('play_sound', async ({ channelId, soundId }) => {
      const userId = socket.data.userId;
      if (!userId || !channelId || !soundId) return;

      // Must actually be in this voice channel — otherwise anyone who knows a
      // channel id could blast a room they are not in.
      const inRoom = await getQuery(
        `SELECT 1 FROM voice_states WHERE user_id = ? AND channel_id = ?`, [userId, channelId]
      );
      if (!inRoom) return socket.emit('voice_error', { code: 'NOT_IN_VOICE' });

      const sound = await getQuery(
        `SELECT s.id, s.name, s.url, s.volume, s.emoji
           FROM soundboard_sounds s
           JOIN channels c ON c.id = ?
          WHERE s.id = ? AND s.server_id = c.server_id`,
        [channelId, soundId]
      );
      if (!sound) return socket.emit('voice_error', { code: 'SOUND_NOT_FOUND' });

      // One clip at a time per person, so a held key cannot machine-gun the room.
      const last = soundCooldown.get(userId) ?? 0;
      if (Date.now() - last < SOUND_COOLDOWN_MS) return;
      soundCooldown.set(userId, Date.now());

      io.to(`voice-${channelId}`).emit('sound_played', {
        channelId, userId, sound
      });
    });

    socket.on('leave_voice', async ({ channelId }) => {
      const userId = socket.data.userId;
      if (!userId) return;
      socket.leave(`voice-${channelId}`);
      socket.data.voiceChannelId = null;
      await runQuery(`DELETE FROM voice_states WHERE user_id = ?`, [userId]);
      await broadcastVoice(io, channelId);
    });

    // --- WebRTC signalling (server only relays; media is peer-to-peer) --------

    socket.on('webrtc_offer', ({ targetSocketId, offer }) => {
      io.to(targetSocketId).emit('webrtc_offer', { senderSocketId: socket.id, offer });
    });
    socket.on('webrtc_answer', ({ targetSocketId, answer }) => {
      io.to(targetSocketId).emit('webrtc_answer', { senderSocketId: socket.id, answer });
    });
    socket.on('webrtc_ice_candidate', ({ targetSocketId, candidate }) => {
      io.to(targetSocketId).emit('webrtc_ice_candidate', { senderSocketId: socket.id, candidate });
    });

    // --- teardown ------------------------------------------------------------

    socket.on('disconnect', async () => {
      const userId = socket.data.userId;

      const voiceRow = await getQuery(
        `SELECT channel_id FROM voice_states WHERE socket_id = ?`, [socket.id]
      );
      if (voiceRow) {
        await runQuery(`DELETE FROM voice_states WHERE socket_id = ?`, [socket.id]);
        await broadcastVoice(io, voiceRow.channel_id);
      }

      if (!userId) return;
      const sockets = socketsByUser.get(userId);
      sockets?.delete(socket.id);

      // Only go offline once the user's *last* tab or device disconnects.
      if (sockets && sockets.size === 0) {
        socketsByUser.delete(userId);
        await userService.touchLastSeen(userId);
        // Keep an explicit "invisible" so it survives the next sign-in.
        const current = await getQuery(`SELECT status FROM users WHERE id = ?`, [userId]);
        if (current?.status !== 'invisible') {
          await userService.setPresence({ userId, status: 'offline' });
        }
        io.emit('presence_updated', { userId, status: 'offline' });
      }

      for (const [channelId, users] of typing) {
        if (users.has(userId)) clearTyping(io, channelId, userId);
      }
    });
  });

  return io;
}

// --- helpers -----------------------------------------------------------------

function clearTyping(io, channelId, userId) {
  const channelTyping = typing.get(channelId);
  if (!channelTyping?.has(userId)) return;
  clearTimeout(channelTyping.get(userId));
  channelTyping.delete(userId);
  if (channelTyping.size === 0) typing.delete(channelId);
  io.to(channelId).emit('typing_stop', { channelId, userId });
}

async function broadcastVoice(io, channelId) {
  const participants = await allQuery(
    `SELECT vs.user_id AS userId, vs.socket_id AS socketId,
            vs.self_mute AS isMuted, vs.self_deaf AS isDeafened,
            vs.self_video, vs.self_stream, vs.joined_at, vs.suppress, vs.request_to_speak_at,
            COALESCE(u.display_name, u.username) AS username, u.avatar_url
       FROM voice_states vs JOIN users u ON u.id = vs.user_id
      WHERE vs.channel_id = ?
      ORDER BY vs.joined_at ASC`,
    [channelId]
  );
  io.to(`voice-${channelId}`).emit('voice_participants', {
    channelId,
    participants: participants.map((p) => ({
      ...p,
      isMuted: Boolean(p.isMuted),
      isDeafened: Boolean(p.isDeafened),
      isVideo: Boolean(p.self_video),
      isStreaming: Boolean(p.self_stream),
      isSuppressed: Boolean(p.suppress),
      requestedToSpeakAt: p.request_to_speak_at ?? null,
      isSpeaking: false
    }))
  });
}

/**
 * Deliver the notification rows createMessage already persisted. Emitting is
 * all that happens here — the rows exist whether or not anyone is connected.
 */
/**
 * Unfurl any links in a message after it has already been delivered, then push
 * the updated message. Fire-and-forget on purpose — the send path must not wait
 * on a third-party site.
 */
export function resolveEmbedsInBackground(io, message) {
  if (!message?.content || !/https?:\/\//.test(message.content)) return;

  linkEmbeds.resolveEmbedsForContent(message.content)
    .then(async (embeds) => {
      if (!embeds.length) return;
      const updated = await messageService.attachEmbeds(message.id, embeds);
      if (updated) io.to(message.channel_id).emit('message_updated', updated);
    })
    .catch((err) => console.warn('embed resolve failed:', err.message));
}

/**
 * Deliver a freshly created message everywhere it needs to go:
 *   - the full message to sockets viewing that channel,
 *   - a light `channel_activity` ping to everyone else who can see the channel
 *     (guild members, or the DM's recipients) so unread markers update live,
 *   - mention/DM notification rows to the users concerned,
 *   - link previews, resolved in the background.
 */
export function fanOutMessage(io, message) {
  // An idempotent retry resolves to the message that already went out.
  if (message.duplicate) return;
  io.to(message.channel_id).emit('new_message', message);
  const activity = {
    channel_id: message.channel_id,
    server_id: message.server_id ?? null,
    message_id: message.id,
    author_id: message.user_id,
    created_at: message.created_at
  };
  // createMessage already worked out who may see this channel; reusing that
  // list keeps a private channel's activity out of the guild-wide room.
  if (Array.isArray(message.audience)) {
    for (const userId of message.audience) {
      io.to(`user-${userId}`).except(message.channel_id).emit('channel_activity', activity);
    }
  } else if (!message.server_id) {
    allQuery(`SELECT user_id FROM channel_recipients WHERE channel_id = ?`, [message.channel_id])
      .then((rows) => {
        for (const { user_id } of rows) {
          io.to(`user-${user_id}`).except(message.channel_id).emit('channel_activity', activity);
        }
      })
      .catch(() => {});
  }
  pushNotifications(io, message);
  resolveEmbedsInBackground(io, message);
}

export function pushNotifications(io, message) {
  for (const notification of message.notifications ?? []) {
    io.to(`user-${notification.user_id}`).emit('notification', { ...notification, message });
  }
}

/** Clear stale voice rows left behind by a crash. Call once at boot. */
/**
 * Move idle people to their server's AFK channel.
 *
 * Runs on a timer from server.js. A member is idle when they have not spoken
 * for the server's `afk_timeout`. Someone already in the AFK channel is left
 * alone, and a server with no AFK channel configured is skipped entirely.
 * Muted users count as idle too — Discord's rule, and the reason you land in
 * AFK if you go quiet with your mic off.
 */
/** Test hook: back-date a user's last activity so a sweep treats them as idle. */
export function __markIdle(userId, ms) { lastSpokeAt.set(userId, Date.now() - ms); }

export async function sweepAfk(io) {
  const servers = await allQuery(
    `SELECT id, afk_channel_id, afk_timeout FROM servers
      WHERE afk_channel_id IS NOT NULL AND deleted_at IS NULL`
  );
  let moved = 0;
  for (const server of servers) {
    const afkChannel = await getQuery(
      `SELECT id FROM channels WHERE id = ? AND server_id = ? AND type = 'voice' AND deleted_at IS NULL`,
      [server.afk_channel_id, server.id]
    );
    if (!afkChannel) continue;

    const timeoutMs = Math.max(60, Number(server.afk_timeout) || 300) * 1000;
    const idle = await allQuery(
      `SELECT user_id, channel_id FROM voice_states
        WHERE server_id = ? AND channel_id IS NOT NULL AND channel_id != ?`,
      [server.id, afkChannel.id]
    );

    for (const state of idle) {
      // No record means we have not observed this user since the process
      // started (a voice_state that survived a restart). Start their clock
      // now rather than moving them on the first sweep.
      if (!lastSpokeAt.has(state.user_id)) { lastSpokeAt.set(state.user_id, Date.now()); continue; }
      if (Date.now() - lastSpokeAt.get(state.user_id) < timeoutMs) continue;

      const from = state.channel_id;
      await runQuery(`UPDATE voice_states SET channel_id = ? WHERE user_id = ?`, [afkChannel.id, state.user_id]);
      lastSpokeAt.set(state.user_id, Date.now());   // do not bounce them again immediately

      // Tell the moved client so it re-joins the mesh in the new room, then
      // refresh both rosters.
      for (const socketId of socketsByUser.get(state.user_id) ?? []) {
        io.to(socketId).emit('voice_moved', { from, to: afkChannel.id, reason: 'afk' });
        const sock = io.sockets.sockets.get(socketId);
        if (sock) { sock.leave(`voice-${from}`); sock.join(`voice-${afkChannel.id}`); }
      }
      await broadcastVoice(io, from);
      await broadcastVoice(io, afkChannel.id);
      moved += 1;
    }
  }
  return moved;
}

export async function resetVolatileState() {
  await runQuery(`DELETE FROM voice_states`);
  await runQuery(`UPDATE users SET status = 'offline' WHERE status != 'invisible'`);
  // In-memory maps outlive a restart in tests, where the module is not reloaded.
  typing.clear();
  soundCooldown.clear();
  lastSpokeAt.clear();
}
