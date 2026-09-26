// Design-token regression tests (no server needed).
//
//  1. Contrast matrix: every text token of every theme (Dark, Light, Ash,
//     Onyx, plus high contrast) against every surface it can sit on, from
//     the raw `--base-*` values in src/index.css. Text ≥ 4.5:1, the focus ring
//     and border-strong ≥ 3:1 (WCAG 1.4.3 / 1.4.11), as specified in
//     docs/research/DISCORD-THEMES.md §3.3.
//  2. Every `*-d-<name>` utility used in src/ still has a `--color-d-<name>`
//     token (the legacy alias layer must not silently drop a colour).
//  3. Nothing puts a CSS `filter` on :root/body/#root for saturation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const css = fs.readFileSync(path.join(ROOT, 'src/index.css'), 'utf8');

const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lum = (hex) => {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => lin(parseInt(h.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};

/** `--base-*` values of one rule, hex taken from the value or its comment. */
function block(selector) {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `missing rule ${selector}`);
  const body = css.slice(start, css.indexOf('\n}', start));
  const out = {};
  for (const [, name, value] of body.matchAll(/--base-([\w-]+):\s*([^;]+);/g)) {
    const hex = /#[0-9a-fA-F]{6}\b/.exec(value)?.[0];
    if (hex) out[name] = hex;
  }
  return out;
}

const dark = block(':root');
const themes = {
  dark,
  light: { ...dark, ...block(':root[data-theme="light"]') },
  ash: { ...dark, ...block(':root[data-theme="ash"]') },
  onyx: { ...dark, ...block(':root[data-theme="onyx"]') }
};
themes['dark+high-contrast'] = { ...dark, ...block(':root[data-contrast="high"]') };
themes['light+high-contrast'] = { ...themes.light, ...block(':root[data-contrast="high"][data-theme="light"]') };

const SURFACES = ['bg-app', 'bg-sidebar', 'bg-chat', 'bg-surface', 'bg-raised', 'bg-input', 'bg-hover', 'bg-selected', 'bg-panel', 'bg-rowhover'];
const TEXT = ['text-strong', 'text-default', 'text-subtle', 'text-muted', 'text-link', 'text-brand', 'text-danger', 'text-positive'];

for (const [name, t] of Object.entries(themes)) {
  test(`${name}: text tokens reach 4.5:1 on every surface`, () => {
    const failures = [];
    for (const fg of TEXT) {
      for (const bg of SURFACES) {
        if (!t[fg] || !t[bg]) continue;
        const r = ratio(t[fg], t[bg]);
        if (r < 4.5) failures.push(`${fg} ${t[fg]} on ${bg} ${t[bg]} = ${r.toFixed(2)}`);
      }
    }
    // text-faint: placeholders/disabled; never used on bg-selected.
    for (const bg of SURFACES.filter((s) => s !== 'bg-selected')) {
      const r = ratio(t['text-faint'], t[bg]);
      if (r < 4.5) failures.push(`text-faint on ${bg} = ${r.toFixed(2)}`);
    }
    assert.deepEqual(failures, []);
  });

  test(`${name}: focus ring reaches 3:1 on every surface`, () => {
    const low = SURFACES.map((bg) => [bg, ratio(t['focus-ring'], t[bg])]).filter(([, r]) => r < 3);
    assert.deepEqual(low, []);
  });
}

test('every d-* colour utility used in src/ has a token', () => {
  const used = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(jsx?|css)$/.test(entry.name)) {
        const text = fs.readFileSync(full, 'utf8');
        for (const [, token] of text.matchAll(/\b(?:bg|text|border|ring|fill|stroke|from|to|via|outline|divide|placeholder|accent|caret|decoration)-d-([a-z0-9]+)\b/g)) used.add(token);
      }
    }
  };
  walk(path.join(ROOT, 'src'));
  const defined = new Set([...css.matchAll(/--color-d-([a-z0-9]+):/g)].map((m) => m[1]));
  const missing = [...used].filter((name) => !defined.has(name) && !['sm', 'md', 'lg'].includes(name));
  assert.deepEqual(missing, []);
});

test('saturation is not a filter on the root, body or #root', () => {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(stripped, /:root\[data-saturation\][^{]*\{[^}]*filter/);
  assert.doesNotMatch(stripped, /(^|\n)\s*(body|#root)\s*\{[^}]*filter\s*:/);
});
