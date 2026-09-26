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
  // A failed first connect must not be cached forever: let a retry try again.
  connectPromise.catch(() => { connectPromise = null; });
  return connectPromise;
}

// --- command timeouts and the stall breaker ------------------------------------
//
// node-redis only times out a command while it waits to be *written*. Once it
// is on the wire it waits for the reply forever. A Redis that is alive at the
// TCP level but not answering (SIGSTOP, a long fork on a starved host, a
// network path that black-holes packets without a reset) therefore used to
// hang every request that touched a rate limit, and every socket connect that
// touched presence.
//
// So every command issued through getRedis()/runScript() races a timer
// (REDIS_COMMAND_TIMEOUT_MS, default 500 ms). The first timeout trips a
// breaker: getRedis() returns null — callers take their local fallback at once
// instead of each waiting out the timer — and a background PING probes once a
// second until Redis answers again. The raw client handed to the Socket.IO
// adapter is not wrapped; the adapter has its own request timeouts.

const COMMAND_TIMEOUT_MS = Math.max(20, Number(process.env.REDIS_COMMAND_TIMEOUT_MS) || 500);
const PROBE_INTERVAL_MS = Math.max(50, Number(process.env.REDIS_STALL_PROBE_MS) || 1000);

let stalledSince = 0;
let probeTimer = null;
let proxied = null;

export class RedisTimeoutError extends Error {
  constructor(what, ms) {
    super(`redis ${what} did not answer within ${ms} ms`);
    this.name = 'RedisTimeoutError';
    this.code = 'REDIS_TIMEOUT';
  }
}

/** True while the breaker is open (a command timed out and no PING has answered since). */
export function redisStalled() {
  return stalledSince > 0;
}

function markStalled(what) {
  if (stalledSince) return;
  stalledSince = Date.now();
  console.warn(`redis: ${what} timed out after ${COMMAND_TIMEOUT_MS} ms — using local fallbacks until it answers again`);
  startProbe();
}

function startProbe() {
  if (probeTimer) return;
  let inFlight = false;
  probeTimer = setInterval(async () => {
    if (inFlight || !client) return;
    inFlight = true;
    try {
      await withTimeout(client.ping(), COMMAND_TIMEOUT_MS, 'PING', { trip: false });
      const stalledForMs = Date.now() - stalledSince;
      stalledSince = 0;
      clearInterval(probeTimer);
      probeTimer = null;
      console.warn(`redis: answering again after ${Math.round(stalledForMs / 1000)} s`);
    } catch { /* still stalled (or down); keep probing */ } finally {
      inFlight = false;
    }
  }, PROBE_INTERVAL_MS);
  probeTimer.unref?.();
}

/**
 * Race `promise` against the command timeout. On timeout the breaker trips
 * (unless `trip: false`) and the returned promise rejects with
 * RedisTimeoutError; the command itself cannot be recalled and simply
 * completes, unobserved, if Redis ever answers.
 */
export function withTimeout(promise, ms = COMMAND_TIMEOUT_MS, what = 'command', { trip = true } = {}) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      if (trip) markStalled(what);
      reject(new RedisTimeoutError(what, ms));
    }, ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const isThenable = (v) => v !== null && (typeof v === 'object' || typeof v === 'function') && typeof v.then === 'function';

/** `multi()` builders: queueing calls are synchronous; exec is the round trip. */
function wrapMulti(multi) {
  return new Proxy(multi, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      if (prop === 'exec' || prop === 'execAsPipeline') {
        return (...args) => withTimeout(value.apply(target, args), COMMAND_TIMEOUT_MS, `MULTI ${String(prop)}`);
      }
      return value.bind(target);
    }
  });
}

/** The client, with every promise-returning command raced against the timeout. */
function timed(c) {
  const cache = new Map();
  return new Proxy(c, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (typeof value !== 'function') return value;
      if (cache.has(prop)) return cache.get(prop);
      const wrapped = (...args) => {
        const result = value.apply(target, args);
        if (prop === 'multi' || prop === 'MULTI') return wrapMulti(result);
        return isThenable(result) ? withTimeout(result, COMMAND_TIMEOUT_MS, String(prop)) : result;
      };
      cache.set(prop, wrapped);
      return wrapped;
    }
  });
}

/**
 * The connected client, or null (not configured, currently down, or stalled).
 * Commands issued through it time out after REDIS_COMMAND_TIMEOUT_MS.
 */
export function getRedis() {
  if (!client?.isReady || stalledSince) return null;
  if (!proxied || proxied.raw !== client) proxied = { raw: client, timed: timed(client) };
  return proxied.timed;
}

/** Health summary for /api/health and /api/ready. */
export function redisHealth() {
  if (!redisConfigured()) return { enabled: false };
  return {
    enabled: true,
    connected: Boolean(client?.isReady) && !stalledSince,
    ...(stalledSince ? { stalled: true, stalled_since: new Date(stalledSince).toISOString() } : {}),
    ...(lastError ? { error: lastError.message } : {})
  };
}

export async function closeRedis() {
  const c = client;
  const s = subscriber;
  client = null;
  subscriber = null;
  connectPromise = null;
  proxied = null;
  stalledSince = 0;
  if (probeTimer) { clearInterval(probeTimer); probeTimer = null; }
  for (const conn of [s, c]) {
    if (!conn) continue;
    // QUIT waits for a reply; a stalled server would hold shutdown hostage.
    try { await withTimeout(conn.quit(), COMMAND_TIMEOUT_MS, 'QUIT', { trip: false }); } catch {
      try { conn.destroy?.(); } catch { /* already gone */ }
    }
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
  // The timed client: SCRIPT LOAD / EVALSHA / EVAL each time out on their own.
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
