// ============================================================================
//  Antigravity Discord — application server.
//
//  This file is the composition root only: wiring, middleware, route mounting
//  and lifecycle. Domain logic lives in services/, storage in storageService.js,
//  realtime in realtime.js.
// ============================================================================

import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { fileURLToPath } from 'url';

import { initDB, closeDB, allQuery, getQuery, runQuery, SCHEMA_VERSION } from './db.js';
import {
  initStorage, STORAGE_ROOT, PUBLIC_BASE, startGarbageCollector, StorageError
} from './storageService.js';
import {
  ApiError, asyncRoute, makeIdentify, errorHandler, parseLimit
} from './lib/httpUtils.js';
import { resolveSession, pruneSessions } from './lib/auth.js';
import { config } from './lib/config.js';
import {
  securityHeaders, requestLogger, metricsMiddleware, renderMetrics, metricsSnapshot
} from './lib/middleware.js';
import { pruneAccountTokens } from './services/accountSecurity.js';
import { sweepStaleThreads } from './services/threads.js';
import {
  writeRateLimit, uploadRateLimit, readRateLimit
} from './lib/rateLimit.js';
import { PERMISSIONS, toNames } from './lib/permissions.js';
import { assertChannelAccess } from './services/access.js';

import filesRouter from './routes/files.js';
import * as messageService from './services/messages.js';
import * as guildService from './services/guilds.js';
import * as userService from './services/users.js';
import * as guildAdmin from './services/guildAdmin.js';
import * as threadService from './services/threads.js';
import * as forumService from './services/forum.js';
import * as onboardingService from './services/onboarding.js';
import * as followingService from './services/following.js';
import * as templateService from './services/templates.js';
import * as linkEmbeds from './services/linkEmbeds.js';
import * as automod from './services/automod.js';
import * as webhookService from './services/webhooks.js';
import * as reportService from './services/reports.js';
import * as channelPerms from './services/channelPerms.js';
import * as userSettings from './services/userSettings.js';
import * as pollService from './services/polls.js';
import * as eventService from './services/events.js';
import authRouter from './routes/auth.js';
import securityRouter from './routes/accountSecurity.js';
import {
  registerRealtime, resetVolatileState, fanOutMessage, sweepAfk
} from './realtime.js';
import { requireUser } from './lib/httpUtils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

process.on('uncaughtException', (err) => {
  if (err?.code === 'EPIPE') return;
  console.error('⚠️ Uncaught Exception caught:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('⚠️ Unhandled Rejection caught:', reason);
});
process.stdout?.on('error', (err) => { if (err?.code === 'EPIPE') return; });
process.stderr?.on('error', (err) => { if (err?.code === 'EPIPE') return; });


const PORT = config.port;
// An empty allow-list means same-origin only, which is what you want once this
// process also serves the SPA.
const CORS_ORIGIN = config.corsOrigins.includes('*')
  ? '*'
  : (config.corsOrigins.length > 0 ? config.corsOrigins : false);

// --- boot --------------------------------------------------------------------

await initDB();
await initStorage();
await resetVolatileState();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: { origin: CORS_ORIGIN, methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
  maxHttpBufferSize: 1e6 // messages only — file bytes go over HTTP, not the socket
});

// Behind a proxy, req.ip must come from X-Forwarded-For or every rate limit
// keys on the proxy's own address instead of the real client.
app.set('trust proxy', config.trustProxy);
app.disable('x-powered-by');

app.use(securityHeaders({ isProduction: config.isProduction, publicUrl: config.publicUrl }));
app.use(requestLogger({ format: config.logFormat, level: config.logLevel }));
app.use(metricsMiddleware());
app.use(cors({ origin: CORS_ORIGIN, credentials: true }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
// Real sessions first; the x-user-id shortcut only when explicitly enabled.
// lib/config.js refuses to start in production if the dev shortcut is enabled.
app.use(makeIdentify({ resolveSession, allowDevIdentity: config.allowDevIdentity }));

// Broad read budget for everyone, tighter budgets on writes and uploads.
app.use('/api', readRateLimit);
app.use(['/api/upload', '/api/upload/attachments'], uploadRateLimit);

// Static object store. Keys are content-addressed and therefore immutable, so
// they are safe to cache aggressively; nosniff stops an uploaded blob from
// being interpreted as script in our own origin.
app.use(PUBLIC_BASE, express.static(STORAGE_ROOT, {
  maxAge: '1y',
  immutable: true,
  setHeaders(res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  }
}));

// --- health ------------------------------------------------------------------

/**
 * Liveness: is the process up? Deliberately does not touch the database, so a
 * database blip cannot make an orchestrator kill an otherwise healthy container.
 */
app.get('/api/live', (_req, res) => {
  res.json({ status: 'alive', uptime_seconds: Math.round(process.uptime()) });
});

/**
 * Readiness: should this instance receive traffic? This one *does* check the
 * database, because an instance that cannot read it should leave the pool.
 */
app.get('/api/ready', asyncRoute(async (req, res) => {
  if (req.app.get('shutting-down')) {
    res.status(503).json({ status: 'draining' });
    return;
  }
  try {
    await getQuery('SELECT 1 AS ok');
    res.json({ status: 'ready', ...metricsSnapshot() });
  } catch (err) {
    res.status(503).json({ status: 'not_ready', error: err.message });
  }
}));

if (config.enableMetrics) {
  app.get('/metrics', (req, res) => {
    // With METRICS_TOKEN set the endpoint is private; without it, open — which
    // is normal when the metrics port is only reachable inside the network.
    if (config.metricsToken && req.get('authorization') !== `Bearer ${config.metricsToken}`) {
      res.status(401).type('text/plain').send('unauthorized\n');
      return;
    }
    res.type('text/plain; version=0.0.4')
      .send(renderMetrics({ socketConnections: io.engine.clientsCount }));
  });
}

app.get('/api/health', asyncRoute(async (_req, res) => {
  const { version } = await getQuery(
    `SELECT MAX(version) AS version FROM schema_migrations`
  );
  res.json({
    status: 'ok',
    schema_version: version,
    // What *this process* was built against. A client that expects more than
    // this is talking to a server that was started before the code changed —
    // the API would 404 on newer routes with no other clue.
    code_schema_version: SCHEMA_VERSION,
    storage_root: STORAGE_ROOT,
    uptime_seconds: Math.round(process.uptime()),
    connected_sockets: io.engine.clientsCount
  });
}));

/** Permission flag reference, so the client can build a role editor. */
app.get('/api/meta/permissions', (_req, res) => {
  res.json({
    permissions: Object.fromEntries(
      Object.entries(PERMISSIONS).map(([name, bit]) => [name, bit.toString()])
    )
  });
});

// --- storage / uploads -------------------------------------------------------

app.use('/api', authRouter);
app.use('/api', securityRouter);
app.use('/api', filesRouter);

// --- users -------------------------------------------------------------------

app.get('/api/users', asyncRoute(async (_req, res) => {
  res.json(await userService.listUsers());
}));

// Every custom emoji the viewer may use, grouped by server — the picker's
// "other servers" sections. Must be declared before /api/users/:userId.
app.get('/api/users/@me/emojis', requireUser, asyncRoute(async (req, res) => {
  const rows = await allQuery(
    `SELECT e.id, e.name, e.url, e.animated, e.server_id, s.name AS server_name, s.icon_url AS server_icon
       FROM emojis e
       JOIN servers s ON s.id = e.server_id AND s.deleted_at IS NULL
       JOIN server_members sm ON sm.server_id = e.server_id AND sm.user_id = ? AND sm.left_at IS NULL
      WHERE e.available = 1
      ORDER BY s.name, e.name`, [req.userId]
  );
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.server_id)) groups.set(r.server_id, { server_id: r.server_id, server_name: r.server_name, server_icon: r.server_icon, emojis: [] });
    groups.get(r.server_id).emojis.push({ id: r.id, name: r.name, url: r.url, animated: Boolean(r.animated), server_id: r.server_id });
  }
  res.json([...groups.values()]);
}));

// Resolve an emoji id to its image, for clients rendering <:name:id> from a
// server they do not have loaded (forwards, relays, DMs).
app.get('/api/emojis/:emojiId/image', asyncRoute(async (req, res) => {
  const emoji = await getQuery(`SELECT url FROM emojis WHERE id = ? AND available = 1`, [req.params.emojiId]);
  if (!emoji) throw ApiError.notFound('Emoji');
  res.redirect(302, emoji.url);
}));

