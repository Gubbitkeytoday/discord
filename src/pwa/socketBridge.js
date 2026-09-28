// ============================================================================
//  The PWA layer's link to the app's realtime socket.
//
//  - reports whether this client is in front of the user (`client_state`), so
//    the server skips Web Push while you are looking at the app;
//  - shows desktop notifications for "All messages" pings (the server sends
//    `notification_ping` for messages that notify but are not mentions);
//  - re-ties this browser's push subscription to the session on identify;
//  - notices good moments to offer notifications (see prompts.js).
//
//  The app hands its socket over with bindSocket(socket). Until it does, the
//  first socket that emits `identify` is adopted — src/App.jsx owns the socket
//  and does not export it.
// ============================================================================

import { Socket } from 'socket.io-client';
import { notifyMessage, playSound } from '../utils/notifier';
import { t } from '../i18n/index.jsx';
import { setPwaState } from './store';
import { syncPushSubscription } from './push';
import { noteSignal } from './prompts';

const IDLE_MS = 5 * 60_000;       // no input for this long = not "in front of it"
const HEARTBEAT_MS = 60_000;      // server forgets focus after 3 min without one

let socket = null;
let myId = null;
let myStatus = null;
let lastInput = Date.now();
let lastSent = { focused: null, at: 0 };

// --- adoption ------------------------------------------------------------------

const originalEmit = Socket.prototype.emit;
Socket.prototype.emit = function emitAndAdopt(event, ...args) {
  if (event === 'identify' && !socket) {
    Socket.prototype.emit = originalEmit;
    bindSocket(this);
  }
  return originalEmit.call(this, event, ...args);
};

export function bindSocket(next) {
  if (!next || socket === next) return;
  Socket.prototype.emit = originalEmit;
  socket = next;
  socket.on('identified', ({ userId } = {}) => {
    myId = userId ?? null;
    setPwaState({ userId: myId });
    lastSent = { focused: null, at: 0 };
    report(true);
    syncPushSubscription().catch(() => {});
  });
  socket.on('presence_updated', ({ userId, status } = {}) => {
    if (userId && userId === myId) myStatus = status;
  });
  socket.on('notification_ping', onPing);
  // Signed out elsewhere: nothing to offer until someone identifies again.
  socket.on('session_revoked', () => { myId = null; setPwaState({ userId: null, askNotifications: false }); });
  socket.on('notification', () => noteSignal('mention'));
  socket.onAnyOutgoing?.((event) => { if (event === 'send_message') noteSignal('sent'); });
}

// --- focus reporting -----------------------------------------------------------

export function isFocusedNow() {
  return document.visibilityState === 'visible'
    && (typeof document.hasFocus !== 'function' || document.hasFocus())
    && Date.now() - lastInput < IDLE_MS;
}

function report(force = false) {
  if (!socket?.connected || !myId) return;
  const focused = isFocusedNow();
  const now = Date.now();
  if (!force && focused === lastSent.focused && (!focused || now - lastSent.at < HEARTBEAT_MS)) return;
  lastSent = { focused, at: now };
  socket.emit('client_state', { focused });
}

let inputThrottle = 0;
function onInput() {
  const wasIdle = Date.now() - lastInput >= IDLE_MS;
  lastInput = Date.now();
  if (wasIdle || Date.now() - inputThrottle > 5000) {
    inputThrottle = Date.now();
    report();
  }
}

export function initFocusReporting() {
  document.addEventListener('visibilitychange', () => report());
  window.addEventListener('focus', () => { lastInput = Date.now(); report(); });
  window.addEventListener('blur', () => report());
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    window.addEventListener(type, onInput, { passive: true, capture: true });
  }
  setInterval(() => report(), 30_000);
}

// --- navigation ----------------------------------------------------------------

/**
 * Open an in-app path. The app may handle `pwa:navigate` itself (and call
 * preventDefault) to switch channel without a reload; otherwise load it.
 */
export function openAppPath(path) {
  if (typeof path !== 'string' || !path.startsWith('/')) return;
  const [, , server, channel, message] = path.split('?')[0].split('/');
  const event = new CustomEvent('pwa:navigate', {
    cancelable: true,
    detail: { path, serverId: server === '@me' ? 'home' : server, channelId: channel, messageId: message ?? null }
  });
  window.dispatchEvent(event);
  if (event.defaultPrevented) return;
  if (window.location.pathname + window.location.search !== path) window.location.assign(path);
}

// --- "All messages" pings ------------------------------------------------------

function onPing(ping = {}) {
  const path = `/channels/${ping.server_id ?? '@me'}/${ping.channel_id}`;
  // The channel on screen already shows the message.
  if (isFocusedNow() && window.location.pathname.startsWith(path)) return;
  if (myStatus === 'dnd') return;
  playSound('message');
  notifyMessage({
    title: ping.actor_name
      ? (ping.channel_name ? `${ping.actor_name} (#${ping.channel_name})` : ping.actor_name)
      : t('notif.newMessage'),
    body: ping.preview ?? '',
    tag: `channel-${ping.channel_id}`,
    status: myStatus,
    onClick: () => openAppPath(path)
  });
}
