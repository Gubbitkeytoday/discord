// ============================================================================
//  Media pipeline: what happens to an upload after its bytes are accepted.
//
//    image   → responsive WebP renditions (+ a still for animated images),
//              then an `avif` job for the same widths (static images only)
//    avif    → AVIF renditions, in the background; never delays an upload
//    video   → ffprobe dimensions/duration + a poster frame (ffmpeg optional)
//    ingest  → a presigned direct upload: fetch it from the bucket, run the
//              same validation/sanitising as a multipart upload, move it to its
//              content-addressed key, then the image/video steps inline
//
//  Jobs run on the persisted queue in services/mediaJobs.js, so a restart in
//  the middle of processing resumes where it left off.
//
//  Direct uploads (S3/R2 only):
//    1. POST /api/media/uploads            → a presigned POST policy (or PUT
//                                            URL for R2) for incoming/<user>/<id>
//    2. browser → bucket                    (bytes never touch this server)
//    3. POST /api/media/uploads/:id/complete → HEAD + ranged GET sniff, a
//                                            files row, and an `ingest` job
// ============================================================================

import path from 'path';
import fsp from 'fs/promises';
import crypto from 'crypto';

import { runQuery, getQuery, allQuery } from '../db.js';
import { generateId } from '../lib/snowflake.js';
import { ApiError } from '../lib/httpUtils.js';
import { s3 } from '../lib/s3Client.js';
import { sniffMime, probeImage } from '../lib/mediaProbe.js';
import { probeVideo, extractPoster } from '../lib/mediaDuration.js';
import {
  loadSharp, inspectImage, planRenditions, renderRendition, renderStill,
  animationWithinBudget, computePlaceholders, mediaConfig, MediaError
} from '../lib/imageVariants.js';
import {
  CATEGORY_RULES, STORAGE_ROOT, StorageError, activeBackend, buildStorageKey, readObject,
  writeObject, removeObject, resolveStoragePath, prepareUpload, processingJobFor, sha256,
  sanitizeFilename, assertQuota, getFile, formatBytes, syncBudgetMs
} from '../storageService.js';
import {
  registerJobHandler, enqueueJob, waitForJob, onWorkersStart
} from './mediaJobs.js';

const permanent = (message) => Object.assign(new Error(message), { permanent: true });

/** Storage-key stem for derived objects: the content hash (plus the id for undeduplicated direct uploads). */
function derivedKey(file, ext, suffix) {
  const sha = String(file.hash).slice(0, 64);
  const unique = String(file.hash).includes('~') ? `-${file.id}` : '';
  return buildStorageKey(file.category, sha, ext, `${suffix}${unique}`);
}

async function loadFileRow(fileId) {
  const file = await getQuery(`SELECT * FROM files WHERE id = ? AND deleted_at IS NULL`, [fileId]);
  return file ?? null;
}

// --- images ----------------------------------------------------------------------

async function upsertRendition(file, plan, format, out) {
  const key = derivedKey(file, format, `w${plan.bucket}`);
  await writeObject(key, out.data, out.mime, file.backend);
  await runQuery(
    `INSERT INTO file_renditions (id, file_id, bucket, format, storage_key, mime_type, width, height, size, animated)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (file_id, bucket, format) DO UPDATE SET
       storage_key = excluded.storage_key, mime_type = excluded.mime_type,
       width = excluded.width, height = excluded.height, size = excluded.size,
       animated = excluded.animated`,
    [generateId(), file.id, plan.bucket, format, key, out.mime, out.width, out.height,
     out.data.length, out.animated ? 1 : 0]
  );
  return key;
}

/** Drop renditions of `format` that the current plan no longer makes. */
async function pruneRenditions(file, format, keepBuckets) {
  const rows = await allQuery(
    `SELECT bucket, storage_key FROM file_renditions WHERE file_id = ? AND format = ?`, [file.id, format]
  );
  for (const row of rows) {
    if (keepBuckets.has(row.bucket)) continue;
    await removeObject(row.storage_key, file.backend);
    await runQuery(`DELETE FROM file_renditions WHERE file_id = ? AND bucket = ? AND format = ?`,
      [file.id, row.bucket, format]);
  }
}

