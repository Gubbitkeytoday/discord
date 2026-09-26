#!/usr/bin/env node
// ============================================================================
//  Seed a throwaway database through the public API, and write a fixture file
//  every other scenario reads.
//
//    node scripts/load/seed.mjs --url http://127.0.0.1:5750 --users 2000 \
//         --guilds 10 --channels 2 --history 500 --out /tmp/lt/fixture.json
//
//  Order matters for speed, and mirrors a guild that grew over time:
//    1. owners register and create guilds + extra text channels,
//    2. owners post `--history` messages per channel while the guild is still
//       small (createMessage fans unread counters out to every member, so a
//       message in a 200-member guild costs ~200x more than in a 1-member one),
//    3. members register (scrypt-bound, parallel) and accept an invite.
//
//  The server must run with RATE_LIMIT_REGISTER_PER_HOUR and
//  RATE_LIMIT_WRITE_PER_MIN raised (start-server.sh does that); each
//  registration also carries a distinct X-Forwarded-For so per-IP limits see
//  distinct clients.
// ============================================================================

import { parseArgs, makeClient, pool, fakeIp, writeJson } from './lib.mjs';

const args = parseArgs(undefined, {
  url: 'http://127.0.0.1:5750',
  users: 500,
  guilds: 10,
  channels: 2,          // text channels per guild (including #general)
  history: 300,         // messages per text channel
  concurrency: 16,
  password: 'LoadTest#2026',
  prefix: `lt${Date.now().toString(36).slice(-4)}`,
  out: 'fixture.json'
});

const api = makeClient(args.url, { retry429: true });
const t0 = Date.now();
const log = (...a) => console.log(`[seed +${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);

const WORDS = ('alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima mike '
  + 'november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu '
  + 'deploy release rollback incident latency database cache socket render payment invoice '
  + 'สวัสดี ทดสอบ ประชุม งาน ข้อความ').split(' ');
const sentence = (i) => {
  const n = 4 + (i % 12);
  const words = [];
  for (let k = 0; k < n; k += 1) words.push(WORDS[(i * 7 + k * 13) % WORDS.length]);
  return `${words.join(' ')} #${i}`;
};

async function register(username, ipN) {
  const r = await api('POST', '/api/auth/register', {
    ip: fakeIp(ipN),
    body: { username, password: args.password, email: `${username}@load.test`, device: 'loadtest' }
  });
  return { id: r.user.id, username, token: r.token };
}

// --- 1. owners, guilds, channels ----------------------------------------------
const guilds = [];
for (let g = 0; g < args.guilds; g += 1) {
  const owner = await register(`${args.prefix}_owner${g}`, 60000 + g);
  const server = await api('POST', '/api/servers', { token: owner.token, body: { name: `Load Guild ${g}` } });
  for (let c = 1; c < args.channels; c += 1) {
    await api('POST', '/api/channels', {
      token: owner.token, body: { server_id: server.id, name: `chat-${c}`, type: 'text' }
    });
  }
  const detail = await api('GET', `/api/servers/${server.id}`, { token: owner.token });
  const channels = detail.channels.filter((ch) => ch.type === 'text').map((ch) => ch.id);
  const invite = await api('POST', `/api/servers/${server.id}/invites`, {
    token: owner.token, body: { maxUses: 0, maxAge: 0 }
  });
  guilds.push({ id: server.id, name: server.name, owner, channels, invite: invite.code });
}
log(`created ${guilds.length} guilds × ${args.channels} text channels`);

// --- 2. history -----------------------------------------------------------------
const tHist = Date.now();
let posted = 0;
const jobs = [];
for (const g of guilds) for (const ch of g.channels) jobs.push({ g, ch });
await pool(jobs, Math.min(args.concurrency, jobs.length), async ({ g, ch }) => {
  for (let i = 0; i < args.history; i += 1) {
    await api('POST', '/api/messages', {
      token: g.owner.token, body: { channel_id: ch, content: sentence(posted + i) }
    });
    posted += 1;
  }
});
const histSecs = (Date.now() - tHist) / 1000;
log(`posted ${posted} history messages in ${histSecs.toFixed(1)}s (${(posted / histSecs).toFixed(0)} msg/s, 1-member guilds)`);

// --- 3. members -----------------------------------------------------------------
const tReg = Date.now();
const users = await pool([...Array(args.users).keys()], args.concurrency, async (i) => {
  const u = await register(`${args.prefix}_u${i}`, i + 1);
  u.guild = i % guilds.length;
  if (i && i % 250 === 0) log(`registered ${i}`);
  return u;
});
const regSecs = (Date.now() - tReg) / 1000;
log(`registered ${users.length} users in ${regSecs.toFixed(1)}s (${(users.length / regSecs).toFixed(0)}/s)`);

const tJoin = Date.now();
const joinLat = [];
await pool(users, args.concurrency, async (u) => {
  const s = Date.now();
  await api('POST', `/api/invites/${guilds[u.guild].invite}/accept`, { token: u.token });
  joinLat.push(Date.now() - s);
});
joinLat.sort((a, b) => a - b);
const joinSecs = (Date.now() - tJoin) / 1000;
log(`joined in ${joinSecs.toFixed(1)}s; accept p50 ${joinLat[joinLat.length >> 1]}ms p95 ${joinLat[Math.floor(joinLat.length * 0.95)]}ms (last-joiner cost grows with guild size)`);

const fixture = {
  url: args.url,
  password: args.password,
  created_at: new Date().toISOString(),
  guilds: guilds.map((g) => ({ id: g.id, name: g.name, channels: g.channels, owner: g.owner, invite: g.invite })),
  users,
  seed_stats: {
    history_msgs: posted, history_msgs_per_s: +(posted / histSecs).toFixed(1),
    register_per_s: +(users.length / regSecs).toFixed(1),
    join_per_s: +(users.length / joinSecs).toFixed(1),
    join_p50_ms: joinLat[joinLat.length >> 1], join_p95_ms: joinLat[Math.floor(joinLat.length * 0.95)]
  }
};
writeJson(args.out, fixture);
log(`fixture → ${args.out}`);
