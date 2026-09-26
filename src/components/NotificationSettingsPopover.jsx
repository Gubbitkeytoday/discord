import React, { useEffect, useRef, useState } from 'react';
import { useDismiss } from '../hooks/useFocusTrap';
import { Bell, BellOff, Check } from 'lucide-react';
import { t } from '../i18n/index.jsx';
import { get, put } from '../api';

const MUTE_DURATIONS = () => [
  { minutes: 15,   label: t('notif.mute15m') },
  { minutes: 60,   label: t('notif.mute1h') },
  { minutes: 180,  label: t('notif.mute3h') },
  { minutes: 480,  label: t('notif.mute8h') },
  { minutes: 1440, label: t('notif.mute24h') },
  { minutes: 0,    label: t('notif.muteForever') }
];

const LEVEL_LABEL = () => ({
  all_messages: t('notif.allMessages'),
  only_mentions: t('notif.onlyMentions'),
  nothing: t('notif.nothing')
});

const isMuteActive = (s) => Boolean(s?.muted)
  && (!s?.muted_until || Date.parse(s.muted_until) > Date.now());

/**
 * Discord's per-channel / per-server notification menu: mute with a duration,
 * the notification level (a channel or thread can follow its parent/server),
 * and — for a server — suppressing @everyone/@here and role mentions.
 *
 * Reads and writes /api/notification-settings (the server's source of truth
 * for what notifies), and reports each change through `onChange` so the app's
 * own settings state stays in step.
 */
