// Schema v43 — integration round.
//
//   v43  messages.forwarded_from — JSON snapshot of the message a forward was
//        made from: {message_id, channel_id, channel_name, guild_id,
//        author_name, created_at}. Only metadata is kept: the forwarded
//        content is copied into the new message's own content/attachments at
//        send time, after the server has checked the sender can read the
//        source, so later edits/deletes of the source never leak through.

async function addColumnSqlite({ allQuery, runQuery }, table, column, ddl) {
  const cols = await allQuery(`PRAGMA table_info(${table})`);
  if (!cols.some((c) => c.name === column)) await runQuery(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

export const INTEGRATION_MIGRATIONS = [
  {
    version: 43,
    name: 'message forwarding snapshot metadata',
    up: async (db) => {
      await addColumnSqlite(db, 'messages', 'forwarded_from', 'TEXT');
    },
    postgres: async ({ runQuery }) => {
      await runQuery(`ALTER TABLE messages ADD COLUMN IF NOT EXISTS forwarded_from TEXT`);
    }
  }
];
