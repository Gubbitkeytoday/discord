// Dependency-free media inspection: magic-byte sniffing and image dimensions.
//
// Why not trust req.file.mimetype? Because it is the *client's* claim. A file
// named cat.png with Content-Type image/png can be an HTML document that the
// browser will happily render from our origin. Everything here reads the actual
// bytes instead.

const MAGIC = [
  { mime: 'image/jpeg', ext: 'jpg',  bytes: [0xff, 0xd8, 0xff] },
  { mime: 'image/png',  ext: 'png',  bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { mime: 'image/gif',  ext: 'gif',  bytes: [0x47, 0x49, 0x46, 0x38] },
  { mime: 'image/bmp',  ext: 'bmp',  bytes: [0x42, 0x4d] },
  { mime: 'application/pdf', ext: 'pdf', bytes: [0x25, 0x50, 0x44, 0x46] },
  { mime: 'application/zip', ext: 'zip', bytes: [0x50, 0x4b, 0x03, 0x04] },
  { mime: 'audio/mpeg', ext: 'mp3',  bytes: [0x49, 0x44, 0x33] },
  { mime: 'audio/flac', ext: 'flac', bytes: [0x66, 0x4c, 0x61, 0x43] },
  { mime: 'video/x-matroska', ext: 'mkv', bytes: [0x1a, 0x45, 0xdf, 0xa3] }
];

function startsWith(buf, bytes, offset = 0) {
  if (buf.length < offset + bytes.length) return false;
  return bytes.every((b, i) => buf[offset + i] === b);
}

const ascii = (buf, start, len) => buf.slice(start, start + len).toString('latin1');

/**
 * Identify a buffer's real type.
 * @returns {{mime: string, ext: string, confident: boolean}}
 */
export function sniffMime(buffer, declaredMime = 'application/octet-stream', filename = '') {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    return { mime: 'application/octet-stream', ext: '', confident: false };
  }

  for (const sig of MAGIC) {
    if (startsWith(buffer, sig.bytes)) return { ...sig, confident: true };
  }

  // RIFF containers: WebP and WAV share the same first 4 bytes.
  if (ascii(buffer, 0, 4) === 'RIFF') {
    const kind = ascii(buffer, 8, 4);
    if (kind === 'WEBP') return { mime: 'image/webp', ext: 'webp', confident: true };
    if (kind === 'WAVE') return { mime: 'audio/wav',  ext: 'wav',  confident: true };
  }

  // ISO base media (MP4, MOV, M4A): 'ftyp' at offset 4, brand at 8.
  if (ascii(buffer, 4, 4) === 'ftyp') {
    const brand = ascii(buffer, 8, 4);
    if (brand.startsWith('M4A')) return { mime: 'audio/mp4', ext: 'm4a', confident: true };
    if (brand === 'qt  ')        return { mime: 'video/quicktime', ext: 'mov', confident: true };
    return { mime: 'video/mp4', ext: 'mp4', confident: true };
  }

  // Ogg can carry audio or video; treat as audio unless declared otherwise.
  if (ascii(buffer, 0, 4) === 'OggS') {
    return declaredMime.startsWith('video/')
      ? { mime: 'video/ogg', ext: 'ogv', confident: true }
      : { mime: 'audio/ogg', ext: 'ogg', confident: true };
  }

  // Text-ish formats have no magic number. Only accept them when the *declared*
  // type is text/svg AND the content actually parses as such.
  const head = buffer.slice(0, 1024).toString('utf8').trimStart();
  if (declaredMime === 'image/svg+xml' && /^(<\?xml|<svg)/i.test(head)) {
    return { mime: 'image/svg+xml', ext: 'svg', confident: true };
  }
  if (declaredMime === 'application/json') {
    try { JSON.parse(buffer.toString('utf8')); return { mime: 'application/json', ext: 'json', confident: true }; }
    catch { /* not json */ }
  }
  // Accept text/plain only when the head contains no binary control bytes.
  if (declaredMime === 'text/plain' && !/[\x00-\x08\x0e-\x1f]/.test(head)) {
    return { mime: 'text/plain', ext: 'txt', confident: true };
  }

  const ext = (filename.match(/\.([a-z0-9]{1,8})$/i)?.[1] ?? '').toLowerCase();
  return { mime: 'application/octet-stream', ext, confident: false };
}

/**
 * Read intrinsic image dimensions straight from the header.
 * @returns {{width: number, height: number, animated: boolean} | null}
 */
export function probeImage(buffer, mime) {
  try {
    switch (mime) {
      case 'image/png':  return probePng(buffer);
      case 'image/jpeg': return probeJpeg(buffer);
      case 'image/gif':  return probeGif(buffer);
      case 'image/webp': return probeWebp(buffer);
      case 'image/bmp':  return { width: buffer.readInt32LE(18), height: Math.abs(buffer.readInt32LE(22)), animated: false };
      case 'image/svg+xml': return probeSvg(buffer);
      default: return null;
    }
  } catch {
    return null; // truncated or malformed header — not fatal, dimensions stay null
  }
}

function probePng(buf) {
  // IHDR is always the first chunk: width/height are big-endian at 16 and 20.
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  // APNG announces itself with an acTL chunk before the first IDAT.
  const animated = buf.slice(0, Math.min(buf.length, 4096)).includes('acTL');
  return { width, height, animated };
}

function probeJpeg(buf) {
  let offset = 2;
  while (offset < buf.length - 9) {
    if (buf[offset] !== 0xff) { offset += 1; continue; }
    const marker = buf[offset + 1];
    // SOF0..SOF15, excluding DHT(c4), JPG(c8) and DAC(cc)
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7), animated: false };
    }
    offset += 2 + buf.readUInt16BE(offset + 2);
  }
  return null;
}

function probeGif(buf) {
  // Two Graphic Control Extensions means more than one frame.
  let frames = 0;
  for (let i = 0; i < buf.length - 3 && frames < 2; i += 1) {
    if (buf[i] === 0x21 && buf[i + 1] === 0xf9 && buf[i + 2] === 0x04) frames += 1;
  }
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), animated: frames > 1 };
}

function probeWebp(buf) {
  const format = ascii(buf, 12, 4);
  if (format === 'VP8 ') {
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, animated: false };
  }
  if (format === 'VP8L') {
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, animated: false };
  }
  if (format === 'VP8X') {
    const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    return { width, height, animated: Boolean(buf[20] & 0b00000010) };
  }
  return null;
}

function probeSvg(buf) {
  const head = buf.slice(0, 2048).toString('utf8');
  const w = head.match(/\bwidth\s*=\s*["']([\d.]+)/i);
  const h = head.match(/\bheight\s*=\s*["']([\d.]+)/i);
  if (w && h) return { width: Math.round(+w[1]), height: Math.round(+h[1]), animated: false };
  const vb = head.match(/viewBox\s*=\s*["']\s*[\d.-]+\s+[\d.-]+\s+([\d.]+)\s+([\d.]+)/i);
  if (vb) return { width: Math.round(+vb[1]), height: Math.round(+vb[2]), animated: false };
  return null;
}

/** Broad bucket used for UI rendering decisions. */
export function getFileType(mime) {
  if (!mime) return 'file';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'document';
  if (mime.startsWith('text/') || mime === 'application/json') return 'text';
  return 'file';
}
