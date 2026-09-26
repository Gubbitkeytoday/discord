// ============================================================================
//  Message translation, client side.
//
//  Privacy-first order:
//    1. The browser's own on-device Translator API (+ LanguageDetector), when
//       present — the message never leaves the device.
//    2. POST /api/translate — the server's configured providers
//       (self-hosted LibreTranslate first), for a stored message only.
//
//  Per-message state lives in a tiny external store so the hover-bar
//  <TranslateButton> and the <TranslatedText> under the message body stay
//  in sync without threading props through ChatArea.
// ============================================================================

import { useSyncExternalStore } from 'react';
import { get, post } from '../api';
import { currentLocaleCode } from '../i18n/index.jsx';
import { getPreferences } from '../hooks/useUserSettings';
import {
  segmentMessage, translateSegments, guessLanguage, primaryLang, normalizeLang
} from '../../lib/translationMarkup.js';

// --- target language ------------------------------------------------------------

/** Settings › Chat › "Translate messages to"; '' means the app language. */
function preferredTarget() {
  try {
    const value = getPreferences()?.chat?.translateTarget;
    return typeof value === 'string' && value ? value : null;
  } catch { return null; }
}

/**
 * The reader's language as a translation target ('th', 'en', 'zh-Hant',
 * 'pt-BR'): the user's chosen target, else the UI language.
 */
export function targetLanguage(locale = preferredTarget() ?? currentLocaleCode()) {
  const tag = normalizeLang(locale) ?? 'en';
  if (/^zh-(TW|HK|MO|Hant)$/.test(tag)) return 'zh-Hant';
  if (tag.startsWith('zh')) return 'zh';
  if (tag === 'pt-BR' || tag === 'pt-PT') return tag;
  return primaryLang(tag);
}

// --- capability detection ---------------------------------------------------------

const hasBuiltinTranslator = () => 'Translator' in globalThis;
const hasBuiltinDetector = () => 'LanguageDetector' in globalThis;

const configCache = new Map();   // channelId -> Promise<config>

/** Server capabilities for a channel (cached per page load). */
export function getTranslationConfig(channelId = null) {
  const key = channelId ?? '';
  if (!configCache.has(key)) {
    const query = channelId ? `?channel_id=${encodeURIComponent(channelId)}` : '';
    configCache.set(key, get(`/api/translate/config${query}`).catch(() => ({
      enabled: false, client: { enabled: true }, server: { enabled: false, providers: [] }
    })));
  }
  return configCache.get(key);
}

/** Forget cached config (e.g. after a guild admin flips the switch). */
export function resetTranslationConfig() { configCache.clear(); }

/** Can this message be translated at all, and is it worth offering? */
export async function canOfferTranslation({ content, channelId }) {
  if (!segmentMessage(content).some((s) => s.kind === 'text')) return false;
  const target = targetLanguage();
  const guess = guessLanguage(content);
  if (guess.confident && guess.lang && primaryLang(guess.lang) === primaryLang(target)) return false;
  const cfg = await getTranslationConfig(channelId);
  const builtin = cfg.client?.enabled !== false && hasBuiltinTranslator();
  return Boolean(builtin || cfg.server?.enabled);
}

// --- on-device translation ----------------------------------------------------------

async function detectOnDevice(text) {
  if (hasBuiltinDetector()) {
    try {
      const detector = await globalThis.LanguageDetector.create();
      const [top] = await detector.detect(text);
      detector.destroy?.();
      if (top?.detectedLanguage && top.detectedLanguage !== 'und' && (top.confidence ?? 0) >= 0.5) {
        return top.detectedLanguage;
      }
    } catch { /* fall through to the heuristic */ }
  }
  const guess = guessLanguage(text);
  return guess.lang;
}

const translators = new Map();   // "src>dst" -> Promise<Translator>

async function onDevice(content, target) {
  if (!hasBuiltinTranslator()) return null;
  const segments = segmentMessage(content);
  const prose = segments.filter((s) => s.kind === 'text').map((s) => s.text).join('\n');
  const source = await detectOnDevice(prose);
  if (!source) return null;
  const sourceLanguage = primaryLang(source);
  const targetLanguage = primaryLang(target);
  if (sourceLanguage === targetLanguage) {
    return { translated: content, sourceLang: sourceLanguage, provider: 'device', sameLanguage: true };
  }
  const pair = { sourceLanguage, targetLanguage };
  let availability;
  try { availability = await globalThis.Translator.availability(pair); } catch { return null; }
  if (!availability || availability === 'unavailable') return null;

  const key = `${sourceLanguage}>${targetLanguage}`;
  if (!translators.has(key)) {
    // Creating may download a language pack; it must happen inside the click
    // (user activation), which is where translateMessage() is called from.
    translators.set(key, globalThis.Translator.create(pair).catch((err) => { translators.delete(key); throw err; }));
  }
  const translator = await translators.get(key);
  const { text } = await translateSegments(segments, async (strings) => ({
    texts: await Promise.all(strings.map((s) => translator.translate(s)))
  }));
  return { translated: text, sourceLang: sourceLanguage, provider: 'device', sameLanguage: false };
}

// --- store ---------------------------------------------------------------------

const states = new Map();        // messageId -> state
const listeners = new Set();
const IDLE = Object.freeze({ status: 'idle', showing: false });

function setState(messageId, next) {
  states.set(messageId, next);
  for (const listener of listeners) listener();
}
const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };

/** React hook: this message's translation state. */
export function useTranslationState(messageId) {
  return useSyncExternalStore(subscribe, () => states.get(messageId) ?? IDLE, () => IDLE);
}

/**
 * Translate (or re-show) a message. `message` needs { id, content,
 * channel_id }. On-device first; the server only when the browser cannot.
 */
export async function translateMessage(message) {
  const target = targetLanguage();
  const current = states.get(message.id);
  if (current?.status === 'done' && current.content === message.content && current.target === target) {
    setState(message.id, { ...current, showing: true });
    return;
  }
  setState(message.id, { status: 'loading', showing: true, content: message.content, target });
  try {
    const cfg = await getTranslationConfig(message.channel_id);
    let result = cfg.client?.enabled === false ? null : await onDevice(message.content, target).catch(() => null);
    if (!result) {
      if (!cfg.server?.enabled) throw Object.assign(new Error('unavailable'), { code: 'TRANSLATION_UNAVAILABLE' });
      const data = await post('/api/translate', { messageId: message.id, targetLang: target });
      result = {
        translated: data.translated, sourceLang: data.source_lang,
        provider: data.provider, sameLanguage: data.same_language
      };
    }
    setState(message.id, { status: 'done', showing: true, content: message.content, target, ...result });
  } catch (err) {
    setState(message.id, {
      status: 'error', showing: true, content: message.content, target,
      error: err?.message ?? 'failed', code: err?.code ?? null
    });
  }
}

export function hideTranslation(messageId) {
  const current = states.get(messageId);
  if (current) setState(messageId, { ...current, showing: false });
}

export function toggleTranslation(message) {
  const current = states.get(message.id);
  if (current?.showing) hideTranslation(message.id);
  else translateMessage(message);
}
