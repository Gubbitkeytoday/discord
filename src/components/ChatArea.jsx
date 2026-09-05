import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import {
  Hash, Bell, BellOff, Pin, Users, Search, PlusCircle, Smile, Send, Trash2, Reply, X,
  FileText, Download, Pencil, ArrowDown, Loader2, Check, Sticker, Inbox, UserPlus,
  MessagesSquare, Archive, AlertTriangle, RotateCcw, Megaphone, Volume2, Lock, BarChart3, ChevronRight
} from 'lucide-react';
import { parseDiscordMarkdown } from '../utils/markdownParser';
import { playMessageIncomingSound } from '../utils/soundEffects';
import { DEFAULT_AVATAR } from '../utils/avatar';
import {
  decorateMessages, formatDateDivider, formatTime, formatFullTimestamp, formatTypingText
} from '../utils/messageGrouping';

import ImageLightboxModal from './ImageLightboxModal';
import LinkEmbed from './LinkEmbed';
import PinnedMessagesPopover from './PinnedMessagesPopover';
import MessageContextMenu from './MessageContextMenu';
import EmojiPicker from './EmojiPicker';
import StickerPicker from './StickerPicker';
import PollCard from './PollCard';
import CreatePollModal from './CreatePollModal';
import { VoiceNotePlayer, VoiceNoteRecorder, VoiceNoteButton } from './VoiceNote';
import { runSlashCommand } from '../utils/slashCommands';
import { t } from '../i18n/index.jsx';
import { useUserSettings } from '../hooks/useUserSettings';
import ComposerAutocomplete, { detectTrigger, buildOptions } from './ComposerAutocomplete';

const FALLBACK_AVATAR = DEFAULT_AVATAR;
const QUICK_EMOJIS = ['❤️', '🔥', '👍', '😂', '🎉', '🚀', '💯', '💩', '✨'];

// How close to the bottom still counts as "following the conversation".
const AUTOSCROLL_THRESHOLD_PX = 120;

const HEADER_ICONS = { announcement: Megaphone, voice: Volume2, forum: MessagesSquare, thread: MessagesSquare };

