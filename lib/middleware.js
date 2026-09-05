// ============================================================================
//  Production middleware: security headers, request logging, metrics.
//
//  Written directly rather than pulling in helmet/morgan/prom-client — each is
//  a small, well-understood policy, and having them here means the exact header
//  set is visible and testable instead of hidden behind defaults.
// ============================================================================

import crypto from 'crypto';

/**
 * Security headers.
 *
 * The CSP is deliberately strict, with two documented exceptions: the app is a
 * Vite bundle that inlines a small module preload script, and Tailwind emits a
 * style element at runtime — so 'unsafe-inline' is required for styles and a
 * nonce would have to be threaded through the HTML template to remove it for
 * scripts. Everything else is locked to 'self'.
 */
export function securityHeaders({ isProduction, publicUrl }) {
  const connectSources = ["'self'", 'ws:', 'wss:'];
  if (publicUrl) {
    try { connectSources.push(new URL(publicUrl).origin); } catch { /* ignore */ }
  }

  const policy = [
    "default-src 'self'",
    // Avatars and emoji in the seed data come from Unsplash and dicebear; user
    // uploads are same-origin or on the configured S3 host.
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob: https:",
    "font-src 'self' https://fonts.gstatic.com data:",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    `script-src 'self'${isProduction ? '' : " 'unsafe-inline' 'unsafe-eval'"}`,
    `connect-src ${connectSources.join(' ')}`,
    "frame-ancestors 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'"
  ].join('; ');

  return (req, res, next) => {
    // Uploaded files get their own, much stricter policy in the storage routes;
    // do not override it here.
    if (req.path.startsWith('/uploads') || req.path.startsWith('/api/files/')) {
      return next();
    }

    res.setHeader('Content-Security-Policy', policy);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Permissions-Policy',
      'camera=(self), microphone=(self), display-capture=(self), geolocation=()');
    // Do not advertise the stack.
    res.removeHeader('X-Powered-By');

    if (isProduction) {
      // Two years, subdomains included, and preload-eligible. Only meaningful
      // over HTTPS, which is why it is production-only.
      res.setHeader('Strict-Transport-Security',
        'max-age=63072000; includeSubDomains; preload');
    }
    return next();
  };
}

/**
 * Structured request logging with a correlation id.
 *
 * JSON in production so a log aggregator can index it; a compact human line in
 * development. The id is echoed in the response header so a user-reported
 * failure can be found in the logs.
 */
export function requestLogger({ format = 'pretty', level = 'info' }) {
  const levels = { error: 0, warn: 1, info: 2, debug: 3 };
  const threshold = levels[level] ?? 2;

  return (req, res, next) => {
    const requestId = req.get('x-request-id') || crypto.randomUUID();
    req.requestId = requestId;
    res.setHeader('X-Request-Id', requestId);

    const startedAt = process.hrtime.bigint();

    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const entry = {
        level: res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info',
        time: new Date().toISOString(),
        request_id: requestId,
        method: req.method,
        path: req.originalUrl.split('?')[0],
        status: res.statusCode,
        duration_ms: Math.round(durationMs * 10) / 10,
        user_id: req.userId ?? null,
        ip: req.ip,
        bytes: Number(res.getHeader('content-length')) || 0
      };

      if ((levels[entry.level] ?? 2) > threshold) return;

      // Health checks and metrics scrapes would otherwise dominate the log.
      if (entry.status < 400 && ['/api/health', '/api/ready', '/metrics'].includes(entry.path)) {
        return;
      }

      if (format === 'json') {
        console.log(JSON.stringify(entry));
      } else {
        const colour = entry.status >= 500 ? '\x1b[31m'
          : entry.status >= 400 ? '\x1b[33m' : '\x1b[32m';
        console.log(
          `${colour}${entry.status}\x1b[0m ${entry.method.padEnd(6)} ${entry.path} `
          + `${entry.duration_ms}ms${entry.user_id ? ` user=${entry.user_id}` : ''}`
        );
      }
    });

    next();
  };
}

