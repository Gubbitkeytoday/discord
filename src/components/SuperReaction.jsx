// ============================================================================
//  Super Reactions — Discord's full-message burst when someone reacts.
//
//  Deliberately cheap: a handful of absolutely positioned spans on a CSS
//  keyframe, mounted for one second and then thrown away. No canvas, no
//  library, nothing retained. The whole effect is suppressed when the viewer
//  has asked for reduced motion or turned animated emoji off — an animation
//  nobody asked for is worse than no animation.
// ============================================================================

import React, { useEffect, useMemo, useState } from 'react';
import { getPreferences } from '../hooks/useUserSettings';

const PARTICLES = 12;
const DURATION_MS = 1100;

/** True when this viewer wants motion at all. */
export function motionAllowed() {
  const prefs = getPreferences();
  if (prefs.accessibility?.reducedMotion) return false;
  if (prefs.accessibility?.playAnimatedEmoji === false) return false;
  try {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return false;
  } catch { /* matchMedia unavailable */ }
  return true;
}

/**
 * A one-shot burst of `emoji` over its parent. The parent must be positioned;
 * the burst never intercepts pointer events.
 */
export default function SuperReaction({ emoji, onDone }) {
  const [alive, setAlive] = useState(true);

  // Randomise once per burst so two bursts do not look stamped from a mould.
  const particles = useMemo(() => Array.from({ length: PARTICLES }, (_, i) => ({
    id: i,
    left: 10 + Math.random() * 80,          // %
    drift: (Math.random() - 0.5) * 80,      // px sideways
    rise: 60 + Math.random() * 70,          // px upward
    delay: Math.random() * 220,             // ms
    scale: 0.7 + Math.random() * 0.8,
    spin: (Math.random() - 0.5) * 90        // deg
  })), []);

  useEffect(() => {
    const timer = setTimeout(() => { setAlive(false); onDone?.(); }, DURATION_MS + 260);
    return () => clearTimeout(timer);
  }, [onDone]);

  if (!alive) return null;

  return (
    <div className="pointer-events-none absolute inset-0 overflow-visible z-20" aria-hidden="true">
      {particles.map((p) => (
        <span
          key={p.id}
          className="absolute bottom-0 select-none super-reaction-particle"
          style={{
            left: `${p.left}%`,
            fontSize: `${p.scale}rem`,
            animationDelay: `${p.delay}ms`,
            animationDuration: `${DURATION_MS}ms`,
            '--sr-drift': `${p.drift}px`,
            '--sr-rise': `-${p.rise}px`,
            '--sr-spin': `${p.spin}deg`
          }}
        >
          {emoji}
        </span>
      ))}
    </div>
  );
}
