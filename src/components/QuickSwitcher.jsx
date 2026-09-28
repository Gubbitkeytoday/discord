import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Hash, Volume2, AtSign, Server, Megaphone, MessagesSquare } from 'lucide-react';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { t, useLocaleCode } from '../i18n/index.jsx';
import { DEFAULT_AVATAR, serverIconOf } from '../utils/avatar';
import { proxiedImageUrl } from '../utils/media';
import { MentionBadge } from './ui';
import { recordRecentDestination, getRecentDestinations } from './server/recentDestinations';
import { channelEmojiOf } from './server/ChannelEmojiIcon.jsx';
import { rankSwitcherEntries } from '../utils/switcherRank.js';

const FALLBACK_AVATAR = DEFAULT_AVATAR;
const CHANNEL_ICONS = { voice: Volume2, stage: Volume2, announcement: Megaphone, forum: MessagesSquare, thread: MessagesSquare };

// Discord's switcher prefixes narrow the search to one kind.
const PREFIXES = { '*': 'server', '#': 'text', '@': 'dm', '!': 'voice' };

/**
 * Ctrl+K / Cmd+K jump-to-anything palette, across every server you are in.
 *
 * WAI-ARIA combobox: the input keeps focus and points at the highlighted
 * option with aria-activedescendant; ↑/↓ move, Enter jumps, Escape closes
 * and focus returns to where it was. `*` servers, `#` text channels,
 * `@` people, `!` voice channels. With an empty query it shows Recent
 * destinations (prefs.layout.recentDestinations), then Unread, with mention
 * counts as red badges; results are grouped under headers.
 */
