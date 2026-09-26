// ============================================================================
//  Structured logging (pino) with request-scoped context and redaction.
//
//    LOG_LEVEL   trace | debug | info | warn | error | fatal | silent
//                (default: info in production, debug otherwise)
//    LOG_FORMAT  json | pretty   (default: json in production, pretty otherwise)
//
//  Every line written inside a request (or a socket event) carries that
//  request's id, taken from AsyncLocalStorage, so one user-reported failure can
//  be followed through the HTTP handler, the database layer and the realtime
//  fan-out without threading an id through every call. When OpenTelemetry is
//  active the current trace/span ids are attached too, which is what lets
//  Grafana jump from a log line to its trace.
//
//  Redaction is deliberately belt-and-braces: sensitive *keys* are replaced
//  wherever they appear (any depth), and *strings* are scrubbed for e-mail
//  addresses, bearer tokens, credentials in URLs and token-shaped query params.
//  Logs are shipped to third-party-ish systems (Loki, a SIEM, a support ticket)
//  and must never become the place a password or a private message leaks from.
// ============================================================================

import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'node:crypto';
import { Writable } from 'node:stream';
import pino from 'pino';

// --- redaction ---------------------------------------------------------------

export const REDACTED = '[REDACTED]';

/**
 * Keys whose values are never logged. Matched case-insensitively against the
 * whole key after stripping `-`/`_`, so `access_token`, `X-Api-Key` and
 * `newPassword` are all caught. Message *content* is on the list: chat text is
 * personal data and has no operational value in a log line.
 */
const SENSITIVE_KEY = new RegExp(
  '^(?:'
  + [
    '.*password.*', 'passwd', 'pwd', 'passphrase',
    '.*secret.*', '.*token.*', 'authorization', 'proxyauthorization',
    'cookie', 'setcookie', 'cookies',
    'apikey', 'xapikey', 'privatekey', 'clientsecret',
    'session', 'sessionid', 'sid',
    'totp', 'otp', 'mfacode', 'recoverycode', 'recoverycodes', 'backupcodes',
    'dsn', 'signature', 'sig', 'credentials', 'credential',
    'email', 'emailaddress', 'mail', 'phone', 'phonenumber',
    'content', 'messagecontent', 'body', 'text', 'rawbody', 'attachments'
  ].join('|')
  + ')$',
  'i'
);

export function isSensitiveKey(key) {
  return SENSITIVE_KEY.test(String(key).replace(/[-_\s]/g, ''));
}

