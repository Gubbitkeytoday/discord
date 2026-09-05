// ============================================================================
//  Applications (bots), their slash commands, and interactions.
//
//  The design decision that makes the rest of this small: a bot is a *user*.
//  Creating an application mints a `users` row with is_bot = 1, and the bot
//  token resolves to that user id during identity resolution. From then on the
//  bot travels every path a person does — the same permission gate, the same
//  message pipeline, the same realtime rooms — so there is no second API to
//  keep in step and no weaker path to audit.
//
//  Inviting a bot to a server creates a *managed* role holding exactly the
//  permissions the inviter granted, as Discord does; removing the bot removes
//  the role. Because the role is managed, the role editor will not let anyone
//  hand a bot more than it was invited with by accident.
// ============================================================================

import crypto from 'crypto';
import { runQuery, getQuery, allQuery, transaction } from '../db.js';
import { generateId } from '../lib/snowflake.js';
import { ApiError } from '../lib/httpUtils.js';
import { assertPermission, writeAuditLog } from './guilds.js';
import { assertChannelAccess } from './access.js';
import { fromNames, toNames, has } from '../lib/permissions.js';

export const APP_LIMITS = Object.freeze({
  perOwner: 25, name: 32, description: 190,
  commandsPerScope: 100, commandName: 32, commandDescription: 100, options: 25,
  componentsPerMessage: 5, buttonsPerRow: 5, embedsPerMessage: 10,
  interactionTtlMs: 15 * 60 * 1000
});

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

/** Permissions a bot may never be granted through an invite. */
const NEVER_GRANT = ['ADMINISTRATOR'];

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

/**
 * Resolve `Authorization: Bot <token>` to the bot user. Returns null for
 * anything else so the caller can fall through to session handling.
 */
export async function resolveBotToken(token) {
  if (!token) return null;
  const app = await getQuery(
    `SELECT id, bot_user_id FROM applications WHERE token_hash = ? AND deleted_at IS NULL`,
    [hashToken(String(token))]
  );
  if (!app) return null;
  return { applicationId: app.id, userId: app.bot_user_id };
}

// ---------------------------------------------------------------------------
// Applications
// ---------------------------------------------------------------------------

function shape(row, { token = null } = {}) {
  return {
    id: row.id, name: row.name, description: row.description ?? null,
    icon_url: row.icon_url ?? null, owner_id: row.owner_id,
    bot_user_id: row.bot_user_id, public: Boolean(row.public),
    created_at: row.created_at,
    bot: row.bot_username ? {
      id: row.bot_user_id, username: row.bot_username,
      discriminator: row.bot_discriminator, avatar_url: row.bot_avatar_url, is_bot: true
    } : undefined,
    ...(token ? { token } : {})
  };
}

const APP_SELECT = `
  SELECT a.*, u.username AS bot_username, u.discriminator AS bot_discriminator, u.avatar_url AS bot_avatar_url
    FROM applications a JOIN users u ON u.id = a.bot_user_id
`;

export async function listApplications(ownerId) {
  const rows = await allQuery(
    `${APP_SELECT} WHERE a.owner_id = ? AND a.deleted_at IS NULL ORDER BY a.created_at ASC`, [ownerId]
  );
  return rows.map((r) => shape(r));
}

export async function getApplication(applicationId) {
  const row = await getQuery(`${APP_SELECT} WHERE a.id = ? AND a.deleted_at IS NULL`, [applicationId]);
  if (!row) throw ApiError.notFound('Application');
  return shape(row);
}

async function assertOwner(applicationId, userId) {
  const row = await getQuery(
    `SELECT * FROM applications WHERE id = ? AND deleted_at IS NULL`, [applicationId]
  );
  if (!row) throw ApiError.notFound('Application');
  if (row.owner_id !== userId) throw ApiError.forbidden('Only the application owner may do that');
  return row;
}

