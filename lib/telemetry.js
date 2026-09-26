// ============================================================================
//  Telemetry: Prometheus metrics, OpenTelemetry traces/metrics, error tracking.
//
//  Three independent, optional pieces:
//
//   * Prometheus (prom-client) — always on while ENABLE_METRICS is on. Served
//     at /metrics next to the hand-written app_* series from lib/middleware.js.
//     Recording is a counter increment or a histogram bucket, nothing more.
//
//   * OpenTelemetry — OFF unless OTEL_EXPORTER_OTLP_ENDPOINT (or the traces
//     endpoint) is set. When off, none of the SDK is even imported: every
//     helper below checks one boolean and calls straight through. When on,
//     lib/otel-preload.mjs starts the SDK before the app loads so the http /
//     express / pg auto-instrumentations can patch those modules; database
//     queries and socket events get spans from the wrappers here.
//
//   * Error tracking — OFF unless SENTRY_DSN is set. Any Sentry-protocol
//     server works (Sentry, or self-hosted GlitchTip). PII is scrubbed before
//     an event leaves the process.
// ============================================================================

import client from 'prom-client';
import fs from 'node:fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { logger, redact, scrubString, setTraceContextProvider, currentRequestId } from './logger.js';

const log = logger.child({ component: 'telemetry' });

// --- identity ------------------------------------------------------------------

function packageVersion() {
  try {
    return JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  } catch { return '0.0.0'; }
}

/** The running build: the git sha baked into the image, else the package version. */
export const RELEASE = process.env.APP_RELEASE || process.env.GIT_SHA || process.env.SOURCE_COMMIT
  || `antigravity-discord@${packageVersion()}`;
export const SERVICE_NAME = process.env.OTEL_SERVICE_NAME || 'antigravity-discord';

export function otelConfigured(env = process.env) {
  if (String(env.OTEL_SDK_DISABLED).toLowerCase() === 'true') return false;
  return Boolean(env.OTEL_EXPORTER_OTLP_ENDPOINT || env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
    || env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT);
}

// --- Prometheus ----------------------------------------------------------------

export const registry = new client.Registry();
let defaultMetricsStarted = false;

const SECONDS_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

const httpDuration = new client.Histogram({
  name: 'app_http_request_duration_seconds',
  help: 'HTTP request duration by method, route template and status code',
  labelNames: ['method', 'route', 'status_code'],
  buckets: SECONDS_BUCKETS,
  registers: [registry]
});

