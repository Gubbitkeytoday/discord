import React, { useId, useLayoutEffect, useRef, useState } from 'react';
import { Check, CheckCheck, FolderMinus, X } from 'lucide-react';
import { t } from '../../i18n/index.jsx';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { Button, IconButton } from '../ui';

/** Discord's folder palette (12 swatches), plus "no colour" and a custom hex. */
export const FOLDER_COLORS = [
  '#5865f2', '#3ba55c', '#faa61a', '#ed4245', '#eb459e', '#9b59b6',
  '#1abc9c', '#3498db', '#e67e22', '#95a5a6', '#607d8b', '#ffffff'
];

/**
 * Folder Settings — replaces the rail's window.prompt rename. Opened from the
 * folder's context menu (or a long-press on touch) at the pointer:
 *
 *   <FolderSettingsPopover
 *     folder={folder}                     // { id, name, color, serverIds }
 *     x={e.clientX} y={e.clientY}
 *     onSave={({ name, color }) => …}     // write layout.serverFolders
 *     onMarkRead={() => …}                // mark every server in it read
 *     onUngroup={() => …}                 // dissolve the folder
 *     onClose={() => …}
 *   />
 *
 * A dialog (focus is trapped, Escape closes, focus returns to the opener).
 */
export default function FolderSettingsPopover({ folder, x = 80, y = 80, onSave, onMarkRead, onUngroup, onClose }) {
  const dialogRef = useFocusTrap(true, onClose);
  const inputRef = useRef(null);
  const nameId = useId();
  const hexId = useId();
  const [name, setName] = useState(folder?.name ?? '');
  const [color, setColor] = useState(folder?.color ?? null);
  const [hex, setHex] = useState(folder?.color ?? '');
  const [pos, setPos] = useState({ left: x, top: y });

  // Keep the popover inside the viewport (and as a bottom sheet on phones).
  useLayoutEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const margin = 8;
    setPos({
      left: Math.max(margin, Math.min(x, window.innerWidth - width - margin)),
      top: Math.max(margin, Math.min(y, window.innerHeight - height - margin))
    });
    inputRef.current?.select();
  }, [x, y]); // eslint-disable-line react-hooks/exhaustive-deps

  const submit = (e) => {
    e?.preventDefault();
    onSave?.({ name: name.trim().slice(0, 60), color });
    onClose?.();
  };

  const pickHex = (value) => {
    setHex(value);
    const clean = value.trim().replace(/^#?/, '#').toLowerCase();
    if (/^#[0-9a-f]{6}$/.test(clean)) setColor(clean);
  };

  return (
    <div className="fixed inset-0 z-[85]" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}>
      <form
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${nameId}-title`}
        onSubmit={submit}
        className="fixed w-[min(300px,calc(100vw-16px))] bg-d-sunken border border-d-divider rounded-lg shadow-2xl p-3
          max-sm:!left-2 max-sm:!right-2 max-sm:!top-auto max-sm:bottom-2 max-sm:w-auto"
        style={{ left: pos.left, top: pos.top }}
      >
        <div className="flex items-center justify-between mb-2">
          <h2 id={`${nameId}-title`} className="text-sm font-bold text-d-strong">{t('srv.folderSettings')}</h2>
          <IconButton icon={X} label={t('common.close')} onClick={onClose} />
        </div>

        <label htmlFor={nameId} className="block text-[11px] font-bold text-d-text2 uppercase mb-1">{t('srv.folderName')}</label>
        <input
          ref={inputRef}
          id={nameId}
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('srv.folderNamePlaceholder')}
          className="w-full min-h-10 bg-d-base text-sm text-d-strong px-3 rounded border border-d-edge focus:outline-none focus:border-d-brand"
        />

        <fieldset className="mt-3">
          <legend className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">{t('srv.folderColour')}</legend>
          <div className="grid grid-cols-7 gap-1.5">
            <button
              type="button"
              onClick={() => { setColor(null); setHex(''); }}
              aria-pressed={color === null}
              aria-label={t('srv.folderNoColour')}
              title={t('srv.folderNoColour')}
              className={`w-8 h-8 rounded-full border-2 border-dashed border-d-text3 flex items-center justify-center ${color === null ? 'ring-2 ring-d-strong ring-offset-2 ring-offset-d-sunken' : ''}`}
            >
              {color === null && <Check className="w-4 h-4 text-d-text2" aria-hidden="true" />}
            </button>
            {FOLDER_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => { setColor(c); setHex(c); }}
                aria-pressed={color === c}
                aria-label={t('roles.colorSwatch', { color: c })}
                data-custom-color
                style={{ backgroundColor: c }}
                className={`w-8 h-8 rounded-full border border-black/20 flex items-center justify-center ${color === c ? 'ring-2 ring-d-strong ring-offset-2 ring-offset-d-sunken' : ''}`}
              >
                {color === c && <Check className={`w-4 h-4 ${c === '#ffffff' ? 'text-black' : 'text-white'} drop-shadow`} aria-hidden="true" />}
              </button>
            ))}
          </div>
          <div className="mt-2 flex items-center gap-2">
            <label htmlFor={hexId} className="text-xs text-d-text2">{t('srv.customColour')}</label>
            <input
              id={hexId}
              value={hex}
              maxLength={7}
              spellCheck={false}
              placeholder="#5865f2"
              onChange={(e) => pickHex(e.target.value)}
              className="w-24 min-h-8 bg-d-base text-xs font-mono text-d-strong px-2 rounded border border-d-edge focus:outline-none focus:border-d-brand"
            />
            <input
              type="color"
              aria-label={t('srv.customColour')}
              value={color ?? '#5865f2'}
              onChange={(e) => { setColor(e.target.value); setHex(e.target.value); }}
              className="w-8 h-8 p-0 bg-transparent border border-d-divider rounded cursor-pointer"
            />
          </div>
        </fieldset>

        <div className="mt-3 border-t border-d-divider pt-2 space-y-0.5">
          {onMarkRead && (
            <button type="button" onClick={() => { onMarkRead(); onClose?.(); }}
              className="w-full min-h-9 flex items-center gap-2 px-2 rounded text-sm text-d-text hover:bg-d-hover">
              <CheckCheck className="w-4 h-4 text-d-text2" aria-hidden="true" /> {t('srv.folderMarkRead')}
            </button>
          )}
          {onUngroup && (
            <button type="button" onClick={() => { onUngroup(); onClose?.(); }}
              className="w-full min-h-9 flex items-center gap-2 px-2 rounded text-sm text-d-dangertext hover:bg-d-danger/10">
              <FolderMinus className="w-4 h-4" aria-hidden="true" /> {t('srv.folderUngroup')}
            </button>
          )}
        </div>

        <div className="mt-3 flex justify-end gap-2">
          <Button variant="link" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" size="sm">{t('common.save')}</Button>
        </div>
      </form>
    </div>
  );
}
