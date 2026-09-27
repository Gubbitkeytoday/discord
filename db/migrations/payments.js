// ============================================================================
//  payments (schema v48) — donations and the cosmetic Supporter badge.
//  Applied by db.js. Nothing in the app is paywalled: a paid order only sets
//  users.supporter_since, which shows the Supporter badge.
//
//  payment_orders
//    amount_satang   integer satang (1 THB = 100 satang) — never a float
//    method          promptpay | stripe
//    status          pending | paid | rejected | expired | refunded
//    trans_ref       the bank slip's transaction reference, or the Stripe
//                    payment intent. UNIQUE (NULLs allowed): the same slip can
//                    never pay two orders, whoever submits it, however fast.
//    slip_file_id    storage reference (private file) of the uploaded slip
//    slip_sha256     hash of the slip image, so a re-used image is spotted
//                    even when no provider reads a reference from it
//    provider_ref    Stripe Checkout Session id
//    check_code      the last automated verdict (SLIP_UNDERPAID, …) shown to
//                    the payer and the admin while the order stays pending
//  payment_events    processed webhook event ids (Stripe), for idempotency.
//  users.supporter_since       first paid order; drives the badge.
//  users.supporter_badge_hidden the supporter chose not to show it.
//
//  Self-contained DDL; every statement is idempotent.
// ============================================================================

async function addColumnSqlite({ allQuery, runQuery }, table, column, ddl) {
  const cols = await allQuery(`PRAGMA table_info(${table})`);
  if (!cols.some((c) => c.name === column)) await runQuery(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

const NOW_SQLITE = "(strftime('%Y-%m-%dT%H:%M:%fZ','now'))";

export const PAYMENTS_MIGRATIONS = [
  {
    version: 48,
    name: 'payments: orders, webhook events, supporter badge',
    up: async (db) => {
      const { runQuery } = db;
      await runQuery(
        `CREATE TABLE IF NOT EXISTS payment_orders (
           id                TEXT PRIMARY KEY,
           user_id           TEXT REFERENCES users(id) ON DELETE SET NULL,
           amount_satang     INTEGER NOT NULL CHECK (amount_satang > 0),
           currency          TEXT NOT NULL DEFAULT 'THB',
           method            TEXT NOT NULL CHECK (method IN ('promptpay','stripe')),
           status            TEXT NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending','paid','rejected','expired','refunded')),
           provider          TEXT,
           provider_ref      TEXT,
           trans_ref         TEXT UNIQUE,
           slip_file_id      TEXT,
           slip_sha256       TEXT,
           slip_payload      TEXT,
           slip_submitted_at TEXT,
           slip_attempts     INTEGER NOT NULL DEFAULT 0,
           check_code        TEXT,
           paid_amount_satang INTEGER,
           reviewed_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
           note              TEXT,
           created_at        TEXT NOT NULL DEFAULT ${NOW_SQLITE},
           expires_at        TEXT NOT NULL,
           paid_at           TEXT,
           updated_at        TEXT NOT NULL DEFAULT ${NOW_SQLITE}
         )`
      );
      await runQuery(`CREATE INDEX IF NOT EXISTS idx_payment_orders_user ON payment_orders(user_id, created_at)`);
      await runQuery(`CREATE INDEX IF NOT EXISTS idx_payment_orders_status ON payment_orders(status, created_at)`);
      await runQuery(`CREATE INDEX IF NOT EXISTS idx_payment_orders_slip ON payment_orders(slip_sha256)`);
      await runQuery(`CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_orders_provider_ref ON payment_orders(provider_ref)`);
      await runQuery(
        `CREATE TABLE IF NOT EXISTS payment_events (
           id           TEXT PRIMARY KEY,
           provider     TEXT NOT NULL,
           type         TEXT NOT NULL,
           order_id     TEXT,
           received_at  TEXT NOT NULL DEFAULT ${NOW_SQLITE}
         )`
      );
      await addColumnSqlite(db, 'users', 'supporter_since', 'TEXT');
      await addColumnSqlite(db, 'users', 'supporter_badge_hidden', 'INTEGER NOT NULL DEFAULT 0');
    },
    postgres: async ({ runQuery }) => {
      await runQuery(
        `CREATE TABLE IF NOT EXISTS payment_orders (
           id                TEXT COLLATE "C" PRIMARY KEY,
           user_id           TEXT COLLATE "C" REFERENCES users(id) ON DELETE SET NULL DEFERRABLE,
           amount_satang     INTEGER NOT NULL CHECK (amount_satang > 0),
           currency          TEXT COLLATE "C" NOT NULL DEFAULT 'THB',
           method            TEXT COLLATE "C" NOT NULL CHECK (method IN ('promptpay','stripe')),
           status            TEXT COLLATE "C" NOT NULL DEFAULT 'pending'
                               CHECK (status IN ('pending','paid','rejected','expired','refunded')),
           provider          TEXT COLLATE "C",
           provider_ref      TEXT COLLATE "C",
           trans_ref         TEXT COLLATE "C" UNIQUE,
           slip_file_id      TEXT COLLATE "C",
           slip_sha256       TEXT COLLATE "C",
           slip_payload      TEXT,
           slip_submitted_at TIMESTAMPTZ(3),
           slip_attempts     INTEGER NOT NULL DEFAULT 0,
           check_code        TEXT COLLATE "C",
           paid_amount_satang INTEGER,
           reviewed_by       TEXT COLLATE "C" REFERENCES users(id) ON DELETE SET NULL DEFERRABLE,
           note              TEXT,
           created_at        TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
           expires_at        TIMESTAMPTZ(3) NOT NULL,
           paid_at           TIMESTAMPTZ(3),
           updated_at        TIMESTAMPTZ(3) NOT NULL DEFAULT now()
         )`
      );
      await runQuery(`CREATE INDEX IF NOT EXISTS idx_payment_orders_user ON payment_orders(user_id, created_at)`);
      await runQuery(`CREATE INDEX IF NOT EXISTS idx_payment_orders_status ON payment_orders(status, created_at)`);
      await runQuery(`CREATE INDEX IF NOT EXISTS idx_payment_orders_slip ON payment_orders(slip_sha256)`);
      await runQuery(`CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_orders_provider_ref ON payment_orders(provider_ref)`);
      await runQuery(
        `CREATE TABLE IF NOT EXISTS payment_events (
           id           TEXT COLLATE "C" PRIMARY KEY,
           provider     TEXT COLLATE "C" NOT NULL,
           type         TEXT COLLATE "C" NOT NULL,
           order_id     TEXT COLLATE "C",
           received_at  TIMESTAMPTZ(3) NOT NULL DEFAULT now()
         )`
      );
      await runQuery(`ALTER TABLE users ADD COLUMN IF NOT EXISTS supporter_since TIMESTAMPTZ(3)`);
      await runQuery(`ALTER TABLE users ADD COLUMN IF NOT EXISTS supporter_badge_hidden INTEGER NOT NULL DEFAULT 0`);
    }
  }
];
