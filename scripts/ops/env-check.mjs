#!/usr/bin/env node
// ============================================================================
//  .env.example is the single list of configuration.
//
//    node scripts/ops/env-check.mjs            check: every variable the code
//                                              reads appears in .env.example
//                                              and DEPLOYMENT.md's reference
//                                              table is current (exit 1 if not)
//    node scripts/ops/env-check.mjs --write    regenerate that table in place
//    node scripts/ops/env-check.mjs --markdown print the table
//
//  "Reads" = process.env.X / env.X / env['X'] / envInt('X') in the server,
//  its libraries and the operator scripts, plus ${X} in docker-compose.yml.
//  The table lives between <!-- env-reference:start --> and :end markers in
//  DEPLOYMENT.md and is built from .env.example's sections and comments.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXAMPLE = path.join(ROOT, '.env.example');
const DEPLOYMENT = path.join(ROOT, 'DEPLOYMENT.md');
const START = '<!-- env-reference:start -->';
const END = '<!-- env-reference:end -->';

// Set by the tooling itself, never by an operator.
const IGNORE = new Set([
  'NODE_TEST_CONTEXT',                                        // node --test
  'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE', 'PGSSLMODE' // backup.mjs → pg_dump child env
]);

const SOURCES = [
  'server.js', 'realtime.js', 'db.js', 'storageService.js', 'vite.config.js',
  'lib', 'services', 'routes', 'db',
  'scripts/backup.mjs', 'scripts/storage.js', 'scripts/push-keys.mjs',
  'scripts/migrate-sqlite-to-postgres.mjs', 'scripts/example-bot.mjs'
];

function* walk(rel) {
  const full = path.join(ROOT, rel);
  if (!fs.existsSync(full)) return;
  if (fs.statSync(full).isDirectory()) {
    for (const entry of fs.readdirSync(full)) yield* walk(path.join(rel, entry));
  } else if (/\.(m?js|cjs)$/.test(rel)) {
    yield rel;
  }
}

/** Variable name -> first file that reads it. */
export function variablesInCode() {
  const found = new Map();
  const add = (name, file) => { if (!IGNORE.has(name) && !found.has(name)) found.set(name, file); };
  const patterns = [
    /\b(?:process\.env|env)\.([A-Z][A-Z0-9_]+)\b(?!\s*=[^=])/g,
    /\b(?:process\.env|env)\[['"]([A-Z][A-Z0-9_]+)['"]\]/g,
    /\benv(?:Int|Num|Bool|Str|List)?\(\s*['"]([A-Z][A-Z0-9_]+)['"]/g
  ];
  for (const source of SOURCES) {
    for (const file of walk(source)) {
      const text = fs.readFileSync(path.join(ROOT, file), 'utf8');
      for (const re of patterns) for (const m of text.matchAll(re)) add(m[1], file);
    }
  }
  const compose = fs.readFileSync(path.join(ROOT, 'docker-compose.yml'), 'utf8')
    .split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  for (const m of compose.matchAll(/\$\{([A-Z][A-Z0-9_]+)/g)) add(m[1], 'docker-compose.yml');
  return found;
}

/** Parse .env.example into [{ section, name, value, active, description }]. */
export function parseExample(text = fs.readFileSync(EXAMPLE, 'utf8')) {
  const entries = [];
  let section = 'General';
  let comment = [];
  let lastWasVar = false;
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const heading = line.match(/^#\s*---\s*(.+?)\s*-{3,}\s*$/);
    if (heading) { section = heading[1]; comment = []; lastWasVar = false; continue; }
    const v = line.match(/^(#\s?)?([A-Z][A-Z0-9_]+)=(.*)$/);
    if (v) {
      let value = v[3];
      let trailing = '';
      const hash = value.search(/\s{2,}#\s/);
      if (hash !== -1) { trailing = value.slice(hash).replace(/^\s*#\s*/, ''); value = value.slice(0, hash); }
      entries.push({
        section,
        name: v[2],
        value: value.trim().replace(/^"(.*)"$/, '$1'),
        active: !v[1],
        description: trailing || (lastWasVar ? '' : comment.join(' ')),
        sharesAbove: !trailing && lastWasVar
      });
      lastWasVar = true;
      continue;
    }
    if (/^#/.test(line) && !/^#\s*=+\s*$/.test(line)) {
      if (lastWasVar) { comment = []; lastWasVar = false; }
      comment.push(line.replace(/^#\s?/, '').trim());
    } else if (!line.trim()) {
      comment = [];
      lastWasVar = false;
    }
  }
  return entries;
}

const cell = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();

export function markdownTable(entries = parseExample()) {
  const out = [
    START,
    '<!-- Generated from .env.example by `node scripts/ops/env-check.mjs --write`. Edit .env.example, not this table. -->',
    ''
  ];
  let section = null;
  for (const e of entries) {
    if (e.section !== section) {
      section = e.section;
      out.push('', `**${cell(section)}**`, '', '| Variable | Example / default | Notes |', '| --- | --- | --- |');
    }
    const value = e.value ? `\`${cell(e.value)}\`` : '';
    const notes = e.sharesAbove ? '↑ same group as above' : cell(e.description);
    out.push(`| \`${e.name}\`${e.active ? '' : ''} | ${value} | ${notes} |`);
  }
  out.push('', END);
  return out.join('\n');
}

function main() {
  const args = new Set(process.argv.slice(2));
  const entries = parseExample();
  const documented = new Set(entries.map((e) => e.name));
  const table = markdownTable(entries);

  if (args.has('--markdown')) { process.stdout.write(`${table}\n`); return; }

  const deployment = fs.readFileSync(DEPLOYMENT, 'utf8');
  const a = deployment.indexOf(START);
  const b = deployment.indexOf(END);
  if (a === -1 || b === -1) {
    console.error(`DEPLOYMENT.md has no ${START} … ${END} block.`);
    process.exit(1);
  }
  const next = deployment.slice(0, a) + table + deployment.slice(b + END.length);

  if (args.has('--write')) {
    fs.writeFileSync(DEPLOYMENT, next);
    console.log(`DEPLOYMENT.md: environment reference regenerated (${entries.length} variables).`);
    return;
  }

  let failed = false;
  const missing = [...variablesInCode()].filter(([name]) => !documented.has(name));
  if (missing.length) {
    failed = true;
    console.error('Read by the code but missing from .env.example:');
    for (const [name, file] of missing) console.error(`  ${name}  (${file})`);
  }
  if (next !== deployment) {
    failed = true;
    console.error('DEPLOYMENT.md environment reference is stale: run node scripts/ops/env-check.mjs --write');
  }
  if (failed) process.exit(1);
  console.log(`env ok: ${documented.size} variables documented, DEPLOYMENT.md reference current.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
