import React, { useCallback, useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  X, Flag, Users, Server, DoorOpen, ScrollText, Sparkles, Loader2, RefreshCw, Trash2, Ban, CheckCircle2, Undo2
} from 'lucide-react';
import { get, patch, post, put, del } from '../../api';
import { localeTag, t } from '../../i18n/index.jsx';
import { useDialog } from '../settings/primitives';
import { reasonLabel, useStreamerMask, maskEmail } from './safety';
import SeasonalAdminPanel from '../theme/SeasonalAdminPanel.jsx';

/**
 * Instance administration: the people who run this deployment. Reached from
 * User settings › Account when the account is an instance admin. Every call
 * here is authorised on the server again (routes/admin.js) and every change is
 * written to the audit log.
 */
const TABS = [
  { key: 'reports', icon: Flag },
  { key: 'users', icon: Users },
  { key: 'servers', icon: Server },
  { key: 'registration', icon: DoorOpen },
  { key: 'seasonal', icon: Sparkles },
  { key: 'audit', icon: ScrollText }
];

const fmtDate = (iso) => {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleString(localeTag(), { dateStyle: 'medium', timeStyle: 'short' }); } catch { return String(iso); }
};

export default function AdminConsole({ currentUser, onClose, onToast }) {
  const dialogRef = useDialog(onClose);
  const [tab, setTab] = useState('reports');
  const [overview, setOverview] = useState(null);
  const titleId = useId();

  const loadOverview = useCallback(() => get('/api/admin/overview').then(setOverview).catch(() => {}), []);
  useEffect(() => { loadOverview(); }, [loadOverview]);

  const toastError = (err) => onToast?.(err.message, { type: 'error' });

  const onTabKey = (e) => {
    const i = TABS.findIndex((x) => x.key === tab);
    let next = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = TABS[(i + 1) % TABS.length];
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = TABS[(i - 1 + TABS.length) % TABS.length];
    if (e.key === 'Home') next = TABS[0];
    if (e.key === 'End') next = TABS[TABS.length - 1];
    if (next) {
      e.preventDefault();
      setTab(next.key);
      requestAnimationFrame(() => document.getElementById(`admin-tab-${next.key}`)?.focus());
    }
  };

  // Portalled to <body>, above the settings modal it is opened from.
  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-stretch justify-center bg-black/70 sm:p-6">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex w-full max-w-5xl flex-col overflow-hidden bg-d-canvas shadow-2xl sm:rounded-xl"
      >
        <header className="flex items-center gap-3 border-b border-d-edge px-4 py-3 sm:px-6">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="text-lg font-bold text-d-strong">{t('admin.title')}</h2>
            {overview && (
              <p className="text-xs text-d-text2">
                {t('admin.summary', { users: overview.users, servers: overview.servers, reports: overview.open_reports })}
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="flex h-10 w-10 items-center justify-center rounded-md text-d-text2 hover:bg-d-hover hover:text-d-strong"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <div role="tablist" aria-label={t('admin.title')} onKeyDown={onTabKey}
          className="flex gap-1 overflow-x-auto border-b border-d-edge px-2 sm:px-4 scrollbar-none">
          {TABS.map(({ key, icon: Icon }) => (
            <button
              key={key}
              id={`admin-tab-${key}`}
              type="button"
              role="tab"
              aria-selected={tab === key}
              aria-controls={`admin-panel-${key}`}
              tabIndex={tab === key ? 0 : -1}
              onClick={() => setTab(key)}
              className={`flex min-h-11 shrink-0 items-center gap-2 border-b-2 px-3 text-sm font-medium transition-colors ${
                tab === key ? 'border-d-brand text-d-strong' : 'border-transparent text-d-text2 hover:text-d-strong'
              }`}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {t(`admin.tab.${key}`)}
              {key === 'reports' && overview?.open_reports > 0 && (
                <span className="rounded-full bg-d-danger px-1.5 text-[11px] font-bold text-white">{overview.open_reports}</span>
              )}
            </button>
          ))}
        </div>

        <div id={`admin-panel-${tab}`} role="tabpanel" aria-labelledby={`admin-tab-${tab}`} className="flex-1 overflow-y-auto p-4 sm:p-6">
          {tab === 'reports' && <ReportsPanel onChanged={loadOverview} onError={toastError} onToast={onToast} />}
          {tab === 'users' && <UsersPanel currentUser={currentUser} onChanged={loadOverview} onError={toastError} onToast={onToast} />}
          {tab === 'servers' && <ServersPanel onError={toastError} />}
          {tab === 'registration' && <RegistrationPanel onChanged={loadOverview} onError={toastError} onToast={onToast} />}
          {tab === 'seasonal' && <SeasonalAdminPanel onError={toastError} onToast={onToast} />}
          {tab === 'audit' && <AuditPanel onError={toastError} />}
        </div>
      </div>
    </div>,
    document.body
  );
}

function useLoader(url, onError) {
  const [rows, setRows] = useState(null);
  const load = useCallback(() => {
    setRows(null);
    return get(url).then((d) => setRows(Array.isArray(d) ? d : d ?? [])).catch((err) => { setRows([]); onError?.(err); });
  }, [url]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, [load]);
  return [rows, load, setRows];
}

function Loading() {
  return (
    <p className="flex items-center gap-2 text-sm text-d-text3" role="status">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> {t('common.loading')}
    </p>
  );
}

const btn = 'inline-flex min-h-9 items-center gap-1.5 rounded-md px-3 text-xs font-semibold transition-colors disabled:opacity-50';

// --- reports ------------------------------------------------------------------

function ReportsPanel({ onChanged, onError, onToast }) {
  const [status, setStatus] = useState('open');
  const [rows, load] = useLoader(`/api/admin/reports?status=${status}`, onError);
  const [open, setOpen] = useState(null);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-sm text-d-text2" htmlFor="admin-report-status">{t('admin.show')}</label>
        <select id="admin-report-status" value={status} onChange={(e) => setStatus(e.target.value)}
          className="min-h-9 rounded-md border border-d-edge bg-d-base px-2 text-sm text-d-strong">
          {['open', 'reviewing', 'resolved', 'dismissed', 'all'].map((s) => (
            <option key={s} value={s}>{s === 'all' ? t('admin.all') : t(`safety.status.${s}`)}</option>
          ))}
        </select>
        <button type="button" onClick={load} className={`${btn} bg-d-surface text-d-strong hover:bg-d-hover`}>
          <RefreshCw className="h-3.5 w-3.5" /> {t('admin.refresh')}
        </button>
      </div>
      <p className="text-xs text-d-text3">{t('admin.reportsHint')}</p>
      {!rows ? <Loading /> : rows.length === 0 ? (
        <p className="rounded-lg bg-d-surface p-4 text-sm text-d-text2">{t('admin.noReports')}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((r) => (
            <li key={r.id} className="rounded-lg border border-d-divider bg-d-surface">
              <button
                type="button"
                onClick={() => setOpen(open === r.id ? null : r.id)}
                aria-expanded={open === r.id}
                className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 p-3 text-left"
              >
                <span className={`rounded px-2 py-0.5 text-xs font-bold ${['self_harm', 'minor_safety', 'illegal'].includes(r.reason) ? 'bg-d-danger text-white' : 'bg-d-base text-d-strong'}`}>
                  {reasonLabel(r.reason)}
                </span>
                <span className="min-w-0 flex-1 text-sm text-d-strong">
                  {r.target_type === 'user'
                    ? t('admin.reportUserLine', { name: r.target_display || r.target_username || '?' })
                    : t('admin.reportMessageLine', { name: r.target_display || r.target_username || '?', where: r.server_name || t('admin.dm') })}
                </span>
                <span className="text-xs text-d-text3">{fmtDate(r.created_at)} · {t(`safety.status.${r.status}`)}</span>
              </button>
              {open === r.id && (
                <ReportDetail report={r} onDone={() => { load(); onChanged?.(); }} onError={onError} onToast={onToast} />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ReportDetail({ report, onDone, onError, onToast }) {
  const [busy, setBusy] = useState(null);
  const [note, setNote] = useState('');
  const act = (status, action = null) => async () => {
    if (action === 'ban_user' && !window.confirm(t('admin.confirmBan', { name: report.target_username ?? '' }))) return;
    setBusy(action ?? status);
    try {
      await patch(`/api/admin/reports/${report.id}`, { status, action, note: note.trim() || null });
      onToast?.(t('admin.reportUpdated'), { type: 'success', ttl: 2500 });
      onDone();
    } catch (err) { onError(err); } finally { setBusy(null); }
  };
  const ctx = report.context;
  return (
    <div className="space-y-3 border-t border-d-divider p-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-d-text3">{t('admin.reportedBy')}</dt>
        <dd className="text-d-text">{report.reporter_display || report.reporter_name || t('admin.deletedUser')}</dd>
        <dt className="text-d-text3">{t('admin.reportedUser')}</dt>
        <dd className="text-d-text">
          {report.target_display || report.target_username || '—'}
          {report.target_disabled_at ? ` · ${t('admin.disabled')}` : ''}
        </dd>
        {report.details && (<><dt className="text-d-text3">{t('safety.details')}</dt><dd className="whitespace-pre-wrap text-d-text">{report.details}</dd></>)}
      </dl>
      {ctx?.message && (
        <div className="rounded-md bg-d-base p-3">
          <p className="mb-2 text-[11px] font-bold uppercase text-d-text3">{t('admin.context')}</p>
          <ol className="space-y-1.5 text-sm">
            {(ctx.before ?? []).map((m) => (
              <li key={m.id} className="text-d-text2"><span className="font-semibold text-d-text">{m.author ?? '?'}:</span> {m.content}</li>
            ))}
            <li className="rounded bg-d-danger/10 px-2 py-1 text-d-strong">
              <span className="font-semibold">{ctx.message.author ?? '?'}:</span> {ctx.message.content}
              {report.target?.deleted && <span className="ml-2 text-xs text-d-text3">({t('admin.deleted')})</span>}
            </li>
          </ol>
        </div>
      )}
      <label className="block">
        <span className="mb-1 block text-[11px] font-bold uppercase text-d-text3">{t('admin.note')}</span>
        <input value={note} onChange={(e) => setNote(e.target.value.slice(0, 500))}
          className="w-full rounded-md border border-d-edge bg-d-base px-3 py-2 text-sm text-d-strong focus:border-d-brand focus:outline-none" />
      </label>
      <div className="flex flex-wrap gap-2">
        {report.target_type === 'message' && !report.target?.deleted && (
          <button type="button" disabled={Boolean(busy)} onClick={act('resolved', 'delete_message')} className={`${btn} bg-d-danger text-white hover:bg-d-dangerhover`}>
            <Trash2 className="h-3.5 w-3.5" /> {t('admin.deleteMessage')}
          </button>
        )}
        {report.target_user_id && !report.target_disabled_at && (
          <button type="button" disabled={Boolean(busy)} onClick={act('resolved', 'ban_user')} className={`${btn} bg-d-danger text-white hover:bg-d-dangerhover`}>
            <Ban className="h-3.5 w-3.5" /> {t('admin.banUser')}
          </button>
        )}
        <button type="button" disabled={Boolean(busy)} onClick={act('resolved')} className={`${btn} bg-d-brand text-white hover:bg-d-brandhover`}>
          <CheckCircle2 className="h-3.5 w-3.5" /> {t('admin.resolve')}
        </button>
        <button type="button" disabled={Boolean(busy)} onClick={act('dismissed')} className={`${btn} bg-d-control2 text-d-strong hover:bg-d-control`}>
          {t('admin.dismiss')}
        </button>
        {busy && <Loader2 className="h-4 w-4 animate-spin self-center text-d-text3" aria-hidden="true" />}
      </div>
    </div>
  );
}

// --- users ----------------------------------------------------------------------

function UsersPanel({ currentUser, onChanged, onError, onToast }) {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [rows, load] = useLoader(`/api/admin/users${query ? `?search=${encodeURIComponent(query)}` : ''}`, onError);
  const [busy, setBusy] = useState(null);
  const mask = useStreamerMask();

  const act = (user, kind) => async () => {
    const name = user.username;
    if (kind === 'disable' && !window.confirm(t('admin.confirmBan', { name }))) return;
    if (kind === 'delete' && !window.confirm(t('admin.confirmDelete', { name }))) return;
    setBusy(`${kind}-${user.id}`);
    try {
      if (kind === 'disable') await post(`/api/admin/users/${user.id}/disable`, {});
      if (kind === 'enable') await post(`/api/admin/users/${user.id}/enable`, {});
      if (kind === 'delete') await del(`/api/admin/users/${user.id}`);
      onToast?.(t('admin.userUpdated', { name }), { type: 'success', ttl: 2500 });
      load(); onChanged?.();
    } catch (err) { onError(err); } finally { setBusy(null); }
  };

  return (
    <div className="space-y-3">
      <form onSubmit={(e) => { e.preventDefault(); setQuery(search.trim()); }} className="flex gap-2" role="search">
        <label htmlFor="admin-user-search" className="sr-only">{t('admin.searchUsers')}</label>
        <input id="admin-user-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('admin.searchUsers')}
          className="min-h-10 flex-1 rounded-md border border-d-edge bg-d-base px-3 text-sm text-d-strong focus:border-d-brand focus:outline-none" />
        <button type="submit" className={`${btn} bg-d-brand text-white hover:bg-d-brandhover`}>{t('common.search')}</button>
      </form>
      {!rows ? <Loading /> : (
        <div className="overflow-x-auto rounded-lg border border-d-divider">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="bg-d-surface text-xs uppercase text-d-text3">
              <tr>
                <th scope="col" className="px-3 py-2">{t('admin.col.user')}</th>
                <th scope="col" className="px-3 py-2">{t('admin.col.joined')}</th>
                <th scope="col" className="px-3 py-2">{t('admin.col.reports')}</th>
                <th scope="col" className="px-3 py-2">{t('admin.col.status')}</th>
                <th scope="col" className="px-3 py-2"><span className="sr-only">{t('admin.col.actions')}</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-d-divider">
              {rows.map((u) => (
                <tr key={u.id}>
                  <td className="px-3 py-2">
                    <span className="block font-medium text-d-strong">{u.display_name}</span>
                    <span className="block text-xs text-d-text3">
                      @{u.username}{u.email ? ` · ${mask.personal ? maskEmail(u.email) : u.email}` : ''}
                      {u.instance_admin ? ` · ${t('admin.adminBadge')}` : ''}{u.is_bot ? ' · BOT' : ''}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-xs text-d-text2">{fmtDate(u.created_at)}</td>
                  <td className="px-3 py-2 text-xs text-d-text2">{u.report_count}</td>
                  <td className="px-3 py-2 text-xs">
                    {u.disabled_at ? <span className="font-semibold text-d-danger">{t('admin.disabled')}</span> : <span className="text-d-text2">{t('admin.active')}</span>}
                  </td>
                  <td className="px-3 py-2">
                    {u.id !== currentUser?.id && !u.instance_admin && (
                      <div className="flex justify-end gap-1.5">
                        {u.disabled_at ? (
                          <button type="button" disabled={Boolean(busy)} onClick={act(u, 'enable')} className={`${btn} bg-d-control2 text-d-strong hover:bg-d-control`}
                            aria-label={t('admin.enableNamed', { name: u.username })}>
                            <Undo2 className="h-3.5 w-3.5" /> {t('admin.enable')}
                          </button>
                        ) : (
                          <button type="button" disabled={Boolean(busy)} onClick={act(u, 'disable')} className={`${btn} bg-d-danger/90 text-white hover:bg-d-danger`}
                            aria-label={t('admin.banNamed', { name: u.username })}>
                            <Ban className="h-3.5 w-3.5" /> {t('admin.ban')}
                          </button>
                        )}
                        <button type="button" disabled={Boolean(busy)} onClick={act(u, 'delete')} className={`${btn} text-d-danger hover:bg-d-danger/10`}
                          aria-label={t('admin.deleteNamed', { name: u.username })}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// --- servers ----------------------------------------------------------------------

function ServersPanel({ onError }) {
  const [rows] = useLoader('/api/admin/servers', onError);
  if (!rows) return <Loading />;
  if (rows.length === 0) return <p className="text-sm text-d-text2">{t('admin.noServers')}</p>;
  return (
    <div className="overflow-x-auto rounded-lg border border-d-divider">
      <table className="w-full min-w-[520px] text-left text-sm">
        <thead className="bg-d-surface text-xs uppercase text-d-text3">
          <tr>
            <th scope="col" className="px-3 py-2">{t('admin.col.server')}</th>
            <th scope="col" className="px-3 py-2">{t('admin.col.owner')}</th>
            <th scope="col" className="px-3 py-2">{t('admin.col.members')}</th>
            <th scope="col" className="px-3 py-2">{t('admin.col.openReports')}</th>
            <th scope="col" className="px-3 py-2">{t('admin.col.created')}</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-d-divider">
          {rows.map((s) => (
            <tr key={s.id}>
              <td className="px-3 py-2 font-medium text-d-strong">{s.name}</td>
              <td className="px-3 py-2 text-xs text-d-text2">{s.owner_display || s.owner_username || '—'}</td>
              <td className="px-3 py-2 text-xs text-d-text2">{s.member_count}</td>
              <td className="px-3 py-2 text-xs text-d-text2">{s.open_reports}</td>
              <td className="px-3 py-2 text-xs text-d-text2">{fmtDate(s.created_at)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --- registration -------------------------------------------------------------------

function RegistrationPanel({ onChanged, onError, onToast }) {
  const [current, setCurrent] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { get('/api/admin/registration').then(setCurrent).catch(onError); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const choose = async (mode) => {
    setBusy(true);
    try {
      const next = await put('/api/admin/registration', { mode });
      setCurrent(next);
      onToast?.(t('admin.registrationSaved'), { type: 'success', ttl: 2500 });
      onChanged?.();
    } catch (err) { onError(err); } finally { setBusy(false); }
  };
  if (!current) return <Loading />;
  const options = ['open', 'invite', 'closed'];
  return (
    <fieldset className="max-w-xl space-y-2" disabled={busy}>
      <legend className="mb-2 text-sm text-d-text2">{t('admin.registrationLead')}</legend>
      {options.map((mode) => (
        <label key={mode} className={`flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border px-4 py-3 ${
          current.mode === mode ? 'border-d-brand bg-d-brand/10' : 'border-d-divider bg-d-surface'}`}>
          <input type="radio" name="registration-mode" checked={current.mode === mode} onChange={() => choose(mode)} className="mt-1 h-4 w-4" />
          <span>
            <span className="block text-sm font-medium text-d-strong">{t(`admin.reg.${mode}`)}</span>
            <span className="block text-xs text-d-text2">{t(`admin.reg.${mode}Hint`)}</span>
          </span>
        </label>
      ))}
      <p className="pt-1 text-xs text-d-text3">
        {current.source === 'admin' ? t('admin.regOverride') : t('admin.regFromEnv')}
        {current.source === 'admin' && (
          <button type="button" onClick={() => choose('default')} className="ml-2 text-d-link hover:underline">{t('admin.regReset')}</button>
        )}
      </p>
    </fieldset>
  );
}

// --- audit ------------------------------------------------------------------------

function AuditPanel({ onError }) {
  const [rows] = useLoader('/api/admin/audit-log', onError);
  if (!rows) return <Loading />;
  if (rows.length === 0) return <p className="text-sm text-d-text2">{t('admin.noAudit')}</p>;
  return (
    <ol className="divide-y divide-d-divider rounded-lg border border-d-divider">
      {rows.map((a) => (
        <li key={a.id} className="px-3 py-2 text-sm">
          <span className="font-medium text-d-strong">{a.actor_display || a.actor_username || '?'}</span>{' '}
          <span className="text-d-text">{t(`admin.action.${a.action}`)}</span>
          {a.details?.username && <span className="text-d-text2"> · @{a.details.username}</span>}
          {a.details?.to && <span className="text-d-text2"> · {a.details.from} → {a.details.to}</span>}
          {a.details?.action && <span className="text-d-text2"> · {a.details.action}</span>}
          <span className="block text-xs text-d-text3">{fmtDate(a.created_at)}</span>
        </li>
      ))}
    </ol>
  );
}
