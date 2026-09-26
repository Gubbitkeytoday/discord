// ============================================================================
//  Display name styles: font, effect (solid / gradient / glow) and colours.
//
//  Fonts are open-licence (OFL) families with Thai coverage, self-hosted via
//  @fontsource and loaded only when a styled name is first shown. Colours go
//  through a contrast guard against the current theme background, so a name
//  stays readable on dark and light themes alike.
// ============================================================================

import { readableColor, themeBackground, contrastRatio } from '../utils/color';

export const FONTS = Object.freeze({
  default: { family: null, label: 'Default' },
  kanit: { family: "'Kanit'", label: 'Kanit', load: () => import('@fontsource/kanit/600.css') },
  sarabun: { family: "'Sarabun'", label: 'Sarabun', load: () => import('@fontsource/sarabun/600.css') },
  mali: { family: "'Mali'", label: 'Mali', load: () => import('@fontsource/mali/600.css') },
  itim: { family: "'Itim'", label: 'Itim', load: () => import('@fontsource/itim/400.css') },
  chakra: { family: "'Chakra Petch'", label: 'Chakra Petch', load: () => import('@fontsource/chakra-petch/600.css') },
  trirong: { family: "'Trirong'", label: 'Trirong', load: () => import('@fontsource/trirong/600.css') }
});

export const EFFECTS = Object.freeze(['solid', 'gradient', 'glow']);

const loaded = new Set();
export function loadNameFont(font) {
  const def = FONTS[font];
  if (!def?.load || loaded.has(font)) return;
  loaded.add(font);
  def.load().catch(() => loaded.delete(font));
}

/** The name colours after the contrast guard (≥ 4.5:1 on `background`). */
export function guardedColors(colors = [], background = themeBackground()) {
  return colors.map((c) => readableColor(c, background, 4.5));
}

/**
 * Inline style for a styled name.
 *   style        { font, effect, colors[] } from the identity (or null)
 *   roleColor    a server role colour: wins over the name's colours inside
 *                servers, so role signalling (mods, bots) stays intact
 *   plain        true in dense lists when the viewer turned styles off there
 *   animate      the gradient pans slowly only when motion is allowed
 */
export function nameStyleCss(style, { roleColor = null, plain = false, background } = {}) {
  if (!style || plain) return roleColor ? { color: roleColor } : {};
  const bg = background ?? themeBackground();
  const css = {};
  const font = FONTS[style.font];
  if (font?.family) {
    loadNameFont(style.font);
    css.fontFamily = `${font.family}, var(--font-sans, inherit)`;
  }
  if (style.effect === 'staff') {
    css.color = roleColor ?? 'var(--color-d-brand)';
    css.textShadow = '0 0 8px color-mix(in srgb, currentColor 45%, transparent)';
    return css;
  }
  if (roleColor) {
    css.color = roleColor;
    return css;
  }
  const colors = guardedColors(style.colors ?? [], bg);
  if (!colors.length) return css;
  if (style.effect === 'gradient' && colors.length >= 2) {
    css.backgroundImage = `linear-gradient(90deg, ${colors[0]}, ${colors[1]}, ${colors[0]})`;
    css.backgroundSize = '200% 100%';
    css.WebkitBackgroundClip = 'text';
    css.backgroundClip = 'text';
    css.color = 'transparent';
    // Fallback colour for forced-colors / selection.
    css['--name-fallback'] = colors[0];
  } else {
    css.color = colors[0];
  }
  if (style.effect === 'glow') {
    css.textShadow = `0 0 6px color-mix(in srgb, ${colors[0]} 55%, transparent)`;
  }
  return css;
}

/** Warn in the editor when a picked colour needed adjusting. */
export function contrastReport(colors = [], backgrounds = ['#1c1d22', '#ffffff']) {
  return colors.map((c) => ({
    color: c,
    ratios: backgrounds.map((bg) => Math.round(contrastRatio(c, bg) * 10) / 10),
    adjusted: backgrounds.some((bg) => contrastRatio(c, bg) < 4.5)
  }));
}
