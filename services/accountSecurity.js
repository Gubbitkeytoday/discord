// ============================================================================
//  Account security: MFA enrolment, email verification and password reset.
//
//  All three share the same shape — issue a single-use token, store only its
//  hash, expire it quickly — so they live together.
// ============================================================================

import crypto from 'crypto';

import { runQuery, getQuery, allQuery, transaction, sql } from '../db.js';
import { generateId } from '../lib/snowflake.js';
import { ApiError } from '../lib/httpUtils.js';
import {
  generateSecret, verifyCode, matchCodeStep, buildOtpAuthUri,
  generateRecoveryCodes, hashRecoveryCode
} from '../lib/totp.js';
import { hashPassword, verifyPassword, revokeAllSessions } from '../lib/auth.js';
import { currentTransport } from '../lib/mailer.js';

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;   // email confirmation
const RESET_TTL_MS = 60 * 60 * 1000;         // password reset — deliberately short

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

const isProduction = () => process.env.NODE_ENV === 'production';

/**
 * Whether a mailed token may also be handed back in the HTTP response. Only
 * ever in development with the console transport — the one case where the
 * "mail" is a log line on the developer's own terminal. Keyed on the transport
 * actually in effect, not on whether MAIL_TRANSPORT happens to be set: an
 * unset variable in production used to return the token to anyone who asked,
 * which is an account takeover.
 */
const exposeDevToken = () => !isProduction() && currentTransport() === 'console';

/**
 * A production server with no real mail transport cannot deliver a reset or
 * verification link, and must not pretend to. Refusing is the same answer for
 * every address, so it discloses nothing about which accounts exist.
 */
function assertMailDeliverable() {
  if (isProduction() && currentTransport() === 'console') {
    throw new ApiError('E-mail delivery is not configured on this server', {
      status: 503, code: 'MAIL_NOT_CONFIGURED'
    });
  }
}

// --- MFA ---------------------------------------------------------------------

/**
 * Step 1 of enrolment: hand back a secret and its QR URI. Nothing is enabled
 * yet — the user must prove they can generate a code first, otherwise a failed
 * setup would lock them out.
 */
export async function beginMfaEnrolment({ userId }) {
  const user = await getQuery(
    `SELECT username, mfa_enabled FROM users WHERE id = ? AND deleted_at IS NULL`, [userId]
  );
  if (!user) throw ApiError.notFound('User');
  if (user.mfa_enabled) throw new ApiError('Two-factor authentication is already on', { status: 409, code: 'MFA_ALREADY_ENABLED' });

  const secret = generateSecret();
  // Parked in mfa_secret but mfa_enabled stays 0, so it is not yet enforced.
  await runQuery(`UPDATE users SET mfa_secret = ? WHERE id = ?`, [secret, userId]);

  return {
    secret,
    otpauth_uri: buildOtpAuthUri({ secret, accountName: user.username }),
    // Manual-entry formatting, for when the camera will not cooperate.
    manual_entry: secret.match(/.{1,4}/g).join(' ')
  };
}

/** Step 2: confirm a code, enable MFA, and issue recovery codes. */
export async function confirmMfaEnrolment({ userId, code }) {
  const user = await getQuery(
    `SELECT mfa_secret, mfa_enabled FROM users WHERE id = ?`, [userId]
  );
  if (!user?.mfa_secret) throw new ApiError('Two-factor setup has not been started', { code: 'MFA_NOT_STARTED' });
  if (user.mfa_enabled) throw new ApiError('Two-factor authentication is already on', { status: 409, code: 'MFA_ALREADY_ENABLED' });

  // Proving the authenticator works is not an authentication, so the step is
  // not recorded as used here; replay protection applies to sign-ins and to
  // turning MFA off.
  if (!verifyCode(user.mfa_secret, code)) {
    throw new ApiError('That code is not valid — try again', { status: 401, code: 'INVALID_MFA_CODE' });
  }

  const recoveryCodes = generateRecoveryCodes();

  await transaction(async () => {
    await runQuery(`UPDATE users SET mfa_enabled = 1 WHERE id = ?`, [userId]);
    // Used-step bookkeeping belongs to the previous secret, if any.
    await runQuery(`DELETE FROM user_settings WHERE user_id = ? AND category = ?`, [userId, MFA_STATE]);
    // Recovery codes are stored hashed and single-use, exactly like tokens.
    for (const recoveryCode of recoveryCodes) {
      await runQuery(
        `INSERT INTO account_tokens (id, user_id, kind, token_hash, expires_at)
         VALUES (?, ?, 'recovery', ?, NULL)`,
        [generateId(), userId, hashRecoveryCode(recoveryCode)]
      );
    }
  });

  return { enabled: true, recovery_codes: recoveryCodes };
}

/**
 * Turning MFA off is exactly what someone holding a stolen session would do
 * first, so it needs both factors again: the account password (step-up
 * re-authentication) and a current code or a recovery code.
 */
