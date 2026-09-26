// ============================================================================
//  Image pipeline primitives: safety limits, metadata stripping, renditions,
//  thumbhash placeholders and Accept negotiation.
//
//  Everything here is a pure function of bytes in → bytes out, so it can be
//  unit-tested without a server and reused by the upload path, the background
//  job queue and the maintenance CLI alike. sharp is optional: without it the
//  lossless metadata strippers still run and renditions are simply skipped.
//
//  Measured on a 4-vCPU container, 12 MP JPEG source, one libvips thread,
//  per rendition (see DEPLOYMENT.md "Media pipeline"):
//
//      width   WebP q78 e4   AVIF q50 e0   AVIF e2   AVIF e4 (sharp default)
//      1920      ~650 ms       ~320 ms     ~1350 ms     ~9000 ms
//       960      ~200 ms        ~95 ms      ~230 ms     ~1900 ms
//       480      ~230 ms       ~150 ms      ~200 ms      ~470 ms
//
//  sharp's default AVIF effort (4) is far too slow for an upload path, so AVIF
//  runs at effort 2 (MEDIA_AVIF_EFFORT) and only in the background queue, after
//  the WebP set a client can already use. MEDIA_AVIF=0 turns it off.
// ============================================================================

import { rgbaToThumbHash } from 'thumbhash';
import { probeImage } from './mediaProbe.js';

// --- configuration -------------------------------------------------------------

const envInt = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

/** Read on every call so tests (and a changed env on restart) take effect. */
export function mediaConfig() {
  const widths = String(process.env.MEDIA_WIDTHS ?? '160,480,960,1920')
    .split(',').map((w) => Number(w.trim())).filter((w) => Number.isInteger(w) && w >= 16 && w <= 4096)
    .sort((a, b) => a - b);
  return {
    // Per-frame decode limit: the decompression-bomb guard. A 16k×16k PNG of
    // zeros compresses to ~1 MB but decodes to 1 GB of RGBA.
    maxPixels: envInt('MEDIA_MAX_PIXELS', 100_000_000),
    maxDimension: envInt('MEDIA_MAX_DIMENSION', 16_384),
    // Animated sources: frames × width × height. Above it only a still is made.
    maxAnimatedPixels: envInt('MEDIA_MAX_ANIMATED_PIXELS', 200_000_000),
    widths: widths.length ? widths : [160, 480, 960, 1920],
    avif: process.env.MEDIA_AVIF !== '0',
    avifEffort: Math.min(9, envInt('MEDIA_AVIF_EFFORT', 2)),
    avifQuality: Math.min(100, envInt('MEDIA_AVIF_QUALITY', 50)),
    webpQuality: Math.min(100, envInt('MEDIA_WEBP_QUALITY', 78))
  };
}

// --- optional sharp --------------------------------------------------------------

let sharpModule = null;
let sharpChecked = false;

/**
 * sharp is a native dependency and deliberately optional: without it uploads
 * still work, they just skip resized renditions.
 */
export async function loadSharp() {
  if (sharpChecked) return sharpModule;
  sharpChecked = true;
  try {
    sharpModule = (await import('sharp')).default;
    // libvips' operation cache helps batch tools, not a server decoding a
    // different image every time; bound it so it cannot hold hundreds of MB.
    sharpModule.cache({ memory: 64, files: 0, items: 100 });
  } catch {
    sharpModule = null;
  }
  return sharpModule;
}

/** Which input formats this sharp build decodes (HEIC needs a custom libvips). */
export async function decodableFormats() {
  const sharp = await loadSharp();
  if (!sharp) return new Set();
  const set = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
  if (sharp.format.svg?.input?.buffer) set.add('image/svg+xml');
  const heifSuffixes = sharp.format.heif?.input?.fileSuffix ?? [];
  if (heifSuffixes.includes('.avif')) set.add('image/avif');
  if (heifSuffixes.includes('.heic') || heifSuffixes.includes('.heif')) {
    set.add('image/heic');
    set.add('image/heif');
  }
  return set;
}

// --- errors ------------------------------------------------------------------------

export class MediaError extends Error {
  constructor(message, { status = 422, code = 'MEDIA_ERROR' } = {}) {
    super(message);
    this.name = 'MediaError';
    this.status = status;
    this.code = code;
  }
}

