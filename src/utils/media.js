// ============================================================================
//  Remote media goes through our own origin.
//
//  The CSP allows images only from 'self', data: and blob:, so any absolute
//  http(s) URL that points at another host must be rewritten to the
//  same-origin image proxy:
//
//    /api/media/proxy?url=<encodeURIComponent(absolute http(s) URL)>
//
//  Same-origin, relative, data: and blob: URLs — and URLs that are already
//  proxied — come back unchanged, so the helper is safe to apply twice and to
//  values the server has already rewritten.
// ============================================================================

export const MEDIA_PROXY_PATH = '/api/media/proxy';

function currentOrigin() {
  try { return typeof window !== 'undefined' ? window.location.origin : null; } catch { return null; }
}

/** Is this an absolute http(s) URL on a host other than ours? */
export function isRemoteMediaUrl(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url.trim())) return false;
  let parsed;
  try { parsed = new URL(url.trim()); } catch { return false; }
  const origin = currentOrigin();
  if (origin && parsed.origin === origin) return false;
  return true;
}

/** The URL to put in `src` / `url(...)` for a possibly-remote image. */
export function proxiedImageUrl(url) {
  if (typeof url !== 'string' || !url) return url;
  const value = url.trim();
  if (!isRemoteMediaUrl(value)) return url;
  return `${MEDIA_PROXY_PATH}?url=${encodeURIComponent(value)}`;
}

/** `url(...)` for an inline background-image, or undefined when there is none. */
export function cssImageUrl(url) {
  const src = proxiedImageUrl(url);
  if (!src) return undefined;
  return `url("${String(src).replace(/["\\\n\r]/g, (c) => encodeURIComponent(c))}")`;
}
