#!/usr/bin/env node
// ============================================================================
//  Offline JSX sanity check.
//
//  A real bundler is the authority on whether the client compiles, but it needs
//  the npm registry. This catches the mistakes that actually happen when files
//  are edited in bulk — unbalanced JSX tags, unbalanced brackets, imports that
//  point at files which do not exist, and identifiers used without an import —
//  without downloading anything.
// ============================================================================

import fs from 'fs';
import path from 'path';

const ROOT = 'src';
const problems = [];
let scanned = 0;

/** Strip strings, template literals and comments so brackets inside them do not count. */
function strip(source) {
  let out = '';
  let i = 0;
  let prevMeaningful = '';
  const n = source.length;
  while (i < n) {
    const two = source.slice(i, i + 2);
    if (two === '//') { while (i < n && source[i] !== '\n') i += 1; continue; }
    if (two === '/*') { i += 2; while (i < n && source.slice(i, i + 2) !== '*/') i += 1; i += 2; continue; }
    const ch = source[i];
    // Regex literal: everything inside is text, including brackets and '<'.
    if (ch === '/' && /[([{=,:;!&|?+\-*%~^]|^$|\breturn$|\bcase$/.test(prevMeaningful)) {
      i += 1;
      let inClass = false;
      while (i < n) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === '[') inClass = true;
        else if (source[i] === ']') inClass = false;
        else if (source[i] === '/' && !inClass) break;
        else if (source[i] === '\n') break;   // not a regex after all
        i += 1;
      }
      i += 1;
      while (i < n && /[a-z]/.test(source[i])) i += 1;   // flags
      out += '/RE/';
      prevMeaningful = '/';
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      while (i < n && source[i] !== quote) { if (source[i] === '\\') i += 1; i += 1; }
      i += 1;
      out += '""';
      prevMeaningful = '"';
      continue;
    }
    if (ch === '`') {
      // Template literal: keep ${...} because it can contain JSX and brackets.
      i += 1;
      out += '`';
      while (i < n && source[i] !== '`') {
        if (source[i] === '\\') { i += 2; continue; }
        if (source.slice(i, i + 2) === '${') {
          let depth = 1;
          out += '${';
          i += 2;
          const start = i;
          while (i < n && depth > 0) {
            if (source[i] === '{') depth += 1;
            if (source[i] === '}') depth -= 1;
            i += 1;
          }
          // Recurse so quoted text inside the expression is stripped too.
          out += strip(source.slice(start, i));
          continue;
        }
        i += 1;
      }
      i += 1;
      out += '`';
      prevMeaningful = '`';
      continue;
    }
    out += ch;
    if (!/\s/.test(ch)) prevMeaningful = ch;
    i += 1;
  }
  return out;
}

function checkBrackets(file, source) {
  const stack = [];
  const pairs = { ')': '(', ']': '[', '}': '{' };
  let line = 1;
  for (const ch of source) {
    if (ch === '\n') line += 1;
    if ('([{'.includes(ch)) stack.push({ ch, line });
    if (')]}'.includes(ch)) {
      const top = stack.pop();
      if (!top || top.ch !== pairs[ch]) {
        problems.push(`${file}:${line}  unbalanced '${ch}'`);
        return;
      }
    }
  }
  if (stack.length) {
    problems.push(`${file}:${stack[stack.length - 1].line}  unclosed '${stack[stack.length - 1].ch}'`);
  }
}

const VOID_TAGS = new Set(['img', 'input', 'br', 'hr', 'meta', 'link', 'source', 'track', 'area', 'base', 'col', 'embed', 'param', 'wbr']);

/**
 * Walk JSX tags with a brace-aware scanner.
 *
 * A regex cannot do this: `onChange={(e) => …}` contains a '>' inside the
 * attribute list, so any pattern that stops at the first '>' closes the tag in
 * the wrong place and every later tag mismatches.
 */
function checkTags(file, source) {
  const stack = [];
  let i = 0;
  let line = 1;
  const n = source.length;

  while (i < n) {
    if (source[i] === '\n') { line += 1; i += 1; continue; }
    if (source[i] !== '<') { i += 1; continue; }

    const next = source[i + 1];
    // Not a tag: comparison operators, arrows, generics in plain code.
    if (next === undefined) break;
    if (!/[A-Za-z/>]/.test(next)) { i += 1; continue; }

    const isClose = next === '/';
    let cursor = i + (isClose ? 2 : 1);
    let name = '';
    while (cursor < n && /[\w.$-]/.test(source[cursor])) { name += source[cursor]; cursor += 1; }

    // Scan to the tag's real '>', ignoring anything inside {...} or quotes.
    let depth = 0;
    let selfClosing = false;
    let lastMeaningful = '';
    let seenLines = 0;
    while (cursor < n) {
      const ch = source[cursor];
      if (ch === '\n') seenLines += 1;
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      else if (depth === 0 && ch === '>') break;
      if (!/\s/.test(ch)) lastMeaningful = ch;
      cursor += 1;
    }
    if (cursor >= n) { i += 1; continue; }
    selfClosing = lastMeaningful === '/';

    if (isClose) {
      const top = stack.pop();
      if (!top || top.name !== name) {
        problems.push(`${file}:${line}  </${name}> does not match ${top ? `<${top.name}> opened on line ${top.line}` : 'any open tag'}`);
        return;
      }
    } else if (!selfClosing && !VOID_TAGS.has(name)) {
      stack.push({ name, line });
    }

    line += seenLines;
    i = cursor + 1;
  }

  if (stack.length) {
    const top = stack[stack.length - 1];
    problems.push(`${file}:${top.line}  <${top.name || 'fragment'}> is never closed`);
  }
}

function checkImports(file, source) {
  const dir = path.dirname(file);
  const importPattern = /import\s+(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
  let match;
  while ((match = importPattern.exec(source)) !== null) {
    const specifier = match[1];
    if (!specifier.startsWith('.')) continue;
    const base = path.resolve(dir, specifier);
    const candidates = [base, `${base}.js`, `${base}.jsx`, path.join(base, 'index.js'), path.join(base, 'index.jsx')];
    if (!candidates.some((candidate) => fs.existsSync(candidate))) {
      problems.push(`${file}  imports '${specifier}', which does not exist`);
    }
  }
}

/**
 * Identifiers used as JSX components must be imported or declared in the file.
 * This is what catches an icon that was renamed in the markup but not in the
 * import list — a runtime crash that a linter would otherwise find.
 */
function checkComponentsDeclared(file, source, stripped) {
  const declared = new Set();
  const importPattern = /import\s+([\s\S]*?)\s+from\s+['"][^'"]+['"]/g;
  let match;
  while ((match = importPattern.exec(source)) !== null) {
    for (const part of match[1].replace(/[{}]/g, ',').split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) declared.add(name);
    }
  }
  for (const m of source.matchAll(/(?:function|const|let|class)\s+([A-Z][\w$]*)/g)) declared.add(m[1]);
  // Destructured locals count as declarations too — from a const, and from a
  // callback parameter such as `options.map(({ key, Icon }) => …)`.
  for (const m of source.matchAll(/(?:\((?:\s*)|(?:const|let|var)\s*)\{([^}]*)\}\s*(?:=[^=]|\)\s*=>)/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(':').pop().trim();
      if (/^[A-Z][\w$]*$/.test(name)) declared.add(name);
    }
  }

  const used = new Set();
  for (const m of stripped.matchAll(/<([A-Z][\w$]*)/g)) used.add(m[1]);
  for (const name of used) {
    const root = name.split('.')[0];
    if (root === 'React' || declared.has(root)) continue;
    problems.push(`${file}  uses <${name}> but never imports or defines it`);
  }
}

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full); continue; }
    if (!/\.(jsx?|mjs)$/.test(entry.name)) continue;
    const source = fs.readFileSync(full, 'utf8');
    const stripped = strip(source);
    scanned += 1;
    checkBrackets(full, stripped);
    if (full.endsWith('.jsx')) {
      checkTags(full, stripped);
      // Comments are stripped first, so a component named in prose does not
      // count as a use.
      checkComponentsDeclared(full, source, stripped);
    }
    checkImports(full, source);
  }
}

walk(ROOT);

console.log(`\nChecked ${scanned} files under ${ROOT}/`);
if (problems.length === 0) {
  console.log('No structural problems found.\n');
  process.exit(0);
}
console.log(`\n${problems.length} problem(s):`);
for (const problem of problems) console.log(`  ${problem}`);
console.log();
process.exit(1);
