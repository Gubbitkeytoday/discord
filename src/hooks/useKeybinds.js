import { useEffect, useRef } from 'react';
import { getPreferences } from './useUserSettings';

/**
 * In-app hotkeys.
 *
 * A browser tab cannot register a true system-wide hotkey, so these fire while
 * the app has focus — which is what a web client can honestly promise. Every
 * binding is a string like "Ctrl+Shift+M", stored in the account's settings and
 * matched here against the real event.
 */

/** Turn a keyboard event into the same string format the settings store uses. */
export function describeKeyEvent(event) {
  const parts = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.metaKey) parts.push('Meta');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');

  const code = event.code || event.key;
  // A bare modifier is not a binding on its own.
  if (/^(Control|Shift|Alt|Meta)(Left|Right)?$/.test(code)) return null;

  parts.push(normaliseCode(code));
  return parts.join('+');
}

function normaliseCode(code) {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  return code;
}

/** Human-readable form for the settings UI. */
export function formatBinding(binding) {
  if (!binding) return '—';
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform ?? '');
  return binding
    .split('+')
    .map((part) => {
      if (part === 'Meta') return isMac ? '⌘' : 'Win';
      if (part === 'Ctrl') return isMac ? '⌃' : 'Ctrl';
      if (part === 'Alt') return isMac ? '⌥' : 'Alt';
      if (part === 'Shift') return isMac ? '⇧' : 'Shift';
      if (part === 'Space') return 'Space';
      if (part.startsWith('Arrow')) return { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' }[part] ?? part;
      return part;
    })
    .join(isMac ? '' : ' + ');
}

/** Which actions share a binding — surfaced in the UI so a clash is visible. */
export function findConflicts(keybinds) {
  const seen = new Map();
  const conflicts = new Set();
  for (const [action, binding] of Object.entries(keybinds)) {
    if (!binding) continue;
    if (seen.has(binding)) {
      conflicts.add(action);
      conflicts.add(seen.get(binding));
    } else {
      seen.set(binding, action);
    }
  }
  return conflicts;
}

const TEXT_FIELDS = ['INPUT', 'TEXTAREA'];

function isTyping(target) {
  return TEXT_FIELDS.includes(target?.tagName) || target?.isContentEditable;
}

/**
 * Bind the configured hotkeys to `handlers`, keyed by action name.
 * Push-to-talk is deliberately not handled here — it needs keydown *and* keyup
 * and lives with the microphone, in useVoiceMedia.
 */
export function useKeybinds(handlers) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const onKeyDown = (event) => {
      const binding = describeKeyEvent(event);
      if (!binding) return;

      const keybinds = getPreferences().keybinds;
      const action = Object.keys(keybinds).find((key) => keybinds[key] === binding);
      if (!action || action === 'pushToTalk') return;

      const handler = handlersRef.current[action];
      if (!handler) return;

      // A binding with no modifier must not fire while someone is typing.
      const hasModifier = event.ctrlKey || event.metaKey || event.altKey;
      if (!hasModifier && isTyping(event.target)) return;

      event.preventDefault();
      handler(event);
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}
