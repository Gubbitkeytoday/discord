import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Hash, Volume2, Check, X, Minus, ShieldCheck } from 'lucide-react';

import { permissionGroups, PERMISSION_BITS } from '../../utils/permissionCatalog';
import { t } from '../../i18n/index.jsx';
import { get as httpGet, put as httpPut, del as httpDel } from '../../api';

/**
 * Per-channel permission overwrites.
 *
 * Each permission is tri-state, exactly as Discord models it:
 *   allow (✓) · inherit (/) · deny (✕)
 * "Inherit" means the bit appears in neither the allow nor the deny mask, so the
 * role's server-wide setting decides. That is why this cannot be a checkbox.
 */
export default function ChannelPermissionsTab({ channels, roles, members = [], onToast }) {
  const [channelId, setChannelId] = useState('');
  const [targetKey, setTargetKey] = useState('');   // "role:<id>" or "member:<id>"
  const [overwrites, setOverwrites] = useState([]);
  const [draft, setDraft] = useState({ allow: 0n, deny: 0n });
  const [busy, setBusy] = useState(false);

  const selectable = useMemo(
    () => channels.filter((c) => c.type !== 'category' && c.type !== 'thread'),
    [channels]
  );

  useEffect(() => {
    if (!channelId && selectable.length) setChannelId(selectable[0].id);
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
    const bit = 1n << BigInt(PERMISSION_BITS[name]);
    if ((draft.allow & bit) !== 0n) return 'allow';
    if ((draft.deny & bit) !== 0n) return 'deny';
    return 'inherit';
  };

  const cycle = (name, next) => {
    const bit = 1n << BigInt(PERMISSION_BITS[name]);
    setDraft({
      allow: next === 'allow' ? draft.allow | bit : draft.allow & ~bit,
      deny: next === 'deny' ? draft.deny | bit : draft.deny & ~bit
    });
  };

  const save = async () => {
    const [type, id] = targetKey.split(':');
    setBusy(true);
    try {
      const data = await httpPut(`/api/channels/${channelId}/permissions/${type}/${id}`, {
        allow: draft.allow.toString(), deny: draft.deny.toString()
      });
      setOverwrites(Array.isArray(data) ? data : []);
      onToast?.(t('perms.saved'), { type: 'success', ttl: 2500 });
    } catch (err) {
      onToast?.(err.message, { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    const [type, id] = targetKey.split(':');
    try {
      const data = await httpDel(`/api/channels/${channelId}/permissions/${type}/${id}`);
      setOverwrites(Array.isArray(data) ? data : []);
      setDraft({ allow: 0n, deny: 0n });
    } catch (err) { onToast?.(err.message, { type: 'error' }); }
  };

  const dirty = useMemo(() => {
    const [type, id] = targetKey.split(':');
    const existing = overwrites.find((o) => o.target_type === type && o.target_id === id);
    return draft.allow.toString() !== (existing?.allow ?? '0')
      || draft.deny.toString() !== (existing?.deny ?? '0');
  }, [draft, overwrites, targetKey]);

  return (
    <div>
      <h1 className="text-xl font-bold text-d-strong mb-1">{t('settings.channelPermissions')}</h1>
      <p className="text-xs text-d-text3 mb-5">
        {t('perms.hint')}
      </p>

      <div className="grid grid-cols-2 gap-3 mb-5">
        <label className="block">
          <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">{t('autocomplete.channels')}</span>
          <select
            value={channelId}
            onChange={(e) => setChannelId(e.target.value)}
            className="w-full bg-d-base text-sm text-d-strong px-3 py-2 rounded border border-d-edge focus:outline-none"
          >
            {selectable.map((c) => (
              <option key={c.id} value={c.id}>
                {c.type === 'voice' ? '🔊 ' : '# '}{c.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">{t('perms.appliesTo')}</span>
          <select
            value={targetKey}
            onChange={(e) => setTargetKey(e.target.value)}
            className="w-full bg-d-base text-sm text-d-strong px-3 py-2 rounded border border-d-edge focus:outline-none"
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
      </div>

      {overwrites.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-5">
          <span className="text-[11px] text-d-text4 mr-1">{t('perms.existing')}</span>
          {overwrites.map((o) => (
            <button
              key={`${o.target_type}:${o.target_id}`}
              onClick={() => setTargetKey(`${o.target_type}:${o.target_id}`)}
              className="text-[11px] px-2 py-0.5 rounded bg-d-active text-d-strong"
            >
              {o.role_name ?? o.display_name ?? o.target_id}
            </button>
          ))}
        </div>
      )}

      <div className="space-y-5">
        {permissionGroups().map((group) => (
          <div key={group.key}>
            <h4 className="text-[11px] font-bold text-d-text3 uppercase mb-2">{group.title}</h4>
            <div className="space-y-1">
              {group.items.map(([name, label, description]) => (
                <div key={name} className="flex items-center justify-between gap-4 py-2 border-b border-d-divider/40">
                  <div className="min-w-0">
                    <p className="text-sm text-d-strong">{label}</p>
                    <p className="text-[11px] text-d-text3">{description}</p>
                  </div>
                  <TriState value={stateOf(name)} onChange={(next) => cycle(name, next)} label={label} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="sticky bottom-0 mt-6 bg-d-surface border border-d-edge rounded-lg p-3 flex items-center justify-between">
        <span className="text-xs text-d-text2 flex items-center gap-1.5">
          <ShieldCheck className="w-3.5 h-3.5" />
          {t('perms.cannotGrant')}
        </span>
        <div className="flex gap-2">
          <button onClick={reset} className="text-xs text-d-danger px-3 py-1.5 hover:underline">
            {t('perms.removeOverride')}
          </button>
          <button
            onClick={save}
            disabled={busy || !dirty}
            className="bg-d-success hover:bg-d-successhover disabled:opacity-40 text-white text-xs font-semibold px-4 py-1.5 rounded transition-colors"
          >
            {busy ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}

function TriState({ value, onChange, label }) {
  const options = [
    { key: 'deny', Icon: X, tint: 'bg-d-danger text-white', title: t('perms.deny') },
    { key: 'inherit', Icon: Minus, tint: 'bg-d-control text-white', title: t('perms.inherit') },
    { key: 'allow', Icon: Check, tint: 'bg-d-online text-white', title: t('perms.allow') }
  ];
  return (
    <div className="flex rounded overflow-hidden shrink-0" role="radiogroup" aria-label={label}>
      {options.map(({ key, Icon, tint, title }) => (
        <button
          key={key}
          role="radio"
          aria-checked={value === key}
          title={title}
          onClick={() => onChange(key)}
          className={`w-9 h-7 flex items-center justify-center transition-colors ${
            value === key ? tint : 'bg-d-base text-d-text4 hover:bg-d-hover'
          }`}
        >
          <Icon className="w-3.5 h-3.5" />
        </button>
      ))}
    </div>
  );
}

