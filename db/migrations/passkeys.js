// Schema v35 — passkeys (WebAuthn). Applied by db.js; kept here so the
// feature's DDL is one self-contained file on both engines.
//
//   webauthn_credentials  one row per registered passkey (many per account)
//   webauthn_challenges   single-use ceremony challenges and short "sudo"
//                         re-authentication grants, all with an expiry
//   passkey_events        account-level audit trail (register, sign-in, …)
//
// Binary values (credential id, COSE public key) are stored base64url as TEXT,
// which both engines and the SQLite→Postgres migration tool handle verbatim.

const sqlite = [
  `CREATE TABLE IF NOT EXISTS webauthn_credentials (
     id               TEXT PRIMARY KEY,
     user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     credential_id    TEXT NOT NULL UNIQUE,
     public_key       TEXT NOT NULL,
     counter          INTEGER NOT NULL DEFAULT 0,
     transports       TEXT NOT NULL DEFAULT '[]',
     device_type      TEXT NOT NULL DEFAULT 'singleDevice',
     backup_eligible  INTEGER NOT NULL DEFAULT 0,
     backed_up        INTEGER NOT NULL DEFAULT 0,
     aaguid           TEXT,
     name             TEXT NOT NULL,
     created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
     last_used_at     TEXT
   )`,
  `CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user ON webauthn_credentials(user_id)`,
  `CREATE TABLE IF NOT EXISTS webauthn_challenges (
     id          TEXT PRIMARY KEY,
     user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
     purpose     TEXT NOT NULL CHECK (purpose IN ('register','login','reauth','sudo')),
     challenge   TEXT NOT NULL,
     session_id  TEXT,
     created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
     expires_at  TEXT NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_user ON webauthn_challenges(user_id, purpose)`,
  `CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_expiry ON webauthn_challenges(expires_at)`,
  `CREATE TABLE IF NOT EXISTS passkey_events (
     id             TEXT PRIMARY KEY,
     user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     action         TEXT NOT NULL,
     credential_id  TEXT,
     ip_address     TEXT,
     user_agent     TEXT,
     created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
   )`,
  `CREATE INDEX IF NOT EXISTS idx_passkey_events_user ON passkey_events(user_id, created_at)`
];

const postgres = [
  `CREATE TABLE IF NOT EXISTS webauthn_credentials (
     id               TEXT COLLATE "C" PRIMARY KEY,
     user_id          TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE,
     credential_id    TEXT COLLATE "C" NOT NULL UNIQUE,
     public_key       TEXT COLLATE "C" NOT NULL,
     counter          BIGINT NOT NULL DEFAULT 0,
     transports       TEXT COLLATE "C" NOT NULL DEFAULT '[]',
     device_type      TEXT COLLATE "C" NOT NULL DEFAULT 'singleDevice',
     backup_eligible  INTEGER NOT NULL DEFAULT 0,
     backed_up        INTEGER NOT NULL DEFAULT 0,
     aaguid           TEXT COLLATE "C",
     name             TEXT COLLATE "C" NOT NULL,
     created_at       TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
     last_used_at     TIMESTAMPTZ(3)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user ON webauthn_credentials(user_id)`,
  `CREATE TABLE IF NOT EXISTS webauthn_challenges (
     id          TEXT COLLATE "C" PRIMARY KEY,
     user_id     TEXT COLLATE "C" REFERENCES users(id) ON DELETE CASCADE DEFERRABLE,
     purpose     TEXT COLLATE "C" NOT NULL CHECK (purpose IN ('register','login','reauth','sudo')),
     challenge   TEXT COLLATE "C" NOT NULL,
     session_id  TEXT COLLATE "C",
     created_at  TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
     expires_at  TIMESTAMPTZ(3) NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_user ON webauthn_challenges(user_id, purpose)`,
  `CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_expiry ON webauthn_challenges(expires_at)`,
  `CREATE TABLE IF NOT EXISTS passkey_events (
     id             TEXT COLLATE "C" PRIMARY KEY,
     user_id        TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE,
     action         TEXT COLLATE "C" NOT NULL,
     credential_id  TEXT COLLATE "C",
     ip_address     TEXT COLLATE "C",
     user_agent     TEXT COLLATE "C",
     created_at     TIMESTAMPTZ(3) NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS idx_passkey_events_user ON passkey_events(user_id, created_at)`
];

export const PASSKEY_DDL = Object.freeze({ sqlite, postgres });
