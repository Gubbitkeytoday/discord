// ============================================================================
//  Storage engine
//
//  Every uploaded byte in the system goes through here. Responsibilities:
//
//    1. Validation      — magic-byte sniffing, per-category size/type limits
//    2. Content address — sha256 of the bytes IS the filename, so uploading the
//                         same image twice stores it once (dedupe)
//    3. Registry        — one `files` row per stored object, with real metadata
//    4. Variants        — thumbnails / resized renditions (sharp if installed)
//    5. Reference count — files are owned by nothing; things *reference* them.
//                         ref_count hits 0 → eligible for garbage collection
//    6. Quotas          — per-user storage_used vs storage_quota
//    7. Access control  — public / authenticated / private with signed URLs
//    8. Lifecycle       — soft delete, expiry, GC sweep, integrity check
//
//  The backend is pluggable: `local` writes to disk under STORAGE_ROOT. The
//  storage_key column is backend-agnostic, so swapping in S3/R2 later means
//  writing one adapter, not touching callers.
// ============================================================================

import multer from 'multer';
import path from 'path';
import fs from 'fs';
import fsp from 'fs/promises';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

import { runQuery, getQuery, allQuery, transaction } from './db.js';
import { generateId } from './lib/snowflake.js';
import { sniffMime, probeImage, getFileType } from './lib/mediaProbe.js';
import { probeDuration, extractPoster } from './lib/mediaDuration.js';
import { s3 } from './lib/s3Client.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// --- configuration -----------------------------------------------------------

/** Root of all stored objects. Override with STORAGE_ROOT to move off-repo. */
export const STORAGE_ROOT =
  process.env.STORAGE_ROOT || path.join(__dirname, 'public', 'uploads');

/** Public base path that maps to STORAGE_ROOT (see the static mount in server.js). */
export const PUBLIC_BASE = process.env.STORAGE_PUBLIC_BASE || '/uploads';

/** Secret for signed private-file URLs. */
const URL_SECRET = process.env.STORAGE_URL_SECRET || 'dev-insecure-storage-secret';

const MB = 1024 * 1024;