function assertDimensions(width, height, cfg = mediaConfig()) {
  if (!width || !height) return;
  if (width > cfg.maxDimension || height > cfg.maxDimension || width * height > cfg.maxPixels) {
    throw new MediaError(
      `Image dimensions ${width}×${height} exceed the limit (${cfg.maxDimension}px per side, ` +
      `${Math.round(cfg.maxPixels / 1e6)} MP)`,
      { status: 413, code: 'IMAGE_TOO_LARGE' }
    );
  }
}

// --- inspection --------------------------------------------------------------------

/**
 * Cheap, decode-free facts about an image plus sharp's view of it.
 * Throws MediaError(IMAGE_TOO_LARGE) for a decompression bomb *before* any
 * pixel is decoded: the header check needs no decoder at all, and sharp's
 * limitInputPixels backs it up for formats the header probe cannot read.
 *
 * @returns {Promise<{width, height, orientation, animated, pages, format, decodable}>}
 *   width/height are *display* dimensions (EXIF orientation applied).
 */
export async function inspectImage(buffer, mime) {
  const cfg = mediaConfig();
  const header = probeImage(buffer, mime);
  if (header) assertDimensions(header.width, header.height, cfg);

  const decodable = (await decodableFormats()).has(mime);
  const sharp = decodable ? await loadSharp() : null;
  if (!sharp || mime === 'image/svg+xml') {
    return {
      width: header?.width ?? null, height: header?.height ?? null,
      orientation: 1, animated: Boolean(header?.animated), pages: 1,
      format: mime, decodable: decodable && mime !== 'image/svg+xml'
    };
  }

  let meta;
  try {
    meta = await sharp(buffer, { limitInputPixels: cfg.maxPixels }).metadata();
  } catch (err) {
    if (/pixel limit/i.test(err.message)) {
      throw new MediaError('Image dimensions exceed the limit', { status: 413, code: 'IMAGE_TOO_LARGE' });
    }
    throw new MediaError(`Image could not be decoded: ${err.message}`, { status: 415, code: 'CORRUPT_IMAGE' });
  }
  const frameHeight = meta.pageHeight ?? meta.height;
  assertDimensions(meta.width, frameHeight, cfg);
  const orientation = meta.orientation ?? 1;
  const swap = orientation >= 5 && orientation <= 8;
  const pages = meta.pages ?? 1;
  return {
    width: swap ? frameHeight : meta.width,
    height: swap ? meta.width : frameHeight,
    orientation,
    animated: pages > 1,
    pages,
    format: meta.format,
    hasProfile: Boolean(meta.icc),
    decodable: true
  };
}

// --- metadata stripping --------------------------------------------------------------
//
// Photos carry GPS coordinates, device serials and capture times in EXIF/XMP.
// They are removed from the stored "original" too — it is what the download
// link hands out. Where possible the strip is lossless (segments/chunks are
// dropped, pixel data is copied byte-for-byte); only when an EXIF orientation
// has to be baked in is the image re-encoded, at high quality.

/**
 * @returns {Promise<{buffer: Buffer, method: 'lossless'|'reencoded'|'none', rotated: boolean}>}
 */