const dbDuration = new client.Histogram({
  name: 'app_db_query_duration_seconds',
  help: 'Database adapter call duration by driver and operation',
  labelNames: ['driver', 'operation'],
  buckets: [0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [registry]
});

const dbErrors = new client.Counter({
  name: 'app_db_query_errors_total',
  help: 'Database adapter calls that threw',
  labelNames: ['driver', 'operation'],
  registers: [registry]
});

const socketEvents = new client.Counter({
  name: 'app_socket_events_total',
  help: 'Inbound Socket.IO events handled, by event name',
  labelNames: ['event'],
  registers: [registry]
});

const pushSends = new client.Counter({
  name: 'app_push_sends_total',
  help: 'Notification deliveries attempted, by channel (socket, webpush, email) and result',
  labelNames: ['channel', 'result'],
  registers: [registry]
});

const errorsReported = new client.Counter({
  name: 'app_errors_reported_total',
  help: 'Server errors handed to the error tracker (counted even when none is configured)',
  labelNames: ['source'],
  registers: [registry]
});

const VITAL_SPECS = {
  LCP: { unit: 's', buckets: [0.5, 1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10, 20], max: 120 },
  INP: { unit: 's', buckets: [0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 0.75, 1, 2, 5], max: 60 },
  FCP: { unit: 's', buckets: [0.5, 1, 1.5, 1.8, 2.5, 3, 4, 6, 10], max: 120 },
  TTFB: { unit: 's', buckets: [0.1, 0.2, 0.4, 0.8, 1.2, 1.8, 3, 5, 10], max: 120 },
  CLS: { unit: '', buckets: [0.01, 0.025, 0.05, 0.1, 0.15, 0.25, 0.5, 1, 2], max: 50 }
};
export const WEB_VITAL_NAMES = Object.keys(VITAL_SPECS);
export const WEB_VITAL_RATINGS = ['good', 'needs-improvement', 'poor'];

const vitalHistograms = Object.fromEntries(Object.entries(VITAL_SPECS).map(([name, spec]) => [
  name,
  new client.Histogram({
    name: `app_web_vitals_${name.toLowerCase()}${spec.unit === 's' ? '_seconds' : ''}`,
    help: `Core Web Vital ${name} reported by browsers (sampled)`,
    labelNames: ['rating'],
    buckets: spec.buckets,
    registers: [registry]
  })
]));

/** Upper bound on a plausible value, for input validation. */
export const webVitalMax = (name) => VITAL_SPECS[name]?.max ?? 0;

// Gauges read at scrape time from whatever server.js registers.
const gaugeSources = { sockets: null, dbStats: null, voiceParticipants: null, disk: null };
let voiceCache = { at: 0, value: 0 };
let diskCache = { at: 0, value: [] };

new client.Gauge({
  name: 'app_socket_connections',
  help: 'Connected websocket clients',
  registers: [registry],
  collect() { if (gaugeSources.sockets) this.set(gaugeSources.sockets()); }
});

new client.Gauge({
  name: 'app_db_pool_connections',
  help: 'Database pool connections by state (PostgreSQL only)',
  labelNames: ['state'],
  registers: [registry],
  collect() {
    const pool = gaugeSources.dbStats?.()?.pool;
    if (!pool) return;
    for (const state of ['total', 'idle', 'waiting', 'max']) {
      if (Number.isFinite(pool[state])) this.set({ state }, pool[state]);
    }
  }
});

new client.Gauge({
  name: 'app_db_inflight_queries',
  help: 'Database adapter calls currently in flight',
  registers: [registry],
  collect() {
    const stats = gaugeSources.dbStats?.();
    if (stats && Number.isFinite(stats.inflight)) this.set(stats.inflight);
  }
});

async function readVoiceParticipants() {
  if (!gaugeSources.voiceParticipants) return null;
  // Cached: a scrape every 15 s from two scrapers must not become DB load.
  if (Date.now() - voiceCache.at > 10_000) {
    try {
      voiceCache = { at: Date.now(), value: Number(await gaugeSources.voiceParticipants()) || 0 };
    } catch { voiceCache.at = Date.now(); }
  }
  return voiceCache.value;
}

new client.Gauge({
  name: 'app_voice_participants',
  help: 'Users currently connected to a voice or stage channel',
  registers: [registry],
  async collect() {
    const value = await readVoiceParticipants();
    if (value !== null) this.set(value);
  }
});

async function readDisk() {
  if (!gaugeSources.disk) return [];
  if (Date.now() - diskCache.at > 10_000) {
    try {
      diskCache = { at: Date.now(), value: (await gaugeSources.disk()) ?? [] };
    } catch { diskCache.at = Date.now(); }
  }
  return diskCache.value;
}

for (const [field, name, help] of [
  ['free_bytes', 'app_disk_free_bytes', 'Free bytes on the filesystem holding each data volume (storage, database)'],
  ['total_bytes', 'app_disk_total_bytes', 'Size of the filesystem holding each data volume']
]) {
  new client.Gauge({
    name, help, labelNames: ['volume'], registers: [registry],
    async collect() {
      for (const d of await readDisk()) {
        if (Number.isFinite(d[field])) this.set({ volume: d.volume }, d[field]);
      }
    }
  });
}

/**
 * Tell telemetry how to read live gauges. Called once from server.js; every
 * source is optional.
 */
export function registerRuntimeGauges({ sockets, dbStats, voiceParticipants, disk } = {}) {
  if (disk) gaugeSources.disk = disk;
  if (sockets) gaugeSources.sockets = sockets;
  if (dbStats) gaugeSources.dbStats = dbStats;
  if (voiceParticipants) gaugeSources.voiceParticipants = voiceParticipants;
  if (otel.meter) registerOtelGauges();
}

/** Node.js default metrics (CPU, memory, GC, event-loop lag, handles). */
export function startDefaultMetrics() {
  if (defaultMetricsStarted) return;
  defaultMetricsStarted = true;
  client.collectDefaultMetrics({ register: registry, eventLoopMonitoringPrecision: 20 });
}

/**
 * Merge the legacy hand-written exposition with prom-client's. When both
 * define a metric family (process_resident_memory_bytes, app_socket_connections)
 * prom-client's wins, because Prometheus rejects a scrape with duplicate
 * families.
 */
export function mergeExposition(legacyText, promText) {
  const familyOf = (line) => {
    const m = /^# (?:HELP|TYPE) (\S+)/.exec(line) ?? /^([a-zA-Z_:][a-zA-Z0-9_:]*)/.exec(line);
    return m ? m[1] : null;
  };
  const promFamilies = new Set(promText.split('\n').map(familyOf).filter(Boolean));
  const baseName = (name) => name.replace(/_(bucket|sum|count|total|created)$/, '');
  const kept = legacyText.split('\n').filter((line) => {
    if (!line) return false;
    const family = familyOf(line);
    return !family || !(promFamilies.has(family) || promFamilies.has(baseName(family)));
  });
  return `${kept.join('\n')}\n${promText.endsWith('\n') ? promText : `${promText}\n`}`;
}

export const metricsContentType = registry.contentType;
export const renderPromMetrics = () => registry.metrics();

// --- recording helpers (called from hot paths: keep them branch-cheap) --------------

/** Express middleware: request duration histogram keyed by route template. */
export function httpMetrics() {
  return (req, res, next) => {
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
      // A route *template* keeps cardinality bounded; unmatched paths (the SPA,
      // static files, 404s) collapse into one label value each.
      let route = req.route?.path ? `${req.baseUrl ?? ''}${req.route.path}` : null;
      if (!route) {
        const path = req.path ?? '';
        route = path.startsWith('/api/') ? 'unmatched_api'
          : path.startsWith('/uploads') ? 'uploads' : 'static';
      }
      if (typeof route !== 'string') route = String(route);
      httpDuration.observe({ method: req.method, route, status_code: String(res.statusCode) }, seconds);
      otel.instruments?.httpDuration.record(seconds, { method: req.method, route, status_code: res.statusCode });
    });
    next();
  };
}

