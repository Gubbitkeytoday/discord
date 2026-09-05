// ============================================================================
//  Server Insights, the public widget, and raid protection.
//
//  Insights are computed on demand from the tables that already exist — there
//  is no analytics pipeline and no second copy of the data, so a number shown
//  here is the same number the app would show you by counting. That costs a
//  few grouped queries per request, which is the right trade at this scale and
//  is honest about where the figures come from.
// ============================================================================

import { runQuery, getQuery, allQuery } from '../db.js';
import { generateId } from '../lib/snowflake.js';
import { ApiError } from '../lib/httpUtils.js';
import { assertPermission, writeAuditLog } from './guilds.js';

export const RAID_LIMITS = Object.freeze({
  minThreshold: 3, maxThreshold: 200,
  minWindow: 10, maxWindow: 3600
});

const DAY_MS = 24 * 60 * 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

/**
 * Everything the Insights tab shows, for a window of `days`.
 *
 * Every figure is a count over a real table: members joined/left from
 * `server_members`, messages from `messages`, voice from `voice_states`
 * history is not kept, so voice is reported as "currently connected" rather
 * than invented.
 */
export async function getInsights({ serverId, userId, days = 30 }) {
  await assertPermission({ userId, serverId, permission: 'MANAGE_GUILD' });
  const window = Math.min(180, Math.max(1, Number(days) || 30));
  const since = iso(Date.now() - window * DAY_MS);
  const previousSince = iso(Date.now() - 2 * window * DAY_MS);

  const server = await getQuery(
    `SELECT id, name, member_count, created_at FROM servers WHERE id = ? AND deleted_at IS NULL`, [serverId]
  );
  if (!server) throw ApiError.notFound('Server');

  const [joined, left, joinedBefore, messages, messagesBefore, activeAuthors, activeBefore] = await Promise.all([
    getQuery(`SELECT count(*) AS n FROM server_members WHERE server_id = ? AND joined_at >= ?`, [serverId, since]),
    getQuery(`SELECT count(*) AS n FROM server_members WHERE server_id = ? AND left_at >= ?`, [serverId, since]),
    getQuery(`SELECT count(*) AS n FROM server_members WHERE server_id = ? AND joined_at >= ? AND joined_at < ?`,
      [serverId, previousSince, since]),
    getQuery(`SELECT count(*) AS n FROM messages WHERE server_id = ? AND deleted_at IS NULL AND created_at >= ?`,
      [serverId, since]),
    getQuery(`SELECT count(*) AS n FROM messages WHERE server_id = ? AND deleted_at IS NULL AND created_at >= ? AND created_at < ?`,
      [serverId, previousSince, since]),
    getQuery(`SELECT count(DISTINCT user_id) AS n FROM messages WHERE server_id = ? AND deleted_at IS NULL AND created_at >= ?`,
      [serverId, since]),
    getQuery(`SELECT count(DISTINCT user_id) AS n FROM messages WHERE server_id = ? AND deleted_at IS NULL AND created_at >= ? AND created_at < ?`,
      [serverId, previousSince, since])
  ]);

  // Daily series, zero-filled so a quiet day is a gap in the line rather than
  // a missing point that the chart would silently close over.
  const rows = await allQuery(
    `SELECT substr(created_at, 1, 10) AS day, count(*) AS messages, count(DISTINCT user_id) AS authors
       FROM messages
      WHERE server_id = ? AND deleted_at IS NULL AND created_at >= ?
      GROUP BY day ORDER BY day`, [serverId, since]
  );
  const joins = await allQuery(
    `SELECT substr(joined_at, 1, 10) AS day, count(*) AS joins
       FROM server_members WHERE server_id = ? AND joined_at >= ? GROUP BY day ORDER BY day`, [serverId, since]
  );
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const joinsByDay = new Map(joins.map((r) => [r.day, r.joins]));
  const series = [];
  for (let i = window - 1; i >= 0; i -= 1) {
    const day = iso(Date.now() - i * DAY_MS).slice(0, 10);
    series.push({
      day,
      messages: byDay.get(day)?.messages ?? 0,
      authors: byDay.get(day)?.authors ?? 0,
      joins: joinsByDay.get(day) ?? 0
    });
  }

  const topChannels = await allQuery(
    `SELECT c.id, c.name, c.type, count(m.id) AS messages, count(DISTINCT m.user_id) AS authors
       FROM messages m JOIN channels c ON c.id = m.channel_id
      WHERE m.server_id = ? AND m.deleted_at IS NULL AND m.created_at >= ? AND c.deleted_at IS NULL
      GROUP BY c.id ORDER BY messages DESC LIMIT 10`, [serverId, since]
  );
  const topMembers = await allQuery(
    `SELECT u.id, u.username, u.display_name, u.avatar_url, u.is_bot, count(m.id) AS messages
       FROM messages m JOIN users u ON u.id = m.user_id
      WHERE m.server_id = ? AND m.deleted_at IS NULL AND m.created_at >= ?
      GROUP BY u.id ORDER BY messages DESC LIMIT 10`, [serverId, since]
  );
  const retention = await getQuery(
    `SELECT
       (SELECT count(*) FROM server_members WHERE server_id = ? AND joined_at >= ? AND left_at IS NULL) AS stayed,
       (SELECT count(*) FROM server_members WHERE server_id = ? AND joined_at >= ?) AS total`,
    [serverId, since, serverId, since]
  );
  const voiceNow = await getQuery(
    `SELECT count(*) AS n FROM voice_states WHERE server_id = ? AND channel_id IS NOT NULL`, [serverId]
  );

  const delta = (now, before) => (before > 0 ? Math.round(((now - before) / before) * 100) : null);

  return {
    server: { id: server.id, name: server.name, member_count: server.member_count, created_at: server.created_at },
    window_days: window,
    totals: {
      members: server.member_count,
      joined: joined.n, left: left.n, net: joined.n - left.n,
      messages: messages.n,
      active_members: activeAuthors.n,
      in_voice_now: voiceNow.n,
      retention_percent: retention.total > 0 ? Math.round((retention.stayed / retention.total) * 100) : null
    },
    change_percent: {
      joined: delta(joined.n, joinedBefore.n),
      messages: delta(messages.n, messagesBefore.n),
      active_members: delta(activeAuthors.n, activeBefore.n)
    },
    series,
    top_channels: topChannels.map((c) => ({ ...c, messages: c.messages, authors: c.authors })),
    top_members: topMembers.map((m) => ({ ...m, is_bot: Boolean(m.is_bot) }))
  };
}

