#!/usr/bin/env node
// Generate distinct small PNGs for the upload scenario (k6 cannot synthesise
// images itself). Default 320×240 noise-over-gradient ≈ 150–230 KB each.
//
//   node scripts/load/gen-images.mjs --dir /tmp/lt/img --count 300 [--w 320 --h 240]
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs, makePng } from './lib.mjs';

const args = parseArgs(undefined, { dir: 'img', count: 100, w: 320, h: 240 });
fs.mkdirSync(args.dir, { recursive: true });
let bytes = 0;
for (let i = 0; i < args.count; i += 1) {
  const png = makePng(args.w, args.h, i + 1);
  bytes += png.length;
  fs.writeFileSync(path.join(args.dir, `img-${i}.png`), png);
}
console.log(`${args.count} PNGs in ${args.dir}, avg ${(bytes / args.count / 1024).toFixed(1)} KB`);
