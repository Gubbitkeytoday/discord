import React, { useEffect, useState } from 'react';
import { Trash2, Plus, Loader2 } from 'lucide-react';
import { Glyph, TAG_ICONS, BADGE_ICONS } from '../../profile/glyphs.jsx';
import { ServerTagChip } from './DisplayName';
import BadgeRow from './BadgeRow';
import {
  getServerTag, saveServerTag, deleteServerTag, getCosmeticsSettings, saveCosmeticsSettings,
  listServerBadges, createServerBadge, deleteServerBadge
} from '../../profile/api';
import { Section, SettingToggle, Field, inputClass, Divider } from '../settings/primitives';
import { t } from '../../i18n/index.jsx';

// Error messages arrive localised (api.js maps each code to apiError.<CODE>).
const errorText = (err) => err?.message ?? String(err);

/**
 * Server settings › Identity: the server tag members can wear (free, no
 * boosts), server-defined badges, "hide members' cosmetics here" and the 🌱
 * new-member window. Server-side checks decide who may change what
 * (MANAGE_GUILD); this pane only needs to be shown to those people.
 *
 * Stable API: <ServerIdentitySettings serverId serverName onToast canManage />
 */
export default function ServerIdentitySettings({ serverId, serverName = '', onToast, canManage = true }) {
  return (
    <div className="space-y-2">
      <ServerTagEditor serverId={serverId} serverName={serverName} onToast={onToast} canManage={canManage} />
      <Divider />
      <CosmeticsSettings serverId={serverId} onToast={onToast} canManage={canManage} />
      <Divider />
      <BadgesEditor serverId={serverId} onToast={onToast} canManage={canManage} />
    </div>
  );
}

function ServerTagEditor({ serverId, serverName, onToast, canManage }) {
  const [tag, setTag] = useState(null);
  const [draft, setDraft] = useState({ tag: '', icon: 'leaf', color: '#22c55e', enabled: true });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    getServerTag(serverId).then((res) => {
      setTag(res.tag);
      if (res.tag) setDraft({ tag: res.tag.tag, icon: res.tag.icon, color: res.tag.color || '#22c55e', enabled: res.tag.enabled });
    }).catch(() => {});
  }, [serverId]);

  const save = async (e) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      const res = await saveServerTag(serverId, draft);
      setTag(res.tag);
      setDraft((d) => ({ ...d, tag: res.tag.tag }));
      onToast?.(t('profiles.tagSaved'), { type: 'success', ttl: 2500 });
    } catch (err) {
      setError(errorText(err));
    } finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true);
    try { await deleteServerTag(serverId); setTag(null); setDraft({ tag: '', icon: 'leaf', color: '#22c55e', enabled: true }); }
    catch (err) { setError(errorText(err)); }
    finally { setBusy(false); }
  };

  return (
    <Section title={t('profiles.serverTagAdminTitle')} description={t('profiles.serverTagAdminLead')}>
      <form onSubmit={save} className="space-y-3">
        <div className="flex flex-wrap items-end gap-4">
          <Field label={t('profiles.tagText')} htmlFor={`tag-${serverId}`} hint={t('profiles.tagTextHint')}>
            <input id={`tag-${serverId}`} value={draft.tag} maxLength={8} disabled={!canManage}
              onChange={(e) => setDraft({ ...draft, tag: e.target.value.toUpperCase() })}
              className={`${inputClass} w-32 uppercase tracking-wider`} autoComplete="off" />
          </Field>
          <label className="flex flex-col gap-1 text-xs font-semibold text-d-text2">
            {t('profiles.tagColor')}
            <input type="color" value={draft.color} disabled={!canManage}
              onChange={(e) => setDraft({ ...draft, color: e.target.value })}
              className="h-10 w-16 cursor-pointer rounded border border-d-divider bg-transparent" />
          </label>
          <div className="pb-2">
            <ServerTagChip tag={{ ...draft, tag: draft.tag || '—', server_name: serverName }} size="lg" />
          </div>
        </div>
        <fieldset>
          <legend className="mb-1.5 text-xs font-bold uppercase tracking-wide text-d-text2">{t('profiles.tagIcon')}</legend>
          <div className="flex flex-wrap gap-1.5">
            {TAG_ICONS.map((icon) => (
              <label key={icon} title={icon}
                className={`flex h-9 w-9 cursor-pointer items-center justify-center rounded-md border has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-d-brand
                  ${draft.icon === icon ? 'border-d-brand bg-d-active text-d-strong' : 'border-d-divider text-d-text2 hover:text-d-strong'}`}>
                <input type="radio" name={`tag-icon-${serverId}`} value={icon} checked={draft.icon === icon} disabled={!canManage}
                  onChange={() => setDraft({ ...draft, icon })} className="sr-only" aria-label={icon} />
                <Glyph name={icon} className="h-4 w-4" />
              </label>
            ))}
          </div>
        </fieldset>
        <SettingToggle label={t('profiles.tagEnabled')} hint={t('profiles.tagEnabledHint')} checked={draft.enabled}
          disabled={!canManage} onChange={(v) => setDraft({ ...draft, enabled: v })} last />
        {error && <p role="alert" className="text-sm text-d-danger">{error}</p>}
        {canManage && (
          <div className="flex gap-2">
            <button type="submit" disabled={busy || !draft.tag.trim()}
              className="min-h-9 rounded bg-d-brand px-4 text-sm font-semibold text-white hover:bg-d-brandhover disabled:opacity-50">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : t('common.save')}
            </button>
            {tag && (
              <button type="button" onClick={remove} disabled={busy}
                className="min-h-9 rounded px-4 text-sm font-medium text-d-danger hover:underline">{t('profiles.removeTag')}</button>
            )}
          </div>
        )}
      </form>
    </Section>
  );
}

