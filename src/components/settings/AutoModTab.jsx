import React, { useState } from 'react';
import {
  Plus, Trash2, ShieldAlert, AlertTriangle, Pencil, ChevronDown, ChevronRight, Check,
  MessageSquareWarning, Link2, AtSign, Repeat, Ban, Languages
} from 'lucide-react';
import { t } from '../../i18n/index.jsx';
import ConfirmModal from '../ConfirmModal';

const triggers = ({ advanced = false } = {}) => [
  { key: 'keyword', label: t('automod.keyword'), hint: t('automod.keywordHint') },
  { key: 'link', label: t('automod.link'), hint: t('automod.linkHint') },
  { key: 'mention_spam', label: t('automod.mentionSpam'), hint: t('automod.mentionSpamHint') },
  { key: 'spam', label: t('automod.spam'), hint: t('automod.spamHint') },
  advanced && { key: 'regex', label: t('automod.regex'), hint: t('automod.regexHint') }
].filter(Boolean);

const actionLabels = () => ({ block: t('automod.actionBlock'), alert: t('automod.actionAlert'), timeout: t('audit.MEMBER_TIMEOUT') });

/** Server-side word lists (the words themselves never reach the browser). */
const WORD_LISTS = () => [
  { id: 'profanity_en', label: t('adm.preset.profanity_en'), hint: t('adm.preset.profanity_enHint') },
  { id: 'profanity_th', label: t('adm.preset.profanity_th'), hint: t('adm.preset.profanity_thHint') },
  { id: 'slurs', label: t('adm.preset.slurs'), hint: t('adm.preset.slursHint') },
  { id: 'sexual', label: t('adm.preset.sexual'), hint: t('adm.preset.sexualHint') },
  { id: 'spam_links', label: t('adm.preset.spam_links'), hint: t('adm.preset.spam_linksHint') },
  { id: 'invite_links', label: t('adm.preset.invite_links'), hint: t('adm.preset.invite_linksHint') }
];

/** One-click starting points shown as cards above the rule list. */
const QUICK_RULES = () => [
  { key: 'profanity', icon: MessageSquareWarning, trigger: 'keyword', presets: ['profanity_en', 'profanity_th'] },
  { key: 'slurs', icon: Ban, trigger: 'keyword', presets: ['slurs', 'sexual'] },
  { key: 'scams', icon: Link2, trigger: 'keyword', presets: ['spam_links', 'invite_links'] },
  { key: 'mentions', icon: AtSign, trigger: 'mention_spam' },
  { key: 'flood', icon: Repeat, trigger: 'spam' },
  { key: 'thai', icon: Languages, trigger: 'keyword', presets: ['profanity_th'] }
];

