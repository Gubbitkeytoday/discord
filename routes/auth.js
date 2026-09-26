// ============================================================================
//  /api/auth — register, login, logout, session listing.
//
//  Error bodies carry an English `error` for logs and a stable machine `code`
//  (INVALID_CREDENTIALS, USERNAME_TAKEN, MFA_REQUIRED, …) that the client maps
//  to its own translations.
// ============================================================================

import express from 'express';

import { runQuery, getQuery, allQuery, transaction, sql, isUniqueViolation } from '../db.js';
import { generateId } from '../lib/snowflake.js';
import { ApiError, asyncRoute } from '../lib/httpUtils.js';
import {
  hashPassword, verifyPassword, createSession, revokeSession, revokeSessionById,
  revokeAllSessions, extractToken, sessionCookie, clearedCookie, SESSION_TTL_MS
} from '../lib/auth.js';
import { loginRateLimit, rateLimit } from '../lib/rateLimit.js';
import { config } from '../lib/config.js';
import { sendMail } from '../lib/mailer.js';
import { verifyMfaChallenge } from '../services/accountSecurity.js';

const router = express.Router();

const USERNAME = /^[a-zA-Z0-9_.฀-๿-]{2,32}$/;
// Linear-time check (no backtracking regex on user input): one '@', no
// whitespace, a dotted domain, and the RFC 5321 length cap.
function isValidEmail(value) {
  if (value.length > 254 || /\s/.test(value)) return false;
  const at = value.indexOf('@');
  if (at < 1 || at !== value.lastIndexOf('@')) return false;
  const domain = value.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  return dot > 0 && dot < domain.length - 1;
}

const PUBLIC_USER = `
  id, username, discriminator, display_name, email, avatar_url, banner_url,
  bio, pronouns, status, custom_status, theme, locale, is_bot, mfa_enabled,
  storage_used, storage_quota, created_at
`;

// From validated config, which defaults to on in production and understands
// 'true'/'yes' as well as '1' — reading the raw env here used to leave cookies
// without Secure in production unless the value was exactly '1'.
const secureCookies = config.secureCookies;

// Account creation is unauthenticated and cheap to script; keyed by IP.
const registerRateLimit = rateLimit({
  name: 'register',
  limit: Math.max(1, Number(process.env.RATE_LIMIT_REGISTER_PER_HOUR) || 10),
  windowMs: 60 * 60_000, byIpOnly: true
});

const usernameTaken = () => new ApiError('That username is taken', { status: 409, code: 'USERNAME_TAKEN' });

/** Four random digits, avoiding a collision with the same username. */
async function allocateDiscriminator(username) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = String(Math.floor(1000 + Math.random() * 9000));
    const clash = await getQuery(
      `SELECT 1 FROM users WHERE username = ? AND discriminator = ?`, [username, candidate]
    );
    if (!clash) return candidate;
  }
  throw usernameTaken();
}

// Each attempt runs a deliberately slow password hash, and a stolen session
// must not get the global read budget (600/min) of current-password guesses.
const passwordChangeRateLimit = rateLimit({ name: 'password-change', limit: 10, windowMs: 15 * 60_000 });

