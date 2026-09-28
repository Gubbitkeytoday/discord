#!/usr/bin/env node
// ============================================================================
//  Bundle composition audit.
//
//  Rebuilds the app with the project's own vite.config.js plus
//  rollup-plugin-visualizer (raw-data + treemap) into a scratch outDir — the
//  real dist/ and the app config are untouched — then reports:
//    - every emitted chunk: raw / gzip / brotli bytes
//    - the main entry chunk broken down by package and by top-level src folder
//    - lucide-react: how many icon modules made it in (tree-shaking check)
//    - duplicate packages (same name resolved from >1 path / version)
//
//  Setup:  npm i --no-save rollup-plugin-visualizer
//  Usage:  node scripts/perf/bundle.mjs
//  Output: $PERF_OUT/bundle.json, $PERF_OUT/bundle-treemap.html
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { build, loadConfigFromFile, mergeConfig } from 'vite';
import { ROOT, OUT, writeJson } from './lib.mjs';

let visualizer;
try { ({ visualizer } = await import('rollup-plugin-visualizer')); } catch {
  console.error('Run: npm i --no-save rollup-plugin-visualizer'); process.exit(2);
}

const outDir = path.join(OUT, 'bundle-dist');
const { config } = await loadConfigFromFile({ command: 'build', mode: 'production' }, path.join(ROOT, 'vite.config.js'));
await build(mergeConfig(config, {
  root: ROOT, logLevel: 'warn', configFile: false,
  build: { outDir, emptyOutDir: true, sourcemap: false, reportCompressedSize: false },
  plugins: [
    visualizer({ filename: path.join(OUT, 'bundle-raw.json'), template: 'raw-data', gzipSize: true, brotliSize: true }),
    visualizer({ filename: path.join(OUT, 'bundle-treemap.html'), template: 'treemap', gzipSize: true, brotliSize: true })
  ]
}));

const sizes = (buf) => ({
  raw: buf.length,
  gzip: zlib.gzipSync(buf, { level: 9 }).length,
  brotli: zlib.brotliCompressSync(buf).length
});
const chunks = fs.readdirSync(path.join(outDir, 'assets')).map((f) => ({ file: f, ...sizes(fs.readFileSync(path.join(outDir, 'assets', f))) }))
  .sort((a, b) => b.raw - a.raw);

// --- composition of the entry chunk from visualizer raw data ---------------
// Sizes are rollup's rendered (pre-minify) bytes: use them as proportions.
const raw = JSON.parse(fs.readFileSync(path.join(OUT, 'bundle-raw.json'), 'utf8'));
const { nodeParts, nodeMetas, tree } = raw;
const entryChunk = tree.children.find((c) => /index-.*\.js$/.test(c.name));
const leaves = [];
(function walk(n) { if (n.uid) leaves.push(n); for (const c of n.children ?? []) walk(c); })(entryChunk);
const byPkg = {}; const bySrc = {}; const lucide = new Set(); const pkgPaths = {};
let total = 0;
for (const leaf of leaves) {
  const part = nodeParts[leaf.uid];
  const meta = nodeMetas[part.metaUid];
  const id = meta.id;
  const len = part.renderedLength; total += len;
  const nm = id.lastIndexOf('node_modules/');
  if (nm >= 0) {
    const rest = id.slice(nm + 13).split('/');
    const pkg = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
    byPkg[pkg] = (byPkg[pkg] ?? 0) + len;
    (pkgPaths[pkg] ??= new Set()).add(id.slice(0, nm + 13 + pkg.length));
    if (pkg === 'lucide-react' && /icons\//.test(id)) lucide.add(id);
  } else {
    const rel = id.replace(ROOT + '/', '').replace(/^\0/, '').replace(/^\//, '');
    // Components and the big top-level files individually; the rest by folder.
    const key = /^src\/(components|i18n|utils|hooks)\//.test(rel) || /^src\/[^/]+$/.test(rel)
      ? rel.replace(/^src\/components\/settings\/.*/, 'src/components/settings/*')
      : rel.split('/').slice(0, 2).join('/');
    bySrc[key] = (bySrc[key] ?? 0) + len;
    byPkg['(app src)'] = (byPkg['(app src)'] ?? 0) + len;
  }
}
const top = (o, n) => Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ module: k, kB: +(v / 1024).toFixed(1), pct: +((v / total) * 100).toFixed(1) }));

// Duplicate packages across the whole graph (any chunk).
const allPaths = {};
for (const meta of Object.values(nodeMetas)) {
  const m = meta.id.replace(/^\0/, "").match(/^(.*node_modules\/)((?:@[^/]+\/)?[^/]+)/);
  if (m) (allPaths[m[2]] ??= new Set()).add(m[1] + m[2]);
}
const duplicates = Object.entries(allPaths).filter(([, s]) => s.size > 1).map(([k, s]) => ({ pkg: k, paths: [...s] }));

const report = {
  chunks,
  totals: {
    allJsRaw: chunks.filter((c) => c.file.endsWith('.js')).reduce((s, c) => s + c.raw, 0),
    initialJs: chunks.find((c) => /^index-.*\.js$/.test(c.file)),
    initialCss: chunks.find((c) => /^index-.*\.css$/.test(c.file))
  },
  entryRenderedBytes: total,
  entryByPackage: top(byPkg, 20),
  entryBySource: top(bySrc, 40),
  lucideIconModules: lucide.size,
  duplicates
};
console.table(chunks.slice(0, 6));
console.log('entry chunk by package'); console.table(report.entryByPackage);
console.log('entry chunk by source'); console.table(report.entryBySource.slice(0, 25));
console.log('lucide icon modules in entry:', lucide.size, 'duplicates:', duplicates.length);
console.log('wrote', writeJson('bundle.json', report), 'and', path.join(OUT, 'bundle-treemap.html'));
