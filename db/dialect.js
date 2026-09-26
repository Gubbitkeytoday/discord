// ============================================================================
//  SQL dialect selection and portable SQL fragments.
//
//  The backend runs on one of two drivers, picked once at startup:
//
//    DATABASE_URL=postgres://…   → PostgreSQL (node-postgres pool)
//    anything else / unset       → SQLite file at DB_PATH (zero-config dev)
//
//  Queries are written once, in the subset both engines understand, with `?`
//  placeholders. Where the engines genuinely differ, a query site interpolates
//  one of the fragments below instead of hand-writing the SQLite spelling. The
//  fragments are constants chosen at import time, so they cost nothing at
//  runtime and a query string can still be read top to bottom.
//
//  The one thing rewritten at runtime is the placeholder: `?` → `$n` for
//  Postgres (see toPgPlaceholders). Nothing else about the SQL is touched.
// ============================================================================

// Load .env before anything reads process.env. db.js is imported first by
// server.js and the scripts, and this module is the first thing db.js imports.
if (!process.env.NODE_TEST_CONTEXT && process.env.NODE_ENV !== 'test') {
  try {
    process.loadEnvFile?.();
  } catch { /* no .env file — fine */ }
}

/**
 * Which engine a given environment selects. Exported so scripts (the data
 * migration tool, backups) can reason about a URL without importing db.js.
 */