function CosmeticsSettings({ serverId, onToast, canManage }) {
  const [settings, setSettings] = useState(null);
  useEffect(() => { getCosmeticsSettings(serverId).then(setSettings).catch(() => {}); }, [serverId]);
  const update = async (patch) => {
    const prev = settings;
    setSettings({ ...settings, ...patch });
    try { setSettings(await saveCosmeticsSettings(serverId, patch)); }
    catch (err) { setSettings(prev); onToast?.(errorText(err), { type: 'error' }); }
  };
  if (!settings) return null;
  return (
    <Section title={t('profiles.serverCosmeticsTitle')}>
      <SettingToggle label={t('profiles.hideCosmetics')} hint={t('profiles.hideCosmeticsHint')}
        checked={settings.cosmetics_hidden} disabled={!canManage} onChange={(v) => update({ cosmetics_hidden: v })} />
      <Field label={t('profiles.newMemberDays')} htmlFor={`nm-${serverId}`} hint={t('profiles.newMemberDaysHint')}>
        <input id={`nm-${serverId}`} type="number" min="0" max="30" value={settings.new_member_badge_days}
          disabled={!canManage}
          onChange={(e) => setSettings({ ...settings, new_member_badge_days: e.target.value })}
          onBlur={(e) => update({ new_member_badge_days: Math.max(0, Math.min(30, Number(e.target.value) || 0)) })}
          className={`${inputClass} w-24`} />
      </Field>
    </Section>
  );
}

function BadgesEditor({ serverId, onToast, canManage }) {
  const [badges, setBadges] = useState([]);
  const [draft, setDraft] = useState({ name: '', description: '', icon: 'trophy', color: '#eab308' });
  const [error, setError] = useState(null);
  useEffect(() => { listServerBadges(serverId).then(setBadges).catch(() => {}); }, [serverId]);

  const create = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      const badge = await createServerBadge(serverId, draft);
      setBadges((list) => [...list, { ...badge, holders: 0 }]);
      setDraft({ ...draft, name: '', description: '' });
    } catch (err) { setError(errorText(err)); }
  };
  const remove = async (id) => {
    try { await deleteServerBadge(serverId, id); setBadges((list) => list.filter((b) => b.id !== id)); }
    catch (err) { onToast?.(errorText(err), { type: 'error' }); }
  };

  return (
    <Section title={t('profiles.serverBadgesTitle')} description={t('profiles.serverBadgesLead')}>
      {badges.length > 0 && (
        <ul className="mb-4 divide-y divide-d-divider rounded-lg border border-d-divider">
          {badges.map((b) => (
            <li key={b.id} className="flex items-center gap-3 px-3 py-2">
              <BadgeRow badges={[b]} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold text-d-strong">{b.name}</span>
                <span className="block truncate text-xs text-d-text3">
                  {t('profiles.badgeHolders', { count: b.holders ?? 0 })}{b.description ? ` · ${b.description}` : ''}
                </span>
              </span>
              {canManage && (
                <button type="button" onClick={() => remove(b.id)} aria-label={t('common.deleteNamed', { name: b.name })}
                  className="flex h-9 w-9 items-center justify-center rounded text-d-text3 hover:bg-d-hover hover:text-d-danger">
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {canManage && badges.length < 10 && (
        <form onSubmit={create} className="space-y-3 rounded-lg border border-dashed border-d-divider p-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('profiles.badgeName')} htmlFor={`bn-${serverId}`}>
              <input id={`bn-${serverId}`} value={draft.name} maxLength={32}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={inputClass} />
            </Field>
            <Field label={t('profiles.badgeDescription')} htmlFor={`bd-${serverId}`}>
              <input id={`bd-${serverId}`} value={draft.description} maxLength={120}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })} className={inputClass} />
            </Field>
          </div>
          <div className="flex flex-wrap items-center gap-1.5" role="radiogroup" aria-label={t('profiles.tagIcon')}>
            {BADGE_ICONS.map((icon) => (
              <button key={icon} type="button" role="radio" aria-checked={draft.icon === icon} aria-label={icon}
                onClick={() => setDraft({ ...draft, icon })}
                className={`flex h-9 w-9 items-center justify-center rounded-md border focus:outline-none focus-visible:ring-2 focus-visible:ring-d-brand
                  ${draft.icon === icon ? 'border-d-brand bg-d-active text-d-strong' : 'border-d-divider text-d-text2 hover:text-d-strong'}`}>
                <Glyph name={icon} className="h-4 w-4" />
              </button>
            ))}
            <input type="color" value={draft.color} aria-label={t('profiles.tagColor')}
              onChange={(e) => setDraft({ ...draft, color: e.target.value })}
              className="ml-2 h-9 w-12 cursor-pointer rounded border border-d-divider bg-transparent" />
          </div>
          {error && <p role="alert" className="text-sm text-d-danger">{error}</p>}
          <button type="submit" disabled={draft.name.trim().length < 2}
            className="flex min-h-9 items-center gap-1.5 rounded bg-d-brand px-4 text-sm font-semibold text-white hover:bg-d-brandhover disabled:opacity-50">
            <Plus className="h-4 w-4" aria-hidden="true" /> {t('profiles.createBadge')}
          </button>
        </form>
      )}
    </Section>
  );
}
