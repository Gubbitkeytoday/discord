// ============================================================================
//  Call sounds (join, leave, mute, unmute) behind the user's settings.
//
//  Voice & Video › "Join and leave sounds" and "Mute and unmute sounds" decide
//  whether each plays, and Streamer mode › "Disable sounds" silences all of
//  them — a stream should not beep every time someone hops in.
// ============================================================================

import { getPreferences } from '../hooks/useUserSettings';
import {
  playJoinVoiceSound, playLeaveVoiceSound, playMuteSound, playUnmuteSound
} from '../utils/soundEffects';

const PLAYERS = {
  join: playJoinVoiceSound,
  leave: playLeaveVoiceSound,
  mute: playMuteSound,
  unmute: playUnmuteSound
};

/** Whether a call sound of this kind should play right now. */
export function callSoundAllowed(kind, prefs = getPreferences()) {
  const streamer = prefs?.streamerMode;
  if (streamer?.enabled && streamer?.disableSounds) return false;
  const voice = prefs?.voice ?? {};
  if (kind === 'join' || kind === 'leave') return voice.voiceJoinSound !== false;
  if (kind === 'mute' || kind === 'unmute') return voice.muteSounds !== false;
  return true;
}

export function playCallSound(kind) {
  if (!callSoundAllowed(kind)) return;
  try { PLAYERS[kind]?.(); } catch { /* no audio output: silence is fine */ }
}
