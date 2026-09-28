// ============================================================================
//  When to offer notifications.
//
//  Never on first load: a permission prompt before the user has done anything
//  is the one most often denied, and a denial is effectively permanent. The
//  in-app banner (not the browser prompt) appears only after a signal that
//  notifications would help:
//    - someone mentions you while you are here, or
//    - you have sent a few messages this session,
//  and only once the app has been open for a minute. "Not now" snoozes it for
//  two weeks; the browser prompt itself is only ever triggered by the
//  banner's Enable button (a user gesture).
// ============================================================================

import { setPwaState, storage } from './store';
import { pushSupport } from './push';

const SNOOZE_KEY = 'pwa.notifyPromptSnoozedUntil';
const SNOOZE_MS = 14 * 24 * 60 * 60_000;
const MIN_SESSION_MS = 60_000;
const SENT_THRESHOLD = 3;

const startedAt = Date.now();
let sent = 0;
let pending = false;

function eligible() {
  if (typeof Notification === 'undefined' && pushSupport() !== 'needs-install') return false;
  if (typeof Notification !== 'undefined' && Notification.permission !== 'default') return false;
  const snoozedUntil = Number(storage.get(SNOOZE_KEY) || 0);
  return Date.now() >= snoozedUntil;
}

function offer() {
  if (!eligible()) return;
  const wait = MIN_SESSION_MS - (Date.now() - startedAt);
  if (wait > 0) {
    if (pending) return;
    pending = true;
    setTimeout(() => { pending = false; if (eligible()) setPwaState({ askNotifications: true }); }, wait);
    return;
  }
  setPwaState({ askNotifications: true });
}

/** 'mention' | 'sent' */
export function noteSignal(kind) {
  if (kind === 'mention') offer();
  if (kind === 'sent') { sent += 1; if (sent >= SENT_THRESHOLD) offer(); }
}

export function snoozeNotificationPrompt() {
  storage.set(SNOOZE_KEY, String(Date.now() + SNOOZE_MS));
  setPwaState({ askNotifications: false });
}

export function dismissNotificationPrompt() {
  setPwaState({ askNotifications: false });
}
