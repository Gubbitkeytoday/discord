import React, { useState } from 'react';
import ProfileCard from './ProfileCard';
import AvatarWithDecoration from './AvatarWithDecoration';
import Nameplate from './Nameplate';
import DisplayName from './DisplayName';
import { BioSection } from './ProfileSections';
import { StatusEmoji } from '../../profile/text.jsx';
import { t } from '../../i18n/index.jsx';

/**
 * The editor's live preview: the real ProfileCard with the draft, plus how
 * the same draft looks in the member list and on a chat message.
 *
 * Stable API: <ProfilePreview user={draftUser} identity={draftIdentity} avatarSrc bannerSrc />
 */
export default function ProfilePreview({ user, identity, avatarSrc, bannerSrc }) {
  const [replay, setReplay] = useState(0);
  const name = user?.display_name || user?.username;
  return (
    <div className="space-y-4" data-profile-preview>
      <ProfileCard
        user={user}
        identity={identity}
        variant="preview"
        avatarSrc={avatarSrc}
        bannerSrc={bannerSrc}
        replay={replay}
        onReplay={() => setReplay((n) => n + 1)}
        className="shadow-lg ring-1 ring-d-divider"
      >
        <BioSection user={user} />
      </ProfileCard>

      <div>
        <h4 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-d-text2">{t('profiles.previewMemberList')}</h4>
        <div className="rounded-lg bg-d-panel p-2 ring-1 ring-d-divider">
          <Nameplate item={identity?.nameplate} className="flex items-center gap-3 rounded-md px-2 py-1.5">
            <AvatarWithDecoration src={avatarSrc} userId={user?.id} size={32} decoration={identity?.decoration}
              status={user?.status ?? 'online'} context="list" />
            <span className="min-w-0">
              <DisplayName name={name} identity={identity} compact className="text-sm font-medium text-d-strong" />
              {(user?.custom_status || user?.custom_status_emoji) && (
                <span className="flex items-center gap-1 truncate text-xs text-d-text3">
                  <StatusEmoji emoji={user.custom_status_emoji} className="h-3.5 w-3.5" />
                  <span className="truncate">{user.custom_status}</span>
                </span>
              )}
            </span>
          </Nameplate>
        </div>
      </div>

      <div>
        <h4 className="mb-1.5 text-xs font-bold uppercase tracking-wide text-d-text2">{t('profiles.previewChat')}</h4>
        <div className="flex gap-3 rounded-lg bg-d-canvas p-3 ring-1 ring-d-divider">
          <AvatarWithDecoration src={avatarSrc} userId={user?.id} size={40} decoration={identity?.decoration} context="list" />
          <div className="min-w-0">
            <p className="flex items-baseline gap-2">
              <DisplayName name={name} identity={identity} compact className="font-medium text-d-strong" />
              <span className="text-xs text-d-text4">{t('profiles.previewTime')}</span>
            </p>
            <p className="text-sm text-d-text">{t('profiles.previewMessage')}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
