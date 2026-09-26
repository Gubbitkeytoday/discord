// ============================================================================
//  Client telemetry: Core Web Vitals and (optional) error reporting.
//
//  Imported once from main.jsx for its side effect. Nothing here runs before
//  the browser is idle, and nothing heavy is downloaded unless the server says
//  it is wanted (GET /api/telemetry/config):
//
//   * Web Vitals (LCP, INP, CLS, FCP, TTFB) for a sampled share of page loads,
//     sent as ONE beacon when the page is hidden. Only the metric name, value
//     and rating leave the browser — no URL, no user id, no user agent.
//   * Error reports through @sentry/browser (loaded lazily) only when the
//     operator set SENTRY_BROWSER_DSN. Events go through our own server
//     (/api/telemetry/errors), which re-scrubs them; PII is removed here first.
// ============================================================================

const CONFIG_URL = '/api/telemetry/config';
const VITALS_URL = '/api/telemetry/vitals';

let sentry = null;
const early = [];          // errors seen before the reporter loaded (bounded)

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const TOKEN_PARAM = /([?&#](?:access_token|token|code|key|signature|password|t)=)[^&#\s]+/gi;
const BEARER = /\b(Bearer|Bot)\s+[A-Za-z0-9._~+/=-]{8,}/g;

export function scrub(text) {
  return String(text ?? '')
    .replace(EMAIL, '[EMAIL]')
    .replace(TOKEN_PARAM, '$1[REDACTED]')
    .replace(BEARER, '$1 [REDACTED]');
}

function scrubEvent(event) {
  if (event.request) {
    event.request = { url: event.request.url ? scrub(event.request.url.split('?')[0]) : undefined };
  }
  if (event.user) event.user = event.user.id ? { id: String(event.user.id) } : undefined;
  if (event.message) event.message = scrub(event.message);
  for (const ex of event.exception?.values ?? []) {
    if (ex.value) ex.value = scrub(ex.value);
  }
  if (Array.isArray(event.breadcrumbs)) {
    event.breadcrumbs = event.breadcrumbs
      .filter((b) => b.category !== 'console' && b.category !== 'ui.input')
      .map((b) => ({
        ...b,
        message: b.message ? scrub(b.message) : b.message,
        data: b.data?.url ? { ...b.data, url: scrub(String(b.data.url).split('?')[0]) } : undefined
      }));
  }
  return event;
}

/** Report an error (used by error boundaries). Safe to call at any time. */
export function captureException(error) {
  if (sentry) {
    sentry.captureException(error);
  } else if (early.length < 10) {
    early.push(error);
  }
}

// --- Web Vitals ------------------------------------------------------------------

function startVitals() {
  const queue = [];
  let sent = false;

  const flush = () => {
    if (!queue.length) return;
    const body = JSON.stringify({ metrics: queue.splice(0, 10) });
    try {
      // A string body is sent as text/plain: no CORS preflight, no JSON
      // Content-Type needed; the endpoint accepts both.
      if (!navigator.sendBeacon?.(VITALS_URL, body)) {
        fetch(VITALS_URL, { method: 'POST', body, keepalive: true, credentials: 'same-origin' }).catch(() => {});
      }
    } catch { /* telemetry must never throw */ }
    sent = true;
  };

  const report = (metric) => {
    queue.push({
      name: metric.name,
      value: Math.round(metric.name === 'CLS' ? metric.value * 1e4 : metric.value) / (metric.name === 'CLS' ? 1e4 : 1),
      rating: metric.rating
    });
    // Late reports (INP/CLS finalised after the first hide) go out on the next hide.
    if (sent) setTimeout(flush, 0);
  };

  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
  window.addEventListener('pagehide', flush);

  import('web-vitals').then(({ onLCP, onINP, onCLS, onFCP, onTTFB }) => {
    onLCP(report);
    onINP(report);
    onCLS(report);
    onFCP(report);
    onTTFB(report);
  }).catch(() => {});
}

// --- error reporting ---------------------------------------------------------------

function startErrors(cfg) {
  const remember = (event) => captureException(event.reason ?? event.error ?? new Error(scrub(event.message)));
  window.addEventListener('error', remember);
  window.addEventListener('unhandledrejection', remember);

  import('@sentry/browser').then((Sentry) => {
    Sentry.init({
      dsn: cfg.errors.dsn,
      tunnel: cfg.errors.tunnel,
      release: cfg.release,
      environment: cfg.errors.environment,
      sendDefaultPii: false,
      tracesSampleRate: 0,
      maxBreadcrumbs: 30,
      beforeSend: scrubEvent,
      // No session tracking, replay or feedback widgets: errors only.
      integrations: (defaults) => defaults.filter((i) => !['BrowserSession', 'BrowserTracing', 'Replay', 'Feedback'].includes(i.name))
    });
    window.removeEventListener('error', remember);
    window.removeEventListener('unhandledrejection', remember);
    sentry = Sentry;
    for (const error of early.splice(0)) Sentry.captureException(error);
  }).catch(() => {});
}

// --- boot ---------------------------------------------------------------------------

function start() {
  fetch(CONFIG_URL, { credentials: 'same-origin' })
    .then((r) => (r.ok ? r.json() : null))
    .then((cfg) => {
      if (!cfg) return;
      if (cfg.vitals?.enabled && Math.random() < Number(cfg.vitals.sample_rate ?? 0)) startVitals();
      if (cfg.errors?.dsn) startErrors(cfg);
    })
    .catch(() => {});
}

if (typeof window !== 'undefined' && !window.__agTelemetry) {
  // Error boundaries reach the reporter through this hook without importing it.
  window.__agTelemetry = { captureException };
  if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(start, { timeout: 5000 });
  else setTimeout(start, 2000);
}
