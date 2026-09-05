-- ============================================================================
--  Antigravity Discord — full relational schema (SQLite)
--  Schema version: 1
--
--  Conventions
--    * All primary keys are snowflake IDs stored as TEXT (see lib/snowflake.js).
--    * Permission bitfields are TEXT decimal strings (64-bit safe).
--    * Timestamps are ISO-8601 TEXT in UTC.
--    * Soft deletes use deleted_at; queries must filter it.
--    * Every FK is declared; PRAGMA foreign_keys is ON at connect time.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 0. Migration bookkeeping
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  applied_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------------------------------------------------------------------------
-- 1. Identity
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id                  TEXT PRIMARY KEY,
  username            TEXT NOT NULL,
  discriminator       TEXT NOT NULL DEFAULT '0000',
  display_name        TEXT NOT NULL,
  email               TEXT,
  password_hash       TEXT,
  avatar_file_id      TEXT REFERENCES files(id) ON DELETE SET NULL,
  avatar_url          TEXT,
  banner_file_id      TEXT REFERENCES files(id) ON DELETE SET NULL,
  banner_url          TEXT,
  accent_color        TEXT,
  bio                 TEXT,
  pronouns            TEXT,
  status              TEXT NOT NULL DEFAULT 'offline'
                      CHECK (status IN ('online','idle','dnd','offline','invisible')),
  custom_status       TEXT,
  custom_status_emoji TEXT,
  presence_updated_at TEXT,
  locale              TEXT NOT NULL DEFAULT 'th-TH',
  theme               TEXT NOT NULL DEFAULT 'dark',
  flags               INTEGER NOT NULL DEFAULT 0,
  is_bot              INTEGER NOT NULL DEFAULT 0,
  is_system           INTEGER NOT NULL DEFAULT 0,
  email_verified      INTEGER NOT NULL DEFAULT 0,
  mfa_enabled         INTEGER NOT NULL DEFAULT 0,
  mfa_secret          TEXT,
  storage_used        INTEGER NOT NULL DEFAULT 0,
  storage_quota       INTEGER NOT NULL DEFAULT 5368709120, -- 5 GiB
  last_seen_at        TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at          TEXT,
  UNIQUE (username, discriminator)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email    ON users(email)    WHERE email IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);

CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,
  device_name   TEXT,
  platform      TEXT,
  ip_address    TEXT,
  user_agent    TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_seen_at  TEXT,
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, revoked_at);

-- Single-use tokens: email verification, password reset, MFA recovery codes.
-- Only hashes are stored, so a database leak cannot be replayed.
CREATE TABLE IF NOT EXISTS account_tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('email_verify','password_reset','recovery')),
  token_hash  TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at  TEXT,
  used_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_account_tokens_lookup ON account_tokens(kind, token_hash);
CREATE INDEX IF NOT EXISTS idx_account_tokens_user ON account_tokens(user_id, kind);

CREATE TABLE IF NOT EXISTS push_tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform    TEXT NOT NULL CHECK (platform IN ('web','ios','android','desktop')),
  token       TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at  TEXT
);

