// A default avatar that costs no network request and cannot 404: Discord's
// blurple circle with a neutral figure, inlined as an SVG data URI.
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 80">
<circle cx="40" cy="40" r="40" fill="#5865f2"/>
<circle cx="40" cy="31" r="13" fill="#ffffff"/>
<path d="M16 72a24 24 0 0 1 48 0z" fill="#ffffff"/>
</svg>`;

export const DEFAULT_AVATAR = `data:image/svg+xml;utf8,${encodeURIComponent(SVG)}`;

/** Avatar for a user-ish object, falling back to the inline default. */
export function avatarOf(entity) {
  return entity?.avatar_url || entity?.member_avatar_url || DEFAULT_AVATAR;
}

// Placeholder icons the backend used to generate on a third-party service.
// Loading them leaks the server name to that service and breaks offline, and
// the initials tile we draw ourselves carries the same information.
const GENERATED_ICON_HOSTS = /^https?:\/\/api\.dicebear\.com\//i;

/** A server's own icon URL, or null when it has none worth loading. */
export function serverIconOf(server) {
  const url = server?.icon_url;
  if (!url || GENERATED_ICON_HOSTS.test(url)) return null;
  return url;
}

/** Discord's acronym for an icon-less guild: first letter of each word. */
export function serverInitials(name = '') {
  const words = String(name).trim().split(/\s+/).filter(Boolean);
  const letters = words.map((w) => Array.from(w)[0]).filter((c) => /[\p{L}\p{N}]/u.test(c));
  return (letters.slice(0, 3).join('') || '?').toUpperCase();
}
