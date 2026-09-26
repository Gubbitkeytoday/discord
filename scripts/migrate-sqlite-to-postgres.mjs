#!/usr/bin/env node
// ============================================================================
//  Copy an existing SQLite database into an empty PostgreSQL database.
//
//    npm run db:migrate-to-pg -- --from ./discord.db --to postgres://user:pass@host/db
//
//  Options
//    --from <path>      SQLite file (default: $DB_PATH, else ./discord.db)
//    --to <url>         Postgres URL (default: $DATABASE_URL)
//    --batch <n>        rows per INSERT (default 500)
//    --force            the target already has rows: TRUNCATE every table first
//    --dry-run          do the whole copy and verification, then roll back
//    --drop-orphans     skip rows that violate a foreign key in the source
//                       (reported by PRAGMA foreign_key_check) instead of aborting
//
//  What it does
//    1. Opens the SQLite file read-only and checks it is at this build's
//       schema version (boot the app on it once first if it is older).
//    2. Creates the Postgres schema through db.js (same code path as the app),
//       then refuses to continue if any table has rows, unless --force.
//    3. Copies every table in one transaction — ids preserved, FK checks
//       deferred to COMMIT so load order does not matter — converting values
//       to the Postgres column types (ISO text → timestamptz, JSON text →
//       jsonb) and failing loudly, with table/row/column, on anything that
//       does not convert.
//    4. Verifies per-table row counts inside the same transaction and commits
//       only if every table matches. A failure leaves the target unchanged.
//
//  The SQLite file is never written to. The copy is all-or-nothing, so the
//  tool can simply be re-run after fixing whatever it reported.
// ============================================================================

import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import sqlite3 from 'sqlite3';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));

// --- arguments ---------------------------------------------------------------

