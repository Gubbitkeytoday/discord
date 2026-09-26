// ============================================================================
//  Gradient themes: from validated data to CSS custom properties, with a
//  contrast guard that keeps every text token at 4.5:1 or better.
//
//  How it paints (index.css, `:root[data-tint="gradient"]`):
//    - every layout surface class (bg-d-base, bg-d-surface, bg-d-canvas …) gets
//      `background-image: <scrim>, <gradient>` with `background-attachment:
//      fixed`. Each surface is therefore OPAQUE — a modal over the chat never
//      shows the text behind it — yet all of them show the same viewport-wide
//      gradient, so the app reads as one continuous tinted sheet (Discord's
//      look, without its translucency hazards).
//    - the scrim is the base theme's darkest (dark) or lightest (light)
//      colour at a per-layer opacity; deeper chrome gets a thicker scrim.
//    - hover / selected rows are translucent overlays on top of a surface.
//
//  The guard (docs/research/DISCORD-THEMES.md §4.2): for the thinnest layer
//  (the chat) and the overlays on it, sample the whole gradient line and raise
//  the scrim until the worst point still gives 4.5:1 for every text token.
//  Thicker layers are then safe too — adding scrim only moves a surface away
//  from the text (scripts/test-themes-71.mjs checks every layer anyway).
//
//  Output is a small map of CSS variables whose values are built here from
//  hex codes and numbers only; nothing from the theme is pasted into CSS.
// ============================================================================

import { contrast, luminance, over, parseHex, sampleGradient, averageColour, rgba, toHex, isHex6 } from './color.js';
import { GRADIENT_TEXT } from './palettes.js';

export const MIN_TEXT_CONTRAST = 4.5;
// The guard aims a little higher: the browser (and our flat fallbacks)
// round every composited channel to 8 bits, which can shave ~0.02 off.
const GUARD_TARGET = 4.55;

/** Scrim colour per base: the base theme's own deepest/brightest surface. */
export const SCRIM = { dark: '#0d0d10', light: '#ffffff' };
/** Row states are a wash of this colour over whatever surface is below. */
export const OVERLAY = { dark: '#ffffff', light: '#000000' };
export const OVERLAY_ALPHA = { rowhover: 0.03, hover: 0.05, selected: 0.09 };

/**
 * Extra scrim per layer on top of the base amount. `chat` is the thinnest,
 * so it decides the guard. Keys are the `--tint-scrim-<layer>` suffixes.
 */
export const LAYERS = {
  chat: 0,
  surface: 0.04,
  sidebar: 0.07,
  input: 0.1,
  panel: 0.1,
  app: 0.14,
  deep: 0.16,
  raised: 0.2,
  deepest: 0.2,
  floating: 0.24
};
const MAX_SCRIM = 0.97;

/** Intensity 0–100 → requested base scrim (more intensity = thinner scrim). */
export function scrimForIntensity(intensity, base) {
  const i = Math.max(0, Math.min(100, Number(intensity) || 0)) / 100;
  return base === 'light' ? 0.88 - 0.6 * i : 0.85 - 0.6 * i;
}

const layerAmount = (a, layer) => Math.min(MAX_SCRIM, a + LAYERS[layer]);

/** Every text token must reach the ratio; text-faint is exempt only on `selected`. */
function textLuminances(base) {
  const tokens = GRADIENT_TEXT[base];
  return Object.entries(tokens).map(([name, hex]) => ({ name, hex, lum: luminance(hex) }));
}

/**
 * The backgrounds text can sit on for one layer at scrim `a`, across the
 * whole gradient line plus the flat fallback colour. Returns [{ rgb, state }].
 */
export function layerBackgrounds({ base, stops }, a, layer = 'chat', samples = 48) {
  const scrim = parseHex(SCRIM[base]);
  const overlay = parseHex(OVERLAY[base]);
  const alpha = layerAmount(a, layer);
  const points = [...sampleGradient(stops, samples), averageColour(stops)];
  const out = [];
  for (const g of points) {
    const surface = over(g, scrim, alpha);
    out.push({ rgb: surface, state: 'surface' });
    for (const [state, amount] of Object.entries(OVERLAY_ALPHA)) {
      out.push({ rgb: over(surface, overlay, amount), state });
    }
  }
  return out;
}

/** Worst contrast of any text token over the given backgrounds. */
export function worstContrast(base, backgrounds) {
  const texts = textLuminances(base);
  let worst = { ratio: Infinity, token: null, background: null };
  for (const bg of backgrounds) {
    const bgLum = luminance(bg.rgb);
    for (const text of texts) {
      if (text.name === 'text-faint' && bg.state === 'selected') continue;
      const hi = Math.max(bgLum, text.lum);
      const lo = Math.min(bgLum, text.lum);
      const ratio = (hi + 0.05) / (lo + 0.05);
      if (ratio < worst.ratio) worst = { ratio, token: text.name, background: toHex(bg.rgb) };
    }
  }
  return worst;
}

/**
 * Smallest scrim ≥ `requested` for which the chat layer passes. Steps of
 * 0.01 — the answer is shown to the user as a percentage.
 */
export function guardScrim(theme, requested) {
  let a = Math.max(0, Math.min(MAX_SCRIM, requested));
  for (;;) {
    const worst = worstContrast(theme.base, layerBackgrounds(theme, a, 'chat'));
    if (worst.ratio >= GUARD_TARGET || a >= MAX_SCRIM) return { amount: a, worst };
    a = Math.min(MAX_SCRIM, Math.round((a + 0.01) * 100) / 100);
  }
}

const cssNumber = (n) => String(Math.round(n * 1000) / 1000);

/** `linear-gradient(…)` built from validated numbers and hex codes only. */
export function gradientCss({ angle, stops }) {
  const safeAngle = Number.isInteger(angle) && angle >= 0 && angle <= 360 ? angle : 180;
  const safeStops = stops.filter(isHex6);
  const list = safeStops.length === 1 ? [safeStops[0], safeStops[0]] : safeStops;
  return `linear-gradient(${safeAngle}deg, ${list.join(', ')})`;
}

/**
 * Everything the document needs for one gradient theme.
 * `theme` = { base, stops, angle, intensity } (already validated).
 */
export function buildGradientTheme(theme) {
  const requested = scrimForIntensity(theme.intensity, theme.base);
  const { amount, worst } = guardScrim(theme, requested);
  const scrim = parseHex(SCRIM[theme.base]);
  const avg = averageColour(theme.stops);
  const vars = {
    '--tint-gradient': gradientCss(theme),
    '--tint-color': toHex(avg),
    '--tint-overlay': OVERLAY[theme.base]
  };
  for (const layer of Object.keys(LAYERS)) {
    const alpha = layerAmount(amount, layer);
    vars[`--tint-scrim-${layer}`] = rgba(scrim, alpha);
    // Flat equivalent at the gradient's average colour: what any rule that
    // reads the token as a colour (borders, the settings split) gets.
    vars[`--tint-bg-${layer}`] = toHex(over(avg, scrim, alpha));
  }
  return {
    base: theme.base,
    vars,
    requested,
    amount,
    adjusted: amount > requested + 0.005,
    worst
  };
}

/** Contrast of a text token on a flat colour (swatch previews). */
export function swatchText(base) {
  return GRADIENT_TEXT[base]['text-strong'];
}

export { contrast };
