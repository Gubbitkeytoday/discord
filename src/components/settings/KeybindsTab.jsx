import React, { useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import { useUserSettings } from '../../hooks/useUserSettings';
import { describeKeyEvent, formatBinding, findConflicts } from '../../hooks/useKeybinds';
import { t } from '../../i18n/index.jsx';
import { PageHeader, Section, Row, ResetButton, Note } from './primitives';

const GROUPS = () => [
  {
    title: t('keys.groupVoice'),
    actions: [
      { key: 'pushToTalk',      label: t('keys.pushToTalk'), hint: t('keys.pushToTalkHint') },
      { key: 'toggleMute',      label: t('keys.toggleMute') },
      { key: 'toggleDeafen',    label: t('keys.toggleDeafen') },
      { key: 'disconnectVoice', label: t('keys.disconnectVoice') }
    ]
  },
  {
    title: t('keys.groupNavigation'),
    actions: [
      { key: 'quickSwitcher',       label: t('keys.quickSwitcher') },
      { key: 'navigateChannelUp',   label: t('keys.navigateChannelUp') },
      { key: 'navigateChannelDown', label: t('keys.navigateChannelDown') },
      { key: 'markServerRead',      label: t('keys.markServerRead') }
    ]
  },
  {
    title: t('keys.groupOther'),
    actions: [
      { key: 'toggleStreamerMode', label: t('keys.toggleStreamerMode') }
    ]
  }
];

/**
 * Keybinds. Capturing a binding listens for the next real key press, so what is
 * recorded is exactly what the hotkey engine will later match against — and it
 * records `event.code`, not `event.key`, so a Thai keyboard layout does not
 * silently change which physical key a shortcut lives on.
 */
export default function KeybindsTab({ onToast }) {
  const { prefs, update, reset } = useUserSettings();
  const keybinds = prefs.keybinds;
  const [capturing, setCapturing] = useState(null);
  const conflicts = findConflicts(keybinds);

  const capture = (action) => (event) => {
    event.preventDefault();
    if (event.key === 'Escape') { setCapturing(null); return; }
    const binding = describeKeyEvent(event);
    if (!binding) return;   // a modifier on its own — keep listening
    update('keybinds', { [action]: binding });
    setCapturing(null);
  };

  return (
    <div>
      <PageHeader title={t('settings.keybindsTitle')} description={t('keys.browserScopeNote')} />

      {conflicts.size > 0 && (
        <div className="mb-6 flex items-start gap-2.5 rounded-lg border-l-4 border-l-d-idle bg-d-idle/5 px-4 py-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-d-idle" aria-hidden="true" />
          <p className="text-sm text-d-text2">{t('keys.conflictWarning')}</p>
        </div>
      )}

      {GROUPS().map((group) => (
        <Section key={group.title} title={group.title}>
          {group.actions.map((action, index) => {
            const isCapturing = capturing === action.key;
            const conflicted = conflicts.has(action.key);
            return (
              <Row
                key={action.key}
                label={action.label}
                hint={action.hint}
                last={index === group.actions.length - 1}
              >
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setCapturing(action.key)}
                    onKeyDown={isCapturing ? capture(action.key) : undefined}
                    onBlur={() => isCapturing && setCapturing(null)}
                    aria-label={t('keys.changeBinding', { name: action.label })}
                    className={`min-w-[128px] rounded-md border px-3 py-1.5 text-center font-mono text-xs
                      transition-colors ${
                        isCapturing
                          ? 'animate-pulse border-d-brand bg-d-brand/10 text-d-mention'
                          : conflicted
                          ? 'border-d-idle bg-d-sunken text-d-idle'
                          : 'border-d-divider bg-d-sunken text-d-strong hover:border-d-control'
                      }`}
                  >
                    {isCapturing ? t('keys.pressKeys') : formatBinding(keybinds[action.key]) || '—'}
                  </button>

                  {/* Reserve the slot so rows do not jump as bindings clear. */}
                  <span className="w-7">
                    {keybinds[action.key] && !isCapturing && (
                      <button
                        type="button"
                        onClick={() => update('keybinds', { [action.key]: '' })}
                        title={t('keys.clearBinding')}
                        aria-label={t('keys.clearBindingFor', { name: action.label })}
                        className="rounded p-1.5 text-d-text3 transition-colors hover:bg-d-hover hover:text-d-danger"
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </span>
                </div>
              </Row>
            );
          })}
        </Section>
      ))}

      <Note>{t('keys.escapeHint')}</Note>

      <ResetButton
        onClick={() => {
          reset('keybinds');
          onToast?.(t('keys.resetDone'), { type: 'success', ttl: 2500 });
        }}
      >
        {t('keys.resetDefaults')}
      </ResetButton>
    </div>
  );
}