export function parseArgs(argv) {
  const opts = { batch: 500, force: false, dryRun: false, dropOrphans: false, quiet: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${a} needs a value`);
      i += 1;
      return v;
    };
    if (a === '--from') opts.from = next();
    else if (a === '--to') opts.to = next();
    else if (a === '--batch') opts.batch = Number(next());
    else if (a === '--force') opts.force = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--drop-orphans') opts.dropOrphans = true;
    else if (a === '--quiet') opts.quiet = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`Unknown option ${a}`);
  }
  if (!Number.isInteger(opts.batch) || opts.batch < 1) throw new Error('--batch must be a positive integer');
  return opts;
}

// --- SQLite helpers ----------------------------------------------------------

function openSqlite(file) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file, sqlite3.OPEN_READONLY, (err) => (err ? reject(err) : resolve(db)));
  });
}
const sAll = (db, q, p = []) => new Promise((res, rej) => db.all(q, p, (e, r) => (e ? rej(e) : res(r))));
const sClose = (db) => new Promise((res) => db.close(() => res()));

// Tables that exist only on SQLite (the FTS5 index and its shadow tables) or
// that the target manages itself.
const SKIP_TABLE = (name) => name.startsWith('sqlite_') || name.startsWith('messages_fts') || name === 'schema_migrations';

// --- value conversion ----------------------------------------------------------

class ConversionError extends Error {}

/** A converter per Postgres column type; each receives the raw SQLite value. */
function converterFor(column, warn) {
  const { data_type: type, column_name: name } = column;
  const where = (ctx) => `${ctx.table}.${name} (rowid ${ctx.rowid})`;

  if (type === 'timestamp with time zone') {
    return (v, ctx) => {
      if (v === null || v === undefined || v === '') return null;
      let d;
      if (typeof v === 'number') d = new Date(v > 1e11 ? v : v * 1000);   // ms or seconds since epoch
      else {
        const s = String(v).trim();
        // SQLite's datetime() writes 'YYYY-MM-DD HH:MM:SS' in UTC with no zone.
        const zoned = /([zZ]|[+-]\d\d:?\d\d)$/.test(s) ? s : `${s.replace(' ', 'T')}Z`;
        d = new Date(zoned);
      }
      if (Number.isNaN(d.getTime())) throw new ConversionError(`${where(ctx)}: not a timestamp: ${JSON.stringify(v)}`);
      return d.toISOString();
    };
  }
  if (type === 'jsonb' || type === 'json') {
    return (v, ctx) => {
      if (v === null || v === undefined) return null;
      const s = Buffer.isBuffer(v) ? v.toString('utf8') : String(v);
      try {
        JSON.parse(s);
      } catch {
        throw new ConversionError(`${where(ctx)}: not valid JSON: ${s.slice(0, 80)}`);
      }
      if (s.includes('\\u0000')) {
        warn(`${where(ctx)}: removed \\u0000 escapes (jsonb cannot store them)`);
        return s.replaceAll('\\u0000', '');
      }
      return s;
    };
  }
  if (type === 'integer' || type === 'bigint' || type === 'smallint') {
    return (v, ctx) => {
      if (v === null || v === undefined) return null;
      if (typeof v === 'number' && Number.isInteger(v)) return v;
      if (typeof v === 'bigint') return v.toString();
      const s = String(v).trim();
      if (/^-?\d+$/.test(s)) return s;
      if (/^-?\d+\.0*$/.test(s)) return s.split('.')[0];
      throw new ConversionError(`${where(ctx)}: not an integer: ${JSON.stringify(v)}`);
    };
  }
  if (type === 'double precision' || type === 'real' || type === 'numeric') {
    return (v, ctx) => {
      if (v === null || v === undefined) return null;
      const n = Number(v);
      if (!Number.isFinite(n)) throw new ConversionError(`${where(ctx)}: not a number: ${JSON.stringify(v)}`);
      return n;
    };
  }
  // text
  return (v, ctx) => {
    if (v === null || v === undefined) return null;
    let s = Buffer.isBuffer(v) ? v.toString('utf8') : String(v);
    if (s.includes('\u0000')) {
      warn(`${where(ctx)}: removed NUL characters (Postgres text cannot store them)`);
      s = s.replaceAll('\u0000', '');
    }
    return s;
  };
}

// --- main --------------------------------------------------------------------

/**
 * Run the migration. Returns { tables: [{ table, source, skipped, target }], dryRun }.
 * Throws (after rolling back) on any problem.
 */
export async function migrate(opts) {
  const log = opts.quiet ? () => {} : (...a) => console.log(...a);
  const warnings = [];
  const warn = (msg) => {
    if (warnings.length < 1000) warnings.push(msg);
  };

  const from = path.resolve(opts.from ?? process.env.DB_PATH ?? path.join(here, '..', 'discord.db'));
  const to = opts.to ?? process.env.DATABASE_URL;
  if (!fs.existsSync(from)) throw new Error(`SQLite file not found: ${from}`);
  if (!to || !/^postgres(ql)?:\/\//i.test(to)) {
    throw new Error('Pass the target with --to postgres://… (or set DATABASE_URL)');
  }

  // db.js picks its driver from DATABASE_URL at import time: point it at the
  // target so the schema is created by exactly the code the app runs.
  process.env.DATABASE_URL = to;
  if (opts.quiet) process.env.NODE_TEST_CONTEXT ??= '1';
  const db = await import('../db.js');

  const source = await openSqlite(from);
  const client = new pg.Client({ connectionString: to });
  let began = false;
  try {
    // --- source checks -------------------------------------------------------
    // The FTS5 index is not copied (Postgres searches through pg_trgm), and
    // validating it needs a writable handle — so its lines are ignored.
    const problems = (await sAll(source, 'PRAGMA quick_check'))
      .map((r) => r.quick_check)
      .filter((line) => line !== 'ok' && !/messages_fts/.test(line));
    if (problems.length) {
      throw new Error(`Source database failed PRAGMA quick_check:\n  ${problems.slice(0, 10).join('\n  ')}`);
    }

    const versionRow = (await sAll(source,
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'`)).length
      ? (await sAll(source, 'SELECT MAX(version) AS v FROM schema_migrations'))[0]
      : { v: null };
    if (versionRow.v !== db.SCHEMA_VERSION) {
      throw new Error(
        `Source is at schema v${versionRow.v ?? 'none'}, this build expects v${db.SCHEMA_VERSION}. ` +
        (versionRow.v !== null && versionRow.v < db.SCHEMA_VERSION
          ? 'Start the app once against the SQLite file (unset DATABASE_URL) so it migrates, then re-run.'
          : 'Use the build that matches the source database.')
      );
    }

    const orphanRows = await sAll(source, 'PRAGMA foreign_key_check');
    const skip = new Map();   // table -> Set(rowid)
    if (orphanRows.length) {
      const summary = orphanRows.slice(0, 20)
        .map((r) => `  ${r.table} rowid ${r.rowid} → missing ${r.parent}`).join('\n');
      if (!opts.dropOrphans) {
        throw new Error(
          `Source has ${orphanRows.length} row(s) violating a foreign key:\n${summary}\n` +
          'Fix them, or re-run with --drop-orphans to leave them behind.'
        );
      }
      for (const r of orphanRows) {
        if (!skip.has(r.table)) skip.set(r.table, new Set());
        skip.get(r.table).add(r.rowid);
      }
      log(`⚠️  Skipping ${orphanRows.length} orphaned row(s) (--drop-orphans):\n${summary}`);
    }

    // --- target schema -----------------------------------------------------------
    await db.initDB({ seed: false });
    await db.closeDB();

    await client.connect();
    await client.query(`SET TIME ZONE 'UTC'; SET statement_timeout = 0`);

    const sourceTables = (await sAll(source,
      `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`))
      .map((r) => r.name).filter((n) => !SKIP_TABLE(n));
    const targetTables = (await client.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`
    )).rows.map((r) => r.table_name).filter((n) => !SKIP_TABLE(n));

    const unknown = sourceTables.filter((t) => !targetTables.includes(t));
    if (unknown.length) throw new Error(`Tables missing from the Postgres schema: ${unknown.join(', ')}`);

    // Parents before children where the graph allows it (FKs are deferred
    // anyway, but this keeps the deferred-check queue short).
    const order = await dependencyOrder(client, targetTables);

    // --- emptiness ---------------------------------------------------------------
    const occupied = [];
    for (const t of targetTables) {
      const { rows } = await client.query(`SELECT EXISTS (SELECT 1 FROM "${t}") AS has`);
      if (rows[0].has) occupied.push(t);
    }

    await client.query('BEGIN');
    began = true;
    await client.query('SET CONSTRAINTS ALL DEFERRED');

    if (occupied.length) {
      if (!opts.force) {
        throw new Error(
          `The target database is not empty (rows in: ${occupied.join(', ')}). ` +
          'Refusing to merge; re-run with --force to replace its contents.'
        );
      }
      log(`--force: truncating ${targetTables.length} table(s) in the target`);
      await client.query(`TRUNCATE ${targetTables.map((t) => `"${t}"`).join(', ')} CASCADE`);
    }

    // --- copy ----------------------------------------------------------------------
    const results = [];
    for (const table of order.filter((t) => sourceTables.includes(t))) {
      const sourceCols = (await sAll(source, `PRAGMA table_info("${table}")`)).map((c) => c.name);
      const targetCols = (await client.query(
        `SELECT column_name, data_type FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`, [table]
      )).rows;
      const missing = sourceCols.filter((c) => !targetCols.some((t) => t.column_name === c));
      if (missing.length) {
        throw new Error(`${table}: column(s) ${missing.join(', ')} have no counterpart in Postgres`);
      }
      const cols = targetCols.filter((t) => sourceCols.includes(t.column_name));
      const convert = cols.map((c) => converterFor(c, warn));
      const colList = cols.map((c) => `"${c.column_name}"`).join(', ');
      // Postgres allows 65535 parameters per statement.
      const perStatement = Math.max(1, Math.min(opts.batch, Math.floor(65535 / cols.length)));
      const skipped = skip.get(table) ?? new Set();

      let copied = 0;
      let lastRowid = null;
      for (;;) {
        // Keyset pagination on rowid: constant cost per batch, however large the table.
        const rows = lastRowid === null
          ? await sAll(source, `SELECT rowid AS __rowid, * FROM "${table}" ORDER BY rowid LIMIT ?`, [perStatement])
          : await sAll(source, `SELECT rowid AS __rowid, * FROM "${table}" WHERE rowid > ? ORDER BY rowid LIMIT ?`,
            [lastRowid, perStatement]);
        if (!rows.length) break;
        lastRowid = rows[rows.length - 1].__rowid;
        const keep = rows.filter((r) => !skipped.has(r.__rowid));
        if (keep.length) {
          const values = [];
          const tuples = keep.map((row) => {
            const ctx = { table, rowid: row.__rowid };
            const start = values.length;
            cols.forEach((c, i) => values.push(convert[i](row[c.column_name], ctx)));
            return `(${cols.map((_, i) => `$${start + i + 1}`).join(', ')})`;
          });
          await client.query(`INSERT INTO "${table}" (${colList}) VALUES ${tuples.join(', ')}`, values);
          copied += keep.length;
        }
      }
      const [{ n: sourceCount }] = await sAll(source, `SELECT count(*) AS n FROM "${table}"`);
      const { rows: [{ n: targetCount }] } = await client.query(`SELECT count(*)::bigint AS n FROM "${table}"`);
      results.push({ table, source: sourceCount, skipped: skipped.size, copied, target: Number(targetCount) });
      log(`  ${table.padEnd(24)} ${String(sourceCount).padStart(9)} → ${String(targetCount).padStart(9)}`);
    }

    // --- verify ---------------------------------------------------------------------
    const mismatched = results.filter((r) => r.target !== r.source - r.skipped);
    if (mismatched.length) {
      throw new Error(`Row count mismatch: ${mismatched.map((r) =>
        `${r.table} (source ${r.source} − skipped ${r.skipped} ≠ target ${r.target})`).join('; ')}`);
    }

    if (opts.dryRun) {
      await client.query('ROLLBACK');
      began = false;
      log('\nDry run: everything converted and verified; rolled back.');
    } else {
      // Deferred foreign-key checks run here; a violation aborts the commit.
      await client.query('COMMIT');
      began = false;
      await client.query('ANALYZE');
      log(`\n✅ Copied ${results.reduce((a, r) => a + r.target, 0)} rows in ${results.length} tables; counts verified.`);
    }
    if (warnings.length) {
      log(`\n${warnings.length} warning(s):\n${warnings.slice(0, 50).map((w) => `  ${w}`).join('\n')}`);
    }
    return { tables: results, dryRun: opts.dryRun, warnings };
  } catch (err) {
    if (began) await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    await client.end().catch(() => {});
    await sClose(source);
    await db.closeDB().catch(() => {});
  }
}

/** Tables ordered so a referenced table comes before the tables referencing it. */
async function dependencyOrder(client, tables) {
  const { rows } = await client.query(
    `SELECT DISTINCT tc.table_name AS child, ccu.table_name AS parent
       FROM information_schema.table_constraints tc
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = current_schema()`
  );
  const parents = new Map(tables.map((t) => [t, new Set()]));
  for (const { child, parent } of rows) {
    if (child !== parent && parents.has(child) && parents.has(parent)) parents.get(child).add(parent);
  }
  const ordered = [];
  const state = new Map();
  const visit = (t) => {
    if (state.get(t) === 'done') return;
    if (state.get(t) === 'visiting') return;   // a cycle (users ↔ files): deferred FKs cover it
    state.set(t, 'visiting');
    for (const p of [...parents.get(t)].sort()) visit(p);
    state.set(t, 'done');
    ordered.push(t);
  };
  for (const t of [...tables].sort()) visit(t);
  return ordered;
}

// --- CLI -----------------------------------------------------------------------

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }
  if (opts.help) {
    const header = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 32);
    console.log(header.map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(0);
  }
  try {
    await migrate(opts);
  } catch (err) {
    console.error(`\n❌ Migration failed — nothing was written.\n${err.message}`);
    process.exit(1);
  }
}
