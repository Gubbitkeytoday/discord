import React from 'react';
import { t } from '../../i18n/index.jsx';

/**
 * Presence shown by shape as well as colour, as Discord draws it, so it reads
 * for colour-blind people and in forced-colours mode:
 *   online  filled circle        idle     crescent moon
 *   dnd     circle with a bar    offline  hollow ring
 * The SVG is decorative; the status is always also given as text (visible
 * `label`, or sr-only by default).
 */
const COLORS = {
  online: 'var(--color-d-online, #23a55a)',
  idle: 'var(--color-d-idle, #f0b232)',
  dnd: 'var(--color-d-danger, #f23f43)',
  offline: 'var(--color-d-text4, #80848e)'
};

export function statusKey(status) {
  if (status === 'online' || status === 'idle' || status === 'dnd') return status;
  return 'offline';
}

export function statusLabel(status) {
  return t(`status.${statusKey(status)}`);
}

export function StatusShape({ status, size = 10, ringColor = null }) {
  const key = statusKey(status);
  const color = COLORS[key];
  const r = 5;
  return (
    <svg width={size} height={size} viewBox="0 0 10 10" aria-hidden="true" focusable="false" className="block shrink-0">
      {ringColor && <circle cx="5" cy="5" r="5" fill={ringColor} />}
      {key === 'online' && <circle cx="5" cy="5" r={r - 0.5} fill={color} />}
      {key === 'idle' && (
        <path d="M5 0.5a4.5 4.5 0 1 0 4.5 4.5 3.3 3.3 0 0 1 -4.5 -4.5z" fill={color} />
      )}
      {key === 'dnd' && (
        <>
          <circle cx="5" cy="5" r={r - 0.5} fill={color} />
          <rect x="2.4" y="4.1" width="5.2" height="1.8" rx="0.9" fill={ringColor ?? '#fff'} />
        </>
      )}
      {key === 'offline' && (
        <circle cx="5" cy="5" r="3.2" fill="none" stroke={color} strokeWidth="2" />
      )}
    </svg>
  );
}

/**
 * The avatar-corner badge: shape on a ring of the surface colour, plus the
 * status as screen-reader text (or visible text with `showLabel`).
 */
export default function StatusIndicator({ status, size = 12, ringColor = 'var(--color-d-surface, #2b2d31)', showLabel = false, className = '' }) {
  return (
    <span className={`inline-flex items-center gap-1 ${className}`}>
      <StatusShape status={status} size={size} ringColor={ringColor} />
      {showLabel
        ? <span className="text-[11px] text-d-text3">{statusLabel(status)}</span>
        : <span className="sr-only">{statusLabel(status)}</span>}
    </span>
  );
}
