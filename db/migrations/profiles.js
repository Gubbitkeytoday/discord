// ============================================================================
//  profiles (schema v44–v45) — free profile customisation.
//
//  v44  Identity columns and the cosmetics catalogue.
//       users.custom_status_expires_at   "Clear after" for the custom status;
//                                        enforced at read time and by a sweeper.
//       users.theme_colors               JSON ["#primary", "#accent"] — the
//                                        two-colour profile gradient.
//       users.name_style                 JSON {font, effect, colors[]}.
//       users.avatar_decoration_id,
//       users.profile_effect_id,
//       users.nameplate_id,
//       users.profile_frame_id           equipped cosmetic_items (no FK: an
//                                        item removed with its pack is simply
//                                        ignored, then cleared by the service).
//       users.primary_server_tag_id      the one server whose tag is worn.
//       server_members.profile_overrides JSON per-server cosmetics.
//       server_members.tag_hidden        a moderator hid this member's worn
//                                        tag inside this server.
//       servers.cosmetics_hidden         the server hides members' cosmetics.
//       servers.new_member_badge_days    🌱 for this many days (0 = off).
//       cosmetic_packs / cosmetic_items / user_cosmetics.
//  v45  Badges and server tags.
//       badges (system / instance / server), user_badges, server_tags.
//
//  Self-contained DDL (not in schema.sql / schema.pg.sql) so it merges
//  cleanly; every statement is idempotent.
// ============================================================================

