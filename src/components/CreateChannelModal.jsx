import React, { useEffect, useMemo, useState } from 'react';
import {
  X, Hash, Volume2, Megaphone, Lock, MessagesSquare, Image as ImageIcon, Radio, ArrowLeft, Search, Check, Users, Shield
} from 'lucide-react';
import { useDialog } from './settings/primitives';
import { t } from '../i18n/index.jsx';
import { get, post, put, getApiUserId } from '../api';
import { maskOf } from '../utils/permissionCatalog';
import { takeCreateChannelIntent, defaultCategoryFor } from './admin/createChannelIntent';
import { defaultAvatar } from '../utils/avatar';
import { proxiedImageUrl } from '../utils/media';

const channelTypes = () => [
  { value: 'text',         icon: Hash,      title: t('channel.typeText'),         description: t('channel.typeTextHint') },
  { value: 'voice',        icon: Volume2,   title: t('channel.typeVoice'),        description: t('channel.typeVoiceHint') },
  { value: 'announcement', icon: Megaphone, title: t('channel.typeAnnouncement'), description: t('channel.typeAnnouncementHint') },
  { value: 'forum',        icon: MessagesSquare, title: t('channel.typeForum'),   description: t('channel.typeForumHint') },
  { value: 'media',        icon: ImageIcon, title: t('channel.typeMedia'),        description: t('channel.typeMediaHint') },
  { value: 'stage',        icon: Radio,     title: t('channel.typeStage'),        description: t('channel.typeStageHint') }
];

const NEW_CATEGORY = '__new__';
const NO_CATEGORY = '__none__';
const slug = (name) => name.trim().toLowerCase().replace(/\s+/g, '-').replace(/[^\p{L}\p{M}\p{N}_-]/gu, '');
const isTextish = (type) => ['text', 'announcement', 'forum', 'media'].includes(type);
const bigger = (a, b) => (a.length !== b.length ? a.length > b.length : a > b);

/**
 * Create channel, Discord-style: name, type, category (including a new one),
 * and — for a private channel — a second "Who can access?" step so a private
 * channel is never created empty. "Only admins can post" makes a read-only
 * channel (announcements) in one switch instead of a permission matrix.
 */
