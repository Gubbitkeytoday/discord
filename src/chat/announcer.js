// ============================================================================
//  One screen-reader announcer for the whole app (WCAG 4.1.3).
//
//  A live region only speaks when its *content changes* while it is already
//  in the document. Regions mounted together with their text (the old
//  per-toast role="status") are often skipped by NVDA and VoiceOver, so the
//  app mounts <LiveAnnouncer/> once and everything speaks through here:
//
//    announce(text)                     polite, de-duplicated, queued
//    announce(text, { assertive: true }) errors and things that need action
//    announceMessage(msg, channelName)  new messages in the open channel,
//                                       batched: 1 → "Mina: hi", 4 → "4 new
//                                       messages in #general"
//    announceTyping(text)               at most once per 5 s, only on change
//    announceVoice(event, detail)       voice join/leave/mute hooks — for the
//                                       voice UI (VoiceRoom, user panel)
//
//  Nothing here touches React: subscribers (the announcer component) get the
//  strings. The module also works before the component mounts (queued).
// ============================================================================

import { t } from '../i18n/index.jsx';

const listeners = new Set();
const pending = [];

let messageBatch = [];
let messageTimer = null;
let lastTyping = '';
let lastTypingAt = 0;
let verbosity = 'all';   // 'all' | 'mentions' | 'off' — see setMessageVerbosity

const MESSAGE_WINDOW_MS = 1500;
const TYPING_INTERVAL_MS = 5000;
const MAX_SPOKEN_CHARS = 180;

function emit(entry) {
  if (listeners.size === 0) {
    pending.push(entry);
    if (pending.length > 20) pending.shift();
    return;
  }
  for (const fn of listeners) fn(entry);
}

/** Subscribe to announcements: fn({ text, assertive }). Returns unsubscribe. */
export function subscribeAnnouncements(fn) {
  listeners.add(fn);
  while (pending.length) fn(pending.shift());
  return () => listeners.delete(fn);
}

/** Speak `text` through the live region. Empty strings are ignored. */
export function announce(text, { assertive = false } = {}) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!value) return;
  emit({ text: value.length > MAX_SPOKEN_CHARS ? `${value.slice(0, MAX_SPOKEN_CHARS)}…` : value, assertive, at: Date.now() });
}

/** How chatty new-message announcements are ('all' | 'mentions' | 'off'). */
export function setMessageVerbosity(value) {
  verbosity = ['all', 'mentions', 'off'].includes(value) ? value : 'all';
}

/** Plain text for speech: tokens and markup reduced to what a listener needs. */
export function speakable(content = '') {
  return String(content)
    .replace(/```[\s\S]*?```/g, ` ${t('a11y.codeBlock')} `)
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
    .replace(/<@&?!?\d+>/g, '@')
    .replace(/<#\d+>/g, '#')
    .replace(/\|\|[\s\S]*?\|\|/g, ` ${t('chat.spoiler')} `)
    .replace(/[*_~`>]/g, '')
    .trim();
}

function flushMessages(channelName) {
  const batch = messageBatch;
  messageBatch = [];
  messageTimer = null;
  if (batch.length === 0) return;
  if (batch.length === 1) {
    const { author, text } = batch[0];
    announce(text ? t('a11y.messageFrom', { name: author, text }) : t('a11y.attachmentFrom', { name: author }));
    return;
  }
  const authors = [...new Set(batch.map((m) => m.author))];
  announce(authors.length === 1
    ? t('a11y.newMessagesFrom', { count: batch.length, name: authors[0] })
    : t('a11y.newMessagesIn', { count: batch.length, channel: channelName }));
}

/**
 * A message arrived in the channel on screen. Your own messages are skipped;
 * a burst inside 1.5 s is summarised instead of read out one by one.
 */
export function announceMessage(msg, { channelName = '', currentUserId = null, mentionsMe = false } = {}) {
  if (!msg || msg.user_id === currentUserId || verbosity === 'off') return;
  if (verbosity === 'mentions' && !mentionsMe) return;
  messageBatch.push({ author: msg.display_name || msg.username || t('chat.someone'), text: speakable(msg.content) });
  clearTimeout(messageTimer);
  messageTimer = setTimeout(() => flushMessages(channelName), MESSAGE_WINDOW_MS);
}

/** The typing line changed. Spoken only when new, and not more than every 5 s. */
export function announceTyping(text) {
  if (!text) { lastTyping = ''; return; }
  const now = Date.now();
  if (text === lastTyping || now - lastTypingAt < TYPING_INTERVAL_MS) return;
  lastTyping = text;
  lastTypingAt = now;
  announce(text);
}

/**
 * Voice-state announcements, for the voice UI to call:
 *   announceVoice('connected', { channel })   announceVoice('disconnected')
 *   announceVoice('joined', { name })         announceVoice('left', { name })
 *   announceVoice('muted') / ('unmuted') / ('deafened') / ('undeafened')
 */
export function announceVoice(event, { name = '', channel = '' } = {}) {
  const key = {
    connected: 'a11y.voiceConnected',
    disconnected: 'a11y.voiceDisconnected',
    joined: 'a11y.voiceJoined',
    left: 'a11y.voiceLeft',
    muted: 'a11y.voiceMuted',
    unmuted: 'a11y.voiceUnmuted',
    deafened: 'a11y.voiceDeafened',
    undeafened: 'a11y.voiceUndeafened'
  }[event];
  if (key) announce(t(key, { name, channel }));
}

// Other modules (src/voice/announce.js) speak without importing this file:
//   window.dispatchEvent(new CustomEvent('app:announce',
//     { detail: { message, politeness: 'polite' | 'assertive' } }))
if (typeof window !== 'undefined') {
  window.addEventListener('app:announce', (event) => {
    const { message, politeness } = event.detail ?? {};
    announce(message, { assertive: politeness === 'assertive' });
  });
}

// Voice code lives elsewhere; a global handle keeps it from having to import
// React-free modules through odd paths (and helps manual testing).
if (typeof window !== 'undefined') {
  window.__antigravityAnnounce = { announce, announceVoice };
}
