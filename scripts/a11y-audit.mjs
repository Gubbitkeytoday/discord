#!/usr/bin/env node
// ============================================================================
//  Accessibility audit.
//
//  A screen-reader pass needs a human with NVDA or VoiceOver. What *can* be
//  automated is the set of failures that make a screen reader useless in the
//  first place: controls with no accessible name, invalid ARIA, images with no
//  alt text, and text that does not meet WCAG contrast.
//
//  Run against the built app:
//    npm run build && npm run a11y
// ============================================================================

import fs from 'fs';
import path from 'path';

const ROOT = 'src';
const problems = [];
const stats = { files: 0, buttons: 0, images: 0, inputs: 0 };

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (/\.jsx$/.test(entry.name)) yield full;
  }
}

/** Split a JSX file into individual element open-tags. */
function elements(source, tagName) {
  const found = [];
  const pattern = new RegExp(`<${tagName}\\b`, 'g');
  let match;
  while ((match = pattern.exec(source)) !== null) {
    // Scan forward to the matching '>' while respecting nested braces/strings.
    let depth = 0;
    let quote = null;
    let i = match.index + tagName.length + 1;
    for (; i < source.length; i += 1) {
      const char = source[i];
      if (quote) {
        if (char === quote && source[i - 1] !== '\\') quote = null;
        continue;
      }
      if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
      if (char === '{') depth += 1;
      else if (char === '}') depth -= 1;
      else if (char === '>' && depth === 0) break;
    }
    found.push({
      tag: source.slice(match.index, i + 1),
      line: source.slice(0, match.index).split('\n').length
    });
  }
  return found;
}

const has = (tag, attr) => new RegExp(`\\b${attr}\\s*=`).test(tag);

/**
 * Is the control on `line` nested inside a <label> or the codebase's
 * <Field label="..."> helper? Both give it a real accessible name.
 *
 * Counted over the whole preceding source rather than a fixed window: these
 * wrappers can open many lines above the control, and a window either misses
 * them (false positives) or reaches into an unrelated earlier wrapper (false
 * negatives).
 */
function insideLabel(source, line) {
  const upto = source.split('\n').slice(0, line).join('\n');
  let depth = 0;
  // `Labelled` is our own wrapper that renders a <label> around its children,
  // so a control inside one is associated the same way a native wrap would be.
  const pattern = /<(\/?)(label|Field|Labelled)\b([^>]*?)(\/?)>/g;
  let match;
  while ((match = pattern.exec(upto)) !== null) {
    const [, closing, , attrs, selfClosing] = match;
    if (closing) depth -= 1;
    else if (!selfClosing && !attrs.trimEnd().endsWith('/')) depth += 1;
  }
  return depth > 0;
}

// A button is named if it has text content, aria-label, title, or aria-labelledby.
// Text content is approximated by whether the tag is self-closing.
function auditFile(file) {
  // Deliberately NOT comment-stripped. A JSX-aware stripper has to know about
  // strings, template literals and regex literals to avoid eating real markup —
  // an earlier attempt here silently dropped six buttons from the scan, which
  // is a far worse failure than the occasional comment that trips a check.
  // Write comments so they do not quote an attribute verbatim.
  const source = fs.readFileSync(file, 'utf8');
  stats.files += 1;

  for (const { tag, line } of elements(source, 'button')) {
    stats.buttons += 1;
    const selfClosing = tag.trimEnd().endsWith('/>');
    const named = has(tag, 'aria-label') || has(tag, 'title') || has(tag, 'aria-labelledby');
    if (selfClosing && !named) {
      problems.push({ file, line, level: 'error', message: 'button has no accessible name' });
    }
  }

  for (const { tag, line } of elements(source, 'img')) {
    stats.images += 1;
    if (!has(tag, 'alt')) {
      problems.push({ file, line, level: 'error', message: 'img is missing alt' });
    }
  }

  // Every id referenced by a <label htmlFor=…> in this file. A literal
  // htmlFor="x" is matched against a literal id="x"; a dynamic htmlFor={expr}
  // is matched against id={expr} — the same expression on both sides is the
  // only way a generated id (useId, a prop) can be associated at all.
  const labelTargets = new Set([
    ...[...source.matchAll(/htmlFor=["']([^"']+)["']/g)].map((m) => m[1]),
    ...[...source.matchAll(/htmlFor=\{([^}]+)\}/g)].map((m) => `{${m[1].trim()}}`)
  ]);

  for (const tagName of ['input', 'textarea', 'select']) {
    for (const { tag, line } of elements(source, tagName)) {
      stats.inputs += 1;
      // `id` counts only when some <label htmlFor> in this file points at it —
      // an id on its own gives a screen reader nothing.
      const ownId = tag.match(/\bid=["']([^"']+)["']/)?.[1]
        ?? (tag.match(/\bid=\{([^}]+)\}/) ? `{${tag.match(/\bid=\{([^}]+)\}/)[1].trim()}` + '}' : undefined);
      const labelled = has(tag, 'aria-label') || has(tag, 'aria-labelledby')
        || has(tag, 'placeholder') || has(tag, 'title')
        || (ownId && labelTargets.has(ownId));

      if (!labelled && !insideLabel(source, line)) {
        problems.push({ file, line, level: 'error', message: `${tagName} has no label` });
      }
    }
  }

  // role="switch"/"radio"/"menuitem" need their state attribute.
  for (const [role, required] of [
    ['switch', 'aria-checked'], ['radio', 'aria-checked'], ['tab', 'aria-selected']
  ]) {
    const pattern = new RegExp(`role=["']${role}["']`, 'g');
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const line = source.slice(0, match.index).split('\n').length;
      const window = source.slice(Math.max(0, match.index - 400), match.index + 400);
      if (!new RegExp(`\\b${required}\\s*=`).test(window)) {
        problems.push({ file, line, level: 'error', message: `role="${role}" without ${required}` });
      }
    }
  }

  // A dialog must be labelled and marked modal.
  const dialogPattern = /role=["']dialog["']/g;
  let dialogMatch;
  while ((dialogMatch = dialogPattern.exec(source)) !== null) {
    const line = source.slice(0, dialogMatch.index).split('\n').length;
    const window = source.slice(Math.max(0, dialogMatch.index - 300), dialogMatch.index + 400);
    if (!/aria-modal/.test(window)) {
      problems.push({ file, line, level: 'warn', message: 'role="dialog" without aria-modal' });
    }
    if (!/aria-label/.test(window)) {
      problems.push({ file, line, level: 'warn', message: 'role="dialog" without a label' });
    }
  }
}