// ---------------------------------------------------------------------------
// Public widget
// ---------------------------------------------------------------------------

/**
 * The widget is deliberately thin: a name, an approximate presence count and,
 * if a channel is nominated, an instant invite. No member list, no message
 * content — it is served without authentication, so it must be safe to leak.
 */
export async function getWidget(serverId) {
  const server = await getQuery(
    `SELECT id, name, icon_url, widget_enabled, widget_channel_id, member_count
       FROM servers WHERE id = ? AND deleted_at IS NULL`, [serverId]
  );
  if (!server) throw ApiError.notFound('Server');
  if (!server.widget_enabled) throw ApiError.forbidden('The widget is disabled for this server');

  const online = await getQuery(
    `SELECT count(*) AS n FROM server_members sm JOIN users u ON u.id = sm.user_id
      WHERE sm.server_id = ? AND sm.left_at IS NULL AND u.status IN ('online','idle','dnd')`, [serverId]
  );
  const voice = await allQuery(
    `SELECT c.id, c.name, count(vs.user_id) AS members
       FROM channels c LEFT JOIN voice_states vs ON vs.channel_id = c.id
      WHERE c.server_id = ? AND c.type = 'voice' AND c.deleted_at IS NULL
      GROUP BY c.id ORDER BY members DESC, c.position ASC LIMIT 10`, [serverId]
  );

  let instantInvite = null;
  if (server.widget_channel_id) {
    const invite = await getQuery(
      `SELECT code FROM invites
        WHERE channel_id = ? AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        ORDER BY created_at DESC LIMIT 1`, [server.widget_channel_id]
    );
    instantInvite = invite?.code ? `/invite/${invite.code}` : null;
  }

  return {
    id: server.id,
    name: server.name,
    icon_url: server.icon_url,
    presence_count: online.n,
    member_count: server.member_count,
    instant_invite: instantInvite,
    voice_channels: voice.map((c) => ({ id: c.id, name: c.name, members: c.members }))
  };
}

