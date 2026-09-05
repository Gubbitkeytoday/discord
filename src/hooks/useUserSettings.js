import { useCallback, useEffect, useState } from 'react';
import { get, patch, del } from '../api';
import { setSoundVolumeSource } from '../utils/soundEffects';

/**
 * Account-wide client preferences.
 *
 * Three jobs, in this order of priority:
 *   1. Paint correctly on the very first frame — read the last known values
 *      out of localStorage before React mounts, so there is no flash of the
 *      wrong theme or font size while the network call is in flight.
 *   2. Follow the account — hydrate from the server on sign-in, and write
 *      changes back so another device sees them.
 *   3. Apply to the document — everything visual is a CSS variable or a data
 *      attribute on <html>, so changing a setting never re-renders the tree.
 */

const STORAGE_KEY = 'antigravity.preferences';
const SAVE_DEBOUNCE_MS = 400;

export const PREFERENCE_DEFAULTS = {
  appearance: {
    theme: 'dark',
    uiDensity: 'default',
    messageDisplay: 'cozy',
    zoom: 100,
    chatFontScale: 100,
    messageGroupSpacing: 16,
    showSendButton: true,
    syncAcrossDevices: true
  },
  accessibility: {
    saturation: 100,
    reducedMotion: false,
    highContrast: false,
    roleColors: 'names',
    playAnimatedEmoji: true,
    autoplayGifs: true,
    stickerAnimation: 'always',
    ttsRate: 1,
    ttsEnabled: false,
    forceColors: false
  },
  notifications: {
    desktopEnabled: true,
    unreadBadge: true,
    taskbarFlash: true,
    ttsMode: 'never',
    sounds: {
      message: true, mention: true, deafen: true, undeafen: true,
      mute: true, unmute: true, voiceJoin: true, voiceLeave: true, call: true
    },
    muteWhileStreaming: true
  },
  chat: {
    showLinkPreviews: true,
    showImagePreviews: true,
    showEmbeds: true,
    inlineAttachmentMedia: true,
    renderSpoilers: 'click',
    showTimestamps: true,
    use24HourClock: true,
    convertEmoticons: true,
    showTypingIndicator: true,
    // Tap to React: double-clicking a message applies this emoji. Set it to
    // null to turn the gesture off entirely — some people double-click to
    // select text and would rather not leave a heart behind every time.
    tapToReactEmoji: '❤️',
    developerMode: false
  },
  privacy: {
    dmScanning: 'friends',
    allowDmsFrom: 'everyone',
    friendRequests: 'everyone',
    allowServerMemberDms: true,
    showCurrentActivity: true,
    allowAnalytics: false
  },
  activity: { shareActivity: true, customActivity: null },
  streamerMode: {
    enabled: false,
    autoEnable: false,
    hidePersonalInformation: true,
    hideInviteLinks: true,
    disableSounds: true,
    disableNotifications: true
  },
  keybinds: {
    toggleMute: 'Ctrl+Shift+M',
    toggleDeafen: 'Ctrl+Shift+D',
    pushToTalk: 'Space',
    quickSwitcher: 'Ctrl+K',
    markServerRead: 'Shift+Escape',
    navigateChannelUp: 'Alt+ArrowUp',
    navigateChannelDown: 'Alt+ArrowDown',
    toggleStreamerMode: 'Ctrl+Shift+S',
    disconnectVoice: 'Ctrl+Shift+H',
    navigateServerUp: 'Ctrl+Alt+ArrowUp',
    navigateServerDown: 'Ctrl+Alt+ArrowDown',
    markChannelRead: 'Escape',
    toggleMemberList: 'Ctrl+U',
    togglePins: 'Ctrl+P',
    search: 'Ctrl+F',
    openSettings: 'Ctrl+Comma',
    toggleEmojiPicker: 'Ctrl+E',
    openEvents: 'Ctrl+Shift+E',
    toggleFormatting: 'Ctrl+Shift+F',
    jumpToHome: 'Ctrl+Shift+Home'
  },
  voice: {
    inputMode: 'voice',
    pushToTalkReleaseMs: 200,
    automaticSensitivity: true,
    sensitivity: 15,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    attenuation: 0,
    attenuateWhileSpeaking: true,
    inputVolume: 100,
    outputVolume: 100,
    soundboardVolume: 70,
    videoResolution: '1280x720',
    videoFrameRate: 30,
    mirrorCamera: true,
    blurCamera: false,
    blurStrength: 12,
    showSpeakingIndicator: true,
    silenceWarning: true,
    voiceJoinSound: true,
    spatialAudio: false
  },
  layout: {
    serverFolders: [],
    serverOrder: [],
    // Channels and conversations the user has pinned to the top of their list.
    // Per-account rather than per-server, because that is how the sidebar reads
    // them back: one lookup, whichever server is open.
    pinnedChannels: [],
    pinnedDms: []
  }
};

function mergeCategory(base, patchValue) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patchValue ?? {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)
        && base[key] && typeof base[key] === 'object') {
      out[key] = { ...base[key], ...value };
    } else {
      out[key] = value;
    }
  }
  return out;
}

