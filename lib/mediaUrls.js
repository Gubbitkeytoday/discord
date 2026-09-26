// URL shapes for the same-origin image proxy (services/mediaProxy.js).
//
//   /api/media/proxy?url=<encodeURIComponent(absolute http(s) URL)>
//
// Clients build the same string for any remote image they render.

export const PROXY_PATH = '/api/media/proxy';

/** The proxied form of a remote image URL; anything else is returned unchanged. */
export function proxiedImageUrl(value) {
  if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) return value;
  return `${PROXY_PATH}?url=${encodeURIComponent(value)}`;
}

/** The original URL behind a proxied one. */
export function unproxiedImageUrl(value) {
  if (typeof value !== 'string' || !value.startsWith(`${PROXY_PATH}?url=`)) return value;
  try { return decodeURIComponent(value.slice(`${PROXY_PATH}?url=`.length)); } catch { return value; }
}
