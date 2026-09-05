// ============================================================================
//  Account security: MFA enrolment, email verification and password reset.
//
//  All three share the same shape — issue a single-use token, store only its
//  hash, expire it quickly — so they live together.
// ============================================================================

import crypto from 'crypto';

import { runQuery, getQuery, allQuery, transaction } from '../db.js';
import { generateId } from '../lib/snowflake.js';
import { ApiError } from '../lib/httpUtils.js';
import {
  generateSecret, verifyCode, buildOtpAuthUri,
  generateRecoveryCodes, hashRecoveryCode
} from '../lib/totp.js';
import { hashPassword, revokeAllSessions } from '../lib/auth.js';

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;   // email confirmation
const RESET_TTL_MS = 60 * 60 * 1000;         // password reset — deliberately short

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

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
  if (user.mfa_enabled) throw ApiError.conflict('เปิด 2FA อยู่แล้ว');

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
  if (!user?.mfa_secret) throw new ApiError('ยังไม่ได้เริ่มตั้งค่า 2FA', { code: 'MFA_NOT_STARTED' });
  if (user.mfa_enabled) throw ApiError.conflict('เปิด 2FA อยู่แล้ว');

  if (!verifyCode(user.mfa_secret, code)) {
    throw new ApiError('รหัสไม่ถูกต้อง ลองใหม่อีกครั้ง', { status: 401, code: 'INVALID_MFA_CODE' });
  }

  const recoveryCodes = generateRecoveryCodes();

  await transaction(async () => {
    await runQuery(`UPDATE users SET mfa_enabled = 1 WHERE id = ?`, [userId]);
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

export async function disableMfa({ userId, code }) {
  const user = await getQuery(
    `SELECT mfa_secret, mfa_enabled FROM users WHERE id = ?`, [userId]
  );
  if (!user?.mfa_enabled) throw new ApiError('ยังไม่ได้เปิด 2FA', { code: 'MFA_NOT_ENABLED' });

  // Turning MFA *off* also requires a valid code; otherwise a stolen session
  // could quietly remove the second factor.
  const ok = verifyCode(user.mfa_secret, code) || await consumeRecoveryCode({ userId, code });
  if (!ok) throw new ApiError('รหัสไม่ถูกต้อง', { status: 401, code: 'INVALID_MFA_CODE' });

  await transaction(async () => {
    await runQuery(`UPDATE users SET mfa_enabled = 0, mfa_secret = NULL WHERE id = ?`, [userId]);
    await runQuery(`DELETE FROM account_tokens WHERE user_id = ? AND kind = 'recovery'`, [userId]);
  });
  return { enabled: false };
}

/** Used by the login flow when the account has MFA on. */
export async function verifyMfaChallenge({ userId, code }) {
  const user = await getQuery(
    `SELECT mfa_secret, mfa_enabled FROM users WHERE id = ?`, [userId]
  );
  if (!user?.mfa_enabled) return true;                 // nothing to check
  if (verifyCode(user.mfa_secret, code)) return true;
  return consumeRecoveryCode({ userId, code });
}

async function consumeRecoveryCode({ userId, code }) {
  const hash = hashRecoveryCode(code ?? '');
  const row = await getQuery(
    `SELECT id FROM account_tokens
      WHERE user_id = ? AND kind = 'recovery' AND token_hash = ? AND used_at IS NULL`,
    [userId, hash]
  );
  if (!row) return false;
  // Single use: burn it immediately.
  await runQuery(
    `UPDATE account_tokens SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    [row.id]
  );
  return true;
}

export async function countRecoveryCodes(userId) {
  const { remaining } = await getQuery(
    `SELECT count(*) AS remaining FROM account_tokens
      WHERE user_id = ? AND kind = 'recovery' AND used_at IS NULL`,
    [userId]
  );
  return remaining;
}

// --- email verification ------------------------------------------------------

export async function requestEmailVerification({ userId, sendMail }) {
  const user = await getQuery(
    `SELECT email, email_verified, username FROM users WHERE id = ?`, [userId]
  );
  if (!user?.email) throw new ApiError('บัญชีนี้ยังไม่มีอีเมล', { code: 'NO_EMAIL' });
  if (user.email_verified) throw ApiError.conflict('ยืนยันอีเมลแล้ว');

  const token = crypto.randomBytes(32).toString('base64url');
  await runQuery(
    `INSERT INTO account_tokens (id, user_id, kind, token_hash, expires_at)
     VALUES (?, ?, 'email_verify', ?, ?)`,
    [generateId(), userId, hashToken(token),
     new Date(Date.now() + VERIFY_TTL_MS).toISOString()]
  );

  await sendMail({
    to: user.email,
    subject: 'ยืนยันอีเมลของคุณ — Antigravity Discord',
    text: `สวัสดี ${user.username}\n\nยืนยันอีเมลได้ที่ลิงก์นี้ (หมดอายุใน 24 ชั่วโมง):\n`
        + `${process.env.PUBLIC_URL ?? 'http://localhost:5173'}/verify-email?token=${token}\n`
  });

  // The token is returned only when mail delivery is not configured, so a dev
  // environment is still usable. Never in production.
  return { sent: true, ...(process.env.MAIL_TRANSPORT ? {} : { dev_token: token }) };
}

export async function verifyEmail({ token }) {
  const row = await getQuery(
    `SELECT * FROM account_tokens
      WHERE kind = 'email_verify' AND token_hash = ? AND used_at IS NULL`,
    [hashToken(String(token ?? ''))]
  );
  if (!row || (row.expires_at && row.expires_at < new Date().toISOString())) {
    throw new ApiError('ลิงก์ยืนยันไม่ถูกต้องหรือหมดอายุ', { status: 410, code: 'INVALID_TOKEN' });
  }

  await transaction(async () => {
    await runQuery(`UPDATE users SET email_verified = 1 WHERE id = ?`, [row.user_id]);
    await runQuery(
      `UPDATE account_tokens SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
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
      subject: 'ตั้งรหัสผ่านใหม่ — Antigravity Discord',
      text: `สวัสดี ${user.username}\n\nตั้งรหัสผ่านใหม่ได้ที่ลิงก์นี้ (หมดอายุใน 1 ชั่วโมง):\n`
          + `${process.env.PUBLIC_URL ?? 'http://localhost:5173'}/reset-password?token=${token}\n\n`
          + `ถ้าไม่ได้ขอเปลี่ยนรหัสผ่าน ไม่ต้องทำอะไร`
    });
    return { sent: true, ...(process.env.MAIL_TRANSPORT ? {} : { dev_token: token }) };
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
    throw new ApiError('ลิงก์ตั้งรหัสผ่านไม่ถูกต้องหรือหมดอายุ', { status: 410, code: 'INVALID_TOKEN' });
  }

  const hashed = await hashPassword(newPassword);

  await transaction(async () => {
    await runQuery(`UPDATE users SET password_hash = ? WHERE id = ?`, [hashed, row.user_id]);
    await runQuery(
      `UPDATE account_tokens SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      [row.id]
    );
    // Any other outstanding reset links for this account are now void.
    await runQuery(
      `UPDATE account_tokens SET used_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
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