function readCache() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
    const merged = {};
    for (const [category, defaults] of Object.entries(PREFERENCE_DEFAULTS)) {
      merged[category] = mergeCategory(defaults, stored[category]);
    }
    return merged;
  } catch {
    return structuredClone(PREFERENCE_DEFAULTS);
  }
}

function writeCache(value) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); } catch { /* private mode */ }
}

// Module-level store so non-React code (sound effects, the hotkey engine, the
// notification manager) can read the current values without prop drilling.
let current = readCache();
const listeners = new Set();
const pending = new Map();     // category -> timer

export function getPreferences() {
  return current;
}

function publish(next) {
  current = next;
  writeCache(next);
  applyPreferences(next);
  for (const listener of listeners) listener(next);
}

/** Merge a patch into one category, apply it, and save it to the account. */
export function updatePreferences(category, patchValue, { persist = true } = {}) {
  const next = { ...current, [category]: mergeCategory(current[category], patchValue) };
  publish(next);

  if (!persist) return;
  // Debounced per category, so dragging a slider is one request, not fifty.
  clearTimeout(pending.get(category));
  pending.set(category, setTimeout(() => {
    pending.delete(category);
    patch(`/api/settings/preferences/${category}`, current[category]).catch(() => {
      // Offline or signed out: the local value still applies for this session.
    });
  }, SAVE_DEBOUNCE_MS));
}

export async function resetPreferences(category) {
  const value = await del(`/api/settings/preferences/${category}`);
  publish({ ...current, [category]: mergeCategory(PREFERENCE_DEFAULTS[category], value) });
  return value;
}

/** Replace everything from a server payload (sign-in, or another device saved). */
export function hydratePreferences(payload) {
  if (!payload) return;
  const next = {};
  for (const [category, defaults] of Object.entries(PREFERENCE_DEFAULTS)) {
    next[category] = mergeCategory(defaults, payload[category]);
  }
  publish(next);
}

export function applyCategoryFromServer(category, value) {
  if (!PREFERENCE_DEFAULTS[category]) return;
  publish({ ...current, [category]: mergeCategory(PREFERENCE_DEFAULTS[category], value) });
}

// --- applying to the document ------------------------------------------------

let mediaQuery = null;

/**
 * Push every visual preference onto <html>. CSS in index.css does the rest, so
 * a settings change costs one style recalculation instead of a React re-render.
 */
export function applyPreferences(prefs = current) {
  const root = document.documentElement;
  const { appearance, accessibility, streamerMode, chat } = prefs;

  const resolvedTheme = appearance.theme === 'system'
    ? (window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark')
    : appearance.theme;

  // Suspend transitions across a theme swap: a full-page colour cross-fade
  // looks broken, and Chromium does not reliably repaint transitioned colours
  // when only the underlying custom property changed.
  if (root.dataset.theme && root.dataset.theme !== resolvedTheme) {
    root.classList.add('theme-switching');
    void root.offsetWidth;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => root.classList.remove('theme-switching'));
    });
  }

  root.dataset.theme = resolvedTheme;
  root.dataset.messageDisplay = appearance.messageDisplay;
  root.dataset.uiDensity = appearance.uiDensity;
  root.dataset.contrast = accessibility.highContrast ? 'high' : 'normal';
  root.dataset.saturation = String(accessibility.saturation);
  root.dataset.reducedMotion = String(Boolean(accessibility.reducedMotion));
  root.dataset.roleColors = accessibility.roleColors;
  root.dataset.animateEmoji = String(Boolean(accessibility.playAnimatedEmoji));
  root.dataset.streamerMode = String(Boolean(streamerMode.enabled));
  root.dataset.developerMode = String(Boolean(chat.developerMode));

  root.style.setProperty('--app-zoom', String((appearance.zoom ?? 100) / 100));
  root.style.setProperty('--app-saturation', String((accessibility.saturation ?? 100) / 100));
  root.style.setProperty('--message-font-size', `${Math.round(16 * ((appearance.chatFontScale ?? 100) / 100))}px`);
  root.style.setProperty('--message-group-gap', `${appearance.messageGroupSpacing ?? 16}px`);
  root.style.colorScheme = resolvedTheme === 'light' ? 'light' : 'dark';

  // Follow the OS while the user is on "sync with computer".
  if (appearance.theme === 'system' && !mediaQuery) {
    mediaQuery = window.matchMedia?.('(prefers-color-scheme: light)');
    mediaQuery?.addEventListener('change', () => applyPreferences());
  }
}

/** Apply the cached preferences before React mounts, so there is no flash. */
export function initPreferences() {
  applyPreferences(current);
  // Interface sounds follow the output-volume slider.
  setSoundVolumeSource(() => (getPreferences().voice.outputVolume ?? 100) / 100);
}

export function useUserSettings() {
  const [prefs, setPrefs] = useState(current);

  useEffect(() => {
    listeners.add(setPrefs);
    return () => { listeners.delete(setPrefs); };
  }, []);

  return {
    prefs,
    update: useCallback((category, patchValue) => updatePreferences(category, patchValue), []),
    reset: useCallback((category) => resetPreferences(category), [])
  };
}

/** Load the account's saved preferences. Called once the user is known. */
export async function loadPreferences() {
  try {
    hydratePreferences(await get('/api/settings/preferences'));
  } catch {
    // Not signed in yet, or offline — the cached values stay in force.
  }
}
