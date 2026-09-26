#!/usr/bin/env node
// ============================================================================
//  Database layer: dual-driver behaviour, transactions, concurrency, search,
//  and the SQLite → Postgres migration tool.
//
//  Runs on both drivers like every other part: `npm test` (SQLite) and
//  `npm run test:pg` (TEST_DATABASE_URL). The tests that need a SQLite file
//  *and* a Postgres server at once (schema parity, migration) need
//  TEST_DATABASE_URL, since there is no Postgres to talk to otherwise.
// ============================================================================

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { startServer, stopServer, api, get, TEST_DATABASE_URL } from './testHarness.mjs';

const run = promisify(execFile);
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const as = (userId) => ({ 'x-user-id': userId });
const needsPg = TEST_DATABASE_URL ? false : 'needs TEST_DATABASE_URL (a Postgres server) alongside SQLite';

before(startServer);
after(stopServer);

const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys)
  : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]))
    : v);

/** Insert throwaway users straight into the database; returns their ids. */
async function makeUsers(n, prefix) {
  const { runQuery } = await import('../db.js');
  const ids = [];
  for (let i = 0; i < n; i += 1) {
    const id = `${prefix}-${crypto.randomBytes(4).toString('hex')}`;
    await runQuery(
      `INSERT INTO users (id, username, display_name, email) VALUES (?, ?, ?, ?)`,
      [id, id, id, `${id}@example.test`]
    );
    ids.push(id);
  }
  return ids;
}

// ---------------------------------------------------------------------------

describe('driver', () => {
  test('health reports the driver and that the database is reachable', async () => {
    const { status, body } = await get('/api/health');
    assert.equal(status, 200);
    assert.equal(body.database.driver, TEST_DATABASE_URL ? 'postgres' : 'sqlite');
    assert.equal(body.database.reachable, true);
    assert.equal(typeof body.database.latency_ms, 'number');
    // Connection details only — never credentials.
    assert.ok(!JSON.stringify(body).includes('password'));
  });

  test('results have the same shape on both engines', async () => {
    const { getQuery, allQuery, runQuery } = await import('../db.js');
    const count = await getQuery(`SELECT count(*) AS n FROM users`);
    assert.equal(typeof count.n, 'number', 'COUNT(*) must be a JS number');
    const flag = await getQuery(`SELECT EXISTS (SELECT 1 FROM users WHERE id = 'user-me') AS present`);
    assert.equal(flag.present, 1, 'booleans come back as 1/0');
    const row = await getQuery(`SELECT created_at FROM users WHERE id = 'user-me'`);
    assert.match(row.created_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/, 'timestamps are ISO with ms and Z');
    const quoted = await getQuery(`SELECT 1 AS "camelCase", '?' AS q`);
    assert.equal(quoted.camelCase, 1);
    assert.equal(quoted.q, '?', 'a ? inside a string literal is not a placeholder');
    const res = await runQuery(`UPDATE users SET bio = bio WHERE id IN (?, ?)`, ['user-me', 'user-2']);
    assert.equal(res.changes, 2);
    const none = await allQuery(`SELECT id FROM users WHERE id = ?`, ['nobody']);
    assert.deepEqual(none, []);
  });

  test('placeholder rewriting skips literals, identifiers and comments', async () => {
    const { toPgPlaceholders } = await import('../db/dialect.js');
    assert.equal(
      toPgPlaceholders(`SELECT '?', "a?b", ? -- what?\n, /* ? */ ?, $$ ? $$, $t$ ? $t$, 'it''s ?', ?`),
      `SELECT '?', "a?b", $1 -- what?\n, /* ? */ $2, $$ ? $$, $t$ ? $t$, 'it''s ?', $3`
    );
  });

  test('database errors never reach the client verbatim', async () => {
    // Settings for a channel that does not exist: a foreign-key violation.
    const fk = await api('PUT', '/api/settings/channels/no-such-channel', { muted: true });
    assert.equal(fk.status, 409, JSON.stringify(fk.body));
    assert.equal(fk.body.code, 'REFERENCE_CONFLICT');
    assert.ok(!/SQLITE|FOREIGN|syntax|relation|column|constraint|23503/i.test(JSON.stringify(fk.body)));
    // A value the service rejects before it reaches the database.
    const bad = await api('PUT', '/api/settings/channels/chan-102', { mutedUntil: 'not a date' });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'INVALID_MUTED_UNTIL');
  });
});

