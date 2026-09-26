// ============================================================================
//  Storage engine
//
//  Every uploaded byte in the system goes through here. Responsibilities:
//
//    1. Validation      — magic-byte sniffing, per-category size/type limits,
//                         decompression-bomb limits for images
//    2. Sanitising      — EXIF/XMP/GPS stripped from images (orientation baked
//                         in), losslessly where the format allows
//    3. Content address — sha256 of the stored bytes IS the filename, so
//                         uploading the same image twice stores it once
//    4. Registry        — one `files` row per stored object, with real metadata
//                         (display width/height, duration, thumbhash)
//    5. Renditions      — responsive WebP/AVIF widths, made by the media job
//                         queue (services/mediaPipeline.js, services/mediaJobs.js)
//    6. Reference count — files are owned by nothing; things *reference* them.
//                         ref_count hits 0 → eligible for garbage collection
//    7. Quotas          — per-user storage_used vs storage_quota (or the
//                         STORAGE_QUOTA_BYTES override)
//    8. Access control  — public / authenticated / private with signed URLs
//    9. Lifecycle       — soft delete, expiry, GC sweep, integrity check
//
//  Backends: `local` writes to disk under STORAGE_ROOT; `s3` is any
//  S3-compatible bucket (lib/s3Client.js). Every row records the backend its
//  bytes live on, so files written before S3 was configured keep being served
//  from disk after it is.
// ============================================================================

import multer from 'multer';
import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

import { runQuery, getQuery, allQuery, transaction, sql } from './db.js';
import { generateId } from './lib/snowflake.js';
import { sniffMime, probeImage, getFileType } from './lib/mediaProbe.js';
import { probeDuration, probeVideoDimensions, ffmpegAvailability } from './lib/mediaDuration.js';
import { s3 } from './lib/s3Client.js';
import {
  loadSharp, inspectImage, sanitizeImage, computeThumbhash, computeTinyPreview,
  pickRendition, MediaError, mediaConfig
} from './lib/imageVariants.js';
import { enqueueJob, waitForJob, startMediaWorkers } from './services/mediaJobs.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- configuration -----------------------------------------------------------

/** Root of all stored objects. Override with STORAGE_ROOT to move off-repo. */
export const STORAGE_ROOT =
  process.env.STORAGE_ROOT || path.join(__dirname, 'public', 'uploads');

/**
 * Public base that maps to stored objects. A path (default `/uploads`) is the
 * static mount in server.js; an absolute URL (`https://cdn.example.com`) is a
 * CDN or public bucket in front of the S3 backend.
 */
export const PUBLIC_BASE = process.env.STORAGE_PUBLIC_BASE || '/uploads';
const PUBLIC_BASE_IS_URL = /^https?:\/\//i.test(PUBLIC_BASE);

/** Secret for signed private-file URLs. */
const URL_SECRET = process.env.STORAGE_URL_SECRET || 'dev-insecure-storage-secret';

const MB = 1024 * 1024;

const IMAGE_MIMES = [
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp',
  'image/avif', 'image/heic', 'image/heif'
];
const AUDIO_MIMES = ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/flac', 'audio/webm'];
const VIDEO_MIMES = ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'video/x-matroska'];
const DOC_MIMES   = ['application/pdf', 'application/json', 'application/zip', 'text/plain'];

/**
 * Per-category policy. `variants` names the legacy rendition kinds the
 * descriptor exposes (thumb/small/medium/large); the actual sizes come from
 * lib/imageVariants.js renditionSpec(). `display` marks categories whose image
 * must be renderable — an undecodable HEIC is refused there, while an
 * attachment keeps it as a download.
 */
export const CATEGORY_RULES = {
  avatars:     { maxSize: 10 * MB,     mimes: IMAGE_MIMES, square: true, display: true, variants: [{ kind: 'thumb', size: 64 }, { kind: 'small', size: 128 }, { kind: 'medium', size: 256 }, { kind: 'large', size: 512 }] },
  banners:     { maxSize: 15 * MB,     mimes: IMAGE_MIMES, display: true, variants: [{ kind: 'small', size: 480 }, { kind: 'large', size: 1920 }] },
  icons:       { maxSize: 10 * MB,     mimes: IMAGE_MIMES, square: true, display: true, variants: [{ kind: 'thumb', size: 64 }, { kind: 'small', size: 128 }, { kind: 'medium', size: 256 }, { kind: 'large', size: 512 }] },
  splashes:    { maxSize: 15 * MB,     mimes: IMAGE_MIMES, display: true, variants: [{ kind: 'large', size: 1920 }] },
  emojis:      { maxSize: 512 * 1024,  mimes: IMAGE_MIMES, square: true, display: true, variants: [{ kind: 'thumb', size: 48 }, { kind: 'small', size: 96 }] },
  stickers:    { maxSize: 1 * MB,      mimes: [...IMAGE_MIMES, 'application/json'], display: true, variants: [{ kind: 'thumb', size: 160 }, { kind: 'medium', size: 320 }] },
  audio:       { maxSize: 25 * MB,     mimes: AUDIO_MIMES, variants: [] },
  video:       { maxSize: 100 * MB,    mimes: VIDEO_MIMES, variants: [] },
  attachments: { maxSize: 50 * MB,     mimes: [...IMAGE_MIMES, ...AUDIO_MIMES, ...VIDEO_MIMES, ...DOC_MIMES], variants: [{ kind: 'thumb', size: 160 }, { kind: 'small', size: 480 }, { kind: 'medium', size: 960 }, { kind: 'large', size: 1920 }] },
  misc:        { maxSize: 25 * MB,     mimes: [...IMAGE_MIMES, ...DOC_MIMES], variants: [] }
};

