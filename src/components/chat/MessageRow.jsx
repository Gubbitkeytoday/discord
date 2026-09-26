import React, { memo, useState } from 'react';
import { Reply, AlertTriangle, RotateCcw, Check, Clock, X, Pin } from 'lucide-react';
import { t } from '../../i18n/index.jsx';
import { formatDateDivider, formatTime, formatFullTimestamp } from '../../utils/messageGrouping';
import { mentionsUser } from '../../utils/mentions';
import { defaultAvatar } from '../../utils/avatar';
import { proxiedImageUrl } from '../../utils/media';
import { guessLang } from '../../chat/langGuess.js';
import { useLongPress } from '../../hooks/useLongPress';
import LinkEmbed from '../LinkEmbed';
import { RichEmbed, MessageComponents } from '../RichEmbed';
import PollCard from '../PollCard';
import { VoiceNotePlayer } from '../VoiceNote';
import SuperReaction from '../SuperReaction';
import StillImage from '../StillImage';
import { TranslatedText } from '../../translation';
import Attachment from './Attachment';
import ReactionChip from './ReactionChip';
import MessageActions from './MessageActions';
import SystemMessage, { SYSTEM_TYPES } from './SystemMessage';

// Errors a retry cannot fix: offering "Retry" there only repeats the refusal.
const FINAL_ERRORS = new Set(['MISSING_PERMISSIONS', 'FORBIDDEN', 'AUTOMOD_BLOCKED', 'AUTOMOD', 'SLOWMODE', 'ARCHIVED', 'BLOCKED']);

/** Date divider and the red "New" line that sit above a message. */
function Dividers({ dateDivider, firstUnread }) {
  return (
    <>
      {Boolean(dateDivider) && (
        <div className="flex items-center gap-2 my-4" role="separator" aria-label={formatDateDivider(new Date(dateDivider))}>
          <div className="flex-1 h-px bg-d-divider" />
          <span className="text-xs font-semibold text-d-text3 px-1" aria-hidden="true">{formatDateDivider(new Date(dateDivider))}</span>
          <div className="flex-1 h-px bg-d-divider" />
        </div>
      )}
      {Boolean(firstUnread) && (
        <div data-first-unread="true" className="flex items-center gap-2 my-2" role="separator" aria-label={t('chat.newMessages')}>
          <div className="flex-1 h-px bg-d-danger" />
          <span className="text-[11px] font-bold text-d-danger bg-d-danger/10 px-2 py-0.5 rounded" aria-hidden="true">
            {t('chat.newMessages')}
          </span>
        </div>
      )}
    </>
  );
}

/** Inline edit box. Owns its own text, so typing re-renders this row only. */
function EditForm({ msg, actions }) {
  const [text, setText] = useState(() => actions.humanize(msg.content ?? ''));
  const submit = (e) => { e.preventDefault(); actions.submitEdit(msg, text); };
  return (
    <form onSubmit={submit} className="mt-1">
      <textarea
        aria-label={t('chat.editMessage')}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Enter' && !e.shiftKey) submit(e);
          if (e.key === 'Escape') { e.preventDefault(); actions.stopEditing(); }
        }}
        rows={Math.min(8, text.split('\n').length)}
        autoFocus
        onFocus={(e) => { const end = e.target.value.length; e.target.setSelectionRange(end, end); }}
        className="w-full bg-d-input text-d-strong text-sm max-sm:text-base rounded px-3 py-2 resize-none focus:outline-none focus-visible:ring-2 focus-visible:ring-d-brand/60"
      />
      <div className="flex items-center gap-3 mt-1 text-xs text-d-text3">
        <button type="button" onClick={actions.stopEditing} className="hover:underline min-h-6">
          {t('chat.cancelEsc')}
        </button>
        <button type="submit" className="text-d-link hover:underline flex items-center gap-1 min-h-6">
          <Check className="w-3 h-3" aria-hidden="true" /> {t('chat.saveEnter')}
        </button>
      </div>
    </form>
  );
}

/**
 * One message. Memoised: it re-renders only when its own message object, its
 * grouping flags or its active/focus/editing state change — not when someone
 * types in the composer or another message arrives.
 */
