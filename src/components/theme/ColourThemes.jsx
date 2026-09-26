import React, { useId, useRef, useState } from 'react';
import { Check, Ban, Plus, Upload, Download, Copy, Pencil, Trash2 } from 'lucide-react';
import { t } from '../../i18n/index.jsx';
import { GRADIENT_PRESETS } from '../../theme/presets.js';
import { gradientCss } from '../../theme/gradient.js';
import { gradientFor } from '../../theme/engine.js';
import {
  MAX_CUSTOM_THEMES, safeCustomThemes, exportTheme, importTheme, newThemeId, ThemeError
} from '../../theme/schema.js';
import { Button, inputClass } from '../settings/primitives';
import CustomThemeBuilder from './CustomThemeBuilder.jsx';
import { useRovingRadio } from './useRovingRadio.js';

const IMPORT_ERRORS = {
  IMPORT_EMPTY: 'theme.importErrorEmpty',
  IMPORT_TOO_BIG: 'theme.importErrorTooBig',
  IMPORT_JSON: 'theme.importErrorJson',
  IMPORT_FORMAT: 'theme.importErrorFormat'
};

/** One swatch: the raw gradient, with the real chat surface as a chip inside. */
function Swatch({ theme, label, selected, itemProps }) {
  const built = gradientFor(theme);
  const text = theme.base === 'light' ? '#060607' : '#ffffff';
  return (
    <button
      type="button"
      {...itemProps}
      aria-label={label}
      title={label}
      className={`relative flex h-14 w-14 items-center justify-center rounded-xl border-2 transition-colors
        ${selected ? 'border-d-brand' : 'border-d-divider hover:border-d-control'}`}
      style={{ backgroundImage: gradientCss(theme) }}
    >
      <span
        aria-hidden="true"
        className="flex h-7 w-7 items-center justify-center rounded-full text-[11px] font-bold"
        style={{ backgroundColor: built.vars['--tint-bg-chat'], color: text }}
      >
        Aa
      </span>
      {selected && (
        <span aria-hidden="true" className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-d-brand ring-2 ring-d-canvas">
          <Check className="h-3 w-3 text-white" strokeWidth={3} />
        </span>
      )}
    </button>
  );
}

/**
 * Gradient themes: twelve presets and your own, all free. A choice is saved
 * to the account (it syncs), so it follows you to other devices.
 */
