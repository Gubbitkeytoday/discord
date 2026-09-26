import React, {
  forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState
} from 'react';
import {
  PlusCircle, Smile, Send, Reply, X, Loader2, Sticker, BarChart3, Type, Upload, RotateCcw,
  Bold, Italic, Underline, Strikethrough, Code, Code2, Quote, EyeOff, Link2, Film, Mic
} from 'lucide-react';
import { t } from '../../i18n/index.jsx';
import { runSlashCommand, parseSlashInput } from '../../utils/slashCommands';
import { convertEmoticons } from '../../utils/emoticons';
import { resolveComposerTokens } from '../../utils/mentions';
import { convertShortcodes } from '../../chat/emojiShortcodes.js';
import { proxiedImageUrl } from '../../utils/media';
import { localizeError } from '../../api';
import { playMessageIncomingSound } from '../../utils/soundEffects';
import { lazyComponent } from '../../utils/lazyComponent';
import ComposerAutocomplete, { detectTrigger, buildOptions } from '../ComposerAutocomplete';
import ContextMenu from '../ContextMenu';
import { VoiceNoteRecorder, VoiceNoteButton } from '../VoiceNote';
import GifPicker from './GifPicker';

const EmojiPicker = lazyComponent(() => import('../EmojiPicker'));
const StickerPicker = lazyComponent(() => import('../StickerPicker'));

const MAX_LENGTH = 4000;
// An upload that has not moved for this long is treated as failed (a dead
// connection in a tunnel otherwise shows "48%" forever).
const STALL_MS = 20_000;

// Unsent text per channel, kept for the life of the tab like Discord's drafts:
// hopping to another channel to check something no longer eats what you typed.
const drafts = new Map();

const ICON_BTN = 'w-9 h-9 pointer-coarse:w-11 pointer-coarse:h-11 shrink-0 inline-flex items-center justify-center rounded-md text-d-text2 hover:text-d-strong hover:bg-d-hover/60 transition-colors disabled:opacity-40 disabled:cursor-not-allowed';

const FORMATS = () => [
  { key: 'bold', markers: ['**'], icon: Bold, label: t('chat.bold') },
  { key: 'italic', markers: ['*'], icon: Italic, label: t('chat.italic') },
  { key: 'underline', markers: ['__'], icon: Underline, label: t('chat.underline') },
  { key: 'strike', markers: ['~~'], icon: Strikethrough, label: t('chat.strikethrough') },
  { key: 'code', markers: ['`'], icon: Code, label: t('chat.inlineCode') },
  { key: 'block', markers: ['```\n', '\n```'], icon: Code2, label: t('chat.codeBlock') },
  { key: 'quote', markers: ['> ', ''], icon: Quote, label: t('chat.quote') },
  { key: 'spoiler', markers: ['||'], icon: EyeOff, label: t('chat.spoiler') },
  { key: 'link', markers: ['[', '](url)'], icon: Link2, label: t('chat.link') }
];

let jobSeq = 0;

/**
 * The message composer. It owns everything typing touches — the text, the
 * autocomplete, pickers, uploads — so a keystroke re-renders this component
 * and nothing else (docs/FRONTEND-PERFORMANCE.md F1: the list used to
 * re-render on every character).
 *
 * Mounted with key={channel.id}; the draft is saved on unmount.
 */
