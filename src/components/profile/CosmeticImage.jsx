import React, { useEffect, useState } from 'react';
import { captureStill, POSTER_DELAY } from '../../profile/art';
import { useMotionAllowed } from '../../profile/motion';

/**
 * A cosmetic's art. `animate` asks for the moving version; motion settings
 * can still say no, in which case the captured first frame is shown.
 * `replay` changes the URL so a play-once effect starts again.
 */
export default function CosmeticImage({ item, animate = false, replay = 0, className = '', style, alt = '' }) {
  const motion = useMotionAllowed();
  const moving = animate && motion;
  const [still, setStill] = useState(null);
  const url = item?.asset_url ?? null;

  useEffect(() => {
    if (!url || moving) return undefined;
    let cancelled = false;
    captureStill(url, 240, item?.kind === 'profile_effect' ? POSTER_DELAY : 0).then((s) => { if (!cancelled) setStill(s); });
    return () => { cancelled = true; };
  }, [url, moving, item?.kind]);

  if (!url) return null;
  if (moving) {
    const src = replay ? `${url}${url.includes('?') ? '&' : '?'}play=${replay}` : url;
    return <img src={src} alt={alt} draggable="false" className={className} style={style} decoding="async" />;
  }
  if (!still) return null;
  return <img src={still} alt={alt} draggable="false" className={className} style={style} data-still="true" />;
}
