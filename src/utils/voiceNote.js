// ============================================================================
//  Voice notes: recording, and the waveform that represents one.
//
//  The waveform is computed on the client because the browser has already
//  decoded the audio to record it. Deriving it server-side would mean decoding
//  every upload again for what is, in the end, a 120px-wide bar chart.
//  The server clamps and caps whatever arrives, so a hostile client can make an
//  ugly waveform but not an expensive one.
// ============================================================================

/** How many bars the waveform has. Matches the server's cap. */
export const WAVEFORM_POINTS = 64;

/**
 * Pick a container the browser can actually record.
 *
 * `audio/webm;codecs=opus` is what Chrome and Firefox produce; Safari records
 * mp4/aac instead and rejects webm outright. Asking the browser rather than
 * assuming is the difference between working on Safari and silently failing.
 */
export function pickRecorderMime() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4;codecs=mp4a.40.2',
    'audio/mp4',
    'audio/ogg;codecs=opus'
  ];
  if (typeof MediaRecorder === 'undefined') return null;
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}

export const isVoiceNoteSupported = () =>
  typeof MediaRecorder !== 'undefined'
  && Boolean(navigator.mediaDevices?.getUserMedia)
  && Boolean(pickRecorderMime());

/**
 * Reduce decoded audio to `points` amplitudes in the 0–100 range.
 *
 * RMS rather than peak: a single click would make a peak-based bar chart all
 * spike and no shape, whereas RMS tracks perceived loudness, which is what the
 * picture is meant to convey.
 */
export function buildWaveform(audioBuffer, points = WAVEFORM_POINTS) {
  const channel = audioBuffer.getChannelData(0);
  const bucketSize = Math.max(1, Math.floor(channel.length / points));
  const buckets = [];

  for (let i = 0; i < points; i += 1) {
    const start = i * bucketSize;
    const end = Math.min(channel.length, start + bucketSize);
    let sum = 0;
    for (let j = start; j < end; j += 1) sum += channel[j] * channel[j];
    buckets.push(Math.sqrt(sum / Math.max(1, end - start)));
  }

  // Normalise against the loudest bucket so a quiet recording still shows shape
  // instead of a flat line. A silent clip has no peak, so guard the divide.
  const peak = Math.max(...buckets, 0.0001);
  return buckets.map((value) => Math.round(Math.min(100, (value / peak) * 100)));
}

/** Decode a recorded blob and summarise it. Returns nulls if it cannot. */
export async function analyseRecording(blob) {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    const ctx = new AudioCtx();
    const buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
    const result = { waveform: buildWaveform(buffer), durationSecs: buffer.duration };
    ctx.close().catch(() => {});
    return result;
  } catch {
    // A failed decode must not block sending — the note is still perfectly
    // playable, it just renders without a waveform.
    return { waveform: null, durationSecs: null };
  }
}

/**
 * Start recording. Returns a handle with `stop()` (resolving to the blob) and
 * `cancel()` (which throws the audio away and releases the microphone).
 */
export async function startVoiceNote({ deviceId = 'default' } = {}) {
  const mimeType = pickRecorderMime();
  if (!mimeType) throw new Error('This browser cannot record audio');

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      deviceId: deviceId !== 'default' ? { exact: deviceId } : undefined,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  });

  const recorder = new MediaRecorder(stream, { mimeType });
  const chunks = [];
  recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
  recorder.start();

  const release = () => stream.getTracks().forEach((track) => track.stop());

  return {
    mimeType,
    stream,               // exposed so the composer can drive a live meter
    cancel() {
      try { if (recorder.state !== 'inactive') recorder.stop(); } catch { /* already stopped */ }
      release();
    },
    stop() {
      return new Promise((resolve) => {
        recorder.onstop = () => {
          release();
          resolve(new Blob(chunks, { type: mimeType }));
        };
        if (recorder.state === 'inactive') recorder.onstop();
        else recorder.stop();
      });
    }
  };
}

/** "0:07" / "1:23" — the only format a voice note needs. */
export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}
