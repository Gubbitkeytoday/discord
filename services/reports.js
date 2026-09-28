// ============================================================================
//  Reports — user-submitted reports on messages, users, servers and files.
//
//  Routing (who can see a report):
//    - a message in a server   → that server's moderators (MANAGE_MESSAGES);
//                                severe categories are *also* escalated to
//                                the instance administrators, because a
//                                server's mods may be the problem, or 14.
//    - a DM message, a user    → the instance administrators. A DM has no
//                                moderators; before this they went nowhere.
//    - a server, a channel     → both.
//  The reporter is never named to the person reported, and can follow their
//  own reports' status (listMyReports) without seeing who handled them.
// ============================================================================

import { runQuery, getQuery, allQuery, sql } from '../db.js';
import { generateId } from '../lib/snowflake.js';
import { ApiError } from '../lib/httpUtils.js';

const TARGETS = ['message', 'user', 'server', 'channel', 'file'];
// minor_safety: sexual content involving minors, or an adult sexualising a
// child. hate: attacks on a protected group.
const REASONS = ['spam', 'harassment', 'hate', 'self_harm', 'minor_safety', 'nsfw', 'illegal', 'impersonation', 'other'];
// Always seen by the instance admins, wherever they happened.
const SEVERE = new Set(['self_harm', 'minor_safety', 'illegal']);
const STATUSES = ['open', 'reviewing', 'resolved', 'dismissed'];
// Messages before the reported one, kept with the report as evidence.
const CONTEXT_BEFORE = 5;

const parseJson = (text) => { try { return text ? JSON.parse(text) : null; } catch { return null; } };

/** Evidence captured at report time, so deleting the message later hides nothing. */
async function snapshot(targetType, targetId) {
  if (targetType === 'message') {
    const message = await getQuery(
      `SELECT m.id, m.channel_id, m.server_id, m.user_id, m.content, m.created_at, m.edited_at,
              u.username, u.display_name, c.type AS channel_type, c.name AS channel_name
         FROM messages m LEFT JOIN users u ON u.id = m.user_id
         LEFT JOIN channels c ON c.id = m.channel_id
        WHERE m.id = ?`,
      [targetId]
    );
    if (!message) throw ApiError.notFound('Message');
    const before = await allQuery(
      `SELECT m.id, m.user_id, m.content, m.created_at, u.username, u.display_name
         FROM messages m LEFT JOIN users u ON u.id = m.user_id
        WHERE m.channel_id = ? AND m.id < ? AND m.deleted_at IS NULL
        ORDER BY m.id DESC LIMIT ?`,
      [message.channel_id, targetId, CONTEXT_BEFORE]
    );
    const shape = (m) => ({
      id: m.id, author_id: m.user_id, author: m.display_name || m.username || null,
      content: String(m.content ?? '').slice(0, 2000), created_at: m.created_at
    });
    return {
      serverId: message.server_id ?? null,
      channelId: message.channel_id,
      targetUserId: message.user_id,
      context: {
        channel: { id: message.channel_id, type: message.channel_type, name: message.channel_name ?? null },
        message: shape(message),
        before: before.reverse().map(shape)
      }
    };
  }
  if (targetType === 'user') {
    const user = await getQuery(
      `SELECT id, username, display_name, created_at FROM users WHERE id = ?`, [targetId]
    );
    if (!user) throw ApiError.notFound('User');
    return { serverId: null, channelId: null, targetUserId: user.id, context: { user } };
  }
  if (targetType === 'channel') {
    const channel = await getQuery(`SELECT server_id FROM channels WHERE id = ?`, [targetId]);
    return { serverId: channel?.server_id ?? null, channelId: targetId, targetUserId: null, context: null };
  }
  if (targetType === 'server') {
    const server = await getQuery(`SELECT owner_id FROM servers WHERE id = ?`, [targetId]);
    return { serverId: targetId, channelId: null, targetUserId: server?.owner_id ?? null, context: null };
  }
  if (targetType === 'file') {
    const file = await getQuery(`SELECT uploader_id FROM files WHERE id = ?`, [targetId]);
    return { serverId: null, channelId: null, targetUserId: file?.uploader_id ?? null, context: null };
  }
  return { serverId: null, channelId: null, targetUserId: null, context: null };
}

