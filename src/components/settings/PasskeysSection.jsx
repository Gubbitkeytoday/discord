import React, { useCallback, useEffect, useState } from 'react';
import { Fingerprint, Loader2, Pencil, Trash2, Cloud, Smartphone, Check, X } from 'lucide-react';
import { localeTag, t } from '../../i18n/index.jsx';
import {
  passkeysAvailable, listPasskeys, registerPasskey, renamePasskey, deletePasskey,
  getReauthStatus, reauthWithPassword, reauthWithPasskey, suggestPasskeyName
} from '../../auth/passkeys';

const inputClass = 'w-full bg-d-surface text-sm text-d-strong px-3 py-2 rounded border border-d-edge focus:outline-none focus:border-d-brand';

/**
 * Settings › My Account › Passkeys. Register, list, rename and remove
 * passkeys. Adding or removing one needs a fresh step-up (password + 2FA,
 * or an existing passkey), asked for inline only when the server says the
 * last one has lapsed. Renders nothing when the server has passkeys off or
 * the browser has no WebAuthn.
 */
export default function PasskeysSection({ onToast, mfaEnabled = false }) {
  const [available, setAvailable] = useState(false);
  const [items, setItems] = useState([]);
  const [busy, setBusy] = useState(null);
  const [pending, setPending] = useState(null);          // { kind: 'add' } | { kind: 'delete', id }
  const [confirm, setConfirm] = useState({ password: '', code: '' });
  const [editing, setEditing] = useState(null);          // { id, name }
  const [armedDelete, setArmedDelete] = useState(null);

  const toastError = useCallback((err) => {
    if (err?.cancelled) return;                          // the user closed the browser sheet
    onToast?.(err?.message ?? t('apiError.generic', { code: '?' }), { type: 'error' });
  }, [onToast]);

  const load = useCallback(async () => {
    try {
      setItems(await listPasskeys());
    } catch (err) {
      toastError(err);
    }
  }, [toastError]);

  useEffect(() => {
    let alive = true;
    passkeysAvailable().then((ok) => {
      if (!alive) return;
      setAvailable(ok);
      if (ok) load();
    });
    return () => { alive = false; };
  }, [load]);

  const perform = async (action) => {
    if (action.kind === 'add') {
      setBusy('add');
      try {
        await registerPasskey(suggestPasskeyName());
        onToast?.(t('passkeys.added'), { type: 'success' });
        await load();
      } finally { setBusy(null); }
    } else if (action.kind === 'delete') {
      setBusy(`delete-${action.id}`);
      try {
        await deletePasskey(action.id);
        setItems((prev) => prev.filter((p) => p.id !== action.id));
        onToast?.(t('passkeys.deleted'), { type: 'success' });
      } finally { setBusy(null); }
    }
  };

  /** Run a sensitive action, asking to re-authenticate first if needed. */
  const withSudo = async (action) => {
    try {
      const status = await getReauthStatus();
      if (!status?.active) { setPending(action); return; }
      await perform(action);
    } catch (err) {
      if (err?.code === 'REAUTH_REQUIRED') { setPending(action); return; }
      toastError(err);
    }
  };

  const confirmWithPassword = async (e) => {
    e.preventDefault();
    setBusy('reauth');
    try {
      await reauthWithPassword({ password: confirm.password, code: confirm.code.replace(/\s+/g, '') || undefined });
      const action = pending;
      setPending(null);
      setConfirm({ password: '', code: '' });
      await perform(action);
    } catch (err) {
      toastError(err);
    } finally { setBusy((b) => (b === 'reauth' ? null : b)); }
  };

  const confirmWithPasskey = async () => {
    setBusy('reauth');
    try {
      await reauthWithPasskey();
      const action = pending;
      setPending(null);
      await perform(action);
    } catch (err) {
      toastError(err);
    } finally { setBusy((b) => (b === 'reauth' ? null : b)); }
  };

  const saveName = async (e) => {
    e.preventDefault();
    if (!editing?.name.trim()) return;
    setBusy(`rename-${editing.id}`);
    try {
      const updated = await renamePasskey(editing.id, editing.name.trim());
      setItems((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
      setEditing(null);
      onToast?.(t('passkeys.renamed'), { type: 'success' });
    } catch (err) {
      toastError(err);
    } finally { setBusy(null); }
  };

  if (!available) return null;

  const formatDate = (iso) => (iso ? new Date(iso).toLocaleDateString(localeTag()) : '');

  return (
    <section className="space-y-3" aria-labelledby="passkeys-heading">
      <h3 id="passkeys-heading" className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.02em] text-d-text2">
        <Fingerprint className="w-4 h-4" /> {t('passkeys.title')}
      </h3>
      <div className="bg-d-base rounded-xl border border-d-divider p-4 space-y-3">
        <p className="text-xs text-d-text2">{t('passkeys.lead')}</p>

        {items.length === 0 ? (
          <p className="text-xs text-d-text4">{t('passkeys.none')}</p>
        ) : (
          <ul className="divide-y divide-d-divider border border-d-divider rounded-lg">
            {items.map((item) => (
              <li key={item.id} className="p-3 flex items-center justify-between gap-3">
                <div className="min-w-0 flex-1">
                  {editing?.id === item.id ? (
                    <form onSubmit={saveName} className="flex items-center gap-2">
                      <input
                        value={editing.name}
                        onChange={(e) => setEditing({ ...editing, name: e.target.value.slice(0, 64) })}
                        aria-label={t('passkeys.nameLabel')}
                        autoFocus
                        className={inputClass}
                      />
                      <button type="submit" className="p-1.5 rounded hover:bg-d-hover text-d-online" aria-label={t('common.save')} title={t('common.save')}>
                        {busy === `rename-${item.id}` ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                      </button>
                      <button type="button" onClick={() => setEditing(null)} className="p-1.5 rounded hover:bg-d-hover text-d-text3" aria-label={t('common.cancel')} title={t('common.cancel')}>
                        <X className="w-4 h-4" />
                      </button>
                    </form>
                  ) : (
                    <>
                      <p className="text-sm text-d-strong truncate flex items-center gap-2">
                        {item.name}
                        <span
                          className="text-[10px] bg-d-surface text-d-text3 px-1.5 py-0.5 rounded inline-flex items-center gap-1 shrink-0"
                          title={item.backed_up ? t('passkeys.syncedHint') : undefined}
                        >
                          {item.backed_up
                            ? <><Cloud className="w-3 h-3" /> {t('passkeys.synced')}</>
                            : <><Smartphone className="w-3 h-3" /> {t('passkeys.deviceBound')}</>}
                        </span>
                      </p>
                      <p className="text-[11px] text-d-text3 truncate">
                        {t('passkeys.created', { date: formatDate(item.created_at) })}
                        {' · '}
                        {item.last_used_at ? t('passkeys.lastUsed', { date: formatDate(item.last_used_at) }) : t('passkeys.neverUsed')}
                      </p>
                    </>
                  )}
                </div>
                {editing?.id !== item.id && (
                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => { setEditing({ id: item.id, name: item.name }); setArmedDelete(null); }}
                      className="p-1.5 rounded hover:bg-d-hover text-d-text2"
                      aria-label={t('passkeys.renameLabel', { name: item.name })}
                      title={t('passkeys.rename')}
                    >
                      <Pencil className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        if (armedDelete !== item.id) { setArmedDelete(item.id); return; }
                        setArmedDelete(null);
                        withSudo({ kind: 'delete', id: item.id });
                      }}
                      disabled={busy === `delete-${item.id}`}
                      className={`p-1.5 rounded text-d-danger ${armedDelete === item.id ? 'bg-d-danger/20' : 'hover:bg-d-danger/10'}`}
                      aria-label={t('passkeys.removeLabel', { name: item.name })}
                      title={armedDelete === item.id ? t('passkeys.removeConfirm') : t('passkeys.remove')}
                    >
                      {busy === `delete-${item.id}` ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                    </button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
        {armedDelete && (
          <p className="text-xs text-d-danger" role="alert">{t('passkeys.removeConfirm')}</p>
        )}

        {pending ? (
          <form onSubmit={confirmWithPassword} className="space-y-2 bg-d-surface/50 rounded-lg p-3 border border-d-divider">
            <p className="text-xs font-semibold text-d-strong">{t('passkeys.confirmTitle')}</p>
            <p className="text-[11px] text-d-text3">{t('passkeys.confirmHint')}</p>
            <label className="block">
              <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1">{t('security.currentPassword')}</span>
              <input
                type="password"
                autoComplete="current-password"
                value={confirm.password}
                onChange={(e) => setConfirm({ ...confirm, password: e.target.value })}
                autoFocus
                className={inputClass}
              />
            </label>
            {mfaEnabled && (
              <label className="block">
                <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1">{t('security.sixDigitCode')}</span>
                <input
                  value={confirm.code}
                  onChange={(e) => setConfirm({ ...confirm, code: e.target.value.slice(0, 32) })}
                  autoComplete="one-time-code"
                  inputMode="text"
                  className={`${inputClass} w-40 font-mono tracking-[0.2em]`}
                />
              </label>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="submit"
                disabled={!confirm.password || busy === 'reauth'}
                className="bg-d-brand hover:bg-d-brandhover disabled:opacity-50 text-white text-xs font-semibold px-4 py-2 rounded flex items-center gap-2"
              >
                {busy === 'reauth' && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {t('security.confirm')}
              </button>
              {items.length > 0 && (
                <button type="button" onClick={confirmWithPasskey} disabled={busy === 'reauth'} className="text-xs text-d-link hover:underline flex items-center gap-1">
                  <Fingerprint className="w-3.5 h-3.5" /> {t('passkeys.confirmWithPasskey')}
                </button>
              )}
              <button type="button" onClick={() => setPending(null)} className="text-xs text-d-text3 hover:underline">
                {t('common.cancel')}
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            onClick={() => withSudo({ kind: 'add' })}
            disabled={busy === 'add'}
            className="bg-d-brand hover:bg-d-brandhover disabled:opacity-50 text-white text-xs font-semibold px-4 py-2 rounded flex items-center gap-2 transition-colors"
          >
            {busy === 'add' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Fingerprint className="w-3.5 h-3.5" />}
            {busy === 'add' ? t('passkeys.adding') : t('passkeys.add')}
          </button>
        )}
      </div>
    </section>
  );
}
