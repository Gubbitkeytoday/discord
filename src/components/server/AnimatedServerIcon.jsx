import React, { useState } from 'react';
import StillImage, { isAnimatedImage } from '../StillImage';
import { useUserSettings, prefersReducedMotion } from '../../hooks/useUserSettings';
import { serverIconOf } from '../../utils/avatar';

/**
 * A server icon (or banner) that may be animated: a still first frame at rest,
 * playing while hovered/focused or while `active` (the selected server), as
 * Discord does. Reduced motion and "Automatically play GIFs" off keep it
 * still except under the pointer; a static image renders as a plain image element.
 *
 *   <AnimatedServerIcon server={s} active={s.id === currentId} className="w-12 h-12 rounded-[16px]" />
 */
export default function AnimatedServerIcon({ server, src: explicitSrc, animated: explicitAnimated, active = false, alt = '', className = '', ...rest }) {
  const { prefs } = useUserSettings();
  const [hover, setHover] = useState(false);
  const src = explicitSrc ?? serverIconOf(server);
  if (!src) return null;
  const animated = explicitAnimated ?? (Boolean(server?.icon_animated) || isAnimatedImage({ url: src }));
  if (!animated) return <img src={src} alt={alt} className={className} {...rest} />;
  const calm = prefersReducedMotion(prefs) || prefs.accessibility?.autoplayGifs === false;
  const play = hover || (active && !calm);
  return (
    <span
      className="contents"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
    >
      <StillImage src={src} alt={alt} animate={play} playOnHover={false} className={className} {...rest} />
    </span>
  );
}
