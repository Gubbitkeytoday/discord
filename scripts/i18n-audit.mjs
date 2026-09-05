// ============================================================================
//  Translation audit.
//
//  Three things can silently break an internationalised UI, and none of them is
//  a build error:
//    1. a key present in one dictionary but missing from the other
//    2. a placeholder ({name}) that exists in one translation but not the other
//    3. a t('key') call in a component that no dictionary defines
//  This script fails the process on 1 and 3, warns on 2, and reports the amount
//  of Thai text still hardcoded in components so the remaining work is visible.
//
//  Usage: node scripts/i18n-audit.mjs
// ============================================================================
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'src');

const th = (await import(`file://${path.join(SRC, 'i18n/th.js')}`)).default;
const en = (await import(`file://${path.join(SRC, 'i18n/en.js')}`)).default;

const DICTIONARIES = { th, en };
const BASE = 'en'; // English is the reference: every other locale is measured against it.

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

// --- 1. key parity ----------------------------------------------------------
const baseKeys = Object.keys(DICTIONARIES[BASE]);
const errors = [];
const warnings = [];

for (const [locale, dict] of Object.entries(DICTIONARIES)) {
  if (locale === BASE) continue;
  const keys = new Set(Object.keys(dict));
  const missing = baseKeys.filter((key) => !keys.has(key));
  const extra = [...keys].filter((key) => !baseKeys.includes(key));
  if (missing.length) errors.push(`${locale}: ${missing.length} key(s) missing → ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ' …' : ''}`);
  if (extra.length) errors.push(`${locale}: ${extra.length} key(s) not in ${BASE} → ${extra.slice(0, 8).join(', ')}${extra.length > 8 ? ' …' : ''}`);
}

// --- 2. placeholder parity --------------------------------------------------
const placeholders = (text) => new Set(String(text).match(/\{(\w+)\}/g) ?? []);

for (const key of baseKeys) {
  const reference = placeholders(DICTIONARIES[BASE][key]);
  for (const [locale, dict] of Object.entries(DICTIONARIES)) {
    if (locale === BASE || !(key in dict)) continue;
    const found = placeholders(dict[key]);
    const diff = [...reference].filter((p) => !found.has(p))
      .concat([...found].filter((p) => !reference.has(p)));
    if (diff.length) warnings.push(`${locale} "${key}": placeholder mismatch (${diff.join(', ')})`);
  }
}

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

const undefinedKeys = [...used].filter(([key]) => !(key in DICTIONARIES[BASE]));
for (const [key, file] of undefinedKeys) {
  errors.push(`undefined key t('${key}') used in ${file}`);
}

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
