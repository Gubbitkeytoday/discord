// ============================================================================
//  Webhooks — post into a channel with only a URL, no user account.
//
//  The token is the credential, so it is stored hashed and returned exactly once
//  at creation, the same way session tokens are handled.
// ============================================================================

import crypto from 'crypto';

import { runQuery, getQuery, allQuery } from '../db.js';
import { generateId } from '../lib/snowflake.js';
import { ApiError } from '../lib/httpUtils.js';
import { assertPermission, writeAuditLog } from './guilds.js';
import { createMessage } from './messages.js';

const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

export async function createWebhook({ channelId, actorId, name, avatarUrl = null }) {
  const channel = await getQuery(
    `SELECT id, server_id FROM channels WHERE id = ? AND deleted_at IS NULL`, [channelId]
  );
  if (!channel) throw ApiError.notFound('Channel');
  // Webhooks are a guild feature. A DM has no permission model to check
  // against, so allowing one there would mean allowing anyone with the channel
  // id to mint a token that posts into someone else's conversation.
  if (!channel.server_id) {
    throw ApiError.forbidden('Webhooks can only be created in a server channel');
  }
  await assertPermission({
    userId: actorId, serverId: channel.server_id, permission: 'MANAGE_WEBHOOKS'
  });

  const id = generateId();
  const token = crypto.randomBytes(32).toString('base64url');

  await runQuery(
    `INSERT INTO webhooks (id, channel_id, server_id, name, avatar_url, token_hash, creator_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, channelId, channel.server_id, String(name ?? 'Webhook').slice(0, 80),
     avatarUrl, hashToken(token), actorId]
  );
  await writeAuditLog({
    serverId: channel.server_id, userId: actorId, actionType: 'WEBHOOK_CREATE',
    targetType: 'webhook', targetId: id, changes: [{ key: 'name', new: name }]
  });

  const webhook = await getQuery(`SELECT * FROM webhooks WHERE id = ?`, [id]);
  return {
    ...strip(webhook),
    token,
    // Full URL, so the caller can copy it straight into another service.
    url: `/api/webhooks/${id}/${token}`
  };
}

function strip(row) {
  if (!row) return null;
  const { token_hash: _ignored, ...rest } = row;
  return rest;
}

export async function listWebhooks({ serverId = null, channelId = null }) {
  const rows = channelId
    ? await allQuery(
        `SELECT w.*, c.name AS channel_name FROM webhooks w
           LEFT JOIN channels c ON c.id = w.channel_id
          WHERE w.channel_id = ? AND w.revoked_at IS NULL`, [channelId])
    : await allQuery(
        `SELECT w.*, c.name AS channel_name FROM webhooks w
           LEFT JOIN channels c ON c.id = w.channel_id
          WHERE w.server_id = ? AND w.revoked_at IS NULL
          ORDER BY w.created_at DESC`, [serverId]);
  return rows.map(strip);
}

export async function deleteWebhook({ webhookId, actorId }) {
  const webhook = await getQuery(`SELECT * FROM webhooks WHERE id = ?`, [webhookId]);
  if (!webhook) throw ApiError.notFound('Webhook');
  // Every webhook belongs to a guild channel (see createWebhook); a row without
  // a server is corrupt data, not a permission-free deletion.
  if (!webhook.server_id) throw ApiError.forbidden('This webhook has no server');
  await assertPermission({
    userId: actorId, serverId: webhook.server_id, permission: 'MANAGE_WEBHOOKS'
  });
  await runQuery(
    `UPDATE webhooks SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
    [webhookId]
  );
  await writeAuditLog({
    serverId: webhook.server_id, userId: actorId, actionType: 'WEBHOOK_DELETE',
    targetType: 'webhook', targetId: webhookId
  });
  return { success: true };
}

/**
 * Execute a webhook. Authentication is the token in the URL alone — there is no
 * session — so the token is compared in constant time and a revoked webhook is
 * indistinguishable from a wrong token.
 */
export async function executeWebhook({ webhookId, token, content, username = null, avatarUrl = null }) {
  const webhook = await getQuery(
    `SELECT * FROM webhooks WHERE id = ? AND revoked_at IS NULL`, [webhookId]
  );

  const provided = Buffer.from(hashToken(String(token ?? '')));
  const expected = Buffer.from(webhook?.token_hash ?? hashToken('nope'));
  const ok = webhook
    && provided.length === expected.length
    && crypto.timingSafeEqual(provided, expected);
  if (!ok) throw new ApiError('Webhook token ไม่ถูกต้อง', { status: 401, code: 'INVALID_TOKEN' });

  const body = String(content ?? '').trim();
  if (!body) throw new ApiError('content ว่างเปล่า', { code: 'EMPTY_MESSAGE' });

  // Webhooks post as the webhook's creator so foreign keys and the UI have a
  // real author, with the webhook recorded on the row.
  const message = await createMessage({
    channelId: webhook.channel_id,
    userId: webhook.creator_id,
    content: body,
    // AutoMod and slowmode are for humans; a webhook has no member record.
    skipModeration: true
  });

  await runQuery(`UPDATE messages SET webhook_id = ? WHERE id = ?`, [webhook.id, message.id]);

  return {
    ...message,
    webhook_id: webhook.id,
    // Presentation overrides, as Discord allows per-execution.
    display_name: username || webhook.name,
    avatar_url: avatarUrl || webhook.avatar_url || message.avatar_url,
    is_webhook: true
  };
}
