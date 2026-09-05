import React from 'react';
import { Radio } from 'lucide-react';
import { useUserSettings } from '../../hooks/useUserSettings';
import { t } from '../../i18n/index.jsx';
import { PageHeader, Section, SettingToggle, ResetButton, Divider, Note } from './primitives';

/**
 * Streamer Mode. Turning it on blurs anything marked sensitive and can silence
 * sounds and notifications, so a screen share does not broadcast a private
 * e-mail address or a working invite link.
 */
export default function StreamerModeTab() {
  const { prefs, update, reset } = useUserSettings();
  const streamer = prefs.streamerMode;
  const set = (patch) => update('streamerMode', patch);

  return (
    <div>
      <PageHeader
        title={t('settings.streamerTitle')}
        description={t('settings.streamerLead')}
        action={streamer.enabled ? (
          <span className="flex shrink-0 items-center gap-1.5 rounded bg-d-danger px-2 py-1
            text-[11px] font-bold uppercase tracking-wide text-white">
            <Radio className="h-3 w-3" aria-hidden="true" /> {t('streamer.live')}
          </span>
        ) : null}
      />

      <Section>
        <SettingToggle
          label={t('streamer.enable')}
          hint={t('streamer.enableHint')}
          checked={streamer.enabled}
          onChange={(value) => set({ enabled: value })}
        />
        <SettingToggle
          label={t('streamer.autoEnable')}
          hint={t('streamer.autoEnableHint')}
          checked={streamer.autoEnable}
          onChange={(value) => set({ autoEnable: value })}
          last
        />
      </Section>

      <Divider />

      <Section title={t('streamer.whatItHides')}>
        <SettingToggle
          label={t('streamer.hidePersonal')}
          hint={t('streamer.hidePersonalHint')}
          checked={streamer.hidePersonalInformation}
          onChange={(value) => set({ hidePersonalInformation: value })}
        />
        <SettingToggle
          label={t('streamer.hideInvites')}
          hint={t('streamer.hideInvitesHint')}
          checked={streamer.hideInviteLinks}
          onChange={(value) => set({ hideInviteLinks: value })}
        />
        <SettingToggle
          label={t('streamer.disableSounds')}
          checked={streamer.disableSounds}
          onChange={(value) => set({ disableSounds: value })}
        />
        <SettingToggle
          label={t('streamer.disableNotifications')}
          checked={streamer.disableNotifications}
          onChange={(value) => set({ disableNotifications: value })}
          last
        />
      </Section>

      <Note tone="warn">{t('streamer.scopeNote')}</Note>

      <ResetButton onClick={() => reset('streamerMode')}>{t('streamer.resetDefaults')}</ResetButton>
    </div>
  );
}
