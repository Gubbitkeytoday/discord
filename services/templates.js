// ============================================================================
//  Server templates (Discord "Server Template"): a portable snapshot of a
//  server's structure — roles, categories, channels (with role overwrites),
//  forum tags and a few settings — that anyone can use to create a new server.
//
//  Templates are stored as JSON with a share code. Members are never included
//  (nor messages, emoji files or invites); role overwrites are re-mapped to
//  the new server's role ids at creation time.
// ============================================================================

import { runQuery, getQuery, allQuery, transaction } from '../db.js';
import { generateId } from '../lib/snowflake.js';
import { ApiError } from '../lib/httpUtils.js';
import crypto from 'crypto';
import { assertPermission, getServerDetail, writeAuditLog } from './guilds.js';
import { DEFAULT_PERMISSIONS } from '../lib/permissions.js';

export const TEMPLATE_VERSION = 1;
export const TEMPLATE_LIMITS = Object.freeze({ perServer: 1, name: 100, description: 120 });

const CHANNEL_FIELDS = ['name', 'type', 'topic', 'position', 'nsfw', 'rate_limit_per_user', 'bitrate', 'user_limit',
  'default_sort_order', 'default_reaction_emoji', 'require_tag', 'default_layout', 'auto_archive_duration'];
const SERVER_FIELDS = ['description', 'verification_level', 'default_notifications', 'explicit_content_filter', 'afk_timeout'];

/** Build the snapshot object from a live server. */
export async function snapshot(serverId) {
  const server = await getQuery(`SELECT * FROM servers WHERE id = ? AND deleted_at IS NULL`, [serverId]);
  if (!server) throw ApiError.notFound('Server');

  const roles = await allQuery(`SELECT * FROM roles WHERE server_id = ? ORDER BY position ASC`, [serverId]);
  const channels = await allQuery(
    `SELECT * FROM channels WHERE server_id = ? AND deleted_at IS NULL AND type != 'thread' ORDER BY position ASC`, [serverId]
  );
  const overwrites = channels.length ? await allQuery(
    `SELECT * FROM channel_overwrites WHERE target_type = 'role' AND channel_id IN (${channels.map(() => '?').join(',')})`,
    channels.map((c) => c.id)
  ) : [];
  const tags = channels.length ? await allQuery(
    `SELECT * FROM forum_tags WHERE channel_id IN (${channels.map(() => '?').join(',')}) ORDER BY position ASC`,
    channels.map((c) => c.id)
  ) : [];

  // Ids inside the template are local ("r1", "c3"); the importer mints real ones.
  const roleKey = new Map(roles.map((r, i) => [r.id, r.is_everyone ? 'everyone' : `r${i}`]));
  const chanKey = new Map(channels.map((c, i) => [c.id, `c${i}`]));

  return {
    version: TEMPLATE_VERSION,
    source: { name: server.name, icon_url: server.icon_url ?? null },
    server: Object.fromEntries(SERVER_FIELDS.map((f) => [f, server[f] ?? null])),
    system_channel: chanKey.get(server.system_channel_id) ?? null,
    rules_channel: chanKey.get(server.rules_channel_id) ?? null,
    afk_channel: chanKey.get(server.afk_channel_id) ?? null,
    roles: roles.map((r) => ({
      key: roleKey.get(r.id), name: r.name, color: r.color ?? null, position: r.position,
      permissions: String(r.permissions), hoist: Boolean(r.hoist), mentionable: Boolean(r.mentionable), everyone: Boolean(r.is_everyone)
    })),
    channels: channels.map((c) => ({
      key: chanKey.get(c.id),
      parent: chanKey.get(c.parent_id) ?? null,
      ...Object.fromEntries(CHANNEL_FIELDS.map((f) => [f, c[f] ?? null])),
      overwrites: overwrites.filter((o) => o.channel_id === c.id).map((o) => ({
        role: roleKey.get(o.target_id), allow: String(o.allow), deny: String(o.deny)
      })).filter((o) => o.role),
      tags: tags.filter((t) => t.channel_id === c.id).map((t) => ({ name: t.name, emoji: t.emoji ?? null, moderated: Boolean(t.moderated) }))
    }))
  };
}

const shape = (row) => ({
  code: row.code, name: row.name, description: row.description ?? null,
  source_server_id: row.source_server_id, creator_id: row.creator_id,
  usage_count: row.usage_count, created_at: row.created_at, updated_at: row.updated_at,
  channel_count: (JSON.parse(row.data).channels ?? []).filter((c) => c.type !== 'category').length,
  role_count: (JSON.parse(row.data).roles ?? []).filter((r) => !r.everyone).length
});

