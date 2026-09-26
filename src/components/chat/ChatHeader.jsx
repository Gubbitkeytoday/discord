import React, { forwardRef, memo, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import {
  Hash, Bell, BellOff, Pin, Users, Search, Inbox, UserPlus, MessagesSquare, Archive, Megaphone, Volume2, Lock,
  ChevronRight, Menu, Phone, Video, MoreVertical
} from 'lucide-react';
import ContextMenu from '../ContextMenu';
import { t } from '../../i18n/index.jsx';
import { defaultAvatar } from '../../utils/avatar';
import { proxiedImageUrl } from '../../utils/media';

const HEADER_ICONS = { announcement: Megaphone, voice: Volume2, forum: MessagesSquare, thread: MessagesSquare };

// Header buttons: 32 px with a mouse, 44 px on touch (WCAG 2.5.8 / Apple HIG).
const BTN = 'relative shrink-0 w-8 h-8 pointer-coarse:w-11 pointer-coarse:h-11 inline-flex items-center justify-center rounded-md text-d-text2 hover:text-d-strong hover:bg-d-hover/60 transition-colors';

function Badge({ count, tone = 'bg-d-danger' }) {
  if (!count) return null;
  return (
    <span className={`absolute top-0 right-0 ${tone} text-white text-[10px] font-bold min-w-4 h-4 px-0.5 rounded-full flex items-center justify-center`} aria-hidden="true">
      {count > 9 ? '9+' : count}
    </span>
  );
}

/**
 * The channel header: the channel name as the page's <h1>, then its actions.
 *
 * Buttons that do not fit collapse into a "More" (⋮) menu by the header's
 * *own* width — so a phone, a 200 % zoom and a narrow window with the member
 * list open all keep Search, Pins, Inbox, Members and Notification settings
 * reachable (WCAG 1.4.10), instead of losing them below a breakpoint.
 */
const ChatHeader = forwardRef(function ChatHeader({
  channel, title, isDM, parentChannel, muted, pinsCount, showPins, showMemberList, inboxCount,
  onOpenMobileSidebar, onStartCall, onFollowChannel, onArchiveThread, onAddGroupRecipients,
  onOpenNotificationSettings, onTogglePins, onToggleMemberList, onOpenInbox, onSearch, onOpenMobileSearch,
  onSelectChannel, isArchived
}, ref) {
  const rootRef = useRef(null);
  const searchRef = useRef(null);
  const [width, setWidth] = useState(1024);
  const [term, setTerm] = useState('');
  const [menu, setMenu] = useState(null);

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el) return undefined;
    setWidth(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const wide = width >= 700;          // everything inline, search box included
  const medium = width >= 460;        // pins + members inline
  const compact = width >= 330;       // a search icon at least (phones)

  useImperativeHandle(ref, () => ({
    /** Ctrl+F: the search box when it is on screen, else the search sheet. */
    focusSearch() {
      const input = searchRef.current;
      if (input && input.offsetParent !== null) { input.focus(); input.select(); return; }
      onOpenMobileSearch?.();
    }
  }), [onOpenMobileSearch]);

  const HeaderIcon = HEADER_ICONS[channel.type] ?? Hash;
  const openAt = (fn) => (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    fn(rect);
  };

  const overflow = [
    !compact && { icon: Search, label: t('chat.searchMessages'), action: () => onOpenMobileSearch?.() },
    !medium && { icon: Pin, label: pinsCount ? `${t('chat.pinnedMessages')} (${pinsCount})` : t('chat.pinnedMessages'), action: onTogglePins },
    !medium && !isDM && onToggleMemberList && { icon: Users, label: t('chat.memberList'), checked: showMemberList, action: onToggleMemberList },
    !wide && onOpenInbox && {
      icon: Inbox,
      label: inboxCount > 0 ? `${t('notif.inbox')} (${inboxCount})` : t('notif.inbox'),
      action: () => onOpenInbox(window.innerWidth - 8, (menu?.y ?? 48))
    },
    !wide && onOpenNotificationSettings && {
      icon: muted ? BellOff : Bell,
      label: t('notif.notificationSettings'),
      action: () => onOpenNotificationSettings(Math.max(8, (menu?.x ?? 200) - 120), menu?.y ?? 48)
    }
  ].filter(Boolean);

  return (
    <header
      ref={rootRef}
      className="h-12 pointer-coarse:h-14 px-4 max-sm:px-2 shadow-sm border-b border-d-edge flex items-center justify-between gap-2 shrink-0 bg-d-canvas z-10 pt-[env(safe-area-inset-top)] box-content"
    >
      <div className="flex items-center gap-2 min-w-0 flex-1">
        {onOpenMobileSidebar && (
          <button type="button" onClick={onOpenMobileSidebar} className={`${BTN} md:hidden`} aria-label={t('sidebar.openChannels')}>
            <Menu className="w-5 h-5" aria-hidden="true" />
          </button>
        )}
        {isDM ? (
          <img src={proxiedImageUrl(channel.avatar_url || defaultAvatar(channel.recipients?.[0]?.id ?? channel.id))} alt="" width={24} height={24} className="w-6 h-6 rounded-full object-cover shrink-0" />
        ) : (
          <HeaderIcon className="w-6 h-6 text-d-text3 shrink-0" aria-hidden="true" />
        )}
        {parentChannel && (
          <>
            <button
              type="button"
              onClick={() => onSelectChannel?.(parentChannel.id)}
              className="text-d-text3 hover:text-d-strong text-[15px] font-semibold truncate max-w-[10rem] max-sm:hidden"
              title={t('chat.backToChannel', { channel: parentChannel.name })}
            >
              {parentChannel.name}
            </button>
            <ChevronRight className="w-4 h-4 text-d-text3 shrink-0 max-sm:hidden" aria-hidden="true" />
          </>
        )}
        <h1 id="channel-title" tabIndex={-1} className="font-bold text-d-strong text-[15px] truncate min-w-0 outline-none">
          <span className="sr-only">{isDM ? t('a11y.conversationWith') : t('a11y.channelPrefix')} </span>
          {title}
        </h1>
        {Boolean(channel.is_private) && (
          <Lock className="w-3.5 h-3.5 text-d-text3 shrink-0" aria-label={t('a11y.privateChannel')} role="img" />
        )}
        {isArchived && (
          <span className="text-[11px] bg-d-surface text-d-text3 px-1.5 py-0.5 rounded shrink-0">{t('chat.archived')}</span>
        )}
        {Boolean(channel.topic) && wide && (
          <>
            <div className="w-px h-4 bg-d-divider mx-2 shrink-0" aria-hidden="true" />
            <span className="text-xs text-d-text3 truncate min-w-0" title={channel.topic}>{channel.topic}</span>
          </>
        )}
      </div>

      <div className="flex items-center gap-1 text-d-text2 shrink-0">
        {onStartCall && (
          <>
            <button type="button" onClick={() => onStartCall(false)} className={BTN} title={t('call.start')} aria-label={t('call.start')}>
              <Phone className="w-5 h-5" aria-hidden="true" />
            </button>
            <button type="button" onClick={() => onStartCall(true)} className={BTN} title={t('call.startVideo')} aria-label={t('call.startVideo')}>
              <Video className="w-5 h-5" aria-hidden="true" />
            </button>
          </>
        )}
        {channel.type === 'announcement' && onFollowChannel && (
          <button
            type="button"
            onClick={() => onFollowChannel(channel)}
            className="inline-flex items-center gap-1.5 text-xs font-semibold bg-d-surface hover:bg-d-hover text-d-strong px-2.5 min-h-8 pointer-coarse:min-h-11 rounded-md"
            title={t('chat.followChannelHint')}
            aria-label={t('chat.followChannel')}
          >
            <Megaphone className="w-3.5 h-3.5" aria-hidden="true" />{medium && <span>{t('chat.followChannel')}</span>}
          </button>
        )}
        {onArchiveThread && (
          <button type="button" onClick={() => onArchiveThread(!isArchived)} className={BTN}
            title={isArchived ? t('chat.unarchiveThread') : t('chat.archiveThread')}
            aria-label={isArchived ? t('chat.unarchiveThread') : t('chat.archiveThread')}>
            <Archive className="w-5 h-5" aria-hidden="true" />
          </button>
        )}
        {onAddGroupRecipients && (
          <button type="button" onClick={onAddGroupRecipients} className={BTN} title={t('dm.addToGroup')} aria-label={t('dm.addToGroup')}>
            <UserPlus className="w-5 h-5" aria-hidden="true" />
          </button>
        )}
        {wide && onOpenNotificationSettings && (
          <button
            type="button"
            onClick={openAt((rect) => onOpenNotificationSettings(rect.left - 120, rect.bottom + 6))}
            className={`${BTN} ${muted ? 'text-d-danger' : ''}`}
            title={t('notif.notificationSettings')}
            aria-label={muted ? t('notif.notificationSettingsMuted') : t('notif.notificationSettings')}
          >
            {muted ? <BellOff className="w-5 h-5" aria-hidden="true" /> : <Bell className="w-5 h-5" aria-hidden="true" />}
          </button>
        )}
        {medium && (
          <button
            type="button"
            onClick={onTogglePins}
            className={`${BTN} ${showPins ? 'text-d-strong' : ''}`}
            title={t('chat.pinnedMessages')}
            aria-label={pinsCount ? t('chat.pinnedMessagesCount', { count: pinsCount }) : t('chat.pinnedMessages')}
            aria-expanded={showPins}
            aria-keyshortcuts="Control+P"
          >
            <Pin className="w-5 h-5" aria-hidden="true" />
            <Badge count={pinsCount} tone="bg-d-brand" />
          </button>
        )}
        {medium && !isDM && onToggleMemberList && (
          <button
            type="button"
            onClick={onToggleMemberList}
            className={`${BTN} ${showMemberList ? 'text-d-strong' : ''}`}
            title={t('chat.memberList')}
            aria-label={t('chat.memberList')}
            aria-pressed={showMemberList}
          >
            <Users className="w-5 h-5" aria-hidden="true" />
          </button>
        )}
        {wide && onOpenInbox && (
          <button
            type="button"
            onClick={openAt((rect) => onOpenInbox(rect.right, rect.bottom + 6))}
            className={BTN}
            title={t('notif.inbox')}
            aria-label={inboxCount ? t('notif.inboxCount', { count: inboxCount }) : t('notif.inbox')}
          >
            <Inbox className="w-5 h-5" aria-hidden="true" />
            <Badge count={inboxCount} />
          </button>
        )}
        {compact && !wide && (
          <button type="button" onClick={onOpenMobileSearch} className={BTN} title={t('chat.searchMessages')} aria-label={t('chat.searchMessages')} aria-keyshortcuts="Control+F">
            <Search className="w-5 h-5" aria-hidden="true" />
          </button>
        )}
        {overflow.length > 0 && (
          <button
            type="button"
            onClick={openAt((rect) => setMenu({ x: rect.right - 224, y: rect.bottom + 6 }))}
            className={BTN}
            title={t('chat.moreOptions')}
            aria-label={t('chat.moreOptions')}
            aria-haspopup="menu"
            aria-expanded={Boolean(menu)}
          >
            <MoreVertical className="w-5 h-5" aria-hidden="true" />
            {!wide && inboxCount > 0 && <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-d-danger" aria-hidden="true" />}
          </button>
        )}
        {wide && (
          <form
            role="search"
            onSubmit={(e) => { e.preventDefault(); onSearch?.(term); }}
            className="relative ml-1"
          >
            <input
              ref={searchRef}
              type="search"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder={t('common.search')}
              aria-label={t('chat.searchMessages')}
              aria-keyshortcuts="Control+F"
              className="bg-d-base text-sm text-d-strong placeholder-d-text3 pl-2 pr-8 h-8 rounded w-36 focus:w-56 transition-[width] focus:outline-none focus-visible:ring-2 focus-visible:ring-d-brand"
            />
            <button type="submit" className="absolute right-0 top-0 w-8 h-8 inline-flex items-center justify-center text-d-text3 hover:text-d-strong" title={t('chat.searchMessages')} aria-label={t('chat.searchSubmit')}>
              <Search className="w-4 h-4" aria-hidden="true" />
            </button>
          </form>
        )}
      </div>

      {menu && <ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={overflow} />}
    </header>
  );
});

export default memo(ChatHeader);
