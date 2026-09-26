import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Compass, Search, X, Link2 } from 'lucide-react';
import { t, useLocaleCode } from '../../i18n/index.jsx';
import { get, post } from '../../api';
import { EmptyState, SkeletonRows, Button, IconButton } from '../ui';
import ServerProfileCard from './ServerProfileCard.jsx';

const CATEGORIES = ['gaming', 'music', 'entertainment', 'education', 'science', 'art', 'community', 'other'];
const PAGE = 24;

/**
 * Server Discovery for this instance: servers whose admins opted in
 * (Server Settings › Overview › Server profile › "List in Discover"), with
 * search and category filters. Joining goes through the normal join rules
 * (POST /api/servers/:id/join: bans, verification level, raid protection,
 * membership screening).
 *
 * Props
 *   onJoined(detail)      after a successful join (the server detail payload)
 *   onOpenServer(id)      "Joined" card clicked
 *   onJoinWithInvite()    the "Have an invite?" shortcut (optional)
 *   onClose()             renders a close button when given (optional)
 *   onToast(msg, opts)
 */
export default function DiscoverPage({ onJoined, onOpenServer, onJoinWithInvite, onClose, onToast, className = '' }) {
  useLocaleCode();
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('');
  const [state, setState] = useState({ loading: true, servers: [], hasMore: false, error: null });
  const [joining, setJoining] = useState(null);
  const request = useRef(0);

  const load = useCallback(async ({ append = false } = {}) => {
    const seq = ++request.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    const params = new URLSearchParams({ limit: String(PAGE) });
    if (query.trim()) params.set('q', query.trim());
    if (category) params.set('category', category);
    if (append) params.set('offset', String(state.servers.length));
    try {
      const data = await get(`/api/discover?${params}`);
      if (seq !== request.current) return;
      setState((s) => ({
        loading: false, error: null, hasMore: Boolean(data.has_more),
        servers: append ? [...s.servers, ...data.servers] : data.servers
      }));
    } catch (err) {
      if (seq !== request.current) return;
      setState((s) => ({ ...s, loading: false, error: err.message }));
    }
  }, [query, category, state.servers.length]);

  // Search as you type, debounced; category changes apply at once.
  useEffect(() => {
    const timer = setTimeout(() => load(), query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [query, category]); // eslint-disable-line react-hooks/exhaustive-deps

  const join = async (profile) => {
    setJoining(profile.id);
    try {
      const detail = await post(`/api/servers/${profile.id}/join`);
      setState((s) => ({ ...s, servers: s.servers.map((x) => (x.id === profile.id ? { ...x, joined: true, member_count: x.member_count + 1 } : x)) }));
      onToast?.(t('srv.joinedServer', { name: profile.name }), { type: 'success', ttl: 2500 });
      onJoined?.(detail);
    } catch (err) {
      onToast?.(err.message, { type: 'error' });
    } finally {
      setJoining(null);
    }
  };

  return (
    <section aria-labelledby="discover-title" className={`flex-1 min-w-0 h-full overflow-y-auto bg-d-canvas ${className}`}>
      <div className="max-w-6xl mx-auto px-6 max-sm:px-4 py-6">
        <header className="flex items-start gap-3 mb-5">
          <span className="w-10 h-10 rounded-full bg-d-online/15 text-d-onlinetext flex items-center justify-center shrink-0" aria-hidden="true">
            <Compass className="w-5 h-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h1 id="discover-title" className="text-xl font-bold text-d-strong">{t('srv.discoverTitle')}</h1>
            <p className="text-sm text-d-text2">{t('srv.discoverHint')}</p>
          </div>
          {onJoinWithInvite && (
            <Button variant="secondary" size="sm" onClick={onJoinWithInvite} className="shrink-0 max-sm:hidden">
              <Link2 className="w-4 h-4" aria-hidden="true" /> {t('srv.haveInvite')}
            </Button>
          )}
          {onClose && <IconButton icon={X} label={t('common.close')} onClick={onClose} />}
        </header>

        <div className="relative mb-3">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-d-text3" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('srv.discoverSearch')}
            aria-label={t('srv.discoverSearch')}
            className="w-full min-h-11 bg-d-base text-d-strong placeholder-d-text3 rounded-md pl-9 pr-3 text-sm border border-d-edge focus:outline-none focus:border-d-brand"
          />
        </div>

        <div role="group" aria-label={t('srv.categories')} className="flex gap-2 overflow-x-auto pb-2 mb-4 -mx-1 px-1">
          {['', ...CATEGORIES].map((key) => (
            <button
              key={key || 'all'}
              type="button"
              aria-pressed={category === key}
              onClick={() => setCategory(key)}
              className={`shrink-0 min-h-8 px-3 rounded-full text-sm border transition-colors ${category === key
                ? 'bg-d-brand border-d-brand text-white'
                : 'border-d-divider text-d-text2 hover:bg-d-hover hover:text-d-strong'}`}
            >
              {key ? t(`srv.category.${key}`) : t('srv.categoryAll')}
            </button>
          ))}
        </div>

        {onJoinWithInvite && (
          <Button variant="secondary" size="md" block onClick={onJoinWithInvite} className="sm:hidden mb-4">
            <Link2 className="w-4 h-4" aria-hidden="true" /> {t('srv.haveInvite')}
          </Button>
        )}

        <p className="sr-only" role="status" aria-live="polite">
          {state.loading ? t('common.loading') : t('srv.resultsCount', { n: state.servers.length })}
        </p>

        {state.error && (
          <div role="alert" className="mb-4 rounded-md border border-d-danger/50 bg-d-danger/10 p-3 text-sm text-d-text flex items-center justify-between gap-3">
            <span>{state.error}</span>
            <Button size="sm" variant="secondary" onClick={() => load()}>{t('srv.retry')}</Button>
          </div>
        )}

        {state.loading && state.servers.length === 0 ? (
          <SkeletonRows count={4} />
        ) : state.servers.length === 0 && !state.error ? (
          <EmptyState
            art="search"
            title={query || category ? t('srv.discoverNoMatch') : t('srv.discoverEmpty')}
            body={query || category ? t('srv.discoverNoMatchHint') : t('srv.discoverEmptyHint')}
          />
        ) : (
          <ul className="grid gap-4 grid-cols-[repeat(auto-fill,minmax(min(100%,260px),1fr))]">
            {state.servers.map((profile) => (
              <li key={profile.id} className="flex">
                <ServerProfileCard
                  className="flex-1"
                  profile={profile}
                  headingLevel={2}
                  actionLabel={t('srv.join')}
                  busy={joining === profile.id}
                  onAction={() => join(profile)}
                  onOpen={onOpenServer ? () => onOpenServer(profile.id) : undefined}
                />
              </li>
            ))}
          </ul>
        )}

        {state.hasMore && (
          <div className="mt-6 flex justify-center">
            <Button variant="secondary" onClick={() => load({ append: true })} disabled={state.loading}>
              {t('srv.loadMore')}
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
