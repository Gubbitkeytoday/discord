import React, { cloneElement, isValidElement, useId } from 'react';

/**
 * A CSS-only tooltip that also appears on keyboard focus (the old
 * `.discord-tooltip` showed on hover only) and is wired to the trigger with
 * aria-describedby. It never steals the pointer and costs no JS state.
 *
 *   <Tooltip label="Add a server" side="right">{trigger}</Tooltip>
 *
 * For an icon-only button the label should ALSO be its aria-label; the
 * tooltip is then described-by, which screen readers skip when it repeats
 * the name.
 */
const SIDES = {
  top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
  bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
  right: 'left-full top-1/2 -translate-y-1/2 ml-3',
  left: 'right-full top-1/2 -translate-y-1/2 mr-3'
};

export default function Tooltip({ label, side = 'top', children, className = '' }) {
  const id = useId();
  if (!label) return children;
  const trigger = isValidElement(children)
    ? cloneElement(children, { 'aria-describedby': [children.props['aria-describedby'], id].filter(Boolean).join(' ') })
    : children;
  return (
    <span className={`group/tip relative inline-flex ${className}`}>
      {trigger}
      <span
        id={id}
        role="tooltip"
        className={`pointer-events-none absolute z-[100] whitespace-nowrap rounded-[var(--radius-d-sm)] bg-d-sunken px-3 py-1.5
          text-sm font-semibold text-d-strong shadow-[var(--shadow-d-pop)] opacity-0 scale-95
          transition-[opacity,transform] duration-100
          group-hover/tip:opacity-100 group-hover/tip:scale-100
          group-has-[:focus-visible]/tip:opacity-100 group-has-[:focus-visible]/tip:scale-100 ${SIDES[side] ?? SIDES.top}`}
      >
        {label}
      </span>
    </span>
  );
}
