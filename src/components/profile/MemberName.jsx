import React from 'react';
import RoleName from '../server/RoleName.jsx';
import RoleIcon from '../server/RoleIcon.jsx';
import { roleStops } from '../server/roleStyle';
import DisplayName, { NewMemberMark, ServerTagChip } from './DisplayName';
import { FONTS, loadNameFont } from '../../profile/nameStyle';
import { useViewerPrefs } from '../../profile/motion';

/**
 * A member's name where server roles and personal name styles meet (member
 * list rows, the chat author line).
 *
 * - A role with a colour decides the colour — solid, gradient or holographic,
 *   contrast-guarded by RoleName — because role colours carry meaning (who
 *   moderates). The person's name *font* still applies on top.
 * - With no coloured role, the person's own name style (font, colours,
 *   gradient / glow) is used, exactly as DisplayName draws it outside servers.
 * - Then the role icon, the 🌱 new-member mark and the worn server tag.
 *
 *   <MemberName name identity styleRole iconRole surface="sidebar" compact />
 *
 * `interactive` gives the marks their own Tab stops (only outside a button).
 */
export default function MemberName({
  name, identity = null, styleRole = null, iconRole = null, surface = 'chat', compact = false,
  interactive = false, showTag = true, iconSize = 16, className = '', nameClassName = ''
}) {
  const viewer = useViewerPrefs();
  const marks = (
    <>
      {identity?.new_member && <NewMemberMark joinedAt={identity.joined_at} interactive={interactive} />}
      {showTag && identity?.tag && <ServerTagChip tag={identity.tag} interactive={interactive} />}
    </>
  );

  if (styleRole && roleStops(styleRole).length > 0) {
    const style = viewer.nameStyles && !(compact && !viewer.nameStylesInLists) ? identity?.name_style : null;
    const font = style?.font ? FONTS[style.font] : null;
    if (font?.family) loadNameFont(style.font);
    return (
      <RoleName
        name={name}
        role={styleRole}
        iconRole={iconRole}
        surface={surface}
        iconSize={iconSize}
        className={`${className} ${nameClassName}`}
        style={font?.family ? { fontFamily: `${font.family}, var(--font-sans, inherit)` } : undefined}
        data-name-style={style ? `${style.font}/${style.effect}` : undefined}
      >
        {marks}
      </RoleName>
    );
  }

  return (
    <span className={`inline-flex min-w-0 max-w-full items-center gap-1 ${className}`}>
      <DisplayName
        name={name}
        identity={identity}
        compact={compact}
        showTag={false}
        showNewMember={false}
        className="min-w-0"
        nameClassName={nameClassName}
      />
      {iconRole && <RoleIcon role={iconRole} size={iconSize} />}
      {marks}
    </span>
  );
}