export const STORAGE_CATEGORIES = Object.keys(CATEGORY_RULES).reduce((acc, key) => {
  acc[key.toUpperCase()] = path.join(STORAGE_ROOT, key);
  return acc;
}, {});

/** @deprecated use STORAGE_ROOT — kept so older imports keep resolving. */
export const UPLOADS_BASE_DIR = STORAGE_ROOT;

/**
 * How long an upload request waits for its renditions before answering with
 * `media_status: 'processing'`. The WebP set for a 12 MP photo takes ~1 s;
 * AVIF is always finished in the background.
 */
const syncBudgetMs = () => {
  const n = Number(process.env.MEDIA_SYNC_BUDGET_MS);
  return Number.isFinite(n) && n >= 0 ? n : 10_000;
};

// --- errors ------------------------------------------------------------------

export class StorageError extends Error {
  constructor(message, { status = 400, code = 'STORAGE_ERROR' } = {}) {
    super(message);
    this.name = 'StorageError';
    this.status = status;
    this.code = code;
  }
}

const fromMediaError = (err) => (err instanceof MediaError
  ? new StorageError(err.message, { status: err.status, code: err.code })
  : err);

// --- initialisation ----------------------------------------------------------

/**
 * @param {object} [opts]
 * @param {boolean} [opts.workers=true] start the media job workers (the CLI
 *   passes false so a one-shot command does not pick up background work)
 */
