import React, { useEffect, useRef } from 'react';
import { Home } from 'lucide-react';
import { t } from '../i18n/index.jsx';
import EmptyState from './ui/EmptyState.jsx';

/**
 * What an address the app does not know shows: a plain "nothing here" with a
 * way home — instead of quietly rendering Home under the wrong URL. The URL
 * stays as typed, so it can be corrected or reported.
 */
export default function NotFoundView({ onGoHome, onOpenMobileSidebar }) {
  const headingRef = useRef(null);
  useEffect(() => { headingRef.current?.focus({ preventScroll: true }); }, []);
  return (
    <section
      className="flex-1 min-w-0 min-h-0 bg-d-canvas flex flex-col items-center justify-center p-6 text-center"
      aria-labelledby="not-found-title"
      data-testid="not-found"
    >
      <EmptyState art="search" title={null} body={null} />
      <h1 id="not-found-title" ref={headingRef} tabIndex={-1} className="text-2xl font-extrabold text-d-strong mt-2 outline-none">
        {t('notFound.title')}
      </h1>
      <p className="text-sm text-d-text2 mt-2 max-w-md break-words">{t('notFound.body')}</p>
      <p className="text-xs text-d-text3 mt-1 font-mono break-all max-w-md">{typeof window !== 'undefined' ? window.location.pathname : ''}</p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        <button
          type="button"
          onClick={onGoHome}
          className="min-h-10 pointer-coarse:min-h-11 px-4 rounded-md bg-d-brand hover:bg-d-brandhover text-white text-sm font-semibold inline-flex items-center gap-2"
        >
          <Home className="w-4 h-4" aria-hidden="true" />
          {t('notFound.goHome')}
        </button>
        {onOpenMobileSidebar && (
          <button
            type="button"
            onClick={onOpenMobileSidebar}
            className="md:hidden min-h-11 px-4 rounded-md bg-d-control2 hover:bg-d-control text-d-strong text-sm font-semibold"
          >
            {t('sidebar.openChannels')}
          </button>
        )}
      </div>
    </section>
  );
}
