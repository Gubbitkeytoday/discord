// The catch-up cursor from GET /api/sync plus the guild state hashes that came
// with it, kept per account in localStorage so it survives a reload. Only a
// convenience: without it the next catch-up answers `reset: true` and the
// client reloads everything, which is always correct.

const KEY = 'antigravity.sync';

export function readSyncState(userId) {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (stored?.userId === userId && typeof stored.cursor === 'string') {
      return { cursor: stored.cursor, hashes: stored.hashes ?? {} };
    }
  } catch { /* unavailable or corrupt */ }
  return { cursor: null, hashes: {} };
}

export function writeSyncState(userId, { cursor, hashes = {} }) {
  if (!userId || !cursor) return;
  try { localStorage.setItem(KEY, JSON.stringify({ userId, cursor, hashes })); } catch { /* private mode */ }
}

export function clearSyncState() {
  try { localStorage.removeItem(KEY); } catch { /* private mode */ }
}

/** Snowflake ids are decimal strings; compare them as numbers. */
export function compareIds(a, b) {
  const x = String(a);
  const y = String(b);
  return x.length - y.length || (x < y ? -1 : x > y ? 1 : 0);
}
