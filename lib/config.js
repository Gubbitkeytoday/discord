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

try {
  process.loadEnvFile?.();
} catch (err) {
  if (err?.code !== 'ENOENT') console.warn('Warning loading .env file:', err.message);
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

    shutdownTimeoutMs: int(env.SHUTDOWN_TIMEOUT_MS, 15_000)
  };

  const errors = [];
  const warnings = [];

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
    if (config.corsOrigins.length === 0) {
      warnings.push(
        'CORS_ORIGIN is unset. Only same-origin requests will work, which is '
        + 'correct when the SPA is served from this process.'
      );
    }
    if (!config.secureCookies) {
      warnings.push(
        'SECURE_COOKIES is off in production. Session cookies will be sent over '
        + 'plain HTTP. Enable it once TLS terminates in front of this server.'
      );
    }
    if (config.publicUrl.startsWith('http://')) {
      warnings.push(`PUBLIC_URL is not HTTPS (${config.publicUrl}).`);
    }
    if (!config.adminToken) {
      warnings.push('ADMIN_TOKEN is unset — maintenance and report triage endpoints are disabled.');
    }
  }

  return { config, errors, warnings };
}

/**
 * Load and apply. Exits non-zero on a fatal misconfiguration, because starting
 * anyway would mean serving an insecure deployment.
 */
export function initConfig(env = process.env) {
  const { config, errors, warnings } = loadConfig(env);

  for (const warning of warnings) console.warn(`⚠️  config: ${warning}`);

  if (errors.length > 0) {
    console.error('\n❌ Refusing to start — configuration is unsafe for production:\n');
    for (const error of errors) console.error(`   • ${error}\n`);
    console.error('   See .env.example and DEPLOYMENT.md.\n');
    process.exit(1);
  }

  return config;
}

export const config = initConfig();
