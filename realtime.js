// ============================================================================
//  Realtime layer — Socket.IO gateway.
//
//  Event names and payload shapes are unchanged from the prototype so the
//  existing client keeps working; what is new is that state (voice membership,
//  presence, read markers) is persisted rather than living only in a module
//  variable that dies with the process.
// ============================================================================

import { runQuery, getQuery, allQuery, sql } from './db.js';
import { generateId } from './lib/snowflake.js';
import * as messageService from './services/messages.js';
import * as userService from './services/users.js';
import * as linkEmbeds from './services/linkEmbeds.js';
import { resolveSession, SESSION_COOKIE } from './lib/auth.js';
import { config } from './lib/config.js';
import {
  assertChannelAccess, canInChannel, loadGuildPermissionContext, resolveMemberPermissions
} from './services/access.js';
import { messageAdmission } from './lib/admission.js';
import { permCacheStats } from './services/permCache.js';
import { resolveBotToken } from './services/applications.js';
import { checkSocketLimitShared, createFloodGuard } from './lib/rateLimit.js';
import {
  initRedis, attachSocketAdapter, redisConfigured, redisHealth, holdsLease, closeRedis
} from './lib/redis.js';
import * as presence from './lib/presence.js';
import { resolvePermissions } from './services/guilds.js';
import { ApiError, publicError } from './lib/httpUtils.js';
import { sessionEvents } from './lib/sessionEvents.js';
// livekit: optional SFU; every call is a no-op when it is not configured.
import * as livekit from './services/livekit.js';
import { getLogger } from './lib/logger.js';
import { bumpMetric } from './lib/middleware.js';
import { instrumentSocket, recordMessageSent, recordPushSend } from './lib/telemetry.js';

const log = getLogger('realtime');

/** What a socket client may see of an error: never raw database text. */
const clientError = (err) => publicError(err).body;

// Ephemeral state: typing indicators and the socket↔user mapping. These are
// intentionally in-memory — they are meaningless after a restart.
const typing = new Map();        // channelId -> Map<userId, timeoutId>
const socketsByUser = new Map(); // userId -> Set<socketId>

const TYPING_TTL_MS = 8000;
// A client re-sends typing_start every few seconds while the user types. Each
// re-send only refreshes the expiry; the room hears about it at most once per
// this interval, which is the difference between O(keystrokes x viewers) and
// O(viewers) fan-out for a busy channel.
const TYPING_REBROADCAST_MS = 3000;
const typingSentAt = new Map();  // `${channelId}:${userId}` -> last broadcast

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
async function authenticateSocket(socket, { userId, token, botToken }) {
  // A bot connects with its application token; it lands on the same socket
  // plumbing as a person, plus one extra room for its interactions.
  if (botToken) {
    const bot = await resolveBotToken(botToken);
    if (!bot) return null;
    socket.data.applicationId = bot.applicationId;
    return bot.userId;
  }
  const candidate = token || cookieToken(socket);
  if (candidate) {
    const session = await resolveSession(candidate);
    if (session) {
      // Remembered so ending the session (logout, revoke) can drop this socket.
      socket.data.sessionId = session.sessionId;
      return session.userId;
    }
  }
  if (config.allowDevIdentity && userId) return userId;
  return null;
}

// Upper bound on a full-mesh voice room. Each participant uploads one stream per
// other participant, so bandwidth grows linearly and quality collapses past this
// without a selective-forwarding unit.
const MESH_LIMIT = Number(process.env.VOICE_MESH_LIMIT) || 8;

// --- scaling & reliability ---------------------------------------------------

/** Brief-disconnect window in which a client resumes with its missed events. */
export const RECOVERY_WINDOW_MS = Math.max(0, Number(process.env.SOCKET_RECOVERY_MS ?? 120_000));
/** Largest single socket frame accepted (bytes). File bytes go over HTTP. */
export const SOCKET_MAX_PAYLOAD_BYTES = Math.max(16_384, Number(process.env.SOCKET_MAX_PAYLOAD_BYTES) || 512 * 1024);

/**
 * Socket.IO server options owned by the gateway. server.js spreads these into
 * `new Server(...)`.
 *
 * Connection state recovery: a client that drops for less than
 * RECOVERY_WINDOW_MS reconnects with the same socket id, its rooms and data,
 * and receives every room broadcast it missed. guardRecovery() re-checks the
 * session and every room before a restore is allowed — a permission revoked
 * while the client was away turns the restore into a fresh connection (the
 * client then re-identifies and catches up over REST), so a replayed packet can
 * never leak a channel the user has just lost.
 */
export function realtimeServerOptions() {
  return {
    maxHttpBufferSize: SOCKET_MAX_PAYLOAD_BYTES,
    ...(RECOVERY_WINDOW_MS > 0
      ? { connectionStateRecovery: { maxDisconnectionDuration: RECOVERY_WINDOW_MS, skipMiddlewares: false } }
      : {})
  };
}

const clustered = () => redisConfigured();
const timers = [];
let draining = false;

/** Is a live session still behind this socket's stored identity? */
async function identityStillValid(data) {
  if (data.applicationId) return false;          // bots re-identify with their token
  if (data.sessionId) {
    const row = await getQuery(
      `SELECT s.expires_at, u.deleted_at AS user_deleted
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ? AND s.user_id = ? AND s.revoked_at IS NULL`,
      [data.sessionId, data.userId]
    );
    if (!row || row.user_deleted) return false;
    const expires = Date.parse(row.expires_at);
    return !Number.isFinite(expires) || expires > Date.now();
  }
  return Boolean(config.allowDevIdentity);
}

/**
 * Should this stored session be resumed? Every room the socket held was an
 * access decision taken while it was connected; take each one again now.
 */
export async function recoveryAllowed(session) {
  const data = session?.data ?? {};
  const rooms = session?.rooms ?? [];
  const userId = data.userId;
  if (!userId) return rooms.every((room) => room === session.sid);
  if (!(await identityStillValid(data))) return false;
  for (const room of rooms) {
    if (room === session.sid || room === `user-${userId}`) continue;
    // Voice state is torn down on disconnect; the voice client rejoins itself.
    if (room.startsWith('voice-') || room.startsWith('user-') || room.startsWith('application-')) return false;
    const server = await getQuery(`SELECT id FROM servers WHERE id = ? AND deleted_at IS NULL`, [room]);
    if (server) {
      const resolved = await resolveMemberPermissions({ userId, serverId: room }).catch(() => null);
      if (!resolved?.isMember) return false;
      continue;
    }
    if (!(await canInChannel({ channelId: room, userId, permission: 'VIEW_CHANNEL' }))) return false;
  }
  return true;
}

