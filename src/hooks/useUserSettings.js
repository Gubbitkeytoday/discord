import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { get, patch, del } from '../api';
import { setSoundVolumeSource, setSoundPackSource } from '../utils/soundEffects';
import { applyThemeLayer, writeBootCache } from '../theme/engine.js';
import { SOUND_PACKS } from '../theme/soundPacks.js';
import { BASE_THEMES, SYSTEM_LIGHT_CHOICES, SYSTEM_DARK_CHOICES } from '../theme/palettes.js';
import { configureSeasonWindows } from '../theme/seasonal.js';
import { localeTag, useLocaleCode } from '../i18n/index.jsx';

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
    // "Sync with computer" follows the OS light/dark switch; these say WHICH
    // light and which dark theme it switches between (Discord: Ash/Dark/Onyx).
    systemDarkTheme: 'dark',
    systemLightTheme: 'light',
    uiDensity: 'default',
    // Corner shape: sharp | default | round (radius tokens in index.css).
    radius: 'default',
    messageDisplay: 'cozy',
    zoom: 100,
    // Percent of 16 px; the settings show it as 12–24 px (Discord's range).
    chatFontScale: 100,
    messageGroupSpacing: 16,
    // Readable type (WCAG 1.4.12): UI font, chat line height, and letter /
    // word spacing in em. Fonts other than Inter download only when chosen.
    uiFont: 'inter',
    chatLineHeight: 1.375,
    letterSpacing: 0,
    wordSpacing: 0,
    // Gradient theme: 'none', a preset id (theme/presets.js) or
    // 'custom:<id>' for one of `customThemes` (theme/schema.js).
    gradient: 'none',
    customThemes: [],
    // Seasonal accent + decoration while a season is on ('auto') or never.
    seasonal: 'auto',
    // Notification sound pack (theme/soundPacks.js).
    soundPack: 'classic',
    showSendButton: true,
    // Role icons beside names in chat and the member list.
    showRoleIcons: true,
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
    forceColors: false,
    // Follow the OS "reduce motion" setting; off = the toggle above decides.
    syncReducedMotion: true,
    // WCAG 1.4.1: links are told apart from text by more than colour.
    underlineLinks: true,
    // Off = role colours keep their hue when Saturation is turned down.
    saturateCustomColors: true,
    // Every control at least 44×44 px.
    largeTargets: false,
    // The message action bar is always visible instead of on hover.
    alwaysShowMessageActions: false
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
    // 'auto' follows the language's convention (13:30 in de/ja/th, 1:30 PM
    // in en-US, 下午1:30 in zh-TW); '12h' / '24h' are explicit choices.
    // `use24HourClock` is derived from it (see withDerived) and kept for the
    // components that read it.
    clockFormat: 'auto',
    use24HourClock: true,
    convertEmoticons: true,
    showTypingIndicator: true,
    // Tap to React: double-clicking a message applies this emoji. Set it to
    // null to turn the gesture off entirely — some people double-click to
    // select text and would rather not leave a heart behind every time.
    tapToReactEmoji: '❤️',
    // Language the Translate button translates into; '' follows the app
    // language (see src/translation/translationClient.js).
    translateTarget: '',
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
    navigateUnreadUp: 'Alt+Shift+ArrowUp',
    navigateUnreadDown: 'Alt+Shift+ArrowDown',
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
    jumpToHome: 'Ctrl+Shift+Home',
    openShortcuts: 'Ctrl+Slash'
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
// The last value per category the server has confirmed. A failed save rolls
// the category back to this, so the UI never shows a setting as saved when
// it is not.
let confirmed = structuredClone(current);
const listeners = new Set();
const errorListeners = new Set();
const pending = new Map();     // category -> timer
const inFlight = new Map();    // category -> request sequence number
let sequence = 0;

/** Subscribe to failed saves: `fn({ category, error })`. Returns an unsubscribe. */
export function onPreferenceSaveError(fn) {
  errorListeners.add(fn);
  return () => errorListeners.delete(fn);
}

/** Current preferences, with derived values (the 12/24-hour clock) resolved. */
export function getPreferences() {
  return withDerived(current);
}

/** Does this locale write times on a 24-hour clock? (en-US no; de, ja, th yes.) */
export function localeUses24Hour(locale = localeTag()) {
  try {
    const cycle = new Intl.DateTimeFormat(locale, { hour: 'numeric' }).resolvedOptions().hourCycle;
    return cycle === 'h23' || cycle === 'h24';
  } catch {
    return true;
  }
}

/**
 * 24-hour clock or not, from the chat preferences. Before `clockFormat`
 * existed the only stored value was `use24HourClock`, whose default was true;
 * a stored `false` was therefore an explicit choice and is honoured.
 */
export function resolveUse24Hour(chat, locale = localeTag()) {
  const format = chat?.clockFormat;
  if (format === '24h') return true;
  if (format === '12h') return false;
  if (format === undefined && chat?.use24HourClock === false) return false;
  return localeUses24Hour(locale);
}

