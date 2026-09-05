// ============================================================================
//  Integration tests, part 3: MFA (TOTP), email verification, password reset,
//  S3 SigV4 signing, media duration parsing, and extra security probes.
// ============================================================================

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';

import {
  startServer, stopServer, api, get, asSession, login, uploadFile, PNG, BASE, ADMIN
} from './testHarness.mjs';

import {
  generateCode, verifyCode, base32Encode, base32Decode, generateSecret,
  buildOtpAuthUri, generateRecoveryCodes
} from '../lib/totp.js';
import { signRequest, uriEncode, S3Client } from '../lib/s3Client.js';
import { probeDuration } from '../lib/mediaDuration.js';

before(startServer);
after(stopServer);

// ---------------------------------------------------------------------------
// TOTP — checked against the RFC 6238 published test vectors, which is the only
// way to know the implementation is interoperable with real authenticator apps.
// ---------------------------------------------------------------------------

describe('TOTP (RFC 6238 vectors)', () => {
  // The RFC uses the ASCII secret "12345678901234567890".
  const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

  const VECTORS = [
    { time: 59, code: '287082' },
    { time: 1111111109, code: '081804' },
    { time: 1111111111, code: '050471' },
    { time: 1234567890, code: '005924' },
    { time: 2000000000, code: '279037' },
    { time: 20000000000, code: '353130' }
  ];

  for (const { time, code } of VECTORS) {
    test(`matches the RFC vector at T=${time}`, () => {
      const generated = generateCode(RFC_SECRET, { timestamp: time * 1000, digits: 6 });
      assert.equal(generated, code);
    });
  }

  test('base32 round-trips', () => {
    const original = crypto.randomBytes(20);
    assert.deepEqual(base32Decode(base32Encode(original)), original);
  });

  test('accepts a code from the adjacent window but not a distant one', () => {
    const secret = generateSecret();
    const now = 1700000000000;
    const previous = generateCode(secret, { timestamp: now - 30_000 });
    assert.ok(verifyCode(secret, previous, { timestamp: now }), 'previous window rejected');

    const distant = generateCode(secret, { timestamp: now - 300_000 });
    assert.ok(!verifyCode(secret, distant, { timestamp: now }), 'stale code accepted');
  });

  test('rejects malformed input without throwing', () => {
    const secret = generateSecret();
    for (const bad of ['', '12345', 'abcdef', null, undefined, '1234567']) {
      assert.equal(verifyCode(secret, bad), false);
    }
  });

  test('otpauth URI carries the fields apps need', () => {
    const uri = buildOtpAuthUri({ secret: 'ABCDEFGH', accountName: 'alex' });
    assert.match(uri, /^otpauth:\/\/totp\//);
    assert.match(uri, /secret=ABCDEFGH/);
    assert.match(uri, /digits=6/);
    assert.match(uri, /period=30/);
  });

  test('recovery codes are unique and formatted', () => {
    const codes = generateRecoveryCodes(10);
    assert.equal(codes.length, 10);
    assert.equal(new Set(codes).size, 10);
    for (const code of codes) assert.match(code, /^[0-9A-F]{5}-[0-9A-F]{5}$/);
  });
});

describe('MFA enrolment', () => {
  let token;
  let secret;
  let recoveryCodes;

  test('enrolment hands back a secret without enabling MFA yet', async () => {
    ({ token } = await login('AlexPro'));
    const begun = await asSession(token, 'POST', '/api/auth/mfa/begin');
    assert.equal(begun.status, 200);
    assert.ok(begun.body.secret);
    assert.match(begun.body.otpauth_uri, /^otpauth:/);
    secret = begun.body.secret;

    // Not enabled until a code is proven — otherwise a failed setup locks the
    // user out of their own account.
    const status = await asSession(token, 'GET', '/api/auth/mfa/status');
    assert.equal(status.body.enabled, false);
  });

  test('a wrong code does not enable MFA', async () => {
    const bad = await asSession(token, 'POST', '/api/auth/mfa/confirm', { code: '000000' });
    assert.equal(bad.status, 401);
    const status = await asSession(token, 'GET', '/api/auth/mfa/status');
    assert.equal(status.body.enabled, false);
  });

  test('a valid code enables MFA and issues recovery codes', async () => {
    const code = generateCode(secret);
    const confirmed = await asSession(token, 'POST', '/api/auth/mfa/confirm', { code });
    assert.equal(confirmed.status, 200);
    assert.equal(confirmed.body.enabled, true);
    assert.equal(confirmed.body.recovery_codes.length, 10);
    recoveryCodes = confirmed.body.recovery_codes;

    const status = await asSession(token, 'GET', '/api/auth/mfa/status');
    assert.equal(status.body.enabled, true);
    assert.equal(status.body.recovery_codes_remaining, 10);
  });

  test('enrolling twice is refused', async () => {
    const again = await asSession(token, 'POST', '/api/auth/mfa/begin');
    assert.equal(again.status, 409);
  });

  test('a recovery code works once and only once', async () => {
    const code = recoveryCodes[0];
    const first = await asSession(token, 'POST', '/api/auth/mfa/disable', { code });
    assert.equal(first.status, 200);
    assert.equal(first.body.enabled, false);

    // MFA is off now, so re-enable and try the burnt code.
    const begun = await asSession(token, 'POST', '/api/auth/mfa/begin');
    await asSession(token, 'POST', '/api/auth/mfa/confirm', {
      code: generateCode(begun.body.secret)
    });
    const reused = await asSession(token, 'POST', '/api/auth/mfa/disable', { code });
    assert.equal(reused.status, 401, 'a used recovery code was accepted again');

    // Clean up so later tests see a normal account.
    await asSession(token, 'POST', '/api/auth/mfa/disable', {
      code: generateCode(begun.body.secret)
    });
  });

  test('disabling MFA requires a code', async () => {
    const begun = await asSession(token, 'POST', '/api/auth/mfa/begin');
    await asSession(token, 'POST', '/api/auth/mfa/confirm', {
      code: generateCode(begun.body.secret)
    });

    const noCode = await asSession(token, 'POST', '/api/auth/mfa/disable', { code: '111111' });
    assert.equal(noCode.status, 401, 'MFA was removed without proof');

    await asSession(token, 'POST', '/api/auth/mfa/disable', {
      code: generateCode(begun.body.secret)
    });
  });
});

describe('email verification', () => {
  test('issues a token and marks the address verified', async () => {
    // A fresh account, so the seeded email_verified flag does not interfere.
    const unique = `verify${Date.now().toString(36)}`;
    const registered = await api('POST', '/api/auth/register', {
      username: unique, password: 'a-good-password', email: `${unique}@example.dev`
    });
    assert.equal(registered.status, 201);
    const token = registered.body.token;

    const requested = await asSession(token, 'POST', '/api/auth/verify-email/request');
    assert.equal(requested.status, 200);
    // With no mail transport configured the token is returned for dev use.
    assert.ok(requested.body.dev_token, 'no dev token returned');

    const verified = await api('POST', '/api/auth/verify-email', {
      token: requested.body.dev_token
    });
    assert.equal(verified.body.verified, true);

    // Single use.
    const again = await api('POST', '/api/auth/verify-email', {
      token: requested.body.dev_token
    });
    assert.equal(again.status, 410);
  });

  test('rejects a forged token', async () => {
    const { status } = await api('POST', '/api/auth/verify-email', { token: 'nope' });
    assert.equal(status, 410);
  });
});

describe('password reset', () => {
  test('resets the password and invalidates every session', async () => {
    const unique = `reset${Date.now().toString(36)}`;
    const email = `${unique}@example.dev`;
    const registered = await api('POST', '/api/auth/register', {
      username: unique, password: 'original-password', email
    });
    const oldToken = registered.body.token;
    assert.equal((await asSession(oldToken, 'GET', '/api/auth/me')).status, 200);

    const requested = await api('POST', '/api/auth/forgot-password', { email });
    assert.equal(requested.status, 200);
    assert.ok(requested.body.dev_token);

    const reset = await api('POST', '/api/auth/reset-password', {
      token: requested.body.dev_token, password: 'brand-new-password'
    });
    assert.equal(reset.body.reset, true);

    // A reset means "I lost control of this account": old sessions must die.
    assert.equal((await asSession(oldToken, 'GET', '/api/auth/me')).status, 401);

    // The new password works, the old one does not.
    assert.equal((await login(unique, 'brand-new-password')).status, 200);
    assert.equal((await login(unique, 'original-password')).status, 401);
  });

  test('an unknown address still reports success (no account enumeration)', async () => {
    const known = await api('POST', '/api/auth/forgot-password', { email: 'user-me@example.dev' });
    const unknown = await api('POST', '/api/auth/forgot-password', { email: 'nobody@example.dev' });
    assert.equal(known.status, unknown.status);
    assert.equal(known.body.sent, true);
    assert.equal(unknown.body.sent, true);
    // The unknown address must not receive a token.
    assert.equal(unknown.body.dev_token, undefined);
  });

  test('a reset token cannot be reused', async () => {
    const unique = `reuse${Date.now().toString(36)}`;
    const email = `${unique}@example.dev`;
    await api('POST', '/api/auth/register', {
      username: unique, password: 'first-password', email
    });
    const requested = await api('POST', '/api/auth/forgot-password', { email });
    await api('POST', '/api/auth/reset-password', {
      token: requested.body.dev_token, password: 'second-password'
    });
    const again = await api('POST', '/api/auth/reset-password', {
      token: requested.body.dev_token, password: 'third-password'
    });
    assert.equal(again.status, 410);
  });
});

// ---------------------------------------------------------------------------
// S3 SigV4 — verified against the signature AWS publishes for its own example,
// which is the only way to be sure the implementation would be accepted.
// ---------------------------------------------------------------------------

describe('S3 SigV4 signing', () => {
  test('reproduces the AWS documentation example signature', () => {
    // From "Examples of the complete Version 4 signing process":
    // GET https://examplebucket.s3.amazonaws.com/test.txt with a range header.
    const signed = signRequest({
      method: 'GET',
      path: '/test.txt',
      headers: {
        host: 'examplebucket.s3.amazonaws.com',
        range: 'bytes=0-9'
      },
      body: '',
      region: 'us-east-1',
      service: 's3',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      timestamp: new Date('2013-05-24T00:00:00Z')
    });

    assert.equal(
      signed.signature,
      'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41'
    );
    assert.match(signed.authorization, /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/);
    assert.match(signed.authorization, /SignedHeaders=host;range;x-amz-content-sha256;x-amz-date/);
  });

  test('uriEncode follows RFC 3986, not encodeURIComponent', () => {
    // encodeURIComponent leaves these alone; S3 requires them percent-encoded.
    assert.equal(uriEncode("!'()*"), '%21%27%28%29%2A');
    assert.equal(uriEncode('a/b'), 'a%2Fb');
    assert.equal(uriEncode('a/b', false), 'a/b');
    assert.equal(uriEncode('ก'), '%E0%B8%81');
  });

  test('reports itself unconfigured without credentials', () => {
    const client = new S3Client({
      endpoint: undefined, bucket: undefined, accessKeyId: undefined, secretAccessKey: undefined
    });
    assert.equal(client.configured, false);
  });

  test('builds path-style and virtual-hosted URLs', () => {
    const pathStyle = new S3Client({
      endpoint: 'https://s3.example.com', bucket: 'media',
      accessKeyId: 'k', secretAccessKey: 's', forcePathStyle: true
    });
    assert.equal(pathStyle.urlFor('a/b.png').href, 'https://s3.example.com/media/a/b.png');

    const virtualHosted = new S3Client({
      endpoint: 'https://s3.example.com', bucket: 'media',
      accessKeyId: 'k', secretAccessKey: 's', forcePathStyle: false
    });
    assert.equal(virtualHosted.urlFor('a/b.png').href, 'https://media.s3.example.com/a/b.png');
  });

  test('presigned URLs carry every required query parameter', () => {
    const client = new S3Client({
      endpoint: 'https://s3.example.com', bucket: 'media',
      region: 'us-east-1', accessKeyId: 'AKIA', secretAccessKey: 'secret'
    });
    const url = client.presignGet('a/b.png', { expiresIn: 900 });
    for (const param of [
      'X-Amz-Algorithm=AWS4-HMAC-SHA256', 'X-Amz-Credential=', 'X-Amz-Date=',
      'X-Amz-Expires=900', 'X-Amz-SignedHeaders=host', 'X-Amz-Signature='
    ]) {
      assert.ok(url.includes(param), `missing ${param}`);
    }
  });

  test('the local backend stays active without S3 configuration', async () => {
    const { activeBackend } = await import('../storageService.js');
    assert.equal(activeBackend(), 'local');
  });
});

// ---------------------------------------------------------------------------
// Media duration — parsed from the container, no ffmpeg involved.
// ---------------------------------------------------------------------------

describe('media duration parsing', () => {
  /** A minimal MP4 with a moov/mvhd atom describing a known duration. */
  const buildMp4 = (timescale, duration) => {
    const mvhdBody = Buffer.alloc(100);
    mvhdBody.writeUInt32BE(0, 0);            // version 0 + flags
    mvhdBody.writeUInt32BE(timescale, 12);
    mvhdBody.writeUInt32BE(duration, 16);
    const mvhd = Buffer.concat([
      sizeAndType(mvhdBody.length + 8, 'mvhd'), mvhdBody
    ]);
    const moov = Buffer.concat([sizeAndType(mvhd.length + 8, 'moov'), mvhd]);
    const ftyp = Buffer.concat([sizeAndType(16, 'ftyp'), Buffer.from('isom' + 'mp42')]);
    return Buffer.concat([ftyp, moov]);
  };

  const sizeAndType = (size, type) => {
    const header = Buffer.alloc(8);
    header.writeUInt32BE(size, 0);
    header.write(type, 4, 'latin1');
    return header;
  };

  test('reads MP4 duration from mvhd', () => {
    // 90000 ticks per second, 450000 ticks = 5 seconds.
    assert.equal(probeDuration(buildMp4(90000, 450000), 'video/mp4'), 5);
    assert.equal(probeDuration(buildMp4(1000, 12500), 'video/mp4'), 12.5);
  });

  test('reads WAV duration from the data chunk', () => {
    const byteRate = 44100 * 2 * 2;      // 44.1 kHz stereo 16-bit
    const dataBytes = byteRate * 3;      // exactly 3 seconds
    const fmt = Buffer.alloc(24);
    fmt.write('fmt ', 0, 'latin1');
    fmt.writeUInt32LE(16, 4);
    fmt.writeUInt32LE(byteRate, 16);
    const data = Buffer.alloc(8);
    data.write('data', 0, 'latin1');
    data.writeUInt32LE(dataBytes, 4);
    const riff = Buffer.alloc(12);
    riff.write('RIFF', 0, 'latin1');
    riff.write('WAVE', 8, 'latin1');

    assert.equal(probeDuration(Buffer.concat([riff, fmt, data]), 'audio/wav'), 3);
  });

  test('returns null rather than throwing on junk', () => {
    assert.equal(probeDuration(Buffer.from('not media at all'), 'video/mp4'), null);
    assert.equal(probeDuration(Buffer.alloc(0), 'video/mp4'), null);
    assert.equal(probeDuration(PNG, 'image/png'), null);
    // A truncated moov must not crash the parser.
    const truncated = buildMp4(1000, 5000).subarray(0, 20);
    assert.equal(probeDuration(truncated, 'video/mp4'), null);
  });
});

// ---------------------------------------------------------------------------
// Extra security probes beyond the earlier suites.
// ---------------------------------------------------------------------------

describe('security probes', () => {
  test('SQL injection in a path parameter does not corrupt anything', async () => {
    const injections = [
      "'; DROP TABLE messages; --",
      "1' OR '1'='1",
      'chan-102" UNION SELECT * FROM users --'
    ];
    for (const payload of injections) {
      const { status } = await get(`/api/messages/${encodeURIComponent(payload)}`);
      assert.ok([200, 400, 404].includes(status), `unexpected ${status} for ${payload}`);
    }
    // The table must still be there.
    const { body } = await get('/api/messages/chan-102?limit=5');
    assert.ok(Array.isArray(body));
  });

  test('SQL injection in a search query is treated as text', async () => {
    const { status } = await get(
      `/api/search/messages?q=${encodeURIComponent("'; DELETE FROM messages WHERE 1=1; --")}`
    );
    assert.equal(status, 200);
    const { body } = await get('/api/messages/chan-102?limit=5');
    assert.ok(body.length > 0, 'messages were deleted by a search query');
  });

  test('a prototype-pollution payload does not poison Object', async () => {
    await api('POST', '/api/messages', {
      channel_id: 'chan-102', user_id: 'user-me', content: 'pollution attempt',
      __proto__: { polluted: true },
      constructor: { prototype: { polluted: true } }
    });
    assert.equal({}.polluted, undefined, 'Object.prototype was polluted');
  });

  test('an oversized JSON body is rejected, not buffered', async () => {
    const huge = 'x'.repeat(3 * 1024 * 1024);
    const res = await fetch(`${BASE}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-user-id': 'user-me' },
      body: JSON.stringify({ channel_id: 'chan-102', user_id: 'user-me', content: huge })
    });
    assert.ok(res.status >= 400, `oversized body accepted with ${res.status}`);
  });

  test('message content is capped, so storage cannot be exhausted', async () => {
    const { body } = await api('POST', '/api/messages', {
      channel_id: 'chan-102', user_id: 'user-me', content: 'ก'.repeat(9000)
    });
    assert.ok(body.content.length <= 4000, `content stored at ${body.content.length} chars`);
  });

  test('header injection through a filename is neutralised', async () => {
    const evil = 'a\r\nX-Injected: yes\r\n.png';
    const { body } = await uploadFile(PNG, evil, 'image/png');
    const file = body.attachments[0];
    // The stored name must not carry CR or LF into a response header.
    assert.ok(!/[\r\n]/.test(file.filename), 'CRLF survived sanitisation');

    const res = await fetch(`${BASE}/api/files/${file.id}`, {
      headers: { 'x-user-id': 'user-me' }
    });
    assert.equal(res.headers.get('x-injected'), null);
  });

  test('a path-traversal storage key cannot be fetched', async () => {
    for (const attempt of [
      '/uploads/../../server.js',
      '/uploads/..%2f..%2fserver.js',
      '/uploads/....//....//server.js'
    ]) {
      const res = await fetch(`${BASE}${attempt}`);
      const text = await res.text().catch(() => '');
      assert.ok(!text.includes('registerRealtime'), `traversal succeeded for ${attempt}`);
    }
  });

  test('uploads are served with the headers that stop script execution', async () => {
    const { body } = await uploadFile(PNG, 'headers.png', 'image/png');
    const res = await fetch(`${BASE}${body.attachments[0].url}`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('content-security-policy') ?? '', /sandbox/);
  });

  test('an SVG upload is not served as an executable document', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' +
      '<script>alert(1)</script></svg>'
    );
    const upload = await uploadFile(svg, 'x.svg', 'image/svg+xml');
    if (upload.status !== 200) return;   // rejected outright is also fine
    const res = await fetch(`${BASE}${upload.body.attachments[0].url}`);
    // The CSP sandbox is what makes an inline script inert.
    assert.match(res.headers.get('content-security-policy') ?? '', /sandbox/);
  });
});

// ---------------------------------------------------------------------------
// Account-wide client preferences. The client keeps its own copy for instant
// feedback, so the value of these tests is that the *server* is the authority:
// it validates, it clamps, and the two privacy categories it enforces cannot be
// talked out of by a modified client.
// ---------------------------------------------------------------------------

const asUser = (id) => ({ 'x-user-id': id });

describe('client preferences', () => {
  test('every category comes back with its defaults', async () => {
    const { status, body } = await get('/api/settings/preferences');
    assert.equal(status, 200);
    for (const category of [
      'appearance', 'accessibility', 'notifications', 'chat',
      'privacy', 'activity', 'streamerMode', 'keybinds', 'voice'
    ]) {
      assert.ok(body[category], `missing category ${category}`);
    }
    assert.equal(body.appearance.theme, 'dark');
  });

  test('a patch merges into the category and survives a re-read', async () => {
    const patch = await api('PATCH', '/api/settings/preferences/appearance', { theme: 'onyx' });
    assert.equal(patch.status, 200);
    assert.equal(patch.body.theme, 'onyx');

    const { body } = await get('/api/settings/preferences');
    assert.equal(body.appearance.theme, 'onyx');
    // Untouched keys in the same category are not wiped by a partial patch.
    assert.equal(body.appearance.messageDisplay, 'cozy');
  });

  test('preferences are per account, not global', async () => {
    const { body } = await get('/api/settings/preferences', asUser('user-5'));
    assert.equal(body.appearance.theme, 'dark');
  });

  test('an unknown category is rejected', async () => {
    const { status } = await api('PATCH', '/api/settings/preferences/nonsense', { x: 1 });
    assert.equal(status, 404);
  });

  test('a value outside the allowed set is rejected', async () => {
    const { status } = await api('PATCH', '/api/settings/preferences/appearance', { theme: 'chartreuse' });
    assert.equal(status, 400);
  });

  test('a numeric value is clamped rather than stored out of range', async () => {
    const { status, body } = await api('PATCH', '/api/settings/preferences/voice', { outputVolume: 9000 });
    assert.equal(status, 200);
    assert.ok(body.outputVolume <= 200, `expected clamping, got ${body.outputVolume}`);
  });

  test('reset restores the category defaults', async () => {
    await api('PATCH', '/api/settings/preferences/appearance', { theme: 'light' });
    const { status, body } = await api('DELETE', '/api/settings/preferences/appearance');
    assert.equal(status, 200);
    assert.equal(body.theme, 'dark');
  });

  test('preferences require a signed-in caller', async () => {
    const res = await fetch(`${BASE}/api/settings/preferences`);
    assert.equal(res.status, 401);
  });
});

describe('privacy settings are enforced by the server', () => {
  test("allowDmsFrom 'friends' refuses a DM from a non-friend", async () => {
    // user-5 is only a *pending* friend of user-me, and they share a server —
    // so without this setting the DM would be allowed.
    await api('PATCH', '/api/settings/preferences/privacy', { allowDmsFrom: 'friends' }, asUser('user-5'));
    const { status } = await api('POST', '/api/dms', { recipientId: 'user-5' });
    assert.equal(status, 403);

    await api('DELETE', '/api/settings/preferences/privacy', undefined, asUser('user-5'));
    const reopened = await api('POST', '/api/dms', { recipientId: 'user-5' });
    assert.equal(reopened.status, 200);
  });

  test('an accepted friend still gets through', async () => {
    await api('PATCH', '/api/settings/preferences/privacy', { allowDmsFrom: 'friends' }, asUser('user-2'));
    const { status } = await api('POST', '/api/dms', { recipientId: 'user-2' });
    assert.equal(status, 200);
    await api('DELETE', '/api/settings/preferences/privacy', undefined, asUser('user-2'));
  });

  test("friendRequests 'none' refuses a request", async () => {
    await api('PATCH', '/api/settings/preferences/privacy', { friendRequests: 'none' }, asUser('user-3'));
    const { status } = await api('POST', '/api/friends/requests', { targetId: 'user-3' });
    assert.equal(status, 403);
    await api('DELETE', '/api/settings/preferences/privacy', undefined, asUser('user-3'));
  });

  test("friendRequests 'friends_of_friends' accepts someone from a shared server", async () => {
    await api('PATCH', '/api/settings/preferences/privacy',
      { friendRequests: 'friends_of_friends' }, asUser('user-3'));
    // user-me and user-3 are both in server-1.
    const { status } = await api('POST', '/api/friends/requests', { targetId: 'user-3' });
    assert.ok(status === 200 || status === 409, `unexpected ${status}`);
    await api('DELETE', '/api/settings/preferences/privacy', undefined, asUser('user-3'));
  });
});

// ---------------------------------------------------------------------------
// The file lifecycle, end to end.
//
// These exist because a live audit found the GC endpoint silently refusing to
// delete: it accepted only `dryRun`, so `{apply: true}` — the spelling the CLI
// uses and the one an operator reaches for — ran a dry run and returned 200
// with `removed: 0`. A cron wired that way reclaims nothing forever while
// looking perfectly healthy, and the disk fills up months later.
//
// The second half of the story matters just as much: a *real* sweep must never
// take a file that something still points at.
// ---------------------------------------------------------------------------

const gc = (body) => api('POST', '/api/files/maintenance/gc', body, ADMIN);

describe('garbage collection contract', () => {
  test('an unreferenced upload survives the default grace period', async () => {
    const { body } = await uploadFile(PNG, 'grace.png', 'image/png');
    const url = body.attachments[0].url;

    const swept = await gc({ apply: true });
    assert.equal(swept.status, 200);
    assert.equal(swept.body.effective.grace_hours, 24);

    const still = await fetch(`${BASE}${url}`);
    assert.equal(still.status, 200, 'a fresh upload must not be collected');
  });

  test('{apply:true} really deletes — it must not silently dry-run', async () => {
    const { body } = await uploadFile(PNG, 'orphan.png', 'image/png');
    const url = body.attachments[0].url;

    const swept = await gc({ apply: true, graceHours: 0 });
    assert.equal(swept.status, 200);
    assert.equal(swept.body.effective.dryRun, false, 'apply:true must not be a dry run');
    assert.ok(swept.body.removed >= 1, 'expected at least the orphan to be removed');

    const gone = await fetch(`${BASE}${url}`);
    assert.equal(gone.status, 404, 'the orphan should be gone from disk');
  });

  test('graceHours 0 is honoured rather than falling back to the default', async () => {
    // `Number(0) || undefined` is undefined — the bug that made "collect
    // everything now" impossible through the API.
    const { body } = await gc({ graceHours: 0 });
    assert.equal(body.effective.grace_hours, 0);
    assert.equal(body.effective.orphanGraceMs, 0);
  });

  test('a dry run reports what it would do without claiming it did it', async () => {
    await uploadFile(PNG, 'dry.png', 'image/png');
    const { body } = await gc({ graceHours: 0 });
    assert.equal(body.effective.dryRun, true);
    assert.equal(body.removed, 0, 'a dry run must report removing nothing');
    assert.equal(body.bytesFreed, 0);
    assert.ok(body.wouldRemove >= 1, 'but it must still say what a real run would take');
    assert.ok(body.wouldFreeBytes > 0);
  });

  test('contradictory apply/dryRun is refused instead of guessed', async () => {
    assert.equal((await gc({ apply: true, dryRun: true })).status, 400);
    assert.equal((await gc({ apply: false, dryRun: false })).status, 400);
  });

  test('a non-numeric grace is refused', async () => {
    assert.equal((await gc({ graceHours: 'soon' })).status, 400);
    assert.equal((await gc({ limit: 'lots' })).status, 400);
  });

  test('maintenance needs the admin token', async () => {
    const { status } = await api('POST', '/api/files/maintenance/gc', { apply: true });
    assert.equal(status, 403);
  });
});

describe('an image posted in chat is not garbage', () => {
  test('posting references the file, and a zero-grace sweep leaves it alone', async () => {
    const upload = await uploadFile(PNG, 'posted.png', 'image/png');
    const descriptor = upload.body.attachments[0];

    const before = await get(`/api/files/${descriptor.id}/meta`);
    assert.equal(before.body.ref_count, 0, 'not referenced until it is posted');

    const posted = await api('POST', '/api/messages', {
      channel_id: 'chan-102',
      content: 'look at this',
      attachments: [descriptor]
    });
    assert.equal(posted.status, 200);

    const after = await get(`/api/files/${descriptor.id}/meta`);
    assert.equal(after.body.ref_count, 1, 'posting must claim a reference');

    // The sweep that deletes orphans must not touch this one.
    await gc({ apply: true, graceHours: 0 });
    const served = await fetch(`${BASE}${descriptor.url}`);
    assert.equal(served.status, 200, 'a posted image must survive garbage collection');

    // ...and deleting the message must release it again.
    await api('DELETE', `/api/messages/${posted.body.id}`);
    const released = await get(`/api/files/${descriptor.id}/meta`);
    assert.equal(released.body.ref_count, 0, 'deleting the message releases the file');
  });

  test('setting an avatar claims a reference, and changing it releases the old one', async () => {
    const first = await uploadFile(PNG, 'av1.png', 'image/png', 'avatar', '/api/upload/avatar');
    assert.equal(first.status, 200);
    await api('PUT', '/api/users/user-me', { avatar_url: first.body.url });

    const claimed = await get(`/api/files/${first.body.id}/meta`);
    assert.equal(claimed.body.ref_count, 1);

    // A different image, so dedupe does not mask the swap.
    const second = await uploadFile(
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64'
      ),
      'av2.png', 'image/png', 'avatar', '/api/upload/avatar'
    );
    await api('PUT', '/api/users/user-me', { avatar_url: second.body.url });

    const releasedOld = await get(`/api/files/${first.body.id}/meta`);
    const claimedNew = await get(`/api/files/${second.body.id}/meta`);
    assert.equal(releasedOld.body.ref_count, 0, 'the replaced avatar is released');
    assert.equal(claimedNew.body.ref_count, 1, 'the new avatar is claimed');
  });
});

// ---------------------------------------------------------------------------
// Polls.
//
// The rules worth pinning down are the ones that are easy to get subtly wrong:
// changing a vote must *replace* it rather than add a second one, a retry must
// not toggle, a closed poll must refuse everything, and expiry must settle
// itself on read rather than needing a timer to have fired.
// ---------------------------------------------------------------------------

const makePoll = (poll, channel = 'chan-102') =>
  api('POST', '/api/messages', { channel_id: channel, poll });

describe('polls', () => {
  test('a poll is a message, and comes back with its answers', async () => {
    const { status, body } = await makePoll({
      question: 'กินอะไรดี',
      answers: ['ข้าวมันไก่', 'ก๋วยเตี๋ยว', 'ส้มตำ'],
      durationHours: 24
    });
    assert.equal(status, 200);
    assert.equal(body.type, 'poll');
    assert.equal(body.poll.question, 'กินอะไรดี');
    assert.equal(body.poll.answers.length, 3);
    assert.equal(body.poll.is_closed, false);
    assert.equal(body.poll.total_voters, 0);
    // Answer ids are server-assigned, so a client cannot pre-guess them.
    for (const answer of body.poll.answers) assert.ok(answer.id);
  });

  test('votes tally, and percentages are of voters', async () => {
    const { body } = await makePoll({ question: 'สีอะไร', answers: ['แดง', 'น้ำเงิน'] });
    const [red, blue] = body.poll.answers;

    await api('PUT', `/api/polls/${body.id}/vote`, { answer_ids: [red.id] });
    await api('PUT', `/api/polls/${body.id}/vote`, { answer_ids: [red.id] }, { 'x-user-id': 'user-2' });
    const third = await api('PUT', `/api/polls/${body.id}/vote`,
      { answer_ids: [blue.id] }, { 'x-user-id': 'user-5' });

    const answers = Object.fromEntries(third.body.answers.map((a) => [a.text, a]));
    assert.equal(answers['แดง'].votes, 2);
    assert.equal(answers['น้ำเงิน'].votes, 1);
    assert.equal(third.body.total_voters, 3);
    assert.equal(answers['แดง'].percent, 67);
  });

  test('changing your vote replaces it rather than adding another', async () => {
    const { body } = await makePoll({ question: 'ก', answers: ['หนึ่ง', 'สอง'] });
    const [one, two] = body.poll.answers;

    await api('PUT', `/api/polls/${body.id}/vote`, { answer_ids: [one.id] });
    const after = await api('PUT', `/api/polls/${body.id}/vote`, { answer_ids: [two.id] });

    assert.equal(after.body.total_voters, 1, 'one person must still count once');
    assert.equal(after.body.my_votes.length, 1);
    assert.deepEqual(after.body.my_votes, [two.id]);
  });

  test('voting twice with the same body is idempotent', async () => {
    const { body } = await makePoll({ question: 'ข', answers: ['ใช่', 'ไม่'] });
    const [yes] = body.poll.answers;

    await api('PUT', `/api/polls/${body.id}/vote`, { answer_ids: [yes.id] });
    const again = await api('PUT', `/api/polls/${body.id}/vote`, { answer_ids: [yes.id] });

    // A retried request after a dropped response must not toggle the vote off.
    assert.equal(again.body.answers.find((a) => a.id === yes.id).votes, 1);
    assert.deepEqual(again.body.my_votes, [yes.id]);
  });

  test('an empty selection retracts the vote', async () => {
    const { body } = await makePoll({ question: 'ค', answers: ['A', 'B'] });
    const [a] = body.poll.answers;
    await api('PUT', `/api/polls/${body.id}/vote`, { answer_ids: [a.id] });
    const cleared = await api('PUT', `/api/polls/${body.id}/vote`, { answer_ids: [] });
    assert.equal(cleared.body.total_voters, 0);
    assert.deepEqual(cleared.body.my_votes, []);
  });

  test('a single-choice poll refuses two answers', async () => {
    const { body } = await makePoll({ question: 'ง', answers: ['A', 'B'] });
    const [a, b] = body.poll.answers;
    const { status } = await api('PUT', `/api/polls/${body.id}/vote`, { answer_ids: [a.id, b.id] });
    assert.equal(status, 400);
  });

  test('a multiple-choice poll accepts two, and still counts one voter', async () => {
    const { body } = await makePoll({ question: 'จ', answers: ['A', 'B'], allowMultiple: true });
    const [a, b] = body.poll.answers;
    const { body: voted } = await api('PUT', `/api/polls/${body.id}/vote`, { answer_ids: [a.id, b.id] });
    assert.equal(voted.total_votes, 2);
    assert.equal(voted.total_voters, 1, 'two votes from one person is still one voter');
  });

  test('closing freezes the poll', async () => {
    const { body } = await makePoll({ question: 'ฉ', answers: ['A', 'B'] });
    const [a] = body.poll.answers;

    const closed = await api('POST', `/api/polls/${body.id}/close`);
    assert.equal(closed.status, 200);
    assert.equal(closed.body.is_closed, true);

    const refused = await api('PUT', `/api/polls/${body.id}/vote`, { answer_ids: [a.id] });
    assert.equal(refused.status, 409);
  });

  test('a stranger cannot close someone else\'s poll', async () => {
    const { body } = await makePoll({ question: 'ช', answers: ['A', 'B'] });
    // user-5 is a member of server-1 but holds no MANAGE_MESSAGES there.
    const { status } = await api('POST', `/api/polls/${body.id}/close`, undefined,
      { 'x-user-id': 'user-5' });
    assert.equal(status, 403);
  });

  test('expiry settles on read, with no timer involved', async () => {
    const { body } = await makePoll({ question: 'ซ', answers: ['A', 'B'], durationHours: 1 });
    assert.equal(body.poll.is_closed, false);

    // Reach past the API and backdate the deadline, the way a server that was
    // switched off over the weekend would come back to.
    const { runQuery } = await import('../db.js');
    await runQuery(`UPDATE polls SET expires_at = ? WHERE message_id = ?`,
      ['2020-01-01T00:00:00.000Z', body.id]);

    const read = await get(`/api/polls/${body.id}`);
    assert.equal(read.body.is_closed, true);
    assert.equal(read.body.closed_at, '2020-01-01T00:00:00.000Z');
  });

  test('the voter list names who picked an answer', async () => {
    const { body } = await makePoll({ question: 'ฌ', answers: ['A', 'B'] });
    const [a] = body.poll.answers;
    await api('PUT', `/api/polls/${body.id}/vote`, { answer_ids: [a.id] }, { 'x-user-id': 'user-2' });

    const { body: voters } = await get(`/api/polls/${body.id}/answers/${a.id}/voters`);
    assert.equal(voters.length, 1);
    assert.equal(voters[0].id, 'user-2');
  });

  test('a poll survives a history reload with its tally intact', async () => {
    const { body } = await makePoll({ question: 'ญ', answers: ['A', 'B'] });
    const [a] = body.poll.answers;
    await api('PUT', `/api/polls/${body.id}/vote`, { answer_ids: [a.id] });

    const { body: history } = await get('/api/messages/chan-102?limit=50');
    const found = history.find((m) => m.id === body.id);
    assert.ok(found, 'the poll message is missing from history');
    assert.ok(found.poll, 'history dropped the poll payload');
    assert.equal(found.poll.question, 'ญ');
    assert.equal(found.poll.answers.find((x) => x.id === a.id).votes, 1);
    assert.deepEqual(found.poll.my_votes, [a.id], 'history must know what I voted for');
  });

  test('malformed polls are refused before a message is created', async () => {
    const before = await get('/api/messages/chan-102?limit=100');
    for (const bad of [
      { question: '', answers: ['a', 'b'] },
      { question: 'q', answers: ['only one'] },
      { question: 'q', answers: [] },
      { question: 'q', answers: Array.from({ length: 11 }, (_, i) => `a${i}`) },
      { question: 'q', answers: ['a', 'b'], durationHours: -5 },
      { question: 'x'.repeat(301), answers: ['a', 'b'] }
    ]) {
      const { status } = await makePoll(bad);
      assert.equal(status, 400, `expected 400 for ${JSON.stringify(bad).slice(0, 60)}`);
    }
    const after = await get('/api/messages/chan-100?limit=100');
    void before; void after;

    // The important half: a rejected poll must not leave an orphan message.
    const history = await get('/api/messages/chan-102?limit=100');
    const empty = history.body.filter((m) => m.type === 'poll' && !m.poll);
    assert.equal(empty.length, 0, 'a rejected poll left a message behind');
  });

  test('voting requires being able to see the channel', async () => {
    const { body } = await makePoll({ question: 'ฎ', answers: ['A', 'B'] });
    const [a] = body.poll.answers;
    const res = await fetch(`${BASE}/api/polls/${body.id}/vote`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ answer_ids: [a.id] })
    });
    assert.equal(res.status, 401, 'an anonymous caller must not be able to vote');
  });
});

// ---------------------------------------------------------------------------
// Voice notes.
//
// The waveform is the only field the client is the authority on, which makes it
// the one that has to be clamped. These pin the clamping, and the rule that a
// waveform is what marks an attachment as a voice note rather than a file.
// ---------------------------------------------------------------------------

describe('voice notes', () => {
  const OGG = Buffer.from('T2dnUwACAAAAAAAAAAA=', 'base64');   // an OggS header

  test('a waveform round-trips and marks the attachment as a voice note', async () => {
    const upload = await uploadFile(OGG, 'note.ogg', 'audio/ogg');
    if (upload.status !== 200) return;      // the sniffer may reject a stub file
    const descriptor = upload.body.attachments[0];

    const waveform = [0, 25, 50, 75, 100, 60, 20];
    const { status, body } = await api('POST', '/api/messages', {
      channel_id: 'chan-102',
      attachments: [{ ...descriptor, waveform }]
    });
    assert.equal(status, 200);
    assert.deepEqual(body.attachments[0].waveform, waveform);
  });

  test('a waveform is capped and clamped', async () => {
    const upload = await uploadFile(OGG, 'long.ogg', 'audio/ogg');
    if (upload.status !== 200) return;
    const descriptor = upload.body.attachments[0];

    const hostile = Array.from({ length: 5000 }, (_, i) => (i % 2 ? 999 : -50));
    const { body } = await api('POST', '/api/messages', {
      channel_id: 'chan-102',
      attachments: [{ ...descriptor, waveform: hostile }]
    });

    const stored = body.attachments[0].waveform;
    assert.ok(stored.length <= 64, `expected at most 64 points, got ${stored.length}`);
    for (const value of stored) {
      assert.ok(value >= 0 && value <= 100, `value ${value} escaped the 0–100 clamp`);
    }
  });

  test('an ordinary attachment carries no waveform', async () => {
    const upload = await uploadFile(PNG, 'plain.png', 'image/png');
    const { body } = await api('POST', '/api/messages', {
      channel_id: 'chan-102',
      attachments: [upload.body.attachments[0]]
    });
    assert.equal(body.attachments[0].waveform, null);
  });

  test('junk in a waveform does not reach storage', async () => {
    const upload = await uploadFile(OGG, 'junk.ogg', 'audio/ogg');
    if (upload.status !== 200) return;
    const { body } = await api('POST', '/api/messages', {
      channel_id: 'chan-102',
      attachments: [{
        ...upload.body.attachments[0],
        waveform: ['x', null, undefined, {}, 42]
      }]
    });
    const stored = body.attachments[0].waveform;
    assert.ok(stored.every((n) => Number.isFinite(n)), 'a non-number survived');
  });
});

// ---------------------------------------------------------------------------
// Scheduled events, private notes, friend-request notes, profile privacy.
// ---------------------------------------------------------------------------

const inHours = (h) => new Date(Date.now() + h * 3600 * 1000).toISOString();
const as = (id) => ({ 'x-user-id': id });

describe('scheduled events', () => {
  test('creating an event marks the creator interested', async () => {
    const { status, body } = await api('POST', '/api/servers/server-1/events', {
      name: 'Game night', channel_id: 'chan-104', starts_at: inHours(2)
    });
    assert.equal(status, 201);
    assert.equal(body.status, 'scheduled');
    assert.equal(body.interested, true);
    assert.equal(body.interested_count, 1);
    assert.equal(body.channel.type, 'voice');
  });

  test('interest is idempotent in both directions', async () => {
    const { body } = await api('POST', '/api/servers/server-1/events', {
      name: 'x', location: 'somewhere', starts_at: inHours(3)
    });
    const on1 = await api('PUT', `/api/events/${body.id}/interest`, { interested: true }, as('user-2'));
    const on2 = await api('PUT', `/api/events/${body.id}/interest`, { interested: true }, as('user-2'));
    assert.equal(on1.body.interested_count, 2);
    assert.equal(on2.body.interested_count, 2, 'a repeated "interested" must not double-count');
    const off = await api('PUT', `/api/events/${body.id}/interest`, { interested: false }, as('user-2'));
    assert.equal(off.body.interested_count, 1);
  });

  test('only MANAGE_GUILD may create, edit or cancel', async () => {
    const created = await api('POST', '/api/servers/server-1/events',
      { name: 'x', location: 'y', starts_at: inHours(1) }, as('user-5'));
    assert.equal(created.status, 403);

    const mine = await api('POST', '/api/servers/server-1/events',
      { name: 'x', location: 'y', starts_at: inHours(1) });
    const edited = await api('PATCH', `/api/events/${mine.body.id}`, { name: 'z' }, as('user-5'));
    assert.equal(edited.status, 403);
    const cancelled = await api('DELETE', `/api/events/${mine.body.id}`, undefined, as('user-5'));
    assert.equal(cancelled.status, 403);
  });

  test('a text channel is not a venue', async () => {
    const { status } = await api('POST', '/api/servers/server-1/events',
      { name: 'x', channel_id: 'chan-102', starts_at: inHours(1) });
    assert.equal(status, 400);
  });

  test('an event needs somewhere to happen', async () => {
    const { status } = await api('POST', '/api/servers/server-1/events',
      { name: 'x', starts_at: inHours(1) });
    assert.equal(status, 400);
  });

  test('the past is refused; the immediate future is not', async () => {
    const past = await api('POST', '/api/servers/server-1/events',
      { name: 'x', location: 'y', starts_at: '2001-01-01T00:00:00Z' });
    assert.equal(past.status, 400);
    const soon = await api('POST', '/api/servers/server-1/events',
      { name: 'x', location: 'y', starts_at: new Date(Date.now() + 30_000).toISOString() });
    assert.equal(soon.status, 201);
  });

  test('a channel event goes live at its start time, on read', async () => {
    const { body } = await api('POST', '/api/servers/server-1/events',
      { name: 'x', channel_id: 'chan-104', starts_at: inHours(1), ends_at: inHours(3) });
    const { runQuery } = await import('../db.js');
    await runQuery(`UPDATE scheduled_events SET starts_at = ? WHERE id = ?`,
      [new Date(Date.now() - 60_000).toISOString(), body.id]);
    const read = await get(`/api/events/${body.id}`);
    assert.equal(read.body.status, 'active');
  });

  test('an external event never goes "active" — nobody is there to start it', async () => {
    const { body } = await api('POST', '/api/servers/server-1/events',
      { name: 'x', location: 'the park', starts_at: inHours(1), ends_at: inHours(3) });
    const { runQuery } = await import('../db.js');
    await runQuery(`UPDATE scheduled_events SET starts_at = ? WHERE id = ?`,
      [new Date(Date.now() - 60_000).toISOString(), body.id]);
    const read = await get(`/api/events/${body.id}`);
    assert.equal(read.body.status, 'scheduled');
  });

  test('an event completes an hour after start when it has no end time', async () => {
    const { body } = await api('POST', '/api/servers/server-1/events',
      { name: 'x', channel_id: 'chan-104', starts_at: inHours(1) });
    const { runQuery } = await import('../db.js');
    await runQuery(`UPDATE scheduled_events SET starts_at = ? WHERE id = ?`,
      [new Date(Date.now() - 2 * 3600_000).toISOString(), body.id]);
    const read = await get(`/api/events/${body.id}`);
    assert.equal(read.body.status, 'completed');
    const late = await api('PUT', `/api/events/${body.id}/interest`, { interested: true }, as('user-2'));
    assert.equal(late.status, 409);
  });

  test('cancelling a live event ends it rather than cancelling it', async () => {
    const { body } = await api('POST', '/api/servers/server-1/events',
      { name: 'x', channel_id: 'chan-104', starts_at: inHours(1), ends_at: inHours(3) });
    const { runQuery } = await import('../db.js');
    await runQuery(`UPDATE scheduled_events SET starts_at = ? WHERE id = ?`,
      [new Date(Date.now() - 60_000).toISOString(), body.id]);
    const ended = await api('DELETE', `/api/events/${body.id}`);
    assert.equal(ended.body.status, 'completed');
  });

  test('the upcoming list hides finished events; the archive shows them', async () => {
    const before = await get('/api/servers/server-1/events');
    const finished = before.body.filter((e) => ['completed', 'cancelled'].includes(e.status));
    assert.equal(finished.length, 0, 'the default list must be forward-looking');
    const archive = await get('/api/servers/server-1/events?past=1');
    assert.ok(archive.body.length > before.body.length);
  });
});

describe('private notes and profile privacy', () => {
  test('a note is visible only to its author', async () => {
    await api('PUT', '/api/users/user-2/note', { note: 'met at the LAN' });
    const mine = await get('/api/users/user-2');
    assert.equal(mine.body.my_note, 'met at the LAN');
    const theirs = await get('/api/users/user-2', as('user-5'));
    assert.equal(theirs.body.my_note, '', 'another viewer must never see my note');
  });

  test('an empty note deletes it; a note on yourself is refused', async () => {
    await api('PUT', '/api/users/user-2/note', { note: '' });
    const cleared = await get('/api/users/user-2');
    assert.equal(cleared.body.my_note, '');
    const self = await api('PUT', '/api/users/user-me/note', { note: 'me' });
    assert.equal(self.status, 400);
  });

  test('a friend request can carry a note', async () => {
    const { status, body } = await api('POST', '/api/friends/requests',
      { targetId: 'user-2', note: 'we met yesterday' }, as('user-5'));
    assert.equal(status, 200);
    assert.equal(body.request_note, 'we met yesterday');
  });

  test('a friends-only profile hides its bio from strangers but not friends', async () => {
    await api('PUT', '/api/users/user-2', { profile_visibility: 'friends' }, as('user-2'));

    const friend = await get('/api/users/user-2');            // user-me is user-2's friend
    assert.ok(friend.body.bio, 'a friend should still see the bio');
    assert.equal(friend.body.profile_hidden, undefined);

    const stranger = await get('/api/users/user-2', as('user-5'));
    assert.equal(stranger.body.bio, null);
    assert.equal(stranger.body.profile_hidden, true);
    // Identity is never hidden — you must be able to tell who someone is.
    assert.ok(stranger.body.username);
    assert.ok(stranger.body.avatar_url);

    const self = await get('/api/users/user-2', as('user-2'));
    assert.ok(self.body.bio, 'you always see your own profile');

    await api('PUT', '/api/users/user-2', { profile_visibility: 'everyone' }, as('user-2'));
  });

  test('an unknown visibility value is refused', async () => {
    const { status } = await api('PUT', '/api/users/user-2', { profile_visibility: 'nobody' }, as('user-2'));
    assert.equal(status, 400);
  });
});

// ---------------------------------------------------------------------------
// Vanity URLs, verification levels, role icons.
// ---------------------------------------------------------------------------

describe('vanity URL', () => {
  test('a slug is normalised, validated and unique', async () => {
    const ok = await api('PATCH', '/api/servers/server-1', { vanity_url: 'Antigravity-HQ' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.vanity_url, 'antigravity-hq', 'slugs are lowercased');

    for (const bad of ['has space', 'ünïcode', '-leading', 'trailing-', 'a', 'x'.repeat(40)]) {
      const { status } = await api('PATCH', '/api/servers/server-1', { vanity_url: bad });
      assert.equal(status, 400, `expected 400 for ${JSON.stringify(bad)}`);
    }
    const still = await get('/api/servers/server-1');
    assert.equal(still.body.server.vanity_url, 'antigravity-hq', 'a rejected write must not touch the stored slug');

    // server-2 is owned by user-2; the slug is already taken by server-1
    const taken = await api('PATCH', '/api/servers/server-2', { vanity_url: 'antigravity-hq' }, as('user-2'));
    assert.equal(taken.status, 409);
  });

  test('a vanity slug works anywhere an invite code does', async () => {
    const preview = await get('/api/invites/antigravity-hq', as('user-5'));
    assert.equal(preview.status, 200);
    assert.equal(preview.body.vanity, true);
    assert.equal(preview.body.server.id, 'server-1');
    assert.equal(preview.body.expires_at, null, 'a vanity link never expires');
  });

  test('clearing the slug releases it', async () => {
    await api('PATCH', '/api/servers/server-1', { vanity_url: null });
    const gone = await get('/api/invites/antigravity-hq');
    assert.equal(gone.status, 404);
  });
});

describe('verification level', () => {
  test('a high level keeps out a brand-new, unverified account', async () => {
    // A fresh account: unverified e-mail, seconds old, no MFA.
    const unique = `newbie${Date.now().toString(36)}`;
    const reg = await api('POST', '/api/auth/register', { username: unique, password: 'a-good-password' });
    const token = reg.body.token;

    // Invite to server-3 (owned by user-me), then raise the bar.
    const invite = await api('POST', '/api/servers/server-3/invites', {});
    const code = invite.body.code;

    await api('PATCH', '/api/servers/server-3', { verification_level: 1 });
    const refused = await asSession(token, 'POST', `/api/invites/${code}/accept`);
    assert.equal(refused.status, 403);
    assert.equal(refused.body.code, 'VERIFICATION_EMAIL');

    await api('PATCH', '/api/servers/server-3', { verification_level: 0 });
    const allowed = await asSession(token, 'POST', `/api/invites/${code}/accept`);
    assert.equal(allowed.status, 200, 'level 0 must let anyone in');
  });

  test('an out-of-range level is refused', async () => {
    assert.equal((await api('PATCH', '/api/servers/server-1', { verification_level: 9 })).status, 400);
    assert.equal((await api('PATCH', '/api/servers/server-1', { verification_level: -1 })).status, 400);
  });

  test('afk_timeout accepts only the offered presets', async () => {
    assert.equal((await api('PATCH', '/api/servers/server-1', { afk_timeout: 300 })).status, 200);
    assert.equal((await api('PATCH', '/api/servers/server-1', { afk_timeout: 123 })).status, 400);
  });
});

describe('role icons', () => {
  test('the highest role with an icon is surfaced on the member', async () => {
    const { runQuery } = await import('../db.js');
    await runQuery(`UPDATE roles SET icon_url = '/uploads/emojis/x.png' WHERE id = 'role-1-dev'`);
    const { body } = await get('/api/servers/server-1/members');
    const me = body.find((m) => m.id === 'user-me');
    assert.ok(me.role_icon, 'expected a role_icon on a member holding an iconed role');
    assert.equal(me.role_icon.url, '/uploads/emojis/x.png');
    await runQuery(`UPDATE roles SET icon_url = NULL WHERE id = 'role-1-dev'`);
  });
});

describe('AFK sweep', () => {
  test('idle users are moved to the AFK channel; fresh and unknown users are not', async () => {
    const { runQuery, getQuery } = await import('../db.js');
    const { sweepAfk, __markIdle } = await import('../realtime.js');
    const emitted = [];
    const fakeIo = {
      to: () => ({ emit: (name, payload) => emitted.push([name, payload]) }),
      sockets: { sockets: new Map() }
    };

    // server-1: chan-104 is a voice channel; create a dedicated AFK channel.
    await runQuery(`INSERT OR IGNORE INTO channels (id, server_id, name, type, position, created_at)
                    VALUES ('chan-afk', 'server-1', 'AFK', 'voice', 99, datetime('now'))`);
    await runQuery(`UPDATE servers SET afk_channel_id = 'chan-afk', afk_timeout = 60 WHERE id = 'server-1'`);
    await runQuery(`DELETE FROM voice_states WHERE user_id IN ('user-2', 'user-3')`);
    await runQuery(`INSERT INTO voice_states (user_id, server_id, channel_id, session_id) VALUES ('user-2', 'server-1', 'chan-104', 's2')`);
    await runQuery(`INSERT INTO voice_states (user_id, server_id, channel_id, session_id) VALUES ('user-3', 'server-1', 'chan-104', 's3')`);

    __markIdle('user-2', 5 * 60 * 1000);     // silent for five minutes
    // user-3 has never been observed by this process: first sweep must only start their clock.

    const moved = await sweepAfk(fakeIo);
    assert.equal(moved, 1);
    assert.equal((await getQuery(`SELECT channel_id FROM voice_states WHERE user_id = 'user-2'`)).channel_id, 'chan-afk');
    assert.equal((await getQuery(`SELECT channel_id FROM voice_states WHERE user_id = 'user-3'`)).channel_id, 'chan-104');

    // Second sweep: user-2 is already in AFK (excluded), user-3 is fresh.
    assert.equal(await sweepAfk(fakeIo), 0);

    await runQuery(`UPDATE servers SET afk_channel_id = NULL WHERE id = 'server-1'`);
    await runQuery(`DELETE FROM voice_states WHERE user_id IN ('user-2', 'user-3')`);
  });
});

// ---------------------------------------------------------------------------
// Forum channels — a post is a thread with a body; tags are per-forum.
// ---------------------------------------------------------------------------

describe('forum channels', () => {
  const FORUM = 'chan-106';
  let postId;

  test('seeded tags are listed; moderated flag survives', async () => {
    const { status, body } = await get(`/api/channels/${FORUM}/forum/tags`);
    assert.equal(status, 200);
    assert.deepEqual(body.map((t) => t.name), ['Question', 'Bug', 'Solved']);
    assert.equal(body.find((t) => t.name === 'Solved').moderated, true);
  });

  test('a forum refuses plain messages — you create a post instead', async () => {
    const r = await api('POST', '/api/messages', { channel_id: FORUM, content: 'hi' });
    assert.equal(r.status, 400);
    assert.equal(r.body.code, 'FORUM_NEEDS_POST');
  });

  test('creating a post makes a thread whose first message is the body, with tags', async () => {
    const r = await api('POST', `/api/channels/${FORUM}/forum/posts`, {
      title: 'How do I set up voice?', content: 'My mic is not detected.', tag_ids: ['tag-106-question']
    }, as('user-5'));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    postId = r.body.post.id;
    assert.equal(r.body.post.name, 'How do I set up voice?');
    assert.equal(r.body.post.author.id, 'user-5');
    assert.equal(r.body.post.preview, 'My mic is not detected.');
    assert.deepEqual(r.body.post.tags.map((t) => t.id), ['tag-106-question']);
    assert.equal(r.body.post.reply_count, 0);
    assert.equal(r.body.message.channel_id, postId);

    // It is a real thread: the generic thread endpoint knows it.
    const th = await get(`/api/threads/${postId}`, as('user-5'));
    assert.equal(th.status, 200);
    assert.equal(th.body.parent_id, FORUM);
  });

  test('a post needs a title and a body', async () => {
    assert.equal((await api('POST', `/api/channels/${FORUM}/forum/posts`, { content: 'x' })).status, 400);
    assert.equal((await api('POST', `/api/channels/${FORUM}/forum/posts`, { title: 'x' })).status, 400);
  });

  test('members cannot apply a moderated tag; staff can', async () => {
    const denied = await api('POST', `/api/channels/${FORUM}/forum/posts`, {
      title: 'Cheeky', content: 'marking myself solved', tag_ids: ['tag-106-solved']
    }, as('user-5'));
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, 'TAG_MODERATED');

    const staff = await api('PUT', `/api/forum/posts/${postId}/tags`, { tag_ids: ['tag-106-question', 'tag-106-solved'] });
    assert.equal(staff.status, 200);
    assert.deepEqual(staff.body.tags.map((t) => t.name).sort(), ['Question', 'Solved']);
  });

  test('replies bump activity; the list sorts, filters by tag and searches', async () => {
    const older = await api('POST', `/api/channels/${FORUM}/forum/posts`, {
      title: 'Older bug report', content: 'Crash on start', tag_ids: ['tag-106-bug']
    }, as('user-5'));
    assert.equal(older.status, 201);
    // Reply on the first post so it is the most recently active.
    await new Promise((r) => setTimeout(r, 20));
    const reply = await api('POST', '/api/messages', { channel_id: postId, content: 'Try unplugging it.' });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));

    const byActivity = await get(`/api/channels/${FORUM}/forum/posts?sort=latest_activity`);
    assert.equal(byActivity.body.posts[0].id, postId);
    assert.equal(byActivity.body.posts[0].reply_count, 1);

    const byCreated = await get(`/api/channels/${FORUM}/forum/posts?sort=creation_date`);
    assert.equal(byCreated.body.posts[0].id, older.body.post.id, 'newest post first by creation date');

    const bugs = await get(`/api/channels/${FORUM}/forum/posts?tags=tag-106-bug`);
    assert.deepEqual(bugs.body.posts.map((p) => p.id), [older.body.post.id]);

    const found = await get(`/api/channels/${FORUM}/forum/posts?q=unplugging`);
    assert.deepEqual(found.body.posts.map((p) => p.id), [postId], 'search covers replies too');
  });

  test('pinned posts float to the top; only staff may pin', async () => {
    const list = await get(`/api/channels/${FORUM}/forum/posts?sort=creation_date`);
    const bottom = list.body.posts[list.body.posts.length - 1].id;
    assert.equal((await api('PUT', `/api/forum/posts/${bottom}/pin`, { pinned: true }, as('user-5'))).status, 403);
    const pinned = await api('PUT', `/api/forum/posts/${bottom}/pin`, { pinned: true });
    assert.equal(pinned.status, 200);
    assert.equal(pinned.body.pinned, true);
    const after = await get(`/api/channels/${FORUM}/forum/posts?sort=creation_date`);
    assert.equal(after.body.posts[0].id, bottom);
    await api('PUT', `/api/forum/posts/${bottom}/pin`, { pinned: false });
  });

  test('tag CRUD is MANAGE_CHANNELS-only and names are unique per forum', async () => {
    assert.equal((await api('POST', `/api/channels/${FORUM}/forum/tags`, { name: 'Nope' }, as('user-5'))).status, 403);
    const made = await api('POST', `/api/channels/${FORUM}/forum/tags`, { name: 'Feature', emoji: '✨' });
    assert.equal(made.status, 201);
    assert.equal((await api('POST', `/api/channels/${FORUM}/forum/tags`, { name: 'feature' })).status, 409);
    const renamed = await api('PATCH', `/api/channels/${FORUM}/forum/tags/${made.body.id}`, { name: 'Idea' });
    assert.equal(renamed.body.name, 'Idea');
    assert.equal((await api('DELETE', `/api/channels/${FORUM}/forum/tags/${made.body.id}`)).status, 200);
    const tags = await get(`/api/channels/${FORUM}/forum/tags`);
    assert.equal(tags.body.length, 3);
  });

  test('require_tag forum setting is enforced on create', async () => {
    assert.equal((await api('PATCH', `/api/channels/${FORUM}/forum`, { require_tag: true })).status, 200);
    const bare = await api('POST', `/api/channels/${FORUM}/forum/posts`, { title: 'No tag', content: 'body' }, as('user-5'));
    assert.equal(bare.status, 400);
    assert.equal(bare.body.code, 'TAG_REQUIRED');
    await api('PATCH', `/api/channels/${FORUM}/forum`, { require_tag: false });
  });
});

describe('media channels', () => {
  test('a media channel is a forum with the gallery layout', async () => {
    const made = await api('POST', '/api/channels', { server_id: 'server-1', name: 'Showcase', type: 'media' });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    assert.equal(made.body.type, 'forum');
    assert.equal(made.body.default_layout, 'gallery');
    // Every forum route applies to it.
    const tags = await get(`/api/channels/${made.body.id}/forum/tags`);
    assert.equal(tags.status, 200);
    const flipped = await api('PATCH', `/api/channels/${made.body.id}/forum`, { default_layout: 'list' });
    assert.equal(flipped.body.default_layout, 'list');
    assert.equal((await api('PATCH', `/api/channels/${made.body.id}/forum`, { default_layout: 'mosaic' })).status, 400);
  });
});

// ---------------------------------------------------------------------------
// Membership screening, welcome screen, onboarding.
// ---------------------------------------------------------------------------

describe('onboarding', () => {
  let token; let userId; let code;

  test('staff configure rules, welcome screen and prompts; validation holds', async () => {
    const S = '/api/servers/server-3/onboarding';
    // Non-staff cannot edit.
    assert.equal((await api('PATCH', `${S}/screening`, { enabled: true, rules: ['Be kind'] }, as('user-2'))).status, 403);
    // Screening cannot be enabled without a rule.
    const noRules = await api('PATCH', `${S}/screening`, { enabled: true, rules: [] });
    assert.equal(noRules.status, 400);
    assert.equal(noRules.body.code, 'RULES_REQUIRED');

    const screening = await api('PATCH', `${S}/screening`, { enabled: true, rules: ['Be kind', 'No spam'] });
    assert.equal(screening.status, 200);
    assert.deepEqual(screening.body.screening, { enabled: true, rules: ['Be kind', 'No spam'] });

    // Welcome screen: description + up to five channels.
    const servers = await get('/api/servers/server-3');
    const textChan = servers.body.channels.find((c) => c.type === 'text');
    const welcome = await api('PATCH', `${S}/welcome`, {
      enabled: true, description: 'A place to test onboarding',
      channels: [{ channel_id: textChan.id, description: 'Say hi here', emoji: '👋' }]
    });
    assert.equal(welcome.status, 200, JSON.stringify(welcome.body));
    assert.equal(welcome.body.welcome.channels[0].name, textChan.name);
    assert.equal((await api('PATCH', `${S}/welcome`, { channels: [{ channel_id: 'nope', description: 'x' }] })).status, 400);

    // Prompts grant a role + a channel pick.
    const role = await api('POST', '/api/servers/server-3/roles', { name: 'Gamer' });
    assert.equal(role.status, 200, JSON.stringify(role.body));
    const prompts = await api('PUT', `${S}/prompts`, {
      prompts: [{
        title: 'What brings you here?', single_select: true, required: true,
        options: [
          { title: 'Gaming', emoji: '🎮', role_ids: [role.body.id], channel_ids: [textChan.id] },
          { title: 'Just looking', emoji: '👀' }
        ]
      }]
    });
    assert.equal(prompts.status, 200, JSON.stringify(prompts.body));
    assert.equal(prompts.body.prompts.length, 1);
    assert.equal(prompts.body.prompts[0].options.length, 2);
    assert.equal((await api('PUT', `${S}/prompts`, { prompts: [{ title: 'Empty', options: [] }] })).status, 400);
  });

  test('a newcomer joins as pending: can read, cannot speak', async () => {
    const reg = await api('POST', '/api/auth/register', { username: `newb${Date.now().toString(36)}`, password: 'a-good-password' });
    token = reg.body.token; userId = reg.body.user.id;
    code = (await api('POST', '/api/servers/server-3/invites', {})).body.code;
    const joined = await asSession(token, 'POST', `/api/invites/${code}/accept`);
    assert.equal(joined.status, 200, JSON.stringify(joined.body));
    assert.equal(joined.body.viewer_pending, true);
    assert.equal(joined.body.has_onboarding, true);

    const textChan = joined.body.channels.find((c) => c.type === 'text');
    const read = await asSession(token, 'GET', `/api/messages/${textChan.id}`);
    assert.equal(read.status, 200, 'pending members may read');
    const speak = await asSession(token, 'POST', '/api/messages', { channel_id: textChan.id, content: 'hello?' });
    assert.equal(speak.status, 403, 'pending members may not send');

    const roster = await get('/api/servers/server-3/members');
    assert.equal(roster.body.find((m) => m.id === userId).pending, true);
  });

  test('completing onboarding requires the rules and required prompts, then grants', async () => {
    const S = '/api/servers/server-3/onboarding';
    const bundle = await asSession(token, 'GET', S);
    assert.equal(bundle.body.me.pending, true);
    const prompt = bundle.body.prompts[0];
    const gaming = prompt.options.find((o) => o.title === 'Gaming');

    const noRules = await asSession(token, 'PUT', `${S}/complete`, { accept_rules: false, answers: { [prompt.id]: [gaming.id] } });
    assert.equal(noRules.body.code, 'RULES_NOT_ACCEPTED');
    const noAnswer = await asSession(token, 'PUT', `${S}/complete`, { accept_rules: true, answers: {} });
    assert.equal(noAnswer.body.code, 'ANSWER_REQUIRED');
    const twoAnswers = await asSession(token, 'PUT', `${S}/complete`, {
      accept_rules: true, answers: { [prompt.id]: prompt.options.map((o) => o.id) }
    });
    assert.equal(twoAnswers.body.code, 'ANSWER_INVALID', 'single-select takes one answer');

    const done = await asSession(token, 'PUT', `${S}/complete`, { accept_rules: true, answers: { [prompt.id]: [gaming.id] } });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.viewer_pending, false);
    assert.deepEqual(done.body.picked_channel_ids, gaming.channel_ids);
    assert.deepEqual(done.body.granted_role_ids, gaming.role_ids);

    const textChan = done.body.channels.find((c) => c.type === 'text');
    const speak = await asSession(token, 'POST', '/api/messages', { channel_id: textChan.id, content: 'hello!' });
    assert.equal(speak.status, 200, 'after onboarding the member may send');

    // Changing the answer swaps the onboarding role away again.
    const looking = prompt.options.find((o) => o.title === 'Just looking');
    const redo = await asSession(token, 'PUT', `${S}/complete`, { accept_rules: true, answers: { [prompt.id]: [looking.id] } });
    assert.deepEqual(redo.body.granted_role_ids, []);
    const roster = await get('/api/servers/server-3/members');
    const me = roster.body.find((m) => m.id === userId);
    assert.ok(!me.roles.some((r) => gaming.role_ids.includes(r.id)), 'onboarding role removed when deselected');
  });

  test('turning screening off lets new joiners in directly', async () => {
    await api('PATCH', '/api/servers/server-3/onboarding/screening', { enabled: false });
    const reg = await api('POST', '/api/auth/register', { username: `direct${Date.now().toString(36)}`, password: 'a-good-password' });
    const joined = await asSession(reg.body.token, 'POST', `/api/invites/${code}/accept`);
    assert.equal(joined.body.viewer_pending, false);
  });
});

// ---------------------------------------------------------------------------
// Channel following: announcements relayed into another server.
// ---------------------------------------------------------------------------

describe('channel following', () => {
  let followId;
  const SRC = 'chan-101';   // server-1 #welcome-announcements
  const DST = 'chan-201';   // server-2 #lobby (user-2 is admin in both)

  test('following needs an announcement source and MANAGE_WEBHOOKS in the target', async () => {
    const notAnn = await api('POST', `/api/channels/chan-102/followers`, { target_channel_id: DST }, as('user-2'));
    assert.equal(notAnn.status, 400);
    assert.equal(notAnn.body.code, 'NOT_ANNOUNCEMENT');
    // user-me is only VIP in server-2: no MANAGE_WEBHOOKS there.
    assert.equal((await api('POST', `/api/channels/${SRC}/followers`, { target_channel_id: DST })).status, 403);

    const made = await api('POST', `/api/channels/${SRC}/followers`, { target_channel_id: DST }, as('user-2'));
    assert.equal(made.status, 201, JSON.stringify(made.body));
    followId = made.body.id;
    assert.ok(made.body.source_server_name, 'source server name is resolved');
    assert.equal((await api('POST', `/api/channels/${SRC}/followers`, { target_channel_id: DST }, as('user-2'))).status, 409);

    const followers = await get(`/api/channels/${SRC}/followers`);
    assert.equal(followers.body.length, 1);
    const following = await get('/api/servers/server-2/following', as('user-2'));
    assert.equal(following.body[0].target_channel_id, DST);
  });

  test('publishing relays the message as the source server; publish is idempotent', async () => {
    const posted = await api('POST', '/api/messages', { channel_id: SRC, content: 'Patch 1.2 is live!' });
    assert.equal(posted.status, 200);
    const before = (await get(`/api/messages/${DST}`, as('user-2'))).body.length;

    const pub = await api('POST', `/api/messages/${posted.body.id}/crosspost`, {});
    assert.equal(pub.status, 200, JSON.stringify(pub.body));
    assert.equal(pub.body.relayed.length, 1);
    assert.equal(pub.body.message.crossposted, true);

    const copy = pub.body.relayed[0];
    assert.equal(copy.channel_id, DST);
    assert.equal(copy.content, 'Patch 1.2 is live!');
    assert.equal(copy.is_webhook, true);
    assert.equal(copy.webhook_type, 'follower');
    assert.ok(copy.display_name.includes('#welcome-announcements'), copy.display_name);

    const again = await api('POST', `/api/messages/${posted.body.id}/crosspost`, {});
    assert.equal(again.body.relayed.length, 0, 'second publish relays nothing new');
    const after = (await get(`/api/messages/${DST}`, as('user-2'))).body.length;
    assert.equal(after, before + 1);

    // Deleting the original removes the copy.
    await api('DELETE', `/api/messages/${posted.body.id}`);
    const gone = await get(`/api/messages/${DST}`, as('user-2'));
    assert.ok(!gone.body.some((m) => m.id === copy.id), 'relayed copy retracted');
  });

  test('unfollowing stops future relays', async () => {
    assert.equal((await api('DELETE', `/api/follows/${followId}`, undefined, as('user-2'))).status, 200);
    const posted = await api('POST', '/api/messages', { channel_id: SRC, content: 'After unfollow' });
    const pub = await api('POST', `/api/messages/${posted.body.id}/crosspost`, {});
    assert.equal(pub.body.relayed.length, 0);
    assert.equal(pub.body.followers, 0);
  });
});

// ---------------------------------------------------------------------------
// Cross-server emoji: usable with USE_EXTERNAL_EMOJIS, refused otherwise.
// ---------------------------------------------------------------------------

describe('external emoji', () => {
  let emojiId;
  test('my emoji list is grouped by server and unknown ids are refused', async () => {
    const { runQuery } = await import('../db.js');
    emojiId = `9${Date.now()}`;   // emoji ids are numeric snowflakes; <:name:id> only matches digits
    await runQuery(`INSERT INTO emojis (id, server_id, name, url) VALUES (?, 'server-2', 'party', '/uploads/emojis/party.png')`, [emojiId]);

    const mine = await get('/api/users/@me/emojis');
    assert.equal(mine.status, 200);
    const s2 = mine.body.find((g) => g.server_id === 'server-2');
    assert.ok(s2 && s2.emojis.some((e) => e.id === emojiId), 'server-2 group lists the emoji');

    const img = await fetch(`${BASE}/api/emojis/${emojiId}/image`, { redirect: 'manual' });
    assert.equal(img.status, 302);
    assert.equal(img.headers.get('location'), '/uploads/emojis/party.png');

    const bad = await api('POST', '/api/messages', { channel_id: 'chan-102', content: 'hey <:nope:123456>' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'EMOJI_UNKNOWN');
  });

  test('a server-2 emoji in server-1 needs USE_EXTERNAL_EMOJIS and membership', async () => {
    // user-me is in both servers and admin in server-1: allowed.
    const ok = await api('POST', '/api/messages', { channel_id: 'chan-102', content: `party <:party:${emojiId}>` });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));

    // user-5 is in server-1 only: not a member of the emoji's server.
    const notMember = await api('POST', '/api/messages', { channel_id: 'chan-102', content: `<:party:${emojiId}>` }, as('user-5'));
    assert.equal(notMember.status, 403);

    // Take USE_EXTERNAL_EMOJIS away from @everyone in server-1; user-4 (mod, in both servers) loses it.
    const everyone = await get('/api/servers/server-1/roles');
    const role = everyone.body.find((r) => r.id === 'server-1');
    const { fromNames, toNames } = await import('../lib/permissions.js');
    const names = toNames(role.permissions).filter((n) => n !== 'USE_EXTERNAL_EMOJIS');
    const patched = await api('PATCH', '/api/servers/server-1/roles/server-1', { permissions: fromNames(names) });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
    const denied = await api('POST', '/api/messages', { channel_id: 'chan-102', content: `<:party:${emojiId}>` }, as('user-4'));
    assert.equal(denied.status, 403, JSON.stringify(denied.body));
    // Restore.
    await api('PATCH', '/api/servers/server-1/roles/server-1', { permissions: role.permissions });
    const restored = await api('POST', '/api/messages', { channel_id: 'chan-102', content: `<:party:${emojiId}>` }, as('user-4'));
    assert.equal(restored.status, 200);
  });
});

// ---------------------------------------------------------------------------
// Server templates + server-folder layout preference.
// ---------------------------------------------------------------------------

describe('server templates', () => {
  let code;
  test('MANAGE_GUILD creates one template per server; the snapshot has structure only', async () => {
    assert.equal((await api('POST', '/api/servers/server-1/template', { name: 'Nope' }, as('user-5'))).status, 403);
    const made = await api('POST', '/api/servers/server-1/template', { name: 'Gaming starter', description: 'Roles + channels' });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    code = made.body.code;
    assert.ok(made.body.channel_count >= 5, 'channels counted');
    assert.ok(made.body.role_count >= 3, 'roles counted');
    assert.equal(made.body.usage_count, 0);

    // Creating again updates the same template rather than making a second.
    const again = await api('POST', '/api/servers/server-1/template', { name: 'Gaming starter v2' });
    assert.equal(again.body.code, code);
    assert.equal(again.body.name, 'Gaming starter v2');

    const preview = await get(`/api/templates/${code}`, as('user-2'));
    assert.equal(preview.status, 200);
    assert.ok(preview.body.preview.channels.some((c) => c.name === 'help-forum' && c.type === 'forum'));
    assert.ok(!JSON.stringify(preview.body.preview).includes('user-'), 'no member data leaks into the template body');
    assert.equal(preview.body.creator_id, 'user-me');
  });

  test('using a template creates a server with re-mapped roles, channels, overwrites and tags', async () => {
    // Give the source an overwrite so we can prove it is re-mapped.
    const dev = await api('PUT', '/api/channels/chan-103/permissions/role/role-1-dev', { allow: '0', deny: String(1n << 11n) });
    assert.ok([200, 201].includes(dev.status), JSON.stringify(dev.body));
    await api('PUT', '/api/servers/server-1/template/sync');

    const created = await api('POST', `/api/templates/${code}/servers`, { name: 'From template' }, as('user-5'));
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const detail = created.body;
    assert.equal(detail.server.owner_id, 'user-5');
    assert.equal(detail.server.name, 'From template');
    assert.notEqual(detail.server.id, 'server-1');

    const roleNames = detail.roles.map((r) => r.name).sort();
    assert.ok(roleNames.includes('Developer') && roleNames.includes('@everyone'));
    const forum = detail.channels.find((c) => c.type === 'forum');
    assert.ok(forum, 'forum recreated');
    const tags = await get(`/api/channels/${forum.id}/forum/tags`, as('user-5'));
    assert.deepEqual(tags.body.map((t) => t.name), ['Question', 'Bug', 'Solved']);

    const memes = detail.channels.find((c) => c.name === 'memes-and-fun');
    const newDev = detail.roles.find((r) => r.name === 'Developer');
    const { allQuery } = await import('../db.js');
    const ow = await allQuery(`SELECT * FROM channel_overwrites WHERE channel_id = ?`, [memes.id]);
    assert.equal(ow.length, 1);
    assert.equal(ow[0].target_id, newDev.id, 'overwrite points at the *new* role id');
    assert.equal((await get(`/api/templates/${code}`)).body.usage_count, 1);

    // Categories keep their children.
    const cat = detail.categories.find((c) => c.name === 'TEXT CHANNELS');
    assert.ok(cat, 'category recreated');
    assert.ok(detail.channels.some((c) => c.parent_id === cat.id), 'children keep their category');
  });

  test('deleting the template frees the code', async () => {
    assert.equal((await api('DELETE', '/api/servers/server-1/template')).status, 200);
    assert.equal((await get(`/api/templates/${code}`)).status, 404);
  });
});

describe('server folders (layout preference)', () => {
  test('folders and order round-trip and are bounded', async () => {
    const saved = await api('PATCH', '/api/settings/preferences/layout', {
      serverFolders: [{ id: 'fa', name: 'Work', color: '#5865f2', serverIds: ['server-1', 'server-3'] }, { id: 'empty', serverIds: [] }],
      serverOrder: ['fa', 'server-2', 'server-2']
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const layout = saved.body.layout ?? saved.body;
    assert.equal(layout.serverFolders.length, 1, 'empty folders are dropped');
    assert.deepEqual(layout.serverOrder, ['fa', 'server-2'], 'duplicates removed');
    const bad = await api('PATCH', '/api/settings/preferences/layout', { serverFolders: [{ id: 'x', color: 'red', serverIds: ['s'] }] });
    assert.equal((bad.body.layout ?? bad.body).serverFolders[0].color, null, 'non-hex colour discarded');
  });
});

describe('build sanity', () => {
  test('the client’s EXPECTED_SCHEMA_VERSION matches db.js, and /api/health reports both', async () => {
    const fs = await import('node:fs');
    const { SCHEMA_VERSION } = await import('../db.js');
    const appSource = fs.readFileSync(new URL('../src/App.jsx', import.meta.url), 'utf8');
    const declared = Number(/const EXPECTED_SCHEMA_VERSION = (\d+)/.exec(appSource)?.[1]);
    assert.equal(declared, SCHEMA_VERSION,
      'src/App.jsx EXPECTED_SCHEMA_VERSION must be bumped with every db.js migration');

    const health = await get('/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.code_schema_version, SCHEMA_VERSION);
    assert.equal(health.body.schema_version, SCHEMA_VERSION, 'a migrated database is at the code version');
  });
});
