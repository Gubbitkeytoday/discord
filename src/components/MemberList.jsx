import React, { useMemo, useRef } from 'react';
import { t, useLocaleCode } from '../i18n/index.jsx';
import { useUserSettings } from '../hooks/useUserSettings';
import { defaultAvatar } from '../utils/avatar';
import { proxiedImageUrl } from '../utils/media';
import StatusIndicator, { statusLabel } from './ui/StatusIndicator.jsx';
import { readableRoleColor, themeBackground } from '../utils/color';

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

export default function MemberList({ members, onSelectMember, onMemberContextMenu }) {
  // Translated labels are memoised; recompute when the language changes.
  const locale = useLocaleCode();
  const sections = useMemo(() => groupMembers(members ?? []), [members, locale]);
  // Accessibility › Role Colors decides whether the colour tints the name, sits
  // beside it as a dot, or is dropped entirely.
  const { prefs } = useUserSettings();
  const roleColorMode = prefs.accessibility.roleColors;
  // Role colours are raised to 4.5:1 against the member list's own surface
  // (theme, contrast and saturation settings included) before use as text.
  const surface = themeBackground('--color-d-surface');
  const readable = (colour) => readableRoleColor(colour, surface);

  // Touch has no right-click (iOS Safari never fires contextmenu), so a long
  // press opens the member menu — the same gesture messages already use.
  const pressTimer = useRef(null);
  const longPressed = useRef(false);
  const startPress = (member) => (e) => {
    if (!onMemberContextMenu) return;
    longPressed.current = false;
    const touch = e.touches?.[0];
    clearTimeout(pressTimer.current);
    pressTimer.current = setTimeout(() => {
      longPressed.current = true;
      onMemberContextMenu(member, touch?.clientX ?? 0, touch?.clientY ?? 0);
    }, LONG_PRESS_MS);
  };
  const cancelPress = () => clearTimeout(pressTimer.current);

  if (!members?.length) return null;

  return (
    <aside
      aria-label={t('members.count', { count: members.length })}
      className="w-60 bg-d-surface flex flex-col shrink-0 select-none overflow-y-auto px-3 py-4 space-y-4 border-l border-d-edge/40 max-lg:fixed max-lg:inset-y-0 max-lg:right-0 max-lg:z-30 max-lg:shadow-2xl"
    >
      {sections.map((section) => (
        <div key={`${section.name}-${section.position}`}>
          <h3 className="text-xs font-bold text-d-text3 tracking-wider mb-1.5 px-2 uppercase">
            {section.name} — {section.members.length}
          </h3>

          <div className="space-y-[2px]">
            {section.members.map((member) => {
              const timedOut = member.timeout_until && member.timeout_until > new Date().toISOString();
              return (
                <button
                  key={member.id}
                  onClick={(e) => {
                    if (longPressed.current) { longPressed.current = false; e.preventDefault(); return; }
                    onSelectMember(member.id);
                  }}
                  onContextMenu={(e) => {
                    if (!onMemberContextMenu) return;
                    e.preventDefault();
                    onMemberContextMenu(member, e.clientX, e.clientY);
                  }}
                  onKeyDown={(e) => {
                    if (!onMemberContextMenu) return;
                    if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
                      e.preventDefault();
                      const rect = e.currentTarget.getBoundingClientRect();
                      onMemberContextMenu(member, rect.left + 24, rect.bottom);
                    }
                  }}
                  onTouchStart={startPress(member)}
                  onTouchEnd={cancelPress}
                  onTouchMove={cancelPress}
                  onTouchCancel={cancelPress}
                  aria-label={`${member.display_name || member.username}, ${statusLabel(member.status)}${timedOut ? `, ${t('members.timedOutBadge')}` : ''}`}
                  className="w-full min-h-[40px] flex items-center gap-3 px-2 py-1.5 rounded-md hover:bg-d-hover/60 transition-colors group text-left"
                >
                  <div className="relative shrink-0">
                    <img
                      src={proxiedImageUrl(member.avatar_url || defaultAvatar(member.id))}
                      alt=""
                      className={`w-8 h-8 rounded-full object-cover ${section.dim ? 'grayscale opacity-60 group-hover:opacity-100' : ''}`}
                    />
                    {/* Shape as well as colour: dot, moon, bar, ring. */}
                    <span className="absolute -bottom-0.5 -right-0.5">
                      <StatusIndicator status={member.status} size={10} ring="var(--color-d-surface)" decorative />
                    </span>
                  </div>

                  <div className="flex flex-col min-w-0">
                    <div className="flex items-center gap-1">
                      {roleColorMode === 'dots' && member.role_color && (
                        <span
                          className="w-2 h-2 rounded-full shrink-0"
                          style={{ backgroundColor: member.role_color }}
                          aria-hidden="true"
                        />
                      )}
                      <span
                        className="text-sm font-medium truncate group-hover:brightness-125"
                        style={
                          // A role with two colours paints the name as a
                          // gradient; the text itself is clipped to the fill,
                          // so the colour has to be transparent for it to show.
                          roleColorMode === 'names' && readable(member.role_color) && readable(member.role_color_secondary)
                            ? {
                              backgroundImage: `linear-gradient(90deg, ${readable(member.role_color)}, ${readable(member.role_color_secondary)})`,
                              WebkitBackgroundClip: 'text',
                              backgroundClip: 'text',
                              color: 'transparent'
                            }
                            : {
                              color: (roleColorMode === 'names' && readable(member.role_color)) || 'var(--color-d-text)'
                            }
                        }
                      >
                        {member.display_name || member.username}
                      </span>
                      {Boolean(member.role_icon?.url) && (
                        <img
                          src={proxiedImageUrl(member.role_icon.url)}
                          alt=""
                          title={member.role_icon.name}
                          className="h-4 w-4 shrink-0 rounded-sm object-contain"
                        />
                      )}
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
                    </div>
                    {/* Custom status only: bios are not sent with the member
                        list (visibility is applied on the profile). */}
                    {Boolean(member.custom_status) && (
                      <span className="text-[11px] text-d-text2 truncate">{member.custom_status}</span>
                    )}
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </aside>
  );
}
