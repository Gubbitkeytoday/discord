import React from 'react';

/**
 * Discord's link preview card: a coloured left rail, site name, title, snippet
 * and thumbnail. Bare image links render as a plain image instead of a card.
 */
export default function LinkEmbed({ embed, onOpenImage }) {
  if (!embed) return null;

  if (embed.type === 'image') {
    return (
      <img
        src={embed.image}
        alt=""
        onClick={() => onOpenImage?.(embed.image)}
        className="mt-2 max-w-sm max-h-72 rounded-lg object-cover border border-d-surface cursor-pointer hover:scale-[1.01] transition-transform"
      />
    );
  }

  return (
    <div
      className="mt-2 max-w-md bg-d-base rounded border-l-4 overflow-hidden"
      style={{ borderLeftColor: embed.color || '#5865f2' }}
    >
      <div className="p-3">
        {embed.site_name && (
          <p className="text-[11px] text-d-text3 mb-0.5 truncate">{embed.site_name}</p>
        )}
        <a
          href={embed.url}
          target="_blank"
          rel="noreferrer noopener"
          className="text-sm font-semibold text-d-link hover:underline block truncate"
        >
          {embed.title}
        </a>
        {embed.description && (
          <p className="text-xs text-d-text mt-1 line-clamp-3">{embed.description}</p>
        )}
        {embed.image && (
          <img
            src={embed.image}
            alt=""
            loading="lazy"
            onClick={() => onOpenImage?.(embed.image)}
            className="mt-2 rounded max-h-64 w-full object-cover cursor-pointer"
          />
        )}
      </div>
    </div>
  );
}
