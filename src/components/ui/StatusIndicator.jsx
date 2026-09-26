import React, { useId } from 'react';
import { t } from '../../i18n/index.jsx';

/**
 * Discord's presence shapes. Colour alone fails for about 1 in 12 men (the
 * green online dot and red DND dot look the same olive with deuteranopia), so
 * each status also has its own silhouette:
 *
 *   online      filled circle          (green)
 *   idle        crescent moon          (yellow)
 *   dnd         circle with a bar      (red)
 *   streaming   circle with a ▶ cut    (purple)
 *   offline /   hollow ring            (grey)
 *   invisible
 *
 * Shapes are drawn with an SVG mask so the "holes" show whatever is behind the
 * indicator. `ring` paints a cut-out border in the colour of the surface it
 * sits on, which is how Discord separates the dot from an avatar.
 *
 * Accessibility: by default the indicator is an `img` named after the status
 * ("Do not disturb"). When the parent already says the status in its own
 * accessible name (a member row: "Mina, Do not disturb"), pass `decorative`
 * so it is not read twice.
 */

export const STATUS_KEYS = ['online', 'idle', 'dnd', 'streaming', 'offline', 'invisible'];

const FILL = {
  online: 'var(--color-d-online)',
  idle: 'var(--color-d-idle)',
  dnd: 'var(--color-d-danger)',
  streaming: 'var(--color-d-streaming)',
  offline: 'var(--color-d-text4)',
  invisible: 'var(--color-d-text4)'
};

/** Normalise whatever the API sent ('do_not_disturb', null, …) to a known key. */
export function normalizeStatus(status) {
  const value = String(status ?? 'offline').toLowerCase();
  if (value === 'do_not_disturb' || value === 'busy') return 'dnd';
  if (value === 'away') return 'idle';
  return STATUS_KEYS.includes(value) ? value : 'offline';
}

/** Localised status name, for callers that build their own accessible label. */
export function statusLabel(status) {
  const key = normalizeStatus(status);
  if (key === 'streaming') return t('status.streaming');
  return t(`status.${key}`);
}

function Cutout({ status }) {
  // Everything is on a 10×10 grid; black in the mask = hole.
  switch (status) {
    case 'idle':
      return <circle cx="2.5" cy="2.5" r="3.75" fill="black" />;
    case 'dnd':
      return <rect x="2.25" y="3.9" width="5.5" height="2.2" rx="1.1" fill="black" />;
    case 'streaming':
      return <path d="M3.6 2.7 L7.4 5 L3.6 7.3 Z" fill="black" />;
    case 'offline':
    case 'invisible':
      return <circle cx="5" cy="5" r="2.5" fill="black" />;
    default:
      return null;
  }
}

export default function StatusIndicator({
  status,
  size = 10,
  ring,
  decorative = false,
  label,
  className = '',
  title
}) {
  const key = normalizeStatus(status);
  const maskId = `status-mask-${useId().replace(/:/g, '')}`;
  const name = label ?? statusLabel(key);
  const a11y = decorative
    ? { 'aria-hidden': true }
    : { role: 'img', 'aria-label': name };
  const pad = ring ? Math.max(2, Math.round(size * 0.25)) : 0;

  const svg = (
    <svg width={size} height={size} viewBox="0 0 10 10" focusable="false" className="block shrink-0" aria-hidden="true">
      <mask id={maskId}>
        <circle cx="5" cy="5" r="5" fill="white" />
        <Cutout status={key} />
      </mask>
      <circle cx="5" cy="5" r="5" fill={FILL[key]} mask={`url(#${maskId})`} />
    </svg>
  );

  return (
    <span
      {...a11y}
      title={title}
      data-status={key}
      className={`inline-flex shrink-0 items-center justify-center rounded-full ${className}`}
      style={ring ? { padding: pad, backgroundColor: ring } : undefined}
    >
      {svg}
    </span>
  );
}
