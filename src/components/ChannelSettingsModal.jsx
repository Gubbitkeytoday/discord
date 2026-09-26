import React, { useEffect, useState } from 'react';
import { Hash, Volume2, Trash2, X, Loader2, Megaphone, Check, Folder, Settings, KeyRound, Smile } from 'lucide-react';
import { useDialog } from './settings/primitives';
import ChannelPermissionsTab from './settings/ChannelPermissionsTab';
import { takeChannelSettingsTab } from './admin/createChannelIntent';
import { t } from '../i18n/index.jsx';
import { get, put, del, patch as apiPatch } from '../api';
import EmojiPicker from './EmojiPicker';
import { maskOf } from '../utils/permissionCatalog';

// Discord's slowmode presets, in seconds.
const SLOWMODE_STEPS = [0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600];

const slowmodeLabel = (seconds) => {
  if (!seconds) return t('channel.slowmodeOff');
  if (seconds < 60) return t('channel.seconds', { count: seconds });
  if (seconds < 3600) return t('channel.minutes', { count: Math.round(seconds / 60) });
  return t('channel.hours', { count: Math.round(seconds / 3600) });
};

/**
 * Channel (or category) settings, as Discord's Edit Channel: an Overview tab
 * (name, topic, slowmode, NSFW, voice limits, "only admins can post") and a
 * Permissions tab for this channel's overwrites — no detour through Server
 * Settings to make a channel private or read-only.
 */
