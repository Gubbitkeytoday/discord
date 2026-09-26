// ============================================================================
//  realtime-scale (schema v34)
//
//  1. Partial indexes for GET /api/sync, which counts edits and deletions
//     per channel since a cursor.
//  2. guild_perm_versions + triggers: a per-guild counter bumped by the
//     database itself whenever an input of permission resolution changes
//     (roles, member roles, membership / timeout / pending, channel
//     overwrites, the channel set or hierarchy, the owner, deletion).
//     services/permCache.js compares it on every check, so cached permissions
//     are exact across instances and code paths without invalidation hooks.
//
//  channels UPDATE is limited to the columns that matter: a message bumps
//  channels.last_message_id / updated_at, which must not flush the cache.
// ============================================================================

const INDEXES = [
  `CREATE INDEX IF NOT EXISTS idx_messages_edited ON messages(channel_id, edited_at) WHERE edited_at IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_messages_deleted ON messages(channel_id, deleted_at) WHERE deleted_at IS NOT NULL`
];

const TABLE = `CREATE TABLE IF NOT EXISTS guild_perm_versions (
  server_id TEXT PRIMARY KEY,
  version   INTEGER NOT NULL DEFAULT 0
)`;

// [trigger name, timing clause, table, expression yielding the guild id]
const SQLITE_TRIGGERS = [
  ['trg_pv_roles_ins', 'AFTER INSERT ON roles', 'NEW.server_id'],
  ['trg_pv_roles_upd', 'AFTER UPDATE ON roles', 'NEW.server_id'],
  ['trg_pv_roles_del', 'AFTER DELETE ON roles', 'OLD.server_id'],
  ['trg_pv_mroles_ins', 'AFTER INSERT ON member_roles', 'NEW.server_id'],
  ['trg_pv_mroles_upd', 'AFTER UPDATE ON member_roles', 'NEW.server_id'],
  ['trg_pv_mroles_del', 'AFTER DELETE ON member_roles', 'OLD.server_id'],
  ['trg_pv_members_ins', 'AFTER INSERT ON server_members', 'NEW.server_id'],
  ['trg_pv_members_upd', 'AFTER UPDATE OF left_at, timeout_until, pending, server_id, user_id ON server_members', 'NEW.server_id'],
  ['trg_pv_members_del', 'AFTER DELETE ON server_members', 'OLD.server_id'],
  ['trg_pv_ow_ins', 'AFTER INSERT ON channel_overwrites', '(SELECT server_id FROM channels WHERE id = NEW.channel_id)'],
  ['trg_pv_ow_upd', 'AFTER UPDATE ON channel_overwrites', '(SELECT server_id FROM channels WHERE id = NEW.channel_id)'],
  ['trg_pv_ow_del', 'AFTER DELETE ON channel_overwrites', '(SELECT server_id FROM channels WHERE id = OLD.channel_id)'],
  ['trg_pv_channels_ins', 'AFTER INSERT ON channels', 'NEW.server_id'],
  ['trg_pv_channels_upd', 'AFTER UPDATE OF type, parent_id, deleted_at, server_id ON channels', 'NEW.server_id'],
  ['trg_pv_channels_del', 'AFTER DELETE ON channels', 'OLD.server_id'],
  ['trg_pv_servers_upd', 'AFTER UPDATE OF owner_id, deleted_at ON servers', 'NEW.id'],
  ['trg_pv_servers_del', 'AFTER DELETE ON servers', 'OLD.id']
];

const sqliteTrigger = ([name, timing, expr]) => `CREATE TRIGGER IF NOT EXISTS ${name} ${timing}
  WHEN ${expr} IS NOT NULL
BEGIN
  INSERT INTO guild_perm_versions (server_id, version) VALUES (${expr}, 1)
  ON CONFLICT(server_id) DO UPDATE SET version = version + 1;
END`;

const PG_FUNCTION = `CREATE OR REPLACE FUNCTION ag_guild_perm_bump() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE
  sid TEXT;
BEGIN
  IF TG_TABLE_NAME = 'servers' THEN
    IF TG_OP = 'DELETE' THEN sid := OLD.id; ELSE sid := NEW.id; END IF;
  ELSIF TG_TABLE_NAME = 'channel_overwrites' THEN
    IF TG_OP = 'DELETE' THEN
      SELECT server_id INTO sid FROM channels WHERE id = OLD.channel_id;
    ELSE
      SELECT server_id INTO sid FROM channels WHERE id = NEW.channel_id;
    END IF;
  ELSE
    IF TG_OP = 'DELETE' THEN sid := OLD.server_id; ELSE sid := NEW.server_id; END IF;
  END IF;
  IF sid IS NOT NULL THEN
    INSERT INTO guild_perm_versions (server_id, version) VALUES (sid, 1)
    ON CONFLICT (server_id) DO UPDATE SET version = guild_perm_versions.version + 1;
  END IF;
  RETURN NULL;
END
$fn$`;

const PG_TRIGGERS = [
  ['trg_pv_roles', 'AFTER INSERT OR UPDATE OR DELETE ON roles'],
  ['trg_pv_member_roles', 'AFTER INSERT OR UPDATE OR DELETE ON member_roles'],
  ['trg_pv_server_members', 'AFTER INSERT OR DELETE OR UPDATE OF left_at, timeout_until, pending, server_id, user_id ON server_members'],
  ['trg_pv_channel_overwrites', 'AFTER INSERT OR UPDATE OR DELETE ON channel_overwrites'],
  ['trg_pv_channels', 'AFTER INSERT OR DELETE OR UPDATE OF type, parent_id, deleted_at, server_id ON channels'],
  ['trg_pv_servers', 'AFTER DELETE OR UPDATE OF owner_id, deleted_at ON servers']
];

export const REALTIME_SCALE_DDL = {
  sqlite: [...INDEXES, TABLE, ...SQLITE_TRIGGERS.map(sqliteTrigger)],
  postgres: [
    ...INDEXES,
    TABLE.replace('server_id TEXT PRIMARY KEY', 'server_id TEXT COLLATE "C" PRIMARY KEY'),
    PG_FUNCTION,
    ...PG_TRIGGERS.map(([name, timing]) =>
      `CREATE OR REPLACE TRIGGER ${name} ${timing} FOR EACH ROW EXECUTE FUNCTION ag_guild_perm_bump()`)
  ]
};
