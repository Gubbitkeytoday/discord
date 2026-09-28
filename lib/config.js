// ============================================================================
//  Configuration, validated once at boot.
//
//  The point of this file is to fail loudly at startup rather than quietly in
//  production. A development default that is harmless locally — a shared signing
//  secret, an open CORS policy, the x-user-id shortcut — becomes a real
//  vulnerability the moment NODE_ENV is production, so those combinations are
//  refused outright instead of warned about.
// ============================================================================

const DEV_SECRETS = new Set([
  'dev-insecure-storage-secret',
  'change-me',
  'secret',
  ''
]);

function bool(value, fallback = false) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function list(value, fallback = []) {
  if (!value) return fallback;
  return String(value).split(',').map((v) => v.trim()).filter(Boolean);
}

if (!process.env.NODE_TEST_CONTEXT && process.env.NODE_ENV !== 'test') {
  try {
    process.loadEnvFile?.();
  } catch (err) {
    if (err?.code !== 'ENOENT') console.warn('Warning loading .env file:', err.message);
  }
}

export function loadConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const isProduction = nodeEnv === 'production';

  const config = {
    nodeEnv,
    isProduction,
    port: int(env.PORT, 3001),
    host: env.HOST || '0.0.0.0',
    publicUrl: env.PUBLIC_URL || `http://localhost:${int(env.PORT, 3001)}`,

    // Behind a load balancer or reverse proxy, req.ip must come from
    // X-Forwarded-For or every rate limit keys on the proxy's own address.
    trustProxy: env.TRUST_PROXY ?? (isProduction ? '1' : 'loopback'),

    corsOrigins: list(env.CORS_ORIGIN, isProduction ? [] : ['*']),
    allowDevIdentity: bool(env.ALLOW_DEV_IDENTITY, !isProduction),
    secureCookies: bool(env.SECURE_COOKIES, isProduction),

    storageUrlSecret: env.STORAGE_URL_SECRET || 'dev-insecure-storage-secret',
    adminToken: env.ADMIN_TOKEN || null,

    // Serving the built SPA from this process keeps deployment to one container
    // and removes a whole class of proxy-configuration mistakes.
    serveStatic: bool(env.SERVE_STATIC, isProduction),
    staticDir: env.STATIC_DIR || 'dist',

    logFormat: env.LOG_FORMAT || (isProduction ? 'json' : 'pretty'),
    logLevel: env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),

    // The client prefers the visitor's own browser languages and only falls back
    // to this, so English is the safer default for a public deployment.
    defaultLocale: env.DEFAULT_LOCALE || 'en',
    voiceMeshLimit: int(env.VOICE_MESH_LIMIT, 8),

    enableMetrics: bool(env.ENABLE_METRICS, true),
    metricsToken: env.METRICS_TOKEN || null,

    // console | file | smtp (lib/mailer.js). 'console' only logs, so it is
    // not a way to reach anyone's inbox.
    mailTransport: String(env.MAIL_TRANSPORT || 'console').toLowerCase(),

    shutdownTimeoutMs: int(env.SHUTDOWN_TIMEOUT_MS, 15_000)
  };

  const errors = [];
  const warnings = [];
  // Problems that do not stop the boot but break sign-in for every user, so
  // they are printed as a boxed red banner instead of one more warning line.
  const alerts = [];

  // The most common first-install failure: production defaults
  // SECURE_COOKIES on, the admin opens http://<lan-ip>:3001, and the browser
  // silently drops the Secure session cookie. Sign-up appears to work, every
  // reload lands back on the login screen, and nothing is logged. Browsers only
  // accept Secure cookies over plain http on localhost.
  if (config.secureCookies && /^http:\/\//i.test(config.publicUrl) && !isLoopbackUrl(config.publicUrl)) {
    alerts.push(
      `SECURE_COOKIES is on but PUBLIC_URL is ${config.publicUrl} (plain http).`,
      'Browsers drop Secure cookies on http:// origins other than localhost, so',
      'every sign-in will appear to work and then be forgotten on reload.',
      'Fix one of:',
      '  • put TLS in front (Caddy / nginx / your NAS reverse proxy) and set',
      '    PUBLIC_URL=https://your.domain',
      '  • testing on a LAN without TLS: set SECURE_COOKIES=0 (never on the internet)'
    );
  }

  if (isProduction) {
    if (DEV_SECRETS.has(config.storageUrlSecret)) {
      errors.push(
        'STORAGE_URL_SECRET is still the development default. Signed file URLs '
        + 'would be forgeable by anyone who has read this repository. '
        + 'Generate one with: openssl rand -base64 32'
      );
    }
    if (config.storageUrlSecret.length < 24) {
      errors.push('STORAGE_URL_SECRET must be at least 24 characters in production.');
    }
    if (config.allowDevIdentity) {
      errors.push(
        'ALLOW_DEV_IDENTITY is enabled in production. That lets any request act '
        + 'as any user by sending an x-user-id header. Set ALLOW_DEV_IDENTITY=0.'
      );
    }
    if (config.corsOrigins.includes('*')) {
      errors.push(
        'CORS_ORIGIN=* in production allows any site to call this API with the '
        + "user's cookies. List your origins explicitly."
      );
    }
    // Empty CORS_ORIGIN is the recommended value when this process serves the
    // SPA (same origin, no CORS needed), so it is only worth a warning when the
    // client lives somewhere else.
    if (config.corsOrigins.length === 0 && !config.serveStatic) {
      warnings.push(
        'CORS_ORIGIN is unset and SERVE_STATIC is off. A client served from '
        + 'another origin will be refused; list its origin in CORS_ORIGIN.'
      );
    }
    if (!config.secureCookies) {
      warnings.push(
        'SECURE_COOKIES is off in production. Session cookies will be sent over '
        + 'plain HTTP. Enable it once TLS terminates in front of this server.'
      );
    }
    if (!env.PUBLIC_URL && config.secureCookies) {
      warnings.push(
        `PUBLIC_URL is unset (assuming ${config.publicUrl}). Session cookies are Secure, so `
        + 'opening this server over plain http:// from another machine will sign every user '
        + 'straight back out. Set PUBLIC_URL to your https:// origin, or SECURE_COOKIES=0 for a LAN test.'
      );
    } else if (config.publicUrl.startsWith('http://') && !(config.secureCookies && !isLoopbackUrl(config.publicUrl))) {
      warnings.push(`PUBLIC_URL is not HTTPS (${config.publicUrl}).`);
    }
    if (!config.adminToken) {
      warnings.push('ADMIN_TOKEN is unset — maintenance and report triage endpoints are disabled.');
    }
    if (config.enableMetrics && !config.metricsToken) {
      warnings.push('METRICS_TOKEN is unset — /metrics is not served in production. Set a token to enable it.');
    }
    if (config.mailTransport === 'console') {
      warnings.push(
        'MAIL_TRANSPORT is console (or unset): no e-mail can be delivered, so password reset '
        + 'and e-mail verification are disabled (they answer 503 MAIL_NOT_CONFIGURED). '
        + 'Configure SMTP (MAIL_TRANSPORT=smtp, SMTP_HOST, …) to enable them.'
      );
    }
  }

  return { config, errors, warnings, alerts };
}