-- ---------------------------------------------------------------------------
-- 2. Storage registry — the single source of truth for every uploaded byte
-- ---------------------------------------------------------------------------
-- Content-addressable: `hash` is the sha256 of the bytes, so re-uploading the
-- same picture reuses one row and one file on disk (ref_count tracks users).
CREATE TABLE IF NOT EXISTS files (
  id                TEXT PRIMARY KEY,
  hash              TEXT NOT NULL,
  storage_key       TEXT NOT NULL UNIQUE,     -- path relative to the storage root
  backend           TEXT NOT NULL DEFAULT 'local' CHECK (backend IN ('local','s3','r2','gcs')),
  category          TEXT NOT NULL
                    CHECK (category IN ('avatars','banners','icons','attachments',
                                        'emojis','stickers','splashes','audio','video','misc')),
  original_name     TEXT NOT NULL,
  mime_type         TEXT NOT NULL,
  extension         TEXT,
  size              INTEGER NOT NULL,
  -- media metadata (NULL for non-media)
  width             INTEGER,
  height            INTEGER,
  duration_secs     REAL,
  pages             INTEGER,
  blurhash          TEXT,
  is_animated       INTEGER NOT NULL DEFAULT 0,
  -- lifecycle
  uploader_id       TEXT REFERENCES users(id) ON DELETE SET NULL,
  ref_count         INTEGER NOT NULL DEFAULT 0,
  visibility        TEXT NOT NULL DEFAULT 'public'
                    CHECK (visibility IN ('public','authenticated','private')),
  scan_status       TEXT NOT NULL DEFAULT 'pending'
                    CHECK (scan_status IN ('pending','clean','flagged','error','skipped')),
  scan_result       TEXT,
  expires_at        TEXT,                     -- for ephemeral uploads
  last_accessed_at  TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at        TEXT                      -- soft delete; GC removes bytes later
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_files_hash_category ON files(hash, category) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_files_uploader ON files(uploader_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_files_orphans  ON files(ref_count, created_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_files_expiring ON files(expires_at) WHERE expires_at IS NOT NULL;

-- Derived renditions: thumbnails, resized variants, video posters, previews.
CREATE TABLE IF NOT EXISTS file_variants (
  id           TEXT PRIMARY KEY,
  file_id      TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL
               CHECK (kind IN ('thumb','small','medium','large','poster','preview','webp','blur')),
  storage_key  TEXT NOT NULL UNIQUE,
  mime_type    TEXT NOT NULL,
  width        INTEGER,
  height       INTEGER,
  size         INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (file_id, kind)
);

-- Every read/serve of a private file, for auditing and quota analytics.
CREATE TABLE IF NOT EXISTS file_access_log (
  id          TEXT PRIMARY KEY,
  file_id     TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  ip_address  TEXT,
  variant     TEXT,
  bytes_sent  INTEGER,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_file_access_file ON file_access_log(file_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- 3. Guilds (servers)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS servers (
  id                            TEXT PRIMARY KEY,
  name                          TEXT NOT NULL,
  description                   TEXT,
  icon_file_id                  TEXT REFERENCES files(id) ON DELETE SET NULL,
  icon_url                      TEXT,
  banner_file_id                TEXT REFERENCES files(id) ON DELETE SET NULL,
  banner_url                    TEXT,
  splash_url                    TEXT,
  owner_id                      TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  vanity_url                    TEXT UNIQUE,
  verification_level            INTEGER NOT NULL DEFAULT 0,
  explicit_content_filter       INTEGER NOT NULL DEFAULT 0,
  default_notifications         TEXT NOT NULL DEFAULT 'all_messages'
                                CHECK (default_notifications IN ('all_messages','only_mentions')),
  system_channel_id             TEXT,
  rules_channel_id              TEXT,
  -- membership screening / welcome screen / onboarding
  screening_enabled             INTEGER NOT NULL DEFAULT 0,
  screening_rules               TEXT,                 -- JSON array of strings (≤10)
  welcome_description           TEXT,
  welcome_enabled               INTEGER NOT NULL DEFAULT 0,
  afk_channel_id                TEXT,
  afk_timeout                   INTEGER NOT NULL DEFAULT 300,
  premium_tier                  INTEGER NOT NULL DEFAULT 0,
  member_count                  INTEGER NOT NULL DEFAULT 0,
  max_members                   INTEGER NOT NULL DEFAULT 250000,
  locale                        TEXT NOT NULL DEFAULT 'th-TH',
  features                      TEXT NOT NULL DEFAULT '[]',   -- JSON array
  created_at                    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at                    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at                    TEXT
);
CREATE INDEX IF NOT EXISTS idx_servers_owner ON servers(owner_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS roles (
  id           TEXT PRIMARY KEY,
  server_id    TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  color        TEXT,
  icon_url     TEXT,
  position     INTEGER NOT NULL DEFAULT 0,
  permissions  TEXT NOT NULL DEFAULT '0',
  hoist        INTEGER NOT NULL DEFAULT 0,
  mentionable  INTEGER NOT NULL DEFAULT 0,
  managed      INTEGER NOT NULL DEFAULT 0,
  is_everyone  INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_roles_server ON roles(server_id, position DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_roles_everyone ON roles(server_id) WHERE is_everyone = 1;

CREATE TABLE IF NOT EXISTS server_members (
  server_id      TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  nickname       TEXT,
  avatar_url     TEXT,                  -- per-guild avatar override
  joined_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  premium_since  TEXT,
  is_deaf        INTEGER NOT NULL DEFAULT 0,
  is_mute        INTEGER NOT NULL DEFAULT 0,
  timeout_until  TEXT,                  -- MODERATE_MEMBERS timeout
  pending        INTEGER NOT NULL DEFAULT 0,
  left_at        TEXT,
  PRIMARY KEY (server_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_members_user ON server_members(user_id) WHERE left_at IS NULL;

CREATE TABLE IF NOT EXISTS member_roles (
  server_id    TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id      TEXT NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  assigned_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  assigned_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (server_id, user_id, role_id)
);
CREATE INDEX IF NOT EXISTS idx_member_roles_role ON member_roles(role_id);

CREATE TABLE IF NOT EXISTS bans (
  server_id      TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  moderator_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  reason         TEXT,
  delete_message_seconds INTEGER NOT NULL DEFAULT 0,
  expires_at     TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (server_id, user_id)
);

CREATE TABLE IF NOT EXISTS invites (
  code         TEXT PRIMARY KEY,
  server_id    TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  channel_id   TEXT REFERENCES channels(id) ON DELETE CASCADE,
  inviter_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  max_uses     INTEGER NOT NULL DEFAULT 0,   -- 0 = unlimited
  uses         INTEGER NOT NULL DEFAULT 0,
  max_age      INTEGER NOT NULL DEFAULT 86400,
  temporary    INTEGER NOT NULL DEFAULT 0,
  expires_at   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_invites_server ON invites(server_id) WHERE revoked_at IS NULL;

-- ---------------------------------------------------------------------------
-- 4. Channels — guild channels, categories, threads, DMs and group DMs all
--    live here, discriminated by `type`. server_id is NULL for DMs.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS channels (
  id                    TEXT PRIMARY KEY,
  server_id             TEXT REFERENCES servers(id) ON DELETE CASCADE,
  parent_id             TEXT REFERENCES channels(id) ON DELETE CASCADE, -- category or thread parent
  name                  TEXT,
  type                  TEXT NOT NULL
                        CHECK (type IN ('text','voice','category','announcement','forum',
                                        'stage','thread','dm','group_dm')),
  topic                 TEXT,
  icon_url              TEXT,                 -- group DM icon
  owner_id              TEXT REFERENCES users(id) ON DELETE SET NULL,
  position              INTEGER NOT NULL DEFAULT 0,
  nsfw                  INTEGER NOT NULL DEFAULT 0,
  rate_limit_per_user   INTEGER NOT NULL DEFAULT 0,  -- slowmode seconds
  -- voice
  bitrate               INTEGER,
  user_limit            INTEGER,
  rtc_region            TEXT,
  video_quality_mode    INTEGER,
  -- thread state
  archived              INTEGER NOT NULL DEFAULT 0,
  archive_timestamp     TEXT,
  auto_archive_duration INTEGER NOT NULL DEFAULT 1440,
  locked                INTEGER NOT NULL DEFAULT 0,
  -- forum post state / forum defaults
  pinned                INTEGER NOT NULL DEFAULT 0,
  default_sort_order    TEXT NOT NULL DEFAULT 'latest_activity'
                        CHECK (default_sort_order IN ('latest_activity','creation_date')),
  default_reaction_emoji TEXT,
  require_tag           INTEGER NOT NULL DEFAULT 0,
  default_layout        TEXT NOT NULL DEFAULT 'list' CHECK (default_layout IN ('list','gallery')),
  invitable             INTEGER NOT NULL DEFAULT 1,
  message_count         INTEGER NOT NULL DEFAULT 0,
  member_count          INTEGER NOT NULL DEFAULT 0,
  -- denormalised pointers, kept fresh on write
  last_message_id       TEXT,
  last_pin_at           TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at            TEXT
);
CREATE INDEX IF NOT EXISTS idx_channels_server ON channels(server_id, position, id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_channels_parent ON channels(parent_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_channels_type   ON channels(type);

-- DM / group-DM / thread membership.
CREATE TABLE IF NOT EXISTS channel_recipients (
  channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  closed      INTEGER NOT NULL DEFAULT 0,   -- hidden from the user's DM list
  PRIMARY KEY (channel_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_recipients_user ON channel_recipients(user_id, closed);

CREATE TABLE IF NOT EXISTS channel_overwrites (
  channel_id   TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  target_type  TEXT NOT NULL CHECK (target_type IN ('role','member')),
  target_id    TEXT NOT NULL,
  allow        TEXT NOT NULL DEFAULT '0',
  deny         TEXT NOT NULL DEFAULT '0',
  PRIMARY KEY (channel_id, target_type, target_id)
);

-- ---------------------------------------------------------------------------
-- 5. Messages
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS messages (
  id                TEXT PRIMARY KEY,
  channel_id        TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  server_id         TEXT REFERENCES servers(id) ON DELETE CASCADE,
  user_id           TEXT REFERENCES users(id) ON DELETE SET NULL,
  webhook_id        TEXT REFERENCES webhooks(id) ON DELETE SET NULL,
  content           TEXT,
  type              TEXT NOT NULL DEFAULT 'default'
                    CHECK (type IN ('default','reply','join','pin','thread_created',
                                    'call','system','boost','channel_follow_add','poll')),
  reply_to_id       TEXT REFERENCES messages(id) ON DELETE SET NULL,
  thread_id         TEXT REFERENCES channels(id) ON DELETE SET NULL,
  mention_everyone  INTEGER NOT NULL DEFAULT 0,
  pinned            INTEGER NOT NULL DEFAULT 0,
  tts               INTEGER NOT NULL DEFAULT 0,
  flags             INTEGER NOT NULL DEFAULT 0,
  sticker_id        TEXT REFERENCES stickers(id) ON DELETE SET NULL,  -- one sticker per message
  nonce             TEXT,                 -- client dedupe key for optimistic sends
  embeds            TEXT NOT NULL DEFAULT '[]',
  components        TEXT NOT NULL DEFAULT '[]',
  edited_at         TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  deleted_at        TEXT
);
-- Primary read path: newest-first pagination inside a channel.
CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, id DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_messages_author  ON messages(user_id, id DESC);
CREATE INDEX IF NOT EXISTS idx_messages_reply   ON messages(reply_to_id);
CREATE INDEX IF NOT EXISTS idx_messages_pinned  ON messages(channel_id) WHERE pinned = 1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_nonce ON messages(channel_id, user_id, nonce) WHERE nonce IS NOT NULL;

-- Full-text search over message content.
--
-- The trigram tokenizer, not unicode61: Thai does not put spaces between words,
-- so a word-boundary tokenizer indexes 'ทดสอบรูปภาพ' as a single token and a
-- search for 'ทดสอบ' finds nothing. Trigram gives true substring matching in
-- every language, at the cost of a larger index and a 3-character minimum
-- query (searchMessages falls back to LIKE below that).
CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  message_id UNINDEXED,
  channel_id UNINDEXED,
  tokenize = 'trigram'
);

CREATE TABLE IF NOT EXISTS message_edits (
  id          TEXT PRIMARY KEY,
  message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  content     TEXT,
  edited_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_message_edits ON message_edits(message_id, edited_at DESC);

-- Attachments join a message to a file, carrying per-message presentation.
CREATE TABLE IF NOT EXISTS attachments (
  id            TEXT PRIMARY KEY,
  message_id    TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  file_id       TEXT NOT NULL REFERENCES files(id) ON DELETE RESTRICT,
  filename      TEXT NOT NULL,
  description   TEXT,                    -- alt text
  content_type  TEXT,
  size          INTEGER NOT NULL DEFAULT 0,
  width         INTEGER,
  height        INTEGER,
  duration_secs REAL,
  waveform      TEXT,                    -- voice-message waveform
  is_spoiler    INTEGER NOT NULL DEFAULT 0,
  position      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments(message_id, position);
CREATE INDEX IF NOT EXISTS idx_attachments_file    ON attachments(file_id);

-- One row per (message, user, emoji) — the correct model for reaction lists.
CREATE TABLE IF NOT EXISTS reactions (
  message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  emoji       TEXT NOT NULL,            -- unicode char, or ':name:' for custom
  emoji_id    TEXT REFERENCES emojis(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (message_id, user_id, emoji)
);
CREATE INDEX IF NOT EXISTS idx_reactions_message ON reactions(message_id, emoji);

CREATE TABLE IF NOT EXISTS mentions (
  message_id   TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  target_type  TEXT NOT NULL CHECK (target_type IN ('user','role','channel')),
  target_id    TEXT NOT NULL,
  PRIMARY KEY (message_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_mentions_target ON mentions(target_type, target_id);

CREATE TABLE IF NOT EXISTS pins (
  channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  pinned_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  pinned_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (channel_id, message_id)
);

-- Cached OpenGraph/oEmbed data so link previews are not re-fetched per render.
CREATE TABLE IF NOT EXISTS link_embeds (
  url_hash    TEXT PRIMARY KEY,
  url         TEXT NOT NULL,
  data        TEXT NOT NULL,            -- JSON embed object
  fetched_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  expires_at  TEXT
);

-- ---------------------------------------------------------------------------
-- 6. Expression: custom emojis, stickers, soundboard
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS emojis (
  id          TEXT PRIMARY KEY,
  server_id   TEXT REFERENCES servers(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  file_id     TEXT REFERENCES files(id) ON DELETE SET NULL,
  url         TEXT NOT NULL,
  animated    INTEGER NOT NULL DEFAULT 0,
  managed     INTEGER NOT NULL DEFAULT 0,
  available   INTEGER NOT NULL DEFAULT 1,
  creator_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (server_id, name)
);

CREATE TABLE IF NOT EXISTS stickers (
  id           TEXT PRIMARY KEY,
  server_id    TEXT REFERENCES servers(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT,
  tags         TEXT,
  file_id      TEXT REFERENCES files(id) ON DELETE SET NULL,
  url          TEXT NOT NULL,
  format       TEXT NOT NULL DEFAULT 'png' CHECK (format IN ('png','apng','lottie','gif')),
  available    INTEGER NOT NULL DEFAULT 1,
  creator_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS soundboard_sounds (
  id          TEXT PRIMARY KEY,
  server_id   TEXT REFERENCES servers(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  file_id     TEXT REFERENCES files(id) ON DELETE SET NULL,
  url         TEXT NOT NULL,
  volume      REAL NOT NULL DEFAULT 1.0,
  emoji       TEXT,
  creator_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------------------------------------------------------------------------
-- 7. Social graph
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS friends (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  friend_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status        TEXT NOT NULL DEFAULT 'pending'
                CHECK (status IN ('pending','accepted','blocked','declined')),
  requested_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  nickname      TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  accepted_at   TEXT,
  UNIQUE (user_id, friend_id)
);
CREATE INDEX IF NOT EXISTS idx_friends_lookup ON friends(friend_id, status);

CREATE TABLE IF NOT EXISTS blocks (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  blocked_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, blocked_id)
);

-- ---------------------------------------------------------------------------
-- 8. Read state, notification preferences, notifications
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS read_states (
  user_id                TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id             TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  last_read_message_id   TEXT,
  mention_count          INTEGER NOT NULL DEFAULT 0,
  last_viewed_at         TEXT,
  PRIMARY KEY (user_id, channel_id)
);
CREATE INDEX IF NOT EXISTS idx_read_states_user ON read_states(user_id);

CREATE TABLE IF NOT EXISTS channel_settings (
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id          TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  muted               INTEGER NOT NULL DEFAULT 0,
  muted_until         TEXT,
  notification_level  TEXT NOT NULL DEFAULT 'inherit'
                      CHECK (notification_level IN ('inherit','all_messages','only_mentions','nothing')),
  collapsed           INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, channel_id)
);

-- Account-wide client preferences, one row per category so a partial save
-- never has to read-modify-write the whole blob.
CREATE TABLE IF NOT EXISTS user_settings (
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category    TEXT NOT NULL,          -- appearance, accessibility, notifications, ...
  data        TEXT NOT NULL DEFAULT '{}',   -- JSON object of that category's keys
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, category)
);

CREATE TABLE IF NOT EXISTS server_settings (
  user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  server_id           TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  muted               INTEGER NOT NULL DEFAULT 0,
  muted_until         TEXT,
  notification_level  TEXT NOT NULL DEFAULT 'all_messages'
                      CHECK (notification_level IN ('all_messages','only_mentions','nothing')),
  suppress_everyone   INTEGER NOT NULL DEFAULT 0,
  suppress_roles      INTEGER NOT NULL DEFAULT 0,
  position            INTEGER NOT NULL DEFAULT 0,
  hidden              INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, server_id)
);

CREATE TABLE IF NOT EXISTS notifications (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,             -- mention, dm, friend_request, reply, reaction...
  server_id   TEXT REFERENCES servers(id) ON DELETE CASCADE,
  channel_id  TEXT REFERENCES channels(id) ON DELETE CASCADE,
  message_id  TEXT REFERENCES messages(id) ON DELETE CASCADE,
  actor_id    TEXT REFERENCES users(id) ON DELETE SET NULL,
  body        TEXT,
  read_at     TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at, id DESC);

-- ---------------------------------------------------------------------------
-- 9. Voice / stage
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS voice_states (
  user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  channel_id   TEXT REFERENCES channels(id) ON DELETE CASCADE,
  server_id    TEXT REFERENCES servers(id) ON DELETE CASCADE,
  session_id   TEXT NOT NULL,
  socket_id    TEXT,
  self_mute    INTEGER NOT NULL DEFAULT 0,
  self_deaf    INTEGER NOT NULL DEFAULT 0,
  self_video   INTEGER NOT NULL DEFAULT 0,
  self_stream  INTEGER NOT NULL DEFAULT 0,
  server_mute  INTEGER NOT NULL DEFAULT 0,
  server_deaf  INTEGER NOT NULL DEFAULT 0,
  suppress     INTEGER NOT NULL DEFAULT 0,
  request_to_speak_at TEXT,
  joined_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_voice_channel ON voice_states(channel_id);

-- ---------------------------------------------------------------------------
-- 10. Automation & moderation
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS webhooks (
  id          TEXT PRIMARY KEY,
  channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  server_id   TEXT REFERENCES servers(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  avatar_url  TEXT,
  token_hash  TEXT NOT NULL UNIQUE,
  type        TEXT NOT NULL DEFAULT 'incoming' CHECK (type IN ('incoming','follower','application')),
  creator_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  revoked_at  TEXT
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id           TEXT PRIMARY KEY,
  server_id    TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  action_type  TEXT NOT NULL,
  target_type  TEXT,
  target_id    TEXT,
  changes      TEXT NOT NULL DEFAULT '[]',   -- JSON [{key, old, new}]
  reason       TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_server ON audit_logs(server_id, id DESC);

CREATE TABLE IF NOT EXISTS automod_rules (
  id           TEXT PRIMARY KEY,
  server_id    TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  event_type   TEXT NOT NULL DEFAULT 'message_send',
  trigger_type TEXT NOT NULL CHECK (trigger_type IN ('keyword','spam','mention_spam','link','regex')),
  trigger_metadata TEXT NOT NULL DEFAULT '{}',
  actions      TEXT NOT NULL DEFAULT '[]',
  enabled      INTEGER NOT NULL DEFAULT 1,
  exempt_roles TEXT NOT NULL DEFAULT '[]',
  exempt_channels TEXT NOT NULL DEFAULT '[]',
  creator_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS reports (
  id           TEXT PRIMARY KEY,
  reporter_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  server_id    TEXT REFERENCES servers(id) ON DELETE CASCADE,  -- guild the report belongs to, when any
  target_type  TEXT NOT NULL CHECK (target_type IN ('message','user','server','channel','file')),
  target_id    TEXT NOT NULL,
  reason       TEXT NOT NULL,
  details      TEXT,
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewing','resolved','dismissed')),
  resolved_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolved_at  TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
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
  message_id     TEXT PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  channel_id     TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  question       TEXT NOT NULL,
  allow_multiple INTEGER NOT NULL DEFAULT 0,
  expires_at     TEXT,                    -- NULL = never closes on its own
  closed_at      TEXT,                    -- set when finalised, by time or by hand
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS poll_answers (
  id          TEXT PRIMARY KEY,
  message_id  TEXT NOT NULL REFERENCES polls(message_id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  text        TEXT NOT NULL,
  emoji       TEXT
);
CREATE INDEX IF NOT EXISTS idx_poll_answers_message ON poll_answers(message_id, position);

CREATE TABLE IF NOT EXISTS poll_votes (
  message_id  TEXT NOT NULL REFERENCES polls(message_id) ON DELETE CASCADE,
  answer_id   TEXT NOT NULL REFERENCES poll_answers(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
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
  id             TEXT PRIMARY KEY,
  server_id      TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  channel_id     TEXT REFERENCES channels(id) ON DELETE SET NULL,   -- voice/stage, or NULL for external
  creator_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  name           TEXT NOT NULL,
  description    TEXT,
  location       TEXT,                    -- free text when channel_id is NULL
  image_url      TEXT,
  starts_at      TEXT NOT NULL,
  ends_at        TEXT,
  status         TEXT NOT NULL DEFAULT 'scheduled'
                 CHECK (status IN ('scheduled','active','completed','cancelled')),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_events_server_start ON scheduled_events(server_id, starts_at);

CREATE TABLE IF NOT EXISTS event_interest (
  event_id    TEXT NOT NULL REFERENCES scheduled_events(id) ON DELETE CASCADE,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (event_id, user_id)
);

-- ============================================================================
--  Private notes about other users. Only the author can ever read one.
-- ============================================================================

CREATE TABLE IF NOT EXISTS user_notes (
  author_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note        TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (author_id, subject_id)
);


-- ============================================================================
--  Forum channels. A forum post is a thread whose parent is the forum; the
--  post body is the thread's first message. Tags are per-forum and a post may
--  carry up to five. `moderated` tags may only be applied by staff.
-- ============================================================================

CREATE TABLE IF NOT EXISTS forum_tags (
  id          TEXT PRIMARY KEY,
  channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  emoji       TEXT,
  moderated   INTEGER NOT NULL DEFAULT 0,
  position    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (channel_id, name)
);

CREATE TABLE IF NOT EXISTS forum_post_tags (
  thread_id   TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  tag_id      TEXT NOT NULL REFERENCES forum_tags(id) ON DELETE CASCADE,
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
  server_id    TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  channel_id   TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  description  TEXT NOT NULL,
  emoji        TEXT,
  position     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (server_id, channel_id)
);

CREATE TABLE IF NOT EXISTS onboarding_prompts (
  id           TEXT PRIMARY KEY,
  server_id    TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  single_select INTEGER NOT NULL DEFAULT 0,
  required     INTEGER NOT NULL DEFAULT 0,
  position     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS onboarding_options (
  id           TEXT PRIMARY KEY,
  prompt_id    TEXT NOT NULL REFERENCES onboarding_prompts(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  description  TEXT,
  emoji        TEXT,
  channel_ids  TEXT NOT NULL DEFAULT '[]',   -- JSON array
  role_ids     TEXT NOT NULL DEFAULT '[]',   -- JSON array
  position     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_onboarding_options_prompt ON onboarding_options(prompt_id);

CREATE TABLE IF NOT EXISTS member_onboarding (
  server_id         TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rules_accepted_at TEXT,
  completed_at      TEXT,
  answers           TEXT NOT NULL DEFAULT '{}',  -- JSON {promptId: [optionId]}
  PRIMARY KEY (server_id, user_id)
);

-- ============================================================================
--  Channel following. An announcement channel can be followed from a text
--  channel in another (or the same) server. Publishing a message there relays
--  it through a `follower` webhook into every follower channel, so the relayed
--  message shows the source server as its author.
-- ============================================================================

CREATE TABLE IF NOT EXISTS channel_follows (
  id                 TEXT PRIMARY KEY,
  source_channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  target_channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  webhook_id         TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  created_by         TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (source_channel_id, target_channel_id)
);
CREATE INDEX IF NOT EXISTS idx_channel_follows_source ON channel_follows(source_channel_id);

-- Which relayed message came from which original, so an edit/delete upstream
-- can be mirrored and a message is never relayed twice.
CREATE TABLE IF NOT EXISTS message_crossposts (
  source_message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  follow_id          TEXT NOT NULL REFERENCES channel_follows(id) ON DELETE CASCADE,
  relayed_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  PRIMARY KEY (source_message_id, follow_id)
);

-- ============================================================================
--  Server templates: a JSON snapshot of a server's structure, shared by code.
--  One template per source server (Discord's rule).
-- ============================================================================

CREATE TABLE IF NOT EXISTS server_templates (
  code              TEXT PRIMARY KEY,
  source_server_id  TEXT NOT NULL UNIQUE REFERENCES servers(id) ON DELETE CASCADE,
  creator_id        TEXT REFERENCES users(id) ON DELETE SET NULL,
  name              TEXT NOT NULL,
  description       TEXT,
  data              TEXT NOT NULL,          -- JSON, see services/templates.js
  usage_count       INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
