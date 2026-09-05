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

import { runQuery, getQuery, allQuery } from '../db.js';
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

function parse(json, fallback) {
  if (!json) return fallback;
  try { return JSON.parse(json); } catch { return fallback; }
}

/**
 * Merge one level deep: a category is a flat object except for
 * `notifications.sounds`, which callers patch a key at a time.
 */
function merge(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (value && typeof value === 'object' && !Array.isArray(value)
        && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = { ...base[key], ...value };
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Everything, defaults filled in for anything never saved. */
export async function getAll(userId) {
  const rows = await allQuery(
    `SELECT category, data FROM user_settings WHERE user_id = ?`, [userId]
  );
  const stored = new Map(rows.map((r) => [r.category, parse(r.data, {})]));
  const result = {};
  for (const category of CATEGORIES) {
    result[category] = merge(SETTING_DEFAULTS[category], stored.get(category) ?? {});
  }
  return result;
}

export async function getCategory(userId, category) {
  if (!CATEGORIES.includes(category)) throw ApiError.notFound('Settings category');
  const row = await getQuery(
    `SELECT data FROM user_settings WHERE user_id = ? AND category = ?`, [userId, category]
  );
  return merge(SETTING_DEFAULTS[category], parse(row?.data, {}));
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
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
    [userId, category, JSON.stringify(next)]
  );
  return next;
}

export async function resetCategory(userId, category) {
  if (!CATEGORIES.includes(category)) throw ApiError.notFound('Settings category');
  await runQuery(
    `DELETE FROM user_settings WHERE user_id = ? AND category = ?`, [userId, category]
  );
  return { ...SETTING_DEFAULTS[category] };
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
