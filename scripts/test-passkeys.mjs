#!/usr/bin/env node
// ============================================================================
//  Passkeys (WebAuthn): registration, discoverable sign-in that skips TOTP,
//  step-up re-auth, challenge expiry / reuse, counter and origin checks,
//  cross-user isolation, audit trail.
//
//  A small software authenticator (ES256, "none" attestation) below produces
//  real WebAuthn responses, so @simplewebauthn/server verifies them for real.
// ============================================================================

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// This file's name has no digits, so pick its own port before the harness
// derives one (it would collide with scripts/test.mjs).
process.env.TEST_PORT ??= String(Number(process.env.TEST_PORT_BASE || 3900) + 71);
const RP_ID = 'localhost';
const ORIGIN = 'http://localhost:5173';
process.env.PASSKEYS_ENABLED = '1';
process.env.RP_ID = RP_ID;
process.env.RP_ORIGIN = ORIGIN;

const { startServer, stopServer, api, asSession } = await import('./testHarness.mjs');
const { generateCode } = await import('../lib/totp.js');
const { isoCBOR } = await import('@simplewebauthn/server/helpers');

before(startServer);
after(stopServer);

const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (data) => crypto.createHash('sha256').update(data).digest();
const unique = (p) => `${p}${Date.now().toString(36)}${crypto.randomBytes(2).toString('hex')}`;

// --- software authenticator ----------------------------------------------------

class SoftAuthenticator {
  constructor({ rpId = RP_ID, origin = ORIGIN } = {}) {
    this.rpId = rpId;
    this.origin = origin;
    this.credentials = new Map();   // credentialId(b64u) -> { privateKey, counter, userHandle }
  }

  flags({ up = true, uv = true, be = true, bs = true, at = false }) {
    return (up ? 0x01 : 0) | (uv ? 0x04 : 0) | (be ? 0x08 : 0) | (bs ? 0x10 : 0) | (at ? 0x40 : 0);
  }

  create(options, { uv = true, origin = this.origin } = {}) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    const cose = new Map([
      [1, 2], [3, -7], [-1, 1],
      [-2, new Uint8Array(Buffer.from(jwk.x, 'base64url'))],
      [-3, new Uint8Array(Buffer.from(jwk.y, 'base64url'))]
    ]);
    const credId = crypto.randomBytes(32);
    const counter = Buffer.alloc(4);
    const idLen = Buffer.alloc(2); idLen.writeUInt16BE(credId.length);
    const authData = Buffer.concat([
      sha256(this.rpId), Buffer.from([this.flags({ uv, at: true })]), counter,
      Buffer.alloc(16), idLen, credId, Buffer.from(isoCBOR.encode(cose))
    ]);
    const attestationObject = isoCBOR.encode(new Map([
      ['fmt', 'none'], ['attStmt', new Map()], ['authData', new Uint8Array(authData)]
    ]));
    const clientDataJSON = Buffer.from(JSON.stringify({
      type: 'webauthn.create', challenge: options.challenge, origin, crossOrigin: false
    }));
    const id = b64u(credId);
    this.credentials.set(id, { privateKey, counter: 0, userHandle: options.user.id });
    return {
      id, rawId: id, type: 'public-key', authenticatorAttachment: 'platform',
      response: {
        clientDataJSON: b64u(clientDataJSON),
        attestationObject: b64u(attestationObject),
        transports: ['internal', 'hybrid']
      },
      clientExtensionResults: { credProps: { rk: true } }
    };
  }

  get(options, { credentialId = null, uv = true, origin = this.origin, counter = null } = {}) {
    const allowed = (options.allowCredentials ?? []).map((c) => c.id);
    const id = credentialId
      ?? [...this.credentials.keys()].find((k) => allowed.length === 0 || allowed.includes(k));
    const cred = this.credentials.get(id);
    if (!cred) throw new Error('no matching credential');
    cred.counter = counter ?? cred.counter + 1;
    const count = Buffer.alloc(4); count.writeUInt32BE(cred.counter);
    const authData = Buffer.concat([sha256(this.rpId), Buffer.from([this.flags({ uv })]), count]);
    const clientDataJSON = Buffer.from(JSON.stringify({
      type: 'webauthn.get', challenge: options.challenge, origin, crossOrigin: false
    }));
    const signature = crypto.sign('sha256', Buffer.concat([authData, sha256(clientDataJSON)]), cred.privateKey);
    return {
      id, rawId: id, type: 'public-key', authenticatorAttachment: 'platform',
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        userHandle: cred.userHandle
      },
      clientExtensionResults: {}
    };
  }
}

