import React from 'react';
import CosmeticImage from './CosmeticImage';
import { useMotionAllowed, useViewerPrefs } from '../../profile/motion';
import '../../profile/profile.css';

/**
 * The profile effect: a pointer-transparent overlay over the whole card that
 * plays once (≤ 3 s) when the profile opens and then holds its last frame.
 * Nothing is drawn under reduced motion or when the viewer turned effects
 * off — an effect is motion by nature. `replay` restarts it.
 */
export default function ProfileEffect({ item, replay = 0 }) {
  const motion = useMotionAllowed();
  const viewer = useViewerPrefs();
  if (!item || !motion || !viewer.effects) return null;
  return (
    <CosmeticImage
      key={replay}
      item={item}
      animate
      replay={replay}
      className="pointer-events-none absolute inset-0 z-[2] h-full w-full select-none object-cover"
    />
  );
}

/** A 9-slice frame around the card (static art). */
export function ProfileFrame({ item }) {
  const viewer = useViewerPrefs();
  if (!item || viewer.decorations === 'off') return null;
  return <span aria-hidden="true" className="pf-frame rounded-[inherit]" style={{ borderImageSource: `url("${item.asset_url}")` }} />;
}