/** Wrap the adapter's restoreSession with recoveryAllowed(). */
function guardRecovery(io) {
  const adapter = io.of('/').adapter;
  if (typeof adapter?.restoreSession !== 'function' || adapter.__agGuarded) return;
  const original = adapter.restoreSession.bind(adapter);
  adapter.restoreSession = async (pid, offset) => {
    const session = await original(pid, offset);
    if (!session) return session;
    try {
      return (await recoveryAllowed(session)) ? session : null;
    } catch (err) {
      log.warn({ err }, 'session recovery check failed');
      return null;
    }
  };
  adapter.__agGuarded = true;
}

/** A restored socket skipped `identify`; put it back in the books. */
async function onRecovered(io, socket) {
  const userId = socket.data.userId;
  if (!userId) return;
  if (!socketsByUser.has(userId)) socketsByUser.set(userId, new Set());
  socketsByUser.get(userId).add(socket.id);
  socket.data.voiceChannelId = null;
  const count = await presence.addConnection(userId, socket.id);
  if (count === 1) await comeOnline(io, userId, socket.data.chosenStatus);
  await touchLastSeen(userId);
}

// --- presence transitions ------------------------------------------------------
//
// A reconnect storm used to cost every user an offline write + broadcast and
// then an online write + broadcast to everyone related (docs/PERFORMANCE.md
// #5). Now:
//   - going offline waits PRESENCE_OFFLINE_GRACE_MS (default 5 s); a user who
//     reconnects inside it — here or on another instance — never went
//     offline for anyone else;
//   - coming online is a no-op (no write, no broadcast) when the stored
//     status already says present;
//   - last_seen_at is written at most once per LAST_SEEN_WRITE_MS per user.
const PRESENCE_OFFLINE_GRACE_MS = Math.max(0, Number(process.env.PRESENCE_OFFLINE_GRACE_MS ?? 5000));
const LAST_SEEN_WRITE_MS = 5 * 60_000;
const offlineTimers = new Map();   // userId -> timeout
const lastSeenWrites = new Map();  // userId -> ms

async function touchLastSeen(userId, { force = false } = {}) {
  const now = Date.now();
  if (!force && now - (lastSeenWrites.get(userId) ?? 0) < LAST_SEEN_WRITE_MS) return;
  if (lastSeenWrites.size > 100_000) lastSeenWrites.clear();
  lastSeenWrites.set(userId, now);
  await userService.touchLastSeen(userId);
}

/** First connection anywhere: announce, unless the stored status says present. */
async function comeOnline(io, userId, preferred = null) {
  const pending = offlineTimers.get(userId);
  if (pending) { clearTimeout(pending); offlineTimers.delete(userId); }
  const current = await getQuery(`SELECT status FROM users WHERE id = ?`, [userId]);
  // Still present (a reconnect inside the grace window, or "invisible", which
  // is kept across sessions as on Discord): nothing changed for anyone else.
  if (current && current.status !== 'offline') return;
  const status = ['online', 'idle', 'dnd'].includes(preferred) ? preferred : 'online';
  const user = await userService.setPresence({ userId, status });
  await emitToRelated(io, userId, 'presence_updated', { userId, status: user.status });
}

/** Last connection anywhere went away: go offline after the grace period. */
function scheduleOffline(io, userId) {
  clearTimeout(offlineTimers.get(userId));
  const run = async () => {
    offlineTimers.delete(userId);
    // Back already (another tab, another instance, a resumed socket)?
    if (await presence.connectionCount(userId) > 0) return;
    await touchLastSeen(userId, { force: true });
    const current = await getQuery(`SELECT status FROM users WHERE id = ?`, [userId]);
    // Invisible users already look offline and keep "invisible" for next time.
    if (!current || current.status === 'offline' || current.status === 'invisible') return;
    await userService.setPresence({ userId, status: 'offline' });
    await emitToRelated(io, userId, 'presence_updated', { userId, status: 'offline' });
  };
  const fail = (err) => log.error({ err }, 'offline transition failed');
  if (PRESENCE_OFFLINE_GRACE_MS === 0) return run().catch(fail);
  const timer = setTimeout(() => run().catch(fail), PRESENCE_OFFLINE_GRACE_MS);
  timer.unref?.();
  offlineTimers.set(userId, timer);
  return undefined;
}

/** Run pending offline transitions now (shutdown must not strand them). */
async function flushOfflineTimers(io) {
  const users = [...offlineTimers.keys()];
  for (const userId of users) {
    clearTimeout(offlineTimers.get(userId));
    offlineTimers.delete(userId);
  }
  for (const userId of users) {
    if (await presence.connectionCount(userId) > 0) continue;
    const current = await getQuery(`SELECT status FROM users WHERE id = ?`, [userId]).catch(() => null);
    if (!current || current.status === 'offline' || current.status === 'invisible') continue;
    await userService.setPresence({ userId, status: 'offline' }).catch(() => {});
    await emitToRelated(io, userId, 'presence_updated', { userId, status: 'offline' }).catch(() => {});
  }
}

/** Periodic cluster chores; nothing to do on a single node. */
function startClusterTimers(io) {
  if (!clustered()) return;
  const beat = setInterval(() => {
    presence.heartbeat().catch((err) => log.warn({ err }, 'presence heartbeat failed'));
  }, Math.floor(presence.PRESENCE_TTL_MS / 3));
  const reaper = setInterval(async () => {
    try {
      if (!(await holdsLease('presence-reaper', 60_000))) return;
      for (const userId of await presence.reap()) {
        const current = await getQuery(`SELECT status FROM users WHERE id = ?`, [userId]);
        if (current && current.status !== 'invisible' && current.status !== 'offline') {
          await userService.setPresence({ userId, status: 'offline' });
          await emitToRelated(io, userId, 'presence_updated', { userId, status: 'offline' });
        }
      }
      // Voice rows whose socket no longer exists anywhere in the cluster (an
      // instance crashed mid-call). A single node wipes these at boot instead.
      const live = new Set((await io.fetchSockets()).map((s) => s.id));
      const cutoff = Date.now() - 60_000;
      const rows = await allQuery(`SELECT user_id, channel_id, socket_id, joined_at FROM voice_states`);
      for (const row of rows) {
        if (live.has(row.socket_id) || !(Date.parse(row.joined_at) < cutoff)) continue;
        await runQuery(`DELETE FROM voice_states WHERE user_id = ? AND socket_id = ?`, [row.user_id, row.socket_id]);
        await broadcastVoice(io, row.channel_id);
      }
    } catch (err) {
      log.warn({ err }, 'cluster sweep failed');
    }
  }, 30_000);
  beat.unref?.();
  reaper.unref?.();
  timers.push(beat, reaper);
}

