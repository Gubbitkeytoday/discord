import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  X, Shield, Users, Smile, Link2, Ban, ScrollText, Settings as SettingsIcon,
  Plus, Trash2, Search, Upload, Check, AlertTriangle, Crown, GripVertical,
  ShieldAlert, Webhook, KeyRound, Sticker, Clock, Pencil, Flag, Music, Loader2, Hand, BarChart3,
  ChevronUp, ChevronDown, ChevronLeft, ChevronRight, ShieldCheck, LogOut, Filter, Hash, Folder
} from 'lucide-react';

import { useDialog, UnsavedBar, useReportDirty, SettingToggle } from './settings/primitives';
import { getTranslationConfig, resetTranslationConfig } from '../translation';
import ConfirmModal from './ConfirmModal';
import AutoModTab from './settings/AutoModTab';
import WebhooksTab from './settings/WebhooksTab';
import ChannelPermissionsTab from './settings/ChannelPermissionsTab';
import OnboardingTab from './settings/OnboardingTab';
import InsightsTab from './settings/InsightsTab';
import SafetyTab from './admin/SafetyTab';
import ModerationDialog from './admin/ModerationDialog';
import TypeToConfirmDialog from './admin/TypeToConfirmDialog';
import { t, localeTag, useLocaleCode, formatDate, formatRelative } from '../i18n/index.jsx';
import { api as httpApi, upload as httpUpload } from '../api';
import { DEFAULT_AVATAR, serverIconOf, serverInitials, defaultAvatar } from '../utils/avatar';
import {
  permissionGroups, hasBit, toggleBit, countPermissions, ROLE_PRESETS
} from '../utils/permissionCatalog';
import { proxiedImageUrl, filePreviewUrl } from '../utils/media';
import RoleStyleEditor from './server/RoleStyleEditor.jsx';
import RoleIcon from './server/RoleIcon.jsx';
import { styleOf } from './server/roleStyle';
import ServerAppearanceSettings from './server/ServerAppearanceSettings.jsx';

const FALLBACK_AVATAR = DEFAULT_AVATAR;

/**
 * The nav, grouped the way Discord groups Server Settings. `perm` is the
 * permission the tab's endpoints check: a tab the viewer cannot use is hidden
 * rather than shown and left to fail with a 403 toast. Owners and
 * administrators see everything.
 */
const tabGroups = () => [
  {
    key: 'server',
    title: null,   // the server name is the heading of the first group
    tabs: [
      { key: 'overview', label: t('settings.overview'), icon: SettingsIcon, perm: 'MANAGE_GUILD' },
      { key: 'roles', label: t('settings.roles'), icon: Shield, perm: 'MANAGE_ROLES' },
      { key: 'permissions', label: t('settings.channelPermissions'), icon: KeyRound, perm: 'MANAGE_ROLES' },
      { key: 'emojis', label: t('chat.emoji'), icon: Smile, perm: 'MANAGE_EMOJIS' },
      { key: 'stickers', label: t('settings.stickers'), icon: Sticker, perm: 'MANAGE_EMOJIS' },
      { key: 'soundboard', label: t('settings.soundboard'), icon: Music, perm: 'MANAGE_EMOJIS' }
    ]
  },
  {
    key: 'apps',
    title: t('settings.groupApps'),
    tabs: [
      { key: 'webhooks', label: t('settings.webhooks'), icon: Webhook, perm: 'MANAGE_WEBHOOKS' }
    ]
  },
  {
    key: 'moderation',
    title: t('settings.groupModeration'),
    tabs: [
      { key: 'safety', label: t('adm.safetySetup'), icon: ShieldCheck, perm: 'MANAGE_GUILD' },
      { key: 'automod', label: t('settings.automod'), icon: ShieldAlert, perm: 'MANAGE_GUILD' },
      { key: 'reports', label: t('settings.reports'), icon: Flag, perm: 'MANAGE_MESSAGES' },
      { key: 'audit', label: t('settings.auditLog'), icon: ScrollText, perm: 'VIEW_AUDIT_LOG' },
      { key: 'bans', label: t('settings.bans'), icon: Ban, perm: 'BAN_MEMBERS' }
    ]
  },
  {
    key: 'community',
    title: t('settings.groupCommunity'),
    tabs: [
      { key: 'onboarding', label: t('settings.onboarding'), icon: Hand, perm: 'MANAGE_GUILD' },
      { key: 'insights', label: t('settings.insights'), icon: BarChart3, perm: 'MANAGE_GUILD' }
    ]
  },
  {
    key: 'people',
    title: t('settings.groupPeople'),
    tabs: [
      { key: 'members', label: t('autocomplete.members'), icon: Users, perm: null },
      { key: 'invites', label: t('settings.invites'), icon: Link2, perm: 'MANAGE_GUILD' }
    ]
  }
];

const auditLabels = () => ({
  SERVER_CREATE: t('audit.SERVER_CREATE'), SERVER_UPDATE: t('audit.SERVER_UPDATE'),
  SERVER_OWNER_TRANSFER: t('audit.SERVER_OWNER_TRANSFER'),
  CHANNEL_CREATE: t('adm.audit.CHANNEL_CREATE'), CHANNEL_UPDATE: t('audit.CHANNEL_UPDATE'), CHANNEL_DELETE: t('audit.CHANNEL_DELETE'),
  ROLE_CREATE: t('audit.ROLE_CREATE'), ROLE_UPDATE: t('audit.ROLE_UPDATE'), ROLE_DELETE: t('audit.ROLE_DELETE'),
  MEMBER_ROLE_UPDATE: t('audit.MEMBER_ROLE_UPDATE'), MEMBER_KICK: t('audit.MEMBER_KICK'),
  MEMBER_BAN_ADD: t('audit.MEMBER_BAN_ADD'), MEMBER_BAN_REMOVE: t('bans.unban'),
  MEMBER_TIMEOUT: t('audit.MEMBER_TIMEOUT'), MEMBER_UPDATE: t('audit.MEMBER_UPDATE'),
  EMOJI_CREATE: t('audit.EMOJI_CREATE'), EMOJI_DELETE: t('audit.EMOJI_DELETE'), INVITE_DELETE: t('invites.revoke'),
  LOCKDOWN_START: t('adm.audit.LOCKDOWN_START'), LOCKDOWN_LIFT: t('adm.audit.LOCKDOWN_LIFT'),
  AUTOMOD_BLOCK: t('adm.audit.AUTOMOD_BLOCK'), AUTOMOD_ALERT: t('adm.audit.AUTOMOD_ALERT'),
  RAID_DETECTED: t('adm.audit.RAID_DETECTED'),
  CHANNEL_OVERWRITE_UPDATE: t('adm.audit.CHANNEL_OVERWRITE_UPDATE'),
  CHANNEL_OVERWRITE_DELETE: t('adm.audit.CHANNEL_OVERWRITE_DELETE'),
  MEMBER_MOVE: t('adm.audit.MEMBER_MOVE'), MEMBER_DISCONNECT: t('adm.audit.MEMBER_DISCONNECT'),
  TEMPLATE_CREATE: t('adm.audit.TEMPLATE_CREATE'),
  STICKER_CREATE: t('adm.audit.STICKER_CREATE'), STICKER_DELETE: t('adm.audit.STICKER_DELETE')
});

/** Audit filter groups, Discord-style ("All actions", "Members", …). */
const AUDIT_FILTERS = () => [
  { value: '', label: t('adm.auditAllActions') },
  { value: 'MEMBER_*', label: t('adm.auditMembers') },
  { value: 'CHANNEL_*', label: t('adm.auditChannels') },
  { value: 'ROLE_*', label: t('adm.auditRoles') },
  { value: 'AUTOMOD_*', label: t('settings.automod') },
  { value: 'SERVER_*', label: t('adm.auditServer') },
  { value: 'LOCKDOWN_*', label: t('adm.auditSafety') }
];

/** When an account was created, from its snowflake id (null for other ids). */
function accountCreatedAt(id) {
  if (!/^\d{15,20}$/.test(String(id ?? ''))) return null;
  try { return new Date(Number((BigInt(id) >> 22n) + 1420070400000n)); } catch { return null; }
}

/**
 * Server Settings. Each tab fetches only what it needs, on first open, so
 * opening settings does not pull the audit log and every ban at once.
 */