router.post('/auth/register', registerRateLimit, asyncRoute(async (req, res) => {
  const username = String(req.body?.username ?? '').trim();
  const displayName = String(req.body?.display_name ?? username).trim().slice(0, 80);
  const requestedEmail = req.body?.email ? String(req.body.email).trim().toLowerCase() : null;
  const password = req.body?.password;

  if (!USERNAME.test(username)) {
    throw new ApiError('Usernames are 2-32 characters: letters, digits, Thai, _ . -',
      { code: 'INVALID_USERNAME' });
  }
  if (requestedEmail && !isValidEmail(requestedEmail)) {
    throw new ApiError('That e-mail address is not valid', { code: 'INVALID_EMAIL' });
  }
  // Usernames are public (they are shown everywhere), so saying one is taken
  // discloses nothing. Usernames are unique: login by username is unambiguous.
  if (await getQuery(`SELECT 1 FROM users WHERE username = ? AND deleted_at IS NULL`, [username])) {
    throw usernameTaken();
  }

  // E-mail addresses are private. A distinct answer for "already registered"
  // would make this endpoint an oracle for who has an account — exactly what
  // forgot-password is careful not to be. So the response is the same either
  // way: the account is created, and when the address already belongs to
  // someone it is simply not attached; its owner is told out of band.
  const emailOwner = requestedEmail
    ? await getQuery(`SELECT id, username FROM users WHERE email = ? AND deleted_at IS NULL`, [requestedEmail])
    : null;
  const email = emailOwner ? null : requestedEmail;

  const passwordHash = await hashPassword(password);
  const discriminator = await allocateDiscriminator(username);
  const id = generateId();

  try {
    await transaction(async () => {
      await runQuery(
        `INSERT INTO users (id, username, discriminator, display_name, email, password_hash, status)
         VALUES (?, ?, ?, ?, ?, ?, 'online')`,
        [id, username, discriminator, displayName || username, email, passwordHash]
      );
    });
  } catch (err) {
    // Lost a race for the same username (the unique index decides).
    if (isUniqueViolation(err)) throw usernameTaken();
    throw err;
  }

  if (emailOwner) {
    sendMail({
      to: requestedEmail,
      subject: 'Someone tried to register with your e-mail address',
      text: `Hello ${emailOwner.username},\n\nSomeone just tried to create a new account with this address. `
        + 'It already belongs to your account, so it was not attached to the new one.\n\n'
        + 'If that was you, sign in instead — or use "Forgot password" if you cannot.\n'
    }).catch(() => {});
  }

  const { token, expiresAt } = await createSession({
    userId: id, ip: req.ip, userAgent: req.get('user-agent'), deviceName: req.body?.device ?? null
  });
  res.setHeader('Set-Cookie', sessionCookie(token, { secure: secureCookies }));

  const user = await getQuery(`SELECT ${PUBLIC_USER} FROM users WHERE id = ?`, [id]);
  // Echo what was asked for, identically in both cases; whether the address is
  // attached shows up only after it is verified (/api/auth/me, email_verified).
  res.status(201).json({ user: { ...user, email: requestedEmail }, token, expires_at: expiresAt });
}));

router.post('/auth/login', loginRateLimit, asyncRoute(async (req, res) => {
  const identifier = String(req.body?.username ?? req.body?.email ?? '').trim();
  const password = req.body?.password ?? '';

  // Exactly one way to match: an address containing '@' is an e-mail (unique),
  // anything else a username (unique). Never "whichever column happens to hit".
  const user = identifier.includes('@')
    ? await getQuery(`SELECT * FROM users WHERE deleted_at IS NULL AND email = ?`, [identifier.toLowerCase()])
    : await getQuery(`SELECT * FROM users WHERE deleted_at IS NULL AND username = ?`, [identifier]);

  // Always run a verification, even for an unknown user, so a missing account
  // and a wrong password take the same time.
  const ok = await verifyPassword(password, user?.password_hash ?? 'scrypt$16384$8$1$AA$AA');
  if (!user || !ok) {
    throw new ApiError('Incorrect username or password', { status: 401, code: 'INVALID_CREDENTIALS' });
  }

  // Second factor. Without this, enabling 2FA protected nothing: a password
  // alone still produced a full session. No session is issued until a valid
  // TOTP or single-use recovery code arrives alongside the password.
  if (user.mfa_enabled) {
    const code = String(req.body?.mfa_code ?? req.body?.code ?? '').trim();
    if (!code) {
      throw new ApiError('A two-factor authentication code is required', { status: 401, code: 'MFA_REQUIRED' });
    }
    if (!(await verifyMfaChallenge({ userId: user.id, code }))) {
      throw new ApiError('That two-factor code is not valid', { status: 401, code: 'INVALID_MFA_CODE' });
    }
  }

  const { token, expiresAt } = await createSession({
    userId: user.id, ip: req.ip, userAgent: req.get('user-agent'), deviceName: req.body?.device ?? null
  });
  res.setHeader('Set-Cookie', sessionCookie(token, { secure: secureCookies }));

  const publicUser = await getQuery(`SELECT ${PUBLIC_USER} FROM users WHERE id = ?`, [user.id]);
  res.json({ user: publicUser, token, expires_at: expiresAt });
}));

