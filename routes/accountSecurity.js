// ============================================================================
//  /api/auth/mfa/*, /api/auth/verify-email, /api/auth/reset-password
// ============================================================================

import express from 'express';

import { ApiError, asyncRoute, unauthenticated } from '../lib/httpUtils.js';
import { rateLimit } from '../lib/rateLimit.js';
import { sendMail, currentTransport } from '../lib/mailer.js';
import * as security from '../services/accountSecurity.js';
import * as users from '../services/users.js';
import { listMyReports } from '../services/reports.js';
import { getQuery } from '../db.js';

const router = express.Router();

const requireUser = (req) => {
  if (!req.userId) throw unauthenticated(req);
  return req.userId;
};

// A session signed in within this window counts as "just proved the
// password" (GitHub's sudo mode). Older sessions must re-enter it before
// turning 2FA on, so a stolen, long-lived cookie cannot enrol its own
// authenticator and lock the owner out.
const FRESH_SESSION_MS = 10 * 60_000;

async function assertRecentAuth(req) {
  const password = req.body?.password;
  if (password) {
    await security.assertReauthenticated({ userId: req.userId, password, code: req.body?.code ?? null })
      .catch((err) => {
        // Enabling 2FA on an account that already has it is refused later;
        // here only the password matters.
        if (err?.code === 'MFA_REQUIRED' || err?.code === 'INVALID_MFA_CODE') return;
        throw err;
      });
    return;
  }
  if (req.sessionId) {
    const session = await getQuery(`SELECT created_at FROM sessions WHERE id = ?`, [req.sessionId]);
    const created = session?.created_at ? new Date(session.created_at).getTime() : NaN;
    if (Number.isFinite(created) && Date.now() - created < FRESH_SESSION_MS) return;
  }
  throw new ApiError('Confirm with your password to continue', { status: 401, code: 'PASSWORD_REQUIRED' });
}

// Both of these send email and are unauthenticated (reset) or cheap to abuse,
// so they get their own tighter buckets.
const mailLimit = rateLimit({ name: 'mail', limit: 5, windowMs: 15 * 60_000, byIpOnly: true });
const mfaLimit = rateLimit({ name: 'mfa', limit: 20, windowMs: 5 * 60_000 });

// --- MFA ---------------------------------------------------------------------

router.post('/auth/mfa/begin', mfaLimit, asyncRoute(async (req, res) => {
  const userId = requireUser(req);
  await assertRecentAuth(req);
  res.json(await security.beginMfaEnrolment({ userId }));
}));

router.post('/auth/mfa/confirm', mfaLimit, asyncRoute(async (req, res) => {
  res.json(await security.confirmMfaEnrolment({
    userId: requireUser(req), code: req.body?.code
  }));
}));

router.post('/auth/mfa/disable', mfaLimit, asyncRoute(async (req, res) => {
  // Step-up: the account password as well as a current code / recovery code.
  res.json(await security.disableMfa({
    userId: requireUser(req), code: req.body?.code, password: req.body?.password
  }));
}));

router.get('/auth/mfa/status', asyncRoute(async (req, res) => {
  const userId = requireUser(req);
  const { getQuery } = await import('../db.js');
  const user = await getQuery(`SELECT mfa_enabled FROM users WHERE id = ?`, [userId]);
  res.json({
    enabled: Boolean(user?.mfa_enabled),
    recovery_codes_remaining: await security.countRecoveryCodes(userId)
  });
}));

// --- email verification ------------------------------------------------------

router.post('/auth/verify-email/request', mailLimit, asyncRoute(async (req, res) => {
  res.json(await security.requestEmailVerification({
    userId: requireUser(req), sendMail
  }));
}));

router.post('/auth/verify-email', asyncRoute(async (req, res) => {
  res.json(await security.verifyEmail({ token: req.body?.token }));
}));

// --- password reset ----------------------------------------------------------

router.post('/auth/forgot-password', mailLimit, asyncRoute(async (req, res) => {
  // Always reports success: telling the caller whether an address exists would
  // turn this into an account-enumeration oracle.
  res.json(await security.requestPasswordReset({ email: req.body?.email, sendMail }));
}));

router.post('/auth/reset-password', asyncRoute(async (req, res) => {
  res.json(await security.resetPassword({
    token: req.body?.token, newPassword: req.body?.password
  }));
}));

// --- safety: age, message requests, my reports --------------------------------

router.get('/auth/age', asyncRoute(async (req, res) => {
  res.json(await users.getAgeStatus(requireUser(req)));
}));

/** One-time: accounts made before the age gate are asked once. */
router.put('/auth/age', asyncRoute(async (req, res) => {
  const b = req.body ?? {};
  res.json(await users.setBirthdate({
    userId: requireUser(req), year: b.year ?? b.birth_year, month: b.month ?? b.birth_month, day: b.day ?? b.birth_day
  }));
}));

router.get('/message-requests', asyncRoute(async (req, res) => {
  res.json(await users.listMessageRequests(requireUser(req)));
}));

router.post('/message-requests/:channelId/accept', asyncRoute(async (req, res) => {
  res.json(await users.acceptMessageRequest({ userId: requireUser(req), channelId: req.params.channelId }));
}));

router.post('/message-requests/:channelId/ignore', asyncRoute(async (req, res) => {
  res.json(await users.ignoreMessageRequest({ userId: requireUser(req), channelId: req.params.channelId }));
}));

/** "My reports": what I reported and where it stands. */
router.get('/reports/mine', asyncRoute(async (req, res) => {
  res.json(await listMyReports(requireUser(req)));
}));

// --- diagnostics -------------------------------------------------------------

router.get('/auth/mail-transport', (_req, res) => {
  // Useful when a reset email "did not arrive": says which transport is active
  // without exposing credentials.
  res.json({ transport: currentTransport(), configured: currentTransport() !== 'console' });
});

export default router;