export function recordSocketEvent(event) {
  socketEvents.inc({ event });
  otel.instruments?.socketEvents.add(1, { event });
}

export function recordMessageSent() {
  otel.instruments?.messagesSent.add(1);
}

/** channel: socket | webpush | email | …; result: ok | error | gone */
export function recordPushSend(channel, result = 'ok', count = 1) {
  pushSends.inc({ channel, result }, count);
  otel.instruments?.pushSends.add(count, { channel, result });
}

/** name is one of WEB_VITAL_NAMES; value in the metric's unit (ms converted by the caller). */
export function recordWebVital(name, value, rating) {
  vitalHistograms[name]?.observe({ rating }, value);
  otel.instruments?.vitals[name]?.record(value, { rating });
}

// --- OpenTelemetry -------------------------------------------------------------

const otel = { started: false, sdk: null, api: null, tracer: null, meter: null, instruments: null, gauges: false };

export const tracingActive = () => otel.tracer !== null;

/**
 * Start the OpenTelemetry SDK. Idempotent. Called by lib/otel-preload.mjs
 * (the supported way, so http/express/pg are auto-instrumented) or, as a
 * fallback, from server.js — then only manual spans and metrics work.
 */
export async function startOtel({ preloaded = false } = {}) {
  if (otel.started || !otelConfigured()) return otel.started;
  otel.started = true;
  try {
    const [
      api, { NodeSDK }, { OTLPTraceExporter }, { OTLPMetricExporter },
      { PeriodicExportingMetricReader }, { resourceFromAttributes },
      { HttpInstrumentation }, { ExpressInstrumentation, ExpressLayerType }, { PgInstrumentation }
    ] = await Promise.all([
      import('@opentelemetry/api'),
      import('@opentelemetry/sdk-node'),
      import('@opentelemetry/exporter-trace-otlp-http'),
      import('@opentelemetry/exporter-metrics-otlp-http'),
      import('@opentelemetry/sdk-metrics'),
      import('@opentelemetry/resources'),
      import('@opentelemetry/instrumentation-http'),
      import('@opentelemetry/instrumentation-express'),
      import('@opentelemetry/instrumentation-pg')
    ]);

    const quiet = new Set(['/api/live', '/api/ready', '/api/health', '/metrics', '/api/telemetry/vitals']);
    const sdk = new NodeSDK({
      resource: resourceFromAttributes({
        'service.name': SERVICE_NAME,
        'service.version': RELEASE,
        'deployment.environment.name': process.env.NODE_ENV || 'development'
      }),
      // Endpoint, headers, protocol, sampler (OTEL_TRACES_SAMPLER[_ARG]) all
      // come from the standard OTEL_* environment variables.
      traceExporter: new OTLPTraceExporter(),
      metricReaders: [new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter(),
        exportIntervalMillis: Number(process.env.OTEL_METRIC_EXPORT_INTERVAL) || 15_000
      })],
      instrumentations: [
        new HttpInstrumentation({
          ignoreIncomingRequestHook: (req) => quiet.has(String(req.url ?? '').split('?')[0])
            || String(req.url ?? '').startsWith('/socket.io/'),
          // Never record headers or bodies: they carry cookies and tokens.
          headersToSpanAttributes: undefined
        }),
        // Route handlers only: a span per middleware (cors, json, identify…)
        // is noise on every request.
        new ExpressInstrumentation({ ignoreLayersType: [ExpressLayerType.MIDDLEWARE] }),
        // Query text only (no parameter values), and only inside a request or
        // job span so pool housekeeping does not produce orphan traces.
        new PgInstrumentation({ requireParentSpan: true, enhancedDatabaseReporting: false })
      ]
    });
    sdk.start();

    otel.sdk = sdk;
    otel.api = api;
    otel.tracer = api.trace.getTracer(SERVICE_NAME, RELEASE);
    otel.meter = api.metrics.getMeter(SERVICE_NAME, RELEASE);
    createOtelInstruments();
    if (Object.values(gaugeSources).some(Boolean)) registerOtelGauges();

    setTraceContextProvider(() => {
      const span = api.trace.getActiveSpan();
      if (!span) return null;
      const { traceId, spanId, traceFlags } = span.spanContext();
      return { trace_id: traceId, span_id: spanId, trace_flags: traceFlags };
    });

    log.info({ endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, preloaded },
      'OpenTelemetry started');
    if (!preloaded) {
      log.warn('OpenTelemetry started without the preload: http/express/pg are not auto-instrumented. '
        + 'Run with NODE_OPTIONS="--import ./lib/otel-preload.mjs" (the Docker image does).');
    }
  } catch (err) {
    log.error({ err }, 'OpenTelemetry failed to start — continuing without it');
    otel.tracer = null;
    otel.meter = null;
    otel.instruments = null;
  }
  return otel.started;
}

