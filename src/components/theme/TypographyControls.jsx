import React from 'react';
import { t, formatNumber } from '../../i18n/index.jsx';
import { chatFontPx } from '../../theme/engine.js';
import { RadioList, Slider, Button } from '../settings/primitives';

const FONTS = () => [
  { key: 'inter', label: t('theme.fontInter'), hint: t('theme.fontInterHint') },
  { key: 'system', label: t('theme.fontSystem'), hint: t('theme.fontSystemHint') },
  { key: 'atkinson', label: 'Atkinson Hyperlegible', hint: t('theme.fontAtkinsonHint') },
  { key: 'opendyslexic', label: 'OpenDyslexic', hint: t('theme.fontDyslexicHint') }
];

// WCAG 1.4.12's test values: 1.5 line height, 0.12em letters, 0.16em words.
const WCAG_SPACING = { chatLineHeight: 1.5, letterSpacing: 0.12, wordSpacing: 0.16 };
const DEFAULT_SPACING = { chatLineHeight: 1.375, letterSpacing: 0, wordSpacing: 0 };

const em = (v) => `${formatNumber(v, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} em`;

/**
 * Font and text spacing — the same controls on Appearance and on
 * Accessibility (both write appearance.*, so they can never disagree).
 */
export default function TypographyControls({ appearance, update, showFont = true }) {
  const px = chatFontPx(appearance);
  return (
    <div>
      {showFont && (
        <div className="pb-4">
          <p className="mb-2 text-base font-medium text-d-strong">{t('theme.font')}</p>
          <RadioList
            label={t('theme.font')}
            value={appearance.uiFont ?? 'inter'}
            onChange={(uiFont) => update({ uiFont })}
            options={FONTS()}
          />
          <p className="mt-2 text-xs text-d-text3">{t('theme.fontThaiNote')}</p>
        </div>
      )}
      <Slider
        label={t('appearance.chatFontScale')}
        hint={t('theme.chatFontHint')}
        value={px}
        min={12} max={24} step={1}
        format={(v) => `${v}px`}
        marks={['12px', '16px', '20px', '24px']}
        onChange={(value) => update({ chatFontScale: Math.round((value / 16) * 10000) / 100 })}
      />
      <Slider
        label={t('theme.lineHeight')}
        value={appearance.chatLineHeight ?? 1.375}
        min={1.2} max={2.2} step={0.05}
        format={(v) => `×${formatNumber(v, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
        onChange={(chatLineHeight) => update({ chatLineHeight })}
      />
      <Slider
        label={t('theme.letterSpacing')}
        value={appearance.letterSpacing ?? 0}
        min={0} max={0.2} step={0.01}
        format={em}
        onChange={(letterSpacing) => update({ letterSpacing })}
      />
      <Slider
        label={t('theme.wordSpacing')}
        value={appearance.wordSpacing ?? 0}
        min={0} max={0.3} step={0.02}
        format={em}
        onChange={(wordSpacing) => update({ wordSpacing })}
        last
      />
      <div className="mt-1 flex flex-wrap gap-2">
        <Button size="sm" onClick={() => update(WCAG_SPACING)}>{t('theme.spacingWcag')}</Button>
        <Button size="sm" variant="ghost" onClick={() => update(DEFAULT_SPACING)}>{t('theme.spacingReset')}</Button>
      </div>
    </div>
  );
}
