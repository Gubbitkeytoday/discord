// ============================================================================
//  Text normalisation for AutoMod keyword matching.
//
//  A filter that compares raw text is beaten by one invisible character. Both
//  the message and every keyword are pushed through the same pipeline, and a
//  keyword matches when it appears in *any* of the message's variants:
//
//    base      NFKC, zero-width / format characters removed, lower-cased,
//              stacked Latin combining marks ("zalgo") stripped, runs of the
//              same Thai mark collapsed
//    joined    "f u c k", "ค ว ย", "f.u.c.k" → "fuck", "ควย" (only runs of
//              single letters are joined, so ordinary words are not glued
//              together into false positives)
//    leet      0→o 1→i 3→e 4→a 5→s 7→t @→a $→s …
//    squeezed  a letter repeated three or more times becomes one ("fuuuck")
//    thaiBare  Thai tone marks and the thanthakhat removed ("คว่ย" → "ควย")
//
//  Everything here is pure and synchronous; it runs on the message-send path.
// ============================================================================

// Zero-width and other invisible format characters used to split words.
const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠏​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/gu;
// Combining marks attached to Latin/Greek/Cyrillic letters. Thai, Lao and the
// Indic scripts use their own mark ranges and are deliberately not touched.
const LATIN_COMBINING = /[̀-ͯ҃-҉᪰-᫿᷀-᷿⃐-⃿︠-︯]/gu;
// Thai above/below vowels and tone marks: the same mark typed twice renders
// as one, so "ค่่่วย" is visually "ค่วย".
const THAI_MARK_RUN = /([ัิ-ฺ็-๎])\1+/gu;
// Tone marks (mai ek … mai chattawa), mai taikhu and thanthakhat.
const THAI_TONES = /[็-์]/gu;

const LEET = {
  0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', 9: 'g',
  '@': 'a', $: 's', '!': 'i', '|': 'i', '€': 'e', '£': 'l'
};

/** One "letter" = a base character plus any combining marks after it. */
const LETTER = '\\p{L}\\p{M}*|\\p{N}';
// Three or more single letters separated by spaces or punctuation.
const SPACED_RUN = new RegExp(`(?:^|(?<=[\\s]))((?:(?:${LETTER})[\\s._\\-*~+,'"\`/\\\\]+){2,}(?:${LETTER}))(?=$|[\\s])`, 'gu');

export function baseNormalize(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .replace(INVISIBLE, '')
    .toLowerCase()
    .normalize('NFD')
    .replace(LATIN_COMBINING, '')
    .normalize('NFC')
    .replace(THAI_MARK_RUN, '$1');
}

/** Join runs of single letters: "f u c k" → "fuck", "ค ว ย" → "ควย". */
export function joinSpacedLetters(text) {
  return text.replace(SPACED_RUN, (run) => run.replace(/[^\p{L}\p{M}\p{N}]+/gu, ''));
}

export function deLeet(text) {
  return text.replace(/[0-9@$!|€£]/g, (ch) => LEET[ch] ?? ch);
}

export function squeezeRepeats(text) {
  return text.replace(/(\p{L})\1{2,}/gu, '$1');
}

export function stripThaiTones(text) {
  return text.replace(THAI_TONES, '');
}

/**
 * Every variant of a text a keyword is compared against. Duplicates are
 * removed so a plain ASCII message costs one or two `includes` per keyword.
 */
export function variants(text, { allowList = [] } = {}) {
  let base = baseNormalize(text);
  // Allow-listed terms are removed before matching, so "scunthorpe" can be
  // allowed while "cunt" stays blocked.
  for (const term of allowList) {
    const clean = baseNormalize(term).trim();
    if (clean) base = base.split(clean).join(' ');
  }
  const joined = joinSpacedLetters(base);
  const out = new Set([base, joined]);
  for (const v of [base, joined]) {
    out.add(deLeet(v));
    out.add(squeezeRepeats(v));
    out.add(squeezeRepeats(deLeet(v)));
  }
  for (const v of [...out]) out.add(stripThaiTones(v));
  return [...out];
}

/** A keyword's own normal forms (a keyword can itself contain Thai tones). */
export function keywordForms(keyword) {
  const base = baseNormalize(keyword).trim();
  if (!base) return [];
  return [...new Set([base, stripThaiTones(base)])].filter(Boolean);
}

/**
 * The first keyword found in the text, or null. `keywords` are raw strings;
 * `allowList` terms are ignored wherever they occur.
 */
export function findKeyword(text, keywords, { allowList = [] } = {}) {
  if (!keywords?.length) return null;
  const haystacks = variants(text, { allowList });
  for (const keyword of keywords) {
    for (const form of keywordForms(keyword)) {
      if (haystacks.some((h) => h.includes(form))) return String(keyword);
    }
  }
  return null;
}
