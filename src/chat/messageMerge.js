// ============================================================================
//  Pure history helpers (no network, no DOM) — unit-tested in
//  scripts/test-chat-01.mjs. See messageStore.js for how they are used.
// ============================================================================

import { compareIds } from '../utils/syncCursor.js';

export const PAGE_SIZE = 50;
export const MAX_HISTORY = 5000;

export const isLocal = (m) => Boolean(m.pending || m.failed);

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

