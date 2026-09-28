// ============================================================================
//  Connection presence — "how many live connections does this user have?"
//
//  The gateway goes online on a user's first connection and offline on their
//  last. On one process a Map answers that. With several instances behind a
//  load balancer each only sees its own sockets, so the count has to live in
//  Redis — and an instance that crashes must not leave its users "online"
//  forever, which is what the TTL heartbeats are for:
//
//    ag:presence:u:<userId>  ZSET  member = "<instance>|<socketId>",
//                                  score  = expiry (ms since epoch)
//    ag:presence:users       SET   user ids that currently have a ZSET
//
//  Every instance refreshes the scores of its own sockets on an interval;
//  entries whose score has passed are dead connections. A reaper (one
//  instance at a time, via a lease) prunes them and reports users whose
//  count fell to zero so they can be marked offline exactly once — the
//  prune-and-check is a single Lua script, so two reapers cannot both win.
//
//  Without Redis the same interface is backed by a Map and nothing expires
//  (the process that owns the sockets is the process that counts them).
// ============================================================================

import { getRedis, runScript, key, INSTANCE_ID } from './redis.js';
import { getContext } from './logger.js';

export const PRESENCE_TTL_MS = Math.max(15_000, Number(process.env.PRESENCE_TTL_MS) || 90_000);

const ADD = `
local now = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1])
redis.call('PEXPIRE', KEYS[1], ARGV[4])
redis.call('SADD', KEYS[2], ARGV[5])
return redis.call('ZCARD', KEYS[1])`;

const REMOVE = `
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[2])
local n = redis.call('ZCARD', KEYS[1])
if n == 0 then
  redis.call('DEL', KEYS[1])
  redis.call('SREM', KEYS[2], ARGV[3])
end
return n`;

// Returns 1 when this call is the one that observed the user reach zero.
const REAP = `
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', ARGV[1])
if redis.call('ZCARD', KEYS[1]) == 0 then
  redis.call('DEL', KEYS[1])
  return redis.call('SREM', KEYS[2], ARGV[2])
end
return 0`;

const memberOf = (socketId) => `${INSTANCE_ID}|${socketId}`;
const userKey = (userId) => key('presence', 'u', userId);
const USERS = key('presence', 'users');

// Local fallback: userId -> Set<socketId>.
const local = new Map();

/** Register a connection; resolves to the user's connection count after it. */
export async function addConnection(userId, socketId) {
  const set = local.get(userId) ?? new Set();
  set.add(socketId);
  local.set(userId, set);
  if (!getRedis()) return set.size;
  try {
    const now = Date.now();
    return Number(await runScript(ADD, [userKey(userId), USERS],
      [memberOf(socketId), now + PRESENCE_TTL_MS, now, PRESENCE_TTL_MS * 2, userId]));
  } catch (err) {
    console.warn('presence add fell back to local:', err.message);
    return set.size;
  }
}

/** Drop a connection; resolves to the number the user still has. */
export async function removeConnection(userId, socketId) {
  const set = local.get(userId);
  set?.delete(socketId);
  if (set && set.size === 0) local.delete(userId);
  if (!getRedis()) return set?.size ?? 0;
  try {
    return Number(await runScript(REMOVE, [userKey(userId), USERS],
      [memberOf(socketId), Date.now(), userId]));
  } catch (err) {
    console.warn('presence remove fell back to local:', err.message);
    return set?.size ?? 0;
  }
}

/** Refresh the TTL of every connection this instance owns. */
export async function heartbeat() {
  const redis = getRedis();
  if (!redis || local.size === 0) return;
  const expires = Date.now() + PRESENCE_TTL_MS;
  const multi = redis.multi();
  for (const [userId, sockets] of local) {
    for (const socketId of sockets) multi.zAdd(userKey(userId), { score: expires, value: memberOf(socketId) });
    multi.pExpire(userKey(userId), PRESENCE_TTL_MS * 2);
    multi.sAdd(USERS, userId);
  }
  await multi.exec();
}

/**
 * Prune connections whose instance stopped heart-beating. Returns the user ids
 * that just went to zero connections (only this caller sees each one).
 */
export async function reap({ batch = 500 } = {}) {
  const redis = getRedis();
  if (!redis) return [];
  const gone = [];
  let cursor = '0';
  const now = Date.now();
  do {
    const res = await redis.sScan(USERS, cursor, { COUNT: batch });
    cursor = String(res.cursor);
    for (const userId of res.members) {
      if (local.has(userId)) continue;   // we own a live socket for them
      const n = await runScript(REAP, [userKey(userId), USERS], [now, userId]);
      if (Number(n) === 1) gone.push(userId);
    }
  } while (cursor !== '0');
  return gone;
}

/** Live connections of a user on every instance (this one without Redis). */
export async function connectionCount(userId) {
  const redis = getRedis();
  if (!redis) return localCount(userId);
  try {
    return Number(await redis.zCount(userKey(userId), Date.now(), '+inf'));
  } catch {
    return localCount(userId);
  }
}

/** Local connection count only (this instance). */
export function localCount(userId) {
  return local.get(userId)?.size ?? 0;
}

/** Test seam. */
export function resetLocalPresence() { local.clear(); }

// ============================================================================
//  What others may see of someone's status.
//
//  "Invisible" is a choice to look offline. It must never reach anyone but its
//  owner — being seen as *invisible* is worse than being seen online. Every
//  member / profile / presence payload runs a status through publicStatus().
// ============================================================================


/** `status` as `viewerId` may see it on `userId`: invisible → offline for everyone else. */
export function publicStatus(status, viewerId, userId) {
  if (status === 'invisible' && (!viewerId || viewerId !== userId)) return 'offline';
  return status ?? 'offline';
}

/** Apply publicStatus to a row carrying `status` and an id (`id` or `user_id`). */
export function maskStatus(row, viewerId) {
  if (!row || row.status === undefined) return row;
  const ownerId = row.user_id ?? row.id;
  const status = publicStatus(row.status, viewerId, ownerId);
  return status === row.status ? row : { ...row, status };
}

/**
 * The user the current HTTP request acts for (set by lib/httpUtils.js
 * identify), or null outside a request — a socket fan-out, a job. Callers
 * that are not told their viewer explicitly fall back to this, and "no
 * viewer" is treated as a stranger, never as the owner.
 */
export function currentViewerId() {
  return getContext()?.user_id ?? null;
}
