// ============================================================================
//  /api/files and /api/upload/* — the HTTP surface of the storage engine.
//
//  Every upload route follows the same shape: multer buffers the bytes, then
//  storeFile() validates/dedupes/registers them, then we return a descriptor
//  the client can drop straight into a message or a profile field.
// ============================================================================

import express from 'express';
import crypto from 'crypto';

import { ApiError, asyncRoute, parseLimit, requireUser } from '../lib/httpUtils.js';
import { getFileType } from '../lib/mediaProbe.js';
import {
  storeFile, getFile, getVariant, deleteFile, listFilesForUser,
  getStorageUsage, collectGarbage, verifyIntegrity, recordAccess,
  verifyFileSignature, signFileUrl, sendStoredObject, formatBytes,
  addReference, releaseReference,
  DEFAULT_ORPHAN_GRACE_MS, DEFAULT_GC_LIMIT,
  uploadAvatar, uploadBanner, uploadServerIcon, uploadEmoji, uploadSticker, uploadAttachment,
  CATEGORY_RULES
} from '../storageService.js';
import { getQuery, allQuery } from '../db.js';

const router = express.Router();

/**
 * Shape a files row into the descriptor the frontend consumes.
 *
 * Images carry everything a client needs to render without layout shift and
 * at the right size: display `width`/`height` (EXIF orientation applied),
 * a `thumbhash` placeholder (and the older `placeholder` data URI), and
 * responsive `renditions` with ready `srcset` strings per format. `url` stays
 * the original (sanitised) file; `display_url` negotiates the best format.
 */
function toDescriptor(file) {
  return {
    id: file.id,
    url: file.url,
    download_url: file.download_url ?? `/api/files/${file.id}?download=1`,
    display_url: file.display_url ?? null,
    filename: file.original_name,
    file_type: file.file_type ?? getFileType(file.mime_type),
    mimetype: file.mime_type,
    size: file.size,
    size_human: formatBytes(file.size),
    width: file.width,
    height: file.height,
    duration_secs: file.duration_secs ?? null,
    is_animated: Boolean(file.is_animated),
    placeholder: file.blurhash ?? null,
    thumbhash: file.thumbhash ?? null,
    media_status: file.media_status ?? null,
    category: file.category,
    variants: file.variants ?? {},
    renditions: file.renditions ?? [],
    srcset: file.srcset ?? {},
    poster_url: file.variants?.poster?.url ?? null,
    thumbnail_url: file.variants?.thumb?.url ?? file.variants?.medium?.url ?? file.url,
    created_at: file.created_at,
    deduped: file.deduped ?? false
  };
}

/**
 * The client's filename, decoded as UTF-8.
 *
 * Browsers send `filename="สลิป.png"` as raw UTF-8 bytes, but busboy (under
 * multer) decodes multipart parameters as latin1 unless the uploader is built
 * with `defParamCharset: 'utf8'`, so Thai, CJK or emoji names arrived as
 * mojibake ("à¸ªà¸¥à¸´à¸›.png"). Re-read those latin1 code units as UTF-8 bytes.
 * Only when every code unit is a byte and the bytes are valid UTF-8, so a name
 * that was already decoded correctly (or is genuinely latin1) is unchanged.
 */
const utf8Strict = new TextDecoder('utf-8', { fatal: true });
export function decodeUploadFilename(name) {
  const value = String(name ?? '');
  // eslint-disable-next-line no-control-regex
  if (!/[\u0080-ÿ]/.test(value) || /[^\u0000-ÿ]/.test(value)) return value;
  try {
    return utf8Strict.decode(Buffer.from(value, 'latin1'));
  } catch {
    return value;
  }
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
    originalName: decodeUploadFilename(req.file.originalname),
    declaredMime: req.file.mimetype,
    ...uploadOptions(req, category)
  });
  res.json(toDescriptor(file));
}

/** The caller's own id; a `userId` query naming someone else is refused. */
function ownUserId(req) {
  if (req.query.userId && req.query.userId !== req.userId) {
    throw ApiError.forbidden('You can only list your own files');
  }
  return req.userId;
}

/** A private file is visible only to its uploader (or via a signed URL). */
function assertCanSeeFile(req, file) {
  if (file.visibility === 'private' && file.uploader_id !== req.userId) {
    throw ApiError.forbidden('This file is private');
  }
}

// --- upload endpoints --------------------------------------------------------

// Legacy generic endpoint. Kept because the original client calls it.
router.post('/upload', requireUser, uploadAttachment.single('file'), asyncRoute(async (req, res) => {
  await handleSingle(req, res, 'attachments', 'file');
}));

router.post('/upload/avatar', requireUser, uploadAvatar.single('avatar'), asyncRoute(async (req, res) => {
  await handleSingle(req, res, 'avatars', 'avatar');
}));

router.post('/upload/banner', requireUser, uploadBanner.single('banner'), asyncRoute(async (req, res) => {
  await handleSingle(req, res, 'banners', 'banner');
}));

router.post('/upload/server-icon', requireUser, uploadServerIcon.single('icon'), asyncRoute(async (req, res) => {
  await handleSingle(req, res, 'icons', 'icon');
}));

