import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Hash, Volume2, AtSign, Server } from 'lucide-react';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { t } from '../i18n/index.jsx';
import { DEFAULT_AVATAR } from '../utils/avatar';

const FALLBACK_AVATAR = DEFAULT_AVATAR;

/**
 * Ctrl+K / Cmd+K jump-to-anything palette.
 *
 * Scores by prefix match first, then substring, so typing "gen" puts
 * #general-chat above #memes-and-general — the ordering users expect.
 */
export default function QuickSwitcher({
  channels = [], dms = [], servers = [], onPick, onClose
}) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef(null);
  const dialogRef = useFocusTrap(true, onClose);
  const listRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const entries = useMemo(() => [
    ...channels
      .filter((c) => c.type !== 'category')
      .map((c) => ({
        key: `c-${c.id}`, kind: 'channel', id: c.id,
        label: c.name, hint: c.category ?? '',
        icon: c.type === 'voice' ? Volume2 : Hash
      })),
    ...dms.map((d) => ({
      key: `d-${d.id}`, kind: 'dm', id: d.id,
      label: d.display_name, hint: t('dm.directMessages'),
      avatar: d.avatar_url, icon: AtSign
    })),
    ...servers.map((s) => ({
      key: `s-${s.id}`, kind: 'server', id: s.id,
      label: s.name, hint: t('autocomplete.serverEmoji'),
      avatar: s.icon_url, icon: Server
    }))
  ], [channels, dms, servers]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^[#@]/, '');
    // Empty query shows a recent-ish default rather than nothing.
    if (!q) return entries.slice(0, 12);

    return entries
      .map((entry) => {
        const label = entry.label?.toLowerCase() ?? '';
        if (label.startsWith(q)) return { entry, score: 0 };
        if (label.includes(q)) return { entry, score: 1 };
        return null;
      })
      .filter(Boolean)
      .sort((a, b) => a.score - b.score)
      .slice(0, 12)
      .map((r) => r.entry);
  }, [entries, query]);

  useEffect(() => { setIndex(0); }, [query]);

  useEffect(() => {
    listRef.current?.children?.[index]?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => (i + 1) % Math.max(results.length, 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => (i - 1 + results.length) % Math.max(results.length, 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (results[index]) onPick(results[index]); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };

  return (
    <div className="fixed inset-0 z-[90] bg-black/60 flex items-start justify-center pt-[15vh] px-4" onClick={onClose}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('switcher.ariaLabel')}
        className="w-full max-w-xl bg-d-surface rounded-lg shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-3 border-b border-d-edge">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={t('switcher.placeholder')}
            className="w-full bg-transparent text-d-strong text-base placeholder-d-text4 focus:outline-none"
          />
        </div>

        <div ref={listRef} className="max-h-80 overflow-y-auto py-1">
          {results.length === 0 && (
            <p className="px-4 py-6 text-center text-sm text-d-text3">{t('switcher.nothingFound')}</p>
          )}

          {results.map((entry, i) => (
            <button
              key={entry.key}
              onMouseDown={(e) => { e.preventDefault(); onPick(entry); }}
              onMouseEnter={() => setIndex(i)}
              className={`w-full flex items-center gap-2.5 px-4 py-2 text-left transition-colors ${
                i === index ? 'bg-d-active' : 'hover:bg-d-hover'
              }`}
            >
              {entry.avatar ? (
                <img src={entry.avatar || FALLBACK_AVATAR} alt="" className="w-6 h-6 rounded-full object-cover shrink-0" />
              ) : (
                <entry.icon className="w-5 h-5 text-d-text4 shrink-0" />
              )}
              <span className="text-sm text-d-strong font-medium truncate">{entry.label}</span>
              {entry.hint && (
                <span className="text-[11px] text-d-text3 truncate ml-auto pl-2">{entry.hint}</span>
              )}
            </button>
          ))}
        </div>

        <div className="px-4 py-2 border-t border-d-edge text-[10px] text-d-text4 flex gap-3">
          <span>{t('switcher.navigate')}</span><span>{t('switcher.jump')}</span><span>{t('switcher.dismiss')}</span>
        </div>
      </div>
    </div>
  );
}