// --- helpers --------------------------------------------------------------------

const PASSWORD = 'correct-horse-battery';

async function register(prefix) {
  const username = unique(prefix);
  const { status, body } = await api('POST', '/api/auth/register', { username, password: PASSWORD }, { 'x-user-id': '' });
  assert.equal(status, 201, JSON.stringify(body));
  return { username, token: body.token, id: body.user.id };
}

async function sudo(token, password = PASSWORD, code = undefined) {
  const res = await asSession(token, 'POST', '/api/passkeys/reauth/password', { password, code });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
}

async function addPasskey(token, authenticator, name) {
  const opts = await asSession(token, 'POST', '/api/passkeys/register/options');
  assert.equal(opts.status, 200, JSON.stringify(opts.body));
  const response = authenticator.create(opts.body.options);
  const done = await asSession(token, 'POST', '/api/passkeys/register/verify', {
    flow_id: opts.body.flow_id, response, name
  });
  assert.equal(done.status, 201, JSON.stringify(done.body));
  return { passkey: done.body, credentialId: response.id, options: opts.body.options };
}

async function passkeyLogin(authenticator, getOpts = {}) {
  const opts = await api('POST', '/api/passkeys/login/options', {}, { 'x-user-id': '' });
  assert.equal(opts.status, 200, JSON.stringify(opts.body));
  const response = authenticator.get(opts.body.options, getOpts);
  return api('POST', '/api/passkeys/login/verify', { flow_id: opts.body.flow_id, response }, { 'x-user-id': '' });
}

// ---------------------------------------------------------------------------

describe('configuration', () => {
  test('passkeys stay off unless configured, and derive RP from PUBLIC_URL', async () => {
    const { passkeyConfig } = await import('../services/passkeys.js');
    assert.equal(passkeyConfig({}).enabled, false);
    assert.equal(passkeyConfig({ PASSKEYS_ENABLED: '0', RP_ID: 'example.com' }).enabled, false);
    const derived = passkeyConfig({ PUBLIC_URL: 'https://chat.example.com/app' });
    assert.equal(derived.enabled, true);
    assert.equal(derived.rpId, 'chat.example.com');
    assert.deepEqual(derived.origins, ['https://chat.example.com']);
    const explicit = passkeyConfig({ RP_ID: 'example.com', RP_ORIGIN: 'https://a.example.com, https://b.example.com/' });
    assert.deepEqual(explicit.origins, ['https://a.example.com', 'https://b.example.com']);
  });

  test('/api/passkeys/config reports the RP to the client', async () => {
    const res = await api('GET', '/api/passkeys/config');
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { enabled: true, rp_id: RP_ID });
  });
});

