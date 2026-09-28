import React, { useCallback, useEffect, useState } from 'react';
import {
  Bell, BellOff, AlertTriangle, Play, CheckCircle2, Smartphone, Download, X, Send, Trash2
} from 'lucide-react';
import { useUserSettings } from '../../hooks/useUserSettings';
import {
  requestNotificationPermission, notificationPermission, playSound
} from '../../utils/notifier';
import { t } from '../../i18n/index.jsx';
import { get, put } from '../../api';
import {
  PageHeader, Section, SettingToggle, RadioList, ResetButton, Divider, Toggle, Button, Row, Note,
  inputClass
} from './primitives';
import { usePwaState } from '../../pwa/store';
import {
  pushSupport, enablePush, disablePush, sendTestPush, listDevices, removeDevice, getPushConfig
} from '../../pwa/push';
import { promptInstall, needsManualInstall } from '../../pwa/install';

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

const PUSH_CONTENT = () => [
  { key: 'full',      label: t('pwa.contentFull'),     hint: t('pwa.contentFullHint') },
  { key: 'name_only', label: t('pwa.contentNameOnly'), hint: t('pwa.contentNameOnlyHint') },
  { key: 'hidden',    label: t('pwa.contentHidden'),   hint: t('pwa.contentHiddenHint') }
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

/** Push on this device, what a push may show, and the other devices that get them. */
function PushSection({ onToast, onPermission }) {
  const { pushSubscribed, pushServerEnabled } = usePwaState();
  const support = pushSupport();
  const [busy, setBusy] = useState(false);
  const [devices, setDevices] = useState([]);
  const [content, setContent] = useState('full');

  const refresh = useCallback(() => {
    listDevices().then((rows) => setDevices(Array.isArray(rows) ? rows : [])).catch(() => {});
  }, []);

  useEffect(() => {
    getPushConfig().catch(() => {});
    get('/api/notification-settings')
      .then((all) => setContent(all?.prefs?.push_content ?? 'full'))
      .catch(() => {});
    refresh();
  }, [refresh]);

  const toggle = async (on) => {
    setBusy(true);
    try {
      if (on) {
        const result = await enablePush();
        onPermission?.(notificationPermission());
        if (!result.ok) {
          const key = { denied: 'notif.permissionDenied', server: 'pwa.pushServerOff', 'needs-install': 'pwa.iosInstallBody' }[result.reason] ?? 'pwa.pushError';
          onToast?.(t(key), { type: 'error' });
        } else {
          onToast?.(t('pwa.pushOn'), { type: 'success', ttl: 2500 });
        }
      } else {
        await disablePush();
      }
    } catch (err) {
      onToast?.(err?.message ?? t('pwa.pushError'), { type: 'error' });
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const test = async () => {
    try {
      const result = await sendTestPush();
      onToast?.(t('pwa.testSent', { count: result?.sent ?? 0 }), { type: 'success', ttl: 3000 });
    } catch (err) {
      onToast?.(err?.message ?? t('pwa.pushError'), { type: 'error' });
    }
  };

  const saveContent = async (value) => {
    setContent(value);
    try { await put('/api/notification-settings/prefs', { push_content: value }); }
    catch (err) { onToast?.(err?.message ?? String(err), { type: 'error' }); }
  };

  if (pushServerEnabled === false) {
    return (
      <Section title={t('pwa.pushTitle')}>
        <Note>{t('pwa.pushServerOff')}</Note>
      </Section>
    );
  }

  return (
    <Section title={t('pwa.pushTitle')} description={t('pwa.pushLead')}>
      {support === 'needs-install' && <Note tone="brand">{t('pwa.iosInstallBody')}</Note>}
      {support === 'unsupported' && <Note>{t('pwa.pushUnsupported')}</Note>}
      {support === 'supported' && (
        <>
          <Row label={t('pwa.pushThisDevice')} hint={t('pwa.pushThisDeviceHint')}>
            <Toggle checked={pushSubscribed} onChange={toggle} disabled={busy} label={t('pwa.pushThisDevice')} />
          </Row>
          <div className="py-4 border-b border-d-divider">
            <p className="mb-3 text-base font-medium text-d-strong">{t('pwa.contentTitle')}</p>
            <RadioList label={t('pwa.contentTitle')} value={content} onChange={saveContent} options={PUSH_CONTENT()} />
          </div>
        </>
      )}
      {devices.length > 0 && (
        <div className="py-4">
          <div className="mb-2 flex items-center justify-between gap-3">
            <p className="text-base font-medium text-d-strong">{t('pwa.devices')}</p>
            <Button size="sm" onClick={test}><Send className="h-3.5 w-3.5" /> {t('pwa.sendTest')}</Button>
          </div>
          <ul className="overflow-hidden rounded-lg border border-d-divider">
            {devices.map((device, index) => (
              <li
                key={device.id}
                className={`flex items-center gap-3 bg-d-surface px-3 py-2 ${index > 0 ? 'border-t border-d-divider' : ''}`}
              >
                <Smartphone className="h-4 w-4 shrink-0 text-d-text3" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm text-d-strong">
                    {device.user_agent ? device.user_agent.replace(/\s*\(.*?\)\s*/g, ' ').slice(0, 60) : device.host}
                    {device.current_session && <span className="ml-2 text-xs text-d-online">{t('pwa.thisDevice')}</span>}
                  </span>
                  <span className="block text-xs text-d-text3">{device.host}</span>
                </span>
                <button
                  type="button"
                  onClick={() => removeDevice(device.id).then(refresh).catch(() => {})}
                  aria-label={t('pwa.removeDevice')}
                  title={t('pwa.removeDevice')}
                  className="rounded p-1.5 text-d-text3 hover:bg-d-hover hover:text-d-danger"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}

/** Keyword highlights: words that notify you like a mention. */
function KeywordsSection({ onToast }) {
  const [keywords, setKeywords] = useState([]);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    get('/api/notification-settings').then((all) => setKeywords(all?.prefs?.keywords ?? [])).catch(() => {});
  }, []);

  const save = async (next) => {
    const previous = keywords;
    setKeywords(next);
    try {
      const saved = await put('/api/notification-settings/prefs', { keywords: next });
      setKeywords(saved?.keywords ?? next);
    } catch (err) {
      setKeywords(previous);
      onToast?.(err?.message ?? String(err), { type: 'error' });
    }
  };

  const add = (event) => {
    event.preventDefault();
    const words = draft.split(',').map((w) => w.trim()).filter(Boolean);
    if (!words.length) return;
    setDraft('');
    save([...keywords, ...words]);
  };

  return (
    <Section title={t('notif.keywordsTitle')} description={t('notif.keywordsLead')}>
      <form onSubmit={add} className="flex gap-2">
        <label htmlFor="notif-keyword" className="sr-only">{t('notif.keywordsAdd')}</label>
        <input
          id="notif-keyword"
          value={draft}
          maxLength={200}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={t('notif.keywordsPlaceholder')}
          className={inputClass}
        />
        <Button type="submit" variant="primary" disabled={!draft.trim()}>{t('notif.keywordsAdd')}</Button>
      </form>
      {keywords.length > 0 && (
        <ul className="mt-3 flex flex-wrap gap-2" aria-label={t('notif.keywordsTitle')}>
          {keywords.map((word) => (
            <li key={word} className="flex items-center gap-1 rounded-full bg-d-control2 py-1 pl-3 pr-1 text-sm text-d-strong">
              {word}
              <button
                type="button"
                onClick={() => save(keywords.filter((k) => k !== word))}
                aria-label={t('notif.keywordsRemove', { word })}
                className="rounded-full p-0.5 text-d-text3 hover:bg-d-hover hover:text-d-strong"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}

/** Install as an app: the native prompt where there is one, instructions on iOS. */
function InstallSection({ onToast }) {
  const { installAvailable, installed } = usePwaState();
  if (installed) {
    return (
      <Section title={t('pwa.installTitle')}>
        <p className="flex items-center gap-2 text-sm text-d-online">
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" /> {t('pwa.installed')}
        </p>
      </Section>
    );
  }
  if (!installAvailable && !needsManualInstall()) return null;
  return (
    <Section title={t('pwa.installTitle')}>
      {installAvailable ? (
        <Row label={t('pwa.installLabel')} hint={t('pwa.installHint')} last>
          <Button
            variant="primary"
            onClick={async () => {
              const outcome = await promptInstall();
              if (outcome === 'accepted') onToast?.(t('pwa.installed'), { type: 'success', ttl: 2500 });
            }}
          >
            <Download className="h-4 w-4" /> {t('pwa.install')}
          </Button>
        </Row>
      ) : (
        <Note tone="brand">{t('pwa.iosInstallBody')}</Note>
      )}
    </Section>
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
      <PushSection onToast={onToast} onPermission={setPermission} />
      <Divider />
      <KeywordsSection onToast={onToast} />
      <InstallSection onToast={onToast} />

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
