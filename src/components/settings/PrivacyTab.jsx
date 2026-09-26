import React from 'react';
import { ShieldCheck, Users } from 'lucide-react';
import { useUserSettings } from '../../hooks/useUserSettings';
import MyReports from '../admin/MyReports';
import { useAccountFlags } from '../admin/safety';
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
  const accountFlags = useAccountFlags(currentUser);

  return (
    <div>
      <PageHeader title={t('settings.privacyTitle')} description={t('settings.privacyLead')} />

      <Note tone="brand">{t('privacy.enforcedServerSide')}</Note>

      <Divider />

      <FamilySection ageGroup={accountFlags.age_group} />

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

      <Section title={t('safety.messageRequests')} description={t('safety.messageRequestsHint')}>
        <SettingToggle
          label={t('safety.filterRequests')}
          hint={t('safety.filterRequestsHint')}
          checked={privacy.messageRequests !== false}
          onChange={(value) => set({ messageRequests: value })}
          last
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
          last
        />
        {/* There used to be a "usage analytics" switch here, and a "show
            current activity" one that duplicated Activity Privacy's switch
            without doing anything. That switch lives (and works) there. */}
      </Section>

      <Divider />

      <Section title={t('safety.myReports')} description={t('safety.myReportsHint')}>
        <MyReports />
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

/**
 * Family & teen safety: what protections an under-18 account gets, in plain
 * words, so a parent can check them and a teen knows why things work the way
 * they do. The protections themselves are enforced on the server.
 */
function FamilySection({ ageGroup }) {
  const minor = ageGroup === 'minor';
  const items = [
    t('safety.teenDms'), t('safety.teenRequests'), t('safety.teenFriends'),
    t('safety.teenMedia'), t('safety.teenNsfw')
  ];
  return (
    <Section title={t('safety.familyTitle')} description={minor ? t('safety.familyTeenLead') : t('safety.familyLead')}>
      <div className={`rounded-lg border px-4 py-3 ${minor ? 'border-d-online/50 bg-d-online/10' : 'border-d-divider bg-d-surface'}`}>
        <p className="mb-2 flex items-center gap-2 text-sm font-semibold text-d-strong">
          {minor ? <ShieldCheck className="h-4 w-4 text-d-online" aria-hidden="true" /> : <Users className="h-4 w-4 text-d-text2" aria-hidden="true" />}
          {minor ? t('safety.teenOn') : t('safety.teenDefaultsTitle')}
        </p>
        <ul className="list-disc space-y-1 pl-5 text-sm text-d-text2 leading-relaxed">
          {items.map((line) => <li key={line}>{line}</li>)}
        </ul>
        <p className="mt-2 text-xs text-d-text3 leading-relaxed">{minor ? t('safety.teenChange') : t('safety.parentTip')}</p>
      </div>
    </Section>
  );
}
