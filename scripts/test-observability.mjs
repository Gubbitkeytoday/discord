// ============================================================================
//  Observability: structured logging + redaction, health/readiness, metrics,
//  Web Vitals intake, the browser error tunnel, server error tracking, and
//  "telemetry is off (and costs nothing) unless configured".
// ============================================================================

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';

// This file's name has no digits, which the harness would map to the same port
// as scripts/test.mjs. Pick a slot outside the harness' 0-89 range instead.
process.env.TEST_PORT ??= String(Number(process.env.TEST_PORT_BASE || 3900) + 93);
const { startServer, stopServer, BASE, get } = await import('./testHarness.mjs');

const {
  createLogger, runWithContext, redact, scrubString, isSensitiveKey, REDACTED
} = await import('../lib/logger.js');
const telemetry = await import('../lib/telemetry.js');
const {
  ingestVitals, parseEnvelope, forwardEnvelope, clientTelemetryConfig, checkDisk, pingRedis
} = await import('../services/observability.js');

const run = promisify(execFile);
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

function capture(level = 'debug') {
  const lines = [];
  const log = createLogger({ level, format: 'json', destination: { write: (s) => lines.push(s) } });
  return { log, entries: () => lines.map((l) => JSON.parse(l)) };
}

async function freePort() {
  return new Promise((resolve) => {
    const probe = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// --- logger ---------------------------------------------------------------------

describe('logger redaction', () => {
  test('sensitive keys are redacted at any depth', () => {
    const { log, entries } = capture();
    log.info({
      password: 'hunter2',
      user: { email: 'alice@example.com', profile: { accessToken: 'abc', display_name: 'Alice' } },
      headers: { authorization: 'Bearer abcdefghijkl', cookie: 'sid=1', 'user-agent': 'x' },
      message: { content: 'my private message', id: '42' },
      new_password: 'x', client_secret: 'y', 'X-Api-Key': 'z', totp: '123456'
    }, 'login');
    const [e] = entries();
    assert.equal(e.password, REDACTED);
    assert.equal(e.user.email, REDACTED);
    assert.equal(e.user.profile.accessToken, REDACTED);
    assert.equal(e.user.profile.display_name, 'Alice');
    assert.equal(e.headers.authorization, REDACTED);
    assert.equal(e.headers.cookie, REDACTED);
    assert.equal(e.headers['user-agent'], 'x');
    assert.equal(e.message.content, REDACTED);
    assert.equal(e.message.id, '42');
    for (const k of ['new_password', 'client_secret', 'X-Api-Key', 'totp']) assert.equal(e[k], REDACTED, k);
  });

  test('strings are scrubbed: emails, bearer tokens, URL credentials, token params, JWTs', () => {
    const { log, entries } = capture();
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJlLXZhbHVl';
    log.warn({ url: 'postgres://app:s3cret@db:5432/app', link: '/reset?token=abcdef123&x=1' },
      `mail bob@example.org with Bearer abcdefghijklmnop and ${jwt}`);
    const [e] = entries();
    assert.doesNotMatch(JSON.stringify(e), /bob@example\.org|abcdefghijklmnop|s3cret|abcdef123|eyJhbGci/);
    assert.match(e.msg, /\[EMAIL\]/);
    assert.match(e.url, /postgres:\/\/\[REDACTED\]@db/);
    assert.match(e.link, /token=\[REDACTED\]&x=1/);
  });

  test('errors are serialized with scrubbed message and stack', () => {
    const { log, entries } = capture();
    log.error({ err: new Error('no user carol@example.com') }, 'lookup failed');
    log.error(new Error('direct dave@example.com'));
    const [a, b] = entries();
    assert.equal(a.err.type, 'Error');
    assert.equal(a.err.message, 'no user [EMAIL]');
    assert.doesNotMatch(a.err.stack, /carol@/);
    assert.equal(b.msg, 'direct [EMAIL]');
    assert.doesNotMatch(JSON.stringify(b), /dave@/);
  });

  test('printf-style arguments are scrubbed too', () => {
    const { log, entries } = capture();
    log.info('user %s signed in', 'erin@example.com');
    assert.equal(entries()[0].msg, 'user [EMAIL] signed in');
  });

  test('request context propagates through async calls', async () => {
    const { log, entries } = capture();
    await runWithContext({ request_id: 'req-12345678' }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      log.info('inside');
    });
    log.info('outside');
    const [inside, outside] = entries();
    assert.equal(inside.request_id, 'req-12345678');
    assert.equal(outside.request_id, undefined);
  });

  test('LOG_LEVEL threshold is respected', () => {
    const { log, entries } = capture('warn');
    log.debug('d'); log.info('i'); log.warn('w'); log.error('e');
    assert.deepEqual(entries().map((e) => e.level), ['warn', 'error']);
  });

  test('redact() is bounded and cycle-safe', () => {
    const a = { name: 'x' };
    a.self = a;
    assert.equal(redact(a).self, '[Circular]');
    let deep = {};
    const root = deep;
    for (let i = 0; i < 20; i++) { deep.next = {}; deep = deep.next; }
    assert.doesNotThrow(() => JSON.stringify(redact(root)));
    assert.equal(isSensitiveKey('session_id'), true);
    assert.equal(isSensitiveKey('code'), false);
    assert.equal(scrubString('ok'), 'ok');
  });
});

// --- telemetry units ------------------------------------------------------------

describe('telemetry helpers', () => {
  test('OpenTelemetry is off unless an OTLP endpoint is configured', () => {
    assert.equal(telemetry.otelConfigured({}), false);
    assert.equal(telemetry.otelConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318' }), true);
    assert.equal(telemetry.otelConfigured({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318', OTEL_SDK_DISABLED: 'true' }), false);
    assert.equal(telemetry.tracingActive(), false);
  });

  test('with tracing off the wrappers call straight through', async () => {
    let calls = 0;
    const handler = function (x) { calls += 1; return x * 2; };
    const wrapped = telemetry.wrapSocketHandler('probe_event', handler);
    assert.equal(wrapped(21), 42);
    assert.equal(calls, 1);
    assert.equal(await telemetry.traceDb('sqlite', 'get', 'SELECT 1', async () => 'row'), 'row');
    await assert.rejects(telemetry.traceDb('sqlite', 'run', 'x', async () => { throw new Error('nope'); }), /nope/);
  });

  test('the preload loads no OpenTelemetry SDK when disabled', async () => {
    const env = { ...process.env };
    delete env.OTEL_EXPORTER_OTLP_ENDPOINT;
    delete env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
    delete env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
    delete env.NODE_TEST_CONTEXT;
    const script = `
      const { createRequire } = await import('node:module');
      const require = createRequire(import.meta.url);
      await import('./lib/telemetry.js');
      // (@opentelemetry/api itself is a no-op facade prom-client may load.)
      const loaded = Object.keys(require.cache).filter((k) => /@opentelemetry[\\/](sdk|instrumentation|exporter|resources)|import-in-the-middle|@sentry/.test(k));
      console.log(JSON.stringify({ loaded: loaded.length }));`;
    const { stdout } = await run(process.execPath,
      ['--import', './lib/otel-preload.mjs', '--input-type=module', '-e', script],
      { cwd: repo, env: { ...env, LOG_LEVEL: 'silent' } });
    assert.deepEqual(JSON.parse(stdout.trim().split('\n').pop()), { loaded: 0 });
  });

  test('sanitizeSql drops literals and never includes parameters', () => {
    const s = telemetry.sanitizeSql(`SELECT * FROM users  WHERE email = 'a@b.c' AND age > 42 -- note\n AND id = ?`);
    assert.equal(s, 'SELECT * FROM users WHERE email = ? AND age > ? AND id = ?');
  });

  test('mergeExposition keeps one family per metric name', () => {
    const legacy = [
      '# HELP process_resident_memory_bytes Resident set size', '# TYPE process_resident_memory_bytes gauge',
      'process_resident_memory_bytes 1',
      '# HELP app_uploads_total Files stored', '# TYPE app_uploads_total counter', 'app_uploads_total 3'
    ].join('\n');
    const prom = '# HELP process_resident_memory_bytes RSS\n# TYPE process_resident_memory_bytes gauge\nprocess_resident_memory_bytes 2\n';
    const merged = telemetry.mergeExposition(legacy, prom);
    assert.equal(merged.match(/^# TYPE process_resident_memory_bytes/gm).length, 1);
    assert.match(merged, /^process_resident_memory_bytes 2$/m);
    assert.match(merged, /^app_uploads_total 3$/m);
  });

  test('scrubSentryEvent removes cookies, headers, bodies and personal user fields', () => {
    const event = telemetry.scrubSentryEvent({
      message: 'failed for frank@example.com',
      request: {
        method: 'POST', url: 'https://x/api/auth/reset?token=abc123456',
        headers: { Cookie: 'sid=1', Authorization: 'Bearer abcdefghijkl', 'User-Agent': 'UA' },
        cookies: { sid: '1' }, data: { password: 'p' }, query_string: 'token=abc'
      },
      user: { id: 'u1', email: 'frank@example.com', ip_address: '1.2.3.4', username: 'frank' },
      exception: { values: [{ value: 'boom frank@example.com', stacktrace: { frames: [{ vars: { password: 'p' } }] } }] },
      extra: { token: 'x', ok: 1 },
      breadcrumbs: [{ message: 'GET /?token=abcdef12', data: { email: 'a@b.co' } }],
      server_name: 'host-1'
    });
    const text = JSON.stringify(event);
    assert.doesNotMatch(text, /frank@|sid=1|abcdefghijkl|abc123456|1\.2\.3\.4|"password":"p"|host-1/);
    assert.deepEqual(event.user, { id: 'u1' });
    assert.deepEqual(Object.keys(event.request).sort(), ['headers', 'method', 'url']);
    assert.equal(event.request.headers['User-Agent'], 'UA');
    assert.equal(event.extra.ok, 1);
  });
});

describe('web vitals validation', () => {
  test('accepts well-formed metrics and converts milliseconds to seconds', () => {
    assert.equal(ingestVitals({ metrics: [
      { name: 'LCP', value: 2100, rating: 'good' },
      { name: 'INP', value: 180, rating: 'good' },
      { name: 'CLS', value: 0.03, rating: 'good' }
    ] }), 3);
    assert.equal(ingestVitals({ name: 'ttfb', value: 300, rating: 'weird' }), 1);
  });

  test('rejects unknown names, bad values and oversized batches', () => {
    const bad = [
      {},
      { metrics: [] },
      { metrics: Array.from({ length: 11 }, () => ({ name: 'LCP', value: 1 })) },
      { metrics: [{ name: 'FID', value: 10 }] },
      { metrics: [{ name: 'LCP', value: -1 }] },
      { metrics: [{ name: 'LCP', value: 'NaN' }] },
      { metrics: [{ name: 'LCP', value: 10 * 60 * 1000 }] },
      { metrics: [{ name: 'CLS', value: 1e6 }] },
      { metrics: [{ name: { toUpperCase: 1 }, value: 1 }] }
    ];
    for (const body of bad) {
      assert.throws(() => ingestVitals(body), (err) => err.status === 400 && err.code === 'INVALID_VITALS', JSON.stringify(body));
    }
  });

  test('client config exposes a browser DSN only when one is configured', () => {
    assert.equal(clientTelemetryConfig({}).errors, null);
    assert.equal(clientTelemetryConfig({}).vitals.sample_rate, 0.25);
    assert.equal(clientTelemetryConfig({ WEB_VITALS_SAMPLE_RATE: '7' }).vitals.sample_rate, 0.25);
    const cfg = clientTelemetryConfig({ SENTRY_BROWSER_DSN: 'https://pub@errors.example/3', SENTRY_DSN: 'https://secret@x/1' });
    assert.equal(cfg.errors.dsn, 'https://pub@errors.example/3');
    assert.doesNotMatch(JSON.stringify(cfg), /secret/);
  });
});

describe('browser error tunnel', () => {
  const DSN = 'https://pubkey@glitchtip.example/7';
  const envelope = (dsn, items) => [JSON.stringify({ dsn, sent_at: new Date().toISOString() }), ...items].join('\n');

  test('parses items with and without explicit lengths', () => {
    const bin = 'line1\nline2';
    const { header, items } = parseEnvelope(envelope(DSN, [
      JSON.stringify({ type: 'attachment', length: Buffer.byteLength(bin) }), bin,
      JSON.stringify({ type: 'event' }), JSON.stringify({ message: 'x' })
    ]));
    assert.equal(header.dsn, DSN);
    assert.deepEqual(items.map(([h]) => h.type), ['attachment', 'event']);
    assert.equal(items[0][1].toString(), bin);
  });

  test('refuses envelopes for another project and malformed input', async () => {
    const env = { SENTRY_BROWSER_DSN: DSN };
    await assert.rejects(forwardEnvelope(envelope('https://other@glitchtip.example/7', []), { env }), (e) => e.status === 403);
    await assert.rejects(forwardEnvelope(envelope('https://pubkey@glitchtip.example/8', []), { env }), (e) => e.status === 403);
    await assert.rejects(forwardEnvelope('not json', { env }), (e) => e.status === 400);
    await assert.rejects(forwardEnvelope(envelope(DSN, []), { env: {} }), (e) => e.status === 404);
  });

  test('forwards scrubbed events and drops attachments and replays', async () => {
    let sent = null;
    const fetchImpl = async (url, init) => { sent = { url, body: init.body }; return { status: 200 }; };
    const result = await forwardEnvelope(envelope(DSN, [
      JSON.stringify({ type: 'event' }),
      JSON.stringify({ message: 'oops grace@example.com', user: { id: 'u9', email: 'grace@example.com' }, request: { url: 'https://x/?token=zzzzzzzz', headers: { Cookie: 'a' } } }),
      JSON.stringify({ type: 'replay_recording', length: 3 }), 'abc',
      JSON.stringify({ type: 'attachment', length: 4 }), 'data'
    ]), { env: { SENTRY_BROWSER_DSN: DSN }, fetchImpl });
    assert.equal(result.forwarded, true);
    assert.equal(sent.url, 'https://glitchtip.example/api/7/envelope/');
    assert.doesNotMatch(sent.body, /grace@|zzzzzzzz|Cookie|replay_recording|attachment/);
    const lines = sent.body.trim().split('\n');
    assert.equal(lines.length, 3);
    assert.deepEqual(JSON.parse(lines[2]).user, { id: 'u9' });
  });
});

describe('readiness probes (units)', () => {
  test('disk check reports free space and flips below the threshold', async () => {
    const ok = await checkDisk(os.tmpdir(), { minFreeBytes: 1, warnFreeBytes: 2 });
    assert.equal(ok.ok, true);
    assert.ok(ok.free_bytes > 0);
    const full = await checkDisk(path.join(os.tmpdir(), 'does', 'not', 'exist'), { minFreeBytes: Number.MAX_SAFE_INTEGER });
    assert.equal(full.ok, false);
    assert.equal(full.status, 'critical');
  });

  test('redis ping: PONG, AUTH error, and connection refused', async () => {
    const server = net.createServer((sock) => {
      let buf = '';
      sock.on('data', (d) => {
        buf += d;
        if (buf.includes('AUTH') && buf.includes('wrong')) sock.write('-WRONGPASS invalid username-password pair\r\n');
        else if (buf.includes('AUTH') && buf.includes('PING')) sock.write('+OK\r\n+PONG\r\n');
        else if (buf.includes('PING')) sock.write('+PONG\r\n');
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    try {
      assert.equal((await pingRedis(`redis://127.0.0.1:${port}`)).ok, true);
      assert.equal((await pingRedis(`redis://:good@127.0.0.1:${port}`)).ok, true);
      const denied = await pingRedis(`redis://:wrong@127.0.0.1:${port}`);
      assert.equal(denied.ok, false);
      assert.match(denied.error, /WRONGPASS/);
    } finally {
      server.close();
    }
    const refused = await pingRedis(`redis://127.0.0.1:${await freePort()}`, { timeoutMs: 1000 });
    assert.equal(refused.ok, false);
  });
});

// --- against the harness server ------------------------------------------------------
//
// One server for all integration tests (the suite runs files in parallel, so
// every extra server process slows the others). It is started with a real
// Redis/Valkey when one is on PATH (REDIS_URL also switches the realtime layer
// to cluster mode, so a fake server will not do; the Redis tests are skipped
// without one), a fake error tracker behind SENTRY_BROWSER_DSN, and a small
// vitals rate limit.

const redisBin = spawnSync('sh', ['-c', 'command -v valkey-server || command -v redis-server'])
  .stdout?.toString().trim() || '';
const redisSkip = redisBin ? false : 'needs redis-server/valkey-server on PATH';

describe('observability endpoints', () => {
  let redis = null;
  let redisPort = 0;
  let tracker;

  async function startRedis() {
    redis = spawn(redisBin, ['--port', String(redisPort), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
    const deadline = Date.now() + 10_000;
    while (!(await pingRedis(`redis://127.0.0.1:${redisPort}`, { timeoutMs: 300 })).ok) {
      if (Date.now() > deadline) throw new Error('redis-server did not start');
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  async function stopRedis() {
    if (!redis || redis.exitCode !== null || redis.signalCode !== null) return;
    const exited = new Promise((r) => redis.once('exit', r));
    redis.kill();
    await exited;
  }
  const received = [];

  before(async () => {
    let redisEnv = {};
    if (redisBin) {
      redisPort = await freePort();
      await startRedis();
      redisEnv = { REDIS_URL: `redis://127.0.0.1:${redisPort}`, REDIS_KEY_PREFIX: `agobs${process.pid}:` };
    }
    tracker = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => { received.push({ url: req.url, body }); res.writeHead(200); res.end('{}'); });
    });
    await new Promise((r) => tracker.listen(0, '127.0.0.1', r));
    Object.assign(process.env, {
      ...redisEnv,
      SENTRY_BROWSER_DSN: `http://pubkey@127.0.0.1:${tracker.address().port}/5`,
      RATE_LIMIT_VITALS_PER_MIN: '8',
      WEB_VITALS_SAMPLE_RATE: '1'
    });
    await startServer();
  });

  after(async () => {
    await stopServer();
    for (const key of ['REDIS_URL', 'REDIS_KEY_PREFIX', 'SENTRY_BROWSER_DSN', 'RATE_LIMIT_VITALS_PER_MIN', 'WEB_VITALS_SAMPLE_RATE']) delete process.env[key];
    await stopRedis();
    tracker?.close();
  });

  test('/api/live answers without touching the database', async () => {
    const { status, body } = await get('/api/live');
    assert.equal(status, 200);
    assert.equal(body.status, 'alive');
  });

  test('/api/ready reports database, Redis and disk checks', async () => {
    const { status, body } = await get('/api/ready');
    assert.equal(status, 200, JSON.stringify(body));
    assert.equal(body.status, 'ready');
    assert.equal(body.checks.database.ok, true);
    if (redis) assert.equal(body.checks.redis.ok, true);
    else assert.equal(body.checks.redis, undefined, 'no Redis check without REDIS_URL');
    assert.equal(body.checks.realtime.ok, true, 'realtime layer gates readiness too');
    assert.equal(body.checks.realtime.mode, redis ? 'cluster' : 'single');
    assert.equal(body.checks.disk.ok, true);
    assert.equal(typeof body.checks.disk.free_bytes, 'number');
    assert.equal(body.database.reachable, true);
    assert.ok('requests_total' in body, 'keeps the metrics snapshot it always had');
  });

  test('readiness fails (503) when Redis goes away; liveness and health do not', { skip: redisSkip }, async () => {
    await stopRedis();
    try {
      // Give the app's Redis client a moment to notice the closed connection.
      await new Promise((r) => setTimeout(r, 300));
      const res = await fetch(`${BASE}/api/ready`);
      assert.equal(res.status, 503);
      const body = await res.json();
      assert.equal(body.status, 'not_ready');
      assert.equal(body.checks.database.ok, true);
      assert.equal(body.checks.redis.ok, false);
      assert.match(body.checks.redis.error, /ECONNREFUSED|no response/);
      assert.equal(body.checks.realtime.ok, false, 'the adapter lost Redis too');
      assert.equal((await fetch(`${BASE}/api/live`)).status, 200);
      assert.equal((await fetch(`${BASE}/api/health`)).status, 200);
    } finally {
      await startRedis();
    }
    // The client reconnects with a back-off of up to 5 s.
    const deadline = Date.now() + 15_000;
    let status;
    do {
      status = (await fetch(`${BASE}/api/ready`)).status;
      if (status === 200) break;
      await new Promise((r) => setTimeout(r, 250));
    } while (Date.now() < deadline);
    assert.equal(status, 200);
  });

  test('/api/health keeps its shape', async () => {
    const { status, body } = await get('/api/health');
    assert.equal(status, 200);
    for (const key of ['status', 'database', 'schema_version', 'code_schema_version', 'storage_root', 'uptime_seconds', 'connected_sockets']) {
      assert.ok(key in body, key);
    }
  });

  test('X-Request-Id: a well-formed inbound id is kept, junk is replaced', async () => {
    const good = await fetch(`${BASE}/api/live`, { headers: { 'X-Request-Id': 'trace-abc-12345' } });
    assert.equal(good.headers.get('x-request-id'), 'trace-abc-12345');
    const junk = await fetch(`${BASE}/api/live`, { headers: { 'X-Request-Id': 'bad id with spaces\tand tabs' } });
    assert.match(junk.headers.get('x-request-id'), /^[0-9a-f-]{36}$/);
  });

  test('vitals beacon: JSON and text/plain bodies accepted, bad input refused', async () => {
    const body = JSON.stringify({ metrics: [{ name: 'LCP', value: 1800, rating: 'good' }, { name: 'CLS', value: 0.2, rating: 'needs-improvement' }] });
    const asJson = await fetch(`${BASE}/api/telemetry/vitals`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    assert.equal(asJson.status, 204);
    const asText = await fetch(`${BASE}/api/telemetry/vitals`, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body });
    assert.equal(asText.status, 204);
    const bad = await fetch(`${BASE}/api/telemetry/vitals`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"metrics":[{"name":"LCP","value":-5}]}' });
    assert.equal(bad.status, 400);
    const notJson = await fetch(`${BASE}/api/telemetry/vitals`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'hello' });
    assert.equal(notJson.status, 400);
    const huge = await fetch(`${BASE}/api/telemetry/vitals`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'x'.repeat(9000) });
    assert.equal(huge.status, 413);
  });

  test('/metrics exposes prom-client and legacy series without duplicate families', async () => {
    const res = await fetch(`${BASE}/metrics`);
    assert.equal(res.status, 200);
    const text = await res.text();
    for (const name of [
      'app_requests_total', 'app_messages_sent_total', 'app_http_request_duration_seconds_bucket',
      'app_db_query_duration_seconds_bucket', 'app_socket_connections', 'app_voice_participants',
      'nodejs_eventloop_lag_seconds', 'process_resident_memory_bytes', 'app_web_vitals_lcp_seconds_count',
      'app_web_vitals_cls_count', 'app_disk_free_bytes{volume="storage"}', 'app_db_inflight_queries'
    ]) {
      assert.match(text, new RegExp(`^${name}`, 'm'), name);
    }
    const types = text.match(/^# TYPE (\S+)/gm);
    assert.equal(new Set(types).size, types.length, 'every metric family appears once');
    assert.match(text, /app_web_vitals_lcp_seconds_count\{rating="good"\} [1-9]/);
    assert.match(text, /app_http_request_duration_seconds_count\{method="GET",route="\/api\/live",status_code="200"\}/);
  });

  test('vitals endpoint is rate limited per IP', async () => {
    const body = JSON.stringify({ metrics: [{ name: 'INP', value: 120, rating: 'good' }] });
    const statuses = [];
    for (let i = 0; i < 10; i++) {
      statuses.push((await fetch(`${BASE}/api/telemetry/vitals`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body })).status);
    }
    // 5 of the 8/min budget were spent above; the rest succeed, then 429.
    assert.ok(statuses.includes(204), statuses.join(','));
    const first429 = statuses.indexOf(429);
    assert.ok(first429 > 0, statuses.join(','));
    assert.ok(statuses.slice(first429).every((s) => s === 429), statuses.join(','));
  });

  test('browser config and tunnel forward scrubbed events to the tracker', async () => {
    const cfg = (await get('/api/telemetry/config')).body;
    assert.equal(cfg.vitals.sample_rate, 1);
    assert.equal(cfg.errors.tunnel, '/api/telemetry/errors');
    assert.equal(typeof cfg.release, 'string');
    const envelope = [
      JSON.stringify({ dsn: cfg.errors.dsn }),
      JSON.stringify({ type: 'event' }),
      JSON.stringify({ message: 'client crash for heidi@example.com', user: { email: 'heidi@example.com', id: 'u1' } })
    ].join('\n');
    const res = await fetch(`${BASE}/api/telemetry/errors`, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body: envelope });
    assert.equal(res.status, 200);
    assert.equal(received.length, 1);
    assert.equal(received[0].url, '/api/5/envelope/');
    assert.doesNotMatch(received[0].body, /heidi@/);
    const forged = [JSON.stringify({ dsn: 'http://attacker@127.0.0.1:1/5' }), JSON.stringify({ type: 'event' }), '{}'].join('\n');
    assert.equal((await fetch(`${BASE}/api/telemetry/errors`, { method: 'POST', body: forged })).status, 403);
  });
});

// --- server-side error tracking (a short child process) ----------------------------------

describe('server error tracking', () => {
  test('server errors reach the tracker (SENTRY_DSN) with PII scrubbed', async () => {
    const got = [];
    const tracker = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => { got.push(Buffer.concat(chunks).toString()); res.writeHead(200); res.end('{}'); });
    });
    await new Promise((r) => tracker.listen(0, '127.0.0.1', r));
    const dsn = `http://abc@127.0.0.1:${tracker.address().port}/9`;
    const script = `
      const t = await import('./lib/telemetry.js');
      await t.initErrorTracking();
      t.reportError(new Error('db failed for ivan@example.com'), { req: { requestId: 'rid-123456', method: 'GET', userId: 'u42', route: { path: '/x' }, baseUrl: '/api' } });
      await t.flushErrors(3000);
      process.exit(0);`;
    const env = { ...process.env, SENTRY_DSN: dsn, LOG_LEVEL: 'silent' };
    delete env.NODE_TEST_CONTEXT;
    try {
      await run(process.execPath, ['--input-type=module', '-e', script], { cwd: repo, env });
      assert.ok(got.length >= 1, 'an envelope was sent');
      const body = got.join('\n');
      assert.match(body, /db failed for \[EMAIL\]/);
      assert.doesNotMatch(body, /ivan@example\.com/);
      assert.match(body, /"request_id":"rid-123456"/);
      assert.match(body, /"user":\{"id":"u42"\}/);
    } finally {
      tracker.close();
    }
  });
});
