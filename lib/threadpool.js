// ============================================================================
//  libuv thread-pool size — must run before anything touches the pool.
//
//  scrypt (password hashing), node-sqlite3 queries, fs and dns all share the
//  libuv pool, which defaults to 4 threads. During a login storm four scrypt
//  hashes occupy every thread and each database query queues behind them: the
//  load suite measured a mean SQL wait of 2.7 s and /auth/me p50 of 2.4 s
//  (docs/PERFORMANCE.md #6). A larger pool lets queries run alongside hashing.
//
//  libuv reads UV_THREADPOOL_SIZE once, when the pool is first used, so this
//  module is the first import of server.js (ES modules evaluate in import
//  order, and nothing before it uses the pool). An explicit value in the
//  environment always wins.
// ============================================================================

import os from 'node:os';

if (!process.env.UV_THREADPOOL_SIZE) {
  const cores = typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length;
  // 16 by default; more on big machines, capped well below libuv's 1024.
  process.env.UV_THREADPOOL_SIZE = String(Math.min(64, Math.max(16, cores * 2)));
}

export const THREADPOOL_SIZE = Number(process.env.UV_THREADPOOL_SIZE);
