import React from 'react';
import Tooltip from '../ui/Tooltip.jsx';
import { Glyph } from '../../profile/glyphs.jsx';
import { t, localeTag } from '../../i18n/index.jsx';

const SYSTEM_COLORS = {
  staff: 'var(--color-d-brand)',
  bot: 'var(--color-d-brand)',
  early: '#d97706',
  verified: 'var(--color-d-success)'
};

export function badgeLabel(badge) {
  if (badge.kind === 'system') return t(`profiles.badge.${badge.slug}`);
  return badge.name;
}

function badgeDescription(badge) {
  if (badge.kind === 'system') return t(`profiles.badge.${badge.slug}Hint`);
  const parts = [];
  if (badge.description) parts.push(badge.description);
  if (badge.granted_at) {
    const date = new Date(badge.granted_at).toLocaleDateString(localeTag(), { day: 'numeric', month: 'short', year: 'numeric' });
    parts.push(t('profiles.badgeGranted', { date }));
  }
  if (badge.kind === 'server') parts.push(t('profiles.badgeServer'));
  return parts.join(' · ');
}

/**
 * A row of badges with tooltips. System badges are round; server-defined
 * badges sit in a rounded square so they can never pass for a system one.
 *
 * Stable API:  <BadgeRow badges={identity.badges} size={22} />
 */
export default function BadgeRow({ badges = [], size = 22, className = '', label }) {
  if (!badges?.length) return null;
  return (
    <ul className={`flex flex-wrap items-center gap-1 ${className}`} aria-label={label ?? t('profiles.badges')}>
      {badges.map((badge) => {
        const name = badgeLabel(badge);
        const hint = badgeDescription(badge);
        const color = badge.color || SYSTEM_COLORS[badge.slug] || 'var(--color-d-text2)';
        const shape = badge.kind === 'system' ? 'rounded-full' : 'rounded-[6px]';
        return (
          <li key={badge.id}>
            <Tooltip label={hint ? `${name} — ${hint}` : name}>
              <span
                role="img"
                aria-label={hint ? `${name}. ${hint}` : name}
                tabIndex={0}
                className={`inline-flex items-center justify-center border ${shape}
                  focus:outline-none focus-visible:ring-2 focus-visible:ring-d-brand`}
                style={{
                  width: size, height: size,
                  color,
                  borderColor: `color-mix(in srgb, ${color} 45%, transparent)`,
                  backgroundColor: `color-mix(in srgb, ${color} 14%, transparent)`
                }}
              >
                <Glyph name={badge.icon} className="h-[62%] w-[62%]" />
              </span>
            </Tooltip>
          </li>
        );
      })}
    </ul>
  );
}
