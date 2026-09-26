// ============================================================================
//  Observability services: readiness checks, Web Vitals intake, and the
//  browser error-report tunnel. Routes live in routes/observability.js.
// ============================================================================

import fsp from 'node:fs/promises';
import net from 'node:net';
import tls from 'node:tls';
import path from 'node:path';
import {
  WEB_VITAL_NAMES, WEB_VITAL_RATINGS, webVitalMax, recordWebVital, scrubSentryEvent, RELEASE
} from '../lib/telemetry.js';
import { ApiError } from '../lib/httpUtils.js';

// --- readiness ---------------------------------------------------------------

const MB = 1024 * 1024;

/**
 * Free space on the filesystem holding `dir`. `critical` flips readiness to
 * 503: below that a SQLite write or an upload is about to fail anyway, and
 * failing readiness is what makes the orchestrator/alerting notice.
 */
export async function checkDisk(dir, {
  minFreeBytes = (Number(process.env.READY_DISK_MIN_FREE_MB) || 256) * MB,
  warnFreeBytes = (Number(process.env.READY_DISK_WARN_FREE_MB) || 1024) * MB
} = {}) {
  try {
    // statfs needs an existing path; walk up to the nearest one.
    let target = path.resolve(dir);
    for (;;) {
      try { await fsp.access(target); break; } catch {
        const parent = path.dirname(target);
        if (parent === target) break;
        target = parent;
      }
    }
    const s = await fsp.statfs(target);
    const free = Number(s.bavail) * Number(s.bsize);
    const total = Number(s.blocks) * Number(s.bsize);
    const status = free < minFreeBytes ? 'critical' : free < warnFreeBytes ? 'low' : 'ok';
    return {
      ok: status !== 'critical',
      status,
      free_bytes: free,
      total_bytes: total,
      used_ratio: total > 0 ? Math.round((1 - free / total) * 1000) / 1000 : null
    };
  } catch (err) {
    // A platform without statfs must not make the instance unready.
    return { ok: true, status: 'unknown', error: err.code ?? err.message };
  }
}

/**
 * PING a Redis/Valkey server named by a redis:// or rediss:// URL, with AUTH
 * when the URL carries credentials. A few lines of RESP instead of a client
 * library: readiness only needs "does it answer".
 */
export function pingRedis(url, { timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    let parsed;
    try { parsed = new URL(url); } catch { resolve({ ok: false, error: 'invalid REDIS_URL' }); return; }
    const secure = parsed.protocol === 'rediss:';
    const host = parsed.hostname || '127.0.0.1';
    const port = Number(parsed.port) || 6379;
    const startedAt = Date.now();
    const resp = (...parts) => `*${parts.length}\r\n${parts.map((p) => `$${Buffer.byteLength(p)}\r\n${p}\r\n`).join('')}`;
    let payload = '';
    const password = decodeURIComponent(parsed.password || '');
    const username = decodeURIComponent(parsed.username || '');
    if (password) payload += username ? resp('AUTH', username, password) : resp('AUTH', password);
    payload += resp('PING');

    const socket = secure
      ? tls.connect({ host, port, servername: host })
      : net.connect({ host, port });
    let buffer = '';
    const finish = (result) => {
      socket.destroy();
      resolve({ ...result, latency_ms: Date.now() - startedAt });
    };
    socket.setTimeout(timeoutMs, () => finish({ ok: false, error: `no response within ${timeoutMs}ms` }));
    socket.once(secure ? 'secureConnect' : 'connect', () => socket.write(payload));
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (/^-/m.test(buffer)) {
        finish({ ok: false, error: buffer.split('\r\n').find((l) => l.startsWith('-')).slice(1, 120) });
      } else if (buffer.includes('+PONG')) {
        finish({ ok: true });
      }
    });
    socket.on('error', (err) => finish({ ok: false, error: err.code ?? err.message }));
  });
}

