import React, { useMemo, useState } from 'react';
import { X, Hash, Users, Paperclip, Loader2 } from 'lucide-react';
import { formatFullTimestamp } from '../utils/messageGrouping';
import { t } from '../i18n/index.jsx';
import { DEFAULT_AVATAR, defaultAvatar } from '../utils/avatar';
import { proxiedImageUrl } from '../utils/media';

const FALLBACK_AVATAR = DEFAULT_AVATAR;

/**
 * Discord's right-hand search results rail. Results are grouped by channel and
 * can be narrowed further without re-running the query.
 */
export default function SearchResultsPanel({
  query, results = [], channels = [], onJumpToMessage, onClose, hasMore = false, loadingMore = false, onLoadMore
}) {
  const [channelFilter, setChannelFilter] = useState('');
  const [authorFilter, setAuthorFilter] = useState('');
  const [attachmentsOnly, setAttachmentsOnly] = useState(false);

  const channelName = (id) => {
    const channel = channels.find((c) => c.id === id);
    if (!channel) return t('search.unknownChannel');
    return channel.type === 'dm' || channel.type === 'group_dm' ? `@${channel.display_name}` : `#${channel.name}`;
  };

  const authors = useMemo(() => {
    const map = new Map();
    for (const r of results) map.set(r.user_id, r.display_name || r.username);
    return [...map.entries()];
  }, [results]);

  const channelsInResults = useMemo(() => [...new Set(results.map((r) => r.channel_id))], [results]);

  const visible = useMemo(() => results.filter((r) =>
    (!channelFilter || r.channel_id === channelFilter)
    && (!authorFilter || r.user_id === authorFilter)
    && (!attachmentsOnly || (r.attachments?.length ?? 0) > 0)
  ), [results, channelFilter, authorFilter, attachmentsOnly]);

  return (
    <aside
      aria-label={t('chat.searchMessages')}
      // Beside the chat on wide screens; a sheet over it below xl, where
      // there is no room for a third column (it used to be hidden entirely).
      className="w-80 bg-d-surface border-l border-d-edge/40 flex flex-col shrink-0 max-xl:fixed max-xl:inset-y-0 max-xl:right-0 max-xl:z-50 max-xl:shadow-2xl max-sm:w-full"
    >
      <div className="h-12 px-4 border-b border-d-edge flex items-center justify-between shrink-0">
        <h2 className="text-sm font-bold text-d-strong truncate">
          {t('search.resultsCount', { count: visible.length })}
        </h2>
        <button onClick={onClose} className="text-d-text3 hover:text-d-strong" aria-label={t('common.close')}>
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="px-3 py-2 border-b border-d-edge space-y-2">
        <p className="text-[11px] text-d-text3 truncate">{t('search.for', { query })}</p>
        <div className="flex flex-wrap gap-1.5">
          <select
            value={channelFilter}
            onChange={(e) => setChannelFilter(e.target.value)}
            aria-label={t('search.filterChannel')}
            className="bg-d-base text-[11px] text-d-strong px-2 py-1 rounded border border-d-edge focus:outline-none max-w-[130px]"
          >
            <option value="">{t('search.allChannels')}</option>
            {channelsInResults.map((id) => <option key={id} value={id}>{channelName(id)}</option>)}
          </select>
          <select
            value={authorFilter}
            onChange={(e) => setAuthorFilter(e.target.value)}
            aria-label={t('search.filterAuthor')}
            className="bg-d-base text-[11px] text-d-strong px-2 py-1 rounded border border-d-edge focus:outline-none max-w-[130px]"
          >
            <option value="">{t('search.anyone')}</option>
            {authors.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
          <button
            onClick={() => setAttachmentsOnly((v) => !v)}
            aria-pressed={attachmentsOnly}
            className={`text-[11px] px-2 py-1 rounded border flex items-center gap-1 transition-colors ${
              attachmentsOnly ? 'bg-d-brand border-d-brand text-white' : 'bg-d-base border-d-edge text-d-text2'
            }`}
          >
            <Paperclip className="w-3 h-3" /> {t('search.hasFile')}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-2">
        {visible.length === 0 && <p className="text-xs text-d-text4 p-3">{t('search.noResults')}</p>}
        {visible.map((message) => (
          <button
            key={message.id}
            onClick={() => onJumpToMessage(message)}
            className="w-full text-left bg-d-base hover:bg-d-hover/60 rounded-lg p-2.5 transition-colors border border-d-divider/40"
          >
            <div className="flex items-center gap-1.5 text-[10px] text-d-text3 mb-1.5">
              {channelName(message.channel_id).startsWith('@')
                ? <Users className="w-3 h-3 shrink-0" />
                : <Hash className="w-3 h-3 shrink-0" />}
              <span className="truncate">{channelName(message.channel_id).replace(/^[#@]/, '')}</span>
              <span className="ml-auto shrink-0">{formatFullTimestamp(message.created_at)}</span>
            </div>
            <div className="flex items-start gap-2">
              <img src={proxiedImageUrl(message.avatar_url || defaultAvatar(message.user_id))} alt="" className="w-6 h-6 rounded-full object-cover shrink-0" />
              <div className="min-w-0">
                <span className="block text-xs font-semibold text-d-strong truncate">
                  {message.display_name || message.username}
                </span>
                <p className="text-xs text-d-text2 line-clamp-3 break-words whitespace-pre-wrap">
                  {message.content}
                </p>
                {message.attachments?.length > 0 && (
                  <span className="inline-flex items-center gap-1 text-[10px] text-d-text3 mt-1">
                    <Paperclip className="w-3 h-3" />
                    {t('chat.attachmentCount', { count: message.attachments.length })}
                  </span>
                )}
              </div>
            </div>
          </button>
        ))}
        {hasMore && onLoadMore && (
          <button
            type="button"
            onClick={onLoadMore}
            disabled={loadingMore}
            data-testid="search-load-more"
            className="w-full text-xs font-semibold text-d-link hover:underline disabled:opacity-60 py-2 flex items-center justify-center gap-1.5"
          >
            {loadingMore && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            {loadingMore ? t('common.loading') : t('search.loadMore')}
          </button>
        )}
      </div>
    </aside>
  );
}
