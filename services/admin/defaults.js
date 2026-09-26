// ============================================================================
//  Localised defaults for new servers, and the built-in server templates.
//
//  Discord names a new server's categories and first channels in the
//  creator's language ("ช่องข้อความ / ทั่วไป" for a Thai owner), so a Thai,
//  Hindi or Spanish community does not start with English furniture. The
//  names are stored as ordinary data: renaming them later is just a rename.
//
//  Built-in templates are addressed with the reserved template codes
//  `builtin-<key>` or `builtin-<key>-<lang>` (e.g. builtin-gaming-th), so the
//  existing /api/templates/:code endpoints serve them unchanged.
// ============================================================================

import { PERMISSIONS } from '../../lib/permissions.js';

/** Discord's own localisations of the four default names. */
const DEFAULT_NAMES = {
  en: { textCategory: 'TEXT CHANNELS', general: 'general', voiceCategory: 'VOICE CHANNELS', generalVoice: 'General Voice' },
  th: { textCategory: 'ช่องข้อความ', general: 'ทั่วไป', voiceCategory: 'ช่องเสียง', generalVoice: 'ทั่วไป' },
  ja: { textCategory: 'テキストチャンネル', general: '一般', voiceCategory: 'ボイスチャンネル', generalVoice: '一般' },
  ko: { textCategory: '채팅 채널', general: '일반', voiceCategory: '음성 채널', generalVoice: '일반' },
  'zh-CN': { textCategory: '文字频道', general: '常规', voiceCategory: '语音频道', generalVoice: '常规' },
  'zh-TW': { textCategory: '文字頻道', general: '一般', voiceCategory: '語音頻道', generalVoice: '一般' },
  es: { textCategory: 'CANALES DE TEXTO', general: 'general', voiceCategory: 'CANALES DE VOZ', generalVoice: 'General' },
  pt: { textCategory: 'CANAIS DE TEXTO', general: 'geral', voiceCategory: 'CANAIS DE VOZ', generalVoice: 'Geral' },
  de: { textCategory: 'TEXTKANÄLE', general: 'allgemein', voiceCategory: 'SPRACHKANÄLE', generalVoice: 'Allgemein' },
  fr: { textCategory: 'SALONS TEXTUELS', general: 'général', voiceCategory: 'SALONS VOCAUX', generalVoice: 'Général' },
  it: { textCategory: 'CANALI TESTUALI', general: 'generale', voiceCategory: 'CANALI VOCALI', generalVoice: 'Generale' },
  ru: { textCategory: 'ТЕКСТОВЫЕ КАНАЛЫ', general: 'основной', voiceCategory: 'ГОЛОСОВЫЕ КАНАЛЫ', generalVoice: 'Основной' },
  uk: { textCategory: 'ТЕКСТОВІ КАНАЛИ', general: 'загальний', voiceCategory: 'ГОЛОСОВІ КАНАЛИ', generalVoice: 'Загальний' },
  pl: { textCategory: 'KANAŁY TEKSTOWE', general: 'ogólny', voiceCategory: 'KANAŁY GŁOSOWE', generalVoice: 'Ogólny' },
  tr: { textCategory: 'METİN KANALLARI', general: 'genel', voiceCategory: 'SES KANALLARI', generalVoice: 'Genel' },
  vi: { textCategory: 'KÊNH CHAT', general: 'chung', voiceCategory: 'KÊNH ĐÀM THOẠI', generalVoice: 'Chung' },
  id: { textCategory: 'SALURAN TEKS', general: 'umum', voiceCategory: 'SALURAN SUARA', generalVoice: 'Umum' },
  hi: { textCategory: 'टेक्स्ट चैनल', general: 'सामान्य', voiceCategory: 'वॉइस चैनल', generalVoice: 'सामान्य' },
  ar: { textCategory: 'القنوات النصية', general: 'عام', voiceCategory: 'القنوات الصوتية', generalVoice: 'عام' },
  nl: { textCategory: 'TEKSTKANALEN', general: 'algemeen', voiceCategory: 'SPRAAKKANALEN', generalVoice: 'Algemeen' }
};

/**
 * Map a locale code ("th", "th-TH", "pt-BR", "zh-Hant") onto a key of the
 * tables above, or 'en'. `users.locale` defaults to 'th-TH' in the schema
 * even for people who never chose a language, so that exact value is not
 * treated as a choice (the client always stores bare registry codes).
 */
