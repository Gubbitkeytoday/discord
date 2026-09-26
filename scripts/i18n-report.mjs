// ============================================================================
//  Per-locale translation report.
//
//    npm run i18n:report                 table of every locale
//    npm run i18n:report -- --write      also refresh src/i18n/locales/_meta.json
//                                        (completeness % shown in the picker)
//    npm run i18n:report -- --json       machine-readable
//    npm run i18n:report -- --locale de  list de's missing / extra / identical keys
//
//  Informational only: exits non-zero just when a dictionary fails to load.
//  The pass/fail gate is scripts/i18n-audit.mjs.
// ============================================================================
import fs from 'fs';
import path from 'path';
import { ROOT, META_FILE, LOCALE_REGISTRY, loadDictionaries, analyse } from './i18n-lib.mjs';

const args = process.argv.slice(2);
const WRITE = args.includes('--write');
const JSON_OUT = args.includes('--json');
const only = args.includes('--locale') ? args[args.indexOf('--locale') + 1] : null;

const loaded = await loadDictionaries();
const en = loaded.find((d) => d.name === 'en').dict;
const rows = [];
let failed = false;

for (const { name, dict, error } of loaded) {
  if (error) { failed = true; rows.push({ name, error }); continue; }
  const r = analyse(dict, en);
  rows.push({
    name,
    keys: r.keys,
    missing: r.missing.length,
    extra: r.extra.length,
    placeholders: r.placeholderMismatches.length,
    identical: name === 'en' ? 0 : r.identical.length,
    completeness: name === 'en' ? 100 : r.completeness,
    detail: r
  });
}

// Registry locales that have no file yet.
const present = new Set(loaded.map((d) => d.name));
const absent = [...new Set(LOCALE_REGISTRY.map((e) => e.dictionary))].filter((d) => !present.has(d));

if (WRITE) {
  const meta = {};
  for (const row of rows) if (!row.error && row.name !== 'en') meta[row.name] = row.completeness;
  fs.mkdirSync(path.dirname(META_FILE), { recursive: true });
  fs.writeFileSync(META_FILE, `${JSON.stringify(meta, null, 2)}\n`);
}

if (JSON_OUT) {
  console.log(JSON.stringify({
    locales: rows.map(({ detail, ...rest }) => rest),
    notYetTranslated: absent
  }, null, 2));
} else if (only) {
  const row = rows.find((r) => r.name === only);
  if (!row) { console.error(`No dictionary named ${only}`); process.exit(1); }
  if (row.error) { console.error(`${only}: ${row.error}`); process.exit(1); }
  const d = row.detail;
  console.log(`\n${only}: ${row.completeness}% translated, ${row.keys} keys`);
  for (const [label, list] of [['missing', d.missing], ['extra', d.extra], ['identical to English', d.identical]]) {
    console.log(`\n  ${label} (${list.length})`);
    for (const key of list) console.log(`    ${key}${label.startsWith('identical') ? `  = ${JSON.stringify(en[key])}` : ''}`);
  }
  if (d.placeholderMismatches.length) {
    console.log(`\n  placeholder mismatches (${d.placeholderMismatches.length})`);
    for (const { key, diff } of d.placeholderMismatches) console.log(`    ${key}  ${diff.join(' ')}`);
  }
} else {
  const pad = (v, n) => String(v).padStart(n);
  console.log(`\n🌍 Translation report  (${Object.keys(en).length} source keys)\n`);
  console.log('   locale   done   keys  missing  extra  {ph}  same-as-en');
  for (const r of rows) {
    if (r.error) { console.log(`   ${r.name.padEnd(7)}  ❌ ${r.error}`); continue; }
    console.log(`   ${r.name.padEnd(7)} ${pad(r.completeness, 4)}% ${pad(r.keys, 6)} ${pad(r.missing, 8)} ${pad(r.extra, 6)} ${pad(r.placeholders, 5)} ${pad(r.identical, 11)}`);
  }
  if (absent.length) console.log(`\n   not yet present: ${absent.join(', ')}`);
  if (WRITE) console.log(`\n   wrote ${path.relative(ROOT, META_FILE)}`);
  console.log('');
}

process.exit(failed ? 1 : 0);
