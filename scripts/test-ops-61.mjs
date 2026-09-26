// ============================================================================
//  Redis stall (SIGSTOP) must not hang the shared rate limiter or presence.
//
//  A Redis that keeps its TCP connection open but stops answering is the nasty
//  failure: node-redis never times a command out once it is written, so before
//  lib/redis.js raced every command against REDIS_COMMAND_TIMEOUT_MS, each
//  rate-limited request and each socket connect waited forever.
//
//  This boots a throwaway redis-server, freezes it with SIGSTOP, and checks that
//    - the first shared-bucket call returns within the timeout, from the local
//      bucket, and trips the breaker (health says stalled),
//    - later calls do not wait at all,
//    - presence add/count fall back to the local map just as quickly,
//    - after SIGCONT the probe closes the breaker and Redis is used again.
//
//  Skipped when redis-server is not installed.
// ============================================================================

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';

const PORT = Number(process.env.TEST_REDIS_PORT) || (Number(process.env.TEST_PORT_BASE || 3900) + 61 + 1000);
const TIMEOUT_MS = 200;
process.env.REDIS_COMMAND_TIMEOUT_MS = String(TIMEOUT_MS);
process.env.REDIS_STALL_PROBE_MS = '100';
process.env.REDIS_KEY_PREFIX = `t61:${process.pid}:`;
process.env.REDIS_URL = `redis://127.0.0.1:${PORT}`;

const haveRedis = spawnSync('redis-server', ['--version']).status === 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('redis stall', { skip: haveRedis ? false : 'redis-server not installed' }, () => {
  let server;
  let redis;          // lib/redis.js
  let rateLimit;      // lib/rateLimit.js
  let presence;       // lib/presence.js
  let frozen = false;

  before(async () => {
    server = spawn('redis-server', [
      '--port', String(PORT), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'
    ], { stdio: 'ignore' });
    redis = await import('../lib/redis.js');
    rateLimit = await import('../lib/rateLimit.js');
    presence = await import('../lib/presence.js');
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        await redis.initRedis();
        break;
      } catch (err) {
        if (Date.now() > deadline) throw err;
        await sleep(100);
      }
    }
  });

  after(async () => {
    if (frozen) server.kill('SIGCONT');
    await redis?.closeRedis();
    server?.kill('SIGKILL');
  });

  test('shared buckets live in Redis while it answers', async () => {
    const r = await rateLimit.consumeShared('t61:user', { limit: 5, windowMs: 60_000 });
    assert.equal(r.allowed, true);
    assert.equal(r.remaining, 4);
    const stored = await redis.getRedis().hGet(redis.key('rl', 't61:user'), 't');
    assert.equal(Number(stored), 4, 'the bucket was written to Redis');
  });

  test('a stalled Redis costs at most one timeout, then nothing', async () => {
    server.kill('SIGSTOP');
    frozen = true;

    let t0 = Date.now();
    const first = await rateLimit.consumeShared('t61:stalled', { limit: 3, windowMs: 60_000 });
    const firstMs = Date.now() - t0;
    assert.equal(first.allowed, true, 'fell back to the local bucket');
    assert.ok(firstMs < TIMEOUT_MS + 400, `first call took ${firstMs} ms`);
    assert.equal(redis.redisStalled(), true, 'the breaker tripped');
    assert.equal(redis.getRedis(), null, 'callers see no Redis while stalled');
    assert.equal(redis.redisHealth().stalled, true);
    assert.equal(redis.redisHealth().connected, false);

    // Breaker open: local buckets immediately, still enforcing the limit.
    t0 = Date.now();
    const rest = [];
    for (let i = 0; i < 3; i += 1) rest.push(await rateLimit.consumeShared('t61:stalled', { limit: 3, windowMs: 60_000 }));
    assert.ok(Date.now() - t0 < 50, 'no call waits while the breaker is open');
    assert.deepEqual(rest.map((r) => r.allowed), [true, true, false], 'still limited per instance, never unlimited');

    // The express-rate-limit store takes the same path.
    const store = new rateLimit.TokenBucketStore({ name: 't61', limit: 2, windowMs: 60_000 });
    t0 = Date.now();
    await store.increment('ip');
    await store.decrement('ip');
    await store.resetKey('ip');
    assert.ok(Date.now() - t0 < 50, 'store calls do not wait');

    // Presence: connect/disconnect bookkeeping stays local and instant.
    t0 = Date.now();
    assert.equal(await presence.addConnection('t61-user', 'sock-1'), 1);
    assert.equal(await presence.connectionCount('t61-user'), 1);
    assert.equal(await presence.removeConnection('t61-user', 'sock-1'), 0);
    assert.ok(Date.now() - t0 < 50, 'presence does not wait');
  });

  test('withTimeout rejects a command that never answers', async () => {
    // The primitive under every wrapped command: a reply that never comes
    // becomes a REDIS_TIMEOUT rejection instead of a forever-pending promise.
    assert.equal(redis.redisStalled(), true);
    const racer = redis.withTimeout(new Promise(() => {}), 100, 'test', { trip: false });
    await assert.rejects(racer, { code: 'REDIS_TIMEOUT' });
  });

  test('after SIGCONT the probe closes the breaker and Redis is used again', async () => {
    server.kill('SIGCONT');
    frozen = false;
    const deadline = Date.now() + 5_000;
    while (redis.redisStalled() && Date.now() < deadline) await sleep(50);
    assert.equal(redis.redisStalled(), false, 'breaker closed after Redis answered a PING');
    assert.equal(redis.redisHealth().connected, true);

    const r = await rateLimit.consumeShared('t61:after', { limit: 5, windowMs: 60_000 });
    assert.equal(r.allowed, true);
    const stored = await redis.getRedis().hGet(redis.key('rl', 't61:after'), 't');
    assert.equal(Number(stored), 4, 'shared bucket is back in Redis');
  });
});
