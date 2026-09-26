// ============================================================================
//  Media pipeline, local backend: sanitising (EXIF/GPS), responsive
//  renditions, Accept negotiation, caching headers, Range requests, video
//  metadata, decompression-bomb limits, quotas, the job queue and GC of
//  derived objects.
//
//  The digits in this file's name pick its test port (see testHarness.mjs);
//  the S3/direct-upload half lives in test-media38.mjs.
// ============================================================================

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';

// A small quota for every user, so enforcement can be exercised with a few MB.
process.env.STORAGE_QUOTA_BYTES = String(6 * 1024 * 1024);
// Uploads answer once renditions exist (the default budget is 2 s, which a
// loaded CI machine can miss for the larger fixtures).
process.env.MEDIA_SYNC_BUDGET_MS = '20000';

const {
  startServer, stopServer, api, get, uploadFile, BASE, ADMIN
} = await import('./testHarness.mjs');
const { default: sharp } = await import('sharp');
const {
  stripJpegMetadata, blankIsobmffMetadata, negotiateFormat, pickRendition, planRenditions
} = await import('../lib/imageVariants.js');
const { parseRange } = await import('../storageService.js');
const { probeVideoDimensions, probeDuration } = await import('../lib/mediaDuration.js');
const { sniffMime } = await import('../lib/mediaProbe.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIDEO = fs.readFileSync(path.join(__dirname, 'fixtures', 'media-2s-320x240.mp4'));

before(startServer);
after(stopServer);

const EXIF = {
  IFD0: { Make: 'Apple', Model: 'iPhone 15 Pro', Software: 'TestCam' },
  IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '13/1 45/1 3000/100', GPSLongitudeRef: 'E', GPSLongitude: '100/1 30/1 0/1' }
};

/** A photo-like JPEG: EXIF with GPS, rotated 90° by its orientation tag. */
async function photo({ width = 2400, height = 1600, orientation = 6 } = {}) {
  return sharp({ create: { width, height, channels: 3, background: '#4477aa' } })
    .composite([{ input: { create: { width: Math.round(width / 3), height: Math.round(height / 3), channels: 3, background: '#ffcc00' } }, top: 10, left: 10 }])
    .jpeg({ quality: 85 })
    .withExif(EXIF)
    .withMetadata({ orientation })
    .toBuffer();
}

const fetchBytes = async (url, headers = {}) => {
  const res = await fetch(url.startsWith('http') ? url : `${BASE}${url}`, { headers });
  return { res, body: Buffer.from(await res.arrayBuffer()) };
};

const meta = (id) => get(`/api/files/${id}/meta`);