/** Create (or refresh) the template for a server. One template per server, as in Discord. */
export async function createTemplate({ serverId, userId, name, description = null }) {
  await assertPermission({ userId, serverId, permission: 'MANAGE_GUILD' });
  const clean = String(name ?? '').trim().slice(0, TEMPLATE_LIMITS.name);
  if (!clean) throw new ApiError('A template needs a name', { code: 'INVALID_NAME' });
  const desc = description ? String(description).trim().slice(0, TEMPLATE_LIMITS.description) : null;
  const data = JSON.stringify(await snapshot(serverId));

  const existing = await getQuery(`SELECT code FROM server_templates WHERE source_server_id = ?`, [serverId]);
  if (existing) {
    await runQuery(
      `UPDATE server_templates SET name = ?, description = ?, data = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE code = ?`,
      [clean, desc, data, existing.code]
    );
    return shape(await getQuery(`SELECT * FROM server_templates WHERE code = ?`, [existing.code]));
  }
  const code = crypto.randomBytes(9).toString('base64url');
  await runQuery(
    `INSERT INTO server_templates (code, source_server_id, creator_id, name, description, data) VALUES (?, ?, ?, ?, ?, ?)`,
    [code, serverId, userId, clean, desc, data]
  );
  await writeAuditLog({ serverId, userId, actionType: 'TEMPLATE_CREATE', targetType: 'template', targetId: code });
  return shape(await getQuery(`SELECT * FROM server_templates WHERE code = ?`, [code]));
}

/** Re-snapshot the source server into the existing template. */
export async function syncTemplate({ serverId, userId }) {
  await assertPermission({ userId, serverId, permission: 'MANAGE_GUILD' });
  const row = await getQuery(`SELECT * FROM server_templates WHERE source_server_id = ?`, [serverId]);
  if (!row) throw ApiError.notFound('Template');
  await runQuery(
    `UPDATE server_templates SET data = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE code = ?`,
    [JSON.stringify(await snapshot(serverId)), row.code]
  );
  return shape(await getQuery(`SELECT * FROM server_templates WHERE code = ?`, [row.code]));
}

export async function deleteTemplate({ serverId, userId }) {
  await assertPermission({ userId, serverId, permission: 'MANAGE_GUILD' });
  const { changes } = await runQuery(`DELETE FROM server_templates WHERE source_server_id = ?`, [serverId]);
  if (!changes) throw ApiError.notFound('Template');
  return { ok: true };
}

export async function getServerTemplate(serverId, userId) {
  await assertPermission({ userId, serverId, permission: 'MANAGE_GUILD' });
  const row = await getQuery(`SELECT * FROM server_templates WHERE source_server_id = ?`, [serverId]);
  return row ? shape(row) : null;
}

/** Public preview of a template by code — what the "use template" screen shows. */
export async function getTemplate(code) {
  const row = await getQuery(`SELECT * FROM server_templates WHERE code = ?`, [code]);
  if (!row) throw ApiError.notFound('Template');
  const data = JSON.parse(row.data);
  return {
    ...shape(row),
    preview: {
      roles: data.roles.filter((r) => !r.everyone).map((r) => ({ name: r.name, color: r.color })),
      channels: data.channels.map((c) => ({ key: c.key, parent: c.parent, name: c.name, type: c.type }))
    }
  };
}

/**
 * Create a new server from a template. The caller becomes owner. Roles,
 * categories, channels, overwrites and forum tags are recreated with fresh
 * ids; local keys are re-mapped so overwrites point at the new roles.
 */
