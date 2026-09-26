// Database access layer: driver selection, promise helpers, transactions,
// migrations.
//
//   DATABASE_URL=postgres://…  → PostgreSQL (db/postgres.js, pooled)
//   otherwise                  → SQLite at DB_PATH (db/sqlite.js)
//
// Callers use runQuery / getQuery / allQuery / transaction with `?`
// placeholders, and the `sql` fragments from db/dialect.js wherever the two
// engines genuinely differ. See DEPLOYMENT.md for the operational side.

// dialect.js loads .env, so it must stay the first import.
import { DIALECT, isPostgres, sql } from './db/dialect.js';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { createSqliteDriver } from './db/sqlite.js';
import { seedDatabase } from './db/seed.js';
import { DISCORD_EPOCH } from './lib/snowflake.js';
import { PASSKEY_DDL } from './db/migrations/passkeys.js'; // passkeys
import { TRANSLATION_DDL } from './db/migrations/translation.js'; // translation

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export { sql, DIALECT, isPostgres };

export const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'discord.db');
const SCHEMA_PATH = path.join(__dirname, 'db', 'schema.sql');
const PG_SCHEMA_PATH = path.join(__dirname, 'db', 'schema.pg.sql');

/**
 * db/schema.pg.sql is the Postgres baseline and already contains everything
 * SQLite migrations 1..PG_BASELINE_VERSION add, so on Postgres those versions
 * are recorded as applied when the baseline is created. Every migration after
 * it must provide a `postgres` implementation alongside the SQLite `up`.
 */
const PG_BASELINE_VERSION = 17;

// Arbitrary but fixed: every instance contends for the same advisory lock, so
// only one of several processes booting at once runs migrations and seeding.
const MIGRATION_LOCK_KEY = 7_311_452_019;