app.get('/api/users/:userId', requireUser, asyncRoute(async (req, res) => {
  const user = await userService.getUser(req.params.userId, req.userId);
  // The viewer's own private note rides along; it is theirs and nobody else's.
  const note = req.params.userId === req.userId
    ? null
    : await userService.getNote({ authorId: req.userId, subjectId: req.params.userId });
  res.json({ ...user, my_note: note?.note ?? '' });
}));

app.put('/api/users/:userId/note', requireUser, writeRateLimit, asyncRoute(async (req, res) => {
  res.json(await userService.setNote({
    authorId: req.userId, subjectId: req.params.userId, note: req.body?.note
  }));
}));

/** Reads scoped to one guild require membership in it. */
async function requireMembership(req, serverId = req.params.serverId) {
  const resolved = await guildService.resolvePermissions({ userId: req.userId, serverId });
  if (!resolved.isMember) throw ApiError.forbidden('You are not a member of this server');
  return resolved;
}

/** Only the account owner may edit a profile or presence. */
function assertSelf(req, userId) {
  if (!req.userId) throw ApiError.unauthorized();
  if (req.userId !== userId) throw ApiError.forbidden('You can only modify your own account');
}

app.put('/api/users/:userId', asyncRoute(async (req, res) => {
  assertSelf(req, req.params.userId);
  const updated = await userService.updateProfile({
    userId: req.params.userId, patch: req.body ?? {}
  });
  io.emit('user_updated', updated);
  res.json(updated);
}));

app.patch('/api/users/:userId/presence', asyncRoute(async (req, res) => {
  assertSelf(req, req.params.userId);
  const updated = await userService.setPresence({
    userId: req.params.userId,
    status: req.body?.status,
    customStatus: req.body?.custom_status
  });
  io.emit('presence_updated', {
    userId: updated.id, status: updated.status, custom_status: updated.custom_status
  });
  res.json(updated);
}));

app.get('/api/initial-data/:userId', asyncRoute(async (req, res) => {
  assertSelf(req, req.params.userId);
  res.json(await guildService.getInitialData(req.params.userId));
}));

// --- friends & blocks --------------------------------------------------------

/**
 * Friend events carry the *other* person's public profile plus the relation,
 * shaped exactly like the rows in initial-data so the client can splice them in.
 */
async function friendPayloadFor(viewerId, relation) {
  const otherId = relation.user_id === viewerId ? relation.friend_id : relation.user_id;
  const user = await userService.getUser(otherId);
  return {
    ...user,
    friend_status: relation.status,
    requested_by: relation.requested_by,
    request_id: relation.id,
    request_note: relation.note ?? null,
    direction: relation.requested_by === viewerId ? 'outgoing' : 'incoming'
  };
}

app.post('/api/friends/requests', requireUser, writeRateLimit, asyncRoute(async (req, res) => {
  const request = await userService.sendFriendRequest({
    userId: req.userId,
    targetUsername: req.body.username ?? null,
    targetId: req.body.targetId ?? null,
    note: req.body.note ?? null
  });
  const event = request.status === 'accepted' ? 'friend_added' : 'friend_request';
  io.to(`user-${request.user_id}`).emit(event, await friendPayloadFor(request.user_id, request));
  io.to(`user-${request.friend_id}`).emit(event, await friendPayloadFor(request.friend_id, request));
  res.json(await friendPayloadFor(req.userId, request));
}));

app.post('/api/friends/requests/:requestId/accept', requireUser, asyncRoute(async (req, res) => {
  const result = await userService.acceptFriendRequest({
    userId: req.userId, requestId: req.params.requestId
  });
  io.to(`user-${result.user_id}`).emit('friend_added', await friendPayloadFor(result.user_id, result));
  io.to(`user-${result.friend_id}`).emit('friend_added', await friendPayloadFor(result.friend_id, result));
  res.json(await friendPayloadFor(req.userId, result));
}));

// Decline an incoming request, cancel an outgoing one, or remove a friend —
// all three are "the relation between us no longer exists".
app.delete('/api/friends/:otherId', requireUser, asyncRoute(async (req, res) => {
  const result = await userService.removeFriend({ userId: req.userId, otherId: req.params.otherId });
  io.to(`user-${req.userId}`).emit('friend_removed', { user_id: req.params.otherId });
  io.to(`user-${req.params.otherId}`).emit('friend_removed', { user_id: req.userId });
  res.json(result);
}));

app.post('/api/blocks', requireUser, asyncRoute(async (req, res) => {
  const targetId = req.body?.targetId;
  if (!targetId) throw new ApiError('targetId is required', { code: 'MISSING_TARGET' });
  if (targetId === req.userId) throw new ApiError('You cannot block yourself', { code: 'INVALID_TARGET' });
  const result = await userService.blockUser({ userId: req.userId, targetId });
  // Blocking severs any friendship, on both sides.
  io.to(`user-${req.userId}`).emit('friend_removed', { user_id: targetId });
  io.to(`user-${targetId}`).emit('friend_removed', { user_id: req.userId });
  res.json({ ...result, user: await userService.getUser(targetId) });
}));

app.delete('/api/blocks/:targetId', requireUser, asyncRoute(async (req, res) => {
  res.json(await userService.unblockUser({ userId: req.userId, targetId: req.params.targetId }));
}));

app.get('/api/blocks', requireUser, asyncRoute(async (req, res) => {
  res.json(await userService.listBlocked(req.userId));
}));

// --- servers -----------------------------------------------------------------

app.get('/api/servers/:serverId', requireUser, asyncRoute(async (req, res) => {
  res.json(await guildService.getServerDetail(req.params.serverId, req.userId));
}));

app.post('/api/servers', requireUser, writeRateLimit, asyncRoute(async (req, res) => {
  const ownerId = req.userId;
  const server = await guildService.createServer({
    name: req.body.name,
    iconUrl: req.body.icon_url ?? null,
    iconFileId: req.body.icon_file_id ?? null,
    ownerId
  });
  res.json(server);
}));

/** Announce a new member to everyone in the guild with the full member record. */
async function emitMemberJoined(serverId, userId, detail) {
  const member = detail?.members?.find((m) => m.id === userId) ?? { id: userId };
  io.to(serverId).emit('member_joined', { serverId, userId, member });
}

app.post('/api/servers/:serverId/join', requireUser, writeRateLimit, asyncRoute(async (req, res) => {
  const detail = await guildService.joinServer({
    serverId: req.params.serverId, userId: req.userId
  });
  await emitMemberJoined(req.params.serverId, req.userId, detail);
  res.json(detail);
}));

app.post('/api/servers/:serverId/leave', requireUser, asyncRoute(async (req, res) => {
  const result = await guildService.leaveServer({
    serverId: req.params.serverId, userId: req.userId
  });
  io.to(req.params.serverId).emit('member_removed', {
    serverId: req.params.serverId, userId: req.userId, reason: 'leave'
  });
  res.json(result);
}));

app.get('/api/servers/:serverId/audit-log', asyncRoute(async (req, res) => {
  await guildService.assertPermission({
    userId: req.userId, serverId: req.params.serverId, permission: 'VIEW_AUDIT_LOG'
  });
  res.json(await guildService.listAuditLog(req.params.serverId, {
    limit: parseLimit(req.query.limit), before: req.query.before ?? null
  }));
}));

app.get('/api/servers/:serverId/permissions/:userId', requireUser, asyncRoute(async (req, res) => {
  // Your own permissions always; someone else's only with MANAGE_ROLES.
  if (req.params.userId !== req.userId) {
    await guildService.assertPermission({
      userId: req.userId, serverId: req.params.serverId, permission: 'MANAGE_ROLES'
    });
  }
  const resolved = await guildService.resolvePermissions({
    userId: req.params.userId,
    serverId: req.params.serverId,
    channelId: req.query.channelId ?? null
  });
  res.json({ ...resolved, permission_names: toNames(resolved.permissions) });
}));

// --- roles -------------------------------------------------------------------

app.post('/api/servers/:serverId/roles', requireUser, asyncRoute(async (req, res) => {
  const { serverId } = req.params;
  await guildService.assertPermission({ userId: req.userId, serverId, permission: 'MANAGE_ROLES' });
  const role = await guildService.createRole({
    serverId,
    userId: req.userId,
    name: req.body?.name,
    color: req.body?.color ?? null,
    permissions: req.body?.permissions ?? '0',
    hoist: Boolean(req.body?.hoist),
    mentionable: Boolean(req.body?.mentionable)
  });
  io.to(serverId).emit('role_created', role);
  res.json(role);
}));

