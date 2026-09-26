// ============================================================================
//  Media pipeline, S3 backend: objects in the bucket (not on local disk),
//  redirects to presigned URLs, and browser direct uploads with a presigned
//  POST policy (content-length-range, Content-Type) that the server then
//  verifies with HEAD + a ranged GET before processing it asynchronously.
//
//  The bucket is an in-process fake that *verifies* what real S3 verifies:
//  SigV4 header signatures, presigned query signatures and expiry, and POST
//  policy signatures and conditions. Its verifier is written independently of
//  lib/s3Client.js, so a signing bug fails here instead of in production.
// ============================================================================

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Busboy from 'busboy';

// --- a verifying fake S3 -------------------------------------------------------

const BUCKET = 'media';
const ACCESS_KEY = 'AKIDMEDIATEST';
const SECRET_KEY = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
const REGION = 'us-east-1';

const store = new Map();          // key -> { body, contentType }
const audit = { headerAuthOk: 0, presignedOk: 0, postOk: 0, rejected: [] };

const hex = (d) => crypto.createHash('sha256').update(d).digest('hex');
const hm = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
const rfc3986 = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
const signingKey = (date) => hm(hm(hm(hm(`AWS4${SECRET_KEY}`, date), REGION), 's3'), 'aws4_request');

function parseQuery(raw) {
  const pairs = [];
  for (const part of (raw ?? '').split('&')) {
    if (!part) continue;
    const i = part.indexOf('=');
    const k = decodeURIComponent(i === -1 ? part : part.slice(0, i));
    const v = i === -1 ? '' : decodeURIComponent(part.slice(i + 1).replace(/\+/g, '%20'));
    pairs.push([k, v]);
  }
  return pairs;
}

