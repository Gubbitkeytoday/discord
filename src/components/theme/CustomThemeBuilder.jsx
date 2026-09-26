import React, { useEffect, useId, useMemo, useState } from 'react';
import { Plus, Trash2, Shuffle, ShieldCheck, AlertTriangle } from 'lucide-react';
import { t, formatNumber } from '../../i18n/index.jsx';
import { refreshAppearance } from '../../hooks/useUserSettings';
import { setGradientPreview } from '../../theme/engine.js';
import { buildGradientTheme, gradientCss } from '../../theme/gradient.js';
import { hslToHex, isHex6 } from '../../theme/color.js';
import { MAX_STOPS, MAX_NAME_LENGTH } from '../../theme/schema.js';
import { Segmented, Slider, Button, inputClass } from '../settings/primitives';

const blank = () => ({ name: t('theme.customDefaultName'), base: 'dark', stops: ['#3b2a6b', '#155e63'], angle: 150, intensity: 70 });

/** "Surprise me": analogous hues, dark or pale depending on the base. */
function surprise(base) {
  const hue = Math.floor(Math.random() * 360);
  const count = 2 + Math.floor(Math.random() * 3);
  const spread = 20 + Math.floor(Math.random() * 40);
  const stops = Array.from({ length: count }, (_, i) => {
    const h = (hue + i * spread) % 360;
    return base === 'dark'
      ? hslToHex(h, 0.45 + Math.random() * 0.3, 0.2 + Math.random() * 0.14)
      : hslToHex(h, 0.55 + Math.random() * 0.3, 0.82 + Math.random() * 0.08);
  });
  return { stops, angle: Math.floor(Math.random() * 72) * 5 };
}

function StopInput({ value, index, onChange, onRemove, canRemove }) {
  const [text, setText] = useState(value);
  useEffect(() => setText(value), [value]);
  const id = useId();
  const valid = isHex6(text);
  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={t('theme.stopColour', { n: index + 1 })}
        className="h-10 w-12 shrink-0 cursor-pointer rounded-md border border-d-divider bg-transparent p-0.5"
      />
      <label htmlFor={id} className="sr-only">{t('theme.stopHex', { n: index + 1 })}</label>
      <input
        id={id}
        value={text}
        maxLength={7}
        spellCheck={false}
        autoComplete="off"
        aria-invalid={!valid}
        onChange={(e) => {
          const next = e.target.value.trim();
          setText(next);
          if (isHex6(next)) onChange(next.toLowerCase());
        }}
        onBlur={() => setText(value)}
        className={`${inputClass} !w-28 font-mono uppercase`}
      />
      <Button
        variant="ghost"
        size="sm"
        disabled={!canRemove}
        onClick={onRemove}
        aria-label={t('theme.removeStop', { n: index + 1 })}
        className="!px-2 min-h-8 min-w-8"
      >
        <Trash2 className="h-4 w-4" aria-hidden="true" />
      </Button>
    </div>
  );
}

/**
 * Discord's custom theme editor, free: up to five colours, direction,
 * intensity, "Surprise me". The draft is shown on the whole app while you
 * edit (a transient preview, never saved until you press Save), and the
 * contrast guard's verdict is announced as it changes.
 */
export default function CustomThemeBuilder({ initial, onSave, onCancel, saveLabel }) {
  const [draft, setDraft] = useState(() => ({ ...blank(), ...(initial ?? {}) }));
  const nameId = useId();
  const set = (patch) => setDraft((d) => ({ ...d, ...patch }));

  useEffect(() => {
    setGradientPreview({ base: draft.base, stops: draft.stops, angle: draft.angle, intensity: draft.intensity });
    refreshAppearance();
  }, [draft.base, draft.stops, draft.angle, draft.intensity]);
  useEffect(() => () => { setGradientPreview(null); refreshAppearance(); }, []);

  const verdict = useMemo(() => buildGradientTheme(draft), [draft.base, draft.stops, draft.angle, draft.intensity]);
  const nameValid = draft.name.trim().length > 0 && draft.name.trim().length <= MAX_NAME_LENGTH;
  const ratio = formatNumber(Math.floor(verdict.worst.ratio * 100) / 100, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const percent = Math.round(verdict.amount * 100);

  return (
    <div className="rounded-lg border border-d-divider bg-d-surface p-4">
      <div
        className="mb-4 h-16 rounded-md border border-d-divider"
        style={{ backgroundImage: gradientCss(draft) }}
        aria-hidden="true"
      />

      <label htmlFor={nameId} className="mb-2 block text-xs font-bold uppercase tracking-[0.02em] text-d-text2">
        {t('theme.customName')}
      </label>
      <input
        id={nameId}
        value={draft.name}
        maxLength={MAX_NAME_LENGTH}
        onChange={(e) => set({ name: e.target.value })}
        aria-invalid={!nameValid}
        className={inputClass}
      />

      <p className="mb-2 mt-4 text-xs font-bold uppercase tracking-[0.02em] text-d-text2">{t('theme.customBase')}</p>
      <Segmented
        label={t('theme.customBase')}
        value={draft.base}
        onChange={(base) => set({ base })}
        options={[{ key: 'dark', label: t('appearance.dark') }, { key: 'light', label: t('appearance.light') }]}
      />

      <p className="mb-2 mt-4 text-xs font-bold uppercase tracking-[0.02em] text-d-text2">
        {t('theme.customColours', { n: draft.stops.length, max: MAX_STOPS })}
      </p>
      <div className="space-y-2">
        {draft.stops.map((stop, index) => (
          <StopInput
            // Stops have no identity beyond their position.
            // eslint-disable-next-line react/no-array-index-key
            key={index}
            index={index}
            value={stop}
            canRemove={draft.stops.length > 1}
            onChange={(value) => set({ stops: draft.stops.map((s, i) => (i === index ? value : s)) })}
            onRemove={() => set({ stops: draft.stops.filter((_, i) => i !== index) })}
          />
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={draft.stops.length >= MAX_STOPS}
          onClick={() => set({ stops: [...draft.stops, draft.stops.at(-1)] })}
        >
          <Plus className="h-4 w-4" aria-hidden="true" /> {t('theme.addStop')}
        </Button>
        <Button size="sm" onClick={() => set(surprise(draft.base))}>
          <Shuffle className="h-4 w-4" aria-hidden="true" /> {t('theme.surprise')}
        </Button>
      </div>

      <Slider
        label={t('theme.angle')}
        value={draft.angle}
        min={0} max={360} step={5}
        format={(v) => `${v}°`}
        onChange={(angle) => set({ angle })}
      />
      <Slider
        label={t('theme.intensity')}
        hint={t('theme.intensityHint')}
        value={draft.intensity}
        min={0} max={100} step={5}
        format={(v) => `${v}%`}
        onChange={(intensity) => set({ intensity })}
        last
      />

      <div role="status" aria-live="polite" className="mt-2 flex items-start gap-2 rounded-md bg-d-sunken px-3 py-2 text-sm text-d-text2">
        {verdict.adjusted
          ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-d-idletext" aria-hidden="true" />
          : <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-d-onlinetext" aria-hidden="true" />}
        <span>
          {verdict.adjusted ? t('theme.contrastAdjusted', { percent, ratio }) : t('theme.contrastOk', { ratio })}
        </span>
      </div>

      <div className="mt-4 flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>{t('common.cancel')}</Button>
        <Button
          variant="primary"
          disabled={!nameValid}
          onClick={() => onSave({ ...draft, name: draft.name.trim() })}
        >
          {saveLabel ?? t('theme.saveTheme')}
        </Button>
      </div>
    </div>
  );
}
