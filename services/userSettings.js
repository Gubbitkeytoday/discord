// ============================================================================
//  Client preferences that follow the account rather than the device.
//
//  Discord syncs almost everything in User Settings across your devices; only
//  hardware choices (which microphone, which speaker) are per-machine. This
//  service owns the account-wide half.
//
//  Stored one row per category so two tabs saving different categories at the
//  same time cannot clobber each other, and an unknown key from a newer client
//  is preserved rather than dropped.
// ============================================================================

import { runQuery, getQuery, allQuery, sql } from '../db.js';
import { ApiError } from '../lib/httpUtils.js';

/**
 * Every category, with its defaults. The server owns this list so a client on
 * an older build still gets sane values for settings it has never heard of.
 */
export const SETTING_DEFAULTS = {
  appearance: {
    theme: 'dark',                 // light | dark | ash | onyx | system
    uiDensity: 'default',          // compact | default | spacious
    messageDisplay: 'cozy',        // cozy | compact
    zoom: 100,                     // 50-200 %
    chatFontScale: 100,            // 80-160 %
    messageGroupSpacing: 16,       // px between message groups
    showSendButton: true,
    syncAcrossDevices: true
  },
  accessibility: {
    saturation: 100,               // 0-100 %
    reducedMotion: false,
    highContrast: false,
    roleColors: 'names',           // names | dots | off
    playAnimatedEmoji: true,
    autoplayGifs: true,
    stickerAnimation: 'always',    // always | interaction | never
    ttsRate: 1,                    // 0.1-4 x
    ttsEnabled: false,
    forceColors: false
  },
  notifications: {
    desktopEnabled: true,
    unreadBadge: true,
    taskbarFlash: true,
    ttsMode: 'never',              // never | current | all
    sounds: {
      message: true,
      mention: true,
      deafen: true,
      undeafen: true,
      mute: true,
      unmute: true,
      voiceJoin: true,
      voiceLeave: true,
      call: true
    },
    // Suppress everything while a call is on screen, as Discord's "Do Not
    // Disturb while streaming" does.
    muteWhileStreaming: true
  },
  chat: {
    showLinkPreviews: true,
    showImagePreviews: true,
    showEmbeds: true,
    inlineAttachmentMedia: true,
    renderSpoilers: 'click',       // click | owned | always
    showTimestamps: true,
    use24HourClock: true,
    convertEmoticons: true,
    showTypingIndicator: true,
    developerMode: false
  },
  privacy: {
    dmScanning: 'friends',         // everyone | friends | off
    allowDmsFrom: 'everyone',      // everyone | friends
    friendRequests: 'everyone',    // everyone | friends_of_friends | none
    // Discord's "who can add you as a friend" also honours server membership.
    allowServerMemberDms: true,
    // DMs from people who are not your friends wait in "Message requests"
    // until you accept them (Discord's message request filter).
    messageRequests: true,
    showCurrentActivity: true,
    allowAnalytics: false
  },
  activity: {
    shareActivity: true,
    customActivity: null
  },
  streamerMode: {
    enabled: false,
    autoEnable: false,             // when a screen share starts
    hidePersonalInformation: true,
    // Usernames, #tags and message text in toasts (a viewer can add you
    // with a username, or read a DM off a notification).
    hideUsernames: true,
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
    // The behavioural half of Voice & Video. Device ids stay on the device.
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
    // Server rail: folders group servers (Discord "server folders"); the order
    // lists server ids top to bottom. Servers not listed keep join order.
    serverFolders: [],   // [{ id, name, color, serverIds: [], collapsed }]
    serverOrder: []
  }
};

export const CATEGORIES = Object.keys(SETTING_DEFAULTS);

// ============================================================================
//  Age.
//
//  Only the birth year and month are stored (data minimisation, PDPA / GDPR
//  art. 5(1)(c)); the day is used once, at sign-up, for the 13+ check. Ages
//  derived later from year + month assume the birthday falls at the *end* of
//  the month, so a teen stays protected until the month is over — the error
//  is always on the safe side.
// ============================================================================

export const MINIMUM_AGE = 13;
export const ADULT_AGE = 18;

/** Whole years between a birth date and `now` (UTC). Day defaults to month end. */
export function ageFrom({ year, month, day = null }, now = new Date()) {
  const y = Number(year); const m = Number(month);
  if (!Number.isInteger(y) || !Number.isInteger(m)) return null;
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const d = day == null ? lastDay : Number(day);
  let age = now.getUTCFullYear() - y;
  const beforeBirthday = now.getUTCMonth() + 1 < m
    || (now.getUTCMonth() + 1 === m && now.getUTCDate() < d);
  if (beforeBirthday) age -= 1;
  return age;
}

