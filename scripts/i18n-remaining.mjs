// List the distinct Thai strings still hardcoded, grouped by syntactic position,
// so the next codemod pass can be written against real data instead of guesses.
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'src');
const THAI = /[฀-๿]/;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { if (entry.name !== 'i18n') walk(full, out); }
    else if (/\.jsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const attrs = new Map();     // attr="ไทย"
const quoted = new Map();    // 'ไทย' or "ไทย"
const templates = new Map(); // `ไทย ${x}`
const children = new Map();  // >ไทย<

for (const file of walk(SRC)) {
  const source = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file);
  const add = (map, key) => { if (!map.has(key)) map.set(key, rel); };

  for (const m of source.matchAll(/([\w-]+)="([^"]*[฀-๿][^"]*)"/g)) add(attrs, `${m[1]}="${m[2]}"`);
  for (const m of source.matchAll(/'([^'\n]*[฀-๿][^'\n]*)'/g)) add(quoted, m[1]);
  for (const m of source.matchAll(/"([^"\n]*[฀-๿][^"\n]*)"/g)) add(quoted, m[1]);
  for (const m of source.matchAll(/`([^`]*[฀-๿][^`]*)`/g)) add(templates, m[1]);
  for (const m of source.matchAll(/>([^<>{}]*[฀-๿][^<>{}]*)</g)) add(children, m[1].trim());
}

const dump = (title, map) => {
  console.log(`\n### ${title} (${map.size})`);
  for (const [text, file] of map) console.log(`${file}\t${text}`);
};
dump('attributes', attrs);
dump('quoted literals', quoted);
dump('template literals', templates);
dump('jsx children', children);
