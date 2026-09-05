// ============================================================================
//  Settings design system.
//
//  Discord's settings pages all look identical because every row is the same
//  object: a label and a description on the left, one control hard against the
//  right edge, a hairline underneath. Before this file each tab hand-rolled its
//  own spacing, so the same toggle sat at a different height on every page.
//
//  Measurements are taken from Discord's own settings surface:
//    page title       20px / 600
//    section header   12px / 700 uppercase, 0.02em tracking
//    row label        16px / 500        row description 14px / 400 muted
//    row rhythm       16px top and bottom, hairline between
//    control column   never wraps; the text column shrinks instead
// ============================================================================

import React, { useId } from 'react';
import { Check, X, RotateCcw } from 'lucide-react';

/* --- page ------------------------------------------------------------------ */

/** The h2 every settings page opens with, plus an optional lead paragraph. */
export function PageHeader({ title, description, action = null }) {
  return (
    <header className="mb-6 flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h2 className="text-xl font-semibold text-d-strong leading-tight">{title}</h2>
        {description && (
          <p className="mt-1.5 text-sm text-d-text2 leading-relaxed">{description}</p>
        )}
      </div>
      {action}
    </header>
  );
}

/**
 * A titled group of rows. `flush` drops the top hairline for the first section
 * on a page, where a rule directly under the title reads as a mistake.
 */
export function Section({ title, description, children, className = '' }) {
  return (
    <section className={`mb-6 ${className}`}>
      {title && (
        <h3 className="text-xs font-bold text-d-text2 uppercase tracking-[0.02em] mb-2">
          {title}
        </h3>
      )}
      {description && <p className="text-sm text-d-text2 mb-3 leading-relaxed">{description}</p>}
      {children}
    </section>
  );
}

/** The hairline Discord puts between groups of settings. */
export function Divider({ className = '' }) {
  return <div className={`h-px bg-d-divider my-6 ${className}`} />;
}

/* --- rows ------------------------------------------------------------------ */

/**
 * One setting. Text left, control right, hairline below.
 *
 * `htmlFor` associates the label with a control rendered by the caller; when the
 * control is a Toggle (a button, which cannot be a label target) pass `as="div"`
 * and let the Toggle carry its own aria-label — `SettingToggle` below does this.
 */
