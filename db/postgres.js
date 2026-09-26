// ============================================================================
//  PostgreSQL driver (node-postgres).
//
//  One pool per process. A query made outside a transaction takes any pooled
//  connection for that one statement. transaction(fn) checks out a dedicated
//  connection, binds it to fn's async call stack with AsyncLocalStorage, and
//  every query fn makes — however deep — runs on that connection. A nested
//  transaction() becomes a SAVEPOINT on the same connection.
//
//  Result parity with the SQLite driver:
//    * run()  → { changes, lastID, rows }   (changes = rowCount)
//    * int8 / numeric come back as JS numbers (COUNT(*) is int8 in Postgres)
//    * booleans come back as 1 / 0, as SQLite has no boolean type
//    * timestamptz comes back as an ISO-8601 string with milliseconds and Z,
//      byte-identical to what SQLite stored via strftime('%…%fZ') or
//      Date#toISOString()
//    * json / jsonb come back as the raw JSON text, which callers JSON.parse
// ============================================================================

import pg from 'pg';
import fs from 'fs';
import { AsyncLocalStorage } from 'async_hooks';
import { toPgPlaceholders } from './dialect.js';
import { createMutex } from './sqlite.js';

const OID = {
  BOOL: 16, INT8: 20, JSON: 114, NUMERIC: 1700, TIMESTAMP: 1114, TIMESTAMPTZ: 1184, JSONB: 3802
};

// SQLSTATEs worth re-running a whole transaction for.
const RETRYABLE = new Set(['40001', '40P01']);   // serialization_failure, deadlock_detected

function buildTypes() {
  const types = new pg.TypeOverrides();
  const parseTimestamptz = pg.types.getTypeParser(OID.TIMESTAMPTZ);
  const toIso = (parsed, raw) => {
    if (!(parsed instanceof Date) || Number.isNaN(parsed.getTime())) return raw; // ±infinity
    return parsed.toISOString();
  };
  types.setTypeParser(OID.TIMESTAMPTZ, (v) => toIso(parseTimestamptz(v), v));
  // A bare `timestamp` (no zone) only arises from explicit casts; read it as UTC.
  types.setTypeParser(OID.TIMESTAMP, (v) => toIso(new Date(`${v.replace(' ', 'T')}Z`), v));
  types.setTypeParser(OID.INT8, (v) => {
    const n = Number(v);
    return Number.isSafeInteger(n) ? n : v;
  });
  types.setTypeParser(OID.NUMERIC, (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : v;
  });
  types.setTypeParser(OID.BOOL, (v) => (v === 't' || v === 'true' ? 1 : 0));
  types.setTypeParser(OID.JSON, (v) => v);
  types.setTypeParser(OID.JSONB, (v) => v);
  return types;
}

/**
 * TLS settings from the environment.
 *
 *   PGSSLMODE / DATABASE_SSL = disable | require | no-verify | verify-full
 *   DATABASE_SSL_CA          = path to a PEM bundle (implies verify-full)
 *
 * An sslmode in DATABASE_URL itself is honoured by node-postgres directly and
 * wins when neither variable is set.
 */
export function sslFromEnv(env = process.env) {
  const mode = String(env.DATABASE_SSL ?? env.PGSSLMODE ?? '').trim().toLowerCase();
  const caPath = env.DATABASE_SSL_CA;
  const ca = caPath ? fs.readFileSync(caPath, 'utf8') : undefined;
  if (!mode && !ca) return undefined;
  if (['disable', 'off', 'false', '0'].includes(mode)) return false;
  if (['no-verify', 'allow', 'prefer'].includes(mode)) return { rejectUnauthorized: false };
  if (['require', 'true', 'on', '1'].includes(mode) && !ca) {
    // libpq's `require` encrypts without verifying the certificate.
    return { rejectUnauthorized: false };
  }
  return { rejectUnauthorized: true, ...(ca ? { ca } : {}) };
}