describe('registration', () => {
  test('needs a signed-in user and a recent re-authentication', async () => {
    const anon = await api('POST', '/api/passkeys/register/options', {}, { 'x-user-id': '' });
    assert.equal(anon.status, 401);

    const user = await register('pkreg');
    const noSudo = await asSession(user.token, 'POST', '/api/passkeys/register/options');
    assert.equal(noSudo.status, 401);
    assert.equal(noSudo.body.code, 'REAUTH_REQUIRED');

    const wrong = await asSession(user.token, 'POST', '/api/passkeys/reauth/password', { password: 'nope-nope-nope' });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.code, 'PASSWORD_REQUIRED');

    const granted = await sudo(user.token);
    assert.equal(granted.reauthenticated, true);
    const status = await asSession(user.token, 'GET', '/api/passkeys/reauth');
    assert.equal(status.body.active, true);
  });

  test('registers a discoverable credential with name, flags and no secrets in the listing', async () => {
    const user = await register('pkadd');
    await sudo(user.token);
    const authenticator = new SoftAuthenticator();
    const { passkey, options } = await addPasskey(user.token, authenticator, '  My laptop  ');

    // Best-practice options: discoverable, UV preferred, no attestation.
    assert.equal(options.rp.id, RP_ID);
    assert.equal(options.attestation, 'none');
    assert.equal(options.authenticatorSelection.residentKey, 'required');
    assert.equal(options.authenticatorSelection.userVerification, 'preferred');
    assert.notEqual(options.user.id, b64u(Buffer.from(user.id)), 'user handle must not be the raw id');

    assert.equal(passkey.name, 'My laptop');
    assert.equal(passkey.backup_eligible, true);
    assert.equal(passkey.backed_up, true);
    assert.equal(passkey.device_type, 'multiDevice');
    assert.deepEqual(passkey.transports, ['internal', 'hybrid']);

    const list = await asSession(user.token, 'GET', '/api/passkeys');
    assert.equal(list.status, 200);
    assert.equal(list.body.length, 1);
    assert.ok(!('public_key' in list.body[0]) && !('credential_id' in list.body[0]));

    // The next ceremony excludes the authenticator already registered.
    const again = await asSession(user.token, 'POST', '/api/passkeys/register/options');
    assert.equal(again.body.options.excludeCredentials.length, 1);
  });

  test('a registration challenge is single-use, expires, and must match the origin', async () => {
    const user = await register('pkchal');
    await sudo(user.token);
    const authenticator = new SoftAuthenticator();

    // Reuse.
    const opts = await asSession(user.token, 'POST', '/api/passkeys/register/options');
    const response = authenticator.create(opts.body.options);
    const first = await asSession(user.token, 'POST', '/api/passkeys/register/verify', { flow_id: opts.body.flow_id, response });
    assert.equal(first.status, 201);
    const replay = await asSession(user.token, 'POST', '/api/passkeys/register/verify', { flow_id: opts.body.flow_id, response });
    assert.equal(replay.status, 400);
    assert.equal(replay.body.code, 'PASSKEY_CHALLENGE_INVALID');

    // Expiry.
    const late = await asSession(user.token, 'POST', '/api/passkeys/register/options');
    const { runQuery } = await import('../db.js');
    await runQuery(`UPDATE webauthn_challenges SET expires_at = ? WHERE id = ?`,
      [new Date(Date.now() - 1000).toISOString(), late.body.flow_id]);
    const expired = await asSession(user.token, 'POST', '/api/passkeys/register/verify', {
      flow_id: late.body.flow_id, response: authenticator.create(late.body.options)
    });
    assert.equal(expired.status, 400);
    assert.equal(expired.body.code, 'PASSKEY_CHALLENGE_INVALID');

    // Wrong origin (a phishing page proxying the ceremony).
    const phish = await asSession(user.token, 'POST', '/api/passkeys/register/options');
    const bad = await asSession(user.token, 'POST', '/api/passkeys/register/verify', {
      flow_id: phish.body.flow_id,
      response: authenticator.create(phish.body.options, { origin: 'https://evil.example' })
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'PASSKEY_INVALID');

    // Another user cannot redeem someone else's challenge.
    const other = await register('pkchal2');
    await sudo(other.token);
    const mine = await asSession(user.token, 'POST', '/api/passkeys/register/options');
    const stolen = await asSession(other.token, 'POST', '/api/passkeys/register/verify', {
      flow_id: mine.body.flow_id, response: authenticator.create(mine.body.options)
    });
    assert.equal(stolen.status, 400);
  });
});

