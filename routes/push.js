// ============================================================================
//  Web Push subscriptions and notification settings.
//
//    GET    /api/push/config                    { enabled, public_key }
//    GET    /api/push/subscriptions             this user's devices (no secrets)
//    POST   /api/push/subscriptions             register this browser (tied to the session)
//    DELETE /api/push/subscriptions             { endpoint } — this browser
//    DELETE /api/push/subscriptions/:id         any of this user's devices
//    POST   /api/push/test                      send a test push to my devices
//
//    GET    /api/notification-settings                      servers, channels, prefs
//    GET    /api/notification-settings/servers/:serverId
//    PUT    /api/notification-settings/servers/:serverId    { level, muted, muted_until | mute_minutes,
//                                                             suppress_everyone, suppress_roles }
//    GET    /api/notification-settings/channels/:channelId  incl. effective level + where it came from
//    PUT    /api/notification-settings/channels/:channelId  { level, muted, muted_until | mute_minutes }
//    PUT    /api/notification-settings/prefs                { keywords[], push_content }
//
//  createPushRouter({ io }) also wires the gateway side (focus reports,
//  notification_ping) and the maintenance timers.
// ============================================================================

import express from 'express';
import { asyncRoute, requireUser, ApiError } from '../lib/httpUtils.js';
import { rateLimit } from '../lib/rateLimit.js';
import * as push from '../services/push.js';
import * as notifications from '../services/notifications.js';

const subscribeLimit = rateLimit({ name: 'push-subscribe', limit: 20, windowMs: 60 * 60_000 });
const testLimit = rateLimit({ name: 'push-test', limit: 5, windowMs: 60_000 });
const settingsLimit = rateLimit({ name: 'notification-settings', limit: 120, windowMs: 60_000 });

const MAINTENANCE_MS = 60_000;

export default function createPushRouter({ io } = {}) {
  if (io) {
    notifications.setNotificationGateway(io);
    push.attachGateway(io);
  }
  push.listenForSessionEnd();
  const timer = setInterval(() => {
    notifications.sweepExpiredMutes().catch(() => {});
    if (push.isEnabled()) push.pruneExpired().catch(() => {});
  }, MAINTENANCE_MS);
  timer.unref?.();

  const router = express.Router();

  // --- push ------------------------------------------------------------------

  router.get('/push/config', (_req, res) => res.json(push.status()));

  router.get('/push/subscriptions', requireUser, asyncRoute(async (req, res) => {
    res.json(await push.listSubscriptions(req.userId, req.sessionId ?? null));
  }));

  router.post('/push/subscriptions', requireUser, subscribeLimit, asyncRoute(async (req, res) => {
    // Bots have no browser.
    if (req.botApplicationId) throw ApiError.forbidden('Bots cannot subscribe to push');
    const result = await push.subscribe({
      userId: req.userId,
      sessionId: req.sessionId ?? null,
      subscription: req.body?.subscription ?? req.body,
      userAgent: req.get('user-agent') ?? null
    });
    res.status(201).json(result);
  }));

  router.delete('/push/subscriptions', requireUser, asyncRoute(async (req, res) => {
    res.json(await push.unsubscribe({ userId: req.userId, endpoint: req.body?.endpoint }));
  }));

  router.delete('/push/subscriptions/:id', requireUser, asyncRoute(async (req, res) => {
    res.json(await push.removeSubscriptionById(req.userId, req.params.id));
  }));

  router.post('/push/test', requireUser, testLimit, asyncRoute(async (req, res) => {
    res.json(await push.sendTestPush(req.userId));
  }));

  // --- notification settings ---------------------------------------------------

  router.get('/notification-settings', requireUser, asyncRoute(async (req, res) => {
    res.json(await notifications.getAllSettings(req.userId));
  }));

  router.get('/notification-settings/servers/:serverId', requireUser, asyncRoute(async (req, res) => {
    res.json(await notifications.getServerSettings(req.userId, req.params.serverId));
  }));

  router.put('/notification-settings/servers/:serverId', requireUser, settingsLimit, asyncRoute(async (req, res) => {
    const value = await notifications.updateServerSettings(req.userId, req.params.serverId, req.body ?? {});
    io?.to(`user-${req.userId}`).emit('notification_settings_updated', { kind: 'server', value });
    res.json(value);
  }));

  router.get('/notification-settings/channels/:channelId', requireUser, asyncRoute(async (req, res) => {
    const { assertChannelAccess } = await import('../services/access.js');
    await assertChannelAccess({ channelId: req.params.channelId, userId: req.userId }).catch((err) => {
      throw err?.status === 403 ? ApiError.notFound('Channel') : err;
    });
    res.json(await notifications.getChannelSettings(req.userId, req.params.channelId));
  }));

  router.put('/notification-settings/channels/:channelId', requireUser, settingsLimit, asyncRoute(async (req, res) => {
    const value = await notifications.updateChannelSettings(req.userId, req.params.channelId, req.body ?? {});
    io?.to(`user-${req.userId}`).emit('notification_settings_updated', { kind: 'channel', value });
    res.json(value);
  }));

  router.put('/notification-settings/prefs', requireUser, settingsLimit, asyncRoute(async (req, res) => {
    res.json(await notifications.updatePrefs(req.userId, req.body ?? {}));
  }));

  return router;
}
