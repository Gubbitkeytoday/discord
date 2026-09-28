// ============================================================================
//  /api/cosmetics — the free collectibles catalogue.
//
//    GET    /api/cosmetics[?kind=]                     catalogue (packs + items)
//    GET    /api/cosmetics/items/:itemId/asset          uploaded pack asset (CSP-locked)
//    GET    /api/cosmetics/@me[?server_id=]             what I have equipped
//    PUT    /api/cosmetics/@me[?server_id=]             equip / unequip
//                                                       { avatar_decoration, profile_effect,
//                                                         nameplate, profile_frame }: id | null
//                                                       ('inherit' removes a server override)
//  Instance admins:
//    GET    /api/admin/cosmetic-packs                   every pack, disabled included
//    POST   /api/admin/cosmetic-packs                   { slug, name, author, license, version, items[] }
//    POST   /api/admin/cosmetic-packs/:packId/items     one more item { kind, slug, name, svg | image }
//    PATCH  /api/admin/cosmetic-packs/:packId           { enabled, name, disabled_items[] }
//    DELETE /api/admin/cosmetic-packs/:packId
//    POST   /api/admin/cosmetics/validate-svg           { svg } → sanitised preview or the reason
//  Server moderators:
//    GET/PATCH /api/servers/:serverId/cosmetics-settings   { cosmetics_hidden, new_member_badge_days }
//    POST   /api/servers/:serverId/members/:userId/profile-reset  { hide_tag, unhide_tag, reason }
// ============================================================================

import express from 'express';

import { ApiError, asyncRoute } from '../lib/httpUtils.js';
import { rateLimit } from '../lib/rateLimit.js';
import * as cosmetics from '../services/cosmetics.js';
import * as profiles from '../services/profiles.js';
import * as guilds from '../services/guilds.js';
import { assertInstanceAdmin } from '../services/instanceAdmin.js';
import { emitToRelated } from '../realtime.js';

const requireUser = (req) => {
  if (!req.userId) throw ApiError.unauthorized();
  return req.userId;
};

const equipLimit = rateLimit({ name: 'cosmetics-equip', limit: 60, windowMs: 60_000 });
const adminLimit = rateLimit({ name: 'cosmetics-admin', limit: 120, windowMs: 60_000 });

/** Tell everyone who can see this person to refetch their identity. */
export function announceIdentity(io, userId, serverId = null) {
  emitToRelated(io, userId, 'identity_updated', { user_id: userId, server_id: serverId })
    .catch(() => { /* best-effort */ });
}

async function adminOnly(req) {
  const userId = requireUser(req);
  await assertInstanceAdmin(userId);
  return userId;
}

export default function createCosmeticsRouter({ io } = {}) {
  const router = express.Router();

  router.get('/cosmetics', asyncRoute(async (req, res) => {
    requireUser(req);
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.json(await cosmetics.listCatalogue({ kind: req.query?.kind ?? null }));
  }));

  // Served from our origin, so it is locked down: no script can ever run even
  // if someone opens it directly, and the browser must not sniff it as HTML.
  router.get('/cosmetics/items/:itemId/asset', asyncRoute(async (req, res) => {
    const asset = await cosmetics.getAsset(req.params.itemId);
    res.setHeader('Content-Type', asset.type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.end(asset.body);
  }));

  router.get('/cosmetics/@me', asyncRoute(async (req, res) => {
    const userId = requireUser(req);
    const serverId = req.query?.server_id ? String(req.query.server_id) : null;
    res.json(await cosmetics.getEquipped(userId, { serverId }));
  }));

  router.put('/cosmetics/@me', equipLimit, asyncRoute(async (req, res) => {
    const userId = requireUser(req);
    const serverId = req.query?.server_id ? String(req.query.server_id) : null;
    if (serverId) {
      const resolved = await guilds.resolvePermissions({ userId, serverId });
      if (!resolved.isMember) throw ApiError.forbidden('You are not a member of this server');
    }
    const patch = {};
    for (const kind of cosmetics.KINDS) if (req.body?.[kind] !== undefined) patch[kind] = req.body[kind];
    const result = await cosmetics.equip({ userId, serverId, patch });
    announceIdentity(io, userId, serverId);
    res.json(result);
  }));

  // --- instance admin: packs ---------------------------------------------------

  router.get('/admin/cosmetic-packs', asyncRoute(async (req, res) => {
    await adminOnly(req);
    res.json(await cosmetics.listPacks());
  }));

  router.post('/admin/cosmetic-packs', adminLimit, asyncRoute(async (req, res) => {
    const actorId = await adminOnly(req);
    res.status(201).json(await cosmetics.createPack({ actorId, pack: req.body ?? {} }));
  }));

  router.post('/admin/cosmetic-packs/:packId/items', adminLimit, asyncRoute(async (req, res) => {
    const actorId = await adminOnly(req);
    res.status(201).json(await cosmetics.addItem({ actorId, packId: req.params.packId, item: req.body ?? {} }));
  }));

  router.patch('/admin/cosmetic-packs/:packId', adminLimit, asyncRoute(async (req, res) => {
    const actorId = await adminOnly(req);
    res.json(await cosmetics.updatePack({ actorId, packId: req.params.packId, patch: req.body ?? {} }));
  }));

  router.delete('/admin/cosmetic-packs/:packId', adminLimit, asyncRoute(async (req, res) => {
    const actorId = await adminOnly(req);
    res.json(await cosmetics.deletePack({ actorId, packId: req.params.packId }));
  }));

  router.post('/admin/cosmetics/validate-svg', adminLimit, asyncRoute(async (req, res) => {
    await adminOnly(req);
    res.json({ svg: cosmetics.sanitizeSvg(req.body?.svg) });
  }));

  // --- server moderators -----------------------------------------------------------

  router.get('/servers/:serverId/cosmetics-settings', asyncRoute(async (req, res) => {
    const userId = requireUser(req);
    const resolved = await guilds.resolvePermissions({ userId, serverId: req.params.serverId });
    if (!resolved.isMember) throw ApiError.forbidden('You are not a member of this server');
    res.json(await profiles.getServerCosmeticsSettings(req.params.serverId));
  }));

  router.patch('/servers/:serverId/cosmetics-settings', asyncRoute(async (req, res) => {
    const actorId = requireUser(req);
    await profiles.assertServerPermission(guilds, { userId: actorId, serverId: req.params.serverId, permission: 'MANAGE_GUILD' });
    const settings = await profiles.setServerCosmeticsSettings({ serverId: req.params.serverId, actorId, patch: req.body ?? {} });
    io?.to(req.params.serverId).emit('server_identity_updated', { server_id: req.params.serverId, ...settings });
    res.json(settings);
  }));

  router.post('/servers/:serverId/members/:userId/profile-reset', asyncRoute(async (req, res) => {
    const actorId = requireUser(req);
    const { serverId, userId } = req.params;
    await profiles.assertServerPermission(guilds, { userId: actorId, serverId, permission: 'MANAGE_NICKNAMES' });
    const result = await profiles.resetMemberIdentity({
      serverId, actorId, userId,
      hideTag: req.body?.hide_tag !== false,
      unhideTag: req.body?.unhide_tag === true,
      reason: req.body?.reason ?? null
    });
    io?.to(serverId).emit('identity_updated', { user_id: userId, server_id: serverId });
    res.json(result);
  }));

  return router;
}
