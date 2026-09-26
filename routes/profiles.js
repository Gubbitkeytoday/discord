// ============================================================================
//  /api/profiles — profile popout / full profile data, identity settings,
//  custom status with expiry, server tags, badges and profile reports.
//
//    GET    /api/profiles/:userId[?server_id=]          full profile for the viewer
//    GET    /api/profiles/@me/identity                  my theme / name style / tag / equipped
//    PATCH  /api/profiles/@me/identity                  { theme_colors, name_style,
//                                                         primary_server_tag_id, *_id cosmetics }
//    PUT    /api/profiles/@me/custom-status             { text, emoji, clear_after, expires_at }
//    GET    /api/identities?ids=a,b[&server_id=]        compact identity for lists (≤ 200)
//    POST   /api/profiles/:userId/report                { reason, details, server_id } — snapshot
//
//    GET    /api/servers/:serverId/tag                  the server's tag (members)
//    PUT    /api/servers/:serverId/tag                  { tag, icon, color, enabled } (MANAGE_GUILD)
//    DELETE /api/servers/:serverId/tag                  (MANAGE_GUILD)
//    GET    /api/servers/:serverId/badges               server-defined badges (members)
//    POST   /api/servers/:serverId/badges               { name, description, icon, color } (MANAGE_GUILD)
//    DELETE /api/servers/:serverId/badges/:badgeId      (MANAGE_GUILD)
//    PUT    /api/servers/:serverId/badges/:badgeId/members/:userId      grant   (MANAGE_ROLES)
//    DELETE /api/servers/:serverId/badges/:badgeId/members/:userId      revoke  (MANAGE_ROLES)
//
//  Instance admins:
//    GET/POST /api/admin/badges, DELETE /api/admin/badges/:badgeId,
//    PUT/DELETE /api/admin/badges/:badgeId/users/:userId
//
//  Also mounts routes/cosmetics.js, and runs the custom-status sweeper that
//  clears expired statuses and tells everyone who can see them.
// ============================================================================

import express from 'express';

import { ApiError, asyncRoute } from '../lib/httpUtils.js';
import { rateLimit } from '../lib/rateLimit.js';
import { getLogger } from '../lib/logger.js';
import * as profiles from '../services/profiles.js';
import * as guilds from '../services/guilds.js';
import * as users from '../services/users.js';
import * as reports from '../services/reports.js';
import { runQuery, getQuery } from '../db.js';
import { assertInstanceAdmin, audit as instanceAudit } from '../services/instanceAdmin.js';
import { emitToRelated } from '../realtime.js';
import createCosmeticsRouter, { announceIdentity } from './cosmetics.js';

const log = getLogger('profiles');

const requireUser = (req) => {
  if (!req.userId) throw ApiError.unauthorized();
  return req.userId;
};

const writeLimit = rateLimit({ name: 'profile-write', limit: 60, windowMs: 60_000 });
const reportLimit = rateLimit({ name: 'profile-report', limit: 10, windowMs: 60_000 });

/** What everyone may learn about a user from a broadcast (see server.js). */
function publicUser(user) {
  const { mutual_servers: _servers, ...rest } = user;
  const hidden = (user.profile_visibility ?? 'everyone') !== 'everyone';
  return {
    ...rest,
    status: rest.status === 'invisible' ? 'offline' : rest.status,
    ...(hidden ? { bio: null, banner_url: null, pronouns: null } : {})
  };
}

/** A status change: the presence event lists use, and the full user for caches. */
async function announceStatus(io, userId) {
  const user = await users.getUser(userId);
  const status = { custom_status: user.custom_status ?? null, custom_status_emoji: user.custom_status_emoji ?? null,
    custom_status_expires_at: user.custom_status_expires_at ?? null };
  await emitToRelated(io, userId, 'presence_updated', { userId, status: user.status, ...status });
  await emitToRelated(io, userId, 'user_updated', publicUser(user), await users.getUser(userId, userId));
}

const SWEEP_MS = Math.max(5_000, Number(process.env.STATUS_SWEEP_MS) || 30_000);

export function startStatusSweeper(io) {
  const timer = setInterval(async () => {
    try {
      const cleared = await profiles.sweepExpiredStatuses();
      for (const userId of cleared) await announceStatus(io, userId);
    } catch (err) {
      log.warn({ err }, 'custom status sweep failed');
    }
  }, SWEEP_MS);
  timer.unref?.();
  return timer;
}

async function memberOf(req, serverId) {
  const userId = requireUser(req);
  const resolved = await guilds.resolvePermissions({ userId, serverId });
  if (!resolved.isMember) throw ApiError.forbidden('You are not a member of this server');
  return resolved;
}

async function serverBadge(serverId, badgeId) {
  const badge = await profiles.getBadge(badgeId);
  if (badge.kind !== 'server' || badge.server_id !== serverId) throw ApiError.notFound('Badge');
  return badge;
}

