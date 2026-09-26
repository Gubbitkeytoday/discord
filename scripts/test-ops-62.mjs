// ============================================================================
//  Ops polish, unit level (no app server):
//    - lib/staticAssets.js: brotli/gzip for the Node static path, immutable
//      caching for hashed assets, no-cache SPA shell, 304s, no traversal
//    - lib/searchQuery.js: today / yesterday / tomorrow and date hints
//    - lib/config.js: the Secure-cookie-over-http alert, quieter CORS warning
// ============================================================================

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import http from 'node:http';
import express from 'express';

import { staticAssets, negotiateEncoding } from '../lib/staticAssets.js';
import { parseSearchQuery, resolveDateValue } from '../lib/searchQuery.js';

process.env.NODE_ENV = 'test';   // lib/config.js: do not load ./.env
const { loadConfig, isLoopbackUrl } = await import('../lib/config.js');

/** Raw GET (fetch would transparently decompress and hide the encoding). */
function rawGet(port, urlPath, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('static assets: compression and caching', () => {
  let dir;
  let top;
  let server;
  let port;
  const js = `export const big = ${JSON.stringify('lorem ipsum dolor sit amet '.repeat(400))};\n`;
  const html = `<!doctype html><html><head><title>t</title></head><body>${'<div>shell</div>'.repeat(100)}</body></html>`;

  before(async () => {
    // Under a dot-directory on purpose: installs live in places like
    // ~/.local/share/app or .claude/worktrees, and the dotfile guard must only
    // apply inside dist/.
    top = fs.mkdtempSync(path.join(os.tmpdir(), 'ops62-'));
    dir = path.join(top, '.hidden-parent', 'dist');
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.writeFileSync(path.join(dir, 'assets', 'index-B3oiM5lP.js'), js);
    fs.writeFileSync(path.join(dir, 'assets', 'logo-AbCdEf12.png'), Buffer.alloc(4096, 7));
    fs.writeFileSync(path.join(dir, 'index.html'), html);
    fs.writeFileSync(path.join(dir, 'sw.js'), `self.x = ${JSON.stringify('y'.repeat(3000))};`);
    fs.writeFileSync(path.join(dir, 'tiny.txt'), 'hi');
    fs.writeFileSync(path.join(dir, '.env'), 'SECRET=1');
    const app = express();
    app.use(staticAssets({ root: dir }));
    app.use((req, res) => res.status(404).json({ error: 'not found', path: req.path }));
    server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    port = server.address().port;
  });

  after(() => {
    server?.close();
    fs.rmSync(top, { recursive: true, force: true });
  });

  test('negotiation prefers brotli, honours q=0, falls back to gzip or identity', () => {
    assert.equal(negotiateEncoding('gzip, deflate, br, zstd'), 'br');
    assert.equal(negotiateEncoding('gzip, br;q=0'), 'gzip');
    assert.equal(negotiateEncoding('identity'), null);
    assert.equal(negotiateEncoding(''), null);
    assert.equal(negotiateEncoding('*'), 'br');
  });

  test('hashed JS: brotli, immutable, Vary, decodes to the original', async () => {
    const res = await rawGet(port, '/assets/index-B3oiM5lP.js', { 'accept-encoding': 'gzip, deflate, br' });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-encoding'], 'br');
    assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable');
    assert.match(res.headers['content-type'], /javascript/);
    assert.match(res.headers.vary, /Accept-Encoding/i);
    assert.ok(res.body.length < js.length / 5, `compressed ${res.body.length} of ${js.length}`);
    assert.equal(zlib.brotliDecompressSync(res.body).toString(), js);
    assert.equal(Number(res.headers['content-length']), res.body.length);
  });

  test('gzip-only clients get gzip; clients without Accept-Encoding get identity', async () => {
    const gz = await rawGet(port, '/assets/index-B3oiM5lP.js', { 'accept-encoding': 'gzip' });
    assert.equal(gz.headers['content-encoding'], 'gzip');
    assert.equal(zlib.gunzipSync(gz.body).toString(), js);
    const plain = await rawGet(port, '/assets/index-B3oiM5lP.js');
    assert.equal(plain.headers['content-encoding'], undefined);
    assert.equal(plain.body.toString(), js);
    assert.equal(plain.headers['cache-control'], 'public, max-age=31536000, immutable');
  });

  test('a revalidation with the ETag answers 304 without a body', async () => {
    const first = await rawGet(port, '/assets/index-B3oiM5lP.js', { 'accept-encoding': 'br' });
    const again = await rawGet(port, '/assets/index-B3oiM5lP.js', {
      'accept-encoding': 'br', 'if-none-match': first.headers.etag
    });
    assert.equal(again.status, 304);
    assert.equal(again.body.length, 0);
  });

  test('binary assets are not re-compressed but keep immutable caching', async () => {
    const res = await rawGet(port, '/assets/logo-AbCdEf12.png', { 'accept-encoding': 'br' });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-encoding'], undefined);
    assert.equal(res.headers['cache-control'], 'public, max-age=31536000, immutable');
  });

  test('the SPA shell and sw.js are no-cache; client routes get the shell', async () => {
    for (const p of ['/', '/channels/123/456', '/invite/abc']) {
      const res = await rawGet(port, p, { 'accept-encoding': 'br' });
      assert.equal(res.status, 200, p);
      assert.equal(res.headers['cache-control'], 'no-cache', p);
      assert.match(res.headers['content-type'], /text\/html/, p);
      assert.equal(zlib.brotliDecompressSync(res.body).toString(), html, p);
    }
    const sw = await rawGet(port, '/sw.js', { 'accept-encoding': 'gzip' });
    assert.equal(sw.headers['cache-control'], 'no-cache');
    assert.equal(sw.headers['content-encoding'], 'gzip');
  });

  test('HEAD carries the headers without a body', async () => {
    const res = await rawGet(port, '/assets/index-B3oiM5lP.js', { 'accept-encoding': 'br' }, 'HEAD');
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-encoding'], 'br');
    assert.equal(res.body.length, 0);
  });

  test('API, uploads, missing hashed assets, dotfiles and traversal fall through', async () => {
    for (const p of ['/api/nope', '/uploads/x.png', '/socket.io/?EIO=4', '/assets/missing-12345678.js',
      '/.env', '/%2e%2e/%2e%2e/etc/passwd', '/assets/..%2f..%2fpackage.json']) {
      const res = await rawGet(port, p, { 'accept-encoding': 'br' });
      if (p === '/.env' || p.includes('%2e') || p.includes('..')) {
        // Never the file itself: either the shell (client route) or a 404.
        assert.ok(!res.body.toString().includes('SECRET=1'), p);
        assert.ok(!res.body.toString().includes('"name"'), p);
      } else {
        assert.equal(res.status, 404, p);
      }
    }
  });

  test('small files are sent as-is', async () => {
    const res = await rawGet(port, '/tiny.txt', { 'accept-encoding': 'br' });
    assert.equal(res.headers['content-encoding'], undefined);
    assert.equal(res.body.toString(), 'hi');
  });
});

describe('search dates', () => {
  const now = Date.parse('2026-09-26T10:00:00Z');

  test('today, yesterday and tomorrow resolve to calendar days (UTC)', () => {
    assert.equal(parseSearchQuery('before:tomorrow', { now }).filters.before, '2026-09-27');
    assert.equal(parseSearchQuery('during:today', { now }).filters.during, '2026-09-26');
    assert.equal(parseSearchQuery('after:yesterday', { now }).filters.after, '2026-09-25');
    assert.equal(parseSearchQuery('during:Yesterday', { now }).filters.during, '2026-09-25');
    // Month boundary.
    assert.equal(resolveDateValue('tomorrow', { now: Date.parse('2026-09-30T23:00:00Z') }), '2026-10-01');
  });

  test('an unparsable date is reported with a hint and not silently dropped', () => {
    const parsed = parseSearchQuery('before:someday deploy', { now });
    assert.equal(parsed.filters.before, null);
    assert.equal(parsed.term, 'before:someday deploy');
    assert.equal(parsed.warnings.length, 1);
    assert.equal(parsed.warnings[0].code, 'INVALID_DATE');
    assert.equal(parsed.warnings[0].operator, 'before');
    assert.match(parsed.warnings[0].message, /someday/);
    assert.match(parsed.warnings[0].message, /today, yesterday or tomorrow/);
  });

  test('impossible calendar dates are rejected; months and years still work for during:', () => {
    assert.equal(parseSearchQuery('before:2026-02-30', { now }).warnings[0].code, 'INVALID_DATE');
    assert.equal(parseSearchQuery('during:2026-02-30', { now }).warnings[0].code, 'INVALID_DATE');
    assert.equal(parseSearchQuery('during:2026-09', { now }).filters.during, '2026-09');
    assert.equal(parseSearchQuery('during:2026', { now }).filters.during, '2026');
    assert.deepEqual(parseSearchQuery('after:2024-02-29', { now }).warnings, []);
  });
});

describe('config: HTTPS / Secure-cookie footgun', () => {
  const prod = { NODE_ENV: 'production', STORAGE_URL_SECRET: 'x'.repeat(40), ALLOW_DEV_IDENTITY: '0' };

  test('Secure cookies with a plain-http LAN PUBLIC_URL raise the boot alert', () => {
    const { alerts, errors } = loadConfig({ ...prod, PUBLIC_URL: 'http://192.168.1.20:3001' });
    assert.equal(errors.length, 0, 'still boots');
    assert.ok(alerts.some((l) => /SECURE_COOKIES is on but PUBLIC_URL is http:\/\/192\.168\.1\.20:3001/.test(l)));
    assert.ok(alerts.some((l) => /SECURE_COOKIES=0/.test(l)), 'names the LAN escape hatch');
  });

  test('no alert for https, for localhost, or with SECURE_COOKIES=0', () => {
    assert.deepEqual(loadConfig({ ...prod, PUBLIC_URL: 'https://chat.example.com' }).alerts, []);
    assert.deepEqual(loadConfig({ ...prod, PUBLIC_URL: 'http://localhost:3001' }).alerts, []);
    assert.deepEqual(loadConfig({ ...prod, PUBLIC_URL: 'http://127.0.0.1:3001' }).alerts, []);
    assert.deepEqual(loadConfig({ ...prod, PUBLIC_URL: 'http://192.168.1.20:3001', SECURE_COOKIES: '0' }).alerts, []);
    assert.equal(isLoopbackUrl('http://[::1]:3001'), true);
    assert.equal(isLoopbackUrl('http://10.0.0.2'), false);
  });

  test('an unset PUBLIC_URL in production warns about LAN access', () => {
    const { warnings } = loadConfig({ ...prod });
    assert.ok(warnings.some((w) => /PUBLIC_URL is unset/.test(w)));
  });

  test('empty CORS_ORIGIN is not a warning when the SPA is served by this process', () => {
    const quiet = loadConfig({ ...prod, PUBLIC_URL: 'https://c.example', CORS_ORIGIN: '' });
    assert.ok(!quiet.warnings.some((w) => /CORS_ORIGIN/.test(w)));
    const split = loadConfig({ ...prod, PUBLIC_URL: 'https://c.example', CORS_ORIGIN: '', SERVE_STATIC: '0' });
    assert.ok(split.warnings.some((w) => /CORS_ORIGIN/.test(w)));
  });
});
