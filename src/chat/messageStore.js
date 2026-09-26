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
import { compareIds } from '../utils/syncCursor';

export const PAGE_SIZE = 50;
export const MAX_HISTORY = 1500;

const isLocal = (m) => m.pending || m.failed;

/** Sort settled messages by snowflake, keep pending/failed ones at the end. */
function order(list) {
  const settled = list.filter((m) => !isLocal(m)).sort((a, b) => compareIds(a.id, b.id));
  return [...settled, ...list.filter(isLocal)];
}

/**
 * Merge `incoming` into `prev`, de-duplicated by id. A server message that
 * echoes a pending one (same nonce) replaces it in place. Returns `prev`
 * itself when nothing changed.
 */
export function mergeMessages(prev, incoming) {
  if (!incoming?.length) return prev;
  const byId = new Map(prev.map((m, i) => [m.id, i]));
  const next = [...prev];
  let changed = false;
  let needsSort = false;
  const lastSettled = [...prev].reverse().find((m) => !isLocal(m));
  for (const msg of incoming) {
    if (!msg?.id) continue;
    if (byId.has(msg.id)) {
      const i = byId.get(msg.id);
      if (next[i] !== msg && JSON.stringify(next[i]) !== JSON.stringify(msg)) { next[i] = msg; changed = true; }
      continue;
    }
    const pendingIdx = msg.nonce ? next.findIndex((m) => m.pending && m.nonce === msg.nonce) : -1;
    if (pendingIdx !== -1) next[pendingIdx] = msg;
    else next.push(msg);
    byId.set(msg.id, pendingIdx !== -1 ? pendingIdx : next.length - 1);
    changed = true;
    if (!lastSettled || compareIds(msg.id, lastSettled.id) < 0 || pendingIdx !== -1 || next.some(isLocal)) needsSort = true;
  }
  if (!changed) return prev;
  return needsSort ? order(next) : next;
}

/** Replace `prev` with `fresh`, reusing unchanged message objects. */
export function reconcile(prev, fresh) {
  if (!Array.isArray(fresh)) return prev;
  const old = new Map(prev.map((m) => [m.id, m]));
  let same = prev.length === fresh.length;
  const out = fresh.map((msg, i) => {
    const before = old.get(msg.id);
    if (before && JSON.stringify(before) === JSON.stringify(msg)) {
      if (prev[i] !== before) same = false;
      return before;
    }
    same = false;
    return msg;
  });
  return same ? prev : out;
}

/**
 * Keep at most `max` messages. `keep: 'newest'` drops from the top (you are
 * reading the present), `'oldest'` drops from the bottom (you scrolled far
 * back). Reports what was dropped so paging flags can be updated.
 */
export function capHistory(list, { max = MAX_HISTORY, keep = 'newest' } = {}) {
  if (list.length <= max) return { list, droppedOlder: false, droppedNewer: false };
  if (keep === 'newest') return { list: list.slice(list.length - max), droppedOlder: true, droppedNewer: false };
  return { list: list.slice(0, max), droppedOlder: false, droppedNewer: true };
}

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
