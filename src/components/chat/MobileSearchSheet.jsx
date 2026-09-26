import React, { useState } from 'react';
import { ArrowLeft, Search } from 'lucide-react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useBackClose } from '../../chat/useBackClose';
import { t } from '../../i18n/index.jsx';

/** Full-screen search entry for phones. Results open in SearchResultsPanel. */
export default function MobileSearchSheet({ initial = '', onSubmit, onClose }) {
  const [term, setTerm] = useState(initial);
  const ref = useFocusTrap(true, onClose);
  useBackClose(true, onClose);
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label={t('chat.searchMessages')} className="fixed inset-0 z-50 bg-d-canvas flex flex-col pt-[env(safe-area-inset-top)]">
      <form
        role="search"
        onSubmit={(e) => { e.preventDefault(); if (term.trim()) onSubmit(term.trim()); }}
        className="h-14 px-2 flex items-center gap-2 border-b border-d-edge"
      >
        <button type="button" onClick={onClose} className="w-11 h-11 inline-flex items-center justify-center text-d-text2 hover:text-d-strong" aria-label={t('common.back')}>
          <ArrowLeft className="w-5 h-5" aria-hidden="true" />
        </button>
        <input
          type="search"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder={t('common.search')}
          aria-label={t('chat.searchMessages')}
          enterKeyHint="search"
          className="flex-1 min-w-0 bg-d-base text-base text-d-strong placeholder-d-text4 px-3 py-2 rounded-lg focus:outline-none focus:ring-2 focus:ring-d-brand"
        />
        <button type="submit" disabled={!term.trim()} className="w-11 h-11 inline-flex items-center justify-center text-d-text2 hover:text-d-strong disabled:opacity-40" aria-label={t('chat.searchMessages')}>
          <Search className="w-5 h-5" aria-hidden="true" />
        </button>
      </form>
      <p className="p-4 text-sm text-d-text3">{t('search.mobileHint')}</p>
    </div>
  );
}