export async function disableMfa({ userId, code, password }) {
  const user = await getQuery(
    `SELECT mfa_secret, mfa_enabled, password_hash FROM users WHERE id = ?`, [userId]
  );
  if (!user?.mfa_enabled) throw new ApiError('Two-factor authentication is not on', { code: 'MFA_NOT_ENABLED' });

  if (user.password_hash && !(await verifyPassword(password ?? '', user.password_hash))) {
    throw new ApiError('Your password is required to turn off two-factor authentication', {
      status: 401, code: 'PASSWORD_REQUIRED'
    });
  }
  if (!(await verifyMfaChallenge({ userId, code }))) {
    throw new ApiError('That two-factor code is not valid', { status: 401, code: 'INVALID_MFA_CODE' });
  }

  await transaction(async () => {
    await runQuery(`UPDATE users SET mfa_enabled = 0, mfa_secret = NULL WHERE id = ?`, [userId]);
    await runQuery(`DELETE FROM account_tokens WHERE user_id = ? AND kind = 'recovery'`, [userId]);
    await runQuery(`DELETE FROM user_settings WHERE user_id = ? AND category = ?`, [userId, MFA_STATE]);
  });
  return { enabled: false };
}

/**
 * Check a second factor: a TOTP code (each time step accepted at most once
 * per account) or an unused recovery code (burned on use). Used by login,
 * MFA disable and any other step-up check.
 */
export async function verifyMfaChallenge({ userId, code }) {
  const user = await getQuery(
    `SELECT mfa_secret, mfa_enabled FROM users WHERE id = ?`, [userId]
  );
  if (!user?.mfa_enabled) return true;                 // nothing to check
  const step = matchCodeStep(user.mfa_secret, code);
  if (step !== null) return claimTotpStep(userId, step);
  return consumeRecoveryCode({ userId, code });
}

// The last accepted TOTP step lives in user_settings under a reserved
// category that the settings API never lists or accepts (it only serves the
// categories in SETTING_DEFAULTS). A dedicated column would need a schema
// version bump shared with the client; this needs none and is just as
// durable across restarts.
const MFA_STATE = '__mfa';

/**
 * Record `step` as used, unless it (or a later step) already was. Runs as a
 * transaction, so two concurrent sign-ins with the same code cannot both
 * succeed: SQLite serialises them and Postgres (SERIALIZABLE) aborts one.
 */
async function claimTotpStep(userId, step) {
  return transaction(async () => {
    const row = await getQuery(
      `SELECT data FROM user_settings WHERE user_id = ? AND category = ?`, [userId, MFA_STATE]
    );
    let last = -1;
    try { last = Number(JSON.parse(row?.data ?? '{}').last_step ?? -1); } catch { /* corrupt → treat as unused */ }
    if (step <= last) return false;       // replay, or an older code after a newer one
    await runQuery(
      `INSERT INTO user_settings (user_id, category, data) VALUES (?, ?, ?)
       ON CONFLICT (user_id, category) DO UPDATE SET data = excluded.data, updated_at = ${sql.now}`,
      [userId, MFA_STATE, JSON.stringify({ last_step: step })]
    );
    return true;
  });
}

async function consumeRecoveryCode({ userId, code }) {
  const hash = hashRecoveryCode(code ?? '');
  // One conditional UPDATE: burning the code and checking it was unused are
  // the same statement, so it cannot be spent twice concurrently.
  const row = await getQuery(
    `SELECT id FROM account_tokens
      WHERE user_id = ? AND kind = 'recovery' AND token_hash = ? AND used_at IS NULL`,
    [userId, hash]
  );
  if (!row) return false;
  const burned = await runQuery(
    `UPDATE account_tokens SET used_at = ${sql.now} WHERE id = ? AND used_at IS NULL`,
    [row.id]
  );
  return burned.changes === 1;
}

export async function countRecoveryCodes(userId) {
  const { remaining } = await getQuery(
    `SELECT count(*) AS remaining FROM account_tokens
      WHERE user_id = ? AND kind = 'recovery' AND used_at IS NULL`,
    [userId]
  );
  return remaining;
}

/**
 * Step-up re-authentication for destructive account actions: the password,
 * and — when MFA is on — a second factor too.
 */
export async function assertReauthenticated({ userId, password, code }) {
  const user = await getQuery(
    `SELECT password_hash, mfa_enabled FROM users WHERE id = ? AND deleted_at IS NULL`, [userId]
  );
  if (!user) throw ApiError.notFound('User');
  if (user.password_hash && !(await verifyPassword(password ?? '', user.password_hash))) {
    throw new ApiError('Confirm with your password to continue', { status: 401, code: 'PASSWORD_REQUIRED' });
  }
  if (user.mfa_enabled) {
    if (!code) {
      throw new ApiError('A two-factor authentication code is required', { status: 401, code: 'MFA_REQUIRED' });
    }
    if (!(await verifyMfaChallenge({ userId, code }))) {
      throw new ApiError('That two-factor code is not valid', { status: 401, code: 'INVALID_MFA_CODE' });
    }
  }
}

// --- email verification ------------------------------------------------------

