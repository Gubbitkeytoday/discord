// ============================================================================
//  "Follow #announcements" — pick one of your servers and a text channel in it;
//  announcements published in the source will be relayed there. Mirrors
//  Discord's follow dialog. The target list is loaded on demand per server.
// ============================================================================

import React, { useEffect, useState } from 'react';
import { X, Megaphone, Loader2, Hash, Check } from 'lucide-react';
import { get, post } from '../api';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { t } from '../i18n/index.jsx';

export default function FollowChannelModal({ source, servers = [], onClose, onFollowed, onToast }) {
  const [serverId, setServerId] = useState(servers[0]?.id ?? '');
  const [channels, setChannels] = useState(null);
  const [channelId, setChannelId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const dialogRef = useFocusTrap(true, onClose);

  useEffect(() => {
    if (!serverId) return;
    setChannels(null); setChannelId('');
    get(`/api/servers/${serverId}`)
      .then((d) => {
        const list = (d.channels ?? []).filter((c) => ['text', 'announcement'].includes(c.type) && c.id !== source.id);
        setChannels(list);
        setChannelId(list[0]?.id ?? '');
      })
      .catch((err) => { setChannels([]); setError(err.message); });
  }, [serverId, source.id]);

  const submit = async (e) => {
    e.preventDefault();
    if (!channelId) return;
    setBusy(true); setError(null);
    try {
      const follow = await post(`/api/channels/${source.id}/followers`, { target_channel_id: channelId });
      onFollowed?.(follow);
      onToast?.(t('chat.followed', { channel: follow.target_channel_name }), { type: 'success' });
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[80] bg-black/70 flex items-center justify-center overlay-center p-4" onClick={onClose}>
      <form
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="follow-title"
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md bg-d-canvas rounded-xl shadow-2xl border border-d-edge"
      >
        <header className="flex items-center justify-between px-5 py-4 border-b border-d-edge">
          <h2 id="follow-title" className="font-bold text-d-strong text-lg flex items-center gap-2">
            <Megaphone className="w-5 h-5 text-d-text4" aria-hidden="true" />{t('chat.followChannel')}
          </h2>
          <button type="button" onClick={onClose} className="text-d-text3 hover:text-d-strong" aria-label={t('common.close')}>
            <X className="w-5 h-5" />
          </button>
        </header>
        <div className="p-5 space-y-4">
          <p className="text-sm text-d-text2">{t('chat.followLead', { channel: source.name })}</p>

          <div>
            <label htmlFor="follow-server" className="block text-[11px] font-bold uppercase tracking-wide text-d-text3 mb-1.5">{t('chat.followServer')}</label>
            <select id="follow-server" value={serverId} onChange={(e) => setServerId(e.target.value)}
              className="w-full bg-d-input text-d-strong rounded-md px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-d-brand">
              {servers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>

          <div>
            <label htmlFor="follow-channel" className="block text-[11px] font-bold uppercase tracking-wide text-d-text3 mb-1.5">{t('chat.followTarget')}</label>
            {channels === null ? (
              <div className="flex items-center gap-2 text-sm text-d-text3 py-2"><Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />{t('common.loading')}</div>
            ) : channels.length === 0 ? (
              <p className="text-sm text-d-text3">{t('chat.followNoChannels')}</p>
            ) : (
              <select id="follow-channel" value={channelId} onChange={(e) => setChannelId(e.target.value)}
                className="w-full bg-d-input text-d-strong rounded-md px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-d-brand">
                {channels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
              </select>
            )}
          </div>

          <p className="text-xs text-d-text3 flex items-start gap-1.5"><Hash className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />{t('chat.followNeedsWebhooks')}</p>
          {error && <p role="alert" className="text-sm text-d-danger">{error}</p>}
        </div>
        <footer className="flex justify-end gap-3 px-5 py-4 border-t border-d-edge bg-d-surface/40 rounded-b-xl">
          <button type="button" onClick={onClose} className="text-sm text-d-text2 hover:underline px-3 py-2">{t('common.cancel')}</button>
          <button type="submit" disabled={busy || !channelId}
            className="inline-flex items-center gap-2 bg-d-brand hover:bg-d-brand-hover disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-md">
            {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : <Check className="w-4 h-4" aria-hidden="true" />}
            {t('chat.follow')}
          </button>
        </footer>
      </form>
    </div>
  );
}
