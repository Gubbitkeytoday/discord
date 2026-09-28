// ============================================================================
//  Split a name into emoji and text runs.
//
//  Gradient names paint their text with `background-clip: text` and a
//  transparent fill. A colour emoji inside such a span is drawn with that
//  transparent fill too, so it turns into a gradient-shaped blob (or vanishes)
//  instead of keeping its own colours. Callers render emoji runs outside the
//  clipped span; text runs keep the gradient.
// ============================================================================

// One grapheme is an emoji if it has a pictograph, a flag half or a keycap.
const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;

let segmenter = null;
function graphemes(text) {
  try {
    segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return Array.from(segmenter.segment(text), (s) => s.segment);
  } catch {
    // Without Intl.Segmenter: code points, keeping joiners, variation
    // selectors and skin tones attached to the emoji before them.
    const out = [];
    for (const ch of Array.from(text)) {
      if (out.length && /[‍️⃣\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]/u.test(ch)) out[out.length - 1] += ch;
      else if (out.length && out[out.length - 1].endsWith('‍')) out[out.length - 1] += ch;
      else out.push(ch);
    }
    return out;
  }
}

/**
 * `text` as [{ text, emoji }] runs, adjacent graphemes of the same kind
 * merged. A string with no emoji is one text run.
 */
export function emojiRuns(text) {
  const value = String(text ?? '');
  if (!EMOJI.test(value)) return [{ text: value, emoji: false }];
  const runs = [];
  for (const g of graphemes(value)) {
    const emoji = EMOJI.test(g);
    const last = runs[runs.length - 1];
    if (last && last.emoji === emoji) last.text += g;
    else runs.push({ text: g, emoji });
  }
  return runs;
}

export const hasEmoji = (text) => EMOJI.test(String(text ?? ''));
