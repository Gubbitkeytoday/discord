// ============================================================================
//  Message history helpers: merging by id, capping, and a small per-channel
//  first-page cache with prefetch.
//
//  - mergeMessages(): every path that adds messages (socket, history page,
//    catch-up) goes through one id-keyed merge, so a page that arrives twice
//    (a racing scroll event) can never duplicate rows or React keys.
//  - reconcile(): a refetched page keeps the *same object* for every message
//    that did not change, so memoised rows do not re-render.
//  - capHistory(): an open channel keeps at most MAX_HISTORY messages.
//  - the channel cache renders a recently visited channel instantly and is
//    filled ahead of time by hover / switcher prefetch and at boot.
// ============================================================================

import { get } from '../api';

import { PAGE_SIZE, isLocal } from './messageMerge.js';

export { PAGE_SIZE, MAX_HISTORY, mergeMessages, reconcile, capHistory } from './messageMerge.js';

// --- first-page cache -------------------------------------------------------

const CACHE_LIMIT = 12;
const FRESH_MS = 30_000;       // a prefetch younger than this is not repeated
const cache = new Map();       // channelId -> { list, at }
const inflight = new Map();    // channelId -> Promise<list>

function remember(channelId, list, at = Date.now()) {
  cache.delete(channelId);
  cache.set(channelId, { list, at });
  while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
}

/** The newest page we hold for a channel (possibly stale), or null. */
export function cachedPage(channelId) {
  return cache.get(channelId)?.list ?? null;
}

/** Store the newest page of a channel being left (or just fetched). */
export function rememberPage(channelId, list) {
  if (!channelId || !Array.isArray(list)) return;
  const settled = list.filter((m) => !isLocal(m));
  // Stamped as stale: we left the channel's room, so anything posted since
  // was not received. It renders instantly on return and is revalidated.
  if (settled.length) remember(channelId, settled.slice(-PAGE_SIZE), 0);
}

export function forgetChannel(channelId) {
  cache.delete(channelId);
  inflight.delete(channelId);
}

export function clearMessageCache() {
  cache.clear();
  inflight.clear();
}

/**
 * Fetch a channel's newest page, sharing one request between the boot
 * prefetch, hover prefetch and the channel effect. Resolves to an array.
 */
export function fetchFirstPage(channelId, { force = false } = {}) {
  if (!channelId) return Promise.resolve([]);
  if (inflight.has(channelId)) return inflight.get(channelId);
  const hit = cache.get(channelId);
  if (!force && hit && Date.now() - hit.at < FRESH_MS) return Promise.resolve(hit.list);
  const request = get(`/api/messages/${channelId}?limit=${PAGE_SIZE}`)
    .then((list) => {
      const rows = Array.isArray(list) ? list : [];
      remember(channelId, rows);
      return rows;
    })
    .finally(() => inflight.delete(channelId));
  inflight.set(channelId, request);
  return request;
}

/** Warm the cache on hover / focus / switcher highlight. Errors are ignored. */
export function prefetchChannel(channelId) {
  if (!channelId || inflight.has(channelId)) return;
  const hit = cache.get(channelId);
  if (hit && Date.now() - hit.at < FRESH_MS) return;
  fetchFirstPage(channelId).catch(() => {});
}
