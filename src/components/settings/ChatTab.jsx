import React from 'react';
import { useUserSettings } from '../../hooks/useUserSettings';
import { t } from '../../i18n/index.jsx';
import {
  PageHeader, Section, SettingToggle, RadioList, ResetButton, Divider
} from './primitives';

const SPOILER_MODES = () => [
  { key: 'click',  label: t('chatTab.spoilerClick'),  hint: t('chatTab.spoilerClickHint') },
  { key: 'owned',  label: t('chatTab.spoilerOwned'),  hint: t('chatTab.spoilerOwnedHint') },
  { key: 'always', label: t('chatTab.spoilerAlways'), hint: t('chatTab.spoilerAlwaysHint') }
];

/** Text & Images: what actually renders inside a message. */
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
        <SettingToggle
          label={t('chatTab.use24Hour')}
          checked={chat.use24HourClock}
          onChange={(value) => set({ use24HourClock: value })}
        />
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
