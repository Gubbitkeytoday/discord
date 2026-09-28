import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { X, ZoomIn } from 'lucide-react';
import { t } from '../../i18n/index.jsx';
import { useDialog } from '../settings/primitives';
import { Button } from '../ui';
import { filePreviewUrl } from '../../utils/media';

/** GIF and animated WebP cannot go through a canvas without losing frames. */
export async function isAnimatedFile(file) {
  if (!file) return false;
  if (file.type === 'image/gif') return true;
  if (file.type !== 'image/webp') return false;
  try {
    const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
    // VP8X chunk with the animation flag (bit 1 of the flags byte).
    const text = String.fromCharCode(...head.slice(12, 16));
    return text === 'VP8X' && (head[20] & 0x02) === 0x02;
  } catch { return false; }
}

/**
 * Crop an image to a fixed aspect before upload: drag (or arrow keys) to pan,
 * slider (or +/−) to zoom, preview is the frame itself. Static images are
 * re-encoded to `outputWidth` wide WebP; animated ones keep every frame and
 * are uploaded as they are (centred), which the dialog says up front.
 *
 * onConfirm(File) receives what to upload.
 */
export default function ImageCropDialog({ file, aspect = 16 / 9, outputWidth = 1920, title, onCancel, onConfirm }) {
  const dialogRef = useDialog(onCancel);
  const frameRef = useRef(null);
  const [src, setSrc] = useState(null);
  const [natural, setNatural] = useState(null);   // { w, h }
  const [frame, setFrame] = useState({ w: 480, h: 270 });
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [animated, setAnimated] = useState(false);
  const [busy, setBusy] = useState(false);
  const drag = useRef(null);
  const zoomId = useId();

  useEffect(() => {
    const url = filePreviewUrl(file);
    setSrc(url);
    isAnimatedFile(file).then(setAnimated);
    return () => { if (url) URL.revokeObjectURL(url); };
  }, [file]);

  useEffect(() => {
    const el = frameRef.current;
    if (!el) return undefined;
    const measure = () => setFrame({ w: el.clientWidth, h: el.clientWidth / aspect });
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [aspect]);

  const scale = natural ? Math.max(frame.w / natural.w, frame.h / natural.h) * zoom : 1;
  const clamp = useCallback((pos, s = scale) => {
    if (!natural) return pos;
    const dw = natural.w * s;
    const dh = natural.h * s;
    return {
      x: Math.min(0, Math.max(frame.w - dw, pos.x)),
      y: Math.min(0, Math.max(frame.h - dh, pos.y))
    };
  }, [natural, frame, scale]);

  // Centre on load and whenever the frame or zoom changes.
  useEffect(() => {
    if (!natural) return;
    const dw = natural.w * scale;
    const dh = natural.h * scale;
    setOffset((o) => clamp(drag.current?.moved ? o : { x: (frame.w - dw) / 2, y: (frame.h - dh) / 2 }));
  }, [natural, frame.w, frame.h]); // eslint-disable-line react-hooks/exhaustive-deps

  const setZoomKeepingCentre = (next) => {
    const z = Math.min(3, Math.max(1, next));
    if (!natural) { setZoom(z); return; }
    const base = Math.max(frame.w / natural.w, frame.h / natural.h);
    const oldS = base * zoom;
    const newS = base * z;
    // Keep the point under the frame centre fixed.
    const cx = (frame.w / 2 - offset.x) / oldS;
    const cy = (frame.h / 2 - offset.y) / oldS;
    setZoom(z);
    setOffset(clamp({ x: frame.w / 2 - cx * newS, y: frame.h / 2 - cy * newS }, newS));
  };

  const onPointerDown = (e) => {
    if (animated) return;
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, start: offset, moved: true };
  };
  const onPointerMove = (e) => {
    if (!drag.current?.start) return;
    setOffset(clamp({ x: drag.current.start.x + e.clientX - drag.current.x, y: drag.current.start.y + e.clientY - drag.current.y }));
  };
  const onPointerUp = () => { if (drag.current) drag.current = { moved: true }; };

  const onKeyDown = (e) => {
    if (animated) return;
    const step = e.shiftKey ? 40 : 10;
    const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[e.key]) {
      e.preventDefault();
      drag.current = { moved: true };
      setOffset((o) => clamp({ x: o.x + moves[e.key][0], y: o.y + moves[e.key][1] }));
    } else if (e.key === '+' || e.key === '=') { e.preventDefault(); setZoomKeepingCentre(zoom + 0.1); }
    else if (e.key === '-') { e.preventDefault(); setZoomKeepingCentre(zoom - 0.1); }
  };

  const confirm = async () => {
    if (animated || !natural) { onConfirm(file); return; }
    setBusy(true);
    try {
      const img = new Image();
      img.src = src;
      await img.decode();
      const outW = Math.min(outputWidth, Math.round(frame.w / scale));
      const outH = Math.round(outW / aspect);
      const canvas = document.createElement('canvas');
      canvas.width = outW;
      canvas.height = outH;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, -offset.x / scale, -offset.y / scale, frame.w / scale, frame.h / scale, 0, 0, outW, outH);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9));
      const out = blob ?? await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      const name = `${(file.name || 'image').replace(/\.[^.]+$/, '')}.${out.type === 'image/webp' ? 'webp' : 'png'}`;
      onConfirm(new File([out], name, { type: out.type }));
    } catch {
      onConfirm(file);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[95] bg-black/70 flex items-center justify-center p-4 overlay-center">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-xl bg-d-canvas rounded-lg shadow-2xl border border-d-divider"
      >
        <header className="flex items-center justify-between px-4 py-3 border-b border-d-divider">
          <h2 className="text-base font-semibold text-d-strong">{title}</h2>
          <button type="button" onClick={onCancel} aria-label={t('common.close')}
            className="w-8 h-8 rounded flex items-center justify-center text-d-text2 hover:bg-d-hover hover:text-d-strong">
            <X className="w-4 h-4" />
          </button>
        </header>
        <div className="p-4 space-y-3">
          <div
            ref={frameRef}
            tabIndex={0}
            role="img"
            aria-label={animated ? t('srv.cropAnimated') : t('srv.cropFrame')}
            aria-describedby={`${zoomId}-help`}
            onKeyDown={onKeyDown}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            className={`relative w-full overflow-hidden rounded-md bg-d-base2 select-none touch-none ${animated ? '' : 'cursor-move'}`}
            style={{ aspectRatio: String(aspect) }}
          >
            {src && (
              <img
                src={src}
                alt=""
                draggable={false}
                onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
                className={animated ? 'absolute inset-0 w-full h-full object-cover' : 'absolute top-0 left-0 max-w-none'}
                style={animated || !natural ? undefined : {
                  width: natural.w * scale, height: natural.h * scale,
                  transform: `translate(${offset.x}px, ${offset.y}px)`
                }}
              />
            )}
          </div>
          <p id={`${zoomId}-help`} className="text-[11px] text-d-text2">
            {animated ? t('srv.cropAnimatedHint') : t('srv.cropHint')}
          </p>
          {!animated && (
            <label htmlFor={zoomId} className="flex items-center gap-3 text-sm text-d-text2">
              <ZoomIn className="w-4 h-4 shrink-0" aria-hidden="true" />
              <span className="sr-only">{t('srv.zoom')}</span>
              <input
                id={zoomId}
                type="range" min={1} max={3} step={0.05} value={zoom}
                onChange={(e) => setZoomKeepingCentre(Number(e.target.value))}
                aria-valuetext={`${Math.round(zoom * 100)}%`}
                className="flex-1 accent-[var(--color-d-brand)]"
              />
            </label>
          )}
        </div>
        <footer className="flex justify-end gap-2 px-4 py-3 border-t border-d-divider">
          <Button variant="link" onClick={onCancel}>{t('common.cancel')}</Button>
          <Button onClick={confirm} disabled={busy || !src}>{t('srv.applyImage')}</Button>
        </footer>
      </div>
    </div>
  );
}
