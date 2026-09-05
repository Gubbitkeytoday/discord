// SQLite access layer: connection, promise helpers, transactions, migrations.
//
// Exports runQuery / getQuery / allQuery / initDB and the raw `db` handle so
// existing callers keep working unchanged.

import sqlite3 from 'sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { AsyncLocalStorage } from 'async_hooks';
import { seedDatabase } from './db/seed.js';
import { DISCORD_EPOCH } from './lib/snowflake.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (!process.env.NODE_TEST_CONTEXT && process.env.NODE_ENV !== 'test') {
  try {
    process.loadEnvFile?.();
  } catch {}
}

export const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'discord.db');
const SCHEMA_PATH = path.join(__dirname, 'db', 'schema.sql');

/**
 * Ordered migrations applied after schema.sql. schema.sql is the baseline for a
 * fresh database (every statement is CREATE ... IF NOT EXISTS); these handle
 * changes that an existing database cannot pick up from it.
 */
const MIGRATIONS = [
  { version: 1, name: 'initial full schema', up: async () => {} },
  {
    version: 2,
    name: 'rebuild messages_fts with trigram tokenizer',
    up: async () => {
      // A virtual table's tokenizer cannot be altered, and CREATE IF NOT EXISTS
      // will not replace one that already exists — so drop and repopulate.
      await runQuery(`DROP TABLE IF EXISTS messages_fts`);
      await runQuery(
        `CREATE VIRTUAL TABLE messages_fts USING fts5(
           content, message_id UNINDEXED, channel_id UNINDEXED, tokenize = 'trigram'
         )`
      );
      await runQuery(
        `INSERT INTO messages_fts (content, message_id, channel_id)
         SELECT content, id, channel_id FROM messages
          WHERE deleted_at IS NULL AND content IS NOT NULL AND content != ''`
      );
    }
  },
  {
    version: 3,
    name: 'renumber non-snowflake message ids',
    // Toggles PRAGMA foreign_keys, which is a no-op inside a transaction.
    unsafeOutsideTransaction: true,
    up: async () => {
      // Channel history is ordered and paginated by message id, which only
      // works while every id is a numeric snowflake. Early seed data used
      // 'msg-1'-style ids, and those sort *after* every snowflake — putting old
      // messages at the end of history and breaking `before=` pagination.
      const legacy = await allQuery(
        `SELECT id, created_at FROM messages WHERE id NOT GLOB '[0-9]*' ORDER BY created_at ASC`
      );
      if (legacy.length === 0) return;

      // Rewriting a primary key means rewriting every reference to it by hand;
      // these FKs have no ON UPDATE CASCADE.
      const referencing = [
        ['reactions', 'message_id'], ['mentions', 'message_id'],
        ['attachments', 'message_id'], ['pins', 'message_id'],
        ['message_edits', 'message_id'], ['notifications', 'message_id'],
        ['messages', 'reply_to_id'], ['messages_fts', 'message_id'],
        ['channels', 'last_message_id'], ['read_states', 'last_read_message_id']
      ];

      await runQuery('PRAGMA foreign_keys = OFF');
      try {
        for (const [index, row] of legacy.entries()) {
          const base = Date.parse(row.created_at);
          const newId = ((BigInt(Number.isFinite(base) ? base : Date.now()) - DISCORD_EPOCH) << 22n)
            + BigInt(index);
          await runQuery(`UPDATE messages SET id = ? WHERE id = ?`, [newId.toString(), row.id]);
          for (const [table, column] of referencing) {
            await runQuery(
              `UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`,
              [newId.toString(), row.id]
            );
          }
        }
      } finally {
        await runQuery('PRAGMA foreign_keys = ON');
      }
      console.log(`   renumbered ${legacy.length} legacy message id(s)`);
    }
  },
  {
    version: 4,
    name: 'backfill dev passwords for seed accounts',
    up: async () => {
      // Accounts seeded before authentication existed have no password_hash, so
      // nobody can log in to an existing dev database. Backfill the shared dev
      // password for the seed accounts only (ids of the form 'user-*'); real
      // accounts created through /api/auth/register are never touched.
      const seedAccounts = await allQuery(
        `SELECT id FROM users WHERE password_hash IS NULL AND id LIKE 'user-%'`
      );
      if (seedAccounts.length === 0) return;

      const { hashPassword } = await import('./lib/auth.js');
      const { SEED_PASSWORD } = await import('./db/seed.js');
      const hash = await hashPassword(SEED_PASSWORD);

      for (const account of seedAccounts) {
        await runQuery(
          `UPDATE users SET password_hash = ?, email = COALESCE(email, ? ) WHERE id = ?`,
          [hash, `${account.id}@example.dev`, account.id]
        );
      }
      console.log(`   backfilled dev password for ${seedAccounts.length} seed account(s)`);
    }
  },
  {
    version: 5,
    name: 'add account_tokens and media duration columns',
    up: async () => {
      // schema.sql creates account_tokens for fresh databases; an existing one
      // picks it up here because CREATE TABLE IF NOT EXISTS already ran above.
      const table = await getQuery(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='account_tokens'`
      );
      if (!table) {
        throw new Error('account_tokens missing — schema.sql did not apply');
      }
      // duration_secs already exists on files; nothing to alter. This migration
      // exists so the version bump is recorded and the check above runs.
    }
  },
  {
    version: 6,
    name: 'stickers on messages',
    up: async () => {
      const cols = await allQuery(`PRAGMA table_info(messages)`);
      if (!cols.some((c) => c.name === 'sticker_id')) {
        await runQuery(`ALTER TABLE messages ADD COLUMN sticker_id TEXT REFERENCES stickers(id) ON DELETE SET NULL`);
      }
    }
  },
  {
    version: 7,
    name: 'reports scoped to a guild',
    up: async () => {
      const cols = await allQuery(`PRAGMA table_info(reports)`);
      if (!cols.some((c) => c.name === 'server_id')) {
        await runQuery(`ALTER TABLE reports ADD COLUMN server_id TEXT REFERENCES servers(id) ON DELETE CASCADE`);
        // Backfill from the reported message, which is the only target type
        // that reliably carries a guild.
        await runQuery(
          `UPDATE reports SET server_id = (
             SELECT m.server_id FROM messages m WHERE m.id = reports.target_id
           ) WHERE target_type = 'message' AND server_id IS NULL`
        );
      }
    }
  },
  {
    version: 8,
    name: 'per-account client settings',
    up: async () => {
      // schema.sql creates the table for fresh databases; an existing one picks
      // it up from the same CREATE TABLE IF NOT EXISTS that ran above.
      const table = await getQuery(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='user_settings'`
      );
      if (!table) throw new Error('user_settings missing — schema.sql did not apply');
    }
  },
  {
    version: 9,
    name: 'polls',
    up: async () => {
      // The tables come from schema.sql (CREATE TABLE IF NOT EXISTS runs first
      // on every boot). What an *existing* database cannot pick up that way is
      // the widened CHECK constraint on messages.type, because SQLite has no
      // ALTER for a constraint — so allow 'poll' by rebuilding the check.
      for (const name of ['polls', 'poll_answers', 'poll_votes']) {
        const table = await getQuery(
          `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`, [name]
        );
        if (!table) throw new Error(`${name} missing — schema.sql did not apply`);
      }

      const ddl = await getQuery(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='messages'`
      );
      if (ddl?.sql?.includes("'poll'")) return;   // fresh database, already correct

      // Rebuilding a table is the documented way to change a CHECK. Do it with
      // foreign keys off, inside the migration's own transaction, so nothing
      // observes the half-built state.
      await runQuery(`PRAGMA foreign_keys = OFF`);
      const widened = ddl.sql.replace(
        "'channel_follow_add')",
        "'channel_follow_add','poll')"
      );
      await runQuery(widened.replace(
        'CREATE TABLE IF NOT EXISTS messages',
        'CREATE TABLE messages_rebuilt'
      ).replace('CREATE TABLE messages ', 'CREATE TABLE messages_rebuilt '));
      await runQuery(`INSERT INTO messages_rebuilt SELECT * FROM messages`);
      await runQuery(`DROP TABLE messages`);
      await runQuery(`ALTER TABLE messages_rebuilt RENAME TO messages`);
      await runQuery(`PRAGMA foreign_keys = ON`);
    }
  },
  {
    version: 10,
    name: 'events, user notes, friend-request note, profile privacy',
    up: async () => {
      for (const name of ['scheduled_events', 'event_interest', 'user_notes']) {
        const table = await getQuery(
          `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`, [name]
        );
        if (!table) throw new Error(`${name} missing — schema.sql did not apply`);
      }
      // ADD COLUMN is the one ALTER SQLite supports, and it is idempotent-by-check
      // here so a re-run on a partially migrated database does not fail.
      const addColumn = async (table, column, ddl) => {
        const cols = await allQuery(`PRAGMA table_info(${table})`);
        if (!cols.some((c) => c.name === column)) {
          await runQuery(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
        }
      };
      // A note the requester attaches so the recipient knows who they are.
      await addColumn('friends', 'note', 'TEXT');
      // Who may see the bio: everyone / servers you share / friends only.
      await addColumn('users', 'profile_visibility',
        "TEXT NOT NULL DEFAULT 'everyone' CHECK (profile_visibility IN ('everyone','mutual','friends'))");
    }
  }
  ,{
    version: 11,
    name: 'forum tags, post pinning, forum defaults',
    up: async () => {
      for (const name of ['forum_tags', 'forum_post_tags']) {
        const table = await getQuery(
          `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`, [name]
        );
        if (!table) throw new Error(`${name} missing — schema.sql did not apply`);
      }
      const addColumn = async (table, column, ddl) => {
        const cols = await allQuery(`PRAGMA table_info(${table})`);
        if (!cols.some((c) => c.name === column)) {
          await runQuery(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
        }
      };
      // A pinned forum post floats to the top of the list.
      await addColumn('channels', 'pinned', 'INTEGER NOT NULL DEFAULT 0');
      // Forum defaults: how posts are ordered and the one-tap reaction shown
      // under every post ("👍" in Discord's default).
      await addColumn('channels', 'default_sort_order',
        "TEXT NOT NULL DEFAULT 'latest_activity' CHECK (default_sort_order IN ('latest_activity','creation_date'))");
      await addColumn('channels', 'default_reaction_emoji', 'TEXT');
      await addColumn('channels', 'require_tag', 'INTEGER NOT NULL DEFAULT 0');
      // Default layout of the post list: Discord's "List" vs "Gallery". A media
      // channel is a forum whose default layout is the gallery.
      await addColumn('channels', 'default_layout',
        "TEXT NOT NULL DEFAULT 'list' CHECK (default_layout IN ('list','gallery'))");
    }
  }
  ,{
    version: 12,
    name: 'membership screening, welcome screen, onboarding',
    up: async () => {
      for (const name of ['welcome_channels', 'onboarding_prompts', 'onboarding_options', 'member_onboarding']) {
        const table = await getQuery(
          `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`, [name]
        );
        if (!table) throw new Error(`${name} missing — schema.sql did not apply`);
      }
      const addColumn = async (table, column, ddl) => {
        const cols = await allQuery(`PRAGMA table_info(${table})`);
        if (!cols.some((c) => c.name === column)) {
          await runQuery(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
        }
      };
      await addColumn('servers', 'screening_enabled', 'INTEGER NOT NULL DEFAULT 0');
      await addColumn('servers', 'screening_rules', 'TEXT');
      await addColumn('servers', 'welcome_description', 'TEXT');
      await addColumn('servers', 'welcome_enabled', 'INTEGER NOT NULL DEFAULT 0');
    }
  }
  ,{
    version: 13,
    name: 'channel following',
    up: async () => {
      for (const name of ['channel_follows', 'message_crossposts']) {
        const table = await getQuery(
          `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`, [name]
        );
        if (!table) throw new Error(`${name} missing — schema.sql did not apply`);
      }
    }
  }
  ,{
    version: 14,
    name: 'server templates',
    up: async () => {
      const table = await getQuery(`SELECT name FROM sqlite_master WHERE type='table' AND name = 'server_templates'`);
      if (!table) throw new Error('server_templates missing — schema.sql did not apply');
    }
  }
  ,{
    version: 15,
    name: 'applications, bot commands, interactions',
    up: async () => {
      for (const name of ['applications', 'application_commands', 'interactions']) {
        const table = await getQuery(
          `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`, [name]
        );
        if (!table) throw new Error(`${name} missing — schema.sql did not apply`);
      }
      const addColumn = async (table, column, ddl) => {
        const cols = await allQuery(`PRAGMA table_info(${table})`);
        if (!cols.some((c) => c.name === column)) {
          await runQuery(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
        }
      };
      // An ephemeral reply exists as a real row (so history and moderation
      // still work) but is only ever delivered to one person.
      await addColumn('messages', 'ephemeral_user_id', 'TEXT');
      // Which application produced a bot message, for attribution.
      await addColumn('messages', 'application_id', 'TEXT');
    }
  }
];

// Applied in array order, so the array order must be the version order — and
// SCHEMA_VERSION is the highest, not merely the last.
for (let i = 1; i < MIGRATIONS.length; i += 1) {
  if (MIGRATIONS[i].version <= MIGRATIONS[i - 1].version) {
    throw new Error(
      `MIGRATIONS is out of order at index ${i}: v${MIGRATIONS[i].version} follows v${MIGRATIONS[i - 1].version}`
    );
  }
}

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

const verbose = process.env.SQL_DEBUG === '1' ? sqlite3.verbose() : sqlite3;

const db = new verbose.Database(DB_PATH, (err) => {
  if (err) {
    console.error('❌ Error opening SQLite database:', err.message);
    process.exit(1);
  }
  // Inside `node --test` the child's stdout is the runner's own channel, and a
  // stray banner from a directly-imported module corrupts it.
  if (!process.env.NODE_TEST_CONTEXT) {
    console.log(`🗄️  Connected to SQLite database: ${path.basename(DB_PATH)}`);
  }
});

// Serialize writes so concurrent socket handlers never interleave a transaction.
db.serialize();

// --- promise helpers ---------------------------------------------------------

export const runQuery = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(decorate(err, sql));
      else resolve(this); // { lastID, changes }
    });
  });

export const getQuery = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(decorate(err, sql));
      else resolve(row);
    });
  });

export const allQuery = (sql, params = []) =>
  new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(decorate(err, sql));
      else resolve(rows ?? []);
    });
  });

export const execScript = (sql) =>
  new Promise((resolve, reject) => {
    db.exec(sql, (err) => (err ? reject(decorate(err, sql)) : resolve()));
  });

function decorate(err, sql) {
  err.sql = String(sql).trim().slice(0, 200);
  return err;
}

/**
 * Run `fn` inside a transaction, rolling back on any throw.
 *
 * There is one connection and SQLite has no nested transactions, so concurrent
 * callers are *serialised* rather than interleaved. A plain boolean guard is
 * not enough: it cannot tell a nested call from a concurrent one, so a second
 * request arriving mid-transaction would run its writes inside — and be
 * committed or rolled back by — the first one's transaction.
 *
 * Nesting is detected with AsyncLocalStorage (a nested call really does join
 * the outer transaction, which is what callers expect); everything else queues
 * behind a promise chain and gets a transaction of its own.
 */
const transactionContext = new AsyncLocalStorage();
let transactionQueue = Promise.resolve();

export function transaction(fn) {
  // Already inside one on this async call stack: join it.
  if (transactionContext.getStore()) return fn();

  const run = async () => {
    await runQuery('BEGIN IMMEDIATE');
    try {
      const result = await transactionContext.run({ depth: 1 }, fn);
      await runQuery('COMMIT');
      return result;
    } catch (err) {
      try { await runQuery('ROLLBACK'); } catch { /* already rolled back */ }
      throw err;
    }
  };

  // Queue behind whatever is already running, but never let one caller's
  // failure break the chain for the next.
  const result = transactionQueue.then(run, run);
  transactionQueue = result.then(() => {}, () => {});
  return result;
}

// --- schema management -------------------------------------------------------

async function tableExists(name) {
  const row = await getQuery(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [name]
  );
  return Boolean(row);
}

/**
 * The prototype schema had no schema_migrations table and a much thinner shape
 * (no roles, no files registry, reactions as a JSON blob). There is no sensible
 * column-by-column upgrade path and the only data in it is seed data, so back
 * the file up and rebuild.
 */
async function rebuildLegacySchema() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = `${DB_PATH}.legacy-${stamp}.bak`;
  if (fs.existsSync(DB_PATH)) {
    fs.copyFileSync(DB_PATH, backup);
    console.warn(`⚠️  Legacy schema detected. Backed up to ${path.basename(backup)}`);
  }

  const tables = await allQuery(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`
  );
  await runQuery('PRAGMA foreign_keys = OFF');
  for (const { name } of tables) {
    await runQuery(`DROP TABLE IF EXISTS "${name}"`);
  }
  await runQuery('PRAGMA foreign_keys = ON');
  console.warn('♻️  Legacy tables dropped; rebuilding with schema v1.');
}

export async function initDB({ seed = true } = {}) {
  // WAL keeps readers unblocked while a write transaction is open — needed once
  // socket handlers and HTTP routes write concurrently.
  await runQuery('PRAGMA journal_mode = WAL');
  await runQuery('PRAGMA foreign_keys = ON');
  await runQuery('PRAGMA busy_timeout = 5000');
  await runQuery('PRAGMA synchronous = NORMAL');

  const hasMigrations = await tableExists('schema_migrations');
  if (!hasMigrations && (await tableExists('users'))) {
    await rebuildLegacySchema();
  }

  await execScript(fs.readFileSync(SCHEMA_PATH, 'utf8'));

  const appliedRows = await allQuery(`SELECT version FROM schema_migrations`);
  const applied = new Set(appliedRows.map((r) => r.version));

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    // The migration and the row that records it commit together, so a crash
    // can never leave a half-applied schema that the next boot skips.
    // v3 manages its own foreign-key pragma, which cannot run inside a
    // transaction, so it opts out.
    const runIt = async () => {
      await migration.up();
      await runQuery(
        `INSERT INTO schema_migrations (version, name) VALUES (?, ?)`,
        [migration.version, migration.name]
      );
    };
    if (migration.unsafeOutsideTransaction) await runIt();
    else await transaction(runIt);
    if (!process.env.NODE_TEST_CONTEXT) {
      console.log(`📐 Applied migration v${migration.version} — ${migration.name}`);
    }
  }

  if (seed) await seedDatabase({ runQuery, getQuery, transaction });

  await runQuery('PRAGMA optimize');
  return db;
}

/** Flush WAL and close cleanly. */
export function closeDB() {
  return new Promise((resolve) => {
    db.run('PRAGMA wal_checkpoint(TRUNCATE)', () => db.close(() => resolve()));
  });
}

export default db;
