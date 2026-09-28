// ============================================================================
//  Same-origin image proxy.
//
//    GET /api/media/proxy?url=<absolute http(s) URL>
//
//  An <img src> pointing at someone else's server hands that server the
//  viewer's IP address, User-Agent and the moment they looked — an avatar or
//  an og:image aimed at a logging endpoint deanonymises everyone who sees it.
//  Every remote image therefore goes through here: the server fetches it
//  (with the same SSRF guards as link unfurling — public addresses only,
//  checked again at connect time and on every redirect), checks the bytes
//  really are a raster image, and serves it from our origin. The browser's
//  CSP then only allows images from 'self'.
//
//  Contract for clients: rewrite any absolute http(s) image URL with
//  proxiedImageUrl() (or build the same string); same-origin paths, data:
//  and blob: URLs are used as they are.
// ============================================================================

import { safeGet } from './linkEmbeds.js';
import { sniffMime } from '../lib/mediaProbe.js';
import { ApiError } from '../lib/httpUtils.js';

export { PROXY_PATH, proxiedImageUrl, unproxiedImageUrl } from '../lib/mediaUrls.js';

const MAX_BYTES = Number(process.env.MEDIA_PROXY_MAX_BYTES) || 8 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_MAX_BYTES = Number(process.env.MEDIA_PROXY_CACHE_BYTES) || 64 * 1024 * 1024;

// Raster formats, plus SVG (default server icons are SVG identicons). SVG is a
// document that can carry script; as an <img> the browser never runs it, and
// opened directly the response's `sandbox` CSP forbids script — the same
// treatment uploaded SVGs get.
const ALLOWED = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif']);

// --- cache ---------------------------------------------------------------------
// Small, in-process, byte-bounded LRU. Popular avatars are fetched once an hour
// instead of once per viewer.
const cache = new Map();   // url -> { body, mime, at }
let cachedBytes = 0;

function cacheGet(url) {
  const hit = cache.get(url);
  if (!hit) return null;
  if (Date.now() - hit.at > CACHE_TTL_MS) {
    cache.delete(url);
    cachedBytes -= hit.body.length;
    return null;
  }
  cache.delete(url);
  cache.set(url, hit);        // most recently used goes last
  return hit;
}

function cachePut(url, entry) {
  if (entry.body.length > CACHE_MAX_BYTES / 8) return;
  cache.set(url, entry);
  cachedBytes += entry.body.length;
  for (const [key, old] of cache) {
    if (cachedBytes <= CACHE_MAX_BYTES) break;
    cache.delete(key);
    cachedBytes -= old.body.length;
  }
}

/** Is this buffer an image we are willing to serve? Returns its MIME or null. */
export function acceptableImage(buffer) {
  // Declared as SVG only so the sniffer considers it; raster magic bytes
  // still win, and SVG is accepted only when the text really is an <svg>.
  const { mime } = sniffMime(buffer, 'image/svg+xml');
  if (ALLOWED.has(mime)) return mime;
  if (mime === 'image/svg+xml' && /<svg[\s>]/i.test(buffer.subarray(0, 4096).toString('utf8'))) return mime;
  // AVIF is an ISO-BMFF file sniffMime reports as video/mp4; check its brand.
  if (buffer.length > 12 && buffer.toString('latin1', 4, 8) === 'ftyp'
      && ['avif', 'avis'].includes(buffer.toString('latin1', 8, 12))) {
    return 'image/avif';
  }
  return null;
}

const refuse = (message, code, status = 400) => new ApiError(message, { status, code });

/** Fetch (or serve from cache) a remote image. Resolves to { body, mime }. */
export async function fetchImage(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl ?? ''));
  } catch {
    throw refuse('url must be an absolute http(s) URL', 'INVALID_URL');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw refuse('url must be an absolute http(s) URL', 'INVALID_URL');
  }
  if (url.href.length > 2048) throw refuse('url is too long', 'INVALID_URL');

  const cached = cacheGet(url.href);
  if (cached) return cached;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let response;
  try {
    ({ response } = await safeGet(url.href, {
      signal: controller.signal,
      accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.9,*/*;q=0.1'
    }));
  } catch (err) {
    clearTimeout(timer);
    if (err.code === 'EPRIVATE') {
      throw refuse('That address is not allowed', 'URL_NOT_ALLOWED');
    }
    throw refuse('The image could not be fetched', 'UPSTREAM_FAILED', 502);
  }

  try {
    const declared = Number(response.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BYTES) {
      response.destroy();
      throw refuse('The image is too large', 'IMAGE_TOO_LARGE', 413);
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response) {
      size += chunk.length;
      if (size > MAX_BYTES) {
        response.destroy();
        throw refuse('The image is too large', 'IMAGE_TOO_LARGE', 413);
      }
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    // The upstream Content-Type is a claim; the bytes decide.
    const mime = acceptableImage(body);
    if (!mime) throw refuse('That URL is not an image', 'NOT_AN_IMAGE', 415);
    const entry = { body, mime, at: Date.now() };
    cachePut(url.href, entry);
    return entry;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw refuse('The image could not be fetched', 'UPSTREAM_FAILED', 502);
  } finally {
    clearTimeout(timer);
  }
}

/** Express handler for GET /api/media/proxy. Mount behind requireUser. */
export async function proxyHandler(req, res) {
  const { body, mime } = await fetchImage(req.query.url);
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Length', body.length);
  // Private: the response is only served to signed-in users.
  res.setHeader('Cache-Control', 'private, max-age=86400, immutable');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.end(body);
}