/** Upsert a legacy file_variants row (poster / preview) and charge its bytes. */
async function upsertVariant(file, kind, out) {
  const key = derivedKey(file, out.mime === 'image/png' ? 'png' : 'webp', kind);
  await writeObject(key, out.data, out.mime, file.backend);
  const previous = await getQuery(`SELECT size FROM file_variants WHERE file_id = ? AND kind = ?`, [file.id, kind]);
  await runQuery(
    `INSERT INTO file_variants (id, file_id, kind, storage_key, mime_type, width, height, size)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (file_id, kind) DO UPDATE SET
       storage_key = excluded.storage_key, mime_type = excluded.mime_type,
       width = excluded.width, height = excluded.height, size = excluded.size`,
    [generateId(), file.id, kind, key, out.mime, out.width ?? null, out.height ?? null, out.data.length]
  );
  // collectGarbage refunds variant sizes, so they are charged here to match.
  if (file.uploader_id) {
    await runQuery(`UPDATE users SET storage_used = storage_used + ? WHERE id = ?`,
      [out.data.length - (previous?.size ?? 0), file.uploader_id]);
  }
}

async function processImage(file, buffer = null) {
  const sharp = await loadSharp();
  if (!sharp) {
    await runQuery(`UPDATE files SET media_status = 'ready' WHERE id = ?`, [file.id]);
    return;
  }
  buffer ??= await readObject(file.storage_key, file.backend);
  if (!buffer) throw permanent('stored bytes are missing');

  let info;
  try { info = await inspectImage(buffer, file.mime_type); }
  catch (err) {
    if (err instanceof MediaError) throw permanent(err.message);
    throw err;
  }
  if (!info.decodable) {
    await runQuery(`UPDATE files SET media_status = 'unsupported' WHERE id = ?`, [file.id]);
    return;
  }

  const animated = info.animated && animationWithinBudget(info);
  const plan = planRenditions(file.category, info.width, info.height, { animated });
  for (const step of plan) {
    const out = await renderRendition(buffer, step, 'webp', { animated });
    await upsertRendition(file, step, 'webp', out);
  }
  await pruneRenditions(file, 'webp', new Set(plan.map((p) => p.bucket)));

  // Animated images get a still, for "play GIFs on hover" and reduced motion.
  if (info.animated) {
    await upsertVariant(file, 'preview', await renderStill(buffer));
  }

  await runQuery(
    `UPDATE files SET media_status = 'ready', width = ?, height = ?, is_animated = ? WHERE id = ?`,
    [info.width, info.height, info.animated ? 1 : 0, file.id]
  );

  if (mediaConfig().avif && !info.animated && plan.length) {
    await enqueueJob(file.id, 'avif');
  }
}

async function processAvif(file) {
  if (!mediaConfig().avif || !(await loadSharp())) return;
  const buffer = await readObject(file.storage_key, file.backend);
  if (!buffer) throw permanent('stored bytes are missing');
  const info = await inspectImage(buffer, file.mime_type);
  if (!info.decodable || info.animated) return;
  const plan = planRenditions(file.category, info.width, info.height);
  for (const step of plan) {
    const out = await renderRendition(buffer, step, 'avif');
    await upsertRendition(file, step, 'avif', out);
  }
  await pruneRenditions(file, 'avif', new Set(plan.map((p) => p.bucket)));
}

// --- video ------------------------------------------------------------------------

