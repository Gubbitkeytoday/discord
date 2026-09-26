import React, { useLayoutEffect, useRef } from 'react';
import { SmilePlus, Reply, Pencil, Trash2, MoreHorizontal, MessagesSquare } from 'lucide-react';
import { TranslateButton } from '../../translation';
import { t } from '../../i18n/index.jsx';

export const QUICK_EMOJIS = ['❤️', '🔥', '👍', '😂', '🎉', '🚀', '💯', '💩', '✨'];

const BUTTON = 'p-1.5 pointer-coarse:p-2.5 min-w-8 min-h-8 pointer-coarse:min-w-11 pointer-coarse:min-h-11 inline-flex items-center justify-center rounded transition-colors';
const ICON_BUTTON = `${BUTTON} hover:bg-d-hover focus-visible:bg-d-hover text-d-text2 hover:text-d-strong`;

/**
 * The hover / focus / tap action bar of one message (Discord's order: quick
 * reactions, add reaction, reply, edit, delete, more).
 *
 * It is mounted only for the active row, so a 5,000-message channel does not
 * carry 5,000 hidden toolbars. It is a WAI-ARIA toolbar: one Tab stop, with
 * ←/→/Home/End between its buttons (roving tabindex), so reaching "More" is
 * not ten Tab presses.
 */
export default function MessageActions({ msg, isOwn, canReply, canDelete, canThread, actions }) {
  const ref = useRef(null);

  // Roving tabindex. Buttons come from several components (TranslateButton),
  // so it is applied to the DOM rather than threaded through as props.
  useLayoutEffect(() => {
    const buttons = [...(ref.current?.querySelectorAll('button') ?? [])];
    buttons.forEach((button, index) => button.setAttribute('tabindex', index === 0 ? '0' : '-1'));
  });

  const onKeyDown = (event) => {
    const buttons = [...(ref.current?.querySelectorAll('button') ?? [])];
    const index = buttons.indexOf(document.activeElement);
    if (index === -1) return;
    let next = null;
    if (event.key === 'ArrowRight') next = (index + 1) % buttons.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + buttons.length) % buttons.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = buttons.length - 1;
    else if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      // Arrow keys leave the toolbar for the message list's own navigation.
      event.preventDefault();
      ref.current?.closest('[data-row-id]')?.focus();
      return;
    }
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    buttons.forEach((button, i) => button.setAttribute('tabindex', i === next ? '0' : '-1'));
    buttons[next].focus();
  };

  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label={t('chat.messageActions')}
      onKeyDown={onKeyDown}
      className="message-actions absolute right-4 max-sm:right-2 -top-4 flex items-center bg-d-canvas border border-d-surface rounded-md shadow-lg p-0.5 gap-0.5 z-10"
    >
      {QUICK_EMOJIS.slice(0, 3).map((emoji) => (
        <button
          key={emoji}
          type="button"
          // Shift-click is Discord's "super" gesture: the same reaction, plus a
          // burst everyone in the channel sees.
          onClick={(e) => actions.react(msg, emoji, e.shiftKey)}
          className={`${BUTTON} hover:bg-d-hover focus-visible:bg-d-hover text-sm leading-none`}
          title={`${t('chat.reactWith', { emoji })} — ${t('chat.superHint')}`}
          aria-label={t('chat.reactWith', { emoji })}
        >
          {emoji}
        </button>
      ))}
      <button type="button" onClick={() => actions.openReactionPicker(msg)} className={ICON_BUTTON}
        title={t('chat.addReaction')} aria-label={t('chat.addReaction')} aria-keyshortcuts="+">
        <SmilePlus className="w-4 h-4" aria-hidden="true" />
      </button>
      {canReply && (
        <button type="button" onClick={() => actions.reply(msg)} className={ICON_BUTTON}
          title={t('chat.reply')} aria-label={t('chat.reply')} aria-keyshortcuts="R">
          <Reply className="w-4 h-4" aria-hidden="true" />
        </button>
      )}
      {canThread && (
        <button type="button" onClick={() => actions.createThread(msg)} className={`${ICON_BUTTON} max-sm:hidden`}
          title={t('chat.createThread')} aria-label={t('chat.createThread')} aria-keyshortcuts="T">
          <MessagesSquare className="w-4 h-4" aria-hidden="true" />
        </button>
      )}
      {msg.content && <TranslateButton message={msg} className={ICON_BUTTON} onDone={actions.closeTouchActions} />}
      {isOwn && (
        <button type="button" onClick={() => actions.edit(msg)} className={ICON_BUTTON}
          title={t('chat.editMessage')} aria-label={t('chat.editMessage')} aria-keyshortcuts="E">
          <Pencil className="w-4 h-4" aria-hidden="true" />
        </button>
      )}
      {canDelete && (
        <button type="button" onClick={(e) => actions.remove(msg, e)}
          className={`${BUTTON} hover:bg-d-danger/20 focus-visible:bg-d-danger/20 text-d-danger`}
          title={t('chat.deleteMessage')} aria-label={t('chat.deleteMessage')} aria-keyshortcuts="Delete">
          <Trash2 className="w-4 h-4" aria-hidden="true" />
        </button>
      )}
      <button type="button" onClick={(e) => actions.openMenuFrom(msg, e.currentTarget)} aria-haspopup="menu"
        className={ICON_BUTTON} title={t('chat.moreActions')} aria-label={t('chat.moreActions')} aria-keyshortcuts="Shift+F10">
        <MoreHorizontal className="w-4 h-4" aria-hidden="true" />
      </button>
    </div>
  );
}
