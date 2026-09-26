// ============================================================================
//  Instance administration — the people who run this deployment.
//
//  Who is an instance admin:
//    - users.instance_admin = 1: the first account ever registered, or the
//      earliest existing account when an instance is upgraded (migration 39);
//    - anyone whose *verified* e-mail is listed in ADMIN_EMAILS. Unverified
//      addresses never count: anyone can type an address at sign-up.
//
//  What they can do, all audited in instance_audit_log:
//    reports queue (DM / user reports and escalated severe ones), ban a user
//    instance-wide (disable + revoke sessions), delete reported content,
//    delete accounts, and set the registration mode (open / invite / closed).
// ============================================================================

import { runQuery, getQuery, allQuery, sql } from '../db.js';
import { generateId } from '../lib/snowflake.js';
import { ApiError } from '../lib/httpUtils.js';
import { announceRevoked } from '../lib/sessionEvents.js';
import * as reports from './reports.js';
import { deleteAccount } from './dataRights.js';

export const REGISTRATION_MODES = ['open', 'invite', 'closed'];

const adminEmails = () => String(process.env.ADMIN_EMAILS ?? '')
  .split(',').map((e) => e.trim().toLowerCase()).filter(Boolean);

/** True when this user row (instance_admin, email, email_verified) is an admin. */
export function isAdminRow(row) {
  if (!row || row.deleted_at || row.disabled_at) return false;
  if (Number(row.instance_admin) === 1) return true;
  return Boolean(Number(row.email_verified)) && Boolean(row.email)
    && adminEmails().includes(String(row.email).toLowerCase());
}

export async function isInstanceAdmin(userId) {
  if (!userId) return false;
  const row = await getQuery(
    `SELECT instance_admin, email, email_verified, deleted_at, disabled_at FROM users WHERE id = ?`, [userId]
  );
  return isAdminRow(row);
}

/** Throws 403 unless `userId` administers this instance. */
export async function assertInstanceAdmin(userId) {
  if (!userId) throw ApiError.unauthorized();
  if (!(await isInstanceAdmin(userId))) {
    throw new ApiError('Only an administrator of this instance can do that', { status: 403, code: 'NOT_INSTANCE_ADMIN' });
  }
}

/**
 * Called inside registration: the very first account becomes the admin.
 * "First" = no admin exists yet and no other person can sign in.
 */
export async function claimFirstAdmin(userId) {
  const result = await runQuery(
    `UPDATE users SET instance_admin = 1
      WHERE id = ?
        AND NOT EXISTS (SELECT 1 FROM users WHERE instance_admin = 1)
        AND NOT EXISTS (SELECT 1 FROM users WHERE id <> ? AND deleted_at IS NULL AND is_bot = 0
                          AND is_system = 0 AND password_hash IS NOT NULL)`,
    [userId, userId]
  );
  return result.changes > 0;
}

// --- audit ---------------------------------------------------------------------