async function addColumnSqlite({ allQuery, runQuery }, table, column, ddl) {
  const cols = await allQuery(`PRAGMA table_info(${table})`);
  if (!cols.some((c) => c.name === column)) await runQuery(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

const NOW_SQLITE = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

export const PROFILES_MIGRATIONS = [
  {
    version: 44,
    name: 'profiles: status expiry, theme, name style, cosmetics catalogue',
    up: async (db) => {
      const { runQuery } = db;
      for (const [column, ddl] of [
        ['custom_status_expires_at', 'TEXT'],
        ['theme_colors', 'TEXT'],
        ['name_style', 'TEXT'],
        ['avatar_decoration_id', 'TEXT'],
        ['profile_effect_id', 'TEXT'],
        ['nameplate_id', 'TEXT'],
        ['profile_frame_id', 'TEXT'],
        ['primary_server_tag_id', 'TEXT']
      ]) await addColumnSqlite(db, 'users', column, ddl);
      await addColumnSqlite(db, 'server_members', 'profile_overrides', 'TEXT');
      await addColumnSqlite(db, 'server_members', 'tag_hidden', 'INTEGER NOT NULL DEFAULT 0');
      await addColumnSqlite(db, 'servers', 'cosmetics_hidden', 'INTEGER NOT NULL DEFAULT 0');
      await addColumnSqlite(db, 'servers', 'new_member_badge_days', 'INTEGER NOT NULL DEFAULT 7');
      await runQuery(`CREATE INDEX IF NOT EXISTS idx_users_status_expiry ON users(custom_status_expires_at)
                       WHERE custom_status_expires_at IS NOT NULL`);
      await runQuery(
        `CREATE TABLE IF NOT EXISTS cosmetic_packs (
           id          TEXT PRIMARY KEY,
           slug        TEXT NOT NULL UNIQUE,
           name        TEXT NOT NULL,
           author      TEXT,
           license     TEXT,
           version     TEXT,
           source      TEXT NOT NULL DEFAULT 'admin' CHECK (source IN ('builtin','admin')),
           enabled     INTEGER NOT NULL DEFAULT 1,
           created_by  TEXT,
           created_at  TEXT NOT NULL DEFAULT ${NOW_SQLITE}
         )`
      );
      await runQuery(
        `CREATE TABLE IF NOT EXISTS cosmetic_items (
           id           TEXT PRIMARY KEY,
           pack_id      TEXT NOT NULL REFERENCES cosmetic_packs(id) ON DELETE CASCADE,
           kind         TEXT NOT NULL CHECK (kind IN ('avatar_decoration','profile_effect','nameplate','profile_frame')),
           slug         TEXT NOT NULL,
           name         TEXT NOT NULL,
           name_th      TEXT,
           renderer     TEXT NOT NULL CHECK (renderer IN ('svg','image')),
           asset_url    TEXT,
           asset_type   TEXT,
           asset_data   TEXT,
           tags         TEXT,
           position     INTEGER NOT NULL DEFAULT 0,
           enabled      INTEGER NOT NULL DEFAULT 1,
           created_at   TEXT NOT NULL DEFAULT ${NOW_SQLITE},
           UNIQUE (pack_id, kind, slug)
         )`
      );
      await runQuery(`CREATE INDEX IF NOT EXISTS idx_cosmetic_items_kind ON cosmetic_items(kind, position)`);
      await runQuery(
        `CREATE TABLE IF NOT EXISTS user_cosmetics (
           user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           item_id     TEXT NOT NULL REFERENCES cosmetic_items(id) ON DELETE CASCADE,
           source      TEXT NOT NULL DEFAULT 'equipped',
           acquired_at TEXT NOT NULL DEFAULT ${NOW_SQLITE},
           PRIMARY KEY (user_id, item_id)
         )`
      );
    },
    postgres: async ({ runQuery }) => {
      for (const [column, ddl] of [
        ['custom_status_expires_at', 'TIMESTAMPTZ(3)'],
        ['theme_colors', 'TEXT COLLATE "C"'],
        ['name_style', 'TEXT COLLATE "C"'],
        ['avatar_decoration_id', 'TEXT COLLATE "C"'],
        ['profile_effect_id', 'TEXT COLLATE "C"'],
        ['nameplate_id', 'TEXT COLLATE "C"'],
        ['profile_frame_id', 'TEXT COLLATE "C"'],
        ['primary_server_tag_id', 'TEXT COLLATE "C"']
      ]) await runQuery(`ALTER TABLE users ADD COLUMN IF NOT EXISTS ${column} ${ddl}`);
      await runQuery(`ALTER TABLE server_members ADD COLUMN IF NOT EXISTS profile_overrides TEXT COLLATE "C"`);
      await runQuery(`ALTER TABLE server_members ADD COLUMN IF NOT EXISTS tag_hidden INTEGER NOT NULL DEFAULT 0`);
      await runQuery(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS cosmetics_hidden INTEGER NOT NULL DEFAULT 0`);
      await runQuery(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS new_member_badge_days INTEGER NOT NULL DEFAULT 7`);
      await runQuery(`CREATE INDEX IF NOT EXISTS idx_users_status_expiry ON users(custom_status_expires_at)
                       WHERE custom_status_expires_at IS NOT NULL`);
      await runQuery(
        `CREATE TABLE IF NOT EXISTS cosmetic_packs (
           id          TEXT COLLATE "C" PRIMARY KEY,
           slug        TEXT COLLATE "C" NOT NULL UNIQUE,
           name        TEXT NOT NULL,
           author      TEXT,
           license     TEXT,
           version     TEXT,
           source      TEXT COLLATE "C" NOT NULL DEFAULT 'admin' CHECK (source IN ('builtin','admin')),
           enabled     INTEGER NOT NULL DEFAULT 1,
           created_by  TEXT COLLATE "C",
           created_at  TIMESTAMPTZ(3) NOT NULL DEFAULT now()
         )`
      );
      await runQuery(
        `CREATE TABLE IF NOT EXISTS cosmetic_items (
           id           TEXT COLLATE "C" PRIMARY KEY,
           pack_id      TEXT COLLATE "C" NOT NULL REFERENCES cosmetic_packs(id) ON DELETE CASCADE DEFERRABLE,
           kind         TEXT COLLATE "C" NOT NULL
                          CHECK (kind IN ('avatar_decoration','profile_effect','nameplate','profile_frame')),
           slug         TEXT COLLATE "C" NOT NULL,
           name         TEXT NOT NULL,
           name_th      TEXT,
           renderer     TEXT COLLATE "C" NOT NULL CHECK (renderer IN ('svg','image')),
           asset_url    TEXT COLLATE "C",
           asset_type   TEXT COLLATE "C",
           asset_data   TEXT,
           tags         TEXT,
           position     INTEGER NOT NULL DEFAULT 0,
           enabled      INTEGER NOT NULL DEFAULT 1,
           created_at   TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
           UNIQUE (pack_id, kind, slug)
         )`
      );
      await runQuery(`CREATE INDEX IF NOT EXISTS idx_cosmetic_items_kind ON cosmetic_items(kind, position)`);
      await runQuery(
        `CREATE TABLE IF NOT EXISTS user_cosmetics (
           user_id     TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE,
           item_id     TEXT COLLATE "C" NOT NULL REFERENCES cosmetic_items(id) ON DELETE CASCADE DEFERRABLE,
           source      TEXT COLLATE "C" NOT NULL DEFAULT 'equipped',
           acquired_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
           PRIMARY KEY (user_id, item_id)
         )`
      );
    }
  },
  {
    version: 45,
    name: 'profiles: badges and server tags',
    up: async ({ runQuery }) => {
      await runQuery(
        `CREATE TABLE IF NOT EXISTS badges (
           id           TEXT PRIMARY KEY,
           kind         TEXT NOT NULL CHECK (kind IN ('instance','server')),
           server_id    TEXT REFERENCES servers(id) ON DELETE CASCADE,
           name         TEXT NOT NULL,
           description  TEXT,
           icon         TEXT NOT NULL DEFAULT 'star',
           color        TEXT,
           position     INTEGER NOT NULL DEFAULT 0,
           created_by   TEXT,
           created_at   TEXT NOT NULL DEFAULT ${NOW_SQLITE}
         )`
      );
      await runQuery(`CREATE INDEX IF NOT EXISTS idx_badges_server ON badges(server_id, position)`);
      await runQuery(
        `CREATE TABLE IF NOT EXISTS user_badges (
           user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
           badge_id    TEXT NOT NULL REFERENCES badges(id) ON DELETE CASCADE,
           granted_by  TEXT,
           note        TEXT,
           granted_at  TEXT NOT NULL DEFAULT ${NOW_SQLITE},
           PRIMARY KEY (user_id, badge_id)
         )`
      );
      await runQuery(`CREATE INDEX IF NOT EXISTS idx_user_badges_badge ON user_badges(badge_id)`);
      await runQuery(
        `CREATE TABLE IF NOT EXISTS server_tags (
           server_id   TEXT PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
           tag         TEXT NOT NULL,
           icon        TEXT NOT NULL DEFAULT 'leaf',
           color       TEXT,
           enabled     INTEGER NOT NULL DEFAULT 1,
           updated_by  TEXT,
           updated_at  TEXT NOT NULL DEFAULT ${NOW_SQLITE}
         )`
      );
    },
    postgres: async ({ runQuery }) => {
      await runQuery(
        `CREATE TABLE IF NOT EXISTS badges (
           id           TEXT COLLATE "C" PRIMARY KEY,
           kind         TEXT COLLATE "C" NOT NULL CHECK (kind IN ('instance','server')),
           server_id    TEXT COLLATE "C" REFERENCES servers(id) ON DELETE CASCADE DEFERRABLE,
           name         TEXT NOT NULL,
           description  TEXT,
           icon         TEXT COLLATE "C" NOT NULL DEFAULT 'star',
           color        TEXT COLLATE "C",
           position     INTEGER NOT NULL DEFAULT 0,
           created_by   TEXT COLLATE "C",
           created_at   TIMESTAMPTZ(3) NOT NULL DEFAULT now()
         )`
      );
      await runQuery(`CREATE INDEX IF NOT EXISTS idx_badges_server ON badges(server_id, position)`);
      await runQuery(
        `CREATE TABLE IF NOT EXISTS user_badges (
           user_id     TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE,
           badge_id    TEXT COLLATE "C" NOT NULL REFERENCES badges(id) ON DELETE CASCADE DEFERRABLE,
           granted_by  TEXT COLLATE "C",
           note        TEXT,
           granted_at  TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
           PRIMARY KEY (user_id, badge_id)
         )`
      );
      await runQuery(`CREATE INDEX IF NOT EXISTS idx_user_badges_badge ON user_badges(badge_id)`);
      await runQuery(
        `CREATE TABLE IF NOT EXISTS server_tags (
           server_id   TEXT COLLATE "C" PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE DEFERRABLE,
           tag         TEXT NOT NULL,
           icon        TEXT COLLATE "C" NOT NULL DEFAULT 'leaf',
           color       TEXT COLLATE "C",
           enabled     INTEGER NOT NULL DEFAULT 1,
           updated_by  TEXT COLLATE "C",
           updated_at  TIMESTAMPTZ(3) NOT NULL DEFAULT now()
         )`
      );
    }
  }
];