function createOtelInstruments() {
  const m = otel.meter;
  const seconds = (boundaries) => ({ unit: 's', advice: { explicitBucketBoundaries: boundaries } });
  // Names are chosen so Prometheus' OTLP translation (dots → underscores, unit
  // and _total suffixes) lands on the same series names /metrics exposes, so one
  // Grafana dashboard works for scrape and push alike.
  otel.instruments = {
    httpDuration: m.createHistogram('app.http.request.duration',
      { description: 'HTTP request duration', ...seconds(SECONDS_BUCKETS) }),
    socketEvents: m.createCounter('app.socket.events', { description: 'Inbound Socket.IO events' }),
    messagesSent: m.createCounter('app.messages.sent', { description: 'Chat messages created' }),
    pushSends: m.createCounter('app.push.sends', { description: 'Notification deliveries attempted' }),
    dbErrors: m.createCounter('app.db.query.errors', { description: 'Database adapter calls that threw' }),
    errorsReported: m.createCounter('app.errors.reported', { description: 'Server errors handed to the error tracker' }),
    dbDuration: m.createHistogram('app.db.query.duration',
      { description: 'Database adapter call duration', ...seconds([0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5]) }),
    vitals: Object.fromEntries(Object.entries(VITAL_SPECS).map(([name, spec]) => [
      name,
      m.createHistogram(`app.web_vitals.${name.toLowerCase()}`, {
        description: `Core Web Vital ${name}`,
        ...(spec.unit ? { unit: spec.unit } : {}),
        advice: { explicitBucketBoundaries: spec.buckets }
      })
    ]))
  };
}