export default function ChatArea({
  channel,
  messages,
  pins = [],
  onSendMessage,
  onCreatePoll,
  onSendVoiceNote,
  onSlashAction,
  onRetryMessage,
  onToggleReaction,
  onDeleteMessage,
  onEditMessage,
  onToggleMemberList,
  showMemberList,
  currentUser,
  viewerPermissions = [],
  isOwner = false,
  onSelectUser,
  onUserContextMenu,
  onTypingStart,
  onTypingStop,
  typingUsers = [],
  lastReadMessageId = null,
  onLoadMore,
  hasMoreHistory = false,
  isLoadingHistory = false,
  onSearch,
  onTogglePin,
  members = [],
  channels = [],
  customEmojis = [],
  externalEmojiGroups = [],
  stickers = [],
  onSelectChannel,
  onCreateThread,
  onForward,
  onPublish = null,
  onFollowChannel = null,
  onMarkUnread,
  onReport,
  onOpenNotificationSettings,
  channelSettings,
  blockedIds,
  onOpenInbox,
  inboxCount = 0,
  onAddGroupRecipients,
  onArchiveThread,
  onToast,
  isUnknownSender
}) {
  const [inputText, setInputText] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [replyToMsg, setReplyToMsg] = useState(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showStickerPicker, setShowStickerPicker] = useState(false);
  const [showPollComposer, setShowPollComposer] = useState(false);
  const [recordingNote, setRecordingNote] = useState(false);

  /**
   * Resolve a user id to a display name for the reaction tooltip.
   *
   * The server already sends `user_ids` with every reaction, so naming them is
   * a lookup rather than a request. Someone who has left the server is not in
   * `members` any more — showing "someone" beats showing a snowflake.
   */
  const nameFor = useCallback((userId) => {
    if (userId === currentUser?.id) return t('chat.you');
    const member = members.find((m) => m.id === userId || m.user_id === userId);
    return member?.nickname || member?.display_name || member?.username || t('chat.someone');
  }, [members, currentUser?.id]);
  const [lightboxImg, setLightboxImg] = useState(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState('');
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [showPins, setShowPins] = useState(false);
  const [contextMenu, setContextMenu] = useState(null);
  const [trigger, setTrigger] = useState(null);
  const [acIndex, setAcIndex] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [revealedBlocked, setRevealedBlocked] = useState(() => new Set());

  // Text & Images and Accessibility decide what a message row actually renders.
  const { prefs } = useUserSettings();
  const chatPrefs = prefs.chat;
  const a11yPrefs = prefs.accessibility;

  const fileInputRef = useRef(null);
  const scrollRef = useRef(null);
  const typingTimerRef = useRef(null);
  const textareaRef = useRef(null);
  const prependAnchorRef = useRef(null);

  const can = useCallback(
    (name) => viewerPermissions.includes(name) || viewerPermissions.includes('ADMINISTRATOR') || isOwner,
    [viewerPermissions, isOwner]
  );

  const isDM = channel?.type === 'dm' || channel?.type === 'group_dm';

  /**
   * Privacy & Safety › direct message scanning. Media from someone outside the
   * chosen scope stays behind a cover until you decide to look at it.
   */
  const safetyFilters = (msg) => {
    if (!isDM || chatPrefs === undefined) return false;
    if (prefs.privacy.dmScanning === 'off') return false;
    if (msg.user_id === currentUser?.id) return false;
    if (prefs.privacy.dmScanning === 'friends' && !isUnknownSender?.(msg.user_id)) return false;
    return (msg.attachments?.length ?? 0) > 0;
  };
  // In a DM every conversational permission is implied; in a guild they resolve
  // from the viewer's roles and this channel's overwrites.
  const canManageMessages = isDM ? false : can('MANAGE_MESSAGES');
  const canSend = isDM || !channel?.server_id ? true : can('SEND_MESSAGES');
  const canAttach = isDM || !channel?.server_id ? true : can('ATTACH_FILES');
  const isArchived = Boolean(channel?.archived);
  const isLocked = Boolean(channel?.locked);

  const decorated = useMemo(
    () => decorateMessages(messages, { lastReadMessageId, currentUserId: currentUser?.id }),
    [messages, lastReadMessageId, currentUser?.id]
  );

  const autocompleteOptions = useMemo(
    () => buildOptions(trigger, { members, channels, customEmojis }),
    [trigger, members, channels, customEmojis]
  );

  const markdownContext = useMemo(() => ({
    resolveUser: (id) => {
      const m = members.find((x) => x.id === id);
      return m?.display_name ?? m?.username ?? null;
    },
    resolveChannel: (id) => channels.find((c) => c.id === id)?.name ?? null,
    resolveRole: (id) => {
      for (const m of members) {
        const role = m.roles?.find((r) => r.id === id);
        if (role) return role;
      }
      return null;
    },
    emojiUrl: (id) => customEmojis.find((e) => String(e.id) === String(id))?.url
      ?? externalEmojiGroups.flatMap((g) => g.emojis).find((e) => String(e.id) === String(id))?.url,
    onMentionClick: (id) => onSelectUser?.(id),
    onChannelClick: (id) => onSelectChannel?.(id)
  }), [members, channels, customEmojis, externalEmojiGroups, onSelectUser, onSelectChannel]);

  const trackScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setIsAtBottom(distanceFromBottom < AUTOSCROLL_THRESHOLD_PX);

    if (el.scrollTop < 80 && hasMoreHistory && !isLoadingHistory && onLoadMore) {
      prependAnchorRef.current = el.scrollHeight;
      onLoadMore();
    }
  }, [hasMoreHistory, isLoadingHistory, onLoadMore]);

  // Only auto-scroll when the user is already at the bottom. Being yanked back
  // down while reading history is the single worst chat bug.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (prependAnchorRef.current !== null) {
      el.scrollTop = el.scrollHeight - prependAnchorRef.current;
      prependAnchorRef.current = null;
      return;
    }
    if (isAtBottom) el.scrollTop = el.scrollHeight;
  }, [decorated, isAtBottom]);

  useEffect(() => {
    setIsAtBottom(true);
    setReplyToMsg(null);
    setEditingId(null);
    setInputText('');
    setAttachments([]);
    setShowPins(false);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [channel?.id]);

  if (!channel) {
    return (
      <div className="flex-1 bg-d-canvas flex items-center justify-center text-d-text3">
        {t('chat.selectChannel')}
      </div>
    );
  }

  const handleFileChange = async (e) => {
    const files = Array.from(e.target.files || []);
    await uploadFiles(files);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  /** Shared by the file picker, clipboard paste and drag-and-drop. */
  const uploadFiles = async (files) => {
    if (!files?.length) return;
    if (!canAttach) { setUploadError(t('chat.noAttachPermission')); return; }

    setIsUploading(true);
    setUploadError(null);
    const formData = new FormData();
    files.forEach((file) => formData.append('files', file));

    try {
      const res = await fetch('/api/upload/attachments', {
        method: 'POST',
        credentials: 'same-origin',
        headers: currentUser ? { 'x-user-id': currentUser.id } : {},
        body: formData
      });
      const data = await res.json();
      if (data.attachments?.length) {
        setAttachments((prev) => [...prev, ...data.attachments]);
        if (data.failed?.length) {
          setUploadError(data.failed.map((f) => `${f.filename}: ${f.error}`).join('\n'));
        }
      } else {
        setUploadError(data.error ?? t('chat.uploadFailed'));
      }
    } catch (err) {
      setUploadError(err.message);
    } finally {
      setIsUploading(false);
    }
  };

  const emitTyping = () => {
    if (!onTypingStart || !canSend) return;
    // Throttle: one typing_start per 3s while actively typing.
    if (typingTimerRef.current) return;
    onTypingStart();
    typingTimerRef.current = setTimeout(() => { typingTimerRef.current = null; }, 3000);
  };

  const clearComposer = () => {
    setInputText('');
    setAttachments([]);
    setReplyToMsg(null);
    setUploadError(null);
    setIsAtBottom(true);
    clearTimeout(typingTimerRef.current);
    typingTimerRef.current = null;
    onTypingStop?.();
  };

  const handleSend = (e) => {
    e?.preventDefault();
    if (!inputText.trim() && attachments.length === 0) return;
    if (!canSend || isArchived) return;

    // A slash command is resolved before anything is sent. Some rewrite the
    // text and fall through to the normal path; others do something else
    // entirely and send nothing at all.
    const command = runSlashCommand(inputText.trim());
    if (command) {
      if (command.unknown) {
        onToast?.(t('slash.unknown', { name: command.name }), { type: 'error' });
        return;
      }
      if (command.action) {
        clearComposer();
        // /poll opens the composer that lives here; everything else is the
        // app's business.
        if (command.action === 'poll') setShowPollComposer(true);
        else onSlashAction?.(command.action, command.value);
        return;
      }
      if (command.empty) { clearComposer(); return; }
      onSendMessage(command.content, attachments, replyToMsg?.id, { tts: command.tts });
      playMessageIncomingSound();
      clearComposer();
      return;
    }

    onSendMessage(inputText, attachments, replyToMsg?.id);
    playMessageIncomingSound();
    clearComposer();
  };

  const sendSticker = (sticker) => {
    onSendMessage('', [], replyToMsg?.id, { sticker });
    setReplyToMsg(null);
    setIsAtBottom(true);
  };

  const updateTrigger = (value, caret) => {
    setTrigger(detectTrigger(value, caret));
    setAcIndex(0);
  };

  /** Replace the trigger token with the chosen completion. */
  const applyCompletion = (option) => {
    if (!trigger) return;
    if (option.command) {
      // Keep whatever argument was already typed, so completing "/sh" into
      // "/shrug" does not throw away the words after it.
      const rest = inputText.replace(/^\/\w*\s?/, '');
      setInputText(`${option.insert}${rest}`);
    } else {
      const before = inputText.slice(0, trigger.start);
      const after = inputText.slice(trigger.start + trigger.query.length + 1);
      setInputText(before + option.insert + after.replace(/^\s/, ''));
    }
    setTrigger(null);
    setAcIndex(0);
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const handleInputKeyDown = (e) => {
    // While the popup is open it owns the arrows, Tab, Enter and Escape.
    if (trigger && autocompleteOptions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setAcIndex((i) => (i + 1) % autocompleteOptions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setAcIndex((i) => (i - 1 + autocompleteOptions.length) % autocompleteOptions.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        applyCompletion(autocompleteOptions[acIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setTrigger(null);
        return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend(e);
      return;
    }
    if (e.key === 'Escape' && replyToMsg) {
      e.preventDefault();
      setReplyToMsg(null);
      return;
    }
    // Discord: ↑ on an empty box edits your most recent message.
    if (e.key === 'ArrowUp' && !inputText) {
      const mine = [...messages].reverse().find((m) => m.user_id === currentUser?.id && !m.pending);
      if (mine) { e.preventDefault(); startEditing(mine); }
    }
  };

  /** Paste an image straight from the clipboard, as Discord does. */
  const handlePaste = async (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.length === 0) return;
    e.preventDefault();
    await uploadFiles(files);
  };

  const handleDrop = async (e) => {
    e.preventDefault();
    setIsDragging(false);
    const files = [...(e.dataTransfer?.files ?? [])];
    if (files.length) await uploadFiles(files);
  };

  const startEditing = (msg) => {
    setEditingId(msg.id);
    setEditText(msg.content ?? '');
  };

  /** Scroll a message into view and flash it, like Discord's jump. */
  const jumpToMessage = (messageId) => {
    const node = document.getElementById(`message-${messageId}`);
    if (!node) return;
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    node.classList.add('bg-d-brand/20');
    setTimeout(() => node.classList.remove('bg-d-brand/20'), 1600);
  };

  const submitEdit = (e) => {
    e.preventDefault();
    if (!editText.trim()) return;
    onEditMessage?.(editingId, editText);
    setEditingId(null);
    setEditText('');
  };

  const typingText = formatTypingText(typingUsers.map((u) => u.displayName ?? u.userId));

  const title = isDM ? channel.display_name : channel.name;
  const HeaderIcon = HEADER_ICONS[channel.type] ?? Hash;
  // A thread (incl. a forum post) shows its parent as a crumb you can click.
  const parentChannel = channel.type === 'thread' && channel.parent_id
    ? channels.find((c) => c.id === channel.parent_id) ?? null : null;
  const muted = Boolean(channelSettings?.muted);
  const composerPlaceholder = !canSend
    ? t('chat.noSendPermission')
    : isArchived
    ? t('chat.threadArchived')
    : isDM
    ? t('chat.messagePlaceholderDm', { name: title })
    : t('chat.messagePlaceholder', { channel: title });

  return (
    <div
      className="flex-1 bg-d-canvas flex flex-col min-w-0 h-full relative"
      onDragOver={(e) => { if (canAttach) { e.preventDefault(); setIsDragging(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setIsDragging(false); }}
      onDrop={handleDrop}
    >
      {isDragging && (
        <div className="absolute inset-3 z-50 border-4 border-dashed border-d-brand rounded-2xl bg-d-brand/10 flex items-center justify-center pointer-events-none">
          <div className="text-center">
            <PlusCircle className="w-12 h-12 text-d-strong mx-auto mb-2" />
            <p className="text-lg font-bold text-d-strong">{t('chat.dropToUpload')}</p>
            <p className="text-xs text-d-text">{t('chat.dropTarget', { target: isDM ? '@' + title : '#' + title })}</p>
          </div>
        </div>
      )}

      {/* Channel header */}
      <div className="h-12 px-4 shadow-sm border-b border-d-edge flex items-center justify-between shrink-0 bg-d-canvas z-10">
        <div className="flex items-center gap-2 min-w-0">
          {isDM ? (
            <img src={channel.avatar_url || FALLBACK_AVATAR} alt="" className="w-6 h-6 rounded-full object-cover shrink-0" />
          ) : (
            <HeaderIcon className="w-6 h-6 text-d-text4 shrink-0" />
          )}
          {parentChannel && (
            <>
              <button
                type="button"
                onClick={() => onSelectChannel?.(parentChannel.id)}
                className="text-d-text3 hover:text-d-strong text-[15px] font-semibold truncate max-w-[10rem]"
                title={t('chat.backToChannel', { channel: parentChannel.name })}
              >
                {parentChannel.name}
              </button>
              <ChevronRight className="w-4 h-4 text-d-text4 shrink-0" aria-hidden="true" />
            </>
          )}
          <span className="font-bold text-d-strong text-[15px] truncate">{title}</span>
          {channel.is_private && <Lock className="w-3.5 h-3.5 text-d-text4 shrink-0" />}
          {isArchived && (
            <span className="text-[10px] bg-d-surface text-d-text3 px-1.5 py-0.5 rounded shrink-0">
              {t('chat.archived')}
            </span>
          )}
          {channel.topic && (
            <>
              <div className="w-[1px] h-4 bg-d-divider mx-2 hidden sm:block" />
              <span className="text-xs text-d-text3 truncate hidden sm:block" title={channel.topic}>{channel.topic}</span>
            </>
          )}
        </div>

        <div className="flex items-center gap-3 text-d-text2">
          {channel.type === 'announcement' && onFollowChannel && (
            <button
              type="button"
              onClick={() => onFollowChannel(channel)}
              className="inline-flex items-center gap-1.5 text-xs font-semibold bg-d-surface hover:bg-d-surface/70 text-d-strong px-2.5 py-1 rounded-md"
              title={t('chat.followChannelHint')}
            >
              <Megaphone className="w-3.5 h-3.5" aria-hidden="true" />{t('chat.followChannel')}
            </button>
          )}
          {onArchiveThread && (
            <button
              onClick={() => onArchiveThread(!isArchived)}
              className="hover:text-d-strong transition-colors"
              title={isArchived ? t('chat.unarchiveThread') : t('chat.archiveThread')}
            >
              <Archive className="w-5 h-5" />
            </button>
          )}

          {onAddGroupRecipients && (
            <button onClick={onAddGroupRecipients} className="hover:text-d-strong transition-colors" title={t('dm.addToGroup')}>
              <UserPlus className="w-5 h-5" />
            </button>
          )}

          <button
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              onOpenNotificationSettings?.(rect.left - 120, rect.bottom + 6);
            }}
            className={`hover:text-d-strong transition-colors ${muted ? 'text-d-danger' : ''}`}
            title={t('notif.notificationSettings')}
            aria-label={t('notif.notificationSettings')}
          >
            {muted ? <BellOff className="w-5 h-5" /> : <Bell className="w-5 h-5" />}
          </button>

          <button
            onClick={() => setShowPins((v) => !v)}
            className={`hover:text-d-strong transition-colors relative ${showPins ? 'text-d-strong' : ''}`}
            title={t('chat.pinnedMessages')}
            aria-expanded={showPins}
          >
            <Pin className="w-5 h-5" />
            {pins.length > 0 && (
              <span className="absolute -top-1 -right-1 bg-d-brand text-white text-[9px] font-bold w-3.5 h-3.5 rounded-full flex items-center justify-center">
                {pins.length}
              </span>
            )}
          </button>

          {!isDM && (
            <button
              onClick={onToggleMemberList}
              className={`hover:text-d-strong transition-colors ${showMemberList ? 'text-d-strong' : ''}`}
              title={t('chat.memberList')}
              aria-pressed={showMemberList}
            >
              <Users className="w-5 h-5" />
            </button>
          )}

          {onOpenInbox && (
            <button
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                onOpenInbox(rect.right, rect.bottom + 6);
              }}
              className="hover:text-d-strong transition-colors relative"
              title={t('notif.inbox')}
            >
              <Inbox className="w-5 h-5" />
              {inboxCount > 0 && (
                <span className="absolute -top-1 -right-1 bg-d-danger text-white text-[9px] font-bold min-w-[14px] h-3.5 px-0.5 rounded-full flex items-center justify-center">
                  {inboxCount > 9 ? '9+' : inboxCount}
                </span>
              )}
            </button>
          )}

          <form
            onSubmit={(e) => { e.preventDefault(); onSearch?.(searchTerm); }}
            className="relative hidden md:block"
          >
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder={t('common.search')}
              aria-label={t('chat.searchMessages')}
              className="bg-d-base text-xs text-d-strong placeholder-d-text4 px-2 py-1 pr-6 rounded focus:outline-none w-36 focus:w-48 transition-all"
            />
            <button type="submit" className="absolute right-2 top-1.5" title={t('chat.searchMessages')}>
              <Search className="w-3.5 h-3.5 text-d-text4 hover:text-d-strong" />
            </button>
          </form>
        </div>
      </div>

      {/* Messages */}
      <div ref={scrollRef} onScroll={trackScroll} className="flex-1 overflow-y-auto px-4 select-text">
        {isLoadingHistory && (
          <div className="flex justify-center py-3 text-d-text3">
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
        )}

        {!hasMoreHistory && (
          <div className="my-6">
            <div className="w-16 h-16 rounded-full bg-d-active flex items-center justify-center mb-3">
              <HeaderIcon className="w-10 h-10 text-d-strong" />
            </div>
            <h2 className="text-3xl font-extrabold text-d-strong mb-1">
              {isDM ? t('chat.welcomeToDm', { name: title }) : t('chat.welcomeToChannel', { channel: title })}
            </h2>
            <p className="text-sm text-d-text3">
              {isDM ? t('chat.dmStart', { name: title }) : t('chat.channelStart', { channel: title })}
            </p>
            <div className="w-full h-[1px] bg-d-divider mt-4" />
          </div>
        )}

        {decorated.map((msg) => {
          const isOwn = msg.user_id === currentUser?.id;
          const isBlockedAuthor = blockedIds?.has(msg.user_id) && !isOwn;
          const revealed = revealedBlocked.has(msg.id);
          const reactionList = msg.reaction_details?.length
            ? msg.reaction_details
            : Object.entries(msg.reactions ?? {}).map(([emoji, count]) => ({ emoji, count, me: false }));

          if (isBlockedAuthor && !revealed) {
            return (
              <div key={msg.id} className="py-1 text-[11px] text-d-text4 flex items-center gap-2">
                <span>{t('chat.blockedMessage')}</span>
                <button
                  onClick={() => setRevealedBlocked((prev) => new Set(prev).add(msg.id))}
                  className="text-d-link hover:underline"
                >
                  {t('chat.showAnyway')}
                </button>
              </div>
            );
          }

          return (
            <React.Fragment key={msg.id}>
              {msg.dateDivider && (
                <div className="flex items-center gap-2 my-4" role="separator">
                  <div className="flex-1 h-[1px] bg-d-divider" />
                  <span className="text-[11px] font-semibold text-d-text3 px-1">
                    {formatDateDivider(msg.dateDivider)}
                  </span>
                  <div className="flex-1 h-[1px] bg-d-divider" />
                </div>
              )}

              {msg.isFirstUnread && (
                <div className="flex items-center gap-2 my-2">
                  <div className="flex-1 h-[1px] bg-d-danger" />
                  <span className="text-[10px] font-bold text-d-danger bg-d-danger/10 px-2 py-0.5 rounded">
                    {t('chat.newMessages')}
                  </span>
                </div>
              )}

              <div
                id={`message-${msg.id}`}
                onContextMenu={(e) => {
                  if (e.target.closest('a, img, video, audio, textarea')) return;
                  e.preventDefault();
                  setContextMenu({ message: msg, x: e.clientX, y: e.clientY });
                }}
                className={`group flex gap-4 px-2 -mx-2 rounded hover:bg-d-rowhover transition-colors relative ${
                  msg.isGrouped ? 'py-[1px]' : 'py-[var(--message-padding-y)] message-group-start'
                } ${msg.pending ? 'opacity-50' : ''} ${msg.failed ? 'opacity-70' : ''} ${msg.isFirstUnread ? 'bg-d-danger/[0.04]' : ''}`}
              >
                {msg.isGrouped ? (
                  <div
                    className="w-10 shrink-0 text-[10px] text-d-text3 text-right pr-1 opacity-0 group-hover:opacity-100 transition-opacity select-none"
                    title={formatFullTimestamp(msg.created_at)}
                  >
                    {formatTime(msg.created_at)}
                  </div>
                ) : (
                  <img
                    src={msg.avatar_url || FALLBACK_AVATAR}
                    alt=""
                    onClick={() => onSelectUser?.(msg.user_id)}
                    onContextMenu={(e) => {
                      if (!onUserContextMenu) return;
                      e.preventDefault();
                      e.stopPropagation();
                      onUserContextMenu(msg.user_id, e.clientX, e.clientY);
                    }}
                    className="w-10 h-10 rounded-full object-cover shrink-0 cursor-pointer hover:opacity-80 transition-opacity mt-0.5"
                  />
                )}

                <div className="flex-1 min-w-0">
                  {msg.reply_to_id && (
                    <div className="flex items-center gap-1.5 text-xs text-d-text3 mb-1">
                      <Reply className="w-3.5 h-3.5 shrink-0 rotate-180 text-d-text4" />
                      {msg.replyToMsg ? (
                        <>
                          <span className="font-semibold text-d-mention">@{msg.replyToMsg.display_name}</span>
                          <button
                            onClick={() => jumpToMessage(msg.reply_to_id)}
                            className="truncate max-w-xs text-d-text2 hover:underline text-left"
                          >
                            {msg.replyToMsg.content || t('chat.clickToSeeAttachment')}
                          </button>
                        </>
                      ) : (
                        <span className="italic text-d-text4">{t('chat.originalDeleted')}</span>
                      )}
                    </div>
                  )}

                  {!msg.isGrouped && (
                    <div className="flex items-center gap-2 mb-0.5">
                      <span
                        onClick={() => onSelectUser?.(msg.user_id)}
                        onContextMenu={(e) => {
                          if (!onUserContextMenu) return;
                          e.preventDefault();
                          e.stopPropagation();
                          onUserContextMenu(msg.user_id, e.clientX, e.clientY);
                        }}
                        className="font-semibold text-sm hover:underline cursor-pointer role-colored inline-flex items-center gap-1.5"
                        style={{ color: msg.role_color || 'var(--color-d-strong)' }}
                      >
                        {a11yPrefs.roleColors === 'dots' && msg.role_color && (
                          <span
                            className="role-dot w-2 h-2 rounded-full shrink-0"
                            style={{ backgroundColor: msg.role_color }}
                            aria-hidden="true"
                          />
                        )}
                        {msg.display_name || msg.username}
                      </span>
                      {msg.is_bot && (
                        <span className="bg-d-brand text-white text-[10px] font-bold px-1.5 rounded">BOT</span>
                      )}
                      {msg.crossposted && (
                        <span className="text-[9px] uppercase tracking-wide bg-d-surface text-d-text3 px-1 rounded shrink-0" title={t('chat.publishedHint')}>
                          {t('chat.published')}
                        </span>
                      )}
                      {msg.webhook_id && !msg.is_bot && (
                        <span className="bg-d-surface text-d-text3 text-[10px] font-bold px-1.5 rounded">
                          {t('webhooks.badge')}
                        </span>
                      )}
                      {chatPrefs.showTimestamps && (
                        <span className="text-[11px] text-d-text3" title={formatFullTimestamp(msg.created_at)}>
                          {formatTime(msg.created_at, undefined, chatPrefs.use24HourClock)}
                        </span>
                      )}
                    </div>
                  )}

                  {editingId === msg.id ? (
                    <form onSubmit={submitEdit} className="mt-1">
                      <textarea
                        aria-label={t('chat.editMessage')}
                        value={editText}
                        onChange={(e) => setEditText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !e.shiftKey) submitEdit(e);
                          if (e.key === 'Escape') setEditingId(null);
                        }}
                        rows={Math.min(8, editText.split('\n').length)}
                        autoFocus
                        className="w-full bg-d-input text-d-strong text-sm rounded px-3 py-2 resize-none focus:outline-none"
                      />
                      <div className="flex items-center gap-2 mt-1 text-[11px] text-d-text3">
                        <button type="button" onClick={() => setEditingId(null)} className="hover:underline">
                          {t('chat.cancelEsc')}
                        </button>
                        <button type="submit" className="text-d-link hover:underline flex items-center gap-1">
                          <Check className="w-3 h-3" /> {t('chat.saveEnter')}
                        </button>
                      </div>
                    </form>
                  ) : (
                    msg.content ? (
                      <div className="message-body text-d-text leading-relaxed whitespace-pre-wrap break-words">
                        {parseDiscordMarkdown(msg.content, markdownContext)}
                        {msg.edited_at && (
                          <span className="text-[10px] text-d-text3 ml-1 align-baseline" title={formatFullTimestamp(msg.edited_at)}>
                            {t('chat.edited')}
                          </span>
                        )}
                      </div>
                    ) : null
                  )}

                  {msg.poll && (
                    <PollCard
                      poll={msg.poll}
                      currentUserId={currentUser?.id}
                      canManage={msg.user_id === currentUser?.id
                        || viewerPermissions.includes('MANAGE_MESSAGES')
                        || viewerPermissions.includes('ADMINISTRATOR')}
                      onToast={onToast}
                    />
                  )}

                  {msg.sticker && (
                    <img
                      src={msg.sticker.url}
                      alt={msg.sticker.name}
                      title={msg.sticker.name}
                      className={`mt-1 w-40 h-40 object-contain ${
                        a11yPrefs.stickerAnimation === 'interaction' ? 'hover:animate-none' : ''
                      }`}
                      loading="lazy"
                      // "Never" freezes the sticker on its first frame the same
                      // way the browser does for a paused GIF.
                      style={a11yPrefs.stickerAnimation === 'never' ? { animationPlayState: 'paused' } : undefined}
                    />
                  )}

                  {chatPrefs.showEmbeds && chatPrefs.showLinkPreviews && msg.embeds?.length > 0 && (
                    <div className="space-y-1">
                      {msg.embeds.map((embed, i) => (
                        <LinkEmbed key={i} embed={embed} onOpenImage={setLightboxImg} />
                      ))}
                    </div>
                  )}

                  {msg.attachments?.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {msg.attachments.map((att, i) => (
                        att.waveform ? (
                          <VoiceNotePlayer key={att.id ?? i} attachment={att} />
                        ) : (
                        <Attachment
                          key={att.id ?? i}
                          attachment={att}
                          onOpenImage={setLightboxImg}
                          showMedia={chatPrefs.inlineAttachmentMedia}
                          showImages={chatPrefs.showImagePreviews}
                          spoilerMode={chatPrefs.renderSpoilers}
                          isOwn={isOwn}
                          safetyHold={safetyFilters(msg)}
                        />
                        )
                      ))}
                    </div>
                  )}

                  {msg.failed && (
                    <div className="mt-1 flex items-center gap-2 text-[11px] text-d-danger">
                      <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                      <span className="truncate">{msg.error ?? t('chat.sendFailedShort')}</span>
                      <button onClick={() => onRetryMessage?.(msg)} className="hover:underline flex items-center gap-1">
                        <RotateCcw className="w-3 h-3" /> {t('chat.retry')}
                      </button>
                    </div>
                  )}

                  {reactionList.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-2">
                      {reactionList.map((r) => (
                        <ReactionChip
                          key={r.emoji}
                          reaction={r}
                          onToggle={() => onToggleReaction(msg.id, r.emoji)}
                          nameFor={nameFor}
                        />
                      ))}
                    </div>
                  )}
                </div>

                {/* Hover toolbar */}
                {!msg.pending && !msg.failed && editingId !== msg.id && (
                  <div className="absolute right-4 -top-3.5 hidden group-hover:flex items-center bg-d-canvas border border-d-surface rounded-md shadow-lg p-0.5 gap-1 z-10">
                    {QUICK_EMOJIS.slice(0, 3).map((emoji) => (
                      <button
                        key={emoji}
                        onClick={() => onToggleReaction(msg.id, emoji)}
                        className="p-1 hover:bg-d-hover rounded text-xs transition-colors"
                        title={t('chat.reactWith', { emoji })}
                      >
                        {emoji}
                      </button>
                    ))}
                    {canSend && !isArchived && (
                      <button
                        onClick={() => setReplyToMsg(msg)}
                        className="p-1 hover:bg-d-hover text-d-text2 hover:text-d-strong rounded transition-colors"
                        title={t('chat.reply')}
                      >
                        <Reply className="w-4 h-4" />
                      </button>
                    )}
                    {isOwn && (
                      <button
                        onClick={() => startEditing(msg)}
                        className="p-1 hover:bg-d-hover text-d-text2 hover:text-d-strong rounded transition-colors"
                        title={t('chat.editMessage')}
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                    )}
                    {(isOwn || canManageMessages) && (
                      <button
                        onClick={() => onDeleteMessage?.(msg.id)}
                        className="p-1 hover:bg-d-danger/20 text-d-danger rounded transition-colors"
                        title={t('chat.deleteMessage')}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                )}
              </div>
            </React.Fragment>
          );
        })}
        <div className="h-4" />
      </div>

      {!isAtBottom && (
        <button
          onClick={() => {
            setIsAtBottom(true);
            const el = scrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
          className="absolute bottom-28 right-6 bg-d-brand hover:bg-d-brandhover text-white text-xs font-semibold px-3 py-1.5 rounded-full shadow-lg flex items-center gap-1.5 z-20 transition-colors"
        >
          <ArrowDown className="w-3.5 h-3.5" /> {t('chat.jumpToPresent')}
        </button>
      )}

      {/* Composer */}
      <div className="px-4 pb-6 pt-1 shrink-0 relative">
        {replyToMsg && (
          <div className="mb-2 px-3 py-1.5 bg-d-surface rounded-t-lg border-x border-t border-d-divider flex items-center justify-between text-xs text-d-text2">
            <div className="flex items-center gap-2 truncate">
              <Reply className="w-3.5 h-3.5 text-d-brand" />
              <span>{t('chat.replyingTo', { name: replyToMsg.display_name })}</span>
            </div>
            <button onClick={() => setReplyToMsg(null)} className="hover:text-d-strong" title={t('common.cancel')}>
              <X className="w-4 h-4" />
            </button>
          </div>
        )}

        {uploadError && (
          <div className="mb-2 px-3 py-2 bg-d-danger/10 border border-d-danger/40 rounded-lg text-xs text-d-danger flex items-start justify-between gap-2">
            <span className="whitespace-pre-wrap">{uploadError}</span>
            <button onClick={() => setUploadError(null)} className="shrink-0 hover:text-d-strong">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        {attachments.length > 0 && (
          <div className="mb-2 p-2.5 bg-d-surface rounded-lg border border-d-divider flex flex-wrap gap-3">
            {attachments.map((att, i) => (
              <div key={att.id ?? i} className="relative group bg-d-base p-1 rounded-lg border border-d-divider flex items-center gap-2">
                {att.file_type === 'image' ? (
                  <img src={att.thumbnail_url ?? att.url} alt="" className="w-14 h-14 rounded object-cover" />
                ) : (
                  <div className="w-14 h-14 bg-d-surface rounded flex items-center justify-center text-xs text-d-brand font-semibold">
                    FILE
                  </div>
                )}
                <div className="pr-1 max-w-[140px]">
                  <div className="text-[11px] text-d-strong truncate">{att.filename}</div>
                  <div className="text-[10px] text-d-text3">{att.size_human}</div>
                </div>
                <button
                  type="button"
                  onClick={() => setAttachments(attachments.filter((_, idx) => idx !== i))}
                  className="absolute -top-1.5 -right-1.5 bg-d-danger text-white rounded-full p-1 shadow-md opacity-90 hover:opacity-100 transition-opacity"
                  title={t('chat.removeAttachment')}
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}

        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileChange}
          aria-label={t('chat.selectFiles')}
          className="hidden"
          multiple
          accept="image/*,video/*,audio/*,.pdf,.json,.txt,.zip"
        />

        {showEmojiPicker && (
          <div className="absolute bottom-20 right-4 z-40">
            <EmojiPicker
              customEmojis={customEmojis}
              externalGroups={externalEmojiGroups.filter((g) => g.server_id !== channel?.server_id)}
              onClose={() => setShowEmojiPicker(false)}
              onPick={(entry) => {
                setInputText((prev) => prev + (entry.custom ? '<:' + entry.name + ':' + entry.id + '> ' : entry.char));
                setShowEmojiPicker(false);
                requestAnimationFrame(() => textareaRef.current?.focus());
              }}
            />
          </div>
        )}

        {showPollComposer && (
          <CreatePollModal
            onClose={() => setShowPollComposer(false)}
            onCreate={(poll) => onCreatePoll(poll)}
            onToast={onToast}
          />
        )}

        {showStickerPicker && (
          <div className="absolute bottom-20 right-4 z-40">
            <StickerPicker
              stickers={stickers}
              onClose={() => setShowStickerPicker(false)}
              onPick={sendSticker}
            />
          </div>
        )}

        <div className="relative">
          <ComposerAutocomplete
            trigger={trigger}
            options={autocompleteOptions}
            activeIndex={acIndex}
            onPick={applyCompletion}
          />
        </div>

        <form
          onSubmit={handleSend}
          className={`bg-d-input rounded-lg px-4 py-2.5 flex items-end gap-3 ${!canSend || isArchived ? 'opacity-60' : ''}`}
        >
          {recordingNote ? (
            <VoiceNoteRecorder
              onCancel={() => setRecordingNote(false)}
              onToast={onToast}
              onSend={async (note) => {
                await onSendVoiceNote?.(note, replyToMsg?.id);
                setRecordingNote(false);
                setReplyToMsg(null);
              }}
            />
          ) : (
          <>
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading || !canAttach || !canSend || isArchived}
            className="text-d-text2 hover:text-d-strong transition-colors pb-0.5 disabled:cursor-not-allowed"
            title={canAttach ? t('chat.uploadFiles') : t('chat.noAttachPermission')}
          >
            <PlusCircle className={`w-6 h-6 ${isUploading ? 'animate-spin text-d-brand' : ''}`} />
          </button>

          {/* textarea, not input: Shift+Enter must insert a newline like Discord */}
          <textarea
            ref={textareaRef}
            value={inputText}
            onChange={(e) => {
              setInputText(e.target.value);
              updateTrigger(e.target.value, e.target.selectionStart);
              emitTyping();
            }}
            onKeyDown={handleInputKeyDown}
            onPaste={handlePaste}
            onClick={(e) => updateTrigger(inputText, e.target.selectionStart)}
            onBlur={() => { onTypingStop?.(); setTrigger(null); }}
            rows={1}
            disabled={!canSend || isArchived}
            maxLength={4000}
            placeholder={composerPlaceholder}
            aria-label={composerPlaceholder}
            className="flex-1 bg-transparent text-d-strong placeholder-d-text4 text-sm focus:outline-none resize-none max-h-48 py-0.5 leading-relaxed disabled:cursor-not-allowed"
            style={{ height: `${Math.min(8, inputText.split('\n').length) * 1.5 + 0.5}rem` }}
          />

          {inputText.length > 3600 && (
            <span className={`text-[11px] pb-1 ${inputText.length >= 4000 ? 'text-d-danger' : 'text-d-text3'}`}>
              {4000 - inputText.length}
            </span>
          )}

          {onCreatePoll && (
            <button
              type="button"
              onClick={() => setShowPollComposer(true)}
              disabled={!canSend || isArchived}
              className="text-d-text2 hover:text-d-strong transition-colors pb-0.5 disabled:opacity-50"
              title={t('poll.createTitle')}
            >
              <BarChart3 className="w-6 h-6" />
            </button>
          )}

          {stickers.length > 0 && (
            <button
              type="button"
              onClick={() => { setShowStickerPicker((v) => !v); setShowEmojiPicker(false); }}
              disabled={!canSend || isArchived}
              className="text-d-text2 hover:text-d-strong transition-colors pb-0.5"
              title={t('stickers.title')}
            >
              <Sticker className="w-6 h-6" />
            </button>
          )}

          <button
            type="button"
            onClick={() => { setShowEmojiPicker((v) => !v); setShowStickerPicker(false); }}
            disabled={!canSend || isArchived}
            className="text-d-text2 hover:text-d-strong transition-colors pb-0.5"
            title={t('chat.emoji')}
          >
            <Smile className="w-6 h-6" />
          </button>

          {onSendVoiceNote && (
            <VoiceNoteButton
              onStart={() => setRecordingNote(true)}
              disabled={!canSend || !canAttach || isArchived}
            />
          )}

          <button
            type="submit"
            disabled={(!inputText.trim() && attachments.length === 0) || !canSend || isArchived}
            className={`p-1.5 rounded-full transition-colors mb-0.5 ${
              (inputText.trim() || attachments.length > 0) && canSend && !isArchived
                ? 'bg-d-brand text-white hover:bg-d-brandhover'
                : 'text-d-text4 cursor-not-allowed'
            }`}
            title={t('chat.send')}
          >
            <Send className="w-4 h-4" />
          </button>
          </>
          )}
        </form>

        {/* Typing indicator sits in the composer's gutter, as in Discord */}
        <div className="h-5 px-1 pt-0.5 text-xs text-d-text flex items-center gap-1.5">
          {isLocked && !isArchived && (
            <span className="text-d-text3 flex items-center gap-1"><Lock className="w-3 h-3" /> {t('chat.channelLocked')}</span>
          )}
          {typingText && chatPrefs.showTypingIndicator && (
            <>
              <span className="flex gap-0.5" aria-hidden="true">
                {[0, 150, 300].map((delay) => (
                  <span
                    key={delay}
                    className="w-1 h-1 bg-d-text rounded-full animate-bounce"
                    style={{ animationDelay: `${delay}ms` }}
                  />
                ))}
              </span>
              <span className="truncate">{typingText}</span>
            </>
          )}
        </div>
      </div>

      {showPins && (
        <PinnedMessagesPopover
          messages={pins}
          canUnpin={canManageMessages || isDM}
          onClose={() => setShowPins(false)}
          onJump={(msg) => { setShowPins(false); jumpToMessage(msg.id); }}
          onUnpin={(msg) => onTogglePin?.(msg, false)}
        />
      )}

      {contextMenu && (
        <MessageContextMenu
          message={contextMenu.message}
          x={contextMenu.x}
          y={contextMenu.y}
          isOwn={contextMenu.message.user_id === currentUser?.id}
          canManage={canManageMessages}
          canPin={canManageMessages || isDM}
          onClose={() => setContextMenu(null)}
          onReply={canSend && !isArchived ? setReplyToMsg : null}
          onEdit={startEditing}
          onDelete={(msg) => onDeleteMessage?.(msg.id)}
          onTogglePin={(msg, pinned) => onTogglePin?.(msg, pinned)}
          onAddReaction={() => setShowEmojiPicker(true)}
          onCreateThread={onCreateThread}
          onPublish={channel.type === 'announcement' ? onPublish : null}
          onForward={onForward}
          onMarkUnread={onMarkUnread}
          onReport={onReport}
          onToast={onToast}
        />
      )}

      {lightboxImg && <ImageLightboxModal imageUrl={lightboxImg} onClose={() => setLightboxImg(null)} />}
    </div>
  );
}

/**
 * Renders one attachment by its server-declared `file_type`, not by guessing
 * from the file extension — the server already sniffed the real content type.
 */
function Attachment({
  attachment, onOpenImage, showMedia = true, showImages = true,
  spoilerMode = 'click', isOwn = false, safetyHold = false
}) {
  const att = typeof attachment === 'string'
    ? { url: attachment, filename: attachment.split('/').pop(), file_type: 'file' }
    : attachment;

  // Text & Images › spoilers: reveal on click, reveal your own, or always.
  const spoilerOpen = (!att.is_spoiler
    || spoilerMode === 'always'
    || (spoilerMode === 'owned' && isOwn)) && !safetyHold;
  const [revealed, setRevealed] = useState(spoilerOpen);

  // "Show media inline" off, or image previews off: fall through to the link row.
  const inlineAllowed = showMedia && (att.file_type !== 'image' || showImages);

  if (att.file_type === 'image' && inlineAllowed) {
    // Reserve the image's real footprint so the message does not reflow.
    const ratio = att.width && att.height ? att.width / att.height : null;
    return (
      <div
        className="relative rounded-lg overflow-hidden bg-cover bg-center max-w-sm"
        style={{
          backgroundImage: att.placeholder ? `url(${att.placeholder})` : undefined,
          aspectRatio: ratio ? String(ratio) : undefined,
          maxHeight: '18rem',
          width: att.width ? Math.min(att.width, 384) : undefined
        }}
      >
        <img
          src={att.url}
          alt={att.description || att.filename}
          width={att.width || undefined}
          height={att.height || undefined}
          loading="lazy"
          onClick={() => (revealed ? onOpenImage(att.url) : setRevealed(true))}
          className={`w-full h-full max-h-72 rounded-lg object-cover border border-d-surface cursor-pointer transition-all shadow-md ${
            revealed ? 'hover:scale-[1.01]' : 'blur-2xl'
          }`}
        />
        {!revealed && (
          <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-xs font-bold text-white bg-black/40 rounded-lg pointer-events-none px-3 text-center">
            {safetyHold ? t('privacy.mediaFromStranger') : t('chat.spoiler')}
            <span className="text-[10px] font-normal opacity-80">{t('chat.clickToReveal')}</span>
          </span>
        )}
      </div>
    );
  }

  if (att.file_type === 'video' && inlineAllowed) {
    return (
      <video
        src={att.url}
        controls
        poster={att.variants?.poster?.url}
        className="max-w-md max-h-72 rounded-lg border border-d-surface bg-black"
      />
    );
  }

  if (att.file_type === 'audio' && inlineAllowed) {
    return (
      <div className="bg-d-surface p-3 rounded-lg border border-d-divider flex flex-col gap-2 max-w-sm">
        <span className="text-xs text-d-text2 font-medium truncate">{att.filename}</span>
        <audio src={att.url} controls className="w-full h-8" />
      </div>
    );
  }

  return (
    <a
      href={att.url}
      download={att.filename}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-3 bg-d-surface hover:bg-d-hover p-3 rounded-lg border border-d-divider text-d-strong text-xs transition-colors"
    >
      <FileText className="w-6 h-6 text-d-brand shrink-0" />
      <div className="flex flex-col min-w-0">
        <span className="font-medium truncate max-w-[180px]">{att.filename}</span>
        <span className="text-[10px] text-d-text3">{att.size_human ?? t('files.clickToDownload')}</span>
      </div>
      <Download className="w-4 h-4 text-d-text3 ml-auto shrink-0" />
    </a>
  );
}

/**
 * One reaction pill.
 *
 * Discord shows who reacted on hover, and the data for that already rides along
 * in `reaction_details.user_ids` — so this costs no request. The list is capped
 * because a popular reaction can carry hundreds of ids and a tooltip that fills
 * the screen is worse than one that says "and 40 others".
 */
function ReactionChip({ reaction, onToggle, nameFor }) {
  const ids = reaction.user_ids ?? [];
  const shown = ids.slice(0, 8).map(nameFor);
  const rest = ids.length - shown.length;

  const who = ids.length === 0
    ? t('chat.peopleCount', { count: reaction.count })
    : rest > 0
      ? t('chat.reactedByMore', { names: shown.join(', '), count: rest })
      : t('chat.reactedBy', { names: shown.join(', ') });

  return (
    <button
      onClick={onToggle}
      title={`${who} — ${reaction.emoji}`}
      aria-label={`${reaction.emoji} · ${who}`}
      aria-pressed={Boolean(reaction.me)}
      className={`text-xs px-2 py-0.5 rounded-md flex items-center gap-1 transition-colors border ${
        reaction.me
          ? 'bg-d-brand/20 border-d-brand text-d-mention'
          : 'bg-d-surface hover:bg-d-hover border-d-divider text-d-text'
      }`}
    >
      <span>{reaction.emoji}</span>
      <span className="font-semibold text-[11px]">{reaction.count}</span>
    </button>
  );
}
