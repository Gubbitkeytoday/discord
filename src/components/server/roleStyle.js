// ============================================================================
//  Role name styles — one definition for every place a name is tinted.
//
//  A role is 'solid' (one colour), 'gradient' (two colours + an angle) or
//  'holographic' (an iridescent shimmer that slowly moves). Every colour stop
//  goes through readableRoleColor(), so a gradient can never dip below 4.5:1
//  against the surface it sits on — the same guard a solid name gets.
//
//  Motion, Accessibility › Role Colors (names / dots / off), saturation and
//  forced-colours mode are handled by server.css on top of the classes here.
// ============================================================================

import { parseHex, toHex, readableRoleColor, themeBackground, contrastRatio } from '../../utils/color';

export const ROLE_STYLES = ['solid', 'gradient', 'holographic'];
export const DEFAULT_ROLE_COLOR = '#99aab5';

/** The surface token a name sits on: chat canvas or a sidebar/list. */
export const SURFACES = { chat: '--color-bg-chat', sidebar: '--color-d-surface', floating: '--color-d-sunken' };

function hueShift(hex, degrees) {
  const rgb = parseHex(hex);
  if (!rgb) return hex;
  const [r, g, b] = rgb.map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  h = (h + degrees / 360 + 1) % 1;
  // Holographic stops are pastel: keep them saturated but light.
  s = Math.max(s, 0.55);
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return toHex([f(h + 1 / 3) * 255, f(h) * 255, f(h - 1 / 3) * 255]);
}

/** The effective style of a role row, tolerant of old rows and partial data. */
export function styleOf(role) {
  if (!role) return 'solid';
  if (ROLE_STYLES.includes(role.style) && role.style !== 'solid') return role.style;
  return role.color_secondary ? 'gradient' : 'solid';
}

/** The raw colour stops for a role (not yet contrast-guarded). */
export function roleStops(role) {
  const primary = role?.color && !/^#?0{6}$/.test(role.color) ? role.color : null;
  if (!primary) return [];
  const style = styleOf(role);
  if (style === 'gradient' && role.color_secondary) return [primary, role.color_secondary];
  if (style === 'holographic') {
    const second = role.color_secondary || hueShift(primary, 70);
    return [primary, second, hueShift(primary, -60), primary];
  }
  return [primary];
}

/**
 * Inline style + class for a role-coloured name. `surface` picks the
 * background the contrast guard measures against. Returns an empty style for
 * a role without a colour (callers fall back to the normal text colour).
 */
// role object -> Map("surface|background" -> result). A busy chat renders
// the same few roles hundreds of times; the contrast maths runs once each.
const styleCache = new WeakMap();

export function roleNameStyle(role, { surface = 'chat', background } = {}) {
  const bg = background ?? (role ? themeBackground(SURFACES[surface] ?? surface) : null);
  if (!role || typeof role !== 'object') return computeRoleNameStyle(role, bg);
  let byKey = styleCache.get(role);
  if (!byKey) { byKey = new Map(); styleCache.set(role, byKey); }
  const key = `${surface}|${bg}`;
  if (!byKey.has(key)) byKey.set(key, computeRoleNameStyle(role, bg));
  return byKey.get(key);
}

function computeRoleNameStyle(role, bg) {
  const stops = roleStops(role);
  if (!stops.length) return { className: '', style: {}, colour: null };
  const readable = stops.map((c) => readableRoleColor(c, bg) ?? c);
  const style = styleOf(role);
  if (readable.length === 1) {
    return { className: 'role-colored', style: { color: readable[0] }, colour: readable[0] };
  }
  const angle = Number.isFinite(Number(role.gradient_angle)) ? Number(role.gradient_angle) : 90;
  return {
    className: `role-colored role-name-styled ${style === 'holographic' ? 'role-name-holo' : 'role-name-gradient'}`,
    style: {
      // `color` is the fallback when gradients are switched off (Role Colors
      // "dots" / "off", forced colours): the first readable stop.
      color: readable[0],
      '--role-angle': `${angle}deg`,
      backgroundImage: `linear-gradient(${style === 'holographic' ? 90 : angle}deg, ${readable.join(', ')})`
    },
    colour: readable[0]
  };
}

/**
 * Worst contrast of any stop against a background, for the editor's warning.
 * Uses the raw stops: the guard fixes them at render time, but the owner
 * should know the colour they picked is being adjusted.
 */
export function worstStopContrast(role, background) {
  const stops = roleStops(role);
  if (!stops.length) return null;
  return Math.min(...stops.map((c) => contrastRatio(c, background)));
}

/**
 * The roles that decide how a member's name looks: the highest role with a
 * colour styles the name, the highest with an icon supplies the icon.
 * `rolesById` is the server's full role list (with style fields); without it
 * the member's derived role_color / role_icon fields are used.
 */
export function memberRoleLook(member, rolesById) {
  if (!member) return { styleRole: null, iconRole: null };
  const ids = (member.roles ?? []).map((r) => (typeof r === 'string' ? r : r.id));
  const full = rolesById
    ? ids.map((id) => rolesById.get?.(id) ?? rolesById[id]).filter(Boolean)
    : (member.roles ?? []).filter((r) => typeof r === 'object');
  const ranked = [...full].sort((a, b) => (b.position ?? 0) - (a.position ?? 0));
  const styleRole = ranked.find((r) => r.color && !r.is_everyone && !String(r.name).startsWith('@'))
    ?? (member.role_color ? { color: member.role_color, color_secondary: member.role_color_secondary ?? null } : null);
  const iconRole = ranked.find((r) => r.icon_url || r.unicode_emoji)
    ?? (member.role_icon?.url ? { icon_url: member.role_icon.url, name: member.role_icon.name } : null);
  return { styleRole, iconRole };
}
