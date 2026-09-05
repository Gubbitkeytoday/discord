// Client-side mirror of lib/permissions.js, grouped for the role editor. The bit
// values are authoritative on the server; this file only decides how they are
// presented. Names and descriptions live in the dictionaries under
// `perm.<NAME>` / `perm.<NAME>.hint`, so this module stays language-neutral.

import { t } from '../i18n/index.jsx';

export const PERMISSION_BITS = {
  CREATE_INSTANT_INVITE: 0,
  KICK_MEMBERS: 1,
  BAN_MEMBERS: 2,
  ADMINISTRATOR: 3,
  MANAGE_CHANNELS: 4,
  MANAGE_GUILD: 5,
  ADD_REACTIONS: 6,
  VIEW_AUDIT_LOG: 7,
  PRIORITY_SPEAKER: 8,
  STREAM: 9,
  VIEW_CHANNEL: 10,
  SEND_MESSAGES: 11,
  SEND_TTS_MESSAGES: 12,
  MANAGE_MESSAGES: 13,
  EMBED_LINKS: 14,
  ATTACH_FILES: 15,
  READ_MESSAGE_HISTORY: 16,
  MENTION_EVERYONE: 17,
  USE_EXTERNAL_EMOJIS: 18,
  VIEW_GUILD_INSIGHTS: 19,
  CONNECT: 20,
  SPEAK: 21,
  MUTE_MEMBERS: 22,
  DEAFEN_MEMBERS: 23,
  MOVE_MEMBERS: 24,
  USE_VAD: 25,
  CHANGE_NICKNAME: 26,
  MANAGE_NICKNAMES: 27,
  MANAGE_ROLES: 28,
  MANAGE_WEBHOOKS: 29,
  MANAGE_EMOJIS: 30,
  MANAGE_THREADS: 34,
  CREATE_PUBLIC_THREADS: 35,
  CREATE_PRIVATE_THREADS: 36,
  SEND_MESSAGES_IN_THREADS: 38,
  MODERATE_MEMBERS: 40
};

/**
 * Grouped exactly as Discord's role editor groups them, by permission name only.
 */
export const PERMISSION_GROUP_KEYS = [
  {
    key: 'general',
    items: [
      'VIEW_CHANNEL', 'MANAGE_CHANNELS', 'MANAGE_ROLES', 'MANAGE_EMOJIS',
      'VIEW_AUDIT_LOG', 'MANAGE_WEBHOOKS', 'MANAGE_GUILD', 'VIEW_GUILD_INSIGHTS'
    ]
  },
  {
    key: 'membership',
    items: [
      'CREATE_INSTANT_INVITE', 'CHANGE_NICKNAME', 'MANAGE_NICKNAMES',
      'KICK_MEMBERS', 'BAN_MEMBERS', 'MODERATE_MEMBERS'
    ]
  },
  {
    key: 'messages',
    items: [
      'SEND_MESSAGES', 'SEND_MESSAGES_IN_THREADS', 'CREATE_PUBLIC_THREADS',
      'CREATE_PRIVATE_THREADS', 'MANAGE_THREADS', 'EMBED_LINKS', 'ATTACH_FILES',
      'ADD_REACTIONS', 'USE_EXTERNAL_EMOJIS', 'MENTION_EVERYONE',
      'MANAGE_MESSAGES', 'READ_MESSAGE_HISTORY', 'SEND_TTS_MESSAGES'
    ]
  },
  {
    key: 'voice',
    items: [
      'CONNECT', 'SPEAK', 'STREAM', 'USE_VAD', 'PRIORITY_SPEAKER',
      'MUTE_MEMBERS', 'DEAFEN_MEMBERS', 'MOVE_MEMBERS'
    ]
  }
];

/**
 * Translated view of the catalogue. Called during render rather than built once
 * at module load, so switching language updates the role editor.
 */
export function permissionGroups() {
  return PERMISSION_GROUP_KEYS.map((group) => ({
    key: group.key,
    title: t(`permGroup.${group.key}`),
    items: group.items.map((name) => [name, t(`perm.${name}`), t(`perm.${name}.hint`)])
  }));
}

/** All permissions, for the dangerous ADMINISTRATOR shortcut. */
export const ADMIN_BIT = PERMISSION_BITS.ADMINISTRATOR;

/** The 64-bit mask for one permission, as the decimal string overwrites use. */
export function maskOf(name) {
  const bit = PERMISSION_BITS[name];
  if (bit === undefined) return '0';
  return (1n << BigInt(bit)).toString();
}

export function hasBit(permissions, name) {
  const bit = PERMISSION_BITS[name];
  if (bit === undefined) return false;
  try {
    return (BigInt(permissions || '0') & (1n << BigInt(bit))) !== 0n;
  } catch {
    return false;
  }
}

export function toggleBit(permissions, name) {
  const bit = PERMISSION_BITS[name];
  if (bit === undefined) return String(permissions);
  const current = BigInt(permissions || '0');
  const mask = 1n << BigInt(bit);
  return ((current & mask) !== 0n ? current & ~mask : current | mask).toString();
}

/** Count of enabled permissions, shown next to each role. */
export function countPermissions(permissions) {
  let bits = 0n;
  try { bits = BigInt(permissions || '0'); } catch { return 0; }
  let count = 0;
  for (const bit of Object.values(PERMISSION_BITS)) {
    if ((bits & (1n << BigInt(bit))) !== 0n) count += 1;
  }
  return count;
}

export const ROLE_COLOR_PRESETS = [
  '#1abc9c', '#2ecc71', '#3498db', '#9b59b6', '#e91e63', '#f1c40f',
  '#e67e22', '#e74c3c', '#95a5a6', '#607d8b', '#11806a', '#1f8b4c',
  '#206694', '#71368a', '#ad1457', '#c27c0e', '#a84300', '#992d22',
  '#979c9f', '#546e7a', '#5865f2', '#faa61a', '#f04747', '#43b581'
];