export function resolveLang(locale, { trustDefault = false } = {}) {
  if (!locale || typeof locale !== 'string') return 'en';
  if (locale === 'th-TH' && !trustDefault) return 'en';
  const code = locale.trim();
  if (DEFAULT_NAMES[code]) return code;
  const lower = code.toLowerCase();
  if (lower.startsWith('zh')) {
    return /tw|hk|mo|hant/.test(lower) ? 'zh-TW' : 'zh-CN';
  }
  const base = lower.split(/[-_]/)[0];
  return DEFAULT_NAMES[base] ? base : 'en';
}

export function defaultChannelNames(locale, opts) {
  return DEFAULT_NAMES[resolveLang(locale, opts)] ?? DEFAULT_NAMES.en;
}

// --- built-in templates --------------------------------------------------------

const P = (...names) => names.reduce((acc, n) => acc | PERMISSIONS[n], 0n).toString();
const MOD_PERMS = P('KICK_MEMBERS', 'BAN_MEMBERS', 'MODERATE_MEMBERS', 'MANAGE_MESSAGES', 'VIEW_AUDIT_LOG',
  'MANAGE_NICKNAMES', 'MANAGE_THREADS', 'MUTE_MEMBERS', 'MOVE_MEMBERS', 'DEAFEN_MEMBERS');
const EVERYONE = P('VIEW_CHANNEL', 'SEND_MESSAGES', 'READ_MESSAGE_HISTORY', 'ADD_REACTIONS', 'ATTACH_FILES',
  'EMBED_LINKS', 'USE_EXTERNAL_EMOJIS', 'CONNECT', 'SPEAK', 'USE_VAD', 'STREAM', 'CHANGE_NICKNAME',
  'CREATE_INSTANT_INVITE', 'CREATE_PUBLIC_THREADS', 'SEND_MESSAGES_IN_THREADS');
const SEND = P('SEND_MESSAGES');

/** [en, th] name pairs. Other languages fall back to English. */
const N = {
  info: ['INFORMATION', 'ข้อมูล'],
  welcome: ['welcome', 'ยินดีต้อนรับ'],
  rules: ['rules', 'กฎ'],
  announcements: ['announcements', 'ประกาศ'],
  chat: ['CHAT', 'พูดคุย'],
  general: ['general', 'ทั่วไป'],
  lfg: ['looking-for-group', 'หาทีม'],
  clips: ['clips-and-highlights', 'คลิปเด็ด'],
  voice: ['VOICE', 'ห้องเสียง'],
  lounge: ['Lounge', 'นั่งเล่น'],
  squad1: ['Squad 1', 'ทีม 1'],
  squad2: ['Squad 2', 'ทีม 2'],
  events: ['EVENTS', 'กิจกรรม'],
  stage: ['Stage', 'เวที'],
  study: ['STUDY', 'เรียน'],
  homework: ['homework-help', 'ถามการบ้าน'],
  resources: ['resources', 'แหล่งความรู้'],
  studyRoom: ['Study Room', 'ห้องติว'],
  classroom: ['Classroom', 'ห้องเรียน'],
  memes: ['memes', 'มีม'],
  plans: ['plans', 'นัดเที่ยว'],
  support: ['SUPPORT', 'ช่วยเหลือ'],
  helpForum: ['help', 'ถามตอบ'],
  showcase: ['showcase', 'ผลงาน'],
  moderator: ['Moderator', 'ผู้ดูแล'],
  member: ['Member', 'สมาชิก'],
  teacher: ['Teacher', 'ครู'],
  student: ['Student', 'นักเรียน'],
  maintainer: ['Maintainer', 'ผู้ดูแลโปรเจกต์'],
  gamingName: ['Gaming community', 'คอมมูนิตี้เกม'],
  clubName: ['School club', 'ชมรม / ห้องเรียน'],
  friendsName: ['Friends', 'กลุ่มเพื่อน'],
  supportName: ['Open-source support', 'ชุมชนซัพพอร์ต']
};

const cat = (key, name) => ({ key, type: 'category', name });
const ch = (key, parent, type, name, extra = {}) => ({ key, parent, type, name, ...extra });
const readOnly = [{ role: 'everyone', allow: '0', deny: SEND }];

