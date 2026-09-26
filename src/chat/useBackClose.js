import { useEffect, useRef } from 'react';

// ============================================================================
//  Android "back" (and the browser back button) closes the top overlay —
//  the channel drawer, a bottom sheet, a full-screen search — instead of
//  leaving the app, which is what every native chat app does.
//
//  While an overlay is open it owns one history entry (same URL, marked in
//  `history.state`). Back pops that entry and we close the overlay; closing
//  it any other way removes the entry again with history.back(), so the
//  stack never fills up with dead entries. Overlays stack: only the top one
//  reacts to a pop.
// ============================================================================

const stack = [];
let ignoreNextPop = 0;
let listening = false;
let canonicalPath = null;

/** Keep the address bar on the app's current location after any pop we cause. */
function restorePath() {
  if (canonicalPath && window.location.pathname !== canonicalPath) {
    window.history.replaceState(window.history.state, '', canonicalPath);
  }
}

/**
 * The app's replacement for history.replaceState(null, '', path): it keeps
 * any overlay marker on the current entry, and survives the history.back()
 * an overlay does when it closes (which would otherwise restore an old URL).
 */
export function setCanonicalPath(path) {
  canonicalPath = path;
  ensureListener();
  if (window.location.pathname !== path) window.history.replaceState(window.history.state, '', path);
}

function onPopState() {
  if (ignoreNextPop > 0) { ignoreNextPop -= 1; restorePath(); return; }
  const top = stack[stack.length - 1];
  if (!top) return;
  // The entry we pushed is gone: this "back" was aimed at the overlay.
  if (window.history.state?.overlay === top.token) return;
  stack.pop();
  top.closedByBack = true;
  top.onClose.current?.();
  restorePath();
}

function ensureListener() {
  if (listening || typeof window === 'undefined') return;
  window.addEventListener('popstate', onPopState);
  listening = true;
}

/**
 * @param open    whether the overlay is showing
 * @param onClose closes it (called on back)
 */
export function useBackClose(open, onClose) {
  const handler = useRef(onClose);
  handler.current = onClose;

  useEffect(() => {
    if (!open || typeof window === 'undefined' || !window.history?.pushState) return undefined;
    ensureListener();
    const token = `ov-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const entry = { token, onClose: handler, closedByBack: false };
    try {
      window.history.pushState({ ...(window.history.state ?? {}), overlay: token }, '');
    } catch { return undefined; }
    stack.push(entry);
    return () => {
      const index = stack.indexOf(entry);
      if (index !== -1) stack.splice(index, 1);
      // Closed by the UI: drop our history entry if it is still on top.
      if (!entry.closedByBack && window.history.state?.overlay === token) {
        ignoreNextPop += 1;
        window.history.back();
      }
    };
  }, [open]);
}