export async function useTemplate({ code, userId, name, iconUrl = null }) {
  const row = await getQuery(`SELECT * FROM server_templates WHERE code = ?`, [code]);
  if (!row) throw ApiError.notFound('Template');
  const data = JSON.parse(row.data);
  if (data.version !== TEMPLATE_VERSION) throw new ApiError('Unsupported template version', { code: 'TEMPLATE_VERSION' });

  const serverName = String(name ?? data.source?.name ?? 'New Server').trim().slice(0, 100) || 'New Server';
  const serverId = generateId();
  const roleIds = new Map([['everyone', serverId]]);
  const chanIds = new Map();

  await transaction(async () => {
    await runQuery(
      `INSERT INTO servers (id, name, icon_url, owner_id, member_count, description, verification_level,
                            default_notifications, explicit_content_filter, afk_timeout)
       VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      [serverId, serverName, iconUrl || `https://api.dicebear.com/7.x/identicon/svg?seed=${encodeURIComponent(serverName)}`, userId,
       data.server?.description ?? null, Math.min(4, Math.max(0, Number(data.server?.verification_level) || 0)),
       ['all_messages', 'only_mentions'].includes(data.server?.default_notifications) ? data.server.default_notifications : 'all_messages',
       Number(data.server?.explicit_content_filter) || 0,
       [60, 300, 900, 1800, 3600].includes(Number(data.server?.afk_timeout)) ? Number(data.server.afk_timeout) : 300]
    );

    // Roles: @everyone keeps the template's permissions; others get new ids.
    const everyone = data.roles.find((r) => r.everyone);
    await runQuery(
      `INSERT INTO roles (id, server_id, name, position, permissions, is_everyone) VALUES (?, ?, '@everyone', 0, ?, 1)`,
      [serverId, serverId, everyone?.permissions ?? DEFAULT_PERMISSIONS]
    );
    for (const r of data.roles.filter((x) => !x.everyone)) {
      const id = generateId();
      roleIds.set(r.key, id);
      await runQuery(
        `INSERT INTO roles (id, server_id, name, color, position, permissions, hoist, mentionable) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, serverId, String(r.name).slice(0, 100), r.color ?? null, Number(r.position) || 1, String(r.permissions ?? '0'), r.hoist ? 1 : 0, r.mentionable ? 1 : 0]
      );
    }

    await runQuery(`INSERT INTO server_members (server_id, user_id) VALUES (?, ?)`, [serverId, userId]);
    await runQuery(`INSERT INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)`, [serverId, userId, serverId]);
    await runQuery(`INSERT INTO server_settings (user_id, server_id) VALUES (?, ?)`, [userId, serverId]);

    // Channels: categories first so parents exist.
    const ordered = [...data.channels].sort((a, b) => (a.type === 'category' ? -1 : 0) - (b.type === 'category' ? -1 : 0));
    for (const c of ordered) chanIds.set(c.key, generateId());
    for (const c of ordered) {
      const id = chanIds.get(c.key);
      await runQuery(
        `INSERT INTO channels (id, server_id, parent_id, name, type, topic, position, nsfw, rate_limit_per_user, bitrate, user_limit,
                               default_sort_order, default_reaction_emoji, require_tag, default_layout, auto_archive_duration)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, serverId, c.parent ? chanIds.get(c.parent) ?? null : null, String(c.name).slice(0, 100), c.type, c.topic ?? null,
         Number(c.position) || 0, c.nsfw ? 1 : 0, Number(c.rate_limit_per_user) || 0, c.bitrate ?? null, c.user_limit ?? null,
         ['latest_activity', 'creation_date'].includes(c.default_sort_order) ? c.default_sort_order : 'latest_activity',
         c.default_reaction_emoji ?? null, c.require_tag ? 1 : 0,
         ['list', 'gallery'].includes(c.default_layout) ? c.default_layout : 'list', Number(c.auto_archive_duration) || 1440]
      );
      for (const o of c.overwrites ?? []) {
        const roleId = roleIds.get(o.role);
        if (!roleId) continue;
        await runQuery(
          `INSERT INTO channel_overwrites (channel_id, target_type, target_id, allow, deny) VALUES (?, 'role', ?, ?, ?)`,
          [id, roleId, String(o.allow ?? '0'), String(o.deny ?? '0')]
        );
      }
      let pos = 0;
      for (const tag of (c.tags ?? []).slice(0, 20)) {
        await runQuery(
          `INSERT OR IGNORE INTO forum_tags (id, channel_id, name, emoji, moderated, position) VALUES (?, ?, ?, ?, ?, ?)`,
          [generateId(), id, String(tag.name).slice(0, 20), tag.emoji ?? null, tag.moderated ? 1 : 0, pos++]
        );
      }
    }

    await runQuery(
      `UPDATE servers SET system_channel_id = ?, rules_channel_id = ?, afk_channel_id = ? WHERE id = ?`,
      [chanIds.get(data.system_channel) ?? null, chanIds.get(data.rules_channel) ?? null, chanIds.get(data.afk_channel) ?? null, serverId]
    );
    await runQuery(`UPDATE server_templates SET usage_count = usage_count + 1 WHERE code = ?`, [code]);
    await writeAuditLog({ serverId, userId, actionType: 'SERVER_CREATE', targetId: serverId, changes: [{ key: 'template', new: code }] });
  });

  return getServerDetail(serverId, userId);
}
