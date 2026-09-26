// ============================================================================
//  Serving the built SPA (dist/) from this process, compressed.
//
//  Behind Caddy the proxy already encodes responses (`encode zstd gzip`), but
//  plenty of installs talk to Node directly: `npm start` on a LAN box, the
//  compose `no-proxy` profile behind a NAS reverse proxy, `start-discord.bat`.
//  Uncompressed, the first load is ~900 KB of JS+CSS instead of ~250 KB, which
//  is 20+ s on a slow 3G link (docs/FRONTEND-PERFORMANCE.md F2).
//
//  - Text assets (js, css, html, svg, json, webmanifest, …) are compressed
//    once per file version with brotli (preferred) or gzip, asynchronously on
//    the libuv pool, and kept in a bounded in-memory cache. Nothing is written
//    next to dist/, so a read-only root filesystem keeps working.
//  - Anything a proxy in front already compressed is left alone: we only
//    encode when the request advertises br/gzip and no Content-Encoding is set.
//  - Caching: everything under assets/ carries a content hash in its name →
//    `public, max-age=31536000, immutable`. The shell (index.html), sw.js,
//    the manifest and other root files → `no-cache` (always revalidated), so
//    a deploy is picked up on the next load.
//  - Client-side routing: any other GET that is not an API/upload/socket path
//    returns index.html.
//
//  Usage (server.js): app.use(staticAssets({ root: staticRoot }))
// ============================================================================

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

const COMPRESSIBLE = new Set([
  '.js', '.mjs', '.css', '.html', '.htm', '.svg', '.json', '.webmanifest',
  '.map', '.txt', '.xml', '.wasm', '.ico'
]);
const TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.wasm': 'application/wasm',
  '.ico': 'image/x-icon'
};
// Below this, the encoding overhead and an extra header outweigh the saving.
const MIN_BYTES = 1024;
const SPA_EXCLUDE = /^\/(api|uploads|socket\.io|metrics)(\/|$)/;

/** Pick the encoding from Accept-Encoding: br over gzip, honouring q=0. */
export function negotiateEncoding(header) {
  const offered = new Map();
  for (const part of String(header ?? '').toLowerCase().split(',')) {
    const [name, ...params] = part.trim().split(';');
    if (!name) continue;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    offered.set(name.trim(), q ? Number(q.slice(2)) : 1);
  }
  const ok = (name) => (offered.get(name) ?? offered.get('*') ?? 0) > 0;
  if (ok('br')) return 'br';
  if (ok('gzip')) return 'gzip';
  return null;
}

/**
 * Compressed-body cache. Keyed by path + size + mtime + encoding, so a rebuilt
 * file is re-encoded; bounded by total bytes (oldest entries evicted first).
 */
class EncodedCache {
  constructor(maxBytes) {
    this.maxBytes = maxBytes;
    this.bytes = 0;
    this.map = new Map();       // key -> Buffer
    this.pending = new Map();   // key -> Promise<Buffer>
  }