export async function updateWidget({ serverId, userId, enabled, channelId }) {
  await assertPermission({ userId, serverId, permission: 'MANAGE_GUILD' });
  const sets = []; const params = [];
  if (enabled !== undefined) { sets.push('widget_enabled = ?'); params.push(enabled ? 1 : 0); }
  if (channelId !== undefined) {
    if (channelId) {
      const channel = await getQuery(
        `SELECT id FROM channels WHERE id = ? AND server_id = ? AND deleted_at IS NULL`, [channelId, serverId]
      );
      if (!channel) throw new ApiError('Unknown channel', { code: 'INVALID_CHANNEL' });
    }
    sets.push('widget_channel_id = ?'); params.push(channelId || null);
  }
  if (sets.length) await runQuery(`UPDATE servers SET ${sets.join(', ')} WHERE id = ?`, [...params, serverId]);
  const row = await getQuery(
    `SELECT widget_enabled, widget_channel_id FROM servers WHERE id = ?`, [serverId]
  );
  return { enabled: Boolean(row.widget_enabled), channel_id: row.widget_channel_id ?? null };
}

// ---------------------------------------------------------------------------
// Raid protection
// ---------------------------------------------------------------------------

export async function getRaidSettings(serverId, userId) {
  await assertPermission({ userId, serverId, permission: 'MANAGE_GUILD' });
  const server = await getQuery(
    `SELECT raid_protection, raid_join_threshold, raid_join_window_secs, raid_action
       FROM servers WHERE id = ? AND deleted_at IS NULL`, [serverId]
  );
  if (!server) throw ApiError.notFound('Server');
  const active = await activeLockdown(serverId);
  return {
    enabled: Boolean(server.raid_protection),
    join_threshold: server.raid_join_threshold,
    join_window_secs: server.raid_join_window_secs,
    action: server.raid_action,
    lockdown: active
  };
}

export async function updateRaidSettings({ serverId, userId, patch }) {
  await assertPermission({ userId, serverId, permission: 'MANAGE_GUILD' });
  const sets = []; const params = [];
  if (patch.enabled !== undefined) { sets.push('raid_protection = ?'); params.push(patch.enabled ? 1 : 0); }
  if (patch.join_threshold !== undefined) {
    const n = Number(patch.join_threshold);
    if (!Number.isFinite(n) || n < RAID_LIMITS.minThreshold || n > RAID_LIMITS.maxThreshold) {
      throw new ApiError(`Threshold must be ${RAID_LIMITS.minThreshold}–${RAID_LIMITS.maxThreshold}`, { code: 'RAID_INVALID' });
    }
    sets.push('raid_join_threshold = ?'); params.push(Math.round(n));
  }
  if (patch.join_window_secs !== undefined) {
    const n = Number(patch.join_window_secs);
    if (!Number.isFinite(n) || n < RAID_LIMITS.minWindow || n > RAID_LIMITS.maxWindow) {
      throw new ApiError(`Window must be ${RAID_LIMITS.minWindow}–${RAID_LIMITS.maxWindow} seconds`, { code: 'RAID_INVALID' });
    }
    sets.push('raid_join_window_secs = ?'); params.push(Math.round(n));
  }
  if (patch.action !== undefined) {
    if (!['lockdown', 'screen'].includes(patch.action)) {
      throw new ApiError('Action must be lockdown or screen', { code: 'RAID_INVALID' });
    }
    sets.push('raid_action = ?'); params.push(patch.action);
  }
  if (sets.length) await runQuery(`UPDATE servers SET ${sets.join(', ')} WHERE id = ?`, [...params, serverId]);
  return getRaidSettings(serverId, userId);
}

