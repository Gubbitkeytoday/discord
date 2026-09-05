// ============================================================================
//  Read media duration straight from the container.
//
//  No ffmpeg: MP4/MOV keep it in the `mvhd` atom, WebM/MKV in the Segment Info
//  element, MP3 in the Xing/Info frame (or estimated from the bitrate), and Ogg
//  in the last page's granule position. That covers everything the uploader
//  accepts, with no external binary to install or shell out to.
//
//  A poster frame genuinely does need a decoder — see extractPoster().
// ============================================================================

const ascii = (buf, start, len) => buf.slice(start, start + len).toString('latin1');

/**
 * @returns {number|null} duration in seconds, or null if it cannot be read
 */
export function probeDuration(buffer, mime = '') {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return null;
  try {
    if (mime.includes('mp4') || mime.includes('quicktime') || ascii(buffer, 4, 4) === 'ftyp') {
      return probeMp4(buffer);
    }
    if (mime.includes('matroska') || mime.includes('webm') || buffer.readUInt32BE(0) === 0x1a45dfa3) {
      return probeMatroska(buffer);
    }
    if (mime.includes('mpeg') || mime.includes('mp3')) return probeMp3(buffer);
    if (mime.includes('ogg') || ascii(buffer, 0, 4) === 'OggS') return probeOgg(buffer);
    if (mime.includes('wav') && ascii(buffer, 0, 4) === 'RIFF') return probeWav(buffer);
    return null;
  } catch {
    // A truncated or unusual file is not an error worth failing an upload over.
    return null;
  }
}

/** Walk the atom tree to moov/mvhd, which holds timescale and duration. */
function probeMp4(buffer) {
  const findAtom = (start, end, name) => {
    let offset = start;
    while (offset + 8 <= end) {
      let size = buffer.readUInt32BE(offset);
      const type = ascii(buffer, offset + 4, 4);
      let headerSize = 8;
      if (size === 1) {
        // 64-bit size, stored after the type.
        size = Number(buffer.readBigUInt64BE(offset + 8));
        headerSize = 16;
      }
      if (size === 0) size = end - offset;              // extends to EOF
      if (size < headerSize) return null;               // malformed
      if (type === name) return { start: offset + headerSize, end: offset + size };
      offset += size;
    }
    return null;
  };

  const moov = findAtom(0, buffer.length, 'moov');
  if (!moov) return null;
  const mvhd = findAtom(moov.start, moov.end, 'mvhd');
  if (!mvhd) return null;

  const version = buffer[mvhd.start];
  const timescale = version === 1
    ? buffer.readUInt32BE(mvhd.start + 20)
    : buffer.readUInt32BE(mvhd.start + 12);
  const duration = version === 1
    ? Number(buffer.readBigUInt64BE(mvhd.start + 24))
    : buffer.readUInt32BE(mvhd.start + 16);

  if (!timescale || !duration) return null;
  return Math.round((duration / timescale) * 1000) / 1000;
}

/** EBML: find Segment > Info > Duration, scaled by TimecodeScale. */
function probeMatroska(buffer) {
  const readVint = (offset) => {
    const first = buffer[offset];
    if (first === undefined) return null;
    let length = 1;
    let mask = 0x80;
    while (length <= 8 && !(first & mask)) { mask >>= 1; length += 1; }
    if (length > 8) return null;
    let value = first & (mask - 1);
    for (let i = 1; i < length; i += 1) value = value * 256 + buffer[offset + i];
    return { value, length };
  };

  // The elements we need are near the start; scanning the whole file is
  // unnecessary and slow for a large upload.
  const limit = Math.min(buffer.length, 4096);
  let timecodeScale = 1_000_000;   // EBML default: nanoseconds
  let duration = null;

  for (let offset = 0; offset < limit - 4; offset += 1) {
    // TimecodeScale = 0x2AD7B1
    if (buffer[offset] === 0x2a && buffer[offset + 1] === 0xd7 && buffer[offset + 2] === 0xb1) {
      const size = readVint(offset + 3);
      if (size && size.value <= 8) {
        let value = 0;
        for (let i = 0; i < size.value; i += 1) value = value * 256 + buffer[offset + 3 + size.length + i];
        if (value > 0) timecodeScale = value;
      }
    }
    // Duration = 0x4489, a float
    if (buffer[offset] === 0x44 && buffer[offset + 1] === 0x89) {
      const size = readVint(offset + 2);
      const dataAt = offset + 2 + (size?.length ?? 0);
      if (size?.value === 4) duration = buffer.readFloatBE(dataAt);
      else if (size?.value === 8) duration = buffer.readDoubleBE(dataAt);
    }
  }

  if (!duration) return null;
  return Math.round((duration * timecodeScale / 1e9) * 1000) / 1000;
}

