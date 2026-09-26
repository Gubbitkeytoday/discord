// ============================================================================
//  /api/admin/* — the instance administration console.
//
//  Every route checks, server-side, that the caller administers this instance
//  (services/instanceAdmin.js); the client only decides whether to show the
//  entry point. Every change is written to instance_audit_log.
//
//  Mounted from routes/auth.js, so it needs no wiring in server.js.
// ============================================================================

import express from 'express';

import { ApiError, asyncRoute, parseLimit, unauthenticated } from '../lib/httpUtils.js';
import { rateLimit } from '../lib/rateLimit.js';
import * as admin from '../services/instanceAdmin.js';

const router = express.Router();

// Admin writes are rare; a stolen admin session should not be able to ban the
// whole instance in a second.
const adminWriteLimit = rateLimit({ name: 'admin-write', limit: 120, windowMs: 60_000 });

const requireAdmin = asyncRoute(async (req, _res, next) => {
  if (!req.userId) throw unauthenticated(req);
  await admin.assertInstanceAdmin(req.userId);
  next();
});

router.use('/admin', requireAdmin);
router.use('/admin', (req, res, next) => {
  // Nothing here is cacheable, by a browser or anything in between.
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') return next();
  return adminWriteLimit(req, res, next);
});

router.get('/admin/overview', asyncRoute(async (_req, res) => {
  res.json(await admin.overview());
}));

// --- reports -------------------------------------------------------------------

router.get('/admin/reports', asyncRoute(async (req, res) => {
  res.json(await admin.reportQueue({
    status: req.query.status ?? 'open',
    limit: parseLimit(req.query.limit, { fallback: 100, max: 200 })
  }));
}));

router.get('/admin/reports/:reportId', asyncRoute(async (req, res) => {
  res.json(await admin.reportDetail(req.params.reportId));
}));

router.patch('/admin/reports/:reportId', asyncRoute(async (req, res) => {
  res.json(await admin.actOnReport({
    actorId: req.userId,
    reportId: req.params.reportId,
    status: req.body?.status ?? 'resolved',
    action: req.body?.action ?? null,
    note: req.body?.note ?? null
  }));
}));

// --- users -----------------------------------------------------------------------

router.get('/admin/users', asyncRoute(async (req, res) => {
  res.json(await admin.listUsers({
    search: req.query.search ? String(req.query.search).slice(0, 100) : null,
    limit: parseLimit(req.query.limit, { fallback: 100, max: 500 })
  }));
}));

router.post('/admin/users/:userId/disable', asyncRoute(async (req, res) => {
  res.json(await admin.disableUser({ actorId: req.userId, userId: req.params.userId, reason: req.body?.reason ?? null }));
}));

router.post('/admin/users/:userId/enable', asyncRoute(async (req, res) => {
  res.json(await admin.enableUser({ actorId: req.userId, userId: req.params.userId }));
}));

router.delete('/admin/users/:userId', asyncRoute(async (req, res) => {
  res.json(await admin.removeUser({ actorId: req.userId, userId: req.params.userId }));
}));

// --- servers ---------------------------------------------------------------------

router.get('/admin/servers', asyncRoute(async (req, res) => {
  res.json(await admin.listServers({ limit: parseLimit(req.query.limit, { fallback: 200, max: 1000 }) }));
}));

// --- registration ----------------------------------------------------------------

router.get('/admin/registration', asyncRoute(async (_req, res) => {
  res.json(await admin.getRegistrationMode());
}));

router.put('/admin/registration', asyncRoute(async (req, res) => {
  const mode = req.body?.mode === 'default' ? null : req.body?.mode;
  if (mode === undefined) throw new ApiError('mode is required', { code: 'INVALID_MODE' });
  res.json(await admin.setRegistrationMode({ actorId: req.userId, mode }));
}));

// --- audit -----------------------------------------------------------------------

router.get('/admin/audit-log', asyncRoute(async (req, res) => {
  res.json(await admin.listAudit({ limit: parseLimit(req.query.limit, { fallback: 100, max: 500 }) }));
}));

export default router;
