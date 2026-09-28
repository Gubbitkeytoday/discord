// ============================================================================
//  Notification sound packs — three original, synthesised packs (CC0; we made
//  every note here). One definition drives both:
//    - the WAV files in public/sounds/<pack>/<event>.wav, written by
//      `node src/theme/build-sounds.mjs` (deterministic: the test suite
//      re-renders and compares bytes), and
//    - the in-browser fallback, which renders the same samples into an
//      AudioBuffer if a file cannot be fetched (offline, blocked).
//  'classic' is the app's built-in oscillator set in utils/soundEffects.js.
// ============================================================================

export const SOUND_PACKS = ['classic', 'soft', 'retro', 'glass'];
export const PACK_EVENTS = ['message', 'mention', 'voiceJoin', 'voiceLeave', 'mute', 'unmute'];
export const SAMPLE_RATE = 22050;

// A note: frequency (Hz), start (s), duration (s), waveform, peak gain,
// optional glide target, attack (s) and extra partials [ratio, gain].
const n = (f, t, d, opts = {}) => ({ f, t, d, type: 'sine', gain: 0.3, attack: 0.004, ...opts });

// "Soft": warm marimba-like mallets — sine plus a quiet fourth harmonic.
const mallet = { partials: [[4, 0.12]], gain: 0.32 };
// "Retro": square-wave chip blips, short and dry.
const chip = { type: 'square', gain: 0.09, attack: 0.001 };
// "Glass": bell tones — an inharmonic partial and a long ring.
const bell = { partials: [[2.76, 0.28], [5.4, 0.08]], gain: 0.26, attack: 0.002 };

export const PACK_NOTES = {
  soft: {
    message: [n(659.3, 0, 0.22, mallet), n(987.8, 0.07, 0.28, mallet)],
    mention: [n(784, 0, 0.2, mallet), n(987.8, 0.08, 0.2, mallet), n(1174.7, 0.16, 0.34, mallet)],
    voiceJoin: [n(523.3, 0, 0.18, mallet), n(659.3, 0.08, 0.18, mallet), n(784, 0.16, 0.3, mallet)],
    voiceLeave: [n(784, 0, 0.18, mallet), n(659.3, 0.08, 0.18, mallet), n(523.3, 0.16, 0.3, mallet)],
    mute: [n(440, 0, 0.12, { ...mallet, glide: 349.2 })],
    unmute: [n(349.2, 0, 0.12, { ...mallet, glide: 440 })]
  },
  retro: {
    message: [n(987.8, 0, 0.05, chip), n(1318.5, 0.055, 0.08, chip)],
    mention: [n(1318.5, 0, 0.05, chip), n(1568, 0.055, 0.05, chip), n(2093, 0.11, 0.1, chip)],
    voiceJoin: [n(523.3, 0, 0.06, chip), n(784, 0.065, 0.06, chip), n(1046.5, 0.13, 0.1, chip)],
    voiceLeave: [n(1046.5, 0, 0.06, chip), n(784, 0.065, 0.06, chip), n(523.3, 0.13, 0.1, chip)],
    mute: [n(330, 0, 0.07, { ...chip, glide: 220 })],
    unmute: [n(220, 0, 0.07, { ...chip, glide: 330 })]
  },
  glass: {
    message: [n(1318.5, 0, 0.42, bell)],
    mention: [n(1568, 0, 0.3, bell), n(2093, 0.1, 0.45, bell)],
    voiceJoin: [n(880, 0, 0.3, bell), n(1318.5, 0.1, 0.42, bell)],
    voiceLeave: [n(1318.5, 0, 0.3, bell), n(880, 0.1, 0.42, bell)],
    mute: [n(587.3, 0, 0.16, { ...bell, gain: 0.2 })],
    unmute: [n(880, 0, 0.16, { ...bell, gain: 0.2 })]
  }
};

const TAU = Math.PI * 2;
const wave = (type, phase) => {
  const p = phase / TAU - Math.floor(phase / TAU);
  if (type === 'square') return p < 0.5 ? 1 : -1;
  if (type === 'triangle') return 1 - 4 * Math.abs(p - 0.5);
  return Math.sin(phase);
};

/** Render one event of one pack to mono float samples (−1…1). */
export function renderEvent(pack, event, sampleRate = SAMPLE_RATE) {
  const notes = PACK_NOTES[pack]?.[event];
  if (!notes) return null;
  const length = Math.ceil(Math.max(...notes.map((x) => x.t + x.d)) * sampleRate) + 32;
  const out = new Float32Array(length);
  for (const note of notes) {
    const start = Math.round(note.t * sampleRate);
    const count = Math.round(note.d * sampleRate);
    const partials = [[1, 1], ...(note.partials ?? [])];
    const phases = partials.map(() => 0);
    for (let i = 0; i < count; i += 1) {
      const time = i / sampleRate;
      const progress = i / count;
      const freq = note.glide ? note.f * (note.glide / note.f) ** progress : note.f;
      // Linear attack, then an exponential fall to silence at the note's end.
      const env = time < note.attack ? time / note.attack : Math.exp(-5.5 * (time - note.attack) / note.d);
      const fade = i > count - 64 ? (count - i) / 64 : 1;
      let sample = 0;
      for (let k = 0; k < partials.length; k += 1) {
        const [ratio, g] = partials[k];
        phases[k] += (TAU * freq * ratio) / sampleRate;
        // Higher partials die away faster, as on a real bar or bell.
        sample += wave(note.type, phases[k]) * g * (k === 0 ? 1 : Math.exp(-8 * time));
      }
      out[start + i] += sample * note.gain * env * fade;
    }
  }
  for (let i = 0; i < out.length; i += 1) out[i] = Math.max(-1, Math.min(1, out[i]));
  return out;
}

/** 16-bit PCM mono WAV bytes for rendered samples. */
export function encodeWav(samples, sampleRate = SAMPLE_RATE) {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (offset, text) => { for (let i = 0; i < text.length; i += 1) bytes[offset + i] = text.charCodeAt(i); };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);          // PCM
  view.setUint16(22, 1, true);          // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    view.setInt16(44 + i * 2, Math.round(samples[i] * 32767), true);
  }
  return bytes;
}

/** Public URL of a pack's file. */
export const soundUrl = (pack, event) => `/sounds/${pack}/${event}.wav`;
