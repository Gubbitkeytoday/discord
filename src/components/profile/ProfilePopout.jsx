import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, X } from 'lucide-react';
import ProfileCard from './ProfileCard';
import { BioSection, RolesSection, SinceSection } from './ProfileSections';
import { placePopout } from '../../profile/anchor';
import { useDialog } from '../settings/primitives';
import { t } from '../../i18n/index.jsx';

const WIDTH = 300;

/**
 * The compact profile, anchored beside whatever opened it (a member row, an
 * author name). A bottom sheet on phones. Focus is trapped; Escape or a click
 * outside closes it. "View full profile" opens the full modal.
 *
 * Stable API:
 *   user, identity, member, roles, roleColor, usernameText
 *   anchorRect       { left, top, right, bottom } of the trigger (optional)
 *   onClose, onViewFull
 *   actions          buttons row (message, add friend, ⋯)
 *   footer           extra content under the roles (private note, server profile editor)
 */
export default function ProfilePopout({
  user, identity, member, roles = [], roleColor, usernameText, anchorRect = null,
  onClose, onViewFull, actions = null, footer = null, replay, onReplay
}) {
  const dialogRef = useDialog(onClose);
  const boxRef = useRef(null);
  const [pos, setPos] = useState(null);
  const [narrow, setNarrow] = useState(() => typeof window !== 'undefined' && window.innerWidth < 640);

  useLayoutEffect(() => {
    const place = () => {
      const isNarrow = window.innerWidth < 640;
      setNarrow(isNarrow);
      if (isNarrow) return;
      const h = Math.min(boxRef.current?.offsetHeight ?? 480, window.innerHeight - 16);
      setPos(placePopout(anchorRect, WIDTH, h));
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchorRect, identity, user?.bio]);

  const name = member?.nickname || user?.display_name || user?.username;
  const setRefs = (el) => { boxRef.current = el; dialogRef.current = el; };

  return createPortal(
    <div className="fixed inset-0 z-[60]" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={narrow ? { background: 'rgb(0 0 0 / 0.5)' } : undefined}>
      <div
        ref={setRefs}
        role="dialog"
        aria-modal="true"
        aria-label={t('profiles.profileOf', { name })}
        // Focus lands on the popout itself (its name is read out), not in
        // the private-note field — that would raise the keyboard on a phone.
        tabIndex={-1}
        data-initial-focus
        className={narrow
          ? 'absolute inset-x-0 bottom-0 max-h-[88dvh] overflow-y-auto rounded-t-2xl shadow-2xl focus:outline-none'
          : 'absolute max-h-[calc(100dvh-16px)] overflow-y-auto rounded-xl shadow-2xl ring-1 ring-black/20 focus:outline-none'}
        style={narrow ? undefined : { width: WIDTH, left: pos?.left ?? -9999, top: pos?.top ?? 0 }}
      >
        <ProfileCard
          user={user}
          identity={identity}
          member={member}
          roleColor={roleColor}
          usernameText={usernameText}
          variant="popout"
          replay={replay}
          onReplay={onReplay}
          className={narrow ? 'rounded-b-none' : ''}
          headerSlot={(
            <>
              {onViewFull && (
                <button type="button" onClick={onViewFull} aria-label={t('profiles.viewFull')} title={t('profiles.viewFull')}
                  className="flex h-8 w-8 items-center justify-center rounded-full bg-black/45 text-white hover:bg-black/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-white">
                  <Maximize2 className="h-4 w-4" aria-hidden="true" />
                </button>
              )}
              <button type="button" onClick={onClose} aria-label={t('common.close')}
                className="flex h-8 w-8 items-center justify-center rounded-full bg-black/45 text-white hover:bg-black/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-white">
                <X className="h-4 w-4" aria-hidden="true" />
              </button>
            </>
          )}
        >
          <BioSection user={member?.bio ? { ...user, bio: member.bio } : user} clamp onMore={onViewFull} />
          <RolesSection roles={roles} limit={6} />
          <SinceSection user={user} joinedAt={member?.joined_at ?? identity?.joined_at} />
          {footer}
          {onViewFull && (
            <button type="button" onClick={onViewFull}
              className="mt-3 w-full rounded-md py-1.5 text-center text-sm font-semibold text-d-text2 hover:bg-d-surface hover:text-d-strong">
              {t('profiles.viewFull')}
            </button>
          )}
          {actions && <div className="mt-3 flex flex-wrap gap-2 border-t border-d-divider pt-3">{actions}</div>}
        </ProfileCard>
      </div>
    </div>,
    document.body
  );
}
