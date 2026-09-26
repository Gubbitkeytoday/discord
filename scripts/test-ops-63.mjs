// ============================================================================
//  Ops polish against a real server:
//    - upload filenames are decoded as UTF-8 (Thai, emoji), not latin1 mojibake
//    - message attachments carry the media-pipeline fields the client needs
//      (thumbhash, dimensions, renditions/srcset, display/poster/download URLs,
//      media_status), batched in hydrate
//    - nonce retries return the original message without a second row
//    - search understands today / yesterday / tomorrow end to end
//    - `npm run seed` (node db/seed.js) refuses production without SEED_DATABASE=1
// ============================================================================

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { startServer, stopServer, api, get, uploadFile } from './testHarness.mjs';

// A real 64x32 image (the harness PNG trips sharp's failOn warnings, so it
// never gets a thumbhash). Distinct bytes per call: uploads are deduplicated.
const sharp = await import('sharp').then((m) => m.default).catch(() => null);
const image = (seed) => sharp({ create: { width: 64, height: 32, channels: 3, background: { r: seed, g: 90, b: 200 } } }).png().toBuffer();

before(startServer);
after(stopServer);

const CHANNEL = 'chan-102';

describe('uploads and attachments', { skip: sharp ? false : 'sharp is not installed' }, () => {
  let descriptor;

  test('a Thai filename survives the multipart upload intact', async () => {
    const name = 'สลิป-โอนเงิน 🧾.png';
    const { status, body } = await uploadFile(await image(10), name, 'image/png');
    assert.equal(status, 200, JSON.stringify(body));
    descriptor = body.attachments[0];
    assert.equal(descriptor.filename, name);
  });

  test('a latin1 filename is left alone', async () => {
    const { status, body } = await uploadFile(await image(20), 'café.png', 'image/png');
    assert.equal(status, 200);
    assert.equal(body.attachments[0].filename, 'café.png');
  });

  test('message history exposes the media pipeline fields for each attachment', async () => {
    const posted = await api('POST', '/api/messages', {
      channel_id: CHANNEL, content: 'receipt attached', attachments: [descriptor]
    });
    assert.equal(posted.status, 200, JSON.stringify(posted.body));

    // Renditions may finish in the background; poll briefly for 'ready'.
    let att;
    const deadline = Date.now() + 10_000;
    do {
      const history = await get(`/api/messages/${CHANNEL}?limit=5`);
      const list = Array.isArray(history.body) ? history.body : history.body.messages;
      att = list.find((m) => m.id === posted.body.id).attachments[0];
      if (att.media_status !== 'processing') break;
      await new Promise((r) => setTimeout(r, 200));
    } while (Date.now() < deadline);

    if (process.env.OPS63_DEBUG) console.log(JSON.stringify({ descriptor, att }, null, 1));
    assert.equal(att.filename, 'สลิป-โอนเงิน 🧾.png');
    assert.equal(att.width, 64);
    assert.equal(att.height, 32);
    assert.equal(typeof att.thumbhash, 'string', 'thumbhash placeholder');
    assert.ok(att.thumbhash.length > 0);
    assert.ok(Array.isArray(att.renditions));
    assert.equal(typeof att.srcset, 'object');
    assert.match(att.display_url, /^\/api\/media\//);
    assert.match(att.download_url, /\/api\/files\/.+\?download=1$/);
    assert.ok('poster_url' in att);
    assert.ok(['ready', 'processing', 'failed', 'unsupported', null].includes(att.media_status), att.media_status);
    assert.ok(att.url);
    assert.ok(att.thumbnail_url);
    if (att.renditions.length) {
      assert.ok(att.renditions.every((r) => r.url && r.width && r.format));
      assert.match(Object.values(att.srcset)[0], /\d+w/);
    }
  });
});

describe('nonce idempotency', () => {
  test('a retried send returns the original message and stores it once', async () => {
    const nonce = crypto.randomUUID();
    const first = await api('POST', '/api/messages', { channel_id: CHANNEL, content: 'only once', nonce });
    const second = await api('POST', '/api/messages', { channel_id: CHANNEL, content: 'only once', nonce });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(second.body.id, first.body.id);
    assert.equal(second.body.nonce, nonce);
    const history = await get(`/api/messages/${CHANNEL}?limit=20`);
    const list = Array.isArray(history.body) ? history.body : history.body.messages;
    assert.equal(list.filter((m) => m.nonce === nonce).length, 1);
  });

  test('messages without a nonce are never deduplicated', async () => {
    const a = await api('POST', '/api/messages', { channel_id: CHANNEL, content: 'same text' });
    const b = await api('POST', '/api/messages', { channel_id: CHANNEL, content: 'same text' });
    assert.notEqual(a.body.id, b.body.id);
  });
});

describe('search relative dates', () => {
  const marker = `ops63-${crypto.randomBytes(3).toString('hex')}`;

  before(async () => {
    const res = await api('POST', '/api/messages', { channel_id: CHANNEL, content: `hello ${marker}` });
    assert.equal(res.status, 200);
  });

  const search = async (q) => {
    const res = await get(`/api/search/messages?q=${encodeURIComponent(q)}&serverId=server-1`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.filter((m) => m.content?.includes(marker));
  };

  test('during:today, before:tomorrow and after:yesterday find a message posted now', async () => {
    assert.equal((await search(`${marker} during:today`)).length, 1);
    assert.equal((await search(`${marker} before:tomorrow`)).length, 1);
    assert.equal((await search(`${marker} after:yesterday`)).length, 1);
  });

  test('before:today and during:yesterday exclude it', async () => {
    assert.equal((await search(`${marker} before:today`)).length, 0);
    assert.equal((await search(`${marker} during:yesterday`)).length, 0);
  });
});

describe('npm run seed', () => {
  test('is refused in production unless SEED_DATABASE=1', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops63-seed-'));
    try {
      const env = { ...process.env, NODE_ENV: 'production', DB_PATH: path.join(dir, 'x.db'), LOG_LEVEL: 'warn' };
      delete env.DATABASE_URL;
      delete env.SEED_DATABASE;
      const refused = spawnSync(process.execPath, ['db/seed.js'], { env, encoding: 'utf8' });
      assert.equal(refused.status, 1);
      assert.match(refused.stderr, /Refusing to seed/);
      assert.match(refused.stderr, /SEED_DATABASE=1/);

      const allowed = spawnSync(process.execPath, ['db/seed.js'], {
        env: { ...env, SEED_DATABASE: '1' }, encoding: 'utf8'
      });
      assert.equal(allowed.status, 0, allowed.stderr);
      assert.match(allowed.stdout, /Seed complete/);

      const again = spawnSync(process.execPath, ['db/seed.js'], {
        env: { ...env, SEED_DATABASE: '1' }, encoding: 'utf8'
      });
      assert.equal(again.status, 0);
      assert.match(again.stdout, /nothing seeded/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
