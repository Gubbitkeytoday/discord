// ============================================================================
//  Theme engine: turns the appearance preferences into attributes and CSS
//  variables on <html>. Called by applyPreferences() (hooks/useUserSettings)
//  on every change; cheap when nothing changed (gradient results are cached).
//
//  Owns: gradient/custom themes (data-tint + --tint-*), the season
//  (data-season), UI font (data-ui-font, lazy font download), text spacing,
//  radius scale, browser theme-color, the live favicon's accent, and the
//  pre-paint cache that the inline script in index.html reads on the next
//  load so the first frame already has the right look.
// ============================================================================

import { buildGradientTheme } from './gradient.js';
import { findPreset } from './presets.js';
import { safeCustomThemes, isGradientChoice } from './schema.js';
import { THEME_FRAME } from './palettes.js';
import { resolveSeason, SEASON_ACCENT } from './seasonal.js';
import { setFaviconAccent, installLiveFavicon } from './favicon.js';

export const BOOT_KEY = 'antigravity.boot';
export const UI_FONTS = ['inter', 'system', 'atkinson', 'opendyslexic'];
export const RADII = ['sharp', 'default', 'round'];
export const CHAT_FONT_PX = [12, 24];

// --- transient previews (settings page only; never saved) -------------------

let gradientPreview = null;   // a custom theme object being edited
let seasonPreview = null;     // a season id being tried out

/** The custom theme builder shows its draft on the whole app while open. */
export function setGradientPreview(theme) { gradientPreview = theme ?? null; }
export function getGradientPreview() { return gradientPreview; }
export function setSeasonPreview(id) { seasonPreview = id ?? null; }
export function getSeasonPreview() { return seasonPreview; }

// --- gradient selection -------------------------------------------------------

/** The theme data a gradient choice refers to, or null for none. */
export function selectedGradient(appearance = {}) {
  if (gradientPreview) return gradientPreview;
  const choice = appearance.gradient;
  if (!choice || choice === 'none' || !isGradientChoice(choice)) return null;
  if (choice.startsWith('custom:')) {
    const id = choice.slice(7);
    return safeCustomThemes(appearance.customThemes).find((t) => t.id === id) ?? null;
  }
  return findPreset(choice);
}

const gradientCache = new Map();
/** buildGradientTheme, memoised on the theme's data. */
export function gradientFor(theme) {
  const key = `${theme.base}|${theme.angle}|${theme.intensity}|${theme.stops.join(',')}`;
  if (!gradientCache.has(key)) {
    if (gradientCache.size > 40) gradientCache.clear();
    gradientCache.set(key, buildGradientTheme(theme));
  }
  return gradientCache.get(key);
}

// --- fonts --------------------------------------------------------------------

// Self-hosted (@fontsource, OFL). Downloaded only once somebody picks one;
// each CSS file carries unicode-range subsets, so only Latin files load.
const FONT_LOADERS = {
  atkinson: () => Promise.all([
    import('@fontsource/atkinson-hyperlegible/400.css'),
    import('@fontsource/atkinson-hyperlegible/700.css')
  ]),
  opendyslexic: () => Promise.all([
    import('@fontsource/opendyslexic/400.css'),
    import('@fontsource/opendyslexic/700.css')
  ])
};
const loadedFonts = new Set();
function ensureFont(font) {
  if (!FONT_LOADERS[font] || loadedFonts.has(font)) return;
  loadedFonts.add(font);
  FONT_LOADERS[font]().catch(() => loadedFonts.delete(font));
}

// --- helpers --------------------------------------------------------------------

const clamp = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** Chat text size in px (12–24) from the stored percentage of 16 px. */
export function chatFontPx(appearance = {}) {
  return Math.round(clamp(16 * (Number(appearance.chatFontScale) || 100) / 100, CHAT_FONT_PX[0], CHAT_FONT_PX[1], 16));
}

const setData = (root, key, value) => {
  if (value === null || value === undefined) delete root.dataset[key];
  else if (root.dataset[key] !== value) root.dataset[key] = value;
};

let lastTintVars = [];

