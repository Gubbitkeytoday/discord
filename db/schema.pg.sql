-- ============================================================================
--  Antigravity Discord — full relational schema (PostgreSQL)
--
--  The Postgres twin of db/schema.sql. It is the baseline for a fresh database
--  and corresponds to schema version 17: db.js applies it once, inside one
--  transaction under an advisory lock, and records versions 1..17 as applied.
--  Later changes are versioned migrations in db.js (both engines), never
--  edits to an already-deployed baseline.
--
--  Conventions (and why they differ from the SQLite file)
--    * Ids are TEXT, not BIGINT. Seed and legacy ids are not numeric
--      ('user-me', 'chan-102'), and the API returns ids as strings because a
--      64-bit snowflake does not fit a JS number. Every snowflake is 19 digits,
--      so byte order is numeric order.
--    * Every text column is COLLATE "C": byte-wise comparison, exactly what
--      SQLite's default BINARY collation does. Ordering and uniqueness are
--      therefore identical on both engines, id range scans (`id < ?`) use the
--      primary-key index, and no id comparison can hit a collation mismatch.
--    * Timestamps are TIMESTAMPTZ(3): millisecond precision, the same
--      resolution SQLite stored as ISO text. The driver renders them back as
--      'YYYY-MM-DDTHH:MM:SS.sssZ', so API output is byte-identical.
--    * Flags stay INTEGER 0/1 (the application code and the API speak 0/1);
--      byte counters are BIGINT.
--    * JSON documents are JSONB (validated on write); the driver hands them
--      back as text, as SQLite did.
--    * Every foreign key is DEFERRABLE (initially immediate), so the SQLite →
--      Postgres copy tool can load rows in any order inside one transaction.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ---------------------------------------------------------------------------
-- 0. Migration bookkeeping
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT COLLATE "C" NOT NULL,
  applied_at  TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 1. Identity
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                  TEXT COLLATE "C" PRIMARY KEY,
  username            TEXT COLLATE "C" NOT NULL,
  discriminator       TEXT COLLATE "C" NOT NULL DEFAULT '0000',
  display_name        TEXT COLLATE "C" NOT NULL,
  email               TEXT COLLATE "C",
  password_hash       TEXT COLLATE "C",
  avatar_file_id      TEXT COLLATE "C",
  avatar_url          TEXT COLLATE "C",
  banner_file_id      TEXT COLLATE "C",
  banner_url          TEXT COLLATE "C",
  accent_color        TEXT COLLATE "C",
  bio                 TEXT COLLATE "C",
  pronouns            TEXT COLLATE "C",
  status              TEXT COLLATE "C" NOT NULL DEFAULT 'offline'
                      CHECK (status IN ('online','idle','dnd','offline','invisible')),
  custom_status       TEXT COLLATE "C",
  custom_status_emoji TEXT COLLATE "C",
  presence_updated_at TIMESTAMPTZ(3),
  locale              TEXT COLLATE "C" NOT NULL DEFAULT 'th-TH',
  theme               TEXT COLLATE "C" NOT NULL DEFAULT 'dark',
  flags               INTEGER NOT NULL DEFAULT 0,
  is_bot              INTEGER NOT NULL DEFAULT 0,
  is_system           INTEGER NOT NULL DEFAULT 0,
  email_verified      INTEGER NOT NULL DEFAULT 0,
  mfa_enabled         INTEGER NOT NULL DEFAULT 0,
  mfa_secret          TEXT COLLATE "C",
  storage_used        BIGINT NOT NULL DEFAULT 0,
  storage_quota       BIGINT NOT NULL DEFAULT 5368709120, -- 5 GiB
  last_seen_at        TIMESTAMPTZ(3),
  created_at          TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  deleted_at          TIMESTAMPTZ(3),
  UNIQUE (username, discriminator)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email    ON users(email)    WHERE email IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT COLLATE "C" PRIMARY KEY,
  user_id       TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE,
  token_hash    TEXT COLLATE "C" NOT NULL UNIQUE,
  device_name   TEXT COLLATE "C",
  platform      TEXT COLLATE "C",
  ip_address    TEXT COLLATE "C",
  user_agent    TEXT COLLATE "C",
  created_at    TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  last_seen_at  TIMESTAMPTZ(3),
  expires_at    TIMESTAMPTZ(3) NOT NULL,
  revoked_at    TIMESTAMPTZ(3)
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, revoked_at);

-- Single-use tokens: email verification, password reset, MFA recovery codes.
-- Only hashes are stored, so a database leak cannot be replayed.
CREATE TABLE IF NOT EXISTS account_tokens (
  id          TEXT COLLATE "C" PRIMARY KEY,
  user_id     TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE,
  kind        TEXT COLLATE "C" NOT NULL CHECK (kind IN ('email_verify','password_reset','recovery')),
  token_hash  TEXT COLLATE "C" NOT NULL,
  created_at  TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ(3),
  used_at     TIMESTAMPTZ(3)
);
CREATE INDEX IF NOT EXISTS idx_account_tokens_lookup ON account_tokens(kind, token_hash);
CREATE INDEX IF NOT EXISTS idx_account_tokens_user ON account_tokens(user_id, kind);

CREATE TABLE IF NOT EXISTS push_tokens (
  id          TEXT COLLATE "C" PRIMARY KEY,
  user_id     TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE,
  platform    TEXT COLLATE "C" NOT NULL CHECK (platform IN ('web','ios','android','desktop')),
  token       TEXT COLLATE "C" NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  revoked_at  TIMESTAMPTZ(3)
);