async function waitFor(check, { timeoutMs = 20_000, intervalMs = 150 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) return value;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

// ---------------------------------------------------------------------------

describe('image uploads: sanitising and renditions', () => {
  let photoDescriptor;

  before(async () => {
    const upload = await uploadFile(await photo(), 'IMG_0001.jpg', 'image/jpeg');
    assert.equal(upload.status, 200, JSON.stringify(upload.body));
    photoDescriptor = upload.body.attachments[0];
  });

  test('display dimensions have the EXIF orientation applied, so clients can reserve space', () => {
    assert.equal(photoDescriptor.width, 1600);
    assert.equal(photoDescriptor.height, 2400);
    assert.equal(photoDescriptor.file_type, 'image');
    assert.equal(photoDescriptor.media_status, 'ready');
  });

  test('a thumbhash and an inline placeholder come back with the upload', () => {
    assert.match(photoDescriptor.thumbhash, /^[A-Za-z0-9+/]+=*$/);
    assert.ok(Buffer.from(photoDescriptor.thumbhash, 'base64').length <= 40);
    assert.match(photoDescriptor.placeholder, /^data:image\/webp;base64,/);
  });

  test('the stored original has no EXIF, GPS or camera data left', async () => {
    const { res, body } = await fetchBytes(photoDescriptor.url);
    assert.equal(res.status, 200);
    const m = await sharp(body).metadata();
    assert.equal(m.exif, undefined, 'EXIF block must be gone');
    assert.ok(!body.includes('iPhone 15 Pro'), 'camera model must be gone');
    assert.ok(!body.includes('GPS'), 'no GPS IFD');
    assert.ok(!m.orientation || m.orientation === 1, 'orientation is baked into the pixels');
    assert.equal(m.width, 1600);
    assert.equal(m.height, 2400);
  });

  test('WebP renditions exist at the responsive widths with correct dimensions', async () => {
    const webp = photoDescriptor.renditions.filter((r) => r.format === 'webp');
    assert.deepEqual(webp.map((r) => r.width), [160, 480, 960, 1600]);
    for (const r of webp) {
      const { res, body } = await fetchBytes(r.url);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'image/webp');
      assert.match(res.headers.get('cache-control') ?? '', /immutable/);
      const m = await sharp(body).metadata();
      assert.equal(m.format, 'webp');
      assert.equal(m.width, r.width);
      assert.equal(m.height, Math.round(r.width * 1.5));
      assert.equal(m.exif, undefined);
    }
    assert.match(photoDescriptor.srcset.webp, /\.w160\.webp 160w, .*\.w1600\.webp 1600w$/);
  });

  test('legacy variant kinds still resolve (thumbnail_url keeps working)', () => {
    assert.equal(photoDescriptor.variants.thumb.width, 160);
    assert.ok(photoDescriptor.thumbnail_url.endsWith('.w160.webp'));
  });

  test('AVIF renditions follow in the background', async () => {
    const withAvif = await waitFor(async () => {
      const { body } = await meta(photoDescriptor.id);
      return body.renditions.filter((r) => r.format === 'avif').length === 4 ? body : null;
    }, { timeoutMs: 60_000 });
    assert.ok(withAvif, 'AVIF renditions did not appear');
    const avif960 = withAvif.renditions.find((r) => r.format === 'avif' && r.width === 960);
    const { res, body } = await fetchBytes(avif960.url);
    assert.equal(res.headers.get('content-type'), 'image/avif');
    const m = await sharp(body).metadata();
    assert.equal(m.format, 'heif');
    assert.equal(m.width, 960);
    assert.match(withAvif.srcset.avif, /960w/);
  });

  test('the original stays downloadable, as an attachment', async () => {
    const { res } = await fetchBytes(photoDescriptor.download_url);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /^attachment; filename\*=UTF-8''IMG_0001\.jpg/);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
  });

  test('negotiation: AVIF, then WebP, then the original — with Vary: Accept', async () => {
    const url = `${photoDescriptor.display_url}?w=500`;
    const avif = await fetchBytes(url, { accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8' });
    assert.equal(avif.res.status, 200);
    assert.equal(avif.res.headers.get('content-type'), 'image/avif');
    assert.equal(avif.res.headers.get('vary'), 'Accept');
    assert.equal((await sharp(avif.body).metadata()).width, 960, '?w=500 → the 960 rendition');

    const webp = await fetchBytes(url, { accept: 'image/webp,*/*' });
    assert.equal(webp.res.headers.get('content-type'), 'image/webp');
    assert.equal(webp.res.headers.get('vary'), 'Accept');

    const refused = await fetchBytes(url, { accept: 'image/avif;q=0,image/webp,*/*' });
    assert.equal(refused.res.headers.get('content-type'), 'image/webp', 'q=0 is a refusal');

    const legacy = await fetchBytes(url, { accept: 'image/png,image/*;q=0.8' });
    assert.equal(legacy.res.headers.get('content-type'), 'image/jpeg', 'no explicit support → original');
    assert.equal(legacy.res.headers.get('vary'), 'Accept');
  });

  test('negotiated responses are immutable for public files and carry an ETag (304 on revalidation)', async () => {
    const url = `${photoDescriptor.display_url}?w=160`;
    const first = await fetchBytes(url, { accept: 'image/webp' });
    assert.equal(first.res.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    const etag = first.res.headers.get('etag');
    assert.match(etag, /-160\.webp"$/);
    const again = await fetch(`${BASE}${url}`, { headers: { accept: 'image/webp', 'if-none-match': etag } });
    assert.equal(again.status, 304);
  });

  test('f= pins a format (the explicit srcset form) and needs no Vary', async () => {
    const { res } = await fetchBytes(`${photoDescriptor.display_url}?w=480&f=webp`, { accept: 'image/avif' });
    assert.equal(res.headers.get('content-type'), 'image/webp');
    assert.equal(res.headers.get('vary'), null);
    const bad = await get(`${photoDescriptor.display_url}?w=abc`);
    assert.equal(bad.status, 400);
  });

  test('a lossless strip leaves PNG pixels untouched', async () => {
    const png = await sharp({ create: { width: 64, height: 48, channels: 4, background: { r: 10, g: 200, b: 30, alpha: 0.5 } } })
      .png().withExif(EXIF).toBuffer();
    const upload = await uploadFile(png, 'shot.png', 'image/png');
    const d = upload.body.attachments[0];
    const { body } = await fetchBytes(d.url);
    assert.ok(!body.includes('iPhone 15 Pro'));
    const [a, b] = await Promise.all([png, body].map((x) => sharp(x).raw().toBuffer()));
    assert.ok(a.equals(b), 'pixel data must be identical');
  });

  test('AVIF uploads have their EXIF item blanked and still decode', async () => {
    const avif = await sharp({ create: { width: 320, height: 200, channels: 3, background: '#884422' } })
      .avif({ effort: 0 }).withExif(EXIF).toBuffer();
    assert.equal(sniffMime(avif).mime, 'image/avif');
    const upload = await uploadFile(avif, 'photo.avif', 'image/avif');
    assert.equal(upload.status, 200, JSON.stringify(upload.body));
    const d = upload.body.attachments[0];
    assert.equal(d.mimetype, 'image/avif');
    assert.equal(d.width, 320);
    const { body } = await fetchBytes(d.url);
    assert.ok(!body.includes('iPhone 15 Pro'), 'EXIF payload must be blanked');
    assert.equal((await sharp(body).metadata()).width, 320);
    assert.ok(d.renditions.some((r) => r.format === 'webp'));
  });
});

describe('animated images, avatars, emoji', () => {
  test('an animated GIF gets animated WebP renditions and a still preview', async () => {
    const frames = await Promise.all(['#f00', '#0f0', '#00f'].map((c) =>
      sharp({ create: { width: 800, height: 400, channels: 4, background: c } }).png().toBuffer()));
    const gif = await sharp(frames, { join: { animated: true } }).gif({ delay: [100, 100, 100], loop: 0 }).toBuffer();
    const upload = await uploadFile(gif, 'party.gif', 'image/gif');
    assert.equal(upload.status, 200);
    const d = upload.body.attachments[0];
    assert.equal(d.is_animated, true);
    assert.equal(d.width, 800);
    assert.equal(d.height, 400);
    const webp = d.renditions.filter((r) => r.format === 'webp');
    assert.deepEqual(webp.map((r) => r.width), [160, 480, 640], 'animated renditions stop at 640px');
    assert.ok(webp.every((r) => r.animated));
    assert.equal(d.renditions.filter((r) => r.format === 'avif').length, 0, 'no AVIF for animations');
    const { body } = await fetchBytes(webp[1].url);
    assert.equal((await sharp(body).metadata()).pages, 3, 'every frame survives');
    assert.ok(d.variants.preview, 'a still first frame is provided');
    const still = await fetchBytes(d.variants.preview.url);
    assert.equal((await sharp(still.body).metadata()).pages ?? 1, 1);
  });

  test('avatars are square-cropped to the standard sizes', async () => {
    const src = await photo({ width: 600, height: 300, orientation: 1 });
    const upload = await uploadFile(src, 'me.jpg', 'image/jpeg', 'avatar', '/api/upload/avatar');
    assert.equal(upload.status, 200, JSON.stringify(upload.body));
    const webp = upload.body.renditions.filter((r) => r.format === 'webp');
    assert.deepEqual(webp.map((r) => [r.width, r.height]), [[64, 64], [128, 128], [256, 256]]);
    const { body } = await fetchBytes(webp[2].url);
    const m = await sharp(body).metadata();
    assert.deepEqual([m.width, m.height], [256, 256]);
    assert.equal(upload.body.variants.thumb.width, 64);
    assert.equal(upload.body.variants.small.width, 128);
  });

  test('emoji are fitted, never cropped', async () => {
    const src = await sharp({ create: { width: 256, height: 128, channels: 4, background: '#ff00ff80' } }).png().toBuffer();
    const upload = await uploadFile(src, 'wide.png', 'image/png', 'emoji', '/api/upload/emoji');
    assert.equal(upload.status, 200, JSON.stringify(upload.body));
    const webp = upload.body.renditions.filter((r) => r.format === 'webp');
    assert.deepEqual(webp.map((r) => [r.width, r.height]), [[48, 24], [96, 48], [160, 80]]);
  });
});

describe('safety limits and quota', () => {
  /** A PNG whose header claims 60000×60000 — a decompression bomb. */
  function bombPng(width = 60000, height = 60000) {
    const chunk = (type, data) => {
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
      const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
      const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
      return Buffer.concat([len, body, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 1; ihdr[9] = 0;                    // 1-bit greyscale
    // A few rows of zeros compress to almost nothing; the claim is what matters.
    const idat = zlib.deflateSync(Buffer.alloc(Math.ceil(width / 8) + 1));
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))
    ]);
  }

  test('a decompression bomb is refused before decoding, and the server stays up', async () => {
    const started = Date.now();
    const upload = await uploadFile(bombPng(), 'bomb.png', 'image/png');
    assert.equal(upload.status, 415);                  // every file in the batch rejected…
    assert.equal(upload.body.details[0].code, 'IMAGE_TOO_LARGE');   // …for this reason
    assert.ok(Date.now() - started < 5000, 'rejection must be cheap');
    const avatar = await uploadFile(bombPng(20000, 20000), 'bomb.png', 'image/png', 'avatar', '/api/upload/avatar');
    assert.equal(avatar.status, 413);
    assert.equal(avatar.body.code, 'IMAGE_TOO_LARGE');
    assert.equal((await get('/api/health')).status, 200);
  });

  test('STORAGE_QUOTA_BYTES is enforced for every user', async () => {
    const usage = await get('/api/files/usage');
    assert.equal(usage.body.quota, 6 * 1024 * 1024);
    // Incompressible noise, bigger than what is left.
    const noise = await sharp(Buffer.from(Array.from({ length: 1600 * 1400 * 3 }, () => Math.random() * 256)), {
      raw: { width: 1600, height: 1400, channels: 3 }
    }).png({ compressionLevel: 0 }).toBuffer();
    assert.ok(noise.length > 6 * 1024 * 1024 - usage.body.used);
    const upload = await uploadFile(noise, 'noise.png', 'image/png');
    assert.equal(upload.status, 415);
    assert.equal(upload.body.details[0].code, 'QUOTA_EXCEEDED');
  });

  test('HEIC is recognised by its brand, not taken for an MP4', () => {
    const ftyp = Buffer.concat([
      Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic', 'latin1'), Buffer.alloc(4),
      Buffer.from('mif1heic', 'latin1')
    ]);
    assert.equal(sniffMime(Buffer.concat([ftyp, Buffer.alloc(64)])).mime, 'image/heic');
    const generic = Buffer.concat([
      Buffer.from([0, 0, 0, 24]), Buffer.from('ftypmif1', 'latin1'), Buffer.alloc(4),
      Buffer.from('mif1avif', 'latin1')
    ]);
    assert.equal(sniffMime(Buffer.concat([generic, Buffer.alloc(64)])).mime, 'image/avif');
  });
});

describe('video', () => {
  let video;
  let caps;

  before(async () => {
    caps = (await get('/api/media/config')).body;
    const upload = await uploadFile(VIDEO, 'clip.mp4', 'video/mp4');
    assert.equal(upload.status, 200, JSON.stringify(upload.body));
    video = upload.body.attachments[0];
  });

  test('duration and dimensions are known with or without ffmpeg', () => {
    assert.equal(video.file_type, 'video');
    assert.equal(video.mimetype, 'video/mp4');
    assert.equal(video.duration_secs, 2);
    assert.equal(video.width, 320);
    assert.equal(video.height, 240);
    assert.deepEqual(probeVideoDimensions(VIDEO, 'video/mp4'), { width: 320, height: 240 });
    assert.equal(probeDuration(VIDEO, 'video/mp4'), 2);
  });

  test('a poster frame exists when ffmpeg is installed, and its absence is graceful otherwise', async () => {
    const d = (await waitFor(async () => {
      const { body } = await meta(video.id);
      return body.media_status === 'ready' ? body : null;
    })) ?? (await meta(video.id)).body;
    assert.equal(d.media_status, 'ready');
    if (caps.video_posters) {
      assert.ok(d.poster_url, 'ffmpeg is available, so a poster is expected');
      const { res, body } = await fetchBytes(d.poster_url);
      assert.equal(res.headers.get('content-type'), 'image/webp');
      assert.equal((await sharp(body).metadata()).width, 320);
      assert.ok(d.thumbhash);
      const viaRoute = await fetchBytes(`/api/media/${d.id}/poster`);
      assert.equal(viaRoute.res.status, 200);
    } else {
      assert.equal(d.poster_url, null);
    }
  });

  test('Range requests: 206 with the exact bytes, suffix ranges, 416, HEAD', async () => {
    const url = `/api/files/${video.id}`;
    const part = await fetchBytes(url, { range: 'bytes=100-199' });
    assert.equal(part.res.status, 206);
    assert.equal(part.res.headers.get('content-range'), `bytes 100-199/${VIDEO.length}`);
    assert.equal(part.res.headers.get('content-type'), 'video/mp4');
    assert.equal(part.res.headers.get('accept-ranges'), 'bytes');
    assert.ok(part.body.equals(VIDEO.subarray(100, 200)));

    const tail = await fetchBytes(url, { range: 'bytes=-50' });
    assert.equal(tail.res.status, 206);
    assert.ok(tail.body.equals(VIDEO.subarray(VIDEO.length - 50)));

    const open = await fetchBytes(url, { range: `bytes=${VIDEO.length - 10}-` });
    assert.equal(open.body.length, 10);

    const beyond = await fetchBytes(url, { range: `bytes=${VIDEO.length + 5}-` });
    assert.equal(beyond.res.status, 416);
    assert.equal(beyond.res.headers.get('content-range'), `bytes */${VIDEO.length}`);

    const head = await fetch(`${BASE}${url}`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers.get('content-length')), VIDEO.length);

    // The static path (public URLs) supports ranges too.
    const statik = await fetchBytes(video.url, { range: 'bytes=0-9' });
    assert.equal(statik.res.status, 206);
    assert.equal(statik.res.headers.get('content-type'), 'video/mp4');
  });
});

describe('pure helpers', () => {
  test('parseRange covers the RFC forms', () => {
    assert.deepEqual(parseRange('bytes=0-9', 100), { start: 0, end: 9 });
    assert.deepEqual(parseRange('bytes=90-', 100), { start: 90, end: 99 });
    assert.deepEqual(parseRange('bytes=-10', 100), { start: 90, end: 99 });
    assert.deepEqual(parseRange('bytes=50-500', 100), { start: 50, end: 99 });
    assert.equal(parseRange('bytes=100-', 100), 'unsatisfiable');
    assert.equal(parseRange('bytes=0-1,5-6', 100), null);
    assert.equal(parseRange('items=0-1', 100), null);
  });

  test('negotiateFormat ignores wildcards and honours q=0', () => {
    const both = new Set(['avif', 'webp']);
    assert.equal(negotiateFormat('image/avif,image/webp,*/*', both), 'avif');
    assert.equal(negotiateFormat('image/webp,*/*', both), 'webp');
    assert.equal(negotiateFormat('image/*,*/*', both), null);
    assert.equal(negotiateFormat('image/avif;q=0, image/webp', both), 'webp');
    assert.equal(negotiateFormat('image/avif', new Set(['webp'])), null);
    assert.equal(negotiateFormat(undefined, both), null);
  });

  test('pickRendition picks the smallest rendition at least as wide as asked', () => {
    const list = [{ width: 160 }, { width: 480 }, { width: 960 }];
    assert.equal(pickRendition(list, 100).width, 160);
    assert.equal(pickRendition(list, 481).width, 960);
    assert.equal(pickRendition(list, 4000).width, 960);
    assert.equal(pickRendition(list, null).width, 960);
  });

  test('planRenditions never enlarges and keeps the source width as the top step', () => {
    assert.deepEqual(planRenditions('attachments', 800, 600).map((p) => p.width), [160, 480, 800]);
    assert.deepEqual(planRenditions('attachments', 100, 100).map((p) => p.width), [100]);
    assert.deepEqual(planRenditions('avatars', 40, 40).map((p) => p.width), [64]);
  });

  test('JPEG strip drops appended multi-picture images after the primary EOI', async () => {
    const jpg = await photo({ width: 64, height: 64, orientation: 1 });
    const trailer = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1]), Buffer.from('Exif secret-gps-trailer')]);
    const stripped = stripJpegMetadata(Buffer.concat([jpg, trailer]));
    assert.ok(stripped);
    assert.ok(!stripped.includes('secret-gps-trailer'));
    assert.ok(!stripped.includes('iPhone 15 Pro'));
    assert.equal(stripped[stripped.length - 1], 0xd9);
    assert.equal((await sharp(stripped).metadata()).width, 64);
  });

  test('blankIsobmffMetadata leaves a file without metadata items alone', () => {
    const plain = Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from('ftypavif', 'latin1'), Buffer.alloc(4)]);
    assert.ok(blankIsobmffMetadata(plain).equals(plain));
  });
});

