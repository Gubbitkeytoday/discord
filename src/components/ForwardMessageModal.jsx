import React, { useMemo, useState } from 'react';
import { Hash, Loader2, Search, Send, Users, X } from 'lucide-react';
import { useDialog } from './settings/primitives';
import { t, useLocaleCode } from '../i18n/index.jsx';
import { markdownToPlain } from '../utils/plainText.js';

/**
 * Forward a message to another channel or conversation, the way Discord's
 * Forward dialog works: pick one or more destinations, send, done.
 */
export default function ForwardMessageModal({
  message, channels = [], dms = [], servers = [], onForward, onClose, onDone, maxDestinations = 5
}) {
  const [filter, setFilter] = useState('');
  const [selected, setSelected] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const dialogRef = useDialog(onClose);

  const serverName = (id) => servers.find((s) => s.id === id)?.name ?? '';

  // Translated labels are memoised; recompute when the language changes.
  const locale = useLocaleCode();
  const options = useMemo(() => {
    const entries = [
      ...channels.map((c) => ({ id: c.id, label: `#${c.name}`, sub: serverName(c.server_id), icon: Hash })),
      ...dms.map((d) => ({ id: d.id, label: d.display_name, sub: d.type === 'group_dm' ? t('dm.groupDm') : t('dm.directMessages'), icon: Users }))
    ];
    const needle = filter.trim().toLowerCase();
    if (!needle) return entries;
    return entries.filter((e) => e.label.toLowerCase().includes(needle) || (e.sub ?? '').toLowerCase().includes(needle));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channels, dms, filter, servers, locale]);

  // One forward goes to at most `maxDestinations` places (the server holds
  // the same line), so a message cannot be sprayed across every channel.
  const atLimit = selected.length >= maxDestinations;
  const toggle = (id) => setSelected((prev) => {
    if (prev.includes(id)) return prev.filter((x) => x !== id);
    return prev.length >= maxDestinations ? prev : [...prev, id];
  });

  const submit = async () => {
    if (!selected.length) return;
    setBusy(true);
    setError(null);
    try {
      for (const channelId of selected) await onForward(channelId);
      onDone?.(selected.length);
      onClose();
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/70 z-[70] flex items-center justify-center overlay-center p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('chat.forward')}
        className="bg-d-canvas w-full max-w-md rounded-lg shadow-2xl border border-d-surface overflow-hidden flex flex-col max-h-[80vh]"
      >
        <div className="p-4 border-b border-d-divider flex items-center justify-between">
          <h2 className="text-base font-bold text-d-strong">{t('chat.forward')}</h2>
          <button onClick={onClose} className="text-d-text3 hover:text-d-strong" aria-label={t('common.close')}>
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-3 border-b border-d-divider relative">
          <Search className="w-4 h-4 text-d-text4 absolute left-6 top-1/2 -translate-y-1/2" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('chat.forwardSearch')}
            autoFocus
            className="w-full bg-d-base text-sm text-d-strong pl-9 pr-3 py-2 rounded border border-d-edge focus:outline-none focus:border-d-brand"
          />
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
          {options.length === 0 && <p className="text-xs text-d-text4 p-3">{t('common.noResults')}</p>}
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              onClick={() => toggle(option.id)}
              aria-pressed={selected.includes(option.id)}
              disabled={atLimit && !selected.includes(option.id)}
              className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded text-left transition-colors ${
                selected.includes(option.id) ? 'bg-d-active' : 'hover:bg-d-hover/60 disabled:opacity-50 disabled:hover:bg-transparent'
              }`}
            >
              <option.icon className="w-4 h-4 text-d-text4 shrink-0" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-d-strong truncate">{option.label}</span>
                {Boolean(option.sub) && <span className="block text-[11px] text-d-text3 truncate">{option.sub}</span>}
              </span>
              <span className={`w-4 h-4 rounded border shrink-0 ${selected.includes(option.id) ? 'bg-d-brand border-d-brand' : 'border-d-text4'}`} />
            </button>
          ))}
        </div>

        <div className="p-3 border-t border-d-divider bg-d-surface/40">
          <div className="text-[11px] text-d-text3 mb-2 line-clamp-2 whitespace-pre-wrap break-words">
            {(message.content && markdownToPlain(message.content, {
              resolveChannel: (id) => channels.find((c) => c.id === id)?.name ?? null,
              unknownUser: t('dm.unknownUser'), unknownChannel: t('search.unknownChannel'),
              spoiler: `[${t('chat.spoiler')}]`, singleLine: false
            })) || t('chat.attachmentCount', { count: message.attachments?.length ?? 0 })}
          </div>
          <p className={`text-[11px] mb-2 ${atLimit ? 'text-d-text2 font-semibold' : 'text-d-text3'}`} aria-live="polite">
            {t('integration.forwardLimit', { count: maxDestinations })}
          </p>
          {error && <p className="text-xs text-d-dangertext mb-2" role="alert">{error}</p>}
          <button
            onClick={submit}
            disabled={busy || selected.length === 0}
            className="w-full bg-d-brand hover:bg-d-brandhover disabled:opacity-50 text-white text-sm font-semibold py-2 rounded flex items-center justify-center gap-2 transition-colors"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
            {t('chat.forwardTo', { count: selected.length })}
          </button>
        </div>
      </div>
    </div>
  );
}