const int = (value, fallback) => {
  const n = Number.parseInt(value ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

export function poolConfigFromEnv(env = process.env) {
  const ssl = sslFromEnv(env);
  let connectionString = env.DATABASE_URL;
  if (ssl !== undefined) {
    // An explicit setting wins over any sslmode baked into the URL.
    const url = new URL(connectionString);
    url.searchParams.delete('sslmode');
    connectionString = url.toString();
  }
  return {
    connectionString,
    ...(ssl !== undefined ? { ssl } : {}),
    max: int(env.DB_POOL_MAX, 10),
    min: int(env.DB_POOL_MIN, 0),
    idleTimeoutMillis: int(env.DB_POOL_IDLE_MS, 30_000),
    connectionTimeoutMillis: int(env.DB_CONNECT_TIMEOUT_MS, 10_000),
    application_name: env.DB_APPLICATION_NAME || 'antigravity-discord',
    statementTimeoutMs: int(env.DB_STATEMENT_TIMEOUT_MS, 30_000),
    idleInTxTimeoutMs: int(env.DB_IDLE_IN_TX_TIMEOUT_MS, 60_000),
    lockTimeoutMs: int(env.DB_LOCK_TIMEOUT_MS, 10_000),
    txRetries: int(env.DB_TX_RETRIES, 8),
    txIsolation: normalizeIsolation(env.DB_TX_ISOLATION || 'serializable')
  };
}

function normalizeIsolation(value) {
  const v = String(value).trim().toLowerCase().replace(/[_-]/g, ' ');
  const allowed = ['serializable', 'repeatable read', 'read committed'];
  if (!allowed.includes(v)) {
    throw new Error(`DB_TX_ISOLATION must be one of: ${allowed.join(', ')} (got "${value}")`);
  }
  return v.toUpperCase();
}

function decorate(err, text) {
  err.sql = String(text).trim().slice(0, 200);
  err.isDatabaseError = true;
  return err;
}

// Placeholder rewriting is pure, and the same few hundred statements run over
// and over, so remember them. Bounded so dynamically built SQL cannot grow it
// without limit.
const placeholderCache = new Map();
function convert(text) {
  let out = placeholderCache.get(text);
  if (out === undefined) {
    out = toPgPlaceholders(text);
    if (placeholderCache.size >= 5000) placeholderCache.clear();
    placeholderCache.set(text, out);
  }
  return out;
}

function normalizeParam(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;      // SQLite semantics: booleans are 0/1
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return v.toISOString();
  return v;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createPgDriver(env = process.env, { quiet = false } = {}) {
  const config = poolConfigFromEnv(env);
  const { statementTimeoutMs, idleInTxTimeoutMs, lockTimeoutMs, txRetries, txIsolation, ...poolConfig } = config;

  const pool = new pg.Pool({ ...poolConfig, types: buildTypes() });

  // An idle client can die (server restart, network blip). Without a listener
  // that error would crash the process; the pool already discards the client.
  pool.on('error', (err) => {
    console.error('⚠️  PostgreSQL idle client error:', err.message);
  });

  // Session settings every connection needs, applied once per physical
  // connection before its first statement. (Deliberately not startup
  // parameters: PgBouncer rejects those.)
  const sessionSetup = [
    `SET TIME ZONE 'UTC'`,
    `SET statement_timeout = ${statementTimeoutMs}`,
    `SET idle_in_transaction_session_timeout = ${idleInTxTimeoutMs}`,
    `SET lock_timeout = ${lockTimeoutMs}`
  ].join('; ');
  const prepared = new WeakSet();

  // Where we connect, for logs and /api/health — never the credentials.
  const target = () => {
    try {
      const url = new URL(poolConfig.connectionString);
      return {
        host: decodeURIComponent(url.hostname) || url.searchParams.get('host') || 'localhost',
        port: Number(url.port) || 5432,
        database: decodeURIComponent(url.pathname.replace(/^\//, '')) || 'postgres'
      };
    } catch {
      return { host: 'unknown', port: 5432, database: 'unknown' };
    }
  };
  let announced = quiet;

  async function acquire() {
    const client = await pool.connect();
    if (!prepared.has(client)) {
      try {
        await client.query(sessionSetup);
      } catch (err) {
        client.release(true);
        throw decorate(err, sessionSetup);
      }
      prepared.add(client);
      if (!announced) {
        announced = true;
        const { host, port, database } = target();
        console.log(`🐘 Connected to PostgreSQL: ${database} @ ${host}:${port}`);
      }
    }
    return client;
  }

  /** Errors after which a connection must not go back into the pool. */
  const isConnectionError = (err) =>
    !err?.code || /^(08|57P0)/.test(err.code) || /Connection terminated|ECONNRESET|EPIPE/.test(err.message);

  const als = new AsyncLocalStorage();
  const current = () => {
    const store = als.getStore();
    return store?.active ? store : null;
  };

  /**
   * One statement. Inside a transaction it runs on the transaction's client,
   * one at a time (a pg client cannot pipeline, and a Promise.all inside fn
   * must not interleave with a SAVEPOINT); outside, on any pooled client.
   */
  async function execute(queryConfig, sqlForErrors) {
    const store = current();
    if (store) {
      return store.root.queue(async () => {
        try {
          return await store.client.query(queryConfig);
        } catch (err) {
          throw decorate(err, sqlForErrors);
        }
      });
    }
    const client = await acquire();
    let broken = false;
    try {
      return await client.query(queryConfig);
    } catch (err) {
      broken = isConnectionError(err);
      throw decorate(err, sqlForErrors);
    } finally {
      client.release(broken || undefined);
    }
  }

  const query = (text, params) =>
    execute({ text: convert(text), values: (params ?? []).map(normalizeParam) }, text);

  const run = async (text, params) => {
    const res = await query(text, params);
    return { changes: res.rowCount ?? 0, lastID: res.rows?.[0]?.id, rows: res.rows ?? [] };
  };
  const get = async (text, params) => (await query(text, params)).rows[0];
  const all = async (text, params) => (await query(text, params)).rows;

  // No parameters → simple query protocol, which accepts several statements.
  const exec = async (text) => { await execute(text, text); };

  async function savepoint(store, fn) {
    // Siblings nested under the same (sub)transaction take turns, so their
    // savepoints never interleave.
    return store.mutex(async () => {
      store.root.seq += 1;
      const name = `sp_${store.root.seq}`;
      const raw = (text) => store.root.queue(() => store.client.query(text));
      await raw(`SAVEPOINT ${name}`);
      const child = {
        active: true, client: store.client, root: store.root, depth: store.depth + 1, mutex: createMutex()
      };
      try {
        const result = await als.run(child, fn);
        child.active = false;
        await raw(`RELEASE SAVEPOINT ${name}`);
        return result;
      } catch (err) {
        child.active = false;
        try {
          await raw(`ROLLBACK TO SAVEPOINT ${name}`);
          await raw(`RELEASE SAVEPOINT ${name}`);
        } catch { /* the outer rollback will clean up */ }
        throw err;
      } finally {
        child.active = false;
      }
    });
  }

  /**
   * Run fn in a transaction. Options:
   *   isolation  'serializable' (default, DB_TX_ISOLATION) | 'repeatable read' | 'read committed'
   *   retries    how often to re-run fn after a serialization failure or deadlock
   *
   * Serializable is the default because every transaction in this codebase
   * was written against SQLite, where transactions run one at a time: a
   * check-then-write inside one is safe there, and serializable isolation is
   * what keeps it safe here (Postgres aborts one side of a conflicting pair
   * and we re-run it). fn may therefore run more than once, so it must not
   * perform non-database side effects — emit events after it resolves.
   */
  async function transaction(fn, opts = {}) {
    const store = current();
    if (store) return savepoint(store, fn);

    const isolation = opts.isolation ? normalizeIsolation(opts.isolation) : txIsolation;
    const retries = opts.retries ?? txRetries;

    for (let attempt = 0; ; attempt += 1) {
      const client = await acquire();
      let discard = false;
      const root = { active: true, client, depth: 1, seq: 0, mutex: createMutex(), queue: createMutex() };
      root.root = root;
      try {
        await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
        const result = await als.run(root, fn);
        root.active = false;
        // Anything fn left running on the client (a query it did not await)
        // settles before COMMIT, never after.
        await root.queue(() => client.query('COMMIT'));
        return result;
      } catch (err) {
        root.active = false;
        try {
          await root.queue(() => client.query('ROLLBACK'));
        } catch {
          discard = true;    // the connection is in an unknown state; do not reuse it
        }
        if (RETRYABLE.has(err.code) && attempt < retries) {
          const backoff = Math.min(1000, 5 * 2 ** attempt) * (0.5 + Math.random());
          await sleep(backoff);
          continue;
        }
        // A failed BEGIN/COMMIT is a driver error too; fn's own errors
        // (ApiError and friends) pass through untouched.
        throw err instanceof pg.DatabaseError && !err.isDatabaseError ? decorate(err, 'COMMIT') : err;
      } finally {
        root.active = false;
        client.release(discard || undefined);
      }
    }
  }

  /** Run fn while holding a session-level advisory lock on its own connection. */
  async function withAdvisoryLock(key, fn) {
    const client = await acquire();
    let held = false;
    try {
      // Waiting for another instance's migrations is expected; the per-
      // statement timeout would turn that wait into a failed boot.
      await client.query('SET statement_timeout = 0');
      await client.query('SELECT pg_advisory_lock($1)', [key]);
      held = true;
      return await fn();
    } finally {
      if (held) await client.query('SELECT pg_advisory_unlock($1)', [key]).catch(() => {});
      await client.query(`SET statement_timeout = ${statementTimeoutMs}`).catch(() => {});
      client.release();
    }
  }

  async function ping() {
    const started = Date.now();
    await execute('SELECT 1 AS ok', 'SELECT 1');
    return {
      ok: true,
      latency_ms: Date.now() - started,
      pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount }
    };
  }

  let closing = null;
  function close() {
    closing ??= pool.end();
    return closing;
  }

  return {
    name: 'postgres',
    handle: pool,
    pool,
    run,
    get,
    all,
    exec,
    transaction,
    withAdvisoryLock,
    inTransaction: () => Boolean(current()),
    ping,
    close,
    info: () => ({ driver: 'postgres', ...target(), pool_max: poolConfig.max })
  };
}
