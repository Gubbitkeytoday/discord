import React, { memo, useEffect, useState } from 'react';
import { FileText, Download, RotateCcw } from 'lucide-react';
import StillImage, { isAnimatedImage } from '../StillImage';
import { imgProps, placeholderUrl } from '../../utils/responsiveImage';
import { proxiedImageUrl } from '../../utils/media';
import { t } from '../../i18n/index.jsx';
import { RECONNECTED_EVENT } from '../../chat/events';

// The attachment slot is at most 384 CSS px wide (max-w-sm) and 90% of a
// phone's width; the browser picks the smallest rendition that fills it.
const SIZES = '(max-width: 640px) 90vw, 384px';


export { RECONNECTED_EVENT };

/**
 * Renders one attachment by its server-declared `file_type`, not by guessing
 * from the file extension — the server already sniffed the real content type.
 *
 * Images reserve their box from width/height (no layout shift), show the
 * thumbhash (or legacy blur) placeholder, load lazily from a srcset of the
 * server's renditions, and — when a load fails, typically offline — become a
 * "Tap to reload" tile that also retries on its own when the connection
 * comes back.
 */
function Attachment({
  attachment, onOpenImage, showMedia = true, showImages = true,
  spoilerMode = 'click', isOwn = false, safetyHold = false, autoplayGifs = true, eager = false
}) {
  const att = typeof attachment === 'string'
    ? { url: attachment, filename: attachment.split('/').pop(), file_type: 'file' }
    : attachment;

  // Text & Images › spoilers: reveal on click, reveal your own, or always.
  const spoilerOpen = (!att.is_spoiler
    || spoilerMode === 'always'
    || (spoilerMode === 'owned' && isOwn)) && !safetyHold;
  const [revealed, setRevealed] = useState(spoilerOpen);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!failed) return undefined;
    const retry = () => { setFailed(false); setAttempt((n) => n + 1); };
    window.addEventListener('online', retry);
    window.addEventListener(RECONNECTED_EVENT, retry);
    return () => {
      window.removeEventListener('online', retry);
      window.removeEventListener(RECONNECTED_EVENT, retry);
    };
  }, [failed]);

  // "Show media inline" off, or image previews off: fall through to the link row.
  const inlineAllowed = showMedia && (att.file_type !== 'image' || showImages);

  if (att.file_type === 'image' && inlineAllowed) {
    const ratio = att.width && att.height ? att.width / att.height : null;
    const animated = isAnimatedImage({ url: att.url, mimetype: att.mimetype, filename: att.filename, animated: att.is_animated });
    const animate = autoplayGifs || !animated;
    const responsive = imgProps(att, { sizes: SIZES, eager });
    const placeholder = placeholderUrl(att);
    const cacheBust = attempt ? `${att.url.includes('?') ? '&' : '?'}retry=${attempt}` : '';
    const label = att.description || att.filename || t('files.expandedAttachment');

    return (
      <div
        className="relative rounded-lg overflow-hidden bg-d-surface bg-cover bg-center max-w-full sm:max-w-sm"
        style={{
          backgroundImage: placeholder ? `url("${placeholder}")` : undefined,
          aspectRatio: ratio ? String(ratio) : undefined,
          maxHeight: '18rem',
          width: att.width ? Math.min(att.width, 384) : undefined
        }}
      >
        {failed ? (
          <button
            type="button"
            onClick={() => { setFailed(false); setAttempt((n) => n + 1); }}
            className="absolute inset-0 w-full h-full min-h-24 min-w-40 flex flex-col items-center justify-center gap-1.5 bg-d-surface/90 text-d-text2 hover:text-d-strong text-xs font-semibold border border-d-divider rounded-lg"
          >
            <RotateCcw className="w-5 h-5" aria-hidden="true" />
            {t('chat.tapToReload')}
            <span className="sr-only">{label}</span>
          </button>
        ) : (
          <StillImage
            key={attempt}
            src={`${att.url}${cacheBust}`}
            animate={animate}
            alt={label}
            width={att.width || undefined}
            height={att.height || undefined}
            // A still GIF shows its captured first frame; a srcset would win
            // over that src, so only animated-or-static-as-is images get one.
            {...(animate && !animated && responsive.srcSet && !attempt ? { srcSet: responsive.srcSet, sizes: SIZES } : {})}
            loading={eager ? 'eager' : 'lazy'}
            decoding="async"
            fetchPriority={eager ? 'high' : undefined}
            onError={() => setFailed(true)}
            onClick={() => (revealed ? onOpenImage?.(att.url, label) : setRevealed(true))}
            className={`w-full h-full max-h-72 rounded-lg object-cover border border-d-surface cursor-pointer transition-transform ${
              revealed ? 'hover:scale-[1.01]' : 'blur-2xl'
            }`}
          />
        )}
        {!revealed && !failed && (
          <span className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-xs font-bold text-white bg-black/40 rounded-lg pointer-events-none px-3 text-center">
            {safetyHold ? t('privacy.mediaFromStranger') : t('chat.spoiler')}
            <span className="text-[11px] font-normal opacity-90">{t('chat.clickToReveal')}</span>
          </span>
        )}
      </div>
    );
  }

  if (att.file_type === 'video' && inlineAllowed) {
    return (
      <video
        src={att.url}
        controls
        preload="metadata"
        poster={proxiedImageUrl(att.poster_url ?? att.variants?.poster?.url)}
        width={att.width || undefined}
        height={att.height || undefined}
        className="max-w-full sm:max-w-md max-h-72 rounded-lg border border-d-surface bg-black"
      />
    );
  }

  if (att.file_type === 'audio' && inlineAllowed) {
    return (
      <div className="bg-d-surface p-3 rounded-lg border border-d-divider flex flex-col gap-2 max-w-sm w-full">
        <span className="text-xs text-d-text2 font-medium truncate">{att.filename}</span>
        <audio src={att.url} controls preload="none" className="w-full h-8" />
      </div>
    );
  }

  return (
    <a
      href={att.download_url ?? att.url}
      download={att.filename}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-3 bg-d-surface hover:bg-d-hover p-3 rounded-lg border border-d-divider text-d-strong text-xs transition-colors max-w-full"
    >
      <FileText className="w-6 h-6 text-d-brand shrink-0" aria-hidden="true" />
      <div className="flex flex-col min-w-0">
        <span className="font-medium truncate max-w-[180px]">{att.filename}</span>
        <span className="text-[11px] text-d-text3">{att.size_human ?? t('files.clickToDownload')}</span>
      </div>
      <Download className="w-4 h-4 text-d-text3 ml-auto shrink-0" aria-hidden="true" />
    </a>
  );
}

export default memo(Attachment);