export async function sanitizeImage(buffer, mime, info = {}) {
  const orientation = info.orientation ?? 1;
  const needsRotate = orientation > 1 && !info.animated;

  if (needsRotate && info.decodable && ['image/jpeg', 'image/png', 'image/webp'].includes(mime)) {
    const sharp = await loadSharp();
    let pipeline = sharp(buffer, { limitInputPixels: mediaConfig().maxPixels }).rotate();
    if (info.hasProfile) pipeline = pipeline.keepIccProfile();
    const out = mime === 'image/jpeg'
      ? await pipeline.jpeg({ quality: 92, mozjpeg: true }).toBuffer()
      : mime === 'image/png'
        ? await pipeline.png({ compressionLevel: 9 }).toBuffer()
        : await pipeline.webp({ quality: 92 }).toBuffer();
    return { buffer: out, method: 'reencoded', rotated: true };
  }

  let stripped = null;
  switch (mime) {
    case 'image/jpeg': stripped = stripJpegMetadata(buffer); break;
    case 'image/png': stripped = stripPngMetadata(buffer); break;
    case 'image/webp': stripped = stripWebpMetadata(buffer); break;
    case 'image/avif':
    case 'image/heic':
    case 'image/heif': stripped = blankIsobmffMetadata(buffer); break;
    default: return { buffer, method: 'none', rotated: false };
  }
  if (stripped) return { buffer: stripped, method: 'lossless', rotated: false };

  // A structure the stripper did not understand: re-encode rather than keep
  // metadata we cannot vouch for.
  const sharp = info.decodable ? await loadSharp() : null;
  if (sharp && ['image/jpeg', 'image/png', 'image/webp'].includes(mime)) {
    const pipeline = sharp(buffer, { limitInputPixels: mediaConfig().maxPixels }).rotate();
    const out = mime === 'image/jpeg' ? await pipeline.jpeg({ quality: 92, mozjpeg: true }).toBuffer()
      : mime === 'image/png' ? await pipeline.png().toBuffer()
        : await pipeline.webp({ quality: 92 }).toBuffer();
    return { buffer: out, method: 'reencoded', rotated: orientation > 1 };
  }
  return { buffer, method: 'none', rotated: false };
}

/**
 * JPEG: drop APP1 (EXIF, XMP), APP13 (IPTC/Photoshop), APP12, COM and the
 * MPF APP2 segment, keep JFIF/ICC/Adobe and every coding segment, and cut the
 * file at the primary image's EOI — iPhone/Android "multi-picture" JPEGs
 * append gain maps and depth images there, each with its own EXIF block.
 * @returns {Buffer|null} null when the structure is not understood
 */
export function stripJpegMetadata(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  const parts = [buf.subarray(0, 2)];
  let offset = 2;
  while (offset < buf.length) {
    if (buf[offset] !== 0xff) return null;
    let marker = buf[offset + 1];
    while (marker === 0xff && offset + 2 < buf.length) { offset += 1; marker = buf[offset + 1]; } // fill bytes
    if (marker === undefined) return null;
    if (marker === 0xd9) { parts.push(buf.subarray(offset, offset + 2)); return Buffer.concat(parts); }
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) {
      parts.push(buf.subarray(offset, offset + 2)); offset += 2; continue;
    }
    if (offset + 4 > buf.length) return null;
    const length = buf.readUInt16BE(offset + 2);
    const end = offset + 2 + length;
    if (length < 2 || end > buf.length) return null;

    if (marker === 0xda) {
      // Start of scan: entropy-coded data follows. Copy up to and including
      // the first EOI; anything after it is appended images (MPF) or junk.
      let at = end;
      for (;;) {
        const ff = buf.indexOf(0xff, at);
        if (ff === -1 || ff + 1 >= buf.length) { parts.push(buf.subarray(offset)); return Buffer.concat(parts); }
        const next = buf[ff + 1];
        if (next === 0xd9) { parts.push(buf.subarray(offset, ff + 2)); return Buffer.concat(parts); }
        if (next === 0x00 || (next >= 0xd0 && next <= 0xd7) || next === 0xff) { at = ff + 1; continue; }
        // Another marker (progressive JPEG: DHT/SOS between scans) — copy the
        // scan so far and keep parsing segments from the marker.
        parts.push(buf.subarray(offset, ff));
        offset = ff;
        break;
      }
      continue;
    }

    const id = buf.subarray(offset + 4, Math.min(end, offset + 16)).toString('latin1');
    const drop = marker === 0xe1                        // Exif / XMP
      || marker === 0xed                                // IPTC / Photoshop IRB
      || marker === 0xec                                // "Ducky"
      || marker === 0xfe                                // comment
      || (marker === 0xe2 && id.startsWith('MPF'));     // multi-picture index
    if (!drop) parts.push(buf.subarray(offset, end));
    offset = end;
  }
  return null;
}

/**
 * PNG: drop text chunks (tEXt/zTXt/iTXt — where XMP lives), eXIf and tIME.
 * Whole chunks are copied, so every CRC stays valid.
 */
