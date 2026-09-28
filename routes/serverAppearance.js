// ============================================================================
//  Server appearance & discovery — free server customisation.
//
//    POST   /api/servers/:serverId/appearance/:kind   multipart `image`; kind =
//           banner | splash | icon (MANAGE_GUILD, checked before the upload)
//    DELETE /api/servers/:serverId/appearance/:kind
//    POST   /api/servers/:serverId/roles/:roleId/icon multipart `icon` (≤256 KB,
//           PNG/JPEG/WebP/GIF; MANAGE_ROLES)          DELETE removes it
//    PATCH  /api/channels/:channelId/icon-emoji       { icon_emoji } (MANAGE_CHANNELS)
//    GET    /api/servers/:serverId/profile            the server profile card
//    PATCH  /api/servers/:serverId/profile            { accent_color, traits,
//           discoverable, discovery_category } (MANAGE_GUILD)
//    GET    /api/invites/:code/profile                card behind an invite / vanity
//    GET    /api/discover?q=&category=&limit=&offset= opt-in servers on this instance
//
//  Joining from Discover uses the existing POST /api/servers/:id/join, which
//  admits only servers carrying the DISCOVERABLE feature.
// ============================================================================

import express from 'express';
import multer from 'multer';

import { ApiError, asyncRoute } from '../lib/httpUtils.js';
import { writeRateLimit } from '../lib/rateLimit.js';
import { storeFile } from '../storageService.js';
import { decodeUploadFilename } from './files.js';
import { assertPermission } from '../services/guilds.js';
import * as guildAdmin from '../services/guildAdmin.js';
import * as appearance from '../services/serverAppearance.js';
import { emitToChannelViewers } from '../realtime.js';

const requireUserId = (req) => {
  if (!req.userId) throw ApiError.unauthorized();
  return req.userId;
};

/**
 * multer with a ceiling a little above what we accept, so an oversize file
 * gets our own 413 with a stable code instead of multer's generic error.
 */
function singleUpload(field, maxBytes) {
  const handler = multer({
    storage: multer.memoryStorage(),
    defParamCharset: 'utf8',
    limits: { fileSize: maxBytes + 1, files: 1, fields: 5 }
  }).single(field);
  return (req, res, next) => handler(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return next(new ApiError('That file is too large', { status: 413, code: 'FILE_TOO_LARGE' }));
    }
    return next(new ApiError(err.message || 'Upload failed', { code: 'UPLOAD_FAILED' }));
  });
}

/** Permission first, bytes second: a refused member never spends storage. */
const requirePermission = (permission) => asyncRoute(async (req, _res, next) => {
  await assertPermission({ userId: requireUserId(req), serverId: req.params.serverId, permission });
  next();
});

const GUILD_KINDS = ['banner', 'splash', 'icon'];
const CATEGORY_FOR_KIND = { banner: 'banners', splash: 'banners', icon: 'icons' };

