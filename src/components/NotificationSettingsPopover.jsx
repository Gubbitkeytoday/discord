import React, { useEffect, useRef, useState } from 'react';
import { useDismiss } from '../hooks/useFocusTrap';
import { Bell, BellOff, Check, ArrowUp, ArrowDown } from 'lucide-react';
import { t } from '../i18n/index.jsx';
import useRestoreFocus from './ui/useRestoreFocus.js';
import { get, put } from '../api';
import { ToggleRow } from './ui/Toggle.jsx';
import { menuItem, menuSeparator, menuHeading, menuSurface, MENU_ICON } from './ui/menu.js';
import { moveServerInRail, canMoveServerInRail } from './ServerRail.jsx';

const MUTE_DURATIONS = () => [
  { minutes: 15,    label: t('notif.mute15m') },
  { minutes: 60,    label: t('notif.mute1h') },
  { minutes: 180,   label: t('notif.mute3h') },
  { minutes: 480,   label: t('notif.mute8h') },
  { minutes: 1440,  label: t('notif.mute24h') },
  { minutes: 10080, label: t('notif.mute1w') },
  { minutes: 0,     label: t('notif.muteForever') }
];

const LEVEL_LABEL = () => ({
  all_messages: t('notif.allMessages'),
  only_mentions: t('notif.onlyMentions'),
  nothing: t('notif.nothing')
});

const isMuteActive = (s) => Boolean(s?.muted)
  && (!s?.muted_until || Date.parse(s.muted_until) > Date.now());

/** The radio "dot" and checkbox "tick" drawn at the end of a row. */
function RadioMark({ on }) {
  return (
    <span aria-hidden="true" className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 ${on ? 'border-current' : 'border-d-text3'}`}>
      {on && <span className="h-2.5 w-2.5 rounded-full bg-current" />}
    </span>
  );
}
function CheckMark({ on }) {
  return (
    <span aria-hidden="true" className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border-2 ${on ? 'border-d-brand bg-d-brand' : 'border-d-text3'}`}>
      {on && <Check className="h-3.5 w-3.5 text-white" strokeWidth={3} />}
    </span>
  );
}

