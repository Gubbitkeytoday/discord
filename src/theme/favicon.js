// ============================================================================
//  Live favicon: the app mark drawn in the current theme's accent (a
//  gradient theme's own colours, a season's accent, or brand blurple), with a
//  red dot while there are unread mentions.
//
//  The unread count is read from the tab title that utils/notifier.js already
//  maintains ("(3) Antigravity", or "● …" while it flashes), so no caller has
//  to know the favicon exists. `setFaviconUnread()` is there for callers that
//  want to drive it directly.
// ============================================================================

import { isHex6 } from './color.js';

let accent = { stops: ['#5865f2'] };
let unread = 0;
let lastHref = '';
let observer = null;

const BUBBLE = 'M18 20h28a4 4 0 0 1 4 4v14a4 4 0 0 1-4 4H30l-9 7v-7h-3a4 4 0 0 1-4-4V24a4 4 0 0 1 4-4z';

/** The SVG markup for a given accent and unread state (pure; exported for tests). */
export function faviconSvg({ stops = ['#5865f2'], angle = 135 } = {}, unreadCount = 0) {
  const colours = stops.filter(isHex6).slice(0, 5);
  const list = colours.length ? colours : ['#5865f2'];
  const a = Number.isInteger(angle) ? angle : 135;
  const fill = list.length > 1 ? 'url(#g)' : list[0];
  const eye = list[0];
  const defs = list.length > 1
    ? `<defs><linearGradient id="g" gradientTransform="rotate(${a - 90} .5 .5)">${
      list.map((c, i) => `<stop offset="${(i / (list.length - 1)).toFixed(2)}" stop-color="${c}"/>`).join('')
    }</linearGradient></defs>`
    : '';
  const dot = unreadCount > 0
    ? '<circle cx="50" cy="50" r="13" fill="#f23f43" stroke="#fff" stroke-width="4"/>'
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${defs}`
    + `<rect width="64" height="64" rx="16" fill="${fill}"/>`
    + `<path d="${BUBBLE}" fill="#fff"/>`
    + `<circle cx="26" cy="31" r="3" fill="${eye}"/><circle cx="38" cy="31" r="3" fill="${eye}"/>`
    + `${dot}</svg>`;
}

function render() {
  if (typeof document === 'undefined') return;
  const href = `data:image/svg+xml,${encodeURIComponent(faviconSvg(accent, unread))}`;
  if (href === lastHref) return;
  lastHref = href;
  let link = document.querySelector('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  link.type = 'image/svg+xml';
  link.href = href;
}

/** Theme engine → favicon: `{ stops, angle }` of the active accent. */
export function setFaviconAccent(next) {
  accent = next ?? { stops: ['#5865f2'] };
  render();
}

export function setFaviconUnread(count) {
  unread = Math.max(0, Number(count) || 0);
  render();
}

/** Unread count as notifier.js writes it into the title. */
export function unreadFromTitle(title) {
  const match = /^\((\d+)\)/.exec(String(title ?? ''));
  if (match) return Number(match[1]);
  return String(title ?? '').startsWith('● ') ? 1 : 0;
}

/** Start following the tab title. Idempotent. */
export function installLiveFavicon() {
  if (observer || typeof document === 'undefined' || typeof MutationObserver === 'undefined') return;
  const sync = () => setFaviconUnread(unreadFromTitle(document.title));
  let title = document.querySelector('title');
  if (!title) {
    title = document.createElement('title');
    document.head.appendChild(title);
  }
  observer = new MutationObserver(sync);
  observer.observe(title, { childList: true, characterData: true, subtree: true });
  sync();
}