export async function createReport({ reporterId, targetType, targetId, reason, details = null }) {
  if (!reporterId) throw ApiError.unauthorized();
  if (!TARGETS.includes(targetType)) {
    throw new ApiError(`target_type must be one of ${TARGETS.join(', ')}`, { code: 'INVALID_TARGET' });
  }
  if (!REASONS.includes(reason)) {
    throw new ApiError(`reason must be one of ${REASONS.join(', ')}`, { code: 'INVALID_REASON' });
  }
  if (!targetId) throw new ApiError('target_id is required', { code: 'MISSING_TARGET' });

  // One open report per reporter per target: repeat submissions are noise, not
  // extra signal.
  const existing = await getQuery(
    `SELECT id FROM reports
      WHERE reporter_id = ? AND target_type = ? AND target_id = ? AND status = 'open'`,
    [reporterId, targetType, targetId]
  );
  if (existing) {
    throw new ApiError('You already reported this; it is awaiting review', { status: 409, code: 'ALREADY_REPORTED' });
  }

  const snap = await snapshot(targetType, targetId);
  if (snap.targetUserId && snap.targetUserId === reporterId) {
    throw new ApiError('You cannot report yourself', { code: 'INVALID_TARGET' });
  }
  // Nobody moderates a DM or a person but the instance; severe harm is
  // escalated even when a server's own mods can also see it.
  const escalated = !snap.serverId || targetType === 'user' || targetType === 'server' || SEVERE.has(reason);

  const id = generateId();
  await runQuery(
    `INSERT INTO reports (id, reporter_id, server_id, target_type, target_id, reason, details,
                          escalated, context, target_user_id, channel_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, reporterId, snap.serverId, targetType, targetId, reason,
     details ? String(details).slice(0, 2000) : null, escalated ? 1 : 0,
     snap.context ? JSON.stringify(snap.context) : null, snap.targetUserId, snap.channelId]
  );
  const row = await getQuery(`SELECT * FROM reports WHERE id = ?`, [id]);
  return shapeReport(row);
}

function shapeReport(row) {
  if (!row) return row;
  return { ...row, escalated: Boolean(Number(row.escalated)), context: parseJson(row.context) };
}

/**
 * Reports for triage. Enriched with a snapshot of the target so a moderator can
 * judge without chasing ids — a reported message may be deleted by the time
 * anyone looks.
 *
 * `scope: 'instance'` is the instance admins' queue: everything escalated.
 */
export async function listReports({ status = 'open', limit = 50, serverId = null, scope = null } = {}) {
  if (status !== 'all' && !STATUSES.includes(status)) {
    throw new ApiError(`status must be one of ${STATUSES.join(', ')} or all`, { code: 'INVALID_STATUS' });
  }

  const where = [];
  const params = [];
  if (status !== 'all') { where.push('r.status = ?'); params.push(status); }
  if (serverId) { where.push('r.server_id = ?'); params.push(serverId); }
  if (scope === 'instance') where.push('(r.escalated = 1 OR r.server_id IS NULL)');
  params.push(Math.min(limit, 200));

  const rows = await allQuery(
    `SELECT r.*, u.username AS reporter_name, u.display_name AS reporter_display,
            t.username AS target_username, t.display_name AS target_display, t.disabled_at AS target_disabled_at,
            s.name AS server_name
       FROM reports r
       LEFT JOIN users u ON u.id = r.reporter_id
       LEFT JOIN users t ON t.id = r.target_user_id
       LEFT JOIN servers s ON s.id = r.server_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY r.created_at DESC LIMIT ?`,
    params
  );

  return Promise.all(rows.map(async (row) => ({
    ...shapeReport(row),
    target: await describeTarget(row.target_type, row.target_id)
  })));
}

/** One report with its evidence, or null. */
export async function getReport(reportId) {
  const row = await getQuery(
    `SELECT r.*, u.username AS reporter_name, u.display_name AS reporter_display,
            t.username AS target_username, t.display_name AS target_display, t.disabled_at AS target_disabled_at,
            s.name AS server_name
       FROM reports r
       LEFT JOIN users u ON u.id = r.reporter_id
       LEFT JOIN users t ON t.id = r.target_user_id
       LEFT JOIN servers s ON s.id = r.server_id
      WHERE r.id = ?`,
    [reportId]
  );
  if (!row) return null;
  return { ...shapeReport(row), target: await describeTarget(row.target_type, row.target_id) };
}

/**
 * The reporter's own reports: what they reported, why, and where it stands.
 * Deliberately without the handler's identity or notes.
 */
export async function listMyReports(reporterId, { limit = 50 } = {}) {
  const rows = await allQuery(
    `SELECT r.id, r.target_type, r.target_id, r.reason, r.status, r.created_at, r.resolved_at,
            r.escalated, r.server_id, s.name AS server_name,
            t.username AS target_username, t.display_name AS target_display
       FROM reports r
       LEFT JOIN users t ON t.id = r.target_user_id
       LEFT JOIN servers s ON s.id = r.server_id
      WHERE r.reporter_id = ?
      ORDER BY r.created_at DESC LIMIT ?`,
    [reporterId, Math.min(limit, 200)]
  );
  return rows.map((r) => ({ ...r, escalated: Boolean(Number(r.escalated)) }));
}

async function describeTarget(type, id) {
  switch (type) {
    case 'message': {
      const message = await getQuery(
        `SELECT m.id, m.content, m.channel_id, m.deleted_at, u.display_name AS author
           FROM messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.id = ?`,
        [id]
      );
      return message
        ? { ...message, content: (message.content ?? '').slice(0, 300), deleted: Boolean(message.deleted_at) }
        : { missing: true };
    }
    case 'user': {
      const user = await getQuery(
        `SELECT id, username, display_name, avatar_url FROM users WHERE id = ?`, [id]
      );
      return user ?? { missing: true };
    }
    case 'server': {
      const server = await getQuery(`SELECT id, name, icon_url FROM servers WHERE id = ?`, [id]);
      return server ?? { missing: true };
    }
    case 'channel': {
      const channel = await getQuery(`SELECT id, name, type FROM channels WHERE id = ?`, [id]);
      return channel ?? { missing: true };
    }
    case 'file': {
      const file = await getQuery(
        `SELECT id, original_name, mime_type, size, uploader_id FROM files WHERE id = ?`, [id]
      );
      return file ?? { missing: true };
    }
    default:
      return { missing: true };
  }
}

export async function resolveReport({ reportId, resolverId, status, action = null }) {
  if (!['resolved', 'dismissed', 'reviewing'].includes(status)) {
    throw new ApiError('status must be reviewing, resolved or dismissed', { code: 'INVALID_STATUS' });
  }
  const report = await getQuery(`SELECT * FROM reports WHERE id = ?`, [reportId]);
  if (!report) throw ApiError.notFound('Report');

  await runQuery(
    `UPDATE reports SET status = ?, resolved_by = ?,
       resolved_at = CASE WHEN ? = 'reviewing' THEN NULL
                          ELSE ${sql.now} END,
       details = CASE WHEN ${sql.text('?')} IS NULL THEN details
                      ELSE COALESCE(details, '') || ? END
      WHERE id = ?`,
    [status, resolverId, status, action, action == null ? null : `\n[action] ${action}`, reportId]
  );

  // Acting on a reported message deletes it, which is the common outcome.
  if (status === 'resolved' && action === 'delete_message' && report.target_type === 'message') {
    await runQuery(
      `UPDATE messages SET deleted_at = ${sql.now} WHERE id = ?`,
      [report.target_id]
    );
  }

  return shapeReport(await getQuery(`SELECT * FROM reports WHERE id = ?`, [reportId]));
}

export { TARGETS as REPORT_TARGETS, REASONS as REPORT_REASONS, SEVERE as SEVERE_REPORT_REASONS };