router.post('/upload/emoji', requireUser, uploadEmoji.single('emoji'), asyncRoute(async (req, res) => {
  await handleSingle(req, res, 'emojis', 'emoji');
}));

router.post('/upload/sticker', requireUser, uploadSticker.single('sticker'), asyncRoute(async (req, res) => {
  await handleSingle(req, res, 'stickers', 'sticker');
}));

// Multi-file message attachments. Partial success is reported per file rather
// than failing the whole batch — one oversized image should not lose the rest.
router.post('/upload/attachments', requireUser, uploadAttachment.array('files', 10), asyncRoute(async (req, res) => {
  if (!req.files?.length) throw new ApiError('No files uploaded', { code: 'NO_FILE' });

  const attachments = [];
  const failed = [];
  for (const f of req.files) {
    try {
      const stored = await storeFile({
        buffer: f.buffer,
        originalName: decodeUploadFilename(f.originalname),
        declaredMime: f.mimetype,
        ...uploadOptions(req, 'attachments')
      });
      attachments.push(toDescriptor(stored));
    } catch (err) {
      failed.push({ filename: decodeUploadFilename(f.originalname), error: err.message, code: err.code ?? 'STORAGE_ERROR' });
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
router.get('/files/usage', requireUser, asyncRoute(async (req, res) => {
  // Only ever your own: `?userId=` is accepted for older clients but must
  // name the caller, or anyone could read anyone's upload inventory.
  const userId = ownUserId(req);
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
router.get('/files', requireUser, asyncRoute(async (req, res) => {
  const userId = ownUserId(req);
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

router.get('/files/:fileId/meta', requireUser, asyncRoute(async (req, res) => {
  const file = await getFile(req.params.fileId);
  if (!file) throw ApiError.notFound('File');
  assertCanSeeFile(req, file);
  const refs = await allQuery(
    `SELECT message_id FROM attachments WHERE file_id = ? LIMIT 20`, [req.params.fileId]
  );
  res.json({ ...toDescriptor(file), ref_count: file.ref_count, referenced_by: refs });
}));

/** Mint a time-limited URL for a private file. */
router.post('/files/:fileId/signed-url', requireUser, asyncRoute(async (req, res) => {
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
  if (variantKind) {
    const variant = await getVariant(file.id, variantKind);
    if (!variant) throw ApiError.notFound(`Variant '${variantKind}'`);
    storageKey = variant.storage_key;
    mime = variant.mime_type;
  } else if (String(storageKey).startsWith('incoming/')) {
    // A direct upload that has not been verified and stripped yet.
    res.setHeader('Retry-After', '2');
    throw new ApiError('This upload is still being processed', { status: 409, code: 'MEDIA_PROCESSING' });
  }

  // Content-addressed keys are immutable, so a public file may be cached forever.
  const result = await sendStoredObject(req, res, {
    storageKey,
    backend: file.backend,
    mime,
    etag: `"${file.hash}${variantKind ? `-${variantKind}` : ''}"`,
    cacheControl: file.visibility === 'public' ? 'public, max-age=31536000, immutable' : 'private, max-age=300',
    filename: file.original_name,
    download: req.query.download === '1' || req.query.download === 'true'
  });
  if (result?.bytes) {
    recordAccess(file.id, { userId: req.userId, ip: req.ip, variant: variantKind, bytes: result.bytes })
      .catch(() => {});
  }
}));

// --- mutation ----------------------------------------------------------------

router.delete('/files/:fileId', requireUser, asyncRoute(async (req, res) => {
  const file = await getQuery(`SELECT * FROM files WHERE id = ?`, [req.params.fileId]);
  if (!file) throw ApiError.notFound('File');
  // A file with no uploader (legacy/anonymous) belongs to nobody, so nobody
  // but maintenance may delete it.
  if (file.uploader_id !== req.userId) {
    throw ApiError.forbidden('Only the uploader can delete this file');
  }
  await deleteFile(file.id, { force: req.query.force === 'true' });
  res.json({ success: true, id: file.id });
}));

// Raw reference-count manipulation. Releasing a reference makes a file
// GC-eligible, so an open endpoint would let anyone get someone else's bytes
// deleted by the next sweep. Maintenance only.
router.post('/files/:fileId/reference', requireAdmin, asyncRoute(async (req, res) => {
  await addReference(req.params.fileId, Number(req.body?.count) || 1);
  res.json({ success: true });
}));

router.delete('/files/:fileId/reference', requireAdmin, asyncRoute(async (req, res) => {
  await releaseReference(req.params.fileId, Number(req.query?.count) || 1);
  res.json({ success: true });
}));

// --- maintenance -------------------------------------------------------------
// Guarded by ADMIN_TOKEN; without it set, these are unavailable rather than open.

function requireAdmin(req, _res, next) {
  const token = process.env.ADMIN_TOKEN;
  if (!token) return next(ApiError.forbidden('Maintenance endpoints require ADMIN_TOKEN to be set'));
  const given = Buffer.from(String(req.get('x-admin-token') ?? ''));
  const expected = Buffer.from(token);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return next(ApiError.forbidden());
  }
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
