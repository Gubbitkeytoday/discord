// Development seed data.
//
// Seed IDs are intentionally human-readable ('user-me', 'chan-102') rather than
// snowflakes — the frontend boots with currentUserId = 'user-me'. Everything
// created at runtime uses generateId().

import { generateId, snowflakeForDate } from '../lib/snowflake.js';
import { hashPassword } from '../lib/auth.js';
import { DEFAULT_PERMISSIONS, ALL_PERMISSIONS, fromNames } from '../lib/permissions.js';

const now = () => new Date().toISOString();

/** Dev-only password for every seeded account. */
export const SEED_PASSWORD = 'antigravity123';

export const SEED_USERS = [
  { id: 'user-me', username: 'AlexPro', display_name: 'Alex (You)', avatar_url: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?w=150', banner_url: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=600', bio: 'Full-stack Developer & Gamer 🚀', status: 'online', is_bot: 0 },
  { id: 'user-2',  username: 'CyberNinja', display_name: 'Kira ~ 🦊', avatar_url: 'https://images.unsplash.com/photo-1570295999919-56ceb5ecca61?w=150', banner_url: 'https://images.unsplash.com/photo-1550745165-9bc0b252726f?w=600', bio: 'UI Designer & Web3 enthusiast', status: 'online', is_bot: 0 },
  { id: 'user-3',  username: 'ChillBot', display_name: 'Antigravity AI 🤖', avatar_url: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=150', banner_url: '', bio: 'Your helpful Discord Assistant', status: 'dnd', is_bot: 1 },
  { id: 'user-4',  username: 'GamerGirl99', display_name: 'Sarah', avatar_url: 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=150', banner_url: '', bio: 'Streaming Valorant & Apex Legends!', status: 'idle', is_bot: 0 },
  { id: 'user-5',  username: 'CodeMaster', display_name: 'David G.', avatar_url: 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150', banner_url: '', bio: 'Rust & TypeScript fan', status: 'offline', is_bot: 0 }
];

const SEED_SERVERS = [
  { id: 'server-1', name: 'Antigravity HQ', icon_url: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=150', owner_id: 'user-me', description: 'บ้านหลักของทีม Antigravity' },
  { id: 'server-2', name: 'Gamers Haven 🎮', icon_url: 'https://images.unsplash.com/photo-1542751371-adc38448a05e?w=150', owner_id: 'user-2', description: 'ห้องรวมเกมเมอร์' },
  { id: 'server-3', name: 'Developers & Tech 💻', icon_url: 'https://images.unsplash.com/photo-1526374965328-7f61d4dc18c5?w=150', owner_id: 'user-me', description: 'คุยเรื่องโค้ดและเทคโนโลยี' }
];

// role key -> definition. `everyone` is created for every server automatically.
const SEED_ROLES = {
  'server-1': [
    { id: 'role-1-admin', name: 'Admin', color: '#f04747', position: 90, hoist: 1, mentionable: 1, permissions: fromNames(['ADMINISTRATOR']) },
    { id: 'role-1-mod',   name: 'Moderator', color: '#faa61a', position: 60, hoist: 1, mentionable: 1, permissions: fromNames(['KICK_MEMBERS','BAN_MEMBERS','MANAGE_MESSAGES','MODERATE_MEMBERS','MANAGE_THREADS','VIEW_AUDIT_LOG','MUTE_MEMBERS','DEAFEN_MEMBERS','MOVE_MEMBERS']) },
    { id: 'role-1-bot',   name: 'Bot', color: '#5865f2', position: 40, hoist: 0, mentionable: 0, managed: 1, permissions: fromNames(['SEND_MESSAGES','EMBED_LINKS','ATTACH_FILES','READ_MESSAGE_HISTORY','ADD_REACTIONS','VIEW_CHANNEL']) },
    { id: 'role-1-dev',   name: 'Developer', color: '#43b581', position: 20, hoist: 1, mentionable: 1, permissions: '0' }
  ],
  'server-2': [
    { id: 'role-2-admin', name: 'Admin', color: '#f04747', position: 90, hoist: 1, mentionable: 1, permissions: fromNames(['ADMINISTRATOR']) },
    { id: 'role-2-vip',   name: 'VIP', color: '#e91e63', position: 30, hoist: 1, mentionable: 1, permissions: '0' }
  ],
  'server-3': [
    { id: 'role-3-admin', name: 'Admin', color: '#f04747', position: 90, hoist: 1, mentionable: 1, permissions: fromNames(['ADMINISTRATOR']) }
  ]
};

const SEED_MEMBERS = [
  { server_id: 'server-1', user_id: 'user-me', roles: ['role-1-admin', 'role-1-dev'] },
  { server_id: 'server-1', user_id: 'user-2',  roles: ['role-1-admin'] },
  { server_id: 'server-1', user_id: 'user-3',  roles: ['role-1-bot'] },
  { server_id: 'server-1', user_id: 'user-4',  roles: ['role-1-mod'] },
  { server_id: 'server-1', user_id: 'user-5',  roles: ['role-1-dev'] },
  { server_id: 'server-2', user_id: 'user-2',  roles: ['role-2-admin'] },
  { server_id: 'server-2', user_id: 'user-me', roles: ['role-2-vip'] },
  { server_id: 'server-2', user_id: 'user-4',  roles: ['role-2-admin'] },
  { server_id: 'server-3', user_id: 'user-me', roles: ['role-3-admin'] },
  { server_id: 'server-3', user_id: 'user-5',  roles: ['role-3-admin'] }
];

const SEED_CHANNELS = [
  // Server 1
  { id: 'cat-1-info',  server_id: 'server-1', name: 'INFORMATION',    type: 'category', position: 0 },
  { id: 'chan-101',    server_id: 'server-1', name: 'welcome-announcements', type: 'announcement', parent_id: 'cat-1-info', position: 1, topic: 'ประกาศสำคัญจากทีมงาน' },
  { id: 'cat-1-text',  server_id: 'server-1', name: 'TEXT CHANNELS',  type: 'category', position: 2 },
  { id: 'chan-102',    server_id: 'server-1', name: 'general-chat',   type: 'text', parent_id: 'cat-1-text', position: 3, topic: 'คุยเล่นได้ทุกเรื่อง' },
  { id: 'chan-103',    server_id: 'server-1', name: 'memes-and-fun',  type: 'text', parent_id: 'cat-1-text', position: 4 },
  { id: 'chan-106',    server_id: 'server-1', name: 'help-forum',     type: 'forum', parent_id: 'cat-1-text', position: 5, topic: 'ถาม-ตอบ ตั้งกระทู้ใหม่ได้เลย' },
  { id: 'cat-1-voice', server_id: 'server-1', name: 'VOICE CHANNELS', type: 'category', position: 5 },
  { id: 'chan-104',    server_id: 'server-1', name: 'General Voice',  type: 'voice', parent_id: 'cat-1-voice', position: 6, bitrate: 64000, user_limit: 0 },
  { id: 'chan-105',    server_id: 'server-1', name: 'Gaming Lounge',  type: 'voice', parent_id: 'cat-1-voice', position: 7, bitrate: 96000, user_limit: 10 },
  // Server 2
  { id: 'cat-2-text',  server_id: 'server-2', name: 'TEXT CHANNELS',  type: 'category', position: 0 },
  { id: 'chan-201',    server_id: 'server-2', name: 'lobby',          type: 'text', parent_id: 'cat-2-text', position: 1 },
  { id: 'chan-202',    server_id: 'server-2', name: 'clips-and-highlights', type: 'text', parent_id: 'cat-2-text', position: 2 },
  { id: 'cat-2-voice', server_id: 'server-2', name: 'VOICE CHANNELS', type: 'category', position: 3 },
  { id: 'chan-203',    server_id: 'server-2', name: 'Squad Voice 1',  type: 'voice', parent_id: 'cat-2-voice', position: 4, bitrate: 64000, user_limit: 5 },
  // Server 3
  { id: 'cat-3-prog',  server_id: 'server-3', name: 'PROGRAMMING',    type: 'category', position: 0 },
  { id: 'chan-301',    server_id: 'server-3', name: 'react-js',       type: 'text', parent_id: 'cat-3-prog', position: 1 },
  { id: 'chan-302',    server_id: 'server-3', name: 'node-backend',   type: 'text', parent_id: 'cat-3-prog', position: 2 }
];

// Message ids MUST be snowflakes, never 'msg-N'. Everything that reads a
// channel orders and paginates by id, and a non-numeric id sorts after every
// snowflake — which silently puts seeded messages at the end of history and
// breaks `before=` pagination. Backdate them so they precede runtime messages.
const SEED_BASE_TIME = Date.now() - 3 * 60 * 60 * 1000;
const seedMessageTime = (index) => new Date(SEED_BASE_TIME + index * 60_000);
const seedMessageId = (index) => snowflakeForDate(seedMessageTime(index));

const SEED_MESSAGES = [
  { id: seedMessageId(0), channel_id: 'chan-101', server_id: 'server-1', user_id: 'user-3', content: '🎉 ยินดีต้อนรับทุกคนเข้าสู่ Antigravity Discord Server!', reactions: { '🎉': ['user-me','user-2','user-4','user-5'], '🚀': ['user-me','user-2','user-4'] } },
  { id: seedMessageId(1), channel_id: 'chan-102', server_id: 'server-1', user_id: 'user-2', content: 'สวัสดีทุกคน! ตื่นเต้นมากที่ได้สร้าง Discord ของเราเองวันนี้ 🔥', reactions: { '❤️': ['user-me','user-4'] } },
  { id: seedMessageId(2), channel_id: 'chan-102', server_id: 'server-1', user_id: 'user-me', content: 'จัดไปเลยครับ! ระบบ Real-time แชท + ช่องเสียง พร้อมใช้แล้ว!', reactions: { '💯': ['user-2','user-3','user-4','user-5'] } },
  { id: seedMessageId(3), channel_id: 'chan-102', server_id: 'server-1', user_id: 'user-4', content: 'ใครว่างบ้าง คืนนี้เจอกันในห้อง General Voice นะ 🔊🎮', reactions: { '👍': ['user-me','user-2','user-5'] } }
];

const SEED_FRIENDS = [
  { id: 'fr-1', user_id: 'user-me', friend_id: 'user-2', status: 'accepted' },
  { id: 'fr-2', user_id: 'user-me', friend_id: 'user-4', status: 'accepted' },
  { id: 'fr-3', user_id: 'user-me', friend_id: 'user-5', status: 'pending' }
];

const SEED_EMOJIS = [
  { id: 'emoji-1', server_id: 'server-1', name: 'antigravity', url: 'https://images.unsplash.com/photo-1618005182384-a83a8bd57fbe?w=64', creator_id: 'user-me' },
  { id: 'emoji-2', server_id: 'server-1', name: 'pogchamp',    url: 'https://images.unsplash.com/photo-1542751371-adc38448a05e?w=64', creator_id: 'user-2' }
];

/**
 * Populate an empty database. Safe to call on every boot — it no-ops when the
 * users table already has rows.
 */
export async function seedDatabase({ runQuery, getQuery, transaction }) {
  const { count } = await getQuery(`SELECT count(*) AS count FROM users`);
  if (count > 0) return false;

  console.log('🌱 Seeding development data...');

  // Every seed account gets the same dev password so the account switcher can
  // perform a real login. Hashed once — scrypt is deliberately slow.
  const devPasswordHash = await hashPassword(SEED_PASSWORD);

  await transaction(async () => {
    for (const u of SEED_USERS) {
      await runQuery(
        `INSERT INTO users (id, username, discriminator, display_name, avatar_url, banner_url,
                            bio, status, is_bot, email_verified, email, password_hash,
                            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
        [u.id, u.username, String(1000 + SEED_USERS.indexOf(u)), u.display_name,
         u.avatar_url, u.banner_url, u.bio, u.status, u.is_bot,
         `${u.username.toLowerCase()}@example.dev`, devPasswordHash, now(), now()]
      );
    }

    for (const s of SEED_SERVERS) {
      await runQuery(
        `INSERT INTO servers (id, name, description, icon_url, owner_id, system_channel_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
        [s.id, s.name, s.description, s.icon_url, s.owner_id, now(), now()]
      );

      // Every guild gets an @everyone role whose id equals the guild id, matching
      // Discord's convention.
      await runQuery(
        `INSERT INTO roles (id, server_id, name, position, permissions, is_everyone, created_at)
         VALUES (?, ?, '@everyone', 0, ?, 1, ?)`,
        [s.id, s.id, DEFAULT_PERMISSIONS, now()]
      );

      for (const r of SEED_ROLES[s.id] ?? []) {
        await runQuery(
          `INSERT INTO roles (id, server_id, name, color, position, permissions, hoist, mentionable, managed, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [r.id, s.id, r.name, r.color ?? null, r.position, r.permissions,
           r.hoist ?? 0, r.mentionable ?? 0, r.managed ?? 0, now()]
        );
      }
    }

    for (const m of SEED_MEMBERS) {
      await runQuery(
        `INSERT INTO server_members (server_id, user_id, joined_at) VALUES (?, ?, ?)`,
        [m.server_id, m.user_id, now()]
      );
      // @everyone is implicit (role id === server id) but stored explicitly so
      // permission joins need no special case.
      for (const roleId of [m.server_id, ...m.roles]) {
        await runQuery(
          `INSERT INTO member_roles (server_id, user_id, role_id, assigned_at) VALUES (?, ?, ?, ?)`,
          [m.server_id, m.user_id, roleId, now()]
        );
      }
      await runQuery(
        `INSERT INTO server_settings (user_id, server_id, position) VALUES (?, ?, ?)`,
        [m.user_id, m.server_id, SEED_SERVERS.findIndex((s) => s.id === m.server_id)]
      );
    }

    for (const s of SEED_SERVERS) {
      const { c } = await getQuery(
        `SELECT count(*) AS c FROM server_members WHERE server_id = ?`, [s.id]
      );
      await runQuery(`UPDATE servers SET member_count = ? WHERE id = ?`, [c, s.id]);
    }

    for (const c of SEED_CHANNELS) {
      await runQuery(
        `INSERT INTO channels (id, server_id, parent_id, name, type, topic, position,
                               bitrate, user_limit, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [c.id, c.server_id, c.parent_id ?? null, c.name, c.type, c.topic ?? null,
         c.position, c.bitrate ?? null, c.user_limit ?? null, now(), now()]
      );
    }

    await runQuery(`UPDATE servers SET system_channel_id = 'chan-102' WHERE id = 'server-1'`);

    // Forum tags for #help-forum. Posts themselves are created by users.
    const forumTags = [
      ['tag-106-question', 'Question', '❓', 0, 0],
      ['tag-106-bug',      'Bug',      '🐛', 0, 1],
      ['tag-106-solved',   'Solved',   '✅', 1, 2]   // moderated: staff-only
    ];
    for (const [id, name, emoji, moderated, position] of forumTags) {
      await runQuery(
        `INSERT INTO forum_tags (id, channel_id, name, emoji, moderated, position) VALUES (?, 'chan-106', ?, ?, ?, ?)`,
        [id, name, emoji, moderated, position]
      );
    }
    await runQuery(`UPDATE servers SET rules_channel_id  = 'chan-101' WHERE id = 'server-1'`);

    for (const [index, msg] of SEED_MESSAGES.entries()) {
      // created_at must agree with the id — both derive from the same instant.
      const createdAt = seedMessageTime(index).toISOString();
      await runQuery(
        `INSERT INTO messages (id, channel_id, server_id, user_id, content, type, created_at)
         VALUES (?, ?, ?, ?, ?, 'default', ?)`,
        [msg.id, msg.channel_id, msg.server_id, msg.user_id, msg.content, createdAt]
      );
      await runQuery(
        `INSERT INTO messages_fts (content, message_id, channel_id) VALUES (?, ?, ?)`,
        [msg.content, msg.id, msg.channel_id]
      );
      for (const [emoji, userIds] of Object.entries(msg.reactions ?? {})) {
        for (const userId of userIds) {
          await runQuery(
            `INSERT INTO reactions (message_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?)`,
            [msg.id, userId, emoji, now()]
          );
        }
      }
      await runQuery(
        `UPDATE channels SET last_message_id = ?, message_count = message_count + 1 WHERE id = ?`,
        [msg.id, msg.channel_id]
      );
    }

    for (const f of SEED_FRIENDS) {
      await runQuery(
        `INSERT INTO friends (id, user_id, friend_id, status, requested_by, created_at, accepted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [f.id, f.user_id, f.friend_id, f.status, f.user_id, now(),
         f.status === 'accepted' ? now() : null]
      );
    }

    for (const e of SEED_EMOJIS) {
      await runQuery(
        `INSERT INTO emojis (id, server_id, name, url, creator_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
        [e.id, e.server_id, e.name, e.url, e.creator_id, now()]
      );
    }

    // A seeded DM so the Home view has something to show.
    const dmId = 'dm-me-2';
    await runQuery(
      `INSERT INTO channels (id, server_id, name, type, created_at, updated_at)
       VALUES (?, NULL, NULL, 'dm', ?, ?)`,
      [dmId, now(), now()]
    );
    for (const uid of ['user-me', 'user-2']) {
      await runQuery(
        `INSERT INTO channel_recipients (channel_id, user_id, joined_at) VALUES (?, ?, ?)`,
        [dmId, uid, now()]
      );
    }
    const dmMsgId = generateId();
    await runQuery(
      `INSERT INTO messages (id, channel_id, user_id, content, type, created_at)
       VALUES (?, ?, 'user-2', 'เดี๋ยวเจอกันในห้อง voice นะ 😄', 'default', ?)`,
      [dmMsgId, dmId, now()]
    );
    await runQuery(`UPDATE channels SET last_message_id = ? WHERE id = ?`, [dmMsgId, dmId]);
  });

  console.log('✅ Seed complete.');
  return true;
}

export { ALL_PERMISSIONS };
