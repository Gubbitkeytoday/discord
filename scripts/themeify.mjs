#!/usr/bin/env node
// One-off codemod: replace Tailwind arbitrary colour values with theme tokens.
//
//   bg-[#2b2d31]        -> bg-d-surface
//   border-[#1f2023]/40 -> border-d-edge/40
//   text-[#949ba4]      -> text-d-text3
//
// Only touches hexes inside Tailwind's [#...] brackets, so inline styles that
// carry per-role colours are left alone. Run with --check to see what would
// change without writing.

import fs from 'fs';
import path from 'path';

const MAP = {
  // surfaces
  '#1e1f22': 'd-base',
  '#1a1b1e': 'd-base2',
  '#090a0c': 'd-base3',
  '#111214': 'd-sunken',
  '#232428': 'd-panel',
  '#2b2d31': 'd-surface',
  '#313338': 'd-canvas',
  '#383a40': 'd-input',
  '#404249': 'd-active',
  '#35373c': 'd-hover',
  '#35363c': 'd-hover2',
  '#2e3035': 'd-rowhover',
  '#3f4147': 'd-divider',
  '#1f2023': 'd-edge',
  '#4e5058': 'd-control',
  '#3b3e45': 'd-control2',
  '#f2f3f5': 'd-invert',
  // text
  '#dbdee1': 'd-text',
  '#b5bac1': 'd-text2',
  '#949ba4': 'd-text3',
  '#80848e': 'd-text4',
  '#c9cdfb': 'd-mention',
  // brand + status: same in both themes, but tokenised so they are named
  '#5865f2': 'd-brand',
  '#4752c4': 'd-brandhover',
  '#3c45a5': 'd-brandactive',
  '#23a55a': 'd-online',
  '#f0b232': 'd-idle',
  '#f23f43': 'd-danger',
  '#00a8fc': 'd-link'
};

const check = process.argv.includes('--check');
const roots = ['src'];

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.(jsx?|tsx?)$/.test(entry.name)) yield full;
  }
}

let filesChanged = 0;
let replacements = 0;

for (const root of roots) {
  for (const file of walk(root)) {
    const original = fs.readFileSync(file, 'utf8');
    // Match `[#rrggbb]` and capture the hex; case-insensitive.
    const updated = original.replace(/\[(#[0-9a-fA-F]{6})\]/g, (match, hex) => {
      const token = MAP[hex.toLowerCase()];
      if (!token) return match;
      replacements += 1;
      return token;
    });

    if (updated !== original) {
      filesChanged += 1;
      if (!check) fs.writeFileSync(file, updated);
      console.log(`${check ? 'would update' : 'updated'} ${file}`);
    }
  }
}

console.log(
  `\n${check ? 'Would replace' : 'Replaced'} ${replacements} colour(s) across ${filesChanged} file(s).`
);
