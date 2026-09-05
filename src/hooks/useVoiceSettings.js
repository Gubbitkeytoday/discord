import { useCallback, useEffect, useState } from 'react';
import {
  getPreferences, updatePreferences, useUserSettings, PREFERENCE_DEFAULTS
} from './useUserSettings';

/**
 * Voice settings are split by where they belong.
 *
 * Which microphone, speaker and camera you use is a property of the machine you
 * are sitting at, so those ids stay in localStorage — syncing them would point
 * your laptop at a headset plugged into your desktop. Everything else (input
 * mode, sensitivity, attenuation, video quality) follows the account, so a new
 * device behaves the way you configured it.
 */

const DEVICE_KEY = 'antigravity.voiceDevices';

const DEVICE_DEFAULTS = {
  inputDeviceId: 'default',
  outputDeviceId: 'default',
  videoDeviceId: 'default'
};

export const VOICE_DEFAULTS = { ...DEVICE_DEFAULTS, ...PREFERENCE_DEFAULTS.voice };

function readDevices() {
  try {
    return { ...DEVICE_DEFAULTS, ...JSON.parse(localStorage.getItem(DEVICE_KEY) ?? '{}') };
  } catch {
    return { ...DEVICE_DEFAULTS };
  }
}

let devices = readDevices();
const deviceListeners = new Set();

function writeDevices(next) {
  devices = next;
  try { localStorage.setItem(DEVICE_KEY, JSON.stringify(next)); } catch { /* private mode */ }
  for (const listener of deviceListeners) listener(next);
}

/** The merged view — devices plus the synced behavioural settings. */
export function getVoiceSettings() {
  return { ...devices, ...getPreferences().voice };
}

export function setVoiceSettings(patch) {
  const deviceKeys = Object.keys(DEVICE_DEFAULTS);
  const devicePatch = {};
  const syncedPatch = {};
  for (const [key, value] of Object.entries(patch)) {
    if (deviceKeys.includes(key)) devicePatch[key] = value;
    else syncedPatch[key] = value;
  }
  if (Object.keys(devicePatch).length) writeDevices({ ...devices, ...devicePatch });
  if (Object.keys(syncedPatch).length) {
    // Push-to-talk has two spellings for historical reasons; keep them in step.
    if (syncedPatch.pushToTalk !== undefined && syncedPatch.inputMode === undefined) {
      syncedPatch.inputMode = syncedPatch.pushToTalk ? 'ptt' : 'voice';
    }
    updatePreferences('voice', syncedPatch);
  }
}

export function useVoiceSettings() {
  const { prefs } = useUserSettings();
  const [deviceState, setDeviceState] = useState(devices);

  useEffect(() => {
    deviceListeners.add(setDeviceState);
    return () => { deviceListeners.delete(setDeviceState); };
  }, []);

  const settings = {
    ...deviceState,
    ...prefs.voice,
    // Kept for call sites that still ask the old question.
    pushToTalk: prefs.voice.inputMode === 'ptt'
  };

  const update = useCallback((patch) => setVoiceSettings(patch), []);
  const reset = useCallback(() => {
    writeDevices({ ...DEVICE_DEFAULTS });
    updatePreferences('voice', { ...PREFERENCE_DEFAULTS.voice });
  }, []);

  return { settings, update, reset };
}

/**
 * Enumerate microphones, speakers and cameras. Labels stay empty until the user
 * has granted permission once — a browser rule, not a bug.
 */
export async function listAudioDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return { inputs: [], outputs: [], cameras: [] };
  const all = await navigator.mediaDevices.enumerateDevices();
  return {
    inputs: all.filter((d) => d.kind === 'audioinput'),
    outputs: all.filter((d) => d.kind === 'audiooutput'),
    cameras: all.filter((d) => d.kind === 'videoinput')
  };
}