export async function requestEmailVerification({ userId, sendMail }) {
  assertMailDeliverable();
  const user = await getQuery(
    `SELECT email, email_verified, username FROM users WHERE id = ?`, [userId]
  );
  if (!user?.email) throw new ApiError('This account has no e-mail address', { code: 'NO_EMAIL' });
  if (user.email_verified) throw new ApiError('Your e-mail address is already verified', { status: 409, code: 'EMAIL_ALREADY_VERIFIED' });

  const token = crypto.randomBytes(32).toString('base64url');
  await runQuery(
    `INSERT INTO account_tokens (id, user_id, kind, token_hash, expires_at)
     VALUES (?, ?, 'email_verify', ?, ?)`,
    [generateId(), userId, hashToken(token),
     new Date(Date.now() + VERIFY_TTL_MS).toISOString()]
  );

  await sendMail({
    to: user.email,
    subject: 'Verify your e-mail — Antigravity Discord',
    text: `Hello ${user.username},\n\nConfirm your e-mail address with this link (valid for 24 hours):\n`
        + `${process.env.PUBLIC_URL ?? 'http://localhost:5173'}/verify-email?token=${token}\n`
  });

  return { sent: true, ...(exposeDevToken() ? { dev_token: token } : {}) };
}

export async function verifyEmail({ token }) {
  const row = await getQuery(
    `SELECT * FROM account_tokens
      WHERE kind = 'email_verify' AND token_hash = ? AND used_at IS NULL`,
    [hashToken(String(token ?? ''))]
  );
  if (!row || (row.expires_at && row.expires_at < new Date().toISOString())) {
    throw new ApiError('This verification link is invalid or has expired', { status: 410, code: 'INVALID_TOKEN' });
  }

  await transaction(async () => {
    await runQuery(`UPDATE users SET email_verified = 1 WHERE id = ?`, [row.user_id]);
    await runQuery(
      `UPDATE account_tokens SET used_at = ${sql.now} WHERE id = ?`,
      [row.id]
    );
  });
  return { verified: true };
}

// --- password reset ----------------------------------------------------------

/**
 * Always reports success, whether or not the address exists — otherwise this
 * endpoint becomes an account-enumeration oracle.
 */
export async function requestPasswordReset({ email, sendMail }) {
  assertMailDeliverable();
  const user = await getQuery(
    `SELECT id, username, email FROM users WHERE email = ? AND deleted_at IS NULL`,
    [String(email ?? '').trim().toLowerCase()]
  );

  if (user) {
    const token = crypto.randomBytes(32).toString('base64url');
    await runQuery(
      `INSERT INTO account_tokens (id, user_id, kind, token_hash, expires_at)
       VALUES (?, ?, 'password_reset', ?, ?)`,
      [generateId(), user.id, hashToken(token),
       new Date(Date.now() + RESET_TTL_MS).toISOString()]
    );
    await sendMail({
      to: user.email,
      subject: 'Reset your password — Antigravity Discord',
      text: `Hello ${user.username},\n\nChoose a new password with this link (valid for 1 hour):\n`
          + `${process.env.PUBLIC_URL ?? 'http://localhost:5173'}/reset-password?token=${token}\n\n`
          + `If you did not ask for this, ignore this e-mail.`
    });
    return { sent: true, ...(exposeDevToken() ? { dev_token: token } : {}) };
  }

  return { sent: true };
}

export async function resetPassword({ token, newPassword }) {
  const row = await getQuery(
    `SELECT * FROM account_tokens
      WHERE kind = 'password_reset' AND token_hash = ? AND used_at IS NULL`,
    [hashToken(String(token ?? ''))]
  );
  if (!row || (row.expires_at && row.expires_at < new Date().toISOString())) {
    throw new ApiError('This reset link is invalid or has expired', { status: 410, code: 'INVALID_TOKEN' });
  }

  const hashed = await hashPassword(newPassword);

  await transaction(async () => {
    await runQuery(`UPDATE users SET password_hash = ? WHERE id = ?`, [hashed, row.user_id]);
    await runQuery(
      `UPDATE account_tokens SET used_at = ${sql.now} WHERE id = ?`,
      [row.id]
    );
    // Any other outstanding reset links for this account are now void.
    await runQuery(
      `UPDATE account_tokens SET used_at = ${sql.now}
        WHERE user_id = ? AND kind = 'password_reset' AND used_at IS NULL`,
      [row.user_id]
    );
  });

  // A reset means "I lost control of this account": end every session.
  await revokeAllSessions(row.user_id);
  return { reset: true };
}

/** Housekeeping for the periodic sweep. */
export async function pruneAccountTokens() {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const result = await runQuery(
    `DELETE FROM account_tokens
      WHERE kind != 'recovery' AND (expires_at < ? OR used_at < ?)`,
    [cutoff, cutoff]
  );
  return result.changes;
}

export function listTokens(userId) {
  return allQuery(
    `SELECT id, kind, created_at, expires_at, used_at FROM account_tokens WHERE user_id = ?`,
    [userId]
  );
}