app.put('/api/servers/:serverId/members/:userId/roles/:roleId', requireUser, asyncRoute(async (req, res) => {
  const { serverId, userId, roleId } = req.params;
  await guildService.assertPermission({ userId: req.userId, serverId, permission: 'MANAGE_ROLES' });
  await guildService.assignRole({ serverId, userId, roleId, actorId: req.userId });
  io.to(serverId).emit('member_updated', { serverId, userId });
  res.json({ success: true });
}));

app.delete('/api/servers/:serverId/members/:userId/roles/:roleId', requireUser, asyncRoute(async (req, res) => {
  const { serverId, userId, roleId } = req.params;
  await guildService.assertPermission({ userId: req.userId, serverId, permission: 'MANAGE_ROLES' });
  await guildService.removeRole({ serverId, userId, roleId, actorId: req.userId });
  io.to(serverId).emit('member_updated', { serverId, userId });
  res.json({ success: true });
}));

// --- moderation --------------------------------------------------------------

app.post('/api/servers/:serverId/bans/:userId', requireUser, asyncRoute(async (req, res) => {
  const { serverId, userId } = req.params;
  await guildService.assertPermission({ userId: req.userId, serverId, permission: 'BAN_MEMBERS' });
  await guildService.banMember({
    serverId, userId, moderatorId: req.userId,
    reason: req.body?.reason, deleteMessageSeconds: Number(req.body?.deleteMessageSeconds) || 0
  });
  io.to(serverId).emit('member_removed', { serverId, userId, reason: 'ban' });
  res.json({ success: true });
}));

app.post('/api/servers/:serverId/kicks/:userId', requireUser, asyncRoute(async (req, res) => {
  const { serverId, userId } = req.params;
  await guildService.assertPermission({ userId: req.userId, serverId, permission: 'KICK_MEMBERS' });
  await guildService.kickMember({ serverId, userId, moderatorId: req.userId, reason: req.body?.reason });
  io.to(serverId).emit('member_removed', { serverId, userId, reason: 'kick' });
  res.json({ success: true });
}));

app.post('/api/servers/:serverId/timeouts/:userId', requireUser, asyncRoute(async (req, res) => {
  const { serverId, userId } = req.params;
  await guildService.assertPermission({ userId: req.userId, serverId, permission: 'MODERATE_MEMBERS' });
  const until = req.body?.until ?? new Date(Date.now() + 600_000).toISOString();
  const result = await guildService.timeoutMember({
    serverId, userId, moderatorId: req.userId, untilIso: until, reason: req.body?.reason
  });
  io.to(serverId).emit('member_updated', { serverId, userId });
  res.json(result);
}));

// --- invites -----------------------------------------------------------------

app.post('/api/servers/:serverId/invites', requireUser, writeRateLimit, asyncRoute(async (req, res) => {
  const { serverId } = req.params;
  await guildService.assertPermission({
    userId: req.userId, serverId, permission: 'CREATE_INSTANT_INVITE'
  });
  res.json(await guildService.createInvite({
    serverId,
    channelId: req.body?.channelId ?? null,
    inviterId: req.userId,
    maxUses: Number(req.body?.maxUses) || 0,
    maxAge: req.body?.maxAge === undefined ? 86400 : Number(req.body.maxAge),
    temporary: Boolean(req.body?.temporary)
  }));
}));

app.get('/api/invites/:code', asyncRoute(async (req, res) => {
  const preview = await guildService.getInvitePreview(req.params.code);
  if (req.userId) {
    const membership = await guildService.resolvePermissions({
      userId: req.userId, serverId: preview.server.id
    });
    preview.already_member = membership.isMember;
  }
  res.json(preview);
}));

app.post('/api/invites/:code/accept', requireUser, asyncRoute(async (req, res) => {
  const detail = await guildService.acceptInvite({ code: req.params.code, userId: req.userId });
  await emitMemberJoined(detail.server.id, req.userId, detail);
  res.json(detail);
}));

// --- channels ----------------------------------------------------------------

app.post('/api/channels', requireUser, writeRateLimit, asyncRoute(async (req, res) => {
  const serverId = req.body.server_id;
  if (!serverId) throw new ApiError('server_id is required', { code: 'MISSING_SERVER' });
  const channel = await guildService.createChannel({
    serverId,
    name: req.body.name,
    type: req.body.type ?? 'text',
    parentId: req.body.parent_id ?? null,
    categoryName: req.body.category ?? null,
    topic: req.body.topic ?? null,
    userId: req.userId
  });
  io.to(serverId).emit('channel_created', channel);
  res.json(channel);
}));

app.patch('/api/channels/:channelId', requireUser, asyncRoute(async (req, res) => {
  const channel = await guildService.updateChannel({
    channelId: req.params.channelId, patch: req.body ?? {}, userId: req.userId
  });
  if (channel.server_id) io.to(channel.server_id).emit('channel_updated', channel);
  res.json(channel);
}));

app.delete('/api/channels/:channelId', requireUser, asyncRoute(async (req, res) => {
  const result = await guildService.deleteChannel({
    channelId: req.params.channelId, userId: req.userId
  });
  if (result.server_id) io.to(result.server_id).emit('channel_deleted', result);
  res.json({ success: true, ...result });
}));

// --- direct messages ---------------------------------------------------------

/** Tell every other recipient a conversation now exists (or gained members). */
async function emitDmToRecipients(channelId, exceptUserId, event = 'dm_channel_created') {
  const rows = await allQuery(`SELECT user_id FROM channel_recipients WHERE channel_id = ?`, [channelId]);
  for (const { user_id } of rows) {
    if (user_id === exceptUserId) continue;
    const view = await guildService.getDirectMessageChannel(channelId, user_id);
    io.to(`user-${user_id}`).emit(event, view);
  }
}

app.get('/api/dms/:userId', asyncRoute(async (req, res) => {
  assertSelf(req, req.params.userId);
  res.json(await guildService.listDirectMessageChannels(req.params.userId));
}));

app.post('/api/dms', requireUser, writeRateLimit, asyncRoute(async (req, res) => {
  const userId = req.userId;
  const channel = req.body.recipientIds?.length > 1
    ? await guildService.createGroupDM({
        userId, recipientIds: req.body.recipientIds, name: req.body.name ?? null
      })
    : await guildService.openDirectMessage({
        userId, recipientId: req.body.recipientId ?? req.body.recipientIds?.[0]
      });
  // Both sides need to see the conversation appear, not just group members.
  await emitDmToRecipients(channel.id, userId);
  res.json(channel);
}));

app.delete('/api/dms/:channelId', requireUser, asyncRoute(async (req, res) => {
  res.json(await guildService.closeDirectMessage({ channelId: req.params.channelId, userId: req.userId }));
}));

app.put('/api/dms/:channelId/recipients', requireUser, asyncRoute(async (req, res) => {
  const channel = await guildService.addGroupRecipients({
    channelId: req.params.channelId, userId: req.userId,
    recipientIds: Array.isArray(req.body?.recipientIds) ? req.body.recipientIds : []
  });
  await emitDmToRecipients(channel.id, req.userId, channel.id === req.params.channelId ? 'dm_channel_updated' : 'dm_channel_created');
  res.json(channel);
}));

app.delete('/api/dms/:channelId/recipients/:userId', requireUser, asyncRoute(async (req, res) => {
  const result = await guildService.removeGroupRecipient({
    channelId: req.params.channelId, userId: req.userId, targetId: req.params.userId
  });
  io.to(`user-${req.params.userId}`).emit('dm_channel_removed', { id: req.params.channelId });
  await emitDmToRecipients(req.params.channelId, req.params.userId, 'dm_channel_updated');
  res.json(result);
}));

// --- messages ----------------------------------------------------------------

app.get('/api/messages/:channelId', requireUser, asyncRoute(async (req, res) => {
  const messages = await messageService.listMessages(req.params.channelId, {
    limit: parseLimit(req.query.limit, { fallback: 50, max: 100 }),
    before: req.query.before ?? null,
    after: req.query.after ?? null,
    around: req.query.around ?? null,
    viewerId: req.userId
  });
  res.json(messages);
}));

app.post('/api/messages', requireUser, writeRateLimit, asyncRoute(async (req, res) => {
  const message = await messageService.createMessage({
    channelId: req.body.channel_id,
    userId: req.userId,
    content: req.body.content,
    attachments: req.body.attachments ?? [],
    replyToId: req.body.reply_to_id ?? null,
    nonce: req.body.nonce ?? null,
    stickerId: req.body.sticker_id ?? null,
    poll: req.body.poll ?? null
  });
  fanOutMessage(io, message);
  res.json(message);
}));

// --- polls --------------------------------------------------------------------
//
// A poll's tally changes far more often than the message around it, so votes
// broadcast a small `poll_updated` rather than re-sending the whole message.
// Everyone watching the channel needs the new numbers; only the voter needs to
// know which answers are now theirs, which is why `my_votes` is stripped from
// the broadcast and returned only to the caller.