/** AutoMod rules: quick presets, list, create, edit, toggle and delete. */
export default function AutoModTab({ rules, api, reload, channels, roles, onToast }) {
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [advanced, setAdvanced] = useState(false);
  const textChannels = channels.filter((c) => ['text', 'announcement'].includes(c.type));

  const blank = (trigger) => ({
    name: triggers({ advanced: true }).find((entry) => entry.key === trigger)?.label ?? t('automod.newRule'),
    trigger_type: trigger,
    actions: ['block'],
    keywords: '',
    presets: [],
    allow_list: '',
    pattern: '',
    allowed_domains: '',
    max_mentions: 5,
    max_messages: 5,
    timeout_seconds: 300,
    alert_channel_id: '',
    exempt_roles: [],
    exempt_channels: []
  });

  /** Turn a stored rule back into the editor's flat draft shape. */
  const toDraft = (rule) => {
    const meta = rule.trigger_metadata ?? {};
    if (rule.trigger_type === 'regex') setAdvanced(true);
    return {
      id: rule.id,
      name: rule.name,
      trigger_type: rule.trigger_type,
      actions: rule.actions ?? ['block'],
      keywords: (meta.keywords ?? []).join(', '),
      presets: meta.presets ?? [],
      allow_list: (meta.allow_list ?? []).join(', '),
      pattern: meta.pattern ?? '',
      allowed_domains: (meta.allowed_domains ?? []).join(', '),
      max_mentions: meta.max_mentions ?? 5,
      max_messages: meta.max_messages ?? 5,
      timeout_seconds: meta.timeout_seconds ?? 300,
      alert_channel_id: meta.alert_channel_id ?? '',
      exempt_roles: rule.exempt_roles ?? [],
      exempt_channels: rule.exempt_channels ?? []
    };
  };

  const startQuick = (quick) => {
    setDraft({
      ...blank(quick.trigger),
      name: t(`adm.quick.${quick.key}`),
      presets: quick.presets ?? [],
      actions: textChannels.length ? ['block', 'alert'] : ['block'],
      alert_channel_id: textChannels[0]?.id ?? ''
    });
  };

  const split = (value) => value.split(',').map((k) => k.trim()).filter(Boolean);

  const save = async () => {
    setBusy(true);
    try {
      const metadata = {};
      if (draft.trigger_type === 'keyword') {
        metadata.keywords = split(draft.keywords);
        metadata.presets = draft.presets;
        metadata.allow_list = split(draft.allow_list);
      }
      if (draft.trigger_type === 'regex') metadata.pattern = draft.pattern;
      if (draft.trigger_type === 'link') metadata.allowed_domains = split(draft.allowed_domains);
      if (draft.trigger_type === 'mention_spam') metadata.max_mentions = Number(draft.max_mentions);
      if (draft.trigger_type === 'spam') metadata.max_messages = Number(draft.max_messages);
      if (draft.actions.includes('timeout')) metadata.timeout_seconds = Number(draft.timeout_seconds);
      if (draft.actions.includes('alert') && draft.alert_channel_id) metadata.alert_channel_id = draft.alert_channel_id;

      const body = {
        name: draft.name.trim(),
        trigger_type: draft.trigger_type,
        trigger_metadata: metadata,
        actions: draft.actions,
        exempt_roles: draft.exempt_roles,
        exempt_channels: draft.exempt_channels
      };
      // An existing rule is patched in place; only a new one is POSTed.
      if (draft.id) await api(`/automod/${draft.id}`, { method: 'PATCH', body });
      else await api('/automod', { method: 'POST', body });
      setDraft(null);
      await reload();
      onToast?.(draft.id ? t('automod.ruleSaved') : t('automod.ruleCreated'), { type: 'success', ttl: 2500 });
    } catch (err) {
      onToast?.(err.message, { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (rule) => {
    try {
      await api(`/automod/${rule.id}`, { method: 'PATCH', body: { enabled: !rule.enabled } });
      await reload();
    } catch (err) { onToast?.(err.message, { type: 'error' }); }
  };

  // Throws so the confirm dialog stays open with the reason on failure.
  const remove = async (rule) => {
    await api(`/automod/${rule.id}`, { method: 'DELETE' });
    await reload();
  };

  /**
   * What stops the draft from being saved, if anything. A rule that can never
   * match looks on but is not, so it cannot be saved.
   */
  const problem = (() => {
    if (!draft) return null;
    if (!draft.name.trim()) return t('automod.needName');
    if (draft.trigger_type === 'keyword' && draft.presets.length === 0 && split(draft.keywords).length === 0) return t('adm.needWordsOrList');
    if (draft.trigger_type === 'regex' && !draft.pattern.trim()) return t('automod.needPattern');
    if (draft.actions.length === 0) return t('automod.needAction');
    if (draft.actions.includes('alert') && !draft.alert_channel_id) return t('adm.needAlertChannel');
    return null;
  })();

  const presetsInUse = new Set(rules.flatMap((r) => r.trigger_metadata?.presets ?? []));
  const triggersInUse = new Set(rules.map((r) => r.trigger_type));
  const quickActive = (q) => (q.presets ? q.presets.every((p) => presetsInUse.has(p)) : triggersInUse.has(q.trigger));
  const field = 'w-full min-h-[40px] bg-d-base text-sm text-d-strong px-3 py-2 rounded border border-d-edge focus:outline-none focus:border-d-brand';
  const label = 'block text-[11px] font-bold text-d-text2 uppercase mb-1.5';

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-1">
        <h1 className="text-xl font-bold text-d-strong">{t('settings.automod')}</h1>
        {!draft && (
          <button
            onClick={() => setDraft(blank('keyword'))}
            className="min-h-[32px] flex items-center gap-1 bg-d-brand hover:bg-d-brandhover text-white text-xs font-semibold px-3 py-1.5 rounded transition-colors"
          >
            <Plus className="w-3.5 h-3.5" aria-hidden="true" /> {t('automod.createRule')}
          </button>
        )}
      </div>
      <p className="text-xs text-d-text2 mb-5">{t('automod.hint')} {t('adm.automodNormalised')}</p>

      {!draft && (
        <section aria-labelledby="automod-quick" className="mb-6">
          <h2 id="automod-quick" className="text-[11px] font-bold text-d-text2 uppercase mb-2">{t('adm.quickSetup')}</h2>
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {QUICK_RULES().map((q) => {
              const active = quickActive(q);
              return (
                <li key={q.key} className="bg-d-surface rounded-lg p-3 flex items-start gap-3">
                  <q.icon className="w-5 h-5 text-d-text2 shrink-0 mt-0.5" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-d-strong">{t(`adm.quick.${q.key}`)}</p>
                    <p className="text-[11px] text-d-text2">{t(`adm.quick.${q.key}Hint`)}</p>
                  </div>
                  {active ? (
                    <span className="shrink-0 text-[11px] font-semibold text-d-text flex items-center gap-1 min-h-[28px]">
                      <Check className="w-3.5 h-3.5 text-d-online" aria-hidden="true" /> {t('adm.active')}
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => startQuick(q)}
                      aria-label={t('adm.addQuickRule', { name: t(`adm.quick.${q.key}`) })}
                      className="shrink-0 min-h-[28px] text-xs font-semibold px-3 py-1 rounded bg-d-brand hover:bg-d-brandhover text-white"
                    >
                      {t('adm.add')}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {draft && (
        <div className="bg-d-surface rounded-lg p-4 mb-6 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <span className={label}>{t('automod.ruleName')}</span>
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={field} />
            </label>
            <label className="block">
              <span className={label}>{t('settings.type')}</span>
              <select
                value={draft.trigger_type}
                onChange={(e) => setDraft({ ...blank(e.target.value), name: draft.name, actions: draft.actions, alert_channel_id: draft.alert_channel_id, id: draft.id })}
                className={field}
              >
                {triggers({ advanced }).map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
              </select>
            </label>
          </div>

          {draft.trigger_type === 'keyword' && (
            <>
              <fieldset>
                <legend className={label}>{t('adm.wordLists')}</legend>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {WORD_LISTS().map((list) => {
                    const on = draft.presets.includes(list.id);
                    return (
                      <label key={list.id} className={`flex items-start gap-2 p-2 rounded border cursor-pointer ${on ? 'border-d-brand bg-d-brand/10' : 'border-d-divider'}`}>
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => setDraft({ ...draft, presets: on ? draft.presets.filter((p) => p !== list.id) : [...draft.presets, list.id] })}
                          className="mt-0.5 w-4 h-4 accent-[var(--color-d-brand)]"
                        />
                        <span className="min-w-0">
                          <span className="block text-sm text-d-strong">{list.label}</span>
                          <span className="block text-[11px] text-d-text2">{list.hint}</span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              </fieldset>
              <label className="block">
                <span className={label}>{t('automod.keywordsLabel')}</span>
                <input value={draft.keywords} onChange={(e) => setDraft({ ...draft, keywords: e.target.value })} placeholder={t('automod.keywordsExample')} className={field} />
              </label>
              <label className="block">
                <span className={label}>{t('adm.allowList')}</span>
                <input value={draft.allow_list} onChange={(e) => setDraft({ ...draft, allow_list: e.target.value })} placeholder={t('adm.allowListExample')} className={field} />
                <span className="block text-[11px] text-d-text2 mt-1">{t('adm.allowListHint')}</span>
              </label>
            </>
          )}

          {draft.trigger_type === 'regex' && (
            <label className="block">
              <span className={label}>{t('automod.patternLabel')}</span>
              <input
                value={draft.pattern}
                onChange={(e) => setDraft({ ...draft, pattern: e.target.value })}
                placeholder="discord\\.gg/\\w+"
                className={`${field} font-mono`}
              />
              <span className="block text-[11px] text-d-text2 mt-1">{t('automod.regexSafetyNote')}</span>
            </label>
          )}

          {draft.trigger_type === 'link' && (
            <label className="block">
              <span className={label}>{t('automod.allowedDomains')}</span>
              <input value={draft.allowed_domains} onChange={(e) => setDraft({ ...draft, allowed_domains: e.target.value })} placeholder="github.com, youtube.com" className={field} />
            </label>
          )}

          {draft.trigger_type === 'mention_spam' && (
            <label className="block">
              <span className={label}>{t('automod.maxMentions')}</span>
              <input type="number" min={1} max={50} value={draft.max_mentions}
                onChange={(e) => setDraft({ ...draft, max_mentions: e.target.value })}
                className="w-32 min-h-[40px] bg-d-base text-sm text-d-strong px-3 py-2 rounded border border-d-edge focus:outline-none" />
              <span className="block text-[11px] text-d-text2 mt-1">{t('adm.mentionsIncludeEveryone')}</span>
            </label>
          )}

          {draft.trigger_type === 'spam' && (
            <label className="block">
              <span className={label}>{t('automod.maxMessages')}</span>
              <input type="number" min={2} max={30} value={draft.max_messages}
                onChange={(e) => setDraft({ ...draft, max_messages: e.target.value })}
                className="w-32 min-h-[40px] bg-d-base text-sm text-d-strong px-3 py-2 rounded border border-d-edge focus:outline-none" />
            </label>
          )}

          <fieldset>
            <legend className={label}>{t('automod.actions')}</legend>
            <div className="flex flex-wrap gap-2">
              {Object.entries(actionLabels()).map(([key, text]) => {
                const on = draft.actions.includes(key);
                return (
                  <button
                    type="button"
                    key={key}
                    aria-pressed={on}
                    onClick={() => setDraft({
                      ...draft,
                      actions: on ? draft.actions.filter((a) => a !== key) : [...draft.actions, key],
                      alert_channel_id: key === 'alert' && !on && !draft.alert_channel_id ? textChannels[0]?.id ?? '' : draft.alert_channel_id
                    })}
                    className={`min-h-[32px] text-xs px-2.5 py-1.5 rounded border transition-colors ${
                      on ? 'bg-d-brand border-transparent text-white' : 'border-d-control text-d-text2 hover:border-d-text2'
                    }`}
                  >
                    {on ? '✓ ' : '+ '}{text}
                  </button>
                );
              })}
            </div>
          </fieldset>

          {draft.actions.includes('alert') && (
            <label className="block">
              <span className={label}>{t('adm.sendAlertTo')}</span>
              <select value={draft.alert_channel_id} onChange={(e) => setDraft({ ...draft, alert_channel_id: e.target.value })} className={field} required>
                <option value="">{t('adm.pickChannel')}</option>
                {textChannels.map((c) => <option key={c.id} value={c.id}>#{c.name}</option>)}
              </select>
              <span className="block text-[11px] text-d-text2 mt-1">{t('adm.sendAlertHint')}</span>
            </label>
          )}

          {draft.actions.includes('timeout') && (
            <label className="block">
              <span className={label}>{t('automod.timeoutSeconds')}</span>
              <input type="number" min={60} max={604800} value={draft.timeout_seconds}
                onChange={(e) => setDraft({ ...draft, timeout_seconds: e.target.value })}
                className="w-32 min-h-[40px] bg-d-base text-sm text-d-strong px-3 py-2 rounded border border-d-edge focus:outline-none" />
            </label>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <MultiSelect
              label={t('automod.exemptRoles')}
              options={roles.filter((r) => !r.is_everyone).map((r) => ({ id: r.id, label: r.name }))}
              selected={draft.exempt_roles}
              onChange={(exempt_roles) => setDraft({ ...draft, exempt_roles })}
            />
            <MultiSelect
              label={t('automod.exemptChannels')}
              options={channels.filter((c) => c.type !== 'category').map((c) => ({ id: c.id, label: c.name }))}
              selected={draft.exempt_channels}
              onChange={(exempt_channels) => setDraft({ ...draft, exempt_channels })}
            />
          </div>

          <button
            type="button"
            onClick={() => setAdvanced((v) => !v)}
            aria-expanded={advanced}
            className="flex items-center gap-1 text-xs text-d-text2 hover:text-d-strong"
          >
            {advanced ? <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" /> : <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />}
            {t('adm.advancedOptions')}
          </button>
          {advanced && <p className="text-[11px] text-d-text2 -mt-2">{t('adm.advancedRegexHint')}</p>}

          <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
            {problem && <span className="mr-auto text-[11px] text-d-text" role="status"><AlertTriangle className="inline w-3.5 h-3.5 text-d-idle mr-1" aria-hidden="true" />{problem}</span>}
            <button onClick={() => setDraft(null)} className="min-h-[32px] text-xs text-d-strong px-3 py-1.5 hover:underline">
              {t('common.cancel')}
            </button>
            <button
              onClick={save}
              disabled={busy || Boolean(problem)}
              className="min-h-[32px] bg-d-success hover:bg-d-successhover disabled:opacity-50 text-white text-xs font-semibold px-4 py-1.5 rounded transition-colors"
            >
              {busy ? t('common.saving') : draft.id ? t('common.saveChanges') : t('automod.createRule')}
            </button>
          </div>
        </div>
      )}

      {rules.length === 0 && !draft && (
        <div className="text-center py-6">
          <ShieldAlert className="w-10 h-10 mx-auto mb-2 text-d-control" aria-hidden="true" />
          <p className="text-sm text-d-text2">{t('automod.noRules')}</p>
        </div>
      )}

      <div className="space-y-2">
        {rules.map((rule) => (
          <div key={rule.id} className="bg-d-surface rounded-lg p-3">
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-d-strong truncate flex items-center gap-2">
                  {rule.name}
                  {!rule.enabled && (
                    <span className="text-[10px] bg-d-control/40 text-d-text px-1.5 rounded">{t('automod.ruleOff')}</span>
                  )}
                </p>
                <p className="text-[11px] text-d-text2">
                  {triggers({ advanced: true }).find((x) => x.key === rule.trigger_type)?.label ?? rule.trigger_type}
                  {' · '}
                  {rule.actions.map((a) => actionLabels()[a] ?? a).join(', ')}
                  {rule.actions.includes('alert') && rule.trigger_metadata?.alert_channel_id && (
                    <> → #{channels.find((c) => c.id === rule.trigger_metadata.alert_channel_id)?.name ?? '?'}</>
                  )}
                </p>
                <Summary rule={rule} />
              </div>

              <button
                role="switch"
                aria-checked={Boolean(rule.enabled)}
                aria-label={t('automod.toggleRule', { name: rule.name })}
                onClick={() => toggle(rule)}
                className={`shrink-0 w-10 h-6 rounded-full relative transition-colors ${rule.enabled ? 'bg-d-online' : 'bg-d-control'}`}
              >
                <span className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${rule.enabled ? 'left-5' : 'left-1'}`} />
              </button>

              <button
                onClick={() => setDraft(toDraft(rule))}
                className="shrink-0 text-d-text2 hover:text-d-strong transition-colors p-1"
                aria-label={t('automod.editRule', { name: rule.name })}
              >
                <Pencil className="w-4 h-4" />
              </button>

              <button
                onClick={() => setConfirmDelete(rule)}
                className="shrink-0 text-d-text2 hover:text-d-danger transition-colors p-1"
                aria-label={t('common.deleteNamed', { name: rule.name })}
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </div>
        ))}
      </div>

      {rules.some((r) => r.actions.includes('timeout')) && (
        <div className="flex items-start gap-2 bg-d-idle/10 border border-d-idle/40 rounded p-2.5 mt-4">
          <AlertTriangle className="w-4 h-4 text-d-idle shrink-0 mt-0.5" aria-hidden="true" />
          <p className="text-xs text-d-text">{t('automod.timeoutWarning')}</p>
        </div>
      )}

      {confirmDelete && (
        <ConfirmModal
          title={t('automod.deleteTitle', { name: confirmDelete.name })}
          body={t('automod.deleteBody')}
          confirmLabel={t('common.delete')}
          onConfirm={() => remove(confirmDelete)}
          onClose={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}

function Summary({ rule }) {
  const meta = rule.trigger_metadata ?? {};
  const parts = [];
  const listNames = WORD_LISTS().filter((l) => (meta.presets ?? []).includes(l.id)).map((l) => l.label);
  if (listNames.length) parts.push(listNames.join(', '));
  if (meta.keywords?.length) parts.push(t('automod.words', { list: meta.keywords.slice(0, 6).join(', ') }));
  if (meta.allow_list?.length) parts.push(t('adm.allowedWords', { list: meta.allow_list.slice(0, 4).join(', ') }));
  if (meta.pattern) parts.push(`regex: ${meta.pattern}`);
  if (meta.allowed_domains?.length) parts.push(t('automod.allowed', { list: meta.allowed_domains.join(', ') }));
  else if (rule.trigger_type === 'link') parts.push(t('automod.blockAllLinks'));
  if (meta.max_mentions) parts.push(t('automod.upToMentions', { count: meta.max_mentions }));
  if (meta.max_messages) parts.push(t('automod.upToMessages', { count: meta.max_messages }));
  if (rule.exempt_roles?.length) parts.push(t('automod.exemptCount', { count: rule.exempt_roles.length }));

  if (parts.length === 0) return null;
  return <p className="text-[11px] text-d-text2 mt-0.5 truncate">{parts.join(' · ')}</p>;
}

function MultiSelect({ label, options, selected, onChange }) {
  return (
    <fieldset>
      <legend className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">{label}</legend>
      <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto">
        {options.length === 0 && <span className="text-[11px] text-d-text2">{t('automod.noOptions')}</span>}
        {options.map((option) => {
          const on = selected.includes(option.id);
          return (
            <button
              type="button"
              key={option.id}
              aria-pressed={on}
              onClick={() => onChange(on ? selected.filter((id) => id !== option.id) : [...selected, option.id])}
              className={`min-h-[28px] text-[11px] px-2 py-1 rounded border transition-colors ${
                on ? 'bg-d-active border-transparent text-d-strong' : 'border-d-control text-d-text2 hover:border-d-text3'
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}