const Composer = forwardRef(function Composer({
  channelId, placeholder, canSend, canAttach, isArchived,
  members, channels, customEmojis, externalEmojiGroups, stickers, botCommands, serverId,
  replyTo, onCancelReply, onSend, onSendVoiceNote, onOpenPoll, onSlashAction, onRunBotCommand,
  onTypingStart, onTypingStop, onToast, onArrowUpEmpty, getRecentGifs,
  convertEmoticonsPref, ttsEnabled, showSendButton, currentUserId
}, ref) {
  const [text, setText] = useState(() => drafts.get(channelId) ?? '');
  const [attachments, setAttachments] = useState([]);
  const [jobs, setJobs] = useState([]);                    // uploads: in flight or failed
  const [sendQueued, setSendQueued] = useState(false);
  const [trigger, setTrigger] = useState(null);
  const [acIndex, setAcIndex] = useState(0);
  const [picker, setPicker] = useState(null);              // 'emoji' | 'sticker' | 'gif' | null
  const [showFormatting, setShowFormatting] = useState(false);
  const [plusMenu, setPlusMenu] = useState(null);
  const [recording, setRecording] = useState(false);

  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const typingTimerRef = useRef(null);
  const textRef = useRef(text);
  textRef.current = text;
  const xhrs = useRef(new Map());

  const disabled = !canSend || isArchived;
  const uploading = jobs.some((j) => j.status === 'uploading');

  // Save the draft when leaving the channel; abort uploads that belong to it.
  useEffect(() => {
    const live = xhrs.current;
    return () => {
      const draft = textRef.current;
      if (draft.trim()) drafts.set(channelId, draft); else drafts.delete(channelId);
      for (const xhr of live.values()) xhr.abort();
      clearTimeout(typingTimerRef.current);
    };
  }, [channelId]);

  // Grow with the text (wrapping included), up to the CSS max height.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 192)}px`;
  }, [text]);

  const tokenContext = useMemo(() => ({
    members,
    channels,
    customEmojis: [...customEmojis, ...externalEmojiGroups.flatMap((g) => g.emojis ?? [])]
  }), [members, channels, customEmojis, externalEmojiGroups]);

  const toWire = useCallback((value) => convertShortcodes(resolveComposerTokens(
    convertEmoticonsPref ? convertEmoticons(value) : value, tokenContext
  )), [convertEmoticonsPref, tokenContext]);

  const options = useMemo(
    () => buildOptions(trigger, { members, channels, customEmojis, botCommands }),
    [trigger, members, channels, customEmojis, botCommands]
  );
  const acOpen = Boolean(trigger) && options.length > 0;

  const focus = useCallback(() => requestAnimationFrame(() => textareaRef.current?.focus()), []);

  /** Put `value` at the caret (or replace the selection). */
  const insertAtCaret = useCallback((value) => {
    const el = textareaRef.current;
    const current = textRef.current;
    const start = el?.selectionStart ?? current.length;
    const end = el?.selectionEnd ?? start;
    const next = current.slice(0, start) + value + current.slice(end);
    setText(next);
    requestAnimationFrame(() => {
      el?.focus();
      const caret = start + value.length;
      el?.setSelectionRange(caret, caret);
    });
  }, []);

  useImperativeHandle(ref, () => ({
    focus,
    insert: insertAtCaret,
    toggleEmoji: () => setPicker((p) => (p === 'emoji' ? null : 'emoji')),
    toggleFormatting: () => setShowFormatting((v) => !v),
    uploadFiles: (files) => uploadFiles(files)
  }));

  // --- typing -----------------------------------------------------------------

  const emitTyping = () => {
    if (!onTypingStart || disabled) return;
    if (typingTimerRef.current) return;               // one typing_start per 3 s
    onTypingStart();
    typingTimerRef.current = setTimeout(() => { typingTimerRef.current = null; }, 3000);
  };

  const clear = () => {
    setText('');
    textRef.current = '';
    drafts.delete(channelId);
    setAttachments([]);
    onCancelReply?.();
    clearTimeout(typingTimerRef.current);
    typingTimerRef.current = null;
    onTypingStop?.();
  };

  // --- uploads (progress, cancel, retry) ---------------------------------------

  const updateJob = (id, patch) => setJobs((list) => list.map((j) => (j.id === id ? { ...j, ...patch } : j)));

  const startUpload = (job) => {
    const formData = new FormData();
    job.files.forEach((file) => formData.append('files', file));
    const xhr = new window.XMLHttpRequest();
    xhrs.current.set(job.id, xhr);
    let stall = null;
    const armStall = () => {
      clearTimeout(stall);
      stall = setTimeout(() => { xhr.abort(); finish(null, t('chat.uploadStalled')); }, STALL_MS);
    };
    const finish = (data, error) => {
      clearTimeout(stall);
      if (!xhrs.current.has(job.id)) return;
      xhrs.current.delete(job.id);
      if (data?.attachments?.length) {
        setAttachments((prev) => [...prev, ...data.attachments]);
        setJobs((list) => list.filter((j) => j.id !== job.id));
        if (data.failed?.length) onToast?.(data.failed.map((f) => `${f.filename}: ${f.error}`).join('\n'), { type: 'error' });
        return;
      }
      setSendQueued(false);
      updateJob(job.id, { status: 'failed', error: error ?? data?.error ?? t('chat.uploadFailed'), progress: null });
    };
    xhr.open('POST', '/api/upload/attachments');
    xhr.withCredentials = true;
    if (currentUserId) xhr.setRequestHeader('x-user-id', currentUserId);
    xhr.upload.onprogress = (event) => {
      armStall();
      if (event.lengthComputable && event.total > 0) updateJob(job.id, { progress: event.loaded / event.total });
    };
    xhr.onload = () => {
      let data = null;
      try { data = JSON.parse(xhr.responseText || 'null'); } catch { data = null; }
      if (xhr.status >= 200 && xhr.status < 300) finish(data ?? {});
      else finish(null, data ? localizeError(data, xhr.status) : t('chat.uploadFailed'));
    };
    xhr.onerror = () => finish(null, navigator.onLine === false ? t('chat.uploadOffline') : t('chat.uploadFailed'));
    xhr.onabort = () => finish(null, t('chat.uploadCancelled'));
    armStall();
    xhr.send(formData);
  };

  function uploadFiles(files) {
    if (!files?.length) return;
    if (!canAttach) { onToast?.(t('chat.noAttachPermission'), { type: 'error' }); return; }
    jobSeq += 1;
    const job = { id: `up-${jobSeq}`, files: [...files], progress: 0, status: 'uploading', error: null };
    setJobs((list) => [...list, job]);
    startUpload(job);
  }

  const cancelJob = (job) => {
    const xhr = xhrs.current.get(job.id);
    xhrs.current.delete(job.id);
    xhr?.abort();
    setJobs((list) => list.filter((j) => j.id !== job.id));
    setSendQueued(false);
  };

  const retryJob = (job) => {
    const next = { ...job, status: 'uploading', progress: 0, error: null };
    setJobs((list) => list.map((j) => (j.id === job.id ? next : j)));
    startUpload(next);
  };

  // --- sending --------------------------------------------------------------

  const send = (event) => {
    event?.preventDefault();
    if (uploading) { setSendQueued(true); return; }     // never send ahead of an upload
    const value = textRef.current;
    if (!value.trim() && attachments.length === 0) return;
    if (disabled) return;

    const command = runSlashCommand(value.trim());
    if (command) {
      if (command.unknown) {
        // Not a built-in: a bot in this channel may still own it. Options are
        // taken positionally, in the order the bot declared them.
        const bot = botCommands.find((c) => c.name === command.name);
        if (bot) {
          const parsed = parseSlashInput(value.trim());
          const words = (parsed?.rest ?? '').split(/\s+/).filter(Boolean);
          const opts = {};
          bot.options.forEach((option, index) => {
            const isLast = index === bot.options.length - 1;
            const v = isLast ? words.slice(index).join(' ') : words[index];
            if (v !== undefined && v !== '') opts[option.name] = v;
          });
          clear();
          onRunBotCommand?.(bot, opts);
          return;
        }
        onToast?.(t('slash.unknown', { name: command.name }), { type: 'error' });
        return;
      }
      if (command.action) {
        clear();
        if (command.action === 'poll') onOpenPoll?.();
        else onSlashAction?.(command.action, command.value);
        return;
      }
      if (command.empty) { clear(); return; }
      onSend(toWire(command.content), attachments, replyTo?.id, { tts: Boolean(command.tts && ttsEnabled) });
      playMessageIncomingSound();
      clear();
      return;
    }

    onSend(toWire(value), attachments, replyTo?.id);
    playMessageIncomingSound();
    clear();
  };
  const sendRef = useRef(send);
  sendRef.current = send;
  useEffect(() => {
    if (!sendQueued || uploading) return;
    setSendQueued(false);
    sendRef.current();
  }, [sendQueued, uploading]);

  // --- formatting and completion -------------------------------------------------

  const applyFormat = (before, after = before) => {
    const el = textareaRef.current;
    if (!el) return;
    const value = textRef.current;
    const start = el.selectionStart ?? value.length;
    const end = el.selectionEnd ?? start;
    const selected = value.slice(start, end);
    const wrapped = value.slice(Math.max(0, start - before.length), start) === before
      && value.slice(end, end + after.length) === after;
    let next; let caretStart;
    if (wrapped) {
      next = value.slice(0, start - before.length) + selected + value.slice(end + after.length);
      caretStart = start - before.length;
    } else {
      next = value.slice(0, start) + before + selected + after + value.slice(end);
      caretStart = start + before.length;
    }
    setText(next);
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(caretStart, caretStart + selected.length); });
  };

  const updateTrigger = (value, caret) => { setTrigger(detectTrigger(value, caret)); setAcIndex(0); };

  const applyCompletion = (option) => {
    if (!trigger || !option) return;
    const value = textRef.current;
    if (option.command || option.botCommand) {
      const rest = value.replace(/^\/\w*\s?/, '');
      setText(`${option.insert}${rest}`);
    } else {
      const before = value.slice(0, trigger.start);
      const after = value.slice(trigger.start + trigger.query.length + 1);
      setText(before + option.insert + after.replace(/^\s/, ''));
    }
    setTrigger(null);
    setAcIndex(0);
    focus();
  };

  const onKeyDown = (e) => {
    if (acOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setAcIndex((i) => (i + 1) % options.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setAcIndex((i) => (i - 1 + options.length) % options.length); return; }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) { e.preventDefault(); applyCompletion(options[acIndex]); return; }
      if (e.key === 'Escape') { e.preventDefault(); setTrigger(null); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); send(e); return; }
    if (e.key === 'Escape' && replyTo) { e.preventDefault(); onCancelReply?.(); return; }
    // ↑ in an empty box: edit your last message or step into the history.
    if (e.key === 'ArrowUp' && !textRef.current && !e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
      if (onArrowUpEmpty?.()) e.preventDefault();
    }
  };

  const onPaste = (e) => {
    const files = [...(e.clipboardData?.files ?? [])];
    if (files.length === 0) return;
    e.preventDefault();
    uploadFiles(files);
  };

  const sendSticker = (sticker) => {
    onSend('', [], replyTo?.id, { sticker });
    onCancelReply?.();
  };

  const sendGif = (gif) => {
    onSend('', [gif], replyTo?.id);
    onCancelReply?.();
  };

  const openPlusMenu = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setPlusMenu({ x: rect.left, y: rect.top - 8 - 44 * 6 });
  };

  const hasContent = text.trim().length > 0 || attachments.length > 0;
  const formats = useMemo(FORMATS, []);

  return (
    <div
      className="@container px-4 max-sm:px-2 pt-1 shrink-0 relative pb-[max(0.5rem,env(safe-area-inset-bottom))]"
      role="region"
      aria-label={t('chat.composerRegion')}
    >
      {replyTo && (
        <div className="mb-2 px-3 py-1 bg-d-surface rounded-t-lg border-x border-t border-d-divider flex items-center justify-between gap-2 text-xs text-d-text2">
          <div className="flex items-center gap-2 min-w-0">
            <Reply className="w-3.5 h-3.5 text-d-brand shrink-0" aria-hidden="true" />
            <span className="truncate">{t('chat.replyingTo', { name: replyTo.display_name ?? replyTo.username ?? '' })}</span>
          </div>
          <button type="button" onClick={() => { onCancelReply?.(); focus(); }} className={ICON_BTN} title={t('common.cancel')} aria-label={t('chat.cancelReply')}>
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      )}

      {jobs.map((job) => (
        <div
          key={job.id}
          className={`mb-2 px-3 py-1.5 rounded-lg border text-xs flex items-center gap-2 ${job.status === 'failed' ? 'bg-d-danger/10 border-d-danger/40 text-d-text' : 'bg-d-surface border-d-divider text-d-text2'}`}
          role={job.status === 'failed' ? 'alert' : 'status'}
          data-testid="upload-progress"
        >
          {job.status === 'uploading'
            ? <Loader2 className="w-3.5 h-3.5 animate-spin text-d-brand shrink-0" aria-hidden="true" />
            : <Upload className="w-3.5 h-3.5 text-d-danger shrink-0" aria-hidden="true" />}
          <span className="min-w-0 truncate">
            {job.status === 'uploading'
              ? `${t('chat.uploading')}${job.progress != null ? ` ${Math.round(job.progress * 100)}%` : ''}`
              : `${t('chat.uploadFailedNamed', { name: job.files.map((f) => f.name).join(', ') })}${job.error ? ` — ${job.error}` : ''}`}
          </span>
          {job.status === 'uploading' && (
            <div
              className="h-1.5 flex-1 min-w-12 rounded-full bg-d-base overflow-hidden"
              role="progressbar"
              aria-label={t('chat.uploading')}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={job.progress != null ? Math.round(job.progress * 100) : undefined}
            >
              <div className="h-full bg-d-brand transition-[width] duration-150" style={{ width: `${Math.round((job.progress ?? 0) * 100)}%` }} />
            </div>
          )}
          {job.status === 'uploading' && sendQueued && <span className="shrink-0 text-d-text3 max-sm:hidden">{t('chat.sendAfterUpload')}</span>}
          {job.status === 'failed' && (
            <button type="button" onClick={() => retryJob(job)} className="ml-auto shrink-0 inline-flex items-center gap-1 px-2 min-h-8 pointer-coarse:min-h-11 rounded font-semibold hover:bg-d-hover">
              <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" /> {t('chat.retry')}
            </button>
          )}
          <button
            type="button"
            onClick={() => cancelJob(job)}
            className={`${job.status === 'failed' ? '' : 'ml-auto'} ${ICON_BTN} w-8 h-8`}
            aria-label={job.status === 'failed' ? t('common.close') : t('chat.cancelUpload')}
            title={job.status === 'failed' ? t('common.close') : t('chat.cancelUpload')}
          >
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>
      ))}

      {attachments.length > 0 && (
        <ul className="mb-2 p-2.5 bg-d-surface rounded-lg border border-d-divider flex flex-wrap gap-3" aria-label={t('chat.attachmentCount', { count: attachments.length })}>
          {attachments.map((att, i) => (
            <li key={att.id ?? i} className="relative bg-d-base p-1 rounded-lg border border-d-divider flex items-center gap-2">
              {att.file_type === 'image' ? (
                <img src={proxiedImageUrl(att.thumbnail_url ?? att.url)} alt="" width={56} height={56} className="w-14 h-14 rounded object-cover" />
              ) : (
                <div className="w-14 h-14 bg-d-surface rounded flex items-center justify-center text-xs text-d-brand font-semibold" aria-hidden="true">FILE</div>
              )}
              <div className="pr-1 max-w-[140px]">
                <div className="text-xs text-d-strong truncate">{att.filename}</div>
                <div className="text-[11px] text-d-text3">{att.size_human}</div>
              </div>
              <button
                type="button"
                aria-label={t('chat.removeAttachmentNamed', { name: att.filename ?? '' })}
                onClick={() => setAttachments((prev) => prev.filter((_, idx) => idx !== i))}
                className="absolute -top-2 -right-2 bg-d-danger text-white rounded-full w-6 h-6 pointer-coarse:w-8 pointer-coarse:h-8 inline-flex items-center justify-center shadow-md"
                title={t('chat.removeAttachment')}
              >
                <X className="w-3 h-3" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      )}

      <input
        type="file"
        ref={fileInputRef}
        onChange={(e) => { uploadFiles(Array.from(e.target.files || [])); e.target.value = ''; }}
        aria-label={t('chat.selectFiles')}
        className="hidden"
        multiple
        accept="image/*,video/*,audio/*,.pdf,.json,.txt,.zip"
      />

      {picker === 'emoji' && (
        <div className="absolute bottom-full mb-1 right-4 max-sm:right-2 z-40">
          <EmojiPicker
            customEmojis={customEmojis}
            externalGroups={externalEmojiGroups.filter((g) => g.server_id !== serverId)}
            onClose={() => { setPicker(null); focus(); }}
            onPick={(entry) => {
              setPicker(null);
              insertAtCaret(entry.custom ? `:${entry.name}: ` : entry.char);
            }}
          />
        </div>
      )}
      {picker === 'sticker' && (
        <div className="absolute bottom-full mb-1 right-4 max-sm:right-2 z-40">
          <StickerPicker stickers={stickers} onClose={() => setPicker(null)} onPick={sendSticker} />
        </div>
      )}
      {picker === 'gif' && (
        <div className="absolute bottom-full mb-1 right-4 max-sm:right-2 z-40">
          <GifPicker
            getRecent={getRecentGifs}
            onPick={sendGif}
            onUpload={() => fileInputRef.current?.click()}
            onClose={() => setPicker(null)}
          />
        </div>
      )}

      <div className="relative">
        <ComposerAutocomplete trigger={trigger} options={options} activeIndex={acIndex} onPick={applyCompletion} onHover={setAcIndex} />
      </div>

      <form
        onSubmit={send}
        className={`bg-d-input rounded-lg px-2 py-1 focus-within:ring-2 focus-within:ring-d-brand/60 ${disabled ? 'opacity-60' : ''}`}
      >
        {showFormatting && !recording && (
          <div className="flex flex-wrap items-center gap-0.5 pb-1 mb-1 border-b border-d-divider" role="toolbar" aria-label={t('chat.formatting')}>
            {formats.map(({ key, markers, icon: Icon, label }) => (
              <button
                key={key}
                type="button"
                onClick={() => applyFormat(markers[0], markers[1] ?? markers[0])}
                disabled={disabled}
                className={`${ICON_BTN} w-8 h-8`}
                title={label}
                aria-label={label}
              >
                <Icon className="w-4 h-4" aria-hidden="true" />
              </button>
            ))}
          </div>
        )}

        {recording ? (
          <VoiceNoteRecorder
            onCancel={() => setRecording(false)}
            onToast={onToast}
            onSend={async (note) => {
              await onSendVoiceNote?.(note, replyTo?.id);
              setRecording(false);
              onCancelReply?.();
            }}
          />
        ) : (
          <div className="flex items-end gap-0.5 flex-wrap @min-[20rem]:flex-nowrap">
            <button
              type="button"
              onClick={openPlusMenu}
              disabled={disabled}
              aria-haspopup="menu"
              className={ICON_BTN}
              title={t('chat.moreComposerActions')}
              aria-label={t('chat.moreComposerActions')}
            >
              <PlusCircle className={`w-6 h-6 ${uploading ? 'text-d-brand' : ''}`} aria-hidden="true" />
            </button>

            <button
              type="button"
              onClick={() => setShowFormatting((v) => !v)}
              aria-pressed={showFormatting}
              className={`${ICON_BTN} @max-md:hidden ${showFormatting ? 'text-d-strong' : ''}`}
              title={t('chat.formatting')}
              aria-label={t('chat.formatting')}
            >
              <Type className="w-5 h-5" aria-hidden="true" />
            </button>

            {/* textarea, not input: Shift+Enter must insert a newline. Below a
                320px-wide composer (a phone at 200% zoom) it takes a row of
                its own so it never shrinks to a few pixels. */}
            <textarea
              ref={textareaRef}
              id="message-composer"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                updateTrigger(e.target.value, e.target.selectionStart);
                emitTyping();
              }}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              onClick={(e) => updateTrigger(text, e.target.selectionStart)}
              onBlur={() => { onTypingStop?.(); setTrigger(null); }}
              rows={1}
              disabled={disabled}
              maxLength={MAX_LENGTH}
              placeholder={placeholder}
              aria-label={placeholder}
              aria-autocomplete="list"
              aria-controls={acOpen ? 'composer-ac' : undefined}
              aria-activedescendant={acOpen ? `composer-ac-${acIndex}` : undefined}
              aria-keyshortcuts="ArrowUp"
              enterKeyHint="send"
              className="order-first basis-full @min-[20rem]:order-none @min-[20rem]:basis-auto flex-1 min-w-0 min-h-9 pointer-coarse:min-h-11 bg-transparent text-d-strong placeholder-d-text3 placeholder:truncate text-sm max-sm:text-base focus:outline-none resize-none max-h-48 px-1.5 py-2 leading-relaxed disabled:cursor-not-allowed"
            />

            {text.length > MAX_LENGTH - 400 && (
              <span className={`text-xs self-center px-1 ${text.length >= MAX_LENGTH ? 'text-d-danger' : 'text-d-text3'}`} aria-live="polite">
                {MAX_LENGTH - text.length}
              </span>
            )}

            <div className="flex items-end gap-0.5 ml-auto @min-[20rem]:ml-0">
              {onOpenPoll && (
                <button type="button" onClick={onOpenPoll} disabled={disabled} className={`${ICON_BTN} @max-md:hidden`}
                  title={t('poll.createTitle')} aria-label={t('poll.createTitle')}>
                  <BarChart3 className="w-6 h-6" aria-hidden="true" />
                </button>
              )}
              <button type="button" onClick={() => setPicker((p) => (p === 'gif' ? null : 'gif'))} disabled={disabled}
                className={`${ICON_BTN} @max-md:hidden`} title={t('gif.title')} aria-label={t('gif.title')} aria-expanded={picker === 'gif'}>
                <Film className="w-6 h-6" aria-hidden="true" />
              </button>
              {stickers.length > 0 && (
                <button type="button" onClick={() => setPicker((p) => (p === 'sticker' ? null : 'sticker'))} disabled={disabled}
                  className={`${ICON_BTN} @max-md:hidden`} title={t('stickers.title')} aria-label={t('stickers.title')} aria-expanded={picker === 'sticker'}>
                  <Sticker className="w-6 h-6" aria-hidden="true" />
                </button>
              )}
              <button type="button" onClick={() => setPicker((p) => (p === 'emoji' ? null : 'emoji'))} disabled={disabled}
                className={ICON_BTN} title={t('chat.emoji')} aria-label={t('chat.emoji')} aria-expanded={picker === 'emoji'}>
                <Smile className="w-6 h-6" aria-hidden="true" />
              </button>
              {onSendVoiceNote && !hasContent && (
                <VoiceNoteButton onStart={() => setRecording(true)} disabled={disabled || !canAttach} className={ICON_BTN} />
              )}
              {(showSendButton || hasContent) && (
                <button
                  type="submit"
                  disabled={(!hasContent && !uploading) || disabled}
                  aria-busy={uploading ? 'true' : undefined}
                  className={`w-9 h-9 pointer-coarse:w-11 pointer-coarse:h-11 shrink-0 inline-flex items-center justify-center rounded-full transition-colors ${
                    hasContent && !disabled && !uploading ? 'bg-d-brand text-white hover:bg-d-brandhover' : 'text-d-text3 cursor-not-allowed'
                  }`}
                  title={t('chat.send')}
                  aria-label={t('chat.send')}
                >
                  <Send className="w-4 h-4" aria-hidden="true" />
                </button>
              )}
            </div>
          </div>
        )}
      </form>

      {plusMenu && (
        <ContextMenu
          x={plusMenu.x}
          y={plusMenu.y}
          onClose={() => setPlusMenu(null)}
          items={[
            { icon: Upload, label: t('chat.uploadFiles'), disabled: !canAttach, action: () => fileInputRef.current?.click() },
            onOpenPoll && { icon: BarChart3, label: t('poll.createTitle'), action: onOpenPoll },
            { icon: Film, label: t('gif.title'), action: () => setPicker('gif') },
            stickers.length > 0 && { icon: Sticker, label: t('stickers.title'), action: () => setPicker('sticker') },
            { icon: Type, label: t('chat.formatting'), checked: showFormatting, action: () => setShowFormatting((v) => !v) },
            onSendVoiceNote && canAttach && { icon: Mic, label: t('voiceNote.record'), action: () => setRecording(true) }
          ].filter(Boolean)}
        />
      )}
    </div>
  );
});

export default memo(Composer);
