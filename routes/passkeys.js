// ============================================================================
//  /api/passkeys — WebAuthn passkeys: config, sign-in, registration,
//  step-up re-authentication, list / rename / delete, audit trail.
//
//  Every ceremony is two calls: `…/options` returns { flow_id, options } for
//  navigator.credentials (via @simplewebauthn/browser), and `…/verify` takes
//  { flow_id, response } back. See services/passkeys.js for the policy.
// ============================================================================

import express from 'express';

import { getQuery } from '../db.js';
import { ApiError, asyncRoute } from '../lib/httpUtils.js';
import { rateLimit } from '../lib/rateLimit.js';
import { createSession, sessionCookie } from '../lib/auth.js';
import { config } from '../lib/config.js';
import * as passkeys from '../services/passkeys.js';

const router = express.Router();

// Same shape /api/auth/login answers with (routes/auth.js PUBLIC_USER).
const PUBLIC_USER = `
  id, username, discriminator, display_name, email, avatar_url, banner_url,
  bio, pronouns, status, custom_status, theme, locale, is_bot, mfa_enabled,
  storage_used, storage_quota, created_at
`;

const requireUser = (req) => {
  if (!req.userId) throw ApiError.unauthorized();
  // A bot token is not a person and has no business holding passkeys.
  if (req.botApplicationId) throw ApiError.forbidden('Bots cannot use passkeys');
  return req.userId;
};
const meta = (req) => ({ ip: req.ip ?? null, userAgent: req.get('user-agent') ?? null });

// Unauthenticated sign-in is keyed by IP (like /auth/login); options are
// cheap but each one stores a challenge row, so they are bounded too.
const loginLimit = rateLimit({ name: 'passkey-login', limit: 30, windowMs: 5 * 60_000, byIpOnly: true });
const reauthLimit = rateLimit({ name: 'passkey-reauth', limit: 20, windowMs: 5 * 60_000 });
const manageLimit = rateLimit({ name: 'passkey-manage', limit: 30, windowMs: 60 * 60_000 });

router.get('/passkeys/config', (_req, res) => {
  res.json(passkeys.publicConfig());
});

// --- sign-in -------------------------------------------------------------------

router.post('/passkeys/login/options', loginLimit, asyncRoute(async (_req, res) => {
  res.json(await passkeys.loginOptions());
}));

router.post('/passkeys/login/verify', loginLimit, asyncRoute(async (req, res) => {
  const { userId } = await passkeys.verifyLogin({
    flowId: req.body?.flow_id, response: req.body?.response, ...meta(req)
  });
  // A user-verifying passkey is phishing-resistant and two-factor on its own,
  // so no password and no TOTP code are asked for.
  const { token, expiresAt } = await createSession({
    userId, ip: req.ip, userAgent: req.get('user-agent'), deviceName: req.body?.device ?? null
  });
  res.setHeader('Set-Cookie', sessionCookie(token, { secure: config.secureCookies }));
  const user = await getQuery(`SELECT ${PUBLIC_USER} FROM users WHERE id = ?`, [userId]);
  res.json({ user, token, expires_at: expiresAt, method: 'passkey' });
}));

// --- step-up re-authentication ("sudo") --------------------------------------------

router.get('/passkeys/reauth', asyncRoute(async (req, res) => {
  res.json(await passkeys.sudoStatus({ userId: requireUser(req), sessionId: req.sessionId }));
}));

router.post('/passkeys/reauth/password', reauthLimit, asyncRoute(async (req, res) => {
  res.json(await passkeys.reauthWithPassword({
    userId: requireUser(req), sessionId: req.sessionId,
    password: req.body?.password, code: req.body?.code, ...meta(req)
  }));
}));

router.post('/passkeys/reauth/options', reauthLimit, asyncRoute(async (req, res) => {
  res.json(await passkeys.reauthOptions({ userId: requireUser(req), sessionId: req.sessionId }));
}));

router.post('/passkeys/reauth/verify', reauthLimit, asyncRoute(async (req, res) => {
  res.json(await passkeys.verifyReauth({
    userId: requireUser(req), sessionId: req.sessionId,
    flowId: req.body?.flow_id, response: req.body?.response, ...meta(req)
  }));
}));

// --- registration ---------------------------------------------------------------

router.post('/passkeys/register/options', manageLimit, asyncRoute(async (req, res) => {
  res.json(await passkeys.registrationOptions({ userId: requireUser(req), sessionId: req.sessionId }));
}));

router.post('/passkeys/register/verify', manageLimit, asyncRoute(async (req, res) => {
  res.status(201).json(await passkeys.verifyRegistration({
    userId: requireUser(req), sessionId: req.sessionId,
    flowId: req.body?.flow_id, response: req.body?.response, name: req.body?.name, ...meta(req)
  }));
}));

// --- management -------------------------------------------------------------------

router.get('/passkeys', asyncRoute(async (req, res) => {
  res.json(await passkeys.listPasskeys(requireUser(req)));
}));

router.get('/passkeys/events', asyncRoute(async (req, res) => {
  res.json(await passkeys.listEvents(requireUser(req), { limit: Number(req.query?.limit) || 50 }));
}));

router.patch('/passkeys/:id', manageLimit, asyncRoute(async (req, res) => {
  res.json(await passkeys.renamePasskey({
    userId: requireUser(req), id: req.params.id, name: req.body?.name, ...meta(req)
  }));
}));

router.delete('/passkeys/:id', manageLimit, asyncRoute(async (req, res) => {
  res.json(await passkeys.deletePasskey({
    userId: requireUser(req), sessionId: req.sessionId, id: req.params.id, ...meta(req)
  }));
}));

export default router;