/**
 * Everything readiness depends on. `dbHealth` comes from db.js; Redis is only
 * checked when REDIS_URL is set; disk is checked where the bytes live (the
 * upload root when storage is local, and the SQLite file's directory).
 */
export async function readinessChecks({ dbHealth, storageRoot, storageBackend, dbPath, isSqlite, env = process.env }) {
  const [database, redis, disk] = await Promise.all([
    dbHealth(),
    env.REDIS_URL ? pingRedis(env.REDIS_URL) : Promise.resolve(null),
    (async () => {
      const dirs = new Set();
      if (storageBackend !== 's3' && storageRoot) dirs.add(storageRoot);
      if (isSqlite && dbPath) dirs.add(path.dirname(dbPath));
      const results = {};
      for (const dir of dirs) results[dir] = await checkDisk(dir);
      return results;
    })()
  ]);

  const diskValues = Object.values(disk);
  const diskOk = diskValues.every((d) => d.ok);
  const checks = {
    database: { ok: Boolean(database.reachable), driver: database.driver },
    ...(redis ? { redis } : {}),
    disk: {
      ok: diskOk,
      // Paths are not echoed: they are an internal detail an anonymous caller
      // does not need. The worst filesystem is reported.
      ...(diskValues.sort((a, b) => (a.free_bytes ?? Infinity) - (b.free_bytes ?? Infinity))[0] ?? { status: 'n/a' })
    }
  };
  const ready = checks.database.ok && (!redis || redis.ok) && diskOk;
  return { ready, database, checks };
}

// --- Web Vitals ------------------------------------------------------------------

/**
 * Validate a beacon of Web Vitals and record it. Shape:
 *   { metrics: [{ name: 'LCP'|'INP'|'CLS'|'FCP'|'TTFB', value: number, rating }] }
 * Values arrive in the browser's units (milliseconds, CLS unitless) and are
 * stored in seconds. Nothing identifying is accepted — no URL, no user agent.
 */
export function ingestVitals(body) {
  const metrics = Array.isArray(body?.metrics) ? body.metrics : (body?.name ? [body] : null);
  if (!metrics || metrics.length === 0 || metrics.length > 10) {
    throw new ApiError('metrics must be an array of 1-10 entries', { code: 'INVALID_VITALS' });
  }
  const accepted = [];
  for (const m of metrics) {
    const name = typeof m?.name === 'string' ? m.name.toUpperCase() : '';
    if (!WEB_VITAL_NAMES.includes(name)) {
      throw new ApiError(`unknown metric ${String(m?.name).slice(0, 20)}`, { code: 'INVALID_VITALS' });
    }
    const raw = Number(m.value);
    const value = name === 'CLS' ? raw : raw / 1000;
    if (!Number.isFinite(raw) || value < 0 || value > webVitalMax(name)) {
      throw new ApiError(`value out of range for ${name}`, { code: 'INVALID_VITALS' });
    }
    const rating = WEB_VITAL_RATINGS.includes(m.rating) ? m.rating : 'unknown';
    accepted.push({ name, value, rating });
  }
  for (const { name, value, rating } of accepted) recordWebVital(name, value, rating);
  return accepted.length;
}

export function clientTelemetryConfig(env = process.env) {
  const rate = Number(env.WEB_VITALS_SAMPLE_RATE);
  const dsn = env.SENTRY_BROWSER_DSN || null;
  return {
    release: RELEASE,
    vitals: {
      enabled: String(env.WEB_VITALS_ENABLED ?? '1') !== '0',
      sample_rate: Number.isFinite(rate) && rate >= 0 && rate <= 1 ? rate : 0.25
    },
    errors: dsn
      ? { dsn, environment: env.SENTRY_ENVIRONMENT || env.NODE_ENV || 'development', tunnel: '/api/telemetry/errors' }
      : null
  };
}

// --- browser error tunnel -----------------------------------------------------------