router.post('/auth/logout', asyncRoute(async (req, res) => {
  // Also disconnects any socket that signed in with this session.
  await revokeSession(extractToken(req));
  res.setHeader('Set-Cookie', clearedCookie());
  res.json({ success: true });
}));

router.post('/auth/logout-all', asyncRoute(async (req, res) => {
  if (!req.userId) throw ApiError.unauthorized();
  await revokeAllSessions(req.userId, { exceptToken: extractToken(req) });
  res.json({ success: true });
}));

router.get('/auth/me', asyncRoute(async (req, res) => {
  if (!req.userId) throw ApiError.unauthorized();
  const user = await getQuery(
    `SELECT ${PUBLIC_USER} FROM users WHERE id = ? AND deleted_at IS NULL`, [req.userId]
  );
  if (!user) throw ApiError.unauthorized();
  res.json({ user, session_id: req.sessionId ?? null, dev_identity: !req.sessionId });
}));

/**
 * Seeded accounts for one-click sign-in during development. Returns an empty
 * list — and never a password — unless the dev identity shortcut is enabled,
 * which lib/config.js refuses to allow in production.
 */
router.get('/auth/dev-accounts', asyncRoute(async (_req, res) => {
  if (!config.allowDevIdentity) { res.json([]); return; }
  const { SEED_PASSWORD } = await import('../db/seed.js').catch(() => ({ SEED_PASSWORD: null }));
  if (!SEED_PASSWORD) { res.json([]); return; }
  const users = await allQuery(
    `SELECT id, username, display_name, avatar_url FROM users
      WHERE deleted_at IS NULL AND is_bot = 0 AND id LIKE 'user-%'
      ORDER BY display_name LIMIT 10`
  );
  res.json(users.map((u) => ({ ...u, dev_password: SEED_PASSWORD })));
}));

router.get('/auth/sessions', asyncRoute(async (req, res) => {
  if (!req.userId) throw ApiError.unauthorized();
  const sessions = await allQuery(
    `SELECT id, device_name, platform, ip_address, user_agent, created_at, last_seen_at, expires_at
       FROM sessions
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ${sql.now}
      ORDER BY last_seen_at DESC NULLS LAST, created_at DESC`,
    [req.userId]
  );
  res.json(sessions.map((s) => ({ ...s, current: s.id === req.sessionId })));
}));

router.delete('/auth/sessions/:sessionId', asyncRoute(async (req, res) => {
  if (!req.userId) throw ApiError.unauthorized();
  // Revoking a device also drops its live socket connections.
  await revokeSessionById(req.userId, req.params.sessionId);
  res.json({ success: true });
}));

router.post('/auth/change-password', passwordChangeRateLimit, asyncRoute(async (req, res) => {
  if (!req.userId) throw ApiError.unauthorized();
  const user = await getQuery(`SELECT password_hash FROM users WHERE id = ?`, [req.userId]);

  // A user created before auth existed has no password yet; allow setting one.
  if (user?.password_hash) {
    const ok = await verifyPassword(req.body?.current_password ?? '', user.password_hash);
    if (!ok) throw new ApiError('Your current password is incorrect', { status: 401, code: 'INVALID_CREDENTIALS' });
  }

  const hashed = await hashPassword(req.body?.new_password);
  await runQuery(`UPDATE users SET password_hash = ? WHERE id = ?`, [hashed, req.userId]);
  // Changing a password must invalidate other devices (and their sockets).
  await revokeAllSessions(req.userId, { exceptToken: extractToken(req) });
  res.json({ success: true });
}));

export default router;
export { SESSION_TTL_MS };
