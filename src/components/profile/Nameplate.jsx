import React from 'react';
import { useViewerPrefs } from '../../profile/motion';
import '../../profile/profile.css';

/**
 * A nameplate: the art strip behind a member-list / DM-list row. The art is
 * a masked pseudo-element (no extra DOM per row; the list is virtualised):
 * it is fully transparent behind the avatar and most of the name and fades
 * in towards the right, where Discord's nameplates carry theirs. The row's
 * own surface — including a gradient theme and the translucent hover /
 * selected washes the contrast guard checks — shows through untouched, so
 * role colours, tags and badges keep their contrast on every theme.
 *
 * Stable API:
 *   item       identity.nameplate (catalogue item) or null → renders children plainly
 *   as         element type (default 'div'); other props are passed through
 */
export default function Nameplate({
  item, as = 'div', className = '', style, children, ...rest
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
      style={{ ...style, '--pf-nameplate-art': `url("${item.asset_url}")` }}
      {...rest}
    >
      {children}
    </Tag>
  );
}
