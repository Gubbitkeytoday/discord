import React from 'react';
import { Monitor, Sun, Moon, Circle, Check } from 'lucide-react';
import { useUserSettings } from '../../hooks/useUserSettings';
import { useI18n, LOCALES, t } from '../../i18n/index.jsx';
import { DEFAULT_AVATAR } from '../../utils/avatar';
import {
  PageHeader, Section, SettingToggle, RadioList, Slider, ResetButton, Divider, Segmented
} from './primitives';

const THEMES = () => [
  { key: 'light',  label: t('appearance.light'),  icon: Sun,     swatch: '#ffffff', ink: '#313338' },
  { key: 'ash',    label: t('appearance.ash'),    icon: Circle,  swatch: '#3b3d42', ink: '#ffffff' },
  { key: 'dark',   label: t('appearance.dark'),   icon: Moon,    swatch: '#313338', ink: '#ffffff' },
  { key: 'onyx',   label: t('appearance.onyx'),   icon: Circle,  swatch: '#111214', ink: '#ffffff' },
  { key: 'system', label: t('appearance.system'), icon: Monitor,
    swatch: 'linear-gradient(135deg,#ffffff 0 50%,#313338 50% 100%)', ink: '#ffffff' }
];

const DENSITIES = () => [
  { key: 'compact',  label: t('appearance.densityCompact') },
  { key: 'default',  label: t('appearance.densityDefault') },
  { key: 'spacious', label: t('appearance.densitySpacious') }
];

const DISPLAY_MODES = () => [
  { key: 'cozy',    label: t('appearance.cozy'),    hint: t('appearance.cozyHint') },
  { key: 'compact', label: t('appearance.compact'), hint: t('appearance.compactHint') }
];

/**
 * Appearance. Every control writes a CSS variable or a data attribute on
 * <html>, so the preview below is the real message renderer under the real
 * settings — not a picture of what the result would look like.
 */
export default function AppearanceTab() {
  const { prefs, update, reset } = useUserSettings();
  const appearance = prefs.appearance;
  const { locale, setLocale } = useI18n();
  const set = (patch) => update('appearance', patch);

  return (
    <div>
      <PageHeader title={t('settings.appearanceTitle')} description={t('settings.appearanceLead')} />

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
                onClick={() => set({ theme: theme.key })}
                className={`relative w-[104px] overflow-hidden rounded-lg border-2 transition-colors
                  focus:outline-none focus-visible:ring-2 focus-visible:ring-d-brand
                  ${selected ? 'border-d-brand' : 'border-d-divider hover:border-d-control'}`}
              >
                <span className="block h-14" style={{ background: theme.swatch }}>
                  {selected && (
                    <span className="flex h-full items-center justify-center">
                      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-d-brand">
                        <Check className="h-3.5 w-3.5 text-white" strokeWidth={3} />
                      </span>
                    </span>
                  )}
                </span>
                <span className="flex items-center justify-center gap-1.5 bg-d-surface py-2 text-xs
                  font-semibold text-d-strong">
                  <theme.icon className="h-3.5 w-3.5" aria-hidden="true" /> {theme.label}
                </span>
              </button>
            );
          })}
        </div>
      </Section>

      <Divider />

      <Section title={t('appearance.uiDensity')} description={t('appearance.uiDensityHint')}>
        <Segmented
          label={t('appearance.uiDensity')}
          value={appearance.uiDensity}
          onChange={(value) => set({ uiDensity: value })}
          options={DENSITIES()}
        />
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

      <Section title={t('appearance.preview')}>
        <div className="rounded-lg border border-d-divider bg-d-canvas p-4">
          {[
            { name: 'Kira', colour: '#f0b232', text: t('appearance.previewLineOne') },
            { name: 'Alex', colour: '#5865f2', text: t('appearance.previewLineTwo') }
          ].map((row, index) => (
            <div
              key={row.name}
              className={`flex gap-3 ${index > 0 ? 'message-group-start' : ''}`}
              style={{ paddingTop: 'var(--message-padding-y)', paddingBottom: 'var(--message-padding-y)' }}
            >
              {appearance.messageDisplay === 'cozy' && (
                <img src={DEFAULT_AVATAR} alt="" className="h-10 w-10 shrink-0 rounded-full" />
              )}
              <div className="min-w-0">
                <span className="mr-2 text-sm font-semibold" style={{ color: row.colour }}>{row.name}</span>
                <span className="text-[11px] text-d-text3">
                  {new Date().toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}
                </span>
                <p className="message-body text-d-text">{row.text}</p>
              </div>
            </div>
          ))}
        </div>
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
          label={t('appearance.chatFontScale')}
          hint={t('appearance.chatFontScaleHint')}
          value={appearance.chatFontScale}
          min={80} max={160} step={5}
          format={(v) => `${v}%`}
          onChange={(value) => set({ chatFontScale: value })}
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

      <Section>
        <SettingToggle
          label={t('appearance.showSendButton')}
          checked={appearance.showSendButton}
          onChange={(value) => set({ showSendButton: value })}
        />
        <SettingToggle
          label={t('appearance.syncAcrossDevices')}
          hint={t('appearance.syncAcrossDevicesHint')}
          checked={appearance.syncAcrossDevices}
          onChange={(value) => set({ syncAcrossDevices: value })}
          last
        />
      </Section>

      <Divider />

      {/* Language lives here, as it does in Discord's redesigned settings. */}
      <Section title={t('appearance.language')} description={t('appearance.languageHint')}>
        <div className="flex flex-wrap gap-2">
          {LOCALES.map((entry) => (
            <button
              key={entry.code}
              type="button"
              onClick={() => setLocale(entry.code)}
              aria-pressed={locale === entry.code}
              className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors
                ${locale === entry.code
                  ? 'border-d-brand bg-d-brand/10 text-d-strong'
                  : 'border-d-divider bg-d-surface text-d-text2 hover:border-d-control hover:text-d-strong'}`}
            >
              <span aria-hidden="true">{entry.flag}</span>
              {entry.label}
              {locale === entry.code && <Check className="h-3.5 w-3.5 text-d-brand" />}
            </button>
          ))}
        </div>
      </Section>

      <ResetButton onClick={() => reset('appearance')}>{t('appearance.resetDefaults')}</ResetButton>
    </div>
  );
}