describe('sign-in', () => {
  test('a passkey signs in without password or TOTP, even with 2FA on', async () => {
    const user = await register('pklogin');
    // Turn on TOTP for this account.
    const begin = await asSession(user.token, 'POST', '/api/auth/mfa/begin');
    const confirm = await asSession(user.token, 'POST', '/api/auth/mfa/confirm', { code: generateCode(begin.body.secret) });
    assert.equal(confirm.status, 200, JSON.stringify(confirm.body));
    const pw = await api('POST', '/api/auth/login', { username: user.username, password: PASSWORD }, { 'x-user-id': '' });
    assert.equal(pw.body.code, 'MFA_REQUIRED');

    // Step-up for this account now needs password + TOTP.
    const missingCode = await asSession(user.token, 'POST', '/api/passkeys/reauth/password', { password: PASSWORD });
    assert.equal(missingCode.body.code, 'MFA_REQUIRED');
    await sudo(user.token, PASSWORD, generateCode(begin.body.secret));

    const authenticator = new SoftAuthenticator();
    await addPasskey(user.token, authenticator, 'Phone');

    const res = await passkeyLogin(authenticator);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.user.id, user.id);
    assert.equal(res.body.method, 'passkey');
    const me = await asSession(res.body.token, 'GET', '/api/auth/me');
    assert.equal(me.body.user.id, user.id);

    const list = await asSession(res.body.token, 'GET', '/api/passkeys');
    assert.ok(list.body[0].last_used_at, 'last_used_at is recorded');
  });

  test('login options reveal no credentials; UV, counter and challenge reuse are enforced', async () => {
    const user = await register('pkuv');
    await sudo(user.token);
    const authenticator = new SoftAuthenticator();
    const { credentialId } = await addPasskey(user.token, authenticator);

    const opts = await api('POST', '/api/passkeys/login/options', {}, { 'x-user-id': '' });
    assert.equal((opts.body.options.allowCredentials ?? []).length, 0);
    assert.equal(opts.body.options.userVerification, 'preferred');

    // No user verification → not a sign-in.
    const noUv = await passkeyLogin(authenticator, { uv: false });
    assert.equal(noUv.status, 401);
    assert.equal(noUv.body.code, 'PASSKEY_USER_VERIFICATION_REQUIRED');

    const ok = await passkeyLogin(authenticator);
    assert.equal(ok.status, 200);

    // A discoverable sign-in must carry the user handle; dropping it from the
    // request does not skip the check (the server's challenge decides).
    const bare = await api('POST', '/api/passkeys/login/options', {}, { 'x-user-id': '' });
    const noHandle = authenticator.get(bare.body.options);
    delete noHandle.response.userHandle;
    const refused = await api('POST', '/api/passkeys/login/verify', { flow_id: bare.body.flow_id, response: noHandle }, { 'x-user-id': '' });
    assert.equal(refused.status, 401);
    assert.equal(refused.body.code, 'PASSKEY_AUTH_FAILED');

    // A cloned authenticator replays an old counter.
    const cloned = await passkeyLogin(authenticator, { counter: 1 });
    assert.equal(cloned.status, 401);
    assert.equal(cloned.body.code, 'PASSKEY_AUTH_FAILED');

    // The same flow cannot be redeemed twice.
    const flow = await api('POST', '/api/passkeys/login/options', {}, { 'x-user-id': '' });
    const response = authenticator.get(flow.body.options, { credentialId, counter: 10 });
    const once = await api('POST', '/api/passkeys/login/verify', { flow_id: flow.body.flow_id, response }, { 'x-user-id': '' });
    assert.equal(once.status, 200);
    const twice = await api('POST', '/api/passkeys/login/verify', { flow_id: flow.body.flow_id, response }, { 'x-user-id': '' });
    assert.equal(twice.body.code, 'PASSKEY_CHALLENGE_INVALID');

    // Wrong origin.
    const phish = await passkeyLogin(authenticator, { origin: 'https://evil.example' });
    assert.equal(phish.status, 401);

    // Expired challenge.
    const late = await api('POST', '/api/passkeys/login/options', {}, { 'x-user-id': '' });
    const { runQuery } = await import('../db.js');
    await runQuery(`UPDATE webauthn_challenges SET expires_at = ? WHERE id = ?`,
      [new Date(Date.now() - 1000).toISOString(), late.body.flow_id]);
    const expired = await api('POST', '/api/passkeys/login/verify', {
      flow_id: late.body.flow_id, response: authenticator.get(late.body.options)
    }, { 'x-user-id': '' });
    assert.equal(expired.body.code, 'PASSKEY_CHALLENGE_INVALID');

    // An unknown credential.
    const stranger = new SoftAuthenticator();
    stranger.create({ challenge: 'x', user: { id: 'AAAA' } });
    const unknown = await passkeyLogin(stranger);
    assert.equal(unknown.status, 401);
  });
});

