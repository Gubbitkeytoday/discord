#!/usr/bin/env node
// Build a realistic SQLite database for migration tests:
//
//   node scripts/fixtures/build-sqlite-fixture.mjs /path/to/out.db
//
// Seed data, then activity through the real services (so every row is shaped
// exactly as the app writes it), plus a few rows written the way older builds
// or hand edits did (datetime()-style timestamps, compact JSON), which the
// migration tool has to convert.

import path from 'path';

const out = process.argv[2];
if (!out) {
  console.error('usage: build-sqlite-fixture.mjs <out.db>');
  process.exit(2);
}
process.env.DB_PATH = path.resolve(out);
process.env.NODE_TEST_CONTEXT ??= '1';
delete process.env.DATABASE_URL;

const db = await import('../../db.js');
await db.initDB({ seed: true });

const messages = await import('../../services/messages.js');
const guilds = await import('../../services/guilds.js');
const settings = await import('../../services/userSettings.js');

const server = await guilds.createServer({ name: 'Fixture ทดสอบ', ownerId: 'user-me' });
const serverId = server.id ?? server.server?.id;
await guilds.createInvite({ serverId: 'server-1', channelId: 'chan-102', inviterId: 'user-me', maxUses: 3 });

const thai = await messages.createMessage({
  channelId: 'chan-102', userId: 'user-me', content: 'ทดสอบรูปภาพสวยงาม <@user-2> migration'
});
await messages.editMessage({ messageId: thai.id, userId: 'user-me', content: 'ทดสอบรูปภาพสวยงามมาก <@user-2>' });
await messages.toggleReaction({ messageId: thai.id, userId: 'user-2', emoji: '🔥' });
for (let i = 0; i < 25; i += 1) {
  await messages.createMessage({ channelId: 'chan-103', userId: i % 2 ? 'user-2' : 'user-me', content: `bulk ${i} "quoted" 'single' \\ back` });
}
await settings.updateCategory('user-me', 'appearance', { theme: 'dark', zoom: 110, nested: { a: [1, 2] } });

// Rows as older builds / manual edits wrote them.
await db.runQuery(
  `INSERT INTO notifications (id, user_id, type, body, created_at) VALUES ('fx-legacy-ts', 'user-me', 'dm', 'legacy', '2024-01-02 03:04:05')`
);
await db.runQuery(
  `INSERT INTO audit_logs (id, server_id, user_id, action_type, changes, created_at)
   VALUES ('fx-audit', 'server-1', 'user-me', 'TEST', '[{"key":"name","old":"a","new":"b"}]', '2024-05-06T07:08:09.123Z')`
);

await db.closeDB();
console.log(JSON.stringify({ ok: true, serverId, message: thai.id }));
