// ============================================================================
//  Message markup protection for machine translation.
//
//  Shared by the server (services/translation.js) and the browser
//  (src/translation/*), so it must stay dependency-free, pure ESM.
//
//  A chat message is Discord-flavoured Markdown. Only its prose should reach a
//  translator; everything else must come back byte-for-byte:
//    - fenced code blocks and inline code spans
//    - mentions <@id> <@!id> <@&id> <#id>, custom emoji <:n:id> <a:n:id>,
//      timestamps <t:123:R>, slash-command mentions </name:id>
//    - :shortcode: emoji, URLs (bare or <angle-bracketed>), masked-link targets
//    - paired formatting markers ** __ ~~ || and line prefixes (> # - 1.)
//
//  segmentMessage() splits the message into `keep` segments (copied through)
//  and `text` segments (translated). Inside a text segment, inline protected
//  tokens become numbered placeholders ⟦0⟧ ⟦1⟧ … so the translator still sees
//  the whole sentence. translateSegments() restores them, and if a translator
//  drops or mangles a placeholder it re-translates that segment piecewise
//  instead of guessing — a mention must never turn into plain text.
// ============================================================================

export const PLACEHOLDER_OPEN = '⟦';   // ⟦
export const PLACEHOLDER_CLOSE = '⟧';  // ⟧
const placeholder = (i) => `${PLACEHOLDER_OPEN}${i}${PLACEHOLDER_CLOSE}`;
const PLACEHOLDER_RE = /⟦\s*(\d{1,3})\s*⟧/g;

