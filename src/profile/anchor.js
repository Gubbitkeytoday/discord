// Where a profile popout should appear: next to the thing that opened it.
//
// Callers can pass an explicit `anchorRect`; otherwise the element the
// person last clicked (or activated with the keyboard) is used, as long as it
// happened a moment ago and is still on screen.

let last = { el: null, at: 0 };

function remember(event) {
  const el = event.target?.closest?.('button, [role="button"], a, img, [data-user-id], li, [tabindex]') ?? event.target;
  if (el && el.nodeType === 1) last = { el, at: Date.now() };
}

if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', remember, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') remember(e); }, true);
}

/** The rect of the recent trigger, or null. */
export function recentAnchorRect(maxAgeMs = 2000) {
  if (!last.el || Date.now() - last.at > maxAgeMs || !last.el.isConnected) return null;
  const rect = last.el.getBoundingClientRect();
  if (!rect.width && !rect.height) return null;
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height };
}

/**
 * Position a `width`×`height` popout beside `rect`, inside the viewport with
 * an 8px margin: to the right of the anchor when there is room, else to its
 * left; vertically aligned with it and clamped.
 */
export function placePopout(rect, width, height, viewport = { w: window.innerWidth, h: window.innerHeight }) {
  const m = 8;
  if (!rect) return { left: Math.max(m, (viewport.w - width) / 2), top: Math.max(m, (viewport.h - height) / 2) };
  let left = rect.right + m;
  if (left + width > viewport.w - m) left = rect.left - width - m;
  if (left < m) left = Math.min(Math.max(m, rect.left), viewport.w - width - m);
  let top = rect.top;
  if (top + height > viewport.h - m) top = viewport.h - height - m;
  return { left: Math.round(left), top: Math.round(Math.max(m, top)) };
}
