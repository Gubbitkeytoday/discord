// ============================================================================
//  Tiny observable state for the PWA layer (update available, install prompt,
//  push status, "ask for notifications" moment), shared by the non-React
//  modules and the React surfaces (PwaPrompts, NotificationsTab).
// ============================================================================

import { useSyncExternalStore } from 'react';

let state = {
  updateReady: false,        // a new service worker is waiting
  installAvailable: false,   // beforeinstallprompt was captured
  installed: false,          // running as an installed app
  askNotifications: false,   // now is a good moment to offer notifications
  pushServerEnabled: null,   // null = unknown, else /api/push/config says
  pushSubscribed: false,     // this browser has a live push subscription
  userId: null
};
const listeners = new Set();

export function getPwaState() { return state; }

export function setPwaState(patch) {
  const next = { ...state, ...patch };
  if (Object.keys(patch).every((k) => Object.is(state[k], next[k]))) return;
  state = next;
  for (const fn of listeners) fn();
}

export function subscribePwa(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function usePwaState() {
  return useSyncExternalStore(subscribePwa, getPwaState, getPwaState);
}

// localStorage can throw (private mode, blocked storage); every access is guarded.
export const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* ignore */ } },
  remove(key) { try { localStorage.removeItem(key); } catch { /* ignore */ } }
};
