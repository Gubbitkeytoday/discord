// ============================================================================
//  Authentication: password hashing and session tokens.
//
//  scrypt from node:crypto rather than bcrypt/argon2 — no native dependency to
//  compile, and it is a memory-hard KDF that the platform maintains for us.
// ============================================================================

import crypto from 'crypto';
import { promisify } from 'util';

import { runQuery, getQuery } from '../db.js';
import { generateId } from './snowflake.js';
import { ApiError } from './httpUtils.js';

const scrypt = promisify(crypto.scrypt);

// Cost parameters. N=16384 keeps a single hash around 50-100ms on a laptop,
// which is the right order of magnitude for an interactive login.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const SALT_BYTES = 16;
const TOKEN_BYTES = 32;

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days
export const SESSION_COOKIE = 'antigravity_session';

// --- passwords ---------------------------------------------------------------

/** Format: scrypt$N$r$p$salt$hash, all base64url. Self-describing so the cost
 *  parameters can be raised later without invalidating old hashes. */
export async function hashPassword(password) {
  assertPasswordPolicy(password);
  const salt = crypto.randomBytes(SALT_BYTES);
  const derived = await scrypt(password.normalize('NFKC'), salt, SCRYPT.keylen, {
    N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 128 * SCRYPT.N * SCRYPT.r * 2
  });
  return [
    'scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p,
    salt.toString('base64url'), derived.toString('base64url')
  ].join('$');
}

export async function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const [scheme, N, r, p, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt') return false;

  try {
    const derived = await scrypt(
      String(password).normalize('NFKC'),
      Buffer.from(salt, 'base64url'),
      Buffer.from(hash, 'base64url').length,
      { N: Number(N), r: Number(r), p: Number(p), maxmem: 128 * Number(N) * Number(r) * 2 }
    );
    const expected = Buffer.from(hash, 'base64url');
    // Constant-time: never let response timing reveal how much of the hash matched.
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

export function assertPasswordPolicy(password) {
  const value = String(password ?? '');
  if (value.length < 8) {
    throw new ApiError('รหัสผ่านต้องยาวอย่างน้อย 8 ตัวอักษร', { code: 'WEAK_PASSWORD' });
  }
  if (value.length > 200) {
    throw new ApiError('รหัสผ่านยาวเกินไป', { code: 'WEAK_PASSWORD' });
  }
}

// --- sessions ----------------------------------------------------------------

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

/**
 * Issue a session. Only the hash is stored, so a database leak cannot be
 * replayed as a login.
 */
export async function createSession({ userId, ip = null, userAgent = null, deviceName = null }) {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  const id = generateId();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();

  await runQuery(
    `INSERT INTO sessions (id, user_id, token_hash, device_name, ip_address, user_agent,
                           last_seen_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)`,
    [id, userId, hashToken(token), deviceName, ip, userAgent, expiresAt]
  );

  // The raw token is returned exactly once and never stored anywhere.
  return { token, sessionId: id, expiresAt };
}

/** Resolve a bearer/cookie token to a live session, or null. */
export async function resolveSession(token) {
  if (!token) return null;
  const row = await getQuery(
    `SELECT s.*, u.deleted_at AS user_deleted
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL`,
    [hashToken(token)]
  );
  if (!row) return null;
  if (row.user_deleted) return null;
  if (row.expires_at && row.expires_at < new Date().toISOString()) return null;

  // last_seen_at is best-effort; a failed touch must not fail the request.
  runQuery(
    `UPDATE sessions SET last_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    [row.id]
  ).catch(() => {});

  return { sessionId: row.id, userId: row.user_id, expiresAt: row.expires_at };
}

export async function revokeSession(token) {
  if (!token) return false;
  const result = await runQuery(
    `UPDATE sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE token_hash = ? AND revoked_at IS NULL`,
    [hashToken(token)]
  );
  return result.changes > 0;
}

export async function revokeAllSessions(userId, { exceptToken = null } = {}) {
  await runQuery(
    `UPDATE sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE user_id = ? AND revoked_at IS NULL
        ${exceptToken ? 'AND token_hash != ?' : ''}`,
    exceptToken ? [userId, hashToken(exceptToken)] : [userId]
  );
}

export function listSessions(userId) {
  return getQuery(
    `SELECT count(*) AS active FROM sessions
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    [userId]
  );
}

/** Delete sessions that expired long ago. Called from the periodic sweep. */
export async function pruneSessions() {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const result = await runQuery(
    `DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)`,
    [cutoff, cutoff]
  );
  return result.changes;
}

// --- request plumbing --------------------------------------------------------

/** Pull a token from the Authorization header or the session cookie. */
export function extractToken(req) {
  const header = req.get('authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();

  const cookie = req.headers.cookie;
  if (!cookie) return null;
  for (const part of cookie.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export function sessionCookie(token, { maxAgeMs = SESSION_TTL_MS, secure = false } = {}) {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',              // unreadable from JS, so XSS cannot steal it
    'SameSite=Lax',          // survives normal navigation, blocks cross-site POSTs
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
    secure ? 'Secure' : null
  ].filter(Boolean).join('; ');
}

export function clearedCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
