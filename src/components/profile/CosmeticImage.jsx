import React, { useEffect, useState } from 'react';
import { captureStill, peekStill, POSTER_DELAY } from '../../profile/art';
import { useMotionAllowed } from '../../profile/motion';

/**
 * A cosmetic's art. `animate` asks for the moving version; motion settings
 * can still say no, in which case the captured first frame is shown.
 * `replay` changes the URL so a play-once effect starts again.
 */
export default function CosmeticImage({ item, animate = false, replay = 0, className = '', style, alt = '' }) {
  const motion = useMotionAllowed();
  const moving = animate && motion;
  const url = item?.asset_url ?? null;
  const delay = item?.kind === 'profile_effect' ? POSTER_DELAY : 0;
  // Already captured (the usual case after the first row): paint it now
  // instead of rendering nothing and swapping it in a tick later.
  const [still, setStill] = useState(() => peekStill(url, delay) ?? null);

  useEffect(() => {
    if (!url || moving) return undefined;
    let cancelled = false;
    captureStill(url, 240, delay).then((s) => { if (!cancelled) setStill(s); });
    return () => { cancelled = true; };
  }, [url, moving, delay]);

  if (!url) return null;
  if (moving) {
    const src = replay ? `${url}${url.includes('?') ? '&' : '?'}play=${replay}` : url;
    return <img src={src} alt={alt} draggable="false" className={className} style={style} decoding="async" />;
  }
  if (!still) return null;
  return <img src={still} alt={alt} draggable="false" className={className} style={style} data-still="true" />;
}