export default function createServerAppearanceRouter({ io }) {
  const router = express.Router();

  const emitServer = (server) => { if (server?.id) io?.to(server.id).emit('server_updated', server); };

  // --- banner / splash / icon ----------------------------------------------

  router.post(
    '/servers/:serverId/appearance/:kind',
    writeRateLimit,
    asyncRoute(async (req, _res, next) => {
      if (!GUILD_KINDS.includes(req.params.kind)) throw ApiError.notFound('Image kind');
      next();
    }),
    requirePermission('MANAGE_GUILD'),
    singleUpload('image', appearance.GUILD_IMAGE_MAX_BYTES),
    asyncRoute(async (req, res) => {
      const buffer = req.file?.buffer;
      const mime = appearance.assertGuildImageFile(buffer);
      const file = await storeFile({
        buffer,
        originalName: decodeUploadFilename(req.file.originalname || `${req.params.kind}`),
        declaredMime: mime,
        category: CATEGORY_FOR_KIND[req.params.kind],
        uploaderId: req.userId
      });
      const server = await guildAdmin.setGuildImage({
        serverId: req.params.serverId, actorId: req.userId, kind: req.params.kind, file
      });
      emitServer(server);
      res.json({
        server,
        file: {
          id: file.id, url: file.url, width: file.width ?? null, height: file.height ?? null,
          is_animated: Boolean(file.is_animated),
          // A still first frame for "animate on hover" (made by the media
          // pipeline; absent until it has run, and for static images).
          still_url: file.variants?.preview?.url ?? null
        }
      });
    })
  );

  router.delete('/servers/:serverId/appearance/:kind', writeRateLimit, asyncRoute(async (req, res) => {
    if (!GUILD_KINDS.includes(req.params.kind)) throw ApiError.notFound('Image kind');
    const server = await guildAdmin.setGuildImage({
      serverId: req.params.serverId, actorId: requireUserId(req), kind: req.params.kind, file: null
    });
    emitServer(server);
    res.json({ server });
  }));

  // --- role icons ------------------------------------------------------------

  router.post(
    '/servers/:serverId/roles/:roleId/icon',
    writeRateLimit,
    requirePermission('MANAGE_ROLES'),
    singleUpload('icon', appearance.ROLE_ICON_MAX_BYTES * 4),
    asyncRoute(async (req, res) => {
      const buffer = req.file?.buffer;
      const mime = appearance.assertRoleIconFile(buffer);
      const file = await storeFile({
        buffer,
        originalName: decodeUploadFilename(req.file.originalname || 'role-icon'),
        declaredMime: mime,
        category: 'emojis',
        uploaderId: req.userId
      });
      const role = await guildAdmin.setRoleIcon({
        serverId: req.params.serverId, roleId: req.params.roleId, actorId: req.userId, file
      });
      io?.to(req.params.serverId).emit('role_updated', role);
      res.json(role);
    })
  );

  router.delete('/servers/:serverId/roles/:roleId/icon', writeRateLimit, asyncRoute(async (req, res) => {
    const role = await guildAdmin.setRoleIcon({
      serverId: req.params.serverId, roleId: req.params.roleId, actorId: requireUserId(req), file: null
    });
    io?.to(req.params.serverId).emit('role_updated', role);
    res.json(role);
  }));

  // --- channel emoji ---------------------------------------------------------

  router.patch('/channels/:channelId/icon-emoji', writeRateLimit, asyncRoute(async (req, res) => {
    const channel = await appearance.setChannelEmoji({
      channelId: req.params.channelId, userId: requireUserId(req), emoji: req.body?.icon_emoji ?? null
    });
    if (io) emitToChannelViewers(io, channel, 'channel_updated', channel).catch(() => {});
    res.json(channel);
  }));

  // --- server profile --------------------------------------------------------

  router.get('/servers/:serverId/profile', asyncRoute(async (req, res) => {
    res.json(await appearance.getServerProfile({ serverId: req.params.serverId, viewerId: requireUserId(req) }));
  }));

  router.patch('/servers/:serverId/profile', writeRateLimit, asyncRoute(async (req, res) => {
    const profile = await appearance.updateServerProfile({
      serverId: req.params.serverId, actorId: requireUserId(req), patch: req.body ?? {}
    });
    io?.to(req.params.serverId).emit('server_updated', {
      id: profile.id, accent_color: profile.accent_color, traits: profile.traits,
      discovery_category: profile.discovery_category, discoverable: profile.discoverable
    });
    res.json(profile);
  }));

  // Public like the invite preview itself: the join page shows it before sign-in.
  router.get('/invites/:code/profile', asyncRoute(async (req, res) => {
    res.json(await appearance.getInviteProfile({ code: req.params.code, viewerId: req.userId ?? null }));
  }));

  // --- discovery -------------------------------------------------------------

  router.get('/discover', asyncRoute(async (req, res) => {
    res.json(await appearance.listDiscoverable({
      viewerId: requireUserId(req),
      q: req.query.q ?? '',
      category: req.query.category || null,
      limit: req.query.limit,
      offset: req.query.offset
    }));
  }));

  return router;
}
