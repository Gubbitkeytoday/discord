#!/usr/bin/env node
// ============================================================================
//  Static-serving audit: caching + compression headers of what the Node
//  process sends for the SPA shell, hashed JS/CSS, uploads and API JSON.
//  Also reports raw / gzip / brotli sizes so the compression gap is concrete.
//
//  Usage: node scripts/perf/headers.mjs            (boots its own server)
//         PERF_BASE=https://chat.example.com node scripts/perf/headers.mjs
//  Output: $PERF_OUT/headers.json
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { bootServer, seedWorld, BASE, ROOT, writeJson } from './lib.mjs';

const external = process.env.PERF_BASE;
const base = external || BASE;
let srv; let world;
if (!external) {
  srv = await bootServer();
  world = await seedWorld({ messages: 60, channels: 2, authors: 2, imageEvery: 30 });
}

const assets = fs.readdirSync(path.join(ROOT, 'dist/assets'));
const mainJs = assets.find((f) => /^index-.*\.js$/.test(f));
const mainCss = assets.find((f) => /^index-.*\.css$/.test(f));
const msgs = world ? await world.viewer.get(`/api/messages/${world.long.id}?limit=50`) : [];
const upload = msgs.find((m) => m.avatar_url)?.avatar_url;

const targets = [
  ['/', 'SPA shell'],
  [`/assets/${mainJs}`, 'main JS (hashed)'],
  [`/assets/${mainCss}`, 'main CSS (hashed)'],
  upload && [upload, 'uploaded avatar'],
  world && [`/api/messages/${world.long.id}?limit=50`, 'API JSON (50 msgs)']
].filter(Boolean);

const rows = [];
for (const [url, label] of targets) {
  const headers = { 'Accept-Encoding': 'br, gzip, deflate, zstd' };
  if (world && url.startsWith('/api')) headers.Authorization = `Bearer ${world.viewer.token}`;
  const res = await fetch(base + url, { headers });
  const body = Buffer.from(await res.arrayBuffer()); // fetch decodes; we recompress to size it
  rows.push({
    label, url: url.length > 70 ? url.slice(0, 67) + '…' : url, status: res.status,
    cacheControl: res.headers.get('cache-control'),
    contentEncoding: res.headers.get('content-encoding') ?? '(none)',
    etag: Boolean(res.headers.get('etag')),
    vary: res.headers.get('vary'),
    rawBytes: body.length,
    gzipBytes: zlib.gzipSync(body, { level: 9 }).length,
    brotliBytes: zlib.brotliCompressSync(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length
  });
}
console.table(rows.map(({ url, ...r }) => r));
console.log('wrote', writeJson('headers.json', rows));
srv?.stop();
process.exit(0);
