#!/usr/bin/env node
// Second codemod pass: make `text-white` theme-aware.
//
// In dark mode white text is correct everywhere. In light mode it is only
// correct on top of a saturated brand/status background — on a neutral surface
// it becomes invisible. So: replace `text-white` with the `d-strong` token
// (white in dark, near-black in light) EXCEPT inside class strings that also
// paint a coloured background.

import fs from 'fs';
import path from 'path';

// Backgrounds that stay dark/saturated in both themes, so white text is right.
const COLOURED_BG = [
  'bg-d-brand', 'bg-d-brandhover', 'bg-d-brandactive',
  'bg-d-danger', 'bg-d-dangerhover', 'bg-d-success', 'bg-d-successhover',
  'bg-d-online', 'bg-d-idle', 'bg-d-mint', 'bg-black', 'bg-red', 'bg-indigo',
  'bg-emerald', 'bg-amber'
];

const check = process.argv.includes('--check');

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.jsx?$/.test(entry.name)) yield full;
  }
}

let files = 0;
let swapped = 0;
let kept = 0;

for (const file of walk('src')) {
  const original = fs.readFileSync(file, 'utf8');

  // Operate on whole quoted/backticked chunks so the decision has context.
  const updated = original.replace(/(['"`])((?:[^'"`\\]|\\.)*?)\1/gs, (match, quote, body) => {
    if (!body.includes('text-white')) return match;

    const isColoured = COLOURED_BG.some((bg) => body.includes(bg));
    if (isColoured) {
      kept += body.split('text-white').length - 1;
      return match;
    }
    swapped += body.split('text-white').length - 1;
    return `${quote}${body.replaceAll('text-white', 'text-d-strong')}${quote}`;
  });

  if (updated !== original) {
    files += 1;
    if (!check) fs.writeFileSync(file, updated);
  }
}

console.log(
  `${check ? 'would swap' : 'swapped'} ${swapped} text-white -> text-d-strong; ` +
  `kept ${kept} on coloured backgrounds; ${files} file(s)`
);
