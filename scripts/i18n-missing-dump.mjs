// Print, as JSON, every English key some locale is missing, with its English
// text (for translators). Usage: node scripts/i18n-missing-dump.mjs [locale]
import { loadDictionaries, analyse } from './i18n-lib.mjs';

const only = process.argv[2];
const loaded = await loadDictionaries();
const en = loaded.find((d) => d.name === 'en').dict;
const union = new Map();
const per = {};
for (const { name, dict } of loaded) {
  if (name === 'en' || !dict || (only && name !== only)) continue;
  const { missing } = analyse(dict, en);
  per[name] = missing.length;
  for (const key of missing) union.set(key, en[key]);
}
console.log(JSON.stringify({ per, keys: Object.fromEntries(union) }, null, 1));
