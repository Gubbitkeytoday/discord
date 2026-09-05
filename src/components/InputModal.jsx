import React, { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { t } from '../i18n/index.jsx';

/**
 * In-app replacement for window.prompt(): one labelled text field with
 * validation, used for thread names, nicknames and group names.
 */
export default function InputModal({
  title,
  label,
  hint,
  initialValue = '',
  placeholder = '',
  maxLength = 100,
  allowEmpty = false,
  submitLabel,
  onSubmit,
  onClose
}) {
  const [value, setValue] = useState(initialValue);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const dialogRef = useFocusTrap(true, onClose);

  const submit = async (e) => {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed && !allowEmpty) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit?.(trimmed);
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
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onSubmit={submit}
        className="bg-d-canvas w-full max-w-md rounded-lg shadow-2xl border border-d-surface overflow-hidden"
      >
        <div className="p-5 space-y-3">
          <h2 className="text-lg font-bold text-d-strong">{title}</h2>
          <label className="block">
            <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">{label}</span>
            <input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={placeholder}
              maxLength={maxLength}
              autoFocus
              className="w-full bg-d-base text-sm text-d-strong px-3 py-2.5 rounded border border-d-edge focus:outline-none focus:border-d-brand"
            />
            <span className="block text-right text-[10px] text-d-text4 mt-1">{value.length}/{maxLength}</span>
          </label>
          {hint && <p className="text-xs text-d-text3">{hint}</p>}
          {error && <p className="text-xs text-d-danger">{error}</p>}
        </div>
        <div className="bg-d-surface px-5 py-3 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="px-4 py-2 text-sm font-semibold text-d-strong hover:underline">
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={busy || (!value.trim() && !allowEmpty)}
            className="px-5 py-2 rounded text-sm font-semibold text-white bg-d-brand hover:bg-d-brandhover flex items-center gap-2 disabled:opacity-50"
          >
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            {submitLabel ?? t('common.save')}
          </button>
        </div>
      </form>
    </div>
  );
}
