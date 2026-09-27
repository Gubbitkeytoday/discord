// ============================================================================
//  Hardening (CodeQL triage follow-ups) and read-time status masking:
//    - server.js CORS: an explicit allow-list matched exactly; unlisted
//      origins get no CORS headers at all
//    - services/linkEmbeds.js: requests are pinned to the vetted address
//    - expired custom statuses are hidden wherever users/members are listed,
//      before the 30 s sweeper clears them
// ============================================================================

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { startServer, stopServer, get, BASE } from './testHarness.mjs';

// Set before the server boots: an allow-list instead of the dev wildcard.
process.env.CORS_ORIGIN = 'https://app.example,http://localhost:5173';

before(startServer);
after(stopServer);

const as = (userId) => ({ 'x-user-id': userId });

describe('CORS allow-list', () => {
  const preflight = (origin) => fetch(`${BASE}/api/users`, {
    method: 'OPTIONS',
    headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' }
  });

  test('a listed origin is echoed with credentials', async () => {
    for (const origin of ['https://app.example', 'http://localhost:5173']) {
      const res = await preflight(origin);
      assert.equal(res.headers.get('access-control-allow-origin'), origin);
      assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
    }
  });

  test('anything else gets no CORS headers: no prefix, suffix, scheme or port games', async () => {
    for (const origin of [
      'https://evil.example', 'https://app.example.evil.com', 'https://evilapp.example',
      'http://app.example', 'https://app.example:444', 'null', 'https://APP.example.'
    ]) {
      const res = await preflight(origin);
      assert.equal(res.headers.get('access-control-allow-origin'), null, origin);
      const simple = await fetch(`${BASE}/api/health`, { headers: { Origin: origin } });
      assert.equal(simple.headers.get('access-control-allow-origin'), null, origin);
      assert.notEqual(simple.headers.get('access-control-allow-credentials'), 'true', origin);
    }
  });

  test('same-origin requests (no Origin header) are unaffected', async () => {
    const res = await get('/api/users', as('user-me'));
    assert.equal(res.status, 200);
  });
});

describe('link previews: pinned to the vetted address', () => {
  test('the request dials the vetted IP but keeps the name for Host and TLS', async () => {
    const { pinnedRequestOptions } = await import('../services/linkEmbeds.js');
    const https = pinnedRequestOptions(new URL('https://news.example/a/b?x=1#frag'), { address: '203.0.113.7', family: 4 });
    assert.equal(https.host, '203.0.113.7');
    assert.equal(https.port, 443);
    assert.equal(https.path, '/a/b?x=1');
    assert.equal(https.servername, 'news.example', 'SNI and the certificate check use the name');
    assert.equal(https.headers.Host, 'news.example');
    const v6 = pinnedRequestOptions(new URL('http://[2001:db8::1]:8080/'), { address: '2001:db8::1', family: 6 });
    assert.equal(v6.family, 6);
    assert.equal(v6.port, 8080);
    assert.equal(v6.servername, undefined);
  });

  test('a pinned request reaches the address given, whatever the name resolves to', async () => {
    const { pinnedRequestOptions } = await import('../services/linkEmbeds.js');
    const seen = [];
    const server = http.createServer((req, res) => { seen.push({ host: req.headers.host, url: req.url }); res.end('ok'); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
      // "does-not-resolve.invalid" has no DNS answer: the connection can only
      // work because nothing is looked up at connect time.
      const options = pinnedRequestOptions(new URL(`http://does-not-resolve.invalid:${port}/p?q=1`), { address: '127.0.0.1', family: 4 });
      const body = await new Promise((resolve, reject) => {
        http.get(options, (res) => { let data = ''; res.on('data', (c) => { data += c; }); res.on('end', () => resolve(data)); })
          .on('error', reject);
      });
      assert.equal(body, 'ok');
      assert.deepEqual(seen, [{ host: `does-not-resolve.invalid:${port}`, url: '/p?q=1' }]);
    } finally {
      server.close();
    }
  });
});

describe('expired custom statuses are masked on read', () => {
  test('user lists, member lists, friends and DM recipients hide an expired status at once', async () => {
    const { runQuery } = await import('../db.js');
    const past = new Date(Date.now() - 60_000).toISOString();
    await runQuery(
      `UPDATE users SET custom_status = 'gone fishing', custom_status_emoji = '🎣', custom_status_expires_at = ? WHERE id = 'user-2'`,
      [past]
    );
    await runQuery(
      `UPDATE users SET custom_status = 'still here', custom_status_expires_at = NULL WHERE id = 'user-4'`
    );
    try {
      const users = (await get('/api/users', as('user-me'))).body;
      const kira = users.find((u) => u.id === 'user-2');
      assert.equal(kira.custom_status, null);
      assert.equal(kira.custom_status_emoji, null);
      assert.equal(users.find((u) => u.id === 'user-4').custom_status, 'still here', 'an unexpired status stays');

      const detail = (await get('/api/servers/server-1', as('user-me'))).body;
      assert.equal(detail.members.find((m) => m.id === 'user-2').custom_status, null);
      assert.equal(detail.members.find((m) => m.id === 'user-4').custom_status, 'still here');

      const initial = (await get('/api/initial-data/user-me', as('user-me'))).body;
      const friend = initial.friends.find((f) => f.id === 'user-2');
      if (friend) assert.equal(friend.custom_status, null);
      for (const dm of initial.dms) {
        for (const r of dm.recipients ?? []) if (r.id === 'user-2') assert.equal(r.custom_status, null);
      }

      const profile = (await get('/api/users/user-2', as('user-me'))).body;
      assert.equal(profile.custom_status, null);
    } finally {
      await runQuery(`UPDATE users SET custom_status = NULL, custom_status_emoji = NULL, custom_status_expires_at = NULL WHERE id IN ('user-2', 'user-4')`);
    }
  });
});

describe('seeded demo community', () => {
  test('members joined in the past; only one is new', async () => {
    const detail = (await get('/api/servers/server-1', as('user-me'))).body;
    const recent = detail.members.filter((m) => Date.now() - new Date(m.joined_at).getTime() < 7 * 86400e3);
    assert.deepEqual(recent.map((m) => m.id), ['user-5']);
    const oldest = Math.max(...detail.members.map((m) => Date.now() - new Date(m.joined_at).getTime()));
    assert.ok(oldest > 300 * 86400e3 && oldest < 410 * 86400e3);
  });
});
