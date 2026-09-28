import React, { useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { Flag, Loader2, X, LifeBuoy } from 'lucide-react';
import { post } from '../../api';
import { t } from '../../i18n/index.jsx';
import { useDialog } from '../settings/primitives';
import { REPORT_REASONS, reasonLabel } from './safety';

/**
 * Report a message or a person.
 *
 * Categories instead of a blank box (a 14-year-old should not have to find
 * words for what happened), an optional details field, and "also block" ticked
 * by default. The copy says honestly who will read it:
 *   - a DM or a person      → the administrators of this instance;
 *   - a message in a server → that server's moderators, and for the serious
 *                             categories the instance administrators too.
 *
 * Props: target = { type: 'message' | 'user', id }, user (the person involved,
 * for "also block"), where = 'dm' | 'server' | 'user', onClose, onDone(result),
 * onBlocked(user), onToast.
 */
export default function ReportDialog({ target, user = null, where = 'server', onClose, onDone, onBlocked, onToast }) {
  const dialogRef = useDialog(onClose);
  const [reason, setReason] = useState(null);
  const [details, setDetails] = useState('');
  const [alsoBlock, setAlsoBlock] = useState(Boolean(user));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const titleId = useId();
  const name = user ? (user.display_name || user.username) : null;

  const submit = async (event) => {
    event.preventDefault();
    if (!reason) { setError(t('safety.pickReason')); return; }
    setBusy(true);
    setError(null);
    try {
      const report = await post('/api/reports', {
        target_type: target.type, target_id: target.id, reason, details: details.trim() || undefined
      });
      if (alsoBlock && user?.id) {
        try {
          const result = await post('/api/blocks', { targetId: user.id });
          onBlocked?.(result?.user ?? user);
          try { window.dispatchEvent(new CustomEvent('antigravity:blocked', { detail: result?.user ?? user })); } catch { /* old browser */ }
        } catch (err) {
          onToast?.(err.message, { type: 'error' });
        }
      }
      onToast?.(alsoBlock && user ? t('safety.reportedAndBlocked', { name }) : t('safety.reported'), { type: 'success', ttl: 4000 });
      onDone?.(report);
      onClose?.();
    } catch (err) {
      setError(err.code === 'ALREADY_REPORTED' ? t('safety.alreadyReported') : err.message);
    } finally {
      setBusy(false);
    }
  };

  const destination = where === 'server' ? t('safety.reportToServer') : t('safety.reportToAdmins');

  // Portalled to <body>: opened from inside other dialogs (a profile, a
  // settings pane with a transform) it must still cover the whole viewport.
  return createPortal(
    <div className="fixed inset-0 z-[80] flex items-center justify-center overlay-center bg-black/60 p-4">
      <form
        ref={dialogRef}
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[calc(100dvh-2rem)] w-full max-w-md flex-col overflow-hidden rounded-xl bg-d-canvas shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3 p-5 pb-3">
          <div className="min-w-0">
            <h2 id={titleId} className="flex items-center gap-2 text-lg font-bold text-d-strong">
              <Flag className="h-5 w-5 text-d-danger" aria-hidden="true" />
              {target.type === 'user' ? t('safety.reportUserTitle', { name: name ?? '' }) : t('safety.reportMessageTitle')}
            </h2>
            <p className="mt-1 text-sm text-d-text2 leading-relaxed">{destination}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="-mr-1 -mt-1 flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-d-text3 hover:bg-d-hover hover:text-d-strong"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 pb-2">
          <fieldset>
            <legend className="mb-2 text-xs font-bold uppercase tracking-wide text-d-text2">{t('safety.whatsWrong')}</legend>
            <div className="space-y-1.5">
              {REPORT_REASONS.map((key) => (
                <label
                  key={key}
                  className={`flex min-h-11 cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-sm transition-colors ${
                    reason === key ? 'border-d-brand bg-d-brand/10 text-d-strong' : 'border-d-divider bg-d-surface text-d-text hover:border-d-control'
                  }`}
                >
                  <input
                    type="radio"
                    name="report-reason"
                    value={key}
                    checked={reason === key}
                    onChange={() => { setReason(key); setError(null); }}
                    className="h-4 w-4 accent-[var(--color-d-brand)]"
                  />
                  <span>{reasonLabel(key)}</span>
                </label>
              ))}
            </div>
          </fieldset>

          {(reason === 'self_harm' || reason === 'minor_safety') && (
            <p className="flex gap-2 rounded-lg border-l-4 border-l-d-idle bg-d-idle/10 px-3 py-2 text-sm text-d-text leading-relaxed" role="note">
              <LifeBuoy className="mt-0.5 h-4 w-4 shrink-0 text-d-idle" aria-hidden="true" />
              {t('safety.emergencyNote')}
            </p>
          )}

          <label className="block">
            <span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-d-text2">
              {t('safety.details')} <span className="font-normal normal-case text-d-text3">({t('safety.optional')})</span>
            </span>
            <textarea
              value={details}
              onChange={(e) => setDetails(e.target.value.slice(0, 1000))}
              rows={3}
              placeholder={t('safety.detailsPlaceholder')}
              className="w-full resize-none rounded-lg border border-transparent bg-d-sunken px-3 py-2 text-sm text-d-strong placeholder:text-d-text4 focus:border-d-brand focus:outline-none"
            />
          </label>

          {user && (
            <label className="flex min-h-11 cursor-pointer items-start gap-3 rounded-lg bg-d-surface px-3 py-2.5">
              <input
                type="checkbox"
                checked={alsoBlock}
                onChange={(e) => setAlsoBlock(e.target.checked)}
                className="mt-0.5 h-4 w-4 accent-[var(--color-d-danger)]"
              />
              <span className="min-w-0 text-sm">
                <span className="block font-medium text-d-strong">{t('safety.alsoBlock', { name })}</span>
                <span className="block text-xs text-d-text2 leading-relaxed">{t('safety.alsoBlockHint')}</span>
              </span>
            </label>
          )}

          <p className="text-xs text-d-text3 leading-relaxed">{t('safety.anonymousNote')}</p>

          {error && <p role="alert" className="text-sm text-d-danger">{error}</p>}
        </div>

        <div className="flex justify-end gap-2 bg-d-surface px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="min-h-10 rounded-md px-4 text-sm font-medium text-d-text2 hover:text-d-strong hover:underline"
          >
            {t('common.cancel')}
          </button>
          <button
            type="submit"
            disabled={busy}
            className="flex min-h-10 items-center gap-2 rounded-md bg-d-danger px-4 text-sm font-semibold text-white hover:bg-d-dangerhover disabled:opacity-50"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('safety.submitReport')}
          </button>
        </div>
      </form>
    </div>,
    document.body
  );
}