export default function QuickSwitcher({
  channels = [], dms = [], servers = [], readStates = {}, activeChannelId = null,
  onPick, onClose, onPrefetch, onOpen
}) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef(null);
  const dialogRef = useFocusTrap(true, onClose);
  const listRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); onOpen?.(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const serverName = useMemo(() => new Map(servers.map((s) => [s.id, s.name])), [servers]);

  const locale = useLocaleCode();
  const entries = useMemo(() => {
    const unreadScore = (id) => {
      const state = readStates[id];
      if (state?.mention_count > 0) return 2;
      return state?.unread ? 1 : 0;
    };
    const mentionsOf = (id) => Number(readStates[id]?.mention_count) || 0;
    // A server's badge rolls up its channels, as the server rail does.
    const serverRoll = new Map();
    for (const c of channels) {
      if (!c.server_id) continue;
      const roll = serverRoll.get(c.server_id) ?? { unread: 0, mentions: 0 };
      roll.unread = Math.max(roll.unread, unreadScore(c.id));
      roll.mentions += mentionsOf(c.id);
      serverRoll.set(c.server_id, roll);
    }
    return [
      ...channels
        .filter((c) => c.type !== 'category')
        .map((c) => ({
          key: `c-${c.id}`, kind: c.type === 'voice' || c.type === 'stage' ? 'voice' : 'text', id: c.id,
          serverId: c.server_id,
          label: c.name,
          hint: [serverName.get(c.server_id), c.category].filter(Boolean).join(' · '),
          icon: CHANNEL_ICONS[c.type] ?? Hash,
          emoji: channelEmojiOf(c)?.kind === 'unicode' ? c.icon_emoji : null,
          unread: unreadScore(c.id),
          mentions: mentionsOf(c.id)
        })),
      ...dms.map((d) => ({
        key: `d-${d.id}`, kind: 'dm', id: d.id,
        label: d.display_name, hint: t('dm.directMessages'),
        avatar: d.avatar_url, icon: AtSign, unread: unreadScore(d.id), mentions: mentionsOf(d.id)
      })),
      ...servers.map((s) => ({
        key: `s-${s.id}`, kind: 'server', id: s.id,
        label: s.name, hint: t('switcher.server'),
        avatar: serverIconOf(s), icon: Server,
        unread: serverRoll.get(s.id)?.unread ?? 0, mentions: serverRoll.get(s.id)?.mentions ?? 0
      }))
    ];
  }, [channels, dms, servers, readStates, serverName, activeChannelId, locale]); // eslint-disable-line react-hooks/exhaustive-deps

  // Sections: with no query, Recent then Unread (or Suggestions when both
  // are empty); with a query, one list of best matches.
  const sections = useMemo(() => {
    const raw = query.trim();
    const kind = PREFIXES[raw[0]] ?? null;
    const q = (kind ? raw.slice(1) : raw).trim().toLowerCase();
    const pool = kind ? entries.filter((e) => e.kind === kind) : entries;
    if (!q) {
      const byId = new Map(pool.map((e) => [e.id, e]));
      const recent = getRecentDestinations()
        .map((d) => byId.get(d.id))
        .filter((e) => e && e.id !== activeChannelId)
        .slice(0, 5);
      const seen = new Set(recent.map((e) => e.key));
      const unread = pool
        .filter((e) => e.unread > 0 && !seen.has(e.key) && e.id !== activeChannelId)
        .sort((a, b) => b.unread - a.unread || b.mentions - a.mentions)
        .slice(0, 8);
      const out = [];
      if (recent.length) out.push({ key: 'recent', title: t('srv.switcherRecent'), items: recent });
      if (unread.length) out.push({ key: 'unread', title: t('srv.switcherUnread'), items: unread });
      if (!out.length) out.push({ key: 'suggested', title: t('srv.switcherSuggested'), items: pool.filter((e) => e.id !== activeChannelId).slice(0, 12) });
      return out;
    }
    const items = rankSwitcherEntries(pool, q, { activeId: activeChannelId });
    return items.length ? [{ key: 'results', title: t('switcher.results'), items }] : [];
  }, [entries, query, activeChannelId, locale]); // eslint-disable-line react-hooks/exhaustive-deps

  const results = useMemo(() => sections.flatMap((section) => section.items), [sections]);

  const pick = (entry) => {
    recordRecentDestination({ kind: entry.kind, id: entry.id });
    onPick(entry);
  };

  useEffect(() => { setIndex(0); }, [query]);
  useEffect(() => {
    listRef.current?.querySelector(`#qs-${index}`)?.scrollIntoView({ block: 'nearest' });
    const entry = results[index];
    if (entry && entry.kind !== 'server') onPrefetch?.(entry.id);
  }, [index, results, onPrefetch]);

  const onKeyDown = (e) => {
    const n = Math.max(results.length, 1);
    if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => (i + 1) % n); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => (i - 1 + n) % n); }
    else if (e.key === 'Home' && e.ctrlKey) { e.preventDefault(); setIndex(0); }
    else if (e.key === 'End' && e.ctrlKey) { e.preventDefault(); setIndex(n - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); if (results[index]) pick(results[index]); }
  };

  const expanded = results.length > 0;

  return (
    <div className="fixed inset-0 z-[90] bg-black/60 flex items-start justify-center pt-[12vh] px-4" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('switcher.ariaLabel')}
        className="w-full max-w-xl bg-d-surface rounded-lg shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-3 border-b border-d-edge">
          <label htmlFor="qs-input" className="text-xs font-semibold text-d-text2 block mb-1.5">{t('switcher.title')}</label>
          <input
            ref={inputRef}
            id="qs-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t('switcher.placeholder')}
            role="combobox"
            aria-expanded={expanded}
            aria-controls="qs-list"
            aria-activedescendant={expanded ? `qs-${index}` : undefined}
            aria-autocomplete="list"
            aria-describedby="qs-help"
            autoComplete="off"
            spellCheck={false}
            className="w-full bg-d-base text-d-strong text-base placeholder-d-text3 rounded px-3 py-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-d-brand"
          />
        </div>

        <div ref={listRef} id="qs-list" role="listbox" aria-label={t('switcher.results')} className="max-h-80 overflow-y-auto py-1">
          {results.length === 0 && (
            <p className="px-4 py-6 text-center text-sm text-d-text3" role="status">{t('switcher.nothingFound')}</p>
          )}

          {sections.map((section) => {
            const offset = results.indexOf(section.items[0]);
            return (
              <div key={section.key} role="group" aria-labelledby={`qs-h-${section.key}`}>
                <div id={`qs-h-${section.key}`} role="presentation" className="px-4 pt-2 pb-1 text-[11px] font-bold uppercase tracking-wide text-d-text2">
                  {section.title}
                </div>
                {section.items.map((entry, j) => {
                  const i = offset + j;
                  return (
                    <div
                      key={entry.key}
                      id={`qs-${i}`}
                      role="option"
                      aria-selected={i === index}
                      tabIndex={-1}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => pick(entry)}
                      onMouseEnter={() => setIndex(i)}
                      className={`w-full flex items-center gap-2.5 px-4 min-h-10 pointer-coarse:min-h-12 text-left cursor-pointer transition-colors ${
                        i === index ? 'bg-d-active' : 'hover:bg-d-hover'
                      }`}
                    >
                      {entry.avatar ? (
                        <img src={proxiedImageUrl(entry.avatar || FALLBACK_AVATAR)} alt="" width={24} height={24} className="w-6 h-6 rounded-full object-cover shrink-0" />
                      ) : entry.emoji ? (
                        <span className="w-5 text-center text-base leading-none shrink-0" aria-hidden="true">{entry.emoji}</span>
                      ) : (
                        <entry.icon className="w-5 h-5 text-d-text3 shrink-0" aria-hidden="true" />
                      )}
                      <span className={`text-sm truncate ${entry.unread ? 'text-d-strong font-bold' : 'text-d-strong font-medium'}`}>{entry.label}</span>
                      {entry.mentions > 0 ? (
                        <MentionBadge count={entry.mentions} className="shrink-0" />
                      ) : entry.unread > 0 ? (
                        <>
                          <span className="sr-only">{t('a11y.unread')}</span>
                          <span className="w-2 h-2 rounded-full shrink-0 bg-d-strong" aria-hidden="true" />
                        </>
                      ) : null}
                      {Boolean(entry.hint) && (
                        <span className={`text-xs truncate ml-auto pl-2 ${i === index ? 'text-d-text2' : 'text-d-text3'}`}>{entry.hint}</span>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>

        <div id="qs-help" className="px-4 py-2 border-t border-d-edge text-[11px] text-d-text3 flex flex-wrap gap-x-3 gap-y-1">
          <span>{t('switcher.prefixHint')}</span>
          <span>{t('switcher.navigate')}</span><span>{t('switcher.jump')}</span><span>{t('switcher.dismiss')}</span>
        </div>
      </div>
    </div>
  );
}
