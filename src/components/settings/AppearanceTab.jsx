import React from 'react';
import { Monitor, Sun, Moon, Circle, Check } from 'lucide-react';
import { useUserSettings } from '../../hooks/useUserSettings';
import { t } from '../../i18n/index.jsx';
import {
  PageHeader, Section, SettingToggle, RadioList, Slider, ResetButton, Divider, Segmented, StackedRow, Note
} from './primitives';
import ThemePreview from '../theme/ThemePreview.jsx';
import ColourThemes from '../theme/ColourThemes.jsx';
import TypographyControls from '../theme/TypographyControls.jsx';
import SeasonalControls from '../theme/SeasonalControls.jsx';
import SoundPackPicker from '../theme/SoundPackPicker.jsx';

// Swatches show each theme's chat background (docs/research/DISCORD-THEMES.md §3.2).
const THEMES = () => [
  { key: 'light',  label: t('appearance.light'),  icon: Sun,     swatch: '#fbfbfc' },
  { key: 'ash',    label: t('appearance.ash'),    icon: Circle,  swatch: '#35363c' },
  { key: 'dark',   label: t('appearance.dark'),   icon: Moon,    swatch: '#1c1c20' },
  { key: 'onyx',   label: t('appearance.onyx'),   icon: Circle,  swatch: '#000000' },
  { key: 'system', label: t('appearance.system'), icon: Monitor,
    swatch: 'linear-gradient(135deg,#fbfbfc 0 50%,#1c1c20 50% 100%)' }
];

const SYSTEM_LIGHT = () => [
  { key: 'light', label: t('appearance.light') },
  { key: 'ash',   label: t('appearance.ash') }
];
const SYSTEM_DARK = () => [
  { key: 'ash',  label: t('appearance.ash') },
  { key: 'dark', label: t('appearance.dark') },
  { key: 'onyx', label: t('appearance.onyx') }
];

const DENSITIES = () => [
  { key: 'compact',  label: t('appearance.densityCompact') },
  { key: 'default',  label: t('appearance.densityDefault') },
  { key: 'spacious', label: t('appearance.densitySpacious') }
];

const RADII = () => [
  { key: 'sharp',   label: t('theme.radiusSharp') },
  { key: 'default', label: t('theme.radiusDefault') },
  { key: 'round',   label: t('theme.radiusRound') }
];

const DISPLAY_MODES = () => [
  { key: 'cozy',    label: t('appearance.cozy'),    hint: t('appearance.cozyHint') },
  { key: 'compact', label: t('appearance.compact'), hint: t('appearance.compactHint') }
];

/**
 * Appearance. Every control writes a CSS variable or a data attribute on
 * <html> (theme/engine.js), so the preview pane is the app's own CSS under
 * the real settings — not a picture of what the result would look like —
 * and so is the settings page itself.
 */
