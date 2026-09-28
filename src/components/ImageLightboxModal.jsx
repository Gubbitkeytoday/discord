import React, { useState } from 'react';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { useBackClose } from '../chat/useBackClose';
import { X, Download, ExternalLink, ChevronLeft, ChevronRight } from 'lucide-react';
import { t } from '../i18n/index.jsx';
import { proxiedImageUrl } from '../utils/media';

const BTN = 'p-2 min-w-10 min-h-10 pointer-coarse:min-w-11 pointer-coarse:min-h-11 hover:bg-d-hover2 rounded-lg text-gray-200 hover:text-white transition flex items-center justify-center gap-1.5 text-xs font-medium';

/**
 * Full-size image viewer. With `images` (a message's gallery) it pages with
 * ←/→, the on-screen arrows or a swipe. Escape, Back (Android) or a click on
 * the backdrop closes it.
 */
export default function ImageLightboxModal({ imageUrl, altText, images = null, startIndex = 0, onClose }) {
  const dialogRef = useFocusTrap(Boolean(imageUrl), onClose);
  useBackClose(Boolean(imageUrl), onClose);
  const list = images?.length ? images : [{ url: imageUrl, alt: altText }];
  const [index, setIndex] = useState(() => Math.min(Math.max(0, startIndex), list.length - 1));
  const [touchX, setTouchX] = useState(null);

  if (!imageUrl) return null;
  const current = list[index] ?? list[0];
  const paged = list.length > 1;
  const go = (delta) => setIndex((i) => (i + delta + list.length) % list.length);

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={current.alt || t('files.openOriginal')}
      className="fixed inset-0 z-50 bg-black/85 backdrop-blur-md flex flex-col items-center justify-center p-4 animate-in fade-in duration-200"
      onClick={onClose}
      onKeyDown={(e) => {
        if (!paged) return;
        if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
      }}
      onTouchStart={(e) => setTouchX(e.touches[0]?.clientX ?? null)}
      onTouchEnd={(e) => {
        if (!paged || touchX === null) return;
        const dx = (e.changedTouches[0]?.clientX ?? touchX) - touchX;
        if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
        setTouchX(null);
      }}
      data-no-swipe
    >
      <div
        className="absolute top-[max(1rem,env(safe-area-inset-top))] right-4 flex items-center gap-2 bg-d-sunken/80 p-1.5 rounded-xl border border-d-surface/50"
        onClick={(e) => e.stopPropagation()}
      >
        {paged && <span className="text-xs text-gray-200 px-2 tabular-nums" aria-live="polite">{index + 1} / {list.length}</span>}
        <a href={current.url} target="_blank" rel="noopener noreferrer" className={BTN} title={t('files.openOriginal')}>
          <ExternalLink className="w-4 h-4" aria-hidden="true" />
          <span className="max-sm:sr-only">{t('files.openOriginal')}</span>
        </a>
        <a href={current.url} download className={BTN} title={t('files.download')}>
          <Download className="w-4 h-4" aria-hidden="true" />
          <span className="max-sm:sr-only">{t('files.download')}</span>
        </a>
        <button type="button" onClick={onClose} aria-label={t('common.close')} className={`${BTN} hover:bg-d-dangerhover`} title={t('files.closeEsc')}>
          <X className="w-5 h-5" aria-hidden="true" />
        </button>
      </div>

      {paged && (
        <>
          <button type="button" onClick={(e) => { e.stopPropagation(); go(-1); }} aria-label={t('files.previousImage')}
            className="absolute left-2 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-black/80">
            <ChevronLeft className="w-6 h-6" aria-hidden="true" />
          </button>
          <button type="button" onClick={(e) => { e.stopPropagation(); go(1); }} aria-label={t('files.nextImage')}
            className="absolute right-2 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-black/60 text-white flex items-center justify-center hover:bg-black/80">
            <ChevronRight className="w-6 h-6" aria-hidden="true" />
          </button>
        </>
      )}

      <div className="max-w-[90vw] max-h-[85vh] flex flex-col items-center justify-center relative" onClick={(e) => e.stopPropagation()}>
        <img
          key={current.url}
          src={proxiedImageUrl(current.url)}
          alt={current.alt || t('files.expandedAttachment')}
          decoding="async"
          className="max-w-full max-h-[85vh] object-contain rounded-lg shadow-2xl border border-white/10"
        />
        {current.alt && (
          <p className="mt-3 text-xs text-gray-200 bg-black/60 px-3 py-1 rounded-full border border-gray-800">
            {current.alt}
          </p>
        )}
      </div>
    </div>
  );
}
