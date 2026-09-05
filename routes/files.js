// ============================================================================
//  /api/files and /api/upload/* — the HTTP surface of the storage engine.
//
//  Every upload route follows the same shape: multer buffers the bytes, then
//  storeFile() validates/dedupes/registers them, then we return a descriptor
//  the client can drop straight into a message or a profile field.
// ============================================================================

import express from 'express';
import fs from 'fs';

import { ApiError, asyncRoute, parseLimit } from '../lib/httpUtils.js';
import { getFileType } from '../lib/mediaProbe.js';
import {
  storeFile, getFile, getVariant, deleteFile, listFilesForUser,
  getStorageUsage, collectGarbage, verifyIntegrity, recordAccess,
  verifyFileSignature, signFileUrl, resolveStoragePath, formatBytes,
  addReference, releaseReference,
  DEFAULT_ORPHAN_GRACE_MS, DEFAULT_GC_LIMIT,
  uploadAvatar, uploadBanner, uploadServerIcon, uploadEmoji, uploadSticker, uploadAttachment,
  CATEGORY_RULES
} from '../storageService.js';
import { getQuery, allQuery } from '../db.js';

const router = express.Router();

/** Shape a files row into the descriptor the frontend consumes. */
function toDescriptor(file) {
  return {
    id: file.id,
    url: file.url,
    filename: file.original_name,
    file_type: file.file_type ?? getFileType(file.mime_type),
    mimetype: file.mime_type,
    size: file.size,
    size_human: formatBytes(file.size),
    width: file.width,
    height: file.height,
    is_animated: Boolean(file.is_animated),
    placeholder: file.blurhash ?? null,
    category: file.category,
    variants: file.variants ?? {},
    thumbnail_url: file.variants?.thumb?.url ?? file.variants?.medium?.url ?? file.url,
    created_at: file.created_at,
    deduped: file.deduped ?? false
  };
}

function uploadOptions(req, category) {
  return {
    category,
    uploaderId: req.userId ?? null,
    visibility: req.body?.visibility === 'private' ? 'private'
      : req.body?.visibility === 'authenticated' ? 'authenticated'
      : 'public',
    expiresInSeconds: req.body?.expiresIn ? Number(req.body.expiresIn) : null
  };
}

async function handleSingle(req, res, category, field) {
  if (!req.file) throw new ApiError(`No ${field} uploaded`, { code: 'NO_FILE' });
  const file = await storeFile({
    buffer: req.file.buffer,
    originalName: req.file.originalname,
    declaredMime: req.file.mimetype,
    ...uploadOptions(req, category)
  });
  res.json(toDescriptor(file));
}

// --- upload endpoints --------------------------------------------------------

// Legacy generic endpoint. Kept because the original client calls it.
router.post('/upload', uploadAttachment.single('file'), asyncRoute(async (req, res) => {
  await handleSingle(req, res, 'attachments', 'file');
}));

router.post('/upload/avatar', uploadAvatar.single('avatar'), asyncRoute(async (req, res) => {
  await handleSingle(req, res, 'avatars', 'avatar');
}));

router.post('/upload/banner', uploadBanner.single('banner'), asyncRoute(async (req, res) => {
  await handleSingle(req, res, 'banners', 'banner');
}));

router.post('/upload/server-icon', uploadServerIcon.single('icon'), asyncRoute(async (req, res) => {
  await handleSingle(req, res, 'icons', 'icon');
}));

router.post('/upload/emoji', uploadEmoji.single('emoji'), asyncRoute(async (req, res) => {
  await handleSingle(req, res, 'emojis', 'emoji');
}));

router.post('/upload/sticker', uploadSticker.single('sticker'), asyncRoute(async (req, res) => {
  await handleSingle(req, res, 'stickers', 'sticker');
}));

// Multi-file message attachments. Partial success is reported per file rather
// than failing the whole batch — one oversized image should not lose the rest.
router.post('/upload/attachments', uploadAttachment.array('files', 10), asyncRoute(async (req, res) => {
  if (!req.files?.length) throw new ApiError('No files uploaded', { code: 'NO_FILE' });

  const attachments = [];
  const failed = [];
  for (const f of req.files) {
    try {
      const stored = await storeFile({
        buffer: f.buffer,
        originalName: f.originalname,
        declaredMime: f.mimetype,
        ...uploadOptions(req, 'attachments')
      });
      attachments.push(toDescriptor(stored));
    } catch (err) {
      failed.push({ filename: f.originalname, error: err.message, code: err.code ?? 'STORAGE_ERROR' });
    }
  }

  if (!attachments.length) {
    throw new ApiError('All uploads were rejected', { status: 415, code: 'ALL_REJECTED', details: failed });
  }
  res.json({ attachments, ...(failed.length ? { failed } : {}) });
}));

// --- metadata ----------------------------------------------------------------

/** Storage policy, so the client can validate before spending bandwidth. */
router.get('/files/limits', (_req, res) => {
  const limits = {};
  for (const [category, rules] of Object.entries(CATEGORY_RULES)) {
    limits[category] = {
      max_size: rules.maxSize,
      max_size_human: formatBytes(rules.maxSize),
      allowed_mime_types: rules.mimes,
      variants: rules.variants.map((v) => v.kind)
    };
  }
  res.json({ categories: limits });
});