export async function initStorage({ workers = true } = {}) {
  for (const category of Object.keys(CATEGORY_RULES)) {
    await fsp.mkdir(path.join(STORAGE_ROOT, category), { recursive: true });
  }
  await fsp.mkdir(path.join(STORAGE_ROOT, '.tmp'), { recursive: true });
  const sharp = await loadSharp();
  console.log(sharp
    ? '🖼️  sharp detected — image renditions enabled.'
    : 'ℹ️  sharp not installed — storing originals only (no renditions).');
  if (workers) await startMediaWorkers();
  console.log(`📁 Storage ready at ${activeBackend() === 's3' ? `s3://${s3.bucket}` : STORAGE_ROOT}`);
}

/** @deprecated synchronous alias retained for older call sites. */
export function initStorageDirectories() {
  for (const category of Object.keys(CATEGORY_RULES)) {
    fs.mkdirSync(path.join(STORAGE_ROOT, category), { recursive: true });
  }
  fs.mkdirSync(path.join(STORAGE_ROOT, '.tmp'), { recursive: true });
}

/** What the media pipeline can do on this instance — for /api/media/config and health. */
export async function mediaCapabilities() {
  const cfg = mediaConfig();
  const sharp = await loadSharp();
  const { ffmpeg, ffprobe } = await ffmpegAvailability();
  return {
    backend: activeBackend(),
    renditions: Boolean(sharp),
    formats: sharp ? ['webp', ...(cfg.avif ? ['avif'] : [])] : [],
    widths: cfg.widths,
    video_posters: ffmpeg,
    video_probe: ffprobe,
    max_pixels: cfg.maxPixels,
    max_dimension: cfg.maxDimension
  };
}

// --- backends ----------------------------------------------------------------

export const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

/**
 * Objects are sharded two levels deep by hash prefix. Flat directories with
 * 100k+ entries are slow to stat on every filesystem that matters.
 *   attachments/a1/b2/a1b2c3...ef.png
 *   attachments/a1/b2/a1b2c3...ef.w480.webp      (a rendition)
 */
export function buildStorageKey(category, hash, ext, suffix = '') {
  const stem = suffix ? `${hash}.${suffix}` : hash;
  const filename = ext ? `${stem}.${ext}` : stem;
  return path.posix.join(category, hash.slice(0, 2), hash.slice(2, 4), filename);
}

function absolutePath(storageKey) {
  const resolved = path.resolve(STORAGE_ROOT, storageKey);
  // Defence in depth: a storage_key must never escape the root.
  if (!resolved.startsWith(path.resolve(STORAGE_ROOT) + path.sep)) {
    throw new StorageError('Invalid storage key', { status: 400, code: 'BAD_KEY' });
  }
  return resolved;
}

/**
 * Which backend new bytes go to. Local disk unless S3 is fully configured,
 * so a development machine needs no credentials and production needs no code
 * change — only environment variables.
 */
export function activeBackend() {
  return s3.configured ? 's3' : 'local';
}

const isRemote = (backend) => backend === 's3' || backend === 'r2';

export async function writeObject(storageKey, buffer, contentType, backend = activeBackend()) {
  if (isRemote(backend)) {
    await s3.putObject(storageKey, buffer, contentType);
    return;
  }
  return writeLocalObject(storageKey, buffer);
}

async function writeLocalObject(storageKey, buffer) {
  const target = absolutePath(storageKey);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  // Write to a temp file then rename: a crash mid-write can never leave a
  // half-written object at a key the database already points at.
  const tmp = path.join(STORAGE_ROOT, '.tmp', `${crypto.randomUUID()}.part`);
  await fsp.mkdir(path.dirname(tmp), { recursive: true });
  await fsp.writeFile(tmp, buffer);
  await fsp.rename(tmp, target);
}

/** Whole object into memory (bounded by the category size limits). */
export async function readObject(storageKey, backend = activeBackend()) {
  if (isRemote(backend)) return s3.getObject(storageKey);
  try { return await fsp.readFile(absolutePath(storageKey)); }
  catch (err) { if (err.code === 'ENOENT') return null; throw err; }
}

async function objectExists(storageKey, backend = activeBackend()) {
  if (isRemote(backend)) {
    try { return Boolean(await s3.headObject(storageKey)); }
    catch { return false; }
  }
  try { await fsp.access(absolutePath(storageKey)); return true; }
  catch { return false; }
}

export async function removeObject(storageKey, backend = activeBackend()) {
  if (isRemote(backend)) {
    try { await s3.deleteObject(storageKey); return true; }
    catch { return false; }
  }
  try { await fsp.unlink(absolutePath(storageKey)); return true; }
  catch (err) { if (err.code !== 'ENOENT') throw err; return false; }
}

export function readObjectStream(storageKey, range = undefined) {
  return fs.createReadStream(absolutePath(storageKey), range);
}

export { absolutePath as resolveStoragePath };

// --- URLs --------------------------------------------------------------------

/**
 * Public URL of a stored object. With a CDN/bucket base that is where the
 * bytes are fetched from; with the default `/uploads` base it is the static
 * mount (local) or the redirecting fallback in routes/media.js (S3).
 */
export function publicUrl(storageKey) {
  return `${PUBLIC_BASE.replace(/\/$/, '')}/${String(storageKey).split(path.sep).join('/')}`;
}

/** Time-limited signature for handing a private file to a client. */
export function signFileUrl(fileId, { ttlSeconds = 3600, variant = null } = {}) {
  const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = `${fileId}:${variant ?? ''}:${expires}`;
  const sig = crypto.createHmac('sha256', URL_SECRET).update(payload).digest('base64url');
  const params = new URLSearchParams({ expires: String(expires), sig });
  if (variant) params.set('variant', variant);
  return `/api/files/${fileId}?${params}`;
}

export function verifyFileSignature(fileId, { expires, sig, variant = null }) {
  if (!expires || !sig) return false;
  if (Number(expires) < Math.floor(Date.now() / 1000)) return false;
  const payload = `${fileId}:${variant ?? ''}:${expires}`;
  const expected = crypto.createHmac('sha256', URL_SECRET).update(payload).digest('base64url');
  // Constant-time compare; lengths must match or timingSafeEqual throws.
  const a = Buffer.from(String(sig));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// --- quotas ------------------------------------------------------------------

/**
 * STORAGE_QUOTA_BYTES, when set, is every user's quota (0 = unlimited) and
 * overrides the per-user column; unset, users.storage_quota applies.
 */
function quotaOverride() {
  const raw = process.env.STORAGE_QUOTA_BYTES;
  if (raw === undefined || raw === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export async function getStorageUsage(userId) {
  const user = await getQuery(
    `SELECT storage_used, storage_quota FROM users WHERE id = ?`, [userId]
  );
  if (!user) return null;
  const used = user.storage_used ?? 0;
  const quota = quotaOverride() ?? user.storage_quota ?? 0;
  return {
    used,
    quota,
    used_human: formatBytes(used),
    quota_human: formatBytes(quota),
    remaining: Math.max(0, quota - used),
    percent: quota > 0 ? Math.round((used / quota) * 1000) / 10 : 0
  };
}

export async function assertQuota(userId, incomingBytes) {
  if (!userId) return;
  const usage = await getStorageUsage(userId);
  if (!usage || usage.quota <= 0) return;
  if (usage.used + incomingBytes > usage.quota) {
    throw new StorageError(
      `Storage quota exceeded (${formatBytes(usage.used)} of ${formatBytes(usage.quota)} used)`,
      { status: 413, code: 'QUOTA_EXCEEDED' }
    );
  }
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// --- validation & preparation -------------------------------------------------

/**
 * Everything decided from the bytes alone: the real type, image safety
 * limits, stripped metadata, display dimensions, duration and placeholders.
 * Shared by the multipart upload path and the direct-upload ingest job.
 *
 * @returns {Promise<{buffer, sniffed, info, durationSecs, thumbhash, preview, mediaStatus}>}
 */
export async function prepareUpload({ buffer, category, declaredMime, originalName }) {
  const rules = CATEGORY_RULES[category];
  if (!rules) {
    throw new StorageError(`Unknown storage category '${category}'`, { code: 'BAD_CATEGORY' });
  }
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new StorageError('Empty upload', { code: 'EMPTY_FILE' });
  }
  if (buffer.length > rules.maxSize) {
    throw new StorageError(
      `File too large for ${category}: ${formatBytes(buffer.length)} > ${formatBytes(rules.maxSize)}`,
      { status: 413, code: 'FILE_TOO_LARGE' }
    );
  }

  // Trust the bytes, not the header.
  const sniffed = sniffMime(buffer, declaredMime, originalName);
  if (!rules.mimes.includes(sniffed.mime)) {
    throw new StorageError(
      `File type ${sniffed.mime} is not allowed in ${category}` +
      (sniffed.mime !== declaredMime ? ` (declared as ${declaredMime})` : ''),
      { status: 415, code: 'UNSUPPORTED_TYPE' }
    );
  }

  let info = null;
  let durationSecs = null;
  let thumbhash = null;
  let preview = null;
  let mediaStatus = null;

  if (sniffed.mime.startsWith('image/')) {
    try {
      info = await inspectImage(buffer, sniffed.mime);
    } catch (err) {
      throw fromMediaError(err);
    }
    if (!info.decodable && rules.display && sniffed.mime !== 'image/svg+xml') {
      throw new StorageError(
        `${sniffed.mime} images cannot be displayed here; convert to JPEG, PNG or WebP`,
        { status: 415, code: 'UNSUPPORTED_TYPE' }
      );
    }
    try {
      const clean = await sanitizeImage(buffer, sniffed.mime, info);
      buffer = clean.buffer;
    } catch (err) {
      throw new StorageError(`Image could not be processed: ${err.message}`, { status: 415, code: 'CORRUPT_IMAGE' });
    }
    if (info.decodable) {
      try {
        [thumbhash, preview] = await Promise.all([computeThumbhash(buffer), computeTinyPreview(buffer)]);
      } catch (err) {
        console.warn(`⚠️  placeholder failed: ${err.message}`);
      }
      mediaStatus = (await loadSharp()) ? 'processing' : 'ready';
    } else if (sniffed.mime !== 'image/svg+xml') {
      mediaStatus = 'unsupported';
    }
  } else if (sniffed.mime.startsWith('video/')) {
    info = probeVideoDimensions(buffer, sniffed.mime);
    durationSecs = probeDuration(buffer, sniffed.mime);
    mediaStatus = (await ffmpegAvailability()).ffmpeg ? 'processing' : 'ready';
  } else {
    // Audio carries its length in the container; no ffmpeg needed.
    durationSecs = probeDuration(buffer, sniffed.mime);
  }

  return { buffer, sniffed, info, durationSecs, thumbhash, preview, mediaStatus };
}

/** Job kind that finishes a file's processing, or null when nothing is left to do. */
export function processingJobFor(mime, mediaStatus) {
  if (mediaStatus !== 'processing') return null;
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('image/')) return 'image';
  return null;
}

// --- the main entry point ----------------------------------------------------

/**
 * Validate, sanitise, store and register one upload.
 *
 * @param {object}  opts
 * @param {Buffer}  opts.buffer
 * @param {string}  opts.originalName
 * @param {string}  opts.declaredMime  client-provided Content-Type (untrusted)
 * @param {string}  opts.category      key of CATEGORY_RULES
 * @param {string} [opts.uploaderId]
 * @param {string} [opts.visibility]   public | authenticated | private
 * @param {number} [opts.expiresInSeconds]
 * @param {boolean}[opts.skipVariants] register only; no renditions
 * @param {number} [opts.waitMs]       how long to wait for renditions
 * @returns {Promise<object>} the files row plus `url`, `file_type`, `variants`, `renditions`
 */
export async function storeFile({
  buffer,
  originalName = 'file',
  declaredMime = 'application/octet-stream',
  category = 'attachments',
  uploaderId = null,
  visibility = 'public',
  expiresInSeconds = null,
  skipVariants = false,
  waitMs = syncBudgetMs()
}) {
  const prepared = await prepareUpload({ buffer, category, declaredMime, originalName });
  const { sniffed, info, durationSecs, thumbhash, preview } = prepared;
  buffer = prepared.buffer;
  let mediaStatus = prepared.mediaStatus;
  if (skipVariants && mediaStatus === 'processing') mediaStatus = 'ready';

  await assertQuota(uploaderId, buffer.length);

  const hash = sha256(buffer);
  const safeName = sanitizeFilename(originalName);

  // Dedupe: identical bytes in the same category reuse the existing object.
  const existing = await getQuery(
    `SELECT * FROM files WHERE hash = ? AND category = ? AND deleted_at IS NULL`,
    [hash, category]
  );
  if (existing) {
    if (!(await objectExists(existing.storage_key, existing.backend))) {
      // Registry says it exists but the bytes are gone (manual deletion, or a
      // restored database without its objects). Re-materialise instead of
      // handing out a URL that 404s.
      await writeObject(existing.storage_key, buffer, existing.mime_type, existing.backend);
    }
    await runQuery(
      `UPDATE files SET last_accessed_at = ${sql.now} WHERE id = ?`,
      [existing.id]
    );
    // An older upload from before the pipeline: give it renditions now.
    const job = !skipVariants && !existing.media_status
      ? processingJobFor(existing.mime_type, prepared.mediaStatus) : null;
    if (job) {
      await runQuery(`UPDATE files SET media_status = 'processing' WHERE id = ?`, [existing.id]);
      await enqueueJob(existing.id, job);
      if (waitMs > 0) await waitForJob(existing.id, job, waitMs);
    }
    const fresh = job ? await getQuery(`SELECT * FROM files WHERE id = ?`, [existing.id]) : existing;
    return withUrls({ ...fresh, deduped: true }, await loadVariants(existing.id), await loadRenditions(existing.id));
  }

  const ext = sniffed.ext || path.extname(safeName).replace('.', '').toLowerCase() || null;
  const storageKey = buildStorageKey(category, hash, ext);
  const backend = activeBackend();

  await writeObject(storageKey, buffer, sniffed.mime, backend);

  const id = generateId();
  const expiresAt = expiresInSeconds
    ? new Date(Date.now() + expiresInSeconds * 1000).toISOString()
    : null;

  try {
    await transaction(async () => {
      await runQuery(
        `INSERT INTO files (id, hash, storage_key, backend, category, original_name,
                            mime_type, extension, size, width, height, duration_secs,
                            is_animated, uploader_id, ref_count, visibility, scan_status,
                            expires_at, last_accessed_at, blurhash, thumbhash, media_status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?,
                 ${sql.now}, ?, ?, ?)`,
        [id, hash, storageKey, backend, category, safeName, sniffed.mime, ext,
         buffer.length, info?.width ?? null, info?.height ?? null, durationSecs,
         info?.animated ? 1 : 0, uploaderId, visibility,
         sniffed.confident ? 'clean' : 'pending', expiresAt, preview, thumbhash, mediaStatus]
      );
      if (uploaderId) {
        await runQuery(
          `UPDATE users SET storage_used = storage_used + ? WHERE id = ?`,
          [buffer.length, uploaderId]
        );
      }
    });
  } catch (err) {
    await removeObject(storageKey, backend); // never leave an unreferenced object behind
    throw err;
  }

  // Enqueued after the commit so a worker can see the row. A crash in between
  // leaves media_status 'processing' with no job, which the pipeline's boot
  // repair (services/mediaPipeline.js) re-enqueues.
  const job = processingJobFor(sniffed.mime, mediaStatus);
  if (job) {
    await enqueueJob(id, job);
    if (waitMs > 0) await waitForJob(id, job, waitMs);
  }

  const record = await getQuery(`SELECT * FROM files WHERE id = ?`, [id]);
  return withUrls(record, await loadVariants(id), await loadRenditions(id));
}

export function sanitizeFilename(name) {
  const base = path.basename(String(name)).normalize('NFC');
  // Keep unicode (Thai filenames matter here) but strip path and control chars.
  const cleaned = base.replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_').trim();
  return (cleaned || 'file').slice(0, 200);
}

// --- variants & renditions ---------------------------------------------------

export async function loadVariants(fileId) {
  return allQuery(
    `SELECT kind, storage_key, mime_type, width, height, size FROM file_variants WHERE file_id = ?`,
    [fileId]
  );
}

export async function loadRenditions(fileId) {
  return allQuery(
    `SELECT bucket, format, storage_key, mime_type, width, height, size, animated
       FROM file_renditions WHERE file_id = ? ORDER BY format, bucket`,
    [fileId]
  );
}

/**
 * URL of a stored object. Public files are addressed by key (static mount,
 * CDN, or the S3 redirect fallback) — content-addressed and cacheable
 * forever. Everything else goes through the access-controlled routes.
 */
function objectUrl(file, storageKey, fallback) {
  return file.visibility === 'public' && !String(storageKey).startsWith('incoming/')
    ? publicUrl(storageKey)
    : fallback;
}

/**
 * Attach `url`, `file_type`, a legacy `variants` map keyed by kind, and the
 * responsive `renditions` list with ready-made `srcset` strings.
 */
export function withUrls(file, variants = [], renditions = []) {
  if (!file) return null;
  const rules = CATEGORY_RULES[file.category] ?? {};

  const renditionList = renditions.map((r) => ({
    format: r.format,
    width: r.width,
    height: r.height,
    size: r.size,
    bucket: r.bucket,
    mime_type: r.mime_type,
    animated: Boolean(r.animated),
    url: objectUrl(file, r.storage_key, `/api/media/${file.id}?w=${r.bucket}&f=${r.format}`)
  }));

  const variantMap = {};
  for (const v of variants) {
    variantMap[v.kind] = {
      ...v,
      url: objectUrl(file, v.storage_key, `/api/files/${file.id}?variant=${v.kind}`)
    };
  }
  // The old thumb/small/medium/large kinds, now served by the closest WebP
  // rendition, so existing client code keeps working unchanged.
  const webp = renditionList.filter((r) => r.format === 'webp');
  for (const spec of rules.variants ?? []) {
    if (variantMap[spec.kind] || !webp.length) continue;
    const pick = pickRendition(webp, spec.size);
    variantMap[spec.kind] = {
      kind: spec.kind, storage_key: null, mime_type: pick.mime_type,
      width: pick.width, height: pick.height, size: pick.size, url: pick.url
    };
  }

  const srcset = {};
  for (const format of ['avif', 'webp']) {
    const list = renditionList.filter((r) => r.format === format);
    if (list.length) srcset[format] = list.map((r) => `${r.url} ${r.width}w`).join(', ');
  }

  const isImage = getFileType(file.mime_type) === 'image';
  const undisplayable = file.media_status === 'unsupported';
  const processingIncoming = String(file.storage_key).startsWith('incoming/');
  return {
    ...file,
    // HEIC without a decoder is a download, not an <img>.
    file_type: undisplayable ? 'file' : getFileType(file.mime_type),
    url: processingIncoming ? `/api/files/${file.id}` : objectUrl(file, file.storage_key, `/api/files/${file.id}`),
    download_url: `/api/files/${file.id}?download=1`,
    // Best format for the viewer's browser at a requested width: ?w=<px>.
    display_url: isImage && !undisplayable && file.mime_type !== 'image/svg+xml' ? `/api/media/${file.id}` : null,
    variants: variantMap,
    renditions: renditionList,
    srcset
  };
}

export async function getFile(fileId, { includeDeleted = false } = {}) {
  const file = await getQuery(
    `SELECT * FROM files WHERE id = ?${includeDeleted ? '' : ' AND deleted_at IS NULL'}`,
    [fileId]
  );
  if (!file) return null;
  return withUrls(file, await loadVariants(fileId), await loadRenditions(fileId));
}

/**
 * Reverse-resolve a public URL back to its files row.
 *
 * Needed because clients naturally store the URL they got from an upload, not
 * the file id. Without this, a file whose only pointer is a URL in
 * users.avatar_url would look unreferenced and be garbage-collected.
 */
export async function findFileByPublicUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const prefix = `${PUBLIC_BASE.replace(/\/$/, '')}/`;
  const idx = url.indexOf(prefix);
  if (idx === -1) {
    // /api/media/<id> display URLs (and /api/files/<id>) name the file directly.
    const byId = /^\/api\/(?:media|files)\/(\d+)(?:[/?]|$)/.exec(url);
    if (!byId) return null;  // an external URL (Unsplash, dicebear…) — not ours
    return getQuery(`SELECT * FROM files WHERE id = ? AND deleted_at IS NULL`, [byId[1]]);
  }
  const storageKey = url.slice(idx + prefix.length).split('?')[0];
  const direct = await getQuery(
    `SELECT * FROM files WHERE storage_key = ? AND deleted_at IS NULL`, [storageKey]
  );
  if (direct) return direct;
  // A rendition or legacy variant URL (e.g. an avatar saved as its 256px WebP).
  const owner = await getQuery(
    `SELECT file_id FROM file_renditions WHERE storage_key = ?
     UNION SELECT file_id FROM file_variants WHERE storage_key = ?`,
    [storageKey, storageKey]
  );
  return owner
    ? getQuery(`SELECT * FROM files WHERE id = ? AND deleted_at IS NULL`, [owner.file_id])
    : null;
}

export function getVariant(fileId, kind) {
  return getQuery(`SELECT * FROM file_variants WHERE file_id = ? AND kind = ?`, [fileId, kind]);
}

export function listFilesForUser(userId, { category = null, limit = 50, before = null } = {}) {
  const where = ['uploader_id = ?', 'deleted_at IS NULL'];
  const params = [userId];
  if (category) { where.push('category = ?'); params.push(category); }
  if (before)   { where.push('id < ?');       params.push(before); }
  params.push(Math.min(Number(limit) || 50, 200));
  return allQuery(
    `SELECT * FROM files WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ?`, params
  );
}

// --- serving -------------------------------------------------------------------

/**
 * Parse a Range header against a size (RFC 9110 §14): `bytes=a-b`, `a-` and
 * the suffix form `-n`. Multiple ranges are answered with the whole body,
 * which the RFC allows. Returns {start, end}, 'unsatisfiable', or null.
 */
export function parseRange(header, size) {
  if (!header || !/^bytes=/i.test(header)) return null;
  const spec = header.slice(6).trim();
  if (spec.includes(',')) return null;
  const match = /^(\d*)-(\d*)$/.exec(spec);
  if (!match || (match[1] === '' && match[2] === '')) return null;
  let start;
  let end;
  if (match[1] === '') {
    const suffix = Number(match[2]);
    if (suffix === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start >= size || start > end) return 'unsatisfiable';
  return { start, end };
}

const etagMatches = (header, etag) => Boolean(header)
  && header.split(',').map((t) => t.trim().replace(/^W\//, '')).some((t) => t === etag || t === '*');

/**
 * Send one stored object with the headers every upload needs.
 *   local: streamed here, with Range (206/416), ETag/304 and HEAD support.
 *   s3:    302 to a short-lived presigned URL — the bucket does Range itself
 *          and the bytes never transit this process.
 */
export async function sendStoredObject(req, res, {
  storageKey, backend, mime, etag, cacheControl, filename = null, download = false, vary = null
}) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  if (vary) res.setHeader('Vary', vary);
  const disposition = filename
    ? `${download || getFileType(mime) === 'file' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(filename)}`
    : null;

  if (isRemote(backend)) {
    const ttl = 3600;
    const location = PUBLIC_BASE_IS_URL && cacheControl.startsWith('public') && !download
      ? publicUrl(storageKey)
      : s3.presignGet(storageKey, { expiresIn: ttl, disposition, contentType: mime });
    // The redirect itself may be cached, but never beyond the signature's life.
    res.setHeader('Cache-Control', cacheControl.startsWith('public')
      ? 'public, max-age=600' : 'private, max-age=600');
    res.redirect(302, location);
    return;
  }

  let stat;
  const absolute = absolutePath(storageKey);
  try { stat = await fsp.stat(absolute); }
  catch { throw new StorageError('File bytes are missing from storage', { status: 410, code: 'BYTES_GONE' }); }

  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', cacheControl);
  res.setHeader('ETag', etag);
  res.setHeader('Accept-Ranges', 'bytes');
  if (disposition) res.setHeader('Content-Disposition', disposition);

  if (etagMatches(req.headers['if-none-match'], etag)) {
    res.status(304).end();
    return { bytes: 0 };
  }

  // If-Range: only honour the range when the client's copy is still current.
  const ifRange = req.headers['if-range'];
  const range = ifRange && ifRange !== etag ? null : parseRange(req.headers.range, stat.size);
  if (range === 'unsatisfiable') {
    res.setHeader('Content-Range', `bytes */${stat.size}`);
    res.status(416).end();
    return { bytes: 0 };
  }
  if (range) {
    res.status(206);
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`);
    res.setHeader('Content-Length', range.end - range.start + 1);
    if (req.method === 'HEAD') { res.end(); return { bytes: 0 }; }
    fs.createReadStream(absolute, range).pipe(res);
    return { bytes: range.end - range.start + 1 };
  }
  res.setHeader('Content-Length', stat.size);
  if (req.method === 'HEAD') { res.end(); return { bytes: 0 }; }
  fs.createReadStream(absolute).pipe(res);
  return { bytes: stat.size };
}

// --- reference counting ------------------------------------------------------

/**
 * Claim a reference to a file. Call this whenever a row starts pointing at a
 * file (message attachment, avatar, emoji…) so GC leaves it alone.
 */
export async function addReference(fileId, count = 1) {
  if (!fileId) return;
  await runQuery(
    `UPDATE files
        SET ref_count = ref_count + ?,
            last_accessed_at = ${sql.now}
      WHERE id = ?`,
    [count, fileId]
  );
}

/** Release a reference. Hitting zero makes the file GC-eligible, not deleted. */
export async function releaseReference(fileId, count = 1) {
  if (!fileId) return;
  await runQuery(
    `UPDATE files SET ref_count = ${sql.greatest(0, 'ref_count - ?')} WHERE id = ?`, [count, fileId]
  );
}

export async function recordAccess(fileId, { userId = null, ip = null, variant = null, bytes = null } = {}) {
  await runQuery(
    `UPDATE files SET last_accessed_at = ${sql.now} WHERE id = ?`,
    [fileId]
  );
  await runQuery(
    `INSERT INTO file_access_log (id, file_id, user_id, ip_address, variant, bytes_sent)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [generateId(), fileId, userId, ip, variant, bytes]
  );
}

// --- deletion & garbage collection ------------------------------------------

/** Soft delete. Bytes survive until the next GC sweep, so this stays reversible. */
export async function deleteFile(fileId, { force = false } = {}) {
  const file = await getQuery(`SELECT * FROM files WHERE id = ? AND deleted_at IS NULL`, [fileId]);
  if (!file) return false;
  if (file.ref_count > 0 && !force) {
    throw new StorageError(
      `File is still referenced ${file.ref_count} time(s)`,
      { status: 409, code: 'FILE_IN_USE' }
    );
  }
  await runQuery(
    `UPDATE files SET deleted_at = ${sql.now} WHERE id = ?`, [fileId]
  );
  return true;
}

/**
 * Reclaim disk. Removes bytes for files that are
 *   (a) soft-deleted, or
 *   (b) past expires_at, or
 *   (c) unreferenced and older than `orphanGraceMs` — an upload that was never
 *       attached to anything, e.g. the user abandoned the compose box.
 * Then sweeps rendition/variant objects left on disk with no row (a crash
 * between writing a rendition and recording it), older than the same grace.
 */
export const DEFAULT_ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_GC_LIMIT = 500;

export async function collectGarbage({
  orphanGraceMs = DEFAULT_ORPHAN_GRACE_MS,
  dryRun = false,
  limit = DEFAULT_GC_LIMIT
} = {}) {
  const graceCutoff = new Date(Date.now() - orphanGraceMs).toISOString();
  const nowIso = new Date().toISOString();

  const candidates = await allQuery(
    `SELECT * FROM files
      WHERE deleted_at IS NOT NULL
         OR (expires_at IS NOT NULL AND expires_at <= ?)
         OR (ref_count = 0 AND created_at <= ?)
      ORDER BY created_at ASC
      LIMIT ?`,
    [nowIso, graceCutoff, limit]
  );

  const result = {
    scanned: candidates.length,
    removed: 0, bytesFreed: 0,          // what actually happened
    wouldRemove: 0, wouldFreeBytes: 0,  // what a real run would do
    orphanObjectsRemoved: 0,
    errors: [], dryRun
  };

  for (const file of candidates) {
    try {
      const variants = await allQuery(
        `SELECT storage_key, size FROM file_variants WHERE file_id = ?`, [file.id]
      );
      const renditions = await allQuery(
        `SELECT storage_key FROM file_renditions WHERE file_id = ?`, [file.id]
      );
      // Renditions are the server's choice and never counted against the
      // uploader's quota, so only the original and legacy variants are refunded.
      const bytes = file.size + variants.reduce((sum, v) => sum + (v.size ?? 0), 0);

      if (!dryRun) {
        // Another live row may point at the same object; check before unlinking
        // so dedupe survives GC.
        const shared = await getQuery(
          `SELECT count(*) AS c FROM files
            WHERE storage_key = ? AND id != ? AND deleted_at IS NULL`,
          [file.storage_key, file.id]
        );
        if (!shared || Number(shared.c) === 0) {
          await removeObject(file.storage_key, file.backend);
          for (const v of [...variants, ...renditions]) await removeObject(v.storage_key, file.backend);
        }
        await transaction(async () => {
          await runQuery(`DELETE FROM file_variants WHERE file_id = ?`, [file.id]);
          await runQuery(`DELETE FROM file_renditions WHERE file_id = ?`, [file.id]);
          await runQuery(`DELETE FROM media_jobs WHERE file_id = ?`, [file.id]);
          await runQuery(`DELETE FROM files WHERE id = ?`, [file.id]);
          if (file.uploader_id) {
            await runQuery(
              `UPDATE users SET storage_used = ${sql.greatest(0, 'storage_used - ?')} WHERE id = ?`,
              [bytes, file.uploader_id]
            );
          }
        });
      }

      // A dry run must not claim it removed anything. The counters a script
      // reads have to mean what they say: `removed` is what is gone from disk,
      // `wouldRemove` is what a real run would take. Reporting both, always,
      // saves the caller from branching on `dryRun` and getting it wrong.
      result.wouldRemove += 1;
      result.wouldFreeBytes += bytes;
      if (!dryRun) {
        result.removed += 1;
        result.bytesFreed += bytes;
      }
    } catch (err) {
      result.errors.push({ fileId: file.id, message: err.message });
    }
  }

  if (!dryRun) {
    try {
      result.orphanObjectsRemoved = await sweepOrphanDerivedObjects({ olderThanMs: orphanGraceMs });
    } catch (err) {
      result.errors.push({ fileId: null, message: `orphan sweep: ${err.message}` });
    }
  }

  if (result.wouldRemove || result.orphanObjectsRemoved) {
    console.log(
      `🧹 GC ${dryRun ? '(dry run) would free' : 'freed'} ${formatBytes(result.wouldFreeBytes)} ` +
      `across ${result.wouldRemove} file(s)` +
      (result.orphanObjectsRemoved ? `, ${result.orphanObjectsRemoved} orphaned rendition(s)` : '')
    );
  }
  return result;
}

/** Rendition/variant filenames carry a suffix: <hash>.<suffix>.<ext>. */
const DERIVED_NAME = /^[0-9a-f]{64}\.[a-z0-9]+\.[a-z0-9]+$/;

/**
 * Delete derived objects on local disk that no row points at. Originals are
 * never touched here — only files named like a rendition — so a mistake can
 * cost a thumbnail, not a user's upload. (S3: use a bucket lifecycle rule;
 * listing a whole bucket from the app is not worth its cost.)
 */
async function sweepOrphanDerivedObjects({ olderThanMs }) {
  const cutoff = Date.now() - olderThanMs;
  let removed = 0;
  for (const category of Object.keys(CATEGORY_RULES)) {
    for await (const abs of walk(path.join(STORAGE_ROOT, category))) {
      if (!DERIVED_NAME.test(path.basename(abs))) continue;
      const key = path.relative(STORAGE_ROOT, abs).split(path.sep).join('/');
      const known = await getQuery(
        `SELECT 1 AS k FROM file_renditions WHERE storage_key = ?
         UNION SELECT 1 AS k FROM file_variants WHERE storage_key = ?
         UNION SELECT 1 AS k FROM files WHERE storage_key = ?`,
        [key, key, key]
      );
      if (known) continue;
      const stat = await fsp.stat(abs).catch(() => null);
      if (!stat || stat.mtimeMs > cutoff) continue;
      await fsp.unlink(abs).catch(() => {});
      removed += 1;
    }
  }
  return removed;
}

/** Find registry rows whose bytes are missing, and objects with no registry row. */
export async function verifyIntegrity() {
  const files = await allQuery(`SELECT id, storage_key, size, backend FROM files WHERE deleted_at IS NULL`);
  const missingBytes = [];
  const known = new Set();

  for (const f of files) {
    known.add(f.storage_key);
    if (String(f.storage_key).startsWith('incoming/')) continue;   // mid-ingest
    if (!(await objectExists(f.storage_key, f.backend))) missingBytes.push(f);
  }

  const orphanObjects = [];
  for (const category of Object.keys(CATEGORY_RULES)) {
    for await (const abs of walk(path.join(STORAGE_ROOT, category))) {
      const key = path.relative(STORAGE_ROOT, abs).split(path.sep).join('/');
      if (known.has(key)) continue;
      const derived = await getQuery(
        `SELECT id FROM file_variants WHERE storage_key = ?
         UNION SELECT id FROM file_renditions WHERE storage_key = ?`, [key, key]
      );
      if (!derived) orphanObjects.push(key);
    }
  }

  return { totalFiles: files.length, missingBytes, orphanObjects };
}

async function* walk(dir) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
  catch { return; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

/** Start a periodic GC sweep. Returns a stop function. */
export function startGarbageCollector({ intervalMs = 6 * 60 * 60 * 1000, ...opts } = {}) {
  const timer = setInterval(() => {
    collectGarbage(opts).catch((err) => console.error('GC sweep failed:', err));
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

// --- multer middleware -------------------------------------------------------

// Memory storage: we must hash and sniff the bytes before deciding where — or
// whether — they land on disk. The limits below cap what can be buffered.
function makeUploader(category, { maxFiles = 1 } = {}) {
  const rules = CATEGORY_RULES[category];
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: rules.maxSize, files: maxFiles, fields: 20 },
    fileFilter: (req, file, cb) => {
      // Cheap pre-filter on the declared type; storeFile does the real check.
      if (rules.mimes.includes(file.mimetype) || file.mimetype === 'application/octet-stream') {
        cb(null, true);
      } else {
        cb(new StorageError(
          `File type ${file.mimetype} is not allowed in ${category}`,
          { status: 415, code: 'UNSUPPORTED_TYPE' }
        ));
      }
    }
  });
}

export const uploadAvatar     = makeUploader('avatars');
export const uploadBanner     = makeUploader('banners');
export const uploadServerIcon = makeUploader('icons');
export const uploadEmoji      = makeUploader('emojis');
export const uploadSticker    = makeUploader('stickers');
export const uploadAttachment = makeUploader('attachments', { maxFiles: 10 });

export { getFileType, probeImage };
