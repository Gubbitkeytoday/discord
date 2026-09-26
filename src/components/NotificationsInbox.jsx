import React, { useEffect, useRef } from 'react';
import { useDismiss } from '../hooks/useFocusTrap';
import { Inbox, AtSign, CheckCheck, Sparkles, MessageCircle } from 'lucide-react';
import { formatRelativeShort, formatFullTimestamp } from '../utils/messageGrouping';
import { t } from '../i18n/index.jsx';
import EmptyState from './ui/EmptyState.jsx';
import useRestoreFocus from './ui/useRestoreFocus.js';
import { menuSurface } from './ui/menu.js';

// Mentions, keyword highlights and DMs each get their own glyph and a spoken
// type, so the list is not just "icon, name" to a screen reader.
const TYPE_ICON = { mention: AtSign, keyword: Sparkles, dm: MessageCircle };
const TYPE_LABEL = { mention: 'notif.typeMention', keyword: 'notif.typeKeyword', dm: 'notif.typeDm' };

const isoOrUndefined = (value) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

/**
 * The mention inbox behind the bell. Each row jumps straight to the message,
 * which is the only thing an inbox is really for.
 *
 * A non-modal dialog: focus moves into it on open (the first unread item, or
 * the heading) and returns to the bell on close; ↑/↓ walk the items; the
 * list is a real list, and each item says what it is, who, where and when.
 */
export default function NotificationsInbox({
  x, y, notifications = [], channels = [], onJump, onMarkAllRead, onClose
}) {
  const ref = useRef(null);
  const listRef = useRef(null);

  useDismiss(ref, onClose);
  useRestoreFocus(ref);

  useEffect(() => {
    const first = listRef.current?.querySelector('button');
    (first ?? ref.current)?.focus();
  }, []);

  const channelName = (id) => {
    const channel = channels.find((c) => c.id === id);
    if (!channel) return '';
    return channel.type === 'dm' || channel.type === 'group_dm' ? `@${channel.display_name}` : `#${channel.name}`;
  };

  const onListKeyDown = (event) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const items = [...(listRef.current?.querySelectorAll('button') ?? [])];
    const index = items.indexOf(document.activeElement);
    const next = items[event.key === 'ArrowDown' ? Math.min(index + 1, items.length - 1) : Math.max(index - 1, 0)];
    if (!next) return;
    event.preventDefault();
    next.focus();
  };

  const width = 380;
  const style = {
    left: Math.max(8, Math.min(x - width, window.innerWidth - width - 8)),
    top: Math.max(8, Math.min(y, window.innerHeight - 480)),
    width: `min(${width}px, calc(100vw - 16px))`
  };
  const unread = notifications.filter((n) => !n.read_at).length;

  return (
    <div
      ref={ref}
      style={style}
      role="dialog"
      aria-modal="false"
      aria-labelledby="inbox-heading"
      tabIndex={-1}
      className={`fixed z-[60] max-h-[min(480px,calc(100dvh-16px))] flex flex-col !py-0 ${menuSurface}`}
    >
      <div className="px-3 py-2 border-b border-d-divider/60 flex items-center justify-between gap-2">
        <h2 id="inbox-heading" className="text-base font-bold text-d-strong flex items-center gap-2">
          <Inbox className="w-5 h-5" aria-hidden="true" /> {t('notif.inbox')}
          {unread > 0 && <span className="sr-only">, {t('notif.unreadCount', { count: unread })}</span>}
        </h2>
        {notifications.length > 0 && (
          <button
            type="button"
            onClick={onMarkAllRead}
            className="min-h-8 px-2 rounded-[var(--radius-d-sm)] text-xs font-semibold text-d-link hover:bg-d-hover
              hover:underline flex items-center gap-1.5"
          >
            <CheckCheck className="w-4 h-4" aria-hidden="true" /> {t('notif.markAllRead')}
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto overscroll-contain">
        {notifications.length === 0 ? (
          <EmptyState art="inbox" compact title={t('notif.emptyTitle')} body={t('notif.empty')} />
        ) : (
          <ul ref={listRef} onKeyDown={onListKeyDown} aria-labelledby="inbox-heading">
            {notifications.map((n) => {
              const Icon = TYPE_ICON[n.type] ?? AtSign;
              const who = n.actor_name ?? n.message?.display_name ?? '';
              const where = channelName(n.channel_id);
              const preview = n.preview ?? n.message?.content ?? '';
              return (
                <li key={n.id} className="border-b border-d-divider/40 last:border-b-0">
                  <button
                    type="button"
                    onClick={() => onJump(n)}
                    className={`w-full text-left px-3 py-2.5 hover:bg-d-hover focus-visible:bg-d-hover transition-colors
                      focus-visible:outline-offset-[-2px] ${n.read_at ? '' : 'bg-d-brand/5'}`}
                  >
                    <span className="sr-only">
                      {[t(TYPE_LABEL[n.type] ?? 'notif.typeMention'), n.read_at ? '' : t('a11y.unread')].filter(Boolean).join(', ')}.{' '}
                    </span>
                    <span className="flex items-center gap-2 mb-1">
                      <Icon className="w-4 h-4 text-d-mention shrink-0" aria-hidden="true" />
                      <span className="text-sm font-semibold text-d-strong truncate">{who}</span>
                      <span className="text-xs text-d-text3 truncate">{where}</span>
                      <time
                        dateTime={isoOrUndefined(n.created_at)}
                        title={formatFullTimestamp(n.created_at)}
                        className="text-xs text-d-text3 ml-auto shrink-0"
                      >
                        {formatRelativeShort(n.created_at)}
                      </time>
                      {!n.read_at && <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full bg-d-danger" />}
                    </span>
                    <span className={`block text-sm line-clamp-2 break-words ${n.read_at ? 'text-d-text3' : 'text-d-text2'}`}>
                      {preview}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
