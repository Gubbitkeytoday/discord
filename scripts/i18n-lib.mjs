// Shared loading and per-locale analysis for scripts/i18n-audit.mjs and
// scripts/i18n-report.mjs. No side effects beyond reading files.
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

export const ROOT = path.resolve(import.meta.dirname, '..');
export const SRC = path.join(ROOT, 'src');
export const I18N = path.join(SRC, 'i18n');
export const LOCALES_DIR = path.join(I18N, 'locales');
export const META_FILE = path.join(LOCALES_DIR, '_meta.json');

const registryModule = await import(pathToFileURL(path.join(LOCALES_DIR, '_registry.js')).href);
export const { LOCALE_REGISTRY, completeness, SOURCE_LOCALE } = registryModule;

export const PLURAL_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'];
const PLURAL_SUFFIX = new RegExp(`_(${PLURAL_CATEGORIES.join('|')})$`);

/** Every dictionary file: { name, file, dict?, error? }. en first, th second. */
export async function loadDictionaries() {
  const files = [
    ['en', path.join(I18N, 'en.js')],
    ['th', path.join(I18N, 'th.js')]
  ];
  if (fs.existsSync(LOCALES_DIR)) {
    for (const entry of fs.readdirSync(LOCALES_DIR).sort()) {
      if (!entry.endsWith('.js') || entry.startsWith('_')) continue;
      files.push([entry.slice(0, -3), path.join(LOCALES_DIR, entry)]);
    }
  }
  const out = [];
  for (const [name, file] of files) {
    try {
      const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
      const dict = mod.default;
      if (!dict || typeof dict !== 'object' || Array.isArray(dict)) {
        throw new Error('default export must be a plain object of key → string');
      }
      out.push({ name, file, dict });
    } catch (error) {
      out.push({ name, file, error: error.message.split('\n')[0] });
    }
  }
  return out;
}

export const placeholders = (text) => new Set(String(text).match(/\{(\w+)\}/g) ?? []);

/** The English key a (possibly plural-suffixed) key belongs to, or null. */
export function sourceKeyFor(key, source) {
  if (key in source) return key;
  const base = key.replace(PLURAL_SUFFIX, '');
  if (base !== key && (base in source || `${base}_other` in source)) return base in source ? base : `${base}_other`;
  return null;
}

/** Compare one dictionary against English. */
export function analyse(dict, source) {
  const sourceKeys = Object.keys(source);
  const missing = sourceKeys.filter((key) => !(key in dict) && !(key.replace(PLURAL_SUFFIX, '') in dict));
  const extra = [];
  const placeholderMismatches = [];
  const nonString = [];
  const identical = [];

  for (const [key, value] of Object.entries(dict)) {
    if (typeof value !== 'string') { nonString.push(key); continue; }
    const ref = sourceKeyFor(key, source);
    if (!ref) { extra.push(key); continue; }
    const want = placeholders(source[ref]);
    const got = placeholders(value);
    const diff = [...want].filter((p) => !got.has(p)).map((p) => `-${p}`)
      .concat([...got].filter((p) => !want.has(p)).map((p) => `+${p}`));
    // A plural form may drop {count} ("one message" / "un message").
    const relevant = diff.filter((d) => !(d === '-{count}' && PLURAL_SUFFIX.test(key)));
    if (relevant.length) placeholderMismatches.push({ key, diff: relevant });
    if (dict !== source && value === source[key] && /\p{L}/u.test(value.replace(/\{\w+\}/g, ''))) identical.push(key);
  }
  return {
    keys: Object.keys(dict).length,
    missing, extra, placeholderMismatches, nonString, identical,
    completeness: completeness(dict, source)
  };
}
