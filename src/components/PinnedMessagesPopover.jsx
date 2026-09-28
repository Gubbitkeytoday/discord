import React, { useEffect, useRef } from 'react';
import { useEscapeLayer } from '../hooks/useFocusTrap';
import { Pin, X } from 'lucide-react';
import { formatFullTimestamp } from '../utils/messageGrouping';
import { t } from '../i18n/index.jsx';
import { DEFAULT_AVATAR, defaultAvatar } from '../utils/avatar';
import { proxiedImageUrl } from '../utils/media';

const FALLBACK_AVATAR = DEFAULT_AVATAR;

/** Discord's pinned-messages popover, anchored under the pin icon. */
export default function PinnedMessagesPopover({ messages = [], canUnpin = true, onClose, onJump, onUnpin }) {
  useEscapeLayer(onClose);
  const ref = useRef(null);
  // Focus moves into the popover when it opens and back when it closes.
  useEffect(() => {
    const returnTo = document.activeElement;
    ref.current?.focus();
    return () => { if (returnTo?.isConnected) returnTo.focus?.({ preventScroll: true }); };
  }, []);
  return (
    <>
      {/* Click-away layer, so the popover closes like Discord's does. */}
      <div className="fixed inset-0 z-30" onClick={onClose} />

      <div
        ref={ref}
        role="dialog"
        aria-labelledby="pins-title"
        tabIndex={-1}
        className="absolute right-4 max-sm:right-2 top-12 w-96 max-w-[calc(100vw-1rem)] max-h-[70vh] bg-d-surface border border-d-edge rounded-lg shadow-2xl z-40 flex flex-col overflow-hidden outline-none"
      >
        <div className="px-4 py-2 border-b border-d-edge flex items-center justify-between shrink-0">
          <h2 id="pins-title" className="text-sm font-bold text-d-strong flex items-center gap-2">
            <Pin className="w-4 h-4" aria-hidden="true" /> {t('chat.pinnedMessages')}
          </h2>
          <button type="button" onClick={onClose} aria-label={t('common.close')} className="text-d-text3 hover:text-d-strong transition-colors w-8 h-8 pointer-coarse:w-11 pointer-coarse:h-11 inline-flex items-center justify-center rounded">
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-2">
          {messages.length === 0 && (
            <div className="px-4 py-8 text-center">
              <Pin className="w-10 h-10 mx-auto mb-2 text-d-control" />
              <p className="text-sm text-d-text3">{t('chat.noPinnedMessages')}</p>
              <p className="text-xs text-d-text4 mt-1">
                {t('chat.pinHint')}
              </p>
            </div>
          )}

          {messages.map((msg) => (
            <div
              key={msg.id}
              className="group bg-d-canvas hover:bg-d-hover rounded-lg p-3 transition-colors relative select-text"
            >
              <div className="flex gap-2">
                <img
                  src={proxiedImageUrl(msg.avatar_url || defaultAvatar(msg.user_id))}
                  alt=""
                  className="w-8 h-8 rounded-full object-cover shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span
                      className="text-xs font-semibold truncate"
                      style={{ color: msg.role_color || 'var(--color-d-strong)' }}
                    >
                      {msg.display_name || msg.username}
                    </span>
                    <span className="text-[11px] text-d-text3 shrink-0">
                      {formatFullTimestamp(msg.created_at)}
                    </span>
                  </div>
                  <p className="text-xs text-d-text mt-0.5 break-words whitespace-pre-wrap line-clamp-3">
                    {msg.content}
                  </p>
                  {msg.attachments?.length > 0 && (
                    <span className="text-[11px] text-d-text3 mt-1 inline-block">
                      📎 {t('chat.attachmentCount', { count: msg.attachments.length })}
                    </span>
                  )}
                </div>
              </div>

              {/* Visible on hover, on keyboard focus and always on touch. */}
              <div className="absolute right-2 top-2 flex gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 pointer-coarse:opacity-100 pointer-coarse:static pointer-coarse:mt-2 pointer-coarse:justify-end">
                <button
                  type="button"
                  onClick={() => onJump?.(msg)}
                  className="text-xs bg-d-brand hover:bg-d-brandhover text-white px-2 min-h-7 pointer-coarse:min-h-11 rounded transition-colors"
                >
                  {t('chat.jumpToMessage')}
                </button>
                {canUnpin && (
                  <button
                    type="button"
                    onClick={() => onUnpin?.(msg)}
                    className="text-xs bg-d-control hover:bg-d-danger text-white px-2 min-h-7 pointer-coarse:min-h-11 rounded transition-colors"
                  >
                    {t('chat.unpin')}
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