const derivedCache = new WeakMap();
function withDerived(prefs, locale = localeTag()) {
  const key = `${locale}`;
  const cached = derivedCache.get(prefs);
  if (cached && cached.key === key) return cached.value;
  const use24HourClock = resolveUse24Hour(prefs.chat, locale);
  const value = prefs.chat?.use24HourClock === use24HourClock
    ? prefs
    : { ...prefs, chat: { ...prefs.chat, use24HourClock } };
  derivedCache.set(prefs, { key, value });
  return value;
}

/** True when animations should be reduced right now (setting + OS). */
export function prefersReducedMotion(prefs = current) {
  const a11y = prefs.accessibility ?? {};
  if (a11y.syncReducedMotion !== false) {
    try { return Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches); } catch { return false; }
  }
  return Boolean(a11y.reducedMotion);
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
  // Appearance › "Sync across devices" off: this device's look stays local.
  if (!syncsAppearance(category, next)) return;
  // Debounced per category, so dragging a slider is one request, not fifty.
  clearTimeout(pending.get(category));
  pending.set(category, setTimeout(() => {
    pending.delete(category);
    const sent = current[category];
    const seq = ++sequence;
    inFlight.set(category, seq);
    patch(`/api/settings/preferences/${category}`, sent)
      .then((saved) => {
        confirmed = { ...confirmed, [category]: mergeCategory(PREFERENCE_DEFAULTS[category], saved ?? sent) };
      })
      .catch((error) => {
        // Only the newest request for a category may roll it back, and not
        // while a newer edit is still waiting to be sent.
        if (inFlight.get(category) !== seq || pending.has(category)) return;
        publish({ ...current, [category]: confirmed[category] });
        for (const fn of errorListeners) fn({ category, error });
      })
      .finally(() => { if (inFlight.get(category) === seq) inFlight.delete(category); });
  }, SAVE_DEBOUNCE_MS));
}

export async function resetPreferences(category) {
  const value = await del(`/api/settings/preferences/${category}`);
  const merged = mergeCategory(PREFERENCE_DEFAULTS[category], value);
  confirmed = { ...confirmed, [category]: merged };
  publish({ ...current, [category]: merged });
  return value;
}

function syncsAppearance(category, prefs = current) {
  return category !== 'appearance' || prefs.appearance?.syncAcrossDevices !== false;
}

/** Replace everything from a server payload (sign-in, or another device saved). */
export function hydratePreferences(payload) {
  if (!payload) return;
  const next = {};
  for (const [category, defaults] of Object.entries(PREFERENCE_DEFAULTS)) {
    next[category] = syncsAppearance(category)
      ? mergeCategory(defaults, payload[category])
      : current[category];
  }
  confirmed = structuredClone(next);
  publish(next);
}

export function applyCategoryFromServer(category, value) {
  if (!PREFERENCE_DEFAULTS[category] || !syncsAppearance(category)) return;
  const merged = mergeCategory(PREFERENCE_DEFAULTS[category], value);
  confirmed = { ...confirmed, [category]: merged };
  publish({ ...current, [category]: merged });
}

// --- applying to the document ------------------------------------------------

let mediaQuery = null;

const THEMES = BASE_THEMES;

/** The concrete theme to paint: "system" becomes the chosen light or dark one. */
export function resolveTheme(appearance = current.appearance) {
  const theme = appearance?.theme ?? 'dark';
  if (theme !== 'system') return THEMES.includes(theme) ? theme : 'dark';
  let light = false;
  try { light = Boolean(window.matchMedia?.('(prefers-color-scheme: light)').matches); } catch { /* no matchMedia */ }
  if (light) return SYSTEM_LIGHT_CHOICES.includes(appearance.systemLightTheme) ? appearance.systemLightTheme : 'light';
  return SYSTEM_DARK_CHOICES.includes(appearance.systemDarkTheme) ? appearance.systemDarkTheme : 'dark';
}
let motionQuery = null;
let resizeBound = false;

// Tailwind's breakpoints (index.css re-declares the variants to read these).
const BREAKPOINTS = [['sm', 640], ['md', 768], ['lg', 1024], ['xl', 1280], ['2xl', 1536]];

/**
 * App zoom scales rem but not the media queries, so tell the CSS which
 * breakpoints the *effective* width (window ÷ zoom) is under. 200% zoom on a
 * 1366px window then gets the 683px layout: drawers instead of columns.
 */
function applyEffectiveWidth(root = document.documentElement, zoomPercent = current.appearance?.zoom ?? 100) {
  const zoom = Math.max(0.5, (zoomPercent || 100) / 100);
  const width = (window.innerWidth || 0) / zoom;
  const below = BREAKPOINTS.filter(([, px]) => width < px).map(([name]) => name).join(' ');
  if (root.dataset.below !== below) root.dataset.below = below;
  root.style.setProperty('--app-effective-width', `${Math.round(width)}px`);
}

