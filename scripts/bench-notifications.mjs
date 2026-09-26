#!/usr/bin/env node
// ============================================================================
//  Benchmark: message fan-out (unread/mention counters + notification rows)
//  and the unread summary, against a 1,000-member guild.
//
//  Usage:
//    node scripts/bench-notifications.mjs                       # SQLite (temp file)
//    BENCH_DATABASE_URL=postgres://postgres@localhost:55432/postgres \
//      node scripts/bench-notifications.mjs                     # Postgres (temp DB)
//  Env: BENCH_MEMBERS (default 1000), BENCH_MESSAGES (default 30),
//       BENCH_CHANNELS (default 25)
//
//  Everything runs in-process against a throwaway database; nothing touches
//  discord.db or DATABASE_URL.
// ============================================================================

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';

const MEMBERS = Number(process.env.BENCH_MEMBERS || 1000);
const MESSAGES = Number(process.env.BENCH_MESSAGES || 30);
const CHANNELS = Number(process.env.BENCH_CHANNELS || 25);
const PG_ADMIN = process.env.BENCH_DATABASE_URL || '';

process.env.NODE_TEST_CONTEXT ??= 'bench';   // keep db.js quiet
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-notif-'));
let pgName = null;
if (PG_ADMIN) {
  pgName = `bench_${process.pid}_${crypto.randomBytes(3).toString('hex')}`;
  const { default: pg } = await import('pg');
  const c = new pg.Client({ connectionString: PG_ADMIN });
  await c.connect(); await c.query(`CREATE DATABASE "${pgName}"`); await c.end();
  const url = new URL(PG_ADMIN); url.pathname = `/${pgName}`;
  process.env.DATABASE_URL = url.toString();
} else {
  delete process.env.DATABASE_URL;
  process.env.DB_PATH = path.join(tmp, 'bench.db');
}
process.env.STORAGE_ROOT = path.join(tmp, 'uploads');

const db = await import('../db.js');
await db.initDB({ seed: false });
const { runQuery, transaction } = db;
const { DEFAULT_PERMISSIONS } = await import('../lib/permissions.js');
const messages = await import('../services/messages.js');

const SERVER = 'bench-server';
const AUTHOR = 'bench-author';
const everyonePerms = String(DEFAULT_PERMISSIONS);

async function fixture() {
  await transaction(async () => {
    await runQuery(`INSERT INTO users (id, username, display_name, status) VALUES (?, ?, ?, 'online')`,
      [AUTHOR, 'author', 'Author']);
    for (let i = 0; i < MEMBERS; i += 1) {
      await runQuery(`INSERT INTO users (id, username, display_name, status) VALUES (?, ?, ?, ?)`,
        [`bench-u${i}`, `u${i}`, `User ${i}`, i % 3 === 0 ? 'online' : 'offline']);
    }
    await runQuery(`INSERT INTO servers (id, name, owner_id) VALUES (?, 'Bench', ?)`, [SERVER, AUTHOR]);
    await runQuery(`INSERT INTO roles (id, server_id, name, permissions, is_everyone) VALUES (?, ?, '@everyone', ?, 1)`,
      [SERVER, SERVER, everyonePerms]);
    await runQuery(`INSERT INTO roles (id, server_id, name, permissions, mentionable, position) VALUES ('bench-role', ?, 'Team', '0', 1, 1)`,
      [SERVER]);
    await runQuery(`INSERT INTO server_members (server_id, user_id) VALUES (?, ?)`, [SERVER, AUTHOR]);
    await runQuery(`INSERT INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)`, [SERVER, AUTHOR, SERVER]);
    for (let i = 0; i < MEMBERS; i += 1) {
      await runQuery(`INSERT INTO server_members (server_id, user_id) VALUES (?, ?)`, [SERVER, `bench-u${i}`]);
      await runQuery(`INSERT INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, ?)`, [SERVER, `bench-u${i}`, SERVER]);
      if (i % 10 === 0) {
        await runQuery(`INSERT INTO member_roles (server_id, user_id, role_id) VALUES (?, ?, 'bench-role')`, [SERVER, `bench-u${i}`]);
      }
    }
    for (let c = 0; c < CHANNELS; c += 1) {
      await runQuery(`INSERT INTO channels (id, server_id, name, type, position) VALUES (?, ?, ?, 'text', ?)`,
        [`bench-c${c}`, SERVER, `chan-${c}`, c]);
    }
  });
}

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const pick = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { mean: mean.toFixed(1), p50: pick(0.5).toFixed(1), p95: pick(0.95).toFixed(1), max: s[s.length - 1].toFixed(1) };
};

try {
  const t0 = performance.now();
  await fixture();
  console.log(`fixture: ${MEMBERS} members, ${CHANNELS} channels in ${(performance.now() - t0).toFixed(0)} ms (${db.DIALECT})`);

  const kinds = {
    plain: () => 'hello there, nothing special',
    mention: () => `hey <@bench-u${Math.floor(Math.random() * MEMBERS)}> look`,
    role: () => 'calling <@&bench-role>',
    everyone: () => '@everyone announcement'
  };
  const results = {};
  // Warm-up.
  await messages.createMessage({ channelId: 'bench-c0', userId: AUTHOR, content: 'warm up' });
  for (const [kind, content] of Object.entries(kinds)) {
    const times = [];
    for (let i = 0; i < MESSAGES; i += 1) {
      const start = performance.now();
      await messages.createMessage({ channelId: `bench-c${i % CHANNELS}`, userId: AUTHOR, content: content() });
      times.push(performance.now() - start);
    }
    results[kind] = stats(times);
  }
  const summaryTimes = [];
  for (let i = 0; i < 10; i += 1) {
    const start = performance.now();
    await messages.getUnreadSummary(`bench-u${i}`);
    summaryTimes.push(performance.now() - start);
  }
  results.unreadSummary = stats(summaryTimes);
  console.log(`createMessage latency (ms) per kind, ${MESSAGES} sends each; getUnreadSummary x10:`);
  console.table(results);
} finally {
  await db.closeDB();
  if (pgName) {
    const { default: pg } = await import('pg');
    const c = new pg.Client({ connectionString: PG_ADMIN });
    await c.connect(); await c.query(`DROP DATABASE IF EXISTS "${pgName}" WITH (FORCE)`); await c.end();
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}
