import React, { useCallback, useEffect, useRef, useState } from 'react';
import { X, AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { t } from '../i18n/index.jsx';
import { announce } from '../chat/announcer';

const ICONS = {
  error: { Icon: AlertTriangle, tint: 'border-d-danger text-d-danger' },
  success: { Icon: CheckCircle2, tint: 'border-d-online text-d-online' },
  info: { Icon: Info, tint: 'border-d-brand text-d-mention' }
};

// WCAG 2.2.1: long enough to read (and it pauses while hovered or focused);
// errors stay until dismissed, since they usually ask for an action.
const MIN_TTL_MS = 8000;

/**
 * Toast state hook. Replaces `alert()`, which blocks the whole tab and looks
 * nothing like Discord. Every toast is also spoken through the app's live
 * announcer (errors assertively), which screen readers announce reliably —
 * unlike a region that mounts together with its text.
 */
export function useToasts() {
  const [toasts, setToasts] = useState([]);

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback((message, { type = 'info', ttl } = {}) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const life = type === 'error' ? 0 : Math.max(ttl ?? MIN_TTL_MS, MIN_TTL_MS);
    setToasts((prev) => {
      // The same message twice in a row (a retry loop, a double click) is
      // one toast, not a stack of identical ones.
      const rest = prev.filter((toast) => toast.message !== message);
      return [...rest, { id, message, type, ttl: life }].slice(-5);
    });
    announce(message, { assertive: type === 'error' });
    return id;
  }, []);

  return { toasts, push, dismiss };
}

export default function ToastStack({ toasts, onDismiss }) {
  return (
    <section
      aria-label={t('toast.region')}
      data-focus-trap-ignore
      className="fixed z-[100] flex flex-col gap-2 pointer-events-none right-4 bottom-4 w-80 max-sm:inset-x-2 max-sm:w-auto max-sm:bottom-auto max-sm:top-[max(0.5rem,env(safe-area-inset-top))]"
    >
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </section>
  );
}

function Toast({ toast, onDismiss }) {
  const { Icon, tint } = ICONS[toast.type] ?? ICONS.info;
  const [paused, setPaused] = useState(false);
  const remaining = useRef(toast.ttl);
  const startedAt = useRef(0);

  useEffect(() => {
    if (!toast.ttl || paused) return undefined;
    startedAt.current = Date.now();
    const timer = setTimeout(() => onDismiss(toast.id), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current = Math.max(1500, remaining.current - (Date.now() - startedAt.current));
    };
  }, [toast.id, toast.ttl, paused, onDismiss]);

  return (
    <div
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setPaused(false); }}
      className={`pointer-events-auto bg-d-surface border-l-4 ${tint} rounded-md shadow-2xl pl-3 pr-1 py-1.5 flex items-start gap-2.5 animate-[slideIn_150ms_ease-out]`}
    >
      <Icon className="w-4 h-4 shrink-0 mt-2" aria-hidden="true" />
      <p className="text-sm text-d-text flex-1 whitespace-pre-wrap break-words py-1.5">{toast.message}</p>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        className="text-d-text3 hover:text-d-strong transition-colors shrink-0 w-8 h-8 pointer-coarse:w-11 pointer-coarse:h-11 inline-flex items-center justify-center rounded"
        aria-label={t('error.dismiss')}
      >
        <X className="w-4 h-4" aria-hidden="true" />
      </button>
    </div>
  );
}
