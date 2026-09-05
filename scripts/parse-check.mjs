// ============================================================================
//  Static check for every client source file, in two passes:
//
//  1. Parse  — @babel/parser (already a Vite dependency), so a syntax slip is
//     caught without needing the platform-specific esbuild binary.
//  2. Resolve — scope analysis via @babel/traverse: any identifier that is
//     referenced but never imported, declared or global is reported.
//
//  Pass 2 exists because of a real outage: `Radio` was used in a lookup table
//  in ChannelSidebar.jsx but never added to the lucide-react import. The file
//  parsed fine, jsx-check only inspects `<JSX>` tags, and Vite happily served
//  it — the failure was a blank page at runtime. A ReferenceError like that
//  must never reach the browser again.
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from '@babel/parser';
import _traverse from '@babel/traverse';

const traverse = _traverse.default ?? _traverse;
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Client and server both: a missing import is a blank page in the browser or a
// 500 on the API, and neither shows up until the code path actually runs.
const ROOTS = ['src', 'services', 'lib', 'routes'].map((d) => path.join(appRoot, d)).filter((d) => fs.existsSync(d));
const SINGLE_FILES = ['server.js', 'realtime.js', 'db.js', 'storageService.js']
  .map((f) => path.join(appRoot, f)).filter((f) => fs.existsSync(f));

// Browser, Node and standard-library names that are legitimately free variables.
const GLOBALS = new Set([
  'window', 'document', 'navigator', 'location', 'history', 'localStorage', 'sessionStorage',
  'console', 'fetch', 'Headers', 'Request', 'Response', 'FormData', 'File', 'FileReader', 'Blob',
  'URL', 'URLSearchParams', 'AbortController', 'Image', 'Audio', 'Notification', 'MediaRecorder',
  'MediaStream', 'RTCPeerConnection', 'RTCSessionDescription', 'RTCIceCandidate', 'AudioContext',
  'webkitAudioContext', 'SpeechSynthesisUtterance', 'speechSynthesis', 'IntersectionObserver',
  'ResizeObserver', 'MutationObserver', 'CustomEvent', 'Event', 'DataTransfer', 'DOMParser',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'requestAnimationFrame',
  'cancelAnimationFrame', 'queueMicrotask', 'structuredClone', 'crypto', 'btoa', 'atob',
  'Math', 'JSON', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Date', 'RegExp', 'Error',
  'TypeError', 'RangeError', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'Symbol', 'BigInt',
  'Intl', 'Proxy', 'Reflect', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
  'decodeURIComponent', 'encodeURI', 'decodeURI', 'globalThis', 'undefined', 'NaN', 'Infinity',
  'Uint8Array', 'Int8Array', 'Uint16Array', 'Int16Array', 'Uint32Array', 'Int32Array',
  'Float32Array', 'Float64Array', 'ArrayBuffer', 'DataView', 'TextEncoder', 'TextDecoder',
  'process', 'import', 'require', 'module', 'exports', 'arguments', 'HTMLElement', 'Node',
  'getComputedStyle', 'matchMedia', 'alert', 'confirm', 'prompt', 'scrollTo', 'CSS',
  // Node
  'Buffer', 'setImmediate', 'clearImmediate', '__dirname', '__filename', 'AbortSignal'
]);


/** Does this `if` (or its branches) return? */
function containsReturn(node) {
  if (!node) return false;
  if (node.type === 'ReturnStatement') return true;
  if (node.type === 'BlockStatement') return node.body.some(containsReturn);
  if (node.type === 'IfStatement') return containsReturn(node.consequent) || containsReturn(node.alternate);
  return false;
}

const HOOK_NAME = /^use[A-Z]/;

/** The first top-level hook call inside a statement, if any. */
function findHookCall(node) {
  let found = null;
  const walk = (n) => {
    if (!n || typeof n !== 'object' || found) return;
    if (n.type === 'CallExpression') {
      const callee = n.callee;
      const name = callee?.type === 'Identifier' ? callee.name
        : callee?.type === 'MemberExpression' && callee.property?.type === 'Identifier' ? callee.property.name
        : null;
      if (name && HOOK_NAME.test(name)) {
        found = { name, line: n.loc?.start?.line ?? 0 };
        return;
      }
    }
    // Do not descend into nested functions: their hooks belong to them.
    if (n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression') return;
    for (const key of Object.keys(n)) {
      const value = n[key];
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value.type === 'string') walk(value);
    }
  };
  walk(node);
  return found;
}

let files = 0;
let syntaxFailures = 0;
let unresolved = 0;

const check = (file) => {
  const source = fs.readFileSync(file, 'utf8');
  const rel = path.relative(appRoot, file);
  let ast;
  try {
    ast = parse(source, { sourceType: 'module', plugins: ['jsx'] });
  } catch (err) {
    syntaxFailures += 1;
    console.log(`  ✗ ${rel}: ${err.message}`);
    return;
  }

  // --- hooks after an early return ----------------------------------------
  // React requires every hook to run on every render. A `useX()` that sits
  // after a top-level `return` in a component runs only sometimes, which
  // throws "Rendered more hooks than during the previous render" — a blank
  // screen, and only on the render where the early return did not fire.
  traverse(ast, {
    Function(fnPath) {
      const body = fnPath.node.body;
      if (!body || body.type !== 'BlockStatement') return;
      const name = fnPath.node.id?.name
        ?? (fnPath.parent?.type === 'VariableDeclarator' ? fnPath.parent.id?.name : null);
      // Only components/hooks: PascalCase or useSomething.
      if (!name || !/^([A-Z]|use[A-Z])/.test(name)) return;

      let returnedAt = null;
      for (const statement of body.body) {
        if (returnedAt === null && (statement.type === 'ReturnStatement'
          || (statement.type === 'IfStatement' && containsReturn(statement)))) {
          returnedAt = statement.loc?.start?.line ?? 0;
          continue;
        }
        if (returnedAt === null) continue;
        const hook = findHookCall(statement);
        if (hook) {
          unresolved += 1;
          console.log(`  ✗ ${rel}:${hook.line}: ${hook.name}() runs after an early return in ${name}() `
            + `(line ${returnedAt}) — move every hook above it`);
        }
      }
    }
  });

  const seen = new Set();
  traverse(ast, {
    Program(programPath) {
      // `globals` holds every reference the file never binds itself.
      for (const [name, paths] of Object.entries(programPath.scope.globals ?? {})) {
        if (GLOBALS.has(name) || seen.has(name)) continue;
        seen.add(name);
        const line = Array.isArray(paths) ? paths[0]?.loc?.start?.line : paths?.loc?.start?.line;
        unresolved += 1;
        console.log(`  ✗ ${rel}${line ? `:${line}` : ''}: '${name}' is used but never imported or defined`);
      }
    }
  });
};

const walk = (dir) => {
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (fs.statSync(full).isDirectory()) { walk(full); continue; }
    if (!/\.(jsx?|mjs)$/.test(entry)) continue;
    files += 1;
    check(full);
  }
};

for (const dir of ROOTS) walk(dir);
for (const file of SINGLE_FILES) { files += 1; check(file); }

const problems = syntaxFailures + unresolved;
console.log(problems
  ? `\n${problems} problem(s) in ${files} source files (${syntaxFailures} syntax, ${unresolved} unresolved reference).`
  : `✅ ${files} source files parse, with no unresolved references.`);
process.exit(problems ? 1 : 0);
