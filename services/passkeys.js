// ============================================================================
//  Passkeys (WebAuthn Level 3) — registration, sign-in, step-up re-auth.
//
//  Design choices (see docs in DEPLOYMENT.md § Passkeys):
//    - Discoverable credentials (residentKey 'required'), so sign-in needs no
//      username and works with conditional UI (autofill).
//    - Attestation 'none': we do not gate on authenticator make/model.
//    - userVerification 'preferred' in every ceremony, but a *sign-in* is
//      only accepted when the authenticator reports UV. A UV passkey is two
//      factors in one gesture (possession + biometric/PIN), which is why it
//      skips both the password and TOTP.
//    - Challenges are rows in webauthn_challenges: random, single-use, bound
//      to a purpose (and, when signed in, to the user + session), expiring
//      after CHALLENGE_TTL_MS.
//    - Sensitive changes (adding or removing a passkey) need "sudo": a fresh
//      re-authentication (password [+ TOTP], or a UV passkey assertion) made
//      from the same session within SUDO_TTL_MS.
//
//  Disabled unless configured: PASSKEYS_ENABLED=1, RP_ID or PUBLIC_URL.
// ============================================================================

import crypto from 'crypto';

import { runQuery, getQuery, allQuery, transaction, sql, isUniqueViolation } from '../db.js';
import { generateId } from '../lib/snowflake.js';
import { ApiError } from '../lib/httpUtils.js';
import { assertReauthenticated } from './accountSecurity.js';

export const CHALLENGE_TTL_MS = 5 * 60_000;
export const SUDO_TTL_MS = 5 * 60_000;
export const MAX_PASSKEYS_PER_USER = 20;
const NAME_MAX = 64;
const DEV_SESSION = 'dev-identity';

let webauthn = null;   // @simplewebauthn/server, loaded on first use
const lib = async () => (webauthn ??= await import('@simplewebauthn/server'));

// --- configuration -------------------------------------------------------------

const truthy = (v) => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').trim().toLowerCase());
const falsy = (v) => ['0', 'false', 'no', 'off'].includes(String(v ?? '').trim().toLowerCase());

/**
 * RP ID and allowed origins. RP_ID / RP_ORIGIN win; otherwise both are derived
 * from PUBLIC_URL. Enabled when explicitly turned on, or implicitly when an
 * operator has set RP_ID or PUBLIC_URL — and never when PASSKEYS_ENABLED=0.
 */
export function passkeyConfig(env = process.env) {
  let publicUrl = null;
  try { publicUrl = env.PUBLIC_URL ? new URL(env.PUBLIC_URL) : null; } catch { publicUrl = null; }
  const rpId = String(env.RP_ID || publicUrl?.hostname || '').trim().toLowerCase();
  const origins = String(env.RP_ORIGIN || publicUrl?.origin || '')
    .split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean);
  const wanted = env.PASSKEYS_ENABLED === undefined || env.PASSKEYS_ENABLED === ''
    ? Boolean(env.RP_ID || env.PUBLIC_URL)
    : truthy(env.PASSKEYS_ENABLED) && !falsy(env.PASSKEYS_ENABLED);
  const enabled = Boolean(wanted && rpId && origins.length > 0);
  return {
    enabled,
    rpId,
    origins,
    rpName: String(env.RP_NAME || 'Antigravity Discord').slice(0, 64)
  };
}

function requireEnabled() {
  const cfg = passkeyConfig();
  if (!cfg.enabled) {
    throw new ApiError('Passkeys are not enabled on this server', { status: 404, code: 'PASSKEYS_DISABLED' });
  }
  return cfg;
}

// --- helpers -------------------------------------------------------------------

const nowIso = () => new Date().toISOString();
const later = (ms) => new Date(Date.now() + ms).toISOString();
const sessionKey = (sessionId) => sessionId || DEV_SESSION;
/** The WebAuthn user handle: opaque, stable, and never the username/email. */
const userHandle = (userId) => crypto.createHash('sha256').update(`webauthn-user:${userId}`).digest().subarray(0, 32);

