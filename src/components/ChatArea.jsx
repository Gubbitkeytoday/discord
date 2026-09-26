import React, { useState, useRef, useEffect, useLayoutEffect, useMemo, useCallback } from 'react';
import {
  Hash, Bell, BellOff, Pin, Users, Search, PlusCircle, Smile, Send, Trash2, Reply, X,
  FileText, Download, Pencil, ArrowDown, Loader2, Check, Sticker, Inbox, UserPlus,
  MessagesSquare, Archive, AlertTriangle, RotateCcw, Megaphone, Volume2, Lock, BarChart3, ChevronRight,
  Bold, Italic, Underline, Strikethrough, Code, Code2, Quote, EyeOff, Type, Link2 as Link2Icon, Menu, Phone, Video, History,
  SmilePlus, MoreHorizontal, CheckCheck, MoreVertical, ArrowLeft
} from 'lucide-react';
import { parseDiscordMarkdown } from '../utils/markdownParser';
import { playMessageIncomingSound } from '../utils/soundEffects';
import { DEFAULT_AVATAR } from '../utils/avatar';
import {
  decorateMessages, formatDateDivider, formatTime, formatFullTimestamp, formatTypingText
} from '../utils/messageGrouping';

// Message list windowing (see `hiddenOlder` in ChatArea).
const RENDER_WINDOW = 150;
const RENDER_STEP = 100;