const STRING_SCRUBBERS = [
  // user:password@ in any URL
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/:@]+:[^\s/@]+@/gi, '$1[REDACTED]@'],
  // Authorization header values that ended up inside a message
  [/\b(Bearer|Bot|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/g, '$1 [REDACTED]'],
  // token-ish query / form parameters
  [/([?&;\s](?:access_token|token|code|key|api_key|apikey|signature|sig|password|secret|t)=)[^&\s#"']+/gi, '$1[REDACTED]'],
  // JWTs
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g, '[REDACTED_JWT]'],
  // e-mail addresses
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[EMAIL]']
];

export function scrubString(value) {
  let out = String(value);
  for (const [pattern, replacement] of STRING_SCRUBBERS) out = out.replace(pattern, replacement);
  return out;
}

/**
 * Deep copy with sensitive keys replaced and strings scrubbed. Bounded in
 * depth and breadth so a huge or cyclic object cannot stall the log path.
 */
export function redact(value, depth = 0, seen = new WeakSet()) {
  if (value == null) return value;
  if (typeof value === 'string') return scrubString(value);
  if (typeof value !== 'object') return value;
  if (depth > 6) return '[Object]';
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (value instanceof Error) {
    return redact(pino.stdSerializers.err(value), depth, seen);
  }
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length}b]`;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    const out = value.slice(0, 50).map((v) => redact(v, depth + 1, seen));
    if (value.length > 50) out.push(`[+${value.length - 50} more]`);
    return out;
  }
  const out = {};
  let n = 0;
  for (const [key, v] of Object.entries(value)) {
    if (++n > 100) { out['…'] = '[truncated]'; break; }
    out[key] = isSensitiveKey(key) && v != null && v !== '' ? REDACTED : redact(v, depth + 1, seen);
  }
  return out;
}

// --- request context -----------------------------------------------------------

const als = new AsyncLocalStorage();

/** The current request/socket context ({ request_id, user_id, … }), if any. */
export const getContext = () => als.getStore();

/** Run fn with `ctx` as the logging context of everything it (a)synchronously calls. */
export function runWithContext(ctx, fn) {
  return als.run({ ...(als.getStore() ?? {}), ...ctx }, fn);
}

/** Attach fields (e.g. user_id once authenticated) to the current context. */
export function setContext(fields) {
  const store = als.getStore();
  if (store) Object.assign(store, fields);
}

/** Current request id, for error envelopes and outbound headers. */
export const currentRequestId = () => als.getStore()?.request_id ?? null;

// Filled in by lib/telemetry.js once OpenTelemetry has started, so this module
// does not load the OTel API when tracing is off.
let traceContextProvider = null;
export function setTraceContextProvider(fn) { traceContextProvider = fn; }

// Also filled in by lib/telemetry.js: receives every serialized line so it can
// be exported as an OpenTelemetry log record (→ Loki). Null = one branch.
let logSink = null;
export function setLogSink(fn) { logSink = fn; }

// --- the logger ------------------------------------------------------------------

// This module can be the first thing to read LOG_LEVEL / NODE_ENV (it is
// imported before db.js and lib/config.js), so it loads .env the same way they do.
if (!process.env.NODE_TEST_CONTEXT && process.env.NODE_ENV !== 'test') {
  try { process.loadEnvFile?.(); } catch { /* no .env file — fine */ }
}

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'];
const isTestRun = Boolean(process.env.NODE_TEST_CONTEXT);
const isProduction = process.env.NODE_ENV === 'production';

function resolveLevel(env = process.env) {
  const wanted = String(env.LOG_LEVEL ?? '').toLowerCase();
  if (LEVELS.includes(wanted)) return wanted;
  if (isTestRun) return 'warn';
  return isProduction ? 'info' : 'debug';
}

function resolveFormat(env = process.env) {
  const wanted = String(env.LOG_FORMAT ?? '').toLowerCase();
  if (wanted === 'json' || wanted === 'pretty') return wanted;
  return isProduction ? 'json' : 'pretty';
}

const COLOURS = { trace: 90, debug: 36, info: 32, warn: 33, error: 31, fatal: 35 };
const OMIT_IN_PRETTY = new Set(['level', 'time', 'msg', 'pid', 'hostname', 'service', 'env']);

/**
 * A small human formatter for development, so `npm run server` stays readable
 * without pulling in pino-pretty. Warnings and errors go to stderr.
 */
function prettyStream({ colour = process.stdout.isTTY } = {}) {
  return new Writable({
    write(chunk, _enc, done) {
      for (const line of String(chunk).split('\n')) {
        if (!line) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { process.stdout.write(`${line}\n`); continue; }
        const level = entry.level ?? 'info';
        const paint = (code, s) => (colour ? `\x1b[${code}m${s}\x1b[0m` : s);
        let text;
        if (entry.http) {
          const h = entry.http;
          const code = h.status >= 500 ? 31 : h.status >= 400 ? 33 : 32;
          text = `${paint(code, h.status)} ${String(h.method).padEnd(6)} ${h.path} ${h.duration_ms}ms`
            + `${entry.user_id ? ` user=${entry.user_id}` : ''}`;
        } else {
          const extras = Object.entries(entry)
            .filter(([k]) => !OMIT_IN_PRETTY.has(k))
            .map(([k, v]) => {
              if (k === 'err' && v?.stack) return `\n${v.stack}`;
              return `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`;
            });
          text = `${level === 'info' ? '' : `${paint(COLOURS[level] ?? 0, level.toUpperCase())} `}${entry.msg ?? ''}`
            + (extras.length ? ` ${paint(90, extras.join(' '))}` : '');
        }
        const target = ['warn', 'error', 'fatal'].includes(level) ? process.stderr : process.stdout;
        target.write(`${text}\n`);
      }
      done();
    }
  });
}

/** Build a logger. Exported for tests; the app uses the `logger` singleton. */
export function createLogger({
  level = resolveLevel(),
  format = resolveFormat(),
  destination = null,
  base = {}
} = {}) {
  const primary = destination
    ?? (format === 'pretty' && !isTestRun
      ? prettyStream()
      // Under `node --test` stdout is the runner's own channel.
      : pino.destination({ dest: isTestRun ? 2 : 1, sync: true }));
  // The sink runs synchronously inside the log call, so the active trace
  // context is still the caller's when the record is emitted.
  const stream = {
    write(line) {
      primary.write(line);
      if (logSink) { try { logSink(line); } catch { /* never break logging */ } }
    }
  };

  return pino({
    level,
    base: { service: process.env.OTEL_SERVICE_NAME || 'antigravity-discord', ...base },
    messageKey: 'msg',
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      level: (label) => ({ level: label }),
      // Every key of every line passes through here, error objects included
      // (pino has already run the serializers), so redaction cannot be skipped
      // by logging something under an unexpected key.
      log: (object) => redact(object)
    },
    // redact() serializes Error instances itself (and scrubs them); pino's own
    // err serializer runs after formatters.log and would mangle the result.
    serializers: { err: (e) => e, error: (e) => e },
    hooks: {
      // Scrub the message string (and printf-style arguments) too.
      logMethod(args, method) {
        // log.error(err) takes its message from err.message after this hook,
        // so give it an explicit (scrubbed) one.
        if (args[0] instanceof Error && typeof args[1] !== 'string') {
          args = [{ err: args[0] }, args[0].message];
        }
        method.apply(this, args.map((a) => (typeof a === 'string' ? scrubString(a) : a)));
      }
    },
    mixin() {
      const ctx = als.getStore();
      const trace = traceContextProvider?.();
      if (!ctx && !trace) return {};
      return { ...(ctx ?? {}), ...(trace ?? {}) };
    }
  }, stream);
}

export const logger = createLogger();

/** A child logger for one subsystem: logger.child({ component }) shorthand. */
export const getLogger = (component) => logger.child({ component });

// --- HTTP request logging ------------------------------------------------------------

const QUIET_PATHS = new Set(['/api/health', '/api/live', '/api/ready', '/metrics', '/api/telemetry/vitals']);
const REQUEST_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/**
 * Request id + AsyncLocalStorage context + one access-log line per request.
 *
 * Replaces lib/middleware.js requestLogger (same X-Request-Id behaviour). An
 * inbound X-Request-Id is honoured only when it looks like an id — otherwise a
 * client could inject arbitrary text into every log line of its request.
 */
export function httpLogger({ log = logger } = {}) {
  const access = log.child({ component: 'http' });
  return (req, res, next) => {
    const inbound = req.get('x-request-id');
    const requestId = inbound && REQUEST_ID.test(inbound) ? inbound : crypto.randomUUID();
    req.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);
    const startedAt = process.hrtime.bigint();

    res.on('finish', () => {
      const path = (req.originalUrl || req.url).split('?')[0];
      const status = res.statusCode;
      if (status < 400 && QUIET_PATHS.has(path)) return;
      const durationMs = Math.round(Number(process.hrtime.bigint() - startedAt) / 1e5) / 10;
      const level = status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info';
      access[level]({
        request_id: requestId,
        user_id: req.userId ?? null,
        http: {
          method: req.method,
          path,
          route: req.route?.path ? `${req.baseUrl ?? ''}${req.route.path}` : undefined,
          status,
          duration_ms: durationMs,
          bytes: Number(res.getHeader('content-length')) || 0,
          ip: req.ip
        }
      }, `${req.method} ${path} ${status}`);
    });

    als.run({ request_id: requestId }, next);
  };
}