function MessageRow({
  msg, ctx, grouped, dateDivider, firstUnread, isActive, isFocusTarget, isEditing,
  roleColor, burst, revealed, touchOpen
}) {
  const { actions, currentUserId } = ctx;
  const longPress = useLongPress(() => actions.openSheet(msg), { delay: ctx.longPressMs });

  const rowProps = {
    'data-row-id': msg.id,
    tabIndex: isFocusTarget ? 0 : -1,
    onFocus: () => actions.focusRow(msg.id),
    onBlur: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) actions.blurRow(msg.id); },
    onPointerEnter: (e) => { if (e.pointerType === 'mouse') actions.hoverRow(msg.id); }
  };

  if (SYSTEM_TYPES.has(msg.type)) {
    return (
      <>
        <Dividers dateDivider={dateDivider} firstUnread={firstUnread} />
        <SystemMessage msg={msg} use24Hour={ctx.chatPrefs.use24HourClock} actions={actions} rowProps={rowProps} />
      </>
    );
  }

  const isOwn = msg.user_id === currentUserId;
  const authorName = msg.display_name || msg.username || '';

  if (ctx.blockedIds?.has(msg.user_id) && !isOwn && !revealed) {
    return (
      <>
        <Dividers dateDivider={dateDivider} firstUnread={firstUnread} />
        <div {...rowProps} id={`message-${msg.id}`} role="article" aria-label={t('chat.blockedMessage')}
          className="message-row py-1 text-xs text-d-text3 flex items-center gap-2 rounded focus-visible:outline-2 focus-visible:outline-d-brand">
          <span>{t('chat.blockedMessage')}</span>
          <button type="button" onClick={() => actions.revealBlocked(msg.id)} className="text-d-link hover:underline min-h-6">
            {t('chat.showAnyway')}
          </button>
        </div>
      </>
    );
  }

  const mentionsMe = !msg.pending && mentionsUser(msg, ctx.currentUser, {
    roleIds: ctx.myRoleIds, repliedToUserId: msg.replyToMsg?.user_id ?? null
  });
  const reactionList = msg.reaction_details?.length
    ? msg.reaction_details
    : Object.entries(msg.reactions ?? {}).map(([emoji, count]) => ({ emoji, count, me: false }));
  const lang = msg.content ? guessLang(msg.content) : null;
  const { chatPrefs, a11yPrefs } = ctx;
  const canDelete = isOwn || ctx.canManageMessages;
  const showActions = isActive && !msg.pending && !msg.failed && !isEditing;
  const innerTab = isActive || isFocusTarget ? 0 : -1;
  const ids = {
    author: `msg-author-${msg.id}`,
    body: `msg-body-${msg.id}`,
    time: `msg-time-${msg.id}`
  };
  const finalError = msg.failed && FINAL_ERRORS.has(msg.errorCode);

  return (
    <>
      <Dividers dateDivider={dateDivider} firstUnread={firstUnread} />
      <div
        {...rowProps}
        {...longPress.handlers}
        onClickCapture={longPress.clickGuard}
        id={`message-${msg.id}`}
        role="article"
        aria-roledescription={t('a11y.message')}
        aria-labelledby={`${ids.author} ${msg.content ? ids.body : ''} ${ids.time}`.replace(/\s+/g, ' ').trim()}
        data-actions-open={touchOpen ? 'true' : undefined}
        data-pending={msg.pending ? 'true' : undefined}
        onClick={(e) => {
          // Touch screens have no hover: a plain tap shows the action bar.
          if (e.target.closest('a, button, textarea, input, video, audio, img, [role="button"]')) return;
          if (window.getSelection?.()?.toString()) return;
          actions.tapRow(msg.id);
        }}
        onContextMenu={(e) => {
          if (longPress.firedRef.current) { e.preventDefault(); return; }
          if (e.target.closest('a, img, video, audio, textarea')) return;
          e.preventDefault();
          actions.openMenuAt(msg, e.clientX, e.clientY);
        }}
        onDoubleClick={(e) => {
          // Tap to React. Ignored on anything you might legitimately be
          // double-clicking for another reason, and on unsent messages.
          const emoji = chatPrefs?.tapToReactEmoji;
          if (!emoji || msg.pending || msg.failed) return;
          if (e.target.closest('a, img, video, audio, textarea, input, button')) return;
          if (window.getSelection?.()?.toString()) return;
          actions.toggleReaction(msg.id, emoji);
        }}
        className={`message-row group flex gap-4 max-sm:gap-3 px-2 -mx-2 rounded relative outline-none focus-visible:ring-2 focus-visible:ring-d-brand focus-visible:ring-inset pointer-coarse:select-none [-webkit-touch-callout:none] ${
          grouped ? 'py-px' : 'py-[var(--message-padding-y)] message-group-start'
        } ${msg.pending ? 'opacity-60' : ''} ${msg.failed ? 'opacity-80' : ''} ${
          firstUnread && !mentionsMe ? 'bg-d-danger/[0.04]' : ''
        } ${mentionsMe ? 'mention-row' : ''} ${isActive || touchOpen ? 'bg-d-rowhover' : ''}`}
      >
        {grouped ? (
          <div className="w-10 shrink-0 text-[11px] text-d-text3 text-right pr-1 pt-0.5 select-none">
            <span className="sr-only" id={ids.author}>{authorName}</span>
            <time
              id={ids.time}
              dateTime={msg.created_at}
              title={formatFullTimestamp(msg.created_at)}
              aria-label={formatFullTimestamp(msg.created_at)}
              className={isActive ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'}
            >
              {formatTime(msg.created_at, undefined, chatPrefs.use24HourClock)}
            </time>
          </div>
        ) : (
          <button
            type="button"
            tabIndex={-1}
            aria-hidden="true"
            aria-label={authorName}
            onClick={() => actions.openProfile(msg.user_id)}
            onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); actions.userMenu(msg.user_id, e.clientX, e.clientY); }}
            className="w-10 h-10 shrink-0 mt-0.5 rounded-full overflow-hidden hover:opacity-80 transition-opacity"
          >
            <img
              src={proxiedImageUrl(msg.avatar_url || defaultAvatar(msg.user_id))}
              alt=""
              width={40}
              height={40}
              loading="lazy"
              decoding="async"
              className="w-10 h-10 rounded-full object-cover"
            />
          </button>
        )}

        <div className="flex-1 min-w-0">
          {Boolean(msg.reply_to_id) && (
            <div className="flex items-center gap-1.5 text-xs text-d-text3 mb-1 min-w-0">
              <Reply className="w-3.5 h-3.5 shrink-0 rotate-180 text-d-text3" aria-hidden="true" />
              {msg.replyToMsg ? (
                <>
                  <span className="font-semibold text-d-mention shrink-0">@{msg.replyToMsg.display_name}</span>
                  <button
                    type="button"
                    tabIndex={innerTab}
                    onClick={() => actions.jumpTo(msg.reply_to_id)}
                    className="truncate max-w-xs text-d-text2 hover:underline text-left"
                    aria-label={t('chat.jumpToReplied', { name: msg.replyToMsg.display_name })}
                  >
                    {msg.replyToMsg.content || t('chat.clickToSeeAttachment')}
                  </button>
                </>
              ) : (
                <span className="italic text-d-text3">{t('chat.originalDeleted')}</span>
              )}
            </div>
          )}

          {!grouped && (
            <div className="flex items-center gap-2 mb-0.5 min-w-0 flex-wrap">
              <button
                type="button"
                id={ids.author}
                tabIndex={innerTab}
                onClick={() => actions.openProfile(msg.user_id)}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); actions.userMenu(msg.user_id, e.clientX, e.clientY); }}
                className="font-semibold text-sm hover:underline role-colored inline-flex items-center gap-1.5 min-w-0 truncate"
                style={{ color: roleColor || 'var(--color-d-strong)' }}
              >
                {a11yPrefs.roleColors === 'dots' && roleColor && (
                  <span className="role-dot w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: roleColor }} aria-hidden="true" />
                )}
                {authorName}
              </button>
              {Boolean(msg.is_bot) && (
                <span className="bg-d-brand text-white text-[11px] font-bold px-1.5 rounded">BOT</span>
              )}
              {Boolean(msg.ephemeral) && (
                <span className="text-[11px] uppercase tracking-wide bg-d-surface text-d-text3 px-1 rounded shrink-0" title={t('bot.ephemeralHint')}>
                  {t('bot.ephemeral')}
                </span>
              )}
              {Boolean(msg.crossposted) && (
                <span className="text-[11px] uppercase tracking-wide bg-d-surface text-d-text3 px-1 rounded shrink-0" title={t('chat.publishedHint')}>
                  {t('chat.published')}
                </span>
              )}
              {Boolean(msg.webhook_id) && !msg.is_bot && (
                <span className="bg-d-surface text-d-text3 text-[11px] font-bold px-1.5 rounded">{t('webhooks.badge')}</span>
              )}
              {chatPrefs.showTimestamps !== false ? (
                <time
                  id={ids.time}
                  dateTime={msg.created_at}
                  className="text-xs text-d-text3"
                  title={formatFullTimestamp(msg.created_at)}
                  aria-label={formatFullTimestamp(msg.created_at)}
                >
                  {formatTime(msg.created_at, undefined, chatPrefs.use24HourClock)}
                </time>
              ) : (
                <span id={ids.time} className="sr-only">{formatFullTimestamp(msg.created_at)}</span>
              )}
              {Boolean(msg.pinned) && (
                <span className="text-d-text3" title={t('chat.pinnedBadge')}>
                  <Pin className="w-3 h-3" aria-hidden="true" />
                  <span className="sr-only">{t('chat.pinnedBadge')}</span>
                </span>
              )}
            </div>
          )}

          {isEditing ? (
            <EditForm msg={msg} actions={actions} />
          ) : msg.content ? (
            <div
              id={ids.body}
              lang={lang ?? undefined}
              className="message-body text-d-text leading-relaxed whitespace-pre-wrap break-words"
            >
              {ctx.renderMarkdown(msg)}
              {Boolean(msg.edited_at) && (ctx.canShowEditHistory ? (
                // "(edited)" is the natural place to ask "edited from what?".
                <button
                  type="button"
                  tabIndex={innerTab}
                  onClick={() => actions.showEditHistory(msg)}
                  className="text-[11px] text-d-text3 hover:text-d-strong hover:underline ml-1 align-baseline"
                  title={t('chat.editedHistory')}
                >
                  {t('chat.edited')}
                </button>
              ) : (
                <span className="text-[11px] text-d-text3 ml-1 align-baseline" title={formatFullTimestamp(msg.edited_at)}>
                  {t('chat.edited')}
                </span>
              ))}
            </div>
          ) : null}
          {!isEditing && msg.content && !msg.pending && !msg.failed && (
            <TranslatedText message={msg} render={ctx.renderText} />
          )}

          {Boolean(msg.poll) && (
            <PollCard
              poll={msg.poll}
              currentUserId={currentUserId}
              canManage={isOwn || ctx.canManageMessages}
              onToast={actions.toast}
            />
          )}

          {Boolean(msg.sticker) && (
            <StillImage
              src={msg.sticker.url}
              animate={a11yPrefs.stickerAnimation === 'always' || msg.sticker.format === 'png'}
              playOnHover={a11yPrefs.stickerAnimation === 'interaction'}
              alt={msg.sticker.name}
              title={msg.sticker.name}
              width={160}
              height={160}
              className="mt-1 w-40 h-40 object-contain"
              loading="lazy"
              decoding="async"
            />
          )}

          {Boolean(chatPrefs.showEmbeds) && msg.embeds?.length > 0 && (
            <div className="space-y-1">
              {msg.embeds.map((embed, i) => (
                embed.type === 'rich'
                  ? <RichEmbed key={i} embed={embed} />
                  : chatPrefs.showLinkPreviews
                    ? <LinkEmbed key={i} embed={embed} onOpenImage={actions.openImage} autoplayGifs={a11yPrefs.autoplayGifs} />
                    : null
              ))}
            </div>
          )}

          {msg.components?.length > 0 && <MessageComponents message={msg} onToast={actions.toast} />}

          {msg.attachments?.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {msg.attachments.map((att, i) => (
                att.waveform ? (
                  <VoiceNotePlayer key={att.id ?? i} attachment={att} />
                ) : (
                  <Attachment
                    key={att.id ?? i}
                    attachment={att}
                    onOpenImage={actions.openImage}
                    showMedia={chatPrefs.inlineAttachmentMedia}
                    showImages={chatPrefs.showImagePreviews}
                    spoilerMode={chatPrefs.renderSpoilers}
                    isOwn={isOwn}
                    safetyHold={ctx.safetyHold(msg)}
                    autoplayGifs={a11yPrefs.autoplayGifs}
                  />
                )
              ))}
            </div>
          )}

          {Boolean(msg.pending) && (
            <div className="mt-0.5 flex items-center gap-1 text-[11px] text-d-text3" role="status">
              <Clock className="w-3 h-3" aria-hidden="true" /> {t('chat.sending')}
            </div>
          )}

          {Boolean(msg.failed) && (
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-d-danger" role="alert">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
              <span className="min-w-0">{msg.error ?? t('chat.sendFailedShort')}</span>
              {!finalError && (
                <button type="button" onClick={() => actions.retry(msg)} className="hover:underline flex items-center gap-1 min-h-6 font-semibold">
                  <RotateCcw className="w-3 h-3" aria-hidden="true" /> {t('chat.retry')}
                </button>
              )}
              <button type="button" onClick={() => actions.discard(msg)} className="hover:underline flex items-center gap-1 min-h-6 font-semibold">
                <X className="w-3 h-3" aria-hidden="true" /> {t('chat.removeFailed')}
              </button>
            </div>
          )}

          {reactionList.length > 0 && (
            <div className="flex flex-wrap gap-1 mt-2">
              {reactionList.map((r) => (
                <ReactionChip key={r.emoji} reaction={r} messageId={msg.id} onToggle={actions.toggleReaction} nameFor={ctx.nameFor} />
              ))}
            </div>
          )}
        </div>

        {burst && <SuperReaction emoji={burst} onDone={() => actions.burstDone(msg.id)} />}

        {showActions && (
          <MessageActions
            msg={msg}
            isOwn={isOwn}
            canReply={ctx.canSend && !ctx.isArchived}
            canDelete={canDelete}
            canThread={ctx.canThread}
            actions={actions}
          />
        )}
      </div>
    </>
  );
}

export default memo(MessageRow);
