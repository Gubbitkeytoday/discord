import React, { memo, useMemo, useRef, useState } from 'react';
import { t, useLocaleCode } from '../i18n/index.jsx';
import { statusLabel } from './ui/StatusIndicator.jsx';
import AvatarWithDecoration from './profile/AvatarWithDecoration';
import Nameplate from './profile/Nameplate';
import MemberName from './profile/MemberName';
import { useIdentities } from '../profile/store';
import { memberRoleLook } from './server/roleStyle';

const LONG_PRESS_MS = 500;

/**
 * Group members the way Discord does: one section per *hoisted* role, ordered
 * by role position (highest first), then ONLINE for everyone else, then OFFLINE
 * last. A member appears under their highest hoisted role only.
 */
function groupMembers(members) {
  const online = members.filter((m) => m.status && m.status !== 'offline' && m.status !== 'invisible');
  const onlineIds = new Set(online.map((m) => m.id));
  const offline = members.filter((m) => !onlineIds.has(m.id));

  const sections = new Map(); // roleId -> { name, position, members[] }
  const ungrouped = [];

  for (const member of online) {
    const hoisted = (member.roles ?? [])
      .filter((r) => r.hoist)
      .sort((a, b) => b.position - a.position)[0];

    if (!hoisted || hoisted.name.startsWith('@')) {
      ungrouped.push(member);
      continue;
    }
    if (!sections.has(hoisted.id)) {
      sections.set(hoisted.id, { name: hoisted.name, position: hoisted.position, members: [] });
    }
    sections.get(hoisted.id).members.push(member);
  }

  const byName = (a, b) => (a.display_name || a.username).localeCompare(b.display_name || b.username);
  const ordered = [...sections.values()].sort((a, b) => b.position - a.position);
  for (const section of ordered) section.members.sort(byName);
  if (ungrouped.length) ordered.push({ name: t('status.online'), position: -1, members: ungrouped.sort(byName) });
  if (offline.length) ordered.push({ name: t('status.offline'), position: -2, members: offline.sort(byName), dim: true });

  return ordered;
}

/**
 * The member list. `onSelectMember(id, anchorRect)` opens the profile popout
 * beside the clicked row; `rolesById` (the server's roles with their styles)
 * lets names take gradient / holographic role styles and role icons.
 */
export default function MemberList({ members, serverId = null, rolesById = null, onSelectMember, onMemberContextMenu }) {
  // Translated labels are memoised; recompute when the language changes.
  const locale = useLocaleCode();
  const sections = useMemo(() => groupMembers(members ?? []), [members, locale]);
  // One batched identity request for the whole list (decorations, nameplates,
  // name styles, tags), cached and shared with chat and profiles.
  const ids = useMemo(() => (members ?? []).map((m) => m.id), [members]);
  const identities = useIdentities(ids, serverId);

  // Touch has no right-click (iOS Safari never fires contextmenu), so a long
  // press opens the member menu — the same gesture messages already use.
  // Handlers go through a ref so the memoised rows never re-render for them.
  const pressTimer = useRef(null);
  const longPressed = useRef(false);
  const handlers = useRef(null);
  handlers.current = { onSelectMember, onMemberContextMenu };
  const press = useMemo(() => ({
    start: (member, e) => {
      if (!handlers.current.onMemberContextMenu) return;
      longPressed.current = false;
      const touch = e.touches?.[0];
      clearTimeout(pressTimer.current);
      pressTimer.current = setTimeout(() => {
        longPressed.current = true;
        handlers.current.onMemberContextMenu(member, touch?.clientX ?? 0, touch?.clientY ?? 0);
      }, LONG_PRESS_MS);
    },
    cancel: () => clearTimeout(pressTimer.current),
    select: (member, e) => {
      if (longPressed.current) { longPressed.current = false; e.preventDefault(); return; }
      handlers.current.onSelectMember?.(member.id, e.currentTarget.getBoundingClientRect());
    },
    menu: (member, x, y) => handlers.current.onMemberContextMenu?.(member, x, y),
    hasMenu: () => Boolean(handlers.current.onMemberContextMenu)
  }), []);

  if (!members?.length) return null;

  return (
    <aside
      aria-label={t('members.count', { count: members.length })}
      className="w-60 bg-d-surface flex flex-col shrink-0 select-none overflow-y-auto px-2 py-4 space-y-4 border-l border-d-edge/40 max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:z-30 max-lg:shadow-2xl"
    >
      {sections.map((section) => (
        <div key={`${section.name}-${section.position}`}>
          <h3 className="text-xs font-bold text-d-text3 tracking-wider mb-1.5 px-2 uppercase">
            {section.name} — {section.members.length}
          </h3>

          <div className="space-y-[2px]">
            {section.members.map((member) => (
              <MemberRow
                key={member.id}
                member={member}
                identity={identities[member.id]}
                rolesById={rolesById}
                dim={Boolean(section.dim)}
                press={press}
              />
            ))}
          </div>
        </div>
      ))}
    </aside>
  );
}