describe('job queue persistence', () => {
  test('a job whose worker died (expired lease) is resumed', async () => {
    const { runQuery, getQuery } = await import('../db.js');
    const upload = await uploadFile(await photo({ width: 700, height: 500, orientation: 1 }), 'resume.jpg', 'image/jpeg');
    const id = upload.body.attachments[0].id;
    await waitFor(async () => !(await getQuery(`SELECT 1 AS x FROM media_jobs WHERE file_id = ?`, [id])));
    // Simulate a crash mid-processing: renditions gone, job left 'running'
    // with a lease that has run out.
    await runQuery(`DELETE FROM file_renditions WHERE file_id = ?`, [id]);
    await runQuery(`UPDATE files SET media_status = 'processing' WHERE id = ?`, [id]);
    await runQuery(
      `INSERT INTO media_jobs (id, file_id, kind, status, attempts, run_after, locked_until)
       VALUES (?, ?, 'image', 'running', 1, ?, ?)`,
      [`job-${id}`, id, new Date(Date.now() - 60_000).toISOString(), new Date(Date.now() - 1000).toISOString()]
    );
    // The server's poll (every 15 s) re-queues and processes it.
    const done = await waitFor(async () => {
      const { body } = await meta(id);
      return body.media_status === 'ready' && body.renditions.length ? body : null;
    }, { timeoutMs: 40_000, intervalMs: 500 });
    assert.ok(done, 'the orphaned job was not resumed');
    assert.deepEqual(done.renditions.filter((r) => r.format === 'webp').map((r) => r.width), [160, 480, 700]);
  });
});