/**
 * Push every visual preference onto <html>. CSS in index.css does the rest, so
 * a settings change costs one style recalculation instead of a React re-render.
 */
export function applyPreferences(prefs = current) {
  const root = document.documentElement;
  const { appearance, accessibility, streamerMode, chat } = prefs;

  // A gradient theme brings its own light or dark base (theme/engine.js).
  const resolvedTheme = applyThemeLayer(root, prefs, resolveTheme(appearance));

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
  root.dataset.reducedMotion = String(prefersReducedMotion(prefs));
  root.dataset.underlineLinks = String(accessibility.underlineLinks !== false);
  root.dataset.saturateCustom = String(accessibility.saturateCustomColors !== false);
  root.dataset.largeTargets = String(Boolean(accessibility.largeTargets));
  root.dataset.messageActions = accessibility.alwaysShowMessageActions ? 'always' : 'hover';
  root.dataset.roleColors = accessibility.roleColors;
  root.dataset.animateEmoji = String(Boolean(accessibility.playAnimatedEmoji));
  root.dataset.streamerMode = String(Boolean(streamerMode.enabled));
  root.dataset.developerMode = String(Boolean(chat.developerMode));

  root.style.setProperty('--app-zoom', String((appearance.zoom ?? 100) / 100));
  const saturation = (accessibility.saturation ?? 100) / 100;
  // Accent tokens multiply their OKLCH chroma by --sat (index.css); images
  // and avatars are untouched, unlike the old whole-page CSS filter.
  root.style.setProperty('--sat', String(Math.min(1, Math.max(0, saturation))));
  applyEffectiveWidth(root, appearance.zoom);
  if (!resizeBound && typeof window !== 'undefined') {
    resizeBound = true;
    window.addEventListener('resize', () => applyEffectiveWidth(), { passive: true });
  }
  if (!motionQuery && typeof window !== 'undefined') {
    try {
      motionQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
      motionQuery?.addEventListener?.('change', () => applyPreferences());
    } catch { /* matchMedia unavailable */ }
  }
  root.style.setProperty('--message-group-gap', `${appearance.messageGroupSpacing ?? 16}px`);
  root.style.colorScheme = resolvedTheme === 'light' ? 'light' : 'dark';

  // Follow the OS while the user is on "sync with computer".
  if (appearance.theme === 'system' && !mediaQuery) {
    mediaQuery = window.matchMedia?.('(prefers-color-scheme: light)');
    mediaQuery?.addEventListener('change', () => applyPreferences());
  }

  // Remember the painted look for index.html's pre-paint script.
  writeBootCache(root);
}

/** Re-apply the current preferences (after a transient theme preview changes). */
export function refreshAppearance() {
  applyPreferences(current);
}

/** Apply the cached preferences before React mounts, so there is no flash. */
export function initPreferences() {
  applyPreferences(current);
  // Interface sounds follow the output-volume slider.
  setSoundVolumeSource(() => (getPreferences().voice.outputVolume ?? 100) / 100);
  // …and play from the chosen pack (Appearance › Notification sounds).
  setSoundPackSource(() => {
    const pack = current.appearance?.soundPack;
    return SOUND_PACKS.includes(pack) ? pack : 'classic';
  });
  // The instance admin's seasonal windows (public endpoint, no sign-in).
  loadSeasonWindows();
  // A season can start or end while the app stays open: re-check hourly.
  if (typeof window !== 'undefined') setInterval(() => applyPreferences(current), 60 * 60 * 1000);
}

export function useUserSettings() {
  const [raw, setPrefs] = useState(current);
  // The derived clock follows the app language, so re-derive on a switch.
  const locale = useLocaleCode();
  const prefs = useMemo(() => withDerived(raw, localeTag()), [raw, locale]);

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

/** Subscribe to preference changes outside React (or for useSyncExternalStore). */
export function subscribePreferences(fn) {
  const listener = () => fn();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/**
 * One value out of the preferences, for components that render many times
 * over (message rows, member rows): no state, no effect, no derived copy —
 * the component re-renders only when the selected value changes. `select`
 * must return a primitive (or a stable reference).
 *
 *   const showIcons = usePreference((p) => p.appearance?.showRoleIcons !== false);
 */
export function usePreference(select) {
  return useSyncExternalStore(subscribePreferences, () => select(current), () => select(current));
}

/** Load the account's saved preferences. Called once the user is known. */
export async function loadPreferences() {
  try {
    hydratePreferences(await get('/api/settings/preferences'));
  } catch {
    // Not signed in yet, or offline — the cached values stay in force.
  }
}

/**
 * The instance admin's seasonal theme windows (public, no sign-in needed).
 * Until the server exposes GET /api/instance/seasonal the built-in defaults
 * stay in force (see the round-4 themes patch for the endpoint).
 */
export async function loadSeasonWindows() {
  try {
    const data = await get('/api/instance/seasonal');
    configureSeasonWindows(data?.windows ?? null);
    applyPreferences(current);
  } catch {
    // Older server or offline: default windows.
  }
}
