import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, X, Minus, ShieldCheck, Folder, RefreshCw, Link2, Eye, MessageSquare, Lock, Users } from 'lucide-react';

import { PERMISSION_BITS, channelScopedGroups } from '../../utils/permissionCatalog';
import { t } from '../../i18n/index.jsx';
import { get as httpGet, put as httpPut, del as httpDel, post as httpPost } from '../../api';
import ConfirmModal from '../ConfirmModal';
import { UnsavedBar, useReportDirty } from './primitives';

const MODE_KEY = 'channel-perms-mode';
const bit = (name) => 1n << BigInt(PERMISSION_BITS[name]);
const VIEW = bit('VIEW_CHANNEL');
const SEND = bit('SEND_MESSAGES');
const isVoiceType = (type) => type === 'voice' || type === 'stage';

function readMode() {
  try { return localStorage.getItem(MODE_KEY) === 'advanced' ? 'advanced' : 'simple'; } catch { return 'simple'; }
}

/**
 * Per-channel (and per-category) permission overwrites.
 *
 * Simple mode answers the two questions most people have — who can see this
 * channel, and who can post in it — with role chips. Advanced mode is
 * Discord's tri-state matrix: Allow (✓) · Inherit (–) · Deny (✕), where
 * "Inherit" means the bit is in neither mask so the role's server-wide setting
 * decides. Only permissions that mean something per channel are listed.
 *
 * `fixedChannel` locks the editor to one channel (Channel Settings → Permissions).
 */