describe('transactions', () => {
  test('a write outside a transaction is not rolled back by a concurrent failing one', async () => {
    const { transaction, runQuery, getQuery } = await import('../db.js');
    const inside = `iso-in-${crypto.randomBytes(3).toString('hex')}`;
    const outside = `iso-out-${crypto.randomBytes(3).toString('hex')}`;

    let release;
    const gate = new Promise((r) => { release = r; });
    let opened;
    const isOpen = new Promise((r) => { opened = r; });
    const failing = transaction(async () => {
      await runQuery(`INSERT INTO users (id, username, display_name) VALUES (?, ?, ?)`, [inside, inside, inside]);
      opened();
      await gate;
      throw new Error('boom');
    });
    await isOpen;
    // While that transaction is open and holds its write, an unrelated caller
    // (this test's own async context — like another HTTP request) writes.
    const outsideWrite = runQuery(
      `INSERT INTO users (id, username, display_name) VALUES (?, ?, ?)`, [outside, outside, outside]
    );
    await new Promise((r) => setTimeout(r, 50));
    release();
    await assert.rejects(failing, /boom/);
    await outsideWrite;

    assert.equal(await getQuery(`SELECT id FROM users WHERE id = ?`, [inside]), undefined,
      'the failed transaction must roll back its own write');
    assert.ok(await getQuery(`SELECT id FROM users WHERE id = ?`, [outside]),
      'the unrelated write must survive the other transaction rolling back');
  });

  test('a read outside a transaction never sees its uncommitted rows', async () => {
    const { transaction, runQuery, getQuery } = await import('../db.js');
    const id = `iso-dirty-${crypto.randomBytes(3).toString('hex')}`;
    let release;
    const gate = new Promise((r) => { release = r; });
    let opened;
    const isOpen = new Promise((r) => { opened = r; });
    const tx = transaction(async () => {
      await runQuery(`INSERT INTO users (id, username, display_name) VALUES (?, ?, ?)`, [id, id, id]);
      opened();
      await gate;
    });
    await isOpen;
    const seen = await getQuery(`SELECT id FROM users WHERE id = ?`, [id]);
    release();
    await tx;
    assert.equal(seen, undefined, 'dirty read');
    assert.ok(await getQuery(`SELECT id FROM users WHERE id = ?`, [id]), 'committed row visible afterwards');
  });

  test('a nested transaction is a savepoint: its failure undoes only its own writes', async () => {
    const { transaction, runQuery, getQuery } = await import('../db.js');
    const outer = `sp-outer-${crypto.randomBytes(3).toString('hex')}`;
    const inner = `sp-inner-${crypto.randomBytes(3).toString('hex')}`;
    await transaction(async () => {
      await runQuery(`INSERT INTO users (id, username, display_name) VALUES (?, ?, ?)`, [outer, outer, outer]);
      await assert.rejects(transaction(async () => {
        await runQuery(`INSERT INTO users (id, username, display_name) VALUES (?, ?, ?)`, [inner, inner, inner]);
        // A constraint error inside the savepoint: on Postgres this would
        // otherwise abort the whole outer transaction.
        await runQuery(`INSERT INTO users (id, username, display_name) VALUES (?, ?, ?)`, [outer, 'dupe', 'dupe']);
      }));
      // The outer transaction is still usable.
      await runQuery(`UPDATE users SET bio = 'kept' WHERE id = ?`, [outer]);
    });
    assert.equal((await getQuery(`SELECT bio FROM users WHERE id = ?`, [outer])).bio, 'kept');
    assert.equal(await getQuery(`SELECT id FROM users WHERE id = ?`, [inner]), undefined);
  });

  test('constraint violations are classified the same way on both engines', async () => {
    const { runQuery, isUniqueViolation, isForeignKeyViolation } = await import('../db.js');
    const err = await runQuery(`INSERT INTO users (id, username, display_name) VALUES ('user-me', 'x', 'x')`).catch((e) => e);
    assert.ok(isUniqueViolation(err));
    const fk = await runQuery(
      `INSERT INTO server_members (server_id, user_id) VALUES ('no-such-server', 'user-me')`
    ).catch((e) => e);
    assert.ok(isForeignKeyViolation(fk));
  });

  test('concurrent transactions incrementing one counter lose no update', async () => {
    const { transaction, runQuery, getQuery } = await import('../db.js');
    const id = `ctr-${crypto.randomBytes(3).toString('hex')}`;
    await runQuery(`INSERT INTO users (id, username, display_name, flags) VALUES (?, ?, ?, 0)`, [id, id, id]);
    // Read-then-write inside each transaction: only correct if they serialise
    // (SQLite) or conflicting ones are retried (Postgres, SERIALIZABLE).
    await Promise.all(Array.from({ length: 12 }, () => transaction(async () => {
      const { flags } = await getQuery(`SELECT flags FROM users WHERE id = ?`, [id]);
      await new Promise((r) => setTimeout(r, 2));
      await runQuery(`UPDATE users SET flags = ? WHERE id = ?`, [flags + 1, id]);
    })));
    assert.equal((await getQuery(`SELECT flags FROM users WHERE id = ?`, [id])).flags, 12);
  });
});

