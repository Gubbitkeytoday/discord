// ============================================================================
//  Cosmetics — the free collectibles catalogue.
//
//  Four kinds: avatar_decoration, profile_effect, nameplate, profile_frame.
//  Everything is free: every enabled item can be equipped by anyone. The
//  built-in pack is original SVG/CSS art shipped in public/cosmetics/ and is
//  synced into the catalogue on first use. Instance admins can add packs:
//  SVG (sanitised against a strict allow-list — see sanitizeSvg) or PNG/WebP.
//
//  Uploaded assets are stored in the catalogue row itself (small by design,
//  ≤ 64 KB SVG / ≤ 256 KB image) and served from /api/cosmetics/items/:id/asset
//  with a locked-down CSP, so an SVG opened directly can never run anything.
// ============================================================================

import { runQuery, getQuery, allQuery, transaction, sql } from '../db.js';
import { generateId } from '../lib/snowflake.js';
import { ApiError } from '../lib/httpUtils.js';

export const KINDS = ['avatar_decoration', 'profile_effect', 'nameplate', 'profile_frame'];
/** users column holding each kind's equipped item. */
export const KIND_COLUMN = {
  avatar_decoration: 'avatar_decoration_id',
  profile_effect: 'profile_effect_id',
  nameplate: 'nameplate_id',
  profile_frame: 'profile_frame_id'
};
const KIND_DIR = { avatar_decoration: 'deco', profile_effect: 'effect', nameplate: 'plate', profile_frame: 'frame' };

// --- built-in pack ------------------------------------------------------------

export const BUILTIN_PACK = Object.freeze({
  id: 'builtin-core',
  slug: 'builtin-core',
  name: 'Core collection',
  author: 'Antigravity contributors',
  license: 'CC-BY-4.0',
  version: '1.0.0'
});

// [kind, slug, English name, Thai name, tags]
const BUILTIN_ITEMS = [
  ['avatar_decoration', 'lotus', 'Lotus bloom', 'ดอกบัวบาน', 'thai'],
  ['avatar_decoration', 'kranok', 'Lai kranok ring', 'วงลายกนก', 'thai'],
  ['avatar_decoration', 'songkran', 'Songkran splash', 'สาดน้ำสงกรานต์', 'thai'],
  ['avatar_decoration', 'krathong', 'Loy Krathong', 'ลอยกระทง', 'thai'],
  ['avatar_decoration', 'elephant', 'Little elephant', 'ช้างน้อย', 'thai'],
  ['avatar_decoration', 'malai', 'Jasmine garland', 'พวงมาลัยมะลิ', 'thai'],
  ['avatar_decoration', 'orbit', 'Orbit', 'วงโคจร', ''],
  ['avatar_decoration', 'neon', 'Neon ring', 'วงแหวนนีออน', ''],
  ['avatar_decoration', 'stars', 'Twinkle stars', 'ดาวระยิบ', ''],
  ['avatar_decoration', 'cat-ears', 'Cat ears', 'หูแมว', ''],
  ['avatar_decoration', 'vine', 'Leafy vine', 'เถาใบไม้', ''],
  ['profile_effect', 'songkran-splash', 'Songkran splash', 'สาดน้ำสงกรานต์', 'thai'],
  ['profile_effect', 'lanterns', 'Sky lanterns', 'โคมลอย', 'thai'],
  ['profile_effect', 'lotus-petals', 'Lotus petals', 'กลีบบัวร่วง', 'thai'],
  ['profile_effect', 'confetti', 'Confetti', 'กระดาษสี', ''],
  ['profile_effect', 'fireflies', 'Fireflies', 'หิ่งห้อย', ''],
  ['profile_effect', 'snow', 'Snowfall', 'หิมะโปรย', ''],
  ['nameplate', 'kranok', 'Kranok gold', 'กนกทอง', 'thai'],
  ['nameplate', 'lotus-pond', 'Lotus pond', 'สระบัว', 'thai'],
  ['nameplate', 'waves', 'Songkran waves', 'คลื่นสงกรานต์', 'thai'],
  ['nameplate', 'lanterns', 'Lantern night', 'คืนโคมลอย', 'thai'],
  ['nameplate', 'aurora', 'Aurora', 'แสงเหนือ', ''],
  ['nameplate', 'circuit', 'Circuit', 'วงจร', ''],
  ['nameplate', 'petals', 'Petal drift', 'กลีบดอกไม้', ''],
  ['profile_frame', 'kranok-gold', 'Kranok gold frame', 'กรอบกนกทอง', 'thai'],
  ['profile_frame', 'lotus', 'Lotus frame', 'กรอบดอกบัว', 'thai'],
  ['profile_frame', 'pixel', 'Pixel frame', 'กรอบพิกเซล', ''],
  ['profile_frame', 'neon', 'Neon frame', 'กรอบนีออน', '']
];