function canonical(req, rawPath, queryPairs, signedHeaders, payloadHash) {
  const cq = queryPairs.map(([k, v]) => [rfc3986(k), rfc3986(v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`).join('&');
  const ch = signedHeaders.map((h) => `${h}:${String(req.headers[h] ?? '').trim().replace(/\s+/g, ' ')}\n`).join('');
  return [req.method, rawPath, cq, ch, signedHeaders.join(';'), payloadHash].join('\n');
}

function verifySigV4(req, body) {
  const [rawPath, rawQuery] = req.url.split('?');
  const query = parseQuery(rawQuery);
  const q = Object.fromEntries(query);
  if (q['X-Amz-Signature']) {
    const [, date] = q['X-Amz-Credential'].split('/');
    const amzDate = q['X-Amz-Date'];
    const issued = Date.UTC(+amzDate.slice(0, 4), +amzDate.slice(4, 6) - 1, +amzDate.slice(6, 8),
      +amzDate.slice(9, 11), +amzDate.slice(11, 13), +amzDate.slice(13, 15));
    if (Date.now() > issued + Number(q['X-Amz-Expires']) * 1000) return 'expired';
    const signed = q['X-Amz-SignedHeaders'].split(';');
    const creq = canonical(req, rawPath, query.filter(([k]) => k !== 'X-Amz-Signature'), signed, 'UNSIGNED-PAYLOAD');
    const sts = ['AWS4-HMAC-SHA256', amzDate, `${date}/${REGION}/s3/aws4_request`, hex(creq)].join('\n');
    const sig = crypto.createHmac('sha256', signingKey(date)).update(sts).digest('hex');
    if (sig !== q['X-Amz-Signature']) return 'SignatureDoesNotMatch (presigned)';
    audit.presignedOk += 1;
    return null;
  }
  const auth = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]+)$/
    .exec(req.headers.authorization ?? '');
  if (!auth) return 'missing Authorization';
  if (auth[1] !== ACCESS_KEY) return 'InvalidAccessKeyId';
  const payloadHash = req.headers['x-amz-content-sha256'];
  if (payloadHash !== 'UNSIGNED-PAYLOAD' && payloadHash !== hex(body)) return 'XAmzContentSHA256Mismatch';
  const creq = canonical(req, rawPath, query, auth[4].split(';'), payloadHash);
  const sts = ['AWS4-HMAC-SHA256', req.headers['x-amz-date'], `${auth[2]}/${REGION}/s3/aws4_request`, hex(creq)].join('\n');
  const sig = crypto.createHmac('sha256', signingKey(auth[2])).update(sts).digest('hex');
  if (sig !== auth[5]) return 'SignatureDoesNotMatch';
  audit.headerAuthOk += 1;
  return null;
}

/** POST Object: the policy's signature, expiry, and every condition. */
function verifyPost(fields, fileSize) {
  const policyB64 = fields.policy;
  if (!policyB64) return 'no policy';
  const date = String(fields['x-amz-credential'] ?? '').split('/')[1];
  const sig = crypto.createHmac('sha256', signingKey(date)).update(policyB64).digest('hex');
  if (sig !== fields['x-amz-signature']) return 'SignatureDoesNotMatch (policy)';
  const policy = JSON.parse(Buffer.from(policyB64, 'base64').toString('utf8'));
  if (Date.parse(policy.expiration) < Date.now()) return 'policy expired';
  const covered = new Set(['policy', 'x-amz-signature', 'file']);
  for (const c of policy.conditions) {
    if (Array.isArray(c) && c[0] === 'content-length-range') {
      if (fileSize < c[1] || fileSize > c[2]) return 'EntityTooSmall/EntityTooLarge';
      continue;
    }
    const [op, field, value] = Array.isArray(c) ? c : ['eq', `$${Object.keys(c)[0]}`, Object.values(c)[0]];
    const name = field.slice(1);
    const actual = name === 'bucket' ? BUCKET : fields[name] ?? fields[Object.keys(fields).find((k) => k.toLowerCase() === name.toLowerCase())];
    covered.add(name.toLowerCase());
    if (op === 'eq' && actual !== value) return `condition failed: ${name}`;
    if (op === 'starts-with' && !String(actual ?? '').startsWith(value)) return `condition failed: ${name}`;
  }
  for (const k of Object.keys(fields)) {
    if (!covered.has(k.toLowerCase())) return `field not in policy: ${k}`;
  }
  return null;
}

const fakeS3 = http.createServer((req, res) => {
  const chunks = [];
  const deny = (status, reason) => {
    audit.rejected.push(`${req.method} ${req.url.split('?')[0]}: ${reason}`);
    res.writeHead(status, { 'content-type': 'application/xml' });
    res.end(`<Error><Code>${reason}</Code></Error>`);
  };

  if (req.method === 'POST' && req.url === `/${BUCKET}`) {
    const fields = {};
    let file = null;
    const bb = Busboy({ headers: req.headers, limits: { fileSize: 60 * 1024 * 1024 } });
    bb.on('field', (name, value) => { fields[name] = value; });
    bb.on('file', (_name, stream) => {
      const parts = [];
      stream.on('data', (d) => parts.push(d));
      stream.on('end', () => { file = Buffer.concat(parts); });
    });
    bb.on('close', () => {
      const problem = verifyPost(fields, file?.length ?? 0);
      if (problem) return deny(problem.includes('Signature') ? 403 : 400, problem);
      store.set(fields.key, { body: file, contentType: fields['Content-Type'] });
      audit.postOk += 1;
      res.writeHead(204);
      res.end();
    });
    req.pipe(bb);
    return;
  }

  req.on('data', (d) => chunks.push(d));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const problem = verifySigV4(req, body);
    if (problem) return deny(403, problem);
    const [rawPath, rawQuery] = req.url.split('?');
    const prefix = `/${BUCKET}/`;
    if (!rawPath.startsWith(prefix)) return deny(404, 'NoSuchBucket');
    const key = rawPath.slice(prefix.length).split('/').map(decodeURIComponent).join('/');
    const q = Object.fromEntries(parseQuery(rawQuery));

    if (req.method === 'PUT') {
      store.set(key, { body, contentType: req.headers['content-type'] ?? 'application/octet-stream' });
      res.writeHead(200, { etag: `"${hex(body).slice(0, 32)}"` });
      return res.end();
    }
    if (req.method === 'DELETE') {
      store.delete(key);
      res.writeHead(204);
      return res.end();
    }
    const obj = store.get(key);
    if (!obj) { res.writeHead(404); return res.end(); }
    const headers = {
      'content-type': q['response-content-type'] ?? obj.contentType,
      'accept-ranges': 'bytes',
      etag: `"${hex(obj.body).slice(0, 32)}"`,
      ...(q['response-content-disposition'] ? { 'content-disposition': q['response-content-disposition'] } : {})
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (range && req.method === 'GET') {
      const size = obj.body.length;
      const start = range[1] === '' ? size - Number(range[2]) : Number(range[1]);
      const end = range[1] === '' || range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1);
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
      return res.end(obj.body.subarray(start, end + 1));
    }
    res.writeHead(200, { ...headers, 'content-length': obj.body.length });
    return res.end(req.method === 'HEAD' ? undefined : obj.body);
  });
});

await new Promise((resolve) => fakeS3.listen(0, '127.0.0.1', resolve));
const S3_ORIGIN = `http://127.0.0.1:${fakeS3.address().port}`;

process.env.S3_ENDPOINT = S3_ORIGIN;
process.env.S3_BUCKET = BUCKET;
process.env.S3_REGION = REGION;
process.env.S3_ACCESS_KEY_ID = ACCESS_KEY;
process.env.S3_SECRET_ACCESS_KEY = SECRET_KEY;
process.env.S3_FORCE_PATH_STYLE = '1';
delete process.env.STORAGE_PUBLIC_BASE;
delete process.env.S3_DIRECT_UPLOAD;
// Uploads answer once renditions exist (the default budget is 2 s, which a
// loaded CI machine can miss for the larger fixtures).
process.env.MEDIA_SYNC_BUDGET_MS = '20000';

const { startServer, stopServer, api, get, uploadFile, BASE } = await import('./testHarness.mjs');
const { default: sharp } = await import('sharp');
const { S3Client } = await import('../lib/s3Client.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIDEO = fs.readFileSync(path.join(__dirname, 'fixtures', 'media-2s-320x240.mp4'));

before(startServer);
after(async () => {
  await stopServer();
  await new Promise((r) => fakeS3.close(r));
});

const EXIF = {
  IFD0: { Make: 'Apple', Model: 'iPhone 15 Pro' },
  IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '13/1 45/1 3000/100' }
};
const photo = (width = 1200, height = 800, orientation = 6) =>
  sharp({ create: { width, height, channels: 3, background: '#2266aa' } })
    .jpeg().withExif(EXIF).withMetadata({ orientation }).toBuffer();

async function waitFor(check, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await check();
    if (v || Date.now() > deadline) return v;
    await new Promise((r) => setTimeout(r, 150));
  }
}

const keyFromUrl = (url) => url.replace(/^\/uploads\//, '');

/** Do what a browser does with a presigned POST: the fields, then the file. */
async function postToBucket(presigned, bytes, type) {
  const form = new FormData();
  for (const [k, v] of Object.entries(presigned.fields)) form.append(k, v);
  form.append('file', new Blob([bytes], { type }));
  return fetch(presigned.url, { method: 'POST', body: form });
}

// ---------------------------------------------------------------------------

describe('S3 backend: storage and serving', () => {
  test('the capability report shows the bucket and the POST upload mode', async () => {
    const { body } = await get('/api/media/config');
    assert.equal(body.backend, 's3');
    assert.equal(body.direct_upload, 'post');
  });

  test('a multipart upload lands in the bucket, not on local disk, with its renditions', async () => {
    const upload = await uploadFile(await photo(), 'bucket.jpg', 'image/jpeg');
    assert.equal(upload.status, 200, JSON.stringify(upload.body));
    const d = upload.body.attachments[0];
    assert.equal(d.width, 800);
    assert.equal(d.height, 1200);
    const key = keyFromUrl(d.url);
    assert.ok(store.has(key), 'original is in the bucket');
    assert.ok(!store.get(key).body.includes('iPhone 15 Pro'), 'and it is sanitised');
    for (const r of d.renditions.filter((x) => x.format === 'webp')) {
      assert.ok(store.has(keyFromUrl(r.url)), `rendition ${r.width} is in the bucket`);
    }
    const { STORAGE_ROOT } = await import('../storageService.js');
    assert.ok(!fs.existsSync(path.join(STORAGE_ROOT, key)), 'nothing written to local disk');
  });

  test('/uploads/<key> redirects to a presigned bucket URL instead of 404ing on local disk', async () => {
    const upload = await uploadFile(await photo(640, 480, 1), 'redirect.jpg', 'image/jpeg');
    const d = upload.body.attachments[0];
    const manual = await fetch(`${BASE}${d.url}`, { redirect: 'manual' });
    assert.equal(manual.status, 302);
    const location = manual.headers.get('location');
    assert.ok(location.startsWith(`${S3_ORIGIN}/${BUCKET}/`), location);
    assert.match(location, /X-Amz-Signature=[0-9a-f]{64}/);

    const followed = await fetch(`${BASE}${d.url}`);
    assert.equal(followed.status, 200);
    assert.equal(followed.headers.get('content-type'), 'image/jpeg');
    const bytes = Buffer.from(await followed.arrayBuffer());
    assert.equal((await sharp(bytes).metadata()).width, 640);
  });

  test('the negotiated display URL redirects to the chosen rendition', async () => {
    const upload = await uploadFile(await photo(1000, 700, 1), 'nego.jpg', 'image/jpeg');
    const d = upload.body.attachments[0];
    const manual = await fetch(`${BASE}${d.display_url}?w=400`, { redirect: 'manual', headers: { accept: 'image/webp' } });
    assert.equal(manual.status, 302);
    assert.equal(manual.headers.get('vary'), 'Accept');
    assert.match(manual.headers.get('location'), /\.w480\.webp\?/);
    const followed = await fetch(`${BASE}${d.display_url}?w=400`, { headers: { accept: 'image/webp' } });
    assert.equal(followed.headers.get('content-type'), 'image/webp');
    assert.equal((await sharp(Buffer.from(await followed.arrayBuffer())).metadata()).width, 480);
  });

  test('video Range requests are answered by the bucket through the redirect', async () => {
    const upload = await uploadFile(VIDEO, 'clip.mp4', 'video/mp4');
    assert.equal(upload.status, 200);
    const d = upload.body.attachments[0];
    assert.equal(d.width, 320);
    const res = await fetch(`${BASE}/api/files/${d.id}`, { headers: { range: 'bytes=10-19' } });
    assert.equal(res.status, 206);
    assert.equal(res.headers.get('content-type'), 'video/mp4');
    assert.ok(Buffer.from(await res.arrayBuffer()).equals(VIDEO.subarray(10, 20)));

    const download = await fetch(`${BASE}${d.download_url}`, { redirect: 'manual' });
    assert.match(decodeURIComponent(download.headers.get('location')), /response-content-disposition=attachment; filename\*=UTF-8''clip\.mp4/);
  });
});

describe('direct uploads (presigned POST)', () => {
  test('presign → browser POST → complete gives a sanitised, processed file', async () => {
    const bytes = await photo(1500, 1000, 6);
    const presign = await api('POST', '/api/media/uploads', {
      category: 'attachments', filename: 'IMG_7.jpg', contentType: 'image/jpeg', size: bytes.length
    });
    assert.equal(presign.status, 201, JSON.stringify(presign.body));
    const p = presign.body;
    assert.equal(p.method, 'POST');
    assert.equal(p.url, `${S3_ORIGIN}/${BUCKET}`);
    assert.match(p.fields.key, /^incoming\/user-me\/\d+$/);
    const policy = JSON.parse(Buffer.from(p.fields.policy, 'base64').toString());
    assert.deepEqual(policy.conditions.find((c) => c[0] === 'content-length-range'), ['content-length-range', bytes.length, bytes.length]);

    const posted = await postToBucket(p, bytes, 'image/jpeg');
    assert.equal(posted.status, 204, await posted.text());
    assert.ok(store.has(p.fields.key));

    const done = await api('POST', p.complete_url);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const d = done.body;
    assert.equal(d.media_status, 'ready');
    assert.equal(d.width, 1000, 'orientation applied');
    assert.equal(d.height, 1500);
    assert.ok(d.thumbhash);
    assert.deepEqual(d.renditions.filter((r) => r.format === 'webp').map((r) => r.width), [160, 480, 960, 1000]);
    assert.ok(!store.has(p.fields.key), 'the incoming object is removed after ingest');
    const final = store.get(keyFromUrl(d.url));
    assert.ok(final, 'moved to its content-addressed key');
    assert.ok(!final.body.includes('iPhone 15 Pro'), 'EXIF stripped');
    assert.equal((await sharp(final.body).metadata()).exif, undefined);

    // Completing again is idempotent.
    const again = await api('POST', p.complete_url);
    assert.equal(again.status, 200);
    assert.equal(again.body.id, d.id);
  });

  test('the bucket enforces the policy: another size or type is refused', async () => {
    const bytes = await photo(300, 200, 1);
    const { body: p } = await api('POST', '/api/media/uploads', {
      filename: 'a.jpg', contentType: 'image/jpeg', size: bytes.length
    });
    const bigger = await postToBucket(p, Buffer.concat([bytes, Buffer.alloc(10)]), 'image/jpeg');
    assert.equal(bigger.status, 400);
    const tampered = await postToBucket({ ...p, fields: { ...p.fields, 'Content-Type': 'text/html' } }, bytes, 'text/html');
    assert.equal(tampered.status, 400);
    const forged = await postToBucket({ ...p, fields: { ...p.fields, key: 'attachments/evil.jpg' } }, bytes, 'image/jpeg');
    assert.equal(forged.status, 400);
    assert.ok(!store.has('attachments/evil.jpg'));
  });

  test('complete verifies the bytes: disguised HTML is rejected and deleted', async () => {
    const html = Buffer.from('<html><script>alert(1)</script></html>'.padEnd(200, ' '));
    const { body: p } = await api('POST', '/api/media/uploads', {
      filename: 'cat.png', contentType: 'image/png', size: html.length
    });
    store.set(p.fields.key, { body: html, contentType: 'image/png' });   // what a bypass would leave
    const done = await api('POST', p.complete_url);
    assert.equal(done.status, 415);
    assert.equal(done.body.code, 'UNSUPPORTED_TYPE');
    assert.ok(!store.has(p.fields.key), 'rejected object removed from the bucket');
    assert.equal((await api('POST', p.complete_url)).status, 409);
  });

  test('complete verifies the size with HEAD', async () => {
    const { body: p } = await api('POST', '/api/media/uploads', {
      filename: 'x.png', contentType: 'image/png', size: 5000
    });
    store.set(p.fields.key, { body: Buffer.alloc(100), contentType: 'image/png' });
    const done = await api('POST', p.complete_url);
    assert.equal(done.status, 400);
    assert.equal(done.body.code, 'SIZE_MISMATCH');
  });

  test('before the object exists, and for someone else, complete refuses', async () => {
    const { body: p } = await api('POST', '/api/media/uploads', {
      filename: 'y.png', contentType: 'image/png', size: 10
    });
    assert.equal((await api('POST', p.complete_url)).body.code, 'UPLOAD_MISSING');
    assert.equal((await api('POST', p.complete_url, undefined, { 'x-user-id': 'user-4' })).status, 404);
  });

  test('presign validates type, size, category, quota and authentication', async () => {
    const bad = (body, headers) => api('POST', '/api/media/uploads', body, headers);
    assert.equal((await bad({ filename: 'a.exe', contentType: 'application/x-msdownload', size: 10 })).status, 415);
    assert.equal((await bad({ filename: 'a.jpg', contentType: 'image/jpeg', size: 60 * 1024 * 1024 })).status, 413);
    assert.equal((await bad({ filename: 'a.jpg', contentType: 'image/jpeg' })).status, 400);
    assert.equal((await bad({ category: 'splashes', filename: 'a.jpg', contentType: 'image/jpeg', size: 10 })).status, 400);
    const anon = await fetch(`${BASE}/api/media/uploads`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ size: 10 })
    });
    assert.equal(anon.status, 401);

    const { runQuery } = await import('../db.js');
    await runQuery(`UPDATE users SET storage_quota = storage_used + 100 WHERE id = 'user-me'`);
    try {
      const over = await bad({ filename: 'a.jpg', contentType: 'image/jpeg', size: 5000 });
      assert.equal(over.status, 413);
      assert.equal(over.body.code, 'QUOTA_EXCEEDED');
    } finally {
      await runQuery(`UPDATE users SET storage_quota = 5368709120 WHERE id = 'user-me'`);
    }
  });

  test('a direct video upload is probed and served', async () => {
    const { body: p } = await api('POST', '/api/media/uploads', {
      category: 'video', filename: 'clip.mp4', contentType: 'video/mp4', size: VIDEO.length
    });
    assert.equal((await postToBucket(p, VIDEO, 'video/mp4')).status, 204);
    const done = await api('POST', p.complete_url);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.file_type, 'video');
    assert.equal(done.body.duration_secs, 2);
    assert.equal(done.body.width, 320);
    const caps = (await get('/api/media/config')).body;
    if (caps.video_posters) assert.ok(done.body.poster_url);
  });
});

