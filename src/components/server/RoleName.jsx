import React, { useMemo } from 'react';
import RoleIcon from './RoleIcon.jsx';
import { roleNameStyle, memberRoleLook } from './roleStyle';
import { usePreference } from '../../hooks/useUserSettings';
import { emojiRuns } from '../../utils/emojiRuns';
import './server.css';

/**
 * A display name styled by the member's roles — one component for the chat
 * author line, the member list, mentions and profiles, so a gradient or
 * holographic role looks the same everywhere.
 *
 *   <RoleName member={m} rolesById={rolesById} surface="sidebar" />
 *   <RoleName name="Mod" role={role} />                 (a role pill/preview)
 *
 * Props
 *   name        text to show (default: member display name / role name)
 *   member      a server member ({ roles:[{id}], role_color, role_icon, … })
 *   rolesById   Map|object of the server's roles (with style fields); lets the
 *               member's highest styled role and icon be found
 *   role        style directly from this role (overrides member lookup)
 *   iconRole    icon from this role (default: the member's highest icon role)
 *   surface     'chat' | 'sidebar' | 'floating' — background the contrast
 *               guard measures against
 *   showIcon    render the role icon after the name (default true)
 *   as          element/tag (default 'span'); other props pass through
 *
 * Accessibility › Role Colors (names/dots/off), reduced motion, saturation
 * and forced colours are honoured (server.css + index.css). In "dots" mode a
 * dot in the primary colour is shown before the name, as elsewhere.
 */
export default function RoleName({
  name, member = null, rolesById = null, role = null, iconRole = null,
  surface = 'chat', showIcon = true, iconSize = 16, as = 'span', className = '', children, ...rest
}) {
  const Tag = as;
  // Rendered in every message and member row: read just the theme.
  const theme = usePreference((p) => p.appearance?.theme);
  // A gradient theme changes the backgrounds the guard measures against.
  const gradient = usePreference((p) => (p.accessibility?.highContrast ? 'hc' : p.appearance?.gradient));
  const look = useMemo(() => memberRoleLook(member, rolesById), [member, rolesById]);
  const styleRole = role ?? look.styleRole;
  const icon = iconRole ?? (role ? (role.icon_url || role.unicode_emoji ? role : null) : look.iconRole);
  // Re-measure contrast when the theme changes.
  const { className: styleClass, style, colour } = useMemo(
    () => roleNameStyle(styleRole, { surface }),
    [styleRole, surface, theme, gradient] // eslint-disable-line react-hooks/exhaustive-deps
  );
  const text = name ?? member?.display_name ?? member?.nickname ?? member?.username ?? styleRole?.name ?? '';
  const clipped = styleClass.includes('role-name-styled');
  const runs = useMemo(() => (clipped ? emojiRuns(text) : []), [clipped, text]);

  return (
    <Tag className={`inline-flex items-center gap-1 min-w-0 max-w-full ${className}`} {...rest}>
      {colour && <span className="role-dot w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: styleRole.color }} aria-hidden="true" />}
      {clipped && runs.length > 1 ? (
        // Gradient/holographic names clip their background to the glyphs;
        // emoji must sit outside that clip or they lose their own colours.
        <span className="truncate" data-role-style={styleRole?.style ?? undefined}>
          {runs.map((run, i) => (run.emoji
            ? <span key={i} className="role-name-emoji">{run.text}</span>
            : <span key={i} className={styleClass} style={style}>{run.text}</span>))}
        </span>
      ) : (
        <span className={`truncate ${styleClass}`} style={style} data-role-style={styleRole?.style ?? undefined}>
          {text}
        </span>
      )}
      {showIcon && icon && <RoleIcon role={icon} size={iconSize} />}
      {children}
    </Tag>
  );
}
