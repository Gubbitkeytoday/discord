// ============================================================================
//  Audit log wording.
//
//  The server stores each entry's action as a key (WEBHOOK_CREATE) and its
//  changes as raw column values ({ key: 'icon_url', new: '/uploads/…' }).
//  Neither is for people: this module turns them into translated labels and
//  short, readable values — and never shows a storage path, a URL or JSON.
//
//  Pure (the caller passes `t`), so it is testable from Node.
// ============================================================================

/** Translation key for every action type the server writes. */
export const AUDIT_ACTION_KEYS = {
  SERVER_CREATE: 'audit.SERVER_CREATE',
  SERVER_UPDATE: 'audit.SERVER_UPDATE',
  SERVER_OWNER_TRANSFER: 'audit.SERVER_OWNER_TRANSFER',
  SERVER_COSMETICS_UPDATE: 'audit.SERVER_COSMETICS_UPDATE',
  SERVER_TAG_UPDATE: 'audit.SERVER_TAG_UPDATE',
  SERVER_TAG_DELETE: 'audit.SERVER_TAG_DELETE',
  CHANNEL_CREATE: 'adm.audit.CHANNEL_CREATE',
  CHANNEL_UPDATE: 'audit.CHANNEL_UPDATE',
  CHANNEL_DELETE: 'audit.CHANNEL_DELETE',
  CHANNEL_OVERWRITE_UPDATE: 'adm.audit.CHANNEL_OVERWRITE_UPDATE',
  CHANNEL_OVERWRITE_DELETE: 'adm.audit.CHANNEL_OVERWRITE_DELETE',
  ROLE_CREATE: 'audit.ROLE_CREATE',
  ROLE_UPDATE: 'audit.ROLE_UPDATE',
  ROLE_DELETE: 'audit.ROLE_DELETE',
  MEMBER_ROLE_UPDATE: 'audit.MEMBER_ROLE_UPDATE',
  MEMBER_KICK: 'audit.MEMBER_KICK',
  MEMBER_BAN_ADD: 'audit.MEMBER_BAN_ADD',
  MEMBER_BAN_REMOVE: 'audit.MEMBER_BAN_REMOVE',
  MEMBER_TIMEOUT: 'audit.MEMBER_TIMEOUT',
  MEMBER_UPDATE: 'audit.MEMBER_UPDATE',
  MEMBER_MOVE: 'adm.audit.MEMBER_MOVE',
  MEMBER_DISCONNECT: 'adm.audit.MEMBER_DISCONNECT',
  MEMBER_PROFILE_RESET: 'audit.MEMBER_PROFILE_RESET',
  EMOJI_CREATE: 'audit.EMOJI_CREATE',
  EMOJI_DELETE: 'audit.EMOJI_DELETE',
  STICKER_CREATE: 'adm.audit.STICKER_CREATE',
  STICKER_DELETE: 'adm.audit.STICKER_DELETE',
  INVITE_DELETE: 'audit.INVITE_DELETE',
  WEBHOOK_CREATE: 'audit.WEBHOOK_CREATE',
  WEBHOOK_DELETE: 'audit.WEBHOOK_DELETE',
  BOT_ADD: 'audit.BOT_ADD',
  BOT_REMOVE: 'audit.BOT_REMOVE',
  BADGE_CREATE: 'audit.BADGE_CREATE',
  BADGE_DELETE: 'audit.BADGE_DELETE',
  BADGE_GRANT: 'audit.BADGE_GRANT',
  BADGE_REVOKE: 'audit.BADGE_REVOKE',
  TEMPLATE_CREATE: 'adm.audit.TEMPLATE_CREATE',
  LOCKDOWN_START: 'adm.audit.LOCKDOWN_START',
  LOCKDOWN_LIFT: 'adm.audit.LOCKDOWN_LIFT',
  AUTOMOD_BLOCK: 'adm.audit.AUTOMOD_BLOCK',
  AUTOMOD_ALERT: 'adm.audit.AUTOMOD_ALERT',
  RAID_DETECTED: 'adm.audit.RAID_DETECTED'
};

/** The label for an action; an unknown (newer server) type never shows its key. */
export function auditActionLabel(type, t) {
  const key = AUDIT_ACTION_KEYS[type];
  return key ? t(key) : t('audit.other');
}