export function Row({ label, hint, children, htmlFor, last = false, className = '' }) {
  const Label = htmlFor ? 'label' : 'div';
  return (
    <div
      className={`flex items-center justify-between gap-6 py-4 ${
        last ? '' : 'border-b border-d-divider'
      } ${className}`}
    >
      <Label htmlFor={htmlFor} className={`min-w-0 flex-1 ${htmlFor ? 'cursor-pointer' : ''}`}>
        <span className="block text-base font-medium text-d-strong leading-snug">{label}</span>
        {hint && <span className="mt-1 block text-sm text-d-text2 leading-relaxed">{hint}</span>}
      </Label>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/**
 * A setting whose control needs the full width underneath it — a slider, a
 * segmented control, a preview. Text on top, control below.
 */
export function StackedRow({ label, hint, children, last = false }) {
  return (
    <div className={`py-4 ${last ? '' : 'border-b border-d-divider'}`}>
      {label && (
        <div className="mb-3">
          <span className="block text-base font-medium text-d-strong leading-snug">{label}</span>
          {hint && <span className="mt-1 block text-sm text-d-text2 leading-relaxed">{hint}</span>}
        </div>
      )}
      {children}
    </div>
  );
}

/* --- controls --------------------------------------------------------------- */

/**
 * Discord's switch: a pill that slides, with a tick or a cross inside the knob
 * so the state survives a screenshot in greyscale and does not rely on colour
 * alone (WCAG 1.4.1).
 */
export function Toggle({ checked, onChange, disabled = false, label, id }) {
  return (
    <button
      type="button"
      id={id}
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-10 shrink-0 items-center rounded-full transition-colors
        focus:outline-none focus-visible:ring-2 focus-visible:ring-d-brand focus-visible:ring-offset-2
        focus-visible:ring-offset-d-canvas disabled:opacity-50 disabled:cursor-not-allowed
        ${checked ? 'bg-d-success' : 'bg-d-control'}`}
    >
      <span
        className={`flex h-[18px] w-[18px] items-center justify-center rounded-full bg-white
          shadow transition-transform ${checked ? 'translate-x-[21px]' : 'translate-x-[3px]'}`}
      >
        {checked
          ? <Check className="h-3 w-3 text-d-success" strokeWidth={3.5} />
          : <X className="h-3 w-3 text-d-control" strokeWidth={3.5} />}
      </span>
    </button>
  );
}

/** Row + Toggle, the pairing that makes up most of every settings page. */
export function SettingToggle({ label, hint, checked, onChange, disabled, last }) {
  return (
    <Row label={label} hint={hint} last={last}>
      <Toggle checked={checked} onChange={onChange} disabled={disabled} label={label} />
    </Row>
  );
}

/**
 * Discord's radio list: full-width rows with the dot on the left, the whole row
 * clickable, and the selected one outlined in brand colour.
 */
export function RadioList({ value, onChange, options, label }) {
  return (
    <div role="radiogroup" aria-label={label} className="space-y-2">
      {options.map((option) => {
        const selected = value === option.key;
        return (
          <button
            key={option.key}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={option.disabled}
            onClick={() => onChange(option.key)}
            className={`w-full flex items-start gap-3 rounded-lg border px-4 py-3 text-left transition-colors
              disabled:opacity-50 disabled:cursor-not-allowed
              ${selected
                ? 'border-d-brand bg-d-brand/10'
                : 'border-d-divider bg-d-surface hover:border-d-control'}`}
          >
            <span
              aria-hidden="true"
              className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2
                ${selected ? 'border-d-brand' : 'border-d-control'}`}
            >
              {selected && <span className="h-2.5 w-2.5 rounded-full bg-d-brand" />}
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium text-d-strong">{option.label}</span>
              {option.hint && (
                <span className="mt-0.5 block text-xs text-d-text2 leading-relaxed">{option.hint}</span>
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** A compact segmented control, for two to four short mutually exclusive values. */
export function Segmented({ value, onChange, options, label }) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex rounded-lg bg-d-sunken p-1 gap-1"
    >
      {options.map((option) => {
        const selected = value === option.key;
        return (
          <button
            key={option.key}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.key)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors
              ${selected
                ? 'bg-d-active text-d-strong shadow-sm'
                : 'text-d-text2 hover:text-d-strong'}`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A slider with its live value beside the label — Discord always shows the
 * number, because "60%" tells you more than a knob position does.
 */
export function Slider({
  label, hint, value, onChange, min = 0, max = 100, step = 1,
  format = (v) => `${v}`, last = false, marks = null
}) {
  const id = useId();
  return (
    <div className={`py-4 ${last ? '' : 'border-b border-d-divider'}`}>
      <div className="flex items-baseline justify-between gap-4 mb-2">
        <label htmlFor={id} className="text-base font-medium text-d-strong">{label}</label>
        <span className="text-sm font-semibold text-d-text2 tabular-nums">{format(value)}</span>
      </div>
      {hint && <p className="text-sm text-d-text2 mb-3 leading-relaxed">{hint}</p>}
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="w-full accent-d-brand cursor-pointer"
      />
      {marks && (
        <div className="mt-1 flex justify-between text-[11px] text-d-text4">
          {marks.map((mark) => <span key={mark}>{mark}</span>)}
        </div>
      )}
    </div>
  );
}

/** A labelled text input / select / textarea wrapper. */
export function Field({ label, hint, children, htmlFor, className = '' }) {
  return (
    <div className={className}>
      <label
        htmlFor={htmlFor}
        className="mb-2 block text-xs font-bold uppercase tracking-[0.02em] text-d-text2"
      >
        {label}
      </label>
      {children}
      {hint && <p className="mt-1.5 text-xs text-d-text3 leading-relaxed">{hint}</p>}
    </div>
  );
}

/** The input styling Discord uses everywhere: filled, no border until focus. */
export const inputClass =
  'w-full rounded-lg bg-d-sunken px-3 py-2.5 text-sm text-d-strong border border-transparent ' +
  'placeholder:text-d-text4 focus:outline-none focus:border-d-brand transition-colors';

/** A select that matches `inputClass`, with the caret Discord draws. */
export function Select({ value, onChange, children, label, id, className = '' }) {
  return (
    <select
      id={id}
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      className={`${inputClass} cursor-pointer ${className}`}
    >
      {children}
    </select>
  );
}

/* --- buttons ---------------------------------------------------------------- */

const BUTTON_VARIANTS = {
  primary: 'bg-d-brand hover:bg-d-brandhover text-white',
  secondary: 'bg-d-control2 hover:bg-d-control text-d-strong',
  danger: 'bg-d-danger hover:bg-d-dangerhover text-white',
  ghost: 'bg-transparent hover:underline text-d-text2 hover:text-d-strong',
  dangerGhost: 'bg-transparent text-d-danger hover:underline'
};

export function Button({
  variant = 'secondary', size = 'md', children, className = '', ...rest
}) {
  const sizing = size === 'sm' ? 'px-3 py-1.5 text-xs' : 'px-4 py-2 text-sm';
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-2 rounded-lg font-medium
        transition-colors disabled:opacity-50 disabled:cursor-not-allowed
        focus:outline-none focus-visible:ring-2 focus-visible:ring-d-brand
        ${BUTTON_VARIANTS[variant]} ${sizing} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

/** "Reset to defaults" — Discord puts this alone at the foot of a page. */
export function ResetButton({ onClick, children }) {
  return (
    <div className="pt-2">
      <button
        type="button"
        onClick={onClick}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-d-text3
          hover:text-d-danger transition-colors"
      >
        <RotateCcw className="h-3.5 w-3.5" />
        {children}
      </button>
    </div>
  );
}

/** A callout for context a page needs before you touch anything on it. */
export function Note({ children, tone = 'info' }) {
  const tones = {
    info: 'bg-d-sunken border-d-divider text-d-text2',
    brand: 'border-l-4 border-l-d-brand bg-d-brand/5 border-y-transparent border-r-transparent text-d-text2',
    warn: 'border-l-4 border-l-d-idle bg-d-idle/5 border-y-transparent border-r-transparent text-d-text2',
    danger: 'border-l-4 border-l-d-danger bg-d-danger/5 border-y-transparent border-r-transparent text-d-text2'
  };
  return (
    <div className={`rounded-lg border px-4 py-3 text-sm leading-relaxed ${tones[tone]}`}>
      {children}
    </div>
  );
}
