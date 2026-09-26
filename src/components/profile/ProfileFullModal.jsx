import React, { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import ProfileCard from './ProfileCard';
import { BioSection, RolesSection, SinceSection } from './ProfileSections';
import { useDialog } from '../settings/primitives';
import { t } from '../../i18n/index.jsx';
import { serverIconOf, serverInitials, defaultAvatar } from '../../utils/avatar';
import { proxiedImageUrl } from '../../utils/media';

/**
 * The full profile: identity on the left, tabs on the right —
 * About, Mutual servers (N), Mutual friends (N), Note.
 *
 * Stable API:
 *   user, identity, member, roles, roleColor, usernameText
 *   mutualServers, mutualFriends   from GET /api/profiles/:id
 *   note             the private-note editor (node) or null for yourself
 *   actions          buttons row
 *   onOpenServer(id), onOpenUser(id)   optional navigation from the lists
 *   initialTab       'about' | 'servers' | 'friends' | 'note'
 */
export default function ProfileFullModal({
  user, identity, member, roles = [], roleColor, usernameText, mutualServers = [], mutualFriends = [],
  note = null, actions = null, extra = null, onClose, onOpenServer, onOpenUser, initialTab = 'about',
  replay, onReplay, loading = false
}) {
  const dialogRef = useDialog(onClose);
  const [tab, setTab] = useState(initialTab);
  const tabsRef = useRef(null);
  const baseId = useId();
  const isSelf = !note;
  const tabs = [
    { id: 'about', label: t('profiles.tabAbout') },
    ...(isSelf ? [] : [
      { id: 'servers', label: t('profiles.tabServers', { count: mutualServers.length }) },
      { id: 'friends', label: t('profiles.tabFriends', { count: mutualFriends.length }) },
      { id: 'note', label: t('profile.note') }
    ])
  ];
  const name = member?.nickname || user?.display_name || user?.username;

  const onTabKey = (e) => {
    const i = tabs.findIndex((x) => x.id === tab);
    let next = null;
    if (e.key === 'ArrowRight') next = tabs[(i + 1) % tabs.length];
    if (e.key === 'ArrowLeft') next = tabs[(i - 1 + tabs.length) % tabs.length];
    if (e.key === 'Home') next = tabs[0];
    if (e.key === 'End') next = tabs[tabs.length - 1];
    if (!next) return;
    e.preventDefault();
    setTab(next.id);
    tabsRef.current?.querySelector(`[data-tab="${next.id}"]`)?.focus();
  };

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center overlay-center bg-black/60 p-0 sm:p-4"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t('profiles.profileOf', { name })}
        className="flex h-full w-full max-w-[880px] flex-col overflow-hidden bg-d-panel shadow-2xl sm:h-auto sm:max-h-[calc(100dvh-2rem)] sm:rounded-2xl md:flex-row"
      >
        <div className="relative overflow-y-auto md:w-[340px] md:shrink-0">
          <ProfileCard
            user={user} identity={identity} member={member} roleColor={roleColor}
            usernameText={usernameText} variant="full" replay={replay} onReplay={onReplay}
            className="rounded-none"
            headerSlot={(
              <button type="button" onClick={onClose} aria-label={t('common.close')}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-black/45 text-white hover:bg-black/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-white md:hidden">
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            )}
          >
            <SinceSection user={user} joinedAt={member?.joined_at ?? identity?.joined_at} />
            {actions && <div className="mt-3 flex flex-wrap gap-2 border-t border-d-divider pt-3">{actions}</div>}
          </ProfileCard>
        </div>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-2 border-b border-d-divider px-4">
            <div ref={tabsRef} role="tablist" aria-label={t('profiles.profileOf', { name })} onKeyDown={onTabKey}
              className="-mb-px flex min-w-0 flex-1 flex-wrap gap-x-4 md:flex-nowrap md:overflow-x-auto">
              {tabs.map((x) => (
                <button key={x.id} type="button" role="tab" data-tab={x.id}
                  id={`${baseId}-tab-${x.id}`} aria-controls={`${baseId}-panel`}
                  aria-selected={tab === x.id} tabIndex={tab === x.id ? 0 : -1}
                  onClick={() => setTab(x.id)}
                  className={`min-h-11 whitespace-nowrap border-b-2 text-sm font-semibold focus:outline-none focus-visible:ring-2 focus-visible:ring-d-brand
                    ${tab === x.id ? 'border-d-strong text-d-strong' : 'border-transparent text-d-text2 hover:text-d-strong'}`}>
                  {x.label}
                </button>
              ))}
            </div>
            <button type="button" onClick={onClose} aria-label={t('common.close')}
              className="hidden h-9 w-9 items-center justify-center rounded-full text-d-text2 hover:bg-d-hover hover:text-d-strong md:flex">
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>

          <div id={`${baseId}-panel`} role="tabpanel" aria-labelledby={`${baseId}-tab-${tab}`} tabIndex={0}
            className="min-h-[240px] flex-1 overflow-y-auto p-4 focus:outline-none">
            {tab === 'about' && (
              <>
                <BioSection plain user={member?.bio ? { ...user, bio: member.bio } : user} />
                <RolesSection roles={roles} />
                {extra}
              </>
            )}
            {tab === 'servers' && (
              <PeopleOrServers loading={loading} empty={t('profiles.noMutualServers')}
                items={mutualServers.map((s) => ({
                  id: s.id, label: s.name, icon: serverIconOf(s), fallback: serverInitials(s.name),
                  onClick: onOpenServer ? () => onOpenServer(s.id) : null
                }))} />
            )}
            {tab === 'friends' && (
              <PeopleOrServers loading={loading} empty={t('profiles.noMutualFriends')} round
                items={mutualFriends.map((f) => ({
                  id: f.id, label: f.display_name || f.username, sub: `@${f.username}`,
                  icon: proxiedImageUrl(f.avatar_url || defaultAvatar(f.id)),
                  onClick: onOpenUser ? () => onOpenUser(f.id) : null
                }))} />
            )}
            {tab === 'note' && note}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}

function PeopleOrServers({ items, empty, round = false, loading }) {
  if (loading) return <p className="text-sm text-d-text3">{t('common.loading')}</p>;
  if (!items.length) return <p className="py-8 text-center text-sm text-d-text3">{empty}</p>;
  return (
    <ul className="space-y-1">
      {items.map((it) => {
        const body = (
          <>
            {it.icon
              ? <img src={it.icon} alt="" className={`h-10 w-10 object-cover ${round ? 'rounded-full' : 'rounded-xl'}`} loading="lazy" />
              : <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-d-surface text-sm font-semibold text-d-strong" aria-hidden="true">{it.fallback}</span>}
            <span className="min-w-0">
              <span className="block truncate text-sm font-semibold text-d-strong">{it.label}</span>
              {it.sub && <span className="block truncate text-xs text-d-text3">{it.sub}</span>}
            </span>
          </>
        );
        return (
          <li key={it.id}>
            {it.onClick ? (
              <button type="button" onClick={it.onClick}
                className="flex min-h-12 w-full items-center gap-3 rounded-md px-2 py-1.5 text-left hover:bg-d-hover focus:outline-none focus-visible:ring-2 focus-visible:ring-d-brand">
                {body}
              </button>
            ) : (
              <div className="flex min-h-12 items-center gap-3 px-2 py-1.5">{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