/**
 * Apply the theme layer. `baseTheme` is what the plain theme setting
 * resolves to; the return value is the theme actually painted (a gradient
 * theme brings its own light or dark base).
 */
export function applyThemeLayer(root, prefs, baseTheme) {
  const appearance = prefs.appearance ?? {};
  const a11y = prefs.accessibility ?? {};
  let theme = baseTheme;
  let accent = { stops: ['#5865f2'] };

  // Gradient / custom theme. High contrast wins: it asks for plain surfaces.
  const gradient = a11y.highContrast ? null : selectedGradient(appearance);
  if (gradient) {
    const built = gradientFor(gradient);
    theme = built.base;
    for (const [name, value] of Object.entries(built.vars)) root.style.setProperty(name, value);
    for (const name of lastTintVars) if (!(name in built.vars)) root.style.removeProperty(name);
    lastTintVars = Object.keys(built.vars);
    setData(root, 'tint', 'gradient');
    accent = { stops: gradient.stops, angle: gradient.angle };
  } else {
    for (const name of lastTintVars) root.style.removeProperty(name);
    lastTintVars = [];
    setData(root, 'tint', null);
  }

  // Seasonal accent + decoration (never on high contrast: it keeps the
  // strongest brand fill).
  const season = a11y.highContrast ? null : resolveSeason({ seasonal: appearance.seasonal, preview: seasonPreview });
  setData(root, 'season', season);
  if (season && !gradient) accent = { stops: [SEASON_ACCENT[season]] };

  // Shape and type.
  setData(root, 'radius', RADII.includes(appearance.radius) ? appearance.radius : 'default');
  const font = UI_FONTS.includes(appearance.uiFont) ? appearance.uiFont : 'inter';
  setData(root, 'uiFont', font);
  ensureFont(font);
  root.style.setProperty('--message-font-size', `${chatFontPx(appearance)}px`);
  root.style.setProperty('--message-line-height', String(clamp(appearance.chatLineHeight, 1.2, 2.2, 1.375)));
  const letter = clamp(appearance.letterSpacing, 0, 0.2, 0);
  const word = clamp(appearance.wordSpacing, 0, 0.3, 0);
  root.style.setProperty('--ui-letter-spacing', `${letter}em`);
  root.style.setProperty('--ui-word-spacing', `${word}em`);
  // Only override every element's tracking when the user actually asked for
  // extra letter or word spacing; line height alone is a message-body var.
  const customSpacing = letter > 0 || word > 0;
  setData(root, 'textSpacing', customSpacing ? 'custom' : null);

  // Browser chrome colour (title bar / Android status bar).
  const frame = gradient ? gradientFor(gradient).vars['--tint-bg-app'] : (THEME_FRAME[theme] ?? THEME_FRAME.dark);
  if (typeof document !== 'undefined') {
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
      if (meta.getAttribute('content') !== frame) meta.setAttribute('content', frame);
    }
  }

  installLiveFavicon();
  setFaviconAccent(accent);
  return theme;
}

// --- pre-paint cache --------------------------------------------------------------

// What index.html's inline script may copy back onto <html> before the CSS
// and the bundle arrive. It re-validates everything (see the script).
const BOOT_DATA = ['theme', 'contrast', 'tint', 'season', 'radius', 'uiFont', 'uiDensity',
  'messageDisplay', 'reducedMotion', 'underlineLinks', 'textSpacing', 'largeTargets'];
const SKIP_VARS = new Set(['--app-effective-width']);

/** Snapshot the applied look for the next page load. */
export function writeBootCache(root) {
  try {
    const d = {};
    for (const key of BOOT_DATA) if (root.dataset[key] !== undefined) d[key] = root.dataset[key];
    const v = {};
    for (let i = 0; i < root.style.length; i += 1) {
      const name = root.style[i];
      if (name.startsWith('--') && !SKIP_VARS.has(name)) v[name] = root.style.getPropertyValue(name).trim();
    }
    const meta = document.querySelector('meta[name="theme-color"]');
    localStorage.setItem(BOOT_KEY, JSON.stringify({ d, v, c: meta?.getAttribute('content') ?? null }));
  } catch { /* private mode / quota */ }
}
