// ============================================================================
//  SQLite driver.
//
//  Two connections to the same WAL-mode file:
//
//    writer  every write, and every read made inside a transaction
//    reader  reads made outside a transaction (PRAGMA query_only), so they
//            neither queue behind a long transaction nor observe its
//            uncommitted rows
//
//  SQLite allows one writer at a time and has a single transaction per
//  connection, so writes are serialised through `writeLock`: a transaction
//  holds it from BEGIN to COMMIT, and a write made outside any transaction
//  takes it for one statement. Without this, a write from an unrelated request
//  that happened to run while a transaction was open would be committed — or
//  rolled back — as part of that transaction.
//
//  Transaction membership is tracked with AsyncLocalStorage, so every query on
//  a transaction's async call stack joins it and nothing else does. A nested
//  transaction() becomes a SAVEPOINT.
// ============================================================================

import sqlite3 from 'sqlite3';
import path from 'path';
import { AsyncLocalStorage } from 'async_hooks';
import { getLogger } from '../lib/logger.js';

const log = getLogger('db.sqlite');

const noop = () => {};

/** A FIFO async mutex: run(fn) waits for every earlier fn to settle. */
export function createMutex() {
  let tail = Promise.resolve();
  return (fn) => {
    const result = tail.then(() => fn());
    tail = result.then(noop, noop);
    return result;
  };
}

function decorate(err, text) {
  err.sql = String(text).trim().slice(0, 200);
  err.isDatabaseError = true;
  return err;
}

export function createSqliteDriver({ dbPath, verbose = false, quiet = false }) {
  const S = verbose ? sqlite3.verbose() : sqlite3;
  const inMemory = !dbPath || dbPath === ':memory:' || dbPath.startsWith('file::memory:');

  const writer = new S.Database(dbPath, (err) => {
    if (err) {
      log.fatal({ err: { message: err.message, code: err.code } }, 'cannot open SQLite database');
      process.exit(1);
    }
    if (!quiet) log.info({ file: path.basename(dbPath) }, 'connected to SQLite database');
  });
  // Statements on the writer run strictly in submission order.
  writer.serialize();
  // Per-connection settings, queued ahead of any caller's statement. initDB
  // sets them again, but a script that imports db.js without booting the
  // schema (the test process does) needs them too.
  writer.run('PRAGMA busy_timeout = 5000');
  writer.run('PRAGMA foreign_keys = ON');

  // The reader is opened lazily: at import time the file may not exist yet,
  // and a read-only handle cannot create it.
  let reader = null;
  let readerState = inMemory ? 'disabled' : 'unopened';
  function getReader() {
    if (readerState === 'ready') return reader;
    if (readerState !== 'unopened') return null;
    readerState = 'opening';
    const handle = new S.Database(dbPath, S.OPEN_READWRITE, (err) => {
      if (err) { readerState = 'disabled'; return; }
      handle.run('PRAGMA busy_timeout = 5000');
      handle.run('PRAGMA query_only = ON', (e) => {
        if (e) { readerState = 'disabled'; return; }
        reader = handle;
        readerState = 'ready';
      });
    });
    return null;
  }

  const als = new AsyncLocalStorage();
  const writeLock = createMutex();

  const rawRun = (conn, text, params = []) => new Promise((resolve, reject) => {
    conn.run(text, params, function onRun(err) {
      if (err) reject(decorate(err, text));
      // `this` is the Statement: { lastID, changes }.
      else resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
  const rawGet = (conn, text, params = []) => new Promise((resolve, reject) => {
    conn.get(text, params, (err, row) => (err ? reject(decorate(err, text)) : resolve(row)));
  });
  const rawAll = (conn, text, params = []) => new Promise((resolve, reject) => {
    conn.all(text, params, (err, rows) => (err ? reject(decorate(err, text)) : resolve(rows ?? [])));
  });
  const rawExec = (conn, text) => new Promise((resolve, reject) => {
    conn.exec(text, (err) => (err ? reject(decorate(err, text)) : resolve()));
  });

  /** The live transaction on this async call stack, if any. */
  const current = () => {
    const store = als.getStore();
    return store?.active ? store : null;
  };

  // Booleans bind as 1/0 in sqlite3 already; BigInt does not bind at all.
  const normalize = (params) => (params ?? []).map((v) => (typeof v === 'bigint' ? v.toString() : v));

  function run(text, params) {
    if (current()) return rawRun(writer, text, normalize(params));
    return writeLock(() => rawRun(writer, text, normalize(params)));
  }

  function readConn() {
    if (current()) return writer;
    return getReader() ?? writer;
  }
  const get = (text, params) => rawGet(readConn(), text, normalize(params));
  const all = (text, params) => rawAll(readConn(), text, normalize(params));

  function exec(text) {
    if (current()) return rawExec(writer, text);
    return writeLock(() => rawExec(writer, text));
  }

  async function savepoint(store, fn) {
    // Siblings nested under the same transaction take turns, so their
    // savepoints never interleave.
    return store.mutex(async () => {
      store.root.seq += 1;
      const name = `sp_${store.root.seq}`;
      await rawRun(writer, `SAVEPOINT ${name}`);
      const child = { active: true, root: store.root, depth: store.depth + 1, mutex: createMutex() };
      try {
        const result = await als.run(child, fn);
        await rawRun(writer, `RELEASE SAVEPOINT ${name}`);
        return result;
      } catch (err) {
        try {
          await rawRun(writer, `ROLLBACK TO SAVEPOINT ${name}`);
          await rawRun(writer, `RELEASE SAVEPOINT ${name}`);
        } catch { /* the outer rollback will clean up */ }
        throw err;
      } finally {
        child.active = false;
      }
    });
  }

  function transaction(fn) {
    const store = current();
    if (store) return savepoint(store, fn);

    return writeLock(async () => {
      await rawRun(writer, 'BEGIN IMMEDIATE');
      const root = { active: true, depth: 1, seq: 0, mutex: createMutex() };
      root.root = root;
      try {
        const result = await als.run(root, fn);
        root.active = false;
        await rawRun(writer, 'COMMIT');
        return result;
      } catch (err) {
        root.active = false;
        try { await rawRun(writer, 'ROLLBACK'); } catch { /* already rolled back */ }
        throw err;
      } finally {
        root.active = false;
      }
    });
  }

  async function ping() {
    const started = Date.now();
    await rawGet(readConn(), 'SELECT 1 AS ok');
    return { ok: true, latency_ms: Date.now() - started };
  }

  function close() {
    return writeLock(() => new Promise((resolve) => {
      const closeReader = (next) => (reader ? reader.close(() => next()) : next());
      closeReader(() => {
        writer.run('PRAGMA wal_checkpoint(TRUNCATE)', () => writer.close(() => resolve()));
      });
    }));
  }

  return {
    name: 'sqlite',
    handle: writer,
    run,
    get,
    all,
    exec,
    transaction,
    inTransaction: () => Boolean(current()),
    ping,
    close,
    info: () => ({ driver: 'sqlite', file: path.basename(dbPath || ':memory:') })
  };
}
