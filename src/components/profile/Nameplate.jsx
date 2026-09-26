import React from 'react';
import { useViewerPrefs } from '../../profile/motion';
import '../../profile/profile.css';

/**
 * A nameplate: the art strip behind a member-list / DM-list row. One
 * background image, no extra DOM per row (the list is virtualised), with a
 * scrim from the row colour on the left so the name keeps its contrast.
 *
 * Stable API:
 *   item       identity.nameplate (catalogue item) or null → renders children plainly
 *   scrim      CSS colour of the row behind the text (default: the sidebar surface)
 *   as         element type (default 'div'); other props are passed through
 */
export default function Nameplate({
  item, scrim = 'var(--color-d-panel)', as = 'div', className = '', style, children, ...rest
}) {
  const Tag = as;
  const viewer = useViewerPrefs();
  if (!item || viewer.decorations === 'off') {
    return <Tag className={className} style={style} {...rest}>{children}</Tag>;
  }
  return (
    <Tag
      className={`pf-nameplate ${className}`}
      data-nameplate={item.slug}
      style={{
        ...style,
        // The scrim holds solid behind the avatar and most of the name, so
        // role colours, tags and badges keep their contrast; the art shows
        // through on the right, where Discord's nameplates carry theirs.
        backgroundImage: `linear-gradient(90deg, ${scrim} 0%, ${scrim} 22%, color-mix(in srgb, ${scrim} 82%, transparent) 50%, transparent 88%), url("${item.asset_url}")`
      }}
      {...rest}
    >
      {children}
    </Tag>
  );
}