export default function AppearanceTab({ onToast }) {
  const { prefs, update, reset } = useUserSettings();
  const appearance = prefs.appearance;
  const set = (patch) => update('appearance', patch);
  const gradientOn = appearance.gradient && appearance.gradient !== 'none';

  return (
    <div>
      <PageHeader title={t('settings.appearanceTitle')} description={t('settings.appearanceLead')} />

      <div className="lg:grid lg:grid-cols-[minmax(0,1fr)_17rem] lg:gap-8">
        {/* The preview comes first in the DOM order on narrow screens (it is
            what the controls change); beside the controls on wide ones. */}
        <aside className="mb-6 lg:order-2 lg:mb-0">
          <div className="lg:sticky lg:top-4">
            <ThemePreview messageDisplay={appearance.messageDisplay} use24HourClock={prefs.chat.use24HourClock} />
            <p className="mt-2 text-xs text-d-text3">{t('theme.previewHint')}</p>
          </div>
        </aside>

        <div className="min-w-0 lg:order-1">
          <Section title={t('appearance.theme')}>
            <div className="flex flex-wrap gap-3" role="radiogroup" aria-label={t('appearance.theme')}>
              {THEMES().map((theme) => {
                const selected = appearance.theme === theme.key;
                return (
                  <button
                    key={theme.key}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => set({ theme: theme.key, ...(gradientOn ? { gradient: 'none' } : {}) })}
                    className={`relative w-[92px] overflow-hidden rounded-lg border-2 transition-colors
                      ${selected ? 'border-d-brand' : 'border-d-divider hover:border-d-control'}`}
                  >
                    <span className="block h-12" style={{ background: theme.swatch }}>
                      {selected && (
                        <span className="flex h-full items-center justify-center">
                          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-d-brand">
                            <Check className="h-3.5 w-3.5 text-white" strokeWidth={3} aria-hidden="true" />
                          </span>
                        </span>
                      )}
                    </span>
                    <span className="flex items-center justify-center gap-1.5 bg-d-surface py-2 text-xs font-semibold text-d-strong">
                      <theme.icon className="h-3.5 w-3.5" aria-hidden="true" /> {theme.label}
                    </span>
                  </button>
                );
              })}
            </div>
            {gradientOn && (
              <div className="mt-3"><Note>{t('theme.gradientOverridesBase')}</Note></div>
            )}
            {appearance.theme === 'system' && (
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <div>
                  <p className="mb-2 text-sm font-medium text-d-strong">{t('theme.systemLightTheme')}</p>
                  <Segmented
                    label={t('theme.systemLightTheme')}
                    value={appearance.systemLightTheme ?? 'light'}
                    onChange={(value) => set({ systemLightTheme: value })}
                    options={SYSTEM_LIGHT()}
                  />
                </div>
                <div>
                  <p className="mb-2 text-sm font-medium text-d-strong">{t('appearance.systemDarkTheme')}</p>
                  <Segmented
                    label={t('appearance.systemDarkTheme')}
                    value={appearance.systemDarkTheme ?? 'dark'}
                    onChange={(value) => set({ systemDarkTheme: value })}
                    options={SYSTEM_DARK()}
                  />
                </div>
              </div>
            )}
            <div className="mt-2">
              <SettingToggle
                label={t('a11y.highContrast')}
                hint={t('theme.highContrastHint')}
                checked={Boolean(prefs.accessibility.highContrast)}
                onChange={(value) => update('accessibility', { highContrast: value })}
                last
              />
            </div>
          </Section>

          <Divider />

          <Section title={t('theme.gradients')} description={t('theme.gradientsHint')}>
            <ColourThemes appearance={appearance} update={set} onToast={onToast} />
          </Section>

          <Divider />

          <Section title={t('appearance.uiDensity')} description={t('theme.densityHint')}>
            <Segmented
              label={t('appearance.uiDensity')}
              value={appearance.uiDensity}
              onChange={(value) => set({ uiDensity: value })}
              options={DENSITIES()}
            />
            <StackedRow label={t('theme.radius')} hint={t('theme.radiusHint')} last>
              <Segmented
                label={t('theme.radius')}
                value={appearance.radius ?? 'default'}
                onChange={(value) => set({ radius: value })}
                options={RADII()}
              />
            </StackedRow>
          </Section>

          <Divider />

          <Section title={t('appearance.messageDisplay')}>
            <RadioList
              label={t('appearance.messageDisplay')}
              value={appearance.messageDisplay}
              onChange={(value) => set({ messageDisplay: value })}
              options={DISPLAY_MODES()}
            />
          </Section>

          <Divider />

          <Section title={t('theme.textTitle')} description={t('theme.textHint')}>
            <TypographyControls appearance={appearance} update={set} />
          </Section>

          <Divider />

          <Section title={t('appearance.scaling')}>
            <Slider
              label={t('appearance.zoom')}
              hint={t('appearance.zoomHint')}
              value={appearance.zoom}
              min={50} max={200} step={10}
              format={(v) => `${v}%`}
              marks={['50%', '100%', '150%', '200%']}
              onChange={(value) => set({ zoom: value })}
            />
            <Slider
              label={t('appearance.groupSpacing')}
              hint={t('appearance.groupSpacingHint')}
              value={appearance.messageGroupSpacing}
              min={0} max={48} step={2}
              format={(v) => `${v}px`}
              onChange={(value) => set({ messageGroupSpacing: value })}
              last
            />
          </Section>

          <Divider />

          <Section title={t('theme.seasonalTitle')}>
            <SeasonalControls appearance={appearance} update={set} />
          </Section>

          <Divider />

          <Section title={t('theme.soundPack')} description={t('theme.soundPackHint')}>
            <SoundPackPicker value={appearance.soundPack} onChange={(soundPack) => set({ soundPack })} />
          </Section>

          <Divider />

          <Section>
            <SettingToggle
              label={t('appearance.showSendButton')}
              checked={appearance.showSendButton}
              onChange={(value) => set({ showSendButton: value })}
            />
            <SettingToggle
              label={t('appearance.syncAcrossDevices')}
              hint={t('theme.syncHint')}
              checked={appearance.syncAcrossDevices}
              onChange={(value) => set({ syncAcrossDevices: value })}
              last
            />
          </Section>

          <ResetButton onClick={() => reset('appearance')}>{t('appearance.resetDefaults')}</ResetButton>
        </div>
      </div>
    </div>
  );
}
