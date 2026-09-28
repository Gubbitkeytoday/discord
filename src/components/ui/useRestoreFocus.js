import { useEffect } from 'react';

/**
 * For non-modal popovers (menus, the inbox): remember what had focus when the
 * popover opened and give focus back to it when the popover closes — but only
 * if focus is still inside the popover or was dropped on <body>. Otherwise a
 * keyboard user who opened a menu with Enter lands at the top of the page.
 */
export default function useRestoreFocus(ref) {
  useEffect(() => {
    const opener = document.activeElement;
    return () => {
      const now = document.activeElement;
      const lost = !now || now === document.body || ref.current?.contains(now);
      if (lost && opener && opener !== document.body && opener.isConnected) {
        // After React has removed the popover from the DOM.
        requestAnimationFrame(() => { try { opener.focus({ preventScroll: true }); } catch { /* detached */ } });
      }
    };
  }, [ref]);
}