export function resolveDialect(env = process.env) {
  const url = String(env.DATABASE_URL ?? '').trim();
  if (!url) return 'sqlite';
  if (/^postgres(ql)?:\/\//i.test(url)) return 'postgres';
  throw new Error(
    `DATABASE_URL must be a postgres:// or postgresql:// URL (got "${url.split(':')[0]}:…"). ` +
    'Unset it to use SQLite at DB_PATH.'
  );
}

export const DIALECT = resolveDialect();
export const isPostgres = DIALECT === 'postgres';
export const isSqlite = !isPostgres;

/**
 * Portable SQL fragments. Interpolate these into query text; never user input.
 *
 *   sql.now              current instant, as the engine stores timestamps
 *   sql.like             case-insensitive LIKE (SQLite's LIKE already folds ASCII)
 *   sql.greatest(a, b)   scalar max of two expressions
 *   sql.least(a, b)      scalar min of two expressions
 *   sql.day(expr)        UTC calendar day of a timestamp as 'YYYY-MM-DD'
 *   sql.forUpdate        row lock for read-then-write inside a transaction
 *   sql.text(expr)       an expression (typically a `?`) typed as text, so
 *                        Postgres can infer a parameter's type in positions
 *                        like `? IS NULL` where nothing else constrains it
 *   sql.int(expr)        same, as an integer
 */
export const sql = Object.freeze({
  dialect: DIALECT,
  now: isPostgres ? 'now()' : "strftime('%Y-%m-%dT%H:%M:%fZ','now')",
  like: isPostgres ? 'ILIKE' : 'LIKE',
  greatest: (a, b) => (isPostgres ? `GREATEST(${a}, ${b})` : `MAX(${a}, ${b})`),
  least: (a, b) => (isPostgres ? `LEAST(${a}, ${b})` : `MIN(${a}, ${b})`),
  day: (expr) => (isPostgres
    ? `to_char((${expr}) AT TIME ZONE 'UTC', 'YYYY-MM-DD')`
    : `substr(${expr}, 1, 10)`),
  forUpdate: isPostgres ? ' FOR UPDATE' : '',
  text: (expr) => `CAST(${expr} AS TEXT)`,
  int: (expr) => `CAST(${expr} AS INTEGER)`
});

// --- error classification ----------------------------------------------------
//
// Both drivers mark their errors with `isDatabaseError`. SQLite reports every
// constraint as SQLITE_CONSTRAINT with the kind in the message; Postgres uses
// SQLSTATE codes.

const sqliteConstraint = (err, pattern) =>
  err?.code === 'SQLITE_CONSTRAINT' && pattern.test(String(err.message));

/** A UNIQUE / PRIMARY KEY violation, on either engine. */
export function isUniqueViolation(err) {
  return (err?.isDatabaseError && err.code === '23505') || sqliteConstraint(err, /UNIQUE|PRIMARY KEY/);
}

/** A FOREIGN KEY violation, on either engine. */
export function isForeignKeyViolation(err) {
  return (err?.isDatabaseError && err.code === '23503') || sqliteConstraint(err, /FOREIGN KEY/);
}

/** Any integrity-constraint violation (unique, FK, NOT NULL, CHECK), on either engine. */
export function isConstraintViolation(err) {
  if (!err?.isDatabaseError) return false;
  return err.code === 'SQLITE_CONSTRAINT' || (typeof err.code === 'string' && err.code.startsWith('23'));
}

/**
 * Map a database error to what an API client may be told: an HTTP status, a
 * stable machine code and a generic message. Never the engine's own text,
 * which names tables, columns and constraints. Returns null for errors that
 * are not from the database.
 */
export function classifyDatabaseError(err) {
  if (err?.code === 'DB_CLOSED') {
    return { status: 503, code: 'SERVICE_UNAVAILABLE', message: 'The server is restarting — try again shortly' };
  }
  if (!err?.isDatabaseError) return null;
  if (isUniqueViolation(err)) {
    return { status: 409, code: 'CONFLICT', message: 'That already exists' };
  }
  if (isForeignKeyViolation(err)) {
    return { status: 409, code: 'REFERENCE_CONFLICT', message: 'A referenced item does not exist or is still in use' };
  }
  if (isConstraintViolation(err)) {
    return { status: 400, code: 'INVALID_INPUT', message: 'The request contains an invalid value' };
  }
  const code = String(err.code ?? '');
  // 22xxx data exceptions: bad number/date syntax, value out of range, …
  if (code.startsWith('22') || err.code === 'SQLITE_MISMATCH' || err.code === 'SQLITE_TOOBIG') {
    return { status: 400, code: 'INVALID_INPUT', message: 'The request contains an invalid value' };
  }
  if (code === '40001' || code === '40P01' || code === '55P03' || err.code === 'SQLITE_BUSY') {
    return { status: 503, code: 'BUSY', message: 'The server is busy — try again' };
  }
  if (code === '57014') {
    return { status: 503, code: 'TIMEOUT', message: 'The request took too long' };
  }
  return { status: 500, code: 'INTERNAL_ERROR', message: 'Internal server error' };
}

/**
 * Rewrite `?` placeholders to `$1…$n` for Postgres.
 *
 * A `?` inside a string literal, a quoted identifier, a dollar-quoted body or
 * a comment is left alone. That is the whole of the runtime rewriting: every
 * other dialect difference is handled explicitly at the query site.
 */
export function toPgPlaceholders(text) {
  let out = '';
  let n = 0;
  let i = 0;
  const len = text.length;
  while (i < len) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "'" || ch === '"') {
      // Quoted literal/identifier; a doubled quote is an escaped quote.
      let j = i + 1;
      while (j < len) {
        if (text[j] === ch) {
          if (text[j + 1] === ch) { j += 2; continue; }
          break;
        }
        j += 1;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '-' && next === '-') {
      const j = text.indexOf('\n', i);
      const end = j === -1 ? len : j;
      out += text.slice(i, end);
      i = end;
    } else if (ch === '/' && next === '*') {
      const j = text.indexOf('*/', i + 2);
      const end = j === -1 ? len : j + 2;
      out += text.slice(i, end);
      i = end;
    } else if (ch === '$' && (next === '$' || /[A-Za-z_]/.test(next ?? ''))) {
      // `$$…$$` or `$tag$…$tag$` dollar quote. `$1`-style parameters start
      // with a digit and fall through to the default branch.
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i, i + 66));
      if (m) {
        const tag = m[0];
        const j = text.indexOf(tag, i + tag.length);
        const end = j === -1 ? len : j + tag.length;
        out += text.slice(i, end);
        i = end;
      } else {
        out += ch;
        i += 1;
      }
    } else if (ch === '?') {
      n += 1;
      out += `$${n}`;
      i += 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}
