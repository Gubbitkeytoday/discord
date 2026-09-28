// Shared class strings for menus and popovers (context menus, the status
// menu, notification settings, dropdowns), so every menu has the same
// surface, item height and — importantly — the same FOCUS style as its hover
// style. Menu items that only styled `hover:` showed nothing when focused
// from the keyboard.

export const menuSurface =
  'bg-d-sunken border border-d-divider/60 rounded-[var(--radius-d-md)] shadow-[var(--shadow-d-float)] py-1.5';

/** A normal menu item: 32px min height (≥24px target), full-width. */
export const menuItem =
  'mx-1.5 w-[calc(100%-12px)] min-h-8 flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-d-sm)] text-sm text-left ' +
  'text-d-text2 transition-colors hover:bg-d-brand hover:text-white focus-visible:bg-d-brand focus-visible:text-white ' +
  'focus-visible:outline-none aria-disabled:opacity-50 aria-disabled:pointer-events-none';

/** A destructive item: red text, red fill on hover/focus. */
export const menuItemDanger =
  'mx-1.5 w-[calc(100%-12px)] min-h-8 flex items-center gap-2 px-2 py-1.5 rounded-[var(--radius-d-sm)] text-sm text-left ' +
  'text-d-danger transition-colors hover:bg-d-danger hover:text-white focus-visible:bg-d-danger focus-visible:text-white ' +
  'focus-visible:outline-none';

export const menuSeparator = 'my-1.5 mx-2 h-px bg-d-divider/70';

/** Small section heading inside a menu. 12px minimum, never 10–11px. */
export const menuHeading = 'px-3 pt-1 pb-1.5 text-xs font-bold uppercase tracking-wide text-d-text3';

/** Standard icon size inside menu rows (lucide). */
export const MENU_ICON = 18;