describe('concurrency through the API', () => {
  test('an invite with max_uses cannot be over-accepted by concurrent joins', async () => {
    const created = await api('POST', '/api/servers/server-3/invites', { maxUses: 2, maxAge: 0 });
    assert.equal(created.status, 200, JSON.stringify(created.body));
    const code = created.body.code;
    const users = await makeUsers(8, 'inv');
    const results = await Promise.all(users.map((u) => api('POST', `/api/invites/${code}/accept`, {}, as(u))));
    const ok = results.filter((r) => r.status === 200);
    const refused = results.filter((r) => r.status === 410);
    assert.equal(ok.length, 2, `statuses: ${results.map((r) => r.status).join(',')}`);
    assert.equal(refused.length, 6);
    assert.ok(refused.every((r) => r.body.code === 'INVITE_EXHAUSTED'));

    const { getQuery } = await import('../db.js');
    assert.equal((await getQuery(`SELECT uses FROM invites WHERE code = ?`, [code])).uses, 2);
    const members = await getQuery(
      `SELECT count(*) AS n FROM server_members WHERE server_id = 'server-3' AND user_id LIKE 'inv-%' AND left_at IS NULL`
    );
    assert.equal(members.n, 2, 'exactly the accepted joiners became members');
  });

  test('concurrent sends to one channel all land, in id order, with an exact count', async () => {
    const { getQuery } = await import('../db.js');
    const before = (await getQuery(`SELECT message_count FROM channels WHERE id = 'chan-301'`)).message_count;
    const sends = await Promise.all(Array.from({ length: 15 }, (_, i) => api('POST', '/api/messages', {
      channel_id: 'chan-301', user_id: 'user-me', content: `burst ${i}`
    })));
    assert.ok(sends.every((r) => r.status === 200 || r.status === 201), sends.map((r) => r.status).join(','));
    const after = (await getQuery(`SELECT message_count FROM channels WHERE id = 'chan-301'`)).message_count;
    assert.equal(after - before, 15);
    const { body: page } = await get('/api/messages/chan-301?limit=50');
    const ids = page.map((m) => BigInt(m.id));
    assert.ok(ids.every((id, i) => i === 0 || id > ids[i - 1]), 'history ascending by numeric id');
  });
});