export default function CreateChannelModal({ defaultType = 'text', categories = [], onClose, onCreateChannel }) {
  // Context from the place that opened the dialog (a category's "+", the
  // server menu): which server, which category, and each category's types.
  const [intent] = useState(() => takeCreateChannelIntent());
  const serverId = intent?.serverId ?? null;
  const categoryList = useMemo(() => {
    if (intent?.categories?.length) return intent.categories;
    return categories.map((name) => ({ id: null, name, types: [] }));
  }, [intent, categories]);

  const [channelName, setChannelName] = useState('');
  const [type, setType] = useState(intent?.type ?? defaultType);
  const [isPrivate, setIsPrivate] = useState(false);
  const [readOnly, setReadOnly] = useState((intent?.type ?? defaultType) === 'announcement');
  const [readOnlyTouched, setReadOnlyTouched] = useState(false);
  const initialCategory = intent?.categoryName !== undefined && intent?.categoryName !== null
    ? intent.categoryName
    : defaultCategoryFor(intent?.type ?? defaultType, categoryList)?.name ?? NO_CATEGORY;
  const [category, setCategory] = useState(initialCategory || NO_CATEGORY);
  const [categoryTouched, setCategoryTouched] = useState(Boolean(intent?.categoryName));
  const [newCategory, setNewCategory] = useState('');
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  // Access step data, fetched only when a private channel is being made.
  const [roles, setRoles] = useState(null);
  const [members, setMembers] = useState(null);
  const [pickedRoles, setPickedRoles] = useState(() => new Set());
  const [pickedMembers, setPickedMembers] = useState(() => new Set());
  const [memberQuery, setMemberQuery] = useState('');

  const dialogRef = useDialog(() => { if (!busy) onClose(); });

  // The type decides the sensible default category (voice under the voice
  // category) and whether "only admins can post" starts on — until the user
  // picks either themselves.
  const chooseType = (next) => {
    setType(next);
    if (!categoryTouched) {
      const fallback = defaultCategoryFor(next, categoryList);
      setCategory(fallback?.name ?? NO_CATEGORY);
    }
    if (!readOnlyTouched) setReadOnly(next === 'announcement');
  };

  useEffect(() => {
    if (!isPrivate || !serverId || roles) return;
    let alive = true;
    Promise.all([
      get(`/api/servers/${serverId}/roles`).catch(() => []),
      get(`/api/servers/${serverId}/members?limit=500`).catch(() => [])
    ]).then(([r, m]) => {
      if (!alive) return;
      setRoles((Array.isArray(r) ? r : []).filter((role) => !role.is_everyone && !role.managed));
      setMembers(Array.isArray(m) ? m : []);
    });
    return () => { alive = false; };
  }, [isPrivate, serverId, roles]);

  const canReadOnly = !['voice', 'stage'].includes(type);
  const needsAccessStep = isPrivate && Boolean(serverId);

  const toggleIn = (setter) => (id) => setter((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  /** Find the channel the shell just created, so its permissions can be set. */
  const findCreated = async (finalName, apiType) => {
    const detail = await get(`/api/servers/${serverId}`);
    const matches = (detail?.channels ?? []).filter((c) => c.name === finalName && c.type === apiType);
    return matches.reduce((best, c) => (!best || bigger(String(c.id), String(best.id)) ? c : best), null);
  };

  const create = async () => {
    if (!channelName.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      let categoryName = category === NO_CATEGORY ? '' : category;
      if (category === NEW_CATEGORY) {
        const name = newCategory.trim();
        if (!name) { setError(t('adm.categoryNameRequired')); setBusy(false); return; }
        if (serverId) await post('/api/channels', { server_id: serverId, name, type: 'category' });
        categoryName = name;
      }
      await onCreateChannel({ name: channelName.trim(), type, isPrivate, category: categoryName });

      const wantsReadOnly = readOnly && canReadOnly;
      const wantsAccess = isPrivate && (pickedRoles.size > 0 || pickedMembers.size > 0);
      if (serverId && (wantsReadOnly || wantsAccess)) {
        const apiType = type === 'media' ? 'forum' : type;
        const created = await findCreated(isTextish(type) ? slug(channelName) : channelName.trim(), apiType);
        if (created) {
          const VIEW = BigInt(maskOf('VIEW_CHANNEL'));
          const SEND = BigInt(maskOf('SEND_MESSAGES'));
          const everyoneDeny = (isPrivate ? VIEW : 0n) | (wantsReadOnly ? SEND : 0n);
          if (everyoneDeny) {
            await put(`/api/channels/${created.id}/permissions/role/${serverId}`, { allow: '0', deny: everyoneDeny.toString() });
          }
          for (const roleId of pickedRoles) {
            await put(`/api/channels/${created.id}/permissions/role/${roleId}`, { allow: VIEW.toString(), deny: '0' });
          }
          for (const userId of pickedMembers) {
            await put(`/api/channels/${created.id}/permissions/member/${userId}`, { allow: VIEW.toString(), deny: '0' });
          }
        }
      }
      onClose();
    } catch (err) {
      setError(err?.message ?? String(err));
      setBusy(false);
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!channelName.trim()) return;
    if (step === 1 && needsAccessStep) { setStep(2); return; }
    create();
  };

  const preview = isTextish(type) ? slug(channelName) : channelName;
  const filteredMembers = useMemo(() => {
    const q = memberQuery.trim().toLowerCase();
    // The creator always keeps access; listing them would only confuse.
    const me = getApiUserId();
    const list = (members ?? []).filter((m) => m.id !== me);
    return (q ? list.filter((m) => [m.nickname, m.display_name, m.username].some((v) => (v ?? '').toLowerCase().includes(q))) : list).slice(0, 50);
  }, [members, memberQuery]);

  const label = 'block text-xs font-bold text-d-text2 uppercase tracking-wider mb-2';
  const field = 'w-full min-h-[40px] bg-d-base text-d-strong px-3 py-2.5 rounded-lg border border-d-divider focus:outline-none focus:border-d-brand text-sm';

  return (
    <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center overlay-center p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-channel-title"
        className="bg-d-canvas w-full max-w-md rounded-2xl overflow-hidden shadow-2xl border border-d-surface"
      >
        <form onSubmit={handleSubmit}>
          <div className="p-6 pb-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              {step === 2 && (
                <button type="button" onClick={() => setStep(1)} className="p-1 -ml-1 rounded text-d-text3 hover:text-d-strong" aria-label={t('common.back')}>
                  <ArrowLeft className="w-5 h-5" />
                </button>
              )}
              <h2 id="create-channel-title" className="text-xl font-bold text-d-strong truncate">
                {step === 2 ? t('adm.whoCanAccess') : t('server.createChannel')}
              </h2>
            </div>
            <button type="button" onClick={onClose} className="p-1 rounded text-d-text3 hover:text-d-strong shrink-0" aria-label={t('common.close')}>
              <X className="w-5 h-5" />
            </button>
          </div>

          {step === 1 ? (
            <div className="p-6 pt-2 space-y-4 max-h-[65vh] overflow-y-auto">
              <label className="block">
                <span className={label}>{t('channel.name')}</span>
                <div className="relative">
                  <span className="absolute left-3 top-2.5 text-d-text3 font-semibold" aria-hidden="true">
                    {type === 'voice' || type === 'stage' ? '🔊' : '#'}
                  </span>
                  <input
                    type="text"
                    value={channelName}
                    onChange={(e) => setChannelName(e.target.value)}
                    placeholder={t('channel.namePlaceholder')}
                    required
                    maxLength={100}
                    autoFocus
                    className={`${field} pl-8`}
                  />
                </div>
                {preview && preview !== channelName && (
                  <span className="block text-[11px] text-d-text3 mt-1">{t('channel.willBeNamed', { name: preview })}</span>
                )}
              </label>

              <fieldset>
                <legend className={label}>{t('channel.type')}</legend>
                <div className="grid grid-cols-1 gap-2">
                  {channelTypes().map((option) => (
                    <label
                      key={option.value}
                      className={`flex items-center gap-3 p-3 max-sm:p-2.5 rounded-lg border cursor-pointer transition-colors focus-within:ring-2 focus-within:ring-d-brand ${
                        type === option.value ? 'bg-d-active border-d-brand' : 'bg-d-surface border-d-divider hover:bg-d-hover/40'
                      }`}
                    >
                      <input
                        type="radio"
                        name="channel-type"
                        value={option.value}
                        checked={type === option.value}
                        onChange={() => chooseType(option.value)}
                        className="sr-only"
                      />
                      <option.icon className="w-6 h-6 text-d-text3 shrink-0" aria-hidden="true" />
                      <span className="min-w-0">
                        <span className="block font-bold text-d-strong text-sm">{option.title}</span>
                        <span className="block text-xs text-d-text2">{option.description}</span>
                      </span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <label className="block">
                <span className={label}>{t('channel.category')}</span>
                <select
                  value={category}
                  onChange={(e) => { setCategory(e.target.value); setCategoryTouched(true); }}
                  className={field}
                >
                  <option value={NO_CATEGORY}>{t('adm.noCategory')}</option>
                  {categoryList.map((c) => <option key={c.id ?? c.name} value={c.name}>{c.name}</option>)}
                  {serverId && <option value={NEW_CATEGORY}>{t('adm.newCategoryOption')}</option>}
                </select>
              </label>
              {category === NEW_CATEGORY && (
                <label className="block">
                  <span className={label}>{t('adm.categoryName')}</span>
                  <input
                    value={newCategory}
                    onChange={(e) => setNewCategory(e.target.value)}
                    maxLength={100}
                    placeholder={t('adm.categoryPlaceholder')}
                    className={field}
                  />
                </label>
              )}

              <div className="pt-2 border-t border-d-divider space-y-3">
                <SwitchRow
                  icon={Lock}
                  title={t('channel.private')}
                  hint={t('channel.privateHint')}
                  checked={isPrivate}
                  onChange={setIsPrivate}
                />
                {canReadOnly && (
                  <SwitchRow
                    icon={Megaphone}
                    title={t('adm.onlyAdminsPost')}
                    hint={t('adm.onlyAdminsPostHint')}
                    checked={readOnly}
                    onChange={(v) => { setReadOnly(v); setReadOnlyTouched(true); }}
                  />
                )}
              </div>
            </div>
          ) : (
            <div className="p-6 pt-2 space-y-4 max-h-[65vh] overflow-y-auto">
              <p className="text-sm text-d-text2">{t('adm.whoCanAccessHint', { name: preview || channelName })}</p>
              <fieldset>
                <legend className={`${label} flex items-center gap-1.5`}><Shield className="w-3.5 h-3.5" aria-hidden="true" /> {t('perms.roles')}</legend>
                {roles === null ? (
                  <p className="text-xs text-d-text3" role="status">{t('common.loading')}</p>
                ) : roles.length === 0 ? (
                  <p className="text-xs text-d-text3">{t('adm.noRolesYet')}</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {roles.map((role) => {
                      const on = pickedRoles.has(role.id);
                      return (
                        <button
                          key={role.id}
                          type="button"
                          aria-pressed={on}
                          onClick={() => toggleIn(setPickedRoles)(role.id)}
                          className={`min-h-[32px] flex items-center gap-1.5 px-2.5 py-1 rounded-full border text-sm transition-colors ${
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
                )}
              </fieldset>
              <fieldset>
                <legend className={`${label} flex items-center gap-1.5`}><Users className="w-3.5 h-3.5" aria-hidden="true" /> {t('perms.members')}</legend>
                <div className="relative mb-2">
                  <input
                    value={memberQuery}
                    onChange={(e) => setMemberQuery(e.target.value)}
                    placeholder={t('members.searchMembers')}
                    aria-label={t('members.searchMembers')}
                    className={`${field} pr-8`}
                  />
                  <Search className="w-4 h-4 text-d-text3 absolute right-2.5 top-3" aria-hidden="true" />
                </div>
                <ul className="max-h-48 overflow-y-auto space-y-0.5" aria-label={t('perms.members')}>
                  {filteredMembers.map((m) => {
                    const on = pickedMembers.has(m.id);
                    return (
                      <li key={m.id}>
                        <label className="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-d-hover/50 cursor-pointer min-h-[36px]">
                          <input type="checkbox" checked={on} onChange={() => toggleIn(setPickedMembers)(m.id)} className="w-4 h-4 accent-[var(--color-d-brand)]" />
                          <img src={proxiedImageUrl(m.avatar_url || defaultAvatar(m.id))} alt="" className="w-6 h-6 rounded-full" />
                          <span className="text-sm text-d-strong truncate">{m.nickname || m.display_name || m.username}</span>
                          <span className="text-xs text-d-text3 truncate">@{m.username}</span>
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </fieldset>
              <p className="text-[11px] text-d-text3">{t('adm.accessFootnote')}</p>
            </div>
          )}

          {error && <p className="px-6 pb-2 text-xs text-d-danger" role="alert">{error}</p>}

          <div className="bg-d-surface px-6 py-4 flex justify-between items-center gap-2">
            <button type="button" onClick={step === 2 ? () => create() : onClose} disabled={busy} className="text-sm font-semibold text-d-strong hover:underline min-h-[36px]">
              {step === 2 ? t('adm.skip') : t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={!channelName.trim() || busy || (category === NEW_CATEGORY && !newCategory.trim())}
              className="bg-d-brand hover:bg-d-brandhover text-white px-6 py-2.5 rounded-md text-sm font-semibold transition-colors disabled:opacity-50 min-h-[40px]"
            >
              {step === 1 && needsAccessStep ? t('adm.next') : t('server.createChannel')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function SwitchRow({ icon: Icon, title, hint, checked, onChange }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-sm text-d-strong">
          <Icon className="w-3.5 h-3.5" aria-hidden="true" /> {title}
        </span>
        <span className="block text-[11px] text-d-text2">{hint}</span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={title}
        onClick={() => onChange(!checked)}
        className={`w-11 h-6 rounded-full relative transition-colors shrink-0 ${checked ? 'bg-d-brand' : 'bg-d-text4'}`}
      >
        <span className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${checked ? 'left-6' : 'left-1'}`} />
      </button>
    </div>
  );
}
