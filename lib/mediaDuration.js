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

// --- video dimensions without a decoder --------------------------------------

/**
 * Display dimensions of a video straight from the container, so the client can
 * reserve the player's footprint even when ffprobe is not installed.
 * MP4/MOV: the video track's `tkhd` (16.16 fixed point, rotation in the
 * matrix). WebM/MKV: PixelWidth / PixelHeight (or DisplayWidth/Height).
 * @returns {{width: number, height: number}|null}
 */
export function probeVideoDimensions(buffer, mime = '') {
  if (!Buffer.isBuffer(buffer) || buffer.length < 16) return null;
  try {
    if (ascii(buffer, 4, 4) === 'ftyp' || mime.includes('mp4') || mime.includes('quicktime')) {
      return probeMp4Dimensions(buffer);
    }
    if (buffer.readUInt32BE(0) === 0x1a45dfa3) return probeMatroskaDimensions(buffer);
  } catch { /* truncated — not fatal */ }
  return null;
}

function probeMp4Dimensions(buffer) {
  // tkhd can sit anywhere inside moov; scanning for the fourcc is simpler than
  // walking every trak and is bounded to one pass.
  let at = buffer.indexOf('tkhd', 0, 'latin1');
  while (at !== -1) {
    const start = at + 4;                         // version/flags
    const version = buffer[start];
    // v0: 4+4+4+4+4 (ctime,mtime,id,reserved,duration); v1 doubles times+duration.
    const afterHeader = start + 4 + (version === 1 ? 32 : 20);
    const matrixAt = afterHeader + 8 + 2 + 2 + 2 + 2; // reserved(8) layer alt vol reserved
    const dimsAt = matrixAt + 36;
    if (dimsAt + 8 > buffer.length) return null;
    const width = buffer.readUInt32BE(dimsAt) / 65536;
    const height = buffer.readUInt32BE(dimsAt + 4) / 65536;
    if (width > 0 && height > 0) {
      // Matrix a,b: a 90/270° rotation has a=0.
      const a = buffer.readInt32BE(matrixAt);
      const rotated = a === 0;
      return rotated
        ? { width: Math.round(height), height: Math.round(width) }
        : { width: Math.round(width), height: Math.round(height) };
    }
    at = buffer.indexOf('tkhd', at + 4, 'latin1');   // an audio track: keep looking
  }
  return null;
}

function probeMatroskaDimensions(buffer) {
  const limit = Math.min(buffer.length, 64 * 1024);
  const readUInt = (offset) => {
    const size = buffer[offset] & 0x80 ? { value: buffer[offset] & 0x7f, length: 1 } : null;
    if (!size || size.value > 4) return null;
    let value = 0;
    for (let i = 0; i < size.value; i += 1) value = value * 256 + buffer[offset + 1 + i];
    return value;
  };
  let width = null;
  let height = null;
  for (let i = 0; i < limit - 3; i += 1) {
    if (buffer[i] === 0xb0 && width === null) width = readUInt(i + 1);        // PixelWidth
    else if (buffer[i] === 0xba && height === null) height = readUInt(i + 1); // PixelHeight
    if (width && height) return { width, height };
  }
  return null;
}

// --- ffmpeg / ffprobe (optional) -----------------------------------------------
//
// System binaries, not ffmpeg-static: the static build is a ~70 MB download
// from GitHub at `npm install` time, which breaks offline/air-gapped installs
// and bloats every image whether or not video posters are wanted. Install the
// distro package (the Dockerfile has a WITH_FFMPEG build arg) or point
// FFMPEG_PATH / FFPROBE_PATH at a binary. MEDIA_FFMPEG=0 switches it off.

const ffmpegBin = () => process.env.FFMPEG_PATH || 'ffmpeg';
const ffprobeBin = () => process.env.FFPROBE_PATH || 'ffprobe';
const FFMPEG_TIMEOUT_MS = 15_000;

let availability = null;

