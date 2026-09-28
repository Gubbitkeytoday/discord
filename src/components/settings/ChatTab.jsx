import React from 'react';
import { useUserSettings, localeUses24Hour } from '../../hooks/useUserSettings';
import { t, localeTag, getAvailableLocales, currentLocaleCode } from '../../i18n/index.jsx';
import { targetLanguage } from '../../translation';
import {
  PageHeader, Section, SettingToggle, RadioList, ResetButton, Divider, Select, StackedRow
} from './primitives';

/** 13:30 or 1:30 PM for a fixed sample time, in the app language. */
function sampleTime(hour12) {
  const sample = new Date(2026, 0, 1, 13, 30);
  try {
    return sample.toLocaleTimeString(localeTag(), { hour: 'numeric', minute: '2-digit', ...(hour12 === undefined ? {} : { hour12 }) });
  } catch {
    return hour12 ? '1:30 PM' : '13:30';
  }
}

const CLOCK_FORMATS = () => [
  { key: 'auto', label: t('chatTab.clockAuto'), hint: sampleTime(!localeUses24Hour()) },
  { key: '12h',  label: t('chatTab.clock12'),   hint: sampleTime(true) },
  { key: '24h',  label: t('chatTab.clock24'),   hint: sampleTime(false) }
];

const SPOILER_MODES = () => [
  { key: 'click',  label: t('chatTab.spoilerClick'),  hint: t('chatTab.spoilerClickHint') },
  { key: 'owned',  label: t('chatTab.spoilerOwned'),  hint: t('chatTab.spoilerOwnedHint') },
  { key: 'always', label: t('chatTab.spoilerAlways'), hint: t('chatTab.spoilerAlwaysHint') }
];

/** Text & Images: what actually renders inside a message. */
function languageLabel(code) {
  try { return new Intl.DisplayNames([localeTag()], { type: 'language' }).of(code) ?? code; } catch { return code; }
}

/** One option per distinct target the app's own locales map to, by name. */
function translationTargets() {
  const seen = new Map();
  for (const { code } of getAvailableLocales()) {
    const target = targetLanguage(code);
    if (!seen.has(target)) seen.set(target, { code: target, label: languageLabel(target) });
  }
  return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label, localeTag()));
}

export default function ChatTab() {
  const { prefs, update, reset } = useUserSettings();
  const chat = prefs.chat;
  const set = (patch) => update('chat', patch);

  return (
    <div>
      <PageHeader title={t('settings.chatTitle')} description={t('settings.chatLead')} />

      <Section title={t('chatTab.embedsAndLinks')}>
        <SettingToggle
          label={t('chatTab.linkPreviews')}
          hint={t('chatTab.linkPreviewsHint')}
          checked={chat.showLinkPreviews}
          onChange={(value) => set({ showLinkPreviews: value })}
        />
        <SettingToggle
          label={t('chatTab.embeds')}
          checked={chat.showEmbeds}
          onChange={(value) => set({ showEmbeds: value })}
        />
        <SettingToggle
          label={t('chatTab.imagePreviews')}
          checked={chat.showImagePreviews}
          onChange={(value) => set({ showImagePreviews: value })}
        />
        <SettingToggle
          label={t('chatTab.inlineMedia')}
          hint={t('chatTab.inlineMediaHint')}
          checked={chat.inlineAttachmentMedia}
          onChange={(value) => set({ inlineAttachmentMedia: value })}
          last
        />
      </Section>

      <Divider />

      <Section title={t('chatTab.spoilers')} description={t('chatTab.spoilersHint')}>
        <RadioList
          label={t('chatTab.spoilers')}
          value={chat.renderSpoilers}
          onChange={(value) => set({ renderSpoilers: value })}
          options={SPOILER_MODES()}
        />
      </Section>

      <Divider />

      <Section title={t('chatTab.messageText')}>
        <SettingToggle
          label={t('chatTab.showTimestamps')}
          checked={chat.showTimestamps}
          onChange={(value) => set({ showTimestamps: value })}
        />
        <StackedRow label={t('chatTab.clockFormat')} hint={t('chatTab.clockFormatHint')}>
          <RadioList
            label={t('chatTab.clockFormat')}
            value={chat.clockFormat ?? (chat.use24HourClock === false ? '12h' : 'auto')}
            onChange={(value) => set({ clockFormat: value, use24HourClock: value === 'auto' ? localeUses24Hour() : value === '24h' })}
            options={CLOCK_FORMATS()}
          />
        </StackedRow>
        <SettingToggle
          label={t('chatTab.convertEmoticons')}
          hint={t('chatTab.convertEmoticonsHint')}
          checked={chat.convertEmoticons}
          onChange={(value) => set({ convertEmoticons: value })}
        />
        <SettingToggle
          label={t('chatTab.tapToReact')}
          hint={t('chatTab.tapToReactHint')}
          checked={Boolean(chat.tapToReactEmoji)}
          onChange={(value) => set({ tapToReactEmoji: value ? '❤️' : null })}
        />
        <SettingToggle
          label={t('chatTab.typingIndicator')}
          hint={t('chatTab.typingIndicatorHint')}
          checked={chat.showTypingIndicator}
          onChange={(value) => set({ showTypingIndicator: value })}
          last
        />
      </Section>

      <Divider />

      <Section title={t('chatTab.translation')} description={t('chatTab.translateTargetHint')}>
        <Select
          id="translate-target"
          label={t('chatTab.translateTarget')}
          value={chat.translateTarget ?? ''}
          onChange={(value) => set({ translateTarget: value })}
        >
          <option value="">
            {t('chatTab.translateTargetDefault', { lang: languageLabel(targetLanguage(currentLocaleCode())) })}
          </option>
          {translationTargets().map(({ code, label }) => (
            <option key={code} value={code}>{label}</option>
          ))}
        </Select>
      </Section>

      <Divider />

      <Section title={t('chatTab.advanced')}>
        <SettingToggle
          label={t('chatTab.developerMode')}
          hint={t('chatTab.developerModeHint')}
          checked={chat.developerMode}
          onChange={(value) => set({ developerMode: value })}
          last
        />
      </Section>

      <ResetButton onClick={() => reset('chat')}>{t('chatTab.resetDefaults')}</ResetButton>
    </div>
  );
}
