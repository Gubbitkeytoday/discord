import React, { useState } from 'react';
import { Plus, Trash2, ShieldAlert, AlertTriangle, Pencil } from 'lucide-react';
import { t } from '../../i18n/index.jsx';

const triggers = () => [
  { key: 'keyword', label: t('automod.keyword'), hint: t('automod.keywordHint') },
  { key: 'regex', label: t('automod.regex'), hint: t('automod.regexHint') },
  { key: 'link', label: t('automod.link'), hint: t('automod.linkHint') },
  { key: 'mention_spam', label: t('automod.mentionSpam'), hint: t('automod.mentionSpamHint') },
  { key: 'spam', label: t('automod.spam'), hint: t('automod.spamHint') }
];

const actionLabels = () => ({ block: t('automod.actionBlock'), alert: t('automod.actionAlert'), timeout: t('audit.MEMBER_TIMEOUT') });

/** AutoMod rules: list, create, toggle and delete. */
export default function AutoModTab({ rules, api, reload, channels, roles, onToast }) {
  const [draft, setDraft] = useState(null);
  const [busy, setBusy] = useState(false);

  const blank = (trigger) => ({
    name: triggers().find((entry) => entry.key === trigger)?.label ?? t('automod.newRule'),
    trigger_type: trigger,
    actions: ['block'],
    keywords: '',
    pattern: '',
    allowed_domains: '',
    max_mentions: 5,
    max_messages: 5,
    timeout_seconds: 300,
    exempt_roles: [],
    exempt_channels: []
  });

  /** Turn a stored rule back into the editor's flat draft shape. */
  const toDraft = (rule) => {
    const meta = rule.trigger_metadata ?? {};
    return {
      id: rule.id,
      name: rule.name,
      trigger_type: rule.trigger_type,
      actions: rule.actions ?? ['block'],
      keywords: (meta.keywords ?? []).join(', '),
      pattern: meta.pattern ?? '',
      allowed_domains: (meta.allowed_domains ?? []).join(', '),
      max_mentions: meta.max_mentions ?? 5,
      max_messages: meta.max_messages ?? 5,
      timeout_seconds: meta.timeout_seconds ?? 300,
      exempt_roles: rule.exempt_roles ?? [],
      exempt_channels: rule.exempt_channels ?? []
    };
  };

  const save = async () => {
    setBusy(true);
    try {
      const metadata = {};
      if (draft.trigger_type === 'keyword') {
        metadata.keywords = draft.keywords.split(',').map((k) => k.trim()).filter(Boolean);
      }
      if (draft.trigger_type === 'regex') metadata.pattern = draft.pattern;
      if (draft.trigger_type === 'link') {
        metadata.allowed_domains = draft.allowed_domains.split(',').map((d) => d.trim()).filter(Boolean);
      }
      if (draft.trigger_type === 'mention_spam') metadata.max_mentions = Number(draft.max_mentions);
      if (draft.trigger_type === 'spam') metadata.max_messages = Number(draft.max_messages);
      if (draft.actions.includes('timeout')) metadata.timeout_seconds = Number(draft.timeout_seconds);

      const body = JSON.stringify({
        name: draft.name,
        trigger_type: draft.trigger_type,
        trigger_metadata: metadata,
        actions: draft.actions,
        exempt_roles: draft.exempt_roles,
        exempt_channels: draft.exempt_channels
      });
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
      await api(`/automod/${rule.id}`, {
        method: 'PATCH', body: JSON.stringify({ enabled: !rule.enabled })
      });
      await reload();
    } catch (err) { onToast?.(err.message, { type: 'error' }); }
  };

  const remove = async (rule) => {
    try {
      await api(`/automod/${rule.id}`, { method: 'DELETE' });
      await reload();
    } catch (err) { onToast?.(err.message, { type: 'error' }); }
  };

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-xl font-bold text-d-strong">{t('settings.automod')}</h1>
        {!draft && (
          <button
            onClick={() => setDraft(blank('keyword'))}
            className="flex items-center gap-1 bg-d-brand hover:bg-d-brandhover text-white text-xs font-semibold px-3 py-1.5 rounded transition-colors"
          >
            <Plus className="w-3.5 h-3.5" /> {t('automod.createRule')}
          </button>
        )}
      </div>
      <p className="text-xs text-d-text3 mb-5">
        {t('automod.hint')}
        
      </p>

      {draft && (
        <div className="bg-d-surface rounded-lg p-4 mb-6 space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">{t('automod.ruleName')}</span>
              <input
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                className="w-full bg-d-base text-sm text-d-strong px-3 py-2 rounded border border-d-edge focus:outline-none focus:border-d-brand"
              />
            </label>
            <label className="block">
              <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">{t('settings.type')}</span>
              <select
                value={draft.trigger_type}
                onChange={(e) => setDraft({ ...blank(e.target.value), name: draft.name, actions: draft.actions })}
                className="w-full bg-d-base text-sm text-d-strong px-3 py-2 rounded border border-d-edge focus:outline-none"
              >
                {triggers().map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
              </select>
            </label>
          </div>

          {draft.trigger_type === 'keyword' && (
            <label className="block">
              <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">
                {t('automod.keywordsLabel')}
              </span>
              <input
                value={draft.keywords}
                onChange={(e) => setDraft({ ...draft, keywords: e.target.value })}
                placeholder={t('automod.keywordsExample')}
                className="w-full bg-d-base text-sm text-d-strong px-3 py-2 rounded border border-d-edge focus:outline-none focus:border-d-brand"
              />
            </label>
          )}

          {draft.trigger_type === 'regex' && (
            <label className="block">
              <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">{t('automod.patternLabel')}</span>
              <input
                value={draft.pattern}
                onChange={(e) => setDraft({ ...draft, pattern: e.target.value })}
                placeholder="discord\\.gg/\\w+"
                className="w-full bg-d-base text-sm font-mono text-d-strong px-3 py-2 rounded border border-d-edge focus:outline-none focus:border-d-brand"
              />
              <span className="block text-[10px] text-d-text4 mt-1">
                {t('automod.regexSafetyNote')}
              </span>
            </label>
          )}

          {draft.trigger_type === 'link' && (
            <label className="block">
              <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">
                {t('automod.allowedDomains')}
              </span>
              <input
                value={draft.allowed_domains}
                onChange={(e) => setDraft({ ...draft, allowed_domains: e.target.value })}
                placeholder="github.com, youtube.com"
                className="w-full bg-d-base text-sm text-d-strong px-3 py-2 rounded border border-d-edge focus:outline-none focus:border-d-brand"
              />
            </label>
          )}

          {draft.trigger_type === 'mention_spam' && (
            <label className="block">
              <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">
                {t('automod.maxMentions')}
              </span>
              <input
                type="number" min={1} max={50}
                value={draft.max_mentions}
                onChange={(e) => setDraft({ ...draft, max_mentions: e.target.value })}
                className="w-32 bg-d-base text-sm text-d-strong px-3 py-2 rounded border border-d-edge focus:outline-none"
              />
            </label>
          )}

          {draft.trigger_type === 'spam' && (
            <label className="block">
              <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">
                {t('automod.maxMessages')}
              </span>
              <input
                type="number" min={2} max={30}
                value={draft.max_messages}
                onChange={(e) => setDraft({ ...draft, max_messages: e.target.value })}
                className="w-32 bg-d-base text-sm text-d-strong px-3 py-2 rounded border border-d-edge focus:outline-none"
              />
            </label>
          )}

          <div>
            <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">{t('automod.actions')}</span>
            <div className="flex flex-wrap gap-2">
              {Object.entries(actionLabels()).map(([key, label]) => {
                const on = draft.actions.includes(key);
                return (
                  <button
                    key={key}
                    onClick={() => setDraft({
                      ...draft,
                      actions: on ? draft.actions.filter((a) => a !== key) : [...draft.actions, key]
                    })}
                    className={`text-xs px-2.5 py-1.5 rounded border transition-colors ${
                      on ? 'bg-d-brand border-transparent text-white'
                         : 'border-d-control text-d-text2 hover:border-d-text2'
                    }`}
                  >
                    {on ? '✓ ' : '+ '}{label}
                  </button>
                );
              })}
            </div>
          </div>

          {draft.actions.includes('timeout') && (
            <label className="block">
              <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">
                {t('automod.timeoutSeconds')}
              </span>
              <input
                type="number" min={60} max={604800}
                value={draft.timeout_seconds}
                onChange={(e) => setDraft({ ...draft, timeout_seconds: e.target.value })}
                className="w-32 bg-d-base text-sm text-d-strong px-3 py-2 rounded border border-d-edge focus:outline-none"
              />
            </label>
          )}

          <div className="grid grid-cols-2 gap-3">
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

          <div className="flex justify-end gap-2 pt-1">
            <button onClick={() => setDraft(null)} className="text-xs text-d-strong px-3 py-1.5 hover:underline">
              {t('common.cancel')}
            </button>
            <button
              onClick={save}
              disabled={busy || draft.actions.length === 0}
              className="bg-d-success hover:bg-d-successhover disabled:opacity-50 text-white text-xs font-semibold px-4 py-1.5 rounded transition-colors"
            >
              {busy ? t('common.saving') : draft.id ? t('common.saveChanges') : t('automod.createRule')}
            </button>
          </div>
        </div>
      )}

      {rules.length === 0 && !draft && (
        <div className="text-center py-10">
          <ShieldAlert className="w-10 h-10 mx-auto mb-2 text-d-control" />
          <p className="text-sm text-d-text3">{t('automod.noRules')}</p>
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
                    <span className="text-[10px] bg-d-control/40 text-d-text3 px-1.5 rounded">{t('automod.ruleOff')}</span>
                  )}
                </p>
                <p className="text-[11px] text-d-text3">
                  {triggers().find((t) => t.key === rule.trigger_type)?.label ?? rule.trigger_type}
                  {' · '}
                  {rule.actions.map((a) => actionLabels()[a] ?? a).join(', ')}
                </p>
                <Summary rule={rule} />
              </div>

              <button
                role="switch"
                aria-checked={rule.enabled}
                aria-label={t('automod.toggleRule', { name: rule.name })}
                onClick={() => toggle(rule)}
                className={`shrink-0 w-10 h-6 rounded-full relative transition-colors ${
                  rule.enabled ? 'bg-d-online' : 'bg-d-control'
                }`}
              >
                <span className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${
                  rule.enabled ? 'left-5' : 'left-1'
                }`} />
              </button>

              <button
                onClick={() => setDraft(toDraft(rule))}
                className="shrink-0 text-d-text3 hover:text-d-strong transition-colors p-1"
                aria-label={t('automod.editRule', { name: rule.name })}
              >
                <Pencil className="w-4 h-4" />
              </button>

              <button
                onClick={() => remove(rule)}
                className="shrink-0 text-d-text3 hover:text-d-danger transition-colors p-1"
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
          <AlertTriangle className="w-4 h-4 text-d-idle shrink-0 mt-0.5" />
          <p className="text-xs text-d-idle">
            {t('automod.timeoutWarning')}
          </p>
        </div>
      )}
    </div>
  );
}

function Summary({ rule }) {
  const meta = rule.trigger_metadata ?? {};
  const parts = [];
  if (meta.keywords?.length) parts.push(t('automod.words', { list: meta.keywords.slice(0, 6).join(', ') }));
  if (meta.pattern) parts.push(`regex: ${meta.pattern}`);
  if (meta.allowed_domains?.length) parts.push(t('automod.allowed', { list: meta.allowed_domains.join(', ') }));
  else if (rule.trigger_type === 'link') parts.push(t('automod.blockAllLinks'));
  if (meta.max_mentions) parts.push(t('automod.upToMentions', { count: meta.max_mentions }));
  if (meta.max_messages) parts.push(t('automod.upToMessages', { count: meta.max_messages }));
  if (rule.exempt_roles?.length) parts.push(t('automod.exemptCount', { count: rule.exempt_roles.length }));

  if (parts.length === 0) return null;
  return <p className="text-[11px] text-d-text4 mt-0.5 truncate">{parts.join(' · ')}</p>;
}

function MultiSelect({ label, options, selected, onChange }) {
  return (
    <div>
      <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">{label}</span>
      <div className="flex flex-wrap gap-1 max-h-24 overflow-y-auto">
        {options.length === 0 && <span className="text-[11px] text-d-text4">{t('automod.noOptions')}</span>}
        {options.map((option) => {
          const on = selected.includes(option.id);
          return (
            <button
              key={option.id}
              onClick={() => onChange(
                on ? selected.filter((id) => id !== option.id) : [...selected, option.id]
              )}
              className={`text-[11px] px-2 py-1 rounded border transition-colors ${
                on ? 'bg-d-active border-transparent text-d-strong'
                   : 'border-d-control text-d-text3 hover:border-d-text3'
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
