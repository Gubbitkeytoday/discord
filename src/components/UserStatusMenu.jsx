import React, { useEffect, useRef, useState } from 'react';
import { useDismiss } from '../hooks/useFocusTrap';
import { Settings, Smile } from 'lucide-react';
import { t } from '../i18n/index.jsx';
import useRestoreFocus from './ui/useRestoreFocus.js';
import StatusIndicator from './ui/StatusIndicator.jsx';
import { menuItem, menuSeparator, menuSurface } from './ui/menu.js';

const STATUSES = () => [
  { value: 'online',    label: t('status.online') },
  { value: 'idle',      label: t('status.idle') },
  { value: 'dnd',       label: t('status.dnd'),       hint: t('status.dndHint') },
  { value: 'invisible', label: t('status.invisible'), hint: t('status.invisibleHint') }
];

/**
 * The popover behind your own avatar: presence and a custom status.
 *
 * Each presence is drawn with Discord's shape (dot, moon, bar, ring), not just
 * a colour, so it reads with colour-blindness. The presence choices are a real
 * menu (↑/↓/Home/End, focus lands on the current one); the custom-status form
 * and the Settings shortcut sit beside it in the same dialog, since a form is
 * not allowed inside role="menu".
 */
export default function UserStatusMenu({ currentUser, onSetStatus, onOpenSettings, onClose }) {
  const ref = useRef(null);
  const menuRef = useRef(null);
  const [customStatus, setCustomStatus] = useState(currentUser?.custom_status ?? '');
  const current = currentUser?.status ?? 'online';

  useDismiss(ref, onClose);
  useRestoreFocus(ref);

  // Open with focus on the status you have now, like a native menu.
  useEffect(() => {
    const items = menuRef.current?.querySelectorAll('[role="menuitemradio"]');
    const checked = menuRef.current?.querySelector('[aria-checked="true"]');
    (checked ?? items?.[0])?.focus();
  }, []);

  const onMenuKeyDown = (event) => {
    const items = [...(menuRef.current?.querySelectorAll('[role="menuitemradio"]') ?? [])];
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

  const saveCustom = (e) => {
    e.preventDefault();
    onSetStatus(current, customStatus.trim());
    onClose();
  };

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="false"
      aria-label={t('status.label')}
      className={`absolute bottom-14 left-2 z-50 w-64 ${menuSurface}`}
    >
      <div ref={menuRef} role="menu" aria-label={t('status.label')} onKeyDown={onMenuKeyDown}>
        {STATUSES().map((option) => {
          const checked = current === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="menuitemradio"
              aria-checked={checked}
              tabIndex={checked ? 0 : -1}
              onClick={() => { onSetStatus(option.value); onClose(); }}
              className={`${menuItem} items-start py-2 ${checked ? 'bg-d-active' : ''}`}
            >
              <StatusIndicator status={option.value} size={12} decorative className="mt-1" />
              <span className="min-w-0">
                <span className="block font-medium">{option.label}</span>
                {Boolean(option.hint) && <span className="mt-0.5 block text-xs leading-snug opacity-80">{option.hint}</span>}
              </span>
            </button>
          );
        })}
      </div>

      <div className={menuSeparator} />

      <form onSubmit={saveCustom} className="px-3 pb-1">
        <label htmlFor="custom-status-input" className="mb-1.5 flex items-center gap-2 text-xs font-semibold text-d-text2">
          <Smile className="h-4 w-4 shrink-0" aria-hidden="true" />
          <span>{t('status.customStatus')}</span>
        </label>
        <input
          id="custom-status-input"
          value={customStatus}
          onChange={(e) => setCustomStatus(e.target.value)}
          maxLength={128}
          placeholder={t('status.customPlaceholder')}
          className="w-full rounded-[var(--radius-d-sm)] bg-d-base px-2 py-2 text-sm text-d-strong placeholder:text-d-text3
            border border-d-divider focus:border-d-brand focus:outline-none"
        />
        <button
          type="submit"
          className="mt-2 min-h-8 w-full rounded-[var(--radius-d-sm)] bg-d-brand py-1.5 text-sm font-semibold text-white
            transition-colors hover:bg-d-brandhover"
        >
          {t('common.save')}
        </button>
      </form>

      <div className={menuSeparator} />

      <button
        type="button"
        onClick={() => { onOpenSettings(); onClose(); }}
        className={menuItem}
      >
        <Settings className="h-[18px] w-[18px] shrink-0" aria-hidden="true" /> {t('sidebar.userSettings')}
      </button>
    </div>
  );
}
