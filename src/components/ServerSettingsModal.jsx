import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  X, Shield, Users, Smile, Link2, Ban, ScrollText, Settings as SettingsIcon,
  Plus, Trash2, Search, Upload, Check, AlertTriangle, Crown, GripVertical,
  ShieldAlert, Webhook, KeyRound, Sticker, Clock, Pencil, Flag, Music, Loader2, Hand, BarChart3
} from 'lucide-react';

import { useFocusTrap } from '../hooks/useFocusTrap';
import AutoModTab from './settings/AutoModTab';
import WebhooksTab from './settings/WebhooksTab';
import ChannelPermissionsTab from './settings/ChannelPermissionsTab';
import OnboardingTab from './settings/OnboardingTab';
import InsightsTab from './settings/InsightsTab';
import { t, localeTag } from '../i18n/index.jsx';
import { api as httpApi, upload as httpUpload } from '../api';
import { DEFAULT_AVATAR } from '../utils/avatar';
import {
  permissionGroups, hasBit, toggleBit, countPermissions, ROLE_COLOR_PRESETS
} from '../utils/permissionCatalog';

const FALLBACK_AVATAR = DEFAULT_AVATAR;

const tabs = () => [
  { key: 'overview', label: t('settings.overview'), icon: SettingsIcon },
  { key: 'roles', label: t('settings.roles'), icon: Shield },
  { key: 'members', label: t('autocomplete.members'), icon: Users },
  { key: 'emojis', label: t('chat.emoji'), icon: Smile },
  { key: 'invites', label: t('settings.invites'), icon: Link2 },
  { key: 'bans', label: t('settings.bans'), icon: Ban },
  { key: 'stickers', label: t('settings.stickers'), icon: Sticker },
  { key: 'permissions', label: t('settings.channelPermissions'), icon: KeyRound },
  { key: 'onboarding', label: t('settings.onboarding'), icon: Hand },
  { key: 'insights', label: t('settings.insights'), icon: BarChart3 },
  { key: 'automod', label: t('settings.automod'), icon: ShieldAlert },
  { key: 'webhooks', label: t('settings.webhooks'), icon: Webhook },
  { key: 'soundboard', label: t('settings.soundboard'), icon: Music },
  { key: 'reports', label: t('settings.reports'), icon: Flag },
  { key: 'audit', label: t('settings.auditLog'), icon: ScrollText }
];

const auditLabels = () => ({
  SERVER_CREATE: t('audit.SERVER_CREATE'), SERVER_UPDATE: t('audit.SERVER_UPDATE'),
  SERVER_OWNER_TRANSFER: t('audit.SERVER_OWNER_TRANSFER'),
  CHANNEL_CREATE: t('server.createChannel'), CHANNEL_UPDATE: t('audit.CHANNEL_UPDATE'), CHANNEL_DELETE: t('audit.CHANNEL_DELETE'),
  ROLE_CREATE: t('audit.ROLE_CREATE'), ROLE_UPDATE: t('audit.ROLE_UPDATE'), ROLE_DELETE: t('audit.ROLE_DELETE'),
  MEMBER_ROLE_UPDATE: t('audit.MEMBER_ROLE_UPDATE'), MEMBER_KICK: t('audit.MEMBER_KICK'),
  MEMBER_BAN_ADD: t('audit.MEMBER_BAN_ADD'), MEMBER_BAN_REMOVE: t('bans.unban'),
  MEMBER_TIMEOUT: t('audit.MEMBER_TIMEOUT'), MEMBER_UPDATE: t('audit.MEMBER_UPDATE'),
  EMOJI_CREATE: t('audit.EMOJI_CREATE'), EMOJI_DELETE: t('audit.EMOJI_DELETE'), INVITE_DELETE: t('invites.revoke')
});

/**
 * Server Settings. Each tab fetches only what it needs, on first open, so
 * opening settings does not pull the audit log and every ban at once.
 */
