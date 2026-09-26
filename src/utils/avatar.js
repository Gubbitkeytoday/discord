import { proxiedImageUrl } from './media';

// A default avatar that costs no network request and cannot 404: Discord's
// blurple circle with a neutral figure, inlined as an SVG data URI.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80">
<circle cx="40" cy="40" r="40" fill="#5865f2"/>
<circle cx="40" cy="31" r="13" fill="#ffffff"/>
<path d="M16 72a24 24 0 0 1 48 0z" fill="#ffffff"/>
</svg>`;

export const DEFAULT_AVATAR = `data:image/svg+xml;utf8,${encodeURIComponent(SVG)}`;

// Discord gives avatar-less users one of a handful of colours, derived from
// the account, so two people without a picture are still told apart.
const PALETTE = ['#5865f2', '#757e8a', '#3ba55c', '#faa61a', '#ed4245', '#eb459f'];
const coloured = new Map();

/** The default avatar in this user's colour (stable per id). */
export function defaultAvatar(seed) {
  if (seed === undefined || seed === null || seed === '') return DEFAULT_AVATAR;
  const key = String(seed);
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  const colour = PALETTE[hash % PALETTE.length];
  if (!coloured.has(colour)) {
    coloured.set(colour, `data:image/svg+xml;utf8,${encodeURIComponent(SVG.replace('#5865f2', colour))}`);
  }
  return coloured.get(colour);
}

/** Avatar for a user-ish object, falling back to its coloured default. */
export function avatarOf(entity) {
  const own = entity?.avatar_url || entity?.member_avatar_url;
  return (own && proxiedImageUrl(own))
    || defaultAvatar(entity?.user_id ?? entity?.userId ?? entity?.id);
}

// Placeholder icons the backend used to generate on a third-party service.
// Loading them leaks the server name to that service and breaks offline, and
// the initials tile we draw ourselves carries the same information.
const GENERATED_ICON_HOSTS = /^https?:\/\/api\.dicebear\.com\//i;

/** A server's own icon URL, or null when it has none worth loading. */
export function serverIconOf(server) {
  const url = server?.icon_url;
  if (!url || GENERATED_ICON_HOSTS.test(url)) return null;
  // The backend may already hand us the proxied form of a generated icon.
  if (url.startsWith('/api/media/proxy?url=')) {
    try {
      if (GENERATED_ICON_HOSTS.test(decodeURIComponent(url.slice('/api/media/proxy?url='.length)))) return null;
    } catch { /* malformed: fall through and let onError handle it */ }
  }
  return proxiedImageUrl(url);
}

/** Discord's acronym for an icon-less guild: first letter of each word. */
export function serverInitials(name = '') {
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  const letters = words.map((w) => Array.from(w)[0]).filter((c) => /[\p{L}\p{N}]/u.test(c));
  return (letters.slice(0, 3).join('') || '?').toUpperCase();
}
