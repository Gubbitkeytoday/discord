import React, { memo, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { buildSrcSet, placeholderUrl } from '../../utils/responsiveImage';
import { isAnimatedImage } from '../StillImage';
import { t } from '../../i18n/index.jsx';

/** Grid columns and the tile that spans two rows, Discord-style mosaic. */
function layoutFor(count) {
  if (count === 2) return { cols: 'grid-cols-2', tall: -1 };
  if (count === 3) return { cols: 'grid-cols-2', tall: 0 };
  if (count === 4) return { cols: 'grid-cols-2', tall: -1 };
  return { cols: 'grid-cols-3', tall: -1 };
}

function Tile({ att, onOpen, tall, autoplayGifs }) {
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const animated = isAnimatedImage({ url: att.url, mimetype: att.mimetype, filename: att.filename, animated: att.is_animated });
  const srcSet = !animated ? buildSrcSet(att, 'webp') : undefined;
  const placeholder = placeholderUrl(att);
  const label = att.description || att.filename || t('files.expandedAttachment');
  return (
    <li className={`relative overflow-hidden rounded-md bg-d-surface bg-cover bg-center ${tall ? 'row-span-2 aspect-[1/2]' : 'aspect-square'}`}
      style={placeholder ? { backgroundImage: `url("${placeholder}")` } : undefined}>
      {failed ? (
        <button type="button" onClick={() => { setFailed(false); setAttempt((n) => n + 1); }}
          className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-xs font-semibold text-d-text2 bg-d-surface/90">
          <RotateCcw className="w-4 h-4" aria-hidden="true" /> {t('chat.tapToReload')}
          <span className="sr-only">{label}</span>
        </button>
      ) : (
        <button type="button" onClick={onOpen} className="absolute inset-0 w-full h-full" aria-label={label}>
          <img
            key={attempt}
            src={attempt ? `${att.url}${att.url.includes('?') ? '&' : '?'}retry=${attempt}` : att.url}
            {...(srcSet && !attempt ? { srcSet, sizes: '(max-width: 640px) 45vw, 200px' } : {})}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setFailed(true)}
            className={`w-full h-full object-cover hover:opacity-90 transition-opacity ${!autoplayGifs && animated ? '' : ''}`}
          />
        </button>
      )}
    </li>
  );
}

/**
 * Several images in one message as a mosaic (up to 10), opening the
 * lightbox on the clicked one with paging through the rest.
 */
function ImageGallery({ images, onOpenImage, autoplayGifs = true }) {
  const shown = images.slice(0, 10);
  const { cols, tall } = layoutFor(shown.length);
  const list = shown.map((att) => ({ url: att.url, alt: att.description || att.filename || '' }));
  return (
    <ul className={`grid ${cols} gap-1 max-w-[26rem] w-full`} aria-label={t('chat.attachmentCount', { count: shown.length })}>
      {shown.map((att, i) => (
        <Tile
          key={att.id ?? att.url}
          att={att}
          tall={i === tall}
          autoplayGifs={autoplayGifs}
          onOpen={() => onOpenImage?.(att.url, list[i].alt, { images: list, index: i })}
        />
      ))}
    </ul>
  );
}

export default memo(ImageGallery);
