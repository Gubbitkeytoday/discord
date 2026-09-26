#!/usr/bin/env node
// ============================================================================
//  Rasterise public/favicon.svg into the PWA icon set (public/icons/*.png).
//
//    icon-192.png / icon-512.png         "any" purpose, rounded tile as-is
//    maskable-192.png / maskable-512.png full-bleed background, glyph inside
//                                        the 80 % safe zone (any mask shape)
//    apple-touch-icon.png (180)          iOS home screen (no transparency)
//    badge-72.png                        monochrome glyph for the Android
//                                        status-bar badge (alpha only)
//
//  Needs `sharp` (an optionalDependency). Run after changing favicon.svg:
//    node scripts/generate-pwa-icons.mjs
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'public', 'icons');
const svg = fs.readFileSync(path.join(ROOT, 'public', 'favicon.svg'), 'utf8');

let sharp;
try { ({ default: sharp } = await import('sharp')); } catch {
  console.error('sharp is not installed (npm i sharp)');
  process.exit(1);
}

// Pull the tile colour and the glyph out of the favicon, so the variants stay
// in sync with it.
const brand = /<rect[^>]*fill="([^"]+)"/.exec(svg)?.[1] ?? '#5865f2';
const inner = svg.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<rect[^>]*\/>/, '');

// Glyph bounds in the 64-unit favicon: x 14..50, y 20..49 → centre (32, 34.5).
const maskable = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" fill="${brand}"/>
  <g transform="translate(32 32) scale(0.78) translate(-32 -34.5)">${inner}</g>
</svg>`;
const apple = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" fill="${brand}"/>
  <g transform="translate(32 32) scale(0.9) translate(-32 -34.5)">${inner}</g>
</svg>`;
// Alpha-only badge: the bubble, with the two eyes cut out.
const glyphPath = /<path[^>]*d="([^"]+)"/.exec(svg)?.[1];
const badge = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="12 16 40 40">
  <defs><mask id="m"><rect x="0" y="0" width="64" height="64" fill="#fff"/>
    <circle cx="26" cy="31" r="3" fill="#000"/><circle cx="38" cy="31" r="3" fill="#000"/></mask></defs>
  <path d="${glyphPath}" fill="#fff" mask="url(#m)"/>
</svg>`;

const render = (source, size, file, { flatten = false } = {}) => {
  let img = sharp(Buffer.from(source), { density: Math.ceil((size / 64) * 72 * 2) }).resize(size, size);
  if (flatten) img = img.flatten({ background: brand });
  return img.png({ compressionLevel: 9 }).toFile(path.join(OUT, file));
};

fs.mkdirSync(OUT, { recursive: true });
await render(svg, 192, 'icon-192.png');
await render(svg, 512, 'icon-512.png');
await render(maskable, 192, 'maskable-192.png');
await render(maskable, 512, 'maskable-512.png');
await render(apple, 180, 'apple-touch-icon.png', { flatten: true });
await render(badge, 72, 'badge-72.png');
// Shortcut icons: plain tiles are enough for the launcher menu.
await render(maskable, 96, 'shortcut-96.png');
for (const f of fs.readdirSync(OUT)) console.log(`  ${f}  ${fs.statSync(path.join(OUT, f)).size} B`);
