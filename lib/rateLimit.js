// ============================================================================
//  Rate limiting — token buckets kept in memory.
//
//  In-process on purpose: this is a single-node deployment, and a Redis
//  dependency would buy nothing until there are several nodes. The bucket map is
//  swept periodically so an attacker cannot grow it without bound.
// ============================================================================

import { ApiError } from './httpUtils.js';

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

/**
 * Express middleware factory.
 *
 * Keys on the acting user when known, otherwise the IP — an authenticated user
 * behind a shared NAT should not be throttled by their neighbours.
 */
export function rateLimit({ limit, windowMs, name = 'global', byIpOnly = false }) {
  return (req, res, next) => {
    const identity = byIpOnly ? req.ip : (req.userId ?? req.ip);
    const key = `${name}:${identity}`;
    const result = consume(key, { limit, windowMs });

    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(result.remaining));

    if (!result.allowed) {
      const seconds = Math.ceil(result.retryAfterMs / 1000);
      res.setHeader('Retry-After', String(seconds));
      return next(new ApiError(
        `ทำรายการถี่เกินไป ลองอีกครั้งใน ${seconds} วินาที`,
        { status: 429, code: 'RATE_LIMITED', details: { retry_after_seconds: seconds } }
      ));
    }
    return next();
  };
}

// Login is keyed by IP only: an attacker guessing passwords supplies whatever
// username they like, so per-user keying would be trivially bypassed.
export const loginRateLimit = rateLimit({
  name: 'login', limit: 10, windowMs: 5 * 60_000, byIpOnly: true
});

// The write ceiling can be raised for integration tests, which issue hundreds
// of writes as one user inside a minute. Unset in production => 60/min.
const writeLimit = Math.max(1, Number(process.env.RATE_LIMIT_WRITE_PER_MIN) || 60);
export const writeRateLimit = rateLimit({ name: 'write', limit: writeLimit, windowMs: 60_000 });
export const uploadRateLimit = rateLimit({ name: 'upload', limit: 30, windowMs: 60_000 });
export const readRateLimit = rateLimit({ name: 'read', limit: 600, windowMs: 60_000 });

/**
 * Socket-side limiter. Gateway events bypass Express entirely, so message sends
 * over the socket need their own bucket.
 */
export function checkSocketLimit(userId, action, { limit, windowMs }) {
  return consume(`socket:${action}:${userId}`, { limit, windowMs });
}

/** Test seam: drop all state. */
export function resetRateLimits() {
  buckets.clear();
}
