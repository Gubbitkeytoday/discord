// ============================================================================
//  Responsive images from upload descriptors.
//
//  The server returns, for every image upload (see routes/files.js
//  toDescriptor):
//    width, height        display size, EXIF orientation applied
//    thumbhash            ~25-byte placeholder (decode with placeholderUrl)
//    placeholder          older ~20px WebP data URI (fallback)
//    renditions[]         { format, width, height, url } — WebP always, AVIF
//                         once the background job finishes
//    srcset               { avif?: "u 160w, …", webp?: "u 160w, …" }
//    display_url          /api/media/:id — best format via Accept, ?w=<px>
//    url / download_url   the (metadata-stripped) original
//
//  Two ways to render, both without layout shift:
//
//    <picture>                                      // explicit formats
//      {pictureSources(att).map((s) => <source key={s.type} {...s} sizes={sizes} />)}
//      <img {...imgProps(att, { sizes })} />
//    </picture>
//
//    <img {...imgProps(att, { sizes })} />          // WebP srcset, original src
//
//  `sizes` must describe the rendered slot, e.g. "(max-width: 640px) 90vw, 384px"
//  for a chat attachment capped at 384 CSS px.
// ============================================================================

import { thumbHashToDataURL } from 'thumbhash';

const placeholderCache = new Map();

/** Data URL for a descriptor's placeholder (thumbhash preferred), or null. */
export function placeholderUrl(att) {
  if (!att) return null;
  if (att.thumbhash) {
    const cached = placeholderCache.get(att.thumbhash);
    if (cached) return cached;
    try {
      const bytes = Uint8Array.from(atob(att.thumbhash), (c) => c.charCodeAt(0));
      const url = thumbHashToDataURL(bytes);
      if (placeholderCache.size > 500) placeholderCache.clear();
      placeholderCache.set(att.thumbhash, url);
      return url;
    } catch {
      /* malformed hash — fall through */
    }
  }
  return att.placeholder ?? null;
}

/** "url 160w, url 480w" for one format, built from renditions when srcset is absent. */
export function buildSrcSet(att, format = 'webp') {
  if (att?.srcset?.[format]) return att.srcset[format];
  const list = (att?.renditions ?? []).filter((r) => r.format === format).sort((a, b) => a.width - b.width);
  return list.length ? list.map((r) => `${r.url} ${r.width}w`).join(', ') : undefined;
}

/** <source> props for a <picture>, best format first. Empty when there are no renditions. */
export function pictureSources(att) {
  const out = [];
  for (const format of ['avif', 'webp']) {
    const srcSet = buildSrcSet(att, format);
    if (srcSet) out.push({ type: `image/${format}`, srcSet });
  }
  return out;
}

/**
 * The single best URL for a fixed slot (avatars, emoji, CSS backgrounds):
 * the smallest rendition ≥ cssWidth × devicePixelRatio, else the original.
 */
export function bestUrl(att, cssWidth, { format = 'webp', dpr = globalThis.devicePixelRatio || 1 } = {}) {
  const want = Math.ceil((cssWidth || 0) * dpr);
  const list = (att?.renditions ?? []).filter((r) => r.format === format).sort((a, b) => a.width - b.width);
  if (!list.length) return att?.url ?? null;
  return (list.find((r) => r.width >= want) ?? list[list.length - 1]).url;
}

/**
 * Props for an <img>: intrinsic width/height (the browser reserves the box
 * from them — CLS fix), a WebP srcset with `sizes`, the original as `src`
 * fallback, lazy decoding, and the placeholder as a background until load.
 */
export function imgProps(att, { sizes = '100vw', eager = false } = {}) {
  const placeholder = placeholderUrl(att);
  const srcSet = buildSrcSet(att, 'webp');
  return {
    src: att?.url,
    ...(srcSet ? { srcSet, sizes } : {}),
    width: att?.width || undefined,
    height: att?.height || undefined,
    loading: eager ? 'eager' : 'lazy',
    decoding: 'async',
    style: {
      ...(att?.width && att?.height ? { aspectRatio: `${att.width} / ${att.height}` } : {}),
      ...(placeholder ? { backgroundImage: `url(${placeholder})`, backgroundSize: 'cover' } : {})
    }
  };
}
