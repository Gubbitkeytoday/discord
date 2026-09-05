import React, { createContext, useCallback, useContext, useMemo, useState } from 'react';

import th from './th.js';
import en from './en.js';

const DICTIONARIES = { th, en };
const STORAGE_KEY = 'antigravity.locale';

export const LOCALES = [
  { code: 'th', label: 'ไทย', englishLabel: 'Thai', flag: '🇹🇭' },
  { code: 'en', label: 'English', englishLabel: 'English', flag: '🇬🇧' }
];

/** BCP 47 tags for Intl, which needs a region for sensible defaults. */
const INTL_LOCALE = { th: 'th-TH', en: 'en-GB' };

function detectLocale() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && DICTIONARIES[stored]) return stored;
  } catch { /* private mode */ }

  // Fall back to the browser's preference before the app default, so a visitor
  // from anywhere gets a language they can read on first load.
  for (const tag of navigator.languages ?? [navigator.language ?? '']) {
    const base = String(tag).split('-')[0].toLowerCase();
    if (DICTIONARIES[base]) return base;
  }
  return 'en';
}

/**
 * Look up `key` in the active dictionary, falling back to English and finally to
 * the key itself. Returning the key rather than blank means a missing string is
 * visible in the UI instead of silently disappearing.
 */
function lookup(locale, key) {
  return DICTIONARIES[locale]?.[key] ?? DICTIONARIES.en?.[key] ?? key;
}

/** Replace {name} placeholders. */
function interpolate(template, values) {
  if (!values) return template;
  return String(template).replace(/\{(\w+)\}/g, (match, name) =>
    (values[name] === undefined ? match : String(values[name]))
  );
}

const I18nContext = createContext(null);

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
let currentLocale = 'en';

/** Translate outside of React, or inside it without a hook. */
export function t(key, values) {
  return interpolate(lookup(currentLocale, key), values);
}

/**
 * BCP 47 tag for the active locale — for the handful of places that call
 * `toLocaleDateString` directly instead of going through the provider's
 * formatters.
 */
export function localeTag() {
  return INTL_LOCALE[currentLocale] ?? currentLocale;
}

export function I18nProvider({ children }) {
  const [locale, setLocaleState] = useState(detectLocale);

  // Published before children render, so the very first paint after a switch
  // already uses the new dictionary.
  currentLocale = locale;

  const setLocale = useCallback((next) => {
    if (!DICTIONARIES[next]) return;
    setLocaleState(next);
    try { localStorage.setItem(STORAGE_KEY, next); } catch { /* ignore */ }
    // Assistive tech and browser hyphenation both read this.
    document.documentElement.lang = next;
  }, []);

  const value = useMemo(() => {
    const intlLocale = INTL_LOCALE[locale] ?? locale;

    return {
      locale,
      intlLocale,
      setLocale,
      availableLocales: LOCALES,

      t: (key, values) => interpolate(lookup(locale, key), values),

      // Formatters bound to the active locale. Constructed per render of the
      // provider, not per call, because Intl objects are expensive to build.
      formatNumber: new Intl.NumberFormat(intlLocale).format,
      formatDate: (date, options) =>
        new Intl.DateTimeFormat(intlLocale, options).format(new Date(date)),
      formatRelative: (date) => {
        const diffMs = new Date(date).getTime() - Date.now();
        const units = [
          ['year', 31536000000], ['month', 2592000000], ['day', 86400000],
          ['hour', 3600000], ['minute', 60000], ['second', 1000]
        ];
        const [unit, ms] = units.find(([, span]) => Math.abs(diffMs) >= span) ?? ['second', 1000];
        return new Intl.RelativeTimeFormat(intlLocale, { numeric: 'auto' })
          .format(Math.round(diffMs / ms), unit);
      },
      formatBytes: (bytes) => {
        if (!bytes) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB', 'TB'];
        const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
        const value = bytes / 1024 ** index;
        return `${new Intl.NumberFormat(intlLocale, {
          maximumFractionDigits: index === 0 ? 0 : 1
        }).format(value)} ${units[index]}`;
      }
    };
  }, [locale, setLocale]);

  return (
    <I18nContext.Provider value={value}>
      {/* Remounting on locale change is what makes the module-level `t` above
          correct: every component re-renders, whether it subscribes or not.
          Language switching is rare, so the cost of a remount is fine. */}
      <React.Fragment key={locale}>{children}</React.Fragment>
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

/** Apply the detected locale to <html lang> before React mounts. */
export function initLocale() {
  document.documentElement.lang = detectLocale();
}

/** Every key defined in any dictionary — used by the translation audit. */
export function allKeys() {
  return new Set(Object.keys({ ...th, ...en }));
}

export { DICTIONARIES };