/** Resolves to { ffmpeg: boolean, ffprobe: boolean }; probed once per process. */
export function ffmpegAvailability() {
  if (process.env.MEDIA_FFMPEG === '0') return Promise.resolve({ ffmpeg: false, ffprobe: false });
  if (!availability) {
    availability = (async () => {
      const { spawn } = await import('child_process');
      const check = (bin) => new Promise((resolve) => {
        const probe = spawn(bin, ['-version'], { stdio: 'ignore' });
        probe.on('error', () => resolve(false));
        probe.on('exit', (code) => resolve(code === 0));
      });
      const [ffmpeg, ffprobe] = await Promise.all([check(ffmpegBin()), check(ffprobeBin())]);
      return { ffmpeg, ffprobe };
    })();
  }
  return availability;
}

/** Only these demuxers are ever used, so a crafted file cannot select HLS/concat. */
const DEMUXERS = {
  'video/mp4': 'mov', 'video/quicktime': 'mov', 'video/webm': 'matroska',
  'video/x-matroska': 'matroska', 'video/ogg': 'ogg'
};

/** ffmpeg input arguments hardened against untrusted files. */
function inputArgs(absolutePath, mime) {
  const demuxer = DEMUXERS[mime];
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    // Local file only: no network or subprocess protocols from inside a container.
    '-protocol_whitelist', 'file',
    ...(demuxer ? ['-f', demuxer] : []),
    '-i', absolutePath
  ];
}

function run(bin, args, { timeoutMs = FFMPEG_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    import('child_process').then(({ spawn }) => {
      let settled = false;
      const done = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
      const chunks = [];
      const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'ignore'] });
      child.stdout.on('data', (chunk) => chunks.push(chunk));
      child.on('error', () => done(null));
      child.on('exit', (code) => done(code === 0 ? Buffer.concat(chunks) : null));
      // Never let a malformed file hang a job.
      const timer = setTimeout(() => { child.kill('SIGKILL'); done(null); }, timeoutMs);
    }, () => resolve(null));
  });
}

/**
 * Duration, display dimensions and codec via ffprobe.
 * @returns {Promise<{width:number|null,height:number|null,duration:number|null,codec:string|null}|null>}
 */
export async function probeVideo(absolutePath, mime = '') {
  if (!(await ffmpegAvailability()).ffprobe) return null;
  const out = await run(ffprobeBin(), [
    ...inputArgs(absolutePath, mime).filter((a) => a !== '-nostdin'),
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height,codec_name:stream_tags=rotate:stream_side_data=rotation:format=duration',
    '-of', 'json'
  ]);
  if (!out) return null;
  try {
    const json = JSON.parse(out.toString('utf8'));
    const stream = json.streams?.[0] ?? {};
    const rotation = Math.abs(Number(
      stream.side_data_list?.find((s) => s.rotation !== undefined)?.rotation ?? stream.tags?.rotate ?? 0
    )) % 180;
    let width = Number(stream.width) || null;
    let height = Number(stream.height) || null;
    if (rotation === 90 && width && height) [width, height] = [height, width];
    const duration = Number(json.format?.duration);
    return {
      width, height,
      duration: Number.isFinite(duration) && duration > 0 ? Math.round(duration * 1000) / 1000 : null,
      codec: stream.codec_name ?? null
    };
  } catch {
    return null;
  }
}

/**
 * Extract a poster frame as PNG. This is the one thing that truly needs a
 * decoder, so it shells out to ffmpeg when available and returns null
 * otherwise — the same optional-dependency posture as sharp for thumbnails.
 * One second in (frame 0 is often black), falling back to the first frame for
 * clips shorter than that. ffmpeg applies the rotation side data itself.
 */
export async function extractPoster(absolutePath, { mime = '', duration = null } = {}) {
  if (!(await ffmpegAvailability()).ffmpeg) return null;
  const grab = (seconds) => run(ffmpegBin(), [
    ...(seconds > 0 ? ['-ss', String(seconds)] : []),
    ...inputArgs(absolutePath, mime),
    '-an', '-sn', '-threads', '1',
    '-frames:v', '1',
    '-f', 'image2pipe', '-vcodec', 'png',
    'pipe:1'
  ]);
  const at = duration && duration < 2 ? 0 : 1;
  let png = await grab(at);
  if ((!png || !png.length) && at > 0) png = await grab(0);
  return png && png.length ? png : null;
}