export function stripPngMetadata(buf) {
  const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) return null;
  const DROP = new Set(['tEXt', 'zTXt', 'iTXt', 'eXIf', 'tIME']);
  const parts = [SIG];
  let offset = 8;
  while (offset + 12 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString('latin1', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > buf.length) return null;
    if (!DROP.has(type)) parts.push(buf.subarray(offset, end));
    offset = end;
    if (type === 'IEND') return Buffer.concat(parts);
  }
  return null;
}

/** WebP: drop the EXIF and XMP chunks and clear their VP8X flags. */
export function stripWebpMetadata(buf) {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WEBP') {
    return null;
  }
  const parts = [];
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const fourcc = buf.toString('latin1', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const end = offset + 8 + size + (size % 2);
    if (offset + 8 + size > buf.length) return null;
    if (fourcc === 'VP8X') {
      const chunk = Buffer.from(buf.subarray(offset, Math.min(end, buf.length)));
      chunk[8] &= ~(0x08 | 0x04);       // EXIF and XMP metadata flags
      parts.push(chunk);
    } else if (fourcc !== 'EXIF' && fourcc !== 'XMP ') {
      parts.push(buf.subarray(offset, Math.min(end, buf.length)));
    }
    offset = end;
  }
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8, 'latin1');
  return Buffer.concat([header, body]);
}

/**
 * HEIF/AVIF (iPhone photos): metadata are *items* whose bytes the `iloc` box
 * points at. Zero-filling those extents removes GPS & co. without touching the
 * container structure, so the file stays valid and pixel-identical. Rotation
 * lives in the irot/imir properties, not in EXIF, and is unaffected.
 * @returns {Buffer|null}
 */
export function blankIsobmffMetadata(input) {
  const buf = Buffer.from(input);           // never mutate the caller's buffer
  try {
    const boxes = (start, end) => {
      const out = [];
      let at = start;
      while (at + 8 <= end) {
        let size = buf.readUInt32BE(at);
        const type = buf.toString('latin1', at + 4, at + 8);
        let header = 8;
        if (size === 1) { size = Number(buf.readBigUInt64BE(at + 8)); header = 16; }
        if (size === 0) size = end - at;
        if (size < header || at + size > end) break;
        out.push({ type, start: at, body: at + header, end: at + size });
        at += size;
      }
      return out;
    };
    const meta = boxes(0, buf.length).find((b) => b.type === 'meta');
    if (!meta) return buf;                  // no items at all: nothing to strip
    const children = boxes(meta.body + 4, meta.end);   // meta is a FullBox
    const iinf = children.find((b) => b.type === 'iinf');
    const iloc = children.find((b) => b.type === 'iloc');
    const idat = children.find((b) => b.type === 'idat');
    if (!iinf || !iloc) return buf;

    // Which item ids are metadata?
    const metaItems = new Set();
    const iinfVersion = buf[iinf.body];
    const entriesAt = iinf.body + 4 + (iinfVersion === 0 ? 2 : 4);
    for (const infe of boxes(entriesAt, iinf.end)) {
      if (infe.type !== 'infe') continue;
      const version = buf[infe.body];
      if (version < 2) continue;
      let at = infe.body + 4;
      const itemId = version === 2 ? buf.readUInt16BE(at) : buf.readUInt32BE(at);
      at += (version === 2 ? 2 : 4) + 2;    // item_ID, item_protection_index
      const itemType = buf.toString('latin1', at, at + 4);
      if (itemType === 'Exif') metaItems.add(itemId);
      if (itemType === 'mime') {
        const rest = buf.toString('latin1', at + 4, infe.end);
        if (/rdf\+xml|xmp/i.test(rest)) metaItems.add(itemId);
      }
    }
    if (!metaItems.size) return buf;

    // Where are their bytes?
    const version = buf[iloc.body];
    let at = iloc.body + 4;
    const offsetSize = buf[at] >> 4;
    const lengthSize = buf[at] & 0x0f;
    const baseOffsetSize = buf[at + 1] >> 4;
    const indexSize = version >= 1 ? buf[at + 1] & 0x0f : 0;
    at += 2;
    const readN = (n) => {
      let v = 0;
      for (let i = 0; i < n; i += 1) v = v * 256 + buf[at + i];
      at += n;
      return v;
    };
    const itemCount = version < 2 ? readN(2) : readN(4);
    for (let i = 0; i < itemCount; i += 1) {
      const itemId = version < 2 ? readN(2) : readN(4);
      const construction = version >= 1 ? readN(2) & 0x0f : 0;
      readN(2);                             // data_reference_index
      const baseOffset = readN(baseOffsetSize);
      const extentCount = readN(2);
      for (let e = 0; e < extentCount; e += 1) {
        if (indexSize) readN(indexSize);
        const extentOffset = readN(offsetSize);
        const extentLength = readN(lengthSize);
        if (!metaItems.has(itemId)) continue;
        let from;
        if (construction === 0) from = baseOffset + extentOffset;
        else if (construction === 1 && idat) from = idat.body + baseOffset + extentOffset;
        else continue;
        const to = extentLength ? from + extentLength : buf.length;
        if (from >= 0 && to <= buf.length && from < to) buf.fill(0, from, to);
      }
    }
    return buf;
  } catch {
    return null;
  }
}

