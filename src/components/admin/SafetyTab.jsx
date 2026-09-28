// ============================================================================
//  Server Settings → Safety setup. Everything a moderator reaches for during a
//  raid, in one place (Discord's "Safety Setup"): the lock switch with an
//  honest status line, raid protection and where its alerts go, the
//  verification level, and one-click AutoMod protection.
// ============================================================================

import React, { useEffect, useState } from 'react';
import { ShieldAlert, Lock, Unlock, Bell, UserCheck, Loader2, ShieldCheck, Users } from 'lucide-react';
import { get, patch, post, del } from '../../api';
import { t, formatRelative } from '../../i18n/index.jsx';

const inputClass = 'w-full min-h-[40px] bg-d-input text-d-strong rounded-md px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-d-brand';
const labelClass = 'block text-[11px] font-bold uppercase tracking-wide text-d-text2 mb-1.5';

/** The rules the "Basic protection" button creates, all Block + Alert. */
const BASIC_RULES = (alertChannelId) => [
  { name: t('adm.presetRuleSpam'), trigger_type: 'spam', trigger_metadata: { max_messages: 5 } },
  { name: t('adm.presetRuleMentions'), trigger_type: 'mention_spam', trigger_metadata: { max_mentions: 5 } },
  { name: t('adm.presetRuleLinks'), trigger_type: 'keyword', trigger_metadata: { presets: ['spam_links', 'invite_links'] } }
].map((rule) => ({
  ...rule,
  actions: alertChannelId ? ['block', 'alert'] : ['block'],
  trigger_metadata: { ...rule.trigger_metadata, ...(alertChannelId ? { alert_channel_id: alertChannelId } : {}) }
}));

