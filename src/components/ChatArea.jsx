import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Hash, Lock, Megaphone, Volume2, MessagesSquare, PlusCircle, ShieldOff, Flag, X } from 'lucide-react';
import { parseDiscordMarkdown } from '../utils/markdownParser';
import { defaultAvatar } from '../utils/avatar';
import { formatTypingText } from '../utils/messageGrouping';
import { humanizeTokens, resolveComposerTokens } from '../utils/mentions';
import { proxiedImageUrl } from '../utils/media';
import { useUserSettings } from '../hooks/useUserSettings';
import { lazyComponent } from '../utils/lazyComponent';
import { t } from '../i18n/index.jsx';
import { announceTyping } from '../chat/announcer';
import { motionAllowed } from './SuperReaction';
import PinnedMessagesPopover from './PinnedMessagesPopover';
import MessageContextMenu from './MessageContextMenu';
import ChatHeader from './chat/ChatHeader';
import MessageList from './chat/MessageList';
import Composer from './chat/Composer';
import ActionSheet from './chat/ActionSheet';
import AnchoredPopover from './chat/AnchoredPopover';
import MobileSearchSheet from './chat/MobileSearchSheet';
import { isGifAttachment } from './chat/GifPicker';
import { saveRecentEmoji } from '../chat/recentEmoji.js';

// Pickers and dialogs load on first use.
const ImageLightboxModal = lazyComponent(() => import('./ImageLightboxModal'));
const EmojiPicker = lazyComponent(() => import('./EmojiPicker'));
const CreatePollModal = lazyComponent(() => import('./CreatePollModal'));

const INTRO_ICONS = { announcement: Megaphone, voice: Volume2, forum: MessagesSquare, thread: MessagesSquare };

/**
 * One conversation: header, virtualised history and composer.
 *
 * This component holds the state that belongs to the conversation as a
 * whole (reply target, the message being edited, open menus and popovers).
 * The composer owns what typing touches, the list owns hover/focus, and the
 * props that reach memoised rows are kept stable: App passes fresh inline
 * callbacks on every render, so they are read through a ref and exposed as
 * one `actions` object that never changes identity.
 */