const broadcastPoll = (poll) => {
  if (!poll) return;
  const { my_votes: _mine, ...shared } = poll;
  io.to(poll.channel_id).emit('poll_updated', shared);
};

app.get('/api/polls/:messageId', requireUser, asyncRoute(async (req, res) => {
  const poll = await pollService.getPoll(req.params.messageId, req.userId);
  if (!poll) throw ApiError.notFound('Poll');
  await assertChannelAccess({ channelId: poll.channel_id, userId: req.userId });
  res.json(poll);
}));

app.put('/api/polls/:messageId/vote', requireUser, writeRateLimit, asyncRoute(async (req, res) => {
  const poll = await pollService.vote({
    messageId: req.params.messageId,
    userId: req.userId,
    answerIds: req.body?.answer_ids ?? req.body?.answerIds ?? []
  });
  broadcastPoll(poll);
  res.json(poll);
}));

app.get('/api/polls/:messageId/answers/:answerId/voters', requireUser, asyncRoute(async (req, res) => {
  res.json(await pollService.listVoters({
    messageId: req.params.messageId,
    answerId: req.params.answerId,
    userId: req.userId,
    limit: req.query.limit
  }));
}));

// --- scheduled events -------------------------------------------------------
//
// Every change is broadcast to the guild room so the events panel stays live.
// Interest toggles are the chatty one; they broadcast only the new count, not
// the whole event, and never who — that is what the voters endpoint is for.

const broadcastEvent = (event, kind = 'event_updated') => {
  if (!event) return;
  io.to(`server-${event.server_id}`).emit(kind, event);
};

app.get('/api/servers/:serverId/events', requireUser, asyncRoute(async (req, res) => {
  res.json(await eventService.listEvents(req.params.serverId, {
    viewerId: req.userId, includePast: req.query.past === '1'
  }));
}));

app.post('/api/servers/:serverId/events', requireUser, writeRateLimit, asyncRoute(async (req, res) => {
  const event = await eventService.createEvent({
    serverId: req.params.serverId, userId: req.userId, input: req.body ?? {}
  });
  broadcastEvent(event, 'event_created');
  res.status(201).json(event);
}));

app.get('/api/events/:eventId', requireUser, asyncRoute(async (req, res) => {
  res.json(await eventService.getEvent(req.params.eventId, req.userId));
}));

app.patch('/api/events/:eventId', requireUser, writeRateLimit, asyncRoute(async (req, res) => {
  const event = await eventService.updateEvent({
    eventId: req.params.eventId, userId: req.userId, patch: req.body ?? {}
  });
  broadcastEvent(event);
  res.json(event);
}));

app.delete('/api/events/:eventId', requireUser, asyncRoute(async (req, res) => {
  const event = await eventService.cancelEvent({ eventId: req.params.eventId, userId: req.userId });
  broadcastEvent(event);
  res.json(event);
}));

app.put('/api/events/:eventId/interest', requireUser, writeRateLimit, asyncRoute(async (req, res) => {
  const event = await eventService.setInterest({
    eventId: req.params.eventId, userId: req.userId,
    interested: req.body?.interested !== false
  });
  io.to(`server-${event.server_id}`).emit('event_interest', {
    event_id: event.id, interested_count: event.interested_count
  });
  res.json(event);
}));

app.get('/api/events/:eventId/interested', requireUser, asyncRoute(async (req, res) => {
  res.json(await eventService.listInterested(req.params.eventId, req.userId, { limit: req.query.limit }));
}));

app.post('/api/polls/:messageId/close', requireUser, asyncRoute(async (req, res) => {
  const poll = await pollService.closePoll({ messageId: req.params.messageId, userId: req.userId });
  broadcastPoll(poll);
  res.json(poll);
}));

app.patch('/api/messages/:messageId', requireUser, writeRateLimit, asyncRoute(async (req, res) => {
  const message = await messageService.editMessage({
    messageId: req.params.messageId,
    userId: req.userId,
    content: req.body.content
  });
  io.to(message.channel_id).emit('message_updated', message);
  res.json(message);
}));

app.delete('/api/messages/:messageId', requireUser, writeRateLimit, asyncRoute(async (req, res) => {
  // Author or a holder of MANAGE_MESSAGES in that channel — resolved in the service.
  const result = await messageService.deleteMessage({
    messageId: req.params.messageId,
    userId: req.userId
  });
  if (result) {
    io.to(result.channel_id).emit('message_deleted', result.id);
    // A published announcement takes its relayed copies with it.
    for (const copy of await followingService.retractCrossposts(result.id)) {
      io.to(copy.channel_id).emit('message_deleted', copy.id);
    }
  }
  res.json({ success: true });
}));

app.get('/api/messages/:channelId/pins', requireUser, asyncRoute(async (req, res) => {
  res.json(await messageService.listPins(req.params.channelId, req.userId));
}));

app.put('/api/messages/:messageId/pin', requireUser, writeRateLimit, asyncRoute(async (req, res) => {
  const message = await messageService.setPinned({
    messageId: req.params.messageId,
    channelId: req.body.channelId,
    userId: req.userId,
    pinned: req.body.pinned !== false
  });
  io.to(message.channel_id).emit('pins_updated', { channelId: message.channel_id, message });
  io.to(message.channel_id).emit('message_updated', message);
  res.json(message);
}));

app.put('/api/messages/:messageId/reactions/:emoji', requireUser, writeRateLimit, asyncRoute(async (req, res) => {
  const result = await messageService.toggleReaction({
    messageId: req.params.messageId,
    userId: req.userId,
    emoji: decodeURIComponent(req.params.emoji)
  });
  io.to(result.channelId).emit('reaction_updated', result);
  res.json(result);
}));

app.get('/api/search/messages', requireUser, asyncRoute(async (req, res) => {
  res.json(await messageService.searchMessages({
    query: req.query.q,
    channelId: req.query.channelId ?? null,
    serverId: req.query.serverId ?? null,
    authorId: req.query.authorId ?? null,
    hasAttachment: req.query.hasAttachment === 'true',
    limit: parseLimit(req.query.limit, { fallback: 25, max: 100 }),
    viewerId: req.userId
  }));
}));

// --- read state & notifications ---------------------------------------------

app.get('/api/read-states/:userId', asyncRoute(async (req, res) => {
  assertSelf(req, req.params.userId);
  res.json(await messageService.getUnreadSummary(req.params.userId));
}));

app.post('/api/read-states/:channelId', requireUser, asyncRoute(async (req, res) => {
  const state = await messageService.markRead({
    userId: req.userId,
    channelId: req.params.channelId,
    messageId: req.body?.messageId ?? null
  });
  io.to(`user-${req.userId}`).emit('read_state_updated', state);
  res.json(state);
}));

/**
 * Mark-as-unread. Separate from markRead because "no message id" means opposite
 * things: read-everything there, unread-from-the-top here.
 */
app.post('/api/read-states/:channelId/unread', requireUser, asyncRoute(async (req, res) => {
  const state = await messageService.markUnread({
    userId: req.userId,
    channelId: req.params.channelId,
    beforeMessageId: req.body?.beforeMessageId ?? null
  });
  io.to(`user-${req.userId}`).emit('read_state_updated', state);
  res.json(state);
}));

app.get('/api/notifications/:userId', asyncRoute(async (req, res) => {
  assertSelf(req, req.params.userId);
  const rows = await allQuery(
    `SELECT n.*, u.display_name AS actor_name, u.avatar_url AS actor_avatar,
            c.name AS channel_name, c.type AS channel_type
       FROM notifications n
       LEFT JOIN users u ON u.id = n.actor_id
       LEFT JOIN channels c ON c.id = n.channel_id
      WHERE n.user_id = ? ${req.query.unreadOnly === 'true' ? 'AND n.read_at IS NULL' : ''}
      ORDER BY n.id DESC LIMIT ?`,
    [req.params.userId, parseLimit(req.query.limit)]
  );
  // `preview` is what the inbox renders; the column is called body.
  res.json(rows.map((row) => ({ ...row, preview: row.body })));
}));

app.post('/api/notifications/read', requireUser, asyncRoute(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
  if (ids && ids.length) {
    await runQuery(
      `UPDATE notifications SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE user_id = ? AND read_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`,
      [req.userId, ...ids]
    );
  } else {
    await runQuery(
      `UPDATE notifications SET read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE user_id = ? AND read_at IS NULL`,
      [req.userId]
    );
  }
  res.json({ success: true });
}));

