import React, { forwardRef } from 'react';

/**
 * Design-system buttons. One place for the sizes, radii and states every
 * button in the app should share: a visible focus ring from the global
 * :focus-visible rule, a 150ms colour transition (no `transition-all`, which
 * animated the focus outline in), disabled states that look disabled, and hit
 * areas that meet WCAG 2.5.8 (≥24px; `lg` is 44px for touch).
 *
 *   <Button variant="primary">Save</Button>
 *   <IconButton label="Pinned messages" icon={Pin} />
 */

const VARIANTS = {
  primary: 'bg-d-brand text-white hover:bg-d-brandhover active:bg-d-brandactive',
  secondary: 'bg-d-control text-d-strong hover:bg-d-control2 active:brightness-95',
  success: 'bg-d-success text-white hover:bg-d-successhover',
  danger: 'bg-d-danger text-white hover:bg-d-dangerhover',
  // Text-only: underline on hover, like Discord's "Cancel".
  link: 'bg-transparent text-d-text hover:underline',
  ghost: 'bg-transparent text-d-text2 hover:bg-d-hover hover:text-d-strong active:bg-d-active',
  'danger-ghost': 'bg-transparent text-d-danger hover:bg-d-danger hover:text-white'
};

const SIZES = {
  sm: 'min-h-8 px-3 text-sm gap-1.5',
  md: 'min-h-10 px-4 text-sm gap-2',
  lg: 'min-h-11 px-5 text-base gap-2'
};

export const buttonClass = ({ variant = 'primary', size = 'md', block = false, className = '' } = {}) => (
  `inline-flex items-center justify-center rounded-[var(--radius-d-sm)] font-medium
   transition-[background-color,color,filter] duration-150 select-none
   disabled:cursor-not-allowed disabled:opacity-50
   ${VARIANTS[variant] ?? VARIANTS.primary} ${SIZES[size] ?? SIZES.md} ${block ? 'w-full' : ''} ${className}`
);

export const Button = forwardRef(function Button(
  { variant = 'primary', size = 'md', block = false, className = '', type = 'button', children, ...rest },
  ref
) {
  return (
    <button ref={ref} type={type} className={buttonClass({ variant, size, block, className })} {...rest}>
      {children}
    </button>
  );
});

const ICON_SIZES = {
  // hit area / glyph — the glyph stays Discord-sized, the target grows.
  sm: { box: 'h-8 w-8', icon: 18 },
  md: { box: 'h-10 w-10', icon: 20 },
  lg: { box: 'h-11 w-11', icon: 24 }
};

/**
 * A square icon-only button. `label` is required: it becomes the accessible
 * name and the tooltip. `pressed` makes it a toggle (aria-pressed).
 */
export const IconButton = forwardRef(function IconButton(
  { icon, label, size = 'sm', pressed, active = false, danger = false, className = '', type = 'button', children, ...rest },
  ref
) {
  const spec = ICON_SIZES[size] ?? ICON_SIZES.sm;
  const on = active || pressed === true;
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={rest.title ?? label}
      aria-pressed={pressed === undefined ? undefined : Boolean(pressed)}
      className={`inline-flex shrink-0 items-center justify-center rounded-[var(--radius-d-sm)]
        transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-50
        ${spec.box}
        ${danger
          ? 'text-d-danger hover:bg-d-danger hover:text-white'
          : on
            ? 'text-d-strong bg-d-active'
            : 'text-d-text2 hover:bg-d-hover hover:text-d-strong active:bg-d-active'}
        ${className}`}
      {...rest}
    >
      {icon ? React.createElement(icon, { size: spec.icon, 'aria-hidden': true }) : children}
    </button>
  );
});

export default Button;
