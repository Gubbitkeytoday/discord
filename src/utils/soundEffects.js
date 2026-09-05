// Web Audio API synthesiser for Discord's interface sounds.
//
// Every sound is routed through one master gain node driven by the user's
// output-volume setting, so turning the app down turns the beeps down too
// rather than leaving them at full volume over a quiet call.

let audioCtx = null;
let masterGain = null;
let readVolume = () => 1;

/** Let the settings layer supply the current output volume (0-2). */
export function setSoundVolumeSource(fn) {
  readVolume = fn;
  if (masterGain) masterGain.gain.value = clampVolume(fn());
}

function clampVolume(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 1;
  return Math.min(2, Math.max(0, number));
}

const getAudioContext = () => {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    masterGain = audioCtx.createGain();
    masterGain.connect(audioCtx.destination);
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
  masterGain.gain.value = clampVolume(readVolume());
  return audioCtx;
};

/**
 * Where a sound should connect instead of ctx.destination, so the master
 * volume applies. Kept as a function so the existing call sites only change
 * one word.
 */
const destination = () => masterGain ?? audioCtx.destination;

// 1. Join Voice Channel Sound (Upward 2-tone melody)
export const playJoinVoiceSound = () => {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;

    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();

    osc1.type = 'sine';
    osc2.type = 'sine';

    osc1.frequency.setValueAtTime(440, now); // A4
    osc1.frequency.exponentialRampToValueAtTime(880, now + 0.15); // A5

    osc2.frequency.setValueAtTime(554.37, now + 0.1); // C#5
    osc2.frequency.exponentialRampToValueAtTime(1108.73, now + 0.25); // C#6

    gain.gain.setValueAtTime(0.15, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(destination());

    osc1.start(now);
    osc2.start(now + 0.1);

    osc1.stop(now + 0.35);
    osc2.stop(now + 0.35);
  } catch (err) {
    console.error('Sound effect playback failed:', err);
  }
};

// 2. Leave Voice Channel Sound (Downward 2-tone melody)
export const playLeaveVoiceSound = () => {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;

    const osc1 = ctx.createOscillator();
    const osc2 = ctx.createOscillator();
    const gain = ctx.createGain();

    osc1.type = 'sine';
    osc2.type = 'sine';

    osc1.frequency.setValueAtTime(880, now);
    osc1.frequency.exponentialRampToValueAtTime(440, now + 0.15);

    osc2.frequency.setValueAtTime(659.25, now + 0.08);
    osc2.frequency.exponentialRampToValueAtTime(329.63, now + 0.25);

    gain.gain.setValueAtTime(0.15, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);

    osc1.connect(gain);
    osc2.connect(gain);
    gain.connect(destination());

    osc1.start(now);
    osc2.start(now + 0.08);

    osc1.stop(now + 0.35);
    osc2.stop(now + 0.35);
  } catch (err) {
    console.error('Sound effect playback failed:', err);
  }
};

// 3. Mute Microphones Click Sound
export const playMuteSound = () => {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(600, now);
    osc.frequency.exponentialRampToValueAtTime(300, now + 0.08);

    gain.gain.setValueAtTime(0.1, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);

    osc.connect(gain);
    gain.connect(destination());

    osc.start(now);
    osc.stop(now + 0.08);
  } catch (err) {
    console.error('Sound effect playback failed:', err);
  }
};

// 4. Unmute Microphones Click Sound
export const playUnmuteSound = () => {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'triangle';
    osc.frequency.setValueAtTime(300, now);
    osc.frequency.exponentialRampToValueAtTime(600, now + 0.08);

    gain.gain.setValueAtTime(0.1, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);

    osc.connect(gain);
    gain.connect(destination());

    osc.start(now);
    osc.stop(now + 0.08);
  } catch (err) {
    console.error('Sound effect playback failed:', err);
  }
};

// 5. Message Incoming Sound
export const playMessageIncomingSound = () => {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(800, now);
    osc.frequency.exponentialRampToValueAtTime(1200, now + 0.1);

    gain.gain.setValueAtTime(0.1, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);

    osc.connect(gain);
    gain.connect(destination());

    osc.start(now);
    osc.stop(now + 0.15);
  } catch (err) {
    console.error('Sound effect playback failed:', err);
  }
};

// 6. Mention / notification chime — two quick notes, distinct from a plain
//    incoming message so a ping is recognisable without looking.
export const playMentionSound = () => {
  try {
    const ctx = getAudioContext();
    const now = ctx.currentTime;
    for (const [index, freq] of [880, 1320].entries()) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      const at = now + index * 0.12;
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, at);
      gain.gain.setValueAtTime(0.0001, at);
      gain.gain.exponentialRampToValueAtTime(0.12, at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.16);
      osc.connect(gain);
      gain.connect(destination());
      osc.start(at);
      osc.stop(at + 0.18);
    }
  } catch (err) {
    console.error('Sound effect playback failed:', err);
  }
};

// ---------------------------------------------------------------------------
// Soundboard
//
// A clip is a real audio file, unlike everything else in this module, so it is
// decoded once and cached. Two reasons it goes through the Web Audio graph
// rather than an <audio> element:
//
//   1. The soundboard has its own volume slider, and a GainNode can exceed 1.0
//      where `HTMLMediaElement.volume` cannot.
//   2. Overlapping plays need separate source nodes. One <audio> element can
//      only be at one position at a time, so a second play would cut the first.
// ---------------------------------------------------------------------------

const clipCache = new Map();   // url -> Promise<AudioBuffer>

async function loadClip(url) {
  if (!clipCache.has(url)) {
    clipCache.set(url, (async () => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Sound failed to load (HTTP ${response.status})`);
      return getAudioContext().decodeAudioData(await response.arrayBuffer());
    })().catch((err) => {
      // Do not cache a failure forever — a transient network blip should not
      // permanently break a sound.
      clipCache.delete(url);
      throw err;
    }));
  }
  return clipCache.get(url);
}

/**
 * Play a soundboard clip.
 *
 * `volume` is the sound's own 0–200 setting from the server; `userVolume` is
 * the listener's soundboard slider. They multiply, so a loud clip stays loud
 * relative to a quiet one while the listener keeps final say.
 */
export async function playSoundboardClip(url, { volume = 100, userVolume = 100 } = {}) {
  const ctx = getAudioContext();
  const buffer = await loadClip(url);

  const source = ctx.createBufferSource();
  source.buffer = buffer;

  const gain = ctx.createGain();
  gain.gain.value = clampVolume((volume / 100) * (userVolume / 100));

  source.connect(gain).connect(destination());
  source.start();

  // Let the graph collect itself; a long session would otherwise accumulate
  // one dead node per play.
  source.onended = () => { try { source.disconnect(); gain.disconnect(); } catch { /* already gone */ } };
  return source;
}

/** Drop decoded audio — called when a sound is deleted or replaced. */
export function forgetSoundboardClip(url) {
  clipCache.delete(url);
}