// --- per-user settings -------------------------------------------------------

app.put('/api/settings/channels/:channelId', requireUser, asyncRoute(async (req, res) => {
  res.json(await userService.updateChannelSettings({
    userId: req.userId, channelId: req.params.channelId, patch: req.body ?? {}
  }));
}));

app.put('/api/settings/servers/:serverId', requireUser, asyncRoute(async (req, res) => {
  res.json(await userService.updateServerSettings({
    userId: req.userId, serverId: req.params.serverId, patch: req.body ?? {}
  }));
}));

app.get('/api/settings/me', requireUser, asyncRoute(async (req, res) => {
  const [channels, servers, preferences] = await Promise.all([
    allQuery(`SELECT * FROM channel_settings WHERE user_id = ?`, [req.userId]),
    allQuery(`SELECT * FROM server_settings WHERE user_id = ?`, [req.userId]),
    userSettings.getAll(req.userId)
  ]);
  res.json({ channels, servers, preferences });
}));

// --- account-wide client preferences -----------------------------------------

app.get('/api/settings/preferences', requireUser, asyncRoute(async (req, res) => {
  res.json(await userSettings.getAll(req.userId));
}));

app.patch('/api/settings/preferences/:category', requireUser, asyncRoute(async (req, res) => {
  const value = await userSettings.updateCategory(req.userId, req.params.category, req.body ?? {});
  // Other tabs and devices signed in as this user follow along live.
  io.to(`user-${req.userId}`).emit('user_settings_updated', { category: req.params.category, value });
  res.json(value);
}));

app.delete('/api/settings/preferences/:category', requireUser, asyncRoute(async (req, res) => {
  const value = await userSettings.resetCategory(req.userId, req.params.category);
  io.to(`user-${req.userId}`).emit('user_settings_updated', { category: req.params.category, value });
  res.json(value);
}));

// --- server settings: guild profile ------------------------------------------

app.patch('/api/servers/:serverId', requireUser, asyncRoute(async (req, res) => {
  const server = await guildAdmin.updateGuild({
    serverId: req.params.serverId, actorId: req.userId, patch: req.body ?? {}
  });
  io.to(req.params.serverId).emit('server_updated', server);
  res.json(server);
}));

app.delete('/api/servers/:serverId', requireUser, asyncRoute(async (req, res) => {
  const result = await guildAdmin.deleteGuild({ serverId: req.params.serverId, actorId: req.userId });
  io.to(req.params.serverId).emit('server_deleted', { id: req.params.serverId });
  res.json(result);
}));

app.post('/api/servers/:serverId/transfer-ownership', requireUser, asyncRoute(async (req, res) => {
  const result = await guildAdmin.transferOwnership({
    serverId: req.params.serverId, actorId: req.userId, newOwnerId: req.body?.userId
  });
  io.to(req.params.serverId).emit('server_updated', { id: req.params.serverId, owner_id: req.body?.userId });
  res.json(result);
}));

// --- server settings: roles --------------------------------------------------

app.get('/api/servers/:serverId/roles', requireUser, asyncRoute(async (req, res) => {
  await requireMembership(req);
  res.json(await guildAdmin.listRoles(req.params.serverId));
}));

app.patch('/api/servers/:serverId/roles/:roleId', requireUser, asyncRoute(async (req, res) => {
  const role = await guildAdmin.updateRole({
    serverId: req.params.serverId, roleId: req.params.roleId,
    actorId: req.userId, patch: req.body ?? {}
  });
  io.to(req.params.serverId).emit('role_updated', role);
  res.json(role);
}));

app.delete('/api/servers/:serverId/roles/:roleId', requireUser, asyncRoute(async (req, res) => {
  const result = await guildAdmin.deleteRole({
    serverId: req.params.serverId, roleId: req.params.roleId, actorId: req.userId
  });
  io.to(req.params.serverId).emit('role_deleted', { roleId: req.params.roleId });
  res.json(result);
}));

app.put('/api/servers/:serverId/roles/order', requireUser, asyncRoute(async (req, res) => {
  const roles = await guildAdmin.reorderRoles({
    serverId: req.params.serverId, actorId: req.userId, order: req.body?.order ?? []
  });
  io.to(req.params.serverId).emit('roles_reordered', { serverId: req.params.serverId, roles });
  res.json(roles);
}));

// --- server settings: members, bans, invites --------------------------------

app.get('/api/servers/:serverId/members', requireUser, asyncRoute(async (req, res) => {
  await requireMembership(req);
  res.json(await guildAdmin.listMembers(req.params.serverId, {
    limit: parseLimit(req.query.limit, { fallback: 200, max: 1000 }),
    search: req.query.search ?? null
  }));
}));

app.patch('/api/servers/:serverId/members/:userId', requireUser, asyncRoute(async (req, res) => {
  const result = await guildAdmin.setNickname({
    serverId: req.params.serverId, userId: req.params.userId,
    actorId: req.userId, nickname: req.body?.nickname
  });
  io.to(req.params.serverId).emit('member_updated', {
    serverId: req.params.serverId, userId: req.params.userId
  });
  res.json(result);
}));

app.get('/api/servers/:serverId/bans', asyncRoute(async (req, res) => {
  await guildService.assertPermission({
    userId: req.userId, serverId: req.params.serverId, permission: 'BAN_MEMBERS'
  });
  res.json(await guildAdmin.listBans(req.params.serverId));
}));

app.delete('/api/servers/:serverId/bans/:userId', requireUser, asyncRoute(async (req, res) => {
  res.json(await guildAdmin.unban({
    serverId: req.params.serverId, userId: req.params.userId, actorId: req.userId
  }));
}));

app.get('/api/servers/:serverId/invites', requireUser, asyncRoute(async (req, res) => {
  await guildService.assertPermission({
    userId: req.userId, serverId: req.params.serverId, permission: 'MANAGE_GUILD'
  });
  res.json(await guildAdmin.listInvites(req.params.serverId));
}));

app.delete('/api/servers/:serverId/invites/:code', requireUser, asyncRoute(async (req, res) => {
  res.json(await guildAdmin.revokeInvite({
    serverId: req.params.serverId, code: req.params.code, actorId: req.userId
  }));
}));

// --- server settings: emojis -------------------------------------------------

app.get('/api/servers/:serverId/emojis', requireUser, asyncRoute(async (req, res) => {
  await requireMembership(req);
  res.json(await guildAdmin.listEmojis(req.params.serverId));
}));

app.post('/api/servers/:serverId/emojis', requireUser, asyncRoute(async (req, res) => {
  const emoji = await guildAdmin.createEmoji({
    serverId: req.params.serverId, actorId: req.userId,
    name: req.body?.name, fileId: req.body?.fileId ?? null,
    url: req.body?.url ?? null, animated: Boolean(req.body?.animated)
  });
  io.to(req.params.serverId).emit('emoji_created', emoji);
  res.json(emoji);
}));

app.delete('/api/servers/:serverId/emojis/:emojiId', requireUser, asyncRoute(async (req, res) => {
  const result = await guildAdmin.deleteEmoji({
    serverId: req.params.serverId, emojiId: req.params.emojiId, actorId: req.userId
  });
  io.to(req.params.serverId).emit('emoji_deleted', { emojiId: req.params.emojiId });
  res.json(result);
}));

// --- threads -----------------------------------------------------------------

app.post('/api/channels/:channelId/threads', requireUser, writeRateLimit, asyncRoute(async (req, res) => {
  const thread = await threadService.createThread({
    parentChannelId: req.params.channelId,
    messageId: req.body?.messageId ?? null,
    name: req.body?.name,
    userId: req.userId,
    autoArchiveDuration: Number(req.body?.autoArchiveDuration) || 1440
  });
  if (thread.server_id) io.to(thread.server_id).emit('thread_created', thread);
  res.json(thread);
}));

app.get('/api/channels/:channelId/threads', requireUser, asyncRoute(async (req, res) => {
  await assertChannelAccess({ channelId: req.params.channelId, userId: req.userId });
  res.json(await threadService.listThreads(req.params.channelId, {
    includeArchived: req.query.includeArchived === 'true'
  }));
}));

app.get('/api/threads/:threadId', requireUser, asyncRoute(async (req, res) => {
  await assertChannelAccess({ channelId: req.params.threadId, userId: req.userId });
  res.json(await threadService.getThread(req.params.threadId, req.userId));
}));

app.post('/api/threads/:threadId/join', requireUser, asyncRoute(async (req, res) => {
  res.json(await threadService.joinThread({
    threadId: req.params.threadId, userId: req.userId
  }));
}));

