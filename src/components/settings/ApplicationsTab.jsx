// ============================================================================
//  User Settings → Developer. Create an application, copy its token once,
//  invite its bot to a server with an explicit permission list, and see where
//  it already is. The token is shown exactly once, at creation or after a
//  reset, because only its hash is stored.
// ============================================================================

import React, { useEffect, useMemo, useState } from 'react';
import {
  Bot, Plus, Copy, RefreshCw, Trash2, Loader2, Check, ShieldAlert, Server as ServerIcon, X
} from 'lucide-react';
import { get, post, patch, del } from '../../api';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { t } from '../../i18n/index.jsx';
import { PageHeader, Section, Note, Divider } from './primitives';

const inputClass = 'w-full bg-d-input text-d-strong rounded-md px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-d-brand';

/** Sensible defaults for a chat bot — everything else is opt-in. */
const DEFAULT_PERMISSIONS = ['VIEW_CHANNEL', 'SEND_MESSAGES', 'EMBED_LINKS', 'READ_MESSAGE_HISTORY', 'ADD_REACTIONS'];

export default function ApplicationsTab({ servers = [], onToast }) {
  const [apps, setApps] = useState(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [freshToken, setFreshToken] = useState(null);   // { id, token }
  const [inviting, setInviting] = useState(null);       // application being invited

  const load = () => get('/api/applications')
    .then((list) => setApps(Array.isArray(list) ? list : []))
    .catch((err) => { setApps([]); onToast?.(err.message, { type: 'error' }); });

  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const create = async (event) => {
    event.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const app = await post('/api/applications', { name: name.trim() });
      setName('');
      setFreshToken({ id: app.id, token: app.token });
      await load();
    } catch (err) {
      onToast?.(err.message, { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const copy = (value) => {
    navigator.clipboard?.writeText(value);
    onToast?.(t('common.copied'), { type: 'success', ttl: 2000 });
  };

  return (
    <div>
      <PageHeader title={t('dev.title')} description={t('dev.lead')} />

      <Note tone="brand">{t('dev.tokenWarning')}</Note>

      <Divider />

      <Section title={t('dev.newApplication')} description={t('dev.newApplicationHint')}>
        <form onSubmit={create} className="flex flex-wrap gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value.slice(0, 32))}
            placeholder={t('dev.namePlaceholder')}
            aria-label={t('dev.name')}
            className={`${inputClass} flex-1 min-w-[12rem]`}
          />
          <button
            type="submit"
            disabled={busy || !name.trim()}
            className="inline-flex items-center gap-1.5 bg-d-brand hover:bg-d-brand-hover disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-md"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Plus className="w-4 h-4" aria-hidden="true" />}
            {t('dev.create')}
          </button>
        </form>
      </Section>

      <Divider />

      <Section title={t('dev.yourApplications')}>
        {apps === null ? (
          <div className="flex justify-center py-8 text-d-text3" role="status">
            <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
            <span className="sr-only">{t('common.loading')}</span>
          </div>
        ) : apps.length === 0 ? (
          <p className="text-sm text-d-text3">{t('dev.none')}</p>
        ) : (
          <ul className="space-y-3">
            {apps.map((app) => (
              <li key={app.id} className="bg-d-surface/60 border border-d-edge rounded-lg p-4">
                <div className="flex items-start gap-3">
                  <div className="w-10 h-10 rounded-full bg-d-brand/20 flex items-center justify-center shrink-0">
                    {app.icon_url
                      ? <img src={app.icon_url} alt="" className="w-full h-full rounded-full object-cover" />
                      : <Bot className="w-5 h-5 text-d-brand" aria-hidden="true" />}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-d-strong truncate">{app.name}</span>
                      <span className="bg-d-brand text-white text-[9px] font-bold px-1.5 rounded">BOT</span>
                    </div>
                    <div className="text-[11px] text-d-text3 mt-0.5">
                      {app.bot?.username}#{app.bot?.discriminator} · <code className="select-all">{app.id}</code>
                    </div>

                    {freshToken?.id === app.id && (
                      <div className="mt-2 bg-d-canvas border border-d-brand/50 rounded-md p-2">
                        <p className="text-[11px] text-d-text3 mb-1">{t('dev.tokenOnce')}</p>
                        <div className="flex items-center gap-2">
                          <code className="text-xs text-d-strong break-all select-all flex-1">{freshToken.token}</code>
                          <button type="button" onClick={() => copy(freshToken.token)}
                            className="shrink-0 text-xs font-semibold bg-d-surface hover:bg-d-hover text-d-strong px-2 py-1 rounded"
                          >
                            <Copy className="w-3.5 h-3.5 inline" aria-hidden="true" /> {t('dev.copy')}
                          </button>
                          <button type="button" onClick={() => setFreshToken(null)}
                            className="shrink-0 text-d-text3 hover:text-d-strong" aria-label={t('common.close')}
                          >
                            <X className="w-4 h-4" />
                          </button>
                        </div>
                      </div>
                    )}

                    <div className="flex flex-wrap items-center gap-2 mt-3">
                      <button
                        type="button"
                        onClick={() => setInviting(app)}
                        className="inline-flex items-center gap-1.5 text-xs font-semibold bg-d-brand hover:bg-d-brand-hover text-white px-3 py-1.5 rounded-md"
                      >
                        <ServerIcon className="w-3.5 h-3.5" aria-hidden="true" />{t('dev.addToServer')}
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            const { token } = await post(`/api/applications/${app.id}/token`, {});
                            setFreshToken({ id: app.id, token });
                            onToast?.(t('dev.tokenReset'), { type: 'success' });
                          } catch (err) { onToast?.(err.message, { type: 'error' }); }
                        }}
                        className="inline-flex items-center gap-1.5 text-xs font-semibold bg-d-surface hover:bg-d-hover text-d-strong px-3 py-1.5 rounded-md"
                      >
                        <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />{t('dev.resetToken')}
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            await del(`/api/applications/${app.id}`);
                            onToast?.(t('dev.deleted', { name: app.name }), { type: 'success' });
                            await load();
                          } catch (err) { onToast?.(err.message, { type: 'error' }); }
                        }}
                        className="inline-flex items-center gap-1.5 text-xs font-semibold text-d-danger hover:underline px-2 py-1.5"
                      >
                        <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />{t('common.delete')}
                      </button>
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Note>{t('dev.docsHint')}</Note>

      {inviting && (
        <InviteBotModal
          application={inviting}
          servers={servers}
          onClose={() => setInviting(null)}
          onToast={onToast}
        />
      )}
    </div>
  );
}

function InviteBotModal({ application, servers, onClose, onToast }) {
  const [available, setAvailable] = useState([]);
  const [serverId, setServerId] = useState(servers[0]?.id ?? '');
  const [selected, setSelected] = useState(DEFAULT_PERMISSIONS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const dialogRef = useFocusTrap(true, onClose);

  useEffect(() => {
    get('/api/meta/bot-permissions')
      .then((list) => setAvailable(Array.isArray(list) ? list : []))
      .catch(() => setAvailable(DEFAULT_PERMISSIONS));
  }, []);

  const grouped = useMemo(() => available.slice().sort(), [available]);

  const toggle = (permission) => setSelected((current) => (
    current.includes(permission) ? current.filter((p) => p !== permission) : [...current, permission]
  ));

  const submit = async (event) => {
    event.preventDefault();
    if (!serverId) return;
    setBusy(true); setError(null);
    try {
      await post(`/api/applications/${application.id}/invite`, { server_id: serverId, permissions: selected });
      onToast?.(t('dev.invited', { name: application.name }), { type: 'success' });
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[90] bg-black/70 flex items-center justify-center overlay-center p-4" onClick={onClose}>
      <form
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="invite-bot-title"
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-d-canvas rounded-xl shadow-2xl border border-d-edge flex flex-col max-h-[calc(100vh-2rem)]"
      >
        <header className="flex items-center justify-between px-5 py-4 border-b border-d-edge">
          <h2 id="invite-bot-title" className="font-bold text-d-strong text-lg flex items-center gap-2">
            <Bot className="w-5 h-5 text-d-text4" aria-hidden="true" />{t('dev.addToServer')}
          </h2>
          <button type="button" onClick={onClose} className="text-d-text3 hover:text-d-strong" aria-label={t('common.close')}>
            <X className="w-5 h-5" />
          </button>
        </header>

        <div className="p-5 space-y-4 overflow-y-auto">
          <div>
            <label htmlFor="invite-bot-server" className="block text-[11px] font-bold uppercase tracking-wide text-d-text3 mb-1.5">
              {t('dev.server')}
            </label>
            <select id="invite-bot-server" value={serverId} onChange={(e) => setServerId(e.target.value)} className={inputClass}>
              {servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>

          <fieldset>
            <legend className="text-[11px] font-bold uppercase tracking-wide text-d-text3 mb-1.5">
              {t('dev.permissions')} ({selected.length})
            </legend>
            <p className="text-xs text-d-text3 mb-2">{t('dev.permissionsHint')}</p>
            <div className="max-h-56 overflow-y-auto grid grid-cols-1 sm:grid-cols-2 gap-1">
              {grouped.map((permission) => (
                <label key={permission} className="flex items-center gap-2 text-xs text-d-text2 px-1 py-0.5 rounded hover:bg-d-surface/60">
                  <input
                    type="checkbox"
                    checked={selected.includes(permission)}
                    onChange={() => toggle(permission)}
                    className="accent-d-brand"
                  />
                  <span className="truncate">{permission}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <p className="text-xs text-d-text3 flex items-start gap-1.5">
            <ShieldAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />{t('dev.noAdmin')}
          </p>
          {error && <p role="alert" className="text-sm text-d-danger">{error}</p>}
        </div>

        <footer className="flex justify-end gap-3 px-5 py-4 border-t border-d-edge bg-d-surface/40 rounded-b-xl">
          <button type="button" onClick={onClose} className="text-sm text-d-text2 hover:underline px-3 py-2">{t('common.cancel')}</button>
          <button
            type="submit"
            disabled={busy || !serverId}
            className="inline-flex items-center gap-2 bg-d-brand hover:bg-d-brand-hover disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-md"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Check className="w-4 h-4" aria-hidden="true" />}
            {t('dev.authorize')}
          </button>
        </footer>
      </form>
    </div>
  );
}