export default function NotificationSettingsPopover({
  kind, target, settings, x, y, onChange, onMarkRead, onClose
}) {
  const ref = useRef(null);
  const [showDurations, setShowDurations] = useState(false);
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const endpoint = target?.id
    ? `/api/notification-settings/${kind === 'channel' ? 'channels' : 'servers'}/${encodeURIComponent(target.id)}`
    : null;

  useDismiss(ref, onClose);

  useEffect(() => {
    if (!endpoint) return undefined;
    let cancelled = false;
    get(endpoint).then((value) => { if (!cancelled) setDetail(value); }).catch(() => {});
    return () => { cancelled = true; };
  }, [endpoint]);

  const muted = detail ? Boolean(detail.muted) : isMuteActive(settings);
  const mutedUntil = detail ? detail.muted_until : (isMuteActive(settings) ? settings?.muted_until : null);
  // Channel: 'inherit' | level. Server: null (server default) | level.
  const level = kind === 'channel'
    ? (detail?.level ?? settings?.notification_level ?? 'inherit')
    : (detail ? (detail.level ?? 'inherit') : (settings?.level_override ?? 'inherit'));
  const labels = LEVEL_LABEL();
  const inheritedLabel = kind === 'channel'
    ? (detail && level === 'inherit' ? labels[detail.effective_level] : null)
    : (detail ? labels[detail.server_default] : null);

  const save = async (body, appPatch) => {
    setError(null);
    try {
      if (endpoint) setDetail(await put(endpoint, body));
      if (appPatch) onChange?.(appPatch);
    } catch (err) {
      setError(err?.message ?? String(err));
    }
  };

  const mute = (minutes) => {
    const until = minutes ? new Date(Date.now() + minutes * 60_000).toISOString() : null;
    save({ mute_minutes: minutes }, { muted: true, muted_until: until });
    setShowDurations(false);
    onClose();
  };

  const setLevel = (value) => {
    if (kind === 'channel') {
      save({ level: value }, { notification_level: value });
    } else {
      save({ level: value === 'inherit' ? null : value },
        { notification_level: value === 'inherit' ? 'all_messages' : value, level_override: value === 'inherit' ? null : value });
    }
  };

  const options = [
    {
      value: 'inherit',
      label: kind === 'channel' ? t('notif.useDefault') : t('notif.useServerDefault'),
      hint: inheritedLabel
    },
    { value: 'all_messages', label: labels.all_messages },
    { value: 'only_mentions', label: labels.only_mentions },
    { value: 'nothing', label: labels.nothing }
  ];

  const style = {
    left: Math.max(8, Math.min(x, window.innerWidth - 280)),
    top: Math.max(8, Math.min(y, window.innerHeight - (kind === 'server' ? 470 : 390)))
  };

  const item = 'w-[calc(100%-12px)] mx-1.5 flex items-center justify-between gap-2 px-2 py-1.5 rounded text-d-text2 hover:bg-d-brand hover:text-white transition-colors';

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={t('notif.notificationSettings')}
      style={style}
      className="fixed z-[60] w-64 max-h-[calc(100vh-16px)] overflow-y-auto bg-d-sunken border border-d-surface rounded-md shadow-2xl py-2 text-sm"
    >
      <p className="px-3 pb-2 text-[11px] font-bold text-d-text3 uppercase truncate">
        {kind === 'channel' ? `#${target?.name ?? ''}` : target?.name ?? ''}
      </p>

      {onMarkRead && (
        <>
          <button role="menuitem" onClick={() => { onMarkRead(); onClose(); }} className={`${item} justify-start`}>
            <Check className="w-4 h-4" /> {t('notif.markRead')}
          </button>
          <div className="h-[1px] bg-d-surface my-1.5 mx-2" />
        </>
      )}

      <div className="px-3 py-1.5 flex items-center justify-between gap-2">
        <span className="flex items-center gap-2 text-d-text2">
          {muted ? <BellOff className="w-4 h-4" /> : <Bell className="w-4 h-4" />}
          {kind === 'channel' ? t('notif.muteChannel') : t('notif.muteServer')}
        </span>
        <button
          role="switch"
          aria-checked={muted}
          aria-label={kind === 'channel' ? t('notif.muteChannel') : t('notif.muteServer')}
          onClick={() => (muted
            ? save({ muted: false }, { muted: false, muted_until: null })
            : setShowDurations((v) => !v))}
          className={`w-10 h-5 rounded-full relative transition-colors shrink-0 ${muted ? 'bg-d-brand' : 'bg-d-text4'}`}
        >
          <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${muted ? 'left-[22px]' : 'left-0.5'}`} />
        </button>
      </div>
      <p className="px-3 pb-1 text-[10px] text-d-text4 leading-snug">
        {muted && mutedUntil
          ? t('notif.mutedUntil', { time: new Date(mutedUntil).toLocaleString() })
          : t(kind === 'channel' ? 'notif.muteChannelHint' : 'notif.muteServerHint')}
      </p>

      {showDurations && !muted && (
        <div className="mx-1.5 mb-1 rounded bg-d-base/60 py-1">
          {MUTE_DURATIONS().map((d) => (
            <button
              key={d.minutes}
              role="menuitem"
              onClick={() => mute(d.minutes)}
              className="w-full text-left px-3 py-1.5 text-xs text-d-text2 hover:bg-d-brand hover:text-white rounded transition-colors"
            >
              {d.label}
            </button>
          ))}
        </div>
      )}

      <div className="h-[1px] bg-d-surface my-1.5 mx-2" />
      <p className="px-3 pb-1 text-[11px] font-bold text-d-text3 uppercase">{t('notif.level')}</p>
      {options.map((option) => (
        <button
          key={option.value}
          role="menuitemradio"
          aria-checked={level === option.value}
          onClick={() => setLevel(option.value)}
          className={item}
        >
          <span className="min-w-0 text-left">
            <span className="block truncate">{option.label}</span>
            {option.hint && <span className="block truncate text-[10px] opacity-75">{option.hint}</span>}
          </span>
          <span className={`w-3.5 h-3.5 rounded-full border-2 shrink-0 ${level === option.value ? 'border-d-brand bg-d-brand' : 'border-d-text4'}`} />
        </button>
      ))}

      {kind === 'server' && (
        <>
          <div className="h-[1px] bg-d-surface my-1.5 mx-2" />
          {[
            ['suppress_everyone', t('notif.suppressEveryone')],
            ['suppress_roles', t('notif.suppressRoles')]
          ].map(([key, label]) => {
            const on = Boolean(detail?.[key] ?? settings?.[key]);
            return (
              <button
                key={key}
                role="menuitemcheckbox"
                aria-checked={on}
                onClick={() => save({ [key]: !on }, null)}
                className={item}
              >
                <span className="text-left leading-snug">{label}</span>
                <span className={`w-3.5 h-3.5 rounded-sm border-2 shrink-0 flex items-center justify-center ${on ? 'border-d-brand bg-d-brand' : 'border-d-text4'}`}>
                  {on && <Check className="w-2.5 h-2.5 text-white" />}
                </span>
              </button>
            );
          })}
        </>
      )}

      {error && <p role="alert" className="px-3 pt-1 text-[11px] text-d-danger">{error}</p>}
    </div>
  );
}