let loopDelay = null;
function registerOtelGauges() {
  if (otel.gauges || !otel.meter) return;
  otel.gauges = true;
  const m = otel.meter;
  m.createObservableGauge('app.socket.connections', { description: 'Connected websocket clients' })
    .addCallback((r) => { if (gaugeSources.sockets) r.observe(gaugeSources.sockets()); });
  m.createObservableGauge('app.db.pool.connections', { description: 'Database pool connections by state' })
    .addCallback((r) => {
      const pool = gaugeSources.dbStats?.()?.pool;
      if (!pool) return;
      for (const state of ['total', 'idle', 'waiting', 'max']) {
        if (Number.isFinite(pool[state])) r.observe(pool[state], { state });
      }
    });
  for (const [field, name] of [['free_bytes', 'app.disk.free'], ['total_bytes', 'app.disk.total']]) {
    m.createObservableGauge(name, { unit: 'By', description: 'Filesystem space for each data volume' })
      .addCallback(async (r) => {
        for (const d of await readDisk()) {
          if (Number.isFinite(d[field])) r.observe(d[field], { volume: d.volume });
        }
      });
  }
  m.createObservableGauge('app.voice.participants', { description: 'Users in voice channels' })
    .addCallback(async (r) => {
      const value = await readVoiceParticipants();
      if (value !== null) r.observe(value);
    });
  loopDelay = monitorEventLoopDelay({ resolution: 20 });
  loopDelay.enable();
  m.createObservableGauge('nodejs.eventloop.lag', { unit: 's', description: 'Mean event-loop delay since last export' })
    .addCallback((r) => {
      r.observe(loopDelay.mean / 1e9);
      loopDelay.reset();
    });
}

// Statement text for a span: whitespace collapsed, literals replaced, capped.
// Parameters are never attached — they are user data.
export function sanitizeSql(text) {
  return String(text)
    .replace(/--[^\n]*/g, ' ')
    .replace(/'(?:[^']|'')*'/g, '?')
    .replace(/\b\d+(?:\.\d+)?\b/g, '?')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1000);
}

function describeSql(text) {
  const s = String(text).trimStart();
  const operation = (/^(\w+)/.exec(s)?.[1] ?? 'QUERY').toUpperCase();
  const table = /\b(?:FROM|INTO|UPDATE|JOIN)\s+"?([A-Za-z_][\w]*)/i.exec(s)?.[1] ?? null;
  return { operation, table };
}

