// ============================================================================
//  A small persisted job queue for media processing.
//
//  Why not BullMQ/pg-boss: the work is CPU-bound and runs in this process
//  anyway (sharp/ffmpeg), the deployment has no Redis, and the requirements
//  are modest — survive restarts, bound concurrency, retry with back-off.
//
//    media_jobs(file_id, kind) is unique: re-enqueueing a file's job resets it
//    rather than duplicating it. A worker *claims* a job with a conditional
//    UPDATE (status = 'queued' → 'running') and a lease (`locked_until`); a job
//    whose lease expired — its process died mid-run — is re-queued by the next
//    poll, on this instance or another. Finished jobs are deleted, so the
//    table only ever holds outstanding or failed work.
//
//  Concurrency: MEDIA_JOB_CONCURRENCY (default 2) jobs at once per process.
//  Each job is itself parallel inside libvips, so a small number saturates
//  the CPU without starving the event loop of threads.
// ============================================================================

import { EventEmitter } from 'events';
import { runQuery, getQuery, allQuery } from '../db.js';
import { generateId } from '../lib/snowflake.js';

const LEASE_MS = 10 * 60 * 1000;
const POLL_MS = 15_000;
const MAX_ATTEMPTS = 3;

const handlers = new Map();         // kind -> async (job) => void
const events = new EventEmitter();  // `${fileId}:${kind}` -> 'done' | Error
events.setMaxListeners(0);

let running = 0;
let started = false;
let stopped = false;
let pollTimer = null;
let pumping = false;

const concurrency = () => Math.max(1, Number(process.env.MEDIA_JOB_CONCURRENCY) || 2);
const iso = (ms = Date.now()) => new Date(ms).toISOString();

const startHooks = [];

export function registerJobHandler(kind, handler) {
  handlers.set(kind, handler);
}

/** Run once when the workers start (repairs, periodic sweeps). */
export function onWorkersStart(fn) {
  startHooks.push(fn);
}

/**
 * Add (or reset) a job and nudge the workers. Returns immediately; use
 * waitForJob to block on the outcome.
 */
export async function enqueueJob(fileId, kind, { delayMs = 0 } = {}) {
  await runQuery(
    `INSERT INTO media_jobs (id, file_id, kind, status, attempts, run_after, updated_at)
     VALUES (?, ?, ?, 'queued', 0, ?, ?)
     ON CONFLICT (file_id, kind) DO UPDATE SET
       status = 'queued', attempts = 0, last_error = NULL, locked_until = NULL,
       run_after = excluded.run_after, updated_at = excluded.updated_at`,
    [generateId(), fileId, kind, iso(Date.now() + delayMs), iso()]
  );
  if (started) setImmediate(pump);
}

/**
 * Resolve when this file's job of `kind` finishes (true), fails for good
 * (false) or `timeoutMs` passes (null). Used to give a synchronous upload a
 * complete descriptor when processing is quick, without making it wait for
 * a slow one.
 */
export function waitForJob(fileId, kind, timeoutMs) {
  return new Promise((resolve) => {
    const key = `${fileId}:${kind}`;
    const timer = setTimeout(() => { events.off(key, onDone); resolve(null); }, timeoutMs);
    timer.unref?.();
    function onDone(ok) { clearTimeout(timer); resolve(ok); }
    events.once(key, onDone);
    // It may already be finished (a fast job, or a restart resumed it).
    getQuery(`SELECT status FROM media_jobs WHERE file_id = ? AND kind = ?`, [fileId, kind])
      .then((row) => {
        if (!row) { events.off(key, onDone); clearTimeout(timer); resolve(true); }
        else if (row.status === 'failed') { events.off(key, onDone); clearTimeout(timer); resolve(false); }
      })
      .catch(() => {});
  });
}

