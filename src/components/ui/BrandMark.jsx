import React from 'react';

/**
 * Antigravity's own mark: a speech bubble with two eyes (the same drawing as
 * public/favicon.svg and the loading splash in index.html). The Home button
 * used to show Discord's trademarked logo, which a self-hosted project must
 * not ship.
 */
export default function BrandMark({ className = 'h-7 w-7', title }) {
  return (
    <svg
      viewBox="0 0 48 48"
      className={className}
      fill="currentColor"
      role={title ? 'img' : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      <path d="M8 9h32a5 5 0 0 1 5 5v17a5 5 0 0 1-5 5H21l-10 8v-8H8a5 5 0 0 1-5-5V14a5 5 0 0 1 5-5zm9 11.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7zm14 0a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z" fillRule="evenodd" />
    </svg>
  );
}
