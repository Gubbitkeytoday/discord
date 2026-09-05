import React, { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { t } from '../i18n/index.jsx';

/**
 * In-app replacement for window.confirm(). Discord never uses native dialogs;
 * a red confirm button plus an optional reason field covers kick/ban/delete.
 */
export default function ConfirmModal({
  title,
  body,
  confirmLabel,
  cancelLabel,
  danger = true,
  withReason = false,
  reasonLabel,
  onConfirm,
  onClose
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const dialogRef = useFocusTrap(true, onClose);

  const submit = async (e) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onConfirm?.(withReason ? reason.trim() || null : undefined);
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 z-[70] flex items-center justify-center overlay-center p-4">
      <form
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        onSubmit={submit}
        className="bg-d-canvas w-full max-w-md rounded-lg shadow-2xl border border-d-surface overflow-hidden"
      >
        <div className="p-5 space-y-3">
          <h2 className="text-lg font-bold text-d-strong">{title}</h2>
          {body && <p className="text-sm text-d-text2 leading-relaxed whitespace-pre-wrap">{body}</p>}
          {withReason && (
            <label className="block">
              <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">
                {reasonLabel ?? t('common.reason')}
              </span>
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={512}
                autoFocus
                className="w-full bg-d-base text-sm text-d-strong px-3 py-2 rounded border border-d-edge focus:outline-none focus:border-d-brand"
              />
            </label>
          )}
          {error && <p className="text-xs text-d-danger">{error}</p>}
        </div>
        <div className="bg-d-surface px-5 py-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="px-4 py-2 text-sm font-semibold text-d-strong hover:underline"
          >
            {cancelLabel ?? t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={busy}
            autoFocus={!withReason}
            className={`px-5 py-2 rounded text-sm font-semibold text-white flex items-center gap-2 transition-colors disabled:opacity-60 ${
              danger ? 'bg-d-danger hover:bg-red-600' : 'bg-d-brand hover:bg-d-brandhover'
            }`}
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            {confirmLabel ?? t('common.confirm')}
          </button>
        </div>
      </form>
    </div>
  );
}
