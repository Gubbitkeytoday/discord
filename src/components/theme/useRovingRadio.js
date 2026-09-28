import { useRef } from 'react';

/**
 * Roving tabindex for a radio group laid out as a grid of swatches (WAI-ARIA
 * radio group pattern): one Tab stop, arrow keys move and select, Home/End
 * jump. `keys` is the ordered list of option keys.
 */
export function useRovingRadio(keys, value, onChange) {
  const refs = useRef(new Map());
  const active = keys.includes(value) ? value : keys[0];

  const move = (fromKey, delta) => {
    const index = keys.indexOf(fromKey);
    const next = keys[(index + delta + keys.length) % keys.length];
    onChange(next);
    refs.current.get(next)?.focus();
  };

  const itemProps = (key) => ({
    ref: (node) => { if (node) refs.current.set(key, node); else refs.current.delete(key); },
    role: 'radio',
    'aria-checked': key === value,
    tabIndex: key === active ? 0 : -1,
    onClick: () => onChange(key),
    onKeyDown: (event) => {
      const rtl = typeof document !== 'undefined' && document.documentElement.dir === 'rtl';
      switch (event.key) {
        case 'ArrowRight': move(key, rtl ? -1 : 1); break;
        case 'ArrowDown': move(key, 1); break;
        case 'ArrowLeft': move(key, rtl ? 1 : -1); break;
        case 'ArrowUp': move(key, -1); break;
        case 'Home': onChange(keys[0]); refs.current.get(keys[0])?.focus(); break;
        case 'End': onChange(keys.at(-1)); refs.current.get(keys.at(-1))?.focus(); break;
        default: return;
      }
      event.preventDefault();
    }
  });

  return itemProps;
}
