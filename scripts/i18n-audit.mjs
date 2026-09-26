// ============================================================================
//  Translation audit.
//
//  Things that silently break an internationalised UI without a build error:
//    1. a dictionary that does not parse, or holds non-string values
//    2. a placeholder ({name}) present in one language but not in English —
//       the translated string would render "{name}" or drop the value
//    3. a t('key') call in a component that English does not define
//    4. keys missing from / extra to a locale
//  1–3 fail the process. For 4, English and Thai are maintained in-tree and
//  must match exactly (error); the other locales are community translations
//  that may lag, so missing/extra keys and strings still identical to English
//  are warnings — the English fallback covers them at runtime.
//
//  Usage: node scripts/i18n-audit.mjs [--verbose]
//  Per-locale table: npm run i18n:report
// ============================================================================
import fs from 'fs';
import path from 'path';
import {
  ROOT, SRC, META_FILE, LOCALE_REGISTRY, loadDictionaries, analyse
} from './i18n-lib.mjs';

const VERBOSE = process.argv.includes('--verbose');
const STRICT = new Set(['en', 'th']); // locales whose key set must equal English exactly

const loaded = await loadDictionaries();
const en = loaded.find((d) => d.name === 'en')?.dict;
const errors = [];
const warnings = [];
if (!en) {
  console.error(`❌ en.js failed to load: ${loaded.find((d) => d.name === 'en')?.error}`);
  process.exit(1);
}

const DICTIONARIES = {};
for (const { name, dict, error } of loaded) {
  if (error) { errors.push(`${name}: failed to load (${error})`); continue; }
  DICTIONARIES[name] = dict;
}
const BASE = 'en'; // English is the reference: every other locale is measured against it.

const sample = (list, n = 8) => `${list.slice(0, n).join(', ')}${list.length > n ? ` … +${list.length - n}` : ''}`;
const results = {};
const registryDictionaries = new Set(LOCALE_REGISTRY.map((e) => e.dictionary));

for (const [locale, dict] of Object.entries(DICTIONARIES)) {
  if (locale === BASE) continue;
  const r = analyse(dict, en);
  results[locale] = r;
  const bucket = STRICT.has(locale) ? errors : warnings;
  if (!registryDictionaries.has(locale)) warnings.push(`${locale}: no entry in src/i18n/locales/_registry.js — it will never be offered`);
  if (r.nonString.length) errors.push(`${locale}: ${r.nonString.length} non-string value(s) → ${sample(r.nonString)}`);
  if (r.missing.length) bucket.push(`${locale}: ${r.missing.length} key(s) missing → ${sample(r.missing)}`);
  if (r.extra.length) bucket.push(`${locale}: ${r.extra.length} key(s) not in ${BASE} → ${sample(r.extra)}`);
  for (const { key, diff } of r.placeholderMismatches) {
    errors.push(`${locale} "${key}": placeholder mismatch (${diff.join(', ')})`);
  }
  if (!STRICT.has(locale) && r.identical.length > Object.keys(en).length * 0.2) {
    warnings.push(`${locale}: ${r.identical.length} string(s) identical to English — possibly untranslated${VERBOSE ? ` → ${sample(r.identical, 30)}` : ''}`);
  }
}

// Precomputed completeness shown in the language picker.
if (fs.existsSync(META_FILE)) {
  try {
    const meta = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
    const stale = Object.entries(results).filter(([name, r]) => meta[name] !== r.completeness).map(([name]) => name);
    if (stale.length) warnings.push(`_meta.json is stale for ${stale.join(', ')} — run: npm run i18n:report -- --write`);
  } catch (error) {
    errors.push(`_meta.json does not parse (${error.message})`);
  }
} else if (Object.keys(results).length > 1) {
  warnings.push('src/i18n/locales/_meta.json missing — picker shows no completeness until: npm run i18n:report -- --write');
}

// --- collect source files ---------------------------------------------------
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'i18n') walk(full, out);
    } else if (/\.(jsx?|tsx?)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}
const files = walk(SRC);

// --- 3. keys used in source but never defined -------------------------------
const used = new Map(); // key -> first file that uses it
// Only literal t('…') calls can be checked statically; template keys such as
// t(`appearance.${x}`) are skipped and listed separately.
const LITERAL = /\bt\(\s*['"]([\w.-]+)['"]/g;
const DYNAMIC = /\bt\(\s*`/g;
let dynamicCallCount = 0;

for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  for (const match of source.matchAll(LITERAL)) {
    if (!used.has(match[1])) used.set(match[1], path.relative(ROOT, file));
  }
  dynamicCallCount += [...source.matchAll(DYNAMIC)].length;
}

const undefinedKeys = [...used].filter(([key]) => !(key in en) && !(`${key}_other` in en));
for (const [key, file] of undefinedKeys) {
  errors.push(`undefined key t('${key}') used in ${file}`);
}

const baseKeys = Object.keys(en);
const unusedKeys = baseKeys.filter((key) => !used.has(key));

// --- 4. hardcoded Thai text still in components -----------------------------
const THAI = /[฀-๿]/;
const hardcoded = [];
for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  lines.forEach((line, index) => {
    if (!THAI.test(line)) return;
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // comments are not UI
    hardcoded.push(`${path.relative(ROOT, file)}:${index + 1}`);
  });
}

// --- report -----------------------------------------------------------------
console.log('\n🌍 Translation audit\n');
console.log(`   locales          ${Object.keys(DICTIONARIES).join(', ')}`);
console.log(`   keys (${BASE})       ${baseKeys.length}`);
console.log(`   keys used        ${used.size} literal + ${dynamicCallCount} dynamic call site(s)`);
console.log(`   keys unused      ${unusedKeys.length}`);
console.log(`   hardcoded Thai   ${hardcoded.length} line(s) across components`);

if (unusedKeys.length) {
  console.log(`\n   ℹ️  defined but not referenced yet (${unusedKeys.length}):`);
  console.log(`      ${unusedKeys.slice(0, 20).join(', ')}${unusedKeys.length > 20 ? ` … +${unusedKeys.length - 20}` : ''}`);
}

if (hardcoded.length) {
  console.log(`\n   ℹ️  still untranslated (first 20):`);
  for (const location of hardcoded.slice(0, 20)) console.log(`      ${location}`);
}

if (warnings.length) {
  console.log(`\n   ⚠️  ${warnings.length} warning(s):`);
  for (const warning of warnings) console.log(`      ${warning}`);
}

if (errors.length) {
  console.log(`\n   ❌ ${errors.length} error(s):`);
  for (const error of errors) console.log(`      ${error}`);
  console.log('');
  process.exit(1);
}

console.log('\n   ✅ dictionaries are consistent and every referenced key exists.\n');
