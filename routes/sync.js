// ============================================================================
//  Catch-up routes for clients coming back from a disconnect.
//
//    GET /api/channels/:channelId/messages?after=<id>&limit=<n>
//        Channel history (same service and gating as GET /api/messages/:id),
//        at the path shape Discord clients expect. `after` returns the next
//        `limit` messages oldest-first; repeat with the last id until a page
//        comes back short. `before` / `around` work as on the older route.
//
//    GET /api/sync?since=<cursor>
//        What changed for this user since the cursor (see services/sync.js).
//
//  Client algorithm after a reconnect:
//    1. socket `connect` with socket.recovered === true → nothing to do; the
//       missed events were replayed.
//    2. otherwise (new connection, or recovery refused) → re-identify and
//       re-join rooms as usual, then GET /api/sync?since=<last cursor>:
//         - reset: true              → full reload (initial-data), drop caches
//         - guilds[].state_hash diff → refetch that guild
//         - channels[] entries       → for open/cached channels, page
//           /api/channels/:id/messages?after=<newest cached id>; where
//           edited/deleted > 0, refetch the cached window (around=)
//       and store the returned `cursor` for next time. Take a fresh cursor
//       from every sync (and on first load) rather than a local clock.
// ============================================================================

import { Router } from 'express';
import { requireUser } from '../lib/httpUtils.js';
import { rateLimit } from '../lib/rateLimit.js';
import * as messageService from '../services/messages.js';
import { syncSince } from '../services/sync.js';

const router = Router();

// Catch-up is a burst by design (every client after a deploy), but each
// call is cheap and bounded; this only stops a loop from hammering it.
const syncLimit = rateLimit({ name: 'sync', limit: 30, windowMs: 60_000 });

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const clampLimit = (raw, fallback = 50) => {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, 100);
};
const idParam = (raw) => (typeof raw === 'string' && /^[\w-]{1,64}$/.test(raw) ? raw : null);

router.get('/channels/:channelId/messages', requireUser, wrap(async (req, res) => {
  const messages = await messageService.listMessages(req.params.channelId, {
    limit: clampLimit(req.query.limit),
    before: idParam(req.query.before),
    after: idParam(req.query.after),
    around: idParam(req.query.around),
    viewerId: req.userId
  });
  res.json(messages);
}));

router.get('/sync', requireUser, syncLimit, wrap(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await syncSince({ userId: req.userId, since: req.query.since }));
}));

export default router;