/**
 * Validate a date of birth. Throws INVALID_BIRTHDATE for impossible dates and
 * AGE_TOO_YOUNG under 13. Returns `{ year, month, age }` — never the day.
 */
export function checkBirthdate({ year, month, day }, now = new Date()) {
  const y = Number(year); const m = Number(month); const d = Number(day);
  const valid = Number.isInteger(y) && Number.isInteger(m) && Number.isInteger(d)
    && y >= now.getUTCFullYear() - 120 && y <= now.getUTCFullYear()
    && m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (!valid) throw new ApiError('That date of birth is not valid', { code: 'INVALID_BIRTHDATE' });
  const age = ageFrom({ year: y, month: m, day: d }, now);
  if (age < 0) throw new ApiError('That date of birth is not valid', { code: 'INVALID_BIRTHDATE' });
  if (age < MINIMUM_AGE) {
    throw new ApiError(`You need to be at least ${MINIMUM_AGE} to use this service`,
      { status: 403, code: 'AGE_TOO_YOUNG' });
  }
  return { year: y, month: m, age };
}

/** 'minor' | 'adult' | 'unknown' for a user row carrying birth_year / birth_month. */
export function ageGroupOf(row, now = new Date()) {
  if (!row || row.birth_year == null || row.birth_month == null) return 'unknown';
  const age = ageFrom({ year: row.birth_year, month: row.birth_month }, now);
  if (age == null) return 'unknown';
  return age < ADULT_AGE ? 'minor' : 'adult';
}

export async function getAgeGroup(userId) {
  const row = await getQuery(`SELECT birth_year, birth_month FROM users WHERE id = ?`, [userId]);
  return ageGroupOf(row);
}

/**
 * Teen defaults (Discord's Teen Safety defaults, stricter where it costs
 * nothing): only friends can DM, other DMs wait as message requests, every
 * DM image is scanned, and friend requests need a friend in common. They are
 * defaults — stored choices still win — and are written once when an
 * account is found to be under 18.
 */
export const MINOR_PRIVACY_DEFAULTS = Object.freeze({
  allowDmsFrom: 'friends',
  allowServerMemberDms: false,
  messageRequests: true,
  dmScanning: 'everyone',
  friendRequests: 'friends_of_friends'
});

/** Persist the teen defaults over whatever the account had. */
export async function applyMinorDefaults(userId) {
  return updateCategory(userId, 'privacy', { ...MINOR_PRIVACY_DEFAULTS });
}

async function defaultsFor(userId, category) {
  if (category !== 'privacy') return SETTING_DEFAULTS[category];
  return (await getAgeGroup(userId)) === 'minor'
    ? { ...SETTING_DEFAULTS.privacy, ...MINOR_PRIVACY_DEFAULTS }
    : SETTING_DEFAULTS.privacy;
}

function parse(json, fallback) {
  if (!json) return fallback;
  try { return JSON.parse(json); } catch { return fallback; }
}

const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Merge one level deep: a category is a flat object except for
 * `notifications.sounds`, which callers patch a key at a time.
 */
function merge(base, patch) {
  // Built with Object.fromEntries rather than `out[key] = …`: a JSON body can
  // carry an own "__proto__" key, and assigning that would swap the merged
  // object's prototype instead of storing a setting. Such keys are dropped.
  const entries = Object.entries(patch ?? {})
    .filter(([key]) => key !== '__proto__' && key !== 'constructor' && key !== 'prototype')
    .map(([key, value]) => [key,
      isPlainObject(value) && Object.hasOwn(base, key) && isPlainObject(base[key])
        ? { ...base[key], ...value }
        : value]);
  return { ...base, ...Object.fromEntries(entries) };
}

/** Everything, defaults filled in for anything never saved. */
export async function getAll(userId) {
  const rows = await allQuery(
    `SELECT category, data FROM user_settings WHERE user_id = ?`, [userId]
  );
  const stored = new Map(rows.map((r) => [r.category, parse(r.data, {})]));
  const result = {};
  for (const category of CATEGORIES) {
    const defaults = category === 'privacy' ? await defaultsFor(userId, category) : SETTING_DEFAULTS[category];
    result[category] = merge(defaults, stored.get(category) ?? {});
  }
  return result;
}

export async function getCategory(userId, category) {
  if (!CATEGORIES.includes(category)) throw ApiError.notFound('Settings category');
  const row = await getQuery(
    `SELECT data FROM user_settings WHERE user_id = ? AND category = ?`, [userId, category]
  );
  return merge(await defaultsFor(userId, category), parse(row?.data, {}));
}

