import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Hash, Volume2, AtSign, Server, Megaphone, MessagesSquare } from 'lucide-react';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { t, useLocaleCode } from '../i18n/index.jsx';
import { DEFAULT_AVATAR, serverIconOf } from '../utils/avatar';
import { proxiedImageUrl } from '../utils/media';

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
 * `@` people, `!` voice channels. With an empty query, unread and
 * mentioned conversations come first.
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
    return [
      ...channels
        .filter((c) => c.type !== 'category' && c.id !== activeChannelId)
        .map((c) => ({
          key: `c-${c.id}`, kind: c.type === 'voice' || c.type === 'stage' ? 'voice' : 'text', id: c.id,
          serverId: c.server_id,
          label: c.name,
          hint: [serverName.get(c.server_id), c.category].filter(Boolean).join(' · '),
          icon: CHANNEL_ICONS[c.type] ?? Hash,
          unread: unreadScore(c.id)
        })),
      ...dms.filter((d) => d.id !== activeChannelId).map((d) => ({
        key: `d-${d.id}`, kind: 'dm', id: d.id,
        label: d.display_name, hint: t('dm.directMessages'),
        avatar: d.avatar_url, icon: AtSign, unread: unreadScore(d.id)
      })),
      ...servers.map((s) => ({
        key: `s-${s.id}`, kind: 'server', id: s.id,
        label: s.name, hint: t('switcher.server'),
        avatar: serverIconOf(s), icon: Server, unread: 0
      }))
    ];
  }, [channels, dms, servers, readStates, serverName, activeChannelId, locale]); // eslint-disable-line react-hooks/exhaustive-deps

  const results = useMemo(() => {
    const raw = query.trim();
    const kind = PREFIXES[raw[0]] ?? null;
    const q = (kind ? raw.slice(1) : raw).trim().toLowerCase();
    const pool = kind ? entries.filter((e) => e.kind === kind) : entries;
    if (!q) {
      return [...pool]
        .sort((a, b) => b.unread - a.unread)
        .slice(0, 12);
    }
    return pool
      .map((entry) => {
        const label = entry.label?.toLowerCase() ?? '';
        if (label.startsWith(q)) return { entry, score: 0 };
        if (label.split(/[\s_-]+/).some((word) => word.startsWith(q))) return { entry, score: 1 };
        if (label.includes(q)) return { entry, score: 2 };
        return null;
      })
      .filter(Boolean)
      .sort((a, b) => a.score - b.score || b.entry.unread - a.entry.unread)
      .slice(0, 20)
      .map((r) => r.entry);
  }, [entries, query]);

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
    else if (e.key === 'Enter') { e.preventDefault(); if (results[index]) onPick(results[index]); }
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

          {results.map((entry, i) => (
            <div
              key={entry.key}
              id={`qs-${i}`}
              role="option"
              aria-selected={i === index}
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onPick(entry)}
              onMouseEnter={() => setIndex(i)}
              className={`w-full flex items-center gap-2.5 px-4 min-h-10 pointer-coarse:min-h-12 text-left cursor-pointer transition-colors ${
                i === index ? 'bg-d-active' : 'hover:bg-d-hover'
              }`}
            >
              {entry.avatar ? (
                <img src={proxiedImageUrl(entry.avatar || FALLBACK_AVATAR)} alt="" width={24} height={24} className="w-6 h-6 rounded-full object-cover shrink-0" />
              ) : (
                <entry.icon className="w-5 h-5 text-d-text3 shrink-0" aria-hidden="true" />
              )}
              <span className={`text-sm truncate ${entry.unread ? 'text-d-strong font-bold' : 'text-d-strong font-medium'}`}>{entry.label}</span>
              {entry.unread === 2 && <span className="sr-only">{t('a11y.mentioned')}</span>}
              {entry.unread === 1 && <span className="sr-only">{t('a11y.unread')}</span>}
              {entry.unread > 0 && <span className={`w-2 h-2 rounded-full shrink-0 ${entry.unread === 2 ? 'bg-d-danger' : 'bg-d-strong'}`} aria-hidden="true" />}
              {Boolean(entry.hint) && (
                <span className={`text-xs truncate ml-auto pl-2 ${i === index ? 'text-d-text2' : 'text-d-text3'}`}>{entry.hint}</span>
              )}
            </div>
          ))}
        </div>

        <div id="qs-help" className="px-4 py-2 border-t border-d-edge text-[11px] text-d-text3 flex flex-wrap gap-x-3 gap-y-1">
          <span>{t('switcher.prefixHint')}</span>
          <span>{t('switcher.navigate')}</span><span>{t('switcher.jump')}</span><span>{t('switcher.dismiss')}</span>
        </div>
      </div>
    </div>
  );
}
