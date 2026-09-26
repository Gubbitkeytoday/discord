import React, { useEffect, useState } from 'react';
import AnimatedServerIcon from './AnimatedServerIcon.jsx';
import { proxiedImageUrl } from '../../utils/media';
import './server.css';

/**
 * Collapse the banner once a scroller has moved past `threshold` px.
 *   const collapsed = useScrolledPast(channelListRef, 24);
 */
export function useScrolledPast(ref, threshold = 24) {
  const [past, setPast] = useState(false);
  useEffect(() => {
    const el = ref?.current;
    if (!el) return undefined;
    const onScroll = () => setPast(el.scrollTop > threshold);
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [ref, threshold]);
  return past;
}

/**
 * The server banner at the top of the channel list (Discord: 16:9 art under
 * the server name, shrinking to the 48px header bar as the list scrolls).
 *
 * Renders nothing without `server.banner_url`, so it can wrap the existing
 * header unconditionally:
 *
 *   <ServerBanner server={currentServer} collapsed={collapsed}>
 *     {existing server-name header button}
 *   </ServerBanner>
 *
 * `children` sit on the banner's top edge, over a dark scrim, so the white
 * server name keeps ≥4.5:1 whatever the art is. An animated banner plays on
 * hover only (and never under reduced motion unless hovered).
 */
export default function ServerBanner({ server, collapsed = false, height = 136, children, className = '' }) {
  const url = server?.banner_url;
  if (!url) return children ?? null;
  return (
    <div
      className={`server-banner relative shrink-0 overflow-hidden ${className}`}
      style={{ height: collapsed ? 48 : height }}
      data-collapsed={collapsed ? 'true' : undefined}
    >
      <AnimatedServerIcon
        src={proxiedImageUrl(url)}
        animated={Boolean(server.banner_animated)}
        alt=""
        className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-150 ${collapsed ? 'opacity-0' : 'opacity-100'}`}
      />
      {/* A scrim for the name on top, and a fade into the list below. */}
      <div aria-hidden="true" className="absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-black/70 to-transparent" />
      <div aria-hidden="true" className="absolute inset-x-0 bottom-0 h-8 bg-gradient-to-t from-d-surface/60 to-transparent" />
      <div className="relative z-[1] [&_*]:text-white [&_button]:hover:bg-black/20">{children}</div>
    </div>
  );
}
