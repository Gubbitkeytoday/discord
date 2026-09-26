// ============================================================================
//  Moderator alerts — the message a moderator actually sees when AutoMod
//  catches something or a join flood arrives.
//
//  The alert is an ordinary message (with an embed) posted into the server's
//  alert channel, so it is persisted, searchable and shows up for anyone who
//  can read that channel — Discord's "Send alert to channel" behaves the same.
//
//  Services have no Socket.IO handle, so every alert is also announced on
//  `modAlertEvents` ('message', message). The HTTP layer subscribes once and
//  fans the message out live:
//
//    modAlertEvents.on('message', (m) => fanOutMessage(io, m));
//
//  Without that subscription the alert still lands; it appears on the next
//  load of the channel.
// ============================================================================

import { EventEmitter } from 'events';
import { getQuery } from '../../db.js';

export const modAlertEvents = new EventEmitter();
modAlertEvents.setMaxListeners(20);

/**
 * Where alerts for a server go: an explicit channel, else the server's
 * configured alert channel, else its system channel. Only a live text-ish
 * channel of this server qualifies.
 */
export async function resolveAlertChannel(serverId, preferred = null) {
  const server = await getQuery(
    `SELECT system_channel_id, mod_alert_channel_id FROM servers WHERE id = ? AND deleted_at IS NULL`,
    [serverId]
  ).catch(() => null);
  for (const id of [preferred, server?.mod_alert_channel_id, server?.system_channel_id]) {
    if (!id) continue;
    const channel = await getQuery(
      `SELECT id FROM channels
        WHERE id = ? AND server_id = ? AND deleted_at IS NULL
          AND type IN ('text', 'announcement')`,
      [id, serverId]
    );
    if (channel) return channel.id;
  }
  return null;
}

const clip = (s, n) => {
  const text = String(s ?? '');
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
};

/**
 * Post an alert. Never throws: an alert that cannot be delivered must not
 * turn a moderated message (or a join) into a 500.
 *
 * @returns {Promise<object|null>} the created message, or null
 */
export async function postModAlert({ serverId, channelId = null, title, description, fields = [], color = '#ed4245' }) {
  try {
    const target = await resolveAlertChannel(serverId, channelId);
    if (!target) return null;
    const { createMessage } = await import('../messages.js');
    const message = await createMessage({
      channelId: target,
      userId: null,
      type: 'system',
      skipModeration: true,
      content: clip(`🛡️ ${title}`, 300),
      embeds: [{
        title: clip(title, 256),
        description: clip(description, 2000),
        color,
        fields: fields
          .filter((f) => f && f.value !== undefined && f.value !== null && String(f.value) !== '')
          .slice(0, 10)
          .map((f) => ({ name: clip(f.name, 256), value: clip(f.value, 1024), inline: Boolean(f.inline) })),
        timestamp: new Date().toISOString()
      }]
    });
    modAlertEvents.emit('message', message);
    return message;
  } catch (err) {
    console.error('moderator alert failed', err?.message ?? err);
    return null;
  }
}

/** Display name for a user id, for alert text (never a ping). */
export async function nameOf(userId) {
  if (!userId) return '';
  const row = await getQuery(`SELECT username, display_name FROM users WHERE id = ?`, [userId]).catch(() => null);
  return row ? (row.display_name || row.username) : String(userId);
}