export default function ChatArea(props) {
  const {
    channel, messages, pins = [], currentUser, viewerPermissions = [], isOwner = false,
    typingUsers = [], lastReadMessageId = null, hasMoreHistory = false, hasNewerHistory = false,
    isLoadingHistory = false, isLoadingMessages = false, members = [], channels = [], customEmojis = [],
    externalEmojiGroups = [], stickers = [], botCommands = [], memberColors, rolesById = null, blockedIds,
    showMemberList, channelSettings, inboxCount = 0, hideHeader = false, callBar,
    openPinsSignal = 0, openEmojiSignal = 0, toggleFormattingSignal = 0, focusSearchSignal = 0, focusHistorySignal = 0,
    onOpenMobileSidebar = null, onStartCall, onFollowChannel = null, onArchiveThread, onAddGroupRecipients,
    onOpenNotificationSettings, onOpenInbox, onCreatePoll, onSendVoiceNote, onCreateThread, onForward,
    onPublish = null, onReport, onShowEditHistory, onToggleMemberList, onSearch
  } = props;

  const handlers = useRef(props);
  handlers.current = props;
  // Author lookups for role styles (MessageList resolves each author once).
  const membersById = useMemo(() => new Map((members ?? []).map((m) => [m.id, m])), [members]);

  const { prefs } = useUserSettings();
  const chatPrefs = prefs.chat;
  const a11yPrefs = prefs.accessibility;

  const listRef = useRef(null);
  const composerRef = useRef(null);
  const headerRef = useRef(null);

  const [replyTo, setReplyTo] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [contextMenu, setContextMenu] = useState(null);
  const [sheetMsg, setSheetMsg] = useState(null);
  const [reactTarget, setReactTarget] = useState(null);
  const [showPins, setShowPins] = useState(false);
  const [lightbox, setLightbox] = useState(null);
  const [bursts, setBursts] = useState({});
  const [revealed, setRevealed] = useState(() => new Set());
  const [showMobileSearch, setShowMobileSearch] = useState(false);
  const [showPollComposer, setShowPollComposer] = useState(false);

  const channelId = channel?.id ?? null;
  const isDM = channel?.type === 'dm' || channel?.type === 'group_dm';
  const inGuild = Boolean(channel?.server_id) && !isDM;
  const can = useCallback(
    (name) => viewerPermissions.includes(name) || viewerPermissions.includes('ADMINISTRATOR') || isOwner,
    [viewerPermissions, isOwner]
  );
  const canManageMessages = inGuild ? can('MANAGE_MESSAGES') : false;
  const canSend = inGuild ? can('SEND_MESSAGES') : true;
  const canAttach = inGuild ? can('ATTACH_FILES') : true;
  const isArchived = Boolean(channel?.archived);
  const isLocked = Boolean(channel?.locked);
  const canPin = canManageMessages || isDM;
  const canThread = Boolean(onCreateThread);

  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const membersRef = useRef(members);
  membersRef.current = members;
  const channelsRef = useRef(channels);
  channelsRef.current = channels;

  // A new conversation starts clean.
  useEffect(() => {
    setReplyTo(null);
    setEditingId(null);
    setContextMenu(null);
    setSheetMsg(null);
    setReactTarget(null);
    setShowPins(false);
    setBursts({});
  }, [channelId]);

  // --- Markdown rendering, cached ---------------------------------------------------

  // What mentions resolve against. Keyed by the names only, so a presence
  // update (a new `members` array with the same names) keeps the cache.
  const namesKey = useMemo(
    () => `${members.map((m) => `${m.id}:${m.display_name ?? m.username}`).join('|')}#${channels.map((c) => `${c.id}:${c.name}`).join('|')}#${customEmojis.length}:${externalEmojiGroups.length}`,
    [members, channels, customEmojis, externalEmojiGroups]
  );
  const markdownContext = useMemo(() => {
    const memberById = new Map(membersRef.current.map((m) => [String(m.id), m]));
    const channelById = new Map(channelsRef.current.map((c) => [String(c.id), c]));
    const roleById = new Map();
    for (const m of membersRef.current) for (const r of m.roles ?? []) if (r && typeof r === 'object') roleById.set(String(r.id), r);
    const emojiById = new Map();
    for (const e of [...customEmojis, ...externalEmojiGroups.flatMap((g) => g.emojis ?? [])]) emojiById.set(String(e.id), e.url);
    return {
      resolveUser: (id) => { const m = memberById.get(String(id)); return m?.display_name ?? m?.username ?? null; },
      resolveChannel: (id) => channelById.get(String(id))?.name ?? null,
      resolveRole: (id) => roleById.get(String(id)) ?? null,
      emojiUrl: (id) => emojiById.get(String(id)),
      onMentionClick: (id) => handlers.current.onSelectUser?.(id),
      onChannelClick: (id) => handlers.current.onSelectChannel?.(id)
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [namesKey]);

  const markdownCache = useRef({ context: null, map: new Map() });
  if (markdownCache.current.context !== markdownContext) markdownCache.current = { context: markdownContext, map: new Map() };
  const renderMarkdown = useCallback((msg) => {
    const { map } = markdownCache.current;
    let entry = map.get(msg.id);
    if (!entry || entry.content !== msg.content) {
      entry = { content: msg.content, node: parseDiscordMarkdown(msg.content, markdownContext) };
      map.set(msg.id, entry);
      if (map.size > 3000) map.delete(map.keys().next().value);
    }
    return entry.node;
  }, [markdownContext]);
  const renderText = useCallback((text) => parseDiscordMarkdown(text, markdownContext), [markdownContext]);

  // --- stable actions -------------------------------------------------------------

  const showBurst = useCallback((messageId, emoji) => {
    if (!motionAllowed()) return;
    setBursts((current) => ({ ...current, [messageId]: emoji }));
  }, []);

  const actions = useMemo(() => {
    const h = () => handlers.current;
    const toast = (message, opts) => h().onToast?.(message, opts);
    const copy = (value) => {
      navigator.clipboard?.writeText(value).then(
        () => toast(t('common.copied'), { type: 'success', ttl: 2500 }),
        () => toast(t('chat.copyFailed'), { type: 'error' })
      );
    };
    const focusComposer = () => composerRef.current?.focus();
    return {
      toast,
      focusComposer,
      react: (msg, emoji, isSuper) => {
        h().onToggleReaction?.(msg.id, emoji);
        saveRecentEmoji({ char: emoji });
        listRef.current?.clearTouch();
        if (!isSuper) return;
        h().onSuperReact?.(msg.id, emoji);
        showBurst(msg.id, emoji);
      },
      toggleReaction: (messageId, emoji) => h().onToggleReaction?.(messageId, emoji),
      openReactionPicker: (msg) => { listRef.current?.clearTouch(); setReactTarget(msg); },
      reply: (msg) => { listRef.current?.clearTouch(); setReplyTo(msg); focusComposer(); },
      edit: (msg) => { listRef.current?.clearTouch(); setEditingId(msg.id); },
      stopEditing: () => {
        setEditingId(null);
        focusComposer();
      },
      humanize: (content) => humanizeTokens(content ?? '', { members: membersRef.current, channels: channelsRef.current }),
      submitEdit: (msg, text) => {
        setEditingId(null);
        focusComposer();
        // Saving an empty edit is how Discord offers to delete the message.
        if (!text.trim()) { h().onDeleteMessage?.(msg.id); return; }
        const content = resolveComposerTokens(text, {
          members: membersRef.current, channels: channelsRef.current, customEmojis: h().customEmojis ?? []
        });
        if (msg.content !== content) h().onEditMessage?.(msg.id, content);
      },
      remove: (msg, event) => {
        listRef.current?.clearTouch();
        h().onDeleteMessage?.(msg.id, { skipConfirm: Boolean(event?.shiftKey) });
      },
      openMenuAt: (msg, x, y) => { listRef.current?.clearTouch(); setContextMenu({ message: msg, x, y }); },
      openMenuFrom: (msg, el) => {
        const rect = el.getBoundingClientRect();
        listRef.current?.clearTouch();
        setContextMenu({ message: msg, x: rect.left, y: rect.bottom + 4 });
      },
      openSheet: (msg) => { if (!msg.pending) { listRef.current?.clearTouch(); setSheetMsg(msg); } },
      togglePin: (msg) => {
        h().onTogglePin?.(msg, !msg.pinned);
        toast(msg.pinned ? t('chat.unpinnedToast') : t('chat.pinnedToast'), { type: 'success', ttl: 3000 });
      },
      createThread: (msg) => h().onCreateThread?.(msg),
      publish: (msg) => h().onPublish?.(msg),
      forward: (msg) => h().onForward?.(msg),
      openForwardSource: (source) => h().onJumpToMessage?.({ id: source.message_id, channel_id: source.channel_id }),
      markUnread: (msg) => h().onMarkUnread?.(msg),
      report: (msg) => h().onReport?.(msg),
      // Block the author (long-press sheet). Not for bots/webhooks, yourself,
      // or someone already blocked.
      canBlock: (msg) => Boolean(h().onBlockUser) && Boolean(msg?.user_id) && !msg.is_webhook
        && msg.user_id !== h().currentUser?.id && !h().blockedIds?.has?.(msg.user_id),
      blockAuthor: (msg) => h().onBlockUser?.({
        id: msg.user_id, username: msg.username, display_name: msg.display_name, avatar_url: msg.avatar_url
      }),
      get canForward() { return Boolean(h().onForward); },
      get canReport() { return Boolean(h().onReport); },
      copyText: (msg) => copy(msg.content ?? ''),
      copyLink: (msg) => copy(`${window.location.origin}/channels/${msg.server_id ?? '@me'}/${msg.channel_id}/${msg.id}`),
      openProfile: (userId) => h().onSelectUser?.(userId),
      userMenu: (userId, x, y) => h().onUserContextMenu?.(userId, x, y),
      selectChannel: (id) => h().onSelectChannel?.(id),
      openPins: () => setShowPins(true),
      jumpTo: (messageId) => {
        if (listRef.current?.jumpTo(messageId)) return;
        // Not loaded (older than what we hold): let the app fetch around it.
        h().onJumpToMessage?.({ id: messageId, channel_id: h().channel?.id });
      },
      openImage: (url, alt, gallery) => setLightbox({ url, alt, images: gallery?.images ?? null, index: gallery?.index ?? 0 }),
      showEditHistory: (msg) => h().onShowEditHistory?.(msg),
      retry: (msg) => h().onRetryMessage?.(msg),
      discard: (msg) => h().onDiscardMessage?.(msg),
      revealBlocked: (id) => setRevealed((prev) => new Set(prev).add(id)),
      burstDone: (id) => setBursts((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      })
    };
  }, [showBurst]);

  const nameFor = useCallback((userId) => {
    if (userId === currentUser?.id) return t('chat.you');
    const member = membersRef.current.find((m) => m.id === userId || m.user_id === userId);
    return member?.nickname || member?.display_name || member?.username || t('chat.someone');
  }, [currentUser?.id]);

  const myRoleIds = useMemo(() => {
    const me = members.find((m) => m.id === currentUser?.id);
    return (me?.roles ?? []).map((r) => (typeof r === 'object' ? r.id : r));
  }, [members, currentUser?.id]);
  const myRoleKey = myRoleIds.join(',');

  // Privacy & Safety › direct message scanning: media from someone outside
  // the chosen scope stays covered until you decide to look.
  const dmScanning = prefs.privacy.dmScanning;
  const safetyHold = useCallback((msg) => {
    if (!isDM || dmScanning === 'off') return false;
    if (msg.user_id === currentUser?.id) return false;
    if (dmScanning === 'friends' && !handlers.current.isUnknownSender?.(msg.user_id)) return false;
    return (msg.attachments?.length ?? 0) > 0;
  }, [isDM, dmScanning, currentUser?.id]);

  const ctx = useMemo(() => ({
    actions,
    currentUserId: currentUser?.id ?? null,
    currentUser,
    chatPrefs,
    a11yPrefs,
    canManageMessages,
    canSend,
    isArchived,
    canPin,
    canThread,
    blockedIds,
    myRoleIds,
    renderMarkdown,
    renderText,
    nameFor,
    safetyHold,
    canShowEditHistory: Boolean(onShowEditHistory),
    longPressMs: 450
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [actions, currentUser?.id, currentUser?.display_name, chatPrefs, a11yPrefs, canManageMessages, canSend, isArchived,
    canPin, canThread, blockedIds, myRoleKey, renderMarkdown, renderText, nameFor, safetyHold, onShowEditHistory ? 1 : 0]);

  // --- signals from app-wide shortcuts --------------------------------------------------

  useEffect(() => { if (openPinsSignal) setShowPins(true); }, [openPinsSignal]);
  useEffect(() => { if (openEmojiSignal) composerRef.current?.toggleEmoji(); }, [openEmojiSignal]);
  useEffect(() => { if (toggleFormattingSignal) composerRef.current?.toggleFormatting(); }, [toggleFormattingSignal]);
  useEffect(() => {
    if (!focusSearchSignal) return;
    if (headerRef.current) headerRef.current.focusSearch();
    else setShowMobileSearch(true);
  }, [focusSearchSignal]);
  useEffect(() => { if (focusHistorySignal) listRef.current?.focusLast(); }, [focusHistorySignal]);

  // The app asked to show a message (search result, reply, pin, deep link).
  const jumpTarget = props.jumpTarget;
  useEffect(() => {
    if (!jumpTarget?.id) return;
    if (jumpTarget.bottom) listRef.current?.scrollToBottom();
    else listRef.current?.jumpTo(jumpTarget.id, { focus: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jumpTarget?.n]);

  // Someone else's super reaction arrives over the socket.
  const onSuperReactionEvent = props.onSuperReactionEvent;
  useEffect(() => {
    if (!onSuperReactionEvent) return undefined;
    return onSuperReactionEvent(({ messageId, emoji }) => showBurst(messageId, emoji));
  }, [onSuperReactionEvent, showBurst]);

  // --- typing line (also spoken, at most every 5 s) -----------------------------------

  const typingText = formatTypingText(typingUsers.map((u) => u.displayName ?? u.userId));
  useEffect(() => {
    if (chatPrefs.showTypingIndicator) announceTyping(typingText);
  }, [typingText, chatPrefs.showTypingIndicator]);

  // --- composer callbacks (stable) ------------------------------------------------------

  const composerCallbacks = useMemo(() => ({
    onCancelReply: () => setReplyTo(null),
    onSend: (content, attachments, replyId, extra) => {
      handlers.current.onSendMessage?.(content, attachments, replyId, extra);
      listRef.current?.scrollToBottom();
    },
    onSendVoiceNote: (note, replyId) => handlers.current.onSendVoiceNote?.(note, replyId),
    onOpenPoll: () => setShowPollComposer(true),
    onSlashAction: (action, value) => handlers.current.onSlashAction?.(action, value),
    onRunBotCommand: (bot, options) => handlers.current.onRunBotCommand?.(bot, options),
    onTypingStart: () => handlers.current.onTypingStart?.(),
    onTypingStop: () => handlers.current.onTypingStop?.(),
    onToast: (message, opts) => handlers.current.onToast?.(message, opts),
    // ↑ in an empty composer: edit your own message if it is the latest one
    // (Discord's quick fix-a-typo), otherwise step into the history.
    onArrowUpEmpty: () => {
      const list = messagesRef.current.filter((m) => !m.pending && !m.failed);
      const last = list[list.length - 1];
      if (last && last.user_id === handlers.current.currentUser?.id && !SYSTEM_MESSAGE(last)) {
        setEditingId(last.id);
        return true;
      }
      return Boolean(listRef.current?.focusLast());
    },
    onLoadMore: () => handlers.current.onLoadMore?.(),
    onLoadNewer: () => handlers.current.onLoadNewer?.(),
    onJumpToPresent: () => handlers.current.onJumpToPresent?.(),
    onClearReadMarker: () => handlers.current.onClearReadMarker?.(),
    getRecentGifs: () => {
      const seen = new Set();
      const out = [];
      for (let i = messagesRef.current.length - 1; i >= 0 && out.length < 24; i -= 1) {
        for (const att of messagesRef.current[i].attachments ?? []) {
          if (isGifAttachment(att) && !seen.has(att.url)) { seen.add(att.url); out.push(att); }
        }
      }
      return out;
    }
  }), []);

  // The welcome header, memoised so the (memoised) list sees equal props.
  const introAvatar = channel?.avatar_url || defaultAvatar(channel?.recipients?.[0]?.id ?? channel?.id);
  const introTitle = isDM ? channel?.display_name : channel?.name;
  const introType = channel?.type;
  const intro = useMemo(() => {
    if (!introType) return null;
    const IntroIcon = INTRO_ICONS[introType] ?? Hash;
    return (
      <div className="my-6">
        {isDM ? (
          <img src={proxiedImageUrl(introAvatar)} alt="" width={80} height={80} className="w-20 h-20 rounded-full object-cover mb-3" />
        ) : (
          <div className="w-16 h-16 rounded-full bg-d-active flex items-center justify-center mb-3" aria-hidden="true">
            <IntroIcon className="w-10 h-10 text-d-strong" />
          </div>
        )}
        <h2 className="text-3xl max-sm:text-2xl font-extrabold text-d-strong mb-1 break-words">
          {isDM ? t('chat.welcomeToDm', { name: introTitle }) : t('chat.welcomeToChannel', { channel: introTitle })}
        </h2>
        <p className="text-sm text-d-text2">
          {isDM ? t('chat.dmStart', { name: introTitle }) : t('chat.channelStartSimple', { channel: introTitle })}
        </p>
        <div className="w-full h-px bg-d-divider mt-4" />
      </div>
    );
  }, [isDM, introAvatar, introTitle, introType]);

  if (!channel) {
    return (
      <div className="flex-1 bg-d-canvas flex items-center justify-center text-d-text3 p-6 text-center">
        {t('chat.selectChannel')}
      </div>
    );
  }

  // A 1:1 DM: the other person, whether you blocked them (then the composer
  // becomes an "Unblock" bar, as on Discord), and the header's "⋯" actions.
  const dmPeer = channel.type === 'dm' ? channel.recipients?.[0] ?? null : null;
  const youBlocked = Boolean(dmPeer && (blockedIds?.has?.(dmPeer.id) || props.sendBlocked));
  const dmMenuItems = dmPeer ? [
    youBlocked
      ? props.onUnblockUser && { icon: ShieldOff, label: t('dm.unblock'), action: () => props.onUnblockUser(dmPeer) }
      : props.onBlockUser && { icon: ShieldOff, label: t('dm.block'), danger: true, action: () => props.onBlockUser(dmPeer) },
    props.onReportUser && { icon: Flag, label: t('safety.reportUser'), danger: true, action: () => props.onReportUser(dmPeer) },
    props.onCloseDm && { icon: X, label: t('dm.closeConversation'), action: () => props.onCloseDm() }
  ].filter(Boolean) : null;

  const title = isDM ? channel.display_name : channel.name;
  const channelLabel = isDM ? `@${title}` : `#${title}`;
  const parentChannel = channel.type === 'thread' && channel.parent_id
    ? channels.find((c) => c.id === channel.parent_id) ?? null : null;
  const muted = Boolean(channelSettings?.muted);
  const placeholder = !canSend
    ? t('chat.noSendPermission')
    : isArchived
      ? t('chat.threadArchived')
      : isDM ? t('chat.messagePlaceholderDm', { name: title }) : t('chat.messagePlaceholder', { channel: title });

  const onDragOver = (e) => { if (canAttach && e.dataTransfer?.types?.includes('Files')) { e.preventDefault(); } };
  const onDrop = (e) => {
    const files = [...(e.dataTransfer?.files ?? [])];
    if (!files.length) return;
    e.preventDefault();
    composerRef.current?.uploadFiles(files);
  };

  return (
    <div
      className="flex-1 bg-d-canvas flex flex-col min-w-0 min-h-0 h-full relative"
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <DropHint enabled={canAttach} target={channelLabel} />

      {hideHeader ? (
        // Under a voice room the room's header names the channel; the page
        // still needs its heading.
        <h1 id="channel-title" tabIndex={-1} className="sr-only">{channelLabel}</h1>
      ) : (
        <ChatHeader
          ref={headerRef}
          channel={channel}
          title={title}
          isDM={isDM}
          isArchived={isArchived}
          parentChannel={parentChannel}
          muted={muted}
          pinsCount={pins.length}
          showPins={showPins}
          showMemberList={showMemberList}
          inboxCount={inboxCount}
          onOpenMobileSidebar={onOpenMobileSidebar}
          onStartCall={youBlocked ? null : onStartCall}
          onFollowChannel={onFollowChannel}
          onArchiveThread={onArchiveThread}
          onAddGroupRecipients={onAddGroupRecipients}
          onOpenNotificationSettings={onOpenNotificationSettings}
          onTogglePins={() => setShowPins((v) => !v)}
          onToggleMemberList={isDM ? null : onToggleMemberList}
          onOpenInbox={onOpenInbox}
          onSearch={onSearch}
          onOpenMobileSearch={() => setShowMobileSearch(true)}
          onSelectChannel={props.onSelectChannel}
          dmMenuItems={dmMenuItems}
        />
      )}

      {callBar}

      <MessageList
        key={`list-${channelId}`}
        ref={listRef}
        channelId={channelId}
        channelLabel={channelLabel}
        messages={messages}
        lastReadMessageId={lastReadMessageId}
        currentUserId={currentUser?.id ?? null}
        ctx={ctx}
        memberColors={memberColors}
        serverId={channel?.server_id ?? null}
        membersById={membersById}
        rolesById={rolesById}
        hasMoreHistory={hasMoreHistory}
        hasNewerHistory={hasNewerHistory}
        isLoadingHistory={isLoadingHistory}
        isLoadingMessages={isLoadingMessages}
        onLoadMore={composerCallbacks.onLoadMore}
        onLoadNewer={composerCallbacks.onLoadNewer}
        onJumpToPresent={composerCallbacks.onJumpToPresent}
        onClearReadMarker={composerCallbacks.onClearReadMarker}
        editingId={editingId}
        bursts={bursts}
        revealed={revealed}
        intro={intro}
        use24Hour={chatPrefs.use24HourClock}
      />

      {youBlocked ? (
        <div role="status" className="mx-4 max-sm:mx-2 mb-2 px-4 py-3 rounded-lg bg-d-input text-sm text-d-text2 flex flex-wrap items-center justify-center gap-x-2 gap-y-1">
          <span>{t('integration.youBlocked')}</span>
          {props.onUnblockUser && (
            <>
              <span aria-hidden="true">·</span>
              <button
                type="button"
                onClick={() => props.onUnblockUser(dmPeer)}
                className="font-semibold text-d-link hover:underline min-h-6"
              >
                {t('dm.unblock')}
              </button>
            </>
          )}
        </div>
      ) : (
      <Composer
        key={`composer-${channelId}`}
        ref={composerRef}
        channelId={channelId}
        serverId={channel.server_id ?? null}
        currentUserId={currentUser?.id ?? null}
        placeholder={placeholder}
        canSend={canSend}
        canAttach={canAttach}
        isArchived={isArchived}
        members={members}
        channels={channels}
        customEmojis={customEmojis}
        externalEmojiGroups={externalEmojiGroups}
        stickers={stickers}
        botCommands={botCommands}
        replyTo={replyTo}
        convertEmoticonsPref={chatPrefs.convertEmoticons}
        ttsEnabled={a11yPrefs.ttsEnabled}
        showSendButton={prefs.appearance.showSendButton}
        onSendVoiceNote={onSendVoiceNote ? composerCallbacks.onSendVoiceNote : null}
        onOpenPoll={onCreatePoll ? composerCallbacks.onOpenPoll : null}
        onCancelReply={composerCallbacks.onCancelReply}
        onSend={composerCallbacks.onSend}
        onSlashAction={composerCallbacks.onSlashAction}
        onRunBotCommand={composerCallbacks.onRunBotCommand}
        onTypingStart={composerCallbacks.onTypingStart}
        onTypingStop={composerCallbacks.onTypingStop}
        onToast={composerCallbacks.onToast}
        onArrowUpEmpty={composerCallbacks.onArrowUpEmpty}
        getRecentGifs={composerCallbacks.getRecentGifs}
      />
      )}

      {/* Typing indicator in the composer's gutter, as in Discord. The live
          announcer speaks it; this line is visual only. */}
      <div className="h-5 px-4 max-sm:px-3 -mt-1 pb-1 text-xs text-d-text flex items-center gap-1.5 shrink-0" aria-hidden="true">
        {isLocked && !isArchived && (
          <span className="text-d-text3 flex items-center gap-1"><Lock className="w-3 h-3" /> {t('chat.channelLocked')}</span>
        )}
        {typingText && chatPrefs.showTypingIndicator && (
          <>
            <span className="flex gap-0.5">
              {[0, 150, 300].map((delay) => (
                // A soft pulse, not a bounce; still under reduced motion.
                <span key={delay} className="w-1.5 h-1.5 bg-d-text2 rounded-full motion-safe:animate-pulse" style={{ animationDelay: `${delay}ms` }} />
              ))}
            </span>
            <span className="truncate">{typingText}</span>
          </>
        )}
      </div>

      {showPollComposer && (
        <CreatePollModal
          onClose={() => setShowPollComposer(false)}
          onCreate={(poll) => onCreatePoll(poll)}
          onToast={props.onToast}
        />
      )}

      {reactTarget && (
        // "Add reaction" opens beside the message it reacts to, as in Discord.
        <AnchoredPopover anchorId={reactTarget.id} onClose={() => setReactTarget(null)}>
          <EmojiPicker
            customEmojis={customEmojis}
            externalGroups={externalEmojiGroups.filter((g) => g.server_id !== channel.server_id)}
            onClose={() => setReactTarget(null)}
            onPick={(entry) => {
              props.onToggleReaction?.(reactTarget.id, entry.char ?? `:${entry.name}:`);
              setReactTarget(null);
            }}
          />
        </AnchoredPopover>
      )}

      {showMobileSearch && (
        <MobileSearchSheet
          onClose={() => setShowMobileSearch(false)}
          onSubmit={(term) => { setShowMobileSearch(false); onSearch?.(term); }}
        />
      )}

      {showPins && (
        <PinnedMessagesPopover
          messages={pins}
          canUnpin={canPin}
          onClose={() => setShowPins(false)}
          onJump={(msg) => { setShowPins(false); actions.jumpTo(msg.id); }}
          onUnpin={(msg) => props.onTogglePin?.(msg, false)}
        />
      )}

      {contextMenu && (
        <MessageContextMenu
          botCommands={botCommands}
          onRunBotCommand={props.onRunBotCommand ? (command, target) => props.onRunBotCommand(command, {}, target) : null}
          message={contextMenu.message}
          x={contextMenu.x}
          y={contextMenu.y}
          isOwn={contextMenu.message.user_id === currentUser?.id}
          canManage={canManageMessages}
          canPin={canPin}
          onClose={() => setContextMenu(null)}
          onReply={canSend && !isArchived ? actions.reply : null}
          onEdit={actions.edit}
          onDelete={(msg) => actions.remove(msg)}
          onTogglePin={(msg) => actions.togglePin(msg)}
          onAddReaction={actions.openReactionPicker}
          onCreateThread={onCreateThread}
          onPublish={channel.type === 'announcement' ? onPublish : null}
          onForward={onForward}
          onMarkUnread={props.onMarkUnread}
          onReport={onReport}
          onToast={props.onToast}
        />
      )}

      {sheetMsg && (
        <ActionSheet
          msg={sheetMsg}
          isOwn={sheetMsg.user_id === currentUser?.id}
          canReply={canSend && !isArchived}
          canDelete={sheetMsg.user_id === currentUser?.id || canManageMessages}
          canPin={canPin}
          canThread={canThread}
          canPublish={channel.type === 'announcement' && Boolean(onPublish) && !sheetMsg.crossposted}
          actions={actions}
          onClose={() => setSheetMsg(null)}
        />
      )}

      {lightbox && (
        <ImageLightboxModal
          imageUrl={lightbox.url}
          altText={lightbox.alt}
          images={lightbox.images}
          startIndex={lightbox.index}
          onClose={() => setLightbox(null)}
        />
      )}
    </div>
  );
}

function SYSTEM_MESSAGE(msg) {
  return !['default', 'reply', undefined, null].includes(msg.type);
}

/** The "Drop to upload" overlay, tracked with its own state (not the chat's). */
function DropHint({ enabled, target }) {
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (!enabled) return undefined;
    let depth = 0;
    const enter = (e) => { if (e.dataTransfer?.types?.includes('Files')) { depth += 1; setDragging(true); } };
    const leave = () => { depth = Math.max(0, depth - 1); if (!depth) setDragging(false); };
    const end = () => { depth = 0; setDragging(false); };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', end);
    window.addEventListener('dragend', end);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', end);
      window.removeEventListener('dragend', end);
    };
  }, [enabled]);
  if (!dragging) return null;
  return (
    <div className="absolute inset-3 z-50 border-4 border-dashed border-d-brand rounded-2xl bg-d-brand/10 flex items-center justify-center pointer-events-none">
      <div className="text-center">
        <PlusCircle className="w-12 h-12 text-d-strong mx-auto mb-2" aria-hidden="true" />
        <p className="text-lg font-bold text-d-strong">{t('chat.dropToUpload')}</p>
        <p className="text-xs text-d-text">{t('chat.dropTarget', { target })}</p>
      </div>
    </div>
  );
}