app.delete('/api/threads/:threadId/members/me', requireUser, asyncRoute(async (req, res) => {
  res.json(await threadService.leaveThread({ threadId: req.params.threadId, userId: req.userId }));
}));

app.patch('/api/threads/:threadId', requireUser, asyncRoute(async (req, res) => {
  const thread = await threadService.setThreadArchived({
    threadId: req.params.threadId, userId: req.userId,
    archived: Boolean(req.body?.archived), locked: req.body?.locked
  });
  if (thread?.server_id) io.to(thread.server_id).emit('channel_updated', thread);
  res.json(thread);
}));

// --- server templates --------------------------------------------------------

app.get('/api/servers/:serverId/template', requireUser, asyncRoute(async (req, res) => {
  res.json(await templateService.getServerTemplate(req.params.serverId, req.userId));
}));

app.post('/api/servers/:serverId/template', requireUser, writeRateLimit, asyncRoute(async (req, res) => {
  res.status(201).json(await templateService.createTemplate({
    serverId: req.params.serverId, userId: req.userId, name: req.body?.name, description: req.body?.description ?? null
  }));
}));

app.put('/api/servers/:serverId/template/sync', requireUser, asyncRoute(async (req, res) => {
  res.json(await templateService.syncTemplate({ serverId: req.params.serverId, userId: req.userId }));
}));

app.delete('/api/servers/:serverId/template', requireUser, asyncRoute(async (req, res) => {
  res.json(await templateService.deleteTemplate({ serverId: req.params.serverId, userId: req.userId }));
}));

app.get('/api/templates/:code', requireUser, asyncRoute(async (req, res) => {
  res.json(await templateService.getTemplate(req.params.code));
}));

app.post('/api/templates/:code/servers', requireUser, writeRateLimit, asyncRoute(async (req, res) => {
  const detail = await templateService.useTemplate({
    code: req.params.code, userId: req.userId, name: req.body?.name, iconUrl: req.body?.icon_url ?? null
  });
  res.status(201).json(detail);
}));

// --- channel following -------------------------------------------------------

app.get('/api/channels/:channelId/followers', requireUser, asyncRoute(async (req, res) => {
  res.json(await followingService.listFollowers(req.params.channelId, req.userId));
}));

app.post('/api/channels/:channelId/followers', requireUser, writeRateLimit, asyncRoute(async (req, res) => {
  const follow = await followingService.follow({
    sourceChannelId: req.params.channelId, targetChannelId: req.body?.target_channel_id, userId: req.userId
  });
  io.to(follow.target_server_id).emit('channel_follow_created', follow);
  res.status(201).json(follow);
}));

app.delete('/api/follows/:followId', requireUser, asyncRoute(async (req, res) => {
  res.json(await followingService.unfollow({ followId: req.params.followId, userId: req.userId }));
}));

app.get('/api/servers/:serverId/following', requireUser, asyncRoute(async (req, res) => {
  res.json(await followingService.listFollowing(req.params.serverId, req.userId));
}));

app.post('/api/messages/:messageId/crosspost', requireUser, writeRateLimit, asyncRoute(async (req, res) => {
  const result = await followingService.publish({ messageId: req.params.messageId, userId: req.userId });
  for (const copy of result.relayed) fanOutMessage(io, copy);
  const original = await messageService.getMessage(req.params.messageId, req.userId);
  if (original) io.to(original.channel_id).emit('message_updated', original);
  res.json({ ...result, message: original });
}));

// --- membership screening / welcome screen / onboarding ---------------------

app.get('/api/servers/:serverId/onboarding', requireUser, asyncRoute(async (req, res) => {
  // Members see the bundle; non-members see it too if they hold an invite
  // preview — the welcome screen is meant to be seen *before* joining.
  res.json(await onboardingService.getOnboarding(req.params.serverId, req.userId));
}));

app.patch('/api/servers/:serverId/onboarding/screening', requireUser, asyncRoute(async (req, res) => {
  const bundle = await onboardingService.updateScreening({
    serverId: req.params.serverId, userId: req.userId,
    enabled: req.body?.enabled, rules: req.body?.rules
  });
  io.to(req.params.serverId).emit('onboarding_updated', { server_id: req.params.serverId });
  res.json(bundle);
}));

app.patch('/api/servers/:serverId/onboarding/welcome', requireUser, asyncRoute(async (req, res) => {
  const bundle = await onboardingService.updateWelcome({
    serverId: req.params.serverId, userId: req.userId,
    enabled: req.body?.enabled, description: req.body?.description, channels: req.body?.channels
  });
  io.to(req.params.serverId).emit('onboarding_updated', { server_id: req.params.serverId });
  res.json(bundle);
}));

app.put('/api/servers/:serverId/onboarding/prompts', requireUser, asyncRoute(async (req, res) => {
  const bundle = await onboardingService.replacePrompts({
    serverId: req.params.serverId, userId: req.userId, prompts: req.body?.prompts ?? []
  });
  io.to(req.params.serverId).emit('onboarding_updated', { server_id: req.params.serverId });
  res.json(bundle);
}));

app.put('/api/servers/:serverId/onboarding/complete', requireUser, writeRateLimit, asyncRoute(async (req, res) => {
  const result = await onboardingService.complete({
    serverId: req.params.serverId, userId: req.userId,
    acceptRules: Boolean(req.body?.accept_rules), answers: req.body?.answers ?? {}
  });
  // Roles may have changed and `pending` lifted: refresh everyone's roster.
  io.to(req.params.serverId).emit('member_updated', { server_id: req.params.serverId, user_id: req.userId });
  res.json(result);
}));

// --- forum channels ----------------------------------------------------------
//
// A forum post is a thread; these routes add the forum vocabulary (tags,
// pinning, sorted/filtered listing, create-with-body). Realtime: `thread_created`
// already fires for new posts; tag/pin changes go out as `forum_post_updated`.

const broadcastForumPost = (post) => {
  if (post?.server_id) io.to(post.server_id).emit('forum_post_updated', post);
};

app.get('/api/channels/:channelId/forum/tags', requireUser, asyncRoute(async (req, res) => {
  await assertChannelAccess({ channelId: req.params.channelId, userId: req.userId });
  res.json(await forumService.listTags(req.params.channelId));
}));

app.post('/api/channels/:channelId/forum/tags', requireUser, writeRateLimit, asyncRoute(async (req, res) => {
  const tag = await forumService.createTag({
    channelId: req.params.channelId, userId: req.userId,
    name: req.body?.name, emoji: req.body?.emoji ?? null, moderated: Boolean(req.body?.moderated)
  });
  io.to(req.params.channelId).emit('forum_tags_updated', { channel_id: req.params.channelId });
  res.status(201).json(tag);
}));

app.patch('/api/channels/:channelId/forum/tags/:tagId', requireUser, asyncRoute(async (req, res) => {
  const tag = await forumService.updateTag({
    channelId: req.params.channelId, tagId: req.params.tagId, userId: req.userId, patch: req.body ?? {}
  });
  io.to(req.params.channelId).emit('forum_tags_updated', { channel_id: req.params.channelId });
  res.json(tag);
}));

app.delete('/api/channels/:channelId/forum/tags/:tagId', requireUser, asyncRoute(async (req, res) => {
  res.json(await forumService.deleteTag({
    channelId: req.params.channelId, tagId: req.params.tagId, userId: req.userId
  }));
  io.to(req.params.channelId).emit('forum_tags_updated', { channel_id: req.params.channelId });
}));

app.patch('/api/channels/:channelId/forum', requireUser, asyncRoute(async (req, res) => {
  const channel = await forumService.updateForumSettings({
    channelId: req.params.channelId, userId: req.userId, patch: req.body ?? {}
  });
  if (channel?.server_id) io.to(channel.server_id).emit('channel_updated', channel);
  res.json(channel);
}));

app.get('/api/channels/:channelId/forum/posts', requireUser, asyncRoute(async (req, res) => {
  const tagIds = typeof req.query.tags === 'string' ? req.query.tags.split(',').filter(Boolean) : [];
  res.json(await forumService.listPosts(req.params.channelId, {
    viewerId: req.userId,
    sort: req.query.sort ?? null,
    tagIds,
    q: req.query.q ?? '',
    includeArchived: req.query.includeArchived === 'true',
    before: req.query.before ?? null,
    limit: parseLimit(req.query.limit, { fallback: 25, max: 100 })
  }));
}));

