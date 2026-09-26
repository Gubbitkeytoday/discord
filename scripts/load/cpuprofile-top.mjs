#!/usr/bin/env node
// Summarise a V8 .cpuprofile (from `node --cpu-prof`) without DevTools.
//
//   node scripts/load/cpuprofile-top.mjs <file.cpuprofile> [--top 25] [--from-ms 0]
//
// Prints the hottest functions by self time and by inclusive (total) time, and
// self time grouped by source file — enough to see whether the process is busy
// in app code, socket.io/engine.io serialisation, sqlite glue or GC.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from './lib.mjs';

const file = process.argv[2];
const args = parseArgs(process.argv.slice(3), { top: 25, fromMs: 0 });
const prof = JSON.parse(fs.readFileSync(file, 'utf8'));

const byId = new Map(prof.nodes.map((n) => [n.id, n]));
const parent = new Map();
for (const n of prof.nodes) for (const c of n.children ?? []) parent.set(c, n.id);

const short = (url) => {
  if (!url) return '(native)';
  const u = url.replace(/^file:\/\//, '');
  const nm = u.lastIndexOf('node_modules/');
  if (nm >= 0) return u.slice(nm + 13);
  const cwd = process.cwd() + path.sep;
  return u.startsWith(cwd) ? u.slice(cwd.length) : u.replace(/^node:/, 'node:');
};
const label = (n) => {
  const cf = n.callFrame;
  return `${cf.functionName || '(anonymous)'}  ${short(cf.url)}:${cf.lineNumber + 1}`;
};

const self = new Map(); const total = new Map(); const byFile = new Map();
let elapsed = 0; let counted = 0;
for (let i = 0; i < prof.samples.length; i += 1) {
  const dt = (prof.timeDeltas[i] ?? 0) / 1000;   // µs → ms
  elapsed += dt;
  if (elapsed < args.fromMs) continue;
  counted += dt;
  const node = byId.get(prof.samples[i]);
  const key = label(node);
  self.set(key, (self.get(key) ?? 0) + dt);
  const f = ['(idle)', '(program)', '(garbage collector)'].includes(node.callFrame.functionName)
    ? node.callFrame.functionName : short(node.callFrame.url);
  byFile.set(f, (byFile.get(f) ?? 0) + dt);
  const seen = new Set();
  for (let id = node.id; id !== undefined; id = parent.get(id)) {
    const k = label(byId.get(id));
    if (seen.has(k)) continue;
    seen.add(k);
    total.set(k, (total.get(k) ?? 0) + dt);
  }
}

const idle = self.get([...self.keys()].find((k) => k.startsWith('(idle)')) ?? '') ?? 0;
const busy = counted - idle;
const pct = (ms, of = busy) => `${((ms / of) * 100).toFixed(1).padStart(5)}%`;
const table = (title, map, n, skip = () => false) => {
  console.log(`\n${title}`);
  [...map.entries()].filter(([k]) => !skip(k)).sort((a, b) => b[1] - a[1]).slice(0, n)
    .forEach(([k, ms]) => console.log(`${pct(ms)} ${String(Math.round(ms)).padStart(8)} ms  ${k}`));
};

console.log(`profile: ${(counted / 1000).toFixed(1)} s sampled, busy ${(busy / 1000).toFixed(1)} s (${pct(busy, counted).trim()} of wall; % below are of busy time)`);
table('Self time by file', byFile, 15, (k) => k === '(idle)');
table('Top functions by self time', self, args.top, (k) => k.startsWith('(idle)'));
table('Top functions by inclusive time', total, args.top,
  (k) => k.startsWith('(root)') || k.startsWith('(idle)') || k.startsWith('(program)'));
