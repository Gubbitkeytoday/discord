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
        backgroundImage: `linear-gradient(90deg, ${scrim} 0%, color-mix(in srgb, ${scrim} 70%, transparent) 38%, transparent 72%), url("${item.asset_url}")`
      }}
      {...rest}
    >
      {children}
    </Tag>
  );
}
