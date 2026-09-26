import React from 'react';

/**
 * Friendly empty states with small inline illustrations (no image requests,
 * theme-aware through currentColor and the design tokens).
 *
 *   <EmptyState art="inbox" title="You're all caught up" body="…" />
 */

function Art({ kind }) {
  const common = { width: 96, height: 72, viewBox: '0 0 96 72', 'aria-hidden': true, focusable: 'false' };
  const soft = 'var(--color-d-control)';
  const softer = 'var(--color-d-control2)';
  const accent = 'var(--color-d-brand)';
  switch (kind) {
    case 'inbox':
      return (
        <svg {...common}>
          <ellipse cx="48" cy="64" rx="30" ry="4" fill={softer} />
          <path d="M18 34 28 14h40l10 20v20a4 4 0 0 1-4 4H22a4 4 0 0 1-4-4z" fill={soft} />
          <path d="M18 34h18l4 8h16l4-8h18v20a4 4 0 0 1-4 4H22a4 4 0 0 1-4-4z" fill={softer} />
          <path d="M40 24l6 6 12-12" fill="none" stroke={accent} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'search':
      return (
        <svg {...common}>
          <ellipse cx="48" cy="64" rx="26" ry="4" fill={softer} />
          <circle cx="42" cy="30" r="18" fill="none" stroke={soft} strokeWidth="6" />
          <path d="M55 43l14 14" stroke={soft} strokeWidth="8" strokeLinecap="round" />
          <circle cx="42" cy="30" r="11" fill={softer} />
        </svg>
      );
    case 'friends':
      return (
        <svg {...common}>
          <ellipse cx="48" cy="64" rx="32" ry="4" fill={softer} />
          <circle cx="36" cy="24" r="10" fill={soft} />
          <path d="M18 56a18 18 0 0 1 36 0z" fill={soft} />
          <circle cx="62" cy="28" r="8" fill={softer} />
          <path d="M48 56a14 14 0 0 1 28 0z" fill={softer} />
          <circle cx="72" cy="14" r="6" fill={accent} />
          <path d="M72 11v6M69 14h6" stroke="white" strokeWidth="2" strokeLinecap="round" />
        </svg>
      );
    case 'chat':
    default:
      return (
        <svg {...common}>
          <ellipse cx="48" cy="64" rx="30" ry="4" fill={softer} />
          <path d="M16 14h44a6 6 0 0 1 6 6v18a6 6 0 0 1-6 6H34l-10 8v-8h-8a6 6 0 0 1-6-6V20a6 6 0 0 1 6-6z" fill={soft} />
          <path d="M50 30h28a6 6 0 0 1 6 6v12a6 6 0 0 1-6 6h-4v6l-8-6H50a6 6 0 0 1-6-6V36a6 6 0 0 1 6-6z" fill={accent} />
          <circle cx="28" cy="29" r="3" fill={softer} /><circle cx="38" cy="29" r="3" fill={softer} /><circle cx="48" cy="29" r="3" fill={softer} />
        </svg>
      );
  }
}

export default function EmptyState({ art = 'chat', title, body, action = null, compact = false, className = '' }) {
  return (
    <div className={`flex flex-col items-center text-center ${compact ? 'gap-2 p-4' : 'gap-3 p-8'} ${className}`}>
      <Art kind={art} />
      {title && <p className={`${compact ? 'text-sm' : 'text-base'} font-semibold text-d-strong`}>{title}</p>}
      {body && <p className="max-w-xs text-sm leading-relaxed text-d-text2">{body}</p>}
      {action}
    </div>
  );
}

/** Placeholder rows for lists that are still loading (channels, members). */
export function SkeletonRows({ count = 5, avatar = false, className = '' }) {
  return (
    <div className={`space-y-2 ${className}`} aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex items-center gap-2 px-2 py-1">
          {avatar && <span className="skeleton-block h-8 w-8 shrink-0 rounded-full" />}
          <span className="skeleton-block h-3.5" style={{ width: `${55 + ((i * 17) % 35)}%` }} />
        </div>
      ))}
    </div>
  );
}