async function processVideo(file, buffer = null) {
  // ffmpeg reads from a path. Local files already have one; bucket objects
  // are spooled to the storage temp directory for the duration of the job.
  let filePath;
  let temp = null;
  if (file.backend === 'local') {
    filePath = resolveStoragePath(file.storage_key);
  } else {
    buffer ??= await readObject(file.storage_key, file.backend);
    if (!buffer) throw permanent('stored bytes are missing');
    temp = path.join(STORAGE_ROOT, '.tmp', `${crypto.randomUUID()}.${file.extension || 'bin'}`);
    await fsp.mkdir(path.dirname(temp), { recursive: true });
    await fsp.writeFile(temp, buffer);
    filePath = temp;
  }

  try {
    const meta = await probeVideo(filePath, file.mime_type);
    let width = meta?.width ?? file.width ?? null;
    let height = meta?.height ?? file.height ?? null;
    const duration = meta?.duration ?? file.duration_secs ?? null;

    const png = await extractPoster(filePath, { mime: file.mime_type, duration });
    let thumbhash = file.thumbhash;
    let preview = file.blurhash;
    if (png) {
      const sharp = await loadSharp();
      if (sharp) {
        const { data, info } = await sharp(png)
          .resize(1280, 1280, { fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 80 })
          .toBuffer({ resolveWithObject: true });
        await upsertVariant(file, 'poster', { data, mime: 'image/webp', width: info.width, height: info.height });
        const placeholders = await computePlaceholders(png).catch(() => null);
        thumbhash = placeholders?.thumbhash ?? thumbhash;
        preview = placeholders?.preview ?? preview;
        if (!width || !height) {
          const m = await sharp(png).metadata();
          width = m.width; height = m.height;
        }
      } else {
        await upsertVariant(file, 'poster', { data: png, mime: 'image/png' });
      }
    }

    await runQuery(
      `UPDATE files SET media_status = 'ready', width = ?, height = ?, duration_secs = ?,
              thumbhash = ?, blurhash = ? WHERE id = ?`,
      [width, height, duration, thumbhash ?? null, preview ?? null, file.id]
    );
  } finally {
    if (temp) await fsp.unlink(temp).catch(() => {});
  }
}

// --- direct-upload ingest ----------------------------------------------------------

async function rejectIngest(file, reason) {
  await removeObject(file.storage_key, file.backend);
  await runQuery(`UPDATE files SET media_status = 'failed', deleted_at = ? WHERE id = ?`,
    [new Date().toISOString(), file.id]);
  if (file.uploader_id) {
    await runQuery(`UPDATE users SET storage_used = CASE WHEN storage_used > ? THEN storage_used - ? ELSE 0 END WHERE id = ?`,
      [file.size, file.size, file.uploader_id]);
  }
  await runQuery(`UPDATE direct_uploads SET status = 'rejected' WHERE file_id = ?`, [file.id]);
  throw permanent(reason);
}

async function ingestDirectUpload(file) {
  if (!String(file.storage_key).startsWith('incoming/')) {
    // Already moved (the job is being retried after a crash) — just finish.
    const job = processingJobFor(file.mime_type, file.media_status);
    if (job) await HANDLERS[job](file);
    return;
  }
  // A direct upload only ever lives in the bucket (createDirectUpload needs
  // S3), so it is read from and written back to the bucket, never local disk.
  if (file.backend !== 's3' && file.backend !== 'r2') throw permanent('direct upload is not in a bucket');
  const raw = await s3.getObject(file.storage_key);
  if (!raw) throw permanent('uploaded object is missing from the bucket');

  let prepared;
  try {
    prepared = await prepareUpload({
      buffer: raw, category: file.category, declaredMime: file.mime_type, originalName: file.original_name
    });
  } catch (err) {
    if (err instanceof StorageError) await rejectIngest(file, err.message);
    throw err;
  }
  const { sniffed, info, durationSecs, thumbhash, preview, mediaStatus } = prepared;
  const buffer = prepared.buffer;
  const sha = sha256(buffer);

  // Direct uploads are not deduplicated: the client already holds this row's
  // id. A duplicate keeps its own object under a suffixed key instead.
  const duplicate = await getQuery(
    `SELECT id FROM files WHERE hash = ? AND category = ? AND deleted_at IS NULL AND id != ?`,
    [sha, file.category, file.id]
  );
  const hash = duplicate ? `${sha}~${file.id}` : sha;
  const ext = sniffed.ext || null;
  const key = buildStorageKey(file.category, sha, ext, duplicate ? `u${file.id}` : '');
  const incoming = file.storage_key;

  await s3.putObject(key, buffer, sniffed.mime);
  await runQuery(
    `UPDATE files SET hash = ?, storage_key = ?, mime_type = ?, extension = ?, size = ?,
            width = ?, height = ?, duration_secs = ?, is_animated = ?, blurhash = ?,
            thumbhash = ?, media_status = ?, scan_status = ? WHERE id = ?`,
    [hash, key, sniffed.mime, ext, buffer.length, info?.width ?? null, info?.height ?? null,
     durationSecs, info?.animated ? 1 : 0, preview, thumbhash, mediaStatus,
     sniffed.confident ? 'clean' : 'pending', file.id]
  );
  if (file.uploader_id && buffer.length !== file.size) {
    await runQuery(
      `UPDATE users SET storage_used = CASE WHEN storage_used + ? > 0 THEN storage_used + ? ELSE 0 END WHERE id = ?`,
      [buffer.length - file.size, buffer.length - file.size, file.uploader_id]
    );
  }
  await removeObject(incoming, file.backend);

  const job = processingJobFor(sniffed.mime, mediaStatus);
  if (job) {
    const moved = await loadFileRow(file.id);
    await HANDLERS[job](moved, buffer);
  }
}