export const builtinItemId = (kind, slug) => `builtin-${KIND_DIR[kind]}-${slug}`;

let builtinsReady = null;

/** Upsert the built-in pack once per process (idempotent across processes). */
export function ensureBuiltins() {
  builtinsReady ??= (async () => {
    await runQuery(
      `INSERT INTO cosmetic_packs (id, slug, name, author, license, version, source, enabled)
       VALUES (?, ?, ?, ?, ?, ?, 'builtin', 1)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, author = excluded.author,
         license = excluded.license, version = excluded.version`,
      [BUILTIN_PACK.id, BUILTIN_PACK.slug, BUILTIN_PACK.name, BUILTIN_PACK.author,
       BUILTIN_PACK.license, BUILTIN_PACK.version]
    );
    let position = 0;
    for (const [kind, slug, name, nameTh, tags] of BUILTIN_ITEMS) {
      position += 1;
      await runQuery(
        `INSERT INTO cosmetic_items (id, pack_id, kind, slug, name, name_th, renderer, asset_url, asset_type, tags, position)
         VALUES (?, ?, ?, ?, ?, ?, 'svg', ?, 'image/svg+xml', ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, name_th = excluded.name_th,
           asset_url = excluded.asset_url, tags = excluded.tags, position = excluded.position`,
        [builtinItemId(kind, slug), BUILTIN_PACK.id, kind, slug, name, nameTh,
         `/cosmetics/${KIND_DIR[kind]}/${slug}.svg`, tags || null, position]
      );
    }
  })().catch((err) => { builtinsReady = null; throw err; });
  return builtinsReady;
}

// --- SVG sanitiser --------------------------------------------------------------

const MAX_SVG_BYTES = 64 * 1024;

const SVG_ELEMENTS = new Set([
  'svg', 'g', 'defs', 'symbol', 'use', 'title', 'desc', 'style',
  'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon', 'text', 'tspan',
  'lineargradient', 'radialgradient', 'stop', 'clippath', 'mask', 'pattern',
  'filter', 'fegaussianblur', 'feoffset', 'femerge', 'femergenode', 'fecolormatrix',
  'feblend', 'feflood', 'fecomposite', 'fedropshadow'
]);
// Editor metadata: removed with everything inside it.
const DROPPED_ELEMENTS = /^(metadata|sodipodi:[\w-]+|inkscape:[\w-]+|rdf:[\w-]+|cc:[\w-]+|dc:[\w-]+)$/i;
// Never allowed, whatever they contain.
const FORBIDDEN_ELEMENTS = new Set([
  'script', 'foreignobject', 'image', 'a', 'iframe', 'embed', 'object', 'audio', 'video', 'canvas',
  'animate', 'set', 'animatetransform', 'animatemotion', 'animatecolor', 'discard', 'handler', 'listener',
  'feimage', 'cursor', 'font', 'font-face', 'font-face-uri', 'switch', 'link', 'meta', 'base', 'html', 'body'
]);
const SVG_ATTRIBUTES = new Set([
  'id', 'class', 'style', 'd', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'fr',
  'width', 'height', 'viewbox', 'preserveaspectratio', 'points', 'pathlength',
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'stroke-miterlimit', 'opacity',
  'transform', 'transform-origin', 'offset', 'stop-color', 'stop-opacity', 'gradientunits',
  'gradienttransform', 'spreadmethod', 'clip-path', 'clip-rule', 'clippathunits', 'mask', 'maskunits',
  'maskcontentunits', 'patternunits', 'patterncontentunits', 'patterntransform', 'filter', 'filterunits',
  'primitiveunits', 'stddeviation', 'dx', 'dy', 'in', 'in2', 'result', 'mode', 'values', 'type', 'operator',
  'k1', 'k2', 'k3', 'k4', 'flood-color', 'flood-opacity', 'color', 'display', 'visibility', 'overflow',
  'vector-effect', 'paint-order', 'shape-rendering', 'font-size', 'font-family', 'font-weight',
  'font-style', 'text-anchor', 'dominant-baseline', 'letter-spacing', 'role', 'aria-hidden',
  'aria-label', 'focusable', 'version', 'href', 'xlink:href', 'xmlns', 'xmlns:xlink', 'xml:space',
  'mix-blend-mode', 'isolation'
]);
const XMLNS = { xmlns: 'http://www.w3.org/2000/svg', 'xmlns:xlink': 'http://www.w3.org/1999/xlink' };
const TEXT_ELEMENTS = new Set(['title', 'desc', 'text', 'tspan', 'style']);