describe('management', () => {
  test('rename works; another user cannot rename or delete it; delete needs sudo', async () => {
    const owner = await register('pkown');
    await sudo(owner.token);
    const authenticator = new SoftAuthenticator();
    const { passkey } = await addPasskey(owner.token, authenticator, 'Key');

    const renamed = await asSession(owner.token, 'PATCH', `/api/passkeys/${passkey.id}`, { name: 'YubiKey 5' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.name, 'YubiKey 5');
    const blank = await asSession(owner.token, 'PATCH', `/api/passkeys/${passkey.id}`, { name: '   ' });
    assert.equal(blank.status, 400);

    const attacker = await register('pkatk');
    await sudo(attacker.token);
    const steal = await asSession(attacker.token, 'PATCH', `/api/passkeys/${passkey.id}`, { name: 'mine' });
    assert.equal(steal.status, 404);
    const del = await asSession(attacker.token, 'DELETE', `/api/passkeys/${passkey.id}`);
    assert.equal(del.status, 404);
    // A dev-identity request for another user id cannot reach it either.
    assert.equal((await api('DELETE', `/api/passkeys/${passkey.id}`, undefined, { 'x-user-id': 'user-me' })).status, 401);
    assert.equal((await asSession(owner.token, 'GET', '/api/passkeys')).body.length, 1);

    // A brand-new session (sign-in with the passkey) has no sudo yet.
    const fresh = await passkeyLogin(authenticator);
    const early = await asSession(fresh.body.token, 'DELETE', `/api/passkeys/${passkey.id}`);
    assert.equal(early.status, 401);
    assert.equal(early.body.code, 'REAUTH_REQUIRED');

    // Step up with the passkey itself (allowCredentials lists only the owner's).
    const ro = await asSession(fresh.body.token, 'POST', '/api/passkeys/reauth/options');
    assert.equal(ro.status, 200);
    assert.equal(ro.body.options.allowCredentials.length, 1);
    const rv = await asSession(fresh.body.token, 'POST', '/api/passkeys/reauth/verify', {
      flow_id: ro.body.flow_id, response: authenticator.get(ro.body.options)
    });
    assert.equal(rv.status, 200, JSON.stringify(rv.body));

    const gone = await asSession(fresh.body.token, 'DELETE', `/api/passkeys/${passkey.id}`);
    assert.equal(gone.status, 200);
    assert.equal((await asSession(owner.token, 'GET', '/api/passkeys')).body.length, 0);

    // The deleted passkey no longer signs in.
    const after = await passkeyLogin(authenticator);
    assert.equal(after.status, 401);

    // Everything above is in the account's audit trail.
    const events = await asSession(owner.token, 'GET', '/api/passkeys/events');
    const actions = events.body.map((e) => e.action);
    for (const a of ['register', 'rename', 'login', 'reauth_passkey', 'delete', 'reauth_password']) {
      assert.ok(actions.includes(a), `audit has ${a}: ${actions.join(',')}`);
    }
    // …and the other account's attempts are not in it.
    const theirs = await asSession(attacker.token, 'GET', '/api/passkeys/events');
    assert.ok(!theirs.body.some((e) => e.action === 'rename'));
  });

  test('a passkey step-up cannot use another account\'s passkey', async () => {
    const a = await register('pksa');
    const b = await register('pksb');
    await sudo(a.token);
    await sudo(b.token);
    const authA = new SoftAuthenticator();
    const authB = new SoftAuthenticator();
    await addPasskey(a.token, authA);
    await addPasskey(b.token, authB);
    const ro = await asSession(a.token, 'POST', '/api/passkeys/reauth/options');
    const res = await asSession(a.token, 'POST', '/api/passkeys/reauth/verify', {
      flow_id: ro.body.flow_id, response: authB.get(ro.body.options, { credentialId: [...authB.credentials.keys()][0] })
    });
    assert.equal(res.status, 401);

    // Step-up names the allowed credentials, so the user handle is optional.
    const ro2 = await asSession(a.token, 'POST', '/api/passkeys/reauth/options');
    const own = authA.get(ro2.body.options);
    delete own.response.userHandle;
    const ok = await asSession(a.token, 'POST', '/api/passkeys/reauth/verify', { flow_id: ro2.body.flow_id, response: own });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
  });
});
