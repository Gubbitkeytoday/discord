// Text-to-speech through the browser's own speech synthesiser. No network, no
// model download — the same engine a screen reader uses.

export function isSpeechSupported() {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

/** Speak `text` at `rate`. Cancels anything already queued, as Discord does. */
export function speak(text, { rate = 1, lang, onEnd } = {}) {
  if (!isSpeechSupported() || !text) return false;
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(String(text).slice(0, 400));
    utterance.rate = Math.min(4, Math.max(0.1, Number(rate) || 1));
    if (lang) utterance.lang = lang;
    if (onEnd) {
      utterance.onend = onEnd;
      utterance.onerror = onEnd;
    }
    window.speechSynthesis.speak(utterance);
    return true;
  } catch {
    return false;
  }
}

export function cancelSpeech() {
  if (isSpeechSupported()) window.speechSynthesis.cancel();
}
