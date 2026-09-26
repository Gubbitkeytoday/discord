import React from 'react';
import { useUserSettings } from '../../hooks/useUserSettings';
import { t } from '../../i18n/index.jsx';
import {
  PageHeader, Section, SettingToggle, RadioList, ResetButton, Divider, Note
} from './primitives';

const DM_SCANNING = () => [
  { key: 'everyone', label: t('privacy.scanEveryone'),   hint: t('privacy.scanEveryoneHint') },
  { key: 'friends',  label: t('privacy.scanNonFriends'), hint: t('privacy.scanNonFriendsHint') },
  { key: 'off',      label: t('privacy.scanOff'),        hint: t('privacy.scanOffHint') }
];

const DM_FROM = () => [
  { key: 'everyone', label: t('privacy.dmEveryone'), hint: t('privacy.dmEveryoneHint') },
  { key: 'friends',  label: t('privacy.dmFriends'),  hint: t('privacy.dmFriendsHint') }
];

const PROFILE_VISIBILITY = () => [
  { key: 'everyone', label: t('privacy.profileEveryone'), hint: t('privacy.profileEveryoneHint') },
  { key: 'mutual',   label: t('privacy.profileMutual'),   hint: t('privacy.profileMutualHint') },
  { key: 'friends',  label: t('privacy.profileFriends'),  hint: t('privacy.profileFriendsHint') }
];

const FRIEND_REQUESTS = () => [
  { key: 'everyone',           label: t('privacy.frEveryone') },
  { key: 'friends_of_friends', label: t('privacy.frMutual'), hint: t('privacy.frMutualHint') },
  { key: 'none',               label: t('privacy.frNone') }
];

/**
 * Privacy & Safety. Unlike a client-side preference, the DM and friend-request
 * rules here are also enforced on the server — a client that ignored them would
 * still be refused at the API.
 */
export default function PrivacyTab({ currentUser, onSaveProfile, onToast }) {
  const { prefs, update, reset } = useUserSettings();
  // Profile visibility lives on the user row, not in preferences, because the
  // server reads it when *other people* look at you — it is theirs to obey.
  const visibility = currentUser?.profile_visibility ?? 'everyone';
  const privacy = prefs.privacy;
  const set = (patch) => update('privacy', patch);

  return (
    <div>
      <PageHeader title={t('settings.privacyTitle')} description={t('settings.privacyLead')} />

      <Note tone="brand">{t('privacy.enforcedServerSide')}</Note>

      <Divider />

      <Section title={t('privacy.dmScanning')} description={t('privacy.dmScanningHint')}>
        <RadioList
          label={t('privacy.dmScanning')}
          value={privacy.dmScanning}
          onChange={(value) => set({ dmScanning: value })}
          options={DM_SCANNING()}
        />
      </Section>

      <Divider />

      <Section title={t('privacy.profileVisibility')} description={t('privacy.profileVisibilityHint')}>
        <RadioList
          label={t('privacy.profileVisibility')}
          value={visibility}
          onChange={(value) => Promise.resolve(onSaveProfile?.({ profile_visibility: value }))
            .catch((err) => onToast?.(err.message, { type: 'error' }))}
          options={PROFILE_VISIBILITY()}
        />
      </Section>

      <Divider />

      <Section title={t('privacy.allowDmsFrom')} description={t('privacy.allowDmsFromHint')}>
        <RadioList
          label={t('privacy.allowDmsFrom')}
          value={privacy.allowDmsFrom}
          onChange={(value) => set({ allowDmsFrom: value })}
          options={DM_FROM()}
        />
      </Section>

      <Divider />

      <Section title={t('privacy.friendRequests')} description={t('privacy.friendRequestsHint')}>
        <RadioList
          label={t('privacy.friendRequests')}
          value={privacy.friendRequests}
          onChange={(value) => set({ friendRequests: value })}
          options={FRIEND_REQUESTS()}
        />
      </Section>

      <Divider />

      <Section title={t('privacy.otherTitle')}>
        <SettingToggle
          label={t('privacy.serverMemberDms')}
          hint={t('privacy.serverMemberDmsHint')}
          checked={privacy.allowServerMemberDms}
          onChange={(value) => set({ allowServerMemberDms: value })}
        />
        {/* There used to be a "usage analytics" switch here. Nothing collects
            analytics, so it changed nothing either way — the note below says
            so honestly instead of offering a control with no effect. */}
        <SettingToggle
          label={t('privacy.showActivity')}
          hint={t('privacy.showActivityHint')}
          checked={privacy.showCurrentActivity}
          onChange={(value) => set({ showCurrentActivity: value })}
          last
        />
      </Section>

      <Note>{t('privacy.selfHostedNote')}</Note>

      <ResetButton
        onClick={() => reset('privacy').catch((err) => onToast?.(err.message, { type: 'error' }))}
      >
        {t('privacy.resetDefaults')}
      </ResetButton>
    </div>
  );
}
