// Schema v36 — message translation cache. Applied by db.js.
//
// One row per (message, content hash, target language). The content hash is
// part of the key, so an edited message can never be served its old
// translation; stale rows for a message are removed when it is next
// translated, and every row carries an expiry for the periodic prune.
// (servers.translation_disabled is added by the migration itself.)

const sqlite = [
  `CREATE TABLE IF NOT EXISTS translation_cache (
     message_id    TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
     content_hash  TEXT NOT NULL,
     target_lang   TEXT NOT NULL,
     source_lang   TEXT,
     provider      TEXT NOT NULL,
     translated    TEXT NOT NULL,
     created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
     expires_at    TEXT NOT NULL,
     PRIMARY KEY (message_id, content_hash, target_lang)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_translation_cache_expiry ON translation_cache(expires_at)`
];

const postgres = [
  `CREATE TABLE IF NOT EXISTS translation_cache (
     message_id    TEXT COLLATE "C" NOT NULL REFERENCES messages(id) ON DELETE CASCADE DEFERRABLE,
     content_hash  TEXT COLLATE "C" NOT NULL,
     target_lang   TEXT COLLATE "C" NOT NULL,
     source_lang   TEXT COLLATE "C",
     provider      TEXT COLLATE "C" NOT NULL,
     translated    TEXT COLLATE "C" NOT NULL,
     created_at    TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
     expires_at    TIMESTAMPTZ(3) NOT NULL,
     PRIMARY KEY (message_id, content_hash, target_lang)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_translation_cache_expiry ON translation_cache(expires_at)`
];

export const TRANSLATION_DDL = Object.freeze({ sqlite, postgres });