app.post('/api/channels/:channelId/forum/posts', requireUser, writeRateLimit, asyncRoute(async (req, res) => {
  const { post, message } = await forumService.createPost({
    channelId: req.params.channelId, userId: req.userId,
    title: req.body?.title, content: req.body?.content ?? '',
    attachments: Array.isArray(req.body?.attachments) ? req.body.attachments : [],
    tagIds: Array.isArray(req.body?.tag_ids) ? req.body.tag_ids : [],
    nonce: req.body?.nonce ?? null
  });
  if (post.server_id) {
    io.to(post.server_id).emit('thread_created', await threadService.getThread(post.id));
    io.to(post.server_id).emit('forum_post_created', post);
  }
  res.status(201).json({ post, message });
}));

app.get('/api/forum/posts/:threadId', requireUser, asyncRoute(async (req, res) => {
  res.json(await forumService.getPost(req.params.threadId, req.userId));
}));

app.put('/api/forum/posts/:threadId/tags', requireUser, asyncRoute(async (req, res) => {
  const post = await forumService.setPostTags({
    threadId: req.params.threadId, userId: req.userId,
    tagIds: Array.isArray(req.body?.tag_ids) ? req.body.tag_ids : []
  });
  broadcastForumPost(post);
  res.json(post);
}));

app.put('/api/forum/posts/:threadId/pin', requireUser, asyncRoute(async (req, res) => {
  const post = await forumService.setPostPinned({
    threadId: req.params.threadId, userId: req.userId, pinned: Boolean(req.body?.pinned)
  });
  broadcastForumPost(post);
  res.json(post);
}));

// --- link embeds -------------------------------------------------------------

app.post('/api/embeds/resolve', requireUser, asyncRoute(async (req, res) => {
  const urls = Array.isArray(req.body?.urls) ? req.body.urls.slice(0, 5) : [];
  if (req.body?.content) {
    res.json({ embeds: await linkEmbeds.resolveEmbedsForContent(req.body.content) });
    return;
  }
  const embeds = await Promise.all(urls.map((u) => linkEmbeds.resolveEmbed(u).catch(() => null)));
  res.json({ embeds: embeds.filter(Boolean) });
}));


// --- automod -----------------------------------------------------------------

app.get('/api/servers/:serverId/automod', asyncRoute(async (req, res) => {
  await guildService.assertPermission({
    userId: req.userId, serverId: req.params.serverId, permission: 'MANAGE_GUILD'
  });
  res.json(await automod.listRules(req.params.serverId));
}));

app.post('/api/servers/:serverId/automod', writeRateLimit, asyncRoute(async (req, res) => {
  await guildService.assertPermission({
    userId: req.userId, serverId: req.params.serverId, permission: 'MANAGE_GUILD'
  });
  const rule = await automod.createRule({
    serverId: req.params.serverId, actorId: req.userId, rule: req.body ?? {}
  });
  io.to(req.params.serverId).emit('automod_rule_created', rule);
  res.json(rule);
}));

app.patch('/api/servers/:serverId/automod/:ruleId', asyncRoute(async (req, res) => {
  await guildService.assertPermission({
    userId: req.userId, serverId: req.params.serverId, permission: 'MANAGE_GUILD'
  });
  res.json(await automod.updateRule({
    serverId: req.params.serverId, ruleId: req.params.ruleId, patch: req.body ?? {}
  }));
}));

app.delete('/api/servers/:serverId/automod/:ruleId', asyncRoute(async (req, res) => {
  await guildService.assertPermission({
    userId: req.userId, serverId: req.params.serverId, permission: 'MANAGE_GUILD'
  });
  res.json(await automod.deleteRule({
    serverId: req.params.serverId, ruleId: req.params.ruleId
  }));
}));

// --- webhooks ----------------------------------------------------------------

app.get('/api/servers/:serverId/webhooks', asyncRoute(async (req, res) => {
  await guildService.assertPermission({
    userId: req.userId, serverId: req.params.serverId, permission: 'MANAGE_WEBHOOKS'
  });
  res.json(await webhookService.listWebhooks({ serverId: req.params.serverId }));
}));

app.post('/api/channels/:channelId/webhooks', requireUser, writeRateLimit, asyncRoute(async (req, res) => {
  res.json(await webhookService.createWebhook({
    channelId: req.params.channelId, actorId: req.userId,
    name: req.body?.name, avatarUrl: req.body?.avatar_url ?? null
  }));
}));

app.delete('/api/webhooks/:webhookId', requireUser, asyncRoute(async (req, res) => {
  res.json(await webhookService.deleteWebhook({
    webhookId: req.params.webhookId, actorId: req.userId
  }));
}));

// Execution is authenticated by the token in the path, so it must not require a
// session — this is the endpoint external services call.
app.post('/api/webhooks/:webhookId/:token', writeRateLimit, asyncRoute(async (req, res) => {
  const message = await webhookService.executeWebhook({
    webhookId: req.params.webhookId,
    token: req.params.token,
    content: req.body?.content,
    username: req.body?.username ?? null,
    avatarUrl: req.body?.avatar_url ?? null
  });
  // Same fan-out as any other message: unread markers and the notification
  // rows createMessage already wrote must actually reach people.
  fanOutMessage(io, message);
  res.json(message);
}));

// --- reports -----------------------------------------------------------------

app.post('/api/reports', writeRateLimit, asyncRoute(async (req, res) => {
  if (!req.userId) throw ApiError.unauthorized();
  res.json(await reportService.createReport({
    reporterId: req.userId,
    targetType: req.body?.target_type ?? req.body?.targetType,
    targetId: req.body?.target_id ?? req.body?.targetId,
    reason: req.body?.reason,
    details: req.body?.details ?? null
  }));
}));

app.get('/api/reports', asyncRoute(async (req, res) => {
  // Two ways in: an instance administrator sees everything; a guild moderator
  // sees only the reports raised inside their own guild.
  const serverId = req.query.serverId ?? null;
  const isAdmin = process.env.ADMIN_TOKEN && req.get('x-admin-token') === process.env.ADMIN_TOKEN;
  if (!isAdmin) {
    if (!serverId) throw ApiError.forbidden('ต้องใช้ ADMIN_TOKEN หรือระบุ serverId');
    await guildService.assertPermission({
      userId: req.userId, serverId, permission: 'MANAGE_MESSAGES'
    });
  }
  res.json(await reportService.listReports({
    status: req.query.status ?? 'open',
    serverId,
    limit: parseLimit(req.query.limit, { fallback: 50, max: 200 })
  }));
}));

app.patch('/api/reports/:reportId', requireUser, asyncRoute(async (req, res) => {
  const isAdmin = process.env.ADMIN_TOKEN && req.get('x-admin-token') === process.env.ADMIN_TOKEN;
  if (!isAdmin) {
    // A guild moderator may only close reports raised inside their own guild.
    const report = await getQuery(`SELECT server_id FROM reports WHERE id = ?`, [req.params.reportId]);
    if (!report) throw ApiError.notFound('Report');
    if (!report.server_id) throw ApiError.forbidden('ต้องใช้ ADMIN_TOKEN');
    await guildService.assertPermission({
      userId: req.userId, serverId: report.server_id, permission: 'MANAGE_MESSAGES'
    });
  }
  res.json(await reportService.resolveReport({
    reportId: req.params.reportId,
    resolverId: req.userId ?? null,
    status: req.body?.status,
    action: req.body?.action ?? null
  }));
}));

// --- channel permission overwrites ------------------------------------------

app.get('/api/channels/:channelId/permissions', requireUser, asyncRoute(async (req, res) => {
  const channel = await getQuery(
    `SELECT server_id FROM channels WHERE id = ? AND deleted_at IS NULL`, [req.params.channelId]
  );
  if (!channel?.server_id) throw ApiError.notFound('Channel');
  await guildService.assertPermission({
    userId: req.userId, serverId: channel.server_id, permission: 'MANAGE_ROLES'
  });
  res.json(await channelPerms.listOverwrites(req.params.channelId));
}));

app.put('/api/channels/:channelId/permissions/:targetType/:targetId', requireUser, asyncRoute(async (req, res) => {
  const result = await channelPerms.setOverwrite({
    channelId: req.params.channelId, actorId: req.userId,
    targetType: req.params.targetType, targetId: req.params.targetId,
    allow: req.body?.allow ?? '0', deny: req.body?.deny ?? '0'
  });
  const channel = await getQuery(`SELECT * FROM channels WHERE id = ?`, [req.params.channelId]);
  if (channel?.server_id) io.to(channel.server_id).emit('channel_updated', channel);
  res.json(result);
}));

