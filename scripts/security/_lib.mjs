// Shared helpers for the proof-of-concept scripts in this folder.
//
// Every PoC talks to a running server over plain HTTP / Socket.IO, exactly as an
// outside attacker would. Point them at a disposable instance:
//
//   NODE_ENV=production PORT=5300 HOST=127.0.0.1 DB_PATH=/tmp/sec.db \
//   STORAGE_ROOT=/tmp/sec-up STORAGE_URL_SECRET=$(openssl rand -base64 32) \
//   ALLOW_DEV_IDENTITY=0 SERVE_STATIC=0 RATE_LIMIT_REGISTER_PER_HOUR=10000 \
//   RATE_LIMIT_WRITE_PER_MIN=10000 node server.js
//
//   SEC_BASE=http://127.0.0.1:5300 node scripts/security/poc-01-reset-token-leak.mjs
//
// Each script prints VULNERABLE / NOT VULNERABLE and exits 1 when the issue
// reproduces, so they double as regression tests once a fix lands.

import crypto from 'crypto';
import { io as ioClient } from 'socket.io-client';

export const BASE = process.env.SEC_BASE ?? 'http://127.0.0.1:5300';

const rnd = () => crypto.randomBytes(4).toString('hex');

export async function api(method, path, { token, bot, body, headers = {}, raw = false } = {}) {
  const h = { ...headers };
  if (token) h.authorization = `Bearer ${token}`;
  if (bot) h.authorization = `Bot ${bot}`;
  let payload;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(`${BASE}${path}`, { method, headers: h, body: payload, redirect: 'manual' });
  if (raw) return res;
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, body: json, headers: res.headers };
}

/** Register a fresh account and return { id, username, token, email, password }. */
export async function newUser(label = 'u', { email = true } = {}) {
  const username = `${label}_${rnd()}`;
  const password = `Pw-${rnd()}-${rnd()}`;
  const mail = email ? `${username}@example.test` : undefined;
  const r = await api('POST', '/api/auth/register', { body: { username, password, email: mail } });
  if (r.status !== 201) throw new Error(`register failed: ${r.status} ${JSON.stringify(r.body)}`);
  return { id: r.body.user.id, username, token: r.body.token, email: mail, password };
}

export async function upload(token, { bytes, name, mime, visibility, path = '/api/upload/attachments', field = 'files' }) {
  const form = new FormData();
  // Fields before the file, or multer has not parsed them when storeFile runs.
  if (visibility) form.append('visibility', visibility);
  form.append(field, new Blob([bytes], { type: mime }), name);
  const r = await api('POST', path, { token, body: form });
  if (r.status !== 200) throw new Error(`upload failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.attachments ? r.body.attachments[0] : r.body;
}

export async function newServer(token, name = `srv-${rnd()}`) {
  const r = await api('POST', '/api/servers', { token, body: { name } });
  if (r.status !== 200) throw new Error(`server create failed: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.server ?? r.body;
}

export async function inviteAndJoin(ownerToken, serverId, joinerToken) {
  const inv = await api('POST', `/api/servers/${serverId}/invites`, { token: ownerToken, body: {} });
  const acc = await api('POST', `/api/invites/${inv.body.code}/accept`, { token: joinerToken });
  if (acc.status !== 200) throw new Error(`join failed: ${acc.status} ${JSON.stringify(acc.body)}`);
  return acc.body;
}

export function socket({ token, botToken, identify = true } = {}) {
  const s = ioClient(BASE, { transports: ['websocket'], forceNew: true, reconnection: false });
  const ready = new Promise((resolve, reject) => {
    s.on('connect_error', reject);
    s.on('connect', () => {
      if (!identify) return resolve(s);
      s.once('identified', () => resolve(s));
      s.once('identify_error', (e) => reject(new Error(`identify_error ${JSON.stringify(e)}`)));
      s.emit('identify', { token, botToken });
    });
  });
  return ready;
}

export const emitAck = (s, event, payload, timeoutMs = 3000) => new Promise((resolve) => {
  const t = setTimeout(() => resolve({ timeout: true }), timeoutMs);
  s.emit(event, payload, (res) => { clearTimeout(t); resolve(res); });
});

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function verdict(vulnerable, detail) {
  console.log(`\n${vulnerable ? 'VULNERABLE' : 'NOT VULNERABLE'}: ${detail}`);
  process.exitCode = vulnerable ? 1 : 0;
}
