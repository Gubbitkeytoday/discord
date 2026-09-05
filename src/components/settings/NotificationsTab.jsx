import React, { useEffect, useState } from 'react';
import { Bell, BellOff, AlertTriangle, Play, CheckCircle2 } from 'lucide-react';
import { useUserSettings } from '../../hooks/useUserSettings';
import {
  requestNotificationPermission, notificationPermission, playSound
} from '../../utils/notifier';
import { t } from '../../i18n/index.jsx';
import {
  PageHeader, Section, SettingToggle, RadioList, ResetButton, Divider, Toggle, Button
} from './primitives';

const SOUND_EVENTS = () => [
  { key: 'message',    label: t('notif.soundMessage') },
  { key: 'mention',    label: t('notif.soundMention') },
  { key: 'call',       label: t('notif.soundCall') },
  { key: 'voiceJoin',  label: t('notif.soundVoiceJoin') },
  { key: 'voiceLeave', label: t('notif.soundVoiceLeave') },
  { key: 'mute',       label: t('notif.soundMute') },
  { key: 'unmute',     label: t('notif.soundUnmute') },
  { key: 'deafen',     label: t('notif.soundDeafen') },
  { key: 'undeafen',   label: t('notif.soundUndeafen') }
];

const TTS_MODES = () => [
  { key: 'never',   label: t('notif.ttsNever') },
  { key: 'current', label: t('notif.ttsCurrent') },
  { key: 'all',     label: t('notif.ttsAll') }
];

/** The browser's own permission state, said plainly rather than as a status code. */
function PermissionNotice({ permission, enabled, onAsk }) {
  if (permission === 'unsupported') {
    return (
      <p className="flex items-center gap-2 text-sm text-d-text3">
        <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" /> {t('notif.unsupported')}
      </p>
    );
  }
  if (permission === 'denied') {
    return (
      <p className="flex items-center gap-2 text-sm text-d-danger">
        <BellOff className="h-4 w-4 shrink-0" aria-hidden="true" /> {t('notif.blockedByBrowser')}
      </p>
    );
  }
  if (permission === 'granted') {
    return (
      <p className="flex items-center gap-2 text-sm text-d-online">
        <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden="true" /> {t('notif.permissionOk')}
      </p>
    );
  }
  if (!enabled) return null;
  return (
    <Button variant="primary" onClick={onAsk}>
      <Bell className="h-4 w-4" /> {t('notif.grantPermission')}
    </Button>
  );
}

export default function NotificationsTab({ onToast }) {
  const { prefs, update, reset } = useUserSettings();
  const notifications = prefs.notifications;
  const [permission, setPermission] = useState(notificationPermission());
  const set = (patch) => update('notifications', patch);

  useEffect(() => { setPermission(notificationPermission()); }, []);

  const askPermission = async () => {
    const result = await requestNotificationPermission();
    setPermission(result);
    if (result === 'denied') onToast?.(t('notif.permissionDenied'), { type: 'error' });
    if (result === 'granted') onToast?.(t('notif.permissionGranted'), { type: 'success', ttl: 2500 });
  };

  return (
    <div>
      <PageHeader title={t('settings.notificationsTitle')} description={t('settings.notificationsLead')} />

      <Section title={t('notif.desktopTitle')}>
        <SettingToggle
          label={t('notif.desktopEnabled')}
          hint={t('notif.desktopEnabledHint')}
          checked={notifications.desktopEnabled}
          onChange={(value) => set({ desktopEnabled: value })}
        />

        <div className="py-4 border-b border-d-divider">
          <PermissionNotice
            permission={permission}
            enabled={notifications.desktopEnabled}
            onAsk={askPermission}
          />
        </div>

        <SettingToggle
          label={t('notif.unreadBadge')}
          hint={t('notif.unreadBadgeHint')}
          checked={notifications.unreadBadge}
          onChange={(value) => set({ unreadBadge: value })}
        />
        <SettingToggle
          label={t('notif.taskbarFlash')}
          checked={notifications.taskbarFlash}
          onChange={(value) => set({ taskbarFlash: value })}
        />
        <SettingToggle
          label={t('notif.muteWhileStreaming')}
          hint={t('notif.muteWhileStreamingHint')}
          checked={notifications.muteWhileStreaming}
          onChange={(value) => set({ muteWhileStreaming: value })}
          last
        />
      </Section>

      <Divider />

      <Section title={t('notif.sounds')} description={t('notif.soundsHint')}>
        <div className="overflow-hidden rounded-lg border border-d-divider">
          {SOUND_EVENTS().map((event, index) => {
            const on = notifications.sounds?.[event.key] !== false;
            return (
              <div
                key={event.key}
                className={`flex items-center gap-3 bg-d-surface px-3 py-2
                  ${index > 0 ? 'border-t border-d-divider' : ''}`}
              >
                <button
                  type="button"
                  onClick={() => playSound(event.key, { force: true })}
                  title={t('notif.previewSound')}
                  aria-label={t('notif.previewSoundFor', { name: event.label })}
                  className="shrink-0 rounded p-1.5 text-d-text3 transition-colors
                    hover:bg-d-hover hover:text-d-strong"
                >
                  <Play className="h-3.5 w-3.5" />
                </button>
                <span className="flex-1 text-sm text-d-strong">{event.label}</span>
                <Toggle
                  checked={on}
                  label={event.label}
                  onChange={(value) => set({ sounds: { [event.key]: value } })}
                />
              </div>
            );
          })}
        </div>
      </Section>

      <Divider />

      <Section title={t('notif.ttsNotifications')} description={t('notif.ttsHint')}>
        <RadioList
          label={t('notif.ttsNotifications')}
          value={notifications.ttsMode}
          onChange={(value) => set({ ttsMode: value })}
          options={TTS_MODES()}
        />
      </Section>

      <ResetButton onClick={() => reset('notifications')}>{t('notif.resetDefaults')}</ResetButton>
    </div>
  );
}