/**
 * Ordered migrations applied after schema.sql. schema.sql is the baseline for a
 * fresh database (every statement is CREATE ... IF NOT EXISTS); these handle
 * changes that an existing database cannot pick up from it.
 *
 * `up` is the SQLite implementation. From v18 on, each entry also needs a
 * `postgres` implementation (see PG_BASELINE_VERSION).
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
  ,{
    version: 16,
    name: 'raid protection, widget, per-guild profiles',
    up: async () => {
      const table = await getQuery(`SELECT name FROM sqlite_master WHERE type='table' AND name = 'guild_lockdowns'`);
      if (!table) throw new Error('guild_lockdowns missing — schema.sql did not apply');
      const addColumn = async (t, column, ddl) => {
        const cols = await allQuery(`PRAGMA table_info(${t})`);
        if (!cols.some((c) => c.name === column)) await runQuery(`ALTER TABLE ${t} ADD COLUMN ${column} ${ddl}`);
      };
      await addColumn('servers', 'raid_protection', 'INTEGER NOT NULL DEFAULT 0');
      await addColumn('servers', 'raid_join_threshold', 'INTEGER NOT NULL DEFAULT 10');
      await addColumn('servers', 'raid_join_window_secs', 'INTEGER NOT NULL DEFAULT 60');
      await addColumn('servers', 'raid_action', "TEXT NOT NULL DEFAULT 'lockdown'");
      await addColumn('servers', 'widget_enabled', 'INTEGER NOT NULL DEFAULT 0');
      await addColumn('servers', 'widget_channel_id', 'TEXT');
      // A per-guild profile: Discord lets a member look different in each
      // server, and the pieces are the same ones the global profile has.
      await addColumn('server_members', 'banner_url', 'TEXT');
      await addColumn('server_members', 'bio', 'TEXT');
      await addColumn('server_members', 'pronouns', 'TEXT');
    }
  }
  ,{
    version: 17,
    name: 'DM calls, spoiler channels, gradient roles, context-menu commands',
    up: async () => {
      for (const name of ['calls', 'call_participants']) {
        const table = await getQuery(
          `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`, [name]
        );
        if (!table) throw new Error(`${name} missing — schema.sql did not apply`);
      }
      const addColumn = async (t, column, ddl) => {
        const cols = await allQuery(`PRAGMA table_info(${t})`);
        if (!cols.some((c) => c.name === column)) await runQuery(`ALTER TABLE ${t} ADD COLUMN ${column} ${ddl}`);
      };
      // A spoiler channel hides its contents behind one click, the way a
      // spoiler attachment does — useful for episode-discussion channels.
      await addColumn('channels', 'spoiler', 'INTEGER NOT NULL DEFAULT 0');
      // A second colour turns the role name into a gradient. NULL keeps the
      // flat colour every existing role already has.
      await addColumn('roles', 'color_secondary', 'TEXT');
      // Existing commands are all slash commands; the new kinds are opt-in.
      // ALTER TABLE cannot add a CHECK, so the constraint lives in the service.
      await addColumn('application_commands', 'type', "TEXT NOT NULL DEFAULT 'slash'");
    }
  },
  // --- notifications / web push (services/notifications.js, services/push.js) ---
  // DDL lives only here (idempotent), not in schema.sql / schema.pg.sql.
  {
    version: 32,
    name: 'notification level inheritance, keyword highlights, push privacy',
    up: async () => {
      const cols = await allQuery(`PRAGMA table_info(server_settings)`);
      if (!cols.some((c) => c.name === 'level_override')) {
        // NULL = "use the server's default_notifications". notification_level
        // cannot express that (its CHECK has no 'inherit' and rows are created
        // with 'all_messages' on join), so an explicit choice lives here.
        await runQuery(`ALTER TABLE server_settings ADD COLUMN level_override TEXT`);
      }
      await runQuery(
        `UPDATE server_settings SET level_override = notification_level
          WHERE level_override IS NULL AND notification_level <> 'all_messages'`
      );
      await runQuery(
        `CREATE TABLE IF NOT EXISTS notification_prefs (
           user_id       TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
           keywords      TEXT NOT NULL DEFAULT '[]',
           push_content  TEXT NOT NULL DEFAULT 'full'
                         CHECK (push_content IN ('full','name_only','hidden')),
           updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         )`
      );
      await runQuery(`CREATE INDEX IF NOT EXISTS idx_channel_settings_channel ON channel_settings(channel_id)`);
      await runQuery(`CREATE INDEX IF NOT EXISTS idx_server_settings_server ON server_settings(server_id)`);
      await runQuery(`CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks(blocked_id)`);
    },
    postgres: async () => {
      await runQuery(
        `ALTER TABLE server_settings ADD COLUMN IF NOT EXISTS level_override TEXT COLLATE "C"
           CHECK (level_override IN ('all_messages','only_mentions','nothing'))`
      );
      await runQuery(
        `UPDATE server_settings SET level_override = notification_level
          WHERE level_override IS NULL AND notification_level <> 'all_messages'`
      );
      await runQuery(
        `CREATE TABLE IF NOT EXISTS notification_prefs (
           user_id       TEXT COLLATE "C" PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE DEFERRABLE,
           keywords      TEXT NOT NULL DEFAULT '[]',
           push_content  TEXT COLLATE "C" NOT NULL DEFAULT 'full'
                         CHECK (push_content IN ('full','name_only','hidden')),
           updated_at    TIMESTAMPTZ(3) NOT NULL DEFAULT now()
         )`
      );
      await runQuery(`CREATE INDEX IF NOT EXISTS idx_channel_settings_channel ON channel_settings(channel_id)`);
      await runQuery(`CREATE INDEX IF NOT EXISTS idx_server_settings_server ON server_settings(server_id)`);
      await runQuery(`CREATE INDEX IF NOT EXISTS idx_blocks_blocked ON blocks(blocked_id)`);
    }
  }
  ,{
    version: 33,
    name: 'web push subscriptions',
    up: async () => {
      // A subscription belongs to the session (device login) that created it:
      // ending the session — logout, revoke, expiry prune — removes it.
      await runQuery(
        `CREATE TABLE IF NOT EXISTS push_subscriptions (
           id               TEXT PRIMARY KEY,
           user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           session_id       TEXT REFERENCES sessions(id) ON DELETE CASCADE,
           endpoint         TEXT NOT NULL UNIQUE,
           p256dh           TEXT NOT NULL,
           auth             TEXT NOT NULL,
           user_agent       TEXT,
           expiration_time  TEXT,
           failure_count    INTEGER NOT NULL DEFAULT 0,
           last_success_at  TEXT,
           created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
         )`
      );
      await runQuery(`CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id)`);
      await runQuery(`CREATE INDEX IF NOT EXISTS idx_push_subscriptions_session ON push_subscriptions(session_id)`);
    },
    postgres: async () => {
      await runQuery(
        `CREATE TABLE IF NOT EXISTS push_subscriptions (
           id               TEXT COLLATE "C" PRIMARY KEY,
           user_id          TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE,
           session_id       TEXT COLLATE "C" REFERENCES sessions(id) ON DELETE CASCADE DEFERRABLE,
           endpoint         TEXT COLLATE "C" NOT NULL UNIQUE,
           p256dh           TEXT NOT NULL,
           auth             TEXT NOT NULL,
           user_agent       TEXT,
           expiration_time  TIMESTAMPTZ(3),
           failure_count    INTEGER NOT NULL DEFAULT 0,
           last_success_at  TIMESTAMPTZ(3),
           created_at       TIMESTAMPTZ(3) NOT NULL DEFAULT now()
         )`
      );
      await runQuery(`CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id)`);
      await runQuery(`CREATE INDEX IF NOT EXISTS idx_push_subscriptions_session ON push_subscriptions(session_id)`);
    }
  }
  // realtime-scale: GET /api/sync counts edits and deletions since a cursor
  // per channel; these partial indexes keep that off a table scan. Both
  // baselines (schema.sql / schema.pg.sql) create them too, so a fresh
  // database already has them and IF NOT EXISTS makes this a no-op there.
  ,{
    version: 34,
    name: 'sync indexes on messages.edited_at / deleted_at',
    up: async () => {
      await runQuery(`CREATE INDEX IF NOT EXISTS idx_messages_edited ON messages(channel_id, edited_at) WHERE edited_at IS NOT NULL`);
      await runQuery(`CREATE INDEX IF NOT EXISTS idx_messages_deleted ON messages(channel_id, deleted_at) WHERE deleted_at IS NOT NULL`);
    },
    postgres: async () => {
      await runQuery(`CREATE INDEX IF NOT EXISTS idx_messages_edited ON messages(channel_id, edited_at) WHERE edited_at IS NOT NULL`);
      await runQuery(`CREATE INDEX IF NOT EXISTS idx_messages_deleted ON messages(channel_id, deleted_at) WHERE deleted_at IS NOT NULL`);
    }
  }
  // passkeys (v35) — WebAuthn credentials, single-use challenges, audit trail.
  // Self-contained DDL (not in schema.sql / schema.pg.sql) so it merges cleanly.
  ,{
    version: 35,
    name: 'passkeys (WebAuthn credentials, challenges, events)',
    up: async () => { for (const ddl of PASSKEY_DDL.sqlite) await runQuery(ddl); },
    postgres: async () => { for (const ddl of PASSKEY_DDL.postgres) await runQuery(ddl); }
  }
  // translation (v36) — per-message translation cache + guild opt-out.
  ,{
    version: 36,
    name: 'message translation cache, guild translation switch',
    up: async () => {
      for (const ddl of TRANSLATION_DDL.sqlite) await runQuery(ddl);
      const cols = await allQuery(`PRAGMA table_info(servers)`);
      if (!cols.some((c) => c.name === 'translation_disabled')) {
        await runQuery(`ALTER TABLE servers ADD COLUMN translation_disabled INTEGER NOT NULL DEFAULT 0`);
      }
    },
    postgres: async () => {
      for (const ddl of TRANSLATION_DDL.postgres) await runQuery(ddl);
      await runQuery(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS translation_disabled INTEGER NOT NULL DEFAULT 0`);
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

for (const migration of MIGRATIONS) {
  if (migration.version > PG_BASELINE_VERSION && typeof migration.postgres !== 'function') {
    throw new Error(`Migration v${migration.version} has no postgres implementation`);
  }
}

// Inside `node --test` the child's stdout is the runner's own channel, and a
// stray banner from a directly-imported module corrupts it.
const quiet = Boolean(process.env.NODE_TEST_CONTEXT);

const driver = isPostgres
  ? (await import('./db/postgres.js')).createPgDriver(process.env, { quiet })
  : createSqliteDriver({ dbPath: DB_PATH, verbose: process.env.SQL_DEBUG === '1', quiet });

// --- promise helpers ---------------------------------------------------------

// In-flight operations, so closeDB() can let work that is already running
// (a socket's disconnect handler marking its user offline, say) finish before
// the connection goes away, instead of failing it half-way.
let inflight = 0;
let lastSettled = Date.now();
let closed = false;
function track(promise) {
  inflight += 1;
  return promise.finally(() => {
    inflight -= 1;
    lastSettled = Date.now();
  });
}
function guard() {
  if (closed) {
    const err = new Error('Database is closed (the server is shutting down)');
    err.code = 'DB_CLOSED';
    throw err;
  }
}

/** Execute a statement. Resolves to { changes, lastID } (plus `rows` on Postgres). */
export const runQuery = async (text, params = []) => { guard(); return track(driver.run(text, params)); };

