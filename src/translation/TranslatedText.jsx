import React, { useEffect } from 'react';
import { Languages } from 'lucide-react';
import { t, localeTag } from '../i18n/index.jsx';
import { useTranslationState, translateMessage, hideTranslation } from './translationClient';

const PROVIDER_NAMES = { libretranslate: 'LibreTranslate', deepl: 'DeepL', anthropic: 'Claude' };

function languageName(code) {
  if (!code) return null;
  try { return new Intl.DisplayNames([localeTag()], { type: 'language' }).of(code); } catch { return code; }
}

/**
 * The translation, rendered under the original message body while it is
 * toggled on. `render(text)` should be the same Markdown renderer the message
 * body uses, so mentions, emoji and code render identically; it defaults to
 * plain text.
 */
export default function TranslatedText({ message, render = (text) => text }) {
  const state = useTranslationState(message.id);

  // An edit arrives while the translation is showing: translate the new text.
  useEffect(() => {
    if (state.showing && state.status !== 'loading' && state.content !== undefined && state.content !== message.content) {
      translateMessage(message);
    }
  }, [message, state.showing, state.status, state.content]);

  if (!state.showing) return null;

  if (state.status === 'loading') {
    return <p className="mt-1 text-xs text-d-text3 italic" role="status">{t('translate.translating')}</p>;
  }
  if (state.status === 'error') {
    return (
      <p className="mt-1 text-xs text-d-danger" role="alert">
        {state.code && t(`apiError.${state.code}`) !== `apiError.${state.code}`
          ? t(`apiError.${state.code}`)
          : t('translate.failed')}
        {' '}
        <button type="button" onClick={() => hideTranslation(message.id)} className="underline text-d-text3">
          {t('translate.showOriginal')}
        </button>
      </p>
    );
  }
  if (state.sameLanguage) {
    return <p className="mt-1 text-xs text-d-text3">{t('translate.sameLanguage')}</p>;
  }

  const from = languageName(state.sourceLang);
  const via = state.provider === 'device'
    ? t('translate.onDevice')
    : t('translate.via', { provider: PROVIDER_NAMES[state.provider] ?? state.provider });
  return (
    <div className="mt-1 border-l-2 border-d-brand/60 pl-2" lang={state.target}>
      <div className="message-body text-d-text leading-relaxed whitespace-pre-wrap break-words">
        {render(state.translated)}
      </div>
      <p className="text-[10px] text-d-text3 flex items-center gap-1 mt-0.5">
        <Languages className="w-3 h-3" aria-hidden="true" />
        {from ? t('translate.translatedFrom', { lang: from }) : t('translate.translated')} · {via}
        {' · '}
        <button type="button" onClick={() => hideTranslation(message.id)} className="hover:underline">
          {t('translate.showOriginal')}
        </button>
      </p>
    </div>
  );
}
