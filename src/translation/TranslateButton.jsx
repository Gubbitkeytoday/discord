import React, { useEffect, useState } from 'react';
import { Languages, Loader2 } from 'lucide-react';
import { t } from '../i18n/index.jsx';
import { canOfferTranslation, toggleTranslation, useTranslationState } from './translationClient';

/**
 * Hover-bar button: "Translate" / "Show original". Renders nothing when the
 * message is already in the reader's language, has no prose, or neither the
 * browser nor the server can translate.
 */
export default function TranslateButton({ message, className = '', onDone }) {
  const [offer, setOffer] = useState(false);
  const state = useTranslationState(message.id);

  useEffect(() => {
    let alive = true;
    canOfferTranslation({ content: message.content, channelId: message.channel_id })
      .then((ok) => { if (alive) setOffer(ok); })
      .catch(() => { if (alive) setOffer(false); });
    return () => { alive = false; };
  }, [message.content, message.channel_id]);

  if (!offer && !state.showing) return null;
  const label = state.showing ? t('translate.showOriginal') : t('translate.translate');
  return (
    <button
      type="button"
      onClick={() => { toggleTranslation(message); onDone?.(); }}
      className={className || 'p-1 hover:bg-d-hover text-d-text2 hover:text-d-strong rounded transition-colors'}
      title={label}
      aria-label={label}
      aria-pressed={state.showing}
    >
      {state.status === 'loading' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Languages className="w-4 h-4" />}
    </button>
  );
}