// --- placeholders -----------------------------------------------------------------

/**
 * ThumbHash (~25 bytes, base64) — encodes aspect ratio, alpha and a smooth
 * colour field; decoded on the client into a ~32px data URL. Chosen over
 * BlurHash because it keeps alpha and the aspect ratio, and the decoder is
 * ~1 KB of JS with no dependencies.
 */
export async function computeThumbhash(buffer, { animated = false } = {}) {
  const sharp = await loadSharp();
  if (!sharp) return null;
  const { data, info } = await sharp(buffer, { limitInputPixels: mediaConfig().maxPixels, animated: false, pages: 1 })
    .rotate()
    .resize(100, 100, { fit: 'inside' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  void animated;
  return Buffer.from(rgbaToThumbHash(info.width, info.height, data)).toString('base64');
}

/**
 * The older inline preview: a ~20px WebP data URI (files.blurhash). Kept so
 * clients that do not decode thumbhash still get a colour field.
 */
export async function computeTinyPreview(buffer) {
  const sharp = await loadSharp();
  if (!sharp) return null;
  const tiny = await sharp(buffer, { limitInputPixels: mediaConfig().maxPixels, animated: false })
    .rotate()
    .resize(20, 20, { fit: 'inside' })
    .webp({ quality: 40 })
    .toBuffer();
  return tiny.length > 2048 ? null : `data:image/webp;base64,${tiny.toString('base64')}`;
}

// --- renditions -----------------------------------------------------------------

/**
 * Per-category rendition shapes.
 *   widths: responsive widths for `srcset` (fit inside, never enlarged)
 *   square: fixed square sizes, `fit` cover (avatars/icons: cropped) or inside
 *           (emoji/stickers: never cropped)
 */
export function renditionSpec(category) {
  const cfg = mediaConfig();
  switch (category) {
    case 'avatars':
    case 'icons': return { square: [64, 128, 256, 512], fit: 'cover' };
    case 'emojis': return { square: [48, 96, 160], fit: 'inside' };
    case 'stickers': return { square: [160, 320], fit: 'inside' };
    case 'banners':
    case 'splashes': return { widths: cfg.widths.filter((w) => w >= 480) };
    default: return { widths: cfg.widths };
  }
}

/** Largest width an animated rendition is made at — every frame is encoded. */
const ANIMATED_MAX_WIDTH = 640;

/**
 * Which renditions to make for a source of this size.
 * @returns {Array<{bucket:number, width:number, height:number|null, fit:string}>}
 */
export function planRenditions(category, width, height, { animated = false } = {}) {
  if (!width || !height) return [];
  const spec = renditionSpec(category);
  if (spec.square) {
    const shortest = spec.fit === 'cover' ? Math.min(width, height) : Math.max(width, height);
    let sizes = spec.square.filter((s) => s <= shortest);
    if (!sizes.length) sizes = [spec.square[0]];   // tiny source: one (upscaled) size
    if (animated) sizes = sizes.filter((s) => s <= ANIMATED_MAX_WIDTH);
    return sizes.map((s) => ({ bucket: s, width: s, height: s, fit: spec.fit }));
  }
  const cap = animated ? Math.min(width, ANIMATED_MAX_WIDTH) : width;
  const buckets = spec.widths.filter((w) => w < cap);
  const largest = Math.min(cap, spec.widths[spec.widths.length - 1]);
  if (!buckets.includes(largest)) buckets.push(largest);
  // A very tall image (a long screenshot) is capped at 3× its width so a
  // "960w" rendition cannot be a 960×30000 decode on the client.
  return buckets.map((w) => ({ bucket: w, width: w, height: w * 3, fit: 'inside' }));
}

/**
 * Encode one rendition.
 * @returns {Promise<{data:Buffer, width:number, height:number, mime:string, animated:boolean}>}
 */
export async function renderRendition(buffer, plan, format, { animated = false } = {}) {
  const sharp = await loadSharp();
  if (!sharp) throw new Error('sharp is not installed');
  const cfg = mediaConfig();
  let pipeline = sharp(buffer, {
    limitInputPixels: cfg.maxPixels,
    animated,
    ...(animated ? {} : { pages: 1 })
  }).rotate();

  pipeline = pipeline.resize(plan.width, plan.height, {
    fit: plan.fit,
    position: 'attention',
    withoutEnlargement: plan.fit !== 'cover',
    background: { r: 0, g: 0, b: 0, alpha: 0 }
  });

  let mime;
  if (format === 'avif') {
    pipeline = pipeline.avif({ quality: cfg.avifQuality, effort: cfg.avifEffort });
    mime = 'image/avif';
  } else {
    pipeline = pipeline.webp({
      quality: animated ? Math.min(cfg.webpQuality, 75) : cfg.webpQuality,
      effort: 4,
      smartSubsample: !animated,
      ...(animated ? { loop: 0 } : {})
    });
    mime = 'image/webp';
  }
  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  return {
    data,
    width: info.width,
    height: info.pageHeight ?? info.height,
    mime,
    animated: animated && (info.pages ?? 1) > 1
  };
}

/** A static first frame of an animated image, for "don't autoplay GIFs". */
export async function renderStill(buffer, maxWidth = 480) {
  const sharp = await loadSharp();
  const { data, info } = await sharp(buffer, { limitInputPixels: mediaConfig().maxPixels, animated: false, pages: 1 })
    .rotate()
    .resize(maxWidth, maxWidth * 3, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: mediaConfig().webpQuality })
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, mime: 'image/webp' };
}