app.delete('/api/channels/:channelId/permissions/:targetType/:targetId', requireUser, asyncRoute(async (req, res) => {
  const result = await channelPerms.deleteOverwrite({
    channelId: req.params.channelId, actorId: req.userId,
    targetType: req.params.targetType, targetId: req.params.targetId
  });
  const channel = await getQuery(`SELECT * FROM channels WHERE id = ?`, [req.params.channelId]);
  if (channel?.server_id) io.to(channel.server_id).emit('channel_updated', channel);
  res.json(result);
}));

app.get('/api/channels/:channelId/permissions/:userId/effective', requireUser, asyncRoute(async (req, res) => {
  if (req.params.userId !== req.userId) {
    const channel = await getQuery(
      `SELECT server_id FROM channels WHERE id = ? AND deleted_at IS NULL`, [req.params.channelId]
    );
    if (!channel?.server_id) throw ApiError.notFound('Channel');
    await guildService.assertPermission({
      userId: req.userId, serverId: channel.server_id, permission: 'MANAGE_ROLES'
    });
  }
  const resolved = await channelPerms.effectivePermissions({
    channelId: req.params.channelId, userId: req.params.userId
  });
  res.json({ ...resolved, permission_names: toNames(resolved.permissions) });
}));

// --- stickers & soundboard ---------------------------------------------------

app.get('/api/servers/:serverId/stickers', requireUser, asyncRoute(async (req, res) => {
  await requireMembership(req);
  res.json(await channelPerms.listStickers(req.params.serverId));
}));

app.post('/api/servers/:serverId/stickers', writeRateLimit, requireUser, asyncRoute(async (req, res) => {
  const sticker = await channelPerms.createSticker({
    serverId: req.params.serverId,
    actorId: req.userId,
    name: req.body?.name,
    description: req.body?.description ?? null,
    tags: req.body?.tags ?? null,
    fileId: req.body?.fileId ?? null,
    url: req.body?.url ?? null,
    format: req.body?.format
  });
  io.to(req.params.serverId).emit('sticker_created', sticker);
  res.json(sticker);
}));

app.delete('/api/servers/:serverId/stickers/:stickerId', requireUser, asyncRoute(async (req, res) => {
  const result = await channelPerms.deleteSticker({
    serverId: req.params.serverId, stickerId: req.params.stickerId, actorId: req.userId
  });
  io.to(req.params.serverId).emit('sticker_deleted', { stickerId: req.params.stickerId });
  res.json(result);
}));

app.get('/api/servers/:serverId/sounds', requireUser, asyncRoute(async (req, res) => {
  await requireMembership(req);
  res.json(await channelPerms.listSounds(req.params.serverId));
}));

app.post('/api/servers/:serverId/sounds', writeRateLimit, requireUser, asyncRoute(async (req, res) => {
  const sound = await channelPerms.createSound({
    serverId: req.params.serverId,
    actorId: req.userId,
    name: req.body?.name,
    fileId: req.body?.fileId ?? null,
    url: req.body?.url ?? null,
    emoji: req.body?.emoji ?? null,
    volume: req.body?.volume
  });
  io.to(req.params.serverId).emit('sound_created', sound);
  res.json(sound);
}));

app.delete('/api/servers/:serverId/sounds/:soundId', requireUser, asyncRoute(async (req, res) => {
  res.json(await channelPerms.deleteSound({
    serverId: req.params.serverId, soundId: req.params.soundId, actorId: req.userId
  }));
}));

// --- errors ------------------------------------------------------------------


// Translate multer and storage failures into the standard error envelope.
app.use((err, _req, _res, next) => {
  if (err instanceof multer.MulterError) {
    const status = err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
    return next(new ApiError(err.message, { status, code: err.code }));
  }
  if (err instanceof StorageError) {
    return next(new ApiError(err.message, { status: err.status, code: err.code }));
  }
  return next(err);
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'Endpoint not found', code: 'NOT_FOUND' });
});

// Serve the built SPA from this process: one container, one port, no separate
// web server to misconfigure — and the client is same-origin, so the session
// cookie needs no cross-site relaxation.
if (config.serveStatic) {
  const staticRoot = path.resolve(__dirname, config.staticDir);
  if (!fs.existsSync(staticRoot)) {
    console.error(`❌ SERVE_STATIC is on but ${staticRoot} does not exist. Run: npm run build`);
    process.exit(1);
  }

  // Hashed asset names are immutable; index.html must never be cached, or
  // clients keep booting the previous bundle after a deploy.
  app.use(express.static(staticRoot, {
    index: false,
    setHeaders(res, filePath) {
      if (/\.[0-9a-zA-Z_-]{8,}\.(js|css|woff2?|png|jpe?g|svg|webp)$/.test(filePath)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('Cache-Control', 'no-cache');
      }
    }
  }));

  // Client-side routing: any non-API path returns the shell.
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/uploads')) return next();
    res.setHeader('Cache-Control', 'no-cache');
    return res.sendFile(path.join(staticRoot, 'index.html'));
  });

  console.log(`🌐 Serving SPA from ${staticRoot}`);
}

app.use(errorHandler);

// --- realtime & lifecycle ----------------------------------------------------

registerRealtime(io);

// Sweep abandoned uploads and expired files periodically.
const stopGC = startGarbageCollector({ intervalMs: 6 * 60 * 60 * 1000, dryRun: false });

// Periodic housekeeping: expired sessions and account tokens, and threads whose
// auto-archive window has passed.
const housekeeping = setInterval(async () => {
  try {
    const sessions = await pruneSessions();
    const tokens = await pruneAccountTokens();
    const { archived } = await sweepStaleThreads();
    if (sessions || tokens || archived) {
      console.log(`🧽 housekeeping: ${sessions} session(s), ${tokens} token(s), ${archived} thread(s)`);
    }
  } catch (err) {
    console.error('housekeeping failed:', err.message);
  }
}, 60 * 60 * 1000);
housekeeping.unref?.();

// Event reminders: everyone who marked "interested" hears about it shortly
// before it starts. Sent-state is kept in memory on purpose — a duplicate
// reminder after a restart is a small annoyance, while a column written on every
// tick is a permanent cost. The window is wide enough that a tick landing a bit
// late still catches the event.
// AFK sweep every 30 seconds — coarse enough to be free, fine enough that a
// one-minute timeout still feels like one minute.
const afkSweep = setInterval(() => {
  sweepAfk(io).catch((err) => console.error('afk sweep failed:', err.message));
}, 30 * 1000);
afkSweep.unref?.();

const REMINDER_LEAD_MS = 15 * 60 * 1000;
const remindedEvents = new Set();
const eventReminders = setInterval(async () => {
  try {
    const soon = await eventService.upcomingWithin(REMINDER_LEAD_MS);
    for (const event of soon) {
      if (remindedEvents.has(event.id)) continue;
      remindedEvents.add(event.id);
      const interested = await eventService.listInterested(event.id, event.creator_id, { limit: 500 })
        .catch(() => []);
      for (const person of interested) {
        io.to(`user-${person.id}`).emit('event_reminder', {
          event_id: event.id, server_id: event.server_id, name: event.name,
          starts_at: event.starts_at, channel_id: event.channel_id
        });
      }
    }
    // Forget events that are now in the past so the set cannot grow forever.
    if (remindedEvents.size > 1000) remindedEvents.clear();
  } catch (err) {
    console.error('event reminders failed:', err.message);
  }
}, 60 * 1000);
eventReminders.unref?.();

httpServer.listen(PORT, config.host, () => {
  console.log(`🚀 Antigravity Discord on http://${config.host}:${PORT} (${config.nodeEnv})`);
  console.log(`   public url → ${config.publicUrl}`);
  console.log(`   storage    → ${STORAGE_ROOT}`);
});

/**
 * Graceful shutdown. An orchestrator sends SIGTERM and then waits; using that
 * window to finish in-flight requests and checkpoint the WAL is the difference
 * between a clean rolling deploy and dropped requests plus a database that needs
 * recovery on the next boot.
 */
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received — draining.`);

  // Fail readiness first so the load balancer stops sending new traffic while
  // in-flight requests finish.
  app.set('shutting-down', true);

  const forceExit = setTimeout(() => {
    console.error('   drain timed out — exiting anyway.');
    process.exit(1);
  }, config.shutdownTimeoutMs);
  forceExit.unref?.();

  try {
    stopGC();
    clearInterval(housekeeping);
    await new Promise((resolve) => io.close(resolve));
    await new Promise((resolve) => httpServer.close(resolve));
    await closeDB();
    clearTimeout(forceExit);
    console.log('   drained cleanly.');
    process.exit(0);
  } catch (err) {
    console.error('   shutdown error:', err.message);
    process.exit(1);
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => shutdown(signal));
}

process.on('unhandledRejection', (reason) => console.error('Unhandled rejection:', reason));

export { app, io, httpServer };
