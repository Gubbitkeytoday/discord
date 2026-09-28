// Web Audio API synthesiser for Discord's interface sounds.
//
// Every sound is routed through one master gain node driven by the user's
// output-volume setting, so turning the app down turns the beeps down too
// rather than leaving them at full volume over a quiet call.

import { SOUND_PACKS, renderEvent, soundUrl, SAMPLE_RATE } from '../theme/soundPacks.js';

let audioCtx = null;
let masterGain = null;
let readVolume = () => 1;
let readPack = () => 'classic';

/** Let the settings layer supply the chosen sound pack (Appearance › Sounds). */
export function setSoundPackSource(fn) {
  readPack = fn;
}

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
const classic_playJoinVoiceSound = () => {
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
const classic_playLeaveVoiceSound = () => {
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
const classic_playMuteSound = () => {
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
const classic_playUnmuteSound = () => {
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
const classic_playMessageIncomingSound = () => {
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
const classic_playMentionSound = () => {
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

// ---------------------------------------------------------------------------
// Sound packs (src/theme/soundPacks.js)
//
// A pack other than 'classic' plays its WAV from public/sounds/. If the file
// cannot be fetched or decoded (offline before it was ever cached, a blocked
// request) the same notes are rendered in JS into an AudioBuffer, so a pack
// never goes silent.
// ---------------------------------------------------------------------------

const renderedCache = new Map(); // `${pack}/${event}` -> AudioBuffer

function renderedBuffer(pack, event) {
  const key = `${pack}/${event}`;
  if (!renderedCache.has(key)) {
    const samples = renderEvent(pack, event, SAMPLE_RATE);
    if (!samples) return null;
    const buffer = getAudioContext().createBuffer(1, samples.length, SAMPLE_RATE);
    buffer.copyToChannel(samples, 0);
    renderedCache.set(key, buffer);
  }
  return renderedCache.get(key);
}

function playBuffer(buffer) {
  const ctx = getAudioContext();
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(destination());
  source.start();
  source.onended = () => { try { source.disconnect(); } catch { /* gone */ } };
}

/**
 * Play `event` from `pack` (default: the user's choice). Returns false when
 * the pack is 'classic', so the caller plays the built-in oscillator sound.
 */
export function playPackSound(event, pack = readPack()) {
  if (!pack || pack === 'classic' || !SOUND_PACKS.includes(pack)) return false;
  try {
    getAudioContext();
  } catch {
    return true;
  }
  loadClip(soundUrl(pack, event))
    .then(playBuffer)
    .catch(() => {
      try {
        const buffer = renderedBuffer(pack, event);
        if (buffer) playBuffer(buffer);
      } catch (err) {
        console.error('Sound effect playback failed:', err);
      }
    });
  return true;
}

const packAware = (event, classic) => () => { if (!playPackSound(event)) classic(); };

export const playJoinVoiceSound = packAware('voiceJoin', classic_playJoinVoiceSound);
export const playLeaveVoiceSound = packAware('voiceLeave', classic_playLeaveVoiceSound);
export const playMuteSound = packAware('mute', classic_playMuteSound);
export const playUnmuteSound = packAware('unmute', classic_playUnmuteSound);
export const playMessageIncomingSound = packAware('message', classic_playMessageIncomingSound);
export const playMentionSound = packAware('mention', classic_playMentionSound);

const CLASSIC = {
  voiceJoin: classic_playJoinVoiceSound,
  voiceLeave: classic_playLeaveVoiceSound,
  mute: classic_playMuteSound,
  unmute: classic_playUnmuteSound,
  message: classic_playMessageIncomingSound,
  mention: classic_playMentionSound
};

/** Settings preview: play one event from a given pack, whatever is selected. */
export function previewSoundPack(pack, event = 'message') {
  if (playPackSound(event, pack)) return;
  CLASSIC[event]?.();
}
