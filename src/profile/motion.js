// ============================================================================
//  Motion and viewer preferences for profile cosmetics.
//
//  Motion follows both the OS "reduce motion" switch and the app's own
//  Accessibility setting (prefersReducedMotion does both). The viewer
//  preferences say how *other people's* profiles are shown on this device:
//  decorations (animate / hover / off), profile effects, name styles (and
//  whether they show in dense lists), custom profile colours.
// ============================================================================

import { useEffect, useState } from 'react';
import { useUserSettings, prefersReducedMotion } from '../hooks/useUserSettings';

/** True when cosmetics may animate right now. */
export function useMotionAllowed() {
  const { prefs } = useUserSettings();
  const [osTick, setOsTick] = useState(0);
  useEffect(() => {
    let mq;
    try { mq = window.matchMedia?.('(prefers-reduced-motion: reduce)'); } catch { mq = null; }
    if (!mq) return undefined;
    const onChange = () => setOsTick((n) => n + 1);
    mq.addEventListener?.('change', onChange);
    return () => mq.removeEventListener?.('change', onChange);
  }, []);
  void osTick;
  return !prefersReducedMotion(prefs);
}

export const VIEWER_DEFAULTS = Object.freeze({
  decorations: 'animate',   // animate (in profiles; hover in lists) | hover | off
  effects: true,
  nameStyles: true,
  nameStylesInLists: true,
  profileColors: true
});

const KEY = 'profiles.viewer.v1';
let current = read();
const listeners = new Set();

function read() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    return { ...VIEWER_DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  } catch {
    return { ...VIEWER_DEFAULTS };
  }
}

export function getViewerPrefs() { return current; }

export function setViewerPrefs(patch) {
  current = { ...current, ...patch };
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* private mode */ }
  for (const fn of listeners) fn(current);
}

export function useViewerPrefs() {
  const [prefs, setPrefs] = useState(current);
  useEffect(() => {
    listeners.add(setPrefs);
    return () => { listeners.delete(setPrefs); };
  }, []);
  // High contrast and streamer mode switch the decorative layers off.
  const { prefs: app } = useUserSettings();
  const highContrast = Boolean(app?.accessibility?.highContrast);
  const streamer = Boolean(app?.streamerMode?.enabled);
  return {
    ...prefs,
    profileColors: prefs.profileColors && !highContrast,
    decorations: streamer ? 'off' : prefs.decorations,
    effects: prefs.effects && !streamer,
    highContrast
  };
}
