import React, { useState } from 'react';
import { Loader2, Ban, LogOut, Clock } from 'lucide-react';
import { useDialog } from '../settings/primitives';
import { t } from '../../i18n/index.jsx';
import { post } from '../../api';

/** Discord's "Delete message history" choices for a ban, in seconds. */
export const DELETE_HISTORY_OPTIONS = () => [
  { seconds: 0, label: t('adm.deleteNone') },
  { seconds: 3600, label: t('adm.deleteHour') },
  { seconds: 6 * 3600, label: t('adm.delete6Hours') },
  { seconds: 24 * 3600, label: t('adm.deleteDay') },
  { seconds: 7 * 24 * 3600, label: t('adm.deleteWeek') }
];

/** Timeout lengths in Discord's order, shortest first. */
export const TIMEOUT_OPTIONS = () => [
  { minutes: 1, label: t('adm.timeout60s') },
  { minutes: 5, label: t('members.timeout5m') },
  { minutes: 10, label: t('members.timeout10m') },
  { minutes: 60, label: t('members.timeout60m') },
  { minutes: 1440, label: t('members.timeout1d') },
  { minutes: 10080, label: t('members.timeout1w') }
];

const ICONS = { ban: Ban, kick: LogOut, timeout: Clock };

/**
 * Ban, kick or time out one member or many. Bulk actions run one request per
 * member (the same endpoints the single actions use, so every hierarchy and
 * permission check still applies) and report exactly who could not be acted on.
 *
 * targets: [{ id, name }]
 */
export default function ModerationDialog({ kind, serverId, targets, onDone, onClose }) {
  const [reason, setReason] = useState('');
  const [deleteSeconds, setDeleteSeconds] = useState(3600);
  const [minutes, setMinutes] = useState(60);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [failures, setFailures] = useState([]);
  const dialogRef = useDialog(() => { if (!busy) onClose(); });
  const Icon = ICONS[kind] ?? Ban;
  const many = targets.length > 1;
  const one = targets[0];

  const title = many
    ? t(`adm.${kind}Many`, { count: targets.length })
    : kind === 'ban' ? t('members.banTitle', { name: one?.name })
    : kind === 'kick' ? t('members.kickTitle', { name: one?.name })
    : t('adm.timeoutTitle', { name: one?.name });
  const body = kind === 'ban' ? t('members.banBody') : kind === 'kick' ? t('members.kickBody') : t('adm.timeoutBody');

  const actOn = (target) => {
    const cleanReason = reason.trim() || null;
    if (kind === 'ban') {
      return post(`/api/servers/${serverId}/bans/${target.id}`, { reason: cleanReason, deleteMessageSeconds: deleteSeconds });
    }
    if (kind === 'kick') return post(`/api/servers/${serverId}/kicks/${target.id}`, { reason: cleanReason });
    return post(`/api/servers/${serverId}/timeouts/${target.id}`, {
      until: new Date(Date.now() + minutes * 60_000).toISOString(), reason: cleanReason
    });
  };

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setFailures([]);
    const failed = [];
    const done = [];
    for (const [index, target] of targets.entries()) {
      try {
        await actOn(target);
        done.push(target);
      } catch (err) {
        failed.push({ ...target, error: err?.message ?? String(err) });
      }
      setProgress(index + 1);
    }
    setBusy(false);
    onDone?.({ done, failed, kind, minutes });
    if (failed.length === 0) onClose();
    else setFailures(failed);
  };

  const confirmLabel = kind === 'ban' ? t('members.ban') : kind === 'kick' ? t('members.kick') : t('members.timeout');

  return (
    <div className="fixed inset-0 bg-black/70 z-[90] flex items-center justify-center overlay-center p-4">
      <form
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="mod-dialog-title"
        onSubmit={submit}
        className="bg-d-canvas w-full max-w-md rounded-lg shadow-2xl border border-d-surface overflow-hidden"
      >
        <div className="p-5 space-y-4 max-h-[70vh] overflow-y-auto">
          <h2 id="mod-dialog-title" className="text-lg font-bold text-d-strong flex items-center gap-2">
            <Icon className="w-5 h-5 text-d-danger shrink-0" aria-hidden="true" />
            <span className="min-w-0 break-words">{title}</span>
          </h2>
          <p className="text-sm text-d-text2">{body}</p>
          {many && (
            <p className="text-xs text-d-text3 break-words">
              {targets.slice(0, 8).map((x) => x.name).join(', ')}{targets.length > 8 ? ` +${targets.length - 8}` : ''}
            </p>
          )}

          {kind === 'timeout' && (
            <label className="block">
              <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">{t('adm.duration')}</span>
              <select
                value={minutes}
                onChange={(e) => setMinutes(Number(e.target.value))}
                className="w-full min-h-[40px] bg-d-base text-sm text-d-strong px-3 py-2 rounded border border-d-edge focus:outline-none focus:border-d-brand"
              >
                {TIMEOUT_OPTIONS().map((o) => <option key={o.minutes} value={o.minutes}>{o.label}</option>)}
              </select>
            </label>
          )}

          {kind === 'ban' && (
            <label className="block">
              <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">{t('adm.deleteHistory')}</span>
              <select
                value={deleteSeconds}
                onChange={(e) => setDeleteSeconds(Number(e.target.value))}
                className="w-full min-h-[40px] bg-d-base text-sm text-d-strong px-3 py-2 rounded border border-d-edge focus:outline-none focus:border-d-brand"
              >
                {DELETE_HISTORY_OPTIONS().map((o) => <option key={o.seconds} value={o.seconds}>{o.label}</option>)}
              </select>
              <span className="block text-[11px] text-d-text3 mt-1">{t('adm.deleteHistoryHint')}</span>
            </label>
          )}

          <label className="block">
            <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">{t('common.reason')}</span>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={512}
              autoFocus
              className="w-full min-h-[40px] bg-d-base text-sm text-d-strong px-3 py-2 rounded border border-d-edge focus:outline-none focus:border-d-brand"
            />
          </label>

          {busy && many && (
            <p className="text-xs text-d-text2" role="status">{t('adm.progress', { done: progress, count: targets.length })}</p>
          )}
          {failures.length > 0 && (
            <div role="alert" className="text-xs text-d-danger space-y-1">
              <p className="font-semibold">{t('adm.someFailed', { count: failures.length })}</p>
              <ul className="list-disc pl-4">
                {failures.slice(0, 10).map((f) => <li key={f.id}>{f.name}: {f.error}</li>)}
              </ul>
            </div>
          )}
        </div>
        <div className="bg-d-surface px-5 py-3 flex justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className="min-h-[36px] px-4 py-2 text-sm font-semibold text-d-strong hover:underline">
            {failures.length ? t('common.close') : t('common.cancel')}
          </button>
          {failures.length === 0 && (
            <button
              type="submit"
              disabled={busy || targets.length === 0}
              className="min-h-[36px] px-4 py-2 rounded text-sm font-semibold text-white bg-d-danger hover:bg-red-600 disabled:opacity-40 flex items-center gap-2"
            >
              {busy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
              {many ? `${confirmLabel} (${targets.length})` : confirmLabel}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}
