import React, { useLayoutEffect, useRef, useState } from 'react';

/**
 * A popover placed beside a message row: to the left of the row's right edge
 * (where the action bar sits), top-aligned with the row, clamped inside the
 * viewport; on a phone it centres horizontally. A clear backdrop closes it on
 * an outside click.
 */
export default function AnchoredPopover({ anchorId, onClose, children }) {
  const ref = useRef(null);
  const [position, setPosition] = useState(null);
  useLayoutEffect(() => {
    const anchor = document.querySelector(`[data-row-id="${CSS.escape(String(anchorId))}"]`);
    const node = ref.current;
    if (!node) return;
    const margin = 8;
    const { width, height } = node.getBoundingClientRect();
    const rect = anchor?.getBoundingClientRect() ?? { top: window.innerHeight / 3, right: window.innerWidth - margin };
    const narrow = window.innerWidth < 640;
    const left = narrow ? (window.innerWidth - width) / 2 : rect.right - width - 56;
    let top = rect.top - 8;
    if (top + height > window.innerHeight - margin) top = window.innerHeight - height - margin;
    setPosition({
      left: Math.max(margin, Math.min(left, window.innerWidth - width - margin)),
      top: Math.max(margin, top)
    });
  }, [anchorId]);
  return (
    <>
      <div className="fixed inset-0 z-40" onMouseDown={onClose} aria-hidden="true" />
      <div
        ref={ref}
        className="fixed z-50"
        style={position ? { left: position.left, top: position.top } : { left: 0, top: 0, visibility: 'hidden' }}
      >
        {children}
      </div>
    </>
  );
}
