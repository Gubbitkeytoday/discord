// ============================================================================
//  /api/payments — donations ("Support this instance") and the Supporter
//  badge. Nothing in the app is paywalled; the badge is the only perk.
//
//    GET  /api/payments/config                   public-safe: methods, presets, limits
//    POST /api/payments/orders                   { amount_thb, method } (signed in)
//    GET  /api/payments/orders                   my orders (history)
//    GET  /api/payments/orders/:id               owner or instance admin
//    POST /api/payments/orders/:id/slip          multipart `slip` image and/or `payload`
//    GET  /api/payments/supporter                my badge state
//    PUT  /api/payments/supporter                { badge_hidden }
//    POST /api/payments/stripe/webhook           raw body, Stripe-Signature (server.js
//                                                mounts express.raw for this path
//                                                BEFORE express.json)
//  Instance admins:
//    GET  /api/admin/payments?status=&method=&q=
//    POST /api/admin/payments/:id/approve        { reason?, trans_ref? }
//    POST /api/admin/payments/:id/reject         { reason }
//
//  Also runs the expiry sweeper: unpaid orders with no slip expire after
//  PAYMENTS_ORDER_TTL_MIN (30) minutes.
//
//  Socket: `payment_updated` { order } to the payer's user room whenever an
//  order changes; `identity_updated` when the badge appears.
// ============================================================================

import express from 'express';
import multer from 'multer';

import { ApiError, asyncRoute } from '../lib/httpUtils.js';
import { rateLimit } from '../lib/rateLimit.js';
import { getLogger } from '../lib/logger.js';
import { config as appConfig } from '../lib/config.js';
import { assertInstanceAdmin } from '../services/instanceAdmin.js';
import { paymentsConfig, publicConfig } from '../services/payments/config.js';
import * as orders from '../services/payments/orders.js';
import { verifyStripeSignature } from '../services/payments/stripe.js';
import { announceIdentity } from './cosmetics.js';

const log = getLogger('payments');

const requireUser = (req) => {
  if (!req.userId) throw ApiError.unauthorized();
  return req.userId;
};

const orderLimit = rateLimit({ name: 'payment-order', limit: 20, windowMs: 10 * 60_000 });
const slipLimit = rateLimit({ name: 'payment-slip', limit: 12, windowMs: 10 * 60_000 });
const adminLimit = rateLimit({ name: 'payment-admin', limit: 120, windowMs: 60_000 });
const webhookLimit = rateLimit({ name: 'payment-webhook', limit: 600, windowMs: 60_000, byIpOnly: true });

function enabledConfig() {
  const cfg = paymentsConfig();
  if (!cfg.enabled) throw orders.disabledError();
  return cfg;
}

function slipUpload(req, res, next) {
  const cfg = paymentsConfig();
  const handler = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: cfg.slipMaxBytes + 1, files: 1, fields: 4, fieldSize: 2048 }
  }).single('slip');
  handler(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return next(new ApiError('That image is too large', { status: 413, code: 'FILE_TOO_LARGE' }));
    return next(new ApiError('Upload failed', { code: 'UPLOAD_FAILED' }));
  });
}

export function startPaymentsSweeper(io) {
  const cfg = paymentsConfig();
  if (!cfg.enabled) return null;
  const timer = setInterval(async () => {
    try {
      const expired = await orders.sweepExpired();
      for (const row of expired) emitOrder(io, row);
    } catch (err) {
      log.warn({ err }, 'payment expiry sweep failed');
    }
  }, cfg.sweepMs);
  timer.unref?.();
  return timer;
}

function emitOrder(io, row, { paid = false } = {}) {
  if (!io || !row?.user_id) return;
  io.to(`user-${row.user_id}`).emit('payment_updated', { order: orders.shapeOrder(row, paymentsConfig()), paid });
  if (paid) announceIdentity(io, row.user_id);
}