export async function audit({ actorId, action, targetType = null, targetId = null, details = null }) {
  await runQuery(
    `INSERT INTO instance_audit_log (id, actor_id, action, target_type, target_id, details)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [generateId(), actorId, action, targetType, targetId, details ? JSON.stringify(details) : null]
  );
}

export async function listAudit({ limit = 100 } = {}) {
  const rows = await allQuery(
    `SELECT a.*, u.username AS actor_username, u.display_name AS actor_display
       FROM instance_audit_log a LEFT JOIN users u ON u.id = a.actor_id
      ORDER BY a.created_at DESC, a.id DESC LIMIT ?`,
    [Math.min(limit, 500)]
  );
  return rows.map((r) => {
    let details = null;
    try { details = r.details ? JSON.parse(r.details) : null; } catch { details = r.details; }
    return { ...r, details };
  });
}

// --- registration mode -----------------------------------------------------------

/** Env default (REGISTRATION_MODE), overridden by what an admin chose. */
export async function getRegistrationMode() {
  const row = await getQuery(`SELECT value FROM instance_settings WHERE key = 'registration_mode'`);
  if (row && REGISTRATION_MODES.includes(row.value)) return { mode: row.value, source: 'admin' };
  const env = String(process.env.REGISTRATION_MODE ?? '').trim().toLowerCase();
  // 'invite-only' / 'invite_only' are what people type.
  const normalised = env.startsWith('invite') ? 'invite' : env;
  return { mode: REGISTRATION_MODES.includes(normalised) ? normalised : 'open', source: 'default' };
}

export async function setRegistrationMode({ actorId, mode }) {
  if (mode !== null && !REGISTRATION_MODES.includes(mode)) {
    throw new ApiError(`mode must be one of ${REGISTRATION_MODES.join(', ')}`, { code: 'INVALID_MODE' });
  }
  const before = await getRegistrationMode();
  if (mode === null) {
    await runQuery(`DELETE FROM instance_settings WHERE key = 'registration_mode'`);
  } else {
    await runQuery(
      `INSERT INTO instance_settings (key, value, updated_by, updated_at) VALUES ('registration_mode', ?, ?, ${sql.now})
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by,
                                      updated_at = excluded.updated_at`,
      [mode, actorId]
    );
  }
  const after = await getRegistrationMode();
  await audit({ actorId, action: 'registration_mode', details: { from: before.mode, to: after.mode } });
  return after;
}

// --- overview ------------------------------------------------------------------

export async function overview() {
  const [users, servers, openReports, disabled] = await Promise.all([
    getQuery(`SELECT count(*) AS n FROM users WHERE deleted_at IS NULL AND is_bot = 0 AND is_system = 0`),
    getQuery(`SELECT count(*) AS n FROM servers WHERE deleted_at IS NULL`),
    getQuery(`SELECT count(*) AS n FROM reports WHERE status IN ('open','reviewing') AND (escalated = 1 OR server_id IS NULL)`),
    getQuery(`SELECT count(*) AS n FROM users WHERE disabled_at IS NOT NULL AND deleted_at IS NULL`)
  ]);
  return {
    users: Number(users?.n ?? 0),
    servers: Number(servers?.n ?? 0),
    open_reports: Number(openReports?.n ?? 0),
    disabled_users: Number(disabled?.n ?? 0),
    registration: await getRegistrationMode()
  };
}

// --- users -----------------------------------------------------------------------

export async function listUsers({ search = null, limit = 100 } = {}) {
  const params = [];
  let where = 'u.deleted_at IS NULL AND u.is_system = 0';
  if (search) {
    const like = `%${String(search).replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    where += ` AND (u.username ${sql.like} ? ESCAPE '\\' OR u.display_name ${sql.like} ? ESCAPE '\\' OR u.email ${sql.like} ? ESCAPE '\\')`;
    params.push(like, like, like);
  }
  params.push(Math.min(Number(limit) || 100, 500));
  const rows = await allQuery(
    `SELECT u.id, u.username, u.discriminator, u.display_name, u.email, u.email_verified, u.avatar_url,
            u.is_bot, u.instance_admin, u.created_at, u.last_seen_at, u.disabled_at, u.disabled_reason,
            (SELECT count(*) FROM server_members sm WHERE sm.user_id = u.id AND sm.left_at IS NULL) AS server_count,
            (SELECT count(*) FROM reports r WHERE r.target_user_id = u.id) AS report_count
       FROM users u
      WHERE ${where}
      ORDER BY u.created_at DESC LIMIT ?`,
    params
  );
  return rows.map((r) => ({
    ...r,
    is_bot: Boolean(Number(r.is_bot)),
    email_verified: Boolean(Number(r.email_verified)),
    instance_admin: isAdminRow({ ...r, disabled_at: null }),
    server_count: Number(r.server_count ?? 0),
    report_count: Number(r.report_count ?? 0)
  }));
}

async function targetUser(userId) {
  const row = await getQuery(
    `SELECT id, username, instance_admin, email, email_verified, deleted_at, disabled_at FROM users WHERE id = ?`, [userId]
  );
  if (!row || row.deleted_at) throw ApiError.notFound('User');
  return row;
}

function assertNotAdminTarget(actorId, row) {
  if (row.id === actorId) {
    throw new ApiError('You cannot do that to your own account here', { code: 'CANNOT_TARGET_SELF' });
  }
  if (isAdminRow({ ...row, disabled_at: null })) {
    throw new ApiError('Another instance administrator cannot be banned or deleted from the console',
      { status: 403, code: 'CANNOT_TARGET_ADMIN' });
  }
}

/** Instance-wide ban: the account cannot sign in and every session ends now. */
export async function disableUser({ actorId, userId, reason = null, reportId = null }) {
  const row = await targetUser(userId);
  assertNotAdminTarget(actorId, row);
  const why = reason ? String(reason).trim().slice(0, 500) : null;
  await runQuery(
    `UPDATE users SET disabled_at = COALESCE(disabled_at, ${sql.now}), disabled_reason = ?, status = 'offline'
      WHERE id = ?`,
    [why, userId]
  );
  await runQuery(`UPDATE sessions SET revoked_at = ${sql.now} WHERE user_id = ? AND revoked_at IS NULL`, [userId]);
  announceRevoked({ userId });
  await audit({ actorId, action: 'user_disable', targetType: 'user', targetId: userId,
    details: { username: row.username, reason: why, report_id: reportId } });
  return { id: userId, disabled: true };
}

export async function enableUser({ actorId, userId }) {
  const row = await targetUser(userId);
  await runQuery(`UPDATE users SET disabled_at = NULL, disabled_reason = NULL WHERE id = ?`, [userId]);
  await audit({ actorId, action: 'user_enable', targetType: 'user', targetId: userId, details: { username: row.username } });
  return { id: userId, disabled: false };
}

export async function removeUser({ actorId, userId }) {
  const row = await targetUser(userId);
  assertNotAdminTarget(actorId, row);
  await deleteAccount({ userId });
  await audit({ actorId, action: 'user_delete', targetType: 'user', targetId: userId, details: { username: row.username } });
  return { id: userId, deleted: true };
}

// --- servers -----------------------------------------------------------------------

export async function listServers({ limit = 200 } = {}) {
  const rows = await allQuery(
    `SELECT s.id, s.name, s.icon_url, s.created_at, s.owner_id,
            u.username AS owner_username, u.display_name AS owner_display,
            (SELECT count(*) FROM server_members sm WHERE sm.server_id = s.id AND sm.left_at IS NULL) AS member_count,
            (SELECT count(*) FROM reports r WHERE r.server_id = s.id AND r.status IN ('open','reviewing')) AS open_reports
       FROM servers s LEFT JOIN users u ON u.id = s.owner_id
      WHERE s.deleted_at IS NULL
      ORDER BY s.created_at DESC LIMIT ?`,
    [Math.min(Number(limit) || 200, 1000)]
  );
  return rows.map((r) => ({ ...r, member_count: Number(r.member_count ?? 0), open_reports: Number(r.open_reports ?? 0) }));
}

// --- reports -----------------------------------------------------------------------

export function reportQueue({ status = 'open', limit = 100 } = {}) {
  return reports.listReports({ status, limit, scope: 'instance' });
}

export async function reportDetail(reportId) {
  const report = await reports.getReport(reportId);
  if (!report) throw ApiError.notFound('Report');
  return report;
}

/**
 * Close a report, optionally acting on it:
 *   delete_message   the reported message is removed
 *   ban_user         the reported user is disabled instance-wide
 */
export async function actOnReport({ actorId, reportId, status, action = null, note = null }) {
  const ACTIONS = [null, 'delete_message', 'ban_user'];
  if (!ACTIONS.includes(action)) {
    throw new ApiError('action must be delete_message or ban_user', { code: 'INVALID_ACTION' });
  }
  const report = await reports.getReport(reportId);
  if (!report) throw ApiError.notFound('Report');
  if (action === 'delete_message' && report.target_type !== 'message') {
    throw new ApiError('Only a reported message can be deleted', { code: 'INVALID_ACTION' });
  }
  if (action === 'ban_user') {
    if (!report.target_user_id) throw new ApiError('This report names no user', { code: 'INVALID_ACTION' });
    await disableUser({ actorId, userId: report.target_user_id, reason: note ?? `report ${reportId}`, reportId });
  }
  const updated = await reports.resolveReport({
    reportId, resolverId: actorId, status: status ?? 'resolved', action
  });
  await audit({ actorId, action: 'report_resolve', targetType: 'report', targetId: reportId,
    details: { status: updated.status, action, note: note ? String(note).slice(0, 500) : null } });
  return reports.getReport(reportId);
}
