import React, { useEffect, useRef } from 'react';
import { t } from '../i18n/index.jsx';
import { getPreferences } from '../hooks/useUserSettings';
import {
  UserPlus, Settings, FolderPlus, Plus, Bell, BellOff, Shield, LogOut, Trash2, Copy, Calendar
} from 'lucide-react';

/**
 * The menu behind the server name, mirroring Discord's. Items that need a
 * permission are hidden rather than disabled — a menu full of greyed-out rows
 * tells members what they are missing but not why.
 */
export default function ServerDropdown({
  server, permissions, isOwner, muted, onClose,
  onOpenSettings, onCreateChannel, onCreateInvite, onOpenNotifications, onOpenEvents, onLeave, onDelete, onToast
}) {
  const ref = useRef(null);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    const onClick = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    window.addEventListener('keydown', onKey);
    // Deferred so the click that opened the menu does not immediately close it.
    const timer = setTimeout(() => window.addEventListener('mousedown', onClick), 0);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClick);
      clearTimeout(timer);
    };
  }, [onClose]);

  const can = (name) => permissions?.includes(name) || permissions?.includes('ADMINISTRATOR') || isOwner;

  const run = (fn) => () => { fn?.(); onClose(); };

  const items = [
    can('CREATE_INSTANT_INVITE') && {
      icon: UserPlus, label: t('server.invitePeople'), accent: true, action: run(onCreateInvite)
    },
    onOpenEvents && { icon: Calendar, label: t('events.title'), action: run(onOpenEvents) },
    can('MANAGE_GUILD') && { icon: Settings, label: t('server.settings'), action: run(onOpenSettings) },
    can('MANAGE_CHANNELS') && { icon: Plus, label: t('server.createChannel'), action: run(() => onCreateChannel('text')) },
    can('MANAGE_CHANNELS') && { icon: FolderPlus, label: t('sidebar.createVoiceChannel'), action: run(() => onCreateChannel('voice')) },
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
    { separator: true },
    !isOwner && { icon: LogOut, label: t('server.leave'), danger: true, action: run(onLeave) },
    isOwner && { icon: Trash2, label: t('server.delete'), danger: true, action: run(onDelete) }
  ].filter(Boolean);

  return (
    <div
      ref={ref}
      role="menu"
      className="absolute left-2 right-2 top-12 z-50 bg-d-sunken border border-d-surface rounded-md shadow-2xl py-1.5"
    >
      {items.map((item, index) =>
        item.separator ? (
          <div key={`sep-${index}`} className="h-[1px] bg-d-surface my-1 mx-2" />
        ) : (
          <button
            key={item.label}
            role="menuitem"
            onClick={item.action}
            className={`w-[calc(100%-12px)] mx-1.5 flex items-center justify-between gap-2 px-2 py-1.5 rounded text-sm transition-colors ${
              item.danger
                ? 'text-d-danger hover:bg-d-danger hover:text-white'
                : item.accent
                ? 'text-d-mint hover:bg-d-success hover:text-white'
                : 'text-d-text2 hover:bg-d-brand hover:text-white'
            }`}
          >
            <span className="truncate">{item.label}</span>
            <item.icon className="w-4 h-4 shrink-0" />
          </button>
        )
      )}
    </div>
  );
}
