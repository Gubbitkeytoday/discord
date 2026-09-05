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
  if (!notifications.desktopEnabled) return false;
  if (notificationPermission() !== 'granted') return false;
  // A notification for the window you are already looking at is just noise.
  if (document.visibilityState === 'visible' && document.hasFocus()) return false;

  try {
    const notification = new Notification(title, { body, icon, tag, silent: true });
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

/** Reflect unread counts in the tab title, if the user wants a badge. */
export function applyUnreadBadge(mentionCount) {
  const prefs = getPreferences();
  const base = 'Antigravity';
  document.title = prefs.notifications.unreadBadge && mentionCount > 0
    ? `(${mentionCount}) ${base}`
    : base;
}
