import { useCallback, useMemo, useRef } from 'react';

/**
 * Touch long-press, shared by message rows, channel rows and member rows.
 *
 * iOS Safari never fires `contextmenu` on a long-press, so anything that only
 * listens for right-click is unreachable there. This fires `onLongPress`
 * after `delay` ms of a still finger and then swallows the click that the
 * browser sends when the finger lifts — that trailing click used to toggle
 * the just-opened action bar straight back off.
 *
 *   const press = useLongPress((event) => openSheet(msg));
 *   <div {...press.handlers} onClickCapture={press.clickGuard}>
 *
 * Movement beyond `tolerance` px (a scroll) cancels. Mouse input is ignored:
 * a desktop user has hover and right-click.
 */
export function useLongPress(onLongPress, { delay = 450, tolerance = 10, skip = 'a, button, textarea, input, video, audio, [data-no-long-press]' } = {}) {
  const timer = useRef(null);
  const start = useRef(null);
  const fired = useRef(false);
  const callback = useRef(onLongPress);
  callback.current = onLongPress;

  const cancel = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = null;
    start.current = null;
  }, []);

  const handlers = useMemo(() => ({
    onPointerDown(event) {
      if (event.pointerType === 'mouse' || !event.isPrimary) return;
      if (skip && event.target.closest?.(skip)) return;
      fired.current = false;
      start.current = { x: event.clientX, y: event.clientY };
      const target = event.currentTarget;
      clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        fired.current = true;
        try { navigator.vibrate?.(10); } catch { /* not allowed */ }
        callback.current?.({ currentTarget: target, clientX: start.current?.x ?? 0, clientY: start.current?.y ?? 0 });
      }, delay);
    },
    onPointerMove(event) {
      if (!start.current) return;
      if (Math.abs(event.clientX - start.current.x) > tolerance || Math.abs(event.clientY - start.current.y) > tolerance) cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    // A long-press on Android also raises contextmenu; the sheet already
    // opened, so the native menu must not appear on top of it.
    onContextMenu(event) {
      if (fired.current) event.preventDefault();
    }
  }), [cancel, delay, tolerance, skip]);

  /** onClickCapture: eat the click that follows a long-press. */
  const clickGuard = useCallback((event) => {
    if (!fired.current) return;
    fired.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  return { handlers, clickGuard, firedRef: fired, cancel };
}