/** Current user's quota. */
router.get('/files/usage', asyncRoute(async (req, res) => {
  const userId = req.query.userId ?? req.userId;
  if (!userId) throw ApiError.unauthorized();
  const usage = await getStorageUsage(userId);
  if (!usage) throw ApiError.notFound('User');

  const byCategory = await allQuery(
    `SELECT category, count(*) AS files, sum(size) AS bytes
       FROM files WHERE uploader_id = ? AND deleted_at IS NULL
      GROUP BY category ORDER BY bytes DESC`,
    [userId]
  );
  res.json({
    ...usage,
    by_category: byCategory.map((r) => ({ ...r, bytes_human: formatBytes(r.bytes ?? 0) }))
  });
}));

/** Paginated list of a user's uploads — powers a media gallery / storage manager. */
router.get('/files', asyncRoute(async (req, res) => {
  const userId = req.query.userId ?? req.userId;
  if (!userId) throw ApiError.unauthorized();
  const rows = await listFilesForUser(userId, {
    category: req.query.category ?? null,
    limit: parseLimit(req.query.limit, { fallback: 50, max: 200 }),
    before: req.query.before ?? null
  });
  const files = await Promise.all(rows.map((r) => getFile(r.id)));
  res.json({
    files: files.filter(Boolean).map(toDescriptor),
    next_before: rows.length ? rows[rows.length - 1].id : null
  });
}));

router.get('/files/:fileId/meta', asyncRoute(async (req, res) => {
  const file = await getFile(req.params.fileId);
  if (!file) throw ApiError.notFound('File');
  const refs = await allQuery(
    `SELECT message_id FROM attachments WHERE file_id = ? LIMIT 20`, [req.params.fileId]
  );
  res.json({ ...toDescriptor(file), ref_count: file.ref_count, referenced_by: refs });
}));

/** Mint a time-limited URL for a private file. */
router.post('/files/:fileId/signed-url', asyncRoute(async (req, res) => {
  const file = await getFile(req.params.fileId);
  if (!file) throw ApiError.notFound('File');
  if (file.visibility === 'private' && file.uploader_id !== req.userId) {
    throw ApiError.forbidden('Only the uploader can share this file');
  }
  const ttl = Math.min(Number(req.body?.ttlSeconds) || 3600, 86400);
  res.json({
    url: signFileUrl(file.id, { ttlSeconds: ttl, variant: req.body?.variant ?? null }),
    expires_in: ttl
  });
}));

// --- serving -----------------------------------------------------------------

/**
 * Access-controlled read path. Public files are normally served by the static
 * mount; this route exists for `authenticated` and `private` visibility, for
 * signed URLs, and for range requests on media.
 */
