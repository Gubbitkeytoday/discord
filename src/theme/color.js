// ============================================================================
//  Colour maths for the theme engine. Pure functions, no DOM, so the same code
//  runs in the browser (gradient contrast guard, custom theme builder) and in
//  Node (scripts/test-themes-71.mjs, which checks every preset).
//
//  Everything is sRGB, 8-bit, because that is what the browser composites in:
//  a translucent layer over a hex gradient (which interpolates in sRGB for
//  legacy colours) is a per-channel linear blend of the gamma-encoded values.
// ============================================================================

const HEX6 = /^#[0-9a-f]{6}$/i;

/** True for exactly `#rrggbb` — the only colour syntax a theme may carry. */
export const isHex6 = (value) => typeof value === 'string' && HEX6.test(value);

/** '#rrggbb' → [r, g, b] (0–255). */
export function parseHex(hex) {
  const h = String(hex).replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
}

/** [r, g, b] → '#rrggbb' (rounded and clamped). */
export function toHex(rgb) {
  return `#${rgb.map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('')}`;
}

const lin = (c) => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

/** WCAG 2.x relative luminance of an [r,g,b] triple or a hex string. */
export function luminance(colour) {
  const [r, g, b] = typeof colour === 'string' ? parseHex(colour) : colour;
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio between two colours (hex or rgb triples). */
export function contrast(a, b) {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/**
 * Paint `top` at `alpha` (0–1) over an opaque `bottom`: the browser's own
 * source-over composite. Returns an rgb triple (unrounded).
 */
export function over(bottom, top, alpha) {
  const b = typeof bottom === 'string' ? parseHex(bottom) : bottom;
  const t = typeof top === 'string' ? parseHex(top) : top;
  return b.map((c, i) => c + (t[i] - c) * alpha);
}

/** Linear sRGB-space interpolation (what a hex gradient does). */
export function mix(a, b, t) {
  return over(a, b, t);
}

/**
 * Sample a linear gradient's colour line at `samples` evenly spaced points
 * (stops evenly distributed, as `linear-gradient(angle, a, b, c)` does).
 * The worst contrast can sit between stops for light themes, so the guard
 * checks the whole line, not only the stops.
 */
export function sampleGradient(stops, samples = 48) {
  const rgb = stops.map(parseHex);
  if (rgb.length === 1) return [rgb[0]];
  const out = [];
  for (let i = 0; i <= samples; i += 1) {
    const t = i / samples;
    const pos = t * (rgb.length - 1);
    const k = Math.min(rgb.length - 2, Math.floor(pos));
    out.push(mix(rgb[k], rgb[k + 1], pos - k));
  }
  return out;
}

/** Mean of the stops — the flat colour used where a gradient cannot be painted. */
export function averageColour(stops) {
  const rgb = stops.map(parseHex);
  return rgb[0].map((_, i) => rgb.reduce((sum, c) => sum + c[i], 0) / rgb.length);
}

/** 'rgb(…)'/'rgba(…)' string for a triple and an alpha, 3-decimal precision. */
export function rgba(rgb, alpha = 1) {
  const [r, g, b] = rgb.map((c) => Math.max(0, Math.min(255, Math.round(c))));
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 1000) / 1000;
  return a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** HSL (h 0–360, s/l 0–1) → '#rrggbb'. Used by "Surprise me". */
export function hslToHex(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return toHex([f(0) * 255, f(8) * 255, f(4) * 255]);
}