function cleanName(name, fallback) {
  const trimmed = String(name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, NAME_MAX);
  return trimmed || fallback;
}

function parseTransports(value) {
  try {
    const list = JSON.parse(value ?? '[]');
    return Array.isArray(list) ? list.filter((t) => typeof t === 'string') : [];
  } catch { return []; }
}

/** Audit trail. Best-effort: a failed insert never fails the ceremony. */
export async function recordEvent({ userId, action, credentialId = null, ip = null, userAgent = null }) {
  try {
    await runQuery(
      `INSERT INTO passkey_events (id, user_id, action, credential_id, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [generateId(), userId, action, credentialId, ip, userAgent ? String(userAgent).slice(0, 300) : null]
    );
  } catch { /* audit is best-effort */ }
}

let lastPrune = 0;
/** Drop expired challenges and sudo grants. Throttled; also run from tests. */
export async function pruneChallenges({ force = false } = {}) {
  if (!force && Date.now() - lastPrune < 60_000) return 0;
  lastPrune = Date.now();
  const result = await runQuery(`DELETE FROM webauthn_challenges WHERE expires_at < ?`, [nowIso()]);
  return result.changes;
}

async function storeChallenge({ purpose, challenge, userId = null, sessionId = null }) {
  pruneChallenges().catch(() => {});
  const id = crypto.randomBytes(18).toString('base64url');
  await runQuery(
    `INSERT INTO webauthn_challenges (id, user_id, purpose, challenge, session_id, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, userId, purpose, challenge, sessionId, later(CHALLENGE_TTL_MS)]
  );
  return id;
}

/**
 * Take a challenge out of the store: single use (deleted by the same call that
 * reads it, and only one caller can win the DELETE), bound to its purpose and
 * owner, and refused once expired.
 */
async function consumeChallenge({ flowId, purpose, userId = null }) {
  const invalid = () => new ApiError('This passkey request has expired — try again', {
    status: 400, code: 'PASSKEY_CHALLENGE_INVALID'
  });
  if (typeof flowId !== 'string' || flowId.length > 64) throw invalid();
  const row = await getQuery(`SELECT * FROM webauthn_challenges WHERE id = ? AND purpose = ?`, [flowId, purpose]);
  if (!row) throw invalid();
  const deleted = await runQuery(`DELETE FROM webauthn_challenges WHERE id = ?`, [flowId]);
  if (deleted.changes !== 1) throw invalid();                       // lost a race: already used
  if (row.expires_at < nowIso()) throw invalid();
  if (userId !== null && row.user_id !== userId) throw invalid();
  return row;
}

// --- sudo (recent re-authentication) ---------------------------------------------

async function grantSudo({ userId, sessionId }) {
  const expiresAt = later(SUDO_TTL_MS);
  await runQuery(
    `INSERT INTO webauthn_challenges (id, user_id, purpose, challenge, session_id, expires_at)
     VALUES (?, ?, 'sudo', ?, ?, ?)`,
    [crypto.randomBytes(18).toString('base64url'), userId, 'sudo', sessionKey(sessionId), expiresAt]
  );
  return { reauthenticated: true, expires_at: expiresAt };
}

export async function sudoStatus({ userId, sessionId }) {
  const row = await getQuery(
    `SELECT MAX(expires_at) AS expires_at FROM webauthn_challenges
      WHERE user_id = ? AND purpose = 'sudo' AND session_id = ? AND expires_at > ?`,
    [userId, sessionKey(sessionId), nowIso()]
  );
  return { active: Boolean(row?.expires_at), expires_at: row?.expires_at ?? null };
}

async function assertSudo({ userId, sessionId }) {
  const { active } = await sudoStatus({ userId, sessionId });
  if (!active) {
    throw new ApiError('Confirm it is you before changing passkeys', { status: 401, code: 'REAUTH_REQUIRED' });
  }
}

/** Step-up with the password (and TOTP when MFA is on). */
export async function reauthWithPassword({ userId, sessionId, password, code, ip, userAgent }) {
  await assertReauthenticated({ userId, password, code });
  await recordEvent({ userId, action: 'reauth_password', ip, userAgent });
  return grantSudo({ userId, sessionId });
}

// --- listing ----------------------------------------------------------------------

const PUBLIC_COLUMNS = `id, name, device_type, backup_eligible, backed_up, transports, aaguid,
                        created_at, last_used_at`;

function toPublic(row) {
  return {
    id: row.id,
    name: row.name,
    device_type: row.device_type,
    backup_eligible: Boolean(row.backup_eligible),
    backed_up: Boolean(row.backed_up),
    transports: parseTransports(row.transports),
    aaguid: row.aaguid ?? null,
    created_at: row.created_at,
    last_used_at: row.last_used_at ?? null
  };
}

export async function listPasskeys(userId) {
  const rows = await allQuery(
    `SELECT ${PUBLIC_COLUMNS} FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at ASC, id ASC`,
    [userId]
  );
  return rows.map(toPublic);
}

export async function listEvents(userId, { limit = 50 } = {}) {
  return allQuery(
    `SELECT id, action, credential_id, ip_address, user_agent, created_at
       FROM passkey_events WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    [userId, Math.min(Math.max(1, limit), 200)]
  );
}

// --- registration -----------------------------------------------------------------

export async function registrationOptions({ userId, sessionId }) {
  const cfg = requireEnabled();
  await assertSudo({ userId, sessionId });
  const user = await getQuery(
    `SELECT id, username, display_name FROM users WHERE id = ? AND deleted_at IS NULL`, [userId]
  );
  if (!user) throw ApiError.unauthorized();
  const existing = await allQuery(
    `SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = ?`, [userId]
  );
  if (existing.length >= MAX_PASSKEYS_PER_USER) {
    throw new ApiError(`You can register at most ${MAX_PASSKEYS_PER_USER} passkeys`, { code: 'PASSKEY_LIMIT' });
  }

  const { generateRegistrationOptions } = await lib();
  const options = await generateRegistrationOptions({
    rpName: cfg.rpName,
    rpID: cfg.rpId,
    userName: user.username,
    userDisplayName: user.display_name || user.username,
    userID: new Uint8Array(userHandle(user.id)),
    attestationType: 'none',
    timeout: CHALLENGE_TTL_MS,
    // The same authenticator twice would just be a confusing duplicate.
    excludeCredentials: existing.map((c) => ({ id: c.credential_id, transports: parseTransports(c.transports) })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    // credProps tells us whether the credential really is discoverable.
    extensions: { credProps: true }
  });
  const flowId = await storeChallenge({ purpose: 'register', challenge: options.challenge, userId, sessionId });
  return { flow_id: flowId, options };
}

export async function verifyRegistration({ userId, sessionId, flowId, response, name, ip, userAgent }) {
  const cfg = requireEnabled();
  await assertSudo({ userId, sessionId });
  const challenge = await consumeChallenge({ flowId, purpose: 'register', userId });
  if (!response || typeof response !== 'object') {
    throw new ApiError('Missing passkey response', { code: 'PASSKEY_INVALID' });
  }

  const { verifyRegistrationResponse } = await lib();
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: cfg.origins,
      expectedRPID: cfg.rpId,
      requireUserVerification: false
    });
  } catch (err) {
    throw new ApiError('The passkey could not be verified', {
      code: 'PASSKEY_INVALID', details: { reason: String(err?.message ?? '').slice(0, 200) }
    });
  }
  if (!verification.verified) throw new ApiError('The passkey could not be verified', { code: 'PASSKEY_INVALID' });

  const info = verification.registrationInfo;
  const { credential } = info;
  const count = await getQuery(`SELECT count(*) AS n FROM webauthn_credentials WHERE user_id = ?`, [userId]);
  if (Number(count?.n ?? 0) >= MAX_PASSKEYS_PER_USER) {
    throw new ApiError(`You can register at most ${MAX_PASSKEYS_PER_USER} passkeys`, { code: 'PASSKEY_LIMIT' });
  }

  const id = generateId();
  const transports = Array.isArray(response?.response?.transports) ? response.response.transports : (credential.transports ?? []);
  try {
    await runQuery(
      `INSERT INTO webauthn_credentials (id, user_id, credential_id, public_key, counter, transports,
                                         device_type, backup_eligible, backed_up, aaguid, name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id, userId, credential.id, Buffer.from(credential.publicKey).toString('base64url'),
        credential.counter ?? 0, JSON.stringify(transports.filter((t) => typeof t === 'string').slice(0, 8)),
        info.credentialDeviceType, info.credentialDeviceType === 'multiDevice' ? 1 : 0,
        info.credentialBackedUp ? 1 : 0, info.aaguid ?? null,
        cleanName(name, `Passkey ${Number(count?.n ?? 0) + 1}`)
      ]
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new ApiError('That passkey is already registered', { status: 409, code: 'PASSKEY_EXISTS' });
    }
    throw err;
  }
  await recordEvent({ userId, action: 'register', credentialId: id, ip, userAgent });
  const row = await getQuery(`SELECT ${PUBLIC_COLUMNS} FROM webauthn_credentials WHERE id = ?`, [id]);
  return toPublic(row);
}

