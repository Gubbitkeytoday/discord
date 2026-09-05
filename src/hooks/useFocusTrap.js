import { useEffect, useRef } from 'react';

const FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]:not([tabindex="-1"])',
  'video[controls]', 'audio[controls]', '[contenteditable="true"]'
].join(',');

/**
 * Keep keyboard focus inside a modal while it is open.
 *
 * Without this, Tab walks out of the dialog into the page behind it — the
 * content is visually covered but still reachable, which is disorienting with a
 * screen reader and outright broken for keyboard-only use.
 *
 * Also restores focus to whatever was focused before the modal opened.
 *
 * @param active whether the trap should be engaged
 * @param onEscape optional Escape handler; the trap swallows the event
 * @returns a ref to attach to the dialog container
 */
export function useFocusTrap(active = true, onEscape) {
  const containerRef = useRef(null);
  const previouslyFocused = useRef(null);

  useEffect(() => {
    if (!active) return undefined;
    const container = containerRef.current;
    if (!container) return undefined;

    previouslyFocused.current = document.activeElement;

    const focusable = () =>
      [...container.querySelectorAll(FOCUSABLE)].filter(
        (el) => el.offsetParent !== null || el === document.activeElement
      );

    // Move focus in. Prefer the first field over the first button, so opening a
    // form does not land on "Cancel".
    const initial = container.querySelector('input, textarea, select') ?? focusable()[0];
    initial?.focus?.();

    const onKeyDown = (event) => {
      if (event.key === 'Escape' && onEscape) {
        event.preventDefault();
        event.stopPropagation();
        onEscape();
        return;
      }
      if (event.key !== 'Tab') return;

      const items = focusable();
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;

      // Wrap at both ends, and pull focus back in if it escaped somehow.
      if (event.shiftKey && (current === first || !container.contains(current))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (current === last || !container.contains(current))) {
        event.preventDefault();
        first.focus();
      }
    };

    // A click outside can also move focus out; pull it back.
    const onFocusIn = (event) => {
      if (!container.contains(event.target)) {
        const items = focusable();
        items[0]?.focus();
      }
    };

    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('focusin', onFocusIn);

    // Hide the rest of the page from assistive tech while the modal is open.
    const root = document.getElementById('root');
    const hadAriaHidden = root?.getAttribute('aria-hidden');
    if (root && !root.contains(container)) root.setAttribute('aria-hidden', 'true');

    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('focusin', onFocusIn);
      if (root) {
        if (hadAriaHidden === null) root.removeAttribute('aria-hidden');
        else root.setAttribute('aria-hidden', hadAriaHidden);
      }
      previouslyFocused.current?.focus?.();
    };
  }, [active, onEscape]);

  return containerRef;
}
