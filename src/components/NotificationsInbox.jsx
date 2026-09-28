import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useDismiss } from '../hooks/useFocusTrap';
import { Inbox, AtSign, CheckCheck, Sparkles, MessageCircle, Hash } from 'lucide-react';
import { formatRelativeShort, formatFullTimestamp } from '../utils/messageGrouping';
import { t } from '../i18n/index.jsx';
import EmptyState from './ui/EmptyState.jsx';
import useRestoreFocus from './ui/useRestoreFocus.js';
import { menuSurface } from './ui/menu.js';
import { markdownToPlain } from '../utils/plainText.js';

// Mentions, keyword highlights and DMs each get their own glyph and a spoken
// type, so the list is not just "icon, name" to a screen reader.
const TYPE_ICON = { mention: AtSign, keyword: Sparkles, dm: MessageCircle };
const TYPE_LABEL = { mention: 'notif.typeMention', keyword: 'notif.typeKeyword', dm: 'notif.typeDm' };

// Discord's inbox tabs. "Mentions" is @you (and reply pings); "Unreads" is
// every channel with something new, newest first; "For You" is everything
// the inbox holds (mentions, keyword highlights, DMs).
const TABS = [
  { key: 'mentions', label: 'integration.inboxMentions' },
  { key: 'unreads', label: 'integration.inboxUnreads' },
  { key: 'foryou', label: 'integration.inboxForYou' }
];
const TAB_KEY = 'antigravity.inboxTab';
const readTab = () => {
  try { const v = localStorage.getItem(TAB_KEY); return TABS.some((tab) => tab.key === v) ? v : 'mentions'; } catch { return 'mentions'; }
};

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
  x, y, notifications = [], channels = [], readStates = {}, servers = [], resolvers = null, onJump, onOpenChannel, onMarkAllRead, onClose
}) {
  const ref = useRef(null);
  const listRef = useRef(null);
  const [tab, setTab] = useState(readTab);
  const pickTab = (key) => {
    setTab(key);
    try { localStorage.setItem(TAB_KEY, key); } catch { /* storage unavailable */ }
  };

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

  const shown = tab === 'mentions' ? notifications.filter((n) => (n.type ?? 'mention') === 'mention') : notifications;
  // Unread channels we can name, newest activity first (snowflakes sort by time).
  const unreadChannels = useMemo(() => {
    if (tab !== 'unreads') return [];
    const byId = new Map(channels.map((c) => [c.id, c]));
    const serverName = new Map(servers.map((sv) => [sv.id, sv.name]));
    const key = (row) => String(row.last_message_id ?? row.last_read_message_id ?? '').padStart(24, '0');
    return Object.values(readStates)
      .filter((row) => row && (row.unread || row.mention_count > 0) && byId.has(row.channel_id))
      .sort((a, b) => key(b).localeCompare(key(a)))
      .slice(0, 50)
      .map((row) => {
        const channel = byId.get(row.channel_id);
        return {
          channel,
          mentions: Number(row.mention_count) || 0,
          server: channel.server_id ? serverName.get(channel.server_id) ?? '' : ''
        };
      });
  }, [tab, readStates, channels, servers]);

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
        {notifications.length > 0 && tab !== 'unreads' && (
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

      <div role="tablist" aria-label={t('notif.inbox')} className="px-2 pt-1 flex gap-1 border-b border-d-divider/60"
        onKeyDown={(event) => {
          if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
          event.preventDefault();
          const index = TABS.findIndex((x) => x.key === tab);
          const next = TABS[(index + (event.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
          pickTab(next.key);
          event.currentTarget.querySelector(`#inbox-tab-${next.key}`)?.focus();
        }}>
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            id={`inbox-tab-${key}`}
            type="button"
            role="tab"
            aria-selected={tab === key}
            aria-controls="inbox-panel"
            tabIndex={tab === key ? 0 : -1}
            onClick={() => pickTab(key)}
            className={`min-h-8 px-2.5 -mb-px text-sm font-semibold border-b-2 transition-colors ${
              tab === key ? 'border-d-brand text-d-strong' : 'border-transparent text-d-text3 hover:text-d-text'
            }`}
          >
            {t(label)}
          </button>
        ))}
      </div>

      <div id="inbox-panel" role="tabpanel" aria-labelledby={`inbox-tab-${tab}`} className="flex-1 overflow-y-auto overscroll-contain">
        {tab === 'unreads' ? (
          unreadChannels.length === 0 ? (
            <EmptyState art="inbox" compact title={t('notif.emptyTitle')} body={t('integration.inboxNoUnreads')} />
          ) : (
            <ul ref={listRef} onKeyDown={onListKeyDown} aria-labelledby={`inbox-tab-${tab}`}>
              {unreadChannels.map(({ channel, mentions, server }) => {
                const isDm = !channel.server_id;
                const name = isDm ? `@${channel.display_name ?? ''}` : `#${channel.name}`;
                return (
                  <li key={channel.id} className="border-b border-d-divider/40 last:border-b-0">
                    <button
                      type="button"
                      onClick={() => onOpenChannel?.(channel)}
                      className="w-full text-left px-3 py-2.5 hover:bg-d-hover focus-visible:bg-d-hover transition-colors focus-visible:outline-offset-[-2px] flex items-center gap-2"
                    >
                      {isDm
                        ? <MessageCircle className="w-4 h-4 text-d-text3 shrink-0" aria-hidden="true" />
                        : <Hash className="w-4 h-4 text-d-text3 shrink-0" aria-hidden="true" />}
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold text-d-strong truncate">{name}</span>
                        {Boolean(server) && <span className="block text-xs text-d-text3 truncate">{server}</span>}
                      </span>
                      {mentions > 0 && (
                        <span className="bg-d-danger text-white text-[11px] font-bold min-w-5 h-5 px-1 rounded-full flex items-center justify-center shrink-0">
                          <span className="sr-only">{t('a11y.mentionCount', { count: mentions })}</span>
                          <span aria-hidden="true">{mentions > 99 ? '99+' : mentions}</span>
                        </span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )
        ) : shown.length === 0 ? (
          <EmptyState art="inbox" compact title={t('notif.emptyTitle')} body={t('notif.empty')} />
        ) : (
          <ul ref={listRef} onKeyDown={onListKeyDown} aria-labelledby={`inbox-tab-${tab}`}>
            {shown.map((n) => {
              const Icon = TYPE_ICON[n.type] ?? AtSign;
              const who = n.actor_name ?? n.message?.display_name ?? '';
              const where = channelName(n.channel_id);
              // The same words the chat shows: names for <@id> tokens, no markup.
              const preview = markdownToPlain(n.preview ?? n.message?.content ?? '', {
                ...resolvers,
                unknownUser: t('dm.unknownUser'),
                unknownChannel: t('search.unknownChannel'),
                spoiler: `[${t('chat.spoiler')}]`
              });
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