/**
 * Discord's per-channel / per-server notification menu: mute with a duration,
 * the notification level (a channel or thread can follow its parent/server),
 * and, for a server, suppressing @everyone/@here and role mentions, plus
 * Move up / Move down (the keyboard alternative to dragging it in the rail).
 *
 * Every row is one target at least 32px tall (40px for the mute switch), the
 * whole row is clickable, and focus moves with ↑/↓ like a native menu.
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
  useRestoreFocus(ref);

  useEffect(() => {
    if (!endpoint) return undefined;
    let cancelled = false;
    get(endpoint).then((value) => { if (!cancelled) setDetail(value); }).catch(() => {});
    return () => { cancelled = true; };
  }, [endpoint]);

  // Focus the first item so the menu is usable from the keyboard at once.
  useEffect(() => {
    ref.current?.querySelector('[role^="menuitem"]')?.focus();
  }, []);

  const onKeyDown = (event) => {
    const items = [...(ref.current?.querySelectorAll('[role^="menuitem"]:not([disabled])') ?? [])];
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement);
    let next = null;
    if (event.key === 'ArrowDown') next = items[(index + 1) % items.length];
    else if (event.key === 'ArrowUp') next = items[(index - 1 + items.length) % items.length];
    else if (event.key === 'Home') next = items[0];
    else if (event.key === 'End') next = items[items.length - 1];
    if (!next) return;
    event.preventDefault();
    next.focus();
  };

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

  const width = 300;
  const style = {
    left: Math.max(8, Math.min(x, window.innerWidth - width - 8)),
    top: Math.max(8, Math.min(y, window.innerHeight - (kind === 'server' ? 560 : 440)))
  };

  const muteLabel = kind === 'channel' ? t('notif.muteChannel') : t('notif.muteServer');
  const move = (delta) => {
    moveServerInRail(target.id, delta);
    onClose();
  };

  return (
    <div
      ref={ref}
      role="menu"
      aria-label={t('notif.notificationSettings')}
      onKeyDown={onKeyDown}
      style={{ ...style, width: `min(${width}px, calc(100vw - 16px))` }}
      className={`fixed z-[60] max-h-[calc(100dvh-16px)] overflow-y-auto overscroll-contain text-sm ${menuSurface}`}
    >
      <p className={`${menuHeading} truncate`} title={target?.name ?? ''}>
        {kind === 'channel' ? `#${target?.name ?? ''}` : target?.name ?? ''}
      </p>

      {onMarkRead && (
        <>
          <button type="button" role="menuitem" onClick={() => { onMarkRead(); onClose(); }} className={menuItem}>
            <Check size={MENU_ICON} aria-hidden="true" /> {t('notif.markRead')}
          </button>
          <div className={menuSeparator} role="separator" />
        </>
      )}

      {/* The whole row is the switch: label, hint and pill. Turning mute ON
          first asks for how long, like Discord. */}
      <div className="px-1.5">
        <ToggleRow
          role="menuitemcheckbox"
          icon={muted ? BellOff : Bell}
          label={muteLabel}
          hint={muted && mutedUntil
            ? t('notif.mutedUntil', { time: new Date(mutedUntil).toLocaleString() })
            : t(kind === 'channel' ? 'notif.muteChannelHint' : 'notif.muteServerHint')}
          checked={muted}
          onChange={() => (muted
            ? save({ muted: false }, { muted: false, muted_until: null })
            : setShowDurations((v) => !v))}
        />
      </div>

      {showDurations && !muted && (
        <div role="group" aria-label={t('notif.muteFor')} className="mx-1.5 mb-1 rounded-[var(--radius-d-sm)] bg-d-base/60 py-1">
          <p className="px-3 pt-1 pb-1 text-xs font-semibold text-d-text3">{t('notif.muteFor')}</p>
          {MUTE_DURATIONS().map((d) => (
            <button
              key={d.minutes}
              type="button"
              role="menuitem"
              onClick={() => mute(d.minutes)}
              className={menuItem}
            >
              {d.label}
            </button>
          ))}
        </div>
      )}

      <div className={menuSeparator} role="separator" />
      <p className={menuHeading} id="notif-level-heading">{t('notif.level')}</p>
      <div role="group" aria-labelledby="notif-level-heading">
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            role="menuitemradio"
            aria-checked={level === option.value}
            onClick={() => setLevel(option.value)}
            className={`${menuItem} justify-between`}
          >
            <span className="min-w-0 text-left">
              <span className="block">{option.label}</span>
              {option.hint && <span className="block truncate text-xs opacity-80">{option.hint}</span>}
            </span>
            <RadioMark on={level === option.value} />
          </button>
        ))}
      </div>

      {kind === 'server' && (
        <>
          <div className={menuSeparator} role="separator" />
          {[
            ['suppress_everyone', t('notif.suppressEveryone')],
            ['suppress_roles', t('notif.suppressRoles')]
          ].map(([key, label]) => {
            const on = Boolean(detail?.[key] ?? settings?.[key]);
            return (
              <button
                key={key}
                type="button"
                role="menuitemcheckbox"
                aria-checked={on}
                onClick={() => save({ [key]: !on }, null)}
                className={`${menuItem} justify-between`}
              >
                <span className="text-left leading-snug">{label}</span>
                <CheckMark on={on} />
              </button>
            );
          })}

          <div className={menuSeparator} role="separator" />
          <button
            type="button"
            role="menuitem"
            disabled={!canMoveServerInRail(target?.id, -1)}
            onClick={() => move(-1)}
            className={`${menuItem} disabled:opacity-50 disabled:pointer-events-none`}
          >
            <ArrowUp size={MENU_ICON} aria-hidden="true" /> {t('rail.moveUp')}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={!canMoveServerInRail(target?.id, 1)}
            onClick={() => move(1)}
            className={`${menuItem} disabled:opacity-50 disabled:pointer-events-none`}
          >
            <ArrowDown size={MENU_ICON} aria-hidden="true" /> {t('rail.moveDown')}
          </button>
        </>
      )}

      {error && <p role="alert" className="px-3 pt-1 text-xs text-d-danger">{error}</p>}
    </div>
  );
}
