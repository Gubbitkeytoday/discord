// ============================================================================
//  Optional Redis / Valkey connection — the seam for running several app
//  instances behind one load balancer.
//
//  REDIS_URL unset (the default) → nothing here connects, every caller gets
//  `null` from getRedis() and keeps its in-memory behaviour. That is the
//  single-node deployment and it must stay exactly as it was.
//
//  REDIS_URL=redis://valkey:6379 → one shared client is used for:
//    - the Socket.IO Redis Streams adapter (cross-instance fan-out, and
//      connection-state recovery that survives landing on another instance),
//    - the shared rate-limit buckets (lib/rateLimit.js),
//    - presence with TTL heartbeats (lib/presence.js),
//    - a tiny leader lease so once-per-cluster timers run once.
//
//  Valkey speaks the same protocol, so either server works.
// ============================================================================

import crypto from 'node:crypto';
import os from 'node:os';

let client = null;
let connectPromise = null;
let lastError = null;
const scriptShas = new Map();   // script text -> sha1

/** Stable id for this process, used for leases and diagnostics. */
export const INSTANCE_ID = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`;

/** Is Redis configured at all? (Not whether it is currently reachable.) */
export function redisConfigured(env = process.env) {
  return Boolean(String(env.REDIS_URL ?? '').trim());
}

/** Key prefix, so one Valkey can host several deployments. */
export const KEY_PREFIX = (process.env.REDIS_KEY_PREFIX || 'ag:').trim();
export const key = (...parts) => `${KEY_PREFIX}${parts.join(':')}`;

/**
 * Connect once. Resolves to the client, or null when REDIS_URL is unset.
 * A configured-but-unreachable Redis is a boot failure: silently falling back
 * to per-instance state on a multi-instance deployment would split presence,
 * rate limits and fan-out without anyone noticing.
 */
export async function initRedis({ url = process.env.REDIS_URL } = {}) {
  if (!String(url ?? '').trim()) return null;
  if (connectPromise) return connectPromise;
  connectPromise = (async () => {
    const { createClient } = await import('redis');
    const c = createClient({
      url,
      socket: {
        connectTimeout: Number(process.env.REDIS_CONNECT_TIMEOUT_MS) || 5000,
        // Back off up to 5 s between attempts; never give up while running.
        reconnectStrategy: (retries) => Math.min(250 * 2 ** Math.min(retries, 5), 5000)
      }
    });
    c.on('error', (err) => {
      // node-redis emits on every failed reconnect; log the transition only.
      if (lastError?.message !== err.message) console.error('redis error:', err.message);
      lastError = err;
    });
    c.on('ready', () => { lastError = null; });
    await c.connect();
    client = c;
    await startBus(c);
    return c;
  })();
  return connectPromise;
}

/** The connected client, or null (not configured, or currently down). */
export function getRedis() {
  return client?.isReady ? client : null;
}

/** Health summary for /api/health and /api/ready. */
export function redisHealth() {
  if (!redisConfigured()) return { enabled: false };
  return {
    enabled: true,
    connected: Boolean(client?.isReady),
    ...(lastError ? { error: lastError.message } : {})
  };
}

export async function closeRedis() {
  const c = client;
  const s = subscriber;
  client = null;
  subscriber = null;
  connectPromise = null;
  for (const conn of [s, c]) {
    if (!conn) continue;
    try { await conn.quit(); } catch { try { conn.destroy?.(); } catch { /* already gone */ } }
  }
}

// --- cluster bus -------------------------------------------------------------
//
// Tiny pub/sub for cache invalidation between instances (sessions revoked,
// guild permissions changed). Handlers can be registered before Redis is up
// (modules register at import time); they are subscribed once it connects.
// Without Redis, publish() is a no-op: there are no other instances.

let subscriber = null;
const busHandlers = new Map();   // channel -> Set<fn>

async function subscribeChannel(channel) {
  if (!subscriber) return;
  await subscriber.subscribe(key('bus', channel), (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg?.from === INSTANCE_ID) return;          // our own echo
    for (const fn of busHandlers.get(channel) ?? []) {
      try { fn(msg.payload); } catch (err) { console.warn(`bus ${channel} handler failed:`, err.message); }
    }
  });
}

/** Register `fn(payload)` for messages other instances publish on `channel`. */
export function onBus(channel, fn) {
  if (!busHandlers.has(channel)) {
    busHandlers.set(channel, new Set());
    subscribeChannel(channel).catch((err) => console.warn('bus subscribe failed:', err.message));
  }
  busHandlers.get(channel).add(fn);
}

/** Tell the other instances. Best-effort; never throws. */
export async function publishBus(channel, payload) {
  const c = getRedis();
  if (!c) return;
  try {
    await c.publish(key('bus', channel), JSON.stringify({ from: INSTANCE_ID, payload }));
  } catch (err) {
    console.warn(`bus publish ${channel} failed:`, err.message);
  }
}

/** Called by initRedis once the main client is up. */
async function startBus(c) {
  subscriber = c.duplicate();
  subscriber.on('error', () => {});
  await subscriber.connect();
  for (const channel of busHandlers.keys()) await subscribeChannel(channel);
}

/**
 * Run a Lua script by SHA, loading it on first use (or after a Redis restart
 * flushed the script cache). Keys and args are strings.
 */
export async function runScript(script, keys, args) {
  const c = getRedis();
  if (!c) throw new Error('redis unavailable');
  let sha = scriptShas.get(script);
  if (!sha) {
    sha = await c.scriptLoad(script);
    scriptShas.set(script, sha);
  }
  const opts = { keys, arguments: args.map(String) };
  try {
    return await c.evalSha(sha, opts);
  } catch (err) {
    if (!/NOSCRIPT/.test(String(err?.message))) throw err;
    scriptShas.delete(script);
    return c.eval(script, opts);
  }
}

// Renew only when we still hold the lease; never steal someone else's.
const LEASE_SCRIPT = `
local cur = redis.call('GET', KEYS[1])
if cur == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  return 1
end
if not cur then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
  return 1
end
return 0`;

/**
 * Once-per-cluster work (AFK sweep bookkeeping, stale presence reaping,
 * reminders): true when this instance holds — or just acquired — the named
 * lease. Without Redis there is only one instance, so always true.
 */
export async function holdsLease(name, ttlMs = 60_000) {
  if (!redisConfigured()) return true;
  if (!getRedis()) return false;
  try {
    return (await runScript(LEASE_SCRIPT, [key('lease', name)], [INSTANCE_ID, ttlMs])) === 1;
  } catch {
    return false;
  }
}

/**
 * Attach the Socket.IO Redis Streams adapter. Streams (rather than the
 * pub/sub adapter) because they are the adapter that supports connection
 * state recovery: a client that drops and reconnects to a *different*
 * instance still gets the packets it missed.
 */
export async function attachSocketAdapter(io, redis) {
  const { createAdapter } = await import('@socket.io/redis-streams-adapter');
  io.adapter(createAdapter(redis, {
    streamName: key('socket.io'),
    channelPrefix: key('socket.io'),
    sessionKeyPrefix: key('sio-session:'),
    // Enough history to replay a ~2 min disconnect on a busy node; trimmed
    // approximately (~) so XADD stays O(1).
    maxLen: Number(process.env.SOCKET_STREAM_MAXLEN) || 20_000
  }));
}
