// ============================================================================
//  Two rate limiters for socket-driven work (docs/FRONTEND-PERFORMANCE.md F4).
//
//  createReadAcker  — read acknowledgements. Keeps only the newest message id
//                     per channel and emits at most once per channel per
//                     interval (trailing), plus an immediate flush when the
//                     tab is hidden or closed. 100 incoming messages a second
//                     used to cost 100 `mark_read` emits and 100 echoes.
//  createFrameQueue — runs queued state updates together in one animation
//                     frame, so a burst of socket events is one React commit
//                     per frame instead of one per event. Falls back to a
//                     short timeout while the tab is hidden (rAF is paused
//                     there, and badges / titles must still update).
// ============================================================================

export function createReadAcker(emit, { interval = 1500 } = {}) {
  const latest = new Map();      // channelId -> messageId still to send
  const lastSent = new Map();    // channelId -> time of the last emit
  const timers = new Map();

  const send = (channelId) => {
    timers.delete(channelId);
    const messageId = latest.get(channelId);
    if (messageId === undefined) return;
    latest.delete(channelId);
    lastSent.set(channelId, Date.now());
    emit(channelId, messageId);
  };

  return {
    /** Acknowledge `messageId` in `channelId` (the newest one wins). */
    queue(channelId, messageId) {
      if (!channelId) return;
      latest.set(channelId, messageId);
      if (timers.has(channelId)) return;
      const since = Date.now() - (lastSent.get(channelId) ?? 0);
      if (since >= interval) send(channelId);
      else timers.set(channelId, setTimeout(() => send(channelId), interval - since));
    },
    /** Send everything still waiting (tab hidden, sign-out, unload). */
    flush() {
      for (const [channelId, timer] of timers) { clearTimeout(timer); send(channelId); }
      for (const channelId of [...latest.keys()]) send(channelId);
    },
    pendingFor(channelId) { return latest.get(channelId); }
  };
}

export function createFrameQueue() {
  let jobs = [];
  let scheduled = null;

  const run = () => {
    scheduled = null;
    const batch = jobs;
    jobs = [];
    for (const job of batch) {
      try { job(); } catch (err) { console.error('frame job failed', err); }
    }
  };

  return {
    /** Run `job` in the next frame, together with every other queued job. */
    push(job) {
      jobs.push(job);
      if (scheduled) return;
      const hidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      if (!hidden && typeof requestAnimationFrame === 'function') {
        scheduled = { raf: requestAnimationFrame(run) };
      } else {
        scheduled = { timeout: setTimeout(run, 50) };
      }
    },
    /** Run what is queued now (tests, and before a synchronous read). */
    flush() {
      if (scheduled?.raf) cancelAnimationFrame(scheduled.raf);
      if (scheduled?.timeout) clearTimeout(scheduled.timeout);
      run();
    }
  };
}