// --- metrics ----------------------------------------------------------------

const metrics = {
  startedAt: Date.now(),
  requests: new Map(),      // "METHOD status" -> count
  durations: [],            // recent durations for percentiles
  errors: 0,
  socketConnections: 0,
  messagesSent: 0,
  uploads: 0
};

const MAX_DURATION_SAMPLES = 1000;

export function recordRequest(method, status, durationMs) {
  const key = `${method} ${status}`;
  metrics.requests.set(key, (metrics.requests.get(key) ?? 0) + 1);
  if (status >= 500) metrics.errors += 1;

  metrics.durations.push(durationMs);
  // Bounded sample: an unbounded array is a slow memory leak.
  if (metrics.durations.length > MAX_DURATION_SAMPLES) metrics.durations.shift();
}

export const bumpMetric = (name, amount = 1) => {
  if (name in metrics && typeof metrics[name] === 'number') metrics[name] += amount;
};

export function metricsMiddleware() {
  return (req, res, next) => {
    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      recordRequest(req.method, res.statusCode,
        Number(process.hrtime.bigint() - startedAt) / 1e6);
    });
    next();
  };
}

const percentile = (sorted, p) => {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round(sorted[index] * 10) / 10;
};

/** Prometheus text exposition, so any standard scraper can read it. */
export function renderMetrics(extra = {}) {
  const sorted = [...metrics.durations].sort((a, b) => a - b);
  const memory = process.memoryUsage();
  const lines = [];

  const push = (name, help, type, value, labels = '') => {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} ${type}`);
    lines.push(`${name}${labels} ${value}`);
  };

  push('app_uptime_seconds', 'Process uptime', 'gauge',
    Math.round((Date.now() - metrics.startedAt) / 1000));
  push('app_requests_total', 'HTTP requests by method and status', 'counter', '');
  lines.pop();
  for (const [key, count] of metrics.requests) {
    const [method, status] = key.split(' ');
    lines.push(`app_requests_total{method="${method}",status="${status}"} ${count}`);
  }
  push('app_request_errors_total', 'Responses with status >= 500', 'counter', metrics.errors);
  push('app_request_duration_ms_p50', 'Median request duration', 'gauge', percentile(sorted, 50));
  push('app_request_duration_ms_p95', '95th percentile request duration', 'gauge', percentile(sorted, 95));
  push('app_request_duration_ms_p99', '99th percentile request duration', 'gauge', percentile(sorted, 99));
  push('app_socket_connections', 'Connected websocket clients', 'gauge',
    extra.socketConnections ?? metrics.socketConnections);
  push('app_messages_sent_total', 'Chat messages created', 'counter', metrics.messagesSent);
  push('app_uploads_total', 'Files stored', 'counter', metrics.uploads);
  push('process_resident_memory_bytes', 'Resident set size', 'gauge', memory.rss);
  push('process_heap_used_bytes', 'Heap in use', 'gauge', memory.heapUsed);

  for (const [name, value] of Object.entries(extra)) {
    if (typeof value === 'number' && name !== 'socketConnections') {
      push(`app_${name}`, name, 'gauge', value);
    }
  }

  return `${lines.join('\n')}\n`;
}

export function metricsSnapshot() {
  const sorted = [...metrics.durations].sort((a, b) => a - b);
  return {
    uptime_seconds: Math.round((Date.now() - metrics.startedAt) / 1000),
    requests_total: [...metrics.requests.values()].reduce((a, b) => a + b, 0),
    errors_total: metrics.errors,
    p50_ms: percentile(sorted, 50),
    p95_ms: percentile(sorted, 95),
    p99_ms: percentile(sorted, 99),
    messages_sent: metrics.messagesSent,
    uploads: metrics.uploads
  };
}