export default function ColourThemes({ appearance, update, onToast }) {
  const custom = safeCustomThemes(appearance.customThemes);
  const value = appearance.gradient && appearance.gradient !== 'none' ? appearance.gradient : 'none';
  const [editing, setEditing] = useState(null);      // null | 'new' | theme id
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState('');
  const fileRef = useRef(null);
  const importId = useId();

  const choose = (key) => { setConfirmDelete(false); update({ gradient: key }); };
  const keys = ['none', ...GRADIENT_PRESETS.map((p) => p.id), ...custom.map((c) => `custom:${c.id}`)];
  const itemProps = useRovingRadio(keys, value, choose);
  const selectedCustom = value.startsWith('custom:') ? custom.find((c) => `custom:${c.id}` === value) : null;
  const selectedLabel = value === 'none'
    ? t('theme.noGradient')
    : selectedCustom ? selectedCustom.name : t(`theme.preset.${value}`);
  const full = custom.length >= MAX_CUSTOM_THEMES;

  const saveTheme = (draft) => {
    const id = editing && editing !== 'new' ? editing : newThemeId();
    const theme = { id, name: draft.name, base: draft.base, stops: draft.stops, angle: draft.angle, intensity: draft.intensity };
    const next = editing && editing !== 'new'
      ? custom.map((c) => (c.id === id ? theme : c))
      : [...custom, theme];
    update({ customThemes: next, gradient: `custom:${id}` });
    setEditing(null);
    onToast?.(t('theme.saved', { name: theme.name }));
  };

  const removeSelected = () => {
    if (!selectedCustom) return;
    update({ customThemes: custom.filter((c) => c.id !== selectedCustom.id), gradient: 'none' });
    setConfirmDelete(false);
    onToast?.(t('theme.deleted', { name: selectedCustom.name }));
  };

  const download = () => {
    const json = exportTheme(selectedCustom);
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${selectedCustom.name.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'theme'}.theme.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(exportTheme(selectedCustom));
      onToast?.(t('theme.copied'));
    } catch {
      onToast?.(t('theme.copyFailed'), { type: 'error' });
    }
  };

  const runImport = (text) => {
    setImportError('');
    if (full) { setImportError(t('theme.importErrorFull', { max: MAX_CUSTOM_THEMES })); return; }
    try {
      const theme = { id: newThemeId(), ...importTheme(text) };
      update({ customThemes: [...custom, theme], gradient: `custom:${theme.id}` });
      setImportText('');
      setImportOpen(false);
      onToast?.(t('theme.imported', { name: theme.name }));
    } catch (error) {
      const key = error instanceof ThemeError ? IMPORT_ERRORS[error.code] : null;
      setImportError(t(key ?? 'theme.importErrorInvalid'));
    }
  };

  const onFile = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (file.size > 4096) { setImportError(t('theme.importErrorTooBig')); return; }
    runImport(await file.text());
  };

  return (
    <div>
      <div role="radiogroup" aria-label={t('theme.gradients')} className="flex flex-wrap gap-3">
        <button
          type="button"
          {...itemProps('none')}
          aria-label={t('theme.noGradient')}
          title={t('theme.noGradient')}
          className={`relative flex h-14 w-14 items-center justify-center rounded-xl border-2 bg-d-canvas transition-colors
            ${value === 'none' ? 'border-d-brand' : 'border-d-divider hover:border-d-control'}`}
        >
          <Ban className="h-5 w-5 text-d-text3" aria-hidden="true" />
          {value === 'none' && (
            <span aria-hidden="true" className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-d-brand ring-2 ring-d-canvas">
              <Check className="h-3 w-3 text-white" strokeWidth={3} />
            </span>
          )}
        </button>
        {GRADIENT_PRESETS.map((preset) => (
          <Swatch
            key={preset.id}
            theme={preset}
            label={t(`theme.preset.${preset.id}`)}
            selected={value === preset.id}
            itemProps={itemProps(preset.id)}
          />
        ))}
        {custom.map((theme) => (
          <Swatch
            key={theme.id}
            theme={theme}
            label={t('theme.customLabel', { name: theme.name })}
            selected={value === `custom:${theme.id}`}
            itemProps={itemProps(`custom:${theme.id}`)}
          />
        ))}
      </div>
      <p className="mt-3 text-sm text-d-text2" aria-live="polite">
        {t('theme.selected', { name: selectedLabel })}
      </p>

      {selectedCustom && !editing && (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setEditing(selectedCustom.id)}>
            <Pencil className="h-4 w-4" aria-hidden="true" /> {t('theme.edit')}
          </Button>
          <Button size="sm" onClick={download}>
            <Download className="h-4 w-4" aria-hidden="true" /> {t('theme.export')}
          </Button>
          <Button size="sm" onClick={copy}>
            <Copy className="h-4 w-4" aria-hidden="true" /> {t('theme.copyJson')}
          </Button>
          {confirmDelete ? (
            <>
              <Button size="sm" variant="danger" onClick={removeSelected}>{t('theme.confirmDelete')}</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>{t('common.cancel')}</Button>
            </>
          ) : (
            <Button size="sm" variant="dangerGhost" onClick={() => setConfirmDelete(true)}>
              <Trash2 className="h-4 w-4" aria-hidden="true" /> {t('common.delete')}
            </Button>
          )}
        </div>
      )}

      {editing ? (
        <div className="mt-4">
          <CustomThemeBuilder
            initial={editing === 'new' ? null : custom.find((c) => c.id === editing)}
            onCancel={() => setEditing(null)}
            onSave={saveTheme}
            saveLabel={editing === 'new' ? t('theme.saveTheme') : t('common.saveChanges')}
          />
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button variant="primary" size="sm" disabled={full} onClick={() => setEditing('new')}>
            <Plus className="h-4 w-4" aria-hidden="true" /> {t('theme.createCustom')}
          </Button>
          <Button size="sm" aria-expanded={importOpen} aria-controls={importId} onClick={() => setImportOpen((o) => !o)}>
            <Upload className="h-4 w-4" aria-hidden="true" /> {t('theme.import')}
          </Button>
          <span className="text-xs text-d-text3">{t('theme.customCount', { n: custom.length, max: MAX_CUSTOM_THEMES })}</span>
        </div>
      )}

      {importOpen && !editing && (
        <div id={importId} className="mt-3 rounded-lg border border-d-divider bg-d-surface p-4">
          <p className="mb-2 text-sm text-d-text2">{t('theme.importHint')}</p>
          <label htmlFor={`${importId}-text`} className="mb-1 block text-xs font-bold uppercase tracking-[0.02em] text-d-text2">
            {t('theme.importPaste')}
          </label>
          <textarea
            id={`${importId}-text`}
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
            rows={5}
            spellCheck={false}
            className={`${inputClass} font-mono text-xs`}
          />
          {importError && <p role="alert" className="mt-2 text-sm text-d-dangertext">{importError}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="primary" size="sm" onClick={() => runImport(importText)}>{t('theme.importApply')}</Button>
            <Button size="sm" onClick={() => fileRef.current?.click()}>{t('theme.importFile')}</Button>
            <input ref={fileRef} type="file" accept="application/json,.json" className="hidden" onChange={onFile} tabIndex={-1} aria-label={t('theme.importFile')} />
          </div>
        </div>
      )}
    </div>
  );
}
