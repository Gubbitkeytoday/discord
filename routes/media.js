// ============================================================================
//  Media pipeline HTTP surface.
//
//    GET  /api/media/config                    what this instance can do
//    GET  /api/media/:fileId?w=480[&f=webp]    best rendition for the viewer
//    GET  /api/media/:fileId/poster            a video's poster frame
//    POST /api/media/uploads                   presign a direct (S3/R2) upload
//    POST /api/media/uploads/:id/complete      verify + register it
//    GET  <STORAGE_PUBLIC_BASE>/*              S3 fallback for /uploads/... URLs
//
//  Mounted at the root (server.js) because of the last one.
// ============================================================================

import express from 'express';

import { ApiError, asyncRoute, requireUser } from '../lib/httpUtils.js';
import { rateLimit } from '../lib/rateLimit.js';
import { getQuery, allQuery } from '../db.js';
import { negotiateFormat, pickRendition } from '../lib/imageVariants.js';
import {
  getFile, sendStoredObject, mediaCapabilities, PUBLIC_BASE, StorageError, verifyFileSignature
} from '../storageService.js';
import {
  createDirectUpload, completeDirectUpload, directUploadMode
} from '../services/mediaPipeline.js';
import { queueStats } from '../services/mediaJobs.js';
import { fileDescriptor } from './files.js';

const router = express.Router();

// The static /uploads mount (express.static → send → mime v1) predates AVIF
// and HEIF and would serve them as application/octet-stream, which browsers
// refuse to render in <img>/<picture>. Register them once, process-wide.
express.static.mime.define({
  'image/avif': ['avif'],
  'image/heic': ['heic'],
  'image/heif': ['heif']
}, true);

const presignLimit = rateLimit({ name: 'media-presign', limit: 60, windowMs: 60_000 });

router.get('/api/media/config', asyncRoute(async (_req, res) => {
  const caps = await mediaCapabilities();
  res.json({
    ...caps,
    direct_upload: directUploadMode(),
    queue: await queueStats().catch(() => null)
  });
}));

router.post('/api/media/uploads', requireUser, presignLimit, asyncRoute(async (req, res) => {
  const body = req.body ?? {};
  res.status(201).json(await createDirectUpload({
    userId: req.userId,
    category: body.category ?? 'attachments',
    filename: typeof body.filename === 'string' ? body.filename : 'file',
    contentType: body.contentType ?? body.content_type,
    size: body.size,
    visibility: body.visibility
  }));
}));

router.post('/api/media/uploads/:uploadId/complete', requireUser, presignLimit, asyncRoute(async (req, res) => {
  const file = await completeDirectUpload({ userId: req.userId, uploadId: String(req.params.uploadId) });
  res.json(fileDescriptor(file));
}));

/** Same rules as /api/files/:id: private → uploader (or signed), authenticated → any user. */
function assertCanRead(req, file) {
  const signed = verifyFileSignature(file.id, {
    expires: req.query.expires, sig: req.query.sig, variant: req.query.variant ?? null
  });
  if (file.visibility === 'private' && !signed && file.uploader_id !== req.userId) {
    throw ApiError.forbidden('This file is private');
  }
  if (file.visibility === 'authenticated' && !signed && !req.userId) {
    throw ApiError.unauthorized();
  }
}

function parseWidth(value) {
  if (value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 8192) {
    throw new ApiError('w must be an integer between 1 and 8192', { code: 'INVALID_PARAMETER' });
  }
  return n;
}

/**
 * The display endpoint. `?w=` is the slot width in CSS px × devicePixelRatio;
 * the format follows the Accept header (AVIF, then WebP, then the original)
 * unless `f=` pins one — which is what the explicit srcset URLs do, so those
 * responses need no Vary.
 */