/** Pick a free discriminator for a bot user, the same way accounts do. */
async function freeDiscriminator(username) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = String(Math.floor(Math.random() * 9999) + 1).padStart(4, '0');
    const taken = await getQuery(
      `SELECT 1 FROM users WHERE username = ? AND discriminator = ?`, [username, candidate]
    );
    if (!taken) return candidate;
  }
  throw new ApiError('Could not allocate a discriminator', { code: 'NO_DISCRIMINATOR' });
}

/**
 * Create an application and its bot user. The token is returned exactly once —
 * only its hash is stored, so a lost token is reset, never recovered.
 */
export async function createApplication({ ownerId, name, description = null }) {
  const clean = String(name ?? '').trim().slice(0, APP_LIMITS.name);
  if (!clean) throw new ApiError('An application needs a name', { code: 'INVALID_NAME' });

  const count = (await getQuery(
    `SELECT count(*) AS n FROM applications WHERE owner_id = ? AND deleted_at IS NULL`, [ownerId]
  )).n;
  if (count >= APP_LIMITS.perOwner) {
    throw new ApiError(`You may own at most ${APP_LIMITS.perOwner} applications`, { code: 'APP_LIMIT' });
  }

  const appId = generateId();
  const botUserId = generateId();
  const token = `${appId}.${crypto.randomBytes(24).toString('base64url')}`;

  await transaction(async () => {
    await runQuery(
      `INSERT INTO users (id, username, discriminator, display_name, avatar_url, is_bot, status)
       VALUES (?, ?, ?, ?, NULL, 1, 'online')`,
      [botUserId, clean, await freeDiscriminator(clean), clean]
    );
    await runQuery(
      `INSERT INTO applications (id, name, description, owner_id, bot_user_id, token_hash)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [appId, clean, description ? String(description).slice(0, APP_LIMITS.description) : null,
       ownerId, botUserId, hashToken(token)]
    );
  });

  const row = await getQuery(`${APP_SELECT} WHERE a.id = ?`, [appId]);
  return shape(row, { token });
}

export async function updateApplication({ applicationId, userId, patch }) {
  await assertOwner(applicationId, userId);
  const sets = []; const params = [];
  if (patch.name !== undefined) {
    const clean = String(patch.name).trim().slice(0, APP_LIMITS.name);
    if (!clean) throw new ApiError('An application needs a name', { code: 'INVALID_NAME' });
    sets.push('name = ?'); params.push(clean);
  }
  if (patch.description !== undefined) {
    sets.push('description = ?');
    params.push(patch.description ? String(patch.description).slice(0, APP_LIMITS.description) : null);
  }
  if (patch.icon_url !== undefined) { sets.push('icon_url = ?'); params.push(patch.icon_url || null); }
  if (patch.public !== undefined) { sets.push('public = ?'); params.push(patch.public ? 1 : 0); }
  if (sets.length) await runQuery(`UPDATE applications SET ${sets.join(', ')} WHERE id = ?`, [...params, applicationId]);

  // The bot user wears the application's name and icon.
  const app = await getQuery(`SELECT * FROM applications WHERE id = ?`, [applicationId]);
  await runQuery(
    `UPDATE users SET display_name = ?, avatar_url = ? WHERE id = ?`,
    [app.name, app.icon_url, app.bot_user_id]
  );
  return getApplication(applicationId);
}

/** Mint a new token and invalidate the old one. Returned once. */
export async function resetToken({ applicationId, userId }) {
  const app = await assertOwner(applicationId, userId);
  const token = `${app.id}.${crypto.randomBytes(24).toString('base64url')}`;
  await runQuery(`UPDATE applications SET token_hash = ? WHERE id = ?`, [hashToken(token), applicationId]);
  return { token };
}

export async function deleteApplication({ applicationId, userId }) {
  const app = await assertOwner(applicationId, userId);
  await transaction(async () => {
    await runQuery(
      `UPDATE applications SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), token_hash = ? WHERE id = ?`,
      [`revoked:${generateId()}`, applicationId]
    );
    // The bot leaves every server; its messages stay, as a person's would.
    await runQuery(
      `UPDATE server_members SET left_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id = ? AND left_at IS NULL`,
      [app.bot_user_id]
    );
    await runQuery(`DELETE FROM roles WHERE managed = 1 AND name = ?`, [app.name]);
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Inviting a bot
// ---------------------------------------------------------------------------

/**
 * Add the bot to a server with a managed role carrying `permissionNames`.
 * The inviter needs MANAGE_GUILD, and cannot grant a permission they do not
 * hold themselves — otherwise "invite a bot" would be a privilege ladder.
 */
export async function inviteBot({ applicationId, serverId, userId, permissionNames = [] }) {
  const app = await getQuery(
    `SELECT * FROM applications WHERE id = ? AND deleted_at IS NULL`, [applicationId]
  );
  if (!app) throw ApiError.notFound('Application');
  if (!app.public && app.owner_id !== userId) {
    throw ApiError.forbidden('This application is private');
  }
  const { permissions: inviterPermissions, isOwner } =
    await assertPermission({ userId, serverId, permission: 'MANAGE_GUILD' });

  const wanted = [...new Set(permissionNames.map(String))].filter((name) => !NEVER_GRANT.includes(name));
  for (const name of wanted) {
    if (!isOwner && !has(inviterPermissions, name)) {
      throw ApiError.forbidden(`You cannot grant a permission you do not have: ${name}`);
    }
  }

  const already = await getQuery(
    `SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ? AND left_at IS NULL`,
    [serverId, app.bot_user_id]
  );
  if (already) throw new ApiError('That bot is already in this server', { status: 409, code: 'BOT_PRESENT' });

  const roleId = generateId();
  await transaction(async () => {
    const { maxPos } = await getQuery(
      `SELECT COALESCE(MAX(position), 0) AS maxPos FROM roles WHERE server_id = ?`, [serverId]
    );
    await runQuery(
      `INSERT INTO roles (id, server_id, name, position, permissions, managed, mentionable)
       VALUES (?, ?, ?, ?, ?, 1, 1)`,
      [roleId, serverId, app.name, Math.max(1, maxPos - 1), fromNames(wanted)]
    );
    await runQuery(
      `INSERT INTO server_members (server_id, user_id) VALUES (?, ?)
       ON CONFLICT(server_id, user_id) DO UPDATE SET left_at = NULL`,
      [serverId, app.bot_user_id]
    );
    await runQuery(
      `INSERT OR IGNORE INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)`,
      [serverId, app.bot_user_id, serverId]
    );
    await runQuery(
      `INSERT OR IGNORE INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)`,
      [serverId, app.bot_user_id, roleId]
    );
    await runQuery(
      `UPDATE servers SET member_count = (
         SELECT count(*) FROM server_members WHERE server_id = ? AND left_at IS NULL
       ) WHERE id = ?`, [serverId, serverId]
    );
    await runQuery(
      `INSERT OR IGNORE INTO server_settings (user_id, server_id) VALUES (?, ?)`, [app.bot_user_id, serverId]
    );
  });
  await writeAuditLog({
    serverId, userId, actionType: 'BOT_ADD', targetType: 'user', targetId: app.bot_user_id,
    changes: [{ key: 'permissions', new: wanted.join(', ') }]
  });
  return { application_id: app.id, bot_user_id: app.bot_user_id, role_id: roleId, permissions: wanted };
}

export async function removeBot({ applicationId, serverId, userId }) {
  const app = await getQuery(`SELECT * FROM applications WHERE id = ?`, [applicationId]);
  if (!app) throw ApiError.notFound('Application');
  await assertPermission({ userId, serverId, permission: 'MANAGE_GUILD' });
  await transaction(async () => {
    await runQuery(
      `UPDATE server_members SET left_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE server_id = ? AND user_id = ?`, [serverId, app.bot_user_id]
    );
    await runQuery(
      `DELETE FROM roles WHERE server_id = ? AND managed = 1 AND name = ?`, [serverId, app.name]
    );
    await runQuery(
      `UPDATE servers SET member_count = (
         SELECT count(*) FROM server_members WHERE server_id = ? AND left_at IS NULL
       ) WHERE id = ?`, [serverId, serverId]
    );
  });
  await writeAuditLog({ serverId, userId, actionType: 'BOT_REMOVE', targetType: 'user', targetId: app.bot_user_id });
  return { ok: true };
}

/** Which servers is this bot in? Owner-only. */
export async function listBotGuilds({ applicationId, userId }) {
  const app = await assertOwner(applicationId, userId);
  return allQuery(
    `SELECT s.id, s.name, s.icon_url, s.member_count
       FROM server_members sm JOIN servers s ON s.id = sm.server_id
      WHERE sm.user_id = ? AND sm.left_at IS NULL AND s.deleted_at IS NULL
      ORDER BY s.name`, [app.bot_user_id]
  );
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

const COMMAND_NAME = /^[a-z0-9_-]{1,32}$/;
const OPTION_TYPES = new Set(['string', 'integer', 'boolean', 'user', 'channel', 'role']);

const COMMAND_TYPES = new Set(['slash', 'message', 'user']);

function validateCommand(input) {
  const type = COMMAND_TYPES.has(input?.type) ? input.type : 'slash';
  // A context-menu command is picked from a right-click menu, so its name is a
  // label a person reads — mixed case and spaces allowed, and no description
  // is needed because the menu row *is* the description.
  const name = type === 'slash'
    ? String(input?.name ?? '').trim().toLowerCase()
    : String(input?.name ?? '').trim().slice(0, 32);
  if (type === 'slash' && !COMMAND_NAME.test(name)) {
    throw new ApiError('A command name is 1–32 characters of a–z, 0–9, - or _', { code: 'COMMAND_INVALID' });
  }
  if (type !== 'slash' && !name) {
    throw new ApiError('A context-menu command needs a label', { code: 'COMMAND_INVALID' });
  }
  const description = type === 'slash'
    ? String(input?.description ?? '').trim().slice(0, APP_LIMITS.commandDescription)
    : (String(input?.description ?? '').trim().slice(0, APP_LIMITS.commandDescription) || name);
  if (!description) throw new ApiError('A command needs a description', { code: 'COMMAND_INVALID' });

  const options = (Array.isArray(input?.options) ? input.options : []).slice(0, APP_LIMITS.options).map((o) => {
    const oName = String(o?.name ?? '').trim().toLowerCase();
    if (!COMMAND_NAME.test(oName)) throw new ApiError('Invalid option name', { code: 'COMMAND_INVALID' });
    const type = OPTION_TYPES.has(o?.type) ? o.type : 'string';
    return {
      name: oName,
      description: String(o?.description ?? '').slice(0, APP_LIMITS.commandDescription) || oName,
      type,
      required: Boolean(o?.required),
      choices: Array.isArray(o?.choices)
        ? o.choices.slice(0, 25).map((c) => ({ name: String(c?.name ?? c).slice(0, 100), value: c?.value ?? c }))
        : []
    };
  });
  // Context-menu commands take their argument from what was clicked, not from
  // typed options, so any options sent with one are dropped.
  return { name, description, type, options: type === 'slash' ? options : [] };
}

/** Replace the whole command set for a scope (global, or one guild). */
export async function putCommands({ applicationId, userId, serverId = null, commands }) {
  await assertOwner(applicationId, userId);
  if (serverId) {
    const member = await getQuery(
      `SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ? AND left_at IS NULL`, [serverId, userId]
    );
    if (!member) throw ApiError.forbidden('You are not in that server');
  }
  const list = (Array.isArray(commands) ? commands : []).slice(0, APP_LIMITS.commandsPerScope).map(validateCommand);
  const names = new Set();
  for (const c of list) {
    if (names.has(c.name)) throw new ApiError(`Duplicate command: ${c.name}`, { code: 'COMMAND_DUPLICATE' });
    names.add(c.name);
  }

  await transaction(async () => {
    await runQuery(
      serverId
        ? `DELETE FROM application_commands WHERE application_id = ? AND server_id = ?`
        : `DELETE FROM application_commands WHERE application_id = ? AND server_id IS NULL`,
      serverId ? [applicationId, serverId] : [applicationId]
    );
    for (const c of list) {
      await runQuery(
        `INSERT INTO application_commands (id, application_id, server_id, name, description, type, options)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [generateId(), applicationId, serverId, c.name, c.description, c.type, JSON.stringify(c.options)]
      );
    }
  });
  return listCommands({ applicationId, serverId });
}

