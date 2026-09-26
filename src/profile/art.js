// ============================================================================
//  Cosmetic art helpers.
//
//  Every cosmetic is an image (built-in SVGs in /cosmetics, admin assets from
//  /api/cosmetics/items/:id/asset). An SVG's CSS keyframes run inside the
//  image, isolated from the page. For "static" we paint the image's first
//  frame to a canvas once and reuse that data URL everywhere — lists stay
//  still and cheap, and nothing loops in the background.
// ============================================================================

const stills = new Map(); // url#delay -> Promise<string|null>
const ready = new Map();  // url#delay -> string|null, once resolved
export const POSTER_DELAY = 1400;

/** The captured still if it is already done (so a row can paint it at once). */
export function peekStill(url, delay = 0) {
  return url ? ready.get(`${url}#${delay}`) : undefined;
}

/**
 * `delay` (ms) captures a later frame instead of the first — a profile
 * effect starts empty (its elements fade in), so its poster is taken once
 * the art is on screen. The image is kept in the viewport, almost fully
 * transparent, meanwhile so its animation timeline actually runs.
 */
export function captureStill(url, size = 240, delay = 0) {
  if (!url) return Promise.resolve(null);
  const key = `${url}#${delay}`;
  if (stills.has(key)) return stills.get(key);
  const job = new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    let host = null;
    if (delay) {
      host = document.createElement('div');
      host.setAttribute('aria-hidden', 'true');
      // On screen (browsers do not advance an unpainted image's
      // animation), but practically invisible and behind everything.
      host.style.cssText = 'position:fixed;left:0;top:0;width:60px;height:96px;opacity:0.01;pointer-events:none;z-index:-1;overflow:hidden';
      img.style.cssText = 'width:60px;height:96px';
      host.appendChild(img);
      document.body.appendChild(host);
    }
    img.onload = () => setTimeout(() => {
      try {
        const w = img.naturalWidth || size;
        const h = img.naturalHeight || size;
        const scale = Math.min(2, size / Math.max(w, h)) || 1;
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/png'));
      } catch {
        resolve(null);
      } finally {
        host?.remove();
      }
    }, delay);
    img.onerror = () => { host?.remove(); resolve(null); };
    img.src = url;
  });
  job.then((value) => ready.set(key, value));
  stills.set(key, job);
  return job;
}

/** Built-in art first frames are fine to capture eagerly (small). */
export function preloadStills(items = []) {
  for (const item of items) if (item?.asset_url) captureStill(item.asset_url, 240, item.kind === 'profile_effect' ? POSTER_DELAY : 0);
}