// --- registration ----------------------------------------------------------------

const HANDLERS = {
  image: processImage,
  avif: processAvif,
  video: processVideo,
  ingest: ingestDirectUpload
};

for (const [kind, handler] of Object.entries(HANDLERS)) {
  registerJobHandler(kind, async (job) => {
    const file = await loadFileRow(job.file_id);
    if (!file) return;               // deleted meanwhile — nothing to do
    try {
      await handler(file);
    } catch (err) {
      if (err.permanent || job.attempts >= 3) {
        await runQuery(
          `UPDATE files SET media_status = 'failed' WHERE id = ? AND media_status = 'processing'`, [file.id]
        ).catch(() => {});
      }
      throw err;
    }
  });
}

/**
 * Boot repair: a crash between committing a files row and enqueueing its job
 * leaves it 'processing' with no job; give it one. Also start the sweep that
 * expires abandoned direct uploads.
 */
onWorkersStart(async () => {
  const stuck = await allQuery(
    `SELECT f.id, f.mime_type, f.storage_key FROM files f
      WHERE f.media_status = 'processing' AND f.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM media_jobs j WHERE j.file_id = f.id)
      LIMIT 500`
  );
  for (const f of stuck) {
    const kind = String(f.storage_key).startsWith('incoming/') ? 'ingest' : processingJobFor(f.mime_type, 'processing');
    if (kind) await enqueueJob(f.id, kind);
  }
  if (stuck.length) console.log(`🎞️  media queue: re-enqueued ${stuck.length} unfinished file(s)`);

  const timer = setInterval(() => { expireDirectUploads().catch(() => {}); }, 30 * 60 * 1000);
  timer.unref?.();
});

/**
 * Re-run processing for files made before the pipeline existed (or whose
 * processing failed). Used by `node scripts/storage.js reprocess`.
 */
export async function reprocessFiles({ includeReady = false, limit = 1000 } = {}) {
  const rows = await allQuery(
    `SELECT id, mime_type FROM files
      WHERE deleted_at IS NULL
        AND (mime_type LIKE 'image/%' OR mime_type LIKE 'video/%')
        AND mime_type != 'image/svg+xml'
        AND (media_status IS NULL OR media_status = 'failed'${includeReady ? " OR media_status = 'ready'" : ''})
      ORDER BY id ASC LIMIT ?`,
    [limit]
  );
  for (const row of rows) {
    const kind = row.mime_type.startsWith('video/') ? 'video' : 'image';
    await runQuery(`UPDATE files SET media_status = 'processing' WHERE id = ?`, [row.id]);
    await enqueueJob(row.id, kind);
  }
  return rows.length;
}

// --- direct uploads -----------------------------------------------------------------

const DIRECT_UPLOAD_TTL_S = 10 * 60;
const MAX_PENDING_PER_USER = 20;

/** 'post' | 'put' | null. R2 has no POST Object, so it gets presigned PUT. */
export function directUploadMode() {
  if (!s3.configured) return null;
  const configured = String(process.env.S3_DIRECT_UPLOAD ?? '').toLowerCase();
  if (['0', 'off', 'false', 'no'].includes(configured)) return null;
  if (configured === 'post' || configured === 'put') return configured;
  return isR2Endpoint(s3.endpoint) ? 'put' : 'post';
}