/** Xing/Info header if present, otherwise estimate from the first frame. */
function probeMp3(buffer) {
  const start = ascii(buffer, 0, 3) === 'ID3'
    // ID3v2 size is a syncsafe integer: 7 bits per byte.
    ? 10 + ((buffer[6] << 21) | (buffer[7] << 14) | (buffer[8] << 7) | buffer[9])
    : 0;

  const SAMPLE_RATES = [44100, 48000, 32000];
  const BITRATES = [
    0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0
  ];

  for (let offset = start; offset < Math.min(buffer.length - 4, start + 64 * 1024); offset += 1) {
    if (buffer[offset] !== 0xff || (buffer[offset + 1] & 0xe0) !== 0xe0) continue;

    const sampleRate = SAMPLE_RATES[(buffer[offset + 2] >> 2) & 3];
    const bitrate = BITRATES[(buffer[offset + 2] >> 4) & 15];
    if (!sampleRate || !bitrate) continue;

    // Xing ("Xing"/"Info") gives the exact frame count.
    const xingAt = buffer.indexOf('Xing', offset) >= 0
      ? buffer.indexOf('Xing', offset)
      : buffer.indexOf('Info', offset);
    if (xingAt > 0 && xingAt < offset + 200) {
      const flags = buffer.readUInt32BE(xingAt + 4);
      if (flags & 1) {
        const frames = buffer.readUInt32BE(xingAt + 8);
        return Math.round((frames * 1152 / sampleRate) * 1000) / 1000;
      }
    }

    // Constant-bitrate estimate. Approximate, and labelled as such.
    const bytes = buffer.length - start;
    return Math.round((bytes * 8 / (bitrate * 1000)) * 1000) / 1000;
  }
  return null;
}

/** Ogg stores a granule position per page; the last page holds the total. */
function probeOgg(buffer) {
  let lastGranule = null;
  let rate = null;

  for (let offset = 0; offset < buffer.length - 27; offset += 1) {
    if (ascii(buffer, offset, 4) !== 'OggS') continue;
    lastGranule = buffer.readBigUInt64LE(offset + 6);

    // Vorbis and Opus both publish their rate in the identification header.
    if (rate === null) {
      const header = ascii(buffer, offset + 28, 8);
      if (header.includes('vorbis')) rate = buffer.readUInt32LE(offset + 28 + 12);
      else if (header.startsWith('OpusHead')) rate = 48000;   // Opus granules are always 48 kHz
    }
  }

  if (lastGranule === null || !rate) return null;
  return Math.round((Number(lastGranule) / rate) * 1000) / 1000;
}

/** WAV: data chunk size over the byte rate. */
function probeWav(buffer) {
  let offset = 12;
  let byteRate = null;
  while (offset + 8 <= buffer.length) {
    const id = ascii(buffer, offset, 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === 'fmt ') byteRate = buffer.readUInt32LE(offset + 16);
    if (id === 'data' && byteRate) return Math.round((size / byteRate) * 1000) / 1000;
    offset += 8 + size + (size % 2);
  }
  return null;
}

/**
 * Extract a poster frame. This is the one thing that truly needs a decoder, so
 * it shells out to ffmpeg when available and returns null otherwise — the same
 * optional-dependency posture as sharp for thumbnails.
 */
export async function extractPoster(absolutePath) {
  const { spawn } = await import('child_process');

  const available = await new Promise((resolve) => {
    const probe = spawn('ffmpeg', ['-version'], { stdio: 'ignore' });
    probe.on('error', () => resolve(false));
    probe.on('exit', (code) => resolve(code === 0));
  });
  if (!available) return null;

  return new Promise((resolve) => {
    const chunks = [];
    const ffmpeg = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-ss', '00:00:01',          // one second in; frame 0 is often black
      '-i', absolutePath,
      '-frames:v', '1',
      '-f', 'image2pipe', '-vcodec', 'png',
      'pipe:1'
    ]);
    ffmpeg.stdout.on('data', (chunk) => chunks.push(chunk));
    ffmpeg.on('error', () => resolve(null));
    ffmpeg.on('exit', (code) => {
      const output = Buffer.concat(chunks);
      resolve(code === 0 && output.length > 0 ? output : null);
    });
    // Never let a malformed file hang an upload.
    setTimeout(() => { ffmpeg.kill('SIGKILL'); resolve(null); }, 10_000);
  });
}
