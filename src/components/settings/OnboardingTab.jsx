// ============================================================================
//  Server Settings → Onboarding. Three sections, each saved on its own:
//    1. Membership screening — rules a newcomer must accept.
//    2. Welcome screen — description + up to five highlighted channels.
//    3. Onboarding questions — prompts whose options grant channels/roles.
//  Prompts are saved as a whole set (PUT), the same idempotent pattern as poll
//  votes, so the editor can be freely rearranged before one save.
// ============================================================================

import React, { useEffect, useState } from 'react';
import { Plus, Trash2, GripVertical, Loader2, Check, ShieldCheck, Hand, ListChecks } from 'lucide-react';
import { get, patch, put } from '../../api';
import { t } from '../../i18n/index.jsx';

const input = 'w-full bg-d-input text-d-strong rounded-md px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-d-brand';
const label = 'block text-[11px] font-bold uppercase tracking-wide text-d-text3 mb-1.5';

function SectionCard({ icon, title, hint, children, action }) {
  const Icon = icon;
  return (
    <section className="bg-d-surface/50 border border-d-edge rounded-lg p-4 mb-4">
      <header className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-start gap-2 min-w-0">
          {Icon && <Icon className="w-5 h-5 text-d-text4 shrink-0 mt-0.5" aria-hidden="true" />}
          <div className="min-w-0">
            <h3 className="font-bold text-d-strong">{title}</h3>
            {hint && <p className="text-xs text-d-text3 mt-0.5">{hint}</p>}
          </div>
        </div>
        {action}
      </header>
      {children}
    </section>
  );
}

function SaveButton({ busy, dirty, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || !dirty}
      className="inline-flex items-center gap-1.5 bg-d-brand hover:bg-d-brand-hover disabled:opacity-50 text-white text-xs font-semibold px-3 py-1.5 rounded-md shrink-0"
    >
      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <Check className="w-3.5 h-3.5" aria-hidden="true" />}
      {t('common.save')}
    </button>
  );
}