// --- authentication (sign-in and step-up) ---------------------------------------

/**
 * Sign-in options. No allowCredentials: the authenticator offers whatever
 * discoverable credentials it holds for this RP (also what conditional UI
 * needs), so the endpoint reveals nothing about which accounts exist.
 */
export async function loginOptions() {
  const cfg = requireEnabled();
  const { generateAuthenticationOptions } = await lib();
  const options = await generateAuthenticationOptions({
    rpID: cfg.rpId, userVerification: 'preferred', timeout: CHALLENGE_TTL_MS
  });
  const flowId = await storeChallenge({ purpose: 'login', challenge: options.challenge });
  return { flow_id: flowId, options };
}

/** Step-up options: only this account's own passkeys are acceptable. */
export async function reauthOptions({ userId, sessionId }) {
  const cfg = requireEnabled();
  const creds = await allQuery(
    `SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = ?`, [userId]
  );
  if (creds.length === 0) throw new ApiError('You have no passkeys yet', { code: 'NO_PASSKEYS' });
  const { generateAuthenticationOptions } = await lib();
  const options = await generateAuthenticationOptions({
    rpID: cfg.rpId,
    userVerification: 'preferred',
    timeout: CHALLENGE_TTL_MS,
    allowCredentials: creds.map((c) => ({ id: c.credential_id, transports: parseTransports(c.transports) }))
  });
  const flowId = await storeChallenge({ purpose: 'reauth', challenge: options.challenge, userId, sessionId });
  return { flow_id: flowId, options };
}

