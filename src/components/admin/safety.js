// ============================================================================
//  Small safety helpers shared by the settings pages, the profile popout, the
//  report dialog and the admin console.
// ============================================================================

import { useEffect, useState } from 'react';
import { get } from '../../api';
import { useUserSettings } from '../../hooks/useUserSettings';
import { t } from '../../i18n/index.jsx';

// ---------------------------------------------------------------------------
// Account flags (instance admin, age group, birth date asked) come from
// /api/auth/me. The app's user object is replaced by payloads that do not
// carry them, so they are read here, once per account per page load.
// ---------------------------------------------------------------------------
const flagCache = new Map();
const flagListeners = new Set();

function pickFlags(user) {
  return user && 'age_group' in user
    ? { is_instance_admin: Boolean(user.is_instance_admin), age_group: user.age_group, birthdate_set: user.birthdate_set }
    : null;
}

/** Tell every mounted useAccountFlags that something changed (a birth date was saved). */
export function updateAccountFlags(userId, patch) {
  const next = { ...(flagCache.get(userId)?.value ?? {}), ...patch };
  flagCache.set(userId, { value: next, promise: Promise.resolve(next) });
  flagListeners.forEach((fn) => fn(userId, next));
}

export function useAccountFlags(user) {
  const userId = user?.id ?? null;
  const [flags, setFlags] = useState(() => pickFlags(user) ?? flagCache.get(userId)?.value ?? null);
  useEffect(() => {
    if (!userId) return undefined;
    let live = true;
    const direct = pickFlags(user);
    if (direct && !flagCache.has(userId)) flagCache.set(userId, { value: direct, promise: Promise.resolve(direct) });
    if (!flagCache.has(userId)) {
      const promise = get('/api/auth/me')
        .then((r) => {
          const value = pickFlags(r?.user) ?? { is_instance_admin: false, age_group: 'unknown', birthdate_set: true };
          flagCache.set(userId, { value, promise: Promise.resolve(value) });
          return value;
        })
        .catch(() => { flagCache.delete(userId); return null; });
      flagCache.set(userId, { value: null, promise });
    }
    flagCache.get(userId).promise.then((value) => { if (live && value) setFlags(value); });
    const listener = (id, value) => { if (live && id === userId) setFlags(value); };
    flagListeners.add(listener);
    return () => { live = false; flagListeners.delete(listener); };
  }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps
  return flags ?? {};
}

/** Report categories, in the order the dialog lists them. */
export const REPORT_REASONS = ['spam', 'harassment', 'hate', 'self_harm', 'minor_safety', 'other'];
export const reasonLabel = (reason) => {
  const key = `safety.reason.${reason}`;
  const label = t(key);
  return label === key ? reason : label;
};

/** What streamer mode should hide right now, from the account preferences. */
export function useStreamerMask() {
  const { prefs } = useUserSettings();
  const s = prefs?.streamerMode ?? {};
  const on = Boolean(s.enabled);
  return {
    on,
    personal: on && s.hidePersonalInformation !== false,
    invites: on && s.hideInviteLinks !== false,
    // New in this round; unset (older saved settings) means "hide".
    usernames: on && s.hideUsernames !== false
  };
}

/** "alex@example.com" → "a•••@e•••" style masking for a screen that might be shared. */
export function maskEmail(email) {
  if (!email) return '';
  const [local, domain = ''] = String(email).split('@');
  return `${local.slice(0, 1)}•••@${domain.slice(0, 1)}•••`;
}

/**
 * A browser user agent as a person would say it: "Chrome on Windows",
 * "Safari on iPhone", "Firefox on Android · Pixel 7". Not exhaustive —
 * anything unknown falls back to a generic label, never the raw string.
 */
export function describeUserAgent(ua) {
  const s = String(ua ?? '');
  if (!s) return { browser: null, os: null, device: null };
  let browser = null;
  if (/Edg(e|A|iOS)?\//.test(s)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(s)) browser = 'Opera';
  else if (/SamsungBrowser\//.test(s)) browser = 'Samsung Internet';
  else if (/Firefox\/|FxiOS\//.test(s)) browser = 'Firefox';
  else if (/Chrome\/|CriOS\//.test(s) && !/Chromium\//.test(s)) browser = 'Chrome';
  else if (/Chromium\//.test(s)) browser = 'Chromium';
  else if (/Safari\//.test(s) && /Version\//.test(s)) browser = 'Safari';
  else if (/Electron\//.test(s)) browser = 'Desktop app';
  else if (/node|undici|curl|python|okhttp/i.test(s)) browser = 'API client';

  let os = null;
  let device = null;
  if (/iPhone/.test(s)) os = 'iPhone';
  else if (/iPad/.test(s)) os = 'iPad';
  else if (/Android/.test(s)) {
    os = 'Android';
    const model = /Android [\d.]+; (?:[a-z]{2}-[a-z]{2}; )?([^;)]+?)(?: Build\/|\))/i.exec(s)?.[1]?.trim();
    if (model && !/^(K|Mobile|wv|Linux)$/i.test(model)) device = model;
  } else if (/Windows/.test(s)) os = 'Windows';
  else if (/Mac OS X|Macintosh/.test(s)) os = 'macOS';
  else if (/CrOS/.test(s)) os = 'ChromeOS';
  else if (/Linux/.test(s)) os = 'Linux';
  return { browser, os, device };
}

/** One line for a session row: "Chrome on Windows", with a fallback. */
export function deviceLabel(session) {
  const { browser, os, device } = describeUserAgent(session?.user_agent);
  if (session?.device_name) return session.device_name;
  if (browser && os) return t('safety.browserOnOs', { browser, os }) + (device ? ` · ${device}` : '');
  if (browser || os) return browser || os;
  return t('safety.unknownDevice');
}

/** Read and clear the server's "you were signed out" marker cookie. */
export function takeSignedOutMarker() {
  try {
    const found = document.cookie.split(';').some((part) => part.trim().startsWith('antigravity_signed_out=1'));
    if (found) document.cookie = 'antigravity_signed_out=; Path=/; Max-Age=0; SameSite=Lax';
    return found;
  } catch {
    return false;
  }
}

/** Minutes to wait from a 429 error body, or null. */
export function retryMinutes(err) {
  const seconds = Number(err?.details?.retry_after_seconds);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.max(1, Math.ceil(seconds / 60));
}
