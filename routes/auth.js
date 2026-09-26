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
import { ApiError, asyncRoute, unauthenticated } from '../lib/httpUtils.js';
import {
  hashPassword, verifyPassword, createSession, revokeSession, revokeSessionById,
  revokeAllSessions, extractToken, sessionCookie, clearedCookie, SESSION_TTL_MS
} from '../lib/auth.js';
import { loginRateLimit, rateLimit } from '../lib/rateLimit.js';
import { config } from '../lib/config.js';
import { sendMail } from '../lib/mailer.js';
import { verifyMfaChallenge } from '../services/accountSecurity.js';
import { checkBirthdate, ageGroupOf, applyMinorDefaults } from '../services/userSettings.js';
import {
  isAdminRow, claimFirstAdmin, getRegistrationMode
} from '../services/instanceAdmin.js';
import { getInvitePreview } from '../services/guilds.js';
import adminRouter from './admin.js';

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

// Account creation is unauthenticated and cheap to script; keyed by IP. A
// sign-up that carries a valid invite draws on its own, larger budget: a
// class or a club joining from one school Wi-Fi (one NAT address) is the
// normal case there, not an attack, and the invite's own max-uses still caps
// it.
const registerRateLimit = rateLimit({
  name: 'register',
  limit: Math.max(1, Number(process.env.RATE_LIMIT_REGISTER_PER_HOUR) || 20),
  windowMs: 60 * 60_000, byIpOnly: true
});
const inviteRegisterRateLimit = rateLimit({
  name: 'register-invite',
  limit: Math.max(1, Number(process.env.RATE_LIMIT_REGISTER_INVITE_PER_HOUR) || 100),
  windowMs: 60 * 60_000, byIpOnly: true
});

/** The invite a sign-up carries, when it is real and still usable; else null. */
async function validInvite(code) {
  const value = typeof code === 'string' ? code.trim() : '';
  if (!value || value.length > 64) return null;
  try { return await getInvitePreview(value); } catch { return null; }
}

/**
 * Pick the bucket, and turn a bare "too many requests" into something a person
 * can act on: how long to wait, and that it is the network, not them.
 */
const registerLimit = asyncRoute(async (req, res, next) => {
  req.registrationInvite = await validInvite(req.body?.invite_code);
  const limiter = req.registrationInvite ? inviteRegisterRateLimit : registerRateLimit;
  limiter(req, res, (err) => {
    if (err?.code === 'RATE_LIMITED') {
      const seconds = Number(err.details?.retry_after_seconds) || 60;
      const minutes = Math.max(1, Math.ceil(seconds / 60));
      return next(new ApiError(
        `Lots of people are signing up from this network. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`,
        { status: 429, code: 'REGISTER_RATE_LIMITED', details: { retry_after_seconds: seconds, minutes } }
      ));
    }
    return next(err);
  });
});

// REQUIRE_BIRTHDATE=1 makes the date of birth mandatory at sign-up (the UI
// always asks; by default an account without one is asked once afterwards).
const birthdateRequired = () => ['1', 'true', 'yes', 'on'].includes(String(process.env.REQUIRE_BIRTHDATE ?? '').toLowerCase());

/** Is this still an empty instance (the first account bootstraps it)? */
async function isFirstAccount() {
  const row = await getQuery(
    `SELECT 1 FROM users WHERE deleted_at IS NULL AND is_bot = 0 AND is_system = 0
        AND password_hash IS NOT NULL LIMIT 1`
  );
  return !row;
}

/**
 * Account flags every client needs right after sign-in: whether to show the
 * admin console, and the age group (never the birth date itself).
 */
async function accountFlags(userId) {
  const row = await getQuery(
    `SELECT instance_admin, email, email_verified, deleted_at, disabled_at, birth_year, birth_month
       FROM users WHERE id = ?`, [userId]
  );
  return {
    is_instance_admin: isAdminRow(row),
    birthdate_set: row?.birth_year != null,
    age_group: ageGroupOf(row)
  };
}

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

/** Public: what the sign-up form should offer. */
router.get('/auth/registration', asyncRoute(async (_req, res) => {
  const { mode } = await getRegistrationMode();
  const first = await isFirstAccount();
  res.json({
    mode: first ? 'open' : mode,
    invite_required: !first && mode === 'invite',
    first_account: first,
    minimum_age: 13,
    birthdate_required: birthdateRequired()
  });
}));