export default function SafetyTab({ server, channels = [], onToast, onServerUpdated, onOpenAutoMod }) {
  const [raid, setRaid] = useState(null);
  const [busy, setBusy] = useState(false);
  const textChannels = channels.filter((c) => ['text', 'announcement'].includes(c.type));

  const reload = async () => {
    try { setRaid(await get(`/api/servers/${server.id}/raid`)); } catch (err) { onToast?.(err.message, { type: 'error' }); }
  };
  useEffect(() => { reload(); }, [server.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveRaid = async (body) => {
    setBusy(true);
    try { setRaid(await patch(`/api/servers/${server.id}/raid`, body)); }
    catch (err) { onToast?.(err.message, { type: 'error' }); }
    finally { setBusy(false); }
  };

  const lock = async () => {
    setBusy(true);
    try { await post(`/api/servers/${server.id}/raid/lockdown`, { reason: t('insights.manualLockdown') }); await reload(); }
    catch (err) { onToast?.(err.message, { type: 'error' }); }
    finally { setBusy(false); }
  };
  const unlock = async () => {
    setBusy(true);
    try { await del(`/api/servers/${server.id}/raid/lockdown`); await reload(); }
    catch (err) { onToast?.(err.message, { type: 'error' }); }
    finally { setBusy(false); }
  };

  const setVerification = async (level) => {
    setBusy(true);
    try {
      const updated = await patch(`/api/servers/${server.id}`, { verification_level: level });
      onServerUpdated?.(updated);
      setRaid((r) => ({ ...r, verification_level: level }));
    } catch (err) { onToast?.(err.message, { type: 'error' }); }
    finally { setBusy(false); }
  };

  const addBasicProtection = async () => {
    setBusy(true);
    try {
      for (const rule of BASIC_RULES(raid?.effective_alert_channel_id)) {
        await post(`/api/servers/${server.id}/automod`, rule);
      }
      onToast?.(t('adm.basicProtectionOn'), { type: 'success', ttl: 3000 });
    } catch (err) { onToast?.(err.message, { type: 'error' }); }
    finally { setBusy(false); }
  };

  if (!raid) {
    return (
      <div className="flex justify-center py-10 text-d-text3" role="status">
        <Loader2 className="w-6 h-6 animate-spin" aria-hidden="true" />
        <span className="sr-only">{t('common.loading')}</span>
      </div>
    );
  }

  const locked = Boolean(raid.lockdown);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-bold text-d-strong">{t('adm.safetySetup')}</h1>
        <p className="text-sm text-d-text2 mt-1">{t('adm.safetyLead')}</p>
      </div>

      {/* The emergency switch comes first, with its real state spelled out. */}
      <section
        aria-labelledby="safety-lock"
        className={`rounded-lg p-4 border ${locked ? 'bg-d-danger/10 border-d-danger/60' : 'bg-d-surface border-d-divider'}`}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="safety-lock" className="text-base font-bold text-d-strong flex items-center gap-2">
              {locked ? <Lock className="w-5 h-5 text-d-danger" aria-hidden="true" /> : <Unlock className="w-5 h-5 text-d-text2" aria-hidden="true" />}
              {locked ? t('adm.lockedTitle') : t('adm.unlockedTitle')}
            </h2>
            <p className="text-sm text-d-text mt-1" role="status" aria-live="polite">
              {locked
                ? t('adm.lockedStatus', { when: formatRelative(raid.lockdown.started_at), count: Number(raid.lockdown.joins) || 0 })
                : t('adm.unlockedStatus')}
            </p>
            <p className="text-xs text-d-text2 mt-1 flex items-center gap-1">
              <Users className="w-3.5 h-3.5" aria-hidden="true" /> {t('adm.joinsLast10', { count: raid.joins_last_10_min ?? 0 })}
            </p>
          </div>
          {locked ? (
            <button type="button" disabled={busy} onClick={unlock}
              className="min-h-[40px] inline-flex items-center gap-1.5 bg-d-success hover:bg-d-successhover text-white text-sm font-semibold px-4 py-2 rounded-md disabled:opacity-50">
              <Unlock className="w-4 h-4" aria-hidden="true" />{t('insights.liftLockdown')}
            </button>
          ) : (
            <button type="button" disabled={busy} onClick={lock}
              className="min-h-[40px] inline-flex items-center gap-1.5 bg-d-danger hover:bg-d-dangerhover text-white text-sm font-semibold px-4 py-2 rounded-md disabled:opacity-50">
              <Lock className="w-4 h-4" aria-hidden="true" />{t('insights.startLockdown')}
            </button>
          )}
        </div>
      </section>

      <section aria-labelledby="safety-raid" className="bg-d-surface rounded-lg p-4 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id="safety-raid" className="text-base font-bold text-d-strong flex items-center gap-2">
              <ShieldAlert className="w-5 h-5 text-d-text2" aria-hidden="true" /> {t('insights.raid')}
            </h2>
            <p className="text-xs text-d-text2 mt-1">{t('adm.raidExplainer')}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={Boolean(raid.enabled)}
            aria-label={t('insights.raidEnable')}
            disabled={busy}
            onClick={() => saveRaid({ enabled: !raid.enabled })}
            className={`w-11 h-6 rounded-full relative transition-colors shrink-0 ${raid.enabled ? 'bg-d-brand' : 'bg-d-text4'}`}
          >
            <span className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${raid.enabled ? 'left-6' : 'left-1'}`} />
          </button>
        </div>

        {Boolean(raid.enabled) && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label htmlFor="raid-threshold" className={labelClass}>{t('insights.raidThreshold')}</label>
              <input id="raid-threshold" type="number" min={3} max={200} value={raid.join_threshold}
                onChange={(e) => setRaid({ ...raid, join_threshold: Number(e.target.value) })}
                onBlur={(e) => saveRaid({ join_threshold: Number(e.target.value) })}
                className={inputClass} />
            </div>
            <div>
              <label htmlFor="raid-window" className={labelClass}>{t('insights.raidWindow')}</label>
              <input id="raid-window" type="number" min={10} max={3600} value={raid.join_window_secs}
                onChange={(e) => setRaid({ ...raid, join_window_secs: Number(e.target.value) })}
                onBlur={(e) => saveRaid({ join_window_secs: Number(e.target.value) })}
                className={inputClass} />
            </div>
            <div>
              <label htmlFor="raid-action" className={labelClass}>{t('insights.raidAction')}</label>
              <select id="raid-action" value={raid.action} onChange={(e) => saveRaid({ action: e.target.value })} className={inputClass}>
                <option value="screen">{t('insights.raidScreen')}</option>
                <option value="lockdown">{t('insights.raidLockdown')}</option>
              </select>
            </div>
          </div>
        )}

        <div>
          <label htmlFor="alert-channel" className={`${labelClass} flex items-center gap-1`}>
            <Bell className="w-3.5 h-3.5" aria-hidden="true" /> {t('adm.alertChannel')}
          </label>
          <select
            id="alert-channel"
            value={raid.alert_channel_id ?? ''}
            onChange={(e) => saveRaid({ alert_channel_id: e.target.value || null })}
            className={inputClass}
            aria-describedby="alert-channel-hint"
          >
            <option value="">{t('adm.alertChannelDefault')}</option>
            {textChannels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
          </select>
          <p id="alert-channel-hint" className="text-[11px] text-d-text2 mt-1">{t('adm.alertChannelHint')}</p>
        </div>
      </section>

      <section aria-labelledby="safety-verify" className="bg-d-surface rounded-lg p-4">
        <h2 id="safety-verify" className="text-base font-bold text-d-strong flex items-center gap-2 mb-3">
          <UserCheck className="w-5 h-5 text-d-text2" aria-hidden="true" /> {t('settings.verificationLevel')}
        </h2>
        <div role="radiogroup" aria-labelledby="safety-verify" className="space-y-1.5">
          {[0, 1, 2, 3, 4].map((level) => (
            <label key={level} className="flex items-start gap-2 cursor-pointer min-h-[32px] py-1">
              <input
                type="radio"
                name="verification"
                checked={Number(raid.verification_level) === level}
                disabled={busy}
                onChange={() => setVerification(level)}
                className="mt-0.5 w-4 h-4 accent-[var(--color-d-brand)]"
              />
              <span className="text-sm text-d-text">{t(`settings.verify${level}`)}</span>
            </label>
          ))}
        </div>
        <p className="text-[11px] text-d-text2 mt-2">{t('settings.verifyHint')}</p>
      </section>

      <section aria-labelledby="safety-automod" className="bg-d-surface rounded-lg p-4">
        <h2 id="safety-automod" className="text-base font-bold text-d-strong flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-d-text2" aria-hidden="true" /> {t('adm.basicProtection')}
        </h2>
        <p className="text-xs text-d-text2 mt-1 mb-3">{t('adm.basicProtectionHint')}</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={addBasicProtection}
            className="min-h-[36px] bg-d-brand hover:bg-d-brandhover text-white text-sm font-semibold px-3 py-2 rounded-md disabled:opacity-50">
            {t('adm.turnOnBasicProtection')}
          </button>
          {onOpenAutoMod && (
            <button type="button" onClick={onOpenAutoMod}
              className="min-h-[36px] bg-d-canvas hover:bg-d-hover text-d-strong text-sm font-semibold px-3 py-2 rounded-md border border-d-divider">
              {t('adm.openAutoMod')}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
