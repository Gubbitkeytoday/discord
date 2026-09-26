import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ZoomIn, ZoomOut, Crop } from 'lucide-react';
import { useDialog } from '../settings/primitives';
import { t } from '../../i18n/index.jsx';

const SHAPES = {
  avatar: { w: 260, h: 260, outW: 512, outH: 512, round: true },
  banner: { w: 320, h: 128, outW: 1200, outH: 480, round: false }
};

/** GIF / WebP may be animated; cropping on a canvas would freeze them. */
export const mayBeAnimated = (file) => /image\/(gif|webp|apng)/i.test(file?.type ?? '');

/**
 * Crop an avatar (circle) or banner (5:2) on the client, with pointer drag,
 * arrow keys (nudge), +/- (zoom) and a zoom slider. Output is a PNG/WebP
 * Blob at a fixed size. For a file that may be animated, "Keep animation"
 * uploads the original untouched instead.
 *
 * Stable API: <CropDialog file={File} kind="avatar"|"banner" onCancel onDone={(blob|null) => …} />
 *   onDone(null) means "use the original file as is".
 */
export default function CropDialog({ file, kind = 'avatar', onCancel, onDone }) {
  const shape = SHAPES[kind] ?? SHAPES.avatar;
  const dialogRef = useDialog(onCancel);
  const titleId = useId();
  const [src, setSrc] = useState(null);
  const [natural, setNatural] = useState(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [busy, setBusy] = useState(false);
  const drag = useRef(null);
  const imgRef = useRef(null);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // The scale at zoom 1 makes the image just cover the crop box.
  const base = natural ? Math.max(shape.w / natural.w, shape.h / natural.h) : 1;
  const scale = base * zoom;

  const clamp = useCallback((pos, z = zoom) => {
    if (!natural) return pos;
    const s = base * z;
    const maxX = Math.max(0, (natural.w * s - shape.w) / 2);
    const maxY = Math.max(0, (natural.h * s - shape.h) / 2);
    return { x: Math.min(maxX, Math.max(-maxX, pos.x)), y: Math.min(maxY, Math.max(-maxY, pos.y)) };
  }, [natural, base, zoom, shape.w, shape.h]);

  const setZoomClamped = (z) => {
    const next = Math.min(4, Math.max(1, z));
    setZoom(next);
    setOffset((o) => clamp(o, next));
  };

  const onPointerDown = (e) => {
    e.currentTarget.setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, start: offset };
  };
  const onPointerMove = (e) => {
    if (!drag.current) return;
    const { x, y, start } = drag.current;
    setOffset(clamp({ x: start.x + (e.clientX - x), y: start.y + (e.clientY - y) }));
  };
  const onPointerUp = () => { drag.current = null; };
  const onKeyDown = (e) => {
    const step = e.shiftKey ? 30 : 8;
    const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    if (moves[e.key]) {
      e.preventDefault();
      setOffset((o) => clamp({ x: o.x + moves[e.key][0], y: o.y + moves[e.key][1] }));
    } else if (e.key === '+' || e.key === '=') { e.preventDefault(); setZoomClamped(zoom + 0.1); }
    else if (e.key === '-') { e.preventDefault(); setZoomClamped(zoom - 0.1); }
  };

  const apply = async () => {
    if (!natural || !imgRef.current) return;
    setBusy(true);
    try {
      // Source rectangle under the crop box, in image pixels.
      const sw = shape.w / scale;
      const sh = shape.h / scale;
      const sx = natural.w / 2 - offset.x / scale - sw / 2;
      const sy = natural.h / 2 - offset.y / scale - sh / 2;
      const canvas = document.createElement('canvas');
      canvas.width = shape.outW;
      canvas.height = shape.outH;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(imgRef.current, sx, sy, sw, sh, 0, 0, shape.outW, shape.outH);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.92))
        ?? await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      onDone(blob);
    } finally {
      setBusy(false);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[90] flex items-center justify-center overlay-center bg-black/70 p-4">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId}
        className="w-full max-w-md rounded-xl bg-d-canvas p-5 shadow-2xl">
        <h2 id={titleId} className="flex items-center gap-2 text-lg font-bold text-d-strong">
          <Crop className="h-5 w-5" aria-hidden="true" />
          {kind === 'banner' ? t('profiles.cropBanner') : t('profiles.cropAvatar')}
        </h2>
        <p className="mt-1 text-sm text-d-text2">{t('profiles.cropHint')}</p>

        <div className="mt-4 flex justify-center">
          <div
            role="application"
            tabIndex={0}
            aria-label={t('profiles.cropArea')}
            onKeyDown={onKeyDown}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onWheel={(e) => setZoomClamped(zoom - Math.sign(e.deltaY) * 0.1)}
            className="relative cursor-grab touch-none overflow-hidden bg-black focus:outline-none focus-visible:ring-2 focus-visible:ring-d-brand active:cursor-grabbing"
            style={{ width: shape.w, height: shape.h, maxWidth: '100%', borderRadius: shape.round ? 12 : 8 }}
          >
            {src && (
              <img
                ref={imgRef}
                src={src}
                alt=""
                draggable="false"
                onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
                className="pointer-events-none absolute left-1/2 top-1/2 max-w-none select-none"
                style={natural ? {
                  width: natural.w * scale,
                  height: natural.h * scale,
                  transform: `translate(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px))`
                } : { opacity: 0 }}
              />
            )}
            {shape.round && (
              <span aria-hidden="true" className="pointer-events-none absolute inset-0"
                style={{ boxShadow: `0 0 0 ${shape.w}px rgb(0 0 0 / 0.55)`, borderRadius: '50%' }} />
            )}
          </div>
        </div>

        <div className="mt-4 flex items-center gap-3">
          <button type="button" onClick={() => setZoomClamped(zoom - 0.2)} aria-label={t('profiles.zoomOut')}
            className="flex h-9 w-9 items-center justify-center rounded text-d-text2 hover:bg-d-hover hover:text-d-strong">
            <ZoomOut className="h-4 w-4" aria-hidden="true" />
          </button>
          <input type="range" min="1" max="4" step="0.01" value={zoom} aria-label={t('profiles.zoom')}
            onChange={(e) => setZoomClamped(Number(e.target.value))} className="flex-1 accent-[var(--color-d-brand)]" />
          <button type="button" onClick={() => setZoomClamped(zoom + 0.2)} aria-label={t('profiles.zoomIn')}
            className="flex h-9 w-9 items-center justify-center rounded text-d-text2 hover:bg-d-hover hover:text-d-strong">
            <ZoomIn className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        {mayBeAnimated(file) && <p className="mt-3 text-xs text-d-text3">{t('profiles.cropAnimatedHint')}</p>}

        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onCancel}
            className="min-h-9 rounded px-4 text-sm font-medium text-d-text hover:underline">{t('common.cancel')}</button>
          <button type="button" onClick={() => onDone(null)}
            className="min-h-9 rounded bg-d-surface px-4 text-sm font-semibold text-d-strong hover:bg-d-hover">
            {mayBeAnimated(file) ? t('profiles.keepAnimation') : t('profiles.useOriginal')}
          </button>
          <button type="button" onClick={apply} disabled={!natural || busy}
            className="min-h-9 rounded bg-d-brand px-4 text-sm font-semibold text-white hover:bg-d-brandhover disabled:opacity-50">
            {t('profiles.applyCrop')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
