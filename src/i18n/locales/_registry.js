// ============================================================================
//  Locale registry — metadata only, no strings.
//
//  The set of locales mirrors Discord's client (Settings → Language). Each
//  entry says how to *find* its strings and how to *format* for it; the strings
//  themselves live in ./<dictionary>.js and are code-split, so this file is the
//  only thing about a locale that ships in the main bundle.
//
//    code        what we store and what the picker shows (Discord's code)
//    dictionary  which translation file holds the strings ('en' for both
//                English variants — they differ only in formatting)
//    intl        BCP 47 tag handed to Intl.* (Norwegian 'no' → Bokmål 'nb')
//    fallback    ordered chain tried after the locale itself, before English
//                (CLDR-style parents: es-419 → es-ES). zh-TW deliberately has
//                none: Simplified is not a readable fallback for Traditional.
//
//  A file that does not exist yet is fine: the locale is simply not offered
//  until its dictionary lands. Plain ESM, no JSX — scripts/i18n-*.mjs import it.
// ============================================================================

export const SOURCE_LOCALE = 'en';

export const LOCALE_REGISTRY = [
  { code: 'id',     native: 'Bahasa Indonesia', english: 'Indonesian' },
  { code: 'da',     native: 'Dansk',            english: 'Danish' },
  { code: 'de',     native: 'Deutsch',          english: 'German' },
  { code: 'en-GB',  native: 'English, UK',      english: 'English, UK', dictionary: 'en', intl: 'en-GB' },
  { code: 'en-US',  native: 'English, US',      english: 'English, US', dictionary: 'en', intl: 'en-US' },
  { code: 'es-ES',  native: 'Español',          english: 'Spanish' },
  { code: 'es-419', native: 'Español, LATAM',   english: 'Spanish, LATAM', fallback: ['es-ES'] },
  { code: 'fr',     native: 'Français',         english: 'French' },
  { code: 'hr',     native: 'Hrvatski',         english: 'Croatian' },
  { code: 'it',     native: 'Italiano',         english: 'Italian' },
  { code: 'lt',     native: 'Lietuviškai',      english: 'Lithuanian' },
  { code: 'hu',     native: 'Magyar',           english: 'Hungarian' },
  { code: 'nl',     native: 'Nederlands',       english: 'Dutch' },
  { code: 'no',     native: 'Norsk',            english: 'Norwegian', intl: 'nb' },
  { code: 'pl',     native: 'Polski',           english: 'Polish' },
  { code: 'pt-BR',  native: 'Português do Brasil', english: 'Portuguese, Brazilian' },
  { code: 'ro',     native: 'Română',           english: 'Romanian' },
  { code: 'fi',     native: 'Suomi',            english: 'Finnish' },
  { code: 'sv-SE',  native: 'Svenska',          english: 'Swedish' },
  { code: 'vi',     native: 'Tiếng Việt',       english: 'Vietnamese' },
  { code: 'tr',     native: 'Türkçe',           english: 'Turkish' },
  { code: 'cs',     native: 'Čeština',          english: 'Czech' },
  { code: 'el',     native: 'Ελληνικά',         english: 'Greek' },
  { code: 'bg',     native: 'Български',        english: 'Bulgarian' },
  { code: 'ru',     native: 'Русский',          english: 'Russian' },
  { code: 'uk',     native: 'Українська',       english: 'Ukrainian' },
  { code: 'hi',     native: 'हिन्दी',            english: 'Hindi' },
  { code: 'th',     native: 'ไทย',              english: 'Thai', intl: 'th-TH' },
  { code: 'zh-CN',  native: '中文',             english: 'Chinese, China' },
  { code: 'ja',     native: '日本語',           english: 'Japanese' },
  { code: 'zh-TW',  native: '繁體中文',         english: 'Chinese, Taiwan' },
  { code: 'ko',     native: '한국어',           english: 'Korean' }
].map((entry) => ({
  dictionary: entry.code,
  intl: entry.code,
  fallback: [],
  ...entry
}));

export const REGISTRY_BY_CODE = Object.fromEntries(LOCALE_REGISTRY.map((entry) => [entry.code, entry]));

/** Older builds stored bare 'en'; it kept en-GB formatting, so keep that. */
export const LEGACY_CODES = { en: 'en-GB' };

