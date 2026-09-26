import React from 'react';
import { t } from '../../i18n/index.jsx';
import { proxiedImageUrl } from '../../utils/media';
import { useUserSettings } from '../../hooks/useUserSettings';
import './server.css';

/** Appearance › "Show role icons next to names" (default on). */
export function useShowRoleIcons() {
  const { prefs } = useUserSettings();
  return prefs.appearance?.showRoleIcons !== false;
}

/**
 * A role's icon beside a name: an uploaded image or a unicode emoji. It
 * carries information (which role this is), so it has an accessible name
 * rather than being hidden, and a tooltip for sighted mouse users.
 * `force` shows it even when the viewer turned role icons off (the editor).
 */
export default function RoleIcon({ role, size = 16, force = false, className = '' }) {
  const enabled = useShowRoleIcons();
  if (!role || (!force && !enabled)) return null;
  const label = t('srv.roleIconAlt', { name: role.name ?? '' });
  if (role.unicode_emoji) {
    return (
      <span
        role="img"
        aria-label={label}
        title={role.name}
        className={`role-icon ${className}`}
        style={{ fontSize: size * 0.95, width: size, height: size }}
      >
        {role.unicode_emoji}
      </span>
    );
  }
  if (!role.icon_url) return null;
  return (
    <img
      src={proxiedImageUrl(role.icon_url)}
      alt={label}
      title={role.name}
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      className={`role-icon object-contain ${className}`}
      style={{ width: size, height: size }}
    />
  );
}
