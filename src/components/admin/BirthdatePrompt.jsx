import React, { useId, useState } from 'react';
import { Cake, Loader2 } from 'lucide-react';
import { put } from '../../api';
import { t } from '../../i18n/index.jsx';
import { useDialog } from '../settings/primitives';
import BirthdateFields, { ageFromFields } from './BirthdateFields';
import { updateAccountFlags } from './safety';

const DISMISS_KEY = 'antigravity.dobPromptLater';

// Once answered, this device never asks again (the account row says so too,
// but the signed-in user object is only refreshed on the next load).
function rememberAnswered(user, result) {
  updateAccountFlags(user.id, { birthdate_set: true, age_group: result?.age_group ?? 'unknown' });
  try { window.localStorage.setItem(`${DISMISS_KEY}.${user.id}`, String(Number.MAX_SAFE_INTEGER)); } catch { /* private window */ }
}

/** Should the one-time prompt show for this account (and not been put off today)? */
export function shouldPromptBirthdate(user) {
  if (!user || user.birthdate_set !== false || user.is_bot) return false;
  try {
    const until = Number(window.localStorage.getItem(`${DISMISS_KEY}.${user.id}`) || 0);
    return !until || Date.now() > until;
  } catch {
    return true;
  }
}

/**
 * The one-time "When's your birthday?" for accounts made before the age gate.
 * "Later" puts it off for a day on this device; the server remembers only the
 * answer (year and month), and it cannot be changed afterwards.
 */
export default function BirthdatePrompt({ user, onDone, onClose, onToast }) {
  const dialogRef = useDialog(onClose);
  const [value, setValue] = useState({ day: '', month: '', year: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const titleId = useId();

  const later = () => {
    try { window.localStorage.setItem(`${DISMISS_KEY}.${user.id}`, String(Date.now() + 24 * 3600_000)); } catch { /* private window */ }
    onClose?.();
  };

  const submit = async (event) => {
    event.preventDefault();
    const age = ageFromFields(value);
    if (age == null) { setError(t('safety.dobIncomplete')); return; }
    setBusy(true);
    setError(null);
    try {
      const result = await put('/api/auth/age', { year: Number(value.year), month: Number(value.month), day: Number(value.day) });
      if (result?.age_group === 'minor') onToast?.(t('safety.teenDefaultsOn'), { type: 'info', ttl: 6000 });
      rememberAnswered(user, result);
      onDone?.(result);
    } catch (err) {
      setError(err.code === 'AGE_TOO_YOUNG' ? t('safety.tooYoung') : err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[75] flex items-center justify-center overlay-center bg-black/60 p-4">
      <form
        ref={dialogRef}
        onSubmit={submit}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="w-full max-w-sm rounded-xl bg-d-canvas p-6 shadow-2xl"
      >
        <Cake className="mx-auto h-10 w-10 text-d-brand" aria-hidden="true" />
        <h2 id={titleId} className="mt-3 text-center text-lg font-bold text-d-strong">{t('safety.dobPromptTitle')}</h2>
        <p className="mt-1 mb-4 text-center text-sm text-d-text2 leading-relaxed">{t('safety.dobPromptBody')}</p>
        <BirthdateFields value={value} onChange={(v) => { setValue(v); setError(null); }} required />
        {error && <p role="alert" className="mt-3 text-sm text-d-danger">{error}</p>}
        <div className="mt-5 flex gap-2">
          <button type="button" onClick={later} className="min-h-11 flex-1 rounded-md bg-d-surface text-sm font-medium text-d-strong hover:bg-d-hover">
            {t('safety.later')}
          </button>
          <button type="submit" disabled={busy} className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-md bg-d-brand text-sm font-semibold text-white hover:bg-d-brandhover disabled:opacity-50">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {t('common.save')}
          </button>
        </div>
      </form>
    </div>
  );
}

/**
 * The same question as a card inside the page instead of a modal: it never
 * blocks what someone came to do, and it goes away once answered or put off.
 */
export function BirthdateCard({ user, onDone, onToast }) {
  const [open, setOpen] = useState(false);
  const [gone, setGone] = useState(false);
  const [value, setValue] = useState({ day: '', month: '', year: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const titleId = useId();
  if (gone || !shouldPromptBirthdate(user)) return null;

  const later = () => {
    try { window.localStorage.setItem(`${DISMISS_KEY}.${user.id}`, String(Date.now() + 24 * 3600_000)); } catch { /* private window */ }
    setGone(true);
  };
  const submit = async (event) => {
    event.preventDefault();
    if (ageFromFields(value) == null) { setError(t('safety.dobIncomplete')); return; }
    setBusy(true);
    setError(null);
    try {
      const result = await put('/api/auth/age', { year: Number(value.year), month: Number(value.month), day: Number(value.day) });
      onToast?.(result?.age_group === 'minor' ? t('safety.teenDefaultsOn') : t('safety.dobSaved'), { type: 'success', ttl: 5000 });
      setGone(true);
      rememberAnswered(user, result);
      onDone?.(result);
    } catch (err) {
      setError(err.code === 'AGE_TOO_YOUNG' ? t('safety.tooYoung') : err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby={titleId} className="mb-4 max-w-xl rounded-lg border border-d-divider bg-d-surface p-4">
      <div className="flex items-start gap-3">
        <Cake className="mt-0.5 h-5 w-5 shrink-0 text-d-brand" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-sm font-semibold text-d-strong">{t('safety.dobPromptTitle')}</h2>
          <p className="mt-0.5 text-xs text-d-text2 leading-relaxed">{t('safety.dobPromptBody')}</p>
        </div>
      </div>
      {open ? (
        <form onSubmit={submit} className="mt-3">
          <BirthdateFields value={value} onChange={(v) => { setValue(v); setError(null); }} required compact />
          {error && <p role="alert" className="mt-2 text-sm text-d-danger">{error}</p>}
          <div className="mt-3 flex gap-2">
            <button type="submit" disabled={busy} className="flex min-h-10 items-center gap-2 rounded-md bg-d-brand px-4 text-sm font-semibold text-white hover:bg-d-brandhover disabled:opacity-50">
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}{t('common.save')}
            </button>
            <button type="button" onClick={later} className="min-h-10 rounded-md px-3 text-sm text-d-text2 hover:text-d-strong hover:underline">
              {t('safety.later')}
            </button>
          </div>
        </form>
      ) : (
        <div className="mt-3 flex gap-2">
          <button type="button" onClick={() => setOpen(true)} className="min-h-10 rounded-md bg-d-brand px-4 text-sm font-semibold text-white hover:bg-d-brandhover">
            {t('safety.addBirthday')}
          </button>
          <button type="button" onClick={later} className="min-h-10 rounded-md px-3 text-sm text-d-text2 hover:text-d-strong hover:underline">
            {t('safety.later')}
          </button>
        </div>
      )}
    </section>
  );
}
