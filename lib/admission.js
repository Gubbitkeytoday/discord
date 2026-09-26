// ============================================================================
//  Admission control for the message write path.
//
//  Without it, when the database falls behind every send queues without
//  bound: the load suite saw messages processed and fanned out 40–60 s after
//  the sender had given up on the ack, the SQL queue at ~5,900 and RSS
//  climbing — and clients retrying on top (docs/PERFORMANCE.md #9).
//
//  A limiter admits `concurrency` operations at a time and queues at most
//  `maxQueue` more for at most `maxWaitMs`. Anything beyond that is refused
//  at once with 503 RETRY_LATER (+ retry_after_seconds), which the client
//  can surface or retry with backoff — graceful degradation with a bounded
//  p99 for accepted work, instead of collapse.
// ============================================================================

import { ApiError } from './httpUtils.js';

export function retryLater(name, seconds = 2) {
  return new ApiError('The server is busy — try again in a moment', {
    status: 503, code: 'RETRY_LATER', details: { retry_after_seconds: seconds, queue: name }
  });
}

export function createAdmission({ name, concurrency, maxQueue, maxWaitMs }) {
  let active = 0;
  const queue = [];
  const stats = { admitted: 0, queued: 0, rejected: 0, timedOut: 0, maxQueueSeen: 0 };

  function release() {
    const next = queue.shift();
    if (next) {
      clearTimeout(next.timer);
      next.resolve();            // hand the slot over; `active` is unchanged
    } else {
      active -= 1;
    }
  }

  async function run(fn) {
    if (active < concurrency) {
      active += 1;
    } else {
      if (queue.length >= maxQueue) {
        stats.rejected += 1;
        throw retryLater(name);
      }
      stats.queued += 1;
      await new Promise((resolve, reject) => {
        const item = { resolve, reject, timer: null };
        item.timer = setTimeout(() => {
          const i = queue.indexOf(item);
          if (i >= 0) queue.splice(i, 1);
          stats.timedOut += 1;
          reject(retryLater(name));
        }, maxWaitMs);
        queue.push(item);
        stats.maxQueueSeen = Math.max(stats.maxQueueSeen, queue.length);
      });
    }
    stats.admitted += 1;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  return {
    run,
    snapshot: () => ({ name, active, queued: queue.length, concurrency, maxQueue, maxWaitMs, ...stats })
  };
}

const envInt = (key, fallback) => Math.max(1, Number(process.env[key]) || fallback);

/** Shared by POST /api/messages and the gateway's send_message. */
export const messageAdmission = createAdmission({
  name: 'messages',
  concurrency: envInt('MESSAGE_WRITE_CONCURRENCY', 32),
  maxQueue: envInt('MESSAGE_WRITE_QUEUE', 256),
  maxWaitMs: envInt('MESSAGE_WRITE_MAX_WAIT_MS', 5000)
});