// Inline tokens protected inside a line, most specific first.
const INLINE_PATTERNS = [
  /`[^`\n]+`/y,                                   // inline code
  /<(?:@[!&]?|#)[\w-]{1,64}>/y,                   // user / role / channel mention
  /<a?:[A-Za-z0-9_~]{1,64}:[\w-]{1,64}>/y,        // custom emoji
  /<t:-?\d{1,13}(?::[tTdDfFR])?>/y,               // timestamp
  /<\/[\w -]{1,64}:\d{1,25}>/y,                   // slash-command mention
  /<https?:\/\/[^\s>]+>/y,                        // <suppressed-embed url>
  /\]\((?:https?:\/\/|\/)[^\s)]+\)/y,             // masked-link target "](url)"
  /https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"]/y,      // bare url
  /:[A-Za-z0-9_+-]{1,64}:/y,                      // :shortcode: emoji
  /@(?:everyone|here)\b/y,                        // mass mentions
  /\*\*|__|~~|\|\|/y                              // paired formatting markers
];

// A line's structural prefix: block quote, heading, subtext, list bullet.
const LINE_PREFIX = /^(\s*(?:>>>\s|>\s|#{1,3}\s|-#\s|[-*+]\s|\d{1,3}[.)]\s)*)/;

const LETTER = /\p{L}/u;

/** True when a string has anything a translator could act on. */
export function hasProse(text) {
  return LETTER.test(String(text ?? '').replace(PLACEHOLDER_RE, ''));
}

function segmentLine(line, out) {
  const prefix = LINE_PREFIX.exec(line)?.[1] ?? '';
  if (prefix) out.push({ kind: 'keep', text: prefix });
  let rest = line.slice(prefix.length);

  // Leading/trailing whitespace stays outside the translated text.
  const lead = /^\s*/.exec(rest)[0];
  const trail = /\s*$/.exec(rest.slice(lead.length))[0];
  if (lead) out.push({ kind: 'keep', text: lead });
  rest = rest.slice(lead.length, rest.length - trail.length);

  if (rest) {
    const tokens = [];
    let text = '';
    let i = 0;
    outer: while (i < rest.length) {
      for (const re of INLINE_PATTERNS) {
        re.lastIndex = i;
        const m = re.exec(rest);
        if (m && m[0].length > 0) {
          text += placeholder(tokens.length);
          tokens.push(m[0]);
          i += m[0].length;
          continue outer;
        }
      }
      text += rest[i];
      i += 1;
    }
    if (hasProse(text)) out.push({ kind: 'text', text, tokens });
    else out.push({ kind: 'keep', text: rest });
  }
  if (trail) out.push({ kind: 'keep', text: trail });
}

/**
 * Split `content` into [{ kind: 'keep', text }] and
 * [{ kind: 'text', text, tokens }] segments. Joining every segment's original
 * text (placeholders expanded) gives back `content` exactly.
 */
export function segmentMessage(content) {
  const source = String(content ?? '');
  const out = [];
  // Fenced code blocks are opaque, newlines and all.
  const fence = /```[\s\S]*?```/g;
  let last = 0;
  const pushProse = (chunk) => {
    const lines = chunk.split('\n');
    lines.forEach((line, index) => {
      if (index > 0) out.push({ kind: 'keep', text: '\n' });
      if (line) segmentLine(line, out);
    });
  };
  for (const m of source.matchAll(fence)) {
    if (m.index > last) pushProse(source.slice(last, m.index));
    out.push({ kind: 'keep', text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < source.length) pushProse(source.slice(last));
  return out;
}

/** Inverse of segmentMessage (with original text segments). */
export function joinSegments(segments) {
  return segments.map((s) => (s.kind === 'text' ? restorePlaceholders(s.text, s.tokens) : s.text)).join('');
}

/**
 * Put the protected tokens back. Returns null when the translation lost,
 * duplicated or invented a placeholder — the caller then falls back.
 */
export function restorePlaceholders(translated, tokens) {
  const seen = new Set();
  let ok = true;
  const restored = String(translated ?? '').replace(PLACEHOLDER_RE, (_, n) => {
    const index = Number(n);
    if (index >= tokens.length || seen.has(index)) { ok = false; return ''; }
    seen.add(index);
    return tokens[index];
  });
  if (!ok || seen.size !== tokens.length) return null;
  return restored;
}

/** Split a text segment at its placeholders: prose pieces + tokens between. */
function splitAtPlaceholders(segment) {
  const parts = [];
  let last = 0;
  for (const m of segment.text.matchAll(PLACEHOLDER_RE)) {
    if (m.index > last) parts.push({ prose: segment.text.slice(last, m.index) });
    parts.push({ token: segment.tokens[Number(m[1])] });
    last = m.index + m[0].length;
  }
  if (last < segment.text.length) parts.push({ prose: segment.text.slice(last) });
  return parts;
}

/**
 * Translate a message's prose, keeping its markup.
 *
 * `translateBatch(strings) → Promise<{ texts: string[], sourceLang?: string }>`
 * translates an array in one call (every provider supports batching).
 * Returns { text, sourceLang, translatedSegments }.
 */
export async function translateSegments(segments, translateBatch) {
  const textSegments = segments.filter((s) => s.kind === 'text');
  if (textSegments.length === 0) {
    return { text: joinSegments(segments), sourceLang: null, translatedSegments: 0 };
  }
  const first = await translateBatch(textSegments.map((s) => s.text));
  if (!Array.isArray(first?.texts) || first.texts.length !== textSegments.length) {
    throw new Error('translator returned the wrong number of strings');
  }

  const results = new Map();
  const retry = [];
  textSegments.forEach((segment, i) => {
    const restored = restorePlaceholders(first.texts[i], segment.tokens);
    if (restored !== null) results.set(segment, restored);
    else retry.push(segment);
  });

  // Placeholder damage: translate the prose between tokens separately.
  if (retry.length > 0) {
    const pieces = retry.map(splitAtPlaceholders);
    const prose = [];
    for (const parts of pieces) {
      for (const part of parts) if (part.prose !== undefined && hasProse(part.prose)) prose.push(part.prose);
    }
    const second = prose.length ? await translateBatch(prose) : { texts: [] };
    if (!Array.isArray(second?.texts) || second.texts.length !== prose.length) {
      throw new Error('translator returned the wrong number of strings');
    }
    let k = 0;
    retry.forEach((segment, i) => {
      results.set(segment, pieces[i].map((part) => {
        if (part.token !== undefined) return part.token;
        if (!hasProse(part.prose)) return part.prose;
        // Keep the prose piece's own edge spacing around the tokens.
        const lead = /^\s*/.exec(part.prose)[0];
        const trail = /\s*$/.exec(part.prose)[0];
        const translated = String(second.texts[k++] ?? '').trim();
        return `${lead}${translated}${trail}`;
      }).join(''));
    });
  }

  const text = segments.map((s) => (s.kind === 'text' ? results.get(s) : s.text)).join('');
  return { text, sourceLang: first.sourceLang ?? null, translatedSegments: textSegments.length };
}

// --- languages ------------------------------------------------------------------

const LANG_TAG = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i;

/** Canonical BCP-47-ish tag ('en', 'pt-BR', 'zh-Hant'), or null if invalid. */
export function normalizeLang(tag) {
  const value = String(tag ?? '').trim().replace('_', '-');
  if (!LANG_TAG.test(value)) return null;
  const [lang, region] = value.split('-');
  if (!region) return lang.toLowerCase();
  const sub = region.length === 4
    ? region[0].toUpperCase() + region.slice(1).toLowerCase()
    : region.toUpperCase();
  return `${lang.toLowerCase()}-${sub}`;
}

export const primaryLang = (tag) => String(tag ?? '').split('-')[0].toLowerCase();

// Tiny stop-word lists for telling Latin-script languages apart well enough
// to hide a pointless "Translate" button. Not a detector — a hint.
const STOPWORDS = {
  en: ['the', 'and', 'is', 'are', 'you', 'to', 'of', 'it', 'that', 'this', 'what', 'for', 'with', 'have', 'not', 'was', 'i', 'my', 'we', 'be'],
  es: ['el', 'la', 'los', 'las', 'que', 'es', 'y', 'de', 'por', 'para', 'con', 'una', 'pero', 'como', 'muy'],
  fr: ['le', 'la', 'les', 'est', 'et', 'de', 'des', 'une', 'pour', 'pas', 'que', 'je', 'vous', 'avec', 'mais'],
  de: ['der', 'die', 'das', 'und', 'ist', 'nicht', 'ich', 'mit', 'ein', 'eine', 'zu', 'auf', 'aber', 'wie'],
  pt: ['o', 'os', 'que', 'é', 'e', 'de', 'para', 'com', 'uma', 'não', 'mas', 'você', 'muito'],
  id: ['yang', 'dan', 'ini', 'itu', 'dengan', 'untuk', 'tidak', 'saya', 'kamu', 'ada', 'akan'],
  vi: ['và', 'của', 'là', 'không', 'có', 'được', 'này', 'cho', 'một', 'những', 'tôi', 'bạn']
};

/**
 * Best-effort language guess from the text alone: script ranges decide most
 * non-Latin languages outright, stop words give a weak hint for Latin ones.
 * Returns { lang, confident } — lang null when there is no useful guess.
 */
export function guessLanguage(content) {
  const prose = segmentMessage(content)
    .filter((s) => s.kind === 'text')
    .map((s) => s.text.replace(PLACEHOLDER_RE, ' '))
    .join(' ');
  const letters = [...prose].filter((ch) => LETTER.test(ch));
  if (letters.length === 0) return { lang: null, confident: false };
  const count = (re) => letters.filter((ch) => re.test(ch)).length;
  const share = (n) => n / letters.length;

  const thai = count(/[฀-๿]/u);
  if (share(thai) > 0.5) return { lang: 'th', confident: true };
  const kana = count(/[぀-ヿ]/u);
  if (kana > 0 && share(kana + count(/\p{Script=Han}/u)) > 0.5) return { lang: 'ja', confident: true };
  const hangul = count(/\p{Script=Hangul}/u);
  if (share(hangul) > 0.5) return { lang: 'ko', confident: true };
  const han = count(/\p{Script=Han}/u);
  if (share(han) > 0.5) return { lang: 'zh', confident: true };
  const scripts = [
    ['ar', /\p{Script=Arabic}/u], ['he', /\p{Script=Hebrew}/u], ['hi', /\p{Script=Devanagari}/u],
    ['el', /\p{Script=Greek}/u], ['ru', /\p{Script=Cyrillic}/u], ['lo', /\p{Script=Lao}/u],
    ['km', /\p{Script=Khmer}/u], ['my', /\p{Script=Myanmar}/u]
  ];
  for (const [lang, re] of scripts) {
    // Several languages share Cyrillic / Arabic script: a guess, not certain.
    if (share(count(re)) > 0.5) return { lang, confident: !['ru', 'ar'].includes(lang) };
  }
  const latin = count(/\p{Script=Latin}/u);
  if (share(latin) > 0.5) {
    const words = prose.toLowerCase().split(/[^\p{L}\p{M}']+/u).filter(Boolean);
    let best = null;
    let bestHits = 0;
    for (const [lang, list] of Object.entries(STOPWORDS)) {
      const hits = words.filter((w) => list.includes(w)).length;
      if (hits > bestHits) { best = lang; bestHits = hits; }
    }
    const confident = bestHits >= 2 && bestHits / Math.max(1, words.length) >= 0.15;
    return { lang: best, confident };
  }
  return { lang: null, confident: false };
}