// --- contrast ---------------------------------------------------------------

const hexToRgb = (hex) => {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
  return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
};

const relativeLuminance = ([r, g, b]) => {
  const channel = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

const contrastRatio = (a, b) => {
  const la = relativeLuminance(hexToRgb(a));
  const lb = relativeLuminance(hexToRgb(b));
  const [light, dark] = la > lb ? [la, lb] : [lb, la];
  return (light + 0.05) / (dark + 0.05);
};

/**
 * Guard against a CSS property that quietly breaks every fixed overlay.
 *
 * `filter`, `transform`, `perspective`, `backdrop-filter`, `will-change` and
 * `contain: paint` all make an element a containing block for its
 * `position: fixed` descendants — the document root being the one exemption.
 * Put any of them on `body`, `#root` or a full-app wrapper and every modal,
 * toast, context menu and full-screen surface silently re-anchors to the page
 * instead of the viewport. It does not throw, it does not warn: overlays just
 * end up in the wrong place, or clipped off-screen entirely.
 *
 * This shipped once — a saturation filter on `body` — and clipped the login
 * card off the top of the window. It is cheap to never let it happen again.
 */
const CONTAINING_BLOCK_PROPS =
  /(?:^|[\s;{])(filter|transform|perspective|backdrop-filter|will-change)\s*:\s*(?!none\b|initial\b)([^;}]+)/;

const APP_ROOT_SELECTOR = /(^|,)\s*(?:[^,{]*\s)?(body|#root)\s*(?:$|,)/;

/**
 * A modal backdrop must centre its card. The convention here is
 * `fixed inset-0 ... flex items-center justify-center overlay-center`, where
 * `.overlay-center` (in index.css) makes a too-tall card scroll instead of
 * overflowing off-screen. Putting `overlay-center` on the *card* instead of
 * the backdrop leaves the card pinned to the top-left — which is exactly the
 * bug this catches, after it shipped once in the follow/forum/onboarding
 * dialogs.
 */
function auditOverlayCentring() {
  for (const file of walk(ROOT)) {
    const source = fs.readFileSync(file, 'utf8');
    const lines = source.split('\n');
    lines.forEach((line, index) => {
      const backdrop = /className="[^"]*\bfixed inset-0\b[^"]*"/.exec(line);
      if (backdrop) {
        const cls = backdrop[0];
        // A *scrolling* flex backdrop must say where its card goes: without an
        // alignment the card lands top-left. Backdrops that deliberately align
        // elsewhere (QuickSwitcher's items-start) or are full-bleed surfaces
        // rather than cards (Server Settings) are not dialogs-with-a-card and
        // are left alone.
        const aligned = /items-(center|start|end|stretch|baseline)/.test(cls);
        if (/\bflex\b/.test(cls) && /(?:^|["\s])overflow-y-auto(?:["\s]|$)/.test(cls) && !aligned) {
          problems.push({
            file: path.relative(process.cwd(), file), line: index + 1, level: 'error',
            message: 'modal backdrop is a flex container but does not centre its card '
              + '(add "items-center justify-center overlay-center")'
          });
        }
      }
      // `.overlay-center` belongs on the backdrop, never on the card itself.
      if (/className="[^"]*\boverlay-center\b/.test(line) && !/\bfixed inset-0\b/.test(line)) {
        problems.push({
          file: path.relative(process.cwd(), file), line: index + 1, level: 'error',
          message: 'overlay-center is on the dialog card; it belongs on the "fixed inset-0" backdrop'
        });
      }
    });
  }
}

function auditLayoutTraps() {
  const raw = fs.readFileSync('src/index.css', 'utf8');
  // Blank out comments while preserving newlines, so reported line numbers
  // stay true and a comment above a rule is not mistaken for its selector.
  const css = raw.replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '));

  // Walk rule by rule: selector up to `{`, then the declarations inside.
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = rulePattern.exec(css)) !== null) {
    const selector = match[1].trim().replace(/\s+/g, ' ');
    const body = match[2];
    if (!selector || selector.startsWith('@')) continue;  // at-rules, keyframes
    if (!APP_ROOT_SELECTOR.test(selector)) continue;      // only body / #root matter

    const offending = CONTAINING_BLOCK_PROPS.exec(body);
    if (!offending) continue;

    const line = css.slice(0, match.index + match[1].length).split('\n').length;
    problems.push({
      file: 'src/index.css',
      line,
      level: 'error',
      message:
        `"${selector}" sets ${offending[1]} — that makes it a containing block ` +
        'for position:fixed descendants, which silently re-anchors every modal, ' +
        'toast and full-screen surface to the page instead of the viewport. ' +
        'Move it to :root, which the spec exempts.'
    });
  }
}

