import React, { useMemo, useRef, useState } from 'react';
import { Star, Upload, ImageOff } from 'lucide-react';
import { useDismiss } from '../../hooks/useFocusTrap';
import { t } from '../../i18n/index.jsx';

const FAVORITES_KEY = 'antigravity.favoriteGifs';

function loadFavorites() {
  try {
    const list = JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((g) => g?.url) : [];
  } catch { return []; }
}
function saveFavorites(list) {
  try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(list.slice(0, 60))); } catch { /* private mode */ }
}

/** Is this attachment a GIF (or another animated image)? */
export function isGifAttachment(att) {
  return Boolean(att?.url) && (/image\/gif/i.test(att.mimetype ?? '') || /\.gif(\?|#|$)/i.test(att.filename ?? att.url) || att.is_animated);
}

/**
 * The composer's GIF tray. This server keeps no third-party GIF search (no
 * request leaves the instance), so the tray offers what people actually
 * reuse: GIFs you starred, GIFs recently posted in this conversation, and
 * uploading one from the device. Picking sends it right away, like Discord.
 */
export default function GifPicker({ getRecent, onPick, onUpload, onClose }) {
  const ref = useRef(null);
  useDismiss(ref, onClose);
  const [tab, setTab] = useState(() => (loadFavorites().length ? 'favorites' : 'recent'));
  const [favorites, setFavorites] = useState(loadFavorites);
  const recent = useMemo(() => getRecent?.() ?? [], [getRecent]);
  const list = tab === 'favorites' ? favorites : recent;
  const isFavorite = (gif) => favorites.some((f) => f.url === gif.url);

  const toggleFavorite = (gif) => {
    const next = isFavorite(gif) ? favorites.filter((f) => f.url !== gif.url) : [gif, ...favorites];
    setFavorites(next);
    saveFavorites(next);
  };

  return (
    <div ref={ref} role="dialog" aria-label={t('gif.title')} className="w-[min(22rem,calc(100vw-1rem))] bg-d-surface border border-d-edge rounded-lg shadow-2xl overflow-hidden flex flex-col">
      <div className="flex items-center gap-1 p-2 border-b border-d-edge" role="tablist" aria-label={t('gif.title')}>
        {[['favorites', t('gif.favorites')], ['recent', t('gif.recent')]].map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={tab === key}
            onClick={() => setTab(key)}
            className={`px-3 min-h-9 rounded text-sm font-medium ${tab === key ? 'bg-d-active text-d-strong' : 'text-d-text2 hover:bg-d-hover'}`}
          >
            {label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => { onUpload?.(); onClose(); }}
          className="ml-auto inline-flex items-center gap-1.5 px-3 min-h-9 rounded text-sm font-medium text-d-text2 hover:bg-d-hover hover:text-d-strong"
        >
          <Upload className="w-4 h-4" aria-hidden="true" /> {t('gif.upload')}
        </button>
      </div>
      <div className="p-2 max-h-72 overflow-y-auto" role="tabpanel">
        {list.length === 0 ? (
          <div className="py-8 text-center text-sm text-d-text3 space-y-2">
            <ImageOff className="w-6 h-6 mx-auto opacity-60" aria-hidden="true" />
            <p>{tab === 'favorites' ? t('gif.noFavorites') : t('gif.noRecent')}</p>
          </div>
        ) : (
          <ul className="grid grid-cols-2 gap-2">
            {list.map((gif) => (
              <li key={gif.url} className="relative group">
                <button
                  type="button"
                  onClick={() => { onPick(gif); onClose(); }}
                  className="block w-full aspect-video rounded overflow-hidden bg-d-base hover:ring-2 hover:ring-d-brand focus-visible:ring-2 focus-visible:ring-d-brand"
                  aria-label={t('gif.send', { name: gif.filename ?? 'GIF' })}
                >
                  <img src={gif.url} alt="" loading="lazy" decoding="async" className="w-full h-full object-cover" />
                </button>
                <button
                  type="button"
                  onClick={() => toggleFavorite(gif)}
                  aria-pressed={isFavorite(gif)}
                  aria-label={isFavorite(gif) ? t('gif.unfavorite') : t('gif.favorite')}
                  className="absolute top-1 right-1 w-8 h-8 rounded-full bg-black/60 text-white inline-flex items-center justify-center"
                >
                  <Star className={`w-4 h-4 ${isFavorite(gif) ? 'fill-current text-d-idle' : ''}`} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
