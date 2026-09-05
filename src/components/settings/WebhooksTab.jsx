import React, { useState } from 'react';
import { Plus, Trash2, Copy, Webhook, Eye, EyeOff } from 'lucide-react';
import { t, localeTag } from '../../i18n/index.jsx';

/**
 * Webhook management. The token is only ever visible immediately after
 * creation — the server stores a hash, so it genuinely cannot be shown again.
 */
export default function WebhooksTab({ webhooks, channels, currentUserId, reload, onToast }) {
  const [name, setName] = useState('');
  const [channelId, setChannelId] = useState('');
  const [created, setCreated] = useState(null);   // { id, token, url }
  const [revealed, setRevealed] = useState(false);
  const [busy, setBusy] = useState(false);

  const textChannels = channels.filter((c) => c.type === 'text' || c.type === 'announcement');

  const create = async (event) => {
    event.preventDefault();
    if (!channelId || !name.trim()) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/channels/${channelId}/webhooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-user-id': currentUserId },
        body: JSON.stringify({ name: name.trim() })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setCreated(data);
      setRevealed(false);
      setName('');
      await reload();
    } catch (err) {
      onToast?.(err.message, { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const remove = async (webhook) => {
    try {
      const res = await fetch(`/api/webhooks/${webhook.id}`, {
        method: 'DELETE', headers: { 'x-user-id': currentUserId }
      });
      if (!res.ok) throw new Error((await res.json()).error);
      if (created?.id === webhook.id) setCreated(null);
      await reload();
    } catch (err) { onToast?.(err.message, { type: 'error' }); }
  };

  const fullUrl = created ? `${window.location.origin}/api/webhooks/${created.id}/${created.token}` : '';

  return (
    <div>
      <h1 className="text-xl font-bold text-d-strong mb-1">{t('settings.webhooks')}</h1>
      <p className="text-xs text-d-text3 mb-5">
        {t('webhooks.hint')}
      </p>

      <form onSubmit={create} className="bg-d-surface rounded-lg p-4 mb-6 flex items-end gap-3">
        <label className="flex-1">
          <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">{t('common.name')}</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('webhooks.namePlaceholder')}
            className="w-full bg-d-base text-sm text-d-strong px-3 py-2 rounded border border-d-edge focus:outline-none focus:border-d-brand"
          />
        </label>
        <label className="w-48">
          <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">{t('autocomplete.channels')}</span>
          <select
            value={channelId}
            onChange={(e) => setChannelId(e.target.value)}
            className="w-full bg-d-base text-sm text-d-strong px-3 py-2 rounded border border-d-edge focus:outline-none"
          >
            <option value="">{t('settings.selectChannel')}</option>
            {textChannels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
          </select>
        </label>
        <button
          type="submit"
          disabled={busy || !channelId || !name.trim()}
          className="flex items-center gap-1 bg-d-brand hover:bg-d-brandhover disabled:opacity-40 text-white text-xs font-semibold px-4 py-2 rounded transition-colors"
        >
          <Plus className="w-3.5 h-3.5" /> {t('common.create')}
        </button>
      </form>

      {created && (
        <div className="bg-d-idle/10 border border-d-idle/40 rounded-lg p-4 mb-6">
          <p className="text-xs font-bold text-d-idle mb-2">
            {t('webhooks.copyNow')}
          </p>
          <div className="flex items-center gap-2">
            <input
              readOnly
              aria-label={t('webhooks.urlLabel')}
              value={revealed ? fullUrl : fullUrl.replace(created.token, '•'.repeat(24))}
              className="flex-1 bg-d-base text-xs font-mono text-d-text px-3 py-2 rounded border border-d-edge"
            />
            <button
              onClick={() => setRevealed((v) => !v)}
              className="p-2 text-d-text2 hover:text-d-strong transition-colors"
              aria-label={revealed ? t('webhooks.hide') : t('webhooks.reveal')}
            >
              {revealed ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
            <button
              onClick={() => {
                navigator.clipboard?.writeText(fullUrl);
                onToast?.(t('webhooks.urlCopied'), { type: 'success', ttl: 2500 });
              }}
              className="flex items-center gap-1 bg-d-brand hover:bg-d-brandhover text-white text-xs font-semibold px-3 py-2 rounded transition-colors"
            >
              <Copy className="w-3.5 h-3.5" /> {t('common.copy')}
            </button>
          </div>
          <pre className="mt-3 bg-d-base rounded p-2.5 text-[11px] text-d-text3 overflow-x-auto">
{`curl -X POST -H "Content-Type: application/json" \\
  -d '{"content":"Hello from outside"}' \\
  ${revealed ? fullUrl : '<URL above>'}`}
          </pre>
        </div>
      )}

      {webhooks.length === 0 ? (
        <div className="text-center py-10">
          <Webhook className="w-10 h-10 mx-auto mb-2 text-d-control" />
          <p className="text-sm text-d-text3">{t('webhooks.none')}</p>
        </div>
      ) : (
        <div className="space-y-2">
          {webhooks.map((webhook) => (
            <div key={webhook.id} className="bg-d-surface rounded-lg p-3 flex items-center gap-3">
              <Webhook className="w-8 h-8 text-d-brand shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-d-strong truncate">{webhook.name}</p>
                <p className="text-[11px] text-d-text3 truncate">
                  {webhook.channel_name ? `#${webhook.channel_name}` : t('webhooks.channelDeleted')}
                  {' · '}{t('webhooks.createdOn', { date: new Date(webhook.created_at).toLocaleDateString(localeTag()) })}
                </p>
              </div>
              <button
                onClick={() => remove(webhook)}
                className="text-d-text3 hover:text-d-danger transition-colors p-1 shrink-0"
                aria-label={t('common.deleteNamed', { name: webhook.name })}
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
