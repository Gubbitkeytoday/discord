// ============================================================================
//  Guess the language of a message from its script, so the message body can
//  carry a `lang` attribute. Two things depend on it:
//    - screen readers switch voice (WCAG 3.1.2, language of parts), and
//    - CSS picks a CJK / Thai font per `:lang()` instead of whatever the OS
//      falls back to (Japanese Kanji rendered with a Chinese face, etc.).
//
//  Only scripts that identify a language (or a small family) are guessed.
//  Latin text returns null: "is this English or Indonesian?" cannot be told
//  from the script, and inheriting the page language is the honest answer.
// ============================================================================

const SCRIPTS = [
  // Kana first: Japanese mixes Kanji with kana, and any kana means Japanese.
  ['ja', /[぀-ヿㇰ-ㇿｦ-ﾟ]/g],
  ['ko', /[ᄀ-ᇿ㄰-㆏가-힯]/g],
  ['zh', /[㐀-䶿一-鿿豈-﫿]/g],
  ['th', /[฀-๿]/g],
  ['lo', /[຀-໿]/g],
  ['km', /[ក-៿]/g],
  ['my', /[က-႟]/g],
  ['hi', /[ऀ-ॿ]/g],
  ['bn', /[ঀ-৿]/g],
  ['ta', /[஀-௿]/g],
  ['ar', /[؀-ۿݐ-ݿ]/g],
  ['he', /[֐-׿]/g],
  ['el', /[Ͱ-Ͽ]/g],
  ['ru', /[Ѐ-ӿ]/g],
  ['ka', /[Ⴀ-ჿ]/g],
  ['hy', /[԰-֏]/g]
];

const LETTER = /\p{L}/gu;
const cache = new Map();

/** Strip what is not prose: code, links, tokens like <@123> and :emoji:. */
function prose(text) {
  return text
    .replace(/```[\s\S]*?```|`[^`\n]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/<a?:\w+:\d+>|<[@#][!&]?\d+>|:\w{2,32}:/g, ' ');
}

/**
 * BCP 47 code for the dominant script of `text`, or null when it is Latin,
 * mixed below the threshold, or too short to say.
 */
export function guessLang(text) {
  if (!text || typeof text !== 'string') return null;
  const cached = cache.get(text);
  if (cached !== undefined) return cached;

  const body = prose(text);
  const letters = (body.match(LETTER) ?? []).length;
  let result = null;
  if (letters > 0) {
    let kana = 0;
    let han = 0;
    for (const [code, pattern] of SCRIPTS) {
      const count = (body.match(pattern) ?? []).length;
      if (code === 'ja') { kana = count; continue; }
      if (code === 'zh') { han = count; continue; }
      if (count / letters >= 0.3) { result = code; break; }
    }
    if (!result) {
      if (kana > 0 && (kana + han) / letters >= 0.3) result = 'ja';
      else if (han / letters >= 0.3) result = 'zh';
    }
  }
  if (cache.size > 2000) cache.clear();
  cache.set(text, result);
  return result;
}
