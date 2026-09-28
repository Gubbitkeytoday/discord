import React, { useCallback, useEffect, useState } from 'react';
import { X, Copy, Check, Loader2 } from 'lucide-react';
import { post } from '../api';
import { t } from '../i18n/index.jsx';
import { useDialog } from './settings/primitives';

const EXPIRY = () => [
  { seconds: 1800, label: t('invite.expire30m') },
  { seconds: 3600, label: t('invite.expire1h') },
  { seconds: 21600, label: t('invite.expire6h') },
  { seconds: 43200, label: t('invite.expire12h') },
  { seconds: 86400, label: t('invite.expire1d') },
  { seconds: 604800, label: t('invite.expire7d') },
  { seconds: 0, label: t('invite.expireNever') }
];
const MAX_USES = [0, 1, 5, 10, 25, 50, 100];

/**
 * "Invite friends to <server>": the link itself, visible and copyable, with
 * how long it lasts and how many times it can be used — instead of a silent
 * copy and a toast. A new invite is minted whenever the options change.
 */
export default function InviteModal({ server, channelId = null, hideLink = false, onClose, onToast }) {
  const dialogRef = useDialog(onClose);
  const [maxAge, setMaxAge] = useState(604800);
  const [maxUses, setMaxUses] = useState(0);
  const [invite, setInvite] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const mint = useCallback(async (age, uses) => {
    setBusy(true);
    setError(null);
    try {
      setInvite(await post(`/api/servers/${server.id}/invites`, { channelId, maxAge: age, maxUses: uses }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, [server.id, channelId]);

  useEffect(() => { mint(maxAge, maxUses); }, [mint, maxAge, maxUses]);

  const link = invite ? `${window.location.origin}/invite/${invite.code}` : '';
  const copy = async () => {
    if (!link) return;
    try { await navigator.clipboard?.writeText(link); } catch { /* no clipboard: the field is selectable */ }
    setCopied(true);
    onToast?.(t('common.copied'), { type: 'success', ttl: 2000 });
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="fixed inset-0 z-[80] bg-black/60 flex items-center justify-center overlay-center p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="invite-title"
        className="w-full max-w-md rounded-lg bg-d-canvas border border-d-edge shadow-2xl"
      >
        <header className="flex items-start justify-between gap-4 px-4 pt-4">
          <div className="min-w-0">
            <h2 id="invite-title" className="text-base font-bold text-d-strong line-clamp-2 break-words">
              {t('invite.title', { server: server.name })}
            </h2>
            <p className="text-xs text-d-text3 mt-0.5">{t('invite.hint')}</p>
          </div>
          <button type="button" onClick={onClose} aria-label={t('common.close')} className="p-1 text-d-text3 hover:text-d-strong">
            <X className="w-5 h-5" />
          </button>
        </header>

        <div className="p-4 space-y-4">
          <div>
            <label htmlFor="invite-link" className="block text-xs font-bold text-d-text2 uppercase mb-1.5">{t('invite.linkLabel')}</label>
            <div className="flex gap-2">
              <input
                id="invite-link"
                readOnly
                value={busy && !invite ? t('common.loading') : hideLink ? '•'.repeat(24) : link}
                onFocus={(e) => {
                  // Select it all for copying, but keep the start in view:
                  // a backwards selection leaves the caret (and the scroll) at 0.
                  const el = e.target;
                  el.setSelectionRange(0, el.value.length, 'backward');
                  el.scrollLeft = 0;
                }}
                className="flex-1 min-w-0 bg-d-base text-sm text-d-strong px-3 py-2 rounded border border-d-edge font-mono"
              />
              <button
                type="button"
                onClick={copy}
                disabled={!invite || busy}
                className="shrink-0 bg-d-brand hover:bg-d-brandhover disabled:opacity-50 text-white text-sm font-semibold px-4 rounded flex items-center gap-1.5"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                  : copied ? <Check className="w-4 h-4" aria-hidden="true" /> : <Copy className="w-4 h-4" aria-hidden="true" />}
                {copied ? t('common.copied') : t('common.copy')}
              </button>
            </div>
            {error && <p className="text-xs text-d-danger mt-1.5" role="alert">{error}</p>}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-xs font-bold text-d-text2 uppercase mb-1.5">{t('invite.expireAfter')}</span>
              <select
                value={maxAge}
                onChange={(e) => setMaxAge(Number(e.target.value))}
                className="w-full bg-d-base text-sm text-d-strong px-2 py-2 rounded border border-d-edge"
              >
                {EXPIRY().map((o) => <option key={o.seconds} value={o.seconds}>{o.label}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="block text-xs font-bold text-d-text2 uppercase mb-1.5">{t('invite.maxUses')}</span>
              <select
                value={maxUses}
                onChange={(e) => setMaxUses(Number(e.target.value))}
                className="w-full bg-d-base text-sm text-d-strong px-2 py-2 rounded border border-d-edge"
              >
                {MAX_USES.map((n) => (
                  <option key={n} value={n}>{n === 0 ? t('invite.noLimit') : t('invite.uses', { count: n })}</option>
                ))}
              </select>
            </label>
          </div>
          <p className="text-xs text-d-text3">
            {maxAge === 0 ? t('invite.neverExpires') : t('invite.expiresIn', { time: EXPIRY().find((o) => o.seconds === maxAge)?.label ?? '' })}
          </p>
        </div>
      </div>
    </div>
  );
}
