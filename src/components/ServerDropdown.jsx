import React, { useEffect, useRef } from 'react';
import { useDismiss, useEscapeLayer } from '../hooks/useFocusTrap';
import { t } from '../i18n/index.jsx';
import { getPreferences } from '../hooks/useUserSettings';
import {
  UserPlus, Settings, FolderPlus, Plus, Bell, BellOff, Shield, LogOut, Trash2, Copy, Calendar, Volume2, ShieldCheck
} from 'lucide-react';

/**
 * The menu behind the server name, mirroring Discord's. Items that need a
 * permission are hidden rather than disabled — a menu full of greyed-out rows
 * tells members what they are missing but not why.
 *
 * Keyboard: focus moves into the menu when it opens; ↑/↓/Home/End move
 * between items; Escape (or Tab) closes it and focus returns to the server name.
 */
const SETTINGS_PERMISSIONS = [
  'MANAGE_GUILD', 'MANAGE_CHANNELS', 'MANAGE_ROLES', 'MANAGE_EMOJIS', 'MANAGE_WEBHOOKS',
  'MANAGE_MESSAGES', 'VIEW_AUDIT_LOG', 'BAN_MEMBERS', 'KICK_MEMBERS', 'MODERATE_MEMBERS'
];

export default function ServerDropdown({
  server, permissions, isOwner, muted, onClose,
  onOpenSettings, onCreateChannel, onCreateCategory, onCreateInvite, onOpenNotifications, onOpenEvents,
  onLeave, onDelete, onToast
}) {
  const ref = useRef(null);

  // An outside click closes without pulling focus back to the header.
  useDismiss(ref, () => onClose({ returnFocus: false }));
  useEscapeLayer(() => onClose({ returnFocus: true }));

  const can = (name) => permissions?.includes(name) || permissions?.includes('ADMINISTRATOR') || isOwner;

  // The action may open a dialog that takes focus; don't fight it.
  const run = (fn) => () => { onClose({ returnFocus: false }); fn?.(); };

  // Server Settings is not only for admins: moderators need Bans, Reports and
  // the Audit log, and the modal itself hides every tab they cannot use.
  const canOpenSettings = SETTINGS_PERMISSIONS.some(can);

  const items = [
    can('CREATE_INSTANT_INVITE') && {
      icon: UserPlus, label: t('server.invitePeople'), accent: true, action: run(onCreateInvite)
    },
    onOpenEvents && { icon: Calendar, label: t('events.title'), action: run(onOpenEvents) },
    canOpenSettings && { icon: Settings, label: t('server.settings'), action: run(onOpenSettings) },
    can('MANAGE_GUILD') && { icon: ShieldCheck, label: t('adm.safetySetup'), action: run(() => onOpenSettings('safety')) },
    can('MANAGE_CHANNELS') && { icon: Plus, label: t('server.createChannel'), action: run(() => onCreateChannel('text')) },
    can('MANAGE_CHANNELS') && { icon: Volume2, label: t('sidebar.createVoiceChannel'), action: run(() => onCreateChannel('voice')) },
    can('MANAGE_CHANNELS') && onCreateCategory && { icon: FolderPlus, label: t('adm.createCategory'), action: run(onCreateCategory) },
    { separator: true },
    {
      icon: muted ? BellOff : Bell,
      label: t('server.notificationSettings'),
      action: run(() => {
        const rect = ref.current?.getBoundingClientRect();
        onOpenNotifications?.((rect?.right ?? 260) + 8, rect?.top ?? 60);
      })
    },
    can('MANAGE_ROLES') && { icon: Shield, label: t('server.manageRoles'), action: run(() => onOpenSettings('roles')) },
    getPreferences().chat.developerMode && {
      icon: Copy, label: t('server.copyId'),
      action: run(() => {
        navigator.clipboard?.writeText(server.id);
        onToast?.(t('common.copied'), { type: 'success', ttl: 2000 });
      })
    },
    // The destructive items sit last, behind their own divider, as on Discord.
    { separator: true },
    !isOwner && { icon: LogOut, label: t('server.leave'), danger: true, action: run(onLeave) },
    isOwner && { icon: Trash2, label: t('server.delete'), danger: true, action: run(onDelete) }
  ].filter(Boolean);

  useEffect(() => {
    ref.current?.querySelector('[role="menuitem"]')?.focus({ preventScroll: true });
  }, []);

  const onKeyDown = (e) => {
    const list = [...(ref.current?.querySelectorAll('[role="menuitem"]') ?? [])];
    if (list.length === 0) return;
    const at = list.indexOf(document.activeElement);
    let next = null;
    if (e.key === 'ArrowDown') next = (at + 1) % list.length;
    else if (e.key === 'ArrowUp') next = (at - 1 + list.length) % list.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = list.length - 1;
    else if (e.key === 'Tab') { onClose({ returnFocus: !e.shiftKey }); return; }
    if (next === null) return;
    e.preventDefault();
    list[next].focus();
  };

  return (
    <div
      ref={ref}
      id="server-menu"
      role="menu"
      aria-label={t('adm.serverMenu', { name: server.name })}
      onKeyDown={onKeyDown}
      className="absolute left-2 right-2 top-12 z-50 bg-d-sunken border border-d-surface rounded-md shadow-2xl py-1.5"
    >
      {items.map((item, index) =>
        item.separator ? (
          <div key={`sep-${index}`} role="separator" className="h-[1px] bg-d-surface my-1 mx-2" />
        ) : (
          <button
            key={item.label}
            role="menuitem"
            tabIndex={-1}
            onClick={item.action}
            className={`w-[calc(100%-12px)] mx-1.5 min-h-[32px] flex items-center justify-between gap-2 px-2 py-1.5 rounded text-sm text-left transition-colors focus:outline-none ${
              item.danger
                ? 'text-d-danger hover:bg-d-danger hover:text-white focus:bg-d-danger focus:text-white'
                : item.accent
                ? 'text-d-link hover:bg-d-brand hover:text-white focus:bg-d-brand focus:text-white'
                : 'text-d-text2 hover:bg-d-brand hover:text-white focus:bg-d-brand focus:text-white'
            }`}
          >
            <span className="min-w-0 break-words">{item.label}</span>
            <item.icon className="w-4 h-4 shrink-0" aria-hidden="true" />
          </button>
        )
      )}
    </div>
  );
}
