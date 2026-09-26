// ============================================================================
//  Rate limiting — token buckets.
//
//  Single node (no REDIS_URL): buckets live in memory, swept periodically so
//  an attacker cannot grow the map without bound.
//
//  Several nodes (REDIS_URL set): the same token-bucket arithmetic runs as one
//  Lua script inside Redis/Valkey, so a client spread across instances by the
//  load balancer shares one budget instead of getting N of them. If Redis is
//  briefly unreachable the limiter fails *open to the local bucket* — still
//  limited per instance, never unlimited, never an outage.
// ============================================================================

import { ApiError } from './httpUtils.js';
import { getRedis, runScript, key as redisKey } from './redis.js';

const buckets = new Map();   // key -> { tokens, updatedAt }
const SWEEP_INTERVAL_MS = 60_000;

const sweeper = setInterval(() => {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [key, bucket] of buckets) {
    if (bucket.updatedAt < cutoff) buckets.delete(key);
  }
}, SWEEP_INTERVAL_MS);
sweeper.unref?.();

/**
 * Consume one token from `key`'s bucket.
 * @returns {{allowed: boolean, retryAfterMs: number, remaining: number}}
 */
export function consume(key, { limit, windowMs }) {
  const now = Date.now();
  const refillRate = limit / windowMs;    // tokens per ms

  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { tokens: limit, updatedAt: now };
    buckets.set(key, bucket);
  } else {
    bucket.tokens = Math.min(limit, bucket.tokens + (now - bucket.updatedAt) * refillRate);
    bucket.updatedAt = now;
  }

  if (bucket.tokens < 1) {
    return {
      allowed: false,
      retryAfterMs: Math.ceil((1 - bucket.tokens) / refillRate),
      remaining: 0
    };
  }
  bucket.tokens -= 1;
  return { allowed: true, retryAfterMs: 0, remaining: Math.floor(bucket.tokens) };
}

// Token bucket in Redis. Time comes from the Redis server (TIME), so instances
// with skewed clocks still agree. Returns {allowed, retryAfterMs, remaining}.
const BUCKET_SCRIPT = `
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local rate = limit / window
local state = redis.call('HMGET', KEYS[1], 't', 'u')
local tokens = tonumber(state[1])
local updated = tonumber(state[2])
if tokens == nil or updated == nil then
  tokens = limit
else
  tokens = math.min(limit, tokens + math.max(0, now - updated) * rate)
end
local allowed = 0
local retry = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retry = math.ceil((1 - tokens) / rate)
end
redis.call('HSET', KEYS[1], 't', tostring(tokens), 'u', tostring(now))
redis.call('PEXPIRE', KEYS[1], window * 2)
return { allowed, retry, math.floor(tokens) }`;

let lastRedisWarning = 0;

/**
 * Shared-budget variant of consume(): Redis when configured and reachable,
 * the local bucket otherwise.
 */
export async function consumeShared(key, { limit, windowMs }) {
  if (!getRedis()) return consume(key, { limit, windowMs });
  try {
    const [allowed, retryAfterMs, remaining] = await runScript(
      BUCKET_SCRIPT, [redisKey('rl', key)], [limit, windowMs]
    );
    return { allowed: Number(allowed) === 1, retryAfterMs: Number(retryAfterMs), remaining: Number(remaining) };
  } catch (err) {
    if (Date.now() - lastRedisWarning > 60_000) {
      lastRedisWarning = Date.now();
      console.warn('rate limit: redis unavailable, using local buckets:', err.message);
    }
    return consume(key, { limit, windowMs });
  }
}

/**
 * Express middleware factory.
 *
 * Keys on the acting user when known, otherwise the IP — an authenticated user
 * behind a shared NAT should not be throttled by their neighbours.
 */
export function rateLimit({ limit, windowMs, name = 'global', byIpOnly = false, keyFn = null, methods = null }) {
  const respond = (req, res, next, result) => {
    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));

    if (!result.allowed) {
      const seconds = Math.ceil(result.retryAfterMs / 1000);
      res.setHeader('Retry-After', String(seconds));
      return next(new ApiError(
        `Too many requests — try again in ${seconds} s`,
        { status: 429, code: 'RATE_LIMITED', details: { retry_after_seconds: seconds } }
      ));
    }
    return next();
  };
  return (req, res, next) => {
    if (methods && !methods.includes(req.method)) return next();
    const identity = keyFn ? keyFn(req) : (byIpOnly ? req.ip : (req.userId ?? req.ip));
    const key = `${name}:${identity}`;
    // Synchronous path when there is no Redis: no extra tick per request.
    if (!getRedis()) return respond(req, res, next, consume(key, { limit, windowMs }));
    return consumeShared(key, { limit, windowMs })
      .then((result) => respond(req, res, next, result), next);
  };
}

const envInt = (name, fallback) => Math.max(1, Number(process.env[name]) || fallback);

// Login: two buckets. Guessing one account's password is bounded per
// (IP, username) — RATE_LIMIT_LOGIN_PER_5MIN, default 10. A wider per-IP
// bucket (RATE_LIMIT_LOGIN_IP_PER_5MIN, default 60) bounds spraying many
// usernames from one address, while an office or carrier NAT full of real
// users no longer locks everyone out after ten attempts.
const loginUsername = (req) => String(req.body?.username ?? req.body?.email ?? '')
  .trim().toLowerCase().slice(0, 128);