export default function ChannelSettingsModal({ channel, canManage, onSave, onDelete, onClose, onToast }) {
  const [tab, setTab] = useState(() => takeChannelSettingsTab() ?? 'overview');
  const [name, setName] = useState(channel.name ?? '');
  const [topic, setTopic] = useState(channel.topic ?? '');
  const [slowmode, setSlowmode] = useState(Number(channel.rate_limit_per_user) || 0);
  const [nsfw, setNsfw] = useState(Boolean(channel.nsfw));
  const [userLimit, setUserLimit] = useState(Number(channel.user_limit) || 0);
  // Channel emoji: shown in place of the # / speaker glyph in the channel list.
  const [iconEmoji, setIconEmoji] = useState(channel.icon_emoji ?? '');
  const [pickingEmoji, setPickingEmoji] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [permsDirty, setPermsDirty] = useState(false);
  const [nudge, setNudge] = useState(0);
  const [roles, setRoles] = useState([]);
  const [members, setMembers] = useState([]);
  const [everyoneOw, setEveryoneOw] = useState(undefined);   // undefined = not loaded
  const requestClose = () => { if (permsDirty) { setNudge((n) => n + 1); return; } onClose(); };
  const dialogRef = useDialog(requestClose);

  const serverId = channel.server_id;
  const isCategory = channel.type === 'category';
  const isVoice = channel.type === 'voice' || channel.type === 'stage';
  const isTextish = !isVoice && !isCategory && channel.type !== 'thread';
  const Icon = isCategory ? Folder : isVoice ? Volume2 : channel.type === 'announcement' ? Megaphone : Hash;

  // Roles and members for the permissions editor, and the @everyone overwrite
  // behind the "Only admins can post" switch.
  useEffect(() => {
    if (!serverId || channel.type === 'thread') return undefined;
    let alive = true;
    get(`/api/servers/${serverId}/roles`).then((r) => { if (alive) setRoles(Array.isArray(r) ? r : []); }).catch(() => {});
    get(`/api/servers/${serverId}/members?limit=500`).then((m) => { if (alive) setMembers(Array.isArray(m) ? m : []); }).catch(() => {});
    get(`/api/channels/${channel.id}/permissions`)
      .then((rows) => { if (alive) setEveryoneOw((Array.isArray(rows) ? rows : []).find((o) => o.target_type === 'role' && o.target_id === serverId) ?? null); })
      .catch(() => { if (alive) setEveryoneOw(null); });
    return () => { alive = false; };
  }, [serverId, channel.id, channel.type, tab]);

  const SEND = BigInt(maskOf('SEND_MESSAGES'));
  const readOnly = everyoneOw ? (BigInt(everyoneOw.deny ?? '0') & SEND) !== 0n : false;

  const toggleReadOnly = async () => {
    const allow = BigInt(everyoneOw?.allow ?? '0') & ~SEND;
    const deny = readOnly ? BigInt(everyoneOw?.deny ?? '0') & ~SEND : BigInt(everyoneOw?.deny ?? '0') | SEND;
    try {
      const rows = allow === 0n && deny === 0n
        ? await del(`/api/channels/${channel.id}/permissions/role/${serverId}`)
        : await put(`/api/channels/${channel.id}/permissions/role/${serverId}`, { allow: allow.toString(), deny: deny.toString() });
      setEveryoneOw((Array.isArray(rows) ? rows : []).find((o) => o.target_type === 'role' && o.target_id === serverId) ?? null);
      onToast?.(t('perms.saved'), { type: 'success', ttl: 2000 });
    } catch (err) {
      onToast?.(err.message, { type: 'error' });
    }
  };

  const dirty = name !== (channel.name ?? '')
    || topic !== (channel.topic ?? '')
    || slowmode !== (Number(channel.rate_limit_per_user) || 0)
    || nsfw !== Boolean(channel.nsfw)
    || userLimit !== (Number(channel.user_limit) || 0)
    || iconEmoji !== (channel.icon_emoji ?? '');
  const canHaveEmoji = !isCategory && channel.type !== 'thread' && Boolean(serverId);

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      if (canHaveEmoji && iconEmoji !== (channel.icon_emoji ?? '')) {
        await apiPatch(`/api/channels/${channel.id}/icon-emoji`, { icon_emoji: iconEmoji || null });
      }
      await onSave(isCategory ? { name } : {
        name,
        topic: topic || null,
        rate_limit_per_user: slowmode,
        nsfw,
        ...(isVoice ? { user_limit: userLimit } : {})
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      onToast?.(err.message, { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  const switchTab = (next) => {
    if (permsDirty) { setNudge((n) => n + 1); return; }
    setTab(next);
  };

  const tabs = [
    { key: 'overview', label: t('settings.overview'), icon: Settings },
    channel.type !== 'thread' && serverId && { key: 'permissions', label: t('adm.permissionsTab'), icon: KeyRound }
  ].filter(Boolean);

  const field = 'w-full bg-d-base text-sm text-d-strong px-3 py-2.5 rounded border border-d-edge focus:outline-none focus:border-d-brand disabled:opacity-60';

  return (
    <div className="fixed inset-0 bg-black/70 z-[60] flex items-center justify-center overlay-center p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="channel-settings-title"
        className={`bg-d-canvas w-full ${tab === 'permissions' ? 'max-w-2xl' : 'max-w-lg'} rounded-lg shadow-2xl border border-d-surface overflow-hidden flex flex-col max-h-[90vh]`}
      >
        <div className="p-5 pb-3 border-b border-d-divider">
          <div className="flex items-center justify-between gap-2">
            <h2 id="channel-settings-title" className="text-base font-bold text-d-strong flex items-center gap-2 min-w-0">
              <Icon className="w-5 h-5 text-d-text3 shrink-0" aria-hidden="true" />
              <span className="truncate">
                {isCategory ? t('adm.categorySettingsFor', { name: channel.name }) : t('channel.settingsFor', { name: channel.name })}
              </span>
            </h2>
            <button type="button" onClick={requestClose} className="p-1 rounded text-d-text3 hover:text-d-strong" aria-label={t('common.close')}>
              <X className="w-4 h-4" />
            </button>
          </div>
          {tabs.length > 1 && (
            <div role="tablist" aria-label={t('channel.settings')} className="flex gap-1 mt-3">
              {tabs.map((entry) => (
                <button
                  key={entry.key}
                  type="button"
                  role="tab"
                  id={`chs-tab-${entry.key}`}
                  aria-selected={tab === entry.key}
                  aria-controls={`chs-panel-${entry.key}`}
                  onClick={() => switchTab(entry.key)}
                  className={`min-h-[32px] flex items-center gap-1.5 px-3 py-1.5 rounded text-sm transition-colors ${
                    tab === entry.key ? 'bg-d-active text-d-strong' : 'text-d-text2 hover:bg-d-hover hover:text-d-strong'
                  }`}
                >
                  <entry.icon className="w-4 h-4" aria-hidden="true" /> {entry.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {tab === 'permissions' ? (
          <div id="chs-panel-permissions" role="tabpanel" aria-labelledby="chs-tab-permissions" className="px-5 pb-5 overflow-y-auto flex-1">
            <div className="h-5" aria-hidden="true" />
            <ChannelPermissionsTab
              channels={[channel]}
              roles={roles}
              members={members}
              fixedChannel={channel}
              onToast={onToast}
              onDirtyChange={setPermsDirty}
              nudge={nudge}
            />
          </div>
        ) : (
          <form id="chs-panel-overview" role="tabpanel" aria-labelledby="chs-tab-overview" onSubmit={save} className="flex flex-col min-h-0 flex-1">
            <div className="p-5 space-y-5 overflow-y-auto flex-1">
              <label className="block">
                <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">
                  {isCategory ? t('adm.categoryName') : t('channel.name')}
                </span>
                <input value={name} onChange={(e) => setName(e.target.value)} disabled={!canManage} maxLength={100} className={field} />
              </label>

              {canHaveEmoji && (
                <div className="relative">
                  <span id="chs-emoji-label" className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">{t('srv.channelEmoji')}</span>
                  <div className="flex items-center gap-2" role="group" aria-labelledby="chs-emoji-label">
                    <button
                      type="button"
                      onClick={() => setPickingEmoji((v) => !v)}
                      disabled={!canManage}
                      aria-expanded={pickingEmoji}
                      aria-label={iconEmoji ? t('srv.channelEmojiChange', { emoji: iconEmoji }) : t('srv.channelEmojiPick')}
                      className="w-11 h-11 rounded border border-d-edge bg-d-base flex items-center justify-center text-xl hover:border-d-brand disabled:opacity-60"
                    >
                      {iconEmoji && !iconEmoji.startsWith('<') ? <span aria-hidden="true">{iconEmoji}</span> : <Smile className="w-5 h-5 text-d-text3" aria-hidden="true" />}
                    </button>
                    <input
                      value={iconEmoji}
                      onChange={(e) => setIconEmoji(e.target.value.trim())}
                      disabled={!canManage}
                      maxLength={32}
                      aria-label={t('srv.channelEmoji')}
                      placeholder="🎮"
                      className={`${field} w-28`}
                    />
                    {Boolean(iconEmoji) && canManage && (
                      <button type="button" onClick={() => setIconEmoji('')} className="text-xs text-d-text2 hover:text-d-strong hover:underline min-h-8 px-1">
                        {t('common.remove')}
                      </button>
                    )}
                  </div>
                  <span className="block text-[11px] text-d-text3 mt-1">{t('srv.channelEmojiHint')}</span>
                  {pickingEmoji && (
                    <EmojiPicker
                      anchorClass="absolute left-0 top-full mt-1 z-30"
                      onClose={() => setPickingEmoji(false)}
                      onPick={(entry) => { if (entry.char) setIconEmoji(entry.char); setPickingEmoji(false); }}
                    />
                  )}
                </div>
              )}

              {isTextish && (
                <label className="block">
                  <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">{t('channel.topic')}</span>
                  <textarea
                    value={topic}
                    onChange={(e) => setTopic(e.target.value)}
                    disabled={!canManage}
                    rows={3}
                    maxLength={1024}
                    placeholder={t('channel.topicPlaceholder')}
                    className={`${field} resize-none`}
                  />
                  <span className="block text-right text-[10px] text-d-text3 mt-1">{topic.length}/1024</span>
                </label>
              )}

              {isTextish && (
                <label className="block">
                  <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">
                    {t('channel.slowmode')} — {slowmodeLabel(slowmode)}
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={SLOWMODE_STEPS.length - 1}
                    step={1}
                    value={Math.max(0, SLOWMODE_STEPS.indexOf(slowmode))}
                    onChange={(e) => setSlowmode(SLOWMODE_STEPS[Number(e.target.value)])}
                    disabled={!canManage}
                    aria-valuetext={slowmodeLabel(slowmode)}
                    className="w-full accent-d-brand"
                  />
                  <span className="block text-[11px] text-d-text3 mt-1">{t('channel.slowmodeHint')}</span>
                </label>
              )}

              {isVoice && (
                <label className="block">
                  <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">
                    {t('channel.userLimit')} — {userLimit === 0 ? t('channel.noLimit') : userLimit}
                  </span>
                  <input
                    type="range" min={0} max={20} step={1}
                    value={userLimit}
                    onChange={(e) => setUserLimit(Number(e.target.value))}
                    disabled={!canManage}
                    className="w-full accent-d-brand"
                  />
                </label>
              )}

              {isTextish && (
                <SwitchRow
                  title={t('channel.nsfw')} hint={t('channel.nsfwHint')}
                  checked={nsfw} disabled={!canManage} onChange={() => setNsfw((v) => !v)}
                />
              )}

              {isTextish && everyoneOw !== undefined && (
                <SwitchRow
                  title={t('adm.onlyAdminsPost')} hint={t('adm.onlyAdminsPostHintEdit')}
                  checked={readOnly} disabled={!canManage} onChange={toggleReadOnly}
                />
              )}

              {canManage && (
                <div className="pt-2 border-t border-d-divider">
                  <button type="button" onClick={onDelete} className="min-h-[32px] flex items-center gap-2 text-sm text-d-danger hover:underline">
                    <Trash2 className="w-4 h-4" aria-hidden="true" /> {isCategory ? t('adm.deleteCategory') : t('channel.deleteChannel')}
                  </button>
                  {isCategory && <p className="text-[11px] text-d-text3 mt-1">{t('adm.deleteCategoryBody')}</p>}
                </div>
              )}
            </div>

            <div className="bg-d-surface px-5 py-3 flex justify-end gap-2">
              <button type="button" onClick={requestClose} className="px-4 py-2 text-sm font-semibold text-d-strong hover:underline">
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={!canManage || !dirty || busy || !name.trim()}
                className="px-5 py-2 rounded text-sm font-semibold text-white bg-d-brand hover:bg-d-brandhover disabled:opacity-50 flex items-center gap-2"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" /> : saved ? <Check className="w-4 h-4" aria-hidden="true" /> : null}
                {saved ? t('common.saved') : t('common.saveChanges')}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function SwitchRow({ title, hint, checked, disabled, onChange }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <p className="text-sm text-d-strong">{title}</p>
        <p className="text-[11px] text-d-text3">{hint}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={title}
        disabled={disabled}
        onClick={onChange}
        className={`w-11 h-6 rounded-full relative transition-colors shrink-0 disabled:opacity-60 ${checked ? 'bg-d-brand' : 'bg-d-text4'}`}
      >
        <span className={`absolute top-1 w-4 h-4 rounded-full bg-white transition-all ${checked ? 'left-6' : 'left-1'}`} />
      </button>
    </div>
  );
}
