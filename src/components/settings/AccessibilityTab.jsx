import React, { useState } from 'react';
import { Play, Square } from 'lucide-react';
import { useUserSettings } from '../../hooks/useUserSettings';
import { speak, cancelSpeech, isSpeechSupported } from '../../utils/speech';
import { t } from '../../i18n/index.jsx';
import {
  PageHeader, Section, SettingToggle, Slider, RadioList, Segmented,
  ResetButton, Divider, StackedRow, Button
} from './primitives';

const STICKER_MODES = () => [
  { key: 'always',      label: t('a11y.stickerAlways') },
  { key: 'interaction', label: t('a11y.stickerInteraction') },
  { key: 'never',       label: t('a11y.stickerNever') }
];

/** Each role-colour option previews itself, using the member list's own classes. */
const ROLE_COLOR_MODES = () => [
  {
    key: 'names',
    label: t('a11y.roleColorsNames'),
    hint: t('a11y.roleColorsNamesHint'),
    sample: <span style={{ color: '#f0b232' }}>Kira</span>
  },
  {
    key: 'dots',
    label: t('a11y.roleColorsDots'),
    hint: t('a11y.roleColorsDotsHint'),
    sample: (
      <span className="inline-flex items-center gap-1.5">
        <span className="h-2 w-2 rounded-full" style={{ backgroundColor: '#f0b232' }} />
        <span className="text-d-strong">Kira</span>
      </span>
    )
  },
  {
    key: 'off',
    label: t('a11y.roleColorsOff'),
    hint: t('a11y.roleColorsOffHint'),
    sample: <span className="text-d-strong">Kira</span>
  }
];

/**
 * Accessibility. Saturation, contrast and motion are applied to the document
 * root, so the effect of every control is visible on this page as you change it.
 */
export default function AccessibilityTab({ onToast }) {
  const { prefs, update, reset } = useUserSettings();
  const a11y = prefs.accessibility;
  const [previewing, setPreviewing] = useState(false);
  const set = (patch) => update('accessibility', patch);

  const previewTts = () => {
    if (previewing) { cancelSpeech(); setPreviewing(false); return; }
    if (!isSpeechSupported()) {
      onToast?.(t('a11y.ttsUnsupported'), { type: 'error' });
      return;
    }
    setPreviewing(true);
    speak(t('a11y.ttsPreviewText'), { rate: a11y.ttsRate, onEnd: () => setPreviewing(false) });
  };

  return (
    <div>
      <PageHeader title={t('settings.accessibilityTitle')} description={t('settings.accessibilityLead')} />

      <Section title={t('a11y.visionTitle')}>
        <SettingToggle
          label={t('a11y.highContrast')}
          hint={t('a11y.highContrastHint')}
          checked={a11y.highContrast}
          onChange={(value) => set({ highContrast: value })}
        />
        <SettingToggle
          label={t('a11y.reducedMotion')}
          hint={t('a11y.reducedMotionHint')}
          checked={a11y.reducedMotion}
          onChange={(value) => set({ reducedMotion: value })}
        />
        <Slider
          label={t('a11y.saturation')}
          hint={t('a11y.saturationHint')}
          value={a11y.saturation}
          min={0} max={100} step={5}
          format={(v) => `${v}%`}
          marks={[t('a11y.saturationGrey'), t('a11y.saturationFull')]}
          onChange={(value) => set({ saturation: value })}
          last
        />
      </Section>

      <Divider />

      <Section title={t('a11y.roleColors')} description={t('a11y.roleColorsHint')}>
        <div role="radiogroup" aria-label={t('a11y.roleColors')} className="space-y-2">
          {ROLE_COLOR_MODES().map((mode) => {
            const selected = a11y.roleColors === mode.key;
            return (
              <button
                key={mode.key}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => set({ roleColors: mode.key })}
                className={`flex w-full items-center gap-3 rounded-lg border px-4 py-3 text-left
                  transition-colors ${selected
                    ? 'border-d-brand bg-d-brand/10'
                    : 'border-d-divider bg-d-surface hover:border-d-control'}`}
              >
                <span
                  aria-hidden="true"
                  className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2
                    ${selected ? 'border-d-brand' : 'border-d-control'}`}
                >
                  {selected && <span className="h-2.5 w-2.5 rounded-full bg-d-brand" />}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-d-strong">{mode.label}</span>
                  {mode.hint && <span className="mt-0.5 block text-xs text-d-text2">{mode.hint}</span>}
                </span>
                <span className="shrink-0 text-sm font-medium" aria-hidden="true">{mode.sample}</span>
              </button>
            );
          })}
        </div>
      </Section>

      <Divider />

      <Section title={t('a11y.contentMotion')}>
        <SettingToggle
          label={t('a11y.animatedEmoji')}
          checked={a11y.playAnimatedEmoji}
          onChange={(value) => set({ playAnimatedEmoji: value })}
        />
        <SettingToggle
          label={t('a11y.autoplayGifs')}
          hint={t('a11y.autoplayGifsHint')}
          checked={a11y.autoplayGifs}
          onChange={(value) => set({ autoplayGifs: value })}
        />
        <StackedRow label={t('a11y.stickerAnimation')} last>
          <Segmented
            label={t('a11y.stickerAnimation')}
            value={a11y.stickerAnimation}
            onChange={(value) => set({ stickerAnimation: value })}
            options={STICKER_MODES()}
          />
        </StackedRow>
      </Section>

      <Divider />

      <Section title={t('a11y.textToSpeech')}>
        <SettingToggle
          label={t('a11y.ttsEnabled')}
          hint={t('a11y.ttsEnabledHint')}
          checked={a11y.ttsEnabled}
          onChange={(value) => set({ ttsEnabled: value })}
        />
        <Slider
          label={t('a11y.ttsRate')}
          value={a11y.ttsRate}
          min={0.5} max={3} step={0.1}
          format={(v) => `${v.toFixed(1)}×`}
          onChange={(value) => set({ ttsRate: value })}
        />
        <StackedRow last>
          <Button onClick={previewTts}>
            {previewing ? <Square className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
            {previewing ? t('a11y.stopPreview') : t('a11y.previewTts')}
          </Button>
        </StackedRow>
      </Section>

      <ResetButton onClick={() => reset('accessibility')}>{t('a11y.resetDefaults')}</ResetButton>
    </div>
  );
}