describe('garbage collection of derived objects', () => {
  test('collecting a file removes its renditions; stray rendition files are swept', async () => {
    const { STORAGE_ROOT } = await import('../storageService.js');
    const upload = await uploadFile(await photo({ width: 500, height: 500, orientation: 1 }), 'gc.jpg', 'image/jpeg');
    const d = upload.body.attachments[0];
    const renditionPath = path.join(STORAGE_ROOT, d.renditions[0].url.replace(/^\/uploads\//, ''));
    assert.ok(fs.existsSync(renditionPath));

    // A rendition written by a process that crashed before recording it.
    const stray = path.join(STORAGE_ROOT, 'attachments', 'ab', 'cd', `${'ab'.padEnd(64, 'c')}.w480.webp`);
    fs.mkdirSync(path.dirname(stray), { recursive: true });
    fs.writeFileSync(stray, 'stray');
    const old = new Date(Date.now() - 3600_000);
    fs.utimesSync(stray, old, old);

    const swept = await api('POST', '/api/files/maintenance/gc', { apply: true, graceHours: 0 }, ADMIN);
    assert.equal(swept.status, 200);
    assert.ok(swept.body.orphanObjectsRemoved >= 1);
    assert.ok(!fs.existsSync(stray), 'stray rendition removed');
    assert.ok(!fs.existsSync(renditionPath), 'renditions go with their file');
    assert.equal((await meta(d.id)).status, 404);
  });
});
