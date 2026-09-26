import React from 'react';
import { X } from 'lucide-react';
import { t } from '../i18n/index.jsx';
import { useUserSettings } from '../hooks/useUserSettings';
import { formatBinding } from '../hooks/useKeybinds';
import { keybindGroups } from './settings/KeybindsTab';
import { useDialog } from './settings/primitives';

/** Ctrl+/ — every shortcut as currently bound, grouped like Settings › Keybinds. */
export default function ShortcutsModal({ onClose, onOpenKeybinds }) {
  const dialogRef = useDialog(onClose);
  const { prefs } = useUserSettings();
  const fixed = [
    { label: t('shortcuts.escape'), binding: 'Escape' },
    { label: t('shortcuts.reply'), binding: t('shortcuts.replyKeys') },
    { label: t('shortcuts.newline'), binding: 'Shift+Enter' }
  ];
  return (
    <div className="fixed inset-0 z-[80] bg-black/60 flex items-center justify-center overlay-center p-4" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="shortcuts-title" className="w-full max-w-2xl rounded-lg bg-d-canvas border border-d-edge shadow-2xl">
        <header className="flex items-center justify-between px-5 pt-4">
          <h2 id="shortcuts-title" className="text-lg font-bold text-d-strong">{t('shortcuts.title')}</h2>
          <button type="button" onClick={onClose} aria-label={t('common.close')} className="p-1 text-d-text3 hover:text-d-strong">
            <X className="w-5 h-5" />
          </button>
        </header>
        <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-5 max-h-[70vh] overflow-y-auto">
          {keybindGroups().map((group) => (
            <section key={group.title}>
              <h3 className="text-xs font-bold text-d-text2 uppercase mb-2">{group.title}</h3>
              <dl className="space-y-1.5">
                {group.actions.map((action) => (
                  <div key={action.key} className="flex items-center justify-between gap-3 text-sm">
                    <dt className="text-d-text">{action.label}</dt>
                    <dd><kbd className="font-mono text-xs bg-d-surface text-d-strong px-1.5 py-0.5 rounded border border-d-edge whitespace-nowrap">{formatBinding(prefs.keybinds[action.key])}</kbd></dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
          <section>
            <h3 className="text-xs font-bold text-d-text2 uppercase mb-2">{t('shortcuts.always')}</h3>
            <dl className="space-y-1.5">
              {fixed.map((row) => (
                <div key={row.label} className="flex items-center justify-between gap-3 text-sm">
                  <dt className="text-d-text">{row.label}</dt>
                  <dd><kbd className="font-mono text-xs bg-d-surface text-d-strong px-1.5 py-0.5 rounded border border-d-edge whitespace-nowrap">{row.binding}</kbd></dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
        <footer className="px-5 pb-4">
          <button type="button" onClick={onOpenKeybinds} className="text-sm text-d-link hover:underline">{t('shortcuts.customize')}</button>
        </footer>
      </div>
    </div>
  );
}