/** Change keys (column names) → label keys. */
const FIELD_KEYS = {
  name: 'common.name',
  description: 'settings.description',
  topic: 'audit.field.topic',
  icon: 'audit.field.icon',
  icon_url: 'audit.field.icon',
  icon_emoji: 'audit.field.icon',
  banner: 'audit.field.banner',
  banner_url: 'audit.field.banner',
  splash: 'audit.field.splash',
  splash_url: 'audit.field.splash',
  nsfw: 'audit.field.nsfw',
  rate_limit_per_user: 'audit.field.slowmode',
  slowmode: 'audit.field.slowmode',
  permissions: 'audit.field.permissions',
  color: 'audit.field.color',
  color_secondary: 'audit.field.color',
  nickname: 'audit.field.nickname',
  nick: 'audit.field.nickname',
  channel: 'audit.field.channel',
  channel_id: 'audit.field.channel',
  template: 'audit.field.template',
  timeout_until: 'audit.field.timeout',
  $add: 'audit.field.roleAdded',
  $remove: 'audit.field.roleRemoved',
  position: 'audit.field.position',
  parent_id: 'audit.field.category',
  tag: 'audit.field.tag',
  mute: 'audit.field.mute',
  deaf: 'audit.field.deaf',
  vanity_url: 'settings.vanityUrl',
  vanity_url_code: 'settings.vanityUrl',
  afk_channel_id: 'settings.afkChannel',
  system_channel_id: 'settings.systemChannel',
  rules_channel_id: 'settings.rulesChannel',
  accent_color: 'srv.accentColour',
  traits: 'srv.traits',
  discovery_category: 'srv.discoveryCategory',
  features: 'srv.listInDiscover',
  discoverable: 'srv.listInDiscover',
  verification_level: 'settings.verificationLevel',
  default_message_notifications: 'settings.defaultNotifications'
};

const BOOLEAN_FIELDS = new Set(['nsfw', 'mute', 'deaf', 'enabled', 'hoist', 'mentionable', 'tag_hidden', 'cosmetics_hidden', 'discoverable']);
const CHANNEL_FIELDS = new Set(['channel_id', 'parent_id', 'afk_channel_id', 'system_channel_id', 'rules_channel_id']);

/** "rules_channel_id" → "Rules channel" for keys nobody has named yet. */
function humanizeKey(key) {
  const words = String(key).replace(/^\$/, '').replace(/_(id|url)$/, '').split('_').filter(Boolean);
  if (!words.length) return String(key);
  const text = words.join(' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Paths, URLs, data URIs, file ids: never shown, only "updated". */
function isOpaque(value) {
  const text = String(value);
  return /^(\/uploads\/|\/api\/|https?:\/\/|data:|blob:)/i.test(text) || /\.(png|jpe?g|gif|webp|avif|svg|mp3|ogg|wav)(\?|#|$)/i.test(text);
}

function looksLikeJson(value) {
  if (typeof value === 'object' && value !== null) return true;
  const text = String(value).trim();
  if (!/^[[{]/.test(text)) return false;
  try { JSON.parse(text); return true; } catch { return false; }
}

/**
 * One value for display. Returns null when there is nothing worth showing
 * (the label + "updated" says it all).
 */
function formatValue(key, value, { t, resolveChannel, resolveRole, formatDate }) {
  if (value === undefined || value === null || value === '') return t('common.none');
  if (key === '$add' || key === '$remove') {
    const role = resolveRole?.(String(value));
    if (role) return `@${typeof role === 'object' ? role.name : role}`;
    return /^[\w-]*\d{6,}$/.test(String(value)) ? null : `@${value}`;
  }
  if (BOOLEAN_FIELDS.has(key) || typeof value === 'boolean') {
    const on = value === true || value === 1 || value === '1' || value === 'true';
    return on ? t('voice.stateOn') : t('voice.stateOff');
  }
  if (CHANNEL_FIELDS.has(key)) {
    const name = resolveChannel?.(String(value));
    return name ? `#${name}` : null;
  }
  if (key === 'timeout_until' && formatDate) {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return formatDate(date);
  }
  if (key === 'rate_limit_per_user' || key === 'slowmode') {
    const seconds = Number(value);
    if (Number.isFinite(seconds)) return seconds === 0 ? t('voice.stateOff') : `${seconds}s`;
  }
  if (/_file_id$|_url$/.test(key) || isOpaque(value) || looksLikeJson(value)) return null;
  const text = String(value);
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

/**
 * A change as { label, from, to } for the audit list — or { label, updated }
 * when the values are not fit to print (images, paths, JSON blobs).
 * Returns null for bookkeeping columns nobody needs to see.
 */
export function formatAuditChange(change, { t, resolveChannel, resolveRole, formatDate } = {}) {
  if (!change || typeof change !== 'object' || !change.key) return null;
  const key = String(change.key);
  if (/_file_id$|_animated$|^updated_at$|^id$/.test(key)) return null;
  const label = FIELD_KEYS[key] ? t(FIELD_KEYS[key]) : humanizeKey(key);
  const ctx = { t, resolveChannel, resolveRole, formatDate };
  const to = formatValue(key, change.new, ctx);
  const hasOld = change.old !== undefined && change.old !== null && change.old !== '';
  const from = hasOld ? formatValue(key, change.old, ctx) : null;
  if (to === null || (hasOld && from === null)) return { label, updated: t('audit.valueUpdated') };
  if (hasOld && from === to) return null;
  return { label, from, to };
}
