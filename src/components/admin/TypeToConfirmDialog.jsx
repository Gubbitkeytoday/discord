import React, { useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useDialog } from '../settings/primitives';
import { t } from '../../i18n/index.jsx';

/**
 * "Type the server name to confirm" — the one guard used for every
 * irreversible delete of a whole server, wherever it is started from (the
 * server menu or Server Settings), so the two paths can never disagree.
 */
export default function TypeToConfirmDialog({ title, body, expected, confirmLabel, onConfirm, onClose }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const dialogRef = useDialog(() => { if (!busy) onClose(); });
  const matches = typed.trim() === String(expected ?? '').trim();

  const submit = async (e) => {
    e.preventDefault();
    if (!matches || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (err) {
      setError(err?.message ?? String(err));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 z-[90] flex items-center justify-center overlay-center p-4">
      <form
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="type-confirm-title"
        aria-describedby="type-confirm-body"
        onSubmit={submit}
        className="bg-d-canvas w-full max-w-md rounded-lg shadow-2xl border border-d-surface overflow-hidden"
      >
        <div className="p-5 space-y-3">
          <h2 id="type-confirm-title" className="text-lg font-bold text-d-strong flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-d-danger shrink-0" aria-hidden="true" />
            <span className="min-w-0 break-words">{title}</span>
          </h2>
          <p id="type-confirm-body" className="text-sm text-d-text2 leading-relaxed">{body}</p>
          <label className="block">
            <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">
              {t('settings.typeServerName', { name: expected })}
            </span>
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoFocus
              autoComplete="off"
              spellCheck={false}
              aria-invalid={typed.length > 0 && !matches}
              className="w-full bg-d-base text-sm text-d-strong px-3 py-2 rounded border border-d-edge focus:outline-none focus:border-d-danger"
            />
          </label>
          {error && <p className="text-xs text-d-danger" role="alert">{error}</p>}
        </div>
        <div className="bg-d-surface px-5 py-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            className="min-h-[36px] px-4 py-2 text-sm font-semibold text-d-strong hover:underline"
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={!matches || busy}
            className="min-h-[36px] px-4 py-2 rounded text-sm font-semibold text-white bg-d-danger hover:bg-red-600 disabled:opacity-40 flex items-center gap-2"
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
            {confirmLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
