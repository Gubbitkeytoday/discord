import React from 'react';
import { Pin, X } from 'lucide-react';
import { formatFullTimestamp } from '../utils/messageGrouping';
import { t } from '../i18n/index.jsx';
import { DEFAULT_AVATAR } from '../utils/avatar';

const FALLBACK_AVATAR = DEFAULT_AVATAR;

/** Discord's pinned-messages popover, anchored under the pin icon. */
export default function PinnedMessagesPopover({ messages = [], canUnpin = true, onClose, onJump, onUnpin }) {
  return (
    <>
      {/* Click-away layer, so the popover closes like Discord's does. */}
      <div className="fixed inset-0 z-30" onClick={onClose} />

      <div className="absolute right-4 top-12 w-96 max-h-[70vh] bg-d-surface border border-d-edge rounded-lg shadow-2xl z-40 flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-d-edge flex items-center justify-between shrink-0">
          <span className="text-sm font-bold text-d-strong flex items-center gap-2">
            <Pin className="w-4 h-4" /> {t('chat.pinnedMessages')}
          </span>
          <button onClick={onClose} className="text-d-text3 hover:text-d-strong transition-colors">
            <X className="w-4 h-4" />
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
                  src={msg.avatar_url || FALLBACK_AVATAR}
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
                    <span className="text-[10px] text-d-text3 shrink-0">
                      {formatFullTimestamp(msg.created_at)}
                    </span>
                  </div>
                  <p className="text-xs text-d-text mt-0.5 break-words whitespace-pre-wrap line-clamp-3">
                    {msg.content}
                  </p>
                  {msg.attachments?.length > 0 && (
                    <span className="text-[10px] text-d-text3 mt-1 inline-block">
                      📎 {t('chat.attachmentCount', { count: msg.attachments.length })}
                    </span>
                  )}
                </div>
              </div>

              <div className="absolute right-2 top-2 hidden group-hover:flex gap-1">
                <button
                  onClick={() => onJump?.(msg)}
                  className="text-[10px] bg-d-brand hover:bg-d-brandhover text-white px-2 py-0.5 rounded transition-colors"
                >
                  {t('chat.jumpToMessage')}
                </button>
                {canUnpin && (
                  <button
                    onClick={() => onUnpin?.(msg)}
                    className="text-[10px] bg-d-control hover:bg-d-danger text-white px-2 py-0.5 rounded transition-colors"
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