export const loginRateLimit = [
  rateLimit({
    name: 'login-ip', limit: envInt('RATE_LIMIT_LOGIN_IP_PER_5MIN', 60), windowMs: 5 * 60_000, byIpOnly: true
  }),
  rateLimit({
    name: 'login', limit: envInt('RATE_LIMIT_LOGIN_PER_5MIN', 10), windowMs: 5 * 60_000,
    keyFn: (req) => `${req.ip}:${loginUsername(req)}`
  })
];

// The write ceiling can be raised for integration tests, which issue hundreds
// of writes as one user inside a minute. Unset in production => 60/min.
const writeLimit = envInt('RATE_LIMIT_WRITE_PER_MIN', 60);
export const writeRateLimit = rateLimit({ name: 'write', limit: writeLimit, windowMs: 60_000 });
export const uploadRateLimit = rateLimit({
  name: 'upload', limit: envInt('RATE_LIMIT_UPLOAD_PER_MIN', 30), windowMs: 60_000
});
// The broad /api budget is split by method, so writes (which mostly carry
// their own write bucket as well) no longer drain the read budget:
//   GET/HEAD/OPTIONS    → RATE_LIMIT_READ_PER_MIN   (default 600)
//   everything else     → RATE_LIMIT_MUTATE_PER_MIN (default max(600, write))
const SAFE = ['GET', 'HEAD', 'OPTIONS'];
const readOnly = rateLimit({
  name: 'read', limit: envInt('RATE_LIMIT_READ_PER_MIN', 600), windowMs: 60_000, methods: SAFE
});
const mutating = rateLimit({
  name: 'mutate', limit: envInt('RATE_LIMIT_MUTATE_PER_MIN', Math.max(600, writeLimit)), windowMs: 60_000,
  methods: ['POST', 'PUT', 'PATCH', 'DELETE']
});
export const readRateLimit = (req, res, next) => (SAFE.includes(req.method)
  ? readOnly(req, res, next)
  : mutating(req, res, next));

/**
 * Socket-side limiter. Gateway events bypass Express entirely, so message sends
 * over the socket need their own bucket.
 */
export function checkSocketLimit(userId, action, { limit, windowMs }) {
  return consume(`socket:${action}:${userId}`, { limit, windowMs });
}

/** Cluster-wide socket budget (per user, across every instance). */
export function checkSocketLimitShared(userId, action, { limit, windowMs }) {
  return consumeShared(`socket:${action}:${userId}`, { limit, windowMs });
}

/**
 * Per-socket flood guard for gateway events that never touch the database
 * (typing, presence, speaking, signalling). Kept in the socket object, not in
 * a shared store: the point is to stop one connection from hammering this
 * process, and the socket's lifetime is exactly the state's lifetime.
 *
 * Each event name has a budget; the fallback budget covers everything else.
 * An over-budget event is dropped (its ack, if any, is answered with
 * RATE_LIMITED). A connection that keeps flooding after being dropped
 * `maxStrikes` times inside `strikeWindowMs` is abusive and is disconnected.
 */
export const SOCKET_EVENT_BUDGETS = {
  typing_start:          { limit: 20,  windowMs: 10_000 },
  typing_stop:           { limit: 20,  windowMs: 10_000 },
  update_presence:       { limit: 10,  windowMs: 10_000 },
  voice_state_change:    { limit: 100, windowMs: 10_000 },   // speaking toggles
  webrtc_ice_candidate:  { limit: 300, windowMs: 10_000 },
  webrtc_offer:          { limit: 60,  windowMs: 10_000 },
  webrtc_answer:         { limit: 60,  windowMs: 10_000 },
  super_reaction:        { limit: 10,  windowMs: 10_000 },
  play_sound:            { limit: 10,  windowMs: 10_000 },
  join_channel:          { limit: 60,  windowMs: 10_000 },
  join_server:           { limit: 60,  windowMs: 10_000 },
  identify:              { limit: 10,  windowMs: 10_000 },
  '*':                   { limit: 200, windowMs: 10_000 }
};

export function createFloodGuard({
  budgets = SOCKET_EVENT_BUDGETS,
  multiplier = Math.max(1, Number(process.env.SOCKET_FLOOD_MULTIPLIER) || 1),
  maxStrikes = 50,
  strikeWindowMs = 10_000
} = {}) {
  const windows = new Map();   // event -> { start, count }
  let strikes = 0;
  let strikeStart = Date.now();
  return {
    /** @returns 'ok' | 'drop' | 'disconnect' */
    check(event) {
      const budget = budgets[event] ?? budgets['*'];
      const limit = budget.limit * multiplier;
      const now = Date.now();
      const bucketKey = budgets[event] ? event : '*';
      let w = windows.get(bucketKey);
      if (!w || now - w.start >= budget.windowMs) {
        w = { start: now, count: 0 };
        windows.set(bucketKey, w);
      }
      w.count += 1;
      if (w.count <= limit) return 'ok';
      if (now - strikeStart >= strikeWindowMs) { strikes = 0; strikeStart = now; }
      strikes += 1;
      return strikes > maxStrikes ? 'disconnect' : 'drop';
    }
  };
}

/** Test seam: drop all state. */
export function resetRateLimits() {
  buckets.clear();
}
