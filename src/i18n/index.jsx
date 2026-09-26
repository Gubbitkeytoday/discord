import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import en from './en.js';
import {
  LOCALE_REGISTRY, REGISTRY_BY_CODE, LEGACY_CODES, SOURCE_LOCALE,
  dictionaryChain, matchLocale, textDirection, completeness
} from './locales/_registry.js';

// ---------------------------------------------------------------------------
//  Dictionaries.
//
//  English is the source and the last fallback, so it is bundled. Every other
//  language is its own chunk, fetched only when someone picks it — 31 locales
//  of ~1.5k strings each would otherwise more than double the main bundle.
//  import.meta.glob is resolved at build time; a translation file that does not
//  exist yet simply has no loader and its locale is not offered.
// ---------------------------------------------------------------------------
const LOADERS = {};
for (const [file, load] of Object.entries({
  ...import.meta.glob('./th.js'),
  ...import.meta.glob(['./locales/*.js', '!./locales/_*.js'])
})) {
  LOADERS[file.replace(/^.*\//, '').replace(/\.js$/, '')] = load;
}

/** Loaded dictionaries by dictionary name. Only English is present up front. */
const DICTIONARIES = { en };
const pending = {};

// Completeness percentages precomputed by `npm run i18n:report -- --write`, so
// the picker can show them without downloading every language. Optional.
const META = Object.values(import.meta.glob('./locales/_meta.json', { eager: true, import: 'default' }))[0] ?? {};

const STORAGE_KEY = 'antigravity.locale';

function hasDictionary(code) {
  const entry = REGISTRY_BY_CODE[code];
  return Boolean(entry && (DICTIONARIES[entry.dictionary] || LOADERS[entry.dictionary]));
}

function loadDictionary(name) {
  if (DICTIONARIES[name]) return Promise.resolve(DICTIONARIES[name]);
  if (!LOADERS[name]) return Promise.resolve(null);
  pending[name] ??= LOADERS[name]()
    .then((module) => { DICTIONARIES[name] = module.default ?? {}; return DICTIONARIES[name]; })
    .catch((error) => {
      delete pending[name]; // let a later attempt retry after a network blip
      throw error;
    });
  return pending[name];
}

/** Resolve once every dictionary in `code`'s fallback chain is in memory. */
export function preloadLocale(code) {
  return Promise.all(dictionaryChain(code).map(loadDictionary));
}

function isLoaded(code) {
  return dictionaryChain(code).every((name) => DICTIONARIES[name] || !LOADERS[name]);
}

function normalize(code) {
  const mapped = LEGACY_CODES[code] ?? code;
  return hasDictionary(mapped) ? mapped : null;
}

/**
 * The locale to start in: an explicit choice first, then the browser's ordered
 * preferences (region-aware: es-MX → es-419, zh-HK → zh-TW), then English.
 */
export function detectLocale() {
  try {
    const stored = normalize(localStorage.getItem(STORAGE_KEY));
    if (stored) return stored;
  } catch { /* private mode */ }
  const tags = typeof navigator === 'undefined' ? [] : (navigator.languages ?? [navigator.language]);
  for (const tag of tags) {
    const match = matchLocale(tag, hasDictionary);
    if (match) return match;
  }
  return 'en-US';
}

// ---------------------------------------------------------------------------
//  Lookup, plurals, interpolation.
// ---------------------------------------------------------------------------
const pluralRulesCache = new Map();
function pluralCategory(intlTag, count) {
  let rules = pluralRulesCache.get(intlTag);
  if (!rules) {
    try { rules = new Intl.PluralRules(intlTag); } catch { rules = new Intl.PluralRules('en'); }
    pluralRulesCache.set(intlTag, rules);
  }
  return rules.select(count);
}

function intlFor(dictionaryName) {
  return LOCALE_REGISTRY.find((entry) => entry.dictionary === dictionaryName)?.intl ?? dictionaryName;
}

/**
 * Walk the fallback chain (regional → base → English) and return the first
 * string found, or the key itself so a missing string is visible rather than
 * blank. With a numeric `count`, CLDR plural forms are tried first in each
 * dictionary: `key_one`, `key_few`, … then `key_other`, then `key`.
 */
function lookup(locale, key, count) {
  for (const name of dictionaryChain(locale)) {
    const dictionary = DICTIONARIES[name];
    if (!dictionary) continue;
    if (typeof count === 'number') {
      const category = pluralCategory(intlFor(name), count);
      const plural = dictionary[`${key}_${category}`] ?? dictionary[`${key}_other`];
      if (plural !== undefined) return plural;
    }
    if (dictionary[key] !== undefined) return dictionary[key];
  }
  return key;
}

const numberFormatCache = new Map();
function numberFormat(intlTag, options) {
  const cacheKey = `${intlTag}|${options ? JSON.stringify(options) : ''}`;
  let format = numberFormatCache.get(cacheKey);
  if (!format) {
    format = new Intl.NumberFormat(intlTag, options);
    numberFormatCache.set(cacheKey, format);
  }
  return format;
}

/** Replace {name} placeholders; a numeric {count} is formatted for the locale. */
function interpolate(template, values, intlTag) {
  if (!values) return template;
  return String(template).replace(/\{(\w+)\}/g, (match, name) => {
    const value = values[name];
    if (value === undefined) return match;
    if (name === 'count' && typeof value === 'number') return numberFormat(intlTag).format(value);
    return String(value);
  });
}

function translate(locale, key, values) {
  const intlTag = REGISTRY_BY_CODE[locale]?.intl ?? locale;
  return interpolate(lookup(locale, key, values?.count), values, intlTag);
}

// ---------------------------------------------------------------------------
//  Locale-aware formatters. Plain functions of (intlTag, …) so both the hook
//  and the module-level exports share them; Intl objects are cached.
// ---------------------------------------------------------------------------
const RELATIVE_UNITS = [
  ['year', 31536000000], ['month', 2592000000], ['week', 604800000], ['day', 86400000],
  ['hour', 3600000], ['minute', 60000], ['second', 1000]
];
const BYTE_UNITS = ['byte', 'kilobyte', 'megabyte', 'gigabyte', 'terabyte'];

function makeFormatters(intlTag) {
  return {
    formatNumber: (value, options) => numberFormat(intlTag, options).format(value),
    formatDate: (date, options) => new Intl.DateTimeFormat(intlTag, options).format(new Date(date)),
    formatRelative: (date, { numeric = 'auto', style = 'long' } = {}) => {
      const diffMs = new Date(date).getTime() - Date.now();
      const [unit, ms] = RELATIVE_UNITS.find(([, span]) => Math.abs(diffMs) >= span) ?? ['second', 1000];
      return new Intl.RelativeTimeFormat(intlTag, { numeric, style }).format(Math.round(diffMs / ms), unit);
    },
    formatList: (items, { type = 'conjunction', style = 'long' } = {}) => {
      const list = [...items].map(String);
      try { return new Intl.ListFormat(intlTag, { type, style }).format(list); } catch { return list.join(', '); }
    },
    formatBytes: (bytes) => {
      const n = Number(bytes) || 0;
      const index = n > 0 ? Math.min(BYTE_UNITS.length - 1, Math.floor(Math.log(n) / Math.log(1024))) : 0;
      const value = n / 1024 ** index;
      // Intl's unit style gives "1,5 MB" in German and "1.5 MB" in English.
      return numberFormat(intlTag, {
        style: 'unit', unit: BYTE_UNITS[index], unitDisplay: 'short',
        maximumFractionDigits: index === 0 ? 0 : 1
      }).format(value);
    }
  };
}

// ---------------------------------------------------------------------------
//  Available locales, for pickers.
// ---------------------------------------------------------------------------
function describe(entry) {
  const dictionary = DICTIONARIES[entry.dictionary];
  const percent = entry.dictionary === SOURCE_LOCALE ? 100
    : dictionary ? completeness(dictionary, en)
    : META[entry.dictionary] ?? null;
  return {
    code: entry.code,
    nativeName: entry.native,
    englishName: entry.english,
    // Kept for older callers that read `label` / `englishLabel`.
    label: entry.native,
    englishLabel: entry.english,
    intl: entry.intl,
    dir: textDirection(entry.intl),
    completeness: percent
  };
}

/** Every locale that has a dictionary in this build, with display metadata. */
export function getAvailableLocales() {
  return LOCALE_REGISTRY.filter((entry) => hasDictionary(entry.code)).map(describe);
}

/** @deprecated Snapshot for older imports; prefer `useI18n().availableLocales`. */
export const LOCALES = getAvailableLocales();

// ---------------------------------------------------------------------------
//  Module-level translate function.
//
//  Most components need nothing but `t`, and threading a hook through several
//  hundred call sites adds a lot of noise for no benefit. So the provider also
//  publishes the active locale here and remounts its subtree when the locale
//  changes (see `key={locale}` below) — which means this plain function is
//  always reading the locale the UI is currently rendered in, without every
//  component having to subscribe to a context.
// ---------------------------------------------------------------------------
let currentLocale = 'en-US';

/** Translate outside of React, or inside it without a hook. */
export function t(key, values) {
  return translate(currentLocale, key, values);
}

/** Active locale code (Discord-style, e.g. 'pt-BR'). */
export function currentLocaleCode() {
  return currentLocale;
}

/**
 * BCP 47 tag for the active locale — for the handful of places that call
 * `toLocaleDateString` directly instead of going through the formatters.
 */
export function localeTag() {
  return REGISTRY_BY_CODE[currentLocale]?.intl ?? currentLocale;
}

/** Module-level formatters bound to whatever locale is active at call time. */
export const formatNumber = (...args) => makeFormatters(localeTag()).formatNumber(...args);
export const formatDate = (...args) => makeFormatters(localeTag()).formatDate(...args);
export const formatRelative = (...args) => makeFormatters(localeTag()).formatRelative(...args);
export const formatList = (...args) => makeFormatters(localeTag()).formatList(...args);
export const formatBytes = (...args) => makeFormatters(localeTag()).formatBytes(...args);

function applyDocumentLocale(code) {
  if (typeof document === 'undefined') return;
  const intl = REGISTRY_BY_CODE[code]?.intl ?? code;
  // Assistive tech, hyphenation and font selection (CJK glyph variants) read these.
  document.documentElement.lang = intl;
  document.documentElement.dir = textDirection(intl);
}

// ---------------------------------------------------------------------------
//  Account sync. The users table already has a `locale` column that
//  PUT /api/users/:id accepts, so the choice follows the account. Imported
//  lazily to keep api.js out of this module's static graph.
// ---------------------------------------------------------------------------
async function syncToAccount(code) {
  try {
    const { put, getApiUserId } = await import('../api.js');
    const userId = getApiUserId();
    if (userId) await put(`/api/users/${userId}`, { locale: code });
  } catch { /* offline or signed out — the local choice still stands */ }
}

const listeners = new Set();

/**
 * Adopt the locale stored on the signed-in account, unless this browser has an
 * explicit choice of its own. Call after sign-in with `user.locale`.
 */
export function adoptAccountLocale(code) {
  // 'th-TH' is the users.locale column default, not a choice anyone made: the
  // client always writes registry codes ('th'), so skip the default.
  if (!code || code === 'th-TH') return;
  let stored = null;
  try { stored = localStorage.getItem(STORAGE_KEY); } catch { /* ignore */ }
  const next = normalize(code) ?? matchLocale(code, hasDictionary);
  if (stored || !next) return;
  for (const listener of listeners) listener(next, { sync: false });
}

const I18nContext = createContext(null);

export function I18nProvider({ children }) {
  const [locale, setLocaleState] = useState(detectLocale);
  const [ready, setReady] = useState(() => isLoaded(locale));
  const [switching, setSwitching] = useState(null);

  // Published before children render, so the very first paint after a switch
  // already uses the new dictionary.
  currentLocale = locale;

  // First load of a lazily-loaded language: fetch it before rendering anything,
  // so the UI never flashes English or raw keys. English is bundled and ready.
  useEffect(() => {
    if (ready) return undefined;
    let cancelled = false;
    preloadLocale(locale)
      .catch(() => { /* fall back through the chain to English */ })
      .finally(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, [locale, ready]);

  useEffect(() => { applyDocumentLocale(locale); }, [locale]);

  const setLocale = useCallback(async (requested, { sync = true } = {}) => {
    const next = normalize(requested);
    if (!next) return false;
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* ignore */ }
    // Keep showing the current language until the new one is in memory.
    setSwitching(next);
    try {
      await preloadLocale(next);
    } catch {
      setSwitching(null);
      return false;
    }
    setSwitching(null);
    setLocaleState(next);
    setReady(true);
    if (sync) syncToAccount(next);
    return true;
  }, []);

  useEffect(() => {
    listeners.add(setLocale);
    return () => listeners.delete(setLocale);
  }, [setLocale]);

  const value = useMemo(() => {
    const entry = REGISTRY_BY_CODE[locale];
    const intlLocale = entry?.intl ?? locale;
    return {
      locale,
      intlLocale,
      dir: textDirection(intlLocale),
      setLocale,
      /** Code currently being downloaded, or null. */
      switchingTo: switching,
      availableLocales: getAvailableLocales(),
      preloadLocale,
      t: (key, values) => translate(locale, key, values),
      ...makeFormatters(intlLocale)
    };
  }, [locale, setLocale, switching]);

  return (
    <I18nContext.Provider value={value}>
      {/* Remounting on locale change is what makes the module-level `t` above
          correct: every component re-renders, whether it subscribes or not.
          Language switching is rare, so the cost of a remount is fine. */}
      {ready ? <React.Fragment key={locale}>{children}</React.Fragment> : null}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  const context = useContext(I18nContext);
  if (!context) {
    // Rendering outside the provider is a wiring bug; a hard error is clearer
    // than every label silently rendering as its key.
    throw new Error('useI18n must be used inside <I18nProvider>');
  }
  return context;
}

/** Convenience for components that only need the translate function. */
export function useT() {
  return useI18n().t;
}

/**
 * Apply the detected locale to <html lang dir> before React mounts, and start
 * downloading its dictionary in parallel with the rest of the app's startup.
 */
export function initLocale() {
  const code = detectLocale();
  applyDocumentLocale(code);
  preloadLocale(code).catch(() => {});
}

/** Every key in the source dictionary — used by the translation audit. */
export function allKeys() {
  return new Set(Object.keys(en));
}

export { DICTIONARIES };
