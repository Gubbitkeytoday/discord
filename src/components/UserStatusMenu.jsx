import React, { Suspense, lazy, useEffect, useRef, useState } from 'react';
import { useDismiss } from '../hooks/useFocusTrap';
import { Settings, Smile, X } from 'lucide-react';
import { t } from '../i18n/index.jsx';
import { setCustomStatus } from '../profile/api';
// Loaded with the app shell, so profile popouts can anchor to whatever opened them.
import '../profile/anchor';
import { CLEAR_AFTER, clearAfterLabel, statusExpiryPayload, expiryText, StatusEmoji } from '../profile/text.jsx';

const EmojiPicker = lazy(() => import('./EmojiPicker'));
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
  const [customText, setCustomText] = useState(currentUser?.custom_status ?? '');
  const [emoji, setEmoji] = useState(currentUser?.custom_status_emoji ?? null);
  const [clearAfter, setClearAfter] = useState('today');
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
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

  // Saved through the profiles API: emoji and "clear after" are enforced by
  // the server (it clears the status and tells everyone when it expires).
  const saveCustom = async (e, clear = false) => {
    e?.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const text = clear ? '' : customText.trim();
      await setCustomStatus({ text, emoji: clear ? null : emoji, ...statusExpiryPayload(clearAfter) });
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };
  const hasStatus = Boolean(currentUser?.custom_status || currentUser?.custom_status_emoji);

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
        <div className="flex items-center gap-1 rounded-[var(--radius-d-sm)] border border-d-divider bg-d-base pl-1 focus-within:border-d-brand">
          <button
            type="button"
            onClick={() => setPicking((v) => !v)}
            aria-label={emoji ? t('profiles.changeEmoji') : t('profiles.pickEmoji')}
            aria-expanded={picking}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-lg text-d-text2 hover:bg-d-hover hover:text-d-strong"
          >
            {emoji ? <StatusEmoji emoji={emoji} className="h-5 w-5" /> : <Smile className="h-5 w-5" aria-hidden="true" />}
          </button>
          <input
            id="custom-status-input"
            value={customText}
            onChange={(e) => setCustomText(e.target.value)}
            maxLength={128}
            placeholder={t('status.customPlaceholder')}
            className="min-w-0 flex-1 bg-transparent py-2 pr-1 text-sm text-d-strong placeholder:text-d-text3 focus:outline-none"
          />
          {(customText || emoji) && (
            <button type="button" onClick={() => { setCustomText(''); setEmoji(null); }}
              aria-label={t('profiles.clearField')}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-d-text3 hover:text-d-strong">
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>
        {picking && (
          <div className="absolute bottom-full left-0 z-50 mb-2">
            <Suspense fallback={null}>
              <EmojiPicker
                onClose={() => setPicking(false)}
                onPick={(entry) => {
                  setEmoji(entry.custom || entry.id ? `<${entry.animated ? 'a' : ''}:${entry.name}:${entry.id}>` : entry.char);
                  setPicking(false);
                }}
              />
            </Suspense>
          </div>
        )}
        <label htmlFor="custom-status-expiry" className="mt-2 block text-xs font-semibold text-d-text2">
          {t('profiles.clearAfter')}
        </label>
        <select
          id="custom-status-expiry"
          value={clearAfter}
          onChange={(e) => setClearAfter(e.target.value)}
          className="mt-1 min-h-8 w-full rounded-[var(--radius-d-sm)] border border-d-divider bg-d-base px-2 text-sm text-d-strong focus:border-d-brand focus:outline-none"
        >
          {CLEAR_AFTER.map((value) => <option key={value} value={value}>{clearAfterLabel(value)}</option>)}
        </select>
        {hasStatus && currentUser?.custom_status_expires_at && (
          <p className="mt-1 text-xs text-d-text3">{expiryText(currentUser.custom_status_expires_at)}</p>
        )}
        {error && <p role="alert" className="mt-1 text-xs text-d-danger">{error}</p>}
        <div className="mt-2 flex gap-2">
          {hasStatus && (
            <button
              type="button"
              onClick={(e) => saveCustom(e, true)}
              disabled={saving}
              className="min-h-8 flex-1 rounded-[var(--radius-d-sm)] bg-d-surface py-1.5 text-sm font-semibold text-d-strong hover:bg-d-hover disabled:opacity-50"
            >
              {t('profiles.clearStatus')}
            </button>
          )}
          <button
            type="submit"
            disabled={saving}
            className="min-h-8 flex-1 rounded-[var(--radius-d-sm)] bg-d-brand py-1.5 text-sm font-semibold text-white
              transition-colors hover:bg-d-brandhover disabled:opacity-50"
          >
            {t('common.save')}
          </button>
        </div>
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