describe('search', () => {
  test('Thai substrings are found without word boundaries, at any length', async () => {
    const sent = await api('POST', '/api/messages', {
      channel_id: 'chan-102', user_id: 'user-me', content: 'วันนี้ทดสอบระบบค้นหาข้อความภาษาไทยสำเร็จ'
    });
    assert.ok([200, 201].includes(sent.status));
    for (const q of ['ค้นหาข้อความ', 'ภาษาไทย', 'สำเร็จ', 'ไท']) {
      const { status, body } = await get(`/api/search/messages?q=${encodeURIComponent(q)}`);
      assert.equal(status, 200);
      assert.ok(body.some((m) => m.id === sent.body.id), `"${q}" did not find the message`);
    }
    const miss = await get(`/api/search/messages?q=${encodeURIComponent('ไม่มีคำนี้แน่นอน')}`);
    assert.ok(!miss.body.some((m) => m.id === sent.body.id));
  });

  test('matching is case-insensitive and wildcards in the query are literal', async () => {
    const sent = await api('POST', '/api/messages', {
      channel_id: 'chan-102', user_id: 'user-me', content: 'Deploy WINDOW is 100% at 5_pm'
    });
    const hit = await get(`/api/search/messages?q=${encodeURIComponent('deploy window')}`);
    assert.ok(hit.body.some((m) => m.id === sent.body.id), 'case-insensitive');
    const pct = await get(`/api/search/messages?q=${encodeURIComponent('100%')}`);
    assert.ok(pct.body.some((m) => m.id === sent.body.id));
    const underscore = await get(`/api/search/messages?q=${encodeURIComponent('5_pm')}`);
    assert.ok(underscore.body.some((m) => m.id === sent.body.id));
    const wild = await get(`/api/search/messages?q=${encodeURIComponent('Deploy%pm')}`);
    assert.ok(!wild.body.some((m) => m.id === sent.body.id), '% must not act as a wildcard');
  });

  test('operators combine with Thai text (from:, in:, has:, during:)', async () => {
    const sent = await api('POST', '/api/messages', {
      channel_id: 'chan-103', user_id: 'user-me', content: 'ลิงก์ทดสอบ https://example.com/ตัวอย่าง'
    });
    const today = new Date().toISOString().slice(0, 10);
    const q = `ลิงก์ทดสอบ from:AlexPro in:memes-and-fun has:link during:${today}`;
    const { body } = await get(`/api/search/messages?q=${encodeURIComponent(q)}`);
    assert.ok(body.some((m) => m.id === sent.body.id), JSON.stringify(body.map((m) => m.content)));
    const wrongAuthor = await get(`/api/search/messages?q=${encodeURIComponent('ลิงก์ทดสอบ from:CyberNinja')}`);
    assert.ok(!wrongAuthor.body.some((m) => m.id === sent.body.id));
    const edited = await api('PATCH', `/api/messages/${sent.body.id}`, { content: 'แก้ไขแล้วไม่มีลิงก์' });
    assert.equal(edited.status, 200);
    const after = await get(`/api/search/messages?q=${encodeURIComponent('ลิงก์ทดสอบ')}`);
    assert.ok(!after.body.some((m) => m.id === sent.body.id), 'an edit replaces the searchable text');
  });
});

