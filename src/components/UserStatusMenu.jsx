import React, { useEffect, useRef, useState } from 'react';
import { Settings, Smile, Circle, Moon, MinusCircle, EyeOff } from 'lucide-react';
import { t } from '../i18n/index.jsx';

const STATUSES = () => [
  { value: 'online',    icon: Circle,      label: t('status.online'),    tint: 'text-d-online' },
  { value: 'idle',      icon: Moon,        label: t('status.idle'),      tint: 'text-d-idle' },
  { value: 'dnd',       icon: MinusCircle, label: t('status.dnd'),       tint: 'text-d-danger', hint: t('status.dndHint') },
  { value: 'invisible', icon: EyeOff,      label: t('status.invisible'), tint: 'text-d-text4',  hint: t('status.invisibleHint') }
];

/** The menu behind your own avatar: presence and a custom status. */
export default function UserStatusMenu({ currentUser, onSetStatus, onOpenSettings, onClose }) {
  const ref = useRef(null);
  const [customStatus, setCustomStatus] = useState(currentUser?.custom_status ?? '');

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

  const saveCustom = (e) => {
    e.preventDefault();
    onSetStatus(currentUser?.status ?? 'online', customStatus.trim());
    onClose();
  };

  return (
    <div
      ref={ref}
      role="menu"
      className="absolute bottom-14 left-2 z-50 w-56 bg-d-sunken border border-d-surface rounded-md shadow-2xl py-1.5"
    >
      {STATUSES().map((option) => (
        <button
          key={option.value}
          role="menuitemradio"
          aria-checked={currentUser?.status === option.value}
          onClick={() => { onSetStatus(option.value); onClose(); }}
          className="w-[calc(100%-12px)] mx-1.5 flex items-start gap-2 px-2 py-1.5 rounded text-sm text-d-text2 hover:bg-d-brand hover:text-white transition-colors text-left"
        >
          <option.icon className={`w-4 h-4 mt-0.5 shrink-0 ${option.tint}`} />
          <span className="min-w-0">
            <span className="block truncate">{option.label}</span>
            {option.hint && <span className="block text-[10px] opacity-70">{option.hint}</span>}
          </span>
        </button>
      ))}

      <div className="h-[1px] bg-d-surface my-1.5 mx-2" />

      <form onSubmit={saveCustom} className="px-2 pb-1">
        <label className="flex items-center gap-2 text-xs text-d-text2 mb-1.5">
          <Smile className="w-4 h-4 shrink-0" />
          <span>{t('status.customStatus')}</span>
        </label>
        <input
          value={customStatus}
          onChange={(e) => setCustomStatus(e.target.value)}
          maxLength={128}
          placeholder={t('status.customPlaceholder')}
          className="w-full bg-d-base text-xs text-d-strong px-2 py-1.5 rounded focus:outline-none focus:ring-1 focus:ring-d-brand"
        />
        <button type="submit" className="mt-1.5 w-full bg-d-brand hover:bg-d-brandhover text-white text-xs font-semibold py-1.5 rounded transition-colors">
          {t('common.save')}
        </button>
      </form>

      <div className="h-[1px] bg-d-surface my-1.5 mx-2" />

      <button
        role="menuitem"
        onClick={() => { onOpenSettings(); onClose(); }}
        className="w-[calc(100%-12px)] mx-1.5 flex items-center gap-2 px-2 py-1.5 rounded text-sm text-d-text2 hover:bg-d-brand hover:text-white transition-colors"
      >
        <Settings className="w-4 h-4 shrink-0" /> {t('sidebar.userSettings')}
      </button>
    </div>
  );
}
