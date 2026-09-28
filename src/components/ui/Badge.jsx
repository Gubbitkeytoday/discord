import React from 'react';
import { t } from '../../i18n/index.jsx';

/**
 * Discord's red mention pill ("3", "99+") and the neutral count/label pill.
 * The visible number is aria-hidden and replaced by a sentence ("3 mentions")
 * for screen readers, unless the parent already includes it in its name —
 * then pass `decorative`.
 *
 * `ring` paints a border in the colour of the surface behind the badge, which
 * is how it separates from the icon it overlaps.
 */
export function formatCount(count, max = 99) {
  return count > max ? `${max}+` : String(count);
}

export function MentionBadge({ count, max = 99, ring, decorative = false, className = '' }) {
  if (!count || count < 1) return null;
  return (
    <span
      className={`inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-d-danger px-1
        text-[11px] font-bold leading-none text-white tabular-nums ${ring ? 'box-content border-[3px]' : ''} ${className}`}
      style={ring ? { borderColor: ring } : undefined}
    >
      <span aria-hidden="true">{formatCount(count, max)}</span>
      {!decorative && <span className="sr-only">{t('a11y.mentionCount', { count })}</span>}
    </span>
  );
}

const TONES = {
  neutral: 'bg-d-control text-d-strong',
  brand: 'bg-d-brand text-white',
  success: 'bg-d-online/20 text-d-online',
  warning: 'bg-d-idle/20 text-d-idle',
  danger: 'bg-d-danger/15 text-d-danger'
};

/** A small uppercase status pill: "NEW", "BOT", "Connected". */
export function Pill({ tone = 'neutral', children, className = '' }) {
  return (
    <span className={`inline-flex items-center rounded-[var(--radius-d-sm)] px-1.5 py-0.5 text-xs font-semibold ${TONES[tone] ?? TONES.neutral} ${className}`}>
      {children}
    </span>
  );
}

export default MentionBadge;