router.get('/api/media/:fileId(\\d+)', asyncRoute(async (req, res) => {
  const file = await getFile(req.params.fileId);
  if (!file) throw ApiError.notFound('File');
  assertCanRead(req, file);
  if (file.file_type !== 'image') {
    throw new ApiError('Not an image', { status: 415, code: 'NOT_AN_IMAGE' });
  }
  const width = parseWidth(req.query.w);
  const pinned = ['webp', 'avif', 'original'].includes(req.query.f) ? req.query.f : null;

  const available = new Set(file.renditions.map((r) => r.format));
  const format = pinned === 'original' ? null
    : pinned ? (available.has(pinned) ? pinned : null)
      : negotiateFormat(req.headers.accept, available);
  if (pinned && pinned !== 'original' && !format) throw ApiError.notFound(`Rendition '${pinned}'`);

  const isPublic = file.visibility === 'public';
  const ready = file.media_status === 'ready' || file.media_status === null;
  // Until AVIF exists a negotiated answer can still change, so it is only
  // cached briefly; a pinned or final answer is immutable.
  const settled = ready && (pinned || !available.size || available.has('avif') || !file.renditions.length);
  const cacheControl = isPublic
    ? (settled ? 'public, max-age=31536000, immutable' : 'public, max-age=60')
    : 'private, max-age=3600';
  const vary = pinned ? null : 'Accept';

  if (format) {
    const rows = await allRenditionRows(file.id, format);
    const pick = pickRendition(rows, width);
    await sendStoredObject(req, res, {
      storageKey: pick.storage_key, backend: file.backend, mime: pick.mime_type,
      etag: `"${file.hash}-${pick.bucket}.${format}"`, cacheControl, vary
    });
    return;
  }
  if (String(file.storage_key).startsWith('incoming/')) {
    res.setHeader('Retry-After', '2');
    throw new ApiError('This upload is still being processed', { status: 409, code: 'MEDIA_PROCESSING' });
  }
  await sendStoredObject(req, res, {
    storageKey: file.storage_key, backend: file.backend, mime: file.mime_type,
    etag: `"${file.hash}"`, cacheControl, vary, filename: file.original_name
  });
}));

function allRenditionRows(fileId, format) {
  return allQuery(
    `SELECT bucket, storage_key, mime_type, width, height FROM file_renditions
      WHERE file_id = ? AND format = ? ORDER BY width ASC`,
    [fileId, format]
  );
}

router.get('/api/media/:fileId(\\d+)/poster', asyncRoute(async (req, res) => {
  const file = await getFile(req.params.fileId);
  if (!file) throw ApiError.notFound('File');
  assertCanRead(req, file);
  const poster = await getQuery(
    `SELECT * FROM file_variants WHERE file_id = ? AND kind = 'poster'`, [file.id]
  );
  if (!poster) throw ApiError.notFound('Poster');
  await sendStoredObject(req, res, {
    storageKey: poster.storage_key, backend: file.backend, mime: poster.mime_type,
    etag: `"${file.hash}-poster"`,
    cacheControl: file.visibility === 'public' ? 'public, max-age=31536000, immutable' : 'private, max-age=3600'
  });
}));

// With the S3 backend and the default `/uploads` base there is nothing on disk
// for the static mount to serve; public objects are redirected to the bucket
// instead (fixes uploads 404ing — or being looked for on local disk — once S3
// is configured). Only rows whose bytes really are in the bucket, and only
// public ones, are redirected.
if (PUBLIC_BASE.startsWith('/')) {
  router.get(`${PUBLIC_BASE.replace(/\/$/, '')}/*`, asyncRoute(async (req, res, next) => {
    const key = decodeURIComponent(req.params[0] ?? '');
    if (!key || key.includes('..') || key.startsWith('incoming/')) return next();
    const row = await getQuery(
      `SELECT f.backend, f.visibility, f.mime_type, f.hash, f.storage_key AS key FROM files f
        WHERE f.storage_key = ? AND f.deleted_at IS NULL
       UNION ALL
       SELECT f.backend, f.visibility, r.mime_type, f.hash, r.storage_key AS key
         FROM file_renditions r JOIN files f ON f.id = r.file_id
        WHERE r.storage_key = ? AND f.deleted_at IS NULL
       UNION ALL
       SELECT f.backend, f.visibility, v.mime_type, f.hash, v.storage_key AS key
         FROM file_variants v JOIN files f ON f.id = v.file_id
        WHERE v.storage_key = ? AND f.deleted_at IS NULL`,
      [key, key, key]
    );
    if (!row || row.backend === 'local' || row.visibility !== 'public') return next();
    await sendStoredObject(req, res, {
      storageKey: row.key, backend: row.backend, mime: row.mime_type,
      etag: `"${row.hash}"`, cacheControl: 'public, max-age=31536000, immutable'
    });
  }));
}

// Storage errors raised here reach the shared error handler as ApiErrors.
router.use((err, _req, _res, next) => {
  if (err instanceof StorageError) return next(new ApiError(err.message, { status: err.status, code: err.code }));
  return next(err);
});

export default router;
