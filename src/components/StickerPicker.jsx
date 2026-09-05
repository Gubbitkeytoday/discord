import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Sticker } from 'lucide-react';
import { t } from '../i18n/index.jsx';

/** The composer's sticker tray. Sends immediately on click, as Discord does. */
export default function StickerPicker({ stickers = [], onPick, onClose }) {
  const [filter, setFilter] = useState('');
  const ref = useRef(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    const onClick = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    window.addEventListener('keydown', onKey);
    const timer = setTimeout(() => window.addEventListener('mousedown', onClick), 0);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClick);
      clearTimeout(timer);
    };
  }, [onClose]);

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return stickers;
    return stickers.filter((s) =>
      s.name.toLowerCase().includes(needle) || (s.tags ?? '').toLowerCase().includes(needle));
  }, [stickers, filter]);

  return (
    <div ref={ref} className="w-72 bg-d-sunken border border-d-surface rounded-lg shadow-2xl overflow-hidden">
      <div className="p-2 border-b border-d-surface relative">
        <Search className="w-3.5 h-3.5 text-d-text4 absolute left-4 top-1/2 -translate-y-1/2" />
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder={t('stickers.search')}
          autoFocus
          className="w-full bg-d-base text-xs text-d-strong pl-7 pr-2 py-1.5 rounded focus:outline-none"
        />
      </div>

      <div className="p-2 max-h-64 overflow-y-auto">
        {visible.length === 0 ? (
          <div className="py-8 text-center text-xs text-d-text4 space-y-2">
            <Sticker className="w-6 h-6 mx-auto opacity-50" />
            <p>{stickers.length === 0 ? t('stickers.none') : t('common.noResults')}</p>
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-2">
            {visible.map((sticker) => (
              <button
                key={sticker.id}
                onClick={() => { onPick(sticker); onClose(); }}
                title={sticker.name}
                className="aspect-square rounded-lg bg-d-base hover:bg-d-hover p-1.5 transition-colors"
              >
                <img src={sticker.url} alt={sticker.name} className="w-full h-full object-contain" loading="lazy" />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