/** http://localhost, 127.x, [::1]: origins where browsers keep Secure cookies. */
export function isLoopbackUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || /^127\./.test(host);
  } catch {
    return false;
  }
}

const RED = '\x1b[1;31m';
const RESET = '\x1b[0m';

/** A red box on stderr (colour only on a TTY; JSON log collectors get plain text). */
function printAlert(lines) {
  const colour = process.stderr.isTTY;
  const width = Math.max(...lines.map((l) => l.length)) + 4;
  const bar = '═'.repeat(width);
  const out = [
    `╔${bar}╗`,
    `║  ${'CONFIGURATION PROBLEM — sign-in will not work'.padEnd(width - 2)}║`,
    `╟${'─'.repeat(width)}╢`,
    ...lines.map((l) => `║  ${l.padEnd(width - 2)}║`),
    `╚${bar}╝`
  ].join('\n');
  console.error(colour ? `${RED}${out}${RESET}` : out);
}

/**
 * Load and apply. Exits non-zero on a fatal misconfiguration, because starting
 * anyway would mean serving an insecure deployment.
 */
export function initConfig(env = process.env) {
  const { config, errors, warnings, alerts } = loadConfig(env);

  for (const warning of warnings) console.warn(`⚠️  config: ${warning}`);
  if (alerts.length) printAlert(alerts);

  if (errors.length > 0) {
    console.error('\n❌ Refusing to start — configuration is unsafe for production:\n');
    for (const error of errors) console.error(`   • ${error}\n`);
    console.error('   See .env.example and DEPLOYMENT.md.\n');
    process.exit(1);
  }

  return config;
}

export const config = initConfig();
