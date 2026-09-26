// ============================================================================
//  /api/translate — translate a stored message the caller can read.
//
//    GET  /api/translate/config[?channel_id=]   which providers are usable
//    POST /api/translate  { messageId, targetLang }
//    GET  /api/servers/:serverId/translation     guild switch (members)
//    PUT  /api/servers/:serverId/translation  { disabled }   (MANAGE_GUILD)
//
//  Arbitrary text is never accepted: the endpoint translates what is stored,
//  after the same permission check that reading history has.
// ============================================================================

import express from 'express';

import { ApiError, asyncRoute } from '../lib/httpUtils.js';
import * as translation from '../services/translation.js';
import { assertPermission } from '../services/guilds.js';

const router = express.Router();

const requireUser = (req) => {
  if (!req.userId) throw ApiError.unauthorized();
  return req.userId;
};

router.get('/translate/config', asyncRoute(async (req, res) => {
  const userId = requireUser(req);
  res.json(await translation.clientConfig({ userId, channelId: req.query?.channel_id ?? null }));
}));

router.post('/translate', asyncRoute(async (req, res) => {
  try {
    res.json(await translation.translateMessage({
      userId: requireUser(req),
      messageId: req.body?.messageId ?? req.body?.message_id,
      targetLang: req.body?.targetLang ?? req.body?.target_lang
    }));
  } catch (err) {
    if (err?.status === 429 && err.details?.retry_after_seconds) {
      res.setHeader('Retry-After', String(err.details.retry_after_seconds));
    }
    throw err;
  }
}));

router.get('/servers/:serverId/translation', asyncRoute(async (req, res) => {
  const userId = requireUser(req);
  await assertPermission({ userId, serverId: req.params.serverId, permission: 'VIEW_CHANNEL' });
  res.json({
    server_id: req.params.serverId,
    translation_disabled: await translation.isGuildDisabled(req.params.serverId)
  });
}));

router.put('/servers/:serverId/translation', asyncRoute(async (req, res) => {
  if (typeof req.body?.disabled !== 'boolean') {
    throw new ApiError('disabled must be true or false', { code: 'INVALID_INPUT' });
  }
  res.json(await translation.setGuildDisabled({
    userId: requireUser(req), serverId: req.params.serverId, disabled: req.body.disabled
  }));
}));

export default router;
