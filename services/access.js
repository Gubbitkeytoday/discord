// ============================================================================
//  Channel access — the single place that answers "may this user do X here?"
//
//  Discord's rule set, condensed:
//    guild channel  → must be a member, must hold VIEW_CHANNEL after overwrites,
//                     plus whatever action permission the caller names.
//    DM / group DM  → must be a recipient; a 1:1 DM is also closed when either
//                     side has blocked the other.
//    thread         → inherits the parent channel's permissions.
// ============================================================================

import { getQuery } from '../db.js';
import { ApiError } from '../lib/httpUtils.js';
import { has } from '../lib/permissions.js';
import { resolvePermissions } from './guilds.js';

/**
 * Resolve the channel and the caller's effective permissions inside it.
 * Returns `{ channel, permissions, isDm }`; throws 403/404 when access is denied.
 *
 * `permission` (optional) is an extra flag that must also be present, e.g.
 * SEND_MESSAGES, MANAGE_MESSAGES, ADD_REACTIONS.
 */
export async function assertChannelAccess({ channelId, userId, permission = null }) {
  if (!userId) throw ApiError.unauthorized();

  const channel = await getQuery(
    `SELECT id, type, server_id, parent_id FROM channels WHERE id = ? AND deleted_at IS NULL`,
    [channelId]
  );
  if (!channel) throw ApiError.notFound('Channel');

  // --- direct messages -------------------------------------------------------
  if (channel.type === 'dm' || channel.type === 'group_dm') {
    const recipient = await getQuery(
      `SELECT 1 FROM channel_recipients WHERE channel_id = ? AND user_id = ?`, [channelId, userId]
    );
    if (!recipient) throw ApiError.forbidden('You are not in this conversation');

    // A block closes the conversation in both directions — not only for
    // sending, but for reacting and pinning too. Reading old history stays
    // allowed, as it does on Discord.
    const WRITE_ACTIONS = ['SEND_MESSAGES', 'ADD_REACTIONS', 'MANAGE_MESSAGES', 'ATTACH_FILES'];
    if (channel.type === 'dm' && WRITE_ACTIONS.includes(permission)) {
      const blocked = await getQuery(
        `SELECT 1 FROM blocks b
           JOIN channel_recipients cr ON cr.channel_id = ?
          WHERE (b.user_id = cr.user_id AND b.blocked_id = ?)
             OR (b.user_id = ? AND b.blocked_id = cr.user_id)
          LIMIT 1`,
        [channelId, userId, userId]
      );
      if (blocked) throw ApiError.forbidden('You cannot message this user');
    }
    // Everyone in a DM holds the full conversational permission set.
    return { channel, permissions: null, isDm: true };
  }

  // --- guild channels ----------------------------------------------------------
  // Threads take their permission set from the parent channel.
  const permissionChannelId = channel.type === 'thread' && channel.parent_id
    ? channel.parent_id
    : channel.id;

  const resolved = await resolvePermissions({
    userId, serverId: channel.server_id, channelId: permissionChannelId
  });
  if (!resolved.isMember) throw ApiError.forbidden('You are not a member of this server');
  if (!has(resolved.permissions, 'VIEW_CHANNEL')) {
    throw ApiError.forbidden('Missing permission: VIEW_CHANNEL');
  }
  if (permission && !has(resolved.permissions, permission)) {
    // A timeout is the most common reason a member suddenly cannot act, and
    // "missing SEND_MESSAGES" would be a confusing way to say so.
    if (resolved.timedOut) {
      throw new ApiError('คุณถูกพักการใช้งานชั่วคราว ยังส่งข้อความไม่ได้', {
        status: 403, code: 'TIMED_OUT',
        details: { until: resolved.member?.timeout_until ?? null }
      });
    }
    throw ApiError.forbidden(`Missing permission: ${permission}`);
  }
  return { channel, permissions: resolved.permissions, isDm: false, isOwner: resolved.isOwner };
}

/** Non-throwing variant: does the user hold `permission` in this channel? */
export async function canInChannel({ channelId, userId, permission }) {
  try {
    const { permissions, isDm } = await assertChannelAccess({ channelId, userId, permission });
    return isDm ? true : has(permissions, permission);
  } catch {
    return false;
  }
}
