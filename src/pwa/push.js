// ============================================================================
//  Browser side of Web Push: support detection, subscribe / unsubscribe, and
//  re-registering this browser's subscription with the server after sign-in
//  (a subscription belongs to a session; logging out deletes it server-side).
//
//  iOS/iPadOS only offers Push to a web app added to the Home Screen
//  (16.4+), so there `pushSupport()` reports 'needs-install' until then.
// ============================================================================

import { get, post, del } from '../api';
import { setPwaState, storage } from './store';

const OPT_IN_KEY = 'pwa.pushOptIn';
let configPromise = null;

export function isStandalone() {
  try {
    return window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
  } catch { return false; }
}

export function isIos() {
  const ua = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/** 'supported' | 'needs-install' | 'unsupported' */
export function pushSupport() {
  const hasApis = 'serviceWorker' in navigator && typeof window.PushManager !== 'undefined'
    && typeof window.Notification !== 'undefined';
  if (hasApis) return 'supported';
  if (isIos() && !isStandalone()) return 'needs-install';
  return 'unsupported';
}

export function getPushConfig({ refresh = false } = {}) {
  if (!configPromise || refresh) {
    configPromise = get('/api/push/config')
      .then((cfg) => { setPwaState({ pushServerEnabled: Boolean(cfg?.enabled) }); return cfg ?? { enabled: false }; })
      .catch(() => { configPromise = null; return { enabled: false }; });
  }
  return configPromise;
}

function keyToBytes(base64url) {
  const padded = `${base64url}${'='.repeat((4 - (base64url.length % 4)) % 4)}`.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function sameKey(subscription, publicKey) {
  const current = subscription?.options?.applicationServerKey;
  if (!current) return true; // browser does not expose it; assume unchanged
  const a = new Uint8Array(current);
  const b = keyToBytes(publicKey);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

async function registration(timeoutMs = 8000) {
  if (!('serviceWorker' in navigator)) return null;
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs))
  ]);
}

export async function currentSubscription() {
  const reg = await registration(2000);
  return reg ? reg.pushManager.getSubscription().catch(() => null) : null;
}

export async function refreshPushState() {
  const sub = pushSupport() === 'supported' ? await currentSubscription() : null;
  setPwaState({ pushSubscribed: Boolean(sub) && storage.get(OPT_IN_KEY) === '1' });
  return sub;
}

/**
 * Turn push on for this browser. Must run from a user gesture: it may ask for
 * the notification permission. Returns { ok, reason? }.
 */
export async function enablePush() {
  if (pushSupport() !== 'supported') return { ok: false, reason: pushSupport() };
  const permission = Notification.permission === 'default'
    ? await Notification.requestPermission().catch(() => Notification.permission)
    : Notification.permission;
  if (permission !== 'granted') return { ok: false, reason: 'denied' };
  const cfg = await getPushConfig({ refresh: true });
  if (!cfg?.enabled || !cfg.public_key) return { ok: false, reason: 'server' };
  const reg = await registration();
  if (!reg) return { ok: false, reason: 'no-worker' };
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub, cfg.public_key)) { await sub.unsubscribe().catch(() => {}); sub = null; }
  if (!sub) {
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(cfg.public_key) });
  }
  await post('/api/push/subscriptions', sub.toJSON());
  storage.set(OPT_IN_KEY, '1');
  setPwaState({ pushSubscribed: true });
  return { ok: true };
}

export async function disablePush() {
  storage.remove(OPT_IN_KEY);
  const sub = await currentSubscription();
  if (sub) {
    await del('/api/push/subscriptions', { body: { endpoint: sub.endpoint } }).catch(() => {});
    await sub.unsubscribe().catch(() => {});
  }
  setPwaState({ pushSubscribed: false });
}

/**
 * After (re-)identifying: if this browser opted in and still holds a
 * subscription, hand it to the server again so it is tied to the current
 * session. Silent — never prompts.
 */
export async function syncPushSubscription() {
  if (pushSupport() !== 'supported' || storage.get(OPT_IN_KEY) !== '1') return refreshPushState();
  if (Notification.permission !== 'granted') { storage.remove(OPT_IN_KEY); return refreshPushState(); }
  const cfg = await getPushConfig();
  if (!cfg?.enabled) return refreshPushState();
  const reg = await registration();
  if (!reg) return null;
  let sub = await reg.pushManager.getSubscription().catch(() => null);
  try {
    if (sub && !sameKey(sub, cfg.public_key)) { await sub.unsubscribe().catch(() => {}); sub = null; }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(cfg.public_key) });
    await post('/api/push/subscriptions', sub.toJSON());
  } catch { /* offline or rate-limited: next identify retries */ }
  return refreshPushState();
}

export const sendTestPush = () => post('/api/push/test', {});
export const listDevices = () => get('/api/push/subscriptions');
export const removeDevice = (id) => del(`/api/push/subscriptions/${encodeURIComponent(id)}`);
