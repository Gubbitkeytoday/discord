import React, { useEffect, useRef } from 'react';
import { Inbox, AtSign, Check } from 'lucide-react';
import { formatRelativeShort } from '../utils/messageGrouping';
import { t } from '../i18n/index.jsx';

/**
 * The mention inbox behind the bell. Each row jumps straight to the message,
 * which is the only thing an inbox is really for.
 */
export default function NotificationsInbox({
  x, y, notifications = [], channels = [], onJump, onMarkAllRead, onClose
}) {
  const ref = useRef(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    const onClick = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    window.addEventListener('keydown', onKey);
    const timer = setTimeout(() => window.addEventListener('mousedown', onClick), 0);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClick);
      clearTimeout(timer);
    };
  }, [onClose]);

  const channelName = (id) => {
    const channel = channels.find((c) => c.id === id);
    if (!channel) return '';
    return channel.type === 'dm' || channel.type === 'group_dm' ? `@${channel.display_name}` : `#${channel.name}`;
  };

  const style = {
    left: Math.max(8, Math.min(x - 360, window.innerWidth - 380)),
    top: Math.min(y, window.innerHeight - 460)
  };

  return (
    <div
      ref={ref}
      style={style}
      role="dialog"
      aria-modal="false"
      aria-label={t('notif.inbox')}
      className="fixed z-[60] w-[360px] max-h-[440px] bg-d-sunken border border-d-surface rounded-md shadow-2xl flex flex-col"
    >
      <div className="px-3 py-2.5 border-b border-d-surface flex items-center justify-between">
        <h2 className="text-sm font-bold text-d-strong flex items-center gap-2">
          <Inbox className="w-4 h-4" /> {t('notif.inbox')}
        </h2>
        <button onClick={onMarkAllRead} className="text-[11px] text-d-link hover:underline flex items-center gap-1">
          <Check className="w-3 h-3" /> {t('notif.markAllRead')}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {notifications.length === 0 && (
          <p className="p-6 text-center text-xs text-d-text4">{t('notif.empty')}</p>
        )}
        {notifications.map((n) => (
          <button
            key={n.id}
            onClick={() => onJump(n)}
            className={`w-full text-left px-3 py-2.5 border-b border-d-surface/60 hover:bg-d-hover/50 transition-colors ${
              n.read_at ? 'opacity-60' : ''
            }`}
          >
            <div className="flex items-center gap-2 mb-0.5">
              <AtSign className="w-3 h-3 text-d-mention shrink-0" />
              <span className="text-xs font-semibold text-d-strong truncate">
                {n.actor_name ?? n.message?.display_name ?? ''}
              </span>
              <span className="text-[10px] text-d-text4 truncate">{channelName(n.channel_id)}</span>
              <span className="text-[10px] text-d-text4 ml-auto shrink-0">
                {formatRelativeShort(n.created_at)}
              </span>
            </div>
            <p className="text-xs text-d-text2 line-clamp-2 break-words">
              {n.preview ?? n.message?.content ?? ''}
            </p>
          </button>
        ))}
      </div>
    </div>
  );
}
