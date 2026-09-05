import React, { useCallback, useEffect, useState } from 'react';
import { X, AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { t } from '../i18n/index.jsx';

const ICONS = {
  error: { Icon: AlertTriangle, tint: 'border-d-danger text-d-danger' },
  success: { Icon: CheckCircle2, tint: 'border-d-online text-d-online' },
  info: { Icon: Info, tint: 'border-d-brand text-d-mention' }
};

const DEFAULT_TTL_MS = 6000;

/**
 * Toast state hook. Replaces `alert()`, which blocks the whole tab and looks
 * nothing like Discord.
 */
export function useToasts() {
  const [toasts, setToasts] = useState([]);

  const dismiss = useCallback((id) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((message, { type = 'info', ttl = DEFAULT_TTL_MS } = {}) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    setToasts((prev) => [...prev, { id, message, type, ttl }]);
    return id;
  }, []);

  return { toasts, push, dismiss };
}

export default function ToastStack({ toasts, onDismiss }) {
  return (
    <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 w-80 pointer-events-none">
      {toasts.map((toast) => (
        <Toast key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function Toast({ toast, onDismiss }) {
  const { Icon, tint } = ICONS[toast.type] ?? ICONS.info;

  useEffect(() => {
    if (!toast.ttl) return undefined;
    const timer = setTimeout(() => onDismiss(toast.id), toast.ttl);
    return () => clearTimeout(timer);
  }, [toast, onDismiss]);

  return (
    <div
      role="status"
      className={`pointer-events-auto bg-d-surface border-l-4 ${tint} rounded-md shadow-2xl px-3 py-2.5 flex items-start gap-2.5 animate-[slideIn_150ms_ease-out]`}
    >
      <Icon className="w-4 h-4 shrink-0 mt-0.5" />
      <p className="text-xs text-d-text flex-1 whitespace-pre-wrap break-words">{toast.message}</p>
      <button
        onClick={() => onDismiss(toast.id)}
        className="text-d-text3 hover:text-d-strong transition-colors shrink-0"
        aria-label={t('error.dismiss')}
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}
