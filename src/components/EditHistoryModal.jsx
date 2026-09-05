// ============================================================================
//  Edit history — what a message used to say.
//
//  Every edit has always written a `message_edits` row; this is the window that
//  reads them back. Newest first, with the live text at the top marked as
//  current, so the reader can follow a message backwards the way they read the
//  conversation forwards.
// ============================================================================

import React, { useEffect, useState } from 'react';
import { X, History, Loader2 } from 'lucide-react';
import { get } from '../api';
import { t } from '../i18n/index.jsx';
import { formatFullTimestamp } from '../utils/messageGrouping';

export default function EditHistoryModal({ message, onClose }) {
  const [state, setState] = useState({ loading: true, revisions: [], error: null });

  useEffect(() => {
    let cancelled = false;
    setState({ loading: true, revisions: [], error: null });
    get(`/api/messages/${message.id}/history`)
      .then((body) => { if (!cancelled) setState({ loading: false, revisions: body.revisions ?? [], error: null }); })
      .catch((err) => { if (!cancelled) setState({ loading: false, revisions: [], error: err.message }); });
    return () => { cancelled = true; };
  }, [message.id]);

  return (
    <div
      className="fixed inset-0 z-[80] bg-black/60 overlay-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={t('chat.editedHistory')}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-full max-w-lg rounded-xl bg-d-canvas border border-d-edge shadow-2xl overflow-hidden">
        <header className="flex items-center gap-2 px-4 py-3 border-b border-d-edge">
          <History className="w-4 h-4 text-d-text3" aria-hidden="true" />
          <h2 className="font-bold text-d-strong text-sm flex-1">{t('chat.editedHistory')}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-d-text3 hover:text-d-strong"
            aria-label={t('common.close')}
          >
            <X className="w-4 h-4" />
          </button>
        </header>

        <div className="max-h-[60vh] overflow-y-auto p-4 space-y-3">
          {state.loading && (
            <p className="text-sm text-d-text3 flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />{t('common.loading')}
            </p>
          )}
          {state.error && <p className="text-sm text-d-danger">{state.error}</p>}
          {!state.loading && !state.error && state.revisions.length <= 1 && (
            <p className="text-sm text-d-text3">{t('chat.noEditHistory')}</p>
          )}

          {state.revisions.map((revision) => (
            <article
              key={revision.id}
              className={`rounded-lg border p-3 ${revision.current
                ? 'border-d-brand/60 bg-d-brand/5'
                : 'border-d-edge bg-d-surface/40'}`}
            >
              <p className="text-[11px] uppercase tracking-wide text-d-text4 mb-1">
                {revision.current ? t('chat.editHistoryCurrent') : formatFullTimestamp(revision.edited_at)}
              </p>
              <p className="text-sm text-d-text whitespace-pre-wrap break-words">{revision.content}</p>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}