/** Pull the theme token values straight out of index.css. */
function readTokens() {
  const css = fs.readFileSync('src/index.css', 'utf8');
  const parse = (block) => {
    const tokens = {};
    for (const [, name, value] of block.matchAll(/--color-(d-[\w-]+):\s*(#[0-9a-fA-F]{3,6})/g)) {
      tokens[name] = value;
    }
    return tokens;
  };
  const themeBlock = css.slice(css.indexOf('@theme'), css.indexOf('[data-theme="light"]'));
  // Stop at the closing brace of the light rule — other theme blocks follow it
  // in the stylesheet and would otherwise overwrite the tokens we just read.
  const lightStart = css.indexOf('[data-theme="light"]');
  const lightEnd = css.indexOf('\n}', lightStart);
  const lightBlock = css.slice(lightStart, lightEnd === -1 ? undefined : lightEnd);
  const dark = parse(themeBlock);
  return { dark, light: { ...dark, ...parse(lightBlock) } };
}

// Text/background pairs that actually occur in the UI.
const CONTRAST_PAIRS = [
  ['d-text', 'd-canvas', 4.5, 'message body on chat background'],
  ['d-text', 'd-surface', 4.5, 'body text on sidebar'],
  ['d-text2', 'd-surface', 4.5, 'secondary text on sidebar'],
  ['d-text3', 'd-surface', 4.5, 'muted text on sidebar'],
  ['d-text3', 'd-canvas', 4.5, 'muted text on chat background'],
  ['d-strong', 'd-canvas', 4.5, 'headings on chat background'],
  ['d-strong', 'd-surface', 4.5, 'headings on sidebar'],
  ['d-text4', 'd-surface', 3.0, 'faint text (large/decorative)'],
  ['d-link', 'd-canvas', 3.0, 'links on chat background']
];

function auditContrast() {
  const themes = readTokens();
  for (const [themeName, tokens] of Object.entries(themes)) {
    for (const [fg, bg, minimum, description] of CONTRAST_PAIRS) {
      if (!tokens[fg] || !tokens[bg]) continue;
      const ratio = contrastRatio(tokens[fg], tokens[bg]);
      if (ratio < minimum) {
        problems.push({
          file: 'src/index.css',
          line: 0,
          level: ratio < minimum - 1 ? 'error' : 'warn',
          message: `${themeName}: ${description} — ${ratio.toFixed(2)}:1 `
                 + `(needs ${minimum}:1) ${tokens[fg]} on ${tokens[bg]}`
        });
      }
    }
  }
}

// --- run --------------------------------------------------------------------

for (const file of walk(ROOT)) auditFile(file);
auditContrast();
auditLayoutTraps();
auditOverlayCentring();

const errors = problems.filter((p) => p.level === 'error');
const warnings = problems.filter((p) => p.level === 'warn');

console.log(
  `\nScanned ${stats.files} components: `
  + `${stats.buttons} buttons, ${stats.images} images, ${stats.inputs} form controls\n`
);

for (const group of [['ERROR', errors], ['WARN', warnings]]) {
  const [label, list] = group;
  if (list.length === 0) continue;
  console.log(`${label} (${list.length})`);
  for (const problem of list) {
    console.log(`  ${problem.file}:${problem.line}  ${problem.message}`);
  }
  console.log();
}

if (errors.length === 0 && warnings.length === 0) {
  console.log('No accessibility problems found.\n');
}

console.log(
  'Note: this covers accessible names, ARIA state, alt text and WCAG contrast.\n'
  + 'It cannot replace a pass with a real screen reader.\n'
);

process.exit(errors.length > 0 ? 1 : 0);