describe('S3 client signing (against the verifying fake)', () => {
  const client = new S3Client({
    endpoint: S3_ORIGIN, bucket: BUCKET, region: REGION,
    accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY, forcePathStyle: true
  });

  test('presigned PUT (the R2 mode) pins Content-Type', async () => {
    const body = Buffer.from('hello presigned put');
    const put = client.presignPut('tests/put.txt', { contentType: 'text/plain', contentLength: body.length });
    const ok = await fetch(put.url, { method: 'PUT', headers: put.headers, body });
    assert.equal(ok.status, 200, await ok.text());
    assert.ok(store.get('tests/put.txt').body.equals(body));
    const wrongType = await fetch(put.url, { method: 'PUT', headers: { 'Content-Type': 'text/html' }, body });
    assert.equal(wrongType.status, 403);
    const wrongSize = await fetch(put.url, { method: 'PUT', headers: put.headers, body: Buffer.concat([body, body]) });
    assert.equal(wrongSize.status, 403);
  });

  test('ranged GET, HEAD and keys needing encoding work', async () => {
    await client.putObject('tests/ไทย (1).txt', Buffer.from('0123456789'), 'text/plain');
    assert.equal((await client.getObjectRange('tests/ไทย (1).txt', 2, 4)).toString(), '234');
    assert.equal((await client.headObject('tests/ไทย (1).txt')).size, 10);
    assert.equal(await client.headObject('tests/missing'), null);
  });

  test('every request the server made was correctly signed', () => {
    assert.deepEqual(audit.rejected.filter((r) => !/condition|Entity|SignatureDoesNotMatch \(presigned\)/.test(r)), []);
    assert.ok(audit.headerAuthOk > 10);
    assert.ok(audit.presignedOk > 3);
    assert.ok(audit.postOk >= 2);
  });
});