/** "3:42 PM" today, "Mar 3, 3:42 PM" otherwise — the unread bar's "since". */
function formatUnreadSince(date, use24Hour) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const time = formatTime(d, localeTag(), use24Hour);
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.toLocaleDateString(localeTag(), { month: 'short', day: 'numeric' })}, ${time}`;
}

import LinkEmbed from './LinkEmbed';
import { RichEmbed, MessageComponents } from './RichEmbed';
import PinnedMessagesPopover from './PinnedMessagesPopover';
import MessageContextMenu from './MessageContextMenu';
import ContextMenu from './ContextMenu';
import { useFocusTrap } from '../hooks/useFocusTrap';
import PollCard from './PollCard';
import { VoiceNotePlayer, VoiceNoteRecorder, VoiceNoteButton } from './VoiceNote';
import SuperReaction, { motionAllowed } from './SuperReaction';
import { runSlashCommand, parseSlashInput } from '../utils/slashCommands';
import { t, localeTag } from '../i18n/index.jsx';
import { convertEmoticons } from '../utils/emoticons';
import { resolveComposerTokens, humanizeTokens, mentionsUser } from '../utils/mentions';
import StillImage, { isAnimatedImage } from './StillImage';
import { lazyComponent } from '../utils/lazyComponent';

// Pickers and dialogs load on first use.
const ImageLightboxModal = lazyComponent(() => import('./ImageLightboxModal'));
const EmojiPicker = lazyComponent(() => import('./EmojiPicker'));
const StickerPicker = lazyComponent(() => import('./StickerPicker'));
const CreatePollModal = lazyComponent(() => import('./CreatePollModal'));
import { useUserSettings } from '../hooks/useUserSettings';
import ComposerAutocomplete, { detectTrigger, buildOptions } from './ComposerAutocomplete';

const FALLBACK_AVATAR = DEFAULT_AVATAR;
const QUICK_EMOJIS = ['❤️', '🔥', '👍', '😂', '🎉', '🚀', '💯', '💩', '✨'];

// How close to the bottom still counts as "following the conversation".
const AUTOSCROLL_THRESHOLD_PX = 120;

// Hold this long on a touch screen to get the message actions — phones have
// no hover and no right-click, so without it they had no way to reply or react.
const LONG_PRESS_MS = 450;

// Unsent text per channel, kept for the life of the tab like Discord's drafts:
// hopping to another channel to check something no longer eats what you typed.
const drafts = new Map();

const HEADER_ICONS = { announcement: Megaphone, voice: Volume2, forum: MessagesSquare, thread: MessagesSquare };

export default function ChatArea({
  onStartCall, callBar, onShowEditHistory, hideHeader = false,
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
  openPinsSignal = 0,
  openEmojiSignal = 0,
  toggleFormattingSignal = 0,
  onOpenMobileSidebar = null,
  onSuperReact = null,
  onSuperReactionEvent = null,
  botCommands = [],
  onRunBotCommand = null,
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
  isUnknownSender,
  isLoadingMessages = false,
  onClearReadMarker
}) {
  const [inputText, setInputText] = useState('');
  const [attachments, setAttachments] = useState([]);
  const [replyToMsg, setReplyToMsg] = useState(null);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [showStickerPicker, setShowStickerPicker] = useState(false);
  const [showPollComposer, setShowPollComposer] = useState(false);
  // messageId -> emoji currently bursting over that message.
  const [superBursts, setSuperBursts] = useState({});
  const [recordingNote, setRecordingNote] = useState(false);
  const [showFormatting, setShowFormatting] = useState(false);

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
  // Phones: the header has no room for the search box, the bell or the
  // inbox, so search opens a full-screen sheet and the rest live in "More".
  const [showMobileSearch, setShowMobileSearch] = useState(false);
  const [headerMenu, setHeaderMenu] = useState(null);
  const [trigger, setTrigger] = useState(null);
  const [acIndex, setAcIndex] = useState(0);
  const [isDragging, setIsDragging] = useState(false);
  const [revealedBlocked, setRevealedBlocked] = useState(() => new Set());
  // The message the emoji picker is reacting to. Null means the picker is
  // writing into the composer; set, it toggles a reaction on that message.
  const [reactTarget, setReactTarget] = useState(null);
  // Touch: which row a long-press opened the action bar on.
  const [touchActionsId, setTouchActionsId] = useState(null);
  const longPressRef = useRef(null);
  const lastPointerRef = useRef('mouse');

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

  // Discord's "N new messages since 3:42 PM — Mark as read" bar. Counted from
  // what is loaded; when the first unread is the oldest loaded message and
  // there is more history, the count is a lower bound ("50+").
  const unreadSummary = useMemo(() => {
    const index = decorated.findIndex((m) => m.isFirstUnread);
    if (index === -1) return null;
    const count = decorated.slice(index).filter((m) => m.user_id !== currentUser?.id && !m.pending).length;
    if (count === 0) return null;
    return { id: decorated[index].id, count, more: index === 0 && hasMoreHistory, since: decorated[index].created_at };
  }, [decorated, hasMoreHistory, currentUser?.id]);
  const [unreadBarDismissed, setUnreadBarDismissed] = useState(false);

  // Windowing: a long-lived channel (or a long read back through history)
  // must not keep thousands of rows in the DOM. The oldest `hiddenOlder`
  // loaded messages are not rendered; scrolling to the top reveals them a
  // page at a time before any network fetch, and returning to the bottom
  // trims the window back down.
  const [hiddenOlder, setHiddenOlder] = useState(0);
  const hidden = Math.min(hiddenOlder, Math.max(0, decorated.length - 1));
  const visibleMessages = useMemo(() => {
    if (!hidden) return decorated;
    const rest = decorated.slice(hidden);
    // The first rendered row always shows its author.
    return rest.length && rest[0].isGrouped ? [{ ...rest[0], isGrouped: false }, ...rest.slice(1)] : rest;
  }, [decorated, hidden]);
  // On opening a channel, land on the first unread message instead of the
  // bottom, once its history has arrived.
  const unreadScrollPendingRef = useRef(true);

  // What `@name`, `#channel` and `:emoji:` resolve against when sending.
  const tokenContext = useMemo(() => ({
    members,
    channels,
    customEmojis: [...customEmojis, ...externalEmojiGroups.flatMap((g) => g.emojis ?? [])]
  }), [members, channels, customEmojis, externalEmojiGroups]);
  const toWire = (text) => resolveComposerTokens(
    chatPrefs.convertEmoticons ? convertEmoticons(text) : text, tokenContext
  );

  // My role ids, for highlighting role mentions of me.
  const myRoleIds = useMemo(() => {
    const me = members.find((m) => m.id === currentUser?.id);
    return (me?.roles ?? []).map((r) => (typeof r === 'object' ? r.id : r));
  }, [members, currentUser?.id]);

  const autocompleteOptions = useMemo(
    () => buildOptions(trigger, { members, channels, customEmojis, botCommands }),
    [trigger, members, channels, customEmojis, botCommands]
  );

  // Click handlers arrive as fresh closures on every parent render; reading
  // them through refs keeps the Markdown context (and its cache) stable.
  const onSelectUserRef = useRef(onSelectUser);
  onSelectUserRef.current = onSelectUser;
  const onSelectChannelRef = useRef(onSelectChannel);
  onSelectChannelRef.current = onSelectChannel;

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
    onMentionClick: (id) => onSelectUserRef.current?.(id),
    onChannelClick: (id) => onSelectChannelRef.current?.(id)
  }), [members, channels, customEmojis, externalEmojiGroups]);

  // Parsing Markdown is the most expensive thing a row does, and the composer
  // re-renders this whole component on every keystroke — so a 50-message page
  // was re-parsed 50 times per character typed. Rendered bodies are cached by
  // message id and content; the cache is dropped whenever what mentions and
  // emoji resolve against changes, or the channel does.
  const markdownCacheRef = useRef({ context: null, channelId: null, map: new Map() });
  if (markdownCacheRef.current.context !== markdownContext || markdownCacheRef.current.channelId !== channel?.id) {
    markdownCacheRef.current = { context: markdownContext, channelId: channel?.id, map: new Map() };
  }
  const renderMarkdown = (msg) => {
    const { map } = markdownCacheRef.current;
    let entry = map.get(msg.id);
    if (!entry || entry.content !== msg.content) {
      entry = { content: msg.content, node: parseDiscordMarkdown(msg.content, markdownContext) };
      map.set(msg.id, entry);
    }
    return entry.node;
  };

  const trackScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setIsAtBottom(distanceFromBottom < AUTOSCROLL_THRESHOLD_PX);

    if (el.scrollTop < 80 && hiddenOlder > 0) {
      prependAnchorRef.current = el.scrollHeight;
      setHiddenOlder((n) => Math.max(0, n - RENDER_STEP));
      return;
    }
    if (el.scrollTop < 80 && hasMoreHistory && !isLoadingHistory && onLoadMore) {
      prependAnchorRef.current = el.scrollHeight;
      onLoadMore();
    }
  }, [hasMoreHistory, isLoadingHistory, onLoadMore, hiddenOlder]);

  // Back at the bottom with a big DOM: trim the window (hysteresis of one
  // step, so it does not trim and reveal on every new message).
  useEffect(() => {
    if (!isAtBottom) return;
    const rendered = decorated.length - hiddenOlder;
    if (rendered > RENDER_WINDOW + RENDER_STEP) setHiddenOlder(decorated.length - RENDER_WINDOW);
  }, [isAtBottom, decorated.length, hiddenOlder]);

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
    if (unreadScrollPendingRef.current && decorated.length > 0 && !isLoadingMessages) {
      unreadScrollPendingRef.current = false;
      const divider = el.querySelector('[data-first-unread]');
      if (divider) {
        const top = divider.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
        // Only when the divider would otherwise be above the fold.
        if (top < el.scrollHeight - el.clientHeight) {
          el.scrollTop = Math.max(0, top - 56);
          setIsAtBottom(false);
          return;
        }
      }
    }
    if (isAtBottom) el.scrollTop = el.scrollHeight;
  }, [decorated, isAtBottom, isLoadingMessages, hidden]);

  // Keep the latest text in a ref so the channel-switch cleanup below can
  // stash the draft of the channel being left.
  const inputTextRef = useRef(inputText);
  inputTextRef.current = inputText;

  useEffect(() => {
    const channelId = channel?.id;
    setIsAtBottom(true);
    setReplyToMsg(null);
    setEditingId(null);
    setInputText(channelId ? drafts.get(channelId) ?? '' : '');
    setAttachments([]);
    setShowPins(false);
    setReactTarget(null);
    setTouchActionsId(null);
    setUnreadBarDismissed(false);
    setHiddenOlder(0);
    unreadScrollPendingRef.current = true;
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    return () => {
      if (!channelId) return;
      const draft = inputTextRef.current;
      if (draft.trim()) drafts.set(channelId, draft);
      else drafts.delete(channelId);
    };
  }, [channel?.id]);

  // Hooks must run on every render, so anything hook-shaped lives above the
  // "no channel selected" early return below.
  const showBurst = useCallback((messageId, emoji) => {
    if (!motionAllowed()) return;
    setSuperBursts((current) => ({ ...current, [messageId]: emoji }));
  }, []);

  // Someone else's super reaction arrives over the socket.
  useEffect(() => {
    if (!onSuperReactionEvent) return undefined;
    return onSuperReactionEvent(({ messageId, emoji }) => showBurst(messageId, emoji));
  }, [onSuperReactionEvent, showBurst]);

  // /pins asks the composer's popover to open; a changing number is enough of
  // a signal and avoids threading an imperative handle through the tree.
  useEffect(() => {
    if (openPinsSignal) setShowPins(true);
  }, [openPinsSignal]);

  useEffect(() => {
    if (openEmojiSignal) setShowEmojiPicker((v) => !v);
  }, [openEmojiSignal]);

  useEffect(() => {
    if (toggleFormattingSignal) setShowFormatting((v) => !v);
  }, [toggleFormattingSignal]);

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
    inputTextRef.current = '';
    if (channel?.id) drafts.delete(channel.id);
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
        // Not a built-in — a bot in this channel may still own it. Its options
        // are taken positionally from what follows the name, in the order the
        // bot declared them, which is what people type anyway.
        const bot = botCommands.find((c) => c.name === command.name);
        if (bot) {
          const parsed = parseSlashInput(inputText.trim());
          const words = (parsed?.rest ?? '').split(/\s+/).filter(Boolean);
          const options = {};
          bot.options.forEach((option, index) => {
            const isLast = index === bot.options.length - 1;
            const value = isLast ? words.slice(index).join(' ') : words[index];
            if (value !== undefined && value !== '') options[option.name] = value;
          });
          clearComposer();
          onRunBotCommand?.(bot, options);
          return;
        }
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
      // /tts only speaks when Accessibility › Text-to-speech allows it;
      // otherwise it is sent as an ordinary message, as Discord does.
      onSendMessage(resolveComposerTokens(command.content, tokenContext), attachments, replyToMsg?.id, { tts: Boolean(command.tts && a11yPrefs.ttsEnabled) });
      playMessageIncomingSound();
      clearComposer();
      return;
    }

    onSendMessage(toWire(inputText), attachments, replyToMsg?.id);
    playMessageIncomingSound();
    clearComposer();
  };

  /**
   * React, and on shift-click also fire a Super Reaction: the burst is a local
   * flourish, so it is broadcast as a lightweight event rather than stored —
   * a reaction is data, an animation is not.
   */
  const superReact = (msg, emoji, isSuper) => {
    onToggleReaction(msg.id, emoji);
    if (!isSuper) return;
    onSuperReact?.(msg.id, emoji);
    showBurst(msg.id, emoji);
  };

  /**
   * The formatting toolbar. Discord shipped a WYSIWYG-ish bar in Aug 2026: it
   * still writes Markdown, it just spares you remembering the characters.
   * Wrapping the selection (or, with nothing selected, inserting the markers
   * and placing the caret between them) is the whole behaviour.
   */
  const applyFormat = (before, after = before) => {
    const el = textareaRef.current;
    if (!el) return;
    const start = el.selectionStart ?? inputText.length;
    const end = el.selectionEnd ?? start;
    const selected = inputText.slice(start, end);

    // Toggling: if the selection is already wrapped, unwrap it instead of
    // nesting a second pair of markers.
    const alreadyWrapped = inputText.slice(Math.max(0, start - before.length), start) === before
      && inputText.slice(end, end + after.length) === after;

    let next; let caretStart; let caretEnd;
    if (alreadyWrapped) {
      next = inputText.slice(0, start - before.length) + selected + inputText.slice(end + after.length);
      caretStart = start - before.length;
      caretEnd = caretStart + selected.length;
    } else {
      next = inputText.slice(0, start) + before + selected + after + inputText.slice(end);
      caretStart = start + before.length;
      caretEnd = caretStart + selected.length;
    }
    setInputText(next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caretStart, caretEnd);
    });
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
    setEditText(humanizeTokens(msg.content ?? '', { members, channels }));
  };

  /** Scroll a message into view and flash it, like Discord's jump. */
  const jumpToMessage = (messageId, retried = false) => {
    const node = document.getElementById(`message-${messageId}`);
    if (!node) {
      // Loaded but outside the render window: widen it, then try again.
      const index = decorated.findIndex((m) => String(m.id) === String(messageId));
      if (index !== -1 && index < hidden && !retried) {
        setHiddenOlder(Math.max(0, index - 10));
        setTimeout(() => jumpToMessage(messageId, true), 60);
      }
      return;
    }
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    node.classList.remove('message-flash');
    void node.offsetWidth; // restart the animation on a repeat jump
    node.classList.add('message-flash');
    setTimeout(() => node.classList.remove('message-flash'), 1700);
  };

  const focusComposer = () => requestAnimationFrame(() => textareaRef.current?.focus());

  /** Reply, and put the caret in the composer — replying is about typing. */
  const startReply = (msg) => {
    setReplyToMsg(msg);
    setTouchActionsId(null);
    focusComposer();
  };

  /** Delete, confirming unless Shift is held (Discord's bypass). */
  const requestDelete = (msg, event) => {
    setTouchActionsId(null);
    onDeleteMessage?.(msg.id, { skipConfirm: Boolean(event?.shiftKey) });
  };

  /** Open the full message menu from the "More" button, under the button. */
  const openMenuFrom = (msg, event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setTouchActionsId(null);
    setContextMenu({ message: msg, x: rect.left, y: rect.bottom + 4 });
  };

  const openReactionPicker = (msg) => {
    setTouchActionsId(null);
    setShowStickerPicker(false);
    setReactTarget(msg);
    setShowEmojiPicker(true);
  };

  const cancelLongPress = () => {
    clearTimeout(longPressRef.current);
    longPressRef.current = null;
  };

  const stopEditing = () => {
    setEditingId(null);
    setEditText('');
    focusComposer();
  };

  const submitEdit = (e) => {
    e.preventDefault();
    // Saving an empty edit is how Discord offers to delete the message.
    if (!editText.trim()) {
      const id = editingId;
      stopEditing();
      onDeleteMessage?.(id);
      return;
    }
    const original = messages.find((m) => m.id === editingId);
    const content = resolveComposerTokens(editText, tokenContext);
    if (original?.content !== content) onEditMessage?.(editingId, content);
    stopEditing();
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

      {/* Channel header — suppressed when this chat is the lower half of a
          voice channel, because the voice room above already names the channel
          and carries the same controls. */}
      {!hideHeader && (
      <div className="h-12 px-4 shadow-sm border-b border-d-edge flex items-center justify-between shrink-0 bg-d-canvas z-10">
        <div className="flex items-center gap-2 min-w-0">
          {/* Phones have no room for a permanent channel column, so the header
              carries the handle that opens it. */}
          {onOpenMobileSidebar && (
            <button
              type="button"
              onClick={onOpenMobileSidebar}
              className="md:hidden text-d-text2 hover:text-d-strong shrink-0"
              aria-label={t('sidebar.openChannels')}
            >
              <Menu className="w-5 h-5" />
            </button>
          )}
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
          {Boolean(channel.is_private) && <Lock className="w-3.5 h-3.5 text-d-text4 shrink-0" />}
          {isArchived && (
            <span className="text-[10px] bg-d-surface text-d-text3 px-1.5 py-0.5 rounded shrink-0">
              {t('chat.archived')}
            </span>
          )}
          {Boolean(channel.topic) && (
            <>
              <div className="w-[1px] h-4 bg-d-divider mx-2 hidden sm:block" />
              <span className="text-xs text-d-text3 truncate hidden sm:block" title={channel.topic}>{channel.topic}</span>
            </>
          )}
        </div>

        <div className="flex items-center gap-3 max-sm:gap-2.5 text-d-text2 shrink-0">
          {onStartCall && (
            <>
              <button
                type="button"
                onClick={() => onStartCall(false)}
                className="hover:text-d-strong transition-colors"
                title={t('call.start')}
                aria-label={t('call.start')}
              >
                <Phone className="w-5 h-5" />
              </button>
              <button
                type="button"
                onClick={() => onStartCall(true)}
                className="hover:text-d-strong transition-colors"
                title={t('call.startVideo')}
                aria-label={t('call.startVideo')}
              >
                <Video className="w-5 h-5" />
              </button>
            </>
          )}
          {channel.type === 'announcement' && onFollowChannel && (
            <button
              type="button"
              onClick={() => onFollowChannel(channel)}
              className="inline-flex items-center gap-1.5 text-xs font-semibold bg-d-surface hover:bg-d-surface/70 text-d-strong px-2.5 py-1 rounded-md"
              title={t('chat.followChannelHint')}
              aria-label={t('chat.followChannel')}
            >
              <Megaphone className="w-3.5 h-3.5" aria-hidden="true" /><span className="max-sm:hidden">{t('chat.followChannel')}</span>
            </button>
          )}
          {onArchiveThread && (
            <button
              onClick={() => onArchiveThread(!isArchived)}
              className="hover:text-d-strong transition-colors"
              title={isArchived ? t('chat.unarchiveThread') : t('chat.archiveThread')}
              aria-label={isArchived ? t('chat.unarchiveThread') : t('chat.archiveThread')}
            >
              <Archive className="w-5 h-5" />
            </button>
          )}

          {onAddGroupRecipients && (
            <button onClick={onAddGroupRecipients} className="hover:text-d-strong transition-colors" title={t('dm.addToGroup')} aria-label={t('dm.addToGroup')}>
              <UserPlus className="w-5 h-5" />
            </button>
          )}

          <button
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              onOpenNotificationSettings?.(rect.left - 120, rect.bottom + 6);
            }}
            className={`hover:text-d-strong transition-colors max-sm:hidden ${muted ? 'text-d-danger' : ''}`}
            title={t('notif.notificationSettings')}
            aria-label={t('notif.notificationSettings')}
          >
            {muted ? <BellOff className="w-5 h-5" /> : <Bell className="w-5 h-5" />}
          </button>

          <button
            onClick={() => setShowPins((v) => !v)}
            className={`hover:text-d-strong transition-colors relative ${showPins ? 'text-d-strong' : ''}`}
            title={t('chat.pinnedMessages')}
            aria-label={t('chat.pinnedMessages')}
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
              aria-label={t('chat.memberList')}
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
              className="hover:text-d-strong transition-colors relative max-sm:hidden"
              title={t('notif.inbox')}
              aria-label={t('notif.inbox')}
            >
              <Inbox className="w-5 h-5" />
              {inboxCount > 0 && (
                <span className="absolute -top-1 -right-1 bg-d-danger text-white text-[9px] font-bold min-w-[14px] h-3.5 px-0.5 rounded-full flex items-center justify-center">
                  {inboxCount > 9 ? '9+' : inboxCount}
                </span>
              )}
            </button>
          )}

          <button
            type="button"
            onClick={() => setShowMobileSearch(true)}
            className="md:hidden hover:text-d-strong transition-colors"
            title={t('chat.searchMessages')}
            aria-label={t('chat.searchMessages')}
          >
            <Search className="w-5 h-5" />
          </button>

          <button
            type="button"
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              setHeaderMenu({ x: rect.right - 200, y: rect.bottom + 6 });
            }}
            className="sm:hidden hover:text-d-strong transition-colors relative"
            title={t('chat.moreOptions')}
            aria-label={t('chat.moreOptions')}
            aria-haspopup="menu"
          >
            <MoreVertical className="w-5 h-5" />
            {inboxCount > 0 && <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-d-danger" aria-hidden="true" />}
          </button>

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
            <button type="submit" className="absolute right-2 top-1.5" title={t('chat.searchMessages')} aria-label={t('chat.searchMessages')}>
              <Search className="w-3.5 h-3.5 text-d-text4 hover:text-d-strong" />
            </button>
          </form>
        </div>
      </div>
      )}

      {/* A live call sits between the header and the history — visible while
          reading, and out of the way of the composer. */}
      {callBar}

      {/* Messages */}
      <div
        ref={scrollRef}
        onScroll={trackScroll}
        onPointerDown={(e) => { lastPointerRef.current = e.pointerType; }}
        onClick={(e) => {
          if (e.target.closest('.message-actions')) return;
          // On touch, a plain tap on a message toggles its action bar (phones
          // have no hover); a tap anywhere else puts it away.
          const row = lastPointerRef.current === 'touch' ? e.target.closest('.message-row[data-msg-id]') : null;
          const interactive = e.target.closest('a, button, textarea, input, video, audio, img, [role="button"]');
          if (row && !interactive && !window.getSelection?.()?.toString()) {
            const id = row.getAttribute('data-msg-id');
            const hit = messages.find((m) => String(m.id) === id);
            setTouchActionsId((current) => (String(current) === id ? null : hit?.id ?? null));
            return;
          }
          if (touchActionsId) setTouchActionsId(null);
        }}
        className="flex-1 overflow-y-auto px-4 max-sm:px-3 select-text"
        aria-busy={isLoadingMessages || isLoadingHistory}
      >
        {unreadSummary && !unreadBarDismissed && (
          // Zero-height sticky host: the bar floats over the history without
          // pushing it down.
          <div className="sticky top-0 z-10 h-0 -mx-4 max-sm:-mx-3">
            <div
              role="status"
              className="flex items-center bg-d-brand text-white text-xs font-semibold rounded-b-lg shadow-md mx-2"
            >
              <button
                type="button"
                onClick={() => jumpToMessage(unreadSummary.id)}
                className="flex-1 min-w-0 text-left px-3 py-1.5 truncate hover:underline"
              >
                {t('chat.unreadSince', {
                  count: unreadSummary.more ? `${unreadSummary.count}+` : unreadSummary.count,
                  time: formatUnreadSince(unreadSummary.since, chatPrefs.use24HourClock)
                })}
              </button>
              <button
                type="button"
                onClick={() => {
                  setUnreadBarDismissed(true);
                  onClearReadMarker?.();
                }}
                className="shrink-0 flex items-center gap-1 px-3 py-1.5 hover:bg-white/10 rounded-br-lg"
              >
                {t('chat.markAsRead')} <CheckCheck className="w-3.5 h-3.5" aria-hidden="true" />
              </button>
            </div>
          </div>
        )}
        {/* Like Discord, a short conversation sits on the composer rather than
            floating at the top of an empty pane. */}
        <div className="min-h-full flex flex-col">
        <div className="flex-1" aria-hidden="true" />
        <div>
        {isLoadingHistory && (
          <div className="flex justify-center py-3 text-d-text3">
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
        )}

        {isLoadingMessages && decorated.length === 0 && (
          <div role="status" aria-label={t('chat.loadingMessages')} className="py-4 space-y-5">
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

        {!hasMoreHistory && !isLoadingMessages && (
          <div className="my-6">
            {isDM ? (
              // A conversation opens on the person, not on a channel glyph.
              <img src={channel.avatar_url || FALLBACK_AVATAR} alt="" className="w-20 h-20 rounded-full object-cover mb-3" />
            ) : (
              <div className="w-16 h-16 rounded-full bg-d-active flex items-center justify-center mb-3">
                <HeaderIcon className="w-10 h-10 text-d-strong" />
              </div>
            )}
            <h2 className="text-3xl max-sm:text-2xl font-extrabold text-d-strong mb-1 break-words">
              {isDM ? t('chat.welcomeToDm', { name: title }) : t('chat.welcomeToChannel', { channel: title })}
            </h2>
            <p className="text-sm text-d-text3">
              {isDM ? t('chat.dmStart', { name: title }) : t('chat.channelStart', { channel: title })}
            </p>
            <div className="w-full h-[1px] bg-d-divider mt-4" />
          </div>
        )}

        {visibleMessages.map((msg) => {
          const renderDividers = (m) => (
            <>
              {Boolean(m.dateDivider) && (
                <div className="flex items-center gap-2 my-4" role="separator">
                  <div className="flex-1 h-[1px] bg-d-divider" />
                  <span className="text-[11px] font-semibold text-d-text3 px-1">
                    {formatDateDivider(m.dateDivider)}
                  </span>
                  <div className="flex-1 h-[1px] bg-d-divider" />
                </div>
              )}

              {Boolean(m.isFirstUnread) && (
                <div data-first-unread="true" className="flex items-center gap-2 my-2">
                  <div className="flex-1 h-[1px] bg-d-danger" />
                  <span className="text-[10px] font-bold text-d-danger bg-d-danger/10 px-2 py-0.5 rounded">
                    {t('chat.newMessages')}
                  </span>
                </div>
              )}
            </>
          );
          const isOwn = msg.user_id === currentUser?.id;
          // Discord's gold row for a message that pings you.
          const mentionsMe = !msg.pending && mentionsUser(msg, currentUser, {
            roleIds: myRoleIds, repliedToUserId: msg.replyToMsg?.user_id ?? null
          });
          const isBlockedAuthor = blockedIds?.has(msg.user_id) && !isOwn;
          const revealed = revealedBlocked.has(msg.id);
          const reactionList = msg.reaction_details?.length
            ? msg.reaction_details
            : Object.entries(msg.reactions ?? {}).map(([emoji, count]) => ({ emoji, count, me: false }));

          // Thread created / pin / join: a compact system line, not a message
          // signed by whoever triggered it.
          if (SYSTEM_TYPES.has(msg.type)) {
            return (
              <React.Fragment key={msg.id}>
                {renderDividers(msg)}
                <SystemMessage
                  msg={msg}
                  use24Hour={chatPrefs.use24HourClock}
                  onOpenThread={(id) => onSelectChannel?.(id)}
                  onOpenPins={() => setShowPins(true)}
                  onSelectUser={(id) => onSelectUser?.(id)}
                />
              </React.Fragment>
            );
          }

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
              {renderDividers(msg)}

              <div
                id={`message-${msg.id}`}
                data-msg-id={msg.pending || msg.failed ? undefined : msg.id}
                data-actions-open={touchActionsId === msg.id ? 'true' : undefined}
                onTouchStart={(e) => {
                  if (msg.pending || e.touches.length !== 1) return;
                  if (e.target.closest('a, button, textarea, input, video, audio')) return;
                  cancelLongPress();
                  longPressRef.current = setTimeout(() => {
                    longPressRef.current = null;
                    setTouchActionsId(msg.id);
                  }, LONG_PRESS_MS);
                }}
                onTouchMove={cancelLongPress}
                onTouchEnd={cancelLongPress}
                onTouchCancel={cancelLongPress}
                onContextMenu={(e) => {
                  if (e.target.closest('a, img, video, audio, textarea')) return;
                  e.preventDefault();
                  cancelLongPress();
                  setTouchActionsId(null);
                  setContextMenu({ message: msg, x: e.clientX, y: e.clientY });
                }}
                onDoubleClick={(e) => {
                  // Tap to React. Ignored on anything you might legitimately be
                  // double-clicking for another reason, and on a message that
                  // has not been accepted by the server yet.
                  const emoji = chatPrefs?.tapToReactEmoji;
                  if (!emoji || msg.pending || msg.failed) return;
                  if (e.target.closest('a, img, video, audio, textarea, input, button')) return;
                  // A double-click that was really a text selection is not a tap.
                  if (window.getSelection?.()?.toString()) return;
                  onToggleReaction?.(msg.id, emoji);
                }}
                className={`message-row group flex gap-4 max-sm:gap-3 px-2 -mx-2 rounded hover:bg-d-rowhover transition-colors relative ${
                  msg.isGrouped ? 'py-[1px]' : 'py-[var(--message-padding-y)] message-group-start'
                } ${msg.pending ? 'opacity-50' : ''} ${msg.failed ? 'opacity-70' : ''} ${msg.isFirstUnread && !mentionsMe ? 'bg-d-danger/[0.04]' : ''} ${mentionsMe ? 'mention-row' : ''} ${touchActionsId === msg.id ? 'bg-d-rowhover' : ''}`}
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
                  {Boolean(msg.reply_to_id) && (
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
                      {Boolean(msg.is_bot) && (
                        <span className="bg-d-brand text-white text-[10px] font-bold px-1.5 rounded">BOT</span>
                      )}
                      {Boolean(msg.ephemeral) && (
                        <span className="text-[9px] uppercase tracking-wide bg-d-surface text-d-text3 px-1 rounded shrink-0" title={t('bot.ephemeralHint')}>
                          {t('bot.ephemeral')}
                        </span>
                      )}
                      {Boolean(msg.crossposted) && (
                        <span className="text-[9px] uppercase tracking-wide bg-d-surface text-d-text3 px-1 rounded shrink-0" title={t('chat.publishedHint')}>
                          {t('chat.published')}
                        </span>
                      )}
                      {Boolean(msg.webhook_id) && !msg.is_bot && (
                        <span className="bg-d-surface text-d-text3 text-[10px] font-bold px-1.5 rounded">
                          {t('webhooks.badge')}
                        </span>
                      )}
                      {Boolean(chatPrefs.showTimestamps) && (
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
                          if (e.key === 'Escape') { e.preventDefault(); stopEditing(); }
                        }}
                        rows={Math.min(8, editText.split('\n').length)}
                        autoFocus
                        className="w-full bg-d-input text-d-strong text-sm rounded px-3 py-2 resize-none focus:outline-none"
                      />
                      <div className="flex items-center gap-2 mt-1 text-[11px] text-d-text3">
                        <button type="button" onClick={stopEditing} className="hover:underline">
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
                        {renderMarkdown(msg)}
                        {Boolean(msg.edited_at) && (onShowEditHistory ? (
                          // The "(edited)" marker is the natural place to ask
                          // "edited from what?", so it is the button.
                          <button
                            type="button"
                            onClick={() => onShowEditHistory(msg)}
                            className="text-[10px] text-d-text3 hover:text-d-strong hover:underline ml-1 align-baseline"
                            title={t('chat.editedHistory')}
                          >
                            {t('chat.edited')}
                          </button>
                        ) : (
                          <span className="text-[10px] text-d-text3 ml-1 align-baseline" title={formatFullTimestamp(msg.edited_at)}>
                            {t('chat.edited')}
                          </span>
                        ))}
                      </div>
                    ) : null
                  )}

                  {Boolean(msg.poll) && (
                    <PollCard
                      poll={msg.poll}
                      currentUserId={currentUser?.id}
                      canManage={msg.user_id === currentUser?.id
                        || viewerPermissions.includes('MANAGE_MESSAGES')
                        || viewerPermissions.includes('ADMINISTRATOR')}
                      onToast={onToast}
                    />
                  )}

                  {Boolean(msg.sticker) && (
                    // Sticker animation: always, on hover ("interaction"), or
                    // never — frozen on the first frame.
                    <StillImage
                      src={msg.sticker.url}
                      animate={a11yPrefs.stickerAnimation === 'always'
                        || msg.sticker.format === 'png'}
                      playOnHover={a11yPrefs.stickerAnimation === 'interaction'}
                      alt={msg.sticker.name}
                      title={msg.sticker.name}
                      className="mt-1 w-40 h-40 object-contain"
                      loading="lazy"
                    />
                  )}

                  {Boolean(chatPrefs.showEmbeds) && msg.embeds?.length > 0 && (
                    <div className="space-y-1">
                      {msg.embeds.map((embed, i) => (
                        // A bot's rich embed is authored data; a link preview
                        // is something we unfurled. They render differently and
                        // only the preview obeys the link-preview preference.
                        embed.type === 'rich'
                          ? <RichEmbed key={i} embed={embed} />
                          : chatPrefs.showLinkPreviews
                            ? <LinkEmbed key={i} embed={embed} onOpenImage={setLightboxImg} autoplayGifs={a11yPrefs.autoplayGifs} />
                            : null
                      ))}
                    </div>
                  )}

                  {msg.components?.length > 0 && (
                    <MessageComponents message={msg} onToast={onToast} />
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
                          autoplayGifs={a11yPrefs.autoplayGifs}
                        />
                        )
                      ))}
                    </div>
                  )}

                  {Boolean(msg.failed) && (
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

                {superBursts[msg.id] && (
                  <SuperReaction
                    emoji={superBursts[msg.id]}
                    onDone={() => setSuperBursts((current) => {
                      const next = { ...current };
                      delete next[msg.id];
                      return next;
                    })}
                  />
                )}

                {/* Action bar: hover, keyboard focus, or a long-press on touch.
                    Mirrors Discord's order — quick reactions, add reaction,
                    reply, edit, then "More" for the full menu. */}
                {!msg.pending && !msg.failed && editingId !== msg.id && (
                  <div
                    role="toolbar"
                    aria-label={t('chat.moreActions')}
                    className="message-actions absolute right-4 max-sm:right-2 -top-3.5 hidden group-hover:flex items-center bg-d-canvas border border-d-surface rounded-md shadow-lg p-0.5 gap-0.5 z-10"
                  >
                    {QUICK_EMOJIS.slice(0, 3).map((emoji) => (
                      <button
                        key={emoji}
                        type="button"
                        // Shift-click is Discord's "super" gesture: the same
                        // reaction, plus a burst everyone in the channel sees.
                        onClick={(e) => { superReact(msg, emoji, e.shiftKey); setTouchActionsId(null); }}
                        className="p-1 hover:bg-d-hover rounded text-sm leading-none transition-colors"
                        title={`${t('chat.reactWith', { emoji })} — ${t('chat.superHint')}`}
                        aria-label={t('chat.reactWith', { emoji })}
                      >
                        {emoji}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={() => openReactionPicker(msg)}
                      className="p-1 hover:bg-d-hover text-d-text2 hover:text-d-strong rounded transition-colors"
                      title={t('chat.addReaction')}
                      aria-label={t('chat.addReaction')}
                    >
                      <SmilePlus className="w-4 h-4" />
                    </button>
                    {canSend && !isArchived && (
                      <button
                        type="button"
                        onClick={() => startReply(msg)}
                        className="p-1 hover:bg-d-hover text-d-text2 hover:text-d-strong rounded transition-colors"
                        title={t('chat.reply')}
                        aria-label={t('chat.reply')}
                      >
                        <Reply className="w-4 h-4" />
                      </button>
                    )}
                    {isOwn && (
                      <button
                        type="button"
                        onClick={() => { setTouchActionsId(null); startEditing(msg); }}
                        className="p-1 hover:bg-d-hover text-d-text2 hover:text-d-strong rounded transition-colors"
                        title={t('chat.editMessage')}
                        aria-label={t('chat.editMessage')}
                      >
                        <Pencil className="w-4 h-4" />
                      </button>
                    )}
                    {(isOwn || canManageMessages) && (
                      <button
                        type="button"
                        onClick={(e) => requestDelete(msg, e)}
                        className="p-1 hover:bg-d-danger/20 text-d-danger rounded transition-colors"
                        title={t('chat.deleteMessage')}
                        aria-label={t('chat.deleteMessage')}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={(e) => openMenuFrom(msg, e)}
                      aria-haspopup="menu"
                      className="p-1 hover:bg-d-hover text-d-text2 hover:text-d-strong rounded transition-colors"
                      title={t('chat.moreActions')}
                      aria-label={t('chat.moreActions')}
                    >
                      <MoreHorizontal className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>
            </React.Fragment>
          );
        })}
        <div className="h-4" />
        </div>
        </div>
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
      <div className="px-4 max-sm:px-2 pb-6 max-sm:pb-2 pt-1 shrink-0 relative">
        {replyToMsg && (
          <div className="mb-2 px-3 py-1.5 bg-d-surface rounded-t-lg border-x border-t border-d-divider flex items-center justify-between text-xs text-d-text2">
            <div className="flex items-center gap-2 truncate">
              <Reply className="w-3.5 h-3.5 text-d-brand" />
              <span>{t('chat.replyingTo', { name: replyToMsg.display_name })}</span>
            </div>
            <button onClick={() => { setReplyToMsg(null); focusComposer(); }} className="hover:text-d-strong" title={t('common.cancel')} aria-label={t('common.cancel')}>
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

        {showEmojiPicker && !reactTarget && (
          <div className="absolute bottom-20 right-4 z-40">
            <EmojiPicker
              customEmojis={customEmojis}
              externalGroups={externalEmojiGroups.filter((g) => g.server_id !== channel?.server_id)}
              onClose={() => setShowEmojiPicker(false)}
              onPick={(entry) => {
                setShowEmojiPicker(false);
                setInputText((prev) => prev + (entry.custom ? `:${entry.name}: ` : entry.char));
                focusComposer();
              }}
            />
          </div>
        )}

        {showEmojiPicker && reactTarget && (
          // "Add reaction" opens beside the message it reacts to, as in
          // Discord — not down by the composer, far from what you clicked.
          <AnchoredPopover
            anchorId={`message-${reactTarget.id}`}
            onClose={() => { setShowEmojiPicker(false); setReactTarget(null); }}
          >
            <EmojiPicker
              customEmojis={customEmojis}
              externalGroups={externalEmojiGroups.filter((g) => g.server_id !== channel?.server_id)}
              onClose={() => { setShowEmojiPicker(false); setReactTarget(null); }}
              onPick={(entry) => {
                setShowEmojiPicker(false);
                onToggleReaction(reactTarget.id, entry.char ?? `:${entry.name}:`);
                setReactTarget(null);
              }}
            />
          </AnchoredPopover>
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
          className={`bg-d-input rounded-lg px-4 max-sm:px-3 py-2.5 ${!canSend || isArchived ? 'opacity-60' : ''}`}
        >
          {showFormatting && !recordingNote && (
            <div className="flex items-center gap-0.5 pb-1.5 mb-1.5 border-b border-d-divider" role="toolbar" aria-label={t('chat.formatting')}>
              {[
                { key: 'bold', markers: ['**'], icon: Bold, label: t('chat.bold') },
                { key: 'italic', markers: ['*'], icon: Italic, label: t('chat.italic') },
                { key: 'underline', markers: ['__'], icon: Underline, label: t('chat.underline') },
                { key: 'strike', markers: ['~~'], icon: Strikethrough, label: t('chat.strikethrough') },
                { key: 'code', markers: ['`'], icon: Code, label: t('chat.inlineCode') },
                { key: 'block', markers: ['```\n', '\n```'], icon: Code2, label: t('chat.codeBlock') },
                { key: 'quote', markers: ['> ', ''], icon: Quote, label: t('chat.quote') },
                { key: 'spoiler', markers: ['||'], icon: EyeOff, label: t('chat.spoiler') },
                { key: 'link', markers: ['[', '](url)'], icon: Link2Icon, label: t('chat.link') }
              ].map(({ key, markers, icon: Icon, label }) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => applyFormat(markers[0], markers[1] ?? markers[0])}
                  disabled={!canSend || isArchived}
                  className="p-1.5 rounded text-d-text2 hover:text-d-strong hover:bg-d-hover disabled:opacity-40"
                  title={label}
                  aria-label={label}
                >
                  <Icon className="w-4 h-4" />
                </button>
              ))}
            </div>
          )}

          <div className="flex items-end gap-3 max-sm:gap-2">
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
            aria-label={canAttach ? t('chat.uploadFiles') : t('chat.noAttachPermission')}
          >
            <PlusCircle className={`w-6 h-6 ${isUploading ? 'animate-spin text-d-brand' : ''}`} />
          </button>

          <button
            type="button"
            onClick={() => setShowFormatting((v) => !v)}
            aria-pressed={showFormatting}
            className={`transition-colors pb-0.5 max-sm:hidden ${showFormatting ? 'text-d-strong' : 'text-d-text2 hover:text-d-strong'}`}
            title={t('chat.formatting')}
            aria-label={t('chat.formatting')}
          >
            <Type className="w-5 h-5" />
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
              className="text-d-text2 hover:text-d-strong transition-colors pb-0.5 disabled:opacity-50 max-sm:hidden"
              title={t('poll.createTitle')}
              aria-label={t('poll.createTitle')}
            >
              <BarChart3 className="w-6 h-6" />
            </button>
          )}

          {stickers.length > 0 && (
            <button
              type="button"
              onClick={() => { setShowStickerPicker((v) => !v); setShowEmojiPicker(false); }}
              disabled={!canSend || isArchived}
              className="text-d-text2 hover:text-d-strong transition-colors pb-0.5 max-sm:hidden"
              title={t('stickers.title')}
              aria-label={t('stickers.title')}
            >
              <Sticker className="w-6 h-6" />
            </button>
          )}

          <button
            type="button"
            onClick={() => { setReactTarget(null); setShowEmojiPicker((v) => !v); setShowStickerPicker(false); }}
            disabled={!canSend || isArchived}
            className="text-d-text2 hover:text-d-strong transition-colors pb-0.5"
            title={t('chat.emoji')}
            aria-label={t('chat.emoji')}
          >
            <Smile className="w-6 h-6" />
          </button>

          {onSendVoiceNote && (
            <VoiceNoteButton
              onStart={() => setRecordingNote(true)}
              disabled={!canSend || !canAttach || isArchived}
            />
          )}

{/* Appearance › "Show send message button". Enter always sends. */}
          {prefs.appearance.showSendButton && (
          <button
            type="submit"
            disabled={(!inputText.trim() && attachments.length === 0) || !canSend || isArchived}
            className={`p-1.5 rounded-full transition-colors mb-0.5 ${
              (inputText.trim() || attachments.length > 0) && canSend && !isArchived
                ? 'bg-d-brand text-white hover:bg-d-brandhover'
                : 'text-d-text4 cursor-not-allowed'
            }`}
            title={t('chat.send')}
            aria-label={t('chat.send')}
          >
            <Send className="w-4 h-4" />
          </button>
          )}
          </>
          )}
          </div>
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

      {showMobileSearch && (
        <MobileSearchSheet
          initial={searchTerm}
          onClose={() => setShowMobileSearch(false)}
          onSubmit={(term) => {
            setSearchTerm(term);
            setShowMobileSearch(false);
            onSearch?.(term);
          }}
        />
      )}

      {headerMenu && (
        <ContextMenu
          x={headerMenu.x}
          y={headerMenu.y}
          onClose={() => setHeaderMenu(null)}
          items={[
            {
              icon: muted ? BellOff : Bell,
              label: t('notif.notificationSettings'),
              action: () => onOpenNotificationSettings?.(headerMenu.x, headerMenu.y)
            },
            onOpenInbox && {
              icon: Inbox,
              label: inboxCount > 0 ? `${t('notif.inbox')} (${inboxCount})` : t('notif.inbox'),
              action: () => onOpenInbox(window.innerWidth - 8, headerMenu.y)
            }
          ].filter(Boolean)}
        />
      )}

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
          botCommands={botCommands}
          onRunBotCommand={onRunBotCommand ? (command, target) => onRunBotCommand(command, {}, target) : null}
          message={contextMenu.message}
          x={contextMenu.x}
          y={contextMenu.y}
          isOwn={contextMenu.message.user_id === currentUser?.id}
          canManage={canManageMessages}
          canPin={canManageMessages || isDM}
          onClose={() => setContextMenu(null)}
          onReply={canSend && !isArchived ? startReply : null}
          onEdit={startEditing}
          onDelete={(msg) => requestDelete(msg)}
          onTogglePin={(msg, pinned) => onTogglePin?.(msg, pinned)}
          onAddReaction={openReactionPicker}
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
  spoilerMode = 'click', isOwn = false, safetyHold = false, autoplayGifs = true
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
        <StillImage
          src={att.url}
          animate={autoplayGifs || !isAnimatedImage({ url: att.url, mimetype: att.mimetype, filename: att.filename })}
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

/**
 * A popover placed beside an element in the message list: to the left of the
 * row's right edge (where the action bar sits), top-aligned with the row,
 * clamped inside the viewport; on a phone it centres horizontally. A clear
 * backdrop closes it on an outside click.
 */
function AnchoredPopover({ anchorId, onClose, children }) {
  const ref = useRef(null);
  const [position, setPosition] = useState(null);
  useLayoutEffect(() => {
    const anchor = document.getElementById(anchorId);
    const node = ref.current;
    if (!node) return;
    const margin = 8;
    const { width, height } = node.getBoundingClientRect();
    const rect = anchor?.getBoundingClientRect() ?? { top: window.innerHeight / 3, right: window.innerWidth - margin };
    const narrow = window.innerWidth < 640;
    const left = narrow
      ? (window.innerWidth - width) / 2
      : rect.right - width - 56;
    let top = rect.top - 8;
    if (top + height > window.innerHeight - margin) top = window.innerHeight - height - margin;
    setPosition({
      left: Math.max(margin, Math.min(left, window.innerWidth - width - margin)),
      top: Math.max(margin, top)
    });
  }, [anchorId]);
  return (
    <>
      <div className="fixed inset-0 z-40" onMouseDown={onClose} aria-hidden="true" />
      <div
        ref={ref}
        className="fixed z-50"
        style={position ? { left: position.left, top: position.top } : { left: 0, top: 0, visibility: 'hidden' }}
      >
        {children}
      </div>
    </>
  );
}

const SYSTEM_TYPES = new Set(['thread_created', 'pin', 'channel_pinned_message', 'join', 'member_join', 'guild_member_join']);

/** Put a React node where a translation says {name}. */
function withName(key, node) {
  return t(key).split('{name}').map((part, i) => (
    <React.Fragment key={i}>{i > 0 && node}{part}</React.Fragment>
  ));
}

function SystemMessage({ msg, use24Hour, onOpenThread, onOpenPins, onSelectUser }) {
  const name = msg.display_name ?? msg.username ?? '';
  const who = (
    <button type="button" onClick={() => onSelectUser(msg.user_id)} className="font-semibold text-d-strong hover:underline">
      {name}
    </button>
  );
  let icon = MessagesSquare;
  let body;
  if (msg.type === 'thread_created') {
    body = (
      <>
        {withName('system.threadStarted', who)}{' '}
        {msg.thread_id ? (
          <button type="button" onClick={() => onOpenThread(msg.thread_id)} className="font-semibold text-d-strong hover:underline">
            {msg.content}
          </button>
        ) : <span className="font-semibold text-d-strong">{msg.content}</span>}
      </>
    );
  } else if (msg.type === 'pin' || msg.type === 'channel_pinned_message') {
    icon = Pin;
    body = (
      <>
        {withName('system.pinned', who)}{' '}
        <button type="button" onClick={onOpenPins} className="font-semibold text-d-strong hover:underline">
          {t('system.seePins')}
        </button>
      </>
    );
  } else {
    icon = UserPlus;
    body = withName('system.joined', who);
  }
  const Icon = icon;
  return (
    <div id={`message-${msg.id}`} role="note" className="message-row flex items-center gap-4 max-sm:gap-3 px-2 -mx-2 py-1 text-sm text-d-text2">
      <span className="w-10 shrink-0 flex justify-center text-d-text3" aria-hidden="true">
        <Icon className="w-4 h-4" />
      </span>
      <p className="min-w-0 flex-1 leading-relaxed">
        {body}
        <span className="ml-2 text-[11px] text-d-text4">{formatTime(msg.created_at, undefined, use24Hour)}</span>
      </p>
    </div>
  );
}

/** Full-screen search entry for phones. Results open in SearchResultsPanel. */
function MobileSearchSheet({ initial = '', onSubmit, onClose }) {
  const [term, setTerm] = useState(initial);
  const ref = useFocusTrap(true, onClose);
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label={t('chat.searchMessages')} className="fixed inset-0 z-50 bg-d-canvas flex flex-col">
      <form
        onSubmit={(e) => { e.preventDefault(); if (term.trim()) onSubmit(term.trim()); }}
        className="h-14 px-2 flex items-center gap-2 border-b border-d-edge"
      >
        <button type="button" onClick={onClose} className="p-2 text-d-text2 hover:text-d-strong" aria-label={t('common.back')}>
          <ArrowLeft className="w-5 h-5" />
        </button>
        <input
          type="search"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
          placeholder={t('common.search')}
          aria-label={t('chat.searchMessages')}
          enterKeyHint="search"
          className="flex-1 min-w-0 bg-d-base text-base text-d-strong placeholder-d-text4 px-3 py-2 rounded-lg focus:outline-none focus:ring-2 focus:ring-d-brand"
        />
        <button type="submit" disabled={!term.trim()} className="p-2 text-d-text2 hover:text-d-strong disabled:opacity-40" aria-label={t('chat.searchMessages')}>
          <Search className="w-5 h-5" />
        </button>
      </form>
      <p className="p-4 text-sm text-d-text3">{t('search.mobileHint')}</p>
    </div>
  );
}