/**
 * One member: nameplate art behind the row, the avatar with its decoration
 * (still until the row is hovered or focused), the name in its role colour
 * and the person's font, then the tag / new-member mark and small badges.
 * Memoised on its own props, so hovering one row re-renders only that row.
 */
const MemberRow = memo(function MemberRow({ member, identity, rolesById, dim, press }) {
  const [hover, setHover] = useState(false);
  const timedOut = member.timeout_until && member.timeout_until > new Date().toISOString();
  const look = useMemo(() => memberRoleLook(member, rolesById), [member, rolesById]);
  const name = member.display_name || member.username;
  return (
    <Nameplate
      as="button"
      type="button"
      item={identity?.nameplate}
      scrim="var(--color-d-surface)"
      data-user-id={member.id}
      onClick={(e) => press.select(member, e)}
      onContextMenu={(e) => {
        if (!press.hasMenu()) return;
        e.preventDefault();
        press.menu(member, e.clientX, e.clientY);
      }}
      onKeyDown={(e) => {
        if (!press.hasMenu()) return;
        if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
          e.preventDefault();
          const rect = e.currentTarget.getBoundingClientRect();
          press.menu(member, rect.left + 24, rect.bottom);
        }
      }}
      onTouchStart={(e) => press.start(member, e)}
      onTouchEnd={press.cancel}
      onTouchMove={press.cancel}
      onTouchCancel={press.cancel}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      aria-label={`${name}, ${statusLabel(member.status)}${timedOut ? `, ${t('members.timedOutBadge')}` : ''}`}
      className="w-full min-h-[calc(var(--density-row)+10px)] flex items-center gap-3 px-2 py-1 rounded-md hover:bg-d-hover/60 transition-colors group text-left"
    >
      <AvatarWithDecoration
        src={member.avatar_url}
        userId={member.id}
        size={32}
        decoration={identity?.decoration}
        status={member.status}
        ring="var(--color-d-surface)"
        context="list"
        hovered={hover}
        className={dim ? 'opacity-60 group-hover:opacity-100' : ''}
        imgClassName={dim ? 'grayscale group-hover:grayscale-0' : ''}
      />

      <span className="flex flex-col min-w-0 flex-1">
        <span className="flex items-center gap-1 min-w-0">
          <MemberName
            name={name}
            identity={identity}
            styleRole={look.styleRole}
            iconRole={look.iconRole}
            surface="sidebar"
            compact
            className="text-sm font-medium text-d-text group-hover:text-d-strong"
          />
          {(member.is_bot || member.role === 'bot') && (
            <span className="bg-d-brand text-white text-[9px] font-bold px-1 rounded shrink-0">BOT</span>
          )}
          {Boolean(member.pending) && (
            <span className="bg-d-surface text-d-text3 text-[9px] font-bold px-1 rounded shrink-0" title={t('onboarding.pendingHint')}>
              {t('onboarding.pendingBadge')}
            </span>
          )}
          {member.role === 'owner' && (
            <span className="text-[10px] shrink-0" role="img" title={t('members.owner')} aria-label={t('members.owner')}>👑</span>
          )}
          {timedOut && (
            <span className="text-[10px] shrink-0" role="img" title={t('members.timedOutBadge')} aria-label={t('members.timedOutBadge')}>⏳</span>
          )}
        </span>
        {/* Custom status only: bios are not sent with the member
            list (visibility is applied on the profile). */}
        {Boolean(member.custom_status) && (
          <span className="text-[11px] text-d-text2 truncate">{member.custom_status}</span>
        )}
      </span>
    </Nameplate>
  );
});
