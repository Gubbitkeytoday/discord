// ============================================================================
//  Client caches: the cosmetics catalogue (fetched once) and per-user
//  identities (batched: every surface that renders a name in the same tick
//  shares one GET /api/identities request).
//
//  Integration: call handleIdentityEvent(payload) from the socket's
//  'identity_updated' and 'server_identity_updated' events so open lists and
//  profiles refresh.
// ============================================================================

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { get } from '../api';
import { currentLocaleCode } from '../i18n/index.jsx';

// --- catalogue -------------------------------------------------------------------

let catalogue = null;
let cataloguePromise = null;
const catalogueListeners = new Set();

export function loadCatalogue({ force = false } = {}) {
  if (catalogue && !force) return Promise.resolve(catalogue);
  if (cataloguePromise && !force) return cataloguePromise;
  cataloguePromise = get('/api/cosmetics')
    .then((data) => {
      catalogue = { packs: data?.packs ?? [], items: data?.items ?? [] };
      for (const fn of catalogueListeners) fn();
      return catalogue;
    })
    .catch((err) => { cataloguePromise = null; throw err; });
  return cataloguePromise;
}

export function useCatalogue() {
  const snapshot = useSyncExternalStore(
    (fn) => { catalogueListeners.add(fn); return () => catalogueListeners.delete(fn); },
    () => catalogue
  );
  useEffect(() => { if (!catalogue) loadCatalogue().catch(() => {}); }, []);
  return snapshot;
}

/** An item's display name in the current language. */
export function itemName(item) {
  if (!item) return '';
  return currentLocaleCode() === 'th' && item.name_th ? item.name_th : item.name;
}

// --- identities ------------------------------------------------------------------

const identities = new Map();        // key -> identity | null
const pending = new Map();           // serverKey -> Set(userId)
const identityListeners = new Set();
let version = 0;
let flushScheduled = false;

const keyOf = (userId, serverId) => `${serverId || '-'}:${userId}`;

function notify() {
  version += 1;
  for (const fn of identityListeners) fn();
}

async function flush() {
  flushScheduled = false;
  const batches = [...pending.entries()];
  pending.clear();
  for (const [serverKey, set] of batches) {
    const ids = [...set];
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      const serverId = serverKey === '-' ? null : serverKey;
      const q = `/api/identities?ids=${chunk.map(encodeURIComponent).join(',')}${serverId ? `&server_id=${encodeURIComponent(serverId)}` : ''}`;
      try {
        const data = await get(q);
        for (const id of chunk) identities.set(keyOf(id, serverId), data?.[id] ?? null);
      } catch {
        for (const id of chunk) identities.set(keyOf(id, serverId), null);
      }
    }
  }
  notify();
}

function request(userId, serverId) {
  const key = keyOf(userId, serverId);
  if (identities.has(key)) return;
  identities.set(key, undefined); // in flight
  const serverKey = serverId || '-';
  if (!pending.has(serverKey)) pending.set(serverKey, new Set());
  pending.get(serverKey).add(userId);
  if (!flushScheduled) {
    flushScheduled = true;
    setTimeout(flush, 0);
  }
}

const subscribe = (fn) => { identityListeners.add(fn); return () => identityListeners.delete(fn); };
const getVersion = () => version;

/** Identity of one user (in a server's context when serverId is given). */
export function useIdentity(userId, serverId = null) {
  const v = useSyncExternalStore(subscribe, getVersion);
  const sid = serverId && serverId !== 'home' ? serverId : null;
  // `v` too: after invalidateIdentity() drops an entry, the next version
  // re-requests it (request() is a no-op for anything cached or in flight).
  useEffect(() => { if (userId) request(userId, sid); }, [userId, sid, v]);
  return userId ? identities.get(keyOf(userId, sid)) ?? null : null;
}

/** Identities for a list of users, keyed by id. */
export function useIdentities(userIds, serverId = null) {
  const v = useSyncExternalStore(subscribe, getVersion);
  const sid = serverId && serverId !== 'home' ? serverId : null;
  const key = (userIds ?? []).join(',');
  useEffect(() => {
    for (const id of userIds ?? []) if (id) request(id, sid);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, sid, v]);
  return useMemo(() => {
    const out = {};
    for (const id of userIds ?? []) out[id] = identities.get(keyOf(id, sid)) ?? null;
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, sid, v]);
}

/** Seed the cache (e.g. from GET /api/profiles/:id) without a request. */
export function primeIdentity(userId, serverId, identity) {
  identities.set(keyOf(userId, serverId && serverId !== 'home' ? serverId : null), identity ?? null);
  notify();
}

/** Drop cached identities so the next render refetches. */
export function invalidateIdentity(userId = null, serverId = undefined) {
  for (const key of [...identities.keys()]) {
    const [s, u] = key.split(':');
    if (userId && u !== userId) continue;
    if (serverId !== undefined && s !== (serverId || '-')) continue;
    identities.delete(key);
  }
  notify();
}

/**
 * Socket handler: `identity_updated` { user_id, server_id? } and
 * `server_identity_updated` { server_id } (tag / hide-cosmetics changes).
 */
export function handleIdentityEvent(payload = {}) {
  if (payload.user_id) invalidateIdentity(payload.user_id);
  else if (payload.server_id) invalidateIdentity(null, payload.server_id);
}

if (typeof window !== 'undefined') {
  window.addEventListener('profiles:identity-changed', (e) => handleIdentityEvent(e.detail ?? {}));
}

/** Tell every mounted surface that someone's identity changed (local edits). */
export function announceLocalIdentityChange(userId) {
  try { window.dispatchEvent(new CustomEvent('profiles:identity-changed', { detail: { user_id: userId } })); } catch { /* SSR */ }
}

/** For tests and screenshots: current cache size. */
export function useIdentityVersion() {
  return useSyncExternalStore(subscribe, getVersion);
}

export function useCatalogueByKind() {
  const cat = useCatalogue();
  return useMemo(() => {
    const byKind = { avatar_decoration: [], profile_effect: [], nameplate: [], profile_frame: [] };
    for (const item of cat?.items ?? []) byKind[item.kind]?.push(item);
    return byKind;
  }, [cat]);
}