/**
 * Wrap one database adapter call. With tracing off this is a timer and a
 * histogram observation; with it on, also a CLIENT span.
 *   kind: run | get | all | exec | transaction
 */
export function traceDb(driver, kind, text, fn) {
  const startedAt = process.hrtime.bigint();
  const done = (failed) => {
    const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
    dbDuration.observe({ driver, operation: kind }, seconds);
    otel.instruments?.dbDuration.record(seconds, { driver, operation: kind });
    if (failed) {
      dbErrors.inc({ driver, operation: kind });
      otel.instruments?.dbErrors.add(1, { driver, operation: kind });
    }
  };

  if (!otel.tracer) {
    return fn().then((v) => { done(false); return v; }, (e) => { done(true); throw e; });
  }

  const { SpanKind, SpanStatusCode } = otel.api;
  const { operation, table } = text ? describeSql(text) : { operation: kind.toUpperCase(), table: null };
  const name = kind === 'transaction' ? 'db.transaction' : `${operation}${table ? ` ${table}` : ''}`;
  return otel.tracer.startActiveSpan(name, {
    kind: SpanKind.CLIENT,
    attributes: {
      'db.system.name': driver === 'postgres' ? 'postgresql' : 'sqlite',
      'db.operation.name': operation,
      ...(table ? { 'db.collection.name': table } : {}),
      ...(text ? { 'db.query.text': sanitizeSql(text) } : {})
    }
  }, (span) => fn().then((v) => {
    done(false);
    span.end();
    return v;
  }, (err) => {
    done(true);
    span.recordException({ name: err?.name, message: scrubString(err?.message ?? ''), code: err?.code });
    span.setStatus({ code: SpanStatusCode.ERROR, message: err?.code ?? 'error' });
    span.end();
    throw err;
  }));
}

/**
 * Wrap a Socket.IO event handler: counts the event and, with tracing on,
 * runs it inside a span (ended when its promise settles). With tracing off
 * the handler is only counted — no closure allocation beyond this wrapper.
 */
export function wrapSocketHandler(event, handler, socket) {
  if (typeof handler !== 'function') return handler;
  return function wrapped(...args) {
    recordSocketEvent(event);
    if (!otel.tracer) return handler.apply(this, args);
    const { SpanKind, SpanStatusCode } = otel.api;
    return otel.tracer.startActiveSpan(`socket.io ${event}`, {
      kind: SpanKind.SERVER,
      attributes: {
        'messaging.system': 'socket.io',
        'messaging.operation.type': 'process',
        'messaging.destination.name': event,
        ...(socket?.data?.userId ? { 'enduser.pseudo.id': String(socket.data.userId) } : {})
      }
    }, (span) => {
      const finish = (err) => {
        if (err) {
          span.recordException({ name: err?.name, message: scrubString(err?.message ?? '') });
          span.setStatus({ code: SpanStatusCode.ERROR });
        }
        span.end();
      };
      try {
        const result = handler.apply(this, args);
        if (result && typeof result.then === 'function') {
          return result.then((v) => { finish(); return v; }, (e) => { finish(e); throw e; });
        }
        finish();
        return result;
      } catch (err) {
        finish(err);
        throw err;
      }
    });
  };
}

/** Wrap `socket.on` for one connection so every handler it registers is instrumented. */
export function instrumentSocket(socket) {
  const on = socket.on.bind(socket);
  socket.on = (event, handler) => on(event,
    event === 'disconnect' || event === 'disconnecting' || event === 'error'
      ? handler
      : wrapSocketHandler(event, handler, socket));
  return socket;
}

export async function shutdownTelemetry() {
  const tasks = [];
  if (otel.sdk) tasks.push(otel.sdk.shutdown().catch(() => {}));
  if (sentry) tasks.push(sentry.close(2000).catch(() => {}));
  await Promise.race([Promise.all(tasks), new Promise((r) => setTimeout(r, 3000).unref?.())]);
}

