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
