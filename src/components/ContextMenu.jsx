import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronRight, Check } from 'lucide-react';
import { useEscapeLayer } from '../hooks/useFocusTrap';

const MENU_MARGIN = 8;

/**
 * Generic right-click menu, positioned at the cursor and nudged back inside the
 * viewport. Items:
 *   { label, icon, action, danger, accent, checked, disabled, submenu: [...] }
 *   { separator: true }
 * `submenu` opens to the right on hover, like Discord's Roles / Invite to Server.
 */
export default function ContextMenu({ x, y, items, onClose, width = 'w-56' }) {
  const ref = useRef(null);
  const [position, setPosition] = useState({ left: x, top: y });
  const [openSub, setOpenSub] = useState(null);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const { width: w, height: h } = node.getBoundingClientRect();
    setPosition({
      left: Math.max(MENU_MARGIN, Math.min(x, window.innerWidth - w - MENU_MARGIN)),
      top: Math.max(MENU_MARGIN, Math.min(y, window.innerHeight - h - MENU_MARGIN))
    });
  }, [x, y, items.length]);

  // Keyboard: the menu takes focus when it opens (so a menu opened from a
  // button — the message "More" button — is usable without a mouse), arrows
  // move between items, Home/End jump, Escape closes and hands focus back.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEscapeLayer(() => onCloseRef.current());
  useEffect(() => {
    const returnTo = document.activeElement;
    ref.current?.querySelector('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
    const onKey = (e) => {
      const menu = ref.current;
      if (!menu || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
      // Arrow keys walk the innermost menu that holds focus (a submenu when
      // one is open), not every item in the tree.
      const scope = document.activeElement?.closest?.('[role="menu"]');
      const within = scope && menu.contains(scope) ? scope : menu;
      const items = [...within.querySelectorAll(':scope > div > [role="menuitem"]:not(:disabled)')];
      if (items.length === 0) return;
      e.preventDefault();
      const at = items.indexOf(document.activeElement);
      const next = e.key === 'Home' ? 0
        : e.key === 'End' ? items.length - 1
        : e.key === 'ArrowDown' ? (at + 1) % items.length
        : (at - 1 + items.length) % items.length;
      items[next].focus();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      // Only if nothing else claimed focus: an item that opens an editor or
      // focuses the composer must keep it.
      const orphaned = !document.activeElement || document.activeElement === document.body;
      if (orphaned && returnTo?.isConnected && typeof returnTo.focus === 'function') {
        returnTo.focus({ preventScroll: true });
      }
    };
  }, []);

  const run = (item) => () => {
    if (item.disabled || item.submenu) return;
    item.action?.();
    if (!item.keepOpen) onClose();
  };

  const renderItems = (list, depth = 0) => list.filter(Boolean).map((item, index) => {
    if (item.separator) {
      return <div key={`sep-${depth}-${index}`} className="h-[1px] bg-d-surface my-1 mx-2" />;
    }
    const Icon = item.icon;
    const isOpen = openSub === `${depth}-${index}`;
    return (
      <div
        key={`${depth}-${item.label}-${index}`}
        className="relative"
        onMouseEnter={() => item.submenu && setOpenSub(`${depth}-${index}`)}
        onMouseLeave={() => item.submenu && setOpenSub(null)}
      >
        <button
          role="menuitem"
          onClick={item.submenu ? () => setOpenSub(isOpen ? null : `${depth}-${index}`) : run(item)}
          onKeyDown={(e) => {
            if (item.submenu && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
              e.preventDefault();
              const host = e.currentTarget.parentElement;
              setOpenSub(`${depth}-${index}`);
              requestAnimationFrame(() => {
                host?.querySelector('[role="menu"] [role="menuitem"]:not(:disabled)')?.focus();
              });
            }
          }}
          disabled={item.disabled}
          aria-haspopup={item.submenu ? 'menu' : undefined}
          aria-expanded={item.submenu ? isOpen : undefined}
          className={`w-[calc(100%-12px)] mx-1.5 flex items-center gap-2 px-2 py-1.5 rounded transition-colors text-left text-sm disabled:opacity-40 disabled:cursor-not-allowed ${
            item.danger
              ? 'text-d-danger hover:bg-d-danger hover:text-white'
              : item.accent
              ? 'text-d-mint hover:bg-d-success hover:text-white'
              : 'text-d-text2 hover:bg-d-brand hover:text-white'
          }`}
        >
          {Icon && <Icon className="w-4 h-4 shrink-0" />}
          <span className="truncate flex-1">{item.label}</span>
          {item.checked !== undefined && (
            <span className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
              item.checked ? 'bg-d-brand border-d-brand text-white' : 'border-d-text4'
            }`}>
              {Boolean(item.checked) && <Check className="w-3 h-3" />}
            </span>
          )}
          {Boolean(item.hint) && <span className="text-[10px] opacity-70 shrink-0">{item.hint}</span>}
          {Boolean(item.submenu) && <ChevronRight className="w-4 h-4 shrink-0" />}
        </button>

        {Boolean(item.submenu) && isOpen && (
          <Submenu width={width} emptyLabel={item.emptyLabel} empty={item.submenu.length === 0}>
            {renderItems(item.submenu, depth + 1)}
          </Submenu>
        )}
      </div>
    );
  });

  return (
    <>
      <div
        className="fixed inset-0 z-40"
        onClick={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose(); }}
      />
      <div
        ref={ref}
        role="menu"
        style={{ left: position.left, top: position.top }}
        className={`fixed z-50 ${width} bg-d-sunken border border-d-surface rounded-md shadow-2xl py-1.5`}
      >
        {renderItems(items)}
      </div>
    </>
  );
}

/**
 * A submenu opens beside its item — to the right by default, flipped to the
 * left when that would run off the viewport, and nudged up when it would run
 * off the bottom (the Roles submenu near the right edge used to render at
 * x=1368 in a 1366px window).
 */
function Submenu({ width, empty, emptyLabel, children }) {
  const ref = useRef(null);
  const [placement, setPlacement] = useState({ side: 'right', shiftY: 0 });
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    const parent = node.parentElement.getBoundingClientRect();
    const side = parent.right + rect.width + MENU_MARGIN > window.innerWidth
      && parent.left - rect.width - MENU_MARGIN >= 0 ? 'left' : 'right';
    const overflowY = rect.bottom - (window.innerHeight - MENU_MARGIN);
    setPlacement({ side, shiftY: overflowY > 0 ? -Math.min(overflowY, rect.top - MENU_MARGIN) : 0 });
  }, []);
  return (
    <div
      ref={ref}
      role="menu"
      style={{ transform: placement.shiftY ? `translateY(${placement.shiftY}px)` : undefined }}
      className={`absolute top-0 ${placement.side === 'right' ? 'left-full -ml-1' : 'right-full -mr-1'} ${width} max-h-80 overflow-y-auto bg-d-sunken border border-d-surface rounded-md shadow-2xl py-1.5 z-10`}
      onKeyDown={(e) => {
        if (e.key === (placement.side === 'right' ? 'ArrowLeft' : 'ArrowRight')) {
          e.preventDefault();
          e.stopPropagation();
          ref.current?.parentElement?.querySelector(':scope > [role="menuitem"]')?.focus();
        }
      }}
    >
      {empty && <p className="px-3 py-2 text-xs text-d-text4">{emptyLabel ?? '—'}</p>}
      {children}
    </div>
  );
}