const TEMPLATE_DEFS = {
  gaming: {
    title: 'gamingName',
    roles: [['moderator', '#e67e22', MOD_PERMS, true], ['member', '#3498db', '0', false]],
    channels: [
      ['info'], ['welcome', 'info', 'text', readOnly], ['rules', 'info', 'text', readOnly], ['announcements', 'info', 'announcement', readOnly],
      ['chat'], ['general', 'chat', 'text'], ['lfg', 'chat', 'text'], ['clips', 'chat', 'text'],
      ['voice'], ['lounge', 'voice', 'voice'], ['squad1', 'voice', 'voice'], ['squad2', 'voice', 'voice'],
      ['events'], ['stage', 'events', 'stage']
    ],
    system: 'welcome', rulesChannel: 'rules'
  },
  club: {
    title: 'clubName',
    roles: [['teacher', '#9b59b6', MOD_PERMS, true], ['student', '#2ecc71', '0', true]],
    channels: [
      ['info'], ['welcome', 'info', 'text', readOnly], ['announcements', 'info', 'announcement', readOnly], ['rules', 'info', 'text', readOnly],
      ['study'], ['general', 'study', 'text'], ['homework', 'study', 'forum'], ['resources', 'study', 'text', readOnly],
      ['voice'], ['classroom', 'voice', 'stage'], ['studyRoom', 'voice', 'voice']
    ],
    system: 'welcome', rulesChannel: 'rules'
  },
  friends: {
    title: 'friendsName',
    roles: [],
    channels: [
      ['chat'], ['general', 'chat', 'text'], ['memes', 'chat', 'text'], ['plans', 'chat', 'text'],
      ['voice'], ['lounge', 'voice', 'voice']
    ],
    system: 'general'
  },
  support: {
    title: 'supportName',
    roles: [['maintainer', '#e74c3c', MOD_PERMS, true], ['member', '#95a5a6', '0', false]],
    channels: [
      ['info'], ['welcome', 'info', 'text', readOnly], ['announcements', 'info', 'announcement', readOnly], ['rules', 'info', 'text', readOnly],
      ['support'], ['helpForum', 'support', 'forum'], ['general', 'support', 'text'], ['showcase', 'support', 'text'],
      ['voice'], ['lounge', 'voice', 'voice']
    ],
    system: 'welcome', rulesChannel: 'rules'
  }
};

export const BUILTIN_TEMPLATE_KEYS = Object.freeze(Object.keys(TEMPLATE_DEFS));

/** Parse a reserved template code; null when the code is not a built-in. */
export function parseBuiltinCode(code) {
  const m = /^builtin-([a-z]+)(?:-([A-Za-z]{2,3}(?:-[A-Za-z]{2,4})?))?$/.exec(String(code ?? ''));
  if (!m || !TEMPLATE_DEFS[m[1]]) return null;
  return { key: m[1], lang: m[2] ?? null };
}

/**
 * The template data for a built-in, in the same shape snapshot() produces,
 * localised to `lang` (English fallback).
 */
export function builtinTemplateData(key, lang) {
  const def = TEMPLATE_DEFS[key];
  if (!def) return null;
  const idx = resolveLang(lang, { trustDefault: true }) === 'th' ? 1 : 0;
  const name = (k) => N[k]?.[idx] ?? N[k]?.[0] ?? k;
  const roles = [
    { key: 'everyone', name: '@everyone', color: null, position: 0, permissions: EVERYONE, hoist: false, mentionable: false, everyone: true },
    // Listed top-down; positions count up from the bottom.
    ...def.roles.map(([k, color, permissions, hoist], i) => ({
      key: `r_${k}`, name: name(k), color, position: def.roles.length - i, permissions, hoist, mentionable: false, everyone: false
    }))
  ];
  const channels = def.channels.map(([k, parent, type, overwrites], i) => (parent === undefined
    ? { ...cat(`c_${k}`, name(k)), position: i, overwrites: [], tags: [] }
    : {
        ...ch(`c_${k}`, `c_${parent}`, type, type === 'voice' || type === 'stage' ? name(k) : name(k).toLowerCase()),
        position: i,
        bitrate: type === 'voice' ? 64000 : null,
        overwrites: overwrites ?? [],
        tags: []
      }));
  return {
    version: 1,
    source: { name: name(def.title), icon_url: null },
    server: {},
    system_channel: def.system ? `c_${def.system}` : null,
    rules_channel: def.rulesChannel ? `c_${def.rulesChannel}` : null,
    afk_channel: null,
    roles,
    channels
  };
}
