// ============================================================================
//  Colour helpers: WCAG contrast, and role colours that stay readable.
//
//  Role colours come straight from the database. 13 of Discord's 20 presets
//  fail 4.5:1 on the dark canvas and 12 fail on white (#f1c40f on white is
//  1.66:1), so a name tinted with its role colour can be unreadable. Discord
//  itself nudges the lightness of such colours; `readableColor` does the same:
//  it keeps the hue and saturation and moves lightness away from the
//  background until the text reaches the target ratio.
//
//  Use the raw colour for swatches and dots (non-text, 3:1 is enough and the
//  owner picked it), and `readableRoleColor()` wherever it colours text.
// ============================================================================

const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** '#abc' / 'abc' / '#aabbcc' → [r, g, b] (0-255), or null. */
export function parseHex(hex) {
  const match = HEX.exec(String(hex ?? '').trim());
  if (!match) return null;
  let body = match[1];
  if (body.length === 3) body = body.split('').map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(body.slice(i, i + 2), 16));
}

/** Parse `rgb(…)`/`#hex` as returned by getComputedStyle, or null. */
export function parseColor(value) {
  const hex = parseHex(value);
  if (hex) return hex;
  const match = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(String(value ?? ''));
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function toHex([r, g, b]) {
  return `#${[r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
}

const channel = (v) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** WCAG relative luminance of an [r, g, b] triple. */
export function luminance(rgb) {
  const [r, g, b] = rgb.map(channel);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two colours (hex strings or [r,g,b]). */
export function contrastRatio(a, b) {
  const x = luminance(Array.isArray(a) ? a : parseColor(a) ?? [0, 0, 0]);
  const y = luminance(Array.isArray(b) ? b : parseColor(b) ?? [0, 0, 0]);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb([h, s, l]) {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const hue = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255];
}

const cache = new Map();

/**
 * `colour`, with its lightness moved just far enough from `background` to
 * reach `minRatio` (default 4.5:1, WCAG AA body text). Hue and saturation are
 * kept, so a gold role is still gold. Returns the input unchanged when it
 * already passes or cannot be parsed.
 */
export function readableColor(colour, background, minRatio = 4.5) {
  const fg = parseColor(colour);
  const bg = parseColor(background);
  if (!fg || !bg) return colour;
  const key = `${toHex(fg)}|${toHex(bg)}|${minRatio}`;
  if (cache.has(key)) return cache.get(key);

  let result = toHex(fg);
  if (contrastRatio(fg, bg) < minRatio) {
    const [h, s, l] = rgbToHsl(fg);
    // Lighten on a dark background, darken on a light one — whichever way
    // there is more room, falling back to the other if it cannot reach it.
    const bgDark = luminance(bg) < 0.18;
    // Aim a hair above the target so rounding to 8-bit hex cannot undershoot.
    const goal = minRatio + 0.05;
    const search = (towardWhite) => {
      let lo = l;
      let hi = towardWhite ? 1 : 0;
      if (contrastRatio(hslToRgb([h, s, hi]), bg) < goal) return null;
      for (let i = 0; i < 18; i += 1) {
        const mid = (lo + hi) / 2;
        if (contrastRatio(hslToRgb([h, s, mid]), bg) >= goal) hi = mid; else lo = mid;
      }
      return toHex(hslToRgb([h, s, hi]));
    };
    result = search(bgDark) ?? search(!bgDark) ?? (bgDark ? '#ffffff' : '#000000');
  }
  if (cache.size > 500) cache.clear();
  cache.set(key, result);
  return result;
}

/** The current theme's message background, read from the design tokens. */
export function themeBackground(token = '--color-d-canvas') {
  if (typeof document === 'undefined') return '#313338';
  try {
    const value = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
    return value || '#313338';
  } catch {
    return '#313338';
  }
}

/**
 * A role colour made readable as text on the active theme. `background`
 * defaults to the chat canvas; pass the surface token for the member list
 * (`themeBackground('--color-d-surface')`). A role without a colour (null,
 * '#000000' — Discord's "default") returns null so callers fall back to the
 * normal text colour.
 */
export function readableRoleColor(colour, background = themeBackground()) {
  if (!colour || /^#?0{6}$/.test(String(colour))) return null;
  return readableColor(colour, background, 4.5);
}

/** Discord's non-text minimum (swatches, status shapes, focus rings). */
export function meetsNonTextContrast(colour, background) {
  return contrastRatio(colour, background) >= 3;
}
