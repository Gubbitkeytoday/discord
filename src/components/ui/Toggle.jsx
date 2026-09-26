import React, { useId } from 'react';

/**
 * Discord's switch: a pill whose knob carries a tick or a cross, so the state
 * reads in greyscale too (WCAG 1.4.1). `Toggle` is the bare switch;
 * `ToggleRow` makes the WHOLE row — icon, label, hint and switch — one
 * switch button, because people click the words, not the 40×20 pill
 * (in testing, "Mute channel" was clicked twice before anyone found the pill).
 */

export function Switch({ checked, className = '' }) {
  return (
    <span
      aria-hidden="true"
      className={`relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors duration-150
        ${checked ? 'bg-d-brand' : 'bg-d-control'} ${className}`}
    >
      <span
        className={`absolute top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-white shadow
          transition-[left] duration-150 ${checked ? 'left-[18px]' : 'left-0.5'}`}
      >
        <svg viewBox="0 0 12 12" className={`h-3 w-3 ${checked ? 'text-d-brand' : 'text-d-control'}`}>
          {checked
            ? <path d="M2.5 6.2 5 8.5l4.5-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            : <path d="M3.2 3.2l5.6 5.6M8.8 3.2 3.2 8.8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />}
        </svg>
      </span>
    </span>
  );
}

export function Toggle({ checked, onChange, label, disabled = false, id, className = '' }) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={Boolean(checked)}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      className={`inline-flex rounded-full disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    >
      <Switch checked={Boolean(checked)} />
    </button>
  );
}

/**
 * A whole-row switch for menus and popovers: at least 40px tall, label and
 * hint are part of the button, and the hint is its accessible description.
 */
export function ToggleRow({
  checked, onChange, label, hint, icon, disabled = false, role = 'switch', className = ''
}) {
  const hintId = useId();
  return (
    <button
      type="button"
      role={role}
      aria-checked={Boolean(checked)}
      aria-describedby={hint ? hintId : undefined}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      className={`flex w-full min-h-10 items-center gap-3 rounded-[var(--radius-d-sm)] px-2 py-2 text-left
        text-d-text hover:bg-d-hover focus-visible:bg-d-hover transition-colors
        disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    >
      {icon && React.createElement(icon, { size: 18, 'aria-hidden': true, className: 'shrink-0 text-d-text2' })}
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium leading-snug">{label}</span>
        {hint && <span id={hintId} className="mt-0.5 block text-xs leading-snug text-d-text3">{hint}</span>}
      </span>
      <Switch checked={Boolean(checked)} />
    </button>
  );
}

export default Toggle;
