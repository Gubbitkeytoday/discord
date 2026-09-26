// ============================================================================
//  Motion and viewer preferences for profile cosmetics.
//
//  Motion follows both the OS "reduce motion" switch and the app's own
//  Accessibility setting (prefersReducedMotion does both). The viewer
//  preferences say how *other people's* profiles are shown on this device:
//  decorations (animate / hover / off), profile effects, name styles (and
//  whether they show in dense lists), custom profile colours.
//
//  Both hooks run in every message row and member row, so they are external
//  stores (useSyncExternalStore): no per-row state, effect, media-query
//  listener or copy of the settings — a row re-renders only when the value
//  it reads actually changes.
// ============================================================================

import { useSyncExternalStore } from 'react';
import { getPreferences, subscribePreferences } from '../hooks/useUserSettings';

// --- motion ---------------------------------------------------------------------

let osQuery = null;
function reduceQuery() {
  if (osQuery === null) {
    try { osQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? false; } catch { osQuery = false; }
  }
  return osQuery || null;
}

/** Same rule as useUserSettings' prefersReducedMotion, with one shared query. */
function motionAllowedNow() {
  const a11y = getPreferences()?.accessibility ?? {};
  if (a11y.syncReducedMotion !== false) return !(reduceQuery()?.matches ?? false);
  return !a11y.reducedMotion;
}

function subscribeMotion(fn) {
  const unsubscribe = subscribePreferences(fn);
  const mq = reduceQuery();
  mq?.addEventListener?.('change', fn);
  return () => { unsubscribe(); mq?.removeEventListener?.('change', fn); };
}

/** True when cosmetics may animate right now. */
export function useMotionAllowed() {
  return useSyncExternalStore(subscribeMotion, motionAllowedNow, () => true);
}

// --- viewer preferences ------------------------------------------------------------

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

function subscribeViewer(fn) {
  listeners.add(fn);
  const unsubscribe = subscribePreferences(fn);
  return () => { listeners.delete(fn); unsubscribe(); };
}

// The effective view, rebuilt only when one of its inputs changes so every
// caller gets the same object (a stable snapshot for useSyncExternalStore).
let effective = null;
function effectiveViewerPrefs() {
  const app = getPreferences();
  // High contrast and streamer mode switch the decorative layers off.
  const highContrast = Boolean(app?.accessibility?.highContrast);
  const streamer = Boolean(app?.streamerMode?.enabled);
  if (effective && effective.base === current && effective.highContrast === highContrast && effective.streamer === streamer) {
    return effective.value;
  }
  const value = {
    ...current,
    profileColors: current.profileColors && !highContrast,
    decorations: streamer ? 'off' : current.decorations,
    effects: current.effects && !streamer,
    highContrast
  };
  effective = { base: current, highContrast, streamer, value };
  return value;
}

export function useViewerPrefs() {
  return useSyncExternalStore(subscribeViewer, effectiveViewerPrefs, effectiveViewerPrefs);
}
