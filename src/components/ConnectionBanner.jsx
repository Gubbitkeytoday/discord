import React from 'react';
import { Loader2, WifiOff } from 'lucide-react';
import { t } from '../i18n/index.jsx';

/**
 * Discord's strip across the top of the window while the gateway is down.
 * A planned restart ('draining') gets the quiet version; a real drop says so
 * and offers "Retry now" so nobody has to sit out the backoff.
 */
export default function ConnectionBanner({ status, onRetry }) {
  const quiet = status === 'draining';
  const label = status === 'offline' ? t('connection.offline')
    : quiet ? t('connection.reconnecting')
    : t('connection.lost');
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="connection-banner"
      data-status={status}
      className={`fixed top-0 inset-x-0 z-[90] h-6 flex items-center justify-center gap-2 px-3 text-xs font-medium shadow ${
        quiet ? 'bg-d-surface text-d-text2 border-b border-d-edge' : 'bg-d-danger text-white'
      }`}
    >
      {status === 'offline'
        ? <WifiOff className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
        : <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin" aria-hidden="true" />}
      <span className="truncate">{label}</span>
      {!quiet && (
        <button
          type="button"
          onClick={onRetry}
          className="ml-1 underline underline-offset-2 hover:no-underline font-semibold shrink-0"
        >
          {t('connection.retry')}
        </button>
      )}
    </div>
  );
}