export async function listCommands({ applicationId, serverId = null }) {
  const rows = await allQuery(
    serverId
      ? `SELECT * FROM application_commands WHERE application_id = ? AND (server_id = ? OR server_id IS NULL) ORDER BY name`
      : `SELECT * FROM application_commands WHERE application_id = ? AND server_id IS NULL ORDER BY name`,
    serverId ? [applicationId, serverId] : [applicationId]
  );
  return rows.map((r) => ({
    id: r.id, application_id: r.application_id, server_id: r.server_id,
    name: r.name, description: r.description, type: r.type ?? 'slash',
    options: JSON.parse(r.options || '[]')
  }));
}

/**
 * Every command a member can run in this channel: those registered for the
 * guild or globally, by bots that are actually in the guild.
 */
export async function commandsForChannel({ channelId, userId }) {
  const channel = await getQuery(
    `SELECT id, server_id FROM channels WHERE id = ? AND deleted_at IS NULL`, [channelId]
  );
  if (!channel?.server_id) return [];
  await assertChannelAccess({ channelId, userId });
  const rows = await allQuery(
    `SELECT c.*, a.name AS app_name, a.bot_user_id, u.avatar_url AS bot_avatar_url
       FROM application_commands c
       JOIN applications a ON a.id = c.application_id AND a.deleted_at IS NULL
       JOIN users u ON u.id = a.bot_user_id
       JOIN server_members sm ON sm.user_id = a.bot_user_id AND sm.server_id = ? AND sm.left_at IS NULL
      WHERE c.server_id = ? OR c.server_id IS NULL
      ORDER BY c.name`,
    [channel.server_id, channel.server_id]
  );
  return rows.map((r) => ({
    id: r.id, name: r.name, description: r.description, type: r.type ?? 'slash',
    options: JSON.parse(r.options || '[]'),
    application_id: r.application_id, application_name: r.app_name,
    bot_user_id: r.bot_user_id, bot_avatar_url: r.bot_avatar_url
  }));
}

