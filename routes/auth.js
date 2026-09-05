// ============================================================================
//  /api/auth — register, login, logout, session listing.
// ============================================================================

import express from 'express';

import { runQuery, getQuery, allQuery, transaction } from '../db.js';
import { generateId } from '../lib/snowflake.js';
import { ApiError, asyncRoute } from '../lib/httpUtils.js';
import {
  hashPassword, verifyPassword, createSession, revokeSession, revokeAllSessions,
  extractToken, sessionCookie, clearedCookie, SESSION_TTL_MS
} from '../lib/auth.js';
import { loginRateLimit } from '../lib/rateLimit.js';

const router = express.Router();

const USERNAME = /^[a-zA-Z0-9_.฀-๿-]{2,32}$/;

const PUBLIC_USER = `
  id, username, discriminator, display_name, email, avatar_url, banner_url,
  bio, pronouns, status, custom_status, theme, locale, is_bot, mfa_enabled,
  storage_used, storage_quota, created_at
`;

const secureCookies = process.env.SECURE_COOKIES === '1';

/** Four random digits, avoiding a collision with the same username. */
async function allocateDiscriminator(username) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = String(Math.floor(1000 + Math.random() * 9000));
    const clash = await getQuery(
      `SELECT 1 FROM users WHERE username = ? AND discriminator = ?`, [username, candidate]
    );
    if (!clash) return candidate;
  }
  throw ApiError.conflict('ชื่อผู้ใช้นี้เต็มแล้ว ลองชื่ออื่น');
}

router.post('/auth/register', asyncRoute(async (req, res) => {
  const username = String(req.body?.username ?? '').trim();
  const displayName = String(req.body?.display_name ?? username).trim().slice(0, 80);
  const email = req.body?.email ? String(req.body.email).trim().toLowerCase() : null;
  const password = req.body?.password;

  if (!USERNAME.test(username)) {
    throw new ApiError('ชื่อผู้ใช้ใช้ได้เฉพาะ a-z, 0-9, _ . - และภาษาไทย ยาว 2-32 ตัว',
      { code: 'INVALID_USERNAME' });
  }
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new ApiError('อีเมลไม่ถูกต้อง', { code: 'INVALID_EMAIL' });
  }
  if (email) {
    const taken = await getQuery(
      `SELECT 1 FROM users WHERE email = ? AND deleted_at IS NULL`, [email]
    );
    if (taken) throw ApiError.conflict('อีเมลนี้ถูกใช้แล้ว');
  }

  const passwordHash = await hashPassword(password);
  const discriminator = await allocateDiscriminator(username);
  const id = generateId();

  await transaction(async () => {
    await runQuery(
      `INSERT INTO users (id, username, discriminator, display_name, email, password_hash, status)
       VALUES (?, ?, ?, ?, ?, ?, 'online')`,
      [id, username, discriminator, displayName || username, email, passwordHash]
    );
  });

  const { token, expiresAt } = await createSession({
    userId: id, ip: req.ip, userAgent: req.get('user-agent'), deviceName: req.body?.device ?? null
  });
  res.setHeader('Set-Cookie', sessionCookie(token, { secure: secureCookies }));

  const user = await getQuery(`SELECT ${PUBLIC_USER} FROM users WHERE id = ?`, [id]);
  res.status(201).json({ user, token, expires_at: expiresAt });
}));

router.post('/auth/login', loginRateLimit, asyncRoute(async (req, res) => {
  const identifier = String(req.body?.username ?? req.body?.email ?? '').trim();
  const password = req.body?.password ?? '';

  const user = await getQuery(
    `SELECT * FROM users
      WHERE deleted_at IS NULL AND (username = ? OR email = ? OR id = ?)
      ORDER BY CASE WHEN username = ? THEN 0 ELSE 1 END
      LIMIT 1`,
    [identifier, identifier.toLowerCase(), identifier, identifier]
  );

  // Always run a verification, even for an unknown user, so a missing account
  // and a wrong password take the same time.
  const ok = await verifyPassword(password, user?.password_hash ?? 'scrypt$16384$8$1$AA$AA');
  if (!user || !ok) {
    throw new ApiError('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง', { status: 401, code: 'INVALID_CREDENTIALS' });
  }

  const { token, expiresAt } = await createSession({
    userId: user.id, ip: req.ip, userAgent: req.get('user-agent'), deviceName: req.body?.device ?? null
  });
  res.setHeader('Set-Cookie', sessionCookie(token, { secure: secureCookies }));

  const publicUser = await getQuery(`SELECT ${PUBLIC_USER} FROM users WHERE id = ?`, [user.id]);
  res.json({ user: publicUser, token, expires_at: expiresAt });
}));

router.post('/auth/logout', asyncRoute(async (req, res) => {
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
  const { config } = await import('../lib/config.js');
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
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')
      ORDER BY last_seen_at DESC`,
    [req.userId]
  );
  res.json(sessions.map((s) => ({ ...s, current: s.id === req.sessionId })));
}));

router.delete('/auth/sessions/:sessionId', asyncRoute(async (req, res) => {
  if (!req.userId) throw ApiError.unauthorized();
  await runQuery(
    `UPDATE sessions SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ? AND user_id = ?`,
    [req.params.sessionId, req.userId]
  );
  res.json({ success: true });
}));

router.post('/auth/change-password', asyncRoute(async (req, res) => {
  if (!req.userId) throw ApiError.unauthorized();
  const user = await getQuery(`SELECT password_hash FROM users WHERE id = ?`, [req.userId]);

  // A user created before auth existed has no password yet; allow setting one.
  if (user?.password_hash) {
    const ok = await verifyPassword(req.body?.current_password ?? '', user.password_hash);
    if (!ok) throw new ApiError('รหัสผ่านเดิมไม่ถูกต้อง', { status: 401, code: 'INVALID_CREDENTIALS' });
  }

  const hashed = await hashPassword(req.body?.new_password);
  await runQuery(`UPDATE users SET password_hash = ? WHERE id = ?`, [hashed, req.userId]);
  // Changing a password must invalidate other devices.
  await revokeAllSessions(req.userId, { exceptToken: extractToken(req) });
  res.json({ success: true });
}));

export default router;
export { SESSION_TTL_MS };
