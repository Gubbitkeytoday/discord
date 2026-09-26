import React, { useEffect, useState } from 'react';
import { t, formatDate } from '../../i18n/index.jsx';
import { refreshAppearance } from '../../hooks/useUserSettings';
import { setSeasonPreview, getSeasonPreview } from '../../theme/engine.js';
import {
  SEASONS, seasonDates, getSeasonWindows, onSeasonWindowsChange, resolveSeason
} from '../../theme/seasonal.js';
import { SettingToggle, Button } from '../settings/primitives';

const day = (ymd) => {
  const [y, m, d] = ymd.split('-').map(Number);
  return formatDate(new Date(y, m - 1, d), { day: 'numeric', month: 'short' });
};

/**
 * Seasonal themes: on by default during each season, one switch to opt out.
 * "Try it" previews a season for this session only.
 */
export default function SeasonalControls({ appearance, update }) {
  const [, force] = useState(0);
  const [preview, setPreview] = useState(getSeasonPreview());
  useEffect(() => onSeasonWindowsChange(() => force((n) => n + 1)), []);
  useEffect(() => () => { setSeasonPreview(null); refreshAppearance(); }, []);

  const on = appearance.seasonal !== 'off';
  const windows = getSeasonWindows();
  const current = resolveSeason({ seasonal: 'auto' });

  const toggle = (id) => {
    const next = preview === id ? null : id;
    setSeasonPreview(next);
    setPreview(next);
    refreshAppearance();
  };

  return (
    <div>
      <SettingToggle
        label={t('theme.seasonal')}
        hint={current ? t('theme.seasonalNow', { name: t(`theme.season.${current}`) }) : t('theme.seasonalHint')}
        checked={on}
        onChange={(value) => update({ seasonal: value ? 'auto' : 'off' })}
      />
      <ul className="mt-2 divide-y divide-d-divider">
        {SEASONS.map((id) => {
          const dates = seasonDates(id, new Date(), windows);
          const enabled = windows[id]?.enabled !== false;
          return (
            <li key={id} className="flex items-center justify-between gap-4 py-2.5">
              <span className="min-w-0">
                <span className="block text-sm font-medium text-d-strong">{t(`theme.season.${id}`)}</span>
                <span className="block text-xs text-d-text3">
                  {!enabled ? t('theme.seasonOff') : dates ? t('theme.seasonDates', { start: day(dates.start), end: day(dates.end) }) : t('theme.seasonNoDates')}
                </span>
              </span>
              <Button size="sm" aria-pressed={preview === id} onClick={() => toggle(id)}>
                {preview === id ? t('theme.seasonStop') : t('theme.seasonTry')}
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
