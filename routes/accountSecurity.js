// ============================================================================
//  /api/auth/mfa/*, /api/auth/verify-email, /api/auth/reset-password
// ============================================================================

import express from 'express';

import { ApiError, asyncRoute } from '../lib/httpUtils.js';
import { rateLimit } from '../lib/rateLimit.js';
import { sendMail, currentTransport } from '../lib/mailer.js';
import * as security from '../services/accountSecurity.js';

const router = express.Router();

const requireUser = (req) => {
  if (!req.userId) throw ApiError.unauthorized();
  return req.userId;
};

// Both of these send email and are unauthenticated (reset) or cheap to abuse,
// so they get their own tighter buckets.
const mailLimit = rateLimit({ name: 'mail', limit: 5, windowMs: 15 * 60_000, byIpOnly: true });
const mfaLimit = rateLimit({ name: 'mfa', limit: 20, windowMs: 5 * 60_000 });

// --- MFA ---------------------------------------------------------------------

router.post('/auth/mfa/begin', asyncRoute(async (req, res) => {
  res.json(await security.beginMfaEnrolment({ userId: requireUser(req) }));
}));

router.post('/auth/mfa/confirm', mfaLimit, asyncRoute(async (req, res) => {
  res.json(await security.confirmMfaEnrolment({
    userId: requireUser(req), code: req.body?.code
  }));
}));

router.post('/auth/mfa/disable', mfaLimit, asyncRoute(async (req, res) => {
  res.json(await security.disableMfa({ userId: requireUser(req), code: req.body?.code }));
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

// --- diagnostics -------------------------------------------------------------

router.get('/auth/mail-transport', (_req, res) => {
  // Useful when a reset email "did not arrive": says which transport is active
  // without exposing credentials.
  res.json({ transport: currentTransport(), configured: currentTransport() !== 'console' });
});

export default router;