// --- error tracking (Sentry protocol: Sentry or GlitchTip) ---------------------------

let sentry = null;
let sentryStarting = null;

const SCRUB_HEADERS = /^(authorization|cookie|set-cookie|x-api-key|x-admin-token|x-user-id|proxy-authorization)$/i;

/** Strip everything personal from a Sentry event. Exported for tests. */
export function scrubSentryEvent(event) {
  if (!event) return event;
  if (event.request) {
    const { method, url, headers } = event.request;
    const safeHeaders = {};
    for (const [k, v] of Object.entries(headers ?? {})) {
      if (!SCRUB_HEADERS.test(k)) safeHeaders[k] = scrubString(String(v));
    }
    event.request = {
      method,
      url: url ? scrubString(String(url).split('?')[0]) : undefined,
      headers: safeHeaders
    };
  }
  // Keep a pseudonymous id only: it lets an operator correlate reports from
  // one user without the tracker ever holding a name, e-mail or IP.
  if (event.user) event.user = event.user.id ? { id: String(event.user.id) } : undefined;
  if (event.message) event.message = scrubString(event.message);
  for (const ex of event.exception?.values ?? []) {
    if (ex.value) ex.value = scrubString(ex.value);
    for (const frame of ex.stacktrace?.frames ?? []) {
      delete frame.vars;
    }
  }
  if (event.extra) event.extra = redact(event.extra);
  if (event.contexts) event.contexts = redact(event.contexts);
  if (event.tags) event.tags = redact(event.tags);
  if (Array.isArray(event.breadcrumbs)) {
    event.breadcrumbs = event.breadcrumbs.map((b) => ({
      ...b,
      message: b.message ? scrubString(b.message) : b.message,
      data: b.data ? redact(b.data) : b.data
    }));
  }
  delete event.server_name;
  return event;
}

export function errorTrackingConfigured(env = process.env) {
  return Boolean(env.SENTRY_DSN);
}

/** Start the server-side error tracker when SENTRY_DSN is set. Idempotent. */
export function initErrorTracking() {
  if (sentry || sentryStarting || !errorTrackingConfigured()) return sentryStarting;
  sentryStarting = import('@sentry/node-core/light').then((Sentry) => {
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      release: RELEASE,
      environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || 'development',
      sendDefaultPii: false,
      // Errors only: tracing is OpenTelemetry's job here.
      tracesSampleRate: undefined,
      maxBreadcrumbs: 30,
      includeLocalVariables: false,
      beforeSend: scrubSentryEvent,
      beforeBreadcrumb: (b) => (b.category === 'console' ? null : b)
    });
    sentry = Sentry;
    log.info('error tracking enabled');
    return Sentry;
  }).catch((err) => {
    log.error({ err }, 'error tracking failed to start');
    return null;
  });
  return sentryStarting;
}

/**
 * Report a server error. Always counted; forwarded to the tracker when one is
 * configured. Never throws.
 */
export function reportError(err, { req = null, source = 'http', extra = null } = {}) {
  try {
    errorsReported.inc({ source });
    otel.instruments?.errorsReported.add(1, { source });
    if (!sentry) return;
    sentry.withScope((scope) => {
      scope.setTag('source', source);
      const requestId = req?.requestId ?? currentRequestId();
      if (requestId) scope.setTag('request_id', requestId);
      if (req?.route?.path) scope.setTag('route', `${req.baseUrl ?? ''}${req.route.path}`);
      if (req?.method) scope.setTag('method', req.method);
      if (req?.userId) scope.setUser({ id: String(req.userId) });
      if (extra) scope.setExtras(redact(extra));
      sentry.captureException(err);
    });
  } catch { /* reporting must never break the caller */ }
}

/** Flush pending error reports (used before a crash exit). */
export async function flushErrors(timeoutMs = 2000) {
  if (sentry) await sentry.flush(timeoutMs).catch(() => {});
}