const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/svg+xml', 'image/bmp'];
const AUDIO_MIMES = ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/mp4', 'audio/flac', 'audio/webm'];
const VIDEO_MIMES = ['video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'video/x-matroska'];
const DOC_MIMES   = ['application/pdf', 'application/json', 'application/zip', 'text/plain'];

/**
 * Per-category policy. `variants` lists the renditions derived on upload; they
 * are only produced when `sharp` is installed (see ensureSharp).
 */
export const CATEGORY_RULES = {
  avatars:     { maxSize: 10 * MB,     mimes: IMAGE_MIMES, square: true, variants: [{ kind: 'thumb', size: 64 }, { kind: 'small', size: 128 }, { kind: 'medium', size: 256 }] },
  banners:     { maxSize: 15 * MB,     mimes: IMAGE_MIMES, variants: [{ kind: 'small', size: 480 }, { kind: 'large', size: 1200 }] },
  icons:       { maxSize: 10 * MB,     mimes: IMAGE_MIMES, square: true, variants: [{ kind: 'thumb', size: 64 }, { kind: 'small', size: 128 }] },
  splashes:    { maxSize: 15 * MB,     mimes: IMAGE_MIMES, variants: [{ kind: 'large', size: 1600 }] },
  emojis:      { maxSize: 512 * 1024,  mimes: IMAGE_MIMES, square: true, variants: [{ kind: 'thumb', size: 64 }] },
  stickers:    { maxSize: 1 * MB,      mimes: [...IMAGE_MIMES, 'application/json'], variants: [{ kind: 'thumb', size: 160 }] },
  audio:       { maxSize: 25 * MB,     mimes: AUDIO_MIMES, variants: [] },
  video:       { maxSize: 100 * MB,    mimes: VIDEO_MIMES, variants: [] },
  attachments: { maxSize: 50 * MB,     mimes: [...IMAGE_MIMES, ...AUDIO_MIMES, ...VIDEO_MIMES, ...DOC_MIMES], variants: [{ kind: 'thumb', size: 200 }, { kind: 'medium', size: 800 }] },
  misc:        { maxSize: 25 * MB,     mimes: [...IMAGE_MIMES, ...DOC_MIMES], variants: [] }
};

export const STORAGE_CATEGORIES = Object.keys(CATEGORY_RULES).reduce((acc, key) => {
  acc[key.toUpperCase()] = path.join(STORAGE_ROOT, key);
  return acc;
}, {});

/** @deprecated use STORAGE_ROOT — kept so older imports keep resolving. */
export const UPLOADS_BASE_DIR = STORAGE_ROOT;

// --- errors ------------------------------------------------------------------

export class StorageError extends Error {
  constructor(message, { status = 400, code = 'STORAGE_ERROR' } = {}) {
    super(message);
    this.name = 'StorageError';
    this.status = status;
    this.code = code;
  }
}

// --- optional sharp ----------------------------------------------------------

let sharpModule = null;
let sharpChecked = false;

/**
 * sharp is a native dependency and deliberately optional: without it uploads
 * still work, they just skip resized variants. Install it to enable them:
 *   npm install sharp
 */
async function ensureSharp() {
  if (sharpChecked) return sharpModule;
  sharpChecked = true;
  try {
    sharpModule = (await import('sharp')).default;
    console.log('🖼️  sharp detected — image variants enabled.');
  } catch {
    console.log('ℹ️  sharp not installed — storing originals only (no thumbnails).');
  }
  return sharpModule;
}

// --- initialisation ----------------------------------------------------------

export async function initStorage() {
  for (const category of Object.keys(CATEGORY_RULES)) {
    await fsp.mkdir(path.join(STORAGE_ROOT, category), { recursive: true });
  }
  await fsp.mkdir(path.join(STORAGE_ROOT, '.tmp'), { recursive: true });
  await ensureSharp();
  console.log(`📁 Storage ready at ${STORAGE_ROOT}`);
}

/** @deprecated synchronous alias retained for older call sites. */
export function initStorageDirectories() {
  for (const category of Object.keys(CATEGORY_RULES)) {
    fs.mkdirSync(path.join(STORAGE_ROOT, category), { recursive: true });
  }
  fs.mkdirSync(path.join(STORAGE_ROOT, '.tmp'), { recursive: true });
}

// --- local backend -----------------------------------------------------------

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

/**
 * Objects are sharded two levels deep by hash prefix. Flat directories with
 * 100k+ entries are slow to stat on every filesystem that matters.
 *   attachments/a1/b2/a1b2c3...ef.png
 */
function buildStorageKey(category, hash, ext, suffix = '') {
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
 * Which backend stores the bytes. Local disk unless S3 is fully configured,
 * so a development machine needs no credentials and production needs no code
 * change — only environment variables.
 */
export function activeBackend() {
  return s3.configured ? 's3' : 'local';
}

async function writeObject(storageKey, buffer, contentType) {
  if (activeBackend() === 's3') {
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

async function objectExists(storageKey) {
  if (activeBackend() === 's3') {
    try { return Boolean(await s3.headObject(storageKey)); }
    catch { return false; }
  }
  try { await fsp.access(absolutePath(storageKey)); return true; }
  catch { return false; }
}

async function removeObject(storageKey) {
  if (activeBackend() === 's3') {
    try { await s3.deleteObject(storageKey); return true; }
    catch { return false; }
  }
  try { await fsp.unlink(absolutePath(storageKey)); return true; }
  catch (err) { if (err.code !== 'ENOENT') throw err; return false; }
}

export function readObjectStream(storageKey) {
  return fs.createReadStream(absolutePath(storageKey));
}

export { absolutePath as resolveStoragePath };

// --- URLs --------------------------------------------------------------------

export function publicUrl(storageKey) {
  return `${PUBLIC_BASE}/${String(storageKey).split(path.sep).join('/')}`;
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

export async function getStorageUsage(userId) {
  const user = await getQuery(
    `SELECT storage_used, storage_quota FROM users WHERE id = ?`, [userId]
  );
  if (!user) return null;
  const used = user.storage_used ?? 0;
  const quota = user.storage_quota ?? 0;
  return {
    used,
    quota,
    used_human: formatBytes(used),
    quota_human: formatBytes(quota),
    remaining: Math.max(0, quota - used),
    percent: quota > 0 ? Math.round((used / quota) * 1000) / 10 : 0
  };
}

async function assertQuota(userId, incomingBytes) {
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

// --- the main entry point ----------------------------------------------------

/**
 * Validate, store and register one upload.
 *
 * @param {object}  opts
 * @param {Buffer}  opts.buffer
 * @param {string}  opts.originalName
 * @param {string}  opts.declaredMime  client-provided Content-Type (untrusted)
 * @param {string}  opts.category      key of CATEGORY_RULES
 * @param {string} [opts.uploaderId]
 * @param {string} [opts.visibility]   public | authenticated | private
 * @param {number} [opts.expiresInSeconds]
 * @param {boolean}[opts.skipVariants]
 * @returns {Promise<object>} the files row plus `url`, `file_type` and `variants`
 */
export async function storeFile({
  buffer,
  originalName = 'file',
  declaredMime = 'application/octet-stream',
  category = 'attachments',
  uploaderId = null,
  visibility = 'public',
  expiresInSeconds = null,
  skipVariants = false
}) {
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

  await assertQuota(uploaderId, buffer.length);

  const hash = sha256(buffer);
  const safeName = sanitizeFilename(originalName);

  // Dedupe: identical bytes in the same category reuse the existing object.
  const existing = await getQuery(
    `SELECT * FROM files WHERE hash = ? AND category = ? AND deleted_at IS NULL`,
    [hash, category]
  );
  if (existing) {
    if (!(await objectExists(existing.storage_key))) {
      // Registry says it exists but the bytes are gone (manual deletion, or a
      // restored database without its objects). Re-materialise instead of
      // handing out a URL that 404s.
      await writeObject(existing.storage_key, buffer);
    }
    await runQuery(
      `UPDATE files SET last_accessed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
      [existing.id]
    );
    return withUrls({ ...existing, deduped: true }, await loadVariants(existing.id));
  }

  const ext = sniffed.ext || path.extname(safeName).replace('.', '').toLowerCase() || null;
  const storageKey = buildStorageKey(category, hash, ext);
  const probe = probeImage(buffer, sniffed.mime) ?? {};
  // Audio and video carry their length in the container; no ffmpeg needed.
  const durationSecs = probeDuration(buffer, sniffed.mime);

  await writeObject(storageKey, buffer, sniffed.mime);

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
                            expires_at, last_accessed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?,
                 strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
        [id, hash, storageKey, activeBackend(), category, safeName, sniffed.mime, ext,
         buffer.length, probe.width ?? null, probe.height ?? null, durationSecs,
         probe.animated ? 1 : 0, uploaderId, visibility,
         sniffed.confident ? 'clean' : 'pending', expiresAt]
      );
      if (uploaderId) {
        await runQuery(
          `UPDATE users SET storage_used = storage_used + ? WHERE id = ?`,
          [buffer.length, uploaderId]
        );
      }
    });
  } catch (err) {
    await removeObject(storageKey); // never leave an unreferenced object behind
    throw err;
  }

  const variants = skipVariants
    ? []
    : await buildVariants({ id, hash, category, mime: sniffed.mime, buffer, rules, uploaderId });

  await storePlaceholder(id, buffer, sniffed.mime);
  // Video posters need a real decoder, so they are best-effort via ffmpeg.
  if (sniffed.mime.startsWith('video/')) {
    await storeVideoPoster({ id, hash, category, storageKey, uploaderId });
  }

  const record = await getQuery(`SELECT * FROM files WHERE id = ?`, [id]);
  return withUrls(record, variants);
}

function sanitizeFilename(name) {
  const base = path.basename(String(name)).normalize('NFC');
  // Keep unicode (Thai filenames matter here) but strip path and control chars.
  const cleaned = base.replace(/[\x00-\x1f\x7f<>:"/\\|?*]/g, '_').trim();
  return (cleaned || 'file').slice(0, 200);
}

// --- variants ----------------------------------------------------------------

async function buildVariants({ id, hash, category, mime, buffer, rules, uploaderId }) {
  if (!rules.variants?.length) return [];
  // SVG is served as-is; rasterising it is a separate decision with its own risks.
  if (!mime.startsWith('image/') || mime === 'image/svg+xml') return [];

  const sharp = await ensureSharp();
  if (!sharp) return [];

  const created = [];
  for (const spec of rules.variants) {
    try {
      const pipeline = sharp(buffer, { animated: false }).rotate();
      const resized = rules.square
        ? pipeline.resize(spec.size, spec.size, { fit: 'cover', position: 'centre' })
        : pipeline.resize(spec.size, null, { fit: 'inside', withoutEnlargement: true });

      const out = await resized.webp({ quality: 82 }).toBuffer({ resolveWithObject: true });
      const key = buildStorageKey(category, hash, 'webp', spec.kind);
      await writeObject(key, out.data);

      await runQuery(
        `INSERT OR REPLACE INTO file_variants (id, file_id, kind, storage_key, mime_type, width, height, size)
         VALUES (?, ?, ?, ?, 'image/webp', ?, ?, ?)`,
        [generateId(), id, spec.kind, key, out.info.width, out.info.height, out.data.length]
      );
      if (uploaderId) {
        await runQuery(
          `UPDATE users SET storage_used = storage_used + ? WHERE id = ?`,
          [out.data.length, uploaderId]
        );
      }
      created.push({
        kind: spec.kind, storage_key: key, mime_type: 'image/webp',
        width: out.info.width, height: out.info.height, size: out.data.length
      });
    } catch (err) {
      // A failed thumbnail must never fail the upload.
      console.warn(`⚠️  variant '${spec.kind}' failed for file ${id}: ${err.message}`);
    }
  }
  return created;
}

/**
 * Store a tiny inline preview so the client can paint something in the image's
 * exact footprint while the full file downloads — no layout jump, no grey box.
 *
 * A 20px WebP data URI rather than a real BlurHash: it needs no client library,
 * decodes natively, and costs ~300 bytes. Stored in files.blurhash.
 */
async function storePlaceholder(fileId, buffer, mime) {
  if (!mime.startsWith('image/') || mime === 'image/svg+xml') return;
  const sharp = await ensureSharp();
  if (!sharp) return;

  try {
    const tiny = await sharp(buffer, { animated: false })
      .rotate()
      .resize(20, 20, { fit: 'inside' })
      .webp({ quality: 40 })
      .toBuffer();
    // Guard against a pathological case where the preview is not actually small.
    if (tiny.length > 2048) return;
    await runQuery(
      `UPDATE files SET blurhash = ? WHERE id = ?`,
      [`data:image/webp;base64,${tiny.toString('base64')}`, fileId]
    );
  } catch (err) {
    console.warn(`⚠️  placeholder failed for file ${fileId}: ${err.message}`);
  }
}

/**
 * Grab a frame from an uploaded video to use as its poster. Requires ffmpeg on
 * PATH; without it the video simply has no poster, which the player handles.
 */
async function storeVideoPoster({ id, hash, category, storageKey, uploaderId }) {
  if (activeBackend() !== 'local') return;   // ffmpeg needs a file on disk
  try {
    const png = await extractPoster(absolutePath(storageKey));
    if (!png) return;

    const sharp = await ensureSharp();
    const output = sharp
      ? await sharp(png).resize(640, null, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 80 }).toBuffer()
      : png;

    const key = buildStorageKey(category, hash, sharp ? 'webp' : 'png', 'poster');
    await writeObject(key, output, sharp ? 'image/webp' : 'image/png');
    await runQuery(
      `INSERT OR REPLACE INTO file_variants (id, file_id, kind, storage_key, mime_type, size)
       VALUES (?, ?, 'poster', ?, ?, ?)`,
      [generateId(), id, key, sharp ? 'image/webp' : 'image/png', output.length]
    );
    if (uploaderId) {
      await runQuery(
        `UPDATE users SET storage_used = storage_used + ? WHERE id = ?`,
        [output.length, uploaderId]
      );
    }
  } catch (err) {
    console.warn(`⚠️  poster failed for file ${id}: ${err.message}`);
  }
}

async function loadVariants(fileId) {
  return allQuery(
    `SELECT kind, storage_key, mime_type, width, height, size FROM file_variants WHERE file_id = ?`,
    [fileId]
  );
}

/** Attach `url`, `file_type` and a `variants` map keyed by kind. */
function withUrls(file, variants = []) {
  if (!file) return null;
  const isPublic = file.visibility === 'public';
  const variantMap = {};
  for (const v of variants) {
    variantMap[v.kind] = {
      ...v,
      url: isPublic ? publicUrl(v.storage_key) : `/api/files/${file.id}?variant=${v.kind}`
    };
  }
  return {
    ...file,
    file_type: getFileType(file.mime_type),
    url: isPublic ? publicUrl(file.storage_key) : `/api/files/${file.id}`,
    variants: variantMap
  };
}

export async function getFile(fileId, { includeDeleted = false } = {}) {
  const file = await getQuery(
    `SELECT * FROM files WHERE id = ?${includeDeleted ? '' : ' AND deleted_at IS NULL'}`,
    [fileId]
  );
  if (!file) return null;
  return withUrls(file, await loadVariants(fileId));
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
  const prefix = `${PUBLIC_BASE}/`;
  const idx = url.indexOf(prefix);
  if (idx === -1) return null; // an external URL (Unsplash, dicebear…) — not ours
  const storageKey = url.slice(idx + prefix.length).split('?')[0];
  return getQuery(
    `SELECT * FROM files WHERE storage_key = ? AND deleted_at IS NULL`, [storageKey]
  );
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
            last_accessed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?`,
    [count, fileId]
  );
}

/** Release a reference. Hitting zero makes the file GC-eligible, not deleted. */
export async function releaseReference(fileId, count = 1) {
  if (!fileId) return;
  await runQuery(
    `UPDATE files SET ref_count = MAX(0, ref_count - ?) WHERE id = ?`, [count, fileId]
  );
}

export async function recordAccess(fileId, { userId = null, ip = null, variant = null, bytes = null } = {}) {
  await runQuery(
    `UPDATE files SET last_accessed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`,
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
    `UPDATE files SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`, [fileId]
  );
  return true;
}

/**
 * Reclaim disk. Removes bytes for files that are
 *   (a) soft-deleted, or
 *   (b) past expires_at, or
 *   (c) unreferenced and older than `orphanGraceMs` — an upload that was never
 *       attached to anything, e.g. the user abandoned the compose box.
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
         OR (expires_at IS NOT NULL AND expires_at < ?)
         OR (ref_count = 0 AND created_at < ?)
      ORDER BY created_at ASC
      LIMIT ?`,
    [nowIso, graceCutoff, limit]
  );

  const result = {
    scanned: candidates.length,
    removed: 0, bytesFreed: 0,          // what actually happened
    wouldRemove: 0, wouldFreeBytes: 0,  // what a real run would do
    errors: [], dryRun
  };

  for (const file of candidates) {
    try {
      const variants = await allQuery(
        `SELECT storage_key, size FROM file_variants WHERE file_id = ?`, [file.id]
      );
      const bytes = file.size + variants.reduce((sum, v) => sum + (v.size ?? 0), 0);

      if (!dryRun) {
        // Another live row may point at the same object; check before unlinking
        // so dedupe survives GC.
        const shared = await getQuery(
          `SELECT count(*) AS c FROM files
            WHERE storage_key = ? AND id != ? AND deleted_at IS NULL`,
          [file.storage_key, file.id]
        );
        if (!shared || shared.c === 0) {
          await removeObject(file.storage_key);
          for (const v of variants) await removeObject(v.storage_key);
        }
        await transaction(async () => {
          await runQuery(`DELETE FROM file_variants WHERE file_id = ?`, [file.id]);
          await runQuery(`DELETE FROM files WHERE id = ?`, [file.id]);
          if (file.uploader_id) {
            await runQuery(
              `UPDATE users SET storage_used = MAX(0, storage_used - ?) WHERE id = ?`,
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

  if (result.wouldRemove) {
    console.log(
      `🧹 GC ${dryRun ? '(dry run) would free' : 'freed'} ${formatBytes(result.wouldFreeBytes)} ` +
      `across ${result.wouldRemove} file(s)`
    );
  }
  return result;
}

/** Find registry rows whose bytes are missing, and objects with no registry row. */
export async function verifyIntegrity() {
  const files = await allQuery(`SELECT id, storage_key, size FROM files WHERE deleted_at IS NULL`);
  const missingBytes = [];
  const known = new Set();

  for (const f of files) {
    known.add(f.storage_key);
    if (!(await objectExists(f.storage_key))) missingBytes.push(f);
  }

  const orphanObjects = [];
  for (const category of Object.keys(CATEGORY_RULES)) {
    for await (const abs of walk(path.join(STORAGE_ROOT, category))) {
      const key = path.relative(STORAGE_ROOT, abs).split(path.sep).join('/');
      if (known.has(key)) continue;
      const variant = await getQuery(
        `SELECT id FROM file_variants WHERE storage_key = ?`, [key]
      );
      if (!variant) orphanObjects.push(key);
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

export { getFileType };