/**
 * Graceful drain, called by server.js on SIGTERM before io.close(). Clients
 * are told to come back (after a small random delay, so a rolling deploy does
 * not cause a reconnect stampede); io.close() then ends every socket with a
 * *recoverable* reason, so a client that reconnects — to another instance,
 * with Redis — inside the recovery window resumes with the events it missed.
 * Presence is deliberately not flipped offline: the user is about to be back,
 * and on a cluster the TTL reaper catches anyone who is not.
 */
export async function drainRealtime(io) {
  draining = true;
  for (const t of timers.splice(0)) clearInterval(t);
  await flushOfflineTimers(io).catch((err) => log.warn({ err }, 'offline flush failed'));
  io.emit('server_draining', { reconnect: true, retry_after_ms: 250 + Math.floor(Math.random() * 1750) });
  // Let the frame flush before the transports close.
  await new Promise((r) => setTimeout(r, 100));
}

/** Close the shared Redis client last, after io.close() persisted sessions. */
export async function closeRealtimeBackends() {
  await closeRedis();
}

export async function registerRealtime(io) {
  // Optional Redis/Valkey: cross-instance fan-out, recovery across instances,
  // shared rate limits and presence. Without REDIS_URL nothing changes.
  const redis = await initRedis();
  if (redis) {
    await attachSocketAdapter(io, redis);
    log.info('realtime: Redis Streams adapter enabled (multi-instance mode)');
  }
  guardRecovery(io);
  startClusterTimers(io);

  // Sessions ended elsewhere (logout, revoke, password change) take their
  // sockets with them.
  sessionEvents.on('revoked', (payload) => {
    disconnectSessions(io, payload).catch((err) => log.error({ err }, 'session disconnect failed'));
  });

  io.on('connection', (socket) => {
    // Event counters, and a span per event when tracing is on (lib/telemetry.js).
    instrumentSocket(socket);

    // --- flood protection ----------------------------------------------------
    // Cheap per-connection budgets for every inbound event; a connection that
    // keeps flooding after being throttled is dropped. See lib/rateLimit.js.
    const guard = createFloodGuard();
    socket.use((packet, next) => {
      const verdict = guard.check(packet[0]);
      if (verdict === 'ok') return next();
      const ack = packet[packet.length - 1];
      if (typeof ack === 'function') ack({ ok: false, code: 'RATE_LIMITED', error: 'Slow down' });
      if (verdict === 'disconnect') {
        socket.emit('rate_limited', { reason: 'flood' });
        socket.disconnect(true);
      }
      return undefined;
    });

    // A resumed connection keeps its identity and rooms (re-validated by
    // guardRecovery) but skips `identify`, so re-register it.
    if (socket.recovered) {
      onRecovered(io, socket).catch((err) => log.error({ err }, 'recovery bookkeeping failed'));
    }

    // --- identity ------------------------------------------------------------
    // The client announces who it is; replace with session-token validation
    // when auth lands (see lib/httpUtils.js identify()).
    socket.on('identify', async ({ userId, token, botToken } = {}) => {
      const resolvedId = await authenticateSocket(socket, { userId, token, botToken });
      if (!resolvedId) {
        socket.emit('identify_error', { error: 'Authentication required', code: 'UNAUTHENTICATED' });
        return;
      }
      // One socket, one identity. Re-identifying as someone else would leave
      // the socket in the first user's rooms and its id in their presence set.
      if (socket.data.userId && socket.data.userId !== resolvedId) {
        socket.emit('identify_error', { error: 'Socket already identified', code: 'ALREADY_IDENTIFIED' });
        return;
      }
      userId = resolvedId;
      socket.data.userId = userId;
      if (!socketsByUser.has(userId)) socketsByUser.set(userId, new Set());
      socketsByUser.get(userId).add(socket.id);
      // Cluster-wide connection count (a Map on a single node).
      const connections = await presence.addConnection(userId, socket.id);

      // A user's own room makes it easy to push notifications to every device.
      socket.join(`user-${userId}`);
      // An application's room is where its interactions are delivered.
      if (socket.data.applicationId) socket.join(`application-${socket.data.applicationId}`);

      // First socket for this user means they just came online. A user who
      // chose "invisible" stays invisible to others, as on Discord.
      if (connections === 1) await comeOnline(io, userId);
      await touchLastSeen(userId);
      socket.emit('identified', { userId, applicationId: socket.data.applicationId ?? null });
    });

    // Rooms decide who receives new_message, typing and reaction events, so
    // joining one is an access decision, not bookkeeping. Without this check a
    // client could subscribe to any private channel by guessing its id.
    socket.on('join_server', async (serverId, ack) => {
      const userId = socket.data.userId;
      if (!serverId || !userId) return ack?.({ ok: false, error: 'Authentication required' });
      const resolved = await resolveMemberPermissions({ userId, serverId }).catch(() => null);
      if (!resolved?.isMember) return ack?.({ ok: false, error: 'Not a member of this server' });
      socket.join(serverId);
      ack?.({ ok: true });
    });

    // Batch form for reconnects: one round trip re-joins every room the
    // client had, each still an access decision (served by the permission
    // cache). Returns the rooms actually joined and those refused.
    socket.on('join_rooms', async ({ servers = [], channels = [] } = {}, ack) => {
      const userId = socket.data.userId;
      if (!userId) return ack?.({ ok: false, error: 'Authentication required' });
      const list = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 100) : []);
      const joined = [];
      const refused = [];
      for (const serverId of list(servers)) {
        const resolved = await resolveMemberPermissions({ userId, serverId }).catch(() => null);
        if (resolved?.isMember) { socket.join(serverId); joined.push(serverId); } else refused.push(serverId);
      }
      for (const channelId of list(channels)) {
        if (await canInChannel({ channelId, userId, permission: 'VIEW_CHANNEL' })) {
          socket.join(channelId); joined.push(channelId);
        } else refused.push(channelId);
      }
      ack?.({ ok: true, joined, refused });
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
          attachments = [], reply_to_id: replyToId, nonce, sticker_id: stickerId,
          forwarded_from: forwardedFrom = null, allowed_mentions: allowedMentions = null
        } = data ?? {};
        const userId = socket.data.userId;
        if (!channelId) return;
        if (!userId) {
          ack?.({ ok: false, error: 'Authentication required', code: 'UNAUTHENTICATED' });
          return;
        }
        // The gateway bypasses Express, so it needs its own budget or the HTTP
        // write limit is trivially sidestepped by sending over the socket.
        // Shared across instances when Redis is configured.
        const budget = await checkSocketLimitShared(userId, 'send_message', { limit: 30, windowMs: 10_000 });
        if (!budget.allowed) {
          ack?.({
            ok: false, code: 'RATE_LIMITED',
            error: `Sending too fast — try again in ${Math.ceil(budget.retryAfterMs / 1000)} s`
          });
          return;
        }

        // Bounded concurrency: refuse with RETRY_LATER rather than queue
        // without limit when the database falls behind (lib/admission.js).
        const message = await messageAdmission.run(() => messageService.createMessage({
          channelId, userId, content, attachments, replyToId, nonce, stickerId, forwardedFrom, allowedMentions
        }));

        clearTyping(io, channelId, userId);
        ack?.({ ok: true, message });
        fanOutMessage(io, message);
      } catch (err) {
        log.error({ err, socket_id: socket.id }, 'send_message failed');
        const { error, code } = clientError(err);
        // The HTTP status tells the client whether a retry can help (a 403
        // never will — no "Retry" button for it).
        ack?.({ ok: false, error, code, status: publicError(err).status });
        socket.emit('message_error', { error, code, nonce: data?.nonce });
      }
    });

    socket.on('edit_message', async ({ messageId, content }, ack) => {
      try {
        const userId = socket.data.userId;
        if (!userId) throw ApiError.unauthorized();
        const message = await messageService.editMessage({ messageId, userId, content });
        io.to(message.channel_id).emit('message_updated', message);
        ack?.({ ok: true, message });
      } catch (err) {
        ack?.({ ok: false, ...clientError(err) });
      }
    });

    socket.on('delete_message', async ({ messageId }, ack) => {
      try {
        const userId = socket.data.userId;
        if (!userId) throw ApiError.unauthorized();
        const result = await messageService.deleteMessage({ messageId, userId });
        if (result) io.to(result.channel_id).emit('message_deleted', messageId);
        ack?.({ ok: true });
      } catch (err) {
        ack?.({ ok: false, ...clientError(err) });
      }
    });

    socket.on('toggle_reaction', async ({ messageId, channelId, emoji }, ack) => {
      try {
        const userId = socket.data.userId;
        if (!userId) throw ApiError.unauthorized();
        const result = await messageService.toggleReaction({ messageId, userId, emoji });
        io.to(result.channelId ?? channelId).emit('reaction_updated', {
          messageId: result.messageId,
          reactions: result.reactions,
          reaction_details: result.reaction_details
        });
        ack?.({ ok: true });
      } catch (err) {
        const { error, code } = clientError(err);
        ack?.({ ok: false, error, code });
        socket.emit('action_error', { action: 'toggle_reaction', error, code });
      }
    });

    socket.on('mark_read', async ({ channelId, messageId } = {}) => {
      try {
        const userId = socket.data.userId;
        if (!userId || !channelId) return;
        const state = await messageService.markRead({ userId, channelId, messageId });
        io.to(`user-${userId}`).emit('read_state_updated', state);
      } catch (err) {
        log.error({ err, socket_id: socket.id }, 'mark_read failed');
      }
    });

    // --- typing --------------------------------------------------------------

    socket.on('typing_start', ({ channelId, displayName } = {}) => {
      const userId = socket.data.userId;
      if (!channelId || !userId) return;
      // Only in a channel this socket joined through join_channel's access
      // check; otherwise anyone could announce typing in any channel by id.
      if (!socket.rooms.has(channelId)) return;
      if (!typing.has(channelId)) typing.set(channelId, new Map());
      const channelTyping = typing.get(channelId);

      clearTimeout(channelTyping.get(userId));
      // Self-expiring: a client that disconnects mid-typing must not leave a
      // permanent "… is typing" in everyone else's UI.
      channelTyping.set(userId, setTimeout(() => clearTyping(io, channelId, userId), TYPING_TTL_MS));

      const sentKey = `${channelId}:${userId}`;
      const last = typingSentAt.get(sentKey) ?? 0;
      if (Date.now() - last < TYPING_REBROADCAST_MS) return;
      typingSentAt.set(sentKey, Date.now());
      socket.to(channelId).emit('typing', {
        channelId, userId, displayName: typeof displayName === 'string' ? displayName.slice(0, 64) : undefined
      });
    });

    socket.on('typing_stop', ({ channelId } = {}) => {
      if (socket.data.userId) clearTyping(io, channelId, socket.data.userId);
    });

    // --- presence ------------------------------------------------------------

    socket.on('update_presence', async ({ status, customStatus } = {}) => {
      try {
        const userId = socket.data.userId;
        if (!userId) return;
        // Remember the chosen status so a reconnect restores it instead of
        // snapping back to "online".
        socket.data.chosenStatus = status;
        const user = await userService.setPresence({ userId, status, customStatus });
        // Others see an invisible user as offline; only the user's own devices
        // learn the real value.
        await emitToRelated(io, userId, 'presence_updated', {
          userId, status: user.status === 'invisible' ? 'offline' : user.status,
          custom_status: user.custom_status
        }, { userId, status: user.status, custom_status: user.custom_status });
      } catch (err) {
        log.error({ err, socket_id: socket.id }, 'update_presence failed');
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
        const { error, code } = clientError(err);
        ack?.({ ok: false, error, code });
        socket.emit('voice_error', { channelId, code, error });
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
      // With the LiveKit SFU each participant uploads once whatever the room
      // size, so only the channel's own limit (and LIVEKIT_ROOM_LIMIT) apply.
      const cap = voiceCapacity(channel);
      if (cap && occupants.length + 1 > cap) {
        ack?.({ ok: false, error: `This voice channel is full (${cap} max)`, code: 'VOICE_FULL' });
        socket.emit('voice_error', {
          channelId,
          code: 'VOICE_FULL',
          error: `This voice channel holds at most ${cap} people`
        });
        return;
      }

      socket.join(`voice-${channelId}`);
      socket.data.voiceChannelId = channelId;

      await runQuery(
        `INSERT INTO voice_states (user_id, channel_id, server_id, session_id, socket_id, joined_at)
         VALUES (?, ?, ?, ?, ?, ${sql.now})
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
      // A server mute/deafen belongs to the member, not the session, so leaving
      // and rejoining does not shake it off.
      const member = channel?.server_id
        ? await getQuery(`SELECT is_mute, is_deaf FROM server_members WHERE server_id = ? AND user_id = ?`, [channel.server_id, userId])
        : null;
      await runQuery(
        `UPDATE voice_states SET suppress = ?, request_to_speak_at = NULL, server_mute = ?, server_deaf = ? WHERE user_id = ?`,
        [isStage && !isStageMod ? 1 : 0, member?.is_mute ? 1 : 0, member?.is_deaf ? 1 : 0, userId]
      );

      lastSpokeAt.set(userId, Date.now());
      await broadcastVoice(io, channelId);
      ack?.({ ok: true, participants: occupants.length + 1 });
    });

    socket.on('voice_state_change', async ({
      channelId, isMuted, isDeafened, isSpeaking, isVideo, isStreaming
    } = {}) => {
      const userId = socket.data.userId;
      if (!userId || !channelId) return;
      // The state and the speaking indicator belong to the room this socket
      // is actually in; a claimed channelId must not reach another room.
      if (!socket.rooms.has(`voice-${channelId}`)) return;
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
      // The user's own room reaches their sockets on every instance.
      io.to(`user-${targetId}`).emit('stage_speaker_changed', { channelId, speaker: Boolean(speaker), by: actorId });
      // The SFU enforces it too: a promoted speaker may now publish, a demoted
      // one has their tracks unpublished.
      await livekit.syncParticipantGrants(channelId, targetId);
      await broadcastVoice(io, channelId);
      ack?.({ ok: true });
    });

    /**
     * A Super Reaction is pure flourish: the reaction itself already went
     * through the REST API, and this only tells the room to play the burst.
     * Nothing is stored, and the sender must be able to see the channel.
     */
    socket.on('super_reaction', async ({ channelId, messageId, emoji } = {}) => {
      const userId = socket.data.userId;
      if (!userId || !channelId || !messageId || !emoji) return;
      const allowed = await canInChannel({ channelId, userId, permission: 'ADD_REACTIONS' });
      if (!allowed) return;
      socket.to(channelId).emit('super_reaction', {
        channelId, messageId, emoji: String(emoji).slice(0, 64), userId
      });
    });

    socket.on('play_sound', async ({ channelId, soundId } = {}) => {
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

    socket.on('leave_voice', async ({ channelId } = {}) => {
      const userId = socket.data.userId;
      if (!userId) return;
      for (const room of [...socket.rooms]) if (room.startsWith('voice-')) socket.leave(room);
      socket.leave(`voice-${channelId}`);
      socket.data.voiceChannelId = null;
      await runQuery(`DELETE FROM voice_states WHERE user_id = ?`, [userId]);
      await broadcastVoice(io, channelId);
    });

    // --- WebRTC signalling (server only relays; media is peer-to-peer) --------

    // `io.to(x)` addresses *any* room, so an unchecked targetSocketId of a
    // channel or `user-…` id broadcast signalling to a whole audience, and an
    // anonymous socket could push offers at anyone. Relay only between two
    // identified sockets that share the same voice room.
    //
    // The target may live on another instance (REDIS_URL cluster), so its
    // membership is checked against voice_states — the row the gateway wrote
    // when that socket joined — and the message goes out through the adapter
    // (io.to(socketId)). A socket on this instance is checked in memory. The
    // verdict is cached briefly: a join trickles dozens of ICE candidates.
    const relayVerdicts = new Map();   // `${target}|${room}` -> { ok, at }
    const relayTarget = async (targetSocketId) => {
      if (!socket.data.userId || typeof targetSocketId !== 'string' || !targetSocketId || targetSocketId.length > 64) return false;
      const room = voiceRoomOf(socket);
      if (!room) return false;
      const local = io.sockets.sockets.get(targetSocketId);
      if (local) return Boolean(local.data?.userId) && voiceRoomOf(local) === room;
      const key = `${targetSocketId}|${room}`;
      const cached = relayVerdicts.get(key);
      if (cached && Date.now() - cached.at < 5000) return cached.ok;
      const row = await getQuery(
        `SELECT 1 AS ok FROM voice_states WHERE socket_id = ? AND channel_id = ?`, [targetSocketId, room]
      ).catch(() => null);
      if (relayVerdicts.size > 200) relayVerdicts.clear();
      relayVerdicts.set(key, { ok: Boolean(row), at: Date.now() });
      return Boolean(row);
    };
    const relay = (event, field) => async ({ targetSocketId, [field]: body } = {}) => {
      if (await relayTarget(targetSocketId)) {
        io.to(targetSocketId).emit(event, { senderSocketId: socket.id, [field]: body });
      }
    };
    socket.on('webrtc_offer', relay('webrtc_offer', 'offer'));
    socket.on('webrtc_answer', relay('webrtc_answer', 'answer'));
    socket.on('webrtc_ice_candidate', relay('webrtc_ice_candidate', 'candidate'));

    // --- teardown ------------------------------------------------------------

    socket.on('disconnect', async () => {
      const userId = socket.data.userId;
      // Draining for a deploy: the client is told to reconnect (probably to
      // another instance) - do not flap everyone offline on the way out.
      if (draining) {
        socketsByUser.get(userId)?.delete(socket.id);
        return;
      }

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
      if (sockets && sockets.size === 0) socketsByUser.delete(userId);
      const remaining = sockets ? await presence.removeConnection(userId, socket.id) : 1;

      // Only go offline once the user's *last* tab or device disconnects -
      // on any instance, when several share Redis.
      // After the grace period, so a quick reconnect emits nothing at all.
      if (sockets && remaining === 0) scheduleOffline(io, userId);

      for (const [channelId, users] of typing) {
        if (users.has(userId)) clearTyping(io, channelId, userId);
      }
    });
  });

  return io;
}

// --- helpers -----------------------------------------------------------------

/**
 * Re-check every channel room a user's sockets are in and drop the ones they
 * may no longer view. Room membership is an access decision taken once, at
 * join_channel; without this a kicked/banned member, someone removed from a
 * group DM, or a member who just lost VIEW_CHANNEL to an overwrite or role
 * change keeps receiving that channel's messages until they reconnect.
 *
 * `userIds` null means "everyone in these rooms" (used after a permission
 * change that can affect many members). `serverId` also re-checks the guild
 * room itself.
 */
export async function revalidateRooms(io, { userIds = null, serverId = null, channelIds = null } = {}) {
  // Scope is always a guild or an explicit channel list, so a room that
  // belongs to something else (another guild's room) is never touched.
  if (!io || (!serverId && !channelIds?.length)) return;
  let sockets;
  if (userIds) {
    sockets = [];
    for (const uid of userIds) sockets.push(...(await io.in(`user-${uid}`).fetchSockets()));
  }
  const serverChannels = serverId
    ? new Set((await allQuery(`SELECT id FROM channels WHERE server_id = ?`, [serverId])).map((c) => c.id))
    : null;
  // Guild scope: one bulk permission context answers every member/channel
  // question below, instead of ~5 queries per (user, room) pair.
  const ctx = serverId ? await loadGuildPermissionContext(serverId).catch(() => null) : null;
  if (!sockets) {
    // A socket can sit in a channel room without the guild room, so both.
    const rooms = serverId ? [serverId, ...serverChannels] : channelIds;
    sockets = await io.in(rooms).fetchSockets();
  }
  const verdicts = new Map();   // `${userId}:${room}` -> boolean
  const check = async (userId, room, fn) => {
    const key = `${userId}:${room}`;
    if (!verdicts.has(key)) verdicts.set(key, await fn().catch(() => false));
    return verdicts.get(key);
  };

  for (const sock of sockets) {
    const userId = sock.data?.userId;
    if (!userId) continue;
    for (const room of [...sock.rooms]) {
      if (room === sock.id || room.startsWith('user-') || room.startsWith('application-')) continue;
      if (serverId && room === serverId) {
        const member = await check(userId, room, async () => (ctx
          ? ctx.members.some((m) => m.user_id === userId)
          : (await resolvePermissions({ userId, serverId })).isMember));
        if (!member) sock.leave(room);
        continue;
      }
      if (room.startsWith('voice-')) {
        // Voice is an access decision too: someone kicked, banned or stripped
        // of CONNECT must drop out of the call, not keep relaying media until
        // they hang up themselves.
        const voiceChannel = room.slice('voice-'.length);
        if (channelIds && !channelIds.includes(voiceChannel)) continue;
        if (serverChannels && !channelIds && !serverChannels.has(voiceChannel)) continue;
        const mayStay = await check(userId, room, () =>
          canInChannel({ channelId: voiceChannel, userId, permission: 'CONNECT' }));
        if (!mayStay) await evictFromVoice(io, sock, voiceChannel);
        continue;
      }
      if (channelIds && !channelIds.includes(room)) continue;
      if (serverChannels && !channelIds && !serverChannels.has(room)) continue;
      const allowed = await check(userId, room, async () => ((ctx && serverChannels?.has(room))
        ? ctx.can(userId, room, 'VIEW_CHANNEL')
        : canInChannel({ channelId: room, userId, permission: 'VIEW_CHANNEL' })));
      if (!allowed) sock.leave(room);
    }
  }

  // A voice_states row can outlive its socket's room (a reconnect in flight,
  // another process's socket). For explicitly named users who are no longer
  // members of the guild, clear their voice presence there regardless.
  if (serverId && userIds?.length) {
    for (const uid of userIds) {
      const stillMember = await check(uid, serverId, async () =>
        (await resolvePermissions({ userId: uid, serverId })).isMember);
      if (stillMember) continue;
      const row = await getQuery(
        `SELECT channel_id FROM voice_states WHERE user_id = ? AND server_id = ?`, [uid, serverId]
      );
      if (!row) continue;
      await runQuery(`DELETE FROM voice_states WHERE user_id = ? AND server_id = ?`, [uid, serverId]);
      await broadcastVoice(io, row.channel_id);
    }
  }
}

/**
 * Emit `event` about `userId` to the people who can know that user — those
 * sharing a server, a DM or a friendship (the same scope as GET /api/users) —
 * rather than to every socket on the instance, which let anyone track
 * everyone's presence and profile changes.
 *
 * `selfPayload`, when given, goes to the user's own devices instead (they may
 * see fields others must not, such as their own "invisible" status).
 */
export async function emitToRelated(io, userId, event, payload, selfPayload = undefined) {
  if (!io || !userId) return;
  const rooms = (await relatedUserIds(userId))
    .filter((id) => id !== userId)
    .map((id) => `user-${id}`);
  // One broadcast to the union of rooms: one adapter publish (one XADD with
  // Redis) per presence change, not one per related user.
  if (rooms.length) io.to(rooms).emit(event, payload);
  io.to(`user-${userId}`).emit(event, selfPayload === undefined ? payload : selfPayload);
}

/**
 * Ids of everyone who may know `userId` — same scope as userService.listUsers
 * (shared guild, shared DM, friendship) but ids only, without sorting or
 * profile columns: this runs on every presence change.
 */
async function relatedUserIds(userId) {
  const rows = await allQuery(
    `SELECT them.user_id AS id FROM server_members them
       JOIN server_members me ON me.server_id = them.server_id
      WHERE me.user_id = ? AND me.left_at IS NULL AND them.left_at IS NULL
     UNION
     SELECT them.user_id FROM channel_recipients them
       JOIN channel_recipients me ON me.channel_id = them.channel_id
      WHERE me.user_id = ?
     UNION
     SELECT friend_id FROM friends WHERE user_id = ?
     UNION
     SELECT user_id FROM friends WHERE friend_id = ?`,
    [userId, userId, userId, userId]
  );
  return rows.map((r) => r.id);
}

/** Remove one socket from a voice room: state row, room, peers told. */
async function evictFromVoice(io, sock, channelId) {
  sock.leave(`voice-${channelId}`);
  if (sock.data.voiceChannelId === channelId) sock.data.voiceChannelId = null;
  await runQuery(
    `DELETE FROM voice_states WHERE user_id = ? AND channel_id = ?`, [sock.data.userId, channelId]
  );
  // The client tears down its peer connections on this; the others see the
  // roster change through broadcastVoice.
  sock.emit('voice_disconnected', { channelId, reason: 'removed' });
  // With the SFU the media session is separate from the socket room.
  await livekit.removeParticipant(channelId, sock.data.userId, { revoke: true });
  await broadcastVoice(io, channelId);
}

/**
 * The voice channel a socket is in, read from its rooms rather than from
 * socket.data: rooms follow a socket across instances (a moderator move on
 * another node joins/leaves rooms through the adapter), data does not.
 */
function voiceRoomOf(sock) {
  for (const room of sock?.rooms ?? []) if (room.startsWith('voice-')) return room.slice('voice-'.length);
  return null;
}

/** How many may be in a voice channel at once; 0 = no limit. */
function voiceCapacity(channel) {
  const own = Number(channel?.user_limit) || 0;
  const cfg = livekit.livekitConfig();
  if (cfg.enabled) {
    const caps = [own, cfg.roomLimit].filter((n) => n > 0);
    return caps.length ? Math.min(...caps) : 0;
  }
  return Math.min(own || MESH_LIMIT, MESH_LIMIT);
}

/**
 * Move a user's voice session to another channel: state row, socket rooms,
 * the client told (it rejoins the media there), both rosters refreshed. Used by
 * the AFK sweep and by moderators (MOVE_MEMBERS).
 */
export async function moveVoiceMember(io, userId, from, to, reason = 'moved') {
  const target = await getQuery(`SELECT server_id FROM channels WHERE id = ?`, [to]);
  await runQuery(
    `UPDATE voice_states SET channel_id = ?, server_id = ?, suppress = 0, request_to_speak_at = NULL WHERE user_id = ?`,
    [to, target?.server_id ?? null, userId]
  );
  const toStage = await getQuery(`SELECT type FROM channels WHERE id = ?`, [to]);
  if (toStage?.type === 'stage' && !(await canInChannel({ channelId: to, userId, permission: 'MUTE_MEMBERS' }))) {
    await runQuery(`UPDATE voice_states SET suppress = 1 WHERE user_id = ?`, [userId]);
  }
  // The user's room and fetchSockets() both span every instance.
  io.to(`user-${userId}`).emit('voice_moved', { from, to, reason });
  const sockets = typeof io.in === 'function' ? await io.in(`user-${userId}`).fetchSockets() : [];
  for (const sock of sockets) {
    if (!sock.rooms.has(`voice-${from}`)) continue;
    sock.leave(`voice-${from}`);
    sock.join(`voice-${to}`);
    if (sock.data) sock.data.voiceChannelId = to;
  }
  // The client reconnects to the new room with a fresh token; the old media
  // session must not linger (or keep a moved user audible in the old room).
  await livekit.removeParticipant(from, userId);
  await broadcastVoice(io, from);
  await broadcastVoice(io, to);
}

/** Disconnect a user from voice entirely (moderator "Disconnect"). */
export async function disconnectVoiceMember(io, userId, channelId) {
  let evicted = false;
  for (const sock of await io.in(`user-${userId}`).fetchSockets()) {
    if (!sock.rooms.has(`voice-${channelId}`)) continue;
    await evictFromVoice(io, sock, channelId);
    evicted = true;
  }
  if (!evicted) {
    // Only on the SFU (joined without a live socket): clear the row and room.
    await runQuery(`DELETE FROM voice_states WHERE user_id = ? AND channel_id = ?`, [userId, channelId]);
    await livekit.removeParticipant(channelId, userId, { revoke: true });
    await broadcastVoice(io, channelId);
  }
}

/**
 * Apply a server mute / deafen. It is stored on the membership (it outlives
 * the session, as on Discord) and mirrored into the live voice state; the SFU
 * revokes the corresponding publish/subscribe permission, and the target's
 * client is told so it can reflect it immediately.
 */
export async function setServerVoiceState(io, { serverId, channelId, userId, mute, deaf, by }) {
  const sets = [];
  const params = [];
  if (mute !== undefined) { sets.push('is_mute = ?'); params.push(mute ? 1 : 0); }
  if (deaf !== undefined) { sets.push('is_deaf = ?'); params.push(deaf ? 1 : 0); }
  if (!sets.length) return;
  await runQuery(`UPDATE server_members SET ${sets.join(', ')} WHERE server_id = ? AND user_id = ?`, [...params, serverId, userId]);
  await runQuery(
    `UPDATE voice_states SET ${sets.map((s) => s.replace('is_mute', 'server_mute').replace('is_deaf', 'server_deaf')).join(', ')} WHERE user_id = ?`,
    [...params, userId]
  );
  io.to(`user-${userId}`).emit('voice_server_state', {
    channelId, serverId, by, ...(mute !== undefined ? { serverMute: Boolean(mute) } : {}), ...(deaf !== undefined ? { serverDeaf: Boolean(deaf) } : {})
  });
  await livekit.syncParticipantGrants(channelId, userId);
  await broadcastVoice(io, channelId);
}

/**
 * Server mute (or unmute) several members of one voice channel at once — the
 * teacher's "Mute everyone". Same storage and enforcement as the single
 * action above, but the roster is broadcast once at the end instead of once per
 * member, so a class of thirty does not produce thirty roster refreshes.
 */
export async function setServerMuteMany(io, { serverId, channelId, userIds, mute, by }) {
  const value = mute ? 1 : 0;
  for (const userId of userIds) {
    await runQuery(`UPDATE server_members SET is_mute = ? WHERE server_id = ? AND user_id = ?`, [value, serverId, userId]);
    await runQuery(`UPDATE voice_states SET server_mute = ? WHERE user_id = ? AND channel_id = ?`, [value, userId, channelId]);
    io.to(`user-${userId}`).emit('voice_server_state', { channelId, serverId, by, serverMute: Boolean(mute), bulk: true });
    await livekit.syncParticipantGrants(channelId, userId);
  }
  await broadcastVoice(io, channelId);
}

/**
 * Sessions end (logout, revoke from another device, password change, account
 * deletion): sockets that authenticated with them must not keep receiving
 * events. Called through lib/sessionEvents.js so auth code needs no io handle.
 */
export async function disconnectSessions(io, { sessionIds = null, userId = null, exceptSessionId = null } = {}) {
  if (!io) return 0;
  const targets = userId
    ? await io.in(`user-${userId}`).fetchSockets()
    : await io.fetchSockets();
  let dropped = 0;
  for (const sock of targets) {
    const sid = sock.data?.sessionId;
    if (!sid || sid === exceptSessionId) continue;
    if (sessionIds && !sessionIds.includes(sid)) continue;
    sock.emit('session_revoked', { reason: 'session_ended' });
    sock.disconnect(true);
    dropped += 1;
  }
  return dropped;
}

/**
 * Emit a channel lifecycle event (created/updated/thread created) to the
 * members of its guild room who can actually view the channel. A plain
 * io.to(serverId) would announce a private channel's name and topic to every
 * member of the guild.
 */
export async function emitToChannelViewers(io, channel, event, payload = channel) {
  if (!channel?.server_id) return;
  // Visibility is computed once for the whole guild from a single permission
  // context (a handful of queries), not per socket; the event then goes out
  // as ONE room broadcast that excludes the members who may not see the
  // channel. No fetchSockets() round trip — which, with several instances,
  // would be a cluster-wide request per event — and the broadcast is
  // recorded for connection-state recovery like any other room event.
  if (channel.type === 'category') {
    io.to(channel.server_id).emit(event, payload);
    return;
  }
  const ctx = await loadGuildPermissionContext(channel.server_id);
  if (!ctx) return;
  const hidden = [];
  for (const m of ctx.members) {
    if (!ctx.can(m.user_id, channel.id, 'VIEW_CHANNEL')) hidden.push(`user-${m.user_id}`);
  }
  // Identified sockets that are not (or no longer) members never pass the
  // guild room's join check / revalidateRooms, so members are the whole set.
  io.to(channel.server_id).except(hidden).emit(event, payload);
}

function clearTyping(io, channelId, userId) {
  const channelTyping = typing.get(channelId);
  if (!channelTyping?.has(userId)) return;
  clearTimeout(channelTyping.get(userId));
  channelTyping.delete(userId);
  typingSentAt.delete(`${channelId}:${userId}`);
  if (channelTyping.size === 0) typing.delete(channelId);
  io.to(channelId).emit('typing_stop', { channelId, userId });
}

export async function broadcastVoice(io, channelId) {
  if (!channelId) return;
  const participants = await allQuery(
    `SELECT vs.user_id AS "userId", vs.socket_id AS "socketId",
            vs.self_mute AS "isMuted", vs.self_deaf AS "isDeafened",
            vs.self_video, vs.self_stream, vs.joined_at, vs.suppress, vs.request_to_speak_at,
            vs.server_mute, vs.server_deaf,
            COALESCE(u.display_name, u.username) AS username, u.avatar_url
       FROM voice_states vs JOIN users u ON u.id = vs.user_id
      WHERE vs.channel_id = ?
      ORDER BY vs.joined_at ASC`,
    [channelId]
  );
  const shaped = participants.map((p) => ({
      ...p,
      isMuted: Boolean(p.isMuted),
      isDeafened: Boolean(p.isDeafened),
      isVideo: Boolean(p.self_video),
      isStreaming: Boolean(p.self_stream),
      isSuppressed: Boolean(p.suppress),
      isServerMuted: Boolean(p.server_mute),
      isServerDeafened: Boolean(p.server_deaf),
      requestedToSpeakAt: p.request_to_speak_at ?? null,
      isSpeaking: false
    }));
  io.to(`voice-${channelId}`).emit('voice_participants', { channelId, participants: shaped });
  // Everyone in the guild who can see the channel gets its occupant list too,
  // so the sidebar can show who is in every voice channel, not only yours.
  broadcastGuildVoiceRoster(io, channelId, shaped).catch((err) =>
    log.warn({ err: { message: err.message } }, 'voice roster broadcast failed'));
}

/**
 * Guild-wide voice roster: `voice_roster { serverId, channelId, participants }`
 * to the user rooms of every member allowed to VIEW the channel (never the
 * whole guild room — a private voice channel's occupants stay private).
 * Only presentation fields travel; socket ids stay inside the voice room.
 */
async function broadcastGuildVoiceRoster(io, channelId, participants) {
  const channel = await getQuery(`SELECT server_id FROM channels WHERE id = ?`, [channelId]);
  if (!channel?.server_id) return;
  const ctx = await loadGuildPermissionContext(channel.server_id);
  if (!ctx) return;
  const rooms = ctx.members
    .filter((m) => ctx.can(m.user_id, channelId, 'VIEW_CHANNEL'))
    .map((m) => `user-${m.user_id}`);
  if (!rooms.length) return;
  io.to(rooms).emit('voice_roster', {
    serverId: channel.server_id,
    channelId,
    participants: participants.map((p) => ({
      userId: p.userId, username: p.username, avatar_url: p.avatar_url ?? null,
      isMuted: p.isMuted, isDeafened: p.isDeafened, isVideo: p.isVideo, isStreaming: p.isStreaming,
      isServerMuted: p.isServerMuted, isServerDeafened: p.isServerDeafened, isSuppressed: p.isSuppressed
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
    .catch((err) => log.warn({ err: { message: err.message, code: err.code } }, 'embed resolve failed'));
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
  bumpMetric('messagesSent');
  recordMessageSent();
  // An ephemeral reply goes to one person's sockets, never to the channel
  // room — everyone else must not learn it exists.
  if (message.ephemeral) {
    const target = message.ephemeral_for ?? null;
    if (target) io.to(`user-${target}`).emit('new_message', message);
    return;
  }
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
  // One broadcast to the union of the audience's user rooms (one adapter
  // publish, one XADD with Redis) rather than one emit per member.
  const toUsers = (ids) => {
    if (ids.length) io.to(ids.map((id) => `user-${id}`)).except(message.channel_id).emit('channel_activity', activity);
  };
  if (Array.isArray(message.audience)) {
    toUsers(message.audience);
  } else if (!message.server_id) {
    allQuery(`SELECT user_id FROM channel_recipients WHERE channel_id = ?`, [message.channel_id])
      .then((rows) => toUsers(rows.map((r) => r.user_id)))
      .catch(() => {});
  }
  pushNotifications(io, message);
  resolveEmbedsInBackground(io, message);
}

export function pushNotifications(io, message) {
  const notifications = message.notifications ?? [];
  for (const notification of notifications) {
    io.to(`user-${notification.user_id}`).emit('notification', { ...notification, message });
  }
  if (notifications.length) recordPushSend('socket', 'ok', notifications.length);
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
      // Speaking timestamps are per process: on a cluster, only the instance
      // holding the user's socket can judge them idle.
      if (clustered() && !socketsByUser.has(state.user_id)) continue;
      if (!lastSpokeAt.has(state.user_id)) { lastSpokeAt.set(state.user_id, Date.now()); continue; }
      if (Date.now() - lastSpokeAt.get(state.user_id) < timeoutMs) continue;

      const from = state.channel_id;
      lastSpokeAt.set(state.user_id, Date.now());   // do not bounce them again immediately
      // Tell the moved client so it re-joins the media in the new room, then
      // refresh both rosters.
      await moveVoiceMember(io, state.user_id, from, afkChannel.id, 'afk');
      moved += 1;
    }
  }
  return moved;
}

export async function resetVolatileState() {
  // On a cluster (REDIS_URL) the other instances' calls and presence are
  // live: one instance booting must not wipe them. Stale rows left by a
  // crashed instance are reaped by the TTL/voice sweep in startClusterTimers.
  if (!clustered()) {
    await runQuery(`DELETE FROM voice_states`);
    await runQuery(`UPDATE users SET status = 'offline' WHERE status != 'invisible'`);
  }
  // In-memory maps outlive a restart in tests, where the module is not reloaded.
  typing.clear();
  typingSentAt.clear();
  for (const t of offlineTimers.values()) clearTimeout(t);
  offlineTimers.clear();
  lastSeenWrites.clear();
  soundCooldown.clear();
  lastSpokeAt.clear();
}

export { holdsLease } from './lib/redis.js';
export { messageAdmission } from './lib/admission.js';

/**
 * Gateway mode for /api/health and /api/ready. Deliberately terse (no hosts,
 * no error text): /api/health is public.
 */
export function realtimeHealth() {
  const redis = redisHealth();
  return {
    mode: redis.enabled ? 'cluster' : 'single',
    redis: redis.enabled ? (redis.connected ? 'connected' : 'disconnected') : 'disabled',
    recovery_window_ms: RECOVERY_WINDOW_MS,
    message_admission: messageAdmission.snapshot(),
    permission_cache: permCacheStats(),
    // A cluster member that lost Redis cannot fan out to the other
    // instances; it should leave the load-balancer pool until it is back.
    ready: !redis.enabled || redis.connected
  };
}