export default function ServerSettingsModal({
  server, currentUserId, channels = [], initialTab = 'overview', viewerPermissions = [],
  onClose, onServerUpdated, onServerDeleted, onRefreshServer, onToast
}) {
  const [roles, setRoles] = useState([]);
  const [members, setMembers] = useState([]);
  const [emojis, setEmojis] = useState([]);
  const [invites, setInvites] = useState([]);
  const [bans, setBans] = useState([]);
  const [auditLog, setAuditLog] = useState([]);
  const [automodRules, setAutomodRules] = useState([]);
  const [webhooks, setWebhooks] = useState([]);
  const [stickers, setStickers] = useState([]);
  const [sounds, setSounds] = useState([]);
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(false);
  // Discord will not let you leave a page with unsaved edits: the save bar
  // turns red and shakes instead. Tabs with a save bar report `dirty` here;
  // `nudge` counts refused navigations so the bar can react.
  const [dirty, setDirty] = useState(false);
  const [nudge, setNudge] = useState(0);

  const isOwner = server.owner_id === currentUserId;
  const can = useCallback(
    (name) => viewerPermissions.includes(name) || viewerPermissions.includes('ADMINISTRATOR') || isOwner,
    [viewerPermissions, isOwner]
  );

  // Translated labels are memoised; recompute when the language changes.
  const locale = useLocaleCode();
  const groups = useMemo(
    () => tabGroups()
      .map((group) => ({ ...group, tabs: group.tabs.filter((entry) => !entry.perm || can(entry.perm)) }))
      .filter((group) => group.tabs.length > 0),
    [can, locale]
  );
  const visibleKeys = groups.flatMap((group) => group.tabs.map((entry) => entry.key));
  const [tab, setTab] = useState(() => (visibleKeys.includes(initialTab) ? initialTab : visibleKeys[0] ?? 'members'));
  // Phones get Discord's drill-down: the tab list first, then one page with a
  // back button. A deep link (Manage roles, Safety) opens straight on its page.
  const [mobilePage, setMobilePage] = useState(() => (initialTab && initialTab !== 'overview' ? 'content' : 'nav'));
  const currentTabLabel = groups.flatMap((g) => g.tabs).find((entry) => entry.key === tab)?.label ?? '';

  /** Run `fn` unless a tab is holding unsaved edits, in which case say so. */
  const guarded = (fn) => {
    if (dirty) { setNudge((n) => n + 1); return; }
    fn();
  };
  const switchTab = (key) => guarded(() => { setTab(key); setDirty(false); setMobilePage('content'); });
  const requestClose = () => guarded(onClose);

  // One wrapper for every server-scoped call: the shared client sends the
  // session (cookie or bearer token) and turns error envelopes into throws.
  const api = useCallback(
    (path, { method = 'GET', body } = {}) => httpApi(`/api/servers/${server.id}${path}`, { method, body }),
    [server.id]
  );

  const load = useCallback(async (which) => {
    setLoading(true);
    try {
      if (which === 'roles') setRoles(await api('/roles'));
      if (which === 'members') setMembers(await api('/members?limit=500'));
      if (which === 'emojis') setEmojis(await api('/emojis'));
      if (which === 'invites') setInvites(await api('/invites'));
      if (which === 'bans') setBans(await api('/bans'));
      if (which === 'audit') setAuditLog(await api('/audit-log?limit=100'));
      if (which === 'automod') setAutomodRules(await api('/automod'));
      if (which === 'webhooks') setWebhooks(await api('/webhooks'));
      if (which === 'stickers') setStickers(await api('/stickers'));
      if (which === 'soundboard') setSounds(await api('/sounds'));
      if (which === 'reports') setReports(await httpApi(`/api/reports?status=open&serverId=${server.id}`));
      // AutoMod, channel permissions and onboarding all pick from the role list.
      if (['automod', 'permissions', 'onboarding'].includes(which)) setRoles(await api('/roles'));
      // The channel-permission editor also offers per-member overwrites.
      if (which === 'permissions') setMembers(await api('/members?limit=500'));
    } catch (err) {
      onToast?.(err.message, { type: 'error' });
    } finally {
      setLoading(false);
    }
  }, [api, onToast, server.id]);

  useEffect(() => { load(tab); }, [tab, load]);

  // Members shows role chips and the role picker, so it needs the role list too.
  useEffect(() => { if (tab === 'members' && roles.length === 0) load('roles'); }, [tab, roles.length, load]);

  // Focus stays inside the dialog and returns to the trigger on close.
  const dialogRef = useDialog(requestClose);
  const dirtyProps = { onDirtyChange: setDirty, nudge };

  return (
    <div ref={dialogRef} className="fixed inset-0 z-[80] bg-d-canvas flex max-md:flex-col" role="dialog" aria-modal="true" aria-label={t('server.settings')}>
      {/* Phone header: back (on a page), title, close — never over the content. */}
      <div className="md:hidden h-14 shrink-0 flex items-center gap-2 px-2 border-b border-d-edge bg-d-surface">
        {mobilePage === 'content' ? (
          <button
            type="button"
            onClick={() => guarded(() => setMobilePage('nav'))}
            className="w-11 h-11 flex items-center justify-center rounded-full text-d-text2 hover:text-d-strong"
            aria-label={t('adm.backToSettings')}
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
        ) : <span className="w-2" />}
        <h2 className="flex-1 min-w-0 truncate text-base font-bold text-d-strong">
          {mobilePage === 'content' ? currentTabLabel : server.name}
        </h2>
        <button
          type="button"
          onClick={requestClose}
          aria-label={t('common.close')}
          className="w-11 h-11 rounded-full text-d-text2 hover:text-d-strong flex items-center justify-center"
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Left nav (on phones: the first page of the drill-down) */}
      <nav
        aria-label={t('server.settings')}
        className={`w-56 max-md:w-full bg-d-surface shrink-0 overflow-y-auto py-14 max-md:py-2 px-3 max-md:flex-1 ${mobilePage === 'content' ? 'max-md:hidden' : ''}`}
      >
        {groups.map((group, index) => (
          <div key={group.key} className={index > 0 ? 'mt-4' : ''}>
            <h2 className="px-2 mb-1 text-[11px] font-bold text-d-text2 uppercase tracking-wide truncate">
              {group.title ?? server.name}
            </h2>
            {group.tabs.map((entry) => (
              <button
                key={entry.key}
                onClick={() => switchTab(entry.key)}
                aria-current={tab === entry.key ? 'page' : undefined}
                className={`w-full flex items-center gap-2 px-2 py-1.5 max-md:py-3 max-md:min-h-[44px] rounded text-sm mb-0.5 transition-colors ${
                  tab === entry.key ? 'bg-d-active text-d-strong md:bg-d-active' : 'text-d-text2 hover:bg-d-hover hover:text-d-strong'
                }`}
              >
                <entry.icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                <span className="truncate flex-1 text-left">{entry.label}</span>
                <ChevronRight className="w-4 h-4 shrink-0 md:hidden text-d-text3" aria-hidden="true" />
              </button>
            ))}
          </div>
        ))}
      </nav>

      {/* Content */}
      {/* No top padding on the scroller itself: sticky headers inside a tab
          (role name, permission target) must stick to its very top edge. */}
      <div className={`flex-1 overflow-y-auto px-10 max-md:px-4 pb-14 max-md:pb-6 max-w-4xl min-w-0 ${mobilePage === 'nav' ? 'max-md:hidden' : ''}`}>
        <div className="h-14 max-md:h-4" aria-hidden="true" />
        {loading && <p className="text-xs text-d-text3 mb-3" role="status">{t('common.loading')}</p>}

        {tab === 'overview' && (
          <OverviewTab
            server={server} api={api} channels={channels} isOwner={isOwner}
            onServerUpdated={onServerUpdated} onServerDeleted={onServerDeleted} onToast={onToast}
            {...dirtyProps}
          />
        )}
        {tab === 'roles' && (
          <RolesTab roles={roles} api={api} reload={() => load('roles')} onToast={onToast} serverId={server.id} {...dirtyProps} />
        )}
        {tab === 'members' && (
          <MembersTab
            members={members} roles={roles} server={server} api={api}
            reload={async () => { await load('members'); onRefreshServer?.(); }}
            onToast={onToast} currentUserId={currentUserId} can={can} isOwner={isOwner}
          />
        )}
        {tab === 'emojis' && (
          <EmojisTab emojis={emojis} api={api} reload={() => load('emojis')} onToast={onToast} />
        )}
        {tab === 'invites' && (
          <InvitesTab invites={invites} api={api} reload={() => load('invites')} channels={channels} onToast={onToast} />
        )}
        {tab === 'bans' && (
          <BansTab bans={bans} api={api} reload={() => load('bans')} onToast={onToast} />
        )}
        {tab === 'stickers' && (
          <StickersTab stickers={stickers} api={api} reload={() => load('stickers')} onToast={onToast} />
        )}
        {tab === 'permissions' && (
          <ChannelPermissionsTab
            channels={channels} roles={roles} members={members} onToast={onToast} {...dirtyProps}
          />
        )}
        {tab === 'automod' && (
          <AutoModTab
            rules={automodRules} api={api} reload={() => load('automod')}
            channels={channels} roles={roles} onToast={onToast}
          />
        )}
        {tab === 'webhooks' && (
          <WebhooksTab
            webhooks={webhooks} channels={channels}
            reload={() => load('webhooks')} onToast={onToast}
          />
        )}
        {tab === 'insights' && (
          <InsightsTab server={server} channels={channels} onToast={onToast} onOpenSafety={() => switchTab('safety')} />
        )}
        {tab === 'safety' && (
          <SafetyTab
            server={server} channels={channels} onToast={onToast}
            onServerUpdated={onServerUpdated} onOpenAutoMod={() => switchTab('automod')}
          />
        )}
        {tab === 'onboarding' && (
          <OnboardingTab server={server} channels={channels} roles={roles} onToast={onToast} {...dirtyProps} />
        )}
        {tab === 'soundboard' && (
          <SoundboardTab sounds={sounds} api={api} reload={() => load('soundboard')} onToast={onToast} />
        )}
        {tab === 'reports' && (
          <ReportsTab reports={reports} reload={() => load('reports')} onToast={onToast} />
        )}
        {tab === 'audit' && <AuditTab entries={auditLog} api={api} members={members} onLoadMembers={() => load('members')} onToast={onToast} />}
      </div>

      {/* Close */}
      <div className="w-20 pt-14 shrink-0 max-md:hidden">
        <button
          onClick={requestClose}
          className="w-9 h-9 rounded-full border-2 border-d-text2 text-d-text2 hover:bg-d-control hover:text-d-strong flex items-center justify-center transition-colors"
          aria-label={t('common.close')}
        >
          <X className="w-4 h-4" />
        </button>
        <span className="block text-[11px] font-bold text-d-text2 mt-1 text-center">ESC</span>
      </div>
    </div>
  );
}

// --- Overview ----------------------------------------------------------------

/**
 * The editable slice of a server row, with every null normalised to the value
 * its control shows. Comparing against this — rather than against the raw row —
 * is what keeps the save bar from appearing on a pristine form (a null
 * `afk_timeout` used to compare unequal to the select's 300 forever).
 */
const overviewForm = (server) => ({
  name: server.name ?? '',
  description: server.description ?? '',
  icon_url: server.icon_url ?? '',
  system_channel_id: server.system_channel_id ?? '',
  afk_channel_id: server.afk_channel_id ?? '',
  afk_timeout: Number(server.afk_timeout ?? 300),
  rules_channel_id: server.rules_channel_id ?? '',
  vanity_url: server.vanity_url ?? '',
  verification_level: Number(server.verification_level ?? 0),
  default_notifications: server.default_notifications ?? 'all_messages'
});

