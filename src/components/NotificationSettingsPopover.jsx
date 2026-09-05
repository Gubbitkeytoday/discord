import React, { useEffect, useRef, useState } from 'react';
import { Bell, BellOff, Check } from 'lucide-react';
import { t } from '../i18n/index.jsx';

const MUTE_DURATIONS = () => [
  { minutes: 15,   label: t('notif.mute15m') },
  { minutes: 60,   label: t('notif.mute1h') },
  { minutes: 180,  label: t('notif.mute3h') },
  { minutes: 480,  label: t('notif.mute8h') },
  { minutes: 1440, label: t('notif.mute24h') },
  { minutes: 0,    label: t('notif.muteForever') }
];

const CHANNEL_LEVELS = () => [
  { value: 'inherit',        label: t('notif.useServerDefault') },
  { value: 'all_messages',   label: t('notif.allMessages') },
  { value: 'only_mentions',  label: t('notif.onlyMentions') },
  { value: 'nothing',        label: t('notif.nothing') }
];

const SERVER_LEVELS = () => [
  { value: 'all_messages',   label: t('notif.allMessages') },
  { value: 'only_mentions',  label: t('notif.onlyMentions') },
  { value: 'nothing',        label: t('notif.nothing') }
];

/**
 * Discord's per-channel / per-server notification menu: a mute switch with
 * durations, plus the notification level. Both persist per user.
 */
export default function NotificationSettingsPopover({
  kind, target, settings, x, y, onChange, onMarkRead, onClose
}) {
  const ref = useRef(null);
  const [showDurations, setShowDurations] = useState(false);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    const onClick = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    window.addEventListener('keydown', onKey);
    const timer = setTimeout(() => window.addEventListener('mousedown', onClick), 0);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClick);
      clearTimeout(timer);
    };
  }, [onClose]);

  const muted = Boolean(settings?.muted);
  const level = settings?.notification_level ?? (kind === 'channel' ? 'inherit' : 'all_messages');
  const levels = kind === 'channel' ? CHANNEL_LEVELS() : SERVER_LEVELS();

  const mute = (minutes) => {
    onChange({
      muted: true,
      muted_until: minutes ? new Date(Date.now() + minutes * 60_000).toISOString() : null
    });
    setShowDurations(false);
    onClose();
  };

  const style = {
    left: Math.min(x, window.innerWidth - 280),
    top: Math.min(y, window.innerHeight - 340)
  };

  return (
    <div
      ref={ref}
      role="menu"
      style={style}
      className="fixed z-[60] w-64 bg-d-sunken border border-d-surface rounded-md shadow-2xl py-2 text-sm"
    >
      <p className="px-3 pb-2 text-[11px] font-bold text-d-text3 uppercase truncate">
        {kind === 'channel' ? `#${target?.name ?? ''}` : target?.name ?? ''}
      </p>

      {onMarkRead && (
        <>
          <button
            role="menuitem"
            onClick={() => { onMarkRead(); onClose(); }}
            className="w-[calc(100%-12px)] mx-1.5 flex items-center gap-2 px-2 py-1.5 rounded text-d-text2 hover:bg-d-brand hover:text-white transition-colors"
          >
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
          onClick={() => (muted ? onChange({ muted: false, muted_until: null }) : setShowDurations((v) => !v))}
          className={`w-10 h-5 rounded-full relative transition-colors shrink-0 ${muted ? 'bg-d-brand' : 'bg-d-text4'}`}
        >
          <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-all ${muted ? 'left-[22px]' : 'left-0.5'}`} />
        </button>
      </div>

      {settings?.muted_until && muted && (
        <p className="px-3 pb-1 text-[10px] text-d-text4">
          {t('notif.mutedUntil', { time: new Date(settings.muted_until).toLocaleString() })}
        </p>
      )}

      {showDurations && !muted && (
        <div className="mx-1.5 mb-1 rounded bg-d-base/60 py-1">
          {MUTE_DURATIONS().map((d) => (
            <button
              key={d.minutes}
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
      {levels.map((option) => (
        <button
          key={option.value}
          role="menuitemradio"
          aria-checked={level === option.value}
          onClick={() => onChange({ notification_level: option.value })}
          className="w-[calc(100%-12px)] mx-1.5 flex items-center justify-between gap-2 px-2 py-1.5 rounded text-d-text2 hover:bg-d-brand hover:text-white transition-colors"
        >
          <span className="truncate">{option.label}</span>
          <span className={`w-3.5 h-3.5 rounded-full border-2 shrink-0 ${level === option.value ? 'border-d-brand bg-d-brand' : 'border-d-text4'}`} />
        </button>
      ))}
    </div>
  );
}
