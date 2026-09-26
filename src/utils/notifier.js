// ============================================================================
//  Desktop notifications and notification sounds.
//
//  One place decides whether a given event should make a sound, raise a system
//  notification, both, or neither — because the answer depends on five separate
//  settings (per-event sound toggles, desktop enable, streamer mode, DND, and
//  whether the channel or server is muted) and getting that logic scattered is
//  how an app ends up pinging someone who asked it not to.
// ============================================================================

import { getPreferences } from '../hooks/useUserSettings';
import {
  playMentionSound, playMessageIncomingSound, playJoinVoiceSound,
  playLeaveVoiceSound, playMuteSound, playUnmuteSound
} from './soundEffects';
import { speak } from './speech';
import { proxiedImageUrl } from './media';

const SOUND_PLAYERS = {
  message: playMessageIncomingSound,
  mention: playMentionSound,
  voiceJoin: playJoinVoiceSound,
  voiceLeave: playLeaveVoiceSound,
  mute: playMuteSound,
  unmute: playUnmuteSound,
  deafen: playMuteSound,
  undeafen: playUnmuteSound,
  call: playMentionSound
};

// --- screen share & attention ------------------------------------------------

let streaming = false;
/** App tells us when the user is sharing their screen. */
export function setScreenSharing(value) {
  streaming = Boolean(value);
}

/** "Mute notifications while streaming": nothing private pops up on a shared screen. */
function silencedByStream(prefs) {
  return streaming && prefs.notifications.muteWhileStreaming;
}

let flashTimer = null;
let flashBaseTitle = null;
/**
 * The web's taskbar flash: while the tab is in the background, alternate the
 * tab title until the user looks at it. Browsers do not let a page flash the
 * OS taskbar itself; a blinking tab title is what they allow.
 */
export function flashAttention(label) {
  const prefs = getPreferences();
  if (!prefs.notifications.taskbarFlash || document.visibilityState === 'visible') return false;
  if (flashTimer) return true;
  flashBaseTitle = document.title;
  let on = false;
  flashTimer = setInterval(() => {
    on = !on;
    document.title = on ? `● ${label}` : flashBaseTitle;
  }, 1000);
  const stop = () => {
    if (document.visibilityState !== 'visible') return;
    clearInterval(flashTimer);
    flashTimer = null;
    document.title = flashBaseTitle;
    document.removeEventListener('visibilitychange', stop);
  };
  document.addEventListener('visibilitychange', stop);
  return true;
}

/** Ask the browser for permission. Only ever called from a click. */
export async function requestNotificationPermission() {
  if (typeof Notification === 'undefined') return 'unsupported';
  if (Notification.permission !== 'default') return Notification.permission;
  try { return await Notification.requestPermission(); }
  catch { return Notification.permission; }
}

export function notificationPermission() {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

/**
 * Play one of the app's sounds, if the user has that event's sound switched on.
 * Streamer mode's "disable sounds" wins over the per-event toggle.
 */
export function playSound(event, { force = false } = {}) {
  const prefs = getPreferences();
  if (!force) {
    if (prefs.streamerMode.enabled && prefs.streamerMode.disableSounds) return false;
    if (prefs.notifications.sounds?.[event] === false) return false;
    if (silencedByStream(prefs) && (event === 'message' || event === 'mention')) return false;
  }
  const player = SOUND_PLAYERS[event];
  if (!player) return false;
  player();
  return true;
}

/**
 * Raise a desktop notification for a message.
 *
 * `muted` is the caller's verdict on the channel and server mute state; this
 * function owns everything else.
 */
export function notifyMessage({ title, body, icon, tag, muted = false, status, onClick }) {
  const prefs = getPreferences();
  const { notifications, streamerMode } = prefs;

  if (muted) return false;
  if (status === 'dnd') return false;
  if (streamerMode.enabled && streamerMode.disableNotifications) return false;
  if (silencedByStream(prefs)) return false;
  flashAttention(title);
  if (!notifications.desktopEnabled) return false;
  if (notificationPermission() !== 'granted') return false;
  // A notification for the window you are already looking at is just noise.
  if (document.visibilityState === 'visible' && document.hasFocus()) return false;

  try {
    // Remote avatars go through our image proxy (the CSP allows same-origin
    // images only); no avatar → the app icon.
    const notification = new Notification(title, {
      body, icon: icon ? proxiedImageUrl(icon) : '/icons/icon-192.png', tag, silent: true
    });
    notification.onclick = () => {
      window.focus();
      notification.close();
      onClick?.();
    };
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a message aloud when Text-to-Speech is switched on.
 * `isCurrentChannel` decides whether "for the channel I'm looking at" applies.
 */
export function speakMessage({ author, content, isCurrentChannel }) {
  const prefs = getPreferences();
  const mode = prefs.notifications.ttsMode;
  if (mode === 'never') return false;
  if (mode === 'current' && !isCurrentChannel) return false;
  if (!content) return false;
  return speak(`${author} says ${content}`, { rate: prefs.accessibility.ttsRate });
}

/**
 * Play back a message sent with /tts, if Accessibility › Text-to-speech
 * allows playback on this account.
 */
export function speakTtsMessage({ author, content }) {
  const prefs = getPreferences();
  if (!prefs.accessibility.ttsEnabled || !content) return false;
  if (prefs.streamerMode.enabled && prefs.streamerMode.disableSounds) return false;
  return speak(`${author} says ${content}`, { rate: prefs.accessibility.ttsRate });
}

/**
 * Reflect unread counts in the tab title and, where the Badging API exists
 * (installed PWA on desktop Chromium, iOS/macOS home-screen apps), on the app
 * icon — if the user wants a badge.
 */
export function applyUnreadBadge(mentionCount) {
  const prefs = getPreferences();
  const base = 'Antigravity';
  const show = prefs.notifications.unreadBadge && mentionCount > 0;
  const title = show ? `(${mentionCount}) ${base}` : base;
  if (flashTimer) flashBaseTitle = title;
  else document.title = title;
  try {
    if (show && typeof navigator.setAppBadge === 'function') navigator.setAppBadge(mentionCount).catch(() => {});
    else if (typeof navigator.clearAppBadge === 'function') navigator.clearAppBadge().catch(() => {});
  } catch { /* not allowed in this context */ }
}

/**
 * Is a channel/server settings row's mute in force? A timed mute that has run
 * out is not (the server clears it too, but a client may hold the old row).
 */
export function isMuteActive(settings, now = Date.now()) {
  if (!settings?.muted) return false;
  if (!settings.muted_until) return true;
  const until = Date.parse(settings.muted_until);
  return Number.isFinite(until) ? until > now : true;
}
