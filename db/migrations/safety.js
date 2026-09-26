// ============================================================================
//  safety (schema v39–v40)
//
//  v39  Age, instance administration, report routing, message requests.
//       users.birth_year / birth_month   date of birth, minimised: the day is
//                                        used once for the 13+ check at sign-up
//                                        and never stored (PDPA / GDPR art. 5).
//       users.instance_admin             runs this instance (reports queue,
//                                        registration mode, user list). The
//                                        earliest human account is promoted on
//                                        upgrade so an existing instance is
//                                        never left without one.
//       users.disabled_at / _reason      instance-wide ban.
//       reports.escalated                also visible to instance admins (DMs,
//                                        user reports, severe categories).
//       reports.context                  JSON snapshot taken at report time.
//       reports.target_user_id           who was reported (for "ban user").
//       dm_requests                      a recipient's decision about a DM from
//                                        a non-friend: accepted | ignored.
//  v40  instance_settings (registration mode override) and instance_audit_log.
//
//  Self-contained DDL (not in schema.sql / schema.pg.sql) so it merges cleanly;
//  every statement is idempotent.
// ============================================================================

const addSqliteColumn = async ({ allQuery, runQuery }, table, column, ddl) => {
  const cols = await allQuery(`PRAGMA table_info(${table})`);
  if (!cols.some((c) => c.name === column)) await runQuery(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
};

// The earliest real person (not a bot, not a system user, not deleted, able to
// sign in) becomes the instance admin — only when there is none yet.
const PROMOTE_FIRST = `
  UPDATE users SET instance_admin = 1
   WHERE id = (SELECT id FROM users
                WHERE deleted_at IS NULL AND is_bot = 0 AND is_system = 0
                  AND password_hash IS NOT NULL
                ORDER BY created_at ASC, id ASC LIMIT 1)
     AND NOT EXISTS (SELECT 1 FROM users WHERE instance_admin = 1)`;

export async function safetyV39Sqlite(db) {
  const { runQuery } = db;
  await addSqliteColumn(db, 'users', 'birth_year', 'INTEGER');
  await addSqliteColumn(db, 'users', 'birth_month', 'INTEGER');
  await addSqliteColumn(db, 'users', 'instance_admin', 'INTEGER NOT NULL DEFAULT 0');
  await addSqliteColumn(db, 'users', 'disabled_at', 'TEXT');
  await addSqliteColumn(db, 'users', 'disabled_reason', 'TEXT');
  await addSqliteColumn(db, 'reports', 'escalated', 'INTEGER NOT NULL DEFAULT 0');
  await addSqliteColumn(db, 'reports', 'context', 'TEXT');
  await addSqliteColumn(db, 'reports', 'target_user_id', 'TEXT');
  await addSqliteColumn(db, 'reports', 'channel_id', 'TEXT');
  await runQuery(`CREATE INDEX IF NOT EXISTS idx_reports_reporter ON reports(reporter_id, created_at)`);
  await runQuery(`CREATE INDEX IF NOT EXISTS idx_reports_instance ON reports(escalated, status, created_at)`);
  await runQuery(
    `CREATE TABLE IF NOT EXISTS dm_requests (
       user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
       state      TEXT NOT NULL CHECK (state IN ('accepted','ignored')),
       updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
       PRIMARY KEY (user_id, channel_id)
     )`
  );
  await runQuery(PROMOTE_FIRST);
}

export async function safetyV39Postgres({ runQuery }) {
  await runQuery(`ALTER TABLE users ADD COLUMN IF NOT EXISTS birth_year INTEGER`);
  await runQuery(`ALTER TABLE users ADD COLUMN IF NOT EXISTS birth_month INTEGER`);
  await runQuery(`ALTER TABLE users ADD COLUMN IF NOT EXISTS instance_admin INTEGER NOT NULL DEFAULT 0`);
  await runQuery(`ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ(3)`);
  await runQuery(`ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_reason TEXT`);
  await runQuery(`ALTER TABLE reports ADD COLUMN IF NOT EXISTS escalated INTEGER NOT NULL DEFAULT 0`);
  await runQuery(`ALTER TABLE reports ADD COLUMN IF NOT EXISTS context TEXT`);
  await runQuery(`ALTER TABLE reports ADD COLUMN IF NOT EXISTS target_user_id TEXT COLLATE "C"`);
  await runQuery(`ALTER TABLE reports ADD COLUMN IF NOT EXISTS channel_id TEXT COLLATE "C"`);
  await runQuery(`CREATE INDEX IF NOT EXISTS idx_reports_reporter ON reports(reporter_id, created_at)`);
  await runQuery(`CREATE INDEX IF NOT EXISTS idx_reports_instance ON reports(escalated, status, created_at)`);
  await runQuery(
    `CREATE TABLE IF NOT EXISTS dm_requests (
       user_id    TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE,
       channel_id TEXT COLLATE "C" NOT NULL REFERENCES channels(id) ON DELETE CASCADE DEFERRABLE,
       state      TEXT COLLATE "C" NOT NULL CHECK (state IN ('accepted','ignored')),
       updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
       PRIMARY KEY (user_id, channel_id)
     )`
  );
  await runQuery(PROMOTE_FIRST);
}

export async function safetyV40Sqlite({ runQuery }) {
  await runQuery(
    `CREATE TABLE IF NOT EXISTS instance_settings (
       key        TEXT PRIMARY KEY,
       value      TEXT,
       updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
       updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     )`
  );
  await runQuery(
    `CREATE TABLE IF NOT EXISTS instance_audit_log (
       id          TEXT PRIMARY KEY,
       actor_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
       action      TEXT NOT NULL,
       target_type TEXT,
       target_id   TEXT,
       details     TEXT,
       created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
     )`
  );
  await runQuery(`CREATE INDEX IF NOT EXISTS idx_instance_audit_created ON instance_audit_log(created_at)`);
}

export async function safetyV40Postgres({ runQuery }) {
  await runQuery(
    `CREATE TABLE IF NOT EXISTS instance_settings (
       key        TEXT COLLATE "C" PRIMARY KEY,
       value      TEXT,
       updated_by TEXT COLLATE "C" REFERENCES users(id) ON DELETE SET NULL DEFERRABLE,
       updated_at TIMESTAMPTZ(3) NOT NULL DEFAULT now()
     )`
  );
  await runQuery(
    `CREATE TABLE IF NOT EXISTS instance_audit_log (
       id          TEXT COLLATE "C" PRIMARY KEY,
       actor_id    TEXT COLLATE "C" REFERENCES users(id) ON DELETE SET NULL DEFERRABLE,
       action      TEXT COLLATE "C" NOT NULL,
       target_type TEXT COLLATE "C",
       target_id   TEXT COLLATE "C",
       details     TEXT,
       created_at  TIMESTAMPTZ(3) NOT NULL DEFAULT now()
     )`
  );
  await runQuery(`CREATE INDEX IF NOT EXISTS idx_instance_audit_created ON instance_audit_log(created_at)`);
}
