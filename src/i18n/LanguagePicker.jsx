import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, Globe, Loader2, Search, ChevronDown } from 'lucide-react';
import { useI18n } from './index.jsx';

/** Accent- and case-insensitive text for matching "espanol" to "Español". */
const fold = (text) => String(text).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

function filterLocales(locales, query) {
  const q = fold(query.trim());
  if (!q) return locales;
  return locales.filter((l) => [l.nativeName, l.englishName, l.code].some((s) => fold(s).includes(q)));
}

function CompletenessBadge({ value, intlLocale }) {
  if (value === null || value === undefined) return null;
  const label = new Intl.NumberFormat(intlLocale, { style: 'percent', maximumFractionDigits: 0 }).format(value / 100);
  const tone = value >= 95 ? 'text-d-success border-d-success/40'
    : value >= 60 ? 'text-d-idle border-d-idle/40'
    : 'text-d-text3 border-d-divider';
  return (
    <span className={`shrink-0 rounded border px-1.5 py-px text-[11px] tabular-nums ${tone}`}>{label}</span>
  );
}

/**
 * Settings → Appearance → Language. Searchable, native name first (people look
 * for their own language in its own script), English name second, and a
 * completeness badge so a half-translated locale is not a surprise.
 */
export function LanguageList() {
  const { locale, setLocale, availableLocales, switchingTo, intlLocale, t } = useI18n();
  const [query, setQuery] = useState('');
  const visible = useMemo(() => filterLocales(availableLocales, query), [availableLocales, query]);

  return (
    <div>
      {availableLocales.length > 8 && (
        <div className="relative mb-2">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-d-text3" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('common.search')}
            aria-label={t('common.search')}
            className="w-full rounded-md border border-d-divider bg-d-input py-2 pl-8 pr-3 text-sm text-d-text
              placeholder:text-d-text3 focus:border-d-brand focus:outline-none"
          />
        </div>
      )}
      <div
        role="radiogroup"
        aria-label={t('appearance.language')}
        className="grid max-h-[420px] grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2"
      >
        {visible.map((entry) => {
          const selected = locale === entry.code;
          return (
            <button
              key={entry.code}
              type="button"
              role="radio"
              aria-checked={selected}
              lang={entry.intl}
              dir={entry.dir}
              onClick={() => setLocale(entry.code)}
              className={`flex items-center gap-3 rounded-lg border px-3 py-2 text-left text-sm transition-colors
                focus:outline-none focus-visible:ring-2 focus-visible:ring-d-brand
                ${selected
                  ? 'border-d-brand bg-d-brand/10 text-d-strong'
                  : 'border-d-divider bg-d-surface text-d-text2 hover:border-d-control hover:text-d-strong'}`}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{entry.nativeName}</span>
                <span className="block truncate text-xs text-d-text3" lang="en">{entry.englishName}</span>
              </span>
              <CompletenessBadge value={entry.completeness} intlLocale={intlLocale} />
              {switchingTo === entry.code
                ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-d-text3" aria-hidden="true" />
                : selected && <Check className="h-4 w-4 shrink-0 text-d-brand" aria-hidden="true" />}
            </button>
          );
        })}
        {visible.length === 0 && (
          <p className="px-1 py-3 text-sm text-d-text3">{t('common.noResults')}</p>
        )}
      </div>
    </div>
  );
}

/** Compact globe dropdown for screens without settings, e.g. sign-in. */
export function LanguageMenu({ className = '' }) {
  const { locale, setLocale, availableLocales, switchingTo, t } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef(null);
  const listId = useId();
  const current = availableLocales.find((l) => l.code === locale);
  const visible = useMemo(() => filterLocales(availableLocales, query), [availableLocales, query]);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event) => { if (!rootRef.current?.contains(event.target)) setOpen(false); };
    const onKey = (event) => { if (event.key === 'Escape') setOpen(false); };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (availableLocales.length < 2) return null;

  return (
    <div ref={rootRef} className={className || 'relative'}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-label={`${t('appearance.language')}: ${current?.nativeName ?? locale}`}
        className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm text-d-text2 hover:bg-d-hover hover:text-d-strong
          focus:outline-none focus-visible:ring-2 focus-visible:ring-d-brand"
      >
        {switchingTo
          ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          : <Globe className="h-4 w-4" aria-hidden="true" />}
        <span>{current?.nativeName ?? locale}</span>
        <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-1 w-64 rounded-lg border border-d-divider bg-d-canvas p-1.5 shadow-2xl">
          {availableLocales.length > 8 && (
            <input
              type="search"
              value={query}
              autoFocus
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('common.search')}
              aria-label={t('common.search')}
              className="mb-1 w-full rounded border border-d-divider bg-d-input px-2 py-1.5 text-sm text-d-text
                placeholder:text-d-text3 focus:border-d-brand focus:outline-none"
            />
          )}
          <ul id={listId} role="listbox" aria-label={t('appearance.language')} className="max-h-72 overflow-y-auto">
            {visible.map((entry) => (
              <li
                key={entry.code}
                role="option"
                aria-selected={entry.code === locale}
                tabIndex={0}
                lang={entry.intl}
                onClick={() => { setLocale(entry.code); setOpen(false); }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setLocale(entry.code); setOpen(false); }
                }}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-d-text2
                  hover:bg-d-hover hover:text-d-strong focus:bg-d-hover focus:outline-none"
              >
                <span className="min-w-0 flex-1 truncate">{entry.nativeName}</span>
                <span className="shrink-0 text-xs text-d-text3" lang="en">{entry.englishName}</span>
                {entry.code === locale && <Check className="h-3.5 w-3.5 shrink-0 text-d-brand" aria-hidden="true" />}
              </li>
            ))}
            {visible.length === 0 && <li className="px-2 py-1.5 text-sm text-d-text3">{t('common.noResults')}</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
