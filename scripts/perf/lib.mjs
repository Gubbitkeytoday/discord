// ============================================================================
//  Shared helpers for the frontend performance scripts in scripts/perf/.
//
//  - bootServer(): starts `node server.js` with SERVE_STATIC=1 on a throwaway
//    SQLite DB + storage dir (same approach as scripts/e2e/run.mjs), with the
//    write/register rate limits raised so a benchmark can seed thousands of
//    messages through the real HTTP API. Only the PID it spawned is stopped.
//  - Api: tiny bearer-token client for the REST API.
//  - seedWorld(): users, one guild, N text channels, a long channel with M
//    messages (mixed plain / markdown / code / mentions / image attachments),
//    avatars uploaded as large PNGs so image sizing is measurable.
//
//  Env: PERF_PORT (default 5950), PERF_OUT (results dir), CHROMIUM_PATH.
// ============================================================================

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const PORT = Number(process.env.PERF_PORT || 5950);
export const BASE = `http://localhost:${PORT}`;
export const CHROMIUM = process.env.CHROMIUM_PATH || process.env.CHROME_PATH || '/opt/pw-browsers/chromium';
export const OUT = process.env.PERF_OUT || path.join(os.tmpdir(), 'discord-perf');
export const PASSWORD = 'correct-horse-battery-9';
fs.mkdirSync(OUT, { recursive: true });

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function writeJson(name, data) {
  const file = path.join(OUT, name);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

// --- server lifecycle -------------------------------------------------------
export async function bootServer({ keep = false, env = {} } = {}) {
  if (!env.STATIC_DIR && !fs.existsSync(path.join(ROOT, 'dist/index.html'))) throw new Error('dist/ missing — run `npm run build` first');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-discord-'));
  let log = '';
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      PORT: String(PORT),
      HOST: '127.0.0.1',
      PUBLIC_URL: BASE,
      CORS_ORIGIN: '',
      DB_PATH: path.join(tmp, 'perf.db'),
      STORAGE_ROOT: path.join(tmp, 'uploads'),
      SERVE_STATIC: '1',
      ALLOW_DEV_IDENTITY: '0',
      MAIL_TRANSPORT: 'console',
      LOG_LEVEL: 'warn',
      LOG_FORMAT: 'pretty',
      RATE_LIMIT_WRITE_PER_MIN: '1000000',
      RATE_LIMIT_REGISTER_PER_HOUR: '100000',
      ...env
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early:\n${log}`);
    try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* not yet */ }
    await sleep(200);
  }
  const stop = () => {
    if (child.exitCode === null) child.kill('SIGTERM');
    if (!keep) fs.rmSync(tmp, { recursive: true, force: true });
  };
  process.on('exit', stop);
  process.on('SIGINT', () => { stop(); process.exit(130); });
  return { child, tmp, stop, log: () => log };
}

// --- API client -------------------------------------------------------------
export class Api {
  constructor(token = null, user = null) { this.token = token; this.user = user; }
  async req(method, url, body, { raw = false } = {}) {
    const headers = { Origin: BASE };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await fetch(BASE + url, { method, headers, body: payload });
    if (raw) return res;
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    if (!res.ok) throw new Error(`${method} ${url} → ${res.status} ${text.slice(0, 200)}`);
    return json;
  }
  get(u) { return this.req('GET', u); }
  post(u, b) { return this.req('POST', u, b ?? {}); }
  put(u, b) { return this.req('PUT', u, b ?? {}); }
  static async register(username) {
    const r = await new Api().post('/api/auth/register', { username, password: PASSWORD });
    return new Api(r.token, r.user);
  }
}

/** A solid-colour RGB PNG (no image library needed). */
export function makePng(w, h, rgb = [88, 101, 242]) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => { let c = 0xffffffff; for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  // Noisy rows so the PNG does not compress to nothing (closer to a photo).
  const rows = [];
  for (let y = 0; y < h; y += 1) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x += 1) {
      const n = (x * 7 + y * 13 + ((x * y) % 17)) & 63;
      row[1 + x * 3] = (rgb[0] + n) & 255; row[2 + x * 3] = (rgb[1] + n) & 255; row[3 + x * 3] = (rgb[2] + n) & 255;
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))
  ]);
}

async function uploadFile(api, url, field, buf, name) {
  const fd = new FormData();
  fd.append(field, new Blob([buf], { type: 'image/png' }), name);
  return api.req('POST', url, fd);
}

const SAMPLES = [
  (i) => `plain message number ${i} — lorem ipsum dolor sit amet, consectetur adipiscing elit`,
  (i) => `**bold ${i}** and *italic* with \`inline code\` and ~~strike~~ ok`,
  (i) => `multi-line ${i}\nsecond line of the message\nthird line with more words in it`,
  (i) => `\`\`\`js\nconst n = ${i};\nfunction f(x) { return x * n; }\nconsole.log(f(2));\n\`\`\``,
  (i) => `> quoted text ${i}\nreply to the quote with an emoji :smile: 🎉`,
  (i) => `short ${i}`,
  (i) => `สวัสดีครับ ข้อความภาษาไทยหมายเลข ${i} ทดสอบการแสดงผลฟอนต์`,
  (i) => `||spoiler ${i}|| and a longer sentence that wraps across the line on a normal desktop viewport width for sure`
];

/** Run `fn` over items with bounded concurrency. */
export async function pool(items, n, fn) {
  let i = 0;
  const workers = Array.from({ length: n }, async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
  });
  await Promise.all(workers);
}

