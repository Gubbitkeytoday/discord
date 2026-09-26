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