/** First row, or undefined. */
export const getQuery = async (text, params = []) => { guard(); return track(driver.get(text, params)); };

/** All rows (never null). */
export const allQuery = async (text, params = []) => { guard(); return track(driver.all(text, params)); };

/** Several statements, no parameters (schema scripts). */
export const execScript = async (text) => { guard(); return track(driver.exec(text)); };

/**
 * Run `fn` inside a transaction, rolling back on any throw.
 *
 * Every query on fn's async call stack joins the transaction — including ones
 * made deep inside helpers — and no query from any other request does. A
 * nested transaction() is a SAVEPOINT: if it throws, only its own writes are
 * undone and the error propagates to the enclosing fn.
 *
 * SQLite runs transactions one at a time (and queues writes made outside one
 * behind it). Postgres runs them concurrently at SERIALIZABLE isolation and
 * re-runs fn after a serialization failure or deadlock, so fn may execute
 * more than once: keep socket emits and other side effects outside it.
 *
 * `opts` (Postgres only): { isolation: 'read committed' | 'repeatable read' |
 * 'serializable', retries }.
 */
export const transaction = async (fn, opts) => { guard(); return track(driver.transaction(fn, opts)); };

/** True when the caller is inside a transaction(). */
export const inTransaction = () => driver.inTransaction();

