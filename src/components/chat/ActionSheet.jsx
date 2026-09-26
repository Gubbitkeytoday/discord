import React, { useRef } from 'react';
import {
  Reply, Pencil, Trash2, Pin, PinOff, Copy, Link2, SmilePlus, MessagesSquare, Forward, MailOpen, Flag, Megaphone
} from 'lucide-react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { useBackClose } from '../../chat/useBackClose';
import { quickReactions } from '../../chat/recentEmoji.js';
import { t } from '../../i18n/index.jsx';

/**
 * Discord-mobile / LINE style bottom sheet for one message, opened by a
 * long-press. A row of big quick reactions first (the thing people most often
 * want), then the actions as 48 px rows. Back (Android), Escape, the
 * backdrop or any action closes it.
 */
export default function ActionSheet({
  msg, isOwn, canReply, canDelete, canPin, canThread, canPublish, actions, onClose
}) {
  const ref = useFocusTrap(true, onClose);
  useBackClose(true, onClose);

  // The finger that long-pressed is still down when the sheet appears; the
  // click it sends on release must not hit the backdrop (closing the sheet)
  // or whichever action ended up under it.
  // Only a click from a fresh touch inside the sheet, or from the keyboard
  // (detail 0), counts.
  const armed = useRef(false);
  const accept = (event) => armed.current || event?.detail === 0;
  const run = (fn) => (event) => { if (!accept(event)) return; onClose(); fn(); };
  const rows = [
    canReply && { icon: Reply, label: t('chat.reply'), action: () => actions.reply(msg) },
    { icon: SmilePlus, label: t('chat.addReaction'), action: () => actions.openReactionPicker(msg) },
    isOwn && { icon: Pencil, label: t('chat.editMessage'), action: () => actions.edit(msg) },
    msg.content && { icon: Copy, label: t('chat.copyText'), action: () => actions.copyText(msg) },
    canThread && { icon: MessagesSquare, label: t('chat.createThread'), action: () => actions.createThread(msg) },
    canPin && {
      icon: msg.pinned ? PinOff : Pin,
      label: msg.pinned ? t('chat.unpinMessage') : t('chat.pinMessage'),
      action: () => actions.togglePin(msg)
    },
    canPublish && { icon: Megaphone, label: t('chat.publish'), action: () => actions.publish(msg) },
    actions.canForward && { icon: Forward, label: t('chat.forward'), action: () => actions.forward(msg) },
    { icon: MailOpen, label: t('chat.markUnread'), action: () => actions.markUnread(msg) },
    { icon: Link2, label: t('chat.copyLink'), action: () => actions.copyLink(msg) },
    !isOwn && actions.canReport && { icon: Flag, label: t('chat.reportMessage'), danger: true, action: () => actions.report(msg) },
    canDelete && { icon: Trash2, label: t('chat.deleteMessage'), danger: true, action: () => actions.remove(msg) }
  ].filter(Boolean);

  return (
    <div
      className="fixed inset-0 z-[60] flex flex-col justify-end"
      data-testid="message-action-sheet"
      onPointerDownCapture={() => { armed.current = true; }}
    >
      <button type="button" aria-label={t('common.close')} onClick={(event) => { if (accept(event)) onClose(); }} className="absolute inset-0 bg-black/50 cursor-default" tabIndex={-1} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={t('chat.messageActions')}
        className="relative bg-d-surface rounded-t-2xl shadow-2xl max-h-[85dvh] overflow-y-auto pb-[max(0.75rem,env(safe-area-inset-bottom))] overscroll-contain"
      >
        <div className="w-10 h-1 rounded-full bg-d-divider mx-auto mt-2 mb-3" aria-hidden="true" />
        <div className="flex justify-between gap-1 px-3 pb-3 border-b border-d-divider" role="group" aria-label={t('chat.quickReactions')}>
          {quickReactions(7).map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={run(() => actions.react(msg, emoji, false))}
              className="w-12 h-12 rounded-full bg-d-base hover:bg-d-hover active:scale-95 text-2xl flex items-center justify-center transition-transform"
              aria-label={t('chat.reactWith', { emoji })}
            >
              {emoji}
            </button>
          ))}
        </div>
        <ul className="py-1">
          {rows.map(({ icon: Icon, label, danger, action }) => (
            <li key={label}>
              <button
                type="button"
                onClick={run(action)}
                className={`w-full min-h-12 px-5 flex items-center gap-4 text-left text-[15px] font-medium hover:bg-d-hover focus-visible:bg-d-hover ${danger ? 'text-d-danger' : 'text-d-strong'}`}
              >
                <Icon className="w-5 h-5 shrink-0" aria-hidden="true" />
                {label}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
