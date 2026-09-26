// ============================================================================
//  PWA bootstrap, imported once from src/main.jsx (before App, so the socket
//  bridge is in place before the app's socket identifies).
//
//  - registers /sw.js in production builds (or with ?sw=1 in dev);
//  - drives the update flow: a waiting worker → "New version available";
//  - keeps <meta name="theme-color"> in step with the in-app theme;
//  - mounts the small PWA surfaces (update / notifications / install) in their
//    own React root, so the app shell does not need to know about them.
// ============================================================================

import { setPwaState } from './store';
import { initInstall } from './install';
import { initFocusReporting, openAppPath } from './socketBridge';
import { refreshPushState, getPushConfig } from './push';

let waitingWorker = null;

function watchForUpdates(registration) {
  const offer = (worker) => {
    waitingWorker = worker;
    setPwaState({ updateReady: true });
  };
  // Only an *update* is worth announcing — the first install has no page
  // controlled by an older version.
  if (registration.waiting && navigator.serviceWorker.controller) offer(registration.waiting);
  registration.addEventListener('updatefound', () => {
    const worker = registration.installing;
    worker?.addEventListener('statechange', () => {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) offer(worker);
    });
  });
  // Long-lived tabs: look for a new version every half hour and when the app
  // comes back to the foreground.
  setInterval(() => registration.update().catch(() => {}), 30 * 60_000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') registration.update().catch(() => {});
  });
}

/** "Reload" in the update banner. */
export function applyUpdate() {
  if (!waitingWorker) { window.location.reload(); return; }
  let reloaded = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloaded) return;
    reloaded = true;
    window.location.reload();
  });
  waitingWorker.postMessage({ type: 'SKIP_WAITING' });
}

async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const devOptIn = new URLSearchParams(window.location.search).has('sw');
  if (!import.meta.env.PROD && !devOptIn) return;
  try {
    const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
    watchForUpdates(registration);
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'OPEN_URL') openAppPath(event.data.url);
    });
    refreshPushState().catch(() => {});
  } catch (err) {
    console.warn('Service worker registration failed:', err?.message ?? err);
  }
}

/** Mirror the app's current background into theme-color (title bar / status bar). */
function syncThemeColor() {
  const apply = () => {
    const bg = getComputedStyle(document.body).backgroundColor;
    if (!bg || bg === 'rgba(0, 0, 0, 0)') return;
    for (const meta of document.querySelectorAll('meta[name="theme-color"]')) meta.setAttribute('content', bg);
  };
  apply();
  const observer = new MutationObserver(() => requestAnimationFrame(apply));
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] });
}

function mountSurfaces() {
  const host = document.createElement('div');
  host.id = 'pwa-root';
  document.body.appendChild(host);
  import('./PwaPrompts.jsx').then(({ mountPwaPrompts }) => mountPwaPrompts(host)).catch(() => {});
}

initInstall();
initFocusReporting();
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { syncThemeColor(); mountSurfaces(); }, { once: true });
} else {
  syncThemeColor();
  mountSurfaces();
}
if (document.readyState === 'complete') registerServiceWorker();
else window.addEventListener('load', registerServiceWorker, { once: true });
getPushConfig().catch(() => {});
