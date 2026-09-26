import React, { Component } from 'react';
import { AlertTriangle, RotateCcw, RefreshCw, X } from 'lucide-react';
import { t } from '../i18n/index.jsx';

/**
 * Render errors used to blank the whole app: one bad message, a malformed
 * embed or a settings page that threw, and React unmounted everything. These
 * boundaries keep the damage to the region that failed and offer a way out.
 *
 *   variant="app"     full-screen fallback (last line of defence, main.jsx)
 *   variant="region"  fills the region it replaces (sidebar, chat, members)
 *   variant="modal"   a small dialog in place of the dialog that crashed;
 *                     "Close" calls `onDismiss` so the parent can drop it
 *
 * `resetKeys`: when any of these change (e.g. the open channel), a failed
 * boundary tries rendering its children again, as Discord does when you
 * switch away from a broken channel.
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, keys: props.resetKeys ?? [] };
    this.reset = this.reset.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  static getDerivedStateFromProps(props, state) {
    const next = props.resetKeys ?? [];
    const changed = next.length !== state.keys.length || next.some((k, i) => !Object.is(k, state.keys[i]));
    if (!changed) return null;
    return state.error ? { error: null, keys: next } : { keys: next };
  }

  componentDidCatch(error, info) {
    console.error(`[${this.props.region ?? 'app'}] render error:`, error, info?.componentStack);
    this.props.onError?.(error);
  }

  reset() {
    this.setState({ error: null });
    this.props.onReset?.();
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const { variant = 'region', region = 'app', onDismiss, className } = this.props;
    return (
      <ErrorFallback
        className={className}
        variant={variant}
        region={region}
        error={error}
        onRetry={this.reset}
        onDismiss={onDismiss ? () => { this.setState({ error: null }); onDismiss(); } : null}
      />
    );
  }
}

function reloadPage() {
  window.location.reload();
}

export function ErrorFallback({ variant, region, error, onRetry, onDismiss, className }) {
  const detail = import.meta.env?.DEV ? String(error?.message ?? error) : null;
  const actions = (
    <div className="flex flex-wrap items-center justify-center gap-2 mt-4">
      <button
        type="button"
        onClick={onRetry}
        className="bg-d-brand hover:bg-d-brandhover text-white text-sm font-semibold px-4 py-2 rounded flex items-center gap-2 transition-colors"
      >
        <RotateCcw className="w-4 h-4" aria-hidden="true" /> {t('errorBoundary.tryAgain')}
      </button>
      <button
        type="button"
        onClick={reloadPage}
        className="bg-d-control2 hover:bg-d-control text-d-strong text-sm font-semibold px-4 py-2 rounded flex items-center gap-2 transition-colors"
      >
        <RefreshCw className="w-4 h-4" aria-hidden="true" /> {t('errorBoundary.reload')}
      </button>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="text-d-text2 hover:text-d-strong hover:underline text-sm px-2 py-2 flex items-center gap-1"
        >
          <X className="w-4 h-4" aria-hidden="true" /> {t('common.close')}
        </button>
      )}
    </div>
  );
  const body = (
    <>
      <AlertTriangle className={`${variant === 'app' ? 'w-12 h-12' : 'w-8 h-8'} text-d-idle mx-auto`} aria-hidden="true" />
      <h2 className={`${variant === 'app' ? 'text-xl' : 'text-base'} font-bold text-d-strong mt-3`}>
        {variant === 'app' ? t('errorBoundary.appTitle') : t('errorBoundary.regionTitle')}
      </h2>
      <p className="text-sm text-d-text2 mt-1 max-w-sm mx-auto">
        {variant === 'app' ? t('errorBoundary.appHint') : t('errorBoundary.regionHint')}
      </p>
      {detail && <pre className="mt-3 text-[11px] text-d-text3 whitespace-pre-wrap break-words max-w-md mx-auto">{detail}</pre>}
      {actions}
    </>
  );

  if (variant === 'app') {
    return (
      <div role="alert" data-error-boundary={region} className="fixed inset-0 bg-d-base flex items-center justify-center p-6 text-center">
        <div>{body}</div>
      </div>
    );
  }
  if (variant === 'modal') {
    return (
      <div className="fixed inset-0 z-[100] bg-black/60 flex items-center justify-center p-4" data-error-boundary={region}>
        <div role="alertdialog" aria-modal="true" aria-labelledby="error-boundary-title" className="bg-d-canvas rounded-lg shadow-2xl p-6 text-center max-w-md w-full">
          <span id="error-boundary-title" className="sr-only">{t('errorBoundary.regionTitle')}</span>
          {body}
        </div>
      </div>
    );
  }
  return (
    <div role="alert" data-error-boundary={region} className={className ?? 'flex-1 min-w-0 min-h-0 flex items-center justify-center p-6 text-center bg-d-base'}>
      <div>{body}</div>
    </div>
  );
}
