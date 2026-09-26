import React, {
  forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState
} from 'react';
import { useVirtualizer, defaultRangeExtractor } from '@tanstack/react-virtual';
import { ArrowDown, CheckCheck, Loader2 } from 'lucide-react';
import { t, localeTag } from '../../i18n/index.jsx';
import { messageFlags, formatTime } from '../../utils/messageGrouping';
import MessageRow from './MessageRow';

// "Following the conversation" = within this many px of the bottom.
const AT_BOTTOM_PX = 120;
// Start fetching the next page this far before the edge is reached.
const PAGE_AHEAD_PX = 1200;

const hoverless = () => {
  try { return window.matchMedia('(hover: none)').matches; } catch { return false; }
};

/** "3:42 PM" today, "Mar 3, 3:42 PM" otherwise — the unread bar's "since". */
function formatUnreadSince(date, use24Hour) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const time = formatTime(d, localeTag(), use24Hour);
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString(localeTag(), { month: 'short', day: 'numeric' })}, ${time}`;
}

/**
 * The message history: a virtualised, bottom-anchored `role="log"`.
 *
 * - Only the rows on screen (plus overscan) exist in the DOM, so a channel
 *   read back 5,000 messages costs the same to type, scroll and repaint as
 *   one with 50. `anchorTo: 'end'` keeps the view steady when older pages
 *   are prepended, and follows new messages only while you are at the bottom.
 * - Rows are memoised with primitive props; the flags (grouped, dividers,
 *   first unread) are computed here once per change of the list.
 * - Keyboard: one Tab stop (roving tabindex); ↑/↓, Home/End, PageUp/PageDown
 *   move between messages; R reply, E edit, + react, P pin, T thread,
 *   Delete/Backspace delete, Shift+F10 / ContextMenu opens the menu, Ctrl+C
 *   copies, Escape returns to the composer.
 */
const MessageList = forwardRef(function MessageList({
  channelId, channelLabel, messages, lastReadMessageId, currentUserId, ctx, memberColors,
  hasMoreHistory, hasNewerHistory, isLoadingHistory, isLoadingMessages, onLoadMore, onLoadNewer,
  onJumpToPresent, onClearReadMarker, editingId, bursts, revealed, intro, use24Hour
}, ref) {
  const scrollRef = useRef(null);
  const [hoveredId, setHoveredId] = useState(null);
  const [focusedId, setFocusedId] = useState(null);      // row that contains focus
  const [tabStopId, setTabStopId] = useState(null);      // roving tabindex target
  const [touchOpenId, setTouchOpenId] = useState(null);
  const [atBottom, setAtBottom] = useState(true);
  const [unreadDismissed, setUnreadDismissed] = useState(false);

  const flags = useMemo(
    () => messageFlags(messages, { lastReadMessageId, currentUserId }),
    [messages, lastReadMessageId, currentUserId]
  );
  const indexById = useMemo(() => {
    const map = new Map();
    messages.forEach((m, i) => map.set(String(m.id), i));
    return map;
  }, [messages]);

  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const indexRef = useRef(indexById);
  indexRef.current = indexById;

  // Discord's "N new messages since 3:42 PM — Mark as read" bar.
  const unread = useMemo(() => {
    const index = flags.findIndex((f) => f.firstUnread);
    if (index === -1) return null;
    let count = 0;
    for (let i = index; i < messages.length; i += 1) {
      if (messages[i].user_id !== currentUserId && !messages[i].pending) count += 1;
    }
    if (count === 0) return null;
    return { id: messages[index].id, index, count, more: index === 0 && hasMoreHistory, since: messages[index].created_at };
  }, [flags, messages, hasMoreHistory, currentUserId]);

  const stopId = tabStopId && indexById.has(String(tabStopId))
    ? tabStopId
    : messages[messages.length - 1]?.id ?? null;
  const pinnedIndexes = useRef([]);
  pinnedIndexes.current = [focusedId, editingId, stopId]
    .map((id) => (id == null ? -1 : indexById.get(String(id)) ?? -1))
    .filter((i) => i >= 0)
    .map((i) => i + 1);

  // Index 0 is the intro (welcome header / history spinner); rows follow.
  const count = messages.length + 1;
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => (i === 0 ? 120 : flags[i - 1]?.grouped ? 28 : 68),
    getItemKey: (i) => (i === 0 ? '__intro' : String(messagesRef.current[i - 1]?.id ?? i)),
    overscan: 10,
    anchorTo: 'end',
    followOnAppend: true,
    scrollEndThreshold: AT_BOTTOM_PX,
    // Keep the focused / edited row mounted even when it scrolls away, or
    // keyboard focus would fall to <body>.
    rangeExtractor: useCallback((range) => {
      const base = defaultRangeExtractor(range);
      const extra = pinnedIndexes.current.filter((i) => i < range.count && !base.includes(i));
      return extra.length ? [...base, ...extra].sort((a, b) => a - b) : base;
    }, [])
  });

  // --- scrolling ------------------------------------------------------------

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    virtualizer.scrollToIndex(count - 1, { align: 'end' });
    requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
  }, [virtualizer, count]);

  const pagingRef = useRef({ hasMoreHistory, hasNewerHistory, isLoadingHistory, onLoadMore, onLoadNewer });
  pagingRef.current = { hasMoreHistory, hasNewerHistory, isLoadingHistory, onLoadMore, onLoadNewer };

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const bottom = distance < AT_BOTTOM_PX;
    setAtBottom((prev) => (prev === bottom ? prev : bottom));
    const p = pagingRef.current;
    if (el.scrollTop < PAGE_AHEAD_PX && p.hasMoreHistory && !p.isLoadingHistory) p.onLoadMore?.();
    if (distance < PAGE_AHEAD_PX && p.hasNewerHistory && !p.isLoadingHistory) p.onLoadNewer?.();
    if (hoveredId !== null) setHoveredId(null);
  }, [hoveredId]);

  // A short first page that does not fill the screen cannot be scrolled, so
  // the "near the top" check has to run after layout too.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || isLoadingMessages) return;
    if (el.scrollHeight <= el.clientHeight + 4 && hasMoreHistory && !isLoadingHistory && messages.length) onLoadMore?.();
  }, [messages.length, hasMoreHistory, isLoadingHistory, isLoadingMessages, onLoadMore]);

  // Opening the channel: land on the first unread message when it is above
  // the fold, otherwise at the bottom. Once, when the first page is in.
  const landedRef = useRef(false);
  useLayoutEffect(() => {
    if (landedRef.current || isLoadingMessages || messages.length === 0) return;
    landedRef.current = true;
    const el = scrollRef.current;
    if (unread && el) {
      virtualizer.scrollToIndex(unread.index + 1, { align: 'start' });
      requestAnimationFrame(() => {
        const divider = el.querySelector('[data-first-unread]');
        if (!divider) { el.scrollTop = el.scrollHeight; return; }
        const top = divider.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
        if (top > el.scrollHeight - el.clientHeight) el.scrollTop = el.scrollHeight;
        else el.scrollTop = Math.max(0, top - 56);
      });
      return;
    }
    scrollToBottom();
  }, [isLoadingMessages, messages.length, unread, virtualizer, scrollToBottom]);

  // The soft keyboard (or a rotated phone) shrinks the list: stay pinned.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    let lastHeight = el.clientHeight;
    const observer = new ResizeObserver(() => {
      const shrunk = el.clientHeight < lastHeight;
      lastHeight = el.clientHeight;
      if (shrunk && atBottomRef.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const atBottomRef = useRef(atBottom);
  atBottomRef.current = atBottom;

  // --- focus and keyboard ---------------------------------------------------

  const focusRowById = useCallback((id, attempts = 4) => {
    const node = scrollRef.current?.querySelector(`[data-row-id="${CSS.escape(String(id))}"]`);
    if (node) { node.focus({ preventScroll: false }); return; }
    if (attempts > 0) requestAnimationFrame(() => focusRowById(id, attempts - 1));
  }, []);

  const moveTo = useCallback((index) => {
    const list = messagesRef.current;
    if (!list.length) return;
    if (index < 0) {
      if (pagingRef.current.hasMoreHistory) pagingRef.current.onLoadMore?.();
      index = 0;
    }
    const clamped = Math.min(list.length - 1, index);
    const id = list[clamped].id;
    setTabStopId(id);
    virtualizer.scrollToIndex(clamped + 1, { align: 'auto' });
    focusRowById(id);
  }, [virtualizer, focusRowById]);

  const onKeyDown = useCallback((event) => {
    const row = event.target.closest?.('[data-row-id]');
    if (!row || !scrollRef.current?.contains(row)) return;
    const id = row.getAttribute('data-row-id');
    const index = indexRef.current.get(id);
    if (index === undefined) return;
    const msg = messagesRef.current[index];
    const onRow = event.target === row;
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) || event.target.isContentEditable;
    if (inField) return;
    const page = Math.max(3, Math.floor((scrollRef.current.clientHeight || 600) / 60));
    const { actions } = ctx;

    switch (event.key) {
      case 'ArrowUp': event.preventDefault(); moveTo(index - 1); return;
      case 'ArrowDown':
        event.preventDefault();
        if (index === messagesRef.current.length - 1 && !pagingRef.current.hasNewerHistory) return;
        moveTo(index + 1);
        return;
      case 'PageUp': event.preventDefault(); moveTo(index - page); return;
      case 'PageDown': event.preventDefault(); moveTo(index + page); return;
      case 'Home': if (!onRow) return; event.preventDefault(); moveTo(0); return;
      case 'End': if (!onRow) return; event.preventDefault(); moveTo(messagesRef.current.length - 1); return;
      case 'Escape': event.preventDefault(); actions.focusComposer(); return;
      default:
    }
    if (!onRow || !msg || msg.pending) return;

    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    const isOwn = msg.user_id === currentUserId;
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
    if ((event.shiftKey && event.key === 'F10') || event.key === 'ContextMenu') {
      event.preventDefault();
      const rect = row.getBoundingClientRect();
      actions.openMenuAt(msg, Math.min(rect.right - 220, rect.left + 72), rect.top + 24);
      return;
    }
    if ((event.ctrlKey || event.metaKey) && key === 'c' && !window.getSelection?.()?.toString()) {
      event.preventDefault();
      actions.copyText(msg, { quiet: false });
      return;
    }
    if (!plain) return;
    if (key === 'r' && ctx.canSend && !ctx.isArchived) { event.preventDefault(); actions.reply(msg); return; }
    if (key === 'e' && isOwn) { event.preventDefault(); actions.edit(msg); return; }
    if (key === '+' || key === '=') { event.preventDefault(); actions.openReactionPicker(msg); return; }
    if (key === 'p' && ctx.canPin) { event.preventDefault(); actions.togglePin(msg); return; }
    if (key === 't' && ctx.canThread) { event.preventDefault(); actions.createThread(msg); return; }
    if ((event.key === 'Delete' || event.key === 'Backspace') && (isOwn || ctx.canManageMessages)) {
      event.preventDefault();
      actions.remove(msg, event);
      return;
    }
    if (event.key === 'Enter' && msg.reply_to_id) { event.preventDefault(); actions.jumpTo(msg.reply_to_id); }
  }, [ctx, currentUserId, moveTo]);

  const rowCtx = useMemo(() => ({
    ...ctx,
    actions: {
      ...ctx.actions,
      hoverRow: (id) => setHoveredId(id),
      focusRow: (id, isRow = true) => { setFocusedId(id); if (isRow) setTabStopId(id); },
      blurRow: (id) => setFocusedId((current) => (current === id ? null : current)),
      tapRow: (id) => { if (hoverless()) setTouchOpenId((current) => (current === id ? null : id)); },
      closeTouchActions: () => setTouchOpenId(null)
    }
  }), [ctx]);

  useImperativeHandle(ref, () => ({
    /** Scroll a loaded message into view and flash it. False if not loaded. */
    jumpTo(messageId, { focus = false } = {}) {
      const index = indexRef.current.get(String(messageId));
      if (index === undefined) return false;
      virtualizer.scrollToIndex(index + 1, { align: 'center' });
      const flash = (attempts = 6) => {
        const node = scrollRef.current?.querySelector(`[data-row-id="${CSS.escape(String(messageId))}"]`);
        if (!node) { if (attempts > 0) requestAnimationFrame(() => flash(attempts - 1)); return; }
        node.scrollIntoView({ block: 'center' });
        node.classList.remove('message-flash');
        void node.offsetWidth;
        node.classList.add('message-flash');
        setTimeout(() => node.classList.remove('message-flash'), 1700);
        if (focus) { setTabStopId(messageId); node.focus({ preventScroll: true }); }
      };
      requestAnimationFrame(() => flash());
      return true;
    },
    /** Enter the history from the composer (↑ / Shift+Tab). */
    focusLast() {
      const list = messagesRef.current;
      if (!list.length) return false;
      moveTo(list.length - 1);
      return true;
    },
    scrollToBottom,
    clearTouch() { setTouchOpenId(null); },
    isAtBottom: () => atBottomRef.current
  }), [virtualizer, moveTo, scrollToBottom]);

  const items = virtualizer.getVirtualItems();

  return (
    <div className="relative flex-1 min-h-0 flex flex-col">
      {unread && !unreadDismissed && (
        <div className="absolute top-0 inset-x-0 z-10 px-2 pointer-events-none">
          <div className="pointer-events-auto flex items-center bg-d-brand text-white text-xs font-semibold rounded-b-lg shadow-md">
            <button
              type="button"
              onClick={() => rowCtx.actions.jumpTo(unread.id)}
              className="flex-1 min-w-0 text-left px-3 py-2 truncate hover:underline"
            >
              {t('chat.unreadSince', {
                count: unread.more ? `${unread.count}+` : unread.count,
                time: formatUnreadSince(unread.since, use24Hour)
              })}
            </button>
            <button
              type="button"
              onClick={() => { setUnreadDismissed(true); onClearReadMarker?.(); }}
              className="shrink-0 flex items-center gap-1 px-3 py-2 hover:bg-white/10 rounded-br-lg"
            >
              {t('chat.markAsRead')} <CheckCheck className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </div>
        </div>
      )}

      <div
        ref={scrollRef}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
        onPointerLeave={() => setHoveredId(null)}
        role="log"
        aria-live="off"
        aria-label={t('chat.messagesIn', { channel: channelLabel })}
        aria-busy={isLoadingMessages || isLoadingHistory}
        data-channel-id={channelId}
        data-count={messages.length}
        className="flex-1 overflow-y-auto overflow-x-hidden px-4 max-sm:px-3 select-text overscroll-contain [overflow-anchor:none]"
      >
        <div className="min-h-full flex flex-col justify-end">
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative', width: '100%' }}>
            {items.map((item) => {
              const style = { position: 'absolute', top: 0, left: 0, width: '100%', transform: `translateY(${item.start}px)` };
              if (item.index === 0) {
                return (
                  <div key={item.key} data-index={0} ref={virtualizer.measureElement} style={style}>
                    {isLoadingHistory && (
                      <div className="flex justify-center py-3 text-d-text3" role="status" aria-label={t('chat.loadingHistory')}>
                        <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
                      </div>
                    )}
                    {!hasMoreHistory && !isLoadingMessages && !isLoadingHistory ? intro : <div className="h-px" />}
                  </div>
                );
              }
              const msg = messages[item.index - 1];
              if (!msg) return null;
              const f = flags[item.index - 1];
              const id = msg.id;
              return (
                <div key={item.key} data-index={item.index} ref={virtualizer.measureElement} style={style}>
                  <MessageRow
                    msg={msg}
                    ctx={rowCtx}
                    grouped={f.grouped}
                    dateDivider={f.dateDivider ? msg.created_at : null}
                    firstUnread={f.firstUnread}
                    isActive={id === hoveredId || id === focusedId || id === touchOpenId}
                    touchOpen={id === touchOpenId}
                    isFocusTarget={id === stopId}
                    isEditing={id === editingId}
                    roleColor={msg.role_color ?? memberColors?.get(msg.user_id) ?? null}
                    burst={bursts?.[id] ?? null}
                    revealed={revealed?.has(id) ?? false}
                  />
                </div>
              );
            })}
          </div>
          <div className="h-4 shrink-0" aria-hidden="true" />
        </div>
      </div>

      {isLoadingMessages && messages.length === 0 && (
        <div role="status" aria-label={t('chat.loadingMessages')} className="absolute inset-x-4 bottom-4 space-y-5 pointer-events-none">
          {[0.62, 0.4, 0.78, 0.5, 0.66].map((width, i) => (
            <div key={i} className="flex gap-4 skeleton" aria-hidden="true">
              <div className="w-10 h-10 rounded-full bg-d-surface shrink-0" />
              <div className="flex-1 space-y-2 pt-1">
                <div className="h-3 w-28 rounded bg-d-surface" />
                <div className="h-3 rounded bg-d-surface/70" style={{ width: `${width * 100}%` }} />
              </div>
            </div>
          ))}
        </div>
      )}

      {(!atBottom || hasNewerHistory) && messages.length > 0 && (
        <button
          type="button"
          onClick={() => {
            if (hasNewerHistory) onJumpToPresent?.();
            else scrollToBottom();
          }}
          className="absolute bottom-3 right-4 bg-d-brand hover:bg-d-brandhover text-white text-xs font-semibold px-3 py-2 min-h-9 rounded-full shadow-lg flex items-center gap-1.5 z-20 transition-colors"
        >
          <ArrowDown className="w-3.5 h-3.5" aria-hidden="true" /> {t('chat.jumpToPresent')}
        </button>
      )}
    </div>
  );
});

export default memo(MessageList);