router.post('/auth/register', registerLimit, asyncRoute(async (req, res) => {
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

  // Who may sign up at all (REGISTRATION_MODE, or the admin's override). The
  // very first account is always allowed: it is the one that runs the place.
  if (!(await isFirstAccount())) {
    const { mode } = await getRegistrationMode();
    if (mode === 'closed') {
      throw new ApiError('Sign-ups are closed on this server', { status: 403, code: 'REGISTRATION_CLOSED' });
    }
    if (mode === 'invite' && !req.registrationInvite) {
      throw new ApiError('Sign-ups on this server need an invite link', { status: 403, code: 'INVITE_REQUIRED' });
    }
  }

  // Age gate (13+). The day is checked here and then thrown away: only the
  // year and month are stored.
  const birth = req.body?.birth_date ?? (req.body?.birth_year != null
    ? { year: req.body.birth_year, month: req.body.birth_month, day: req.body.birth_day }
    : null);
  if (!birth && birthdateRequired()) {
    throw new ApiError('Enter your date of birth', { code: 'BIRTHDATE_REQUIRED' });
  }
  const checkedBirth = birth ? checkBirthdate(birth) : null;
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
        `INSERT INTO users (id, username, discriminator, display_name, email, password_hash, status,
                            birth_year, birth_month)
         VALUES (?, ?, ?, ?, ?, ?, 'online', ?, ?)`,
        [id, username, discriminator, displayName || username, email, passwordHash,
         checkedBirth?.year ?? null, checkedBirth?.month ?? null]
      );
    });
  } catch (err) {
    // Lost a race for the same username (the unique index decides).
    if (isUniqueViolation(err)) throw usernameTaken();
    throw err;
  }

  // The first account on an empty instance administers it.
  await claimFirstAdmin(id);
  // Teen accounts start with the protective privacy defaults stored.
  if (checkedBirth && ageGroupOf({ birth_year: checkedBirth.year, birth_month: checkedBirth.month }) === 'minor') {
    await applyMinorDefaults(id);
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
  res.status(201).json({
    user: { ...user, email: requestedEmail, ...(await accountFlags(id)) }, token, expires_at: expiresAt
  });
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
  // Said only after the password proved who is asking.
  if (user.disabled_at) {
    throw new ApiError('This account has been disabled by the administrators of this server',
      { status: 403, code: 'ACCOUNT_DISABLED' });
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
  res.json({ user: { ...publicUser, ...(await accountFlags(user.id)) }, token, expires_at: expiresAt });
}));

router.post('/auth/logout', asyncRoute(async (req, res) => {
  // Also disconnects any socket that signed in with this session.
  await revokeSession(extractToken(req));
  res.setHeader('Set-Cookie', clearedCookie());
  res.json({ success: true });
}));

router.post('/auth/logout-all', asyncRoute(async (req, res) => {
  if (!req.userId) throw unauthenticated(req);
  await revokeAllSessions(req.userId, { exceptToken: extractToken(req) });
  res.json({ success: true });
}));

router.get('/auth/me', asyncRoute(async (req, res) => {
  if (!req.userId) throw unauthenticated(req);
  const user = await getQuery(
    `SELECT ${PUBLIC_USER} FROM users WHERE id = ? AND deleted_at IS NULL`, [req.userId]
  );
  if (!user) throw unauthenticated(req);
  res.json({
    user: { ...user, ...(await accountFlags(req.userId)) },
    session_id: req.sessionId ?? null,
    dev_identity: !req.sessionId
  });
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
  if (!req.userId) throw unauthenticated(req);
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
  if (!req.userId) throw unauthenticated(req);
  // Revoking a device also drops its live socket connections.
  await revokeSessionById(req.userId, req.params.sessionId);
  res.json({ success: true });
}));

router.post('/auth/change-password', passwordChangeRateLimit, asyncRoute(async (req, res) => {
  if (!req.userId) throw unauthenticated(req);
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

// The instance admin console (/api/admin/*), mounted here so it needs no
// wiring in server.js. Every route in it checks instance-admin rights itself.
router.use(adminRouter);

export default router;
export { SESSION_TTL_MS };