const unsafe = (reason) => {
  const err = new ApiError(`SVG rejected: ${reason}`, { code: 'SVG_UNSAFE', details: { reason } });
  return err;
};

function decodeEntities(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (whole, body) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 9 || code > 0x10ffff) throw unsafe('invalid character reference');
      return String.fromCodePoint(code);
    }
    if (!(body.toLowerCase() in named) || !whole.endsWith(';')) throw unsafe(`entity &${body}; is not allowed`);
    return named[body.toLowerCase()];
  });
}

const escapeXml = (value) => value
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * CSS inside <style> or style="": animations and paint only. No external
 * resources, no imports, no escapes (they are how filters get bypassed),
 * and nothing faster than one cycle a second (flash safety, WCAG 2.3.1).
 */
export function assertSafeCss(css) {
  const text = String(css);
  if (/\\/.test(text)) throw unsafe('CSS escapes are not allowed');
  if (/<\/?[a-z!]/i.test(text)) throw unsafe('markup inside CSS');
  if (/@(import|font-face|namespace|charset|document|supports|page|property|layer|container)\b/i.test(text)) {
    throw unsafe('CSS at-rule not allowed');
  }
  if (/expression\s*\(|javascript\s*:|vbscript\s*:|data\s*:|behavior\s*:|-moz-binding|image-set\s*\(|image\s*\(/i.test(text)) {
    throw unsafe('script or external resource in CSS');
  }
  const urls = text.match(/url\s*\(([^)]*)\)/gi) ?? [];
  for (const u of urls) {
    const inner = u.replace(/^url\s*\(/i, '').replace(/\)$/, '').trim().replace(/^["']|["']$/g, '');
    if (!/^#[A-Za-z_][\w.-]*$/.test(inner)) throw unsafe('CSS url() may only point inside the SVG (#id)');
  }
  // animation / animation-duration: the first time value is the duration.
  for (const m of text.matchAll(/animation(?:-duration)?\s*:\s*([^;}]+)/gi)) {
    const times = [...m[1].matchAll(/(^|[\s,])(\d*\.?\d+)(ms|s)\b/gi)];
    for (const [, , num, unit] of times.slice(0, 1)) {
      const seconds = unit.toLowerCase() === 'ms' ? Number(num) / 1000 : Number(num);
      if (seconds < 1) throw unsafe('animations must take at least 1 second per cycle');
    }
  }
}

function assertSafeAttrValue(name, value) {
  if (/javascript\s*:|vbscript\s*:|data\s*:/i.test(value)) throw unsafe(`${name} contains a script or data URL`);
  if (/url\s*\(/i.test(value)) {
    for (const u of value.match(/url\s*\(([^)]*)\)/gi) ?? []) {
      const inner = u.replace(/^url\s*\(/i, '').replace(/\)$/, '').trim().replace(/^["']|["']$/g, '');
      if (!/^#[A-Za-z_][\w.-]*$/.test(inner)) throw unsafe(`${name} references an external resource`);
    }
  }
}

/**
 * Splits markup into text runs and tags with a hand-written scanner (every
 * step is a sticky match of a simple character class, so the whole pass is
 * linear — a single backtracking tag regex is polynomial on unclosed tags).
 * Anything that is not a well-formed tag is rejected as malformed.
 */
function* tokenizeMarkup(src) {
  const NAME = /[A-Za-z][\w:.-]*/y;
  const SPACE = /\s*/y;
  const ATTR_NAME = /[^\s=/>]+/y;
  const VALUE = /"[^"]*"|'[^']*'/y;
  const at = (re, i) => { re.lastIndex = i; const m = re.exec(src); return m ? m[0] : null; };
  let i = 0;
  while (i < src.length) {
    if (src[i] !== '<') {
      const next = src.indexOf('<', i);
      const end = next === -1 ? src.length : next;
      yield { text: src.slice(i, end) };
      i = end;
      continue;
    }
    let j = i + 1;
    const closing = src[j] === '/' ? '/' : '';
    if (closing) j += 1;
    const rawName = at(NAME, j);
    if (!rawName) throw unsafe('malformed markup');
    j += rawName.length;
    const attrsStart = j;
    let attrsEnd = j;
    for (;;) {
      const ws = at(SPACE, j);
      if (!ws) break;
      const attrName = at(ATTR_NAME, j + ws.length);
      if (!attrName) break;
      let k = j + ws.length + attrName.length;
      const beforeEq = at(SPACE, k);
      if (src[k + beforeEq.length] === '=') {
        k += beforeEq.length + 1;
        k += at(SPACE, k).length;
        const value = at(VALUE, k);
        if (!value) throw unsafe('malformed markup');
        k += value.length;
      }
      j = attrsEnd = k;
    }
    j += at(SPACE, j).length;
    const selfClosing = src[j] === '/' ? '/' : '';
    if (selfClosing) j += 1;
    if (src[j] !== '>') throw unsafe('malformed markup');
    yield { closing, rawName, rawAttrs: src.slice(attrsStart, attrsEnd), selfClosing };
    i = j + 1;
  }
}

/** Drops <!-- … --> comments in one linear pass; an unterminated one is rejected. */
function stripComments(src) {
  let out = '';
  let from = 0;
  for (;;) {
    const open = src.indexOf('<!--', from);
    if (open === -1) return out + src.slice(from);
    const close = src.indexOf('-->', open + 4);
    if (close === -1) throw unsafe('unterminated comment');
    out += src.slice(from, open);
    from = close + 3;
  }
}

/**
 * Strict allow-list SVG sanitiser (no DOM needed; runs on the server).
 * Dangerous input is *rejected* with a reason rather than silently repaired,
 * so a pack author learns what to fix. Harmless editor noise (metadata,
 * inkscape:/sodipodi: attributes, unknown presentation attributes) is dropped.
 * Returns the re-serialised SVG built only from allowed parts.
 */
export function sanitizeSvg(input) {
  let src = String(input ?? '');
  if (Buffer.byteLength(src, 'utf8') > MAX_SVG_BYTES) throw unsafe('larger than 64 KB');
  src = src.replace(/^﻿/, '').replace(/^\s*<\?xml[^>]*\?>/i, '');
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i.test(src)) throw unsafe('DOCTYPE, ENTITY and CDATA are not allowed');
  src = stripComments(src);
  if (src.includes('<?') || src.includes('<!')) throw unsafe('processing instructions and declarations are not allowed');

  const out = [];
  const stack = [];
  let dropDepth = 0;
  let sawRoot = false;
  for (const { closing, rawName, rawAttrs, selfClosing, text } of tokenizeMarkup(src)) {
    if (text !== undefined) {
      if (dropDepth) continue;
      const parent = stack[stack.length - 1];
      const decoded = decodeEntities(text);
      if (!parent) { if (decoded.trim()) throw unsafe('text outside the <svg> element'); continue; }
      if (parent === 'style') { assertSafeCss(decoded); out.push(escapeXml(decoded).replace(/&gt;/g, '>').replace(/&quot;/g, '"')); continue; }
      if (TEXT_ELEMENTS.has(parent)) out.push(escapeXml(decoded));
      else if (!decoded.trim()) out.push(decoded.replace(/[^\s]/g, ''));
      continue;
    }
    const name = rawName.toLowerCase();
    if (closing) {
      if (dropDepth) { dropDepth -= 1; continue; }
      const open = stack.pop();
      if (open !== name) throw unsafe('unbalanced tags');
      out.push(`</${rawName}>`);
      continue;
    }
    if (FORBIDDEN_ELEMENTS.has(name)) throw unsafe(`<${rawName}> is not allowed`);
    if (dropDepth || DROPPED_ELEMENTS.test(name)) {
      if (!selfClosing) dropDepth += 1;
      continue;
    }
    if (!SVG_ELEMENTS.has(name)) throw unsafe(`<${rawName}> is not in the allow-list`);
    if (!stack.length) {
      if (name !== 'svg' || sawRoot) throw unsafe('the document must be a single <svg> element');
      sawRoot = true;
    }
    const attrs = [];
    const ATTR = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?/g;
    let a;
    while ((a = ATTR.exec(rawAttrs)) !== null) {
      const attrName = a[1];
      const lower = attrName.toLowerCase();
      if (/^on/i.test(attrName)) throw unsafe(`event handler ${attrName} is not allowed`);
      const rawValue = a[2] ?? a[3];
      if (rawValue === undefined) continue;
      const value = decodeEntities(rawValue);
      if (lower === 'href' || lower === 'xlink:href') {
        if (!/^#[A-Za-z_][\w.-]*$/.test(value.trim())) throw unsafe(`${attrName} must point inside the SVG (#id)`);
      }
      if (lower in XMLNS) {
        if (value !== XMLNS[lower]) throw unsafe(`unexpected namespace ${value}`);
      } else if (lower.startsWith('xmlns')) {
        continue; // editor namespaces: dropped with their attributes
      }
      if (!SVG_ATTRIBUTES.has(lower)) continue;
      if (lower === 'style') assertSafeCss(value);
      else assertSafeAttrValue(attrName, value);
      attrs.push(`${attrName}="${escapeXml(value)}"`);
    }
    if (name === 'svg' && stack.length === 0 && !attrs.some((x) => x.startsWith('xmlns='))) {
      attrs.unshift(`xmlns="${XMLNS.xmlns}"`);
    }
    out.push(`<${rawName}${attrs.length ? ` ${attrs.join(' ')}` : ''}${selfClosing ? '/>' : '>'}`);
    if (!selfClosing) stack.push(name);
  }
  if (stack.length || dropDepth) throw unsafe('unclosed tags');
  if (!sawRoot) throw unsafe('no <svg> element');
  return out.join('').trim();
}

// --- raster images ------------------------------------------------------------------

const MAX_IMAGE_BYTES = 256 * 1024;

function checkImage({ type, data }) {
  if (!['image/png', 'image/webp'].includes(type)) {
    throw new ApiError('Images must be PNG or WebP', { code: 'INVALID_IMAGE' });
  }
  const bytes = Buffer.from(String(data ?? ''), 'base64');
  if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) {
    throw new ApiError('Images must be at most 256 KB', { code: 'INVALID_IMAGE' });
  }
  const png = bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const webp = bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP';
  if ((type === 'image/png' && !png) || (type === 'image/webp' && !webp)) {
    throw new ApiError('The file is not the image type it claims to be', { code: 'INVALID_IMAGE' });
  }
  return bytes.toString('base64');
}

// --- catalogue ----------------------------------------------------------------------

const cleanText = (value, max) => String(value ?? '').replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, '').trim().slice(0, max);
const SLUG = /^[a-z0-9][a-z0-9-]{0,39}$/;

/** The public shape of an item — never the stored asset bytes. */
export function shapeItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    pack_id: row.pack_id,
    kind: row.kind,
    slug: row.slug,
    name: row.name,
    name_th: row.name_th ?? null,
    renderer: row.renderer,
    asset_url: row.asset_url || `/api/cosmetics/items/${row.id}/asset`,
    tags: row.tags ? String(row.tags).split(',').filter(Boolean) : [],
    builtin: row.pack_id === BUILTIN_PACK.id
  };
}

const ITEM_COLUMNS = `i.id, i.pack_id, i.kind, i.slug, i.name, i.name_th, i.renderer, i.asset_url, i.tags, i.position`;

/** Every equippable item (enabled item in an enabled pack), in display order. */
export async function listCatalogue({ kind = null } = {}) {
  await ensureBuiltins();
  if (kind && !KINDS.includes(kind)) throw new ApiError('Unknown cosmetic kind', { code: 'INVALID_KIND' });
  const rows = await allQuery(
    `SELECT ${ITEM_COLUMNS}, p.source FROM cosmetic_items i JOIN cosmetic_packs p ON p.id = i.pack_id
      WHERE i.enabled = 1 AND p.enabled = 1 ${kind ? 'AND i.kind = ?' : ''}
      ORDER BY CASE WHEN p.source = 'builtin' THEN 0 ELSE 1 END, p.created_at, i.position, i.slug`,
    kind ? [kind] : []
  );
  const packs = await allQuery(
    `SELECT id, slug, name, author, license, version, source FROM cosmetic_packs WHERE enabled = 1
      ORDER BY CASE WHEN source = 'builtin' THEN 0 ELSE 1 END, created_at`
  );
  return { packs, items: rows.map(shapeItem) };
}

/** Items by id (enabled only), as a Map — used to resolve equipped ids. */
export async function itemsById(ids) {
  const wanted = [...new Set((ids ?? []).filter(Boolean))];
  if (!wanted.length) return new Map();
  await ensureBuiltins();
  const rows = await allQuery(
    `SELECT ${ITEM_COLUMNS} FROM cosmetic_items i JOIN cosmetic_packs p ON p.id = i.pack_id
      WHERE i.enabled = 1 AND p.enabled = 1 AND i.id IN (${wanted.map(() => '?').join(',')})`,
    wanted
  );
  return new Map(rows.map((r) => [r.id, shapeItem(r)]));
}

/** Throw unless `itemId` is an equippable item of `kind`. null means unequip. */
export async function assertEquippable(itemId, kind) {
  if (itemId === null) return null;
  if (typeof itemId !== 'string' || itemId.length > 80) {
    throw new ApiError('Unknown cosmetic item', { code: 'UNKNOWN_COSMETIC' });
  }
  const item = (await itemsById([itemId])).get(itemId);
  if (!item) throw new ApiError('Unknown cosmetic item', { status: 404, code: 'UNKNOWN_COSMETIC' });
  if (item.kind !== kind) {
    throw new ApiError(`That item is a ${item.kind}, not a ${kind}`, { code: 'WRONG_COSMETIC_KIND' });
  }
  return item;
}

const parseJson = (text, fallback = null) => { try { return text ? JSON.parse(text) : fallback; } catch { return fallback; } };

/** The user's equipped items (global) and, with serverId, their overrides there. */
export async function getEquipped(userId, { serverId = null } = {}) {
  const row = await getQuery(
    `SELECT avatar_decoration_id, profile_effect_id, nameplate_id, profile_frame_id
       FROM users WHERE id = ? AND deleted_at IS NULL`, [userId]
  );
  if (!row) throw ApiError.notFound('User');
  let overrides = {};
  if (serverId) {
    const member = await getQuery(
      `SELECT profile_overrides FROM server_members WHERE server_id = ? AND user_id = ? AND left_at IS NULL`,
      [serverId, userId]
    );
    overrides = parseJson(member?.profile_overrides, {}) ?? {};
  }
  const ids = {};
  for (const kind of KINDS) {
    const col = KIND_COLUMN[kind];
    ids[kind] = Object.prototype.hasOwnProperty.call(overrides, col) ? overrides[col] : row[col];
  }
  const items = await itemsById(Object.values(ids));
  const equipped = {};
  for (const kind of KINDS) equipped[kind] = ids[kind] ? (items.get(ids[kind]) ?? null) : null;
  return { equipped, overrides: serverId ? overrides : null };
}

/**
 * Equip / unequip. `patch` maps kind → item id (or null). With `serverId` the
 * change is a per-server override stored on the membership; `inherit: true`
 * for a kind there removes the override.
 */
export async function equip({ userId, serverId = null, patch = {} }) {
  const changes = {};
  for (const [kind, value] of Object.entries(patch ?? {})) {
    if (!KINDS.includes(kind)) throw new ApiError(`Unknown cosmetic kind '${kind}'`, { code: 'INVALID_KIND' });
    if (value === undefined) continue;
    if (serverId && value === 'inherit') { changes[kind] = 'inherit'; continue; }
    await assertEquippable(value, kind);
    changes[kind] = value;
  }
  if (!Object.keys(changes).length) return getEquipped(userId, { serverId });

  if (serverId) {
    const member = await getQuery(
      `SELECT profile_overrides FROM server_members WHERE server_id = ? AND user_id = ? AND left_at IS NULL`,
      [serverId, userId]
    );
    if (!member) throw ApiError.forbidden('You are not a member of this server');
    const overrides = parseJson(member.profile_overrides, {}) ?? {};
    for (const [kind, value] of Object.entries(changes)) {
      if (value === 'inherit') delete overrides[KIND_COLUMN[kind]];
      else overrides[KIND_COLUMN[kind]] = value;
    }
    await runQuery(
      `UPDATE server_members SET profile_overrides = ? WHERE server_id = ? AND user_id = ?`,
      [Object.keys(overrides).length ? JSON.stringify(overrides) : null, serverId, userId]
    );
  } else {
    const sets = Object.keys(changes).map((kind) => `${KIND_COLUMN[kind]} = ?`);
    await runQuery(
      `UPDATE users SET ${sets.join(', ')}, updated_at = ${sql.now} WHERE id = ?`,
      [...Object.values(changes), userId]
    );
  }
  // The collection remembers everything ever worn (a "recently used" list).
  for (const value of Object.values(changes)) {
    if (!value || value === 'inherit') continue;
    await runQuery(
      `INSERT INTO user_cosmetics (user_id, item_id, source) VALUES (?, ?, 'equipped') ON CONFLICT DO NOTHING`,
      [userId, value]
    );
  }
  return getEquipped(userId, { serverId });
}

// --- asset serving ---------------------------------------------------------------------

export async function getAsset(itemId) {
  const row = await getQuery(
    `SELECT i.renderer, i.asset_type, i.asset_data FROM cosmetic_items i
       JOIN cosmetic_packs p ON p.id = i.pack_id
      WHERE i.id = ? AND i.asset_data IS NOT NULL`, [itemId]
  );
  if (!row) throw ApiError.notFound('Cosmetic asset');
  if (row.renderer === 'svg') return { type: 'image/svg+xml', body: Buffer.from(row.asset_data, 'utf8') };
  return { type: row.asset_type, body: Buffer.from(row.asset_data, 'base64') };
}

// --- admin packs -------------------------------------------------------------------------

async function audit(actorId, action, targetId, details) {
  try {
    const admin = await import('./instanceAdmin.js');
    await admin.audit({ actorId, action, targetType: 'cosmetic_pack', targetId, details });
  } catch { /* the audit log is best-effort for catalogue edits */ }
}

export async function listPacks() {
  await ensureBuiltins();
  const packs = await allQuery(
    `SELECT p.*, (SELECT count(*) FROM cosmetic_items i WHERE i.pack_id = p.id) AS item_count
       FROM cosmetic_packs p ORDER BY CASE WHEN p.source = 'builtin' THEN 0 ELSE 1 END, p.created_at`
  );
  const items = await allQuery(
    `SELECT ${ITEM_COLUMNS}, i.enabled FROM cosmetic_items i ORDER BY i.pack_id, i.position, i.slug`
  );
  const byPack = new Map();
  for (const it of items) {
    if (!byPack.has(it.pack_id)) byPack.set(it.pack_id, []);
    byPack.get(it.pack_id).push({ ...shapeItem(it), enabled: Boolean(Number(it.enabled)) });
  }
  return packs.map((p) => ({
    ...p, enabled: Boolean(Number(p.enabled)), item_count: Number(p.item_count), items: byPack.get(p.id) ?? []
  }));
}

function cleanItemInput(raw) {
  const kind = String(raw?.kind ?? '');
  if (!KINDS.includes(kind)) throw new ApiError('Each item needs a valid kind', { code: 'INVALID_KIND' });
  const slug = String(raw?.slug ?? '').trim().toLowerCase();
  if (!SLUG.test(slug)) throw new ApiError('Item slugs are 1–40 lowercase letters, digits and dashes', { code: 'INVALID_SLUG' });
  const name = cleanText(raw?.name, 60);
  if (!name) throw new ApiError('Each item needs a name', { code: 'INVALID_NAME' });
  if (raw?.svg !== undefined && raw?.svg !== null) {
    return { kind, slug, name, name_th: cleanText(raw?.name_th, 60) || null, renderer: 'svg', asset_type: 'image/svg+xml', asset_data: sanitizeSvg(raw.svg) };
  }
  if (raw?.image) {
    return { kind, slug, name, name_th: cleanText(raw?.name_th, 60) || null, renderer: 'image', asset_type: raw.image.type, asset_data: checkImage(raw.image) };
  }
  throw new ApiError('Each item needs an svg or an image', { code: 'MISSING_ASSET' });
}

export async function createPack({ actorId, pack }) {
  const slug = String(pack?.slug ?? '').trim().toLowerCase();
  if (!SLUG.test(slug) || slug.startsWith('builtin')) {
    throw new ApiError('Pack slugs are 1–40 lowercase letters, digits and dashes', { code: 'INVALID_SLUG' });
  }
  const name = cleanText(pack?.name, 60);
  if (!name) throw new ApiError('The pack needs a name', { code: 'INVALID_NAME' });
  const items = Array.isArray(pack?.items) ? pack.items : [];
  if (items.length > 40) throw new ApiError('A pack holds at most 40 items', { code: 'TOO_MANY_ITEMS' });
  const cleaned = items.map(cleanItemInput);
  if (new Set(cleaned.map((i) => `${i.kind}/${i.slug}`)).size !== cleaned.length) {
    throw new ApiError('Item slugs must be unique within the pack', { code: 'DUPLICATE_SLUG' });
  }
  if (await getQuery(`SELECT 1 FROM cosmetic_packs WHERE slug = ?`, [slug])) {
    throw new ApiError('A pack with that slug already exists', { status: 409, code: 'PACK_EXISTS' });
  }
  const id = generateId();
  await transaction(async () => {
    await runQuery(
      `INSERT INTO cosmetic_packs (id, slug, name, author, license, version, source, enabled, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 'admin', 1, ?)`,
      [id, slug, name, cleanText(pack?.author, 80) || null, cleanText(pack?.license, 40) || null,
       cleanText(pack?.version, 20) || null, actorId]
    );
    let position = 0;
    for (const it of cleaned) {
      position += 1;
      await insertItem(id, it, position);
    }
  });
  await audit(actorId, 'cosmetic_pack.create', id, { slug, items: cleaned.length });
  return (await listPacks()).find((p) => p.id === id);
}

async function insertItem(packId, it, position) {
  const itemId = generateId();
  await runQuery(
    `INSERT INTO cosmetic_items (id, pack_id, kind, slug, name, name_th, renderer, asset_type, asset_data, position)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [itemId, packId, it.kind, it.slug, it.name, it.name_th, it.renderer, it.asset_type, it.asset_data, position]
  );
  return itemId;
}

export async function addItem({ actorId, packId, item }) {
  const pack = await getQuery(`SELECT id, source FROM cosmetic_packs WHERE id = ?`, [packId]);
  if (!pack) throw ApiError.notFound('Cosmetic pack');
  if (pack.source === 'builtin') throw ApiError.forbidden('The built-in pack cannot be edited');
  const count = await getQuery(`SELECT count(*) AS n, max(position) AS p FROM cosmetic_items WHERE pack_id = ?`, [packId]);
  if (Number(count?.n ?? 0) >= 40) throw new ApiError('A pack holds at most 40 items', { code: 'TOO_MANY_ITEMS' });
  const cleaned = cleanItemInput(item);
  if (await getQuery(`SELECT 1 FROM cosmetic_items WHERE pack_id = ? AND kind = ? AND slug = ?`, [packId, cleaned.kind, cleaned.slug])) {
    throw new ApiError('Item slugs must be unique within the pack', { status: 409, code: 'DUPLICATE_SLUG' });
  }
  const id = await insertItem(packId, cleaned, Number(count?.p ?? 0) + 1);
  await audit(actorId, 'cosmetic_item.create', id, { pack: packId, slug: cleaned.slug });
  return (await listPacks()).find((p) => p.id === packId);
}

/** Unequip anything that is no longer available (pack removed or disabled). */
async function clearUnavailable() {
  for (const col of Object.values(KIND_COLUMN)) {
    await runQuery(
      `UPDATE users SET ${col} = NULL WHERE ${col} IS NOT NULL AND ${col} NOT IN (
         SELECT i.id FROM cosmetic_items i JOIN cosmetic_packs p ON p.id = i.pack_id
          WHERE i.enabled = 1 AND p.enabled = 1)`
    );
  }
}

export async function updatePack({ actorId, packId, patch }) {
  const pack = await getQuery(`SELECT * FROM cosmetic_packs WHERE id = ?`, [packId]);
  if (!pack) throw ApiError.notFound('Cosmetic pack');
  if (patch?.enabled !== undefined) {
    await runQuery(`UPDATE cosmetic_packs SET enabled = ? WHERE id = ?`, [patch.enabled ? 1 : 0, packId]);
  }
  if (patch?.name !== undefined && pack.source !== 'builtin') {
    const name = cleanText(patch.name, 60);
    if (!name) throw new ApiError('The pack needs a name', { code: 'INVALID_NAME' });
    await runQuery(`UPDATE cosmetic_packs SET name = ? WHERE id = ?`, [name, packId]);
  }
  if (Array.isArray(patch?.disabled_items)) {
    await runQuery(`UPDATE cosmetic_items SET enabled = 1 WHERE pack_id = ?`, [packId]);
    for (const itemId of patch.disabled_items.slice(0, 100)) {
      await runQuery(`UPDATE cosmetic_items SET enabled = 0 WHERE pack_id = ? AND id = ?`, [packId, String(itemId)]);
    }
  }
  await clearUnavailable();
  await audit(actorId, 'cosmetic_pack.update', packId, patch);
  return (await listPacks()).find((p) => p.id === packId);
}

export async function deletePack({ actorId, packId }) {
  const pack = await getQuery(`SELECT source FROM cosmetic_packs WHERE id = ?`, [packId]);
  if (!pack) throw ApiError.notFound('Cosmetic pack');
  if (pack.source === 'builtin') throw ApiError.forbidden('The built-in pack can be disabled, not deleted');
  await runQuery(`DELETE FROM cosmetic_items WHERE pack_id = ?`, [packId]);
  await runQuery(`DELETE FROM cosmetic_packs WHERE id = ?`, [packId]);
  await clearUnavailable();
  await audit(actorId, 'cosmetic_pack.delete', packId, null);
  return { deleted: true };
}
