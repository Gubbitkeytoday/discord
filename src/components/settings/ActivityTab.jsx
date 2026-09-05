import React, { useState } from 'react';
import { Check } from 'lucide-react';
import { useUserSettings } from '../../hooks/useUserSettings';
import { t } from '../../i18n/index.jsx';
import {
  PageHeader, Section, SettingToggle, StackedRow, ResetButton, Divider, Note,
  Button, inputClass
} from './primitives';

/**
 * Activity Privacy. On Discord this is where game detection lives; a
 * self-hosted web client has no game to detect, so what it can honestly offer
 * is the custom activity line other people see on your profile, and the switch
 * that stops it being shared at all.
 */
export default function ActivityTab({ currentUser, onSetStatus }) {
  const { prefs, update, reset } = useUserSettings();
  const activity = prefs.activity;
  const [draft, setDraft] = useState(activity.customActivity ?? currentUser?.custom_status ?? '');
  const [saved, setSaved] = useState(false);

  const save = () => {
    const value = draft.trim() || null;
    update('activity', { customActivity: value });
    onSetStatus?.(currentUser?.status ?? 'online', value ?? '');
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <div>
      <PageHeader title={t('settings.activityTitle')} description={t('settings.activityLead')} />

      <Section>
        <SettingToggle
          label={t('activity.share')}
          hint={t('activity.shareHint')}
          checked={activity.shareActivity}
          onChange={(value) => update('activity', { shareActivity: value })}
          last
        />
      </Section>

      <Divider />

      <Section title={t('activity.customActivity')}>
        <StackedRow hint={t('activity.customActivityHint')} last>
          <div className="flex gap-2">
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter') save(); }}
              maxLength={128}
              placeholder={t('status.customPlaceholder')}
              aria-label={t('activity.customActivity')}
              className={`${inputClass} flex-1`}
            />
            <Button variant="primary" onClick={save} className="shrink-0">
              {saved ? <Check className="h-4 w-4" /> : null}
              {saved ? t('common.saved') : t('common.save')}
            </Button>
          </div>
        </StackedRow>
      </Section>

      <Note>{t('activity.noGameDetection')}</Note>

      <ResetButton onClick={() => reset('activity')}>{t('activity.resetDefaults')}</ResetButton>
    </div>
  );
}
