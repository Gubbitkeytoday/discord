import React from 'react';
import { Sprout } from 'lucide-react';
import Tooltip from '../ui/Tooltip.jsx';
import { nameStyleCss } from '../../profile/nameStyle';
import { useMotionAllowed, useViewerPrefs } from '../../profile/motion';
import { Glyph } from '../../profile/glyphs.jsx';
import { t, localeTag } from '../../i18n/index.jsx';
import '../../profile/profile.css';

/**
 * A display name with the person's name style, their worn server tag and the
 * 🌱 new-member mark.
 *
 * Stable API:
 *   name          text to show (nickname or display name)
 *   identity      from useIdentity(): { name_style, tag, new_member, joined_at }
 *   roleColor     a readable role colour (wins over the name's colours in servers)
 *   compact       dense list (member list, chat header): obeys "styles in lists"
 *                 and never animates
 *   showTag       draw the server-tag chip (default true)
 *   showNewMember draw 🌱 when identity.new_member (default true)
 *   background    the surface colour behind the name, for the contrast guard
 *   interactive   the marks take keyboard focus for their tooltips (profiles);
 *                 leave false inside a row that is itself a button
 */
export default function DisplayName({
  name, identity = null, roleColor = null, compact = false, showTag = true, showNewMember = true,
  background, interactive = false, as = 'span', className = '', nameClassName = ''
}) {
  const Tag = as;
  const viewer = useViewerPrefs();
  const motion = useMotionAllowed();
  const style = viewer.nameStyles && !(compact && !viewer.nameStylesInLists) ? identity?.name_style : null;
  const css = nameStyleCss(style, { roleColor, background });
  const gradient = Boolean(css.backgroundImage);
  const pan = gradient && motion && !compact;
  return (
    <Tag className={`inline-flex min-w-0 max-w-full items-center gap-1 ${className}`}>
      <span
        className={`truncate ${gradient ? 'pf-gradient-name' : ''} ${pan ? 'pf-name-pan' : ''} ${nameClassName}`}
        style={css}
        data-name-style={style ? `${style.font}/${style.effect}` : undefined}
      >
        {name}
      </span>
      {showNewMember && identity?.new_member && <NewMemberMark joinedAt={identity.joined_at} interactive={interactive} />}
      {showTag && identity?.tag && <ServerTagChip tag={identity.tag} interactive={interactive} />}
    </Tag>
  );
}

export function NewMemberMark({ joinedAt, interactive = false }) {
  const days = joinedAt ? Math.max(0, Math.floor((Date.now() - new Date(joinedAt).getTime()) / 86400e3)) : 0;
  let when = '';
  try { when = new Intl.RelativeTimeFormat(localeTag(), { numeric: 'auto' }).format(-days, 'day'); } catch { when = ''; }
  const label = t('profiles.newMember', { when });
  return (
    <Tooltip label={label}>
      <span role="img" aria-label={label} tabIndex={interactive ? 0 : undefined}
        className="inline-flex h-4 w-4 shrink-0 items-center justify-center rounded text-d-success focus:outline-none focus-visible:ring-2 focus-visible:ring-d-brand">
        <Sprout className="h-3.5 w-3.5" aria-hidden="true" />
      </span>
    </Tooltip>
  );
}

/**
 * The worn server tag: [icon TAG]. Colour is the server's, drawn as a tinted
 * chip with body-text-coloured letters so it is readable on any theme.
 */
export function ServerTagChip({ tag, size = 'sm', interactive = false }) {
  if (!tag?.tag) return null;
  const label = t('profiles.tagFrom', { tag: tag.tag, server: tag.server_name ?? '' });
  const color = tag.color || 'var(--color-d-text3)';
  return (
    <Tooltip label={label}>
      <span
        role="img"
        aria-label={label}
        tabIndex={interactive ? 0 : undefined}
        className={`inline-flex shrink-0 items-center gap-0.5 rounded border px-1 font-semibold leading-none text-d-strong
          focus:outline-none focus-visible:ring-2 focus-visible:ring-d-brand ${size === 'lg' ? 'h-5 text-xs' : 'h-4 text-[10px]'}`}
        style={{
          borderColor: `color-mix(in srgb, ${color} 55%, transparent)`,
          backgroundColor: `color-mix(in srgb, ${color} 18%, transparent)`
        }}
      >
        <Glyph name={tag.icon} className={size === 'lg' ? 'h-3.5 w-3.5' : 'h-3 w-3'} style={{ color }} />
        <span className="tracking-wide">{tag.tag}</span>
      </span>
    </Tooltip>
  );
}
