// ============================================================================
//  Custom themes: the data format, strict validation, import and export.
//
//  A theme is DATA — a base (light/dark), up to five #rrggbb colour stops, an
//  angle and an intensity. It never carries CSS: the engine (gradient.js)
//  builds every CSS value itself from these validated numbers and hex codes,
//  so an imported file cannot inject a selector, a url() or a property.
//
//  services/userSettings.js repeats these rules on the server (the server
//  does not ship src/); scripts/test-themes-71.mjs feeds both the same good
//  and bad inputs.
// ============================================================================

import { isHex6 } from './color.js';
import { PRESET_IDS } from './presets.js';

export const MAX_CUSTOM_THEMES = 10;
export const MAX_STOPS = 5;
export const MAX_NAME_LENGTH = 32;
export const EXPORT_FORMAT = 'antigravity-theme';
export const EXPORT_VERSION = 1;
/** An exported theme is a few hundred bytes; anything much bigger is not one. */
export const MAX_IMPORT_BYTES = 4096;

const ID = /^[a-z0-9]{4,16}$/;
const THEME_KEYS = ['id', 'name', 'base', 'stops', 'angle', 'intensity'];
const EXPORT_KEYS = ['format', 'version', 'name', 'base', 'stops', 'angle', 'intensity'];
// Control characters and bidi overrides have no place in a theme name.
const BAD_NAME_CHARS = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

export class ThemeError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
  && Object.getPrototypeOf(v) === Object.prototype;

function checkName(name) {
  if (typeof name !== 'string') throw new ThemeError('THEME_NAME');
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > MAX_NAME_LENGTH || BAD_NAME_CHARS.test(trimmed)) throw new ThemeError('THEME_NAME');
  return trimmed;
}

function checkBody({ base, stops, angle, intensity }) {
  if (base !== 'light' && base !== 'dark') throw new ThemeError('THEME_BASE');
  if (!Array.isArray(stops) || stops.length < 1 || stops.length > MAX_STOPS || !stops.every(isHex6)) {
    throw new ThemeError('THEME_STOPS');
  }
  if (!Number.isInteger(angle) || angle < 0 || angle > 360) throw new ThemeError('THEME_ANGLE');
  if (!Number.isInteger(intensity) || intensity < 0 || intensity > 100) throw new ThemeError('THEME_INTENSITY');
  return { base, stops: stops.map((s) => s.toLowerCase()), angle, intensity };
}

/** Validate one stored custom theme; throws ThemeError, returns a clean copy. */
export function validateCustomTheme(theme) {
  if (!isPlainObject(theme)) throw new ThemeError('THEME_SHAPE');
  for (const key of Object.keys(theme)) {
    if (!THEME_KEYS.includes(key)) throw new ThemeError('THEME_SHAPE', `unknown key ${key}`);
  }
  if (typeof theme.id !== 'string' || !ID.test(theme.id)) throw new ThemeError('THEME_ID');
  return { id: theme.id, name: checkName(theme.name), ...checkBody(theme) };
}

/** Validate the whole list (unique ids, at most MAX_CUSTOM_THEMES). */
export function validateCustomThemes(list) {
  if (!Array.isArray(list) || list.length > MAX_CUSTOM_THEMES) throw new ThemeError('THEME_LIST');
  const seen = new Set();
  return list.map((theme) => {
    const clean = validateCustomTheme(theme);
    if (seen.has(clean.id)) throw new ThemeError('THEME_ID', 'duplicate id');
    seen.add(clean.id);
    return clean;
  });
}

/** Lenient reader for the client: drop bad entries instead of failing the page. */
export function safeCustomThemes(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const theme of list.slice(0, MAX_CUSTOM_THEMES)) {
    try {
      const clean = validateCustomTheme(theme);
      if (!out.some((t) => t.id === clean.id)) out.push(clean);
    } catch { /* skip */ }
  }
  return out;
}

/** 'none' | a preset id | 'custom:<id>'. */
export function isGradientChoice(value) {
  if (value === 'none') return true;
  if (typeof value !== 'string') return false;
  if (PRESET_IDS.includes(value)) return true;
  return /^custom:[a-z0-9]{4,16}$/.test(value);
}

export function newThemeId() {
  const bytes = new Uint8Array(6);
  (globalThis.crypto ?? { getRandomValues: (a) => a.map(() => Math.floor(Math.random() * 256)) }).getRandomValues(bytes);
  return Array.from(bytes, (b) => (b % 36).toString(36)).join('').padEnd(8, '0').slice(0, 10);
}

/** The JSON a user downloads or copies. Tokens only, never CSS. */
export function exportTheme(theme) {
  const clean = validateCustomTheme(theme);
  return JSON.stringify({
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    name: clean.name,
    base: clean.base,
    stops: clean.stops,
    angle: clean.angle,
    intensity: clean.intensity
  }, null, 2);
}

/**
 * Parse an imported file or pasted text. Strict: exact format marker and
 * version, no unknown keys, every value checked. Returns a theme without an
 * id (the caller assigns one when saving). Throws ThemeError.
 */
export function importTheme(text) {
  if (typeof text !== 'string' || !text.trim()) throw new ThemeError('IMPORT_EMPTY');
  if (new TextEncoder().encode(text).length > MAX_IMPORT_BYTES) throw new ThemeError('IMPORT_TOO_BIG');
  let data;
  try { data = JSON.parse(text); } catch { throw new ThemeError('IMPORT_JSON'); }
  if (!isPlainObject(data)) throw new ThemeError('IMPORT_SHAPE');
  for (const key of Object.keys(data)) {
    if (!EXPORT_KEYS.includes(key)) throw new ThemeError('IMPORT_SHAPE', `unknown key ${key}`);
  }
  if (data.format !== EXPORT_FORMAT || data.version !== EXPORT_VERSION) throw new ThemeError('IMPORT_FORMAT');
  return { name: checkName(data.name), ...checkBody(data) };
}
