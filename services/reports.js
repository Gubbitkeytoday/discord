// ============================================================================
//  Reports — user-submitted reports on messages, users, servers and files.
// ============================================================================

import { runQuery, getQuery, allQuery } from '../db.js';
import { generateId } from '../lib/snowflake.js';
import { ApiError } from '../lib/httpUtils.js';

const TARGETS = ['message', 'user', 'server', 'channel', 'file'];
const REASONS = ['spam', 'harassment', 'nsfw', 'illegal', 'self_harm', 'impersonation', 'other'];
const STATUSES = ['open', 'reviewing', 'resolved', 'dismissed'];

export async function createReport({ reporterId, targetType, targetId, reason, details = null }) {
  if (!reporterId) throw ApiError.unauthorized();
  if (!TARGETS.includes(targetType)) {
    throw new ApiError(`target_type ต้องเป็นหนึ่งใน ${TARGETS.join(', ')}`, { code: 'INVALID_TARGET' });
  }
  if (!REASONS.includes(reason)) {
    throw new ApiError(`reason ต้องเป็นหนึ่งใน ${REASONS.join(', ')}`, { code: 'INVALID_REASON' });
  }
  if (!targetId) throw new ApiError('ต้องระบุ target_id', { code: 'MISSING_TARGET' });

  // One open report per reporter per target: repeat submissions are noise, not
  // extra signal.
  const existing = await getQuery(
    `SELECT id FROM reports
      WHERE reporter_id = ? AND target_type = ? AND target_id = ? AND status = 'open'`,
    [reporterId, targetType, targetId]
  );
  if (existing) {
    throw ApiError.conflict('คุณรายงานสิ่งนี้ไว้แล้ว และกำลังรอการตรวจสอบ');
  }

  // Resolve the guild so the server's own moderators can triage it, rather
  // than every report needing an instance administrator.
  let serverId = null;
  if (targetType === 'message') {
    const message = await getQuery(`SELECT server_id FROM messages WHERE id = ?`, [targetId]);
    serverId = message?.server_id ?? null;
  } else if (targetType === 'channel') {
    const channel = await getQuery(`SELECT server_id FROM channels WHERE id = ?`, [targetId]);
    serverId = channel?.server_id ?? null;
  } else if (targetType === 'server') {
    serverId = targetId;
  }

  const id = generateId();
  await runQuery(
    `INSERT INTO reports (id, reporter_id, server_id, target_type, target_id, reason, details)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, reporterId, serverId, targetType, targetId, reason, details ? String(details).slice(0, 2000) : null]
  );
  return getQuery(`SELECT * FROM reports WHERE id = ?`, [id]);
}

/**
 * Reports for triage. Enriched with a snapshot of the target so a moderator can
 * judge without chasing ids — a reported message may be deleted by the time
 * anyone looks.
 */
export async function listReports({ status = 'open', limit = 50, serverId = null } = {}) {
  if (status !== 'all' && !STATUSES.includes(status)) {
    throw new ApiError(`status ต้องเป็นหนึ่งใน ${STATUSES.join(', ')} หรือ all`, { code: 'INVALID_STATUS' });
  }

  const where = [];
  const params = [];
  if (status !== 'all') { where.push('r.status = ?'); params.push(status); }
  if (serverId) { where.push('r.server_id = ?'); params.push(serverId); }
  params.push(Math.min(limit, 200));

  const rows = await allQuery(
    `SELECT r.*, u.username AS reporter_name, u.display_name AS reporter_display
       FROM reports r LEFT JOIN users u ON u.id = r.reporter_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY r.created_at DESC LIMIT ?`,
    params
  );

  return Promise.all(rows.map(async (row) => ({
    ...row,
    target: await describeTarget(row.target_type, row.target_id)
  })));
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
    throw new ApiError('status ต้องเป็น reviewing, resolved หรือ dismissed', { code: 'INVALID_STATUS' });
  }
  const report = await getQuery(`SELECT * FROM reports WHERE id = ?`, [reportId]);
  if (!report) throw ApiError.notFound('Report');

  await runQuery(
    `UPDATE reports SET status = ?, resolved_by = ?,
       resolved_at = CASE WHEN ? = 'reviewing' THEN NULL
                          ELSE strftime('%Y-%m-%dT%H:%M:%fZ','now') END,
       details = CASE WHEN ? IS NULL THEN details
                      ELSE COALESCE(details, '') || char(10) || '[action] ' || ? END
      WHERE id = ?`,
    [status, resolverId, status, action, action, reportId]
  );

  // Acting on a reported message deletes it, which is the common outcome.
  if (status === 'resolved' && action === 'delete_message' && report.target_type === 'message') {
    await runQuery(
      `UPDATE messages SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      [report.target_id]
    );
  }

  return getQuery(`SELECT * FROM reports WHERE id = ?`, [reportId]);
}

export { TARGETS as REPORT_TARGETS, REASONS as REPORT_REASONS };