const RTL_LANGUAGES = new Set(['ar', 'arc', 'dv', 'fa', 'ha', 'he', 'khw', 'ks', 'ku', 'ps', 'sd', 'ur', 'yi']);

/** 'ltr' or 'rtl' for a BCP 47 tag — ready for an RTL locale even though Discord ships none. */
export function textDirection(tag) {
  try {
    const locale = new Intl.Locale(tag);
    const info = locale.getTextInfo?.() ?? locale.textInfo;
    if (info?.direction) return info.direction;
  } catch { /* old engine or bad tag */ }
  return RTL_LANGUAGES.has(String(tag).split('-')[0].toLowerCase()) ? 'rtl' : 'ltr';
}

/**
 * Dictionaries to consult for `code`, most specific first, always ending in the
 * source locale: e.g. es-419 → ['es-419', 'es-ES', 'en'].
 */
export function dictionaryChain(code) {
  const entry = REGISTRY_BY_CODE[code];
  const chain = entry ? [entry.dictionary, ...entry.fallback.map((c) => REGISTRY_BY_CODE[c]?.dictionary ?? c)] : [];
  chain.push(SOURCE_LOCALE);
  return [...new Set(chain)];
}

// Spanish-speaking Latin America plus the US: CLDR's es-419 region set.
const LATAM = new Set(['419', 'AR', 'BO', 'BR', 'BZ', 'CL', 'CO', 'CR', 'CU', 'DO', 'EC', 'GT', 'HN',
  'MX', 'NI', 'PA', 'PE', 'PR', 'PY', 'SV', 'US', 'UY', 'VE']);

/**
 * Best supported locale for one browser language tag, or null. Understands
 * region and script: zh-HK → zh-TW (Traditional), es-MX → es-419, nb → no,
 * en-AU → en-GB, pt-PT → pt-BR (the only Portuguese we have).
 */
export function matchLocale(tag, isAvailable = () => true) {
  if (!tag) return null;
  let language; let region; let script;
  try {
    const parsed = new Intl.Locale(String(tag));
    const max = parsed.maximize();
    language = parsed.language; region = parsed.region; script = max.script;
  } catch {
    [language, region] = String(tag).split(/[-_]/);
  }
  language = String(language ?? '').toLowerCase();
  region = region ? String(region).toUpperCase() : undefined;

  const candidates = [];
  const exact = LOCALE_REGISTRY.find((e) => e.code.toLowerCase() === String(tag).toLowerCase());
  if (exact) candidates.push(exact.code);

  switch (language) {
    case 'en': candidates.push(...(!region || region === 'US' ? ['en-US', 'en-GB'] : ['en-GB', 'en-US'])); break;
    case 'es': candidates.push(...(region && LATAM.has(region) ? ['es-419', 'es-ES'] : ['es-ES', 'es-419'])); break;
    case 'pt': candidates.push('pt-BR'); break;
    case 'sv': candidates.push('sv-SE'); break;
    case 'nb': case 'nn': case 'no': candidates.push('no'); break;
    case 'zh': candidates.push(script === 'Hant' || ['TW', 'HK', 'MO'].includes(region) ? 'zh-TW' : 'zh-CN'); break;
    default: if (REGISTRY_BY_CODE[language]) candidates.push(language);
  }
  return candidates.find((code) => REGISTRY_BY_CODE[code] && isAvailable(code)) ?? null;
}

/**
 * How much of `dictionary` is actually translated, 0–100. A key counts when it
 * is present and non-empty and either differs from English or contains no
 * letters to translate ("{count}", "•"). Brand names that legitimately stay in
 * English cost a point or two — this is an estimate, not a gate.
 */
export function completeness(dictionary, source) {
  const keys = Object.keys(source);
  if (!keys.length || !dictionary) return 0;
  if (dictionary === source) return 100;
  let done = 0;
  for (const key of keys) {
    const value = dictionary[key];
    if (typeof value !== 'string' || !value.trim()) continue;
    const letters = value.replace(/\{\w+\}/g, '');
    if (value !== source[key] || !/\p{L}/u.test(letters)) done += 1;
  }
  return Math.floor((done / keys.length) * 100);
}