// --- error classification ----------------------------------------------------

export {
  isUniqueViolation, isForeignKeyViolation, isConstraintViolation, classifyDatabaseError
} from './db/dialect.js';

// --- health ------------------------------------------------------------------

/** Driver details for logs and /api/health. Never includes credentials. */
export const dbInfo = () => driver.info();

/** Round-trip the database, bounded by `timeoutMs`. Never throws. */
export async function dbHealth({ timeoutMs = 3000 } = {}) {
  let timer;
  try {
    const result = await Promise.race([
      driver.ping(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no response within ${timeoutMs}ms`)), timeoutMs);
      })
    ]);
    return { ...dbInfo(), reachable: true, ...result };
  } catch (err) {
    return { ...dbInfo(), reachable: false, ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

// --- schema management -------------------------------------------------------

async function tableExists(name) {
  const row = isPostgres
    ? await getQuery(`SELECT to_regclass(?) IS NOT NULL AS present`, [name])
    : await getQuery(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?`, [name]);
  return Boolean(row?.present);
}

/**
 * The prototype schema had no schema_migrations table and a much thinner shape
 * (no roles, no files registry, reactions as a JSON blob). There is no sensible
 * column-by-column upgrade path and the only data in it is seed data, so back
 * the file up and rebuild. SQLite only: Postgres support postdates it.
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

/**
 * Seed accounts share a published password (db/seed.js SEED_PASSWORD) and own
 * the seeded servers, so seeding a production database would hand out an
 * owner login to anyone who has read this repository. Production therefore
 * never seeds unless SEED_DATABASE=1 is set explicitly.
 */
export function shouldSeed(env = process.env) {
  if (env.SEED_DATABASE !== undefined && env.SEED_DATABASE !== '') {
    return ['1', 'true', 'yes', 'on'].includes(String(env.SEED_DATABASE).toLowerCase());
  }
  return env.NODE_ENV !== 'production';
}

const logMigration = (migration) => {
  if (!quiet) console.log(`📐 Applied migration v${migration.version} — ${migration.name}`);
};

async function initSqlite({ seed }) {
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
    logMigration(migration);
  }

  if (seed) await seedDatabase({ runQuery, getQuery, transaction });

  await runQuery('PRAGMA optimize');
}

/**
 * Postgres: create the baseline on an empty database, then apply versioned
 * migrations — each in its own transaction together with the row recording
 * it — all while holding a session advisory lock, so several instances
 * starting at once apply every migration exactly once.
 */
async function initPostgres({ seed }) {
  await driver.withAdvisoryLock(MIGRATION_LOCK_KEY, async () => {
    if (!(await tableExists('schema_migrations'))) {
      if (await tableExists('users')) {
        throw new Error(
          'The Postgres database has application tables but no schema_migrations table. ' +
          'Refusing to guess its schema version; point DATABASE_URL at an empty database.'
        );
      }
      await transaction(async () => {
        await execScript(fs.readFileSync(PG_SCHEMA_PATH, 'utf8'));
        for (const migration of MIGRATIONS) {
          if (migration.version > PG_BASELINE_VERSION) break;
          await runQuery(
            `INSERT INTO schema_migrations (version, name) VALUES (?, ?)`,
            [migration.version, migration.name]
          );
        }
      });
      if (!quiet) console.log(`📐 Created PostgreSQL schema (baseline v${PG_BASELINE_VERSION})`);
    }

    const appliedRows = await allQuery(`SELECT version FROM schema_migrations`);
    const applied = new Set(appliedRows.map((r) => r.version));
    const newest = Math.max(0, ...applied);
    if (newest > SCHEMA_VERSION) {
      throw new Error(
        `Database schema is v${newest} but this build only knows v${SCHEMA_VERSION}. ` +
        'Deploy the newer build (or restore a matching backup) instead of downgrading.'
      );
    }

    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version) || migration.version <= PG_BASELINE_VERSION) continue;
      await transaction(async () => {
        await migration.postgres();
        await runQuery(
          `INSERT INTO schema_migrations (version, name) VALUES (?, ?)`,
          [migration.version, migration.name]
        );
      }, { isolation: 'read committed', retries: 0 });
      logMigration(migration);
    }

    if (seed) await seedDatabase({ runQuery, getQuery, transaction });
  });
}

export async function initDB({ seed = shouldSeed() } = {}) {
  if (isPostgres) await initPostgres({ seed });
  else await initSqlite({ seed });
  return driver.handle;
}

/**
 * Drain and close: waits (up to `drainMs`) until nothing has touched the
 * database for `quietMs` — so a chain of queries is not cut between two
 * statements — then flushes the SQLite WAL or ends the Postgres pool. Later
 * calls fail fast with code DB_CLOSED.
 */
let closing = null;
export function closeDB({ drainMs = 5000, quietMs = 150 } = {}) {
  closing ??= (async () => {
    const deadline = Date.now() + drainMs;
    while (Date.now() < deadline && (inflight > 0 || Date.now() - lastSettled < quietMs)) {
      await new Promise((r) => setTimeout(r, 25));
    }
    closed = true;
    await driver.close();
  })();
  return closing;
}

export default driver.handle;