function parseDsn(dsn) {
  try {
    const u = new URL(dsn);
    const segments = u.pathname.split('/').filter(Boolean);
    const projectId = segments.pop();
    if (!projectId || !u.username) return null;
    const prefix = segments.length ? `/${segments.join('/')}` : '';
    return {
      key: u.username,
      projectId,
      envelopeUrl: `${u.protocol}//${u.host}${prefix}/api/${projectId}/envelope/`
    };
  } catch { return null; }
}

const DROPPED_ITEM_TYPES = new Set(['attachment', 'replay_event', 'replay_recording', 'profile', 'feedback', 'user_report']);

/**
 * Forward a browser Sentry envelope to the configured tracker.
 *
 * Tunnelling keeps the tracker off the page's CSP connect-src and out of
 * ad-blocker lists, and gives the server one more chance to scrub: only
 * envelopes addressed to *our* browser DSN are forwarded, event items are
 * re-scrubbed, and attachment/replay items are dropped.
 */
/** Split a Sentry envelope (header line, then item header + payload pairs). */
export function parseEnvelope(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input ?? ''), 'utf8');
  let pos = 0;
  const readLine = () => {
    const nl = buf.indexOf(0x0a, pos);
    const end = nl === -1 ? buf.length : nl;
    const line = buf.subarray(pos, end).toString('utf8');
    pos = end + 1;
    return line;
  };
  const bad = (what) => new ApiError(`Malformed envelope${what ? ` ${what}` : ''}`, { code: 'BAD_ENVELOPE' });
  let header;
  try { header = JSON.parse(readLine()); } catch { throw bad(); }
  if (!header || typeof header !== 'object') throw bad();
  const items = [];
  while (pos < buf.length) {
    const line = readLine();
    if (!line.trim()) continue;
    let itemHeader;
    try { itemHeader = JSON.parse(line); } catch { throw bad('item'); }
    let payload;
    if (Number.isInteger(itemHeader?.length) && itemHeader.length >= 0) {
      payload = buf.subarray(pos, pos + itemHeader.length);
      pos += itemHeader.length + 1;
    } else {
      payload = Buffer.from(readLine(), 'utf8');
    }
    if (items.length >= 20) throw bad('(too many items)');
    items.push([itemHeader ?? {}, payload]);
  }
  return { header, items };
}

export async function forwardEnvelope(body, { env = process.env, fetchImpl = fetch } = {}) {
  const configured = parseDsn(env.SENTRY_BROWSER_DSN || '');
  if (!configured) throw new ApiError('Error reporting is not configured', { status: 404, code: 'NOT_CONFIGURED' });

  const { header, items } = parseEnvelope(body);
  const target = parseDsn(header.dsn ?? '');
  if (!target || target.key !== configured.key || target.projectId !== configured.projectId) {
    throw new ApiError('Envelope is not addressed to this deployment', { status: 403, code: 'DSN_MISMATCH' });
  }

  const out = [JSON.stringify(header)];
  for (const [itemHeader, raw] of items) {
    if (DROPPED_ITEM_TYPES.has(itemHeader.type)) continue;
    let payload = raw.toString('utf8');
    if (itemHeader.type === 'event') {
      try { payload = JSON.stringify(scrubSentryEvent(JSON.parse(payload))); } catch {
        throw new ApiError('Malformed event', { code: 'BAD_ENVELOPE' });
      }
    }
    // Lengths change after scrubbing; newline-delimited JSON needs none.
    const { length: _length, ...rest } = itemHeader;
    out.push(JSON.stringify(rest), payload.replace(/\n/g, ' '));
  }
  if (out.length === 1) return { forwarded: false };

  const res = await fetchImpl(configured.envelopeUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-sentry-envelope' },
    body: `${out.join('\n')}\n`,
    signal: AbortSignal.timeout(5000)
  });
  return { forwarded: true, status: res.status };
}
