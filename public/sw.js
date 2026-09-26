/* eslint-env serviceworker */
// ============================================================================
//  Service worker: app-shell precache, offline fallback, Web Push, badge.
//
//  `vite build` rewrites the two placeholders below in dist/sw.js (see the
//  pwa-sw plugin in vite.config.js): BUILD_ID changes with every build, which
//  is what makes the browser install a new worker, and PRECACHE lists the
//  hashed JS/CSS the build produced. In dev they stay empty and the worker is
//  not registered at all (src/pwa/register.js).
//
//  Strategies
//    /assets/* (hashed, immutable)   cache-first, filled at install + on use
//    navigations                     network-first → offline.html
//    /api, /socket.io, /uploads      never touched: always the network, never
//                                    cached (private data must not outlive a
//                                    logout on a shared device)
//    icons, manifest, favicon        stale-while-revalidate
//
//  Updates: a new worker installs and then WAITS. The page shows "New version
//  available — Reload"; the button posts SKIP_WAITING, the worker activates,
//  and the page reloads on controllerchange. Nothing swaps under a user
//  mid-conversation.
// ============================================================================

const BUILD_ID = /*__BUILD_ID__*/'dev';
const PRECACHE = /*__PRECACHE__*/[];

const SHELL_CACHE = `shell-${BUILD_ID}`;
const RUNTIME_CACHE = 'runtime-v1';
const OFFLINE_URL = '/offline.html';
const STATIC_FILES = [
  OFFLINE_URL, '/manifest.webmanifest', '/favicon.svg',
  '/icons/icon-192.png', '/icons/badge-72.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // The offline page and icons must make it; a missing chunk must not
    // abort the install (it is fetched on demand instead).
    await cache.addAll(STATIC_FILES);
    await Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => {})));
    // First install: nothing to wait for.
    if (!self.registration.active) await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL_CACHE, RUNTIME_CACHE]);
    for (const key of await caches.keys()) {
      if (!keep.has(key)) await caches.delete(key);
    }
    // Hashed assets of builds that are gone are just dead weight.
    const runtime = await caches.open(RUNTIME_CACHE);
    const requests = await runtime.keys();
    if (requests.length > 400) {
      for (const req of requests.slice(0, requests.length - 400)) await runtime.delete(req);
    }
    if (self.registration.navigationPreload) {
      await self.registration.navigationPreload.enable().catch(() => {});
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  // Only our own pages may drive the worker (skip waiting, version probe).
  if (event.origin !== self.location.origin) return;
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data?.type === 'GET_VERSION') event.source?.postMessage({ type: 'VERSION', buildId: BUILD_ID });
});

// --- fetch ---------------------------------------------------------------------

const NEVER_CACHE = /^\/(api|socket\.io|uploads)(\/|$)/;

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (NEVER_CACHE.test(url.pathname)) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(event));
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(request));
    return;
  }
  if (url.pathname.startsWith('/icons/') || url.pathname === '/manifest.webmanifest' || url.pathname === '/favicon.svg') {
    event.respondWith(staleWhileRevalidate(request, event));
  }
});

async function networkFirstNavigation(event) {
  try {
    const preloaded = await event.preloadResponse;
    if (preloaded) return preloaded;
    return await fetch(event.request);
  } catch {
    const cached = await caches.match(OFFLINE_URL);
    return cached ?? new Response('Offline', { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const copy = response.clone();
    caches.open(RUNTIME_CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
  }
  return response;
}

async function staleWhileRevalidate(request, event) {
  const cached = await caches.match(request);
  const refresh = fetch(request).then(async (response) => {
    if (response.ok) await (await caches.open(RUNTIME_CACHE)).put(request, response.clone());
    return response;
  }).catch(() => cached);
  if (cached) { event.waitUntil(refresh); return cached; }
  return refresh;
}

// --- push ------------------------------------------------------------------------

// The server sends Declarative Web Push JSON ({ web_push: 8030, notification:
// {...} }). Safari 18.4+ displays that itself; everywhere else it lands here.
self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; }
  catch { payload = { notification: { title: 'Antigravity', body: event.data?.text?.() ?? '' } }; }
  const n = payload.notification ?? {};
  const data = payload.data ?? {};
  const badge = Number(n.app_badge ?? data.badge ?? 0);

  event.waitUntil((async () => {
    if ('setAppBadge' in self.navigator) {
      try {
        if (badge > 0) await self.navigator.setAppBadge(badge);
        else if (n.app_badge !== undefined) await self.navigator.clearAppBadge();
      } catch { /* badging not allowed here */ }
    }
    await self.registration.showNotification(n.title || 'Antigravity', {
      body: n.body ?? '',
      tag: n.tag,
      renotify: Boolean(n.tag),
      silent: Boolean(n.silent),
      icon: '/icons/icon-192.png',
      badge: '/icons/badge-72.png',
      timestamp: Date.now(),
      data: { url: n.navigate || data.url || '/channels/@me', ...data }
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  let target;
  try { target = new URL(event.notification.data?.url || '/channels/@me', self.location.origin); }
  catch { target = new URL('/channels/@me', self.location.origin); }
  // Only ever open our own origin, whatever the payload said.
  if (target.origin !== self.location.origin) target = new URL('/channels/@me', self.location.origin);
  const path = target.pathname + target.search;

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const existing = windows.find((c) => new URL(c.url).origin === self.location.origin);
    if (existing) {
      await existing.focus().catch(() => {});
      // The page decides how to get there (in-app navigation, else a load).
      existing.postMessage({ type: 'OPEN_URL', url: path });
      return;
    }
    await self.clients.openWindow(path);
  })());
});

// The push service rotated the subscription: re-register the new one with the
// server (the session cookie rides along) and drop the old endpoint.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const old = event.oldSubscription;
    let fresh = event.newSubscription;
    if (!fresh && old?.options) {
      fresh = await self.registration.pushManager.subscribe(old.options).catch(() => null);
    }
    if (fresh) {
      await fetch('/api/push/subscriptions', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fresh.toJSON())
      }).catch(() => {});
    }
    if (old?.endpoint && old.endpoint !== fresh?.endpoint) {
      await fetch('/api/push/subscriptions', {
        method: 'DELETE', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: old.endpoint })
      }).catch(() => {});
    }
  })());
});