-- ---------------------------------------------------------------------------
-- 2. Storage registry — the single source of truth for every uploaded byte
-- ---------------------------------------------------------------------------
-- Content-addressable: `hash` is the sha256 of the bytes, so re-uploading the
-- same picture reuses one row and one file on disk (ref_count tracks users).
CREATE TABLE IF NOT EXISTS files (
  id                TEXT COLLATE "C" PRIMARY KEY,
  hash              TEXT COLLATE "C" NOT NULL,
  storage_key       TEXT COLLATE "C" NOT NULL UNIQUE,     -- path relative to the storage root
  backend           TEXT COLLATE "C" NOT NULL DEFAULT 'local' CHECK (backend IN ('local','s3','r2','gcs')),
  category          TEXT COLLATE "C" NOT NULL
                    CHECK (category IN ('avatars','banners','icons','attachments',
                                        'emojis','stickers','splashes','audio','video','misc')),
  original_name     TEXT COLLATE "C" NOT NULL,
  mime_type         TEXT COLLATE "C" NOT NULL,
  extension         TEXT COLLATE "C",
  size              BIGINT NOT NULL,
  -- media metadata (NULL for non-media)
  width             INTEGER,
  height            INTEGER,
  duration_secs     DOUBLE PRECISION,
  pages             INTEGER,
  blurhash          TEXT COLLATE "C",
  is_animated       INTEGER NOT NULL DEFAULT 0,
  -- lifecycle
  uploader_id       TEXT COLLATE "C" REFERENCES users(id) ON DELETE SET NULL DEFERRABLE,
  ref_count         INTEGER NOT NULL DEFAULT 0,
  visibility        TEXT COLLATE "C" NOT NULL DEFAULT 'public'
                    CHECK (visibility IN ('public','authenticated','private')),
  scan_status       TEXT COLLATE "C" NOT NULL DEFAULT 'pending'
                    CHECK (scan_status IN ('pending','clean','flagged','error','skipped')),
  scan_result       TEXT COLLATE "C",
  expires_at        TIMESTAMPTZ(3),                     -- for ephemeral uploads
  last_accessed_at  TIMESTAMPTZ(3),
  created_at        TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ(3)                      -- soft delete; GC removes bytes later
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_files_hash_category ON files(hash, category) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_files_uploader ON files(uploader_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_files_orphans  ON files(ref_count, created_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_files_expiring ON files(expires_at) WHERE expires_at IS NOT NULL;

-- Derived renditions: thumbnails, resized variants, video posters, previews.
CREATE TABLE IF NOT EXISTS file_variants (
  id           TEXT COLLATE "C" PRIMARY KEY,
  file_id      TEXT COLLATE "C" NOT NULL REFERENCES files(id) ON DELETE CASCADE DEFERRABLE,
  kind         TEXT COLLATE "C" NOT NULL
               CHECK (kind IN ('thumb','small','medium','large','poster','preview','webp','blur')),
  storage_key  TEXT COLLATE "C" NOT NULL UNIQUE,
  mime_type    TEXT COLLATE "C" NOT NULL,
  width        INTEGER,
  height       INTEGER,
  size         BIGINT NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  UNIQUE (file_id, kind)
);

-- Every read/serve of a private file, for auditing and quota analytics.
CREATE TABLE IF NOT EXISTS file_access_log (
  id          TEXT COLLATE "C" PRIMARY KEY,
  file_id     TEXT COLLATE "C" NOT NULL REFERENCES files(id) ON DELETE CASCADE DEFERRABLE,
  user_id     TEXT COLLATE "C" REFERENCES users(id) ON DELETE SET NULL DEFERRABLE,
  ip_address  TEXT COLLATE "C",
  variant     TEXT COLLATE "C",
  bytes_sent  BIGINT,
  created_at  TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_file_access_file ON file_access_log(file_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 3. Guilds (servers)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS servers (
  id                            TEXT COLLATE "C" PRIMARY KEY,
  name                          TEXT COLLATE "C" NOT NULL,
  description                   TEXT COLLATE "C",
  icon_file_id                  TEXT COLLATE "C" REFERENCES files(id) ON DELETE SET NULL DEFERRABLE,
  icon_url                      TEXT COLLATE "C",
  banner_file_id                TEXT COLLATE "C" REFERENCES files(id) ON DELETE SET NULL DEFERRABLE,
  banner_url                    TEXT COLLATE "C",
  splash_url                    TEXT COLLATE "C",
  owner_id                      TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE RESTRICT DEFERRABLE,
  vanity_url                    TEXT COLLATE "C" UNIQUE,
  verification_level            INTEGER NOT NULL DEFAULT 0,
  explicit_content_filter       INTEGER NOT NULL DEFAULT 0,
  default_notifications         TEXT COLLATE "C" NOT NULL DEFAULT 'all_messages'
                                CHECK (default_notifications IN ('all_messages','only_mentions')),
  system_channel_id             TEXT COLLATE "C",
  rules_channel_id              TEXT COLLATE "C",
  -- raid protection
  raid_protection               INTEGER NOT NULL DEFAULT 0,
  raid_join_threshold           INTEGER NOT NULL DEFAULT 10,
  raid_join_window_secs         INTEGER NOT NULL DEFAULT 60,
  raid_action                   TEXT COLLATE "C" NOT NULL DEFAULT 'lockdown'
                                CHECK (raid_action IN ('lockdown','screen')),
  -- public widget
  widget_enabled                INTEGER NOT NULL DEFAULT 0,
  widget_channel_id             TEXT COLLATE "C",
  -- membership screening / welcome screen / onboarding
  screening_enabled             INTEGER NOT NULL DEFAULT 0,
  screening_rules               JSONB,                 -- JSON array of strings (≤10)
  welcome_description           TEXT COLLATE "C",
  welcome_enabled               INTEGER NOT NULL DEFAULT 0,
  afk_channel_id                TEXT COLLATE "C",
  afk_timeout                   INTEGER NOT NULL DEFAULT 300,
  premium_tier                  INTEGER NOT NULL DEFAULT 0,
  member_count                  INTEGER NOT NULL DEFAULT 0,
  max_members                   INTEGER NOT NULL DEFAULT 250000,
  locale                        TEXT COLLATE "C" NOT NULL DEFAULT 'th-TH',
  features                      JSONB NOT NULL DEFAULT '[]'::jsonb,   -- JSON array
  created_at                    TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  updated_at                    TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  deleted_at                    TIMESTAMPTZ(3)
);
CREATE INDEX IF NOT EXISTS idx_servers_owner ON servers(owner_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS roles (
  id           TEXT COLLATE "C" PRIMARY KEY,
  server_id    TEXT COLLATE "C" NOT NULL REFERENCES servers(id) ON DELETE CASCADE DEFERRABLE,
  name         TEXT COLLATE "C" NOT NULL,
  color        TEXT COLLATE "C",
  color_secondary TEXT COLLATE "C",   -- when set, the role name renders as a gradient
  icon_url     TEXT COLLATE "C",
  position     INTEGER NOT NULL DEFAULT 0,
  permissions  TEXT COLLATE "C" NOT NULL DEFAULT '0',
  hoist        INTEGER NOT NULL DEFAULT 0,
  mentionable  INTEGER NOT NULL DEFAULT 0,
  managed      INTEGER NOT NULL DEFAULT 0,
  is_everyone  INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_roles_server ON roles(server_id, position DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_roles_everyone ON roles(server_id) WHERE is_everyone = 1;

CREATE TABLE IF NOT EXISTS server_members (
  server_id      TEXT COLLATE "C" NOT NULL REFERENCES servers(id) ON DELETE CASCADE DEFERRABLE,
  user_id        TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE,
  nickname       TEXT COLLATE "C",
  avatar_url     TEXT COLLATE "C",                  -- per-guild avatar override
  banner_url     TEXT COLLATE "C",                  -- per-guild banner
  bio            TEXT COLLATE "C",                  -- per-guild "about me"
  pronouns       TEXT COLLATE "C",
  joined_at      TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  premium_since  TIMESTAMPTZ(3),
  is_deaf        INTEGER NOT NULL DEFAULT 0,
  is_mute        INTEGER NOT NULL DEFAULT 0,
  timeout_until  TIMESTAMPTZ(3),                  -- MODERATE_MEMBERS timeout
  pending        INTEGER NOT NULL DEFAULT 0,
  left_at        TIMESTAMPTZ(3),
  PRIMARY KEY (server_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON server_members(user_id) WHERE left_at IS NULL;

CREATE TABLE IF NOT EXISTS member_roles (
  server_id    TEXT COLLATE "C" NOT NULL REFERENCES servers(id) ON DELETE CASCADE DEFERRABLE,
  user_id      TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE,
  role_id      TEXT COLLATE "C" NOT NULL REFERENCES roles(id) ON DELETE CASCADE DEFERRABLE,
  assigned_by  TEXT COLLATE "C" REFERENCES users(id) ON DELETE SET NULL DEFERRABLE,
  assigned_at  TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, user_id, role_id)
);
CREATE INDEX IF NOT EXISTS idx_member_roles_role ON member_roles(role_id);

CREATE TABLE IF NOT EXISTS bans (
  server_id      TEXT COLLATE "C" NOT NULL REFERENCES servers(id) ON DELETE CASCADE DEFERRABLE,
  user_id        TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE,
  moderator_id   TEXT COLLATE "C" REFERENCES users(id) ON DELETE SET NULL DEFERRABLE,
  reason         TEXT COLLATE "C",
  delete_message_seconds INTEGER NOT NULL DEFAULT 0,
  expires_at     TIMESTAMPTZ(3),
  created_at     TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (server_id, user_id)
);

CREATE TABLE IF NOT EXISTS invites (
  code         TEXT COLLATE "C" PRIMARY KEY,
  server_id    TEXT COLLATE "C" NOT NULL REFERENCES servers(id) ON DELETE CASCADE DEFERRABLE,
  channel_id   TEXT COLLATE "C",
  inviter_id   TEXT COLLATE "C" REFERENCES users(id) ON DELETE SET NULL DEFERRABLE,
  max_uses     INTEGER NOT NULL DEFAULT 0,   -- 0 = unlimited
  uses         INTEGER NOT NULL DEFAULT 0,
  max_age      INTEGER NOT NULL DEFAULT 86400,
  temporary    INTEGER NOT NULL DEFAULT 0,
  expires_at   TIMESTAMPTZ(3),
  created_at   TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  revoked_at   TIMESTAMPTZ(3)
);
CREATE INDEX IF NOT EXISTS idx_invites_server ON invites(server_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- 4. Channels — guild channels, categories, threads, DMs and group DMs all
--    live here, discriminated by `type`. server_id is NULL for DMs.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS channels (
  id                    TEXT COLLATE "C" PRIMARY KEY,
  server_id             TEXT COLLATE "C" REFERENCES servers(id) ON DELETE CASCADE DEFERRABLE,
  parent_id             TEXT COLLATE "C" REFERENCES channels(id) ON DELETE CASCADE DEFERRABLE, -- category or thread parent
  name                  TEXT COLLATE "C",
  type                  TEXT COLLATE "C" NOT NULL
                        CHECK (type IN ('text','voice','category','announcement','forum',
                                        'stage','thread','dm','group_dm')),
  topic                 TEXT COLLATE "C",
  icon_url              TEXT COLLATE "C",                 -- group DM icon
  owner_id              TEXT COLLATE "C" REFERENCES users(id) ON DELETE SET NULL DEFERRABLE,
  position              INTEGER NOT NULL DEFAULT 0,
  nsfw                  INTEGER NOT NULL DEFAULT 0,
  spoiler               INTEGER NOT NULL DEFAULT 0,  -- contents blurred until opened
  rate_limit_per_user   INTEGER NOT NULL DEFAULT 0,  -- slowmode seconds
  -- voice
  bitrate               INTEGER,
  user_limit            INTEGER,
  rtc_region            TEXT COLLATE "C",
  video_quality_mode    INTEGER,
  -- thread state
  archived              INTEGER NOT NULL DEFAULT 0,
  archive_timestamp     TIMESTAMPTZ(3),
  auto_archive_duration INTEGER NOT NULL DEFAULT 1440,
  locked                INTEGER NOT NULL DEFAULT 0,
  -- forum post state / forum defaults
  pinned                INTEGER NOT NULL DEFAULT 0,
  default_sort_order    TEXT COLLATE "C" NOT NULL DEFAULT 'latest_activity'
                        CHECK (default_sort_order IN ('latest_activity','creation_date')),
  default_reaction_emoji TEXT COLLATE "C",
  require_tag           INTEGER NOT NULL DEFAULT 0,
  default_layout        TEXT COLLATE "C" NOT NULL DEFAULT 'list' CHECK (default_layout IN ('list','gallery')),
  invitable             INTEGER NOT NULL DEFAULT 1,
  message_count         INTEGER NOT NULL DEFAULT 0,
  member_count          INTEGER NOT NULL DEFAULT 0,
  -- denormalised pointers, kept fresh on write
  last_message_id       TEXT COLLATE "C",
  last_pin_at           TIMESTAMPTZ(3),
  created_at            TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  deleted_at            TIMESTAMPTZ(3)
);
CREATE INDEX IF NOT EXISTS idx_channels_server ON channels(server_id, position, id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_channels_parent ON channels(parent_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_channels_type   ON channels(type);

-- DM / group-DM / thread membership.
CREATE TABLE IF NOT EXISTS channel_recipients (
  channel_id  TEXT COLLATE "C" NOT NULL REFERENCES channels(id) ON DELETE CASCADE DEFERRABLE,
  user_id     TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE,
  joined_at   TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  closed      INTEGER NOT NULL DEFAULT 0,   -- hidden from the user's DM list
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_recipients_user ON channel_recipients(user_id, closed);

CREATE TABLE IF NOT EXISTS channel_overwrites (
  channel_id   TEXT COLLATE "C" NOT NULL REFERENCES channels(id) ON DELETE CASCADE DEFERRABLE,
  target_type  TEXT COLLATE "C" NOT NULL CHECK (target_type IN ('role','member')),
  target_id    TEXT COLLATE "C" NOT NULL,
  allow        TEXT COLLATE "C" NOT NULL DEFAULT '0',
  deny         TEXT COLLATE "C" NOT NULL DEFAULT '0',
  PRIMARY KEY (channel_id, target_type, target_id)
);

-- ---------------------------------------------------------------------------
-- 5. Messages
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
  id                TEXT COLLATE "C" PRIMARY KEY,
  channel_id        TEXT COLLATE "C" NOT NULL REFERENCES channels(id) ON DELETE CASCADE DEFERRABLE,
  server_id         TEXT COLLATE "C" REFERENCES servers(id) ON DELETE CASCADE DEFERRABLE,
  user_id           TEXT COLLATE "C" REFERENCES users(id) ON DELETE SET NULL DEFERRABLE,
  webhook_id        TEXT COLLATE "C",
  content           TEXT COLLATE "C",
  type              TEXT COLLATE "C" NOT NULL DEFAULT 'default'
                    CHECK (type IN ('default','reply','join','pin','thread_created',
                                    'call','system','boost','channel_follow_add','poll')),
  reply_to_id       TEXT COLLATE "C" REFERENCES messages(id) ON DELETE SET NULL DEFERRABLE,
  thread_id         TEXT COLLATE "C" REFERENCES channels(id) ON DELETE SET NULL DEFERRABLE,
  mention_everyone  INTEGER NOT NULL DEFAULT 0,
  pinned            INTEGER NOT NULL DEFAULT 0,
  tts               INTEGER NOT NULL DEFAULT 0,
  flags             INTEGER NOT NULL DEFAULT 0,
  sticker_id        TEXT COLLATE "C",  -- one sticker per message
  nonce             TEXT COLLATE "C",                 -- client dedupe key for optimistic sends
  embeds            JSONB NOT NULL DEFAULT '[]'::jsonb,
  components        JSONB NOT NULL DEFAULT '[]'::jsonb,
  ephemeral_user_id TEXT COLLATE "C",                     -- visible only to this user
  application_id    TEXT COLLATE "C",                     -- the bot application that sent it
  edited_at         TIMESTAMPTZ(3),
  created_at        TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ(3)
);
-- Primary read path: newest-first pagination inside a channel.
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_messages_author  ON messages(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_messages_reply   ON messages(reply_to_id);
CREATE INDEX IF NOT EXISTS idx_messages_pinned  ON messages(channel_id) WHERE pinned = 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_nonce ON messages(channel_id, user_id, nonce) WHERE nonce IS NOT NULL;

-- Message search: a trigram GIN index on the content itself.
--
-- Trigrams, not a word tokenizer: Thai does not put spaces between words, so
-- a word-based index would store 'ทดสอบรูปภาพ' as one token and a search for
-- 'ทดสอบ' would find nothing. pg_trgm serves `content ILIKE '%term%'` for any
-- substring of three or more characters in any language; shorter terms fall
-- back to a scan of the channel-filtered rows. There is no shadow table to
-- keep in sync, which is what messages_fts is on SQLite.
CREATE INDEX IF NOT EXISTS idx_messages_content_trgm ON messages
  USING gin (content gin_trgm_ops) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS message_edits (
  id          TEXT COLLATE "C" PRIMARY KEY,
  message_id  TEXT COLLATE "C" NOT NULL REFERENCES messages(id) ON DELETE CASCADE DEFERRABLE,
  content     TEXT COLLATE "C",
  edited_at   TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_message_edits ON message_edits(message_id, edited_at DESC);

-- Attachments join a message to a file, carrying per-message presentation.
CREATE TABLE IF NOT EXISTS attachments (
  id            TEXT COLLATE "C" PRIMARY KEY,
  message_id    TEXT COLLATE "C" NOT NULL REFERENCES messages(id) ON DELETE CASCADE DEFERRABLE,
  file_id       TEXT COLLATE "C" NOT NULL REFERENCES files(id) ON DELETE RESTRICT DEFERRABLE,
  filename      TEXT COLLATE "C" NOT NULL,
  description   TEXT COLLATE "C",                    -- alt text
  content_type  TEXT COLLATE "C",
  size          BIGINT NOT NULL DEFAULT 0,
  width         INTEGER,
  height        INTEGER,
  duration_secs DOUBLE PRECISION,
  waveform      TEXT COLLATE "C",                    -- voice-message waveform
  is_spoiler    INTEGER NOT NULL DEFAULT 0,
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id, position);
CREATE INDEX IF NOT EXISTS idx_attachments_file    ON attachments(file_id);

-- One row per (message, user, emoji) — the correct model for reaction lists.
CREATE TABLE IF NOT EXISTS reactions (
  message_id  TEXT COLLATE "C" NOT NULL REFERENCES messages(id) ON DELETE CASCADE DEFERRABLE,
  user_id     TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE,
  emoji       TEXT COLLATE "C" NOT NULL,            -- unicode char, or ':name:' for custom
  emoji_id    TEXT COLLATE "C",
  created_at  TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id, emoji);

CREATE TABLE IF NOT EXISTS mentions (
  message_id   TEXT COLLATE "C" NOT NULL REFERENCES messages(id) ON DELETE CASCADE DEFERRABLE,
  target_type  TEXT COLLATE "C" NOT NULL CHECK (target_type IN ('user','role','channel')),
  target_id    TEXT COLLATE "C" NOT NULL,
  PRIMARY KEY (message_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_mentions_target ON mentions(target_type, target_id);

CREATE TABLE IF NOT EXISTS pins (
  channel_id  TEXT COLLATE "C" NOT NULL REFERENCES channels(id) ON DELETE CASCADE DEFERRABLE,
  message_id  TEXT COLLATE "C" NOT NULL REFERENCES messages(id) ON DELETE CASCADE DEFERRABLE,
  pinned_by   TEXT COLLATE "C" REFERENCES users(id) ON DELETE SET NULL DEFERRABLE,
  pinned_at   TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, message_id)
);

-- Cached OpenGraph/oEmbed data so link previews are not re-fetched per render.
CREATE TABLE IF NOT EXISTS link_embeds (
  url_hash    TEXT COLLATE "C" PRIMARY KEY,
  url         TEXT COLLATE "C" NOT NULL,
  data        JSONB NOT NULL,            -- JSON embed object
  fetched_at  TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ(3)
);

-- ---------------------------------------------------------------------------
-- 6. Expression: custom emojis, stickers, soundboard
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS emojis (
  id          TEXT COLLATE "C" PRIMARY KEY,
  server_id   TEXT COLLATE "C" REFERENCES servers(id) ON DELETE CASCADE DEFERRABLE,
  name        TEXT COLLATE "C" NOT NULL,
  file_id     TEXT COLLATE "C" REFERENCES files(id) ON DELETE SET NULL DEFERRABLE,
  url         TEXT COLLATE "C" NOT NULL,
  animated    INTEGER NOT NULL DEFAULT 0,
  managed     INTEGER NOT NULL DEFAULT 0,
  available   INTEGER NOT NULL DEFAULT 1,
  creator_id  TEXT COLLATE "C" REFERENCES users(id) ON DELETE SET NULL DEFERRABLE,
  created_at  TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  UNIQUE (server_id, name)
);

CREATE TABLE IF NOT EXISTS stickers (
  id           TEXT COLLATE "C" PRIMARY KEY,
  server_id    TEXT COLLATE "C" REFERENCES servers(id) ON DELETE CASCADE DEFERRABLE,
  name         TEXT COLLATE "C" NOT NULL,
  description  TEXT COLLATE "C",
  tags         TEXT COLLATE "C",
  file_id      TEXT COLLATE "C" REFERENCES files(id) ON DELETE SET NULL DEFERRABLE,
  url          TEXT COLLATE "C" NOT NULL,
  format       TEXT COLLATE "C" NOT NULL DEFAULT 'png' CHECK (format IN ('png','apng','lottie','gif')),
  available    INTEGER NOT NULL DEFAULT 1,
  creator_id   TEXT COLLATE "C" REFERENCES users(id) ON DELETE SET NULL DEFERRABLE,
  created_at   TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS soundboard_sounds (
  id          TEXT COLLATE "C" PRIMARY KEY,
  server_id   TEXT COLLATE "C" REFERENCES servers(id) ON DELETE CASCADE DEFERRABLE,
  name        TEXT COLLATE "C" NOT NULL,
  file_id     TEXT COLLATE "C" REFERENCES files(id) ON DELETE SET NULL DEFERRABLE,
  url         TEXT COLLATE "C" NOT NULL,
  volume      DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  emoji       TEXT COLLATE "C",
  creator_id  TEXT COLLATE "C" REFERENCES users(id) ON DELETE SET NULL DEFERRABLE,
  created_at  TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- 7. Social graph
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS friends (
  id            TEXT COLLATE "C" PRIMARY KEY,
  user_id       TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE,
  friend_id     TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE,
  status        TEXT COLLATE "C" NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','accepted','blocked','declined')),
  requested_by  TEXT COLLATE "C" REFERENCES users(id) ON DELETE SET NULL DEFERRABLE,
  nickname      TEXT COLLATE "C",
  created_at    TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  accepted_at   TIMESTAMPTZ(3),
  UNIQUE (user_id, friend_id)
);
CREATE INDEX IF NOT EXISTS idx_friends_lookup ON friends(friend_id, status);

CREATE TABLE IF NOT EXISTS blocks (
  user_id     TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE,
  blocked_id  TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE,
  created_at  TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, blocked_id)
);

-- ---------------------------------------------------------------------------
-- 8. Read state, notification preferences, notifications
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS read_states (
  user_id                TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE,
  channel_id             TEXT COLLATE "C" NOT NULL REFERENCES channels(id) ON DELETE CASCADE DEFERRABLE,
  last_read_message_id   TEXT COLLATE "C",
  mention_count          INTEGER NOT NULL DEFAULT 0,
  last_viewed_at         TIMESTAMPTZ(3),
  PRIMARY KEY (user_id, channel_id)
);
CREATE INDEX IF NOT EXISTS idx_read_states_user ON read_states(user_id);

CREATE TABLE IF NOT EXISTS channel_settings (
  user_id             TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE,
  channel_id          TEXT COLLATE "C" NOT NULL REFERENCES channels(id) ON DELETE CASCADE DEFERRABLE,
  muted               INTEGER NOT NULL DEFAULT 0,
  muted_until         TIMESTAMPTZ(3),
  notification_level  TEXT COLLATE "C" NOT NULL DEFAULT 'inherit'
                      CHECK (notification_level IN ('inherit','all_messages','only_mentions','nothing')),
  collapsed           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, channel_id)
);

-- Account-wide client preferences, one row per category so a partial save
-- never has to read-modify-write the whole blob.
CREATE TABLE IF NOT EXISTS user_settings (
  user_id     TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE,
  category    TEXT COLLATE "C" NOT NULL,          -- appearance, accessibility, notifications, ...
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,   -- JSON object of that category's keys
  updated_at  TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, category)
);

CREATE TABLE IF NOT EXISTS server_settings (
  user_id             TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE,
  server_id           TEXT COLLATE "C" NOT NULL REFERENCES servers(id) ON DELETE CASCADE DEFERRABLE,
  muted               INTEGER NOT NULL DEFAULT 0,
  muted_until         TIMESTAMPTZ(3),
  notification_level  TEXT COLLATE "C" NOT NULL DEFAULT 'all_messages'
                      CHECK (notification_level IN ('all_messages','only_mentions','nothing')),
  suppress_everyone   INTEGER NOT NULL DEFAULT 0,
  suppress_roles      INTEGER NOT NULL DEFAULT 0,
  position            INTEGER NOT NULL DEFAULT 0,
  hidden              INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, server_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT COLLATE "C" PRIMARY KEY,
  user_id     TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE,
  type        TEXT COLLATE "C" NOT NULL,             -- mention, dm, friend_request, reply, reaction...
  server_id   TEXT COLLATE "C" REFERENCES servers(id) ON DELETE CASCADE DEFERRABLE,
  channel_id  TEXT COLLATE "C" REFERENCES channels(id) ON DELETE CASCADE DEFERRABLE,
  message_id  TEXT COLLATE "C" REFERENCES messages(id) ON DELETE CASCADE DEFERRABLE,
  actor_id    TEXT COLLATE "C" REFERENCES users(id) ON DELETE SET NULL DEFERRABLE,
  body        TEXT COLLATE "C",
  read_at     TIMESTAMPTZ(3),
  created_at  TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at, id DESC);

-- ---------------------------------------------------------------------------
-- 9. Voice / stage
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS voice_states (
  user_id      TEXT COLLATE "C" PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE DEFERRABLE,
  channel_id   TEXT COLLATE "C" REFERENCES channels(id) ON DELETE CASCADE DEFERRABLE,
  server_id    TEXT COLLATE "C" REFERENCES servers(id) ON DELETE CASCADE DEFERRABLE,
  session_id   TEXT COLLATE "C" NOT NULL,
  socket_id    TEXT COLLATE "C",
  self_mute    INTEGER NOT NULL DEFAULT 0,
  self_deaf    INTEGER NOT NULL DEFAULT 0,
  self_video   INTEGER NOT NULL DEFAULT 0,
  self_stream  INTEGER NOT NULL DEFAULT 0,
  server_mute  INTEGER NOT NULL DEFAULT 0,
  server_deaf  INTEGER NOT NULL DEFAULT 0,
  suppress     INTEGER NOT NULL DEFAULT 0,
  request_to_speak_at TIMESTAMPTZ(3),
  joined_at    TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_voice_channel ON voice_states(channel_id);

-- ---------------------------------------------------------------------------
-- 10. Automation & moderation
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhooks (
  id          TEXT COLLATE "C" PRIMARY KEY,
  channel_id  TEXT COLLATE "C" NOT NULL REFERENCES channels(id) ON DELETE CASCADE DEFERRABLE,
  server_id   TEXT COLLATE "C" REFERENCES servers(id) ON DELETE CASCADE DEFERRABLE,
  name        TEXT COLLATE "C" NOT NULL,
  avatar_url  TEXT COLLATE "C",
  token_hash  TEXT COLLATE "C" NOT NULL UNIQUE,
  type        TEXT COLLATE "C" NOT NULL DEFAULT 'incoming' CHECK (type IN ('incoming','follower','application')),
  creator_id  TEXT COLLATE "C" REFERENCES users(id) ON DELETE SET NULL DEFERRABLE,
  created_at  TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  revoked_at  TIMESTAMPTZ(3)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id           TEXT COLLATE "C" PRIMARY KEY,
  server_id    TEXT COLLATE "C" NOT NULL REFERENCES servers(id) ON DELETE CASCADE DEFERRABLE,
  user_id      TEXT COLLATE "C" REFERENCES users(id) ON DELETE SET NULL DEFERRABLE,
  action_type  TEXT COLLATE "C" NOT NULL,
  target_type  TEXT COLLATE "C",
  target_id    TEXT COLLATE "C",
  changes      JSONB NOT NULL DEFAULT '[]'::jsonb,   -- JSON [{key, old, new}]
  reason       TEXT COLLATE "C",
  created_at   TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_server ON audit_logs(server_id, id DESC);

CREATE TABLE IF NOT EXISTS automod_rules (
  id           TEXT COLLATE "C" PRIMARY KEY,
  server_id    TEXT COLLATE "C" NOT NULL REFERENCES servers(id) ON DELETE CASCADE DEFERRABLE,
  name         TEXT COLLATE "C" NOT NULL,
  event_type   TEXT COLLATE "C" NOT NULL DEFAULT 'message_send',
  trigger_type TEXT COLLATE "C" NOT NULL CHECK (trigger_type IN ('keyword','spam','mention_spam','link','regex')),
  trigger_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  actions      JSONB NOT NULL DEFAULT '[]'::jsonb,
  enabled      INTEGER NOT NULL DEFAULT 1,
  exempt_roles JSONB NOT NULL DEFAULT '[]'::jsonb,
  exempt_channels JSONB NOT NULL DEFAULT '[]'::jsonb,
  creator_id   TEXT COLLATE "C" REFERENCES users(id) ON DELETE SET NULL DEFERRABLE,
  created_at   TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reports (
  id           TEXT COLLATE "C" PRIMARY KEY,
  reporter_id  TEXT COLLATE "C" REFERENCES users(id) ON DELETE SET NULL DEFERRABLE,
  server_id    TEXT COLLATE "C" REFERENCES servers(id) ON DELETE CASCADE DEFERRABLE,  -- guild the report belongs to, when any
  target_type  TEXT COLLATE "C" NOT NULL CHECK (target_type IN ('message','user','server','channel','file')),
  target_id    TEXT COLLATE "C" NOT NULL,
  reason       TEXT COLLATE "C" NOT NULL,
  details      TEXT COLLATE "C",
  status       TEXT COLLATE "C" NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewing','resolved','dismissed')),
  resolved_by  TEXT COLLATE "C" REFERENCES users(id) ON DELETE SET NULL DEFERRABLE,
  resolved_at  TIMESTAMPTZ(3),
  created_at   TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

-- ============================================================================
--  Polls
--
--  A poll belongs to exactly one message, which is why message_id is the
--  primary key rather than a separate id: there is no such thing as a poll
--  without the message that carries it, and making that a 1:1 by construction
--  removes a whole class of orphan.
--
--  Answers are a child table rather than a JSON blob because votes reference
--  them, and a foreign key is the only thing that actually stops a vote for an
--  answer that no longer exists.
-- ============================================================================

CREATE TABLE IF NOT EXISTS polls (
  message_id     TEXT COLLATE "C" PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE DEFERRABLE,
  channel_id     TEXT COLLATE "C" NOT NULL REFERENCES channels(id) ON DELETE CASCADE DEFERRABLE,
  question       TEXT COLLATE "C" NOT NULL,
  allow_multiple INTEGER NOT NULL DEFAULT 0,
  expires_at     TIMESTAMPTZ(3),                    -- NULL = never closes on its own
  closed_at      TIMESTAMPTZ(3),                    -- set when finalised, by time or by hand
  created_at     TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS poll_answers (
  id          TEXT COLLATE "C" PRIMARY KEY,
  message_id  TEXT COLLATE "C" NOT NULL REFERENCES polls(message_id) ON DELETE CASCADE DEFERRABLE,
  position    INTEGER NOT NULL,
  text        TEXT COLLATE "C" NOT NULL,
  emoji       TEXT COLLATE "C"
);
CREATE INDEX IF NOT EXISTS idx_poll_answers_message ON poll_answers(message_id, position);

CREATE TABLE IF NOT EXISTS poll_votes (
  message_id  TEXT COLLATE "C" NOT NULL REFERENCES polls(message_id) ON DELETE CASCADE DEFERRABLE,
  answer_id   TEXT COLLATE "C" NOT NULL REFERENCES poll_answers(id) ON DELETE CASCADE DEFERRABLE,
  user_id     TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE,
  created_at  TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  -- One row per (voter, answer): a single-choice poll is enforced in the
  -- service by clearing prior rows, so the same table serves both modes.
  PRIMARY KEY (message_id, answer_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_poll_votes_user ON poll_votes(message_id, user_id);

-- ============================================================================
--  Scheduled events (Discord: Server Events)
--
--  An event is a guild-level object, not a message: it has a lifecycle
--  (scheduled → active → completed / cancelled), an optional voice/stage
--  channel to hold it in, and a list of people who said they are interested.
--  "Interested" is its own table because the count is shown everywhere and a
--  denormalised counter would have to survive members leaving the server.
-- ============================================================================

CREATE TABLE IF NOT EXISTS scheduled_events (
  id             TEXT COLLATE "C" PRIMARY KEY,
  server_id      TEXT COLLATE "C" NOT NULL REFERENCES servers(id) ON DELETE CASCADE DEFERRABLE,
  channel_id     TEXT COLLATE "C" REFERENCES channels(id) ON DELETE SET NULL DEFERRABLE,   -- voice/stage, or NULL for external
  creator_id     TEXT COLLATE "C" REFERENCES users(id) ON DELETE SET NULL DEFERRABLE,
  name           TEXT COLLATE "C" NOT NULL,
  description    TEXT COLLATE "C",
  location       TEXT COLLATE "C",                    -- free text when channel_id is NULL
  image_url      TEXT COLLATE "C",
  starts_at      TIMESTAMPTZ(3) NOT NULL,
  ends_at        TIMESTAMPTZ(3),
  status         TEXT COLLATE "C" NOT NULL DEFAULT 'scheduled'
                 CHECK (status IN ('scheduled','active','completed','cancelled')),
  created_at     TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_server_start ON scheduled_events(server_id, starts_at);

CREATE TABLE IF NOT EXISTS event_interest (
  event_id    TEXT COLLATE "C" NOT NULL REFERENCES scheduled_events(id) ON DELETE CASCADE DEFERRABLE,
  user_id     TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE,
  created_at  TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, user_id)
);

-- ============================================================================
--  Private notes about other users. Only the author can ever read one.
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_notes (
  author_id   TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE,
  subject_id  TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE,
  note        TEXT COLLATE "C" NOT NULL,
  updated_at  TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (author_id, subject_id)
);


-- ============================================================================
--  Forum channels. A forum post is a thread whose parent is the forum; the
--  post body is the thread's first message. Tags are per-forum and a post may
--  carry up to five. `moderated` tags may only be applied by staff.
-- ============================================================================

CREATE TABLE IF NOT EXISTS forum_tags (
  id          TEXT COLLATE "C" PRIMARY KEY,
  channel_id  TEXT COLLATE "C" NOT NULL REFERENCES channels(id) ON DELETE CASCADE DEFERRABLE,
  name        TEXT COLLATE "C" NOT NULL,
  emoji       TEXT COLLATE "C",
  moderated   INTEGER NOT NULL DEFAULT 0,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  UNIQUE (channel_id, name)
);

CREATE TABLE IF NOT EXISTS forum_post_tags (
  thread_id   TEXT COLLATE "C" NOT NULL REFERENCES channels(id) ON DELETE CASCADE DEFERRABLE,
  tag_id      TEXT COLLATE "C" NOT NULL REFERENCES forum_tags(id) ON DELETE CASCADE DEFERRABLE,
  PRIMARY KEY (thread_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_forum_post_tags_tag ON forum_post_tags(tag_id);

-- ============================================================================
--  Welcome screen + onboarding. The welcome screen is up to five highlighted
--  channels shown to a newcomer; onboarding prompts let them pick channels
--  (and roles) that match their interests. Completion is recorded per member
--  and lifts the `pending` flag.
-- ============================================================================

CREATE TABLE IF NOT EXISTS welcome_channels (
  server_id    TEXT COLLATE "C" NOT NULL REFERENCES servers(id) ON DELETE CASCADE DEFERRABLE,
  channel_id   TEXT COLLATE "C" NOT NULL REFERENCES channels(id) ON DELETE CASCADE DEFERRABLE,
  description  TEXT COLLATE "C" NOT NULL,
  emoji        TEXT COLLATE "C",
  position     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (server_id, channel_id)
);

CREATE TABLE IF NOT EXISTS onboarding_prompts (
  id           TEXT COLLATE "C" PRIMARY KEY,
  server_id    TEXT COLLATE "C" NOT NULL REFERENCES servers(id) ON DELETE CASCADE DEFERRABLE,
  title        TEXT COLLATE "C" NOT NULL,
  single_select INTEGER NOT NULL DEFAULT 0,
  required     INTEGER NOT NULL DEFAULT 0,
  position     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS onboarding_options (
  id           TEXT COLLATE "C" PRIMARY KEY,
  prompt_id    TEXT COLLATE "C" NOT NULL REFERENCES onboarding_prompts(id) ON DELETE CASCADE DEFERRABLE,
  title        TEXT COLLATE "C" NOT NULL,
  description  TEXT COLLATE "C",
  emoji        TEXT COLLATE "C",
  channel_ids  JSONB NOT NULL DEFAULT '[]'::jsonb,   -- JSON array
  role_ids     JSONB NOT NULL DEFAULT '[]'::jsonb,   -- JSON array
  position     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_onboarding_options_prompt ON onboarding_options(prompt_id);

CREATE TABLE IF NOT EXISTS member_onboarding (
  server_id         TEXT COLLATE "C" NOT NULL REFERENCES servers(id) ON DELETE CASCADE DEFERRABLE,
  user_id           TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE,
  rules_accepted_at TIMESTAMPTZ(3),
  completed_at      TIMESTAMPTZ(3),
  answers           JSONB NOT NULL DEFAULT '{}'::jsonb,  -- JSON {promptId: [optionId]}
  PRIMARY KEY (server_id, user_id)
);

-- ============================================================================
--  Channel following. An announcement channel can be followed from a text
--  channel in another (or the same) server. Publishing a message there relays
--  it through a `follower` webhook into every follower channel, so the relayed
--  message shows the source server as its author.
-- ============================================================================

CREATE TABLE IF NOT EXISTS channel_follows (
  id                 TEXT COLLATE "C" PRIMARY KEY,
  source_channel_id  TEXT COLLATE "C" NOT NULL REFERENCES channels(id) ON DELETE CASCADE DEFERRABLE,
  target_channel_id  TEXT COLLATE "C" NOT NULL REFERENCES channels(id) ON DELETE CASCADE DEFERRABLE,
  webhook_id         TEXT COLLATE "C" NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE DEFERRABLE,
  created_by         TEXT COLLATE "C" REFERENCES users(id) ON DELETE SET NULL DEFERRABLE,
  created_at         TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  UNIQUE (source_channel_id, target_channel_id)
);
CREATE INDEX IF NOT EXISTS idx_channel_follows_source ON channel_follows(source_channel_id);

-- Which relayed message came from which original, so an edit/delete upstream
-- can be mirrored and a message is never relayed twice.
CREATE TABLE IF NOT EXISTS message_crossposts (
  source_message_id  TEXT COLLATE "C" NOT NULL REFERENCES messages(id) ON DELETE CASCADE DEFERRABLE,
  follow_id          TEXT COLLATE "C" NOT NULL REFERENCES channel_follows(id) ON DELETE CASCADE DEFERRABLE,
  relayed_message_id TEXT COLLATE "C" NOT NULL REFERENCES messages(id) ON DELETE CASCADE DEFERRABLE,
  PRIMARY KEY (source_message_id, follow_id)
);

-- ============================================================================
--  Server templates: a JSON snapshot of a server's structure, shared by code.
--  One template per source server (Discord's rule).
-- ============================================================================

CREATE TABLE IF NOT EXISTS server_templates (
  code              TEXT COLLATE "C" PRIMARY KEY,
  source_server_id  TEXT COLLATE "C" NOT NULL UNIQUE REFERENCES servers(id) ON DELETE CASCADE DEFERRABLE,
  creator_id        TEXT COLLATE "C" REFERENCES users(id) ON DELETE SET NULL DEFERRABLE,
  name              TEXT COLLATE "C" NOT NULL,
  description       TEXT COLLATE "C",
  data              JSONB NOT NULL,          -- JSON, see services/templates.js
  usage_count       INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);

-- ============================================================================
--  Applications (bots).
--
--  An application owns exactly one bot *user* — a normal row in `users` with
--  is_bot = 1 — so every existing code path (messages, permissions, mentions,
--  the member list) treats a bot like any other member. The token is stored
--  hashed and presented as `Authorization: Bot <token>`; identity resolution
--  maps it back to the bot user, after which the ordinary permission gate
--  applies. There is no second, weaker API surface.
-- ============================================================================

CREATE TABLE IF NOT EXISTS applications (
  id            TEXT COLLATE "C" PRIMARY KEY,
  name          TEXT COLLATE "C" NOT NULL,
  description   TEXT COLLATE "C",
  icon_url      TEXT COLLATE "C",
  owner_id      TEXT COLLATE "C" REFERENCES users(id) ON DELETE CASCADE DEFERRABLE,
  bot_user_id   TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE,
  token_hash    TEXT COLLATE "C" NOT NULL UNIQUE,
  public        INTEGER NOT NULL DEFAULT 1,   -- may anyone invite it?
  created_at    TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  deleted_at    TIMESTAMPTZ(3)
);
CREATE INDEX IF NOT EXISTS idx_applications_owner ON applications(owner_id) WHERE deleted_at IS NULL;

-- Slash commands a bot registers, globally or per guild.
CREATE TABLE IF NOT EXISTS application_commands (
  id             TEXT COLLATE "C" PRIMARY KEY,
  application_id TEXT COLLATE "C" NOT NULL REFERENCES applications(id) ON DELETE CASCADE DEFERRABLE,
  server_id      TEXT COLLATE "C" REFERENCES servers(id) ON DELETE CASCADE DEFERRABLE,  -- NULL = global
  name           TEXT COLLATE "C" NOT NULL,
  description    TEXT COLLATE "C" NOT NULL,
  -- 'slash' is typed in the composer; 'message'/'user' appear in the right-click
  -- menu of a message or a member and carry that target instead of options.
  type           TEXT COLLATE "C" NOT NULL DEFAULT 'slash' CHECK (type IN ('slash','message','user')),
  options        JSONB NOT NULL DEFAULT '[]'::jsonb,   -- JSON [{name,description,type,required,choices}]
  created_at     TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  UNIQUE (application_id, server_id, name)
);
CREATE INDEX IF NOT EXISTS idx_app_commands_server ON application_commands(server_id);

-- One press of a button / one select-menu choice / one slash-command run.
-- Rows are kept so a late callback can be rejected and so "this interaction
-- failed" is answerable after the fact.
CREATE TABLE IF NOT EXISTS interactions (
  id             TEXT COLLATE "C" PRIMARY KEY,
  application_id TEXT COLLATE "C" NOT NULL REFERENCES applications(id) ON DELETE CASCADE DEFERRABLE,
  type           TEXT COLLATE "C" NOT NULL CHECK (type IN ('component','command')),
  user_id        TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE,
  channel_id     TEXT COLLATE "C" REFERENCES channels(id) ON DELETE CASCADE DEFERRABLE,
  server_id      TEXT COLLATE "C" REFERENCES servers(id) ON DELETE CASCADE DEFERRABLE,
  message_id     TEXT COLLATE "C" REFERENCES messages(id) ON DELETE CASCADE DEFERRABLE,
  custom_id      TEXT COLLATE "C",
  command_name   TEXT COLLATE "C",
  data           JSONB NOT NULL DEFAULT '{}'::jsonb,   -- JSON: values / options
  token          TEXT COLLATE "C" NOT NULL UNIQUE,         -- what the bot answers with
  responded_at   TIMESTAMPTZ(3),
  created_at     TIMESTAMPTZ(3) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_interactions_app ON interactions(application_id, created_at);

-- ============================================================================
--  Raid protection and the public widget.
--
--  Raid protection watches the join rate: when more than `raid_join_threshold`
--  accounts join inside `raid_join_window_secs`, the server locks down —
--  new joins are refused until staff lift it. Lockdowns are recorded so the
--  audit log can explain what happened.
-- ============================================================================

CREATE TABLE IF NOT EXISTS guild_lockdowns (
  id          TEXT COLLATE "C" PRIMARY KEY,
  server_id   TEXT COLLATE "C" NOT NULL REFERENCES servers(id) ON DELETE CASCADE DEFERRABLE,
  reason      TEXT COLLATE "C" NOT NULL,
  joins       INTEGER NOT NULL DEFAULT 0,
  started_at  TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  lifted_at   TIMESTAMPTZ(3),
  lifted_by   TEXT COLLATE "C" REFERENCES users(id) ON DELETE SET NULL DEFERRABLE
);
CREATE INDEX IF NOT EXISTS idx_lockdowns_server ON guild_lockdowns(server_id, started_at);

-- ============================================================================
--  Calls in DMs and group DMs.
--
--  A call is a thin record around the voice machinery that already exists:
--  participants still live in `voice_states` keyed by the DM channel, so the
--  same mesh, the same mute/deafen flags and the same screen-share path all
--  apply. What a call adds is the ring: who started it, who is still being
--  rung, and when it ended — which is what turns into the `call` system
--  message in the conversation afterwards.
--
--  At most one call is open per channel; `idx_calls_open` enforces that.
-- ============================================================================

CREATE TABLE IF NOT EXISTS calls (
  id           TEXT COLLATE "C" PRIMARY KEY,
  channel_id   TEXT COLLATE "C" NOT NULL REFERENCES channels(id) ON DELETE CASCADE DEFERRABLE,
  initiator_id TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE,
  video        INTEGER NOT NULL DEFAULT 0,
  message_id   TEXT COLLATE "C" REFERENCES messages(id) ON DELETE SET NULL DEFERRABLE,
  started_at   TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
  ended_at     TIMESTAMPTZ(3)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_calls_open ON calls(channel_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_calls_channel ON calls(channel_id, started_at);

-- Who the call rang, and what they did about it. A row per recipient means an
-- unanswered call can say "no answer" for one person and "declined" for another.
CREATE TABLE IF NOT EXISTS call_participants (
  call_id   TEXT COLLATE "C" NOT NULL REFERENCES calls(id) ON DELETE CASCADE DEFERRABLE,
  user_id   TEXT COLLATE "C" NOT NULL REFERENCES users(id) ON DELETE CASCADE DEFERRABLE,
  state     TEXT COLLATE "C" NOT NULL DEFAULT 'ringing'
            CHECK (state IN ('ringing','joined','declined','missed','left')),
  joined_at TIMESTAMPTZ(3),
  left_at   TIMESTAMPTZ(3),
  PRIMARY KEY (call_id, user_id)
);


-- ============================================================================
--  Foreign keys that point at a table defined further down (SQLite resolves
--  references lazily; Postgres needs the target to exist).
-- ============================================================================
ALTER TABLE users ADD CONSTRAINT users_avatar_file_id_fkey FOREIGN KEY (avatar_file_id) REFERENCES files(id) ON DELETE SET NULL DEFERRABLE;
ALTER TABLE users ADD CONSTRAINT users_banner_file_id_fkey FOREIGN KEY (banner_file_id) REFERENCES files(id) ON DELETE SET NULL DEFERRABLE;
ALTER TABLE invites ADD CONSTRAINT invites_channel_id_fkey FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE DEFERRABLE;
ALTER TABLE messages ADD CONSTRAINT messages_webhook_id_fkey FOREIGN KEY (webhook_id) REFERENCES webhooks(id) ON DELETE SET NULL DEFERRABLE;
ALTER TABLE messages ADD CONSTRAINT messages_sticker_id_fkey FOREIGN KEY (sticker_id) REFERENCES stickers(id) ON DELETE SET NULL DEFERRABLE;
ALTER TABLE reactions ADD CONSTRAINT reactions_emoji_id_fkey FOREIGN KEY (emoji_id) REFERENCES emojis(id) ON DELETE CASCADE DEFERRABLE;