export default function ServerSettingsModal({
  server, currentUserId, channels = [], initialTab = 'overview', viewerPermissions = [],
  onClose, onServerUpdated, onServerDeleted, onRefreshServer, onToast
}) {
  const [tab, setTab] = useState(initialTab);
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

  const isOwner = server.owner_id === currentUserId;
  const can = useCallback(
    (name) => viewerPermissions.includes(name) || viewerPermissions.includes('ADMINISTRATOR') || isOwner,
    [viewerPermissions, isOwner]
  );

  const authed = useMemo(
    () => ({ 'Content-Type': 'application/json', 'x-user-id': currentUserId }),
    [currentUserId]
  );

  const api = useCallback(async (path, options = {}) => {
    const res = await fetch(`/api/servers/${server.id}${path}`, { headers: authed, ...options });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data;
  }, [server.id, authed]);

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
      if (which === 'reports') setReports(await httpApi(`/api/reports?status=open&serverId=${server.id}`).catch(() => []));
      // The AutoMod and channel-permission editors both need the role list.
      if (['automod', 'permissions'].includes(which)) setRoles(await api('/roles'));
      // The channel-permission editor also offers per-member overwrites.
      if (which === 'permissions') setMembers(await api('/members?limit=500'));
    } catch (err) {
      onToast?.(err.message, { type: 'error' });
    } finally {
      setLoading(false);
    }
  }, [api, onToast, server.id]);

  useEffect(() => { load(tab); }, [tab, load]);

  // Roles is the only tab that needs to be loaded for another tab to work
  // (members shows role chips), so fetch it up front.
  useEffect(() => { if (tab === 'members' && roles.length === 0) load('roles'); }, [tab, roles.length, load]);

  // Focus stays inside the dialog and returns to the trigger on close.
  const dialogRef = useFocusTrap(true, onClose);

  return (
    <div ref={dialogRef} className="fixed inset-0 z-[80] bg-d-canvas flex max-md:flex-col max-md:overflow-y-auto" role="dialog" aria-modal="true" aria-label={t('server.settings')}>
      {/* Left nav */}
      <div className="w-56 max-md:w-full bg-d-surface shrink-0 overflow-y-auto py-14 max-md:py-4 px-3 max-md:flex max-md:gap-1 max-md:overflow-x-auto">
        <h2 className="px-2 mb-2 text-[11px] font-bold text-d-text3 uppercase tracking-wide truncate">
          {server.name}
        </h2>
        {tabs().map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm mb-0.5 transition-colors ${
              tab === t.key ? 'bg-d-active text-d-strong' : 'text-d-text2 hover:bg-d-hover hover:text-d-strong'
            }`}
          >
            <t.icon className="w-4 h-4 shrink-0" />
            <span className="truncate">{t.label}</span>
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-10 max-md:px-4 py-14 max-md:py-6 max-w-4xl">
        {loading && <p className="text-xs text-d-text3 mb-3">{t('common.loading')}</p>}

        {tab === 'overview' && (
          <OverviewTab
            server={server} api={api} channels={channels} isOwner={isOwner}
            onServerUpdated={onServerUpdated} onServerDeleted={onServerDeleted} onToast={onToast}
          />
        )}
        {tab === 'roles' && (
          <RolesTab roles={roles} api={api} reload={() => load('roles')} onToast={onToast} />
        )}
        {tab === 'members' && (
          <MembersTab
            members={members} roles={roles} server={server} api={api}
            reload={async () => { await load('members'); onRefreshServer?.(); }}
            onToast={onToast} currentUserId={currentUserId} can={can} isOwner={isOwner}
          />
        )}
        {tab === 'emojis' && (
          <EmojisTab emojis={emojis} api={api} reload={() => load('emojis')} currentUserId={currentUserId} onToast={onToast} />
        )}
        {tab === 'invites' && (
          <InvitesTab invites={invites} api={api} reload={() => load('invites')} channels={channels} onToast={onToast} />
        )}
        {tab === 'bans' && (
          <BansTab bans={bans} api={api} reload={() => load('bans')} onToast={onToast} />
        )}
        {tab === 'stickers' && (
          <StickersTab
            stickers={stickers} api={api} reload={() => load('stickers')}
            currentUserId={currentUserId} onToast={onToast}
          />
        )}
        {tab === 'permissions' && (
          <ChannelPermissionsTab
            channels={channels} roles={roles} members={members} onToast={onToast}
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
            webhooks={webhooks} channels={channels} currentUserId={currentUserId}
            reload={() => load('webhooks')} onToast={onToast}
          />
        )}
        {tab === 'insights' && (
          <InsightsTab server={server} channels={channels} onToast={onToast} />
        )}
        {tab === 'onboarding' && (
          <OnboardingTab server={server} channels={channels} roles={roles} onToast={onToast} />
        )}
        {tab === 'soundboard' && (
          <SoundboardTab sounds={sounds} api={api} reload={() => load('soundboard')} onToast={onToast} />
        )}
        {tab === 'reports' && (
          <ReportsTab reports={reports} reload={() => load('reports')} onToast={onToast} />
        )}
        {tab === 'audit' && <AuditTab entries={auditLog} />}
      </div>

      {/* Close */}
      <div className="w-20 pt-14 shrink-0 max-md:hidden">
        <button
          onClick={onClose}
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

function OverviewTab({ server, api, channels, isOwner, onServerUpdated, onServerDeleted, onToast }) {
  const [form, setForm] = useState({
    name: server.name ?? '',
    description: server.description ?? '',
    icon_url: server.icon_url ?? '',
    system_channel_id: server.system_channel_id ?? '',
    afk_channel_id: server.afk_channel_id ?? '',
    afk_timeout: server.afk_timeout ?? 300,
    rules_channel_id: server.rules_channel_id ?? '',
    vanity_url: server.vanity_url ?? '',
    verification_level: server.verification_level ?? 0,
    default_notifications: server.default_notifications ?? 'all_messages'
  });
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleteName, setDeleteName] = useState('');
  const [deleting, setDeleting] = useState(false);
  const dirty = Object.entries(form).some(([k, v]) => (server[k] ?? '') !== v);

  const deleteServer = async () => {
    setDeleting(true);
    try {
      await api('', { method: 'DELETE' });
      onServerDeleted?.();
    } catch (err) {
      onToast?.(err.message, { type: 'error' });
      setDeleting(false);
    }
  };

  const uploadIcon = async (file) => {
    try {
      // Uploads act as the person clicking, not as the server owner.
      const data = await httpUpload('/api/upload/server-icon', 'icon', file);
      if (data.url) setForm((f) => ({ ...f, icon_url: data.url }));
    } catch (err) {
      onToast?.(err.message ?? t('chat.uploadFailed'), { type: 'error' });
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const body = {
        ...form,
        vanity_url: form.vanity_url.trim() || null,
        rules_channel_id: form.rules_channel_id || null,
        afk_channel_id: form.afk_channel_id || null,
        afk_timeout: Number(form.afk_timeout),
        verification_level: Number(form.verification_level)
      };
      const updated = await api('', { method: 'PATCH', body: JSON.stringify(body) });
      onServerUpdated?.(updated);
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

      <div className="flex gap-6 mb-8">
        <label className="shrink-0 cursor-pointer group">
          <img
            src={form.icon_url || FALLBACK_AVATAR}
            alt=""
            className="w-24 h-24 rounded-full object-cover border-4 border-d-surface group-hover:opacity-70 transition-opacity"
          />
          <span className="flex items-center gap-1 justify-center text-[11px] text-d-link mt-2">
            <Upload className="w-3 h-3" /> {t('settings.changeIcon')}
          </span>
          <input
            type="file" accept="image/*" className="hidden"
            aria-label={t('server.iconAlt')}
            onChange={(e) => e.target.files?.[0] && uploadIcon(e.target.files[0])}
          />
        </label>

        <div className="flex-1 space-y-4">
          <Field label={t('settings.serverName')}>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
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

      <div className="grid grid-cols-2 gap-4 mb-8">
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
        {form.afk_channel_id && (
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
            <span className="shrink-0 text-xs text-d-text3">{window.location.origin}/join/</span>
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

      <TemplateSection server={server} onToast={onToast} />

      {isOwner && (
        <div className="border border-d-danger/40 rounded-lg p-4 mb-6">
          <h2 className="text-sm font-bold text-d-danger mb-1">{t('settings.dangerZone')}</h2>
          <p className="text-xs text-d-text3 mb-3">{t('settings.deleteServerHint')}</p>
          {confirmDelete ? (
            <div className="space-y-2">
              <label className="block">
                <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">
                  {t('settings.typeServerName', { name: server.name })}
                </span>
                <input
                  value={deleteName}
                  onChange={(e) => setDeleteName(e.target.value)}
                  className="w-full bg-d-base text-sm text-d-strong px-3 py-2 rounded border border-d-edge focus:outline-none focus:border-d-danger"
                />
              </label>
              <div className="flex gap-2">
                <button
                  onClick={deleteServer}
                  disabled={deleteName.trim() !== server.name || deleting}
                  className="bg-d-danger hover:bg-red-600 disabled:opacity-40 text-white text-xs font-semibold px-4 py-2 rounded"
                >
                  {deleting ? t('common.saving') : t('server.delete')}
                </button>
                <button onClick={() => setConfirmDelete(false)} className="text-xs text-d-text3 hover:underline">
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={() => setConfirmDelete(true)}
              className="bg-d-danger/10 hover:bg-d-danger hover:text-white text-d-danger text-xs font-semibold px-4 py-2 rounded flex items-center gap-2 transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" /> {t('server.delete')}
            </button>
          )}
        </div>
      )}

      {dirty && (
        <div className="sticky bottom-0 bg-d-surface border border-d-edge rounded-lg p-3 flex items-center justify-between">
          <span className="text-xs text-d-text">{t('common.unsavedChanges')}</span>
          <div className="flex gap-2">
            <button
              onClick={() => setForm({
                name: server.name ?? '', description: server.description ?? '',
                icon_url: server.icon_url ?? '', system_channel_id: server.system_channel_id ?? '',
                afk_channel_id: server.afk_channel_id ?? '',
                default_notifications: server.default_notifications ?? 'all_messages'
              })}
              className="text-xs text-d-strong px-3 py-1.5 hover:underline"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={save}
              disabled={saving}
              className="bg-d-success hover:bg-d-successhover disabled:opacity-50 text-white text-xs font-semibold px-4 py-1.5 rounded transition-colors"
            >
              {saving ? t('common.saving') : t('common.saveChanges')}
            </button>
          </div>
        </div>
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
    const objectUrl = URL.createObjectURL(file);
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
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
function TemplateSection({ server, onToast }) {
  const [template, setTemplate] = useState(undefined);   // undefined = loading, null = none
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

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
            <button type="button" disabled={busy} onClick={() => run(async () => { await httpApi(`/api/servers/${server.id}/template`, { method: 'DELETE' }); return null; })}
              className="text-xs font-semibold text-d-danger hover:underline px-2 py-1.5 disabled:opacity-50">{t('common.delete')}</button>
          </div>
        </div>
      )}
    </div>
  );
}

function RolesTab({ roles, api, reload, onToast }) {
  const [selectedId, setSelectedId] = useState(null);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [dragId, setDragId] = useState(null);

  /**
   * Drop role A onto role B: rebuild the order and send it as a list, highest
   * first. The server rejects any move that would put a role at or above the
   * actor's own highest role, so hierarchy stays enforced server-side.
   */
  const dropOn = async (targetId) => {
    if (!dragId || dragId === targetId) { setDragId(null); return; }
    const ordered = roles.filter((r) => !r.is_everyone).map((r) => r.id);
    const from = ordered.indexOf(dragId);
    const to = ordered.indexOf(targetId);
    if (from === -1 || to === -1) { setDragId(null); return; }
    ordered.splice(to, 0, ordered.splice(from, 1)[0]);
    setDragId(null);
    try {
      await api('/roles/order', { method: 'PUT', body: JSON.stringify({ order: ordered }) });
      await reload();
    } catch (err) { onToast?.(err.message, { type: 'error' }); }
  };

  const selected = roles.find((r) => r.id === selectedId) ?? null;

  useEffect(() => {
    if (!selectedId && roles.length) setSelectedId(roles[0].id);
  }, [roles, selectedId]);

  useEffect(() => {
    setDraft(selected ? { ...selected } : null);
  }, [selectedId, selected?.permissions, selected?.name, selected?.color]);

  const dirty = draft && selected && (
    draft.name !== selected.name ||
    draft.color !== selected.color ||
    String(draft.permissions) !== String(selected.permissions) ||
    Boolean(draft.hoist) !== Boolean(selected.hoist) ||
    Boolean(draft.mentionable) !== Boolean(selected.mentionable)
  );

  const createRole = async () => {
    try {
      await api('/roles', {
        method: 'POST',
        body: JSON.stringify({ name: t('roles.newRoleName'), color: '#99aab5', permissions: '0' })
      });
      await reload();
      onToast?.(t('roles.created'), { type: 'success', ttl: 2500 });
    } catch (err) { onToast?.(err.message, { type: 'error' }); }
  };

  const save = async () => {
    setSaving(true);
    try {
      await api(`/roles/${draft.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: draft.name, color: draft.color, permissions: String(draft.permissions),
          hoist: Boolean(draft.hoist), mentionable: Boolean(draft.mentionable)
        })
      });
      await reload();
      onToast?.(t('roles.savedRole'), { type: 'success', ttl: 2500 });
    } catch (err) { onToast?.(err.message, { type: 'error' }); }
    finally { setSaving(false); }
  };

  const remove = async (role) => {
    try {
      await api(`/roles/${role.id}`, { method: 'DELETE' });
      setSelectedId(null);
      await reload();
      onToast?.(t('roles.deleted', { name: role.name }), { type: 'success', ttl: 2500 });
    } catch (err) { onToast?.(err.message, { type: 'error' }); }
  };

  const isAdmin = draft && hasBit(draft.permissions, 'ADMINISTRATOR');

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-bold text-d-strong">{t('settings.roles')}</h1>
        <button
          onClick={createRole}
          className="flex items-center gap-1 bg-d-brand hover:bg-d-brandhover text-white text-xs font-semibold px-3 py-1.5 rounded transition-colors"
        >
          <Plus className="w-3.5 h-3.5" /> {t('audit.ROLE_CREATE')}
        </button>
      </div>

      <div className="flex gap-6">
        {/* Role list, highest first — the same order that decides hierarchy. */}
        <div className="w-52 shrink-0 space-y-0.5">
          {roles.map((role) => (
            <button
              key={role.id}
              onClick={() => setSelectedId(role.id)}
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
              <span className="text-sm text-d-strong truncate flex-1">{role.name}</span>
              <span className="text-[10px] text-d-text3 shrink-0">{role.member_count}</span>
            </button>
          ))}
        </div>

        {/* Editor */}
        {draft && (
          <div className="flex-1 min-w-0">
            {draft.is_everyone && (
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

                <div className="mt-4">
                  <span className="block text-[11px] font-bold text-d-text2 uppercase mb-1.5">{t('roles.roleColour')}</span>
                  <div className="flex flex-wrap gap-1.5">
                    {ROLE_COLOR_PRESETS.map((color) => (
                      <button
                        key={color}
                        onClick={() => setDraft({ ...draft, color })}
                        style={{ backgroundColor: color }}
                        className={`w-7 h-7 rounded flex items-center justify-center transition-transform hover:scale-110 ${
                          draft.color === color ? 'ring-2 ring-white' : ''
                        }`}
                        aria-label={t('roles.colorSwatch', { color })}
                      >
                        {draft.color === color && <Check className="w-3.5 h-3.5 text-d-strong drop-shadow" />}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex gap-6 mt-4">
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
                  onClick={() => remove(draft)}
                  className="flex items-center gap-1 text-xs text-d-danger hover:underline"
                >
                  <Trash2 className="w-3.5 h-3.5" /> {t('audit.ROLE_DELETE')}
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
                <h4 className="text-[11px] font-bold text-d-text3 uppercase mb-2">{t('roles.advanced')}</h4>
                <PermissionRow
                  label={t('roles.administrator')}
                  description={t('roles.administratorHint')}
                  checked={hasBit(draft.permissions, 'ADMINISTRATOR')}
                  danger
                  onToggle={() => setDraft({ ...draft, permissions: toggleBit(draft.permissions, 'ADMINISTRATOR') })}
                />
              </div>
            </div>

            {dirty && (
              <div className="sticky bottom-0 mt-6 bg-d-surface border border-d-edge rounded-lg p-3 flex items-center justify-between">
                <span className="text-xs text-d-text">{t('common.unsavedChanges')}</span>
                <div className="flex gap-2">
                  <button onClick={() => setDraft({ ...selected })} className="text-xs text-d-strong px-3 py-1.5 hover:underline">
                    {t('common.cancel')}
                  </button>
                  <button
                    onClick={save} disabled={saving}
                    className="bg-d-success hover:bg-d-successhover disabled:opacity-50 text-white text-xs font-semibold px-4 py-1.5 rounded transition-colors"
                  >
                    {saving ? t('common.saving') : t('common.save')}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function PermissionRow({ label, description, checked, onToggle, danger, forced }) {
  const on = checked || forced;
  return (
    <div className="flex items-start justify-between gap-4 py-2 border-b border-d-divider/40">
      <div className="min-w-0">
        <p className={`text-sm ${danger ? 'text-d-danger font-semibold' : 'text-d-strong'}`}>{label}</p>
        <p className="text-[11px] text-d-text3">{description}</p>
      </div>
      <button
        role="switch"
        aria-checked={on}
        aria-label={label}
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
        role="switch" aria-checked={checked} onClick={() => onChange(!checked)}
        className={`w-10 h-6 rounded-full transition-colors relative ${checked ? 'bg-d-online' : 'bg-d-text4'}`}
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

  const saveNickname = async (member) => {
    setBusy(true);
    try {
      await api(`/members/${member.id}`, {
        method: 'PATCH', body: JSON.stringify({ nickname: nickname.trim() || null })
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
        body: JSON.stringify({
          until: new Date(Date.now() + minutes * 60_000).toISOString(),
          reason: t('audit.reasonFromSettings')
        })
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

  const transferOwnership = async (member) => {
    try {
      await api('/transfer-ownership', { method: 'POST', body: JSON.stringify({ userId: member.id }) });
      await reload();
      onToast?.(t('members.ownershipTransferred', { name: member.nickname || member.display_name }), { type: 'success' });
    } catch (err) { onToast?.(err.message, { type: 'error' }); }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return members;
    return members.filter((m) =>
      (m.display_name ?? '').toLowerCase().includes(q) ||
      (m.username ?? '').toLowerCase().includes(q) ||
      (m.nickname ?? '').toLowerCase().includes(q)
    );
  }, [members, search]);

  const toggleRole = async (member, role) => {
    const has = member.roles.some((r) => r.id === role.id);
    try {
      const res = await fetch(`/api/servers/${server.id}/members/${member.id}/roles/${role.id}`, {
        method: has ? 'DELETE' : 'PUT',
        headers: { 'x-user-id': currentUserId, 'Content-Type': 'application/json' }
      });
      if (!res.ok) throw new Error((await res.json()).error);
      await reload();
    } catch (err) { onToast?.(err.message, { type: 'error' }); }
  };

  const kick = async (member) => {
    try {
      await api(`/kicks/${member.id}`, { method: 'POST', body: JSON.stringify({ reason: t('audit.reasonFromSettings') }) });
      await reload();
      onToast?.(t('members.kicked', { name: member.display_name }), { type: 'success', ttl: 2500 });
    } catch (err) { onToast?.(err.message, { type: 'error' }); }
  };

  const ban = async (member) => {
    try {
      await api(`/bans/${member.id}`, { method: 'POST', body: JSON.stringify({ reason: t('audit.reasonFromSettings') }) });
      await reload();
      onToast?.(t('members.banned', { name: member.display_name }), { type: 'success', ttl: 2500 });
    } catch (err) { onToast?.(err.message, { type: 'error' }); }
  };

  return (
    <div>
      <h1 className="text-xl font-bold text-d-strong mb-1">{t('members.count', { count: members.length })}</h1>
      <div className="relative mb-4 mt-4">
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t('members.searchMembers')}
          className="w-full bg-d-base text-sm text-d-strong px-3 py-2 pr-8 rounded border border-d-edge focus:outline-none focus:border-d-brand"
        />
        <Search className="w-4 h-4 text-d-text4 absolute right-2.5 top-2.5" />
      </div>

      <div className="space-y-1">
        {filtered.map((member) => (
          <div key={member.id} className="bg-d-surface rounded-lg p-3">
            <div className="flex items-center gap-3">
              <img src={member.avatar_url || FALLBACK_AVATAR} alt="" className="w-9 h-9 rounded-full object-cover shrink-0" />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold text-d-strong truncate flex items-center gap-1.5">
                  {member.nickname || member.display_name}
                  {server.owner_id === member.id && <Crown className="w-3.5 h-3.5 text-d-idle" title={t('members.ownerTitle')} />}
                  {member.is_bot && <span className="bg-d-brand text-white text-[9px] font-bold px-1 rounded">BOT</span>}
                  {member.timeout_until && member.timeout_until > new Date().toISOString() && (
                    <span className="bg-d-idle/20 text-d-idle text-[9px] font-bold px-1 rounded flex items-center gap-0.5">
                      <Clock className="w-2.5 h-2.5" />
                      {t('members.timedOutUntil', { time: new Date(member.timeout_until).toLocaleString(localeTag()) })}
                    </span>
                  )}
                </p>
                <p className="text-[11px] text-d-text3 truncate">
                  @{member.username} · {t('members.joinedOn', { date: new Date(member.joined_at).toLocaleDateString(localeTag()) })}
                </p>
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
                      <button onClick={() => kick(member)} className="text-[11px] text-d-idle hover:underline">{t('members.kick')}</button>
                    )}
                    {can('BAN_MEMBERS') && (
                      <button onClick={() => ban(member)} className="text-[11px] text-d-danger hover:underline">{t('members.ban')}</button>
                    )}
                    {isOwner && !member.is_bot && (
                      <button
                        onClick={() => transferOwnership(member)}
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
        ))}
      </div>
    </div>
  );
}

// --- Emojis ------------------------------------------------------------------

function EmojisTab({ emojis, api, reload, currentUserId, onToast }) {
  const [name, setName] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const filePreview = useFilePreview(file);

  const submit = async (e) => {
    e.preventDefault();
    if (!file || !name.trim()) return;
    setBusy(true);
    try {
      const body = new FormData();
      body.append('emoji', file);
      const upload = await fetch('/api/upload/emoji', {
        method: 'POST', headers: { 'x-user-id': currentUserId }, body
      }).then((r) => r.json());
      if (upload.error) throw new Error(upload.error);

      await api('/emojis', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), fileId: upload.id, animated: upload.is_animated })
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
            <img src={emoji.url} alt={emoji.name} className="w-8 h-8 object-contain" />
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
        body: JSON.stringify({ channelId: channelId || null, maxUses: Number(maxUses), maxAge: Number(maxAge) })
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
  return (
    <div>
      <h1 className="text-xl font-bold text-d-strong mb-5">{t('bans.count', { count: bans.length })}</h1>
      {bans.length === 0 && <p className="text-sm text-d-text3">{t('bans.none')}</p>}
      <div className="space-y-1">
        {bans.map((ban) => (
          <div key={ban.user_id} className="bg-d-surface rounded-lg p-3 flex items-center gap-3">
            <img src={ban.avatar_url || FALLBACK_AVATAR} alt="" className="w-9 h-9 rounded-full object-cover shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-d-strong truncate">{ban.display_name}</p>
              <p className="text-[11px] text-d-text3 truncate">
                @{ban.username}
                {ban.reason ? ` · ${t('bans.reason', { reason: ban.reason })}` : ''}
                {ban.moderator_name ? ` · ${t('bans.by', { name: ban.moderator_name })}` : ''}
              </p>
            </div>
            <button
              onClick={async () => {
                try { await api(`/bans/${ban.user_id}`, { method: 'DELETE' }); await reload(); onToast?.(t('bans.unbanned'), { type: 'success', ttl: 2500 }); }
                catch (err) { onToast?.(err.message, { type: 'error' }); }
              }}
              className="text-xs text-d-link hover:underline shrink-0"
            >
              {t('bans.unban')}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Audit log ---------------------------------------------------------------

function AuditTab({ entries }) {
  return (
    <div>
      <h1 className="text-xl font-bold text-d-strong mb-5">{t('settings.auditLog')}</h1>
      {entries.length === 0 && <p className="text-sm text-d-text3">{t('audit.none')}</p>}
      <div className="space-y-1">
        {entries.map((entry) => (
          <div key={entry.id} className="bg-d-surface rounded-lg p-3 flex gap-3">
            <img src={entry.avatar_url || FALLBACK_AVATAR} alt="" className="w-8 h-8 rounded-full object-cover shrink-0" />
            <div className="min-w-0">
              <p className="text-sm text-d-strong">
                <strong>{entry.display_name ?? t('audit.system')}</strong>{' '}
                <span className="text-d-text2">
                  {auditLabels()[entry.action_type] ?? entry.action_type}
                </span>
              </p>
              {entry.changes?.length > 0 && (
                <ul className="text-[11px] text-d-text3 mt-0.5 space-y-0.5">
                  {entry.changes.slice(0, 4).map((change, i) => (
                    <li key={i}>
                      {change.key}: <span className="line-through opacity-60">{String(change.old ?? '—').slice(0, 30)}</span>
                      {' → '}{String(change.new ?? '—').slice(0, 30)}
                    </li>
                  ))}
                </ul>
              )}
              <p className="text-[10px] text-d-text4 mt-0.5">
                {new Date(entry.created_at).toLocaleString(localeTag())}
                {entry.reason ? ` · ${entry.reason}` : ''}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Stickers ----------------------------------------------------------------

function StickersTab({ stickers, api, reload, currentUserId, onToast }) {
  const [name, setName] = useState('');
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const filePreview = useFilePreview(file);

  const submit = async (e) => {
    e.preventDefault();
    if (!file || !name.trim()) return;
    setBusy(true);
    try {
      const body = new FormData();
      body.append('sticker', file);
      const upload = await fetch('/api/upload/sticker', {
        method: 'POST', headers: { 'x-user-id': currentUserId }, body
      }).then((r) => r.json());
      if (upload.error) throw new Error(upload.error);

      await api('/stickers', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim(), fileId: upload.id, format: 'png' })
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
              <img src={sticker.url} alt={sticker.name} className="w-20 h-20 object-contain mx-auto" />
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
                className="absolute top-1 right-1 opacity-0 group-hover:opacity-100 text-d-text3 hover:text-d-danger transition-all p-1"
                aria-label={t('common.delete') + sticker.name}
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
        body: JSON.stringify({ name: name.trim(), fileId: attachment.id, url: attachment.url })
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
            <button onClick={() => remove(sound)} className="text-d-text3 hover:text-d-danger" aria-label={t('common.delete')}>
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
            {report.target?.content && (
              <p className="text-xs text-d-text bg-d-base rounded p-2 whitespace-pre-wrap break-words">
                {report.target.author ? `${report.target.author}: ` : ''}{report.target.content}
              </p>
            )}
            {report.details && <p className="text-[11px] text-d-text2">{report.details}</p>}
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