const authFailed = () => new ApiError('That passkey could not be verified', { status: 401, code: 'PASSKEY_AUTH_FAILED' });

/** Shared assertion check. Returns the credential row it verified. */
async function verifyAssertion({ cfg, challenge, response, ip, userAgent }) {
  const credentialId = typeof response?.id === 'string' ? response.id : null;
  if (!credentialId || credentialId.length > 1400) throw authFailed();
  const row = await getQuery(
    `SELECT c.*, u.deleted_at AS user_deleted
       FROM webauthn_credentials c JOIN users u ON u.id = c.user_id
      WHERE c.credential_id = ?`,
    [credentialId]
  );
  if (!row || row.user_deleted) throw authFailed();

  // The user handle must be this account's. Whether it may be absent is
  // decided by the server-side challenge, not by the request: a discoverable
  // sign-in (no allowCredentials) always returns it (WebAuthn §7.2 step 6),
  // while step-up names the credentials and the handle is optional there.
  const expectedHandle = Buffer.from(userHandle(row.user_id)).toString('base64url');
  const handleRequired = challenge.purpose === 'login';
  const presentedHandle = response?.response?.userHandle ?? (handleRequired ? null : expectedHandle);
  if (presentedHandle !== expectedHandle) throw authFailed();

  const { verifyAuthenticationResponse } = await lib();
  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: cfg.origins,
      expectedRPID: cfg.rpId,
      credential: {
        id: row.credential_id,
        publicKey: new Uint8Array(Buffer.from(row.public_key, 'base64url')),
        counter: Number(row.counter) || 0,
        transports: parseTransports(row.transports)
      },
      // UV is checked below with its own error code.
      requireUserVerification: false
    });
  } catch {
    // Includes a counter that went backwards: a sign of a cloned authenticator.
    await recordEvent({ userId: row.user_id, action: 'auth_failed', credentialId: row.id, ip, userAgent });
    throw authFailed();
  }
  if (!verification.verified) {
    await recordEvent({ userId: row.user_id, action: 'auth_failed', credentialId: row.id, ip, userAgent });
    throw authFailed();
  }
  const info = verification.authenticationInfo;
  if (!info.userVerified) {
    throw new ApiError('Your passkey must verify you (fingerprint, face or PIN)', {
      status: 401, code: 'PASSKEY_USER_VERIFICATION_REQUIRED'
    });
  }
  await runQuery(
    `UPDATE webauthn_credentials
        SET counter = ?, backed_up = ?, device_type = ?, last_used_at = ${sql.now}
      WHERE id = ?`,
    [info.newCounter, info.credentialBackedUp ? 1 : 0, info.credentialDeviceType, row.id]
  );
  return row;
}