async function claimNext() {
  const now = iso();
  const candidates = await allQuery(
    `SELECT id, file_id, kind, attempts FROM media_jobs
      WHERE status = 'queued' AND run_after <= ?
      ORDER BY run_after ASC LIMIT 5`,
    [now]
  );
  for (const job of candidates) {
    if (!handlers.has(job.kind)) continue;
    const { changes } = await runQuery(
      `UPDATE media_jobs SET status = 'running', attempts = attempts + 1,
              locked_until = ?, updated_at = ?
        WHERE id = ? AND status = 'queued'`,
      [iso(Date.now() + LEASE_MS), now, job.id]
    );
    if (changes === 1) return { ...job, attempts: job.attempts + 1 };
  }
  return null;
}

async function runJob(job) {
  const key = `${job.file_id}:${job.kind}`;
  try {
    await handlers.get(job.kind)(job);
    await runQuery(`DELETE FROM media_jobs WHERE id = ?`, [job.id]);
    events.emit(key, true);
  } catch (err) {
    const message = String(err?.message ?? err).slice(0, 500);
    const permanent = err?.permanent || job.attempts >= MAX_ATTEMPTS;
    if (permanent) {
      await runQuery(
        `UPDATE media_jobs SET status = 'failed', last_error = ?, locked_until = NULL, updated_at = ? WHERE id = ?`,
        [message, iso(), job.id]
      ).catch(() => {});
      console.warn(`⚠️  media job ${job.kind} for file ${job.file_id} failed: ${message}`);
      events.emit(key, false);
    } else {
      // Exponential back-off: 5s, 20s, 80s…
      const delay = 5000 * 4 ** (job.attempts - 1);
      await runQuery(
        `UPDATE media_jobs SET status = 'queued', last_error = ?, locked_until = NULL,
                run_after = ?, updated_at = ? WHERE id = ?`,
        [message, iso(Date.now() + delay), iso(), job.id]
      ).catch(() => {});
    }
  }
}

async function pump() {
  if (!started || stopped || pumping) return;
  pumping = true;
  try {
    while (running < concurrency() && !stopped) {
      const job = await claimNext();
      if (!job) break;
      running += 1;
      runJob(job).finally(() => {
        running -= 1;
        if (!stopped) setImmediate(pump);
      });
    }
  } catch (err) {
    // A database hiccup must not kill the worker; the next poll retries.
    if (!stopped) console.warn(`⚠️  media queue poll failed: ${err.message}`);
  } finally {
    pumping = false;
  }
}

/** Put jobs whose lease ran out (their process died) back in the queue. */
export async function requeueExpired() {
  const { changes } = await runQuery(
    `UPDATE media_jobs SET status = 'queued', locked_until = NULL, updated_at = ?
      WHERE status = 'running' AND (locked_until IS NULL OR locked_until < ?)`,
    [iso(), iso()]
  );
  return changes;
}

/**
 * Start the workers. On boot every job left `running` by a previous process
 * of *this* instance is resumed; jobs another live instance holds keep their
 * lease until it expires.
 */
export async function startMediaWorkers() {
  if (started) return;
  started = true;
  stopped = false;
  const resumed = await requeueExpired().catch(() => 0);
  for (const hook of startHooks) {
    try { await hook(); } catch (err) { console.warn(`⚠️  media start hook failed: ${err.message}`); }
  }
  const pending = await getQuery(`SELECT count(*) AS c FROM media_jobs WHERE status = 'queued'`).catch(() => null);
  if (resumed || pending?.c) {
    console.log(`🎞️  media queue: ${pending?.c ?? 0} job(s) pending${resumed ? ` (${resumed} resumed)` : ''}`);
  }
  pollTimer = setInterval(() => {
    requeueExpired().catch(() => {}).finally(pump);
  }, POLL_MS);
  pollTimer.unref?.();
  setImmediate(pump);
}

export function stopMediaWorkers() {
  stopped = true;
  started = false;
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

/** Queue depth by status, for /api/media/config and the CLI. */
export async function queueStats() {
  const rows = await allQuery(`SELECT status, count(*) AS c FROM media_jobs GROUP BY status`);
  const stats = { queued: 0, running: 0, failed: 0, active_in_process: running, concurrency: concurrency() };
  for (const r of rows) stats[r.status] = Number(r.c);
  return stats;
}