/** Whether an animated source is small enough to re-encode frame by frame. */
export function animationWithinBudget(info) {
  return (info.pages ?? 1) * (info.width ?? 0) * (info.height ?? 0) <= mediaConfig().maxAnimatedPixels;
}

// --- negotiation ------------------------------------------------------------------

/** Parse an Accept header into a Map of media type → q. */
function parseAccept(header) {
  const map = new Map();
  for (const part of String(header ?? '').split(',')) {
    const [type, ...params] = part.trim().toLowerCase().split(';');
    if (!type) continue;
    let q = 1;
    for (const p of params) {
      const [k, v] = p.trim().split('=');
      if (k === 'q') q = Number(v);
    }
    if (!Number.isFinite(q)) q = 0;
    map.set(type, Math.max(map.get(type) ?? 0, q));
  }
  return map;
}

/**
 * Pick the best format a client explicitly accepts. Wildcards do not count:
 * every browser sends image/* whether or not it decodes AVIF, so only an
 * explicit image/avif / image/webp entry proves support.
 * @param {string} accept   the request's Accept header
 * @param {Set<string>} available formats that exist, e.g. {'avif','webp'}
 * @returns {'avif'|'webp'|null} null → serve the original
 */
export function negotiateFormat(accept, available) {
  const types = parseAccept(accept);
  for (const format of ['avif', 'webp']) {
    if (available.has(format) && (types.get(`image/${format}`) ?? 0) > 0) return format;
  }
  return null;
}

/**
 * The rendition to serve for a requested width: the smallest one at least as
 * wide as asked (so a 400px slot on a 2× screen asks ?w=800 and gets 960),
 * or the largest one when nothing is that big.
 */
export function pickRendition(renditions, width) {
  if (!renditions.length) return null;
  const sorted = [...renditions].sort((a, b) => a.width - b.width);
  if (!width) return sorted[sorted.length - 1];
  return sorted.find((r) => r.width >= width) ?? sorted[sorted.length - 1];
}
