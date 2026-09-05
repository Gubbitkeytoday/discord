// ============================================================================
//  Server Settings → Insights. Counts over the real tables, drawn as an
//  inline SVG sparkline — no chart library, because one series of ~30 points
//  does not justify a dependency, and an <svg> we own scales with the theme.
//
//  The same screen carries the two moderation-adjacent settings that share its
//  audience: the public widget and raid protection.
// ============================================================================

import React, { useEffect, useMemo, useState } from 'react';
import {
  BarChart3, TrendingUp, TrendingDown, Users, MessageSquare, Mic, Loader2,
  ShieldAlert, Globe, Lock, Unlock, Copy
} from 'lucide-react';
import { get, patch, post, del } from '../../api';
import { avatarOf } from '../../utils/avatar';
import { t, localeTag } from '../../i18n/index.jsx';
import { PageHeader, Section, Note, Divider } from './primitives';

const inputClass = 'w-full bg-d-input text-d-strong rounded-md px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-d-brand';
const WINDOWS = [7, 30, 90];

function Stat({ icon: StatIcon, label, value, change }) {
  const up = typeof change === 'number' && change > 0;
  const down = typeof change === 'number' && change < 0;
  return (
    <div className="bg-d-surface/60 border border-d-edge rounded-lg p-3">
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-d-text3">
        <StatIcon className="w-3.5 h-3.5" aria-hidden="true" />{label}
      </div>
      <div className="text-2xl font-bold text-d-strong mt-1">{value}</div>
      {typeof change === 'number' && (
        <div className={`text-[11px] mt-0.5 inline-flex items-center gap-1 ${up ? 'text-d-success' : down ? 'text-d-danger' : 'text-d-text3'}`}>
          {up ? <TrendingUp className="w-3 h-3" aria-hidden="true" /> : down ? <TrendingDown className="w-3 h-3" aria-hidden="true" /> : null}
          {change > 0 ? '+' : ''}{change}%
        </div>
      )}
    </div>
  );
}