export async function activeLockdown(serverId) {
  const row = await getQuery(
    `SELECT * FROM guild_lockdowns WHERE server_id = ? AND lifted_at IS NULL ORDER BY started_at DESC LIMIT 1`,
    [serverId]
  );
  return row ? { id: row.id, reason: row.reason, joins: row.joins, started_at: row.started_at } : null;
}

/**
 * Called from joinServer *before* the member row is written.
 *
 * If a lockdown is active the join is refused outright. Otherwise the recent
 * join rate is measured, and crossing the threshold either locks the server
 * down or (action = 'screen') turns membership screening on so the flood
 * lands in the pending state instead of in the channels.
 */
export async function guardJoin(serverId) {
  const server = await getQuery(
    `SELECT raid_protection, raid_join_threshold, raid_join_window_secs, raid_action, screening_enabled
       FROM servers WHERE id = ?`, [serverId]
  );
  if (!server?.raid_protection) return { allowed: true };

  const existing = await activeLockdown(serverId);
  if (existing) {
    throw new ApiError('This server is locked down against a raid — try again later', {
      status: 403, code: 'SERVER_LOCKDOWN'
    });
  }

  const since = iso(Date.now() - server.raid_join_window_secs * 1000);
  const recent = await getQuery(
    `SELECT count(*) AS n FROM server_members WHERE server_id = ? AND joined_at >= ?`, [serverId, since]
  );
  // The joiner about to be written counts too, so compare against >= threshold.
  if (recent.n + 1 < server.raid_join_threshold) return { allowed: true };

  if (server.raid_action === 'screen') {
    await runQuery(`UPDATE servers SET screening_enabled = 1 WHERE id = ?`, [serverId]);
    return { allowed: true, triggered: 'screen', joins: recent.n + 1 };
  }

  const id = generateId();
  await runQuery(
    `INSERT INTO guild_lockdowns (id, server_id, reason, joins) VALUES (?, ?, ?, ?)`,
    [id, serverId, `${recent.n + 1} joins in ${server.raid_join_window_secs}s`, recent.n + 1]
  );
  throw new ApiError('This server just locked down against a raid — try again later', {
    status: 403, code: 'SERVER_LOCKDOWN'
  });
}

export async function liftLockdown({ serverId, userId }) {
  await assertPermission({ userId, serverId, permission: 'MANAGE_GUILD' });
  const active = await activeLockdown(serverId);
  if (!active) throw new ApiError('This server is not locked down', { code: 'NO_LOCKDOWN' });
  await runQuery(
    `UPDATE guild_lockdowns SET lifted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), lifted_by = ? WHERE id = ?`,
    [userId, active.id]
  );
  await writeAuditLog({ serverId, userId, actionType: 'LOCKDOWN_LIFT', targetType: 'server', targetId: serverId });
  return { ok: true };
}

/** Staff can also lock a server down by hand, before the rate trips. */
export async function startLockdown({ serverId, userId, reason = 'Manual lockdown' }) {
  await assertPermission({ userId, serverId, permission: 'MANAGE_GUILD' });
  const active = await activeLockdown(serverId);
  if (active) return active;
  const id = generateId();
  await runQuery(
    `INSERT INTO guild_lockdowns (id, server_id, reason, joins) VALUES (?, ?, ?, 0)`,
    [id, serverId, String(reason).slice(0, 200)]
  );
  await writeAuditLog({ serverId, userId, actionType: 'LOCKDOWN_START', targetType: 'server', targetId: serverId });
  return activeLockdown(serverId);
}

export async function listLockdowns(serverId, userId) {
  await assertPermission({ userId, serverId, permission: 'MANAGE_GUILD' });
  return allQuery(
    `SELECT id, reason, joins, started_at, lifted_at, lifted_by
       FROM guild_lockdowns WHERE server_id = ? ORDER BY started_at DESC LIMIT 25`, [serverId]
  );
}
