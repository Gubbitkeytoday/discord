// Bio rendering (safe markdown subset) and custom-status helpers.

import React from 'react';
import { parseDiscordMarkdown } from '../utils/markdownParser.jsx';
import { t, localeTag } from '../i18n/index.jsx';

export const BIO_MAX = 300;

/**
 * The profile subset of our markdown: bold, italic, underline, strike,
 * spoilers, inline code, http(s) links, custom emoji. Headings become bold
 * lines (a bio is not a document), mentions never ping or link.
 */
export function renderBio(text, { resolveUser = null } = {}) {
  if (!text) return null;
  const safe = String(text)
    .replace(/^#{1,3}\s+(.+)$/gm, '**$1**')
    .replace(/```/g, '`');
  return parseDiscordMarkdown(safe, {
    resolveUser: resolveUser ?? (() => null),
    resolveRole: () => null,
    resolveChannel: () => null
  });
}

export const CLEAR_AFTER = ['30m', '1h', '4h', 'today', 'never'];

export const clearAfterLabel = (value) => t(`profiles.clearAfter.${value}`);

/** Local midnight tonight, as the absolute instant the server needs. */
export function endOfToday(now = new Date()) {
  const d = new Date(now);
  d.setHours(24, 0, 0, 0);
  return d.toISOString();
}

export function statusExpiryPayload(clearAfter) {
  if (clearAfter === 'today') return { clear_after: 'today', expires_at: endOfToday() };
  return { clear_after: clearAfter };
}

/** "Clears at 18:30" for a status with an expiry. */
export function expiryText(expiresAt) {
  if (!expiresAt) return '';
  const at = new Date(expiresAt);
  if (Number.isNaN(at.getTime())) return '';
  const time = at.toLocaleTimeString(localeTag(), { hour: 'numeric', minute: '2-digit' });
  return t('profiles.clearsAt', { time });
}

/** A status emoji: unicode, or <:name:id> for a server emoji. */
export function StatusEmoji({ emoji, className = 'h-4 w-4' }) {
  if (!emoji) return null;
  const custom = /^<(a?):(\w+):([\w-]+)>$/.exec(emoji);
  if (custom) {
    return (
      <img src={`/api/emojis/${custom[3]}/image`} alt={`:${custom[2]}:`} className={`${className} inline-block object-contain`}
        loading="lazy" />
    );
  }
  return <span className="leading-none" aria-hidden="true">{emoji}</span>;
}