/** One series as a filled sparkline. Purely presentational, theme-aware. */
function Sparkline({ points, label }) {
  const width = 640;
  const height = 120;
  const max = Math.max(1, ...points.map((p) => p.value));
  const step = points.length > 1 ? width / (points.length - 1) : width;
  const path = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${(height - (p.value / max) * (height - 8)).toFixed(1)}`).join(' ');
  const area = `${path} L${width},${height} L0,${height} Z`;

  return (
    <figure className="mt-2">
      <figcaption className="sr-only">{label}</figcaption>
      <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-28" role="img" aria-label={label} preserveAspectRatio="none">
        <path d={area} fill="var(--color-d-brand)" opacity="0.15" />
        <path d={path} fill="none" stroke="var(--color-d-brand)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="flex justify-between text-[10px] text-d-text3 mt-1">
        <span>{points[0]?.day}</span>
        <span>{t('insights.peak', { n: max })}</span>
        <span>{points[points.length - 1]?.day}</span>
      </div>
    </figure>
  );
}

export default function InsightsTab({ server, channels = [], onToast }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [widget, setWidget] = useState(null);
  const [raid, setRaid] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!server?.id) return;
    setData(null);
    get(`/api/servers/${server.id}/insights?days=${days}`)
      .then(setData)
      .catch((err) => { setData(false); onToast?.(err.message, { type: 'error' }); });
  }, [server?.id, days]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!server?.id) return;
    get(`/api/servers/${server.id}/raid`).then(setRaid).catch(() => setRaid(null));
    setWidget({ enabled: Boolean(server.widget_enabled), channel_id: server.widget_channel_id ?? '' });
  }, [server?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const messageSeries = useMemo(
    () => (data ? data.series.map((d) => ({ day: d.day.slice(5), value: d.messages })) : []),
    [data]
  );
  const joinSeries = useMemo(
    () => (data ? data.series.map((d) => ({ day: d.day.slice(5), value: d.joins })) : []),
    [data]
  );

  const saveWidget = async (next) => {
    setWidget(next);
    try {
      await patch(`/api/servers/${server.id}/widget`, { enabled: next.enabled, channel_id: next.channel_id || null });
    } catch (err) { onToast?.(err.message, { type: 'error' }); }
  };

  const saveRaid = async (patchBody) => {
    setBusy(true);
    try {
      setRaid(await patch(`/api/servers/${server.id}/raid`, patchBody));
    } catch (err) {
      onToast?.(err.message, { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const widgetUrl = `${window.location.origin}/api/servers/${server?.id}/widget.json`;
  const textChannels = channels.filter((c) => ['text', 'announcement'].includes(c.type));

  return (
    <div>
      <PageHeader title={t('insights.title')} description={t('insights.lead')} />

      <div className="flex gap-2 mb-4" role="group" aria-label={t('insights.window')}>
        {WINDOWS.map((w) => (
          <button
            key={w}
            type="button"
            onClick={() => setDays(w)}
            aria-pressed={days === w}
            className={`text-xs font-semibold px-3 py-1.5 rounded-md ${days === w ? 'bg-d-brand text-white' : 'bg-d-surface text-d-text2 hover:text-d-strong'}`}
          >
            {t('insights.lastDays', { n: w })}
          </button>
        ))}
      </div>

      {data === null ? (
        <div className="flex justify-center py-10 text-d-text3" role="status">
          <Loader2 className="w-6 h-6 animate-spin" aria-hidden="true" />
          <span className="sr-only">{t('common.loading')}</span>
        </div>
      ) : data === false ? (
        <p className="text-sm text-d-text3">{t('insights.unavailable')}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Stat icon={Users} label={t('insights.members')} value={data.totals.members} />
            <Stat icon={Users} label={t('insights.joined')} value={data.totals.joined} change={data.change_percent.joined} />
            <Stat icon={MessageSquare} label={t('insights.messages')} value={data.totals.messages} change={data.change_percent.messages} />
            <Stat icon={Mic} label={t('insights.inVoice')} value={data.totals.in_voice_now} />
          </div>

          <Section title={t('insights.messagesPerDay')}>
            <Sparkline points={messageSeries} label={t('insights.messagesPerDay')} />
          </Section>

          <Section title={t('insights.joinsPerDay')} description={
            data.totals.retention_percent !== null
              ? t('insights.retention', { percent: data.totals.retention_percent })
              : undefined
          }>
            <Sparkline points={joinSeries} label={t('insights.joinsPerDay')} />
          </Section>

          <Divider />

          <Section title={t('insights.topChannels')}>
            {data.top_channels.length === 0 ? (
              <p className="text-sm text-d-text3">{t('insights.noData')}</p>
            ) : (
              <ol className="space-y-1">
                {data.top_channels.map((c) => (
                  <li key={c.id} className="flex items-center gap-2 text-sm">
                    <span className="text-d-text3">#</span>
                    <span className="text-d-strong truncate flex-1">{c.name}</span>
                    <span className="text-d-text3 text-xs tabular-nums">
                      {t('insights.messagesCount', { n: c.messages })} · {t('insights.authorsCount', { n: c.authors })}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </Section>

          <Section title={t('insights.topMembers')}>
            {data.top_members.length === 0 ? (
              <p className="text-sm text-d-text3">{t('insights.noData')}</p>
            ) : (
              <ol className="space-y-1">
                {data.top_members.map((m) => (
                  <li key={m.id} className="flex items-center gap-2 text-sm">
                    <img src={avatarOf(m)} alt="" className="w-5 h-5 rounded-full object-cover" />
                    <span className="text-d-strong truncate flex-1">{m.display_name || m.username}</span>
                    {m.is_bot && <span className="bg-d-brand text-white text-[9px] font-bold px-1 rounded">BOT</span>}
                    <span className="text-d-text3 text-xs tabular-nums">{t('insights.messagesCount', { n: m.messages })}</span>
                  </li>
                ))}
              </ol>
            )}
          </Section>
        </>
      )}

      <Divider />

      <Section title={t('insights.widget')} description={t('insights.widgetHint')}>
        {widget && (
          <>
            <label className="flex items-center justify-between gap-3 text-sm mb-3">
              <span className="text-d-strong inline-flex items-center gap-2">
                <Globe className="w-4 h-4 text-d-text4" aria-hidden="true" />{t('insights.widgetEnable')}
              </span>
              <input
                type="checkbox"
                checked={widget.enabled}
                onChange={(e) => saveWidget({ ...widget, enabled: e.target.checked })}
                className="w-4 h-4 accent-d-brand"
              />
            </label>
            {widget.enabled && (
              <>
                <label htmlFor="widget-channel" className="block text-[11px] font-bold uppercase tracking-wide text-d-text3 mb-1.5">
                  {t('insights.widgetChannel')}
                </label>
                <select
                  id="widget-channel"
                  value={widget.channel_id ?? ''}
                  onChange={(e) => saveWidget({ ...widget, channel_id: e.target.value })}
                  className={inputClass}
                >
                  <option value="">{t('insights.widgetNoInvite')}</option>
                  {textChannels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
                </select>
                <div className="flex items-center gap-2 mt-3">
                  <code className="text-xs bg-d-input px-2 py-1.5 rounded-md text-d-text2 break-all select-all flex-1">{widgetUrl}</code>
                  <button
                    type="button"
                    onClick={() => { navigator.clipboard?.writeText(widgetUrl); onToast?.(t('common.copied'), { type: 'success', ttl: 2000 }); }}
                    className="shrink-0 inline-flex items-center gap-1 text-xs font-semibold bg-d-surface hover:bg-d-hover text-d-strong px-3 py-1.5 rounded-md"
                  >
                    <Copy className="w-3.5 h-3.5" aria-hidden="true" />{t('dev.copy')}
                  </button>
                </div>
              </>
            )}
          </>
        )}
      </Section>

      <Divider />

      <Section title={t('insights.raid')} description={t('insights.raidHint')}>
        {raid && (
          <>
            {raid.lockdown && (
              <Note tone="danger">
                {t('insights.lockedDown', {
                  reason: raid.lockdown.reason,
                  when: new Date(raid.lockdown.started_at).toLocaleString(localeTag())
                })}
              </Note>
            )}

            <label className="flex items-center justify-between gap-3 text-sm mb-3 mt-2">
              <span className="text-d-strong inline-flex items-center gap-2">
                <ShieldAlert className="w-4 h-4 text-d-text4" aria-hidden="true" />{t('insights.raidEnable')}
              </span>
              <input
                type="checkbox"
                checked={raid.enabled}
                disabled={busy}
                onChange={(e) => saveRaid({ enabled: e.target.checked })}
                className="w-4 h-4 accent-d-brand"
              />
            </label>

            {raid.enabled && (
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label htmlFor="raid-threshold" className="block text-[11px] font-bold uppercase tracking-wide text-d-text3 mb-1.5">
                    {t('insights.raidThreshold')}
                  </label>
                  <input
                    id="raid-threshold"
                    type="number"
                    min={3}
                    max={200}
                    value={raid.join_threshold}
                    onChange={(e) => setRaid({ ...raid, join_threshold: Number(e.target.value) })}
                    onBlur={(e) => saveRaid({ join_threshold: Number(e.target.value) })}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label htmlFor="raid-window" className="block text-[11px] font-bold uppercase tracking-wide text-d-text3 mb-1.5">
                    {t('insights.raidWindow')}
                  </label>
                  <input
                    id="raid-window"
                    type="number"
                    min={10}
                    max={3600}
                    value={raid.join_window_secs}
                    onChange={(e) => setRaid({ ...raid, join_window_secs: Number(e.target.value) })}
                    onBlur={(e) => saveRaid({ join_window_secs: Number(e.target.value) })}
                    className={inputClass}
                  />
                </div>
                <div>
                  <label htmlFor="raid-action" className="block text-[11px] font-bold uppercase tracking-wide text-d-text3 mb-1.5">
                    {t('insights.raidAction')}
                  </label>
                  <select
                    id="raid-action"
                    value={raid.action}
                    onChange={(e) => saveRaid({ action: e.target.value })}
                    className={inputClass}
                  >
                    <option value="lockdown">{t('insights.raidLockdown')}</option>
                    <option value="screen">{t('insights.raidScreen')}</option>
                  </select>
                </div>
              </div>
            )}

            <div className="mt-3">
              {raid.lockdown ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    try { await del(`/api/servers/${server.id}/raid/lockdown`); setRaid(await get(`/api/servers/${server.id}/raid`)); }
                    catch (err) { onToast?.(err.message, { type: 'error' }); }
                  }}
                  className="inline-flex items-center gap-1.5 bg-d-success hover:bg-d-successhover text-white text-sm font-semibold px-3 py-2 rounded-md"
                >
                  <Unlock className="w-4 h-4" aria-hidden="true" />{t('insights.liftLockdown')}
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    try { await post(`/api/servers/${server.id}/raid/lockdown`, { reason: t('insights.manualLockdown') }); setRaid(await get(`/api/servers/${server.id}/raid`)); }
                    catch (err) { onToast?.(err.message, { type: 'error' }); }
                  }}
                  className="inline-flex items-center gap-1.5 bg-d-surface hover:bg-d-hover text-d-strong text-sm font-semibold px-3 py-2 rounded-md"
                >
                  <Lock className="w-4 h-4" aria-hidden="true" />{t('insights.startLockdown')}
                </button>
              )}
            </div>
          </>
        )}
      </Section>

      <Note>{t('insights.footnote')}</Note>
    </div>
  );
}