export default function createProfilesRouter({ io } = {}) {
  const router = express.Router();
  router.use(createCosmeticsRouter({ io }));
  if (io) startStatusSweeper(io);

  // --- my identity ----------------------------------------------------------------

  router.get('/profiles/@me/identity', asyncRoute(async (req, res) => {
    res.json(await profiles.getIdentitySettings(requireUser(req)));
  }));

  router.patch('/profiles/@me/identity', writeLimit, asyncRoute(async (req, res) => {
    const userId = requireUser(req);
    const result = await profiles.updateIdentitySettings({ userId, patch: req.body ?? {} });
    announceIdentity(io, userId);
    res.json(result);
  }));

  router.put('/profiles/@me/custom-status', writeLimit, asyncRoute(async (req, res) => {
    const userId = requireUser(req);
    const result = await profiles.setCustomStatus({
      userId,
      text: req.body?.text ?? req.body?.custom_status ?? null,
      emoji: req.body?.emoji ?? req.body?.custom_status_emoji ?? null,
      clearAfter: req.body?.clear_after ?? 'never',
      expiresAt: req.body?.expires_at ?? null
    });
    await announceStatus(io, userId);
    res.json(result);
  }));

  // --- identities for lists ----------------------------------------------------------

  router.get('/identities', asyncRoute(async (req, res) => {
    const viewerId = requireUser(req);
    const ids = String(req.query?.ids ?? '').split(',').map((s) => s.trim()).filter(Boolean).slice(0, 200);
    const serverId = req.query?.server_id ? String(req.query.server_id) : null;
    if (serverId) {
      const resolved = await guilds.resolvePermissions({ userId: viewerId, serverId });
      if (!resolved.isMember) throw ApiError.forbidden('You are not a member of this server');
    }
    res.setHeader('Cache-Control', 'private, max-age=30');
    res.json(await profiles.identities(ids, { serverId }));
  }));

  // --- full profile ------------------------------------------------------------------

  router.get('/profiles/:userId', asyncRoute(async (req, res) => {
    const viewerId = requireUser(req);
    const userId = req.params.userId === '@me' ? viewerId : req.params.userId;
    let serverId = req.query?.server_id ? String(req.query.server_id) : null;
    let viewer = { can_moderate: false, can_grant_badges: false };
    if (serverId) {
      const resolved = await guilds.resolvePermissions({ userId: viewerId, serverId }).catch(() => ({ isMember: false }));
      if (!resolved.isMember) serverId = null;
      else {
        const { has } = await import('../lib/permissions.js');
        const mod = resolved.isOwner || has(resolved.permissions, 'MANAGE_NICKNAMES');
        viewer = {
          can_moderate: mod && userId !== viewerId,
          can_grant_badges: resolved.isOwner || has(resolved.permissions, 'MANAGE_ROLES')
        };
      }
    }
    const user = await users.getUser(userId, viewerId);
    const [identity, mutualFriends, note] = await Promise.all([
      profiles.identityOf(userId, { serverId }),
      profiles.mutualFriends(viewerId, userId),
      userId === viewerId ? null : users.getNote({ authorId: viewerId, subjectId: userId })
    ]);
    // Badges follow profile privacy: a hidden profile keeps only the trust
    // signals (staff, bot) that stop impersonation.
    if (user.profile_hidden && identity) {
      identity.badges = identity.badges.filter((b) => b.slug === 'staff' || b.slug === 'bot');
    }
    let member = null;
    if (serverId) {
      member = await getQuery(
        `SELECT nickname, bio, pronouns, avatar_url, banner_url, joined_at, tag_hidden
           FROM server_members WHERE server_id = ? AND user_id = ? AND left_at IS NULL`, [serverId, userId]
      );
      if (member) member = { ...member, tag_hidden: Boolean(Number(member.tag_hidden)) };
    }
    res.json({
      user,
      identity,
      member,
      mutual_servers: user.mutual_servers ?? [],
      mutual_friends: mutualFriends,
      my_note: note?.note ?? '',
      viewer
    });
  }));

  router.post('/profiles/:userId/report', reportLimit, asyncRoute(async (req, res) => {
    const reporterId = requireUser(req);
    const userId = req.params.userId;
    const serverId = req.body?.server_id ? String(req.body.server_id) : null;
    const report = await reports.createReport({
      reporterId, targetType: 'user', targetId: userId,
      reason: req.body?.reason, details: req.body?.details ?? null
    });
    // The report system snapshots a user as name + creation date; a profile
    // report needs what the reporter actually saw.
    const snapshot = await profiles.profileSnapshot(userId, { serverId });
    const context = { ...(report.context ?? {}), profile: snapshot };
    await runQuery(`UPDATE reports SET context = ? WHERE id = ?`, [JSON.stringify(context), report.id]);
    res.status(201).json({ ...report, context });
  }));

  // --- server tag --------------------------------------------------------------------

  router.get('/servers/:serverId/tag', asyncRoute(async (req, res) => {
    await memberOf(req, req.params.serverId);
    res.json({ tag: await profiles.getServerTag(req.params.serverId) });
  }));

  router.put('/servers/:serverId/tag', writeLimit, asyncRoute(async (req, res) => {
    const actorId = requireUser(req);
    const { serverId } = req.params;
    await profiles.assertServerPermission(guilds, { userId: actorId, serverId, permission: 'MANAGE_GUILD' });
    const tag = await profiles.setServerTag({
      serverId, actorId, tag: req.body?.tag, icon: req.body?.icon ?? 'leaf',
      color: req.body?.color ?? null, enabled: req.body?.enabled !== false
    });
    io?.to(serverId).emit('server_identity_updated', { server_id: serverId, tag });
    res.json({ tag });
  }));

  router.delete('/servers/:serverId/tag', writeLimit, asyncRoute(async (req, res) => {
    const actorId = requireUser(req);
    const { serverId } = req.params;
    await profiles.assertServerPermission(guilds, { userId: actorId, serverId, permission: 'MANAGE_GUILD' });
    const result = await profiles.deleteServerTag({ serverId, actorId });
    io?.to(serverId).emit('server_identity_updated', { server_id: serverId, tag: null });
    res.json(result);
  }));

  // --- server badges ----------------------------------------------------------------

  router.get('/servers/:serverId/badges', asyncRoute(async (req, res) => {
    await memberOf(req, req.params.serverId);
    res.json(await profiles.listServerBadges(req.params.serverId));
  }));

  router.post('/servers/:serverId/badges', writeLimit, asyncRoute(async (req, res) => {
    const actorId = requireUser(req);
    const { serverId } = req.params;
    await profiles.assertServerPermission(guilds, { userId: actorId, serverId, permission: 'MANAGE_GUILD' });
    res.status(201).json(await profiles.createBadge({ kind: 'server', serverId, actorId, input: req.body ?? {} }));
  }));

  router.delete('/servers/:serverId/badges/:badgeId', writeLimit, asyncRoute(async (req, res) => {
    const actorId = requireUser(req);
    const { serverId, badgeId } = req.params;
    await profiles.assertServerPermission(guilds, { userId: actorId, serverId, permission: 'MANAGE_GUILD' });
    res.json(await profiles.deleteBadge({ badge: await serverBadge(serverId, badgeId), actorId }));
  }));

  for (const [method, revoke] of [['put', false], ['delete', true]]) {
    router[method]('/servers/:serverId/badges/:badgeId/members/:userId', writeLimit, asyncRoute(async (req, res) => {
      const actorId = requireUser(req);
      const { serverId, badgeId, userId } = req.params;
      await profiles.assertServerPermission(guilds, { userId: actorId, serverId, permission: 'MANAGE_ROLES' });
      const result = await profiles.grantBadge({
        badge: await serverBadge(serverId, badgeId), userId, actorId, note: req.body?.note ?? null, revoke
      });
      io?.to(serverId).emit('identity_updated', { user_id: userId, server_id: serverId });
      res.json(result);
    }));
  }

  // --- instance badges ----------------------------------------------------------------

  router.get('/admin/badges', asyncRoute(async (req, res) => {
    await assertInstanceAdmin(requireUser(req));
    res.json(await profiles.listInstanceBadges());
  }));

  router.post('/admin/badges', writeLimit, asyncRoute(async (req, res) => {
    const actorId = requireUser(req);
    await assertInstanceAdmin(actorId);
    const badge = await profiles.createBadge({ kind: 'instance', actorId, input: req.body ?? {} });
    await instanceAudit({ actorId, action: 'badge.create', targetType: 'badge', targetId: badge.id, details: { name: badge.name } });
    res.status(201).json(badge);
  }));

  router.delete('/admin/badges/:badgeId', writeLimit, asyncRoute(async (req, res) => {
    const actorId = requireUser(req);
    await assertInstanceAdmin(actorId);
    const badge = await profiles.getBadge(req.params.badgeId);
    if (badge.kind !== 'instance') throw ApiError.notFound('Badge');
    await instanceAudit({ actorId, action: 'badge.delete', targetType: 'badge', targetId: badge.id, details: { name: badge.name } });
    res.json(await profiles.deleteBadge({ badge, actorId }));
  }));

  for (const [method, revoke] of [['put', false], ['delete', true]]) {
    router[method]('/admin/badges/:badgeId/users/:userId', writeLimit, asyncRoute(async (req, res) => {
      const actorId = requireUser(req);
      await assertInstanceAdmin(actorId);
      const badge = await profiles.getBadge(req.params.badgeId);
      if (badge.kind !== 'instance') throw ApiError.notFound('Badge');
      const result = await profiles.grantBadge({ badge, userId: req.params.userId, actorId, revoke });
      await instanceAudit({ actorId, action: revoke ? 'badge.revoke' : 'badge.grant', targetType: 'user',
        targetId: req.params.userId, details: { badge: badge.name } });
      announceIdentity(io, req.params.userId);
      res.json(result);
    }));
  }

  return router;
}
