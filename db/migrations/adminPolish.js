// Schema v41–v42 — admin & moderation polish. Applied by db.js.
//
//   v41  recurring scheduled events: an event can repeat daily, weekly, every
//        two weeks or monthly, optionally until a date. Occurrences share a
//        series_id; the next one is created when the current one completes
//        (services/events.js settle()).
//   v42  servers.mod_alert_channel_id — where AutoMod alerts and join-spike
//        (raid) alerts are posted when a rule names no channel of its own —
//        plus an index for the audit log's action filter.

async function addColumnSqlite({ allQuery, runQuery }, table, column, ddl) {
  const cols = await allQuery(`PRAGMA table_info(${table})`);
  if (!cols.some((c) => c.name === column)) await runQuery(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

export const ADMIN_POLISH_MIGRATIONS = [
  {
    version: 41,
    name: 'recurring scheduled events',
    up: async (db) => {
      await addColumnSqlite(db, 'scheduled_events', 'recurrence', 'TEXT');
      await addColumnSqlite(db, 'scheduled_events', 'recurrence_until', 'TEXT');
      await addColumnSqlite(db, 'scheduled_events', 'series_id', 'TEXT');
      await db.runQuery(`CREATE INDEX IF NOT EXISTS idx_events_series ON scheduled_events(series_id, starts_at)`);
    },
    postgres: async ({ runQuery }) => {
      await runQuery(`ALTER TABLE scheduled_events ADD COLUMN IF NOT EXISTS recurrence TEXT COLLATE "C"`);
      await runQuery(`ALTER TABLE scheduled_events ADD COLUMN IF NOT EXISTS recurrence_until TIMESTAMPTZ(3)`);
      await runQuery(`ALTER TABLE scheduled_events ADD COLUMN IF NOT EXISTS series_id TEXT COLLATE "C"`);
      await runQuery(`CREATE INDEX IF NOT EXISTS idx_events_series ON scheduled_events(series_id, starts_at)`);
    }
  },
  {
    version: 42,
    name: 'moderator alert channel; audit log action index',
    up: async (db) => {
      await addColumnSqlite(db, 'servers', 'mod_alert_channel_id', 'TEXT');
      await db.runQuery(`CREATE INDEX IF NOT EXISTS idx_audit_server_action ON audit_logs(server_id, action_type, id)`);
    },
    postgres: async ({ runQuery }) => {
      await runQuery(`ALTER TABLE servers ADD COLUMN IF NOT EXISTS mod_alert_channel_id TEXT COLLATE "C"`);
      await runQuery(`CREATE INDEX IF NOT EXISTS idx_audit_server_action ON audit_logs(server_id, action_type, id)`);
    }
  }
];
