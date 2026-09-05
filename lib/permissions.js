// Discord-style permission bitfield.
//
// Permissions are stored as decimal strings (BigInt-safe) so they survive JSON
// and SQLite without precision loss.

export const PERMISSIONS = {
  CREATE_INSTANT_INVITE: 1n << 0n,
  KICK_MEMBERS:          1n << 1n,
  BAN_MEMBERS:           1n << 2n,
  ADMINISTRATOR:         1n << 3n,
  MANAGE_CHANNELS:       1n << 4n,
  MANAGE_GUILD:          1n << 5n,
  ADD_REACTIONS:         1n << 6n,
  VIEW_AUDIT_LOG:        1n << 7n,
  PRIORITY_SPEAKER:      1n << 8n,
  STREAM:                1n << 9n,
  VIEW_CHANNEL:          1n << 10n,
  SEND_MESSAGES:         1n << 11n,
  SEND_TTS_MESSAGES:     1n << 12n,
  MANAGE_MESSAGES:       1n << 13n,
  EMBED_LINKS:           1n << 14n,
  ATTACH_FILES:          1n << 15n,
  READ_MESSAGE_HISTORY:  1n << 16n,
  MENTION_EVERYONE:      1n << 17n,
  USE_EXTERNAL_EMOJIS:   1n << 18n,
  VIEW_GUILD_INSIGHTS:   1n << 19n,
  CONNECT:               1n << 20n,
  SPEAK:                 1n << 21n,
  MUTE_MEMBERS:          1n << 22n,
  DEAFEN_MEMBERS:        1n << 23n,
  MOVE_MEMBERS:          1n << 24n,
  USE_VAD:               1n << 25n,
  CHANGE_NICKNAME:       1n << 26n,
  MANAGE_NICKNAMES:      1n << 27n,
  MANAGE_ROLES:          1n << 28n,
  MANAGE_WEBHOOKS:       1n << 29n,
  MANAGE_EMOJIS:         1n << 30n,
  MANAGE_THREADS:        1n << 34n,
  CREATE_PUBLIC_THREADS: 1n << 35n,
  CREATE_PRIVATE_THREADS:1n << 36n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n,
  MODERATE_MEMBERS:      1n << 40n
};

/** Sensible @everyone default: talk, read history, react, attach, join voice. */
export const DEFAULT_PERMISSIONS = [
  'VIEW_CHANNEL', 'SEND_MESSAGES', 'READ_MESSAGE_HISTORY', 'ADD_REACTIONS',
  'ATTACH_FILES', 'EMBED_LINKS', 'USE_EXTERNAL_EMOJIS', 'CONNECT', 'SPEAK',
  'USE_VAD', 'STREAM', 'CHANGE_NICKNAME', 'CREATE_INSTANT_INVITE',
  'CREATE_PUBLIC_THREADS', 'SEND_MESSAGES_IN_THREADS'
].reduce((acc, name) => acc | PERMISSIONS[name], 0n).toString();

export const ALL_PERMISSIONS = Object.values(PERMISSIONS)
  .reduce((acc, bit) => acc | bit, 0n).toString();

export function toBigInt(value) {
  if (typeof value === 'bigint') return value;
  if (value === null || value === undefined || value === '') return 0n;
  try { return BigInt(value); } catch { return 0n; }
}

export function has(bitfield, permission) {
  const bits = toBigInt(bitfield);
  const flag = typeof permission === 'string' ? PERMISSIONS[permission] : permission;
  if (!flag) return false;
  if ((bits & PERMISSIONS.ADMINISTRATOR) === PERMISSIONS.ADMINISTRATOR) return true;
  return (bits & flag) === flag;
}

export function combine(...bitfields) {
  return bitfields.reduce((acc, b) => acc | toBigInt(b), 0n).toString();
}

/** Human-readable list of the permissions set in a bitfield. */
export function toNames(bitfield) {
  const bits = toBigInt(bitfield);
  return Object.entries(PERMISSIONS)
    .filter(([, flag]) => (bits & flag) === flag)
    .map(([name]) => name);
}

export function fromNames(names = []) {
  return names.reduce((acc, n) => acc | (PERMISSIONS[n] ?? 0n), 0n).toString();
}

/**
 * Base guild permissions for a member: @everyone role plus every assigned role.
 * Guild owner always gets ADMINISTRATOR.
 */
export function computeBasePermissions({ isOwner, rolePermissions = [] }) {
  if (isOwner) return ALL_PERMISSIONS;
  const bits = rolePermissions.reduce((acc, p) => acc | toBigInt(p), 0n);
  if ((bits & PERMISSIONS.ADMINISTRATOR) === PERMISSIONS.ADMINISTRATOR) {
    return ALL_PERMISSIONS;
  }
  return bits.toString();
}

/**
 * Apply channel overwrites on top of base permissions, in Discord's order:
 * @everyone deny/allow → union of role denies/allows → member deny/allow.
 *
 * @param base           base guild permission bitfield
 * @param overwrites     rows of { target_type, target_id, allow, deny }
 * @param everyoneRoleId id of the guild's @everyone role
 * @param memberRoleIds  role ids held by the member
 * @param userId         the member's user id
 */
export function computeChannelPermissions({
  base, overwrites = [], everyoneRoleId, memberRoleIds = [], userId
}) {
  let permissions = toBigInt(base);
  if ((permissions & PERMISSIONS.ADMINISTRATOR) === PERMISSIONS.ADMINISTRATOR) {
    return ALL_PERMISSIONS;
  }

  const everyone = overwrites.find(
    (o) => o.target_type === 'role' && o.target_id === everyoneRoleId
  );
  if (everyone) {
    permissions &= ~toBigInt(everyone.deny);
    permissions |= toBigInt(everyone.allow);
  }

  const roleSet = new Set(memberRoleIds);
  let allow = 0n;
  let deny = 0n;
  for (const o of overwrites) {
    if (o.target_type !== 'role' || o.target_id === everyoneRoleId) continue;
    if (!roleSet.has(o.target_id)) continue;
    allow |= toBigInt(o.allow);
    deny |= toBigInt(o.deny);
  }
  permissions &= ~deny;
  permissions |= allow;

  const member = overwrites.find(
    (o) => o.target_type === 'member' && o.target_id === userId
  );
  if (member) {
    permissions &= ~toBigInt(member.deny);
    permissions |= toBigInt(member.allow);
  }

  return permissions.toString();
}

/**
 * What a timed-out member keeps. Discord leaves a member in timeout able to
 * read, and nothing else — no sending, reacting, joining voice or speaking.
 * ADMINISTRATOR is exempt, matching Discord.
 */
export const TIMEOUT_ALLOWED = ['VIEW_CHANNEL', 'READ_MESSAGE_HISTORY'];

export function applyTimeout(permissions) {
  const bits = toBigInt(permissions);
  if ((bits & PERMISSIONS.ADMINISTRATOR) === PERMISSIONS.ADMINISTRATOR) return bits.toString();
  const keep = TIMEOUT_ALLOWED.reduce((acc, name) => acc | PERMISSIONS[name], 0n);
  return (bits & keep).toString();
}

/** Is this ISO timestamp in the future? Parsed, not string-compared. */
export function isActiveTimeout(untilIso) {
  if (!untilIso) return false;
  const until = Date.parse(untilIso);
  return Number.isFinite(until) && until > Date.now();
}
