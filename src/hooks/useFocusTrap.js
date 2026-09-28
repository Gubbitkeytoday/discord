import { useEffect, useRef } from 'react';

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
  'video[controls]', 'audio[controls]', '[contenteditable="true"]'
].join(',');

/* --- Escape layers ----------------------------------------------------------
 * Escape closes the *top-most* layer only. Every dialog / popover registers a
 * layer; one window-level capture listener (window runs before document and
 * before any element handler) calls just the most recently opened one. Without
 * this, pressing Escape in a confirm box opened from Server Settings closed
 * Server Settings as well.
 * ------------------------------------------------------------------------- */
const escapeLayers = [];

function onLayerKeyDown(event) {
  if (event.key !== 'Escape' || escapeLayers.length === 0) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  escapeLayers[escapeLayers.length - 1].current?.();
}

/**
 * Register an Escape handler as a layer. The handler is read through a ref, so
 * callers can pass inline arrows without re-registering (and reordering) the
 * layer on every render.
 */
export function useEscapeLayer(onEscape, active = true) {
  const handler = useRef(onEscape);
  handler.current = onEscape;
  useEffect(() => {
    if (!active) return undefined;
    const layer = { get current() { return handler.current; } };
    escapeLayers.push(layer);
    if (escapeLayers.length === 1) window.addEventListener('keydown', onLayerKeyDown, true);
    return () => {
      const index = escapeLayers.lastIndexOf(layer);
      if (index !== -1) escapeLayers.splice(index, 1);
      if (escapeLayers.length === 0) window.removeEventListener('keydown', onLayerKeyDown, true);
    };
  }, [active]);
}

/* --- focus traps ------------------------------------------------------------
 * Traps stack too: only the top trap reacts to Tab / focusin. Otherwise a
 * dialog opened from another dialog (rendered as a sibling) fights the outer
 * trap for focus forever.
 * ------------------------------------------------------------------------- */
const trapStack = [];

/**
 * Keep keyboard focus inside a modal while it is open, move focus in on open,
 * restore it on close, and hide the page behind from assistive tech.
 *
 * The effect depends on `active` only. `onEscape` is held in a ref: callers
 * pass inline arrows, and when it was a dependency every parent re-render (an
 * incoming message is enough) tore the trap down and re-ran it, yanking focus
 * back to the first field mid-typing.
 *
 * @param active   whether the trap is engaged
 * @param onEscape optional Escape handler, registered as an Escape layer
 * @returns a ref to attach to the dialog container
 */
export function useFocusTrap(active = true, onEscape) {
  const containerRef = useRef(null);
  const hasEscape = typeof onEscape === 'function';
  useEscapeLayer(onEscape, active && hasEscape);

  useEffect(() => {
    if (!active) return undefined;
    const container = containerRef.current;
    if (!container) return undefined;

    const previouslyFocused = document.activeElement;
    const token = { container };
    trapStack.push(token);
    const isTop = () => trapStack[trapStack.length - 1] === token;

    const focusable = () =>
      [...container.querySelectorAll(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null || el === document.activeElement
      );

    // Move focus in — unless something inside already has it (autoFocus).
    // Prefer the first field over the first button, so opening a form does not
    // land on "Cancel". `data-initial-focus` (on the container or inside it)
    // overrides that, e.g. a profile popout whose only field is a side note.
    if (!container.contains(document.activeElement)) {
      const marked = container.matches('[data-initial-focus]') ? container : container.querySelector('[data-initial-focus]');
      const initial = marked ?? container.querySelector('input, textarea, select') ?? focusable()[0];
      if (initial) initial.focus?.();
      else {
        if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1');
        container.focus?.();
      }
    }

    const onKeyDown = (event) => {
      if (event.key !== 'Tab' || !isTop()) return;
      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      if (event.shiftKey && (current === first || !container.contains(current))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (current === last || !container.contains(current))) {
        event.preventDefault();
        first.focus();
      }
    };

    // A click outside can also move focus out; pull it back — top trap only.
    const onFocusIn = (event) => {
      if (!isTop() || container.contains(event.target)) return;
      // Toasts and other live regions outside the dialog are fine to click.
      if (event.target.closest?.('[data-focus-trap-ignore]')) return;
      focusable()[0]?.focus();
    };

    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn);

    const root = document.getElementById('root');
    const hadAriaHidden = root?.getAttribute('aria-hidden');
    if (root && !root.contains(container)) root.setAttribute('aria-hidden', 'true');

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn);
      const index = trapStack.indexOf(token);
      if (index !== -1) trapStack.splice(index, 1);
      if (root) {
        if (hadAriaHidden === null || hadAriaHidden === undefined) root.removeAttribute('aria-hidden');
        else root.setAttribute('aria-hidden', hadAriaHidden);
      }
      if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus?.();
    };
  }, [active]);

  return containerRef;
}

/**
 * Light-dismiss for popovers and menus: Escape (as a layer) and a mousedown
 * outside `ref` both call `onClose`. `onClose` is read through a ref so inline
 * handlers do not re-register the listeners on every render — which used to
 * open a window where an outside click was missed.
 */
export function useDismiss(ref, onClose, { active = true } = {}) {
  const handler = useRef(onClose);
  handler.current = onClose;
  useEscapeLayer(() => handler.current?.(), active);
  useEffect(() => {
    if (!active) return undefined;
    const onClick = (e) => { if (!ref.current?.contains(e.target)) handler.current?.(); };
    // Deferred so the click that opened the popover does not immediately close it.
    const timer = setTimeout(() => window.addEventListener('mousedown', onClick), 0);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('mousedown', onClick);
    };
  }, [active, ref]);
}
