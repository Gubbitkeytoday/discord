// ============================================================================
//  Health, metrics and browser telemetry endpoints.
//
//    GET  /api/live               liveness (process up; never touches the DB)
//    GET  /api/ready              readiness (DB, Redis if configured, disk, draining)
//    GET  /api/health             backward-compatible summary (unchanged shape)
//    GET  /metrics                Prometheus exposition (METRICS_TOKEN in production)
//    GET  /api/telemetry/config   what the browser may report, and where
//    POST /api/telemetry/vitals   Web Vitals beacon (anonymous, sampled, rate-limited)
//    POST /api/telemetry/errors   Sentry envelope tunnel (only with SENTRY_BROWSER_DSN)
// ============================================================================

import crypto from 'node:crypto';
import express from 'express';
import { asyncRoute, ApiError } from '../lib/httpUtils.js';
import { rateLimit } from '../lib/rateLimit.js';
import { renderMetrics, metricsSnapshot } from '../lib/middleware.js';
import {
  mergeExposition, renderPromMetrics, metricsContentType, registerRuntimeGauges
} from '../lib/telemetry.js';
import { getLogger } from '../lib/logger.js';
import {
  readinessChecks, ingestVitals, clientTelemetryConfig, forwardEnvelope, diskVolumes
} from '../services/observability.js';

const log = getLogger('observability');

/** Constant-time bearer check: hashing first gives equal-length buffers. */
function bearerMatches(header, secret) {
  const digest = (v) => crypto.createHash('sha256').update(String(v ?? '')).digest();
  return crypto.timingSafeEqual(digest(header), digest(`Bearer ${secret}`));
}

// Anonymous endpoints, so keyed on IP. A page load produces one vitals beacon
// (two with a bfcache restore) — 30/min is generous for a person and tight for
// a script trying to skew the dashboard.
const vitalsLimit = rateLimit({
  name: 'telemetry-vitals', byIpOnly: true, windowMs: 60_000,
  limit: Math.max(1, Number(process.env.RATE_LIMIT_VITALS_PER_MIN) || 30)
});
const errorsLimit = rateLimit({ name: 'telemetry-errors', byIpOnly: true, windowMs: 60_000, limit: 20 });

export default function observabilityRouter({
  io, config, db, storage, schemaVersion
}) {
  const router = express.Router();
  const sockets = () => io.engine.clientsCount;

  // Live gauges read at scrape/export time (lib/telemetry.js).
  registerRuntimeGauges({
    sockets,
    dbStats: db.stats,
    voiceParticipants: async () => (await db.getQuery(`SELECT COUNT(*) AS n FROM voice_states`))?.n ?? 0,
    disk: () => diskVolumes({
      storageRoot: storage.root, storageBackend: storage.backend(), dbPath: db.path, isSqlite: !db.isPostgres
    })
  });

  /**
   * Liveness: is the process up? Deliberately does not touch the database, so a
   * database blip cannot make an orchestrator kill an otherwise healthy container.
   */
  router.get('/api/live', (_req, res) => {
    res.json({ status: 'alive', uptime_seconds: Math.round(process.uptime()) });
  });

  /**
   * Readiness: should this instance receive traffic? Database, Redis (when
   * REDIS_URL is set) and free disk where uploads / the SQLite file live.
   */
  router.get('/api/ready', asyncRoute(async (req, res) => {
    if (req.app.get('shutting-down')) {
      res.status(503).json({ status: 'draining' });
      return;
    }
    const { ready, database, checks } = await readinessChecks({
      dbHealth: db.health,
      storageRoot: storage.root,
      storageBackend: storage.backend(),
      dbPath: db.path,
      isSqlite: !db.isPostgres
    });
    if (!ready) {
      res.status(503).json({ status: 'not_ready', database, checks });
      return;
    }
    res.json({ status: 'ready', database, checks, ...metricsSnapshot() });
  }));

  // Metrics are operational data (routes, volumes, latency, memory). In
  // production they are served only behind METRICS_TOKEN; without a token the
  // endpoint does not exist (lib/config.js warns at boot). Development keeps the
  // old convenience of an open endpoint.
  if (config.enableMetrics && (config.metricsToken || !config.isProduction)) {
    router.get('/metrics', asyncRoute(async (req, res) => {
      if (config.metricsToken && !bearerMatches(req.get('authorization'), config.metricsToken)) {
        res.status(401).type('text/plain').send('unauthorized\n');
        return;
      }
      const legacy = renderMetrics({ socketConnections: sockets() });
      res.type(metricsContentType).send(mergeExposition(legacy, await renderPromMetrics()));
    }));
  }

  router.get('/api/health', asyncRoute(async (_req, res) => {
    // Which driver is in use and whether it answers. An unreachable database
    // is a 503 with the reason, rather than an opaque 500 from the query below.
    const database = await db.health();
    if (!database.reachable) {
      res.status(503).json({ status: 'error', database, code_schema_version: schemaVersion });
      return;
    }
    const { version } = await db.getQuery(`SELECT MAX(version) AS version FROM schema_migrations`);
    res.json({
      status: 'ok',
      database,
      schema_version: version,
      // What *this process* was built against. A client that expects more than
      // this is talking to a server that was started before the code changed —
      // the API would 404 on newer routes with no other clue.
      code_schema_version: schemaVersion,
      storage_root: storage.root,
      uptime_seconds: Math.round(process.uptime()),
      connected_sockets: sockets()
    });
  }));

  // --- browser telemetry --------------------------------------------------------

  router.get('/api/telemetry/config', (_req, res) => {
    res.set('Cache-Control', 'public, max-age=300');
    res.json(clientTelemetryConfig());
  });

  router.post('/api/telemetry/vitals', vitalsLimit,
    express.text({ type: (req) => !req.is('application/json'), limit: '4kb' }), (req, res, next) => {
    try {
      if (Number(req.get('content-length')) > 4096) {
        throw new ApiError('Payload too large', { status: 413, code: 'PAYLOAD_TOO_LARGE' });
      }
      if (!clientTelemetryConfig().vitals.enabled) {
        res.status(204).end();
        return;
      }
      // sendBeacon cannot set Content-Type to JSON without a preflight-free
      // Blob, so accept a text body too.
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch { throw new ApiError('Body must be JSON', { code: 'INVALID_VITALS' }); }
      }
      ingestVitals(body);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.post('/api/telemetry/errors', errorsLimit,
    express.raw({ type: () => true, limit: '256kb' }),
    asyncRoute(async (req, res) => {
      const result = await forwardEnvelope(req.body ?? Buffer.alloc(0)).catch((err) => {
        if (err instanceof ApiError) throw err;
        // The tracker being down is not the browser's problem.
        log.warn({ err: { message: err.message, code: err.code } }, 'error tunnel: forward failed');
        return { forwarded: false };
      });
      res.status(result.forwarded ? 200 : 202).json({});
    }));

  return router;
}