function OverviewTab({
  server, api, channels, isOwner, onServerUpdated, onServerDeleted, onToast, onDirtyChange, nudge
}) {
  const baseline = useMemo(() => overviewForm(server), [server]);
  const [form, setForm] = useState(baseline);
  const [saving, setSaving] = useState(false);
  const [uploadingIcon, setUploadingIcon] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dirty = Object.keys(baseline).some((key) => form[key] !== baseline[key]);
  useReportDirty(dirty, onDirtyChange);

  // Follow changes made elsewhere (a socket update, another admin) — but only
  // while this form has no edits of its own.
  const previousBaseline = useRef(baseline);
  useEffect(() => {
    const previous = previousBaseline.current;
    previousBaseline.current = baseline;
    setForm((current) => (Object.keys(previous).every((key) => current[key] === previous[key]) ? baseline : current));
  }, [baseline]);

  // Throws on failure so the confirm dialog stays open and shows why.
  const deleteServer = async () => {
    await api('', { method: 'DELETE' });
    onServerDeleted?.();
  };

  const uploadIcon = async (input) => {
    const file = input.files?.[0];
    // Clear the picker so choosing the same file again after an error fires.
    input.value = '';
    if (!file) return;
    setUploadingIcon(true);
    try {
      // Uploads act as the person clicking, not as the server owner.
      const data = await httpUpload('/api/upload/server-icon', 'icon', file);
      if (data.url) setForm((f) => ({ ...f, icon_url: data.url }));
    } catch (err) {
      onToast?.(err.message ?? t('chat.uploadFailed'), { type: 'error' });
    } finally {
      setUploadingIcon(false);
    }
  };

  const save = async () => {
    if (!form.name.trim()) { onToast?.(t('settings.serverNameRequired'), { type: 'error' }); return; }
    setSaving(true);
    try {
      // Only what changed, with "none" sent as null rather than an empty
      // string (which the server would store as a channel id of '').
      const body = {};
      for (const key of Object.keys(baseline)) {
        if (form[key] === baseline[key]) continue;
        const value = typeof form[key] === 'string' ? form[key].trim() : form[key];
        body[key] = value === '' && key !== 'description' ? null : value;
      }
      if (body.name === null) delete body.name;
      const updated = await api('', { method: 'PATCH', body });
      onServerUpdated?.(updated);
      setForm(overviewForm({ ...server, ...updated }));
      onToast?.(t('settings.saved'), { type: 'success', ttl: 2500 });
    } catch (err) {
      onToast?.(err.message, { type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  const textChannels = channels.filter((c) => c.type === 'text' || c.type === 'announcement');
  const voiceChannels = channels.filter((c) => c.type === 'voice');

  return (
    <div>
      <h1 className="text-xl font-bold text-d-strong mb-6">{t('settings.serverOverview')}</h1>

      <div className="flex max-sm:flex-col gap-6 mb-8">
        <label className={`shrink-0 group ${uploadingIcon ? 'cursor-wait' : 'cursor-pointer'}`}>
          <span className="relative block w-24 h-24">
            {serverIconOf(form) ? (
              <img
                src={serverIconOf(form)}
                alt=""
                className="w-24 h-24 rounded-full object-cover border-4 border-d-surface group-hover:opacity-70 transition-opacity"
              />
            ) : (
              // Same initials tile as the server rail, not a person silhouette.
              <span className="w-24 h-24 rounded-full border-4 border-d-surface bg-d-brand text-white text-2xl font-semibold flex items-center justify-center group-hover:opacity-70 transition-opacity">
                {serverInitials(form.name || server.name)}
              </span>
            )}
            {uploadingIcon && (
              <span className="absolute inset-0 flex items-center justify-center rounded-full bg-black/55">
                <Loader2 className="w-5 h-5 animate-spin text-white" aria-label={t('common.uploading')} />
              </span>
            )}
          </span>
          <span className="flex items-center gap-1 justify-center text-[11px] text-d-link mt-2">
            <Upload className="w-3 h-3" /> {t('settings.changeIcon')}
          </span>
          <span className="block max-w-24 text-center text-[10px] leading-tight text-d-text2 mt-1">{t('srv.animatedIconHint')}</span>
          <input
            type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden"
            aria-label={t('server.iconAlt')}
            disabled={uploadingIcon}
            onChange={(e) => uploadIcon(e.target)}
          />
        </label>

        <div className="flex-1 space-y-4">
          <Field label={t('settings.serverName')}>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              maxLength={100}
              aria-invalid={!form.name.trim()}
              className="w-full bg-d-base text-sm text-d-strong px-3 py-2 rounded border border-d-edge focus:outline-none focus:border-d-brand"
            />
          </Field>
          <Field label={t('settings.description')}>
            <textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              rows={3}
              className="w-full bg-d-base text-sm text-d-strong px-3 py-2 rounded border border-d-edge focus:outline-none focus:border-d-brand resize-none"
            />
          </Field>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-8">
        <Field label={t('settings.systemChannel')}>
          <ChannelSelect
            value={form.system_channel_id}
            options={textChannels}
            onChange={(v) => setForm({ ...form, system_channel_id: v })}
          />
        </Field>
        <Field label={t('settings.afkChannel')}>
          <ChannelSelect
            value={form.afk_channel_id}
            options={voiceChannels}
            onChange={(v) => setForm({ ...form, afk_channel_id: v })}
          />
        </Field>
        {Boolean(form.afk_channel_id) && (
          <Field label={t('settings.afkTimeout')}>
            <select
              value={form.afk_timeout}
              onChange={(e) => setForm({ ...form, afk_timeout: Number(e.target.value) })}
              className="w-full bg-d-base text-sm text-d-strong px-3 py-2 rounded border border-d-edge focus:outline-none"
            >
              {[60, 300, 900, 1800, 3600].map((sec) => (
                <option key={sec} value={sec}>{t('settings.afkMinutes', { count: sec / 60 })}</option>
              ))}
            </select>
          </Field>
        )}
        <Field label={t('settings.rulesChannel')}>
          <ChannelSelect
            value={form.rules_channel_id}
            options={textChannels}
            onChange={(v) => setForm({ ...form, rules_channel_id: v })}
          />
        </Field>
        <Field label={t('settings.vanityUrl')}>
          <div className="flex items-center gap-1">
            <span className="shrink-0 text-xs text-d-text3">{window.location.origin}/invite/</span>
            <input
              value={form.vanity_url}
              onChange={(e) => setForm({ ...form, vanity_url: e.target.value.toLowerCase() })}
              maxLength={32}
              placeholder="my-server"
              pattern="[a-z0-9-]*"
              aria-label={t('settings.vanityUrl')}
              className="flex-1 bg-d-base text-sm text-d-strong px-3 py-2 rounded border border-d-edge focus:outline-none focus:border-d-brand"
            />
          </div>
          <p className="mt-1 text-[11px] text-d-text3">{t('settings.vanityHint')}</p>
        </Field>
        <Field label={t('settings.verificationLevel')}>
          <select
            value={form.verification_level}
            onChange={(e) => setForm({ ...form, verification_level: Number(e.target.value) })}
            className="w-full bg-d-base text-sm text-d-strong px-3 py-2 rounded border border-d-edge focus:outline-none"
          >
            <option value={0}>{t('settings.verify0')}</option>
            <option value={1}>{t('settings.verify1')}</option>
            <option value={2}>{t('settings.verify2')}</option>
            <option value={3}>{t('settings.verify3')}</option>
            <option value={4}>{t('settings.verify4')}</option>
          </select>
          <p className="mt-1 text-[11px] text-d-text3">{t('settings.verifyHint')}</p>
        </Field>
        <Field label={t('settings.defaultNotifications')}>
          <select
            value={form.default_notifications}
            onChange={(e) => setForm({ ...form, default_notifications: e.target.value })}
            className="w-full bg-d-base text-sm text-d-strong px-3 py-2 rounded border border-d-edge focus:outline-none"
          >
            <option value="all_messages">{t('settings.allMessages')}</option>
            <option value="only_mentions">{t('settings.onlyMentions')}</option>
          </select>
        </Field>
      </div>

      <ServerAppearanceSettings server={server} onServerUpdated={onServerUpdated} onToast={onToast} />

      <TranslationSection server={server} onToast={onToast} />

      <TemplateSection server={server} onToast={onToast} />

      {isOwner && (
        <div className="border border-d-danger/40 rounded-lg p-4 mb-6">
          <h2 className="text-sm font-bold text-d-danger mb-1">{t('settings.dangerZone')}</h2>
          <p className="text-xs text-d-text3 mb-3">{t('settings.deleteServerHint')}</p>
          <button
            onClick={() => setConfirmDelete(true)}
            className="min-h-[36px] bg-d-danger/10 hover:bg-d-danger hover:text-white text-d-danger text-xs font-semibold px-4 py-2 rounded flex items-center gap-2 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" aria-hidden="true" /> {t('server.delete')}
          </button>
          {confirmDelete && (
            <TypeToConfirmDialog
              title={t('server.deleteTitle', { name: server.name })}
              body={t('adm.deleteServerBody')}
              expected={server.name}
              confirmLabel={t('server.delete')}
              onConfirm={deleteServer}
              onClose={() => setConfirmDelete(false)}
            />
          )}
        </div>
      )}

      {dirty && (
        <UnsavedBar
          nudge={nudge}
          onReset={() => setForm(baseline)}
          onSave={save}
          saving={saving}
          saveDisabled={uploadingIcon || !form.name.trim()}
        />
      )}
    </div>
  );
}

/**
 * A preview URL for a picked file that is revoked when the file changes or the
 * component unmounts. Calling URL.createObjectURL() in render leaks one blob
 * URL per render for as long as the picker is open.
 */
function useFilePreview(file) {
  const [url, setUrl] = useState(null);
  useEffect(() => {
    if (!file) { setUrl(null); return undefined; }
    const objectUrl = filePreviewUrl(file);
    setUrl(objectUrl);
    return () => { if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [file]);
  return url;
}

function Field({ label, children }) {
  return (
    <label className="block">
      <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">{label}</span>
      {children}
    </label>
  );
}

function ChannelSelect({ value, options, onChange, label = t('settings.selectChannel') }) {
  return (
    <select
      aria-label={label}
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      className="w-full bg-d-base text-sm text-d-strong px-3 py-2 rounded border border-d-edge focus:outline-none"
    >
      <option value="">{t('common.none')}</option>
      {options.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
    </select>
  );
}

// --- Roles -------------------------------------------------------------------

/**
 * Server Template: one per server. Anyone with the code can spin up a server
 * with the same roles/channels. Members and messages are never included.
 */
/**
 * Server-side message translation switch (MANAGE_GUILD, which the Overview
 * tab already requires). Saves on toggle, like Discord's switches. Hidden
 * when the instance has no translation provider configured, since the
 * switch would do nothing.
 */
function TranslationSection({ server, onToast }) {
  const [state, setState] = useState(null);   // null = loading/hidden, else { disabled }
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const cfg = await getTranslationConfig();
        if (!cfg?.server?.enabled) return;
        const data = await httpApi(`/api/servers/${server.id}/translation`);
        if (alive) setState({ disabled: Boolean(data?.translation_disabled) });
      } catch { /* leave hidden */ }
    })();
    return () => { alive = false; };
  }, [server.id]);

  if (!state) return null;

  const toggle = async (allowed) => {
    setSaving(true);
    const previous = state;
    setState({ disabled: !allowed });
    try {
      const data = await httpApi(`/api/servers/${server.id}/translation`, { method: 'PUT', body: { disabled: !allowed } });
      setState({ disabled: Boolean(data?.translation_disabled) });
      resetTranslationConfig();
    } catch (err) {
      setState(previous);
      onToast?.(err.message, { type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mb-6" data-testid="server-translation">
      <SettingToggle
        label={t('translate.serverDisabled')}
        hint={t('translate.serverDisabledHint')}
        checked={!state.disabled}
        onChange={toggle}
        disabled={saving}
        last
      />
    </div>
  );
}

function TemplateSection({ server, onToast }) {
  const [template, setTemplate] = useState(undefined);   // undefined = loading, null = none
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!server?.id) return;
    httpApi(`/api/servers/${server.id}/template`).then(setTemplate).catch(() => setTemplate(null));
  }, [server?.id]);

  const run = async (fn) => {
    setBusy(true);
    try { setTemplate(await fn()); } catch (err) { onToast?.(err.message, { type: 'error' }); } finally { setBusy(false); }
  };
  const link = template ? `${window.location.origin}/template/${template.code}` : '';

  return (
    <div className="border border-d-edge rounded-lg p-4 mb-6">
      <h2 className="text-sm font-bold text-d-strong mb-1">{t('settings.template')}</h2>
      <p className="text-xs text-d-text3 mb-3">{t('settings.templateHint')}</p>
      {template === undefined ? (
        <Loader2 className="w-4 h-4 animate-spin text-d-text3" aria-label={t('common.loading')} />
      ) : template === null ? (
        <form
          onSubmit={(e) => { e.preventDefault(); if (name.trim()) run(() => httpApi(`/api/servers/${server.id}/template`, { method: 'POST', body: { name: name.trim() } })); }}
          className="flex flex-wrap gap-2"
        >
          <input value={name} onChange={(e) => setName(e.target.value.slice(0, 100))} placeholder={t('settings.templateNamePlaceholder')} aria-label={t('settings.templateName')}
            className="flex-1 min-w-[10rem] bg-d-input text-d-strong rounded-md px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-d-brand" />
          <button type="submit" disabled={busy || !name.trim()} className="bg-d-brand hover:bg-d-brand-hover disabled:opacity-50 text-white text-sm font-semibold px-3 py-2 rounded-md">
            {t('settings.templateCreate')}
          </button>
        </form>
      ) : (
        <div className="space-y-2">
          <div className="text-sm text-d-strong font-semibold">{template.name}</div>
          <div className="text-[11px] text-d-text3">
            {t('server.templateStats', { channels: template.channel_count, roles: template.role_count, uses: template.usage_count })}
            {' · '}{t('settings.templateSynced', { when: new Date(template.updated_at).toLocaleString(localeTag()) })}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <code className="text-xs bg-d-input px-2 py-1.5 rounded-md text-d-text2 select-all break-all">{link}</code>
            <button type="button" onClick={() => { navigator.clipboard?.writeText(link); onToast?.(t('common.copied'), { type: 'success', ttl: 2000 }); }}
              className="text-xs font-semibold bg-d-surface hover:bg-d-hover text-d-strong px-3 py-1.5 rounded-md">{t('settings.templateCopy')}</button>
            <button type="button" disabled={busy} onClick={() => run(() => httpApi(`/api/servers/${server.id}/template/sync`, { method: 'PUT' }))}
              className="text-xs font-semibold bg-d-surface hover:bg-d-hover text-d-strong px-3 py-1.5 rounded-md disabled:opacity-50">{t('settings.templateSync')}</button>
            <button type="button" disabled={busy} onClick={() => setConfirmDelete(true)}
              className="text-xs font-semibold text-d-danger hover:underline px-2 py-1.5 disabled:opacity-50">{t('common.delete')}</button>
          </div>
        </div>
      )}
      {confirmDelete && (
        <ConfirmModal
          title={t('settings.templateDeleteTitle')}
          body={t('settings.templateDeleteBody')}
          confirmLabel={t('common.delete')}
          onConfirm={async () => {
            await httpApi(`/api/servers/${server.id}/template`, { method: 'DELETE' });
            setTemplate(null);
          }}
          onClose={() => setConfirmDelete(false)}
        />
      )}
    </div>
  );
}

function RolesTab({ roles, api, reload, onToast, onDirtyChange, nudge = 0, serverId }) {
  const [selectedId, setSelectedId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [dragId, setDragId] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [confirmAdmin, setConfirmAdmin] = useState(false);
  const [showPresets, setShowPresets] = useState(false);
  // Switching to another role with edits pending is refused the same way
  // leaving the tab is: the save bar shakes.
  const [localNudge, setLocalNudge] = useState(0);

  /**
   * Drop role A onto role B: rebuild the order and send it as a list, highest
   * first. The server rejects any move that would put a role at or above the
   * actor's own highest role, so hierarchy stays enforced server-side.
   */
  const moveRole = async (roleId, to) => {
    const ordered = roles.filter((r) => !r.is_everyone).map((r) => r.id);
    const from = ordered.indexOf(roleId);
    if (from === -1 || to < 0 || to >= ordered.length || from === to) return false;
    ordered.splice(to, 0, ordered.splice(from, 1)[0]);
    try {
      await api('/roles/order', { method: 'PUT', body: { order: ordered } });
      await reload();
      return true;
    } catch (err) { onToast?.(err.message, { type: 'error' }); return false; }
  };

  const dropOn = async (targetId) => {
    const source = dragId;
    setDragId(null);
    if (!source || source === targetId) return;
    const to = roles.filter((r) => !r.is_everyone).findIndex((r) => r.id === targetId);
    await moveRole(source, to);
  };

  /** Keyboard alternative to dragging: Move up / Move down, and Alt+↑/↓. */
  const nudgeRole = async (roleId, delta) => {
    const list = roles.filter((r) => !r.is_everyone);
    const from = list.findIndex((r) => r.id === roleId);
    const moved = await moveRole(roleId, from + delta);
    if (moved) {
      onToast?.(t('roles.moved', { name: list[from].name, position: from + delta + 1 }), { type: 'success', ttl: 1500 });
    }
  };

  const selected = roles.find((r) => r.id === selectedId) ?? null;

  useEffect(() => {
    if (!selectedId && roles.length) setSelectedId(roles[0].id);
  }, [roles, selectedId]);

  useEffect(() => {
    setDraft(selected ? { ...selected } : null);
  }, [selectedId, selected?.permissions, selected?.name, selected?.color, selected?.style, selected?.color_secondary, selected?.gradient_angle]);

  const dirty = draft && selected && (
    draft.name !== selected.name ||
    draft.color !== selected.color ||
    (draft.color_secondary ?? null) !== (selected.color_secondary ?? null) ||
    styleOf(draft) !== styleOf(selected) ||
    Number(draft.gradient_angle ?? 90) !== Number(selected.gradient_angle ?? 90) ||
    String(draft.permissions) !== String(selected.permissions) ||
    Boolean(draft.hoist) !== Boolean(selected.hoist) ||
    Boolean(draft.mentionable) !== Boolean(selected.mentionable)
  );
  useReportDirty(dirty, onDirtyChange);

  const selectRole = (id) => {
    if (id === selectedId) return;
    if (dirty) { setLocalNudge((n) => n + 1); return; }
    setSelectedId(id);
  };

  // New roles land at the bottom (just above @everyone), as on Discord.
  const createRole = async (preset = null) => {
    if (dirty) { setLocalNudge((n) => n + 1); return; }
    setShowPresets(false);
    try {
      const created = await api('/roles', {
        method: 'POST',
        body: preset
          ? { name: t(`adm.rolePreset.${preset.key}`), color: preset.color, permissions: preset.permissions, hoist: preset.hoist }
          : { name: t('roles.newRoleName'), color: '#99aab5', permissions: '0' }
      });
      await reload();
      // Land on the new role, ready to be named — as Discord does.
      if (created?.id) setSelectedId(created.id);
      onToast?.(t('roles.created'), { type: 'success', ttl: 2500 });
    } catch (err) { onToast?.(err.message, { type: 'error' }); }
  };

  const save = async () => {
    setSaving(true);
    try {
      await api(`/roles/${draft.id}`, {
        method: 'PATCH',
        body: {
          name: draft.name, color: draft.color, color_secondary: draft.color_secondary ?? null,
          style: styleOf(draft), gradient_angle: Number(draft.gradient_angle ?? 90),
          permissions: String(draft.permissions),
          hoist: Boolean(draft.hoist), mentionable: Boolean(draft.mentionable)
        }
      });
      await reload();
      onToast?.(t('roles.savedRole'), { type: 'success', ttl: 2500 });
    } catch (err) { onToast?.(err.message, { type: 'error' }); }
    finally { setSaving(false); }
  };

  // Throws on failure so the confirm dialog stays open and shows why.
  const remove = async (role) => {
    await api(`/roles/${role.id}`, { method: 'DELETE' });
    setSelectedId(null);
    await reload();
    onToast?.(t('roles.deleted', { name: role.name }), { type: 'success', ttl: 2500 });
  };

  const isAdmin = draft && hasBit(draft.permissions, 'ADMINISTRATOR');

  /** Turning ADMINISTRATOR on is confirmed; turning it off is not. */
  const toggleAdministrator = () => {
    if (!hasBit(draft.permissions, 'ADMINISTRATOR')) { setConfirmAdmin(true); return; }
    setDraft({ ...draft, permissions: toggleBit(draft.permissions, 'ADMINISTRATOR') });
  };

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
        <h1 className="text-xl font-bold text-d-strong">{t('settings.roles')}</h1>
        <div className="relative flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowPresets((v) => !v)}
            aria-expanded={showPresets}
            aria-controls="role-presets"
            className="min-h-[32px] flex items-center gap-1 bg-d-surface hover:bg-d-hover text-d-strong text-xs font-semibold px-3 py-1.5 rounded border border-d-divider"
          >
            {t('adm.rolePresets')} <ChevronDown className="w-3.5 h-3.5" aria-hidden="true" />
          </button>
          <button
            onClick={() => createRole()}
            className="min-h-[32px] flex items-center gap-1 bg-d-brand hover:bg-d-brandhover text-white text-xs font-semibold px-3 py-1.5 rounded transition-colors"
          >
            <Plus className="w-3.5 h-3.5" aria-hidden="true" /> {t('roles.create')}
          </button>
          {showPresets && (
            <ul id="role-presets" className="absolute right-0 top-full mt-1 z-20 w-64 bg-d-sunken border border-d-divider rounded-md shadow-xl p-1">
              {ROLE_PRESETS.map((preset) => (
                <li key={preset.key}>
                  <button
                    type="button"
                    onClick={() => createRole(preset)}
                    className="w-full text-left px-2 py-2 rounded hover:bg-d-brand hover:text-white text-d-text group/preset"
                  >
                    <span className="flex items-center gap-2 text-sm font-semibold">
                      <span className="w-3 h-3 rounded-full" style={{ backgroundColor: preset.color }} aria-hidden="true" />
                      {t(`adm.rolePreset.${preset.key}`)}
                    </span>
                    <span className="block text-[11px] text-d-text2 group-hover/preset:text-white">{t(`adm.rolePreset.${preset.key}Hint`)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <p className="text-xs text-d-text2 mb-4">{t('adm.rolesOrderHint')}</p>

      <div className="flex max-md:flex-col gap-6">
        {/* Role list, highest first — the same order that decides hierarchy. */}
        <div className="md:w-52 w-full shrink-0 space-y-0.5 max-md:max-h-56 max-md:overflow-y-auto">
          {roles.map((role, index) => {
            const movable = !role.is_everyone;
            const lastMovable = roles.filter((r) => !r.is_everyone).length - 1;
            return (
            <div key={role.id} className="group/role relative flex items-center">
            <button
              onClick={() => selectRole(role.id)}
              onKeyDown={(e) => {
                if (!movable || !e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
                e.preventDefault();
                nudgeRole(role.id, e.key === 'ArrowUp' ? -1 : 1);
              }}
              aria-current={selectedId === role.id ? 'true' : undefined}
              aria-keyshortcuts={movable ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
              draggable={!role.is_everyone}
              onDragStart={() => setDragId(role.id)}
              onDragOver={(e) => { if (dragId && !role.is_everyone) e.preventDefault(); }}
              onDrop={() => dropOn(role.id)}
              onDragEnd={() => setDragId(null)}
              title={role.is_everyone ? undefined : t('roles.dragToReorder')}
              className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-left transition-colors ${
                selectedId === role.id ? 'bg-d-active' : 'hover:bg-d-hover'
              } ${dragId === role.id ? 'opacity-40' : ''}`}
            >
              <GripVertical className={`w-3 h-3 shrink-0 ${role.is_everyone ? 'text-transparent' : 'text-d-control cursor-grab'}`} />
              <span
                className="w-3 h-3 rounded-full shrink-0 border border-black/20"
                style={{ backgroundColor: role.color || '#99aab5' }}
              />
              <span className="text-sm text-d-strong truncate flex-1 inline-flex items-center gap-1 min-w-0">
                <span className="truncate">{role.name}</span>
                <RoleIcon role={role} size={14} force />
              </span>
              <span className="text-[10px] text-d-text3 shrink-0 group-hover/role:invisible group-focus-within/role:invisible">{role.member_count}</span>
            </button>
            {movable && (
              <span className="absolute right-1 flex opacity-0 group-hover/role:opacity-100 group-focus-within/role:opacity-100">
                <button
                  type="button"
                  onClick={() => nudgeRole(role.id, -1)}
                  disabled={index === 0}
                  aria-label={t('roles.moveUp', { name: role.name })}
                  title={t('roles.moveUp', { name: role.name })}
                  className="p-0.5 rounded text-d-text3 hover:text-d-strong hover:bg-d-hover disabled:opacity-30"
                >
                  <ChevronUp className="w-3.5 h-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => nudgeRole(role.id, 1)}
                  disabled={index >= lastMovable}
                  aria-label={t('roles.moveDown', { name: role.name })}
                  title={t('roles.moveDown', { name: role.name })}
                  className="p-0.5 rounded text-d-text3 hover:text-d-strong hover:bg-d-hover disabled:opacity-30"
                >
                  <ChevronDown className="w-3.5 h-3.5" />
                </button>
              </span>
            )}
            </div>
            );
          })}
        </div>

        {/* Editor */}
        {draft && (
          <div className="flex-1 min-w-0">
            {/* Which role you are editing stays in view while you scroll. */}
            <div className="sticky top-0 z-10 bg-d-canvas py-2 mb-2 border-b border-d-divider flex items-center gap-2">
              <span className="w-3 h-3 rounded-full shrink-0" style={{ backgroundColor: draft.color || '#99aab5' }} aria-hidden="true" />
              <span className="text-sm font-bold text-d-strong truncate">{t('adm.editingRole', { name: draft.name || selected?.name || '' })}</span>
            </div>
            {Boolean(draft.is_everyone) && (
              <p className="text-xs text-d-text3 bg-d-surface rounded p-2.5 mb-4">
                {t('roles.everyoneNote')}
              </p>
            )}

            {!draft.is_everyone && (
              <>
                <Field label={t('roles.roleName')}>
                  <input
                    value={draft.name}
                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                    className="w-full bg-d-base text-sm text-d-strong px-3 py-2 rounded border border-d-edge focus:outline-none focus:border-d-brand"
                  />
                </Field>

                {/* Colour, style (solid / gradient / holographic), icon and preview. */}
                <RoleStyleEditor
                  draft={draft}
                  setDraft={setDraft}
                  serverId={serverId}
                  onToast={onToast}
                  onIconSaved={(role) => {
                    setDraft((d) => ({ ...d, icon_url: role.icon_url, unicode_emoji: role.unicode_emoji, icon_file_id: role.icon_file_id }));
                    reload();
                  }}
                />
                <div className="flex max-sm:flex-col gap-3 sm:gap-6 mt-4">
                  <Toggle
                    label={t('roles.displaySeparately')}
                    checked={Boolean(draft.hoist)}
                    onChange={(v) => setDraft({ ...draft, hoist: v })}
                  />
                  <Toggle
                    label={t('roles.allowMentions')}
                    checked={Boolean(draft.mentionable)}
                    onChange={(v) => setDraft({ ...draft, mentionable: v })}
                  />
                </div>
              </>
            )}

            <div className="mt-6 flex items-center justify-between">
              <h3 className="text-sm font-bold text-d-strong">
                {t('roles.permissions')} <span className="text-d-text3 font-normal">
                  {t('roles.permissionCount', { count: countPermissions(draft.permissions) })}
                </span>
              </h3>
              {!draft.is_everyone && !draft.managed && (
                <button
                  onClick={() => setConfirmDelete(draft)}
                  className="flex items-center gap-1 text-xs text-d-danger hover:underline"
                >
                  <Trash2 className="w-3.5 h-3.5" aria-hidden="true" /> {t('roles.delete')}
                </button>
              )}
            </div>

            {isAdmin && (
              <div className="flex items-start gap-2 bg-d-idle/10 border border-d-idle/40 rounded p-2.5 mt-3">
                <AlertTriangle className="w-4 h-4 text-d-idle shrink-0 mt-0.5" />
                <p className="text-xs text-d-idle">
                  {t('roles.adminWarning')}
                </p>
              </div>
            )}

            <div className="mt-4 space-y-5">
              {permissionGroups().map((group) => (
                <div key={group.key}>
                  <h4 className="text-[11px] font-bold text-d-text3 uppercase mb-2">{group.title}</h4>
                  <div className="space-y-1">
                    {group.items.map(([name, label, description]) => (
                      <PermissionRow
                        key={name}
                        label={label}
                        description={description}
                        checked={hasBit(draft.permissions, name)}
                        // ADMINISTRATOR implies everything; show the rest as
                        // forced-on rather than silently ignored.
                        forced={isAdmin && name !== 'ADMINISTRATOR'}
                        onToggle={() => setDraft({ ...draft, permissions: toggleBit(draft.permissions, name) })}
                      />
                    ))}
                  </div>
                </div>
              ))}

              <div>
                <h4 className="text-[11px] font-bold text-d-text2 uppercase mb-2">{t('roles.advanced')}</h4>
                <PermissionRow
                  label={t('roles.administrator')}
                  description={t('roles.administratorHint')}
                  checked={hasBit(draft.permissions, 'ADMINISTRATOR')}
                  danger
                  onToggle={toggleAdministrator}
                />
                {isAdmin && (
                  <div role="alert" className="flex items-start gap-2 bg-d-danger/10 border border-d-danger/50 rounded p-2.5 mt-2">
                    <AlertTriangle className="w-4 h-4 text-d-danger shrink-0 mt-0.5" aria-hidden="true" />
                    <p className="text-xs text-d-text">{t('adm.adminWarningStrong')}</p>
                  </div>
                )}
                <p className="text-[11px] text-d-text2 mt-3">{t('adm.mutedRoleTip')}</p>
              </div>
            </div>

            {dirty && (
              <UnsavedBar
                nudge={nudge + localNudge}
                onReset={() => setDraft({ ...selected })}
                onSave={save}
                saving={saving}
                saveDisabled={!draft.name.trim()}
              />
            )}
          </div>
        )}
      </div>

      {confirmAdmin && (
        <ConfirmModal
          title={t('adm.adminConfirmTitle', { name: draft?.name ?? '' })}
          body={t('adm.adminConfirmBody')}
          confirmLabel={t('adm.adminConfirm')}
          onConfirm={() => setDraft((d) => ({ ...d, permissions: toggleBit(d.permissions, 'ADMINISTRATOR') }))}
          onClose={() => setConfirmAdmin(false)}
        />
      )}

      {confirmDelete && (
        <ConfirmModal
          title={t('roles.deleteTitle', { name: confirmDelete.name })}
          body={t('roles.deleteBody', { count: confirmDelete.member_count ?? 0 })}
          confirmLabel={t('roles.delete')}
          onConfirm={() => remove(confirmDelete)}
          onClose={() => setConfirmDelete(null)}
        />
      )}
    </div>
  );
}

function PermissionRow({ label, description, checked, onToggle, danger, forced }) {
  const on = Boolean(checked || forced);
  const descId = useMemo(() => `perm-desc-${Math.random().toString(36).slice(2, 9)}`, []);
  return (
    <div className="flex items-start justify-between gap-4 py-2 border-b border-d-divider/40">
      <div className="min-w-0">
        <p className={`text-sm ${danger ? 'text-d-danger font-semibold' : 'text-d-strong'}`}>{label}</p>
        <p id={descId} className="text-[11px] text-d-text2">{description}</p>
      </div>
      <button
        role="switch"
        aria-checked={on}
        aria-label={label}
        aria-describedby={descId}
        disabled={forced}
        onClick={onToggle}
        className={`shrink-0 w-10 h-6 rounded-full transition-colors relative ${
          on ? (danger ? 'bg-d-danger' : 'bg-d-online') : 'bg-d-text4'
        } ${forced ? 'opacity-50 cursor-not-allowed' : ''}`}
      >
        <span
          className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${on ? 'left-5' : 'left-1'}`}
        />
      </button>
    </div>
  );
}

function Toggle({ label, checked, onChange }) {
  return (
    <label className="flex items-center gap-2 cursor-pointer">
      <button
        type="button"
        role="switch" aria-checked={Boolean(checked)} aria-label={label} onClick={() => onChange(!checked)}
        className={`w-10 h-6 shrink-0 rounded-full transition-colors relative ${checked ? 'bg-d-online' : 'bg-d-text4'}`}
      >
        <span className={`absolute top-1 w-4 h-4 bg-white rounded-full transition-all ${checked ? 'left-5' : 'left-1'}`} />
      </button>
      <span className="text-xs text-d-text">{label}</span>
    </label>
  );
}

// --- Members -----------------------------------------------------------------

function MembersTab({ members, roles, server, api, reload, onToast, currentUserId, can, isOwner }) {
  const [search, setSearch] = useState('');
  const [openMenuFor, setOpenMenuFor] = useState(null);
  const [nicknameFor, setNicknameFor] = useState(null);
  const [nickname, setNickname] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState(null);   // { kind: 'transfer', member }
  const [modAction, setModAction] = useState(null);   // { kind: 'ban'|'kick'|'timeout', targets }
  const [selected, setSelected] = useState(() => new Set());
  const [joinedWithin, setJoinedWithin] = useState('');   // '' | minutes
  const [sort, setSort] = useState('oldest');
  const nameOf = (m) => m.nickname || m.display_name || m.username;

  const saveNickname = async (member) => {
    setBusy(true);
    try {
      await api(`/members/${member.id}`, {
        method: 'PATCH', body: { nickname: nickname.trim() || null }
      });
      setNicknameFor(null);
      await reload();
    } catch (err) { onToast?.(err.message, { type: 'error' }); }
    finally { setBusy(false); }
  };

  const timeout = async (member, minutes) => {
    try {
      await api(`/timeouts/${member.id}`, {
        method: 'POST',
        body: {
          until: new Date(Date.now() + minutes * 60_000).toISOString(),
          reason: t('audit.reasonFromSettings')
        }
      });
      await reload();
      onToast?.(
        minutes > 0
          ? t('members.timedOut', { name: member.nickname || member.display_name, minutes })
          : t('members.timeoutRemoved', { name: member.nickname || member.display_name }),
        { type: 'success', ttl: 2500 }
      );
    } catch (err) { onToast?.(err.message, { type: 'error' }); }
  };

  // Kick, ban and ownership transfer go through a confirm dialog; these throw
  // so the dialog stays open and shows the server's reason on failure.
  const transferOwnership = async (member) => {
    await api('/transfer-ownership', { method: 'POST', body: { userId: member.id } });
    await reload();
    onToast?.(t('members.ownershipTransferred', { name: member.nickname || member.display_name }), { type: 'success' });
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let list = members;
    if (q) {
      list = list.filter((m) =>
        (m.display_name ?? '').toLowerCase().includes(q) ||
        (m.username ?? '').toLowerCase().includes(q) ||
        (m.nickname ?? '').toLowerCase().includes(q)
      );
    }
    if (joinedWithin === 'timedout') {
      const now = new Date().toISOString();
      list = list.filter((m) => m.timeout_until && m.timeout_until > now);
    } else if (joinedWithin) {
      const since = Date.now() - Number(joinedWithin) * 60_000;
      list = list.filter((m) => Date.parse(m.joined_at) >= since);
    }
    const byJoin = (a, b) => Date.parse(a.joined_at) - Date.parse(b.joined_at);
    return [...list].sort(sort === 'newest' ? (a, b) => byJoin(b, a) : byJoin);
  }, [members, search, joinedWithin, sort]);

  /** Who a moderator may select: never the owner, never themselves. */
  const selectable = (m) => server.owner_id !== m.id && m.id !== currentUserId;
  const selectableVisible = filtered.filter(selectable);
  const allSelected = selectableVisible.length > 0 && selectableVisible.every((m) => selected.has(m.id));
  const toggleSelected = (id) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const selectedMembers = members.filter((m) => selected.has(m.id));
  const openBulk = (kind) => setModAction({ kind, targets: selectedMembers.map((m) => ({ id: m.id, name: nameOf(m) })) });
  const canBulk = can('BAN_MEMBERS') || can('KICK_MEMBERS') || can('MODERATE_MEMBERS');

  const toggleRole = async (member, role) => {
    const has = member.roles.some((r) => r.id === role.id);
    setBusy(true);
    try {
      await api(`/members/${member.id}/roles/${role.id}`, { method: has ? 'DELETE' : 'PUT' });
      await reload();
    } catch (err) { onToast?.(err.message, { type: 'error' }); }
    finally { setBusy(false); }
  };

  const afterModeration = async ({ done, kind, minutes }) => {
    setSelected(new Set());
    await reload();
    if (done.length === 0) return;
    const message = done.length === 1
      ? (kind === 'ban' ? t('members.banned', { name: done[0].name })
        : kind === 'kick' ? t('members.kicked', { name: done[0].name })
        : t('members.timedOut', { name: done[0].name, minutes }))
      : t(`adm.${kind}Done`, { count: done.length });
    onToast?.(message, { type: 'success', ttl: 3000 });
  };

  return (
    <div>
      <h1 className="text-xl font-bold text-d-strong mb-1">{t('members.count', { count: members.length })}</h1>
      <div className="flex max-sm:flex-col gap-2 mb-3 mt-4">
        <div className="relative flex-1">
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('members.searchMembers')}
            aria-label={t('members.searchMembers')}
            className="w-full min-h-[40px] bg-d-base text-sm text-d-strong px-3 py-2 pr-8 rounded border border-d-edge focus:outline-none focus:border-d-brand"
          />
          <Search className="w-4 h-4 text-d-text3 absolute right-2.5 top-3" aria-hidden="true" />
        </div>
        <label className="flex items-center gap-1.5 text-xs text-d-text2">
          <Filter className="w-3.5 h-3.5" aria-hidden="true" />
          <span className="sr-only">{t('adm.memberFilter')}</span>
          <select
            value={joinedWithin}
            onChange={(e) => setJoinedWithin(e.target.value)}
            className="min-h-[40px] bg-d-base text-sm text-d-strong px-2 py-2 rounded border border-d-edge focus:outline-none"
          >
            <option value="">{t('adm.filterAll')}</option>
            <option value="10">{t('adm.filterJoined10m')}</option>
            <option value="60">{t('adm.filterJoined1h')}</option>
            <option value="1440">{t('adm.filterJoined24h')}</option>
            <option value="timedout">{t('adm.filterTimedOut')}</option>
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-xs text-d-text2">
          <span className="sr-only">{t('adm.sortBy')}</span>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            className="min-h-[40px] bg-d-base text-sm text-d-strong px-2 py-2 rounded border border-d-edge focus:outline-none"
          >
            <option value="oldest">{t('adm.sortOldest')}</option>
            <option value="newest">{t('adm.sortNewest')}</option>
          </select>
        </label>
      </div>

      {canBulk && selectableVisible.length > 0 && (
        <div className={`sticky top-0 z-10 flex flex-wrap items-center gap-2 mb-2 px-3 py-2 rounded-lg ${selected.size ? 'bg-d-brand/15 border border-d-brand/50' : 'bg-d-surface'}`}>
          <label className="flex items-center gap-2 text-sm text-d-text min-h-[32px]">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={() => setSelected(allSelected ? new Set() : new Set(selectableVisible.map((m) => m.id)))}
              className="w-4 h-4 accent-[var(--color-d-brand)]"
            />
            {selected.size ? t('adm.selectedCount', { count: selected.size }) : t('adm.selectAll')}
          </label>
          {selected.size > 0 && (
            <div className="flex flex-wrap gap-2 ml-auto">
              {can('MODERATE_MEMBERS') && (
                <button type="button" onClick={() => openBulk('timeout')} className="min-h-[32px] flex items-center gap-1 px-3 py-1 rounded bg-d-canvas text-d-strong text-xs font-semibold border border-d-divider hover:bg-d-hover">
                  <Clock className="w-3.5 h-3.5" aria-hidden="true" /> {t('members.timeout')}
                </button>
              )}
              {can('KICK_MEMBERS') && (
                <button type="button" onClick={() => openBulk('kick')} className="min-h-[32px] flex items-center gap-1 px-3 py-1 rounded bg-d-canvas text-d-strong text-xs font-semibold border border-d-divider hover:bg-d-hover">
                  <LogOut className="w-3.5 h-3.5" aria-hidden="true" /> {t('members.kick')}
                </button>
              )}
              {can('BAN_MEMBERS') && (
                <button type="button" onClick={() => openBulk('ban')} className="min-h-[32px] flex items-center gap-1 px-3 py-1 rounded bg-d-danger text-white text-xs font-semibold hover:bg-d-dangerhover">
                  <Ban className="w-3.5 h-3.5" aria-hidden="true" /> {t('members.ban')}
                </button>
              )}
              <button type="button" onClick={() => setSelected(new Set())} className="min-h-[32px] px-2 text-xs text-d-text2 hover:underline">
                {t('adm.clearSelection')}
              </button>
            </div>
          )}
        </div>
      )}

      <div className="space-y-1">
        {filtered.map((member) => {
          const created = accountCreatedAt(member.id);
          const newAccount = created && Date.now() - created.getTime() < 24 * 3600_000;
          return (
          <div key={member.id} className={`bg-d-surface rounded-lg p-3 ${selected.has(member.id) ? 'ring-2 ring-d-brand' : ''}`}>
            <div className="flex items-center gap-3">
              {canBulk && (
                selectable(member) ? (
                  <input
                    type="checkbox"
                    checked={selected.has(member.id)}
                    onChange={() => toggleSelected(member.id)}
                    aria-label={t('adm.selectMember', { name: nameOf(member) })}
                    className="w-4 h-4 shrink-0 accent-[var(--color-d-brand)]"
                  />
                ) : <span className="w-4 shrink-0" />
              )}
              <img src={proxiedImageUrl(member.avatar_url || defaultAvatar(member.id))} alt="" className="w-9 h-9 rounded-full object-cover shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-d-strong truncate flex items-center gap-1.5">
                  {member.nickname || member.display_name}
                  {server.owner_id === member.id && <Crown className="w-3.5 h-3.5 text-d-idle" title={t('members.ownerTitle')} />}
                  {Boolean(member.is_bot) && <span className="bg-d-brand text-white text-[9px] font-bold px-1 rounded">BOT</span>}
                  {Boolean(member.timeout_until) && member.timeout_until > new Date().toISOString() && (
                    <span className="bg-d-idle/20 text-d-idle text-[9px] font-bold px-1 rounded flex items-center gap-0.5">
                      <Clock className="w-2.5 h-2.5" />
                      {t('members.timedOutUntil', { time: new Date(member.timeout_until).toLocaleString(localeTag()) })}
                    </span>
                  )}
                </p>
                <p className="text-[11px] text-d-text2 truncate">
                  @{member.username} · {t('adm.joinedAt', { date: formatDate(member.joined_at, { dateStyle: 'medium', timeStyle: 'short' }) })}
                </p>
                {created && (
                  <p className="text-[11px] text-d-text2 truncate flex items-center gap-1.5">
                    {t('adm.accountCreated', { when: formatRelative(created) })}
                    {newAccount && (
                      <span className="bg-d-idle text-black text-[9px] font-bold px-1 rounded">{t('adm.newAccount')}</span>
                    )}
                  </p>
                )}
              </div>
              <button
                onClick={() => setOpenMenuFor(openMenuFor === member.id ? null : member.id)}
                className="text-xs text-d-link hover:underline shrink-0"
              >
                {openMenuFor === member.id ? t('common.close') : t('members.manage')}
              </button>
            </div>

            <div className="flex flex-wrap gap-1 mt-2 pl-12">
              {member.roles.filter((r) => !r.name.startsWith('@')).map((role) => (
                <span
                  key={role.id}
                  className="text-[10px] px-1.5 py-0.5 rounded flex items-center gap-1"
                  style={{ backgroundColor: `${role.color ?? '#4e5058'}33`, color: role.color ?? '#dbdee1' }}
                >
                  <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: role.color ?? '#dbdee1' }} />
                  {role.name}
                </span>
              ))}
            </div>

            {openMenuFor === member.id && (
              <div className="mt-3 pt-3 border-t border-d-divider/50 pl-12">
                <p className="text-[11px] font-bold text-d-text3 uppercase mb-1.5">{t('members.assignRoles')}</p>
                <div className="flex flex-wrap gap-1.5 mb-3">
                  {roles.filter((r) => !r.is_everyone && !r.managed).map((role) => {
                    const has = member.roles.some((r) => r.id === role.id);
                    return (
                      <button
                        key={role.id}
                        onClick={() => toggleRole(member, role)}
                        disabled={busy}
                        aria-pressed={has}
                        className={`text-[11px] px-2 py-1 rounded border transition-colors ${
                          has
                            ? 'border-transparent text-d-strong'
                            : 'border-d-control text-d-text2 hover:border-d-text'
                        }`}
                        style={has ? { backgroundColor: role.color ?? '#5865f2' } : undefined}
                      >
                        {has ? '✓ ' : '+ '}{role.name}
                      </button>
                    );
                  })}
                </div>

                {(can('MANAGE_NICKNAMES') || (member.id === currentUserId && can('CHANGE_NICKNAME'))) && (
                  nicknameFor === member.id ? (
                    <div className="flex items-center gap-2 mb-3">
                      <input
                        value={nickname}
                        onChange={(e) => setNickname(e.target.value)}
                        maxLength={32}
                        placeholder={member.username}
                        aria-label={t('members.nickname')}
                        className="flex-1 bg-d-base text-xs text-d-strong px-2 py-1.5 rounded border border-d-edge focus:outline-none focus:border-d-brand"
                      />
                      <button
                        onClick={() => saveNickname(member)}
                        disabled={busy}
                        className="text-[11px] bg-d-brand hover:bg-d-brandhover text-white px-2.5 py-1.5 rounded"
                      >
                        {t('common.save')}
                      </button>
                      <button onClick={() => setNicknameFor(null)} className="text-[11px] text-d-text3 hover:underline">
                        {t('common.cancel')}
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => { setNicknameFor(member.id); setNickname(member.nickname ?? ''); }}
                      className="text-[11px] text-d-link hover:underline flex items-center gap-1 mb-3"
                    >
                      <Pencil className="w-3 h-3" /> {t('members.changeNickname')}
                    </button>
                  )
                )}

                {server.owner_id !== member.id && member.id !== currentUserId && (
                  <div className="flex flex-wrap items-center gap-3">
                    {can('MODERATE_MEMBERS') && (
                      member.timeout_until && member.timeout_until > new Date().toISOString() ? (
                        <button onClick={() => timeout(member, 0)} className="text-[11px] text-d-link hover:underline flex items-center gap-1">
                          <Clock className="w-3 h-3" /> {t('members.removeTimeout')}
                        </button>
                      ) : (
                        <label className="text-[11px] text-d-text2 flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          <select
                            defaultValue=""
                            onChange={(e) => { if (e.target.value) { timeout(member, Number(e.target.value)); e.target.value = ''; } }}
                            aria-label={t('members.timeout')}
                            className="bg-d-base text-[11px] text-d-strong px-1.5 py-1 rounded border border-d-edge focus:outline-none"
                          >
                            <option value="">{t('members.timeout')}</option>
                            <option value="1">{t('adm.timeout60s')}</option>
                            <option value="5">{t('members.timeout5m')}</option>
                            <option value="10">{t('members.timeout10m')}</option>
                            <option value="60">{t('members.timeout60m')}</option>
                            <option value="1440">{t('members.timeout1d')}</option>
                            <option value="10080">{t('members.timeout1w')}</option>
                          </select>
                        </label>
                      )
                    )}
                    {can('KICK_MEMBERS') && (
                      <button onClick={() => setModAction({ kind: 'kick', targets: [{ id: member.id, name: nameOf(member) }] })} className="min-h-[28px] text-[11px] text-d-text hover:underline">{t('members.kick')}</button>
                    )}
                    {can('BAN_MEMBERS') && (
                      <button onClick={() => setModAction({ kind: 'ban', targets: [{ id: member.id, name: nameOf(member) }] })} className="min-h-[28px] text-[11px] text-d-danger hover:underline">{t('members.ban')}</button>
                    )}
                    {isOwner && !member.is_bot && (
                      <button
                        onClick={() => setConfirm({ kind: 'transfer', member })}
                        className="text-[11px] text-d-idle hover:underline flex items-center gap-1"
                      >
                        <Crown className="w-3 h-3" /> {t('members.transferOwnership')}
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          );
        })}
        {filtered.length === 0 && members.length > 0 && (
          <p className="text-sm text-d-text2 py-4">
            {search.trim() ? t('members.noMatch', { query: search.trim() }) : t('adm.noMembersInFilter')}
          </p>
        )}
      </div>

      {modAction && (
        <ModerationDialog
          kind={modAction.kind}
          serverId={server.id}
          targets={modAction.targets}
          onDone={afterModeration}
          onClose={() => setModAction(null)}
        />
      )}

      {confirm && (() => {
        const name = confirm.member.nickname || confirm.member.display_name;
        const props = {
          transfer: {
            title: t('members.transferTitle', { name }), body: t('members.transferBody', { name }),
            confirmLabel: t('members.transferOwnership'),
            onConfirm: () => transferOwnership(confirm.member)
          }
        }[confirm.kind];
        return <ConfirmModal {...props} onClose={() => setConfirm(null)} />;
      })()}
    </div>
  );
}

// --- Emojis ------------------------------------------------------------------

function EmojisTab({ emojis, api, reload, onToast }) {
  const [name, setName] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const filePreview = useFilePreview(file);

  const submit = async (e) => {
    e.preventDefault();
    if (!file || !name.trim()) return;
    setBusy(true);
    try {
      const upload = await httpUpload('/api/upload/emoji', 'emoji', file);
      await api('/emojis', {
        method: 'POST',
        body: { name: name.trim(), fileId: upload.id, animated: upload.is_animated }
      });
      setName(''); setFile(null);
      await reload();
      onToast?.(t('emojiAdmin.added', { name }), { type: 'success', ttl: 2500 });
    } catch (err) { onToast?.(err.message, { type: 'error' }); }
    finally { setBusy(false); }
  };

  return (
    <div>
      <h1 className="text-xl font-bold text-d-strong mb-1">{t('chat.emoji')}</h1>
      <p className="text-xs text-d-text2 mb-5">
        {t('emojiAdmin.hint')}
      </p>

      <form onSubmit={submit} className="bg-d-surface rounded-lg p-4 mb-6 flex items-end gap-3">
        <label className="cursor-pointer">
          <div className="w-14 h-14 rounded bg-d-base border-2 border-dashed border-d-control flex items-center justify-center hover:border-d-brand transition-colors overflow-hidden">
            {file ? (
              <img src={filePreview} alt="" className="w-full h-full object-contain" />
            ) : (
              <Upload className="w-5 h-5 text-d-text4" />
            )}
          </div>
          <input type="file" accept="image/*" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </label>

        <div className="flex-1">
          <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">{t('common.name')}</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value.replace(/[^a-zA-Z0-9_]/g, ''))}
            placeholder="my_emoji"
            className="w-full bg-d-base text-sm text-d-strong px-3 py-2 rounded border border-d-edge focus:outline-none focus:border-d-brand"
          />
        </div>

        <button
          type="submit"
          disabled={busy || !file || !name.trim()}
          className="bg-d-brand hover:bg-d-brandhover disabled:opacity-40 text-white text-xs font-semibold px-4 py-2 rounded transition-colors"
        >
          {busy ? t('common.uploading') : t('common.upload')}
        </button>
      </form>

      <div className="grid grid-cols-[auto_1fr_auto_auto] gap-x-4 gap-y-1 items-center">
        <span className="text-[11px] font-bold text-d-text3 uppercase">{t('emojiAdmin.image')}</span>
        <span className="text-[11px] font-bold text-d-text3 uppercase">{t('common.name')}</span>
        <span className="text-[11px] font-bold text-d-text3 uppercase">{t('emojiAdmin.addedBy')}</span>
        <span />

        {emojis.map((emoji) => (
          <React.Fragment key={emoji.id}>
            <img src={proxiedImageUrl(emoji.url)} alt={emoji.name} className="w-8 h-8 object-contain" />
            <span className="text-sm text-d-strong truncate">:{emoji.name}:</span>
            <span className="text-xs text-d-text3 truncate">{emoji.creator_name ?? '—'}</span>
            <button
              onClick={async () => {
                try {
                  await api(`/emojis/${emoji.id}`, { method: 'DELETE' });
                  await reload();
                } catch (err) { onToast?.(err.message, { type: 'error' }); }
              }}
              className="text-d-text3 hover:text-d-danger transition-colors p-1"
              aria-label={t('common.deleteNamed', { name: emoji.name })}
            >
              <X className="w-4 h-4" />
            </button>
          </React.Fragment>
        ))}
      </div>

      {emojis.length === 0 && (
        <p className="text-sm text-d-text3 mt-2">{t('emojiAdmin.none')}</p>
      )}
    </div>
  );
}

// --- Invites -----------------------------------------------------------------

function InvitesTab({ invites, api, reload, channels, onToast }) {
  const [channelId, setChannelId] = useState('');
  const [maxUses, setMaxUses] = useState(0);
  const [maxAge, setMaxAge] = useState(86400);

  const create = async () => {
    try {
      const invite = await api('/invites', {
        method: 'POST',
        body: { channelId: channelId || null, maxUses: Number(maxUses), maxAge: Number(maxAge) }
      });
      await reload();
      navigator.clipboard?.writeText(`${window.location.origin}/invite/${invite.code}`);
      onToast?.(t('invites.created', { code: invite.code }), { type: 'success' });
    } catch (err) { onToast?.(err.message, { type: 'error' }); }
  };

  return (
    <div>
      <h1 className="text-xl font-bold text-d-strong mb-5">{t('settings.invites')}</h1>

      <div className="bg-d-surface rounded-lg p-4 mb-6 grid grid-cols-4 gap-3 items-end">
        <Field label={t('autocomplete.channels')}>
          <ChannelSelect value={channelId} options={channels.filter((c) => c.type === 'text')} onChange={setChannelId} />
        </Field>
        <Field label={t('invites.maxUses')}>
          <select value={maxUses} onChange={(e) => setMaxUses(e.target.value)}
            className="w-full bg-d-base text-sm text-d-strong px-3 py-2 rounded border border-d-edge focus:outline-none">
            <option value={0}>{t('invites.unlimited')}</option>
            <option value={1}>{t('invites.usesOption', { count: 1 })}</option>
            <option value={5}>{t('invites.usesOption', { count: 5 })}</option>
            <option value={25}>{t('invites.usesOption', { count: 25 })}</option>
          </select>
        </Field>
        <Field label={t('invites.expiry')}>
          <select value={maxAge} onChange={(e) => setMaxAge(e.target.value)}
            className="w-full bg-d-base text-sm text-d-strong px-3 py-2 rounded border border-d-edge focus:outline-none">
            <option value={1800}>{t('invites.minutes30')}</option>
            <option value={86400}>{t('invites.day1')}</option>
            <option value={604800}>{t('invites.days7')}</option>
            <option value={0}>{t('invites.never')}</option>
          </select>
        </Field>
        <button onClick={create} className="bg-d-brand hover:bg-d-brandhover text-white text-xs font-semibold px-4 py-2 rounded transition-colors">
          {t('invites.createLink')}
        </button>
      </div>

      <div className="space-y-1">
        {invites.length === 0 && <p className="text-sm text-d-text3">{t('invites.none')}</p>}
        {invites.map((invite) => (
          <div key={invite.code} className="bg-d-surface rounded-lg p-3 flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-mono text-d-strong">{invite.code}</p>
              <p className="text-[11px] text-d-text3">
                {invite.inviter_name ? t('invites.by', { name: invite.inviter_name }) : ''}
                {invite.channel_name ? ` · #${invite.channel_name}` : ''}
                {' · '}{t('invites.usedCount', { count: invite.uses })}{invite.max_uses > 0 ? `/${invite.max_uses}` : ''}
                {invite.expires_at
                    ? ` · ${t('invites.expiresAt', { date: new Date(invite.expires_at).toLocaleString(localeTag()) })}`
                    : ` · ${t('invites.neverExpires')}`}
              </p>
            </div>
            <button
              onClick={() => navigator.clipboard?.writeText(`${window.location.origin}/invite/${invite.code}`)}
              className="text-xs text-d-link hover:underline shrink-0"
            >
              {t('common.copy')}
            </button>
            <button
              onClick={async () => {
                try { await api(`/invites/${invite.code}`, { method: 'DELETE' }); await reload(); }
                catch (err) { onToast?.(err.message, { type: 'error' }); }
              }}
              className="text-d-text3 hover:text-d-danger shrink-0"
              aria-label={t('invites.revoke')}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Bans --------------------------------------------------------------------

function BansTab({ bans, api, reload, onToast }) {
  // Unbanning lets someone straight back in; ask first, as Discord does.
  const [confirmUnban, setConfirmUnban] = useState(null);
  return (
    <div>
      <h1 className="text-xl font-bold text-d-strong mb-5">{t('bans.count', { count: bans.length })}</h1>
      {bans.length === 0 && <p className="text-sm text-d-text3">{t('bans.none')}</p>}
      <div className="space-y-1">
        {bans.map((ban) => (
          <div key={ban.user_id} className="bg-d-surface rounded-lg p-3 flex items-center gap-3">
            <img src={proxiedImageUrl(ban.avatar_url || defaultAvatar(ban.user_id))} alt="" className="w-9 h-9 rounded-full object-cover shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-d-strong truncate">{ban.display_name}</p>
              <p className="text-[11px] text-d-text3 truncate">
                @{ban.username}
                {ban.reason ? ` · ${t('bans.reason', { reason: ban.reason })}` : ''}
                {ban.moderator_name ? ` · ${t('bans.by', { name: ban.moderator_name })}` : ''}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setConfirmUnban(ban)}
              aria-label={`${t('bans.unban')} ${ban.display_name ?? ban.username}`}
              className="text-xs text-d-link hover:underline shrink-0"
            >
              {t('bans.unban')}
            </button>
          </div>
        ))}
      </div>
      {confirmUnban && (
        <ConfirmModal
          title={t('bans.unbanTitle', { name: confirmUnban.display_name ?? confirmUnban.username })}
          body={t('bans.unbanBody')}
          confirmLabel={t('bans.unban')}
          danger={false}
          onConfirm={async () => {
            await api(`/bans/${confirmUnban.user_id}`, { method: 'DELETE' });
            await reload();
            onToast?.(t('bans.unbanned'), { type: 'success', ttl: 2500 });
          }}
          onClose={() => setConfirmUnban(null)}
        />
      )}
    </div>
  );
}

// --- Audit log ---------------------------------------------------------------

function AuditTab({ entries, api, onToast }) {
  const [extra, setExtra] = useState([]);
  const [action, setAction] = useState('');
  const [actor, setActor] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  useEffect(() => { setExtra([]); setExhausted(false); }, [entries]);

  const all = useMemo(() => [...entries, ...extra], [entries, extra]);
  const actors = useMemo(() => {
    const map = new Map();
    for (const e of all) if (e.user_id && !map.has(e.user_id)) map.set(e.user_id, e.display_name || e.username || e.user_id);
    return [...map.entries()];
  }, [all]);
  const matchesAction = (type) => !action || (action.endsWith('*') ? type.startsWith(action.slice(0, -1)) : type === action);
  const visible = all.filter((e) => matchesAction(e.action_type) && (!actor || e.user_id === actor));

  const loadMore = async () => {
    const last = all[all.length - 1];
    if (!last) return;
    setLoadingMore(true);
    try {
      const params = new URLSearchParams({ limit: '100', before: last.id });
      if (action) params.set('action_type', action);
      if (actor) params.set('user_id', actor);
      const more = await api(`/audit-log?${params}`);
      const list = Array.isArray(more) ? more : [];
      setExtra((prev) => [...prev, ...list.filter((e) => !all.some((x) => x.id === e.id))]);
      if (list.length < 100) setExhausted(true);
    } catch (err) { onToast?.(err.message, { type: 'error' }); }
    finally { setLoadingMore(false); }
  };

  const targetNode = (entry) => {
    const target = entry.target;
    if (!target) return null;
    if (target.type === 'user') {
      return <strong className="text-d-strong">{entry.target_name ?? target.id}</strong>;
    }
    if (target.type === 'channel') {
      const Icon = target.channel_type === 'category' ? Folder : Hash;
      return (
        <strong className="text-d-strong inline-flex items-center gap-0.5">
          <Icon className="w-3.5 h-3.5" aria-hidden="true" />{target.name ?? t('adm.deletedChannel')}
        </strong>
      );
    }
    if (target.type === 'role') {
      return <strong style={target.color ? { color: target.color } : undefined} className={target.color ? '' : 'text-d-strong'}>@{target.name ?? t('adm.deletedRole')}</strong>;
    }
    return null;
  };

  return (
    <div>
      <h1 className="text-xl font-bold text-d-strong mb-3">{t('settings.auditLog')}</h1>
      <div className="flex max-sm:flex-col gap-2 mb-4">
        <label className="flex-1">
          <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1">{t('adm.filterByAction')}</span>
          <select value={action} onChange={(e) => setAction(e.target.value)}
            className="w-full min-h-[40px] bg-d-base text-sm text-d-strong px-2 py-2 rounded border border-d-edge focus:outline-none">
            {AUDIT_FILTERS().map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
          </select>
        </label>
        <label className="flex-1">
          <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1">{t('adm.filterByUser')}</span>
          <select value={actor} onChange={(e) => setActor(e.target.value)}
            className="w-full min-h-[40px] bg-d-base text-sm text-d-strong px-2 py-2 rounded border border-d-edge focus:outline-none">
            <option value="">{t('adm.allUsers')}</option>
            {actors.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </select>
        </label>
      </div>
      {visible.length === 0 && <p className="text-sm text-d-text2">{t('audit.none')}</p>}
      {/* Focusable so the list can be scrolled with the keyboard. */}
      <ol className="space-y-1" tabIndex={0} aria-label={t('settings.auditLog')}>
        {visible.map((entry) => (
          <li key={entry.id} className="bg-d-surface rounded-lg p-3 flex gap-3">
            <img src={proxiedImageUrl(entry.avatar_url || defaultAvatar(entry.user_id ?? 'system'))} alt="" className="w-8 h-8 rounded-full object-cover shrink-0" />
            <div className="min-w-0">
              <p className="text-sm text-d-text break-words">
                <strong className="text-d-strong">{entry.display_name ?? entry.username ?? t('audit.system')}</strong>{' '}
                <span className="text-d-text2">{auditLabels()[entry.action_type] ?? entry.action_type}</span>
                {targetNode(entry) && <>{' · '}{targetNode(entry)}</>}
              </p>
              {entry.changes?.length > 0 && (
                <ul className="text-[11px] text-d-text2 mt-0.5 space-y-0.5">
                  {entry.changes.slice(0, 4).map((change, i) => (
                    <li key={i} className="break-words">
                      {change.key}: {change.old !== undefined && change.old !== null && (
                        <><span className="line-through opacity-75">{String(change.old).slice(0, 60)}</span>{' → '}</>
                      )}
                      {String(change.new ?? '—').slice(0, 120)}
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-[11px] text-d-text2 mt-0.5">
                <time dateTime={entry.created_at}>{formatDate(entry.created_at, { dateStyle: 'medium', timeStyle: 'short' })}</time>
                {entry.reason ? ` · ${t('bans.reason', { reason: entry.reason })}` : ''}
              </p>
            </div>
          </li>
        ))}
      </ol>
      {all.length >= 100 && !exhausted && (
        <button type="button" onClick={loadMore} disabled={loadingMore}
          className="mt-3 min-h-[36px] px-4 py-2 rounded bg-d-surface hover:bg-d-hover text-sm text-d-strong disabled:opacity-50">
          {loadingMore ? t('common.loading') : t('search.loadMore')}
        </button>
      )}
    </div>
  );
}

// --- Stickers ----------------------------------------------------------------

function StickersTab({ stickers, api, reload, onToast }) {
  const [name, setName] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const filePreview = useFilePreview(file);

  const submit = async (e) => {
    e.preventDefault();
    if (!file || !name.trim()) return;
    setBusy(true);
    try {
      const upload = await httpUpload('/api/upload/sticker', 'sticker', file);
      // The server stores the format so clients know whether it animates;
      // a GIF labelled "png" never would.
      const format = upload.mimetype === 'image/gif' ? 'gif' : upload.is_animated ? 'apng' : 'png';
      await api('/stickers', {
        method: 'POST',
        body: { name: name.trim(), fileId: upload.id, format }
      });
      setName('');
      setFile(null);
      await reload();
      onToast?.(t('stickerAdmin.added'), { type: 'success', ttl: 2500 });
    } catch (err) {
      onToast?.(err.message, { type: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <h1 className="text-xl font-bold text-d-strong mb-1">{t('settings.stickers')}</h1>
      <p className="text-xs text-d-text3 mb-5">{t('stickerAdmin.hint')}</p>

      <form onSubmit={submit} className="bg-d-surface rounded-lg p-4 mb-6 flex items-end gap-3">
        <label className="cursor-pointer">
          <div className="w-16 h-16 rounded bg-d-base border-2 border-dashed border-d-control flex items-center justify-center hover:border-d-brand transition-colors overflow-hidden">
            {file
              ? <img src={filePreview} alt="" className="w-full h-full object-contain" />
              : <Upload className="w-5 h-5 text-d-text4" />}
          </div>
          <input
            type="file" accept="image/*" className="hidden"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        </label>

        <div className="flex-1">
          <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">{t('common.name')}</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('stickerAdmin.namePlaceholder')}
            className="w-full bg-d-base text-sm text-d-strong px-3 py-2 rounded border border-d-edge focus:outline-none focus:border-d-brand"
          />
        </div>

        <button
          type="submit" disabled={busy || !file || !name.trim()}
          className="bg-d-brand hover:bg-d-brandhover disabled:opacity-40 text-white text-xs font-semibold px-4 py-2 rounded transition-colors"
        >
          {busy ? t('common.uploading') : t('common.upload')}
        </button>
      </form>

      {stickers.length === 0 ? (
        <p className="text-sm text-d-text3">{t('stickerAdmin.none')}</p>
      ) : (
        <div className="grid grid-cols-4 gap-3">
          {stickers.map((sticker) => (
            <div key={sticker.id} className="bg-d-surface rounded-lg p-3 text-center relative group">
              <img src={proxiedImageUrl(sticker.url)} alt={sticker.name} className="w-20 h-20 object-contain mx-auto" />
              <p className="text-xs text-d-strong truncate mt-1">{sticker.name}</p>
              <p className="text-[10px] text-d-text4 truncate">{sticker.creator_name ?? ''}</p>
              <button
                onClick={async () => {
                  try {
                    await api('/stickers/' + sticker.id, { method: 'DELETE' });
                    await reload();
                  } catch (err) {
                    onToast?.(err.message, { type: 'error' });
                  }
                }}
                className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 max-md:opacity-100 text-d-text3 hover:text-d-danger transition-all p-1"
                aria-label={t('common.deleteNamed', { name: sticker.name })}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}


// --- Soundboard --------------------------------------------------------------

function SoundboardTab({ sounds, api, reload, onToast }) {
  const [name, setName] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [playing, setPlaying] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    if (!file || !name.trim()) return;
    setBusy(true);
    try {
      const uploaded = await httpUpload('/api/upload/attachments', 'files', file);
      const attachment = uploaded.attachments?.[0] ?? uploaded;
      await api('/sounds', {
        method: 'POST',
        body: { name: name.trim(), fileId: attachment.id, url: attachment.url }
      });
      setName(''); setFile(null);
      await reload();
      onToast?.(t('sounds.added', { name }), { type: 'success', ttl: 2500 });
    } catch (err) { onToast?.(err.message, { type: 'error' }); }
    finally { setBusy(false); }
  };

  const remove = async (sound) => {
    try {
      await api(`/sounds/${sound.id}`, { method: 'DELETE' });
      await reload();
    } catch (err) { onToast?.(err.message, { type: 'error' }); }
  };

  const preview = (sound) => {
    setPlaying(sound.id);
    const audio = new Audio(sound.url);
    audio.addEventListener('ended', () => setPlaying(null));
    audio.play().catch(() => setPlaying(null));
  };

  return (
    <div>
      <h1 className="text-xl font-bold text-d-strong mb-1">{t('settings.soundboard')}</h1>
      <p className="text-xs text-d-text2 mb-5">{t('sounds.hint')}</p>

      <form onSubmit={submit} className="flex flex-wrap items-end gap-2 mb-6">
        <label className="block">
          <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">{t('common.name')}</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={32}
            className="bg-d-base text-sm text-d-strong px-3 py-2 rounded border border-d-edge focus:outline-none focus:border-d-brand"
          />
        </label>
        <label className="block">
          <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">{t('sounds.file')}</span>
          <input
            type="file"
            accept="audio/*"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="text-xs text-d-text2"
          />
        </label>
        <button
          type="submit"
          disabled={busy || !file || !name.trim()}
          className="bg-d-brand hover:bg-d-brandhover disabled:opacity-50 text-white text-xs font-semibold px-4 py-2 rounded flex items-center gap-2"
        >
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
          {t('common.upload')}
        </button>
      </form>

      <div className="space-y-1">
        {sounds.length === 0 && <p className="text-xs text-d-text4">{t('sounds.none')}</p>}
        {sounds.map((sound) => (
          <div key={sound.id} className="bg-d-surface rounded-lg p-3 flex items-center gap-3">
            <button
              onClick={() => preview(sound)}
              className="p-2 bg-d-base hover:bg-d-hover rounded-full text-d-text2"
              aria-label={t('sounds.play', { name: sound.name })}
            >
              <Music className={`w-4 h-4 ${playing === sound.id ? 'text-d-online animate-pulse' : ''}`} />
            </button>
            <span className="text-sm text-d-strong flex-1 truncate">{sound.name}</span>
            <button onClick={() => remove(sound)} className="text-d-text3 hover:text-d-danger" aria-label={t('common.deleteNamed', { name: sound.name })}>
              <Trash2 className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Reports -----------------------------------------------------------------

function ReportsTab({ reports, reload, onToast }) {
  const [busy, setBusy] = useState(null);

  const resolve = async (report, status) => {
    setBusy(report.id);
    try {
      await httpApi(`/api/reports/${report.id}`, {
        method: 'PATCH', body: { status, action: status === 'resolved' ? 'reviewed' : null }
      });
      await reload();
    } catch (err) { onToast?.(err.message, { type: 'error' }); }
    finally { setBusy(null); }
  };

  return (
    <div>
      <h1 className="text-xl font-bold text-d-strong mb-1">{t('settings.reports')}</h1>
      <p className="text-xs text-d-text2 mb-5">{t('reports.hint')}</p>

      <div className="space-y-2">
        {reports.length === 0 && <p className="text-xs text-d-text4">{t('reports.none')}</p>}
        {reports.map((report) => (
          <div key={report.id} className="bg-d-surface rounded-lg p-3 space-y-2">
            <div className="flex items-center gap-2">
              <Flag className="w-3.5 h-3.5 text-d-danger shrink-0" />
              <span className="text-xs font-bold text-d-strong">{report.reason}</span>
              <span className="text-[10px] text-d-text3 ml-auto">
                {new Date(report.created_at).toLocaleString(localeTag())}
              </span>
            </div>
            <p className="text-[11px] text-d-text3">
              {t('reports.by', { name: report.reporter_name ?? report.reporter_id })} · {report.target_type}
            </p>
            {Boolean(report.target?.content) && (
              <p className="text-xs text-d-text bg-d-base rounded p-2 whitespace-pre-wrap break-words">
                {report.target.author ? `${report.target.author}: ` : ''}{report.target.content}
              </p>
            )}
            {Boolean(report.details) && <p className="text-[11px] text-d-text2">{report.details}</p>}
            <div className="flex gap-3">
              <button
                onClick={() => resolve(report, 'resolved')}
                disabled={busy === report.id}
                className="text-[11px] text-d-online hover:underline"
              >
                {t('reports.markResolved')}
              </button>
              <button
                onClick={() => resolve(report, 'dismissed')}
                disabled={busy === report.id}
                className="text-[11px] text-d-text3 hover:underline"
              >
                {t('reports.dismiss')}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