/**
 * Verify a sign-in assertion. Returns the user id; the route issues the
 * session exactly like a password + TOTP login would.
 */
export async function verifyLogin({ flowId, response, ip, userAgent }) {
  const cfg = requireEnabled();
  const challenge = await consumeChallenge({ flowId, purpose: 'login' });
  const row = await verifyAssertion({ cfg, challenge, response, ip, userAgent });
  await recordEvent({ userId: row.user_id, action: 'login', credentialId: row.id, ip, userAgent });
  return { userId: row.user_id, credentialId: row.id };
}

export async function verifyReauth({ userId, sessionId, flowId, response, ip, userAgent }) {
  const cfg = requireEnabled();
  const challenge = await consumeChallenge({ flowId, purpose: 'reauth', userId });
  const row = await verifyAssertion({ cfg, challenge, response, ip, userAgent });
  if (row.user_id !== userId) throw authFailed();
  await recordEvent({ userId, action: 'reauth_passkey', credentialId: row.id, ip, userAgent });
  return grantSudo({ userId, sessionId });
}

// --- management -----------------------------------------------------------------

export async function renamePasskey({ userId, id, name, ip, userAgent }) {
  const clean = cleanName(name, '');
  if (!clean) throw new ApiError('A passkey needs a name', { code: 'INVALID_NAME' });
  const result = await runQuery(
    `UPDATE webauthn_credentials SET name = ? WHERE id = ? AND user_id = ?`, [clean, String(id), userId]
  );
  // Someone else's passkey is indistinguishable from a missing one.
  if (result.changes !== 1) throw ApiError.notFound('Passkey');
  await recordEvent({ userId, action: 'rename', credentialId: String(id), ip, userAgent });
  const row = await getQuery(`SELECT ${PUBLIC_COLUMNS} FROM webauthn_credentials WHERE id = ?`, [String(id)]);
  return toPublic(row);
}

export async function deletePasskey({ userId, sessionId, id, ip, userAgent }) {
  await assertSudo({ userId, sessionId });
  const result = await transaction(async () => runQuery(
    `DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?`, [String(id), userId]
  ));
  if (result.changes !== 1) throw ApiError.notFound('Passkey');
  await recordEvent({ userId, action: 'delete', credentialId: String(id), ip, userAgent });
  return { deleted: true };
}

/** Public, cacheable: whether the client should offer passkeys at all. */
export function publicConfig() {
  const cfg = passkeyConfig();
  return { enabled: cfg.enabled, rp_id: cfg.enabled ? cfg.rpId : null };
}
