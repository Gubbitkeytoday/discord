import React, { useEffect, useState } from 'react';
import { get, put } from '../../api';
import { t } from '../../i18n/index.jsx';
import {
  SEASONS, DEFAULT_SEASON_WINDOWS, normalizeSeasonConfig, configureSeasonWindows
} from '../../theme/seasonal.js';
import { Button, inputClass } from '../settings/primitives';

const MOON = ['loykrathong', 'lunarnewyear'];

/**
 * Instance admin › Seasons: when each seasonal theme runs on this server.
 * Dates are 'MM-DD' (every year) or 'YYYY-MM-DD' (one year only); the two
 * moon-dated festivals may be left empty to use the built-in lunar table.
 * Validated here and again on the server (normalizeSeasonConfig rules).
 * Endpoints: GET/PUT /api/admin/seasonal (see the round-4 themes patch).
 */
export default function SeasonalAdminPanel({ onToast, onError }) {
  const [windows, setWindows] = useState(DEFAULT_SEASON_WINDOWS);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    get('/api/admin/seasonal')
      .then((data) => setWindows({ ...DEFAULT_SEASON_WINDOWS, ...(data?.windows ?? {}) }))
      .catch((err) => onError?.(err));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const setField = (id, patch) => setWindows((w) => ({ ...w, [id]: { ...w[id], ...patch } }));

  const save = async (next) => {
    setError('');
    let clean = null;
    if (next) {
      const body = Object.fromEntries(Object.entries(next).map(([id, w]) => [id, {
        enabled: w.enabled !== false,
        start: w.start ? String(w.start).trim() : null,
        end: w.end ? String(w.end).trim() : null
      }]));
      try { clean = normalizeSeasonConfig(body); } catch { setError(t('theme.admin.invalid')); return; }
    }
    setSaving(true);
    try {
      const saved = await put('/api/admin/seasonal', { windows: clean });
      setWindows({ ...DEFAULT_SEASON_WINDOWS, ...(saved?.windows ?? {}) });
      configureSeasonWindows(saved?.windows ?? null);
      onToast?.(t('theme.admin.saved'), { type: 'success', ttl: 2500 });
    } catch (err) {
      onError?.(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section>
      <h2 className="text-lg font-semibold text-d-strong">{t('theme.admin.title')}</h2>
      <p className="mb-4 mt-1 text-sm text-d-text2">{t('theme.admin.lead')}</p>
      <div className="space-y-3">
        {SEASONS.map((id) => {
          const w = windows[id] ?? DEFAULT_SEASON_WINDOWS[id];
          return (
            <fieldset key={id} className="rounded-lg border border-d-divider p-3">
              <legend className="px-1 text-sm font-semibold text-d-strong">{t(`theme.season.${id}`)}</legend>
              <div className="flex flex-wrap items-end gap-3">
                <label className="flex min-h-8 items-center gap-2 text-sm text-d-text">
                  <input
                    type="checkbox"
                    checked={w.enabled !== false}
                    onChange={(e) => setField(id, { enabled: e.target.checked })}
                    className="h-4 w-4"
                  />
                  {t('theme.admin.enabled')}
                </label>
                {['start', 'end'].map((key) => (
                  <label key={key} className="text-xs font-semibold text-d-text2">
                    {t(`theme.admin.${key}`)}
                    <input
                      value={w[key] ?? ''}
                      onChange={(e) => setField(id, { [key]: e.target.value })}
                      placeholder={MOON.includes(id) ? t('theme.admin.moonPlaceholder') : 'MM-DD'}
                      maxLength={10}
                      className={`${inputClass} mt-1 !w-36 font-mono`}
                    />
                  </label>
                ))}
              </div>
            </fieldset>
          );
        })}
      </div>
      <p className="mt-3 text-xs text-d-text3">{t('theme.admin.formatHint')}</p>
      {error && <p role="alert" className="mt-2 text-sm text-d-dangertext">{error}</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button variant="primary" disabled={saving} onClick={() => save(windows)}>{t('common.saveChanges')}</Button>
        <Button disabled={saving} onClick={() => save(null)}>{t('theme.admin.reset')}</Button>
      </div>
    </section>
  );
}