/** Cloudflare R2: the endpoint's host is r2.cloudflarestorage.com or a subdomain of it. */
export function isR2Endpoint(endpoint) {
  let host;
  try { host = new URL(String(endpoint)).hostname.toLowerCase(); } catch { return false; }
  return host === 'r2.cloudflarestorage.com' || host.endsWith('.r2.cloudflarestorage.com');
}

const DIRECT_CATEGORIES = new Set(['attachments', 'avatars', 'banners', 'icons', 'emojis', 'stickers', 'audio', 'video']);

export async function createDirectUpload({ userId, category = 'attachments', filename, contentType, size, visibility = 'public' }) {
  const mode = directUploadMode();
  if (!mode) {
    throw new ApiError('Direct uploads need the S3 backend; use multipart /api/upload/* instead',
      { status: 409, code: 'DIRECT_UPLOAD_UNAVAILABLE' });
  }
  const rules = CATEGORY_RULES[category];
  if (!rules || !DIRECT_CATEGORIES.has(category)) {
    throw new ApiError(`Unknown upload category '${category}'`, { code: 'BAD_CATEGORY' });
  }
  const mime = String(contentType ?? '').toLowerCase().trim();
  if (!rules.mimes.includes(mime)) {
    throw new ApiError(`File type ${mime || '(none)'} is not allowed in ${category}`, { status: 415, code: 'UNSUPPORTED_TYPE' });
  }
  const bytes = Number(size);
  if (!Number.isInteger(bytes) || bytes < 1) {
    throw new ApiError('size must be a positive integer (bytes)', { code: 'INVALID_SIZE' });
  }
  if (bytes > rules.maxSize) {
    throw new ApiError(`File too large for ${category}: ${formatBytes(bytes)} > ${formatBytes(rules.maxSize)}`,
      { status: 413, code: 'FILE_TOO_LARGE' });
  }
  await assertQuota(userId, bytes);

  const pending = await getQuery(
    `SELECT count(*) AS c FROM direct_uploads WHERE user_id = ? AND status = 'pending' AND expires_at > ?`,
    [userId, new Date().toISOString()]
  );
  if (Number(pending?.c ?? 0) >= MAX_PENDING_PER_USER) {
    throw new ApiError('Too many unfinished uploads', { status: 429, code: 'TOO_MANY_PENDING_UPLOADS' });
  }

  const id = generateId();
  const key = `incoming/${userId}/${id}`;
  const expiresAt = new Date(Date.now() + DIRECT_UPLOAD_TTL_S * 1000).toISOString();
  const vis = ['private', 'authenticated'].includes(visibility) ? visibility : 'public';
  await runQuery(
    `INSERT INTO direct_uploads (id, user_id, category, object_key, filename, declared_mime,
                                 declared_size, visibility, status, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [id, userId, category, key, sanitizeFilename(filename ?? 'file'), mime, bytes, vis, expiresAt]
  );

  const signed = mode === 'post'
    ? s3.presignPost(key, { contentType: mime, minBytes: bytes, maxBytes: bytes, expiresIn: DIRECT_UPLOAD_TTL_S })
    : s3.presignPut(key, { contentType: mime, contentLength: bytes, expiresIn: DIRECT_UPLOAD_TTL_S });
  return {
    upload_id: id,
    method: signed.method,
    url: signed.url,
    fields: signed.fields ?? null,
    headers: signed.headers ?? null,
    expires_at: expiresAt,
    complete_url: `/api/media/uploads/${id}/complete`
  };
}

/**
 * Verify what actually landed in the bucket and register it. Nothing about
 * the object is trusted: its size comes from HEAD, its type from the first
 * 4 KB of its own bytes.
 */
export async function completeDirectUpload({ userId, uploadId, waitMs = null }) {
  const upload = await getQuery(`SELECT * FROM direct_uploads WHERE id = ? AND user_id = ?`, [uploadId, userId]);
  if (!upload) throw ApiError.notFound('Upload');
  if (upload.status === 'completed' && upload.file_id) {
    return getFile(upload.file_id);           // idempotent retry
  }
  if (upload.status !== 'pending') {
    throw new ApiError(`Upload is ${upload.status}`, { status: 409, code: 'UPLOAD_NOT_PENDING' });
  }

  const reject = async (message, status, code) => {
    await removeObject(upload.object_key, 's3');
    await runQuery(`UPDATE direct_uploads SET status = 'rejected' WHERE id = ?`, [upload.id]);
    throw new ApiError(message, { status, code });
  };

  const head = await s3.headObject(upload.object_key);
  if (!head) {
    if (new Date(upload.expires_at).getTime() < Date.now()) {
      await runQuery(`UPDATE direct_uploads SET status = 'expired' WHERE id = ?`, [upload.id]);
      throw new ApiError('Upload expired', { status: 410, code: 'UPLOAD_EXPIRED' });
    }
    throw new ApiError('Nothing has been uploaded yet', { status: 409, code: 'UPLOAD_MISSING' });
  }
  const rules = CATEGORY_RULES[upload.category];
  if (!Number.isFinite(head.size) || head.size !== Number(upload.declared_size) || head.size > rules.maxSize) {
    await reject('Uploaded size does not match the declared size', 400, 'SIZE_MISMATCH');
  }

  const sample = await s3.getObjectRange(upload.object_key, 0, 4095);
  const sniffed = sniffMime(sample ?? Buffer.alloc(0), upload.declared_mime, upload.filename);
  // Text-ish types (JSON, plain text) cannot be confirmed from a prefix; the
  // ingest job re-checks the whole object.
  const textual = ['application/json', 'text/plain'].includes(upload.declared_mime);
  if (!textual && !rules.mimes.includes(sniffed.mime)) {
    await reject(`File type ${sniffed.mime} is not allowed in ${upload.category}`, 415, 'UNSUPPORTED_TYPE');
  }
  const mime = textual ? upload.declared_mime : sniffed.mime;
  const dims = mime.startsWith('image/') ? probeImage(sample, mime) : null;
  const cfg = mediaConfig();
  if (dims && (dims.width > cfg.maxDimension || dims.height > cfg.maxDimension || dims.width * dims.height > cfg.maxPixels)) {
    await reject('Image dimensions exceed the limit', 413, 'IMAGE_TOO_LARGE');
  }
  try {
    await assertQuota(userId, head.size);
  } catch (err) {
    await reject(err.message, 413, 'QUOTA_EXCEEDED');
  }

  const fileId = generateId();
  await runQuery(
    `INSERT INTO files (id, hash, storage_key, backend, category, original_name, mime_type, extension,
                        size, width, height, uploader_id, ref_count, visibility, scan_status, media_status,
                        last_accessed_at)
     VALUES (?, ?, ?, 's3', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'pending', 'processing', ?)`,
    [fileId, `upload:${upload.id}`, upload.object_key, upload.category, upload.filename, mime,
     sniffed.ext || null, head.size, dims?.width ?? null, dims?.height ?? null, userId,
     upload.visibility, new Date().toISOString()]
  );
  await runQuery(`UPDATE users SET storage_used = storage_used + ? WHERE id = ?`, [head.size, userId]);
  await runQuery(`UPDATE direct_uploads SET status = 'completed', file_id = ? WHERE id = ?`, [fileId, upload.id]);

  await enqueueJob(fileId, 'ingest');
  // Until ingest has moved and stripped it the file cannot be served, so
  // completion waits for that (8 s unless MEDIA_SYNC_BUDGET_MS is larger).
  const budget = waitMs ?? Math.max(syncBudgetMs(), 8000);
  if (budget > 0) await waitForJob(fileId, 'ingest', budget);
  const file = await getFile(fileId, { includeDeleted: true });
  if (file?.deleted_at) {
    throw new ApiError('The uploaded file was rejected', { status: 415, code: 'UPLOAD_REJECTED' });
  }
  return file;
}

/** Abandoned direct uploads: delete the incoming object, mark the row expired. */
export async function expireDirectUploads() {
  const rows = await allQuery(
    `SELECT id, object_key FROM direct_uploads WHERE status = 'pending' AND expires_at < ? LIMIT 500`,
    [new Date(Date.now() - 60_000).toISOString()]
  );
  for (const row of rows) {
    if (activeBackend() === 's3') await removeObject(row.object_key, 's3');
    await runQuery(`UPDATE direct_uploads SET status = 'expired' WHERE id = ?`, [row.id]);
  }
  return rows.length;
}