export default function createPaymentsRouter({ io } = {}) {
  const router = express.Router();
  startPaymentsSweeper(io);

  router.get('/payments/config', (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(publicConfig());
  });

  router.post('/payments/orders', orderLimit, asyncRoute(async (req, res) => {
    const userId = requireUser(req);
    const cfg = enabledConfig();
    const result = await orders.createOrder({
      userId, cfg, publicUrl: appConfig.publicUrl,
      amountThb: req.body?.amount_thb, method: req.body?.method ?? 'promptpay'
    });
    res.status(201).json(result);
  }));

  router.get('/payments/orders', asyncRoute(async (req, res) => {
    const userId = requireUser(req);
    const cfg = enabledConfig();
    res.json({ orders: await orders.listOrdersForUser(userId, cfg) });
  }));

  router.get('/payments/orders/:id', asyncRoute(async (req, res) => {
    const userId = requireUser(req);
    const cfg = enabledConfig();
    const { row, admin } = await orders.getOrderFor({ orderId: req.params.id, viewerId: userId });
    res.json({ order: orders.shapeOrder(row, cfg, { admin }) });
  }));

  router.post(
    '/payments/orders/:id/slip',
    slipLimit,
    // Who and which order first; bytes second.
    asyncRoute(async (req, _res, next) => {
      const userId = requireUser(req);
      enabledConfig();
      const row = await orders.getOrderRow(req.params.id);
      if (!row || row.user_id !== userId) throw ApiError.notFound('Order');
      next();
    }),
    slipUpload,
    asyncRoute(async (req, res) => {
      const cfg = enabledConfig();
      const result = await orders.submitSlip({
        orderId: req.params.id, userId: req.userId, cfg,
        image: req.file?.buffer ?? null,
        payload: req.body?.payload ?? null
      });
      emitOrder(io, result.order, { paid: result.newlyPaid });
      res.json({ order: orders.shapeOrder(result.order, cfg), result: result.result, check_code: result.check_code });
    })
  );

  router.get('/payments/supporter', asyncRoute(async (req, res) => {
    res.json(await orders.supporterStatus(requireUser(req)));
  }));

  router.put('/payments/supporter', asyncRoute(async (req, res) => {
    const userId = requireUser(req);
    const result = await orders.setSupporterBadgeHidden(userId, Boolean(req.body?.badge_hidden));
    announceIdentity(io, userId);
    res.json(result);
  }));

  // --- Stripe webhook --------------------------------------------------------------

  router.post('/payments/stripe/webhook', webhookLimit, asyncRoute(async (req, res) => {
    const cfg = paymentsConfig();
    if (!cfg.stripe) throw orders.disabledError();
    const rawBody = Buffer.isBuffer(req.body) ? req.body : null;
    const ok = verifyStripeSignature({
      rawBody, header: req.get('stripe-signature'), secret: cfg.stripeKeys.webhookSecret
    });
    if (!ok) throw new ApiError('Invalid signature', { status: 400, code: 'BAD_SIGNATURE' });
    let event;
    try { event = JSON.parse(rawBody.toString('utf8')); } catch {
      throw new ApiError('Malformed event', { status: 400, code: 'BAD_EVENT' });
    }
    const result = await orders.applyStripeEvent(event);
    if (!result.duplicate && result.order) emitOrder(io, result.order, { paid: result.newlyPaid });
    res.json({ received: true, duplicate: result.duplicate });
  }));

  // --- instance admin --------------------------------------------------------------

  router.get('/admin/payments', asyncRoute(async (req, res) => {
    await assertInstanceAdmin(requireUser(req));
    const cfg = paymentsConfig();
    const q = req.query ?? {};
    const pick = (v) => (typeof v === 'string' && v ? v : null);
    const result = await orders.adminList({
      status: pick(q.status), method: pick(q.method), q: pick(q.q), limit: Number(q.limit) || 50
    }, cfg);
    res.json({ ...result, enabled: cfg.enabled, verification: cfg.provider });
  }));

  router.post('/admin/payments/:id/approve', adminLimit, asyncRoute(async (req, res) => {
    const actorId = requireUser(req);
    await assertInstanceAdmin(actorId);
    const row = await orders.approveOrder({
      orderId: req.params.id, actorId, reason: req.body?.reason ?? null, transRef: req.body?.trans_ref ?? null
    });
    emitOrder(io, row, { paid: true });
    res.json({ order: orders.shapeOrder(row, paymentsConfig(), { admin: true }) });
  }));

  router.post('/admin/payments/:id/reject', adminLimit, asyncRoute(async (req, res) => {
    const actorId = requireUser(req);
    await assertInstanceAdmin(actorId);
    const row = await orders.rejectOrder({ orderId: req.params.id, actorId, reason: req.body?.reason });
    emitOrder(io, row);
    res.json({ order: orders.shapeOrder(row, paymentsConfig(), { admin: true }) });
  }));

  return router;
}