export default function ChannelPermissionsTab({
  channels, roles, members = [], onToast, onDirtyChange, nudge = 0, fixedChannel = null
}) {
  const [channelId, setChannelId] = useState(fixedChannel?.id ?? '');
  const [targetKey, setTargetKey] = useState('');   // "role:<id>" or "member:<id>"
  const [overwrites, setOverwrites] = useState([]);
  const [draft, setDraft] = useState({ allow: 0n, deny: 0n });
  const [busy, setBusy] = useState(false);
  const [localNudge, setLocalNudge] = useState(0);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [mode, setModeState] = useState(readMode);
  const [categories, setCategories] = useState([]);
  const [syncInfo, setSyncInfo] = useState(null);   // { parent, synced }

  const everyoneId = roles.find((r) => r.is_everyone)?.id ?? null;   // === server id

  // Categories are not in the channel list the shell keeps; fetch them so a
  // whole category can be edited at once (and its channels kept in sync).
  const refreshDetail = useCallback(async () => {
    if (!everyoneId) return;
    try {
      const detail = await httpGet(`/api/servers/${everyoneId}`);
      setCategories(Array.isArray(detail?.categories) ? detail.categories : []);
      const current = (detail?.channels ?? []).find((c) => c.id === (fixedChannel?.id ?? channelId));
      if (current?.parent_id) {
        const parent = (detail.categories ?? []).find((c) => c.id === current.parent_id);
        setSyncInfo(parent ? { parent, synced: Boolean(current.permissions_synced) } : null);
      } else {
        setSyncInfo(null);
      }
    } catch { /* optional */ }
  }, [everyoneId, fixedChannel?.id, channelId]);
  useEffect(() => { refreshDetail(); }, [refreshDetail]);

  const selectable = useMemo(() => {
    const plain = channels.filter((c) => c.type !== 'category' && c.type !== 'thread');
    const cats = categories.map((c) => ({ ...c, type: 'category' }));
    return [...cats, ...plain];
  }, [channels, categories]);

  const channel = fixedChannel ?? selectable.find((c) => c.id === channelId) ?? null;

  const setMode = (next) => {
    setModeState(next);
    try { localStorage.setItem(MODE_KEY, next); } catch { /* private mode */ }
  };

  useEffect(() => {
    if (!channelId && selectable.length) setChannelId(selectable.find((c) => c.type !== 'category')?.id ?? selectable[0].id);
  }, [selectable, channelId]);

  useEffect(() => {
    if (!targetKey && roles.length) {
      const everyone = roles.find((r) => r.is_everyone) ?? roles[0];
      setTargetKey(`role:${everyone.id}`);
    }
  }, [roles, targetKey]);

  const load = useCallback(async () => {
    if (!channelId) return;
    try {
      const data = await httpGet(`/api/channels/${channelId}/permissions`);
      setOverwrites(Array.isArray(data) ? data : []);
    } catch (err) {
      onToast?.(err.message, { type: 'error' });
    }
  }, [channelId, onToast]);

  useEffect(() => { load(); }, [load]);

  // Seed the editor from the stored overwrite for the selected target.
  useEffect(() => {
    const [type, id] = targetKey.split(':');
    const existing = overwrites.find((o) => o.target_type === type && o.target_id === id);
    setDraft({
      allow: BigInt(existing?.allow ?? '0'),
      deny: BigInt(existing?.deny ?? '0')
    });
  }, [targetKey, overwrites]);

  const stateOf = (name) => {
    const b = bit(name);
    if ((draft.allow & b) !== 0n) return 'allow';
    if ((draft.deny & b) !== 0n) return 'deny';
    return 'inherit';
  };

  const cycle = (name, next) => {
    const b = bit(name);
    setDraft({
      allow: next === 'allow' ? draft.allow | b : draft.allow & ~b,
      deny: next === 'deny' ? draft.deny | b : draft.deny & ~b
    });
  };

  const afterWrite = (data) => {
    setOverwrites(Array.isArray(data) ? data : []);
    refreshDetail();
  };

  const save = async () => {
    const [type, id] = targetKey.split(':');
    setBusy(true);
    try {
      afterWrite(await httpPut(`/api/channels/${channelId}/permissions/${type}/${id}`, {
        allow: draft.allow.toString(), deny: draft.deny.toString()
      }));
      onToast?.(t('perms.saved'), { type: 'success', ttl: 2500 });
    } catch (err) {
      onToast?.(err.message, { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  // Throws on failure so the confirm dialog shows why.
  const removeOverride = async () => {
    const [type, id] = targetKey.split(':');
    afterWrite(await httpDel(`/api/channels/${channelId}/permissions/${type}/${id}`));
    setDraft({ allow: 0n, deny: 0n });
    onToast?.(t('perms.overrideRemoved'), { type: 'success', ttl: 2500 });
  };

  const syncNow = async () => {
    try {
      await httpPost(`/api/channels/${channelId}/permissions/sync`);
      await load();
      await refreshDetail();
      onToast?.(t('channel.permissionsSynced'), { type: 'success', ttl: 2500 });
    } catch (err) { onToast?.(err.message, { type: 'error' }); }
  };

  const existing = useMemo(() => {
    const [type, id] = targetKey.split(':');
    return overwrites.find((o) => o.target_type === type && o.target_id === id) ?? null;
  }, [overwrites, targetKey]);

  const dirty = draft.allow.toString() !== String(existing?.allow ?? '0')
    || draft.deny.toString() !== String(existing?.deny ?? '0');
  useReportDirty(dirty, onDirtyChange);

  /** Changing channel or target would silently drop the edits — refuse instead. */
  const guarded = (fn) => (value) => {
    if (dirty) { setLocalNudge((n) => n + 1); return; }
    fn(value);
  };

  const targetLabel = (() => {
    const [type, id] = targetKey.split(':');
    if (type === 'role') return roles.find((r) => r.id === id)?.name ?? '';
    const m = members.find((x) => x.id === id);
    return m ? (m.nickname || m.display_name || m.username) : '';
  })();
  const channelLabel = channel ? `${channel.type === 'category' ? '' : isVoiceType(channel.type) ? '🔊 ' : '#'}${channel.name}` : '';
  const groups = channelScopedGroups(channel?.type ?? 'text');

  // --- simple mode ------------------------------------------------------------

  const overwriteFor = (type, id) => overwrites.find((o) => o.target_type === type && o.target_id === id);
  const maskOf = (o, key) => BigInt(o?.[key] ?? '0');
  const everyoneOw = everyoneId ? overwriteFor('role', everyoneId) : null;
  const isPrivate = (maskOf(everyoneOw, 'deny') & VIEW) !== 0n;
  const isReadOnly = (maskOf(everyoneOw, 'deny') & SEND) !== 0n;
  const otherRoles = roles.filter((r) => !r.is_everyone && !r.managed);
  const roleHas = (roleId, b) => (maskOf(overwriteFor('role', roleId), 'allow') & b) !== 0n;

  /** Write one overwrite with `b` added to / removed from its allow or deny mask. */
  const setBits = async (type, id, { allowAdd = 0n, allowRemove = 0n, denyAdd = 0n, denyRemove = 0n }) => {
    const current = overwriteFor(type, id);
    const allow = (maskOf(current, 'allow') | allowAdd) & ~allowRemove;
    const deny = (maskOf(current, 'deny') | denyAdd) & ~denyRemove;
    setBusy(true);
    try {
      const data = allow === 0n && deny === 0n
        ? await httpDel(`/api/channels/${channelId}/permissions/${type}/${id}`)
        : await httpPut(`/api/channels/${channelId}/permissions/${type}/${id}`, { allow: allow.toString(), deny: deny.toString() });
      afterWrite(data);
    } catch (err) {
      onToast?.(err.message, { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const simple = channel && everyoneId && (
    <div className="space-y-6">
      <fieldset className="bg-d-surface rounded-lg p-4">
        <legend className="sr-only">{t('adm.whoCanSee')}</legend>
        <p className="text-sm font-bold text-d-strong flex items-center gap-2 mb-3"><Eye className="w-4 h-4" aria-hidden="true" /> {t('adm.whoCanSee')}</p>
        <div className="space-y-2">
          <RadioRow
            name="see" checked={!isPrivate} disabled={busy}
            label={t('adm.everyoneCanSee')}
            onSelect={() => setBits('role', everyoneId, { denyRemove: VIEW })}
          />
          <RadioRow
            name="see" checked={isPrivate} disabled={busy}
            label={t('adm.onlyTheseCanSee')} icon={Lock}
            onSelect={() => setBits('role', everyoneId, { denyAdd: VIEW })}
          />
        </div>
        {isPrivate && (
          <RoleChips
            roles={otherRoles}
            isOn={(r) => roleHas(r.id, VIEW)}
            onToggle={(r) => setBits('role', r.id, roleHas(r.id, VIEW) ? { allowRemove: VIEW } : { allowAdd: VIEW })}
            disabled={busy}
            emptyLabel={t('adm.noRolesYet')}
          />
        )}
        {isPrivate && (
          <p className="text-[11px] text-d-text2 mt-2">{t('adm.privateMembersHint')}</p>
        )}
      </fieldset>

      {!isVoiceType(channel.type) && (
        <fieldset className="bg-d-surface rounded-lg p-4">
          <legend className="sr-only">{t('adm.whoCanPost')}</legend>
          <p className="text-sm font-bold text-d-strong flex items-center gap-2 mb-3"><MessageSquare className="w-4 h-4" aria-hidden="true" /> {t('adm.whoCanPost')}</p>
          <div className="space-y-2">
            <RadioRow
              name="post" checked={!isReadOnly} disabled={busy}
              label={t('adm.everyoneCanPost')}
              onSelect={() => setBits('role', everyoneId, { denyRemove: SEND })}
            />
            <RadioRow
              name="post" checked={isReadOnly} disabled={busy}
              label={t('adm.onlyTheseCanPost')}
              onSelect={() => setBits('role', everyoneId, { denyAdd: SEND })}
            />
          </div>
          {isReadOnly && (
            <RoleChips
              roles={otherRoles}
              isOn={(r) => roleHas(r.id, SEND)}
              onToggle={(r) => setBits('role', r.id, roleHas(r.id, SEND) ? { allowRemove: SEND } : { allowAdd: SEND })}
              disabled={busy}
              emptyLabel={t('adm.noRolesYet')}
            />
          )}
        </fieldset>
      )}
      <p className="text-xs text-d-text2">{t('adm.simpleFootnote')}</p>
    </div>
  );

  // --- render -------------------------------------------------------------------

  return (
    <div>
      {!fixedChannel && <h1 className="text-xl font-bold text-d-strong mb-1">{t('settings.channelPermissions')}</h1>}
      <p className="text-xs text-d-text2 mb-4">{t('perms.hint')}</p>

      <div className="flex flex-wrap items-center gap-2 mb-4" role="radiogroup" aria-label={t('adm.permMode')}>
        {['simple', 'advanced'].map((m) => (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={mode === m}
            onClick={() => guarded(setMode)(m)}
            className={`min-h-[32px] px-3 py-1 rounded-full text-sm border transition-colors ${
              mode === m ? 'bg-d-brand border-d-brand text-white' : 'border-d-divider text-d-text2 hover:bg-d-hover/60'
            }`}
          >
            {m === 'simple' ? t('adm.modeSimple') : t('adm.modeAdvanced')}
          </button>
        ))}
      </div>

      <div className={`grid gap-3 mb-4 ${fixedChannel ? 'grid-cols-1' : 'grid-cols-1 sm:grid-cols-2'}`}>
        {!fixedChannel && (
          <label className="block">
            <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">{t('autocomplete.channels')}</span>
            <select
              value={channelId}
              onChange={(e) => guarded(setChannelId)(e.target.value)}
              className="w-full min-h-[40px] bg-d-base text-sm text-d-strong px-3 py-2 rounded border border-d-edge focus:outline-none"
            >
              {categories.length > 0 && (
                <optgroup label={t('adm.categories')}>
                  {selectable.filter((c) => c.type === 'category').map((c) => (
                    <option key={c.id} value={c.id}>📁 {c.name}</option>
                  ))}
                </optgroup>
              )}
              <optgroup label={t('autocomplete.channels')}>
                {selectable.filter((c) => c.type !== 'category').map((c) => (
                  <option key={c.id} value={c.id}>
                    {isVoiceType(c.type) ? '🔊 ' : '# '}{c.name}
                  </option>
                ))}
              </optgroup>
            </select>
          </label>
        )}

        {mode === 'advanced' && (
          <label className="block">
            <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">{t('perms.appliesTo')}</span>
            <select
              value={targetKey}
              onChange={(e) => guarded(setTargetKey)(e.target.value)}
              className="w-full min-h-[40px] bg-d-base text-sm text-d-strong px-3 py-2 rounded border border-d-edge focus:outline-none"
            >
              <optgroup label={t('perms.roles')}>
                {roles.map((r) => (
                  <option key={r.id} value={`role:${r.id}`}>{t('perms.role', { name: r.name })}</option>
                ))}
              </optgroup>
              {members.length > 0 && (
                <optgroup label={t('perms.members')}>
                  {members.map((m) => (
                    <option key={m.id} value={`member:${m.id}`}>
                      {t('perms.member', { name: m.nickname || m.display_name || m.username })}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
          </label>
        )}
      </div>

      {channel?.type === 'category' && (
        <p className="text-xs text-d-text2 bg-d-surface rounded p-2.5 mb-4 flex items-start gap-2">
          <Folder className="w-4 h-4 shrink-0 mt-0.5" aria-hidden="true" /> {t('adm.categoryPermsHint')}
        </p>
      )}
      {syncInfo && channel?.type !== 'category' && (
        <div className={`text-xs rounded p-2.5 mb-4 flex flex-wrap items-center justify-between gap-2 ${syncInfo.synced ? 'bg-d-surface text-d-text2' : 'bg-d-idle/10 border border-d-idle/40 text-d-text'}`}>
          <span className="flex items-center gap-2">
            <Link2 className="w-4 h-4 shrink-0" aria-hidden="true" />
            {syncInfo.synced
              ? t('adm.syncedWith', { name: syncInfo.parent.name })
              : t('adm.notSyncedWith', { name: syncInfo.parent.name })}
          </span>
          {!syncInfo.synced && (
            <button type="button" onClick={syncNow} className="min-h-[28px] flex items-center gap-1 px-2 py-1 rounded bg-d-brand text-white text-xs font-semibold hover:bg-d-brandhover">
              <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" /> {t('adm.syncNow')}
            </button>
          )}
        </div>
      )}

      {mode === 'simple' ? simple : (
        <>
          {overwrites.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 mb-4">
              <span className="text-[11px] text-d-text2 mr-1">{t('perms.existing')}</span>
              {overwrites.map((o) => (
                <button
                  key={`${o.target_type}:${o.target_id}`}
                  onClick={() => guarded(setTargetKey)(`${o.target_type}:${o.target_id}`)}
                  aria-pressed={targetKey === `${o.target_type}:${o.target_id}`}
                  className={`min-h-[28px] text-[11px] px-2 py-0.5 rounded text-d-strong ${targetKey === `${o.target_type}:${o.target_id}` ? 'bg-d-brand text-white' : 'bg-d-active'}`}
                >
                  {o.target_type === 'member' ? <Users className="inline w-3 h-3 mr-1" aria-hidden="true" /> : null}
                  {o.role_name ?? o.display_name ?? o.username ?? o.target_id}
                </button>
              ))}
            </div>
          )}

          {/* Sticky: while scrolling a long list you always know what you edit. */}
          <div className="sticky top-0 z-10 -mx-1 px-1 py-2 bg-d-canvas border-b border-d-divider mb-3">
            <p className="text-sm text-d-strong" aria-live="polite">
              {t('adm.editingFor', { channel: channelLabel, target: targetLabel })}
            </p>
            <p className="text-[11px] text-d-text2 mt-1 flex flex-wrap gap-x-3 gap-y-1" aria-hidden="true">
              <span className="flex items-center gap-1"><X className="w-3 h-3 text-d-danger" /> {t('perms.deny')} — {t('adm.denyMeaning')}</span>
              <span className="flex items-center gap-1"><Minus className="w-3 h-3" /> {t('perms.inherit')} — {t('adm.inheritMeaning')}</span>
              <span className="flex items-center gap-1"><Check className="w-3 h-3 text-d-online" /> {t('perms.allow')} — {t('adm.allowMeaning')}</span>
            </p>
          </div>

          <div className="space-y-5">
            {groups.map((group) => (
              <div key={group.key}>
                <h4 className="text-[11px] font-bold text-d-text2 uppercase mb-2">{group.title}</h4>
                <div className="space-y-1">
                  {group.items.map(([name, label, description]) => (
                    <div key={name} className="flex max-sm:flex-col sm:items-center justify-between gap-2 sm:gap-4 py-2 border-b border-d-divider/40">
                      <div className="min-w-0">
                        <p className="text-sm text-d-strong">{label}</p>
                        <p className="text-[11px] text-d-text2">{description}</p>
                      </div>
                      <TriState value={stateOf(name)} onChange={(next) => cycle(name, next)} label={label} />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs text-d-text2 flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />
              {t('perms.cannotGrant')}
            </span>
            {existing && !dirty && (
              <button onClick={() => setConfirmRemove(true)} className="text-xs text-d-danger px-3 py-1.5 hover:underline">
                {t('perms.removeOverride')}
              </button>
            )}
          </div>
        </>
      )}

      {dirty && mode === 'advanced' && (
        <UnsavedBar
          nudge={nudge + localNudge}
          onReset={() => setDraft({ allow: BigInt(existing?.allow ?? '0'), deny: BigInt(existing?.deny ?? '0') })}
          onSave={save}
          saving={busy}
        />
      )}

      {confirmRemove && (
        <ConfirmModal
          title={t('perms.removeOverrideTitle', { name: targetLabel })}
          body={t('perms.removeOverrideBody')}
          confirmLabel={t('perms.removeOverride')}
          onConfirm={removeOverride}
          onClose={() => setConfirmRemove(false)}
        />
      )}
    </div>
  );
}

function RadioRow({ name, checked, label, onSelect, disabled, icon: Icon }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer min-h-[32px]">
      <input type="radio" name={name} checked={checked} disabled={disabled} onChange={onSelect} className="w-4 h-4 accent-[var(--color-d-brand)]" />
      {Icon && <Icon className="w-3.5 h-3.5 text-d-text2" aria-hidden="true" />}
      <span className="text-sm text-d-text">{label}</span>
    </label>
  );
}

function RoleChips({ roles, isOn, onToggle, disabled, emptyLabel }) {
  if (roles.length === 0) return <p className="text-xs text-d-text2 mt-3">{emptyLabel}</p>;
  return (
    <div className="flex flex-wrap gap-2 mt-3 pl-6">
      {roles.map((role) => {
        const on = isOn(role);
        return (
          <button
            key={role.id}
            type="button"
            aria-pressed={on}
            disabled={disabled}
            onClick={() => onToggle(role)}
            className={`min-h-[32px] flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-sm transition-colors disabled:opacity-60 ${
              on ? 'bg-d-brand border-d-brand text-white' : 'border-d-divider text-d-text hover:bg-d-hover/50'
            }`}
          >
            {on ? <Check className="w-3.5 h-3.5" aria-hidden="true" /> : (
              <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: role.color || '#99aab5' }} aria-hidden="true" />
            )}
            {role.name}
          </button>
        );
      })}
    </div>
  );
}

/** Deny / Inherit / Allow with visible words, not only ✕ – ✓. */
function TriState({ value, onChange, label }) {
  const options = [
    { key: 'deny', Icon: X, tint: 'bg-d-danger text-white', title: t('perms.deny'), tip: t('adm.denyMeaning') },
    { key: 'inherit', Icon: Minus, tint: 'bg-d-control text-d-strong', title: t('perms.inherit'), tip: t('adm.inheritMeaning') },
    { key: 'allow', Icon: Check, tint: 'bg-d-success text-white', title: t('perms.allow'), tip: t('adm.allowMeaning') }
  ];
  return (
    <div className="flex rounded overflow-hidden shrink-0 border border-d-divider" role="radiogroup" aria-label={label}>
      {options.map(({ key, Icon, tint, title, tip }) => (
        <button
          type="button"
          key={key}
          role="radio"
          aria-checked={value === key}
          aria-label={title}
          title={`${title}: ${tip}`}
          onClick={() => onChange(key)}
          className={`min-w-[44px] h-8 px-2 flex items-center justify-center gap-1 text-xs font-semibold transition-colors ${
            value === key ? tint : 'bg-d-base text-d-text2 hover:bg-d-hover'
          }`}
        >
          <Icon className="w-3.5 h-3.5" aria-hidden="true" />
          <span aria-hidden="true">{title}</span>
        </button>
      ))}
    </div>
  );
}
