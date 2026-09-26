import React, { useEffect, useState } from 'react';

// url -> data URL of the first frame, or null when it cannot be captured
// (a cross-origin image without CORS taints the canvas).
const frames = new Map();

function captureFirstFrame(url) {
  if (frames.has(url)) return Promise.resolve(frames.get(url));
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      let still = null;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);
        still = canvas.toDataURL('image/png');
      } catch { /* tainted */ }
      frames.set(url, still);
      resolve(still);
    };
    img.onerror = () => { frames.set(url, null); resolve(null); };
    img.src = url;
  });
}

/** Does this URL / attachment look animated (GIF, APNG, animated WebP)? */
export function isAnimatedImage({ url = '', mimetype = '', filename = '', animated = false } = {}) {
  if (animated) return true;
  if (/image\/gif/i.test(mimetype)) return true;
  return /\.gif(\?|#|$)/i.test(filename) || /\.gif(\?|#|$)/i.test(url);
}

/**
 * An image element that honours "Automatically play GIFs": when `animate` is false it
 * shows the first frame and plays only while hovered or focused (or never,
 * with `playOnHover={false}`). Same element, same classes — only `src` swaps,
 * so layout is untouched. If the first frame cannot be captured, it falls
 * back to a neutral placeholder rather than autoplaying against the setting.
 */
export default function StillImage({ src, alt = '', animate = true, playOnHover = true, className = '', style, ...rest }) {
  const [still, setStill] = useState(() => (frames.has(src) ? frames.get(src) : undefined));
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (animate || !src) return undefined;
    let cancelled = false;
    captureFirstFrame(src).then((frame) => { if (!cancelled) setStill(frame); });
    return () => { cancelled = true; };
  }, [src, animate]);

  if (animate) return <img src={src} alt={alt} className={className} style={style} {...rest} />;

  const playing = playOnHover && active;
  const shown = playing ? src : still;
  return (
    <img
      {...rest}
      alt={alt}
      src={shown || undefined}
      data-still={playing ? undefined : 'true'}
      className={`${className} ${shown ? '' : 'bg-d-surface'}`}
      style={style}
      onMouseEnter={(e) => { setActive(true); rest.onMouseEnter?.(e); }}
      onMouseLeave={(e) => { setActive(false); rest.onMouseLeave?.(e); }}
      onFocus={(e) => { setActive(true); rest.onFocus?.(e); }}
      onBlur={(e) => { setActive(false); rest.onBlur?.(e); }}
    />
  );
}
