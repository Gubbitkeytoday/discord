// ============================================================================
//  Shared test harness: boots a real server against a throwaway database on a
//  spare port, and provides the request helpers both test files use.
//
//  Each test file gets its own port and its own database, so `node --test` can
//  run them in parallel processes without interfering.
// ============================================================================

import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import crypto from 'crypto';

// Derive a stable-but-distinct port from the entry file name, so part 1 and
// part 2 never collide.
const suffix = path.basename(process.argv[1] ?? 'test').replace(/\D/g, '') || '1';
// TEST_PORT_BASE lets several checkouts run the suite concurrently.
export const PORT = Number(process.env.TEST_PORT) || (Number(process.env.TEST_PORT_BASE || 3900) + (Number(suffix) % 90));
export const BASE = `http://localhost:${PORT}`;
export const ADMIN = { 'x-admin-token': 'test-admin-token' };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-test-'));
const DB_PATH = path.join(TMP, 'test.db');
const STORAGE_ROOT = path.join(TMP, 'uploads');

// ---------------------------------------------------------------------------
// Database selection.
//
//   TEST_DATABASE_URL unset → SQLite file in TMP (the default).
//   TEST_DATABASE_URL=postgres://user@host:port/postgres → this file gets a
//     brand-new database on that server (CREATE DATABASE test_…), which is
//     dropped again in stopServer. The URL's own database is only used as the
//     maintenance connection for CREATE/DROP.
//
// A DATABASE_URL inherited from the shell is always ignored, so `npm test`
// can never touch a real database.
// ---------------------------------------------------------------------------
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || '';
if (!TEST_DATABASE_URL && process.env.npm_lifecycle_event === 'test:pg') {
  throw new Error('npm run test:pg needs TEST_DATABASE_URL=postgres://user@host:port/postgres');
}
export const PG_DB_NAME = TEST_DATABASE_URL
  ? `test_${suffix}_${process.pid}_${crypto.randomBytes(4).toString('hex')}`
  : null;
if (PG_DB_NAME) {
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${PG_DB_NAME}`;
  process.env.DATABASE_URL = url.toString();
} else {
  delete process.env.DATABASE_URL;
}

async function withAdminClient(fn) {
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try { return await fn(client); } finally { await client.end(); }
}

async function createTestDatabase() {
  if (!PG_DB_NAME) return;
  await withAdminClient((c) => c.query(`CREATE DATABASE "${PG_DB_NAME}"`));
}

async function dropTestDatabase() {
  if (!PG_DB_NAME) return;
  // The test process itself may have opened a pool through db.js.
  try {
    const { closeDB } = await import('../db.js');
    await closeDB();
  } catch { /* never imported, or already closed */ }
  await withAdminClient((c) => c.query(`DROP DATABASE IF EXISTS "${PG_DB_NAME}" WITH (FORCE)`));
}

// Some test files import services directly (media probing, storage, S3). Those
// modules open db.js on import, which would otherwise attach to the real
// discord.db in the project root. Point the *test process itself* at the
// throwaway database before any of them are evaluated — this module is imported
// first by every test file, so these are set in time.
process.env.DB_PATH ??= DB_PATH;
process.env.STORAGE_ROOT ??= STORAGE_ROOT;
process.env.ALLOW_DEV_IDENTITY ??= '1';

let server;

export async function startServer() {
  await createTestDatabase();
  const env = { ...process.env };
  if (!PG_DB_NAME) delete env.DATABASE_URL;
  server = spawn(process.execPath, ['server.js'], {
    env: {
      ...env,
      PORT: String(PORT),
      DB_PATH,
      STORAGE_ROOT,
      ADMIN_TOKEN: 'test-admin-token',
      ALLOW_DEV_IDENTITY: '1',
      RATE_LIMIT_WRITE_PER_MIN: '10000',
      RATE_LIMIT_REGISTER_PER_HOUR: '10000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', (chunk) => {
    const line = String(chunk);
    // TEST_SERVER_LOG=1 shows everything the server writes to stderr.
    if (process.env.TEST_SERVER_LOG === '1' || /Error|error:/i.test(line)) {
      process.stderr.write(`[server] ${line}`);
    }
  });

  const deadline = Date.now() + 40_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server on ${PORT} did not become healthy in time`);
}

export async function stopServer() {
  if (server && server.exitCode === null && server.signalCode === null) {
    const exited = new Promise((r) => server.once('exit', r));
    server.kill();
    // Graceful shutdown closes the pool; don't wait forever for it.
    await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
    if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
  }
  await new Promise((r) => setTimeout(r, PG_DB_NAME ? 0 : 300));
  try {
    await dropTestDatabase();
  } catch (err) {
    process.stderr.write(`[harness] could not drop ${PG_DB_NAME}: ${err.message}\n`);
  }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* windows file lock */ }
}

/** Default identity is the dev header, which the seed owner uses. */
export async function api(method, url, body, headers = {}) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-user-id': 'user-me', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

export const get = (url, headers) => api('GET', url, undefined, headers);

/**
 * Call the API with a real session token. Sends a deliberately *wrong*
 * x-user-id alongside it, so every assertion also proves the session takes
 * precedence over the dev shortcut.
 */
/** Call the API as a bot: `Authorization: Bot <token>`. */
export async function asBot(token, method, url, body) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bot ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { status: res.status, body: parsed };
}

export async function asSession(token, method, url, body) {
  const res = await fetch(`${BASE}${url}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      'x-user-id': 'user-4'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, body: json };
}

export async function login(username, password = 'antigravity123') {
  const { status, body } = await api('POST', '/api/auth/login', { username, password });
  return { status, token: body?.token, user: body?.user, error: body?.error };
}

/** A real 4x2 PNG, so the image pipeline is exercised for real. */
export const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAYAAABm6xu2AAAAFElEQVR42mP8z8Dwn4GBgYGBgQEAFwUCAeVKGYUAAAAASUVORK5CYII=',
  'base64'
);

export async function uploadFile(
  buffer, filename, mime, field = 'files', endpoint = '/api/upload/attachments'
) {
  const form = new FormData();
  form.append(field, new Blob([buffer], { type: mime }), filename);
  const res = await fetch(`${BASE}${endpoint}`, {
    method: 'POST', headers: { 'x-user-id': 'user-me' }, body: form
  });
  return { status: res.status, body: await res.json() };
}