router.get('/files/:fileId', asyncRoute(async (req, res) => {
  const file = await getFile(req.params.fileId);
  if (!file) throw ApiError.notFound('File');

  const variantKind = req.query.variant ?? null;
  const signed = verifyFileSignature(file.id, {
    expires: req.query.expires, sig: req.query.sig, variant: variantKind
  });

  if (file.visibility === 'private' && !signed && file.uploader_id !== req.userId) {
    throw ApiError.forbidden('This file is private');
  }
  if (file.visibility === 'authenticated' && !signed && !req.userId) {
    throw ApiError.unauthorized();
  }

  let storageKey = file.storage_key;
  let mime = file.mime_type;
  let size = file.size;
  if (variantKind) {
    const variant = await getVariant(file.id, variantKind);
    if (!variant) throw ApiError.notFound(`Variant '${variantKind}'`);
    storageKey = variant.storage_key;
    mime = variant.mime_type;
    size = variant.size;
  }

  const absolute = resolveStoragePath(storageKey);
  let stat;
  try { stat = fs.statSync(absolute); }
  catch { throw new ApiError('File bytes are missing from storage', { status: 410, code: 'BYTES_GONE' }); }

  // Content-addressed keys are immutable, so this may be cached forever.
  res.setHeader('Content-Type', mime);
  res.setHeader('Cache-Control', file.visibility === 'public'
    ? 'public, max-age=31536000, immutable'
    : 'private, max-age=300');
  res.setHeader('ETag', `"${file.hash}${variantKind ? `-${variantKind}` : ''}"`);
  res.setHeader('Accept-Ranges', 'bytes');
  // Never let an uploaded SVG or HTML-ish blob execute in our origin.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  res.setHeader(
    'Content-Disposition',
    `${getFileType(mime) === 'file' ? 'attachment' : 'inline'}; ` +
    `filename*=UTF-8''${encodeURIComponent(file.original_name)}`
  );

  if (req.headers['if-none-match'] === res.getHeader('ETag')) return res.status(304).end();

  // Range support so <video>/<audio> can seek.
  const range = req.headers.range;
  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (match) {
      const start = match[1] ? Number(match[1]) : 0;
      const end = match[2] ? Number(match[2]) : stat.size - 1;
      if (start >= stat.size || end >= stat.size || start > end) {
        res.setHeader('Content-Range', `bytes */${stat.size}`);
        return res.status(416).end();
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${stat.size}`);
      res.setHeader('Content-Length', end - start + 1);
      recordAccess(file.id, { userId: req.userId, ip: req.ip, variant: variantKind, bytes: end - start + 1 })
        .catch(() => {});
      return fs.createReadStream(absolute, { start, end }).pipe(res);
    }
  }

  res.setHeader('Content-Length', stat.size);
  recordAccess(file.id, { userId: req.userId, ip: req.ip, variant: variantKind, bytes: size })
    .catch(() => {});
  fs.createReadStream(absolute).pipe(res);
}));

// --- mutation ----------------------------------------------------------------

router.delete('/files/:fileId', asyncRoute(async (req, res) => {
  const file = await getQuery(`SELECT * FROM files WHERE id = ?`, [req.params.fileId]);
  if (!file) throw ApiError.notFound('File');
  if (file.uploader_id && file.uploader_id !== req.userId) {
    throw ApiError.forbidden('Only the uploader can delete this file');
  }
  await deleteFile(file.id, { force: req.query.force === 'true' });
  res.json({ success: true, id: file.id });
}));

router.post('/files/:fileId/reference', asyncRoute(async (req, res) => {
  await addReference(req.params.fileId, Number(req.body?.count) || 1);
  res.json({ success: true });
}));

router.delete('/files/:fileId/reference', asyncRoute(async (req, res) => {
  await releaseReference(req.params.fileId, Number(req.query?.count) || 1);
  res.json({ success: true });
}));

// --- maintenance -------------------------------------------------------------
// Guarded by ADMIN_TOKEN; without it set, these are unavailable rather than open.

function requireAdmin(req, _res, next) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return next(ApiError.forbidden('Maintenance endpoints require ADMIN_TOKEN to be set'));
  if (req.get('x-admin-token') !== token) return next(ApiError.forbidden());
  next();
}

/**
 * Read a numeric body field, accepting 0.
 *
 * `Number(value) || fallback` looks right and is wrong: 0 is falsy, so
 * `orphanGraceMs: 0` — "collect everything now" — silently became the 24-hour
 * default and the endpoint reported that it had found nothing to do.
 */
function numberField(value, { min = 0, max = Number.MAX_SAFE_INTEGER, name }) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new ApiError(`${name} must be a number`, { code: 'INVALID_PARAMETER' });
  }
  if (parsed < min || parsed > max) {
    throw new ApiError(`${name} must be between ${min} and ${max}`, { code: 'INVALID_PARAMETER' });
  }
  return parsed;
}

router.post('/files/maintenance/gc', requireAdmin, asyncRoute(async (req, res) => {
  const body = req.body ?? {};

  // The CLI spells this `--apply`, so an operator scripting the HTTP endpoint
  // reaches for `apply` first. Accepting only `dryRun` meant `{apply: true}`
  // ran a dry run and returned 200 — a cron job that reclaims nothing forever
  // while looking healthy. Both spellings work; contradicting each other is an
  // error rather than a guess.
  const hasApply = body.apply !== undefined;
  const hasDryRun = body.dryRun !== undefined;
  if (hasApply && hasDryRun && Boolean(body.apply) === Boolean(body.dryRun)) {
    throw new ApiError('apply and dryRun contradict each other', { code: 'INVALID_PARAMETER' });
  }
  const dryRun = hasApply ? !body.apply : body.dryRun !== false;

  // graceHours is the friendlier unit and matches the CLI's --grace-hours.
  const graceHours = numberField(body.graceHours, { max: 24 * 365, name: 'graceHours' });
  const orphanGraceMs = graceHours !== undefined
    ? graceHours * 3600 * 1000
    : numberField(body.orphanGraceMs, { name: 'orphanGraceMs' });

  const limit = numberField(body.limit, { min: 1, max: 100_000, name: 'limit' });

  const result = await collectGarbage({
    dryRun,
    ...(orphanGraceMs !== undefined ? { orphanGraceMs } : {}),
    ...(limit !== undefined ? { limit } : {})
  });

  // Echo what actually ran. Without this the caller cannot tell a real sweep
  // that found nothing from a dry run that was never going to delete anything —
  // which is exactly how the bug above stayed invisible.
  res.json({
    ...result,
    bytes_freed_human: formatBytes(result.bytesFreed),
    effective: {
      dryRun,
      orphanGraceMs: orphanGraceMs ?? DEFAULT_ORPHAN_GRACE_MS,
      grace_hours: (orphanGraceMs ?? DEFAULT_ORPHAN_GRACE_MS) / 3600 / 1000,
      limit: limit ?? DEFAULT_GC_LIMIT
    }
  });
}));

router.get('/files/maintenance/integrity', requireAdmin, asyncRoute(async (_req, res) => {
  res.json(await verifyIntegrity());
}));

export default router;
export { toDescriptor as fileDescriptor };