// ---------------------------------------------------------------------------
// Message components (buttons, select menus)
// ---------------------------------------------------------------------------

const BUTTON_STYLES = new Set(['primary', 'secondary', 'success', 'danger', 'link']);

/**
 * Validate the `components` of a message: rows of buttons, or a row holding a
 * single select menu — Discord's shape, and the one the renderer understands.
 * Returns the normalised array, ready to store.
 */
export function validateComponents(components) {
  const rows = Array.isArray(components) ? components : [];
  if (rows.length === 0) return [];
  if (rows.length > APP_LIMITS.componentsPerMessage) {
    throw new ApiError(`At most ${APP_LIMITS.componentsPerMessage} rows of components`, { code: 'COMPONENTS_INVALID' });
  }
  const seen = new Set();
  return rows.map((row) => {
    const children = Array.isArray(row?.components) ? row.components : [];
    if (children.length === 0) throw new ApiError('A component row cannot be empty', { code: 'COMPONENTS_INVALID' });

    const select = children.find((c) => c?.type === 'select');
    if (select) {
      if (children.length > 1) throw new ApiError('A select menu must be alone in its row', { code: 'COMPONENTS_INVALID' });
      const customId = String(select.custom_id ?? '').slice(0, 100);
      if (!customId) throw new ApiError('A select menu needs a custom_id', { code: 'COMPONENTS_INVALID' });
      if (seen.has(customId)) throw new ApiError('custom_id must be unique in a message', { code: 'COMPONENTS_INVALID' });
      seen.add(customId);
      const options = (Array.isArray(select.options) ? select.options : []).slice(0, 25).map((o) => ({
        label: String(o?.label ?? '').slice(0, 100) || String(o?.value ?? ''),
        value: String(o?.value ?? '').slice(0, 100),
        description: o?.description ? String(o.description).slice(0, 100) : null,
        emoji: o?.emoji ? String(o.emoji).slice(0, 64) : null,
        default: Boolean(o?.default)
      })).filter((o) => o.value);
      if (options.length === 0) throw new ApiError('A select menu needs options', { code: 'COMPONENTS_INVALID' });
      return {
        type: 'row',
        components: [{
          type: 'select', custom_id: customId, options,
          placeholder: select.placeholder ? String(select.placeholder).slice(0, 100) : null,
          min_values: Math.max(0, Math.min(Number(select.min_values) || 1, options.length)),
          max_values: Math.max(1, Math.min(Number(select.max_values) || 1, options.length)),
          disabled: Boolean(select.disabled)
        }]
      };
    }

    if (children.length > APP_LIMITS.buttonsPerRow) {
      throw new ApiError(`At most ${APP_LIMITS.buttonsPerRow} buttons per row`, { code: 'COMPONENTS_INVALID' });
    }
    const buttons = children.map((b) => {
      const style = BUTTON_STYLES.has(b?.style) ? b.style : 'secondary';
      const label = String(b?.label ?? '').slice(0, 80);
      const emoji = b?.emoji ? String(b.emoji).slice(0, 64) : null;
      if (!label && !emoji) throw new ApiError('A button needs a label or an emoji', { code: 'COMPONENTS_INVALID' });
      if (style === 'link') {
        const url = String(b?.url ?? '');
        if (!/^https?:\/\//i.test(url)) throw new ApiError('A link button needs an http(s) url', { code: 'COMPONENTS_INVALID' });
        return { type: 'button', style, label, emoji, url: url.slice(0, 512), disabled: Boolean(b.disabled) };
      }
      const customId = String(b?.custom_id ?? '').slice(0, 100);
      if (!customId) throw new ApiError('A button needs a custom_id', { code: 'COMPONENTS_INVALID' });
      if (seen.has(customId)) throw new ApiError('custom_id must be unique in a message', { code: 'COMPONENTS_INVALID' });
      seen.add(customId);
      return { type: 'button', style, label, emoji, custom_id: customId, disabled: Boolean(b.disabled) };
    });
    return { type: 'row', components: buttons };
  });
}

// ---------------------------------------------------------------------------
// Rich embeds
// ---------------------------------------------------------------------------

const HEX = /^#?([0-9a-fA-F]{6})$/;
const safeUrl = (value) => (/^https?:\/\//i.test(String(value ?? '')) || String(value ?? '').startsWith('/')
  ? String(value).slice(0, 2048) : null);

/** Validate bot-supplied embeds. Untrusted input: every field is bounded. */
export function validateEmbeds(embeds) {
  const list = Array.isArray(embeds) ? embeds : [];
  if (list.length > APP_LIMITS.embedsPerMessage) {
    throw new ApiError(`At most ${APP_LIMITS.embedsPerMessage} embeds`, { code: 'EMBEDS_INVALID' });
  }
  return list.map((e) => {
    const colour = HEX.exec(String(e?.color ?? ''));
    return {
      type: 'rich',
      title: e?.title ? String(e.title).slice(0, 256) : null,
      description: e?.description ? String(e.description).slice(0, 4096) : null,
      url: safeUrl(e?.url),
      color: colour ? `#${colour[1].toLowerCase()}` : null,
      timestamp: e?.timestamp ? String(e.timestamp).slice(0, 40) : null,
      author: e?.author ? {
        name: String(e.author.name ?? '').slice(0, 256),
        url: safeUrl(e.author.url), icon_url: safeUrl(e.author.icon_url)
      } : null,
      footer: e?.footer ? {
        text: String(e.footer.text ?? '').slice(0, 2048), icon_url: safeUrl(e.footer.icon_url)
      } : null,
      image: e?.image?.url ? { url: safeUrl(e.image.url) } : null,
      thumbnail: e?.thumbnail?.url ? { url: safeUrl(e.thumbnail.url) } : null,
      fields: (Array.isArray(e?.fields) ? e.fields : []).slice(0, 25).map((f) => ({
        name: String(f?.name ?? '').slice(0, 256),
        value: String(f?.value ?? '').slice(0, 1024),
        inline: Boolean(f?.inline)
      })).filter((f) => f.name && f.value)
    };
  }).filter((e) => e.title || e.description || e.image || e.fields.length || e.author);
}

// ---------------------------------------------------------------------------
// Interactions
// ---------------------------------------------------------------------------

function shapeInteraction(row) {
  return {
    id: row.id, type: row.type, application_id: row.application_id,
    user_id: row.user_id, channel_id: row.channel_id, server_id: row.server_id,
    message_id: row.message_id ?? null, custom_id: row.custom_id ?? null,
    command_name: row.command_name ?? null, data: JSON.parse(row.data || '{}'),
    token: row.token, created_at: row.created_at,
    responded: Boolean(row.responded_at)
  };
}

/**
 * Someone pressed a button or picked from a select menu. Records the
 * interaction and returns it so the caller can hand it to the bot.
 */
export async function createComponentInteraction({ messageId, userId, customId, values = [] }) {
  const message = await getQuery(
    `SELECT id, channel_id, server_id, components, application_id, user_id AS author_id, ephemeral_user_id
       FROM messages WHERE id = ? AND deleted_at IS NULL`, [messageId]
  );
  if (!message) throw ApiError.notFound('Message');
  await assertChannelAccess({ channelId: message.channel_id, userId });
  if (message.ephemeral_user_id && message.ephemeral_user_id !== userId) throw ApiError.notFound('Message');

  const rows = JSON.parse(message.components || '[]');
  const component = rows.flatMap((r) => r.components ?? []).find((c) => c.custom_id === customId);
  if (!component) throw new ApiError('That component is not on this message', { code: 'COMPONENT_UNKNOWN' });
  if (component.disabled) throw new ApiError('That component is disabled', { code: 'COMPONENT_DISABLED' });

  // Only the bot that owns the message can be told about the press.
  const applicationId = message.application_id
    ?? (await getQuery(`SELECT id FROM applications WHERE bot_user_id = ? AND deleted_at IS NULL`, [message.author_id]))?.id;
  if (!applicationId) throw new ApiError('This message has no application behind it', { code: 'NO_APPLICATION' });

  let picked = [];
  if (component.type === 'select') {
    const allowed = new Set(component.options.map((o) => o.value));
    picked = [...new Set((Array.isArray(values) ? values : []).map(String))].filter((v) => allowed.has(v));
    if (picked.length < component.min_values || picked.length > component.max_values) {
      throw new ApiError('Wrong number of options selected', { code: 'SELECT_COUNT' });
    }
  }

  const id = generateId();
  const token = crypto.randomBytes(24).toString('base64url');
  await runQuery(
    `INSERT INTO interactions (id, application_id, type, user_id, channel_id, server_id, message_id, custom_id, data, token)
     VALUES (?, ?, 'component', ?, ?, ?, ?, ?, ?, ?)`,
    [id, applicationId, userId, message.channel_id, message.server_id, messageId, customId,
     JSON.stringify({ values: picked, component_type: component.type }), token]
  );
  return shapeInteraction(await getQuery(`SELECT * FROM interactions WHERE id = ?`, [id]));
}

/** Someone ran a bot's slash command. */
export async function createCommandInteraction({ channelId, userId, name, options = {}, target = null }) {
  const channel = await getQuery(
    `SELECT id, server_id FROM channels WHERE id = ? AND deleted_at IS NULL`, [channelId]
  );
  if (!channel) throw ApiError.notFound('Channel');
  await assertChannelAccess({ channelId, userId, permission: channel.server_id ? 'SEND_MESSAGES' : null });

  const commands = await commandsForChannel({ channelId, userId });
  // Slash names are lower-cased on registration; context-menu labels are not,
  // so a name matches either exactly or case-insensitively.
  const wanted = String(name);
  const command = commands.find((c) => c.name === wanted)
    ?? commands.find((c) => c.name === wanted.toLowerCase());
  if (!command) throw new ApiError(`No such command: /${name}`, { code: 'COMMAND_UNKNOWN' });

  // A context-menu command carries what was right-clicked instead of options.
  // The target is verified here rather than trusted: a message must be one the
  // caller can actually see, and a member must really be in this server.
  let resolvedTarget = null;
  if (command.type === 'message') {
    const message = await getQuery(
      `SELECT id, channel_id, user_id, content FROM messages WHERE id = ? AND deleted_at IS NULL`,
      [target?.message_id ?? null]
    );
    if (!message) throw ApiError.notFound('Message');
    await assertChannelAccess({ channelId: message.channel_id, userId, permission: 'READ_MESSAGE_HISTORY' });
    resolvedTarget = { type: 'message', message };
  } else if (command.type === 'user') {
    const member = await getQuery(
      `SELECT u.id, u.username, u.display_name FROM users u
         JOIN server_members sm ON sm.user_id = u.id AND sm.server_id = ? AND sm.left_at IS NULL
        WHERE u.id = ? AND u.deleted_at IS NULL`,
      [channel.server_id, target?.user_id ?? null]
    );
    if (!member) throw ApiError.notFound('Member');
    resolvedTarget = { type: 'user', user: member };
  }

  // Required options must be present; unknown ones are dropped rather than
  // forwarded, so a bot only ever sees what it declared.
  const clean = {};
  for (const option of command.options) {
    const value = options?.[option.name];
    if (value === undefined || value === null || value === '') {
      if (option.required) {
        throw new ApiError(`Missing option: ${option.name}`, { code: 'OPTION_REQUIRED', details: { option: option.name } });
      }
      continue;
    }
    clean[option.name] = option.type === 'integer' ? Number(value)
      : option.type === 'boolean' ? Boolean(value)
      : String(value).slice(0, 2000);
  }

  const id = generateId();
  const token = crypto.randomBytes(24).toString('base64url');
  await runQuery(
    `INSERT INTO interactions (id, application_id, type, user_id, channel_id, server_id, command_name, data, token)
     VALUES (?, ?, 'command', ?, ?, ?, ?, ?, ?)`,
    [id, command.application_id, userId, channelId, channel.server_id, command.name,
     JSON.stringify({ options: clean, target: resolvedTarget }), token]
  );
  return shapeInteraction(await getQuery(`SELECT * FROM interactions WHERE id = ?`, [id]));
}

/**
 * Look up an interaction a bot is about to answer. The token proves the bot
 * was actually handed this interaction, and it expires — a callback arriving
 * an hour later is refused rather than posting into a stale conversation.
 */
export async function claimInteraction({ interactionId, token, applicationId }) {
  const row = await getQuery(`SELECT * FROM interactions WHERE id = ?`, [interactionId]);
  if (!row || row.token !== String(token ?? '')) throw ApiError.notFound('Interaction');
  if (row.application_id !== applicationId) throw ApiError.forbidden('That interaction belongs to another application');
  if (Date.parse(row.created_at) + APP_LIMITS.interactionTtlMs < Date.now()) {
    throw new ApiError('This interaction has expired', { code: 'INTERACTION_EXPIRED' });
  }
  return shapeInteraction(row);
}

export async function markResponded(interactionId) {
  await runQuery(
    `UPDATE interactions SET responded_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`, [interactionId]
  );
}

/** Permission names an invite link may request, for the client's picker. */
export function invitablePermissions() {
  return toNames(String((1n << 41n) - 1n)).filter((name) => !NEVER_GRANT.includes(name));
}