/**
 * Seed: viewer + authors, one guild, `channels` text channels, one long channel.
 * Messages are sent by `authors` accounts round-robin in runs of 1-4 so
 * grouping looks like a real chat. Every `imageEvery`-th message carries a
 * 1600x1200 PNG attachment.
 */
export async function seedWorld({ run = Math.random().toString(36).slice(2, 7), messages = 5000, channels = 21, authors = 10, imageEvery = 100, avatarPx = 1024, log = console.log } = {}) {
  const t0 = Date.now();
  const viewer = await Api.register(`viewer_${run}`);
  const lhUser = await Api.register(`lh_${run}`);
  const authorApis = [];
  for (let i = 0; i < authors; i += 1) authorApis.push(await Api.register(`author${i}_${run}`));

  // Large avatars: the client renders them at 40px.
  const avatar = makePng(avatarPx, avatarPx);
  for (const [i, a] of [viewer, ...authorApis].entries()) {
    const up = await uploadFile(a, '/api/upload/avatar', 'avatar', makePng(avatarPx, avatarPx, [40 * i & 255, 120, 200]), `a${i}.png`);
    await a.put(`/api/users/${a.user.id}`, { avatar_url: up.url });
  }
  void avatar;

  const server = await viewer.post('/api/servers', { name: `Perf Guild ${run}` });
  const serverId = server.id ?? server.server?.id;
  const chans = [];
  for (let i = 0; i < channels; i += 1) {
    chans.push(await viewer.post('/api/channels', { server_id: serverId, name: i === 0 ? 'long-channel' : `chan-${i}`, type: 'text' }));
  }
  const invite = await viewer.post(`/api/servers/${serverId}/invites`, { maxUses: 0, maxAge: 0 });
  for (const a of [lhUser, ...authorApis]) await a.post(`/api/invites/${invite.code}/accept`);

  // A few messages in every other channel, so switching renders something.
  await pool(chans.slice(1), 4, async (c, ci) => {
    for (let k = 0; k < 30; k += 1) {
      await authorApis[(ci + k) % authors].post('/api/messages', { channel_id: c.id, content: SAMPLES[k % SAMPLES.length](k) });
    }
  });

  // Image attachments uploaded once per author and reused (content-addressed).
  const img = makePng(1600, 1200, [200, 90, 60]);
  const attachmentFor = [];
  for (const a of authorApis) {
    const r = await a.req('POST', '/api/upload/attachments', (() => { const fd = new FormData(); fd.append('files', new Blob([img], { type: 'image/png' }), 'photo.png'); return fd; })());
    attachmentFor.push(r.attachments?.[0] ?? r[0]);
  }

  const long = chans[0];
  // Sequential in author runs keeps ordering realistic; parallel per 8 keeps it fast.
  const plan = [];
  let author = 0;
  for (let i = 0; i < messages; i += 1) {
    if (i % 3 === 0) author = (author + 1 + (i % 7)) % authors;
    plan.push({ i, author });
  }
  let done = 0;
  for (let start = 0; start < plan.length; start += 8) {
    await Promise.all(plan.slice(start, start + 8).map(({ i, author: au }) => {
      const body = { channel_id: long.id, content: SAMPLES[i % SAMPLES.length](i) };
      if (imageEvery && i % imageEvery === imageEvery - 1) body.attachments = [attachmentFor[au]];
      return authorApis[au].post('/api/messages', body);
    }));
    done += 8;
    if (done % 1000 === 0) log(`  seeded ${done}/${messages}`);
  }
  log(`  seed complete in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  return { run, viewer, lhUser, authors: authorApis, serverId, channels: chans, long };
}

/** Cookie for a context (the SPA authenticates with the session cookie). */
export function cookieFor(api) {
  return { name: 'antigravity_session', value: encodeURIComponent(api.token), domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' };
}