export default function OnboardingTab({ server, channels = [], roles = [], onToast }) {
  const [bundle, setBundle] = useState(null);
  const [rules, setRules] = useState([]);
  const [screeningOn, setScreeningOn] = useState(false);
  const [welcome, setWelcome] = useState({ enabled: false, description: '', channels: [] });
  const [prompts, setPrompts] = useState([]);
  const [busy, setBusy] = useState(null);   // 'screening' | 'welcome' | 'prompts'

  const pickable = channels.filter((c) => !['category', 'thread'].includes(c.type));
  const grantable = roles.filter((r) => r.id !== server?.id && !r.managed);

  useEffect(() => {
    if (!server?.id) return;
    get(`/api/servers/${server.id}/onboarding`).then((b) => {
      setBundle(b);
      setRules(b.screening.rules);
      setScreeningOn(b.screening.enabled);
      setWelcome({ enabled: b.welcome.enabled, description: b.welcome.description, channels: b.welcome.channels.map((c) => ({ channel_id: c.channel_id, description: c.description, emoji: c.emoji ?? '' })) });
      setPrompts(b.prompts.map((p) => ({ ...p, options: p.options.map((o) => ({ ...o })) })));
    }).catch((err) => onToast?.(err.message, { type: 'error' }));
  }, [server?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (key, fn) => {
    setBusy(key);
    try {
      const next = await fn();
      setBundle(next);
      onToast?.(t('onboarding.saved'), { type: 'success', ttl: 2000 });
    } catch (err) {
      onToast?.(err.message, { type: 'error' });
    } finally {
      setBusy(null);
    }
  };

  if (!bundle) {
    return <div className="flex justify-center py-12 text-d-text3" role="status"><Loader2 className="w-6 h-6 animate-spin" aria-hidden="true" /><span className="sr-only">{t('common.loading')}</span></div>;
  }

  const rulesDirty = JSON.stringify(rules) !== JSON.stringify(bundle.screening.rules) || screeningOn !== bundle.screening.enabled;
  const welcomeDirty = JSON.stringify(welcome) !== JSON.stringify({ enabled: bundle.welcome.enabled, description: bundle.welcome.description, channels: bundle.welcome.channels.map((c) => ({ channel_id: c.channel_id, description: c.description, emoji: c.emoji ?? '' })) });
  const promptsDirty = JSON.stringify(prompts) !== JSON.stringify(bundle.prompts.map((p) => ({ ...p, options: p.options.map((o) => ({ ...o })) })));

  /* ---- prompt editor helpers ---- */
  const updatePrompt = (i, patchBody) => setPrompts((ps) => ps.map((p, j) => (j === i ? { ...p, ...patchBody } : p)));
  const updateOption = (i, k, patchBody) => setPrompts((ps) => ps.map((p, j) => (j === i
    ? { ...p, options: p.options.map((o, m) => (m === k ? { ...o, ...patchBody } : o)) } : p)));
  const toggleIn = (arr, id) => (arr.includes(id) ? arr.filter((x) => x !== id) : [...arr, id]);

  return (
    <div>
      <h2 className="text-xl font-bold text-d-strong mb-1">{t('onboarding.title')}</h2>
      <p className="text-sm text-d-text2 mb-5">{t('onboarding.lead')}</p>

      {/* 1. screening */}
      <SectionCard
        icon={ShieldCheck}
        title={t('onboarding.screening')}
        hint={t('onboarding.screeningHint')}
        action={<SaveButton busy={busy === 'screening'} dirty={rulesDirty}
          onClick={() => run('screening', () => patch(`/api/servers/${server.id}/onboarding/screening`, { enabled: screeningOn, rules }))} />}
      >
        <label className="flex items-center justify-between gap-3 text-sm mb-3">
          <span className="text-d-strong">{t('onboarding.requireRules')}</span>
          <input type="checkbox" checked={screeningOn} onChange={(e) => setScreeningOn(e.target.checked)} className="w-4 h-4 accent-d-brand" />
        </label>
        <ul className="space-y-2">
          {rules.map((rule, i) => (
            <li key={i} className="flex items-start gap-2">
              <span className="text-xs text-d-text3 w-5 pt-2.5 text-right">{i + 1}.</span>
              <textarea
                value={rule}
                onChange={(e) => setRules(rules.map((r, j) => (j === i ? e.target.value.slice(0, 300) : r)))}
                rows={1}
                aria-label={t('onboarding.ruleN', { n: i + 1 })}
                className={`${input} resize-y min-h-[2.4rem]`}
              />
              <button type="button" onClick={() => setRules(rules.filter((_, j) => j !== i))} className="text-d-text3 hover:text-d-danger p-2" aria-label={t('onboarding.removeRule', { n: i + 1 })}>
                <Trash2 className="w-4 h-4" />
              </button>
            </li>
          ))}
        </ul>
        {rules.length < 10 && (
          <button type="button" onClick={() => setRules([...rules, ''])} className="mt-2 inline-flex items-center gap-1 text-xs text-d-text2 hover:text-d-strong">
            <Plus className="w-3.5 h-3.5" aria-hidden="true" />{t('onboarding.addRule')}
          </button>
        )}
      </SectionCard>

      {/* 2. welcome */}
      <SectionCard
        icon={Hand}
        title={t('onboarding.welcome')}
        hint={t('onboarding.welcomeHint')}
        action={<SaveButton busy={busy === 'welcome'} dirty={welcomeDirty}
          onClick={() => run('welcome', () => patch(`/api/servers/${server.id}/onboarding/welcome`, {
            enabled: welcome.enabled, description: welcome.description,
            channels: welcome.channels.map((c) => ({ ...c, emoji: c.emoji || null }))
          }))} />}
      >
        <label className="flex items-center justify-between gap-3 text-sm mb-3">
          <span className="text-d-strong">{t('onboarding.showWelcome')}</span>
          <input type="checkbox" checked={welcome.enabled} onChange={(e) => setWelcome({ ...welcome, enabled: e.target.checked })} className="w-4 h-4 accent-d-brand" />
        </label>
        <label htmlFor="onb-welcome-desc" className={label}>{t('onboarding.welcomeDescription')}</label>
        <textarea
          id="onb-welcome-desc"
          value={welcome.description}
          onChange={(e) => setWelcome({ ...welcome, description: e.target.value.slice(0, 140) })}
          rows={2}
          placeholder={t('onboarding.welcomeDescriptionPlaceholder')}
          className={`${input} resize-none`}
        />
        <div className="text-right text-[11px] text-d-text3 mt-1 mb-3">{welcome.description.length}/140</div>

        <span className={label}>{t('onboarding.welcomeChannels')} ({welcome.channels.length}/5)</span>
        <ul className="space-y-2">
          {welcome.channels.map((entry, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2 bg-d-canvas/60 rounded-md p-2">
              <input value={entry.emoji} onChange={(e) => setWelcome({ ...welcome, channels: welcome.channels.map((c, j) => (j === i ? { ...c, emoji: e.target.value.slice(0, 8) } : c)) })}
                placeholder="👋" aria-label={t('forum.tagEmoji')} className="w-12 bg-d-input text-d-strong rounded px-2 py-1.5 text-sm text-center outline-none focus:ring-2 focus:ring-d-brand" />
              <select value={entry.channel_id} onChange={(e) => setWelcome({ ...welcome, channels: welcome.channels.map((c, j) => (j === i ? { ...c, channel_id: e.target.value } : c)) })}
                aria-label={t('onboarding.channel')} className="bg-d-input text-d-strong rounded px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-d-brand min-w-[9rem]">
                {pickable.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
              </select>
              <input value={entry.description} onChange={(e) => setWelcome({ ...welcome, channels: welcome.channels.map((c, j) => (j === i ? { ...c, description: e.target.value.slice(0, 100) } : c)) })}
                placeholder={t('onboarding.channelDescriptionPlaceholder')} aria-label={t('onboarding.channelDescription')}
                className="flex-1 min-w-[10rem] bg-d-input text-d-strong rounded px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-d-brand" />
              <button type="button" onClick={() => setWelcome({ ...welcome, channels: welcome.channels.filter((_, j) => j !== i) })} className="text-d-text3 hover:text-d-danger p-1.5" aria-label={t('common.delete')}>
                <Trash2 className="w-4 h-4" />
              </button>
            </li>
          ))}
        </ul>
        {welcome.channels.length < 5 && pickable.length > 0 && (
          <button type="button" onClick={() => setWelcome({ ...welcome, channels: [...welcome.channels, { channel_id: pickable[0].id, description: '', emoji: '' }] })}
            className="mt-2 inline-flex items-center gap-1 text-xs text-d-text2 hover:text-d-strong">
            <Plus className="w-3.5 h-3.5" aria-hidden="true" />{t('onboarding.addWelcomeChannel')}
          </button>
        )}
      </SectionCard>

      {/* 3. prompts */}
      <SectionCard
        icon={ListChecks}
        title={t('onboarding.prompts')}
        hint={t('onboarding.promptsHint')}
        action={<SaveButton busy={busy === 'prompts'} dirty={promptsDirty}
          onClick={() => run('prompts', () => put(`/api/servers/${server.id}/onboarding/prompts`, { prompts }))} />}
      >
        <div className="space-y-3">
          {prompts.map((p, i) => (
            <div key={p.id ?? i} className="bg-d-canvas/60 rounded-md p-3 border border-d-edge">
              <div className="flex items-center gap-2 mb-2">
                <GripVertical className="w-4 h-4 text-d-text4 shrink-0" aria-hidden="true" />
                <input value={p.title} onChange={(e) => updatePrompt(i, { title: e.target.value.slice(0, 100) })}
                  placeholder={t('onboarding.promptTitlePlaceholder')} aria-label={t('onboarding.promptTitle')}
                  className="flex-1 bg-d-input text-d-strong rounded px-2 py-1.5 text-sm font-semibold outline-none focus:ring-2 focus:ring-d-brand" />
                <button type="button" onClick={() => setPrompts(prompts.filter((_, j) => j !== i))} className="text-d-text3 hover:text-d-danger p-1.5" aria-label={t('onboarding.removePrompt')}>
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
              <div className="flex flex-wrap gap-4 text-xs text-d-text2 mb-2 pl-6">
                <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={p.single_select} onChange={(e) => updatePrompt(i, { single_select: e.target.checked })} className="accent-d-brand" aria-label={t('onboarding.singleSelect')} />{t('onboarding.singleSelect')}</label>
                <label className="inline-flex items-center gap-1.5"><input type="checkbox" checked={p.required} onChange={(e) => updatePrompt(i, { required: e.target.checked })} className="accent-d-brand" aria-label={t('onboarding.required')} />{t('onboarding.required')}</label>
              </div>
              <ul className="space-y-2 pl-6">
                {p.options.map((o, k) => (
                  <li key={o.id ?? k} className="bg-d-surface/70 rounded p-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <input value={o.emoji ?? ''} onChange={(e) => updateOption(i, k, { emoji: e.target.value.slice(0, 8) })} placeholder="🎮" aria-label={t('forum.tagEmoji')}
                        className="w-12 bg-d-input text-d-strong rounded px-2 py-1 text-sm text-center outline-none focus:ring-2 focus:ring-d-brand" />
                      <input value={o.title} onChange={(e) => updateOption(i, k, { title: e.target.value.slice(0, 50) })} placeholder={t('onboarding.optionTitlePlaceholder')} aria-label={t('onboarding.optionTitle')}
                        className="flex-1 min-w-[8rem] bg-d-input text-d-strong rounded px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-d-brand" />
                      <input value={o.description ?? ''} onChange={(e) => updateOption(i, k, { description: e.target.value.slice(0, 100) })} placeholder={t('onboarding.optionDescriptionPlaceholder')} aria-label={t('onboarding.optionDescription')}
                        className="flex-1 min-w-[8rem] bg-d-input text-d-strong rounded px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-d-brand" />
                      <button type="button" onClick={() => updatePrompt(i, { options: p.options.filter((_, m) => m !== k) })} className="text-d-text3 hover:text-d-danger p-1" aria-label={t('onboarding.removeOption')}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
                      <fieldset className="min-w-0">
                        <legend className="text-[10px] uppercase tracking-wide text-d-text3 mb-1">{t('onboarding.grantsChannels')}</legend>
                        <div className="flex flex-wrap gap-1">
                          {pickable.map((c) => (
                            <label key={c.id} className={`text-[11px] px-1.5 py-0.5 rounded border cursor-pointer ${o.channel_ids.includes(c.id) ? 'bg-d-brand/20 border-d-brand text-d-strong' : 'border-d-edge text-d-text3'}`}>
                              <input type="checkbox" className="sr-only" checked={o.channel_ids.includes(c.id)} onChange={() => updateOption(i, k, { channel_ids: toggleIn(o.channel_ids, c.id) })} />
                              #{c.name}
                            </label>
                          ))}
                        </div>
                      </fieldset>
                      {grantable.length > 0 && (
                        <fieldset className="min-w-0">
                          <legend className="text-[10px] uppercase tracking-wide text-d-text3 mb-1">{t('onboarding.grantsRoles')}</legend>
                          <div className="flex flex-wrap gap-1">
                            {grantable.map((r) => (
                              <label key={r.id} className={`text-[11px] px-1.5 py-0.5 rounded border cursor-pointer ${o.role_ids.includes(r.id) ? 'bg-d-brand/20 border-d-brand text-d-strong' : 'border-d-edge text-d-text3'}`}>
                                <input type="checkbox" className="sr-only" checked={o.role_ids.includes(r.id)} onChange={() => updateOption(i, k, { role_ids: toggleIn(o.role_ids, r.id) })} />
                                @{r.name}
                              </label>
                            ))}
                          </div>
                        </fieldset>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
              {p.options.length < 12 && (
                <button type="button" onClick={() => updatePrompt(i, { options: [...p.options, { title: '', description: '', emoji: '', channel_ids: [], role_ids: [] }] })}
                  className="mt-2 ml-6 inline-flex items-center gap-1 text-xs text-d-text2 hover:text-d-strong">
                  <Plus className="w-3.5 h-3.5" aria-hidden="true" />{t('onboarding.addOption')}
                </button>
              )}
            </div>
          ))}
        </div>
        {prompts.length < 7 && (
          <button type="button" onClick={() => setPrompts([...prompts, { title: '', single_select: false, required: false, options: [{ title: '', description: '', emoji: '', channel_ids: [], role_ids: [] }] }])}
            className="mt-3 inline-flex items-center gap-1 text-xs text-d-text2 hover:text-d-strong">
            <Plus className="w-3.5 h-3.5" aria-hidden="true" />{t('onboarding.addPrompt')}
          </button>
        )}
      </SectionCard>
    </div>
  );
}
