// ============================================================================
//  Authentication: password hashing and session tokens.
//
//  scrypt from node:crypto rather than bcrypt/argon2 — no native dependency to
//  compile, and it is a memory-hard KDF that the platform maintains for us.
// ============================================================================

import crypto from 'crypto';
import { promisify } from 'util';

import { runQuery, getQuery, sql } from '../db.js';
import { generateId } from './snowflake.js';
import { ApiError } from './httpUtils.js';
import { announceRevoked, sessionEvents } from './sessionEvents.js';
import { onBus, publishBus } from './redis.js';

const scrypt = promisify(crypto.scrypt);

// Cost parameters. N=16384 keeps a single hash around 50-100ms on a laptop,
// which is the right order of magnitude for an interactive login.
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const SALT_BYTES = 16;
const TOKEN_BYTES = 32;

const DAY_MS = 24 * 60 * 60 * 1000;
const positiveDays = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
// Absolute lifetime: fixed at sign-in and never extended by activity, so a
// stolen token stops working at a known time however busy it is kept.
export const SESSION_TTL_MS = positiveDays(process.env.SESSION_TTL_DAYS, 30) * DAY_MS;
// Idle limit: a session nobody has used for this long is dead even inside its
// lifetime (a forgotten laptop, a token lifted from an old backup).
export const SESSION_IDLE_MS = positiveDays(process.env.SESSION_IDLE_DAYS, 14) * DAY_MS;
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
    throw new ApiError('Password must be at least 8 characters', { code: 'WEAK_PASSWORD' });
  }
  if (value.length > 200) {
    throw new ApiError('Password is too long (200 characters at most)', { code: 'PASSWORD_TOO_LONG' });
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
     VALUES (?, ?, ?, ?, ?, ?, ${sql.now}, ?)`,
    [id, userId, hashToken(token), deviceName, ip, userAgent, expiresAt]
  );

  // The raw token is returned exactly once and never stored anywhere.
  return { token, sessionId: id, expiresAt };
}

// --- session cache -------------------------------------------------------------
//
// Every authenticated request and socket identify used to cost a SELECT plus
// an UPDATE of last_seen_at (a write that takes SQLite's lock). Resolved
// sessions are now cached briefly, keyed by token hash, and last_seen_at is
// written at most once per SESSION_TOUCH_INTERVAL_MS per session.
//
// Revocation is immediate, not TTL-bound: every revoke path already announces
// on lib/sessionEvents.js; the cache drops matching entries on that event,
// and with REDIS_URL the event is relayed to the other instances over the
// cluster bus so their caches drop them too. Expiry and idle limits are still
// checked on every hit.
//
// SESSION_CACHE_TTL_MS defaults to 30 s in production and 0 (off) elsewhere,
// so tests that edit the sessions table directly see their edits.
const SESSION_CACHE_TTL_MS = Math.max(0, Number(
  process.env.SESSION_CACHE_TTL_MS ?? (process.env.NODE_ENV === 'production' ? 30_000 : 0)
) || 0);
const SESSION_TOUCH_INTERVAL_MS = Math.max(0, Number(process.env.SESSION_TOUCH_INTERVAL_MS ?? 5 * 60_000) || 0);
const CACHE_MAX = 50_000;
const sessionCache = new Map();   // token hash -> { session, cachedAt, lastSeen }
const lastTouched = new Map();    // session id -> ms of the last last_seen_at write

function forgetSessions({ sessionIds = null, userId = null, exceptSessionId = null } = {}) {
  for (const [hash, entry] of sessionCache) {
    const { sessionId, userId: owner } = entry.session;
    if (sessionIds?.includes(sessionId) || (userId && owner === userId && sessionId !== exceptSessionId)) {
      sessionCache.delete(hash);
    }
  }
}
sessionEvents.on('revoked', (payload) => {
  forgetSessions(payload);
  publishBus('session-revoked', payload);
});
onBus('session-revoked', forgetSessions);

function touchSession(sessionId, now) {
  const last = lastTouched.get(sessionId) ?? 0;
  if (now - last < SESSION_TOUCH_INTERVAL_MS) return;
  if (lastTouched.size > CACHE_MAX * 2) lastTouched.clear();
  lastTouched.set(sessionId, now);
  // last_seen_at is best-effort; a failed touch must not fail the request.
  runQuery(`UPDATE sessions SET last_seen_at = ${sql.now} WHERE id = ?`, [sessionId]).catch(() => {});
}

/** Test seam / operational hook. */
export function clearSessionCache() {
  sessionCache.clear();
  lastTouched.clear();
}

/** Resolve a bearer/cookie token to a live session, or null. */
export async function resolveSession(token) {
  if (!token) return null;
  const tokenHash = hashToken(token);
  const cachedNow = Date.now();
  const hit = SESSION_CACHE_TTL_MS > 0 ? sessionCache.get(tokenHash) : null;
  if (hit && cachedNow - hit.cachedAt < SESSION_CACHE_TTL_MS) {
    const expired = hit.session.expiresAt && Date.parse(hit.session.expiresAt) <= cachedNow;
    if (expired || cachedNow - hit.lastSeen > SESSION_IDLE_MS) {
      sessionCache.delete(tokenHash);
      return null;
    }
    hit.lastSeen = cachedNow;
    touchSession(hit.session.sessionId, cachedNow);
    return { ...hit.session };
  }
  if (hit) sessionCache.delete(tokenHash);
  const row = await getQuery(
    `SELECT s.*, u.deleted_at AS user_deleted
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL`,
    [tokenHash]
  );
  if (!row) return null;
  if (row.user_deleted) return null;
  const now = Date.now();
  if (row.expires_at && row.expires_at < new Date(now).toISOString()) return null;
  const lastUsed = Date.parse(row.last_seen_at ?? row.created_at);
  if (Number.isFinite(lastUsed) && now - lastUsed > SESSION_IDLE_MS) return null;

  touchSession(row.id, now);
  const session = { sessionId: row.id, userId: row.user_id, expiresAt: row.expires_at };
  if (SESSION_CACHE_TTL_MS > 0) {
    if (sessionCache.size >= CACHE_MAX) sessionCache.delete(sessionCache.keys().next().value);
    sessionCache.set(tokenHash, { session, cachedAt: now, lastSeen: now });
  }
  return session;
}

export async function revokeSession(token) {
  if (!token) return false;
  const row = await getQuery(
    `SELECT id FROM sessions WHERE token_hash = ? AND revoked_at IS NULL`, [hashToken(token)]
  );
  if (!row) return false;
  const result = await runQuery(
    `UPDATE sessions SET revoked_at = ${sql.now} WHERE id = ? AND revoked_at IS NULL`, [row.id]
  );
  // Live sockets signed in with this session are disconnected too.
  if (result.changes > 0) announceRevoked({ sessionIds: [row.id] });
  return result.changes > 0;
}

/** Revoke one session by id, only if it belongs to userId. */
export async function revokeSessionById(userId, sessionId) {
  const result = await runQuery(
    `UPDATE sessions SET revoked_at = ${sql.now}
      WHERE id = ? AND user_id = ? AND revoked_at IS NULL`,
    [sessionId, userId]
  );
  if (result.changes > 0) announceRevoked({ sessionIds: [sessionId] });
  return result.changes > 0;
}

export async function revokeAllSessions(userId, { exceptToken = null } = {}) {
  const keep = exceptToken
    ? await getQuery(`SELECT id FROM sessions WHERE token_hash = ?`, [hashToken(exceptToken)])
    : null;
  await runQuery(
    `UPDATE sessions SET revoked_at = ${sql.now}
      WHERE user_id = ? AND revoked_at IS NULL
        ${exceptToken ? 'AND token_hash != ?' : ''}`,
    exceptToken ? [userId, hashToken(exceptToken)] : [userId]
  );
  announceRevoked({ userId, exceptSessionId: keep?.id ?? null });
}

export function listSessions(userId) {
  return getQuery(
    `SELECT count(*) AS active FROM sessions
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ${sql.now}`,
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