/** Merge a patch into one category and return the category's full new value. */
export async function updateCategory(userId, category, patch) {
  if (!CATEGORIES.includes(category)) throw ApiError.notFound('Settings category');
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new ApiError('Settings patch must be an object', { code: 'INVALID_PATCH' });
  }

  const current = await getCategory(userId, category);
  const next = validate(category, merge(current, patch));

  await runQuery(
    `INSERT INTO user_settings (user_id, category, data)
     VALUES (?, ?, ?)
     ON CONFLICT(user_id, category) DO UPDATE SET
       data = excluded.data,
       updated_at = ${sql.now}`,
    [userId, category, JSON.stringify(next)]
  );
  return next;
}

export async function resetCategory(userId, category) {
  if (!CATEGORIES.includes(category)) throw ApiError.notFound('Settings category');
  await runQuery(
    `DELETE FROM user_settings WHERE user_id = ? AND category = ?`, [userId, category]
  );
  return { ...(await defaultsFor(userId, category)) };
}

// --- validation --------------------------------------------------------------

const ENUMS = {
  'appearance.theme': ['light', 'dark', 'ash', 'onyx', 'system'],
  'appearance.uiDensity': ['compact', 'default', 'spacious'],
  'appearance.messageDisplay': ['cozy', 'compact'],
  'accessibility.roleColors': ['names', 'dots', 'off'],
  'accessibility.stickerAnimation': ['always', 'interaction', 'never'],
  'notifications.ttsMode': ['never', 'current', 'all'],
  'chat.renderSpoilers': ['click', 'owned', 'always'],
  'privacy.dmScanning': ['everyone', 'friends', 'off'],
  'privacy.allowDmsFrom': ['everyone', 'friends'],
  'privacy.friendRequests': ['everyone', 'friends_of_friends', 'none'],
  'voice.inputMode': ['voice', 'ptt']
};

const RANGES = {
  'appearance.zoom': [50, 200],
  'appearance.chatFontScale': [80, 160],
  'appearance.messageGroupSpacing': [0, 48],
  'accessibility.saturation': [0, 100],
  'accessibility.ttsRate': [0.1, 4],
  'voice.inputVolume': [0, 200],
  'voice.outputVolume': [0, 200],
  'voice.soundboardVolume': [0, 200],
  'voice.sensitivity': [0, 100],
  'voice.attenuation': [0, 100],
  'voice.pushToTalkReleaseMs': [0, 2000],
  'voice.videoFrameRate': [1, 60],
  'voice.blurStrength': [1, 60]
};

/**
 * Clamp and reject nonsense before it is stored. A settings row is read on
 * every page load, so one bad value written once would follow the user around.
 */
function validate(category, value) {
  const out = { ...value };
  for (const [key, raw] of Object.entries(out)) {
    const path = `${category}.${key}`;
    if (ENUMS[path] && !ENUMS[path].includes(raw)) {
      throw new ApiError(`${path} must be one of ${ENUMS[path].join(', ')}`, { code: 'INVALID_SETTING' });
    }
    if (RANGES[path]) {
      const [min, max] = RANGES[path];
      const number = Number(raw);
      if (!Number.isFinite(number)) {
        throw new ApiError(`${path} must be a number`, { code: 'INVALID_SETTING' });
      }
      out[key] = Math.min(max, Math.max(min, number));
    }
    if (typeof SETTING_DEFAULTS[category][key] === 'boolean') out[key] = Boolean(raw);
    if (typeof raw === 'string' && raw.length > 200) out[key] = raw.slice(0, 200);
  }
  if (category === 'layout') validateLayout(out);
  return out;
}

/** Folders and order are arrays of ids; bound them so one row cannot bloat. */
function validateLayout(out) {
  const ids = (list) => [...new Set((Array.isArray(list) ? list : []).map(String).filter((id) => id.length <= 40))].slice(0, 200);
  out.serverOrder = ids(out.serverOrder);
  const folders = Array.isArray(out.serverFolders) ? out.serverFolders.slice(0, 50) : [];
  out.serverFolders = folders
    .filter((f) => f && typeof f === 'object')
    .map((f) => ({
      id: String(f.id ?? '').slice(0, 40) || String(Date.now()),
      name: String(f.name ?? '').slice(0, 60),
      color: /^#[0-9a-fA-F]{6}$/.test(String(f.color ?? '')) ? String(f.color) : null,
      collapsed: Boolean(f.collapsed),
      serverIds: ids(f.serverIds)
    }))
    .filter((f) => f.serverIds.length > 0);
}