  async get(key, filePath, encoding) {
    const hit = this.map.get(key);
    if (hit) {
      // Refresh recency.
      this.map.delete(key);
      this.map.set(key, hit);
      return hit;
    }
    if (this.pending.has(key)) return this.pending.get(key);
    const job = (async () => {
      const raw = await fs.promises.readFile(filePath);
      const body = encoding === 'br'
        ? await brotli(raw, {
          params: {
            // 11 is ~10x slower than 9 for ~3% smaller output; a one-off per
            // file version, but 9 keeps the first request after a deploy fast.
            [zlib.constants.BROTLI_PARAM_QUALITY]: 9,
            [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length
          }
        })
        : await gzip(raw, { level: 9 });
      this.set(key, body);
      return body;
    })();
    this.pending.set(key, job);
    try { return await job; } finally { this.pending.delete(key); }
  }

  set(key, body) {
    if (body.length > this.maxBytes) return;
    this.map.set(key, body);
    this.bytes += body.length;
    for (const [k, v] of this.map) {
      if (this.bytes <= this.maxBytes) break;
      this.map.delete(k);
      this.bytes -= v.length;
    }
  }
}

/**
 * Express middleware serving `root` (the Vite build output) with compression,
 * immutable caching for hashed assets and an SPA fallback to index.html.
 */
export function staticAssets({
  root,
  spaFallback = true,
  cacheBytes = Number(process.env.STATIC_COMPRESS_CACHE_BYTES) || 32 * 1024 * 1024,
  compress = process.env.STATIC_COMPRESS !== '0'
} = {}) {
  const base = path.resolve(root);
  const cache = new EncodedCache(cacheBytes);
  const indexPath = path.join(base, 'index.html');

  const cacheControl = (rel) => (rel.startsWith(`assets${path.sep}`) || rel.startsWith('assets/')
    ? 'public, max-age=31536000, immutable'
    : 'no-cache');

  /** Map a URL path to a file inside root, or null (never escapes root, no dotfiles). */
  async function resolve(urlPath) {
    let decoded;
    try { decoded = decodeURIComponent(urlPath); } catch { return null; }
    if (decoded.includes('\0')) return null;
    const rel = path.normalize(decoded).replace(/^([/\\])+/, '');
    if (!rel || rel.split(/[/\\]/).some((seg) => seg.startsWith('.'))) return null;
    const full = path.join(base, rel);
    if (!full.startsWith(base + path.sep)) return null;
    try {
      const stat = await fs.promises.stat(full);
      return stat.isFile() ? { full, rel, stat } : null;
    } catch {
      return null;
    }
  }

  async function send(req, res, next, file) {
    const ext = path.extname(file.full).toLowerCase();
    res.setHeader('Cache-Control', cacheControl(file.rel));
    const type = TYPES[ext];
    if (type) res.setHeader('Content-Type', type);

    const encoding = compress && COMPRESSIBLE.has(ext) && file.stat.size >= MIN_BYTES
      && !res.getHeader('Content-Encoding')
      ? negotiateEncoding(req.headers['accept-encoding'])
      : null;
    if (COMPRESSIBLE.has(ext)) res.setHeader('Vary', 'Accept-Encoding');

    if (!encoding) {
      // Ranges, ETag/Last-Modified and 304s for the identity body.
      // root + relative path: send's dotfile check then covers only the part
      // inside dist/, not a dot-directory the install happens to live under.
      return res.sendFile(path.relative(base, file.full), { root: base, dotfiles: 'deny', cacheControl: false, lastModified: true }, (err) => {
        if (err && !res.headersSent) next(err.status === 404 ? undefined : err);
      });
    }

    const version = `${file.stat.size.toString(36)}-${Math.floor(file.stat.mtimeMs).toString(36)}`;
    const etag = `W/"${version}-${encoding}"`;
    res.setHeader('ETag', etag);
    res.setHeader('Last-Modified', file.stat.mtime.toUTCString());
    const inm = req.headers['if-none-match'];
    if (inm && inm.split(',').some((t) => t.trim() === etag)) {
      res.statusCode = 304;
      return res.end();
    }

    let body;
    try {
      body = await cache.get(`${file.full}|${version}|${encoding}`, file.full, encoding);
    } catch (err) {
      return next(err);
    }
    res.setHeader('Content-Encoding', encoding);
    res.setHeader('Content-Length', body.length);
    if (req.method === 'HEAD') return res.end();
    return res.end(body);
  }

  return async function staticAssetsMiddleware(req, res, next) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    try {
      const file = req.path === '/' ? null : await resolve(req.path);
      if (file) return await send(req, res, next, file);
      if (!spaFallback || SPA_EXCLUDE.test(req.path)) return next();
      // A missing hashed asset is a 404, not the shell: returning HTML for a
      // .js request makes the browser report a MIME error instead.
      if (/^\/assets\//.test(req.path)) return next();
      const stat = await fs.promises.stat(indexPath).catch(() => null);
      if (!stat) return next();
      return await send(req, res, next, { full: indexPath, rel: 'index.html', stat });
    } catch (err) {
      return next(err);
    }
  };
}