describe('SQLite → PostgreSQL', () => {
  let tmp;
  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-migrate-')); });
  after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

  async function pgAdmin(fn) {
    const { default: pg } = await import('pg');
    const c = new pg.Client({ connectionString: TEST_DATABASE_URL });
    await c.connect();
    try { return await fn(c); } finally { await c.end(); }
  }
  const dbUrl = (name) => { const u = new URL(TEST_DATABASE_URL); u.pathname = `/${name}`; return u.toString(); };
  const childEnv = () => {
    const env = { ...process.env };
    delete env.DATABASE_URL;
    delete env.DB_PATH;
    return env;
  };

  test('a fresh SQLite schema and the Postgres baseline have the same tables, columns, nullability and indexes',
    { skip: needsPg }, async () => {
      const file = path.join(tmp, 'parity.db');
      await run(process.execPath, ['-e',
        "const m = await import('./db.js'); await m.initDB({ seed: false }); await m.closeDB();",
        '--input-type=module'], { cwd: repo, env: { ...childEnv(), DB_PATH: file, NODE_TEST_CONTEXT: '1' } });
      const { default: sqlite3 } = await import('sqlite3');
      const sdb = new sqlite3.Database(file, sqlite3.OPEN_READONLY);
      const sall = (q) => new Promise((res, rej) => sdb.all(q, (e, r) => (e ? rej(e) : res(r))));

      const name = `parity_${crypto.randomBytes(4).toString('hex')}`;
      await pgAdmin((c) => c.query(`CREATE DATABASE "${name}"`));
      try {
        await run(process.execPath, ['-e',
          "const m = await import('./db.js'); await m.initDB({ seed: false }); await m.closeDB();",
          '--input-type=module'], { cwd: repo, env: { ...childEnv(), DATABASE_URL: dbUrl(name), NODE_TEST_CONTEXT: '1' } });
        const { default: pg } = await import('pg');
        const c = new pg.Client({ connectionString: dbUrl(name) });
        await c.connect();
        try {
          const skip = (t) => t.startsWith('sqlite_') || t.startsWith('messages_fts');
          const sTables = (await sall(`SELECT name FROM sqlite_master WHERE type = 'table'`)).map((r) => r.name).filter((t) => !skip(t)).sort();
          const pTables = (await c.query(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`)).rows.map((r) => r.table_name).sort();
          assert.deepEqual(pTables, sTables);
          for (const t of sTables) {
            const sCols = Object.fromEntries((await sall(`PRAGMA table_info("${t}")`))
              .map((r) => [r.name, r.notnull === 1 || r.pk > 0]));
            const pCols = Object.fromEntries((await c.query(
              `SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [t]
            )).rows.map((r) => [r.column_name, r.is_nullable === 'NO']));
            assert.deepEqual(pCols, sCols, `columns/nullability of ${t}`);
          }
          const sIdx = (await sall(`SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'`)).map((r) => r.name).sort();
          const pIdx = (await c.query(`SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE 'idx_%'`))
            .rows.map((r) => r.indexname).filter((n) => n !== 'idx_messages_content_trgm').sort();
          assert.deepEqual(pIdx, sIdx);
        } finally {
          await c.end();
        }
      } finally {
        sdb.close();
        await pgAdmin((c) => c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
      }
    });

  test('the migration tool copies every table with row-count and value parity, and is re-run safe',
    { skip: needsPg }, async () => {
      const file = path.join(tmp, 'source.db');
      await run(process.execPath, ['scripts/fixtures/build-sqlite-fixture.mjs', file],
        { cwd: repo, env: { ...childEnv(), NODE_TEST_CONTEXT: '1' } });

      const name = `migrate_${crypto.randomBytes(4).toString('hex')}`;
      await pgAdmin((c) => c.query(`CREATE DATABASE "${name}"`));
      const tool = (...extra) => run(process.execPath,
        ['scripts/migrate-sqlite-to-postgres.mjs', '--from', file, '--to', dbUrl(name), '--batch', '7', ...extra],
        { cwd: repo, env: childEnv() });
      try {
        // Dry run first: converts and verifies everything, writes nothing.
        const dry = await tool('--dry-run');
        assert.match(dry.stdout, /Dry run/);
        const { stdout } = await tool();
        assert.match(stdout, /counts verified/);

        const { default: sqlite3 } = await import('sqlite3');
        const { default: pg } = await import('pg');
        const sdb = new sqlite3.Database(file, sqlite3.OPEN_READONLY);
        const sall = (q) => new Promise((res, rej) => sdb.all(q, (e, r) => (e ? rej(e) : res(r))));
        const c = new pg.Client({ connectionString: dbUrl(name) });
        await c.connect();
        try {
          const tables = (await sall(`SELECT name FROM sqlite_master WHERE type = 'table'`)).map((r) => r.name)
            .filter((t) => !t.startsWith('sqlite_') && !t.startsWith('messages_fts') && t !== 'schema_migrations');
          let totalRows = 0;
          for (const t of tables) {
            const types = Object.fromEntries((await c.query(
              `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1`, [t]
            )).rows.map((r) => [r.column_name, r.data_type]));
            const norm = (col, v) => {
              if (v === null || v === undefined) return null;
              const type = types[col];
              if (type === 'timestamp with time zone') {
                const s = String(v);
                return new Date(/([zZ]|[+-]\d\d:?\d\d)$/.test(s) ? s : `${s.replace(' ', 'T')}Z`).toISOString();
              }
              // jsonb stores objects with its own key order; compare semantically.
              if (type === 'jsonb') return JSON.stringify(sortKeys(typeof v === 'string' ? JSON.parse(v) : v));
              if (type === 'integer' || type === 'bigint' || type === 'double precision') return Number(v);
              return String(v);
            };
            const canon = (rows) => rows
              .map((r) => JSON.stringify(Object.keys(types).sort().map((k) => [k, norm(k, r[k])])))
              .sort();
            const src = await sall(`SELECT * FROM "${t}"`);
            const dst = (await c.query(`SELECT row_to_json(x) AS r FROM "${t}" x`)).rows.map((r) => r.r);
            assert.equal(dst.length, src.length, `row count of ${t}`);
            assert.deepEqual(canon(dst), canon(src), `values of ${t}`);
            totalRows += src.length;
          }
          assert.ok(totalRows > 100, `fixture too small (${totalRows} rows)`);
          const v = await c.query(`SELECT max(version) AS v FROM schema_migrations`);
          const { SCHEMA_VERSION } = await import('../db.js');
          assert.equal(v.rows[0].v, SCHEMA_VERSION);
        } finally {
          await c.end();
          sdb.close();
        }

        // Re-running against a populated target refuses instead of duplicating…
        const again = await tool().then(() => null, (e) => e);
        assert.ok(again, 'second run must fail without --force');
        assert.match(again.stderr, /not empty/);
        // …and --force replaces the contents with an identical copy.
        const forced = await tool('--force');
        assert.match(forced.stdout, /counts verified/);
      } finally {
        await pgAdmin((c) => c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
      }
    });

  test('a migrated database serves the app: history, search and login work', { skip: needsPg }, async () => {
    const file = path.join(tmp, 'serve.db');
    await run(process.execPath, ['scripts/fixtures/build-sqlite-fixture.mjs', file],
      { cwd: repo, env: { ...childEnv(), NODE_TEST_CONTEXT: '1' } });
    const name = `served_${crypto.randomBytes(4).toString('hex')}`;
    await pgAdmin((c) => c.query(`CREATE DATABASE "${name}"`));
    try {
      await run(process.execPath, ['scripts/migrate-sqlite-to-postgres.mjs', '--from', file, '--to', dbUrl(name), '--quiet'],
        { cwd: repo, env: childEnv() });
      // Query the migrated copy through the same services the API uses.
      const script = `
        const m = await import('./services/messages.js');
        const found = await m.searchMessages({ query: 'รูปภาพสวยงาม', viewerId: 'user-me' });
        const auth = await import('./lib/auth.js');
        const db = await import('./db.js');
        const u = await db.getQuery("SELECT password_hash FROM users WHERE id = 'user-me'");
        const ok = await auth.verifyPassword('antigravity123', u.password_hash);
        console.log(JSON.stringify({ found: found.map((x) => x.content), ok }));
        await db.closeDB();`;
      const { stdout } = await run(process.execPath, ['--input-type=module', '-e', script],
        { cwd: repo, env: { ...childEnv(), DATABASE_URL: dbUrl(name), NODE_TEST_CONTEXT: '1' } });
      const out = JSON.parse(stdout.trim().split('\n').pop());
      assert.ok(out.found.some((c) => c.includes('ทดสอบรูปภาพสวยงามมาก')), JSON.stringify(out));
      assert.equal(out.ok, true);
    } finally {
      await pgAdmin((c) => c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    }
  });
});
