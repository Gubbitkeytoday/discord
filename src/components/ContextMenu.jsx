import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronRight, Check } from 'lucide-react';

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

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

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
          onClick={run(item)}
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
              {item.checked && <Check className="w-3 h-3" />}
            </span>
          )}
          {item.hint && <span className="text-[10px] opacity-70 shrink-0">{item.hint}</span>}
          {item.submenu && <ChevronRight className="w-4 h-4 shrink-0" />}
        </button>

        {item.submenu && isOpen && (
          <div
            role="menu"
            className={`absolute top-0 left-full -ml-1 ${width} max-h-80 overflow-y-auto bg-d-sunken border border-d-surface rounded-md shadow-2xl py-1.5 z-10`}
          >
            {item.submenu.length === 0 && (
              <p className="px-3 py-2 text-xs text-d-text4">{item.emptyLabel ?? '—'}</p>
            )}
            {renderItems(item.submenu, depth + 1)}
          </div>
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
