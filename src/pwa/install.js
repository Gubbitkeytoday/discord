// ============================================================================
//  Install ("Add to Home Screen") support.
//
//  Chromium fires `beforeinstallprompt` once the app is installable; keeping
//  the event lets an explicit Install button show the native dialog later.
//  Safari/iOS has no such event — the UI shows instructions instead.
// ============================================================================

import { setPwaState } from './store';
import { isStandalone, isIos } from './push';

let deferred = null;

export function initInstall() {
  setPwaState({ installed: isStandalone() });
  window.addEventListener('beforeinstallprompt', (event) => {
    // Our own button decides when to ask; no mini-infobar on page load.
    event.preventDefault();
    deferred = event;
    setPwaState({ installAvailable: true });
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    setPwaState({ installAvailable: false, installed: true });
  });
}

/** Show the browser's install dialog. Returns 'accepted' | 'dismissed' | 'unavailable'. */
export async function promptInstall() {
  if (!deferred) return 'unavailable';
  const event = deferred;
  deferred = null;
  setPwaState({ installAvailable: false });
  try {
    await event.prompt();
    const choice = await event.userChoice;
    return choice?.outcome === 'accepted' ? 'accepted' : 'dismissed';
  } catch {
    return 'dismissed';
  }
}

/** iOS Safari, not yet installed: the UI explains Share → Add to Home Screen. */
export const needsManualInstall = () => isIos() && !isStandalone();
