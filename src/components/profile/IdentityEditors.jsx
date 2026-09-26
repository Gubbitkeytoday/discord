import React, { useEffect, useId } from 'react';
import { AlertTriangle } from 'lucide-react';
import { FONTS, EFFECTS, loadNameFont, contrastReport } from '../../profile/nameStyle';
import { THEME_PRESETS, profileTheme } from '../../profile/theme';
import { t } from '../../i18n/index.jsx';

const DEFAULT_COLORS = ['#5865f2', '#eb459e'];
// Two Thai letters, so each font preview shows its Thai coverage.
const THAI_SAMPLE = '\u0E01\u0E02';

/**
 * Name style: font (all with Thai coverage), effect and colours, with the
 * contrast readout for dark and light themes.
 *
 * Stable API: <NameStyleEditor value={style|null} onChange={(style|null) => …} sample="Name" />
 */
export function NameStyleEditor({ value, onChange, sample }) {
  const id = useId();
  const style = value ?? { font: 'default', effect: 'solid', colors: [] };
  const colors = style.colors?.length ? style.colors : [];
  useEffect(() => { Object.keys(FONTS).forEach(loadNameFont); }, []);
  const set = (patch) => {
    const next = { ...style, ...patch };
    const needed = next.effect === 'gradient' ? 2 : 1;
    let nextColors = next.colors ?? [];
    if (nextColors.length && nextColors.length < needed) nextColors = [nextColors[0], DEFAULT_COLORS[1]];
    next.colors = nextColors.slice(0, needed);
    if (next.font === 'default' && next.colors.length === 0) { onChange(null); return; }
    onChange(next);
  };
  const report = contrastReport(colors);

  return (
    <div className="space-y-3">
      <fieldset>
        <legend className="mb-1.5 text-xs font-bold uppercase tracking-wide text-d-text2">{t('profiles.font')}</legend>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {Object.entries(FONTS).map(([key, font]) => (
            <label key={key}
              className={`flex min-h-11 cursor-pointer flex-col justify-center rounded-md border px-2 py-1.5 text-left
                has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-d-brand
                ${style.font === key ? 'border-d-brand bg-d-active' : 'border-d-divider bg-d-sunken hover:border-d-text4'}`}>
              <input type="radio" name={`${id}-font`} value={key} checked={style.font === key}
                onChange={() => set({ font: key })} className="sr-only" />
              <span className="truncate text-base text-d-strong" style={{ fontFamily: font.family ? `${font.family}, var(--font-sans)` : undefined }}>
                {sample || 'Aa'} {THAI_SAMPLE}
              </span>
              <span className="text-[11px] text-d-text3">{key === 'default' ? t('profiles.fontDefault') : font.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset>
        <legend className="mb-1.5 text-xs font-bold uppercase tracking-wide text-d-text2">{t('profiles.effect')}</legend>
        <div className="flex flex-wrap gap-2">
          {EFFECTS.map((effect) => (
            <label key={effect}
              className={`flex min-h-9 cursor-pointer items-center rounded-md border px-3 text-sm has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-d-brand
                ${style.effect === effect ? 'border-d-brand bg-d-active text-d-strong' : 'border-d-divider bg-d-sunken text-d-text2 hover:text-d-strong'}`}>
              <input type="radio" name={`${id}-effect`} value={effect} checked={style.effect === effect}
                onChange={() => set({ effect, colors: colors.length ? colors : [DEFAULT_COLORS[0]] })} className="sr-only" />
              {t(`profiles.effect.${effect}`)}
            </label>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-wrap items-end gap-4">
        {(style.effect === 'gradient' ? [0, 1] : [0]).map((i) => (
          <label key={i} className="flex flex-col gap-1 text-xs font-semibold text-d-text2">
            {i === 0 ? t('profiles.color1') : t('profiles.color2')}
            <input type="color" value={colors[i] ?? DEFAULT_COLORS[i]}
              onChange={(e) => {
                const next = [...(colors.length ? colors : [DEFAULT_COLORS[0]])];
                next[i] = e.target.value;
                set({ colors: next });
              }}
              className="h-10 w-16 cursor-pointer rounded border border-d-divider bg-transparent" />
          </label>
        ))}
        {value && (
          <button type="button" onClick={() => onChange(null)}
            className="min-h-9 text-sm text-d-text2 hover:text-d-danger hover:underline">
            {t('profiles.clearStyle')}
          </button>
        )}
      </div>
      {report.some((r) => r.adjusted) && (
        <p className="flex items-start gap-2 text-xs text-d-text2" role="status">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-d-idle" aria-hidden="true" />
          {t('profiles.contrastAdjusted')}
        </p>
      )}
      <p className="text-xs text-d-text3">{t('profiles.nameStyleHint')}</p>
    </div>
  );
}

/**
 * Two-colour profile theme with presets. Shows the measured contrast of the
 * text the card will use.
 *
 * Stable API: <ThemeColorsEditor value={[primary, accent]|null} onChange />
 */
export function ThemeColorsEditor({ value, onChange }) {
  const colors = value ?? null;
  const theme = profileTheme(colors);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('profiles.themePresets')}>
        {THEME_PRESETS.map((preset) => {
          const active = colors && preset[0] === colors[0] && preset[1] === colors[1];
          return (
            <button key={preset.join()} type="button" onClick={() => onChange(preset)} aria-pressed={Boolean(active)}
              aria-label={t('profiles.themePreset', { a: preset[0], b: preset[1] })}
              className={`h-10 w-10 rounded-full border-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-d-brand ${active ? 'border-d-strong' : 'border-transparent'}`}
              style={{ backgroundImage: `linear-gradient(180deg, ${preset[0]}, ${preset[1]})` }} />
          );
        })}
      </div>
      <div className="flex flex-wrap items-end gap-4">
        {[0, 1].map((i) => (
          <label key={i} className="flex flex-col gap-1 text-xs font-semibold text-d-text2">
            {i === 0 ? t('profiles.primary') : t('profiles.accent')}
            <input type="color" value={colors?.[i] ?? THEME_PRESETS[0][i]}
              onChange={(e) => {
                const next = [...(colors ?? THEME_PRESETS[0])];
                next[i] = e.target.value;
                onChange(next);
              }}
              className="h-10 w-16 cursor-pointer rounded border border-d-divider bg-transparent" />
          </label>
        ))}
        {colors && (
          <button type="button" onClick={() => onChange(null)}
            className="min-h-9 text-sm text-d-text2 hover:text-d-danger hover:underline">
            {t('profiles.clearTheme')}
          </button>
        )}
      </div>
      {theme && (
        <p className="text-xs text-d-text3" role="status">
          {t('profiles.themeContrast', { ratio: theme.ratio })}
        </p>
      )}
    </div>
  );
}
