// Schema v46–v47 — free server customisation. Applied by db.js.
//
//   v46  role styles and icons, channel emoji, server media bookkeeping:
//          roles.style            'solid' | 'gradient' | 'holographic'
//          roles.gradient_angle   0–360 degrees (gradient direction)
//          roles.unicode_emoji    a unicode emoji shown instead of an image icon
//          roles.icon_file_id     storage reference for an uploaded role icon
//          channels.icon_emoji    an emoji shown in place of the # / speaker glyph
//          servers.splash_file_id storage reference for the invite splash
//          servers.icon_animated / banner_animated — the image has frames, so the
//                                 client shows a still until hover
//   v47  server profile and instance-local discovery:
//          servers.accent_color, servers.traits (≤5 {emoji,label}),
//          servers.discovery_category. Opting in is the existing DISCOVERABLE
//          entry in servers.features, which POST /api/servers/:id/join honours.

async function addColumnSqlite({ allQuery, runQuery }, table, column, ddl) {
  const cols = await allQuery(`PRAGMA table_info(${table})`);
  if (!cols.some((c) => c.name === column)) await runQuery(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

export const SERVERS_MIGRATIONS = [
  {
    version: 46,
    name: 'role styles, role icons, channel emoji, server media',
    up: async (db) => {
      await addColumnSqlite(db, 'roles', 'style', `TEXT NOT NULL DEFAULT 'solid'`);
      await addColumnSqlite(db, 'roles', 'gradient_angle', 'INTEGER NOT NULL DEFAULT 90');
      await addColumnSqlite(db, 'roles', 'unicode_emoji', 'TEXT');
      await addColumnSqlite(db, 'roles', 'icon_file_id', 'TEXT');
      await addColumnSqlite(db, 'channels', 'icon_emoji', 'TEXT');
      await addColumnSqlite(db, 'servers', 'splash_file_id', 'TEXT');
      await addColumnSqlite(db, 'servers', 'icon_animated', 'INTEGER NOT NULL DEFAULT 0');
      await addColumnSqlite(db, 'servers', 'banner_animated', 'INTEGER NOT NULL DEFAULT 0');
      // A role already carrying a second colour was a gradient all along.
      await db.runQuery(`UPDATE roles SET style = 'gradient' WHERE color_secondary IS NOT NULL AND style = 'solid'`);
    },
    postgres: async ({ runQuery }) => {
      await runQuery(`ALTER TABLE roles ADD COLUMN IF NOT EXISTS style TEXT COLLATE "C" NOT NULL DEFAULT 'solid'`);
      await runQuery(`ALTER TABLE roles DROP CONSTRAINT IF EXISTS roles_style_check`);
      await runQuery(`ALTER TABLE roles ADD CONSTRAINT roles_style_check CHECK (style IN ('solid','gradient','holographic'))`);
      await runQuery(`ALTER TABLE roles ADD COLUMN IF NOT EXISTS gradient_angle INTEGER NOT NULL DEFAULT 90`);
      await runQuery(`ALTER TABLE roles ADD COLUMN IF NOT EXISTS unicode_emoji TEXT COLLATE "C"`);
      await runQuery(`ALTER TABLE roles ADD COLUMN IF NOT EXISTS icon_file_id TEXT COLLATE "C"`);
      await runQuery(`ALTER TABLE channels ADD COLUMN IF NOT EXISTS icon_emoji TEXT COLLATE "C"`);
      await runQuery(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS splash_file_id TEXT COLLATE "C"`);
      await runQuery(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS icon_animated INTEGER NOT NULL DEFAULT 0`);
      await runQuery(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS banner_animated INTEGER NOT NULL DEFAULT 0`);
      await runQuery(`UPDATE roles SET style = 'gradient' WHERE color_secondary IS NOT NULL AND style = 'solid'`);
    }
  },
  {
    version: 47,
    name: 'server profile and discovery',
    up: async (db) => {
      await addColumnSqlite(db, 'servers', 'accent_color', 'TEXT');
      await addColumnSqlite(db, 'servers', 'traits', 'TEXT');
      await addColumnSqlite(db, 'servers', 'discovery_category', 'TEXT');
      await db.runQuery(`CREATE INDEX IF NOT EXISTS idx_servers_discovery ON servers(discovery_category, member_count) WHERE deleted_at IS NULL`);
    },
    postgres: async ({ runQuery }) => {
      await runQuery(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS accent_color TEXT COLLATE "C"`);
      await runQuery(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS traits JSONB`);
      await runQuery(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS discovery_category TEXT COLLATE "C"`);
      await runQuery(`CREATE INDEX IF NOT EXISTS idx_servers_discoverable ON servers USING GIN (features) WHERE deleted_at IS NULL`);
      await runQuery(`CREATE INDEX IF NOT EXISTS idx_servers_discovery ON servers(discovery_category, member_count) WHERE deleted_at IS NULL`);
    }
  }
];
