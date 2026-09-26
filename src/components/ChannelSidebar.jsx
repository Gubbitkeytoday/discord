import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Hash, Volume2, Plus, ChevronDown, ChevronRight, Mic, MicOff, Headphones,
  Settings, PhoneOff, Megaphone, X, MessagesSquare, Bell, BellOff, Check,
  Pencil, Trash2, Copy, UserPlus, Link2, Lock, Radio, Pin, MoreHorizontal,
  FolderPlus, KeyRound, ArrowUp, ArrowDown, VolumeX, LogOut, MoveRight, GripVertical
} from 'lucide-react';
import ServerDropdown from './ServerDropdown';
import ContextMenu from './ContextMenu';
import UserStatusMenu from './UserStatusMenu';
import InputModal from './InputModal';
import ConfirmModal from './ConfirmModal';
import TypeToConfirmDialog from './admin/TypeToConfirmDialog';
import StatusIndicator from './ui/StatusIndicator.jsx';
import { setCreateChannelIntent, setChannelSettingsTab } from './admin/createChannelIntent';
import { t, useLocaleCode } from '../i18n/index.jsx';
import { getPreferences, useUserSettings } from '../hooks/useUserSettings';
import { DEFAULT_AVATAR, defaultAvatar } from '../utils/avatar';
import { proxiedImageUrl } from '../utils/media';
import { get, post, patch, del } from '../api';

const FALLBACK_AVATAR = DEFAULT_AVATAR;

const CHANNEL_ICONS = {
  text: Hash,
  announcement: Megaphone,
  voice: Volume2,
  forum: MessagesSquare,
  stage: Radio
};

const TYPE_LABEL_KEYS = {
  text: 'channel.typeText', announcement: 'channel.typeAnnouncement', voice: 'channel.typeVoice',
  forum: 'channel.typeForum', stage: 'channel.typeStage'
};

const UNCATEGORIZED = '__uncategorized__';
const bySortKey = (a, b) => (a.position ?? 0) - (b.position ?? 0) || String(a.id).localeCompare(String(b.id));

export default function ChannelSidebar({
  mobileOpen = false,
  onCloseMobile,
  currentServer,
  channels,
  categories: categoriesProp = null,
  activeChannelId,
  onSelectChannel,
  onOpenCreateChannelModal,
  readStates = {},
  channelSettings = {},
  serverSettings,
  currentUser,
  onOpenUserSettingsModal,
  onOpenEvents,
  onSetStatus,
  currentVoiceChannel,
  activeVoiceParticipants,
  voiceRosters = {},
  onPrefetchChannel,
  onLeaveVoice,
  isMuted,
  onToggleMute,
  isDeafened,
  onToggleDeafen,
  viewerPermissions = [],
  isOwner = false,
  onOpenServerSettings,
  onCreateInvite,
  onCreateInviteFor,
  onLeaveServer,
  onDeleteServer,
  onOpenServerNotifications,
  onOpenChannelNotifications,
  onEditChannel,
  onDeleteChannel,
  onMarkChannelRead,
  onMuteChannel,
  onToast
}) {
  // Collapsed categories are remembered per server, as on Discord.
  const collapseKey = currentServer?.id ? `collapsed-categories:${currentServer.id}` : null;
  const [collapsed, setCollapsed] = useState({});
  useEffect(() => {
    if (!collapseKey) return;
    try { setCollapsed(JSON.parse(localStorage.getItem(collapseKey) || '{}') || {}); } catch { setCollapsed({}); }
  }, [collapseKey]);
  const { prefs, update } = useUserSettings();
  const [showServerMenu, setShowServerMenu] = useState(false);
  const [channelMenu, setChannelMenu] = useState(null);
  const [showStatusMenu, setShowStatusMenu] = useState(false);
  const [dialog, setDialog] = useState(null);    // { kind, ... } for category/server dialogs
  const [drag, setDrag] = useState(null);        // { id, kind: 'channel' | 'category' }
  const [dropHint, setDropHint] = useState(null);
  const [announcement, setAnnouncement] = useState('');
  const serverButtonRef = useRef(null);

  const can = (name) => viewerPermissions.includes(name) || viewerPermissions.includes('ADMINISTRATOR') || isOwner;
  const canManageChannels = can('MANAGE_CHANNELS');
  const serverId = currentServer?.id ?? null;

  // --- categories ------------------------------------------------------------
  //
  // The shell passes channels (with each one's category name and parent_id),
  // but not the categories themselves, so an empty category would vanish.
  // Categories come from, in order of preference: a `categories` prop, the
  // server detail (fetched when the channel layout changes), and whatever the
  // channel list itself implies.
  const [fetchedCategories, setFetchedCategories] = useState([]);
  const layoutSignature = useMemo(
    () => channels
      .filter((c) => c.type !== 'thread')
      .map((c) => `${c.id}:${c.parent_id ?? ''}:${c.type === 'category' ? c.name : ''}:${c.category ?? ''}`)
      .join('|'),
    [channels]
  );
  useEffect(() => {
    if (categoriesProp || !serverId) return undefined;
    let alive = true;
    const timer = setTimeout(() => {
      get(`/api/servers/${serverId}`)
        .then((detail) => { if (alive && Array.isArray(detail?.categories)) setFetchedCategories(detail.categories); })
        .catch(() => {});
    }, 150);
    return () => { alive = false; clearTimeout(timer); };
  }, [serverId, layoutSignature, categoriesProp]);

  const categories = useMemo(() => {
    const map = new Map();
    for (const c of categoriesProp ?? fetchedCategories) map.set(c.id, { ...c });
    for (const c of channels) {
      if (c.type === 'category' && c.server_id === serverId) map.set(c.id, { ...(map.get(c.id) ?? {}), id: c.id, name: c.name, position: c.position });
    }
    // A channel whose category we have not fetched yet still names it.
    for (const c of channels) {
      if (c.parent_id && c.category && !map.has(c.parent_id)) {
        map.set(c.parent_id, { id: c.parent_id, name: c.category, position: Number.MAX_SAFE_INTEGER });
      }
    }
    return [...map.values()].sort(bySortKey);
  }, [categoriesProp, fetchedCategories, channels, serverId]);

  // parentId -> threads, so each channel can list its own.
  const threadsByParent = useMemo(() => {
    const map = new Map();
    for (const c of channels) {
      if (c.type !== 'thread' || c.archived) continue;
      if (!map.has(c.parent_id)) map.set(c.parent_id, []);
      map.get(c.parent_id).push(c);
    }
    return map;
  }, [channels]);

  // Pinned channels are hoisted into their own group above everything else —
  // the point of pinning is not having to remember which category it lives in.
  const pinnedIds = useMemo(
    () => new Set(prefs.layout?.pinnedChannels ?? []),
    [prefs.layout?.pinnedChannels]
  );

  const togglePinned = (channelId) => {
    const current = prefs.layout?.pinnedChannels ?? [];
    const next = current.includes(channelId)
      ? current.filter((id) => id !== channelId)
      : [...current, channelId];
    update('layout', { ...(prefs.layout ?? {}), pinnedChannels: next });
  };

  const locale = useLocaleCode();

  /** The real layout: uncategorised channels first, then each category's. */
  const layout = useMemo(() => {
    const known = new Set(categories.map((c) => c.id));
    const plain = channels.filter((c) => c.type !== 'thread' && c.type !== 'category');
    const top = plain.filter((c) => !c.parent_id || !known.has(c.parent_id)).sort(bySortKey);
    const groups = categories.map((cat) => ({
      category: cat,
      channels: plain.filter((c) => c.parent_id === cat.id).sort(bySortKey)
    }));
    return { top, groups };
  }, [channels, categories]);

  const grouped = useMemo(() => {
    const entries = [];
    const pinned = [];
    const skipPinned = (list) => list.filter((c) => { if (pinnedIds.has(c.id)) { pinned.push(c); return false; } return true; });
    const top = skipPinned(layout.top);
    const groups = layout.groups.map((g) => ({ key: g.category.id, category: g.category, list: skipPinned(g.channels) }));
    if (pinned.length) entries.push({ key: '__pinned__', title: t('channel.pinned'), list: pinned.sort(bySortKey), pinned: true });
    if (top.length) entries.push({ key: UNCATEGORIZED, title: null, list: top });
    for (const g of groups) entries.push({ key: g.key, title: g.category.name, category: g.category, list: g.list });
    return entries;
  }, [layout, pinnedIds, locale]);

  // --- reordering ------------------------------------------------------------

  /** Send the complete order (the server validates every id and parent). */
  const saveOrder = useCallback(async (top, groups, message) => {
    const order = [
      ...top.map((c) => ({ id: c.id, parent_id: null })),
      ...groups.flatMap((g) => [
        { id: g.category.id, parent_id: null },
        ...g.channels.map((c) => ({ id: c.id, parent_id: g.category.id }))
      ])
    ];
    try {
      await patch(`/api/servers/${serverId}/channels/order`, { order });
      if (message) setAnnouncement(message);
    } catch (err) {
      onToast?.(err.message, { type: 'error' });
    }
  }, [serverId, onToast]);

  const cloneLayout = () => ({
    top: [...layout.top],
    groups: layout.groups.map((g) => ({ category: g.category, channels: [...g.channels] }))
  });

  /** Move a channel to `index` within `categoryId` (null = top level). */
  const moveChannel = (channelId, categoryId, index, message) => {
    const next = cloneLayout();
    const lists = [next.top, ...next.groups.map((g) => g.channels)];
    let moving = null;
    for (const list of lists) {
      const at = list.findIndex((c) => c.id === channelId);
      if (at !== -1) { moving = list.splice(at, 1)[0]; break; }
    }
    if (!moving) return;
    const target = categoryId ? next.groups.find((g) => g.category.id === categoryId)?.channels : next.top;
    if (!target) return;
    target.splice(Math.max(0, Math.min(index, target.length)), 0, moving);
    saveOrder(next.top, next.groups, message);
  };

  const moveCategory = (categoryId, index, message) => {
    const next = cloneLayout();
    const at = next.groups.findIndex((g) => g.category.id === categoryId);
    if (at === -1) return;
    const [moving] = next.groups.splice(at, 1);
    next.groups.splice(Math.max(0, Math.min(index, next.groups.length)), 0, moving);
    saveOrder(next.top, next.groups, message);
  };

  /** Keyboard: Alt+↑/↓ moves a channel one slot, crossing category edges. */
  const nudgeChannel = (channel, delta) => {
    const slots = [{ categoryId: null, list: layout.top }, ...layout.groups.map((g) => ({ categoryId: g.category.id, list: g.channels, name: g.category.name }))];
    const slotIndex = slots.findIndex((s) => s.list.some((c) => c.id === channel.id));
    if (slotIndex === -1) return;
    const slot = slots[slotIndex];
    const at = slot.list.findIndex((c) => c.id === channel.id);
    let targetSlot = slot;
    let targetIndex = at + delta;
    if (targetIndex < 0) {
      if (slotIndex === 0) return;
      targetSlot = slots[slotIndex - 1];
      targetIndex = targetSlot.list.length;
    } else if (targetIndex >= slot.list.length) {
      if (slotIndex === slots.length - 1) return;
      targetSlot = slots[slotIndex + 1];
      targetIndex = 0;
    }
    moveChannel(channel.id, targetSlot.categoryId, targetIndex, t('adm.movedChannel', {
      name: channel.name, category: targetSlot.name ?? t('adm.noCategory'), position: targetIndex + 1
    }));
    requestAnimationFrame(() => document.getElementById(`channel-row-${channel.id}`)?.focus());
  };

  const nudgeCategory = (category, delta) => {
    const at = layout.groups.findIndex((g) => g.category.id === category.id);
    const to = at + delta;
    if (at === -1 || to < 0 || to >= layout.groups.length) return;
    moveCategory(category.id, to, t('adm.movedCategory', { name: category.name, position: to + 1 }));
    requestAnimationFrame(() => document.getElementById(`category-${category.id}`)?.focus());
  };

  const onDropOnChannel = (target) => {
    const source = drag;
    setDrag(null); setDropHint(null);
    if (!source || source.id === target.id) return;
    if (source.kind === 'channel') {
      const categoryId = layout.groups.find((g) => g.channels.some((c) => c.id === target.id))?.category.id ?? null;
      const list = categoryId ? layout.groups.find((g) => g.category.id === categoryId).channels : layout.top;
      moveChannel(source.id, categoryId, list.findIndex((c) => c.id === target.id));
    }
  };

  const onDropOnCategory = (category) => {
    const source = drag;
    setDrag(null); setDropHint(null);
    if (!source || source.id === category.id) return;
    if (source.kind === 'channel') {
      moveChannel(source.id, category.id, Number.MAX_SAFE_INTEGER);
    } else {
      moveCategory(source.id, layout.groups.findIndex((g) => g.category.id === category.id));
    }
  };

  // --- menus -----------------------------------------------------------------

  const openCreateChannel = useCallback((type, category = null) => {
    const summaries = layout.groups.map((g) => ({
      id: g.category.id, name: g.category.name, types: g.channels.map((c) => c.type)
    }));
    setCreateChannelIntent({
      serverId, type, categories: summaries,
      categoryName: category ? category.name : undefined,
      categoryId: category?.id ?? null
    });
    onOpenCreateChannelModal(type);
  }, [layout, serverId, onOpenCreateChannelModal]);

  if (!currentServer) return null;

  const toggle = (key) => setCollapsed((prev) => {
    const next = { ...prev, [key]: !prev[key] };
    if (!next[key]) delete next[key];
    try { if (collapseKey) localStorage.setItem(collapseKey, JSON.stringify(next)); } catch { /* storage unavailable */ }
    return next;
  });

  const channelMenuItems = (channel) => {
    const muted = Boolean(channelSettings[channel.id]?.muted);
    const hasUnread = Boolean(readStates[channel.id]?.unread);
    return [
      {
        icon: Check,
        label: t('notif.markRead'),
        disabled: !hasUnread,
        action: () => onMarkChannelRead?.(channel.id)
      },
      {
        icon: Pin,
        label: pinnedIds.has(channel.id) ? t('channel.unpin') : t('channel.pin'),
        action: () => togglePinned(channel.id)
      },
      { separator: true },
      can('CREATE_INSTANT_INVITE') && {
        icon: UserPlus, label: t('server.invitePeople'), accent: true,
        action: () => onCreateInviteFor?.(channel)
      },
      {
        icon: muted ? Bell : BellOff,
        label: muted ? t('notif.unmuteChannel') : t('notif.muteChannel'),
        action: () => onMuteChannel?.(channel, !muted)
      },
      {
        icon: Bell,
        label: t('notif.notificationSettings'),
        action: () => onOpenChannelNotifications?.(channel, window.innerWidth / 2 - 130, 120)
      },
      canManageChannels && { separator: true },
      canManageChannels && {
        icon: Pencil, label: t('channel.editChannel'), action: () => onEditChannel?.(channel)
      },
      can('MANAGE_ROLES') && channel.type !== 'thread' && {
        icon: KeyRound, label: t('adm.editPermissions'),
        action: () => { setChannelSettingsTab('permissions'); onEditChannel?.(channel); }
      },
      canManageChannels && channel.type !== 'thread' && {
        icon: ArrowUp, label: t('adm.moveUp'), hint: 'Alt+↑', action: () => nudgeChannel(channel, -1)
      },
      canManageChannels && channel.type !== 'thread' && {
        icon: ArrowDown, label: t('adm.moveDown'), hint: 'Alt+↓', action: () => nudgeChannel(channel, 1)
      },
      canManageChannels && {
        icon: Trash2, label: t('channel.deleteChannel'), danger: true, action: () => onDeleteChannel?.(channel)
      },
      { separator: true },
      {
        icon: Link2,
        label: t('channel.copyLink'),
        action: () => {
          navigator.clipboard?.writeText(`${window.location.origin}/channels/${currentServer.id}/${channel.id}`);
          onToast?.(t('common.copied'), { type: 'success', ttl: 2000 });
        }
      },
      getPreferences().chat.developerMode && {
        icon: Copy,
        label: t('channel.copyId'),
        action: () => {
          navigator.clipboard?.writeText(channel.id);
          onToast?.(t('common.copied'), { type: 'success', ttl: 2000 });
        }
      }
    ].filter(Boolean);
  };

  const categoryMenuItems = (category) => {
    const group = layout.groups.find((g) => g.category.id === category.id);
    const hasUnread = (group?.channels ?? []).some((c) => readStates[c.id]?.unread);
    return [
      {
        icon: Check, label: t('notif.markRead'), disabled: !hasUnread,
        action: () => (group?.channels ?? []).forEach((c) => { if (readStates[c.id]?.unread) onMarkChannelRead?.(c.id); })
      },
      {
        icon: collapsed[category.id] ? ChevronDown : ChevronRight,
        label: collapsed[category.id] ? t('adm.expandCategory') : t('adm.collapseCategory'),
        action: () => toggle(category.id)
      },
      canManageChannels && { separator: true },
      canManageChannels && { icon: Plus, label: t('adm.createChannelHere'), action: () => openCreateChannel('text', category) },
      canManageChannels && { icon: Pencil, label: t('adm.renameCategory'), action: () => setDialog({ kind: 'renameCategory', category }) },
      canManageChannels && { icon: Settings, label: t('adm.editCategory'), action: () => onEditChannel?.({ ...category, type: 'category', server_id: serverId }) },
      can('MANAGE_ROLES') && {
        icon: KeyRound, label: t('adm.editPermissions'),
        action: () => { setChannelSettingsTab('permissions'); onEditChannel?.({ ...category, type: 'category', server_id: serverId }); }
      },
      canManageChannels && { icon: ArrowUp, label: t('adm.moveUp'), hint: 'Alt+↑', action: () => nudgeCategory(category, -1) },
      canManageChannels && { icon: ArrowDown, label: t('adm.moveDown'), hint: 'Alt+↓', action: () => nudgeCategory(category, 1) },
      canManageChannels && { icon: Trash2, label: t('adm.deleteCategory'), danger: true, action: () => setDialog({ kind: 'deleteCategory', category }) },
      getPreferences().chat.developerMode && { separator: true },
      getPreferences().chat.developerMode && {
        icon: Copy, label: t('channel.copyId'),
        action: () => { navigator.clipboard?.writeText(category.id); onToast?.(t('common.copied'), { type: 'success', ttl: 2000 }); }
      }
    ].filter(Boolean);
  };

  const voiceChannels = channels.filter((c) => c.type === 'voice' || c.type === 'stage');
  const voiceMemberMenuItems = (participant) => {
    const userId = participant.userId ?? participant.user_id;
    const channelId = participant.channelId ?? currentVoiceChannel?.id;
    const base = `/api/voice/channels/${channelId}/members/${userId}`;
    const run = (fn, done) => async () => {
      try { await fn(); if (done) onToast?.(done, { type: 'success', ttl: 2000 }); } catch (err) { onToast?.(err.message, { type: 'error' }); }
    };
    const name = participant.username;
    return [
      can('MUTE_MEMBERS') && {
        icon: participant.isServerMuted ? Mic : MicOff,
        label: participant.isServerMuted ? t('adm.serverUnmute') : t('adm.serverMute'),
        action: run(() => post(`${base}/mute`, { mute: !participant.isServerMuted }),
          participant.isServerMuted ? t('adm.unmutedMember', { name }) : t('adm.mutedMember', { name }))
      },
      can('DEAFEN_MEMBERS') && {
        icon: participant.isServerDeafened ? Headphones : VolumeX,
        label: participant.isServerDeafened ? t('adm.serverUndeafen') : t('adm.serverDeafen'),
        action: run(() => post(`${base}/deafen`, { deaf: !participant.isServerDeafened }))
      },
      can('MOVE_MEMBERS') && voiceChannels.length > 1 && {
        icon: MoveRight,
        label: t('adm.moveTo'),
        submenu: voiceChannels.filter((c) => c.id !== channelId).map((c) => ({
          label: c.name,
          action: run(() => post(`${base}/move`, { channelId: c.id }), t('adm.movedMember', { name, channel: c.name }))
        }))
      },
      can('MOVE_MEMBERS') && {
        icon: LogOut, label: t('adm.disconnect'), danger: true,
        action: run(() => del(base), t('adm.disconnectedMember', { name }))
      }
    ].filter(Boolean);
  };
  const canModerateVoice = can('MUTE_MEMBERS') || can('DEAFEN_MEMBERS') || can('MOVE_MEMBERS');

  const serverDropdownCreateChannel = (type) => openCreateChannel(type);

  const channelRowLabel = (channel, { hasUnread, mentions, muted, isPrivate }) => [
    channel.name,
    `(${t(TYPE_LABEL_KEYS[channel.type] ?? 'channel.typeText')})`,
    isPrivate ? t('adm.a11yPrivate') : null,
    hasUnread ? t('adm.a11yUnread') : null,
    mentions > 0 ? t('adm.a11yMentions', { count: mentions }) : null,
    muted ? t('adm.a11yMuted') : null
  ].filter(Boolean).join(', ');

  return (
    <>
      {/* On a phone this column is a drawer: closed by default, dismissed by
          tapping the backdrop or picking a channel. */}
      {mobileOpen && (
        <button
          type="button"
          aria-label={t('common.close')}
          onClick={onCloseMobile}
          className="md:hidden fixed inset-0 bg-black/60 z-30"
        />
      )}
      <div
        role="navigation"
        aria-label={t('adm.channelsOf', { name: currentServer.name })}
        className={`w-60 bg-d-surface flex flex-col shrink-0 select-none z-20 border-r border-d-edge/40 max-md:fixed max-md:inset-y-0 max-md:left-[72px] max-md:z-40 max-md:w-[min(20rem,calc(100vw-72px-3rem))] max-md:shadow-2xl max-md:transition-transform ${mobileOpen ? '' : 'max-md:-translate-x-[calc(100%+72px)] max-md:invisible'}`}
      >
      {/* Server header */}
      <div className="relative shrink-0">
        <button
          ref={serverButtonRef}
          onClick={() => setShowServerMenu((v) => !v)}
          onKeyDown={(e) => {
            if ((e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') && !showServerMenu) {
              e.preventDefault();
              setShowServerMenu(true);
            }
          }}
          aria-haspopup="menu"
          aria-expanded={showServerMenu}
          aria-controls={showServerMenu ? 'server-menu' : undefined}
          className="w-full h-12 px-4 shadow-sm border-b border-d-edge flex items-center justify-between gap-2 font-bold text-d-strong hover:bg-d-hover/50 transition-colors"
        >
          <span className="min-w-0 truncate text-[15px] flex items-center gap-1.5">
            <span className="truncate">{currentServer.name}</span>
            {/* `muted` is a 0/1 column; a bare `0 &&` would print "0". */}
            {Boolean(serverSettings?.muted) && <BellOff className="w-3.5 h-3.5 text-d-text4 shrink-0" />}
          </span>
          {showServerMenu ? <X className="w-4 h-4 text-d-text3 shrink-0" /> : <ChevronDown className="w-5 h-5 text-d-text3 shrink-0" />}
        </button>

        {showServerMenu && (
          <ServerDropdown
            server={currentServer}
            permissions={viewerPermissions}
            isOwner={isOwner}
            muted={Boolean(serverSettings?.muted)}
            onClose={(opts) => {
              setShowServerMenu(false);
              if (opts?.returnFocus !== false) requestAnimationFrame(() => serverButtonRef.current?.focus());
            }}
            onOpenSettings={onOpenServerSettings}
            onCreateChannel={serverDropdownCreateChannel}
            onCreateCategory={() => setDialog({ kind: 'createCategory' })}
            onCreateInvite={onCreateInvite}
            onOpenNotifications={onOpenServerNotifications}
            onOpenEvents={onOpenEvents}
            onLeave={onLeaveServer}
            onDelete={() => setDialog({ kind: 'deleteServer' })}
            onToast={onToast}
          />
        )}
      </div>

      {/* Channels */}
      <div id="channel-list" tabIndex={-1} className="flex-1 overflow-y-auto px-2 py-3 space-y-4 focus:outline-none">
        {grouped.map((group) => {
          const isCollapsed = collapsed[group.key];
          const visible = isCollapsed
            ? group.list.filter((c) => c.id === activeChannelId || readStates[c.id]?.unread)
            : group.list;
          const isVoiceCategory = group.list.length > 0 && group.list.every((c) => c.type === 'voice' || c.type === 'stage');
          const category = group.category ?? null;
          const isDropTarget = category && dropHint === category.id;

          return (
            <div key={group.key} role="group" aria-label={group.title ?? t('adm.noCategory')}>
              {group.title !== null && (
                <div
                  className={`flex items-center justify-between px-1 mb-1 text-xs font-bold text-d-text3 tracking-wider group rounded ${isDropTarget ? 'ring-2 ring-d-brand' : ''}`}
                  onContextMenu={category ? (e) => { e.preventDefault(); setChannelMenu({ category, x: e.clientX, y: e.clientY }); } : undefined}
                  onDragOver={category && drag ? (e) => { e.preventDefault(); setDropHint(category.id); } : undefined}
                  onDragLeave={category ? () => setDropHint((h) => (h === category.id ? null : h)) : undefined}
                  onDrop={category ? (e) => { e.preventDefault(); onDropOnCategory(category); } : undefined}
                >
                  <button
                    id={category ? `category-${category.id}` : undefined}
                    onClick={() => toggle(group.key)}
                    onKeyDown={category && canManageChannels ? (e) => {
                      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                        e.preventDefault();
                        nudgeCategory(category, e.key === 'ArrowUp' ? -1 : 1);
                      }
                    } : undefined}
                    aria-expanded={!isCollapsed}
                    aria-keyshortcuts={category && canManageChannels ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
                    draggable={Boolean(category && canManageChannels)}
                    onDragStart={category ? () => setDrag({ id: category.id, kind: 'category' }) : undefined}
                    onDragEnd={() => { setDrag(null); setDropHint(null); }}
                    className="flex items-center gap-1 hover:text-d-strong transition-colors min-w-0 min-h-[24px] px-1 flex-1 text-left uppercase"
                  >
                    {isCollapsed ? <ChevronRight className="w-3 h-3 shrink-0" aria-hidden="true" /> : <ChevronDown className="w-3 h-3 shrink-0" aria-hidden="true" />}
                    <span className="truncate">{group.title}</span>
                  </button>
                  {category && (
                    <span className="flex items-center shrink-0">
                      <button
                        type="button"
                        aria-label={t('adm.categoryOptions', { name: category.name })}
                        aria-haspopup="menu"
                        title={t('adm.categoryOptions', { name: category.name })}
                        onClick={(e) => {
                          const rect = e.currentTarget.getBoundingClientRect();
                          setChannelMenu({ category, x: rect.left, y: rect.bottom + 4 });
                        }}
                        className="w-6 h-6 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 focus:opacity-100 max-md:opacity-100 hover:text-d-strong"
                      >
                        <MoreHorizontal className="w-4 h-4" />
                      </button>
                      {canManageChannels && (
                        <button
                          aria-label={isVoiceCategory ? t('sidebar.createVoiceChannel') : t('sidebar.createTextChannel')}
                          onClick={() => openCreateChannel(isVoiceCategory ? 'voice' : 'text', category)}
                          className="w-6 h-6 flex items-center justify-center rounded opacity-0 group-hover:opacity-100 focus:opacity-100 max-md:opacity-100 hover:text-d-strong transition-opacity"
                          title={isVoiceCategory ? t('sidebar.createVoiceChannel') : t('sidebar.createTextChannel')}
                        >
                          <Plus className="w-4 h-4" />
                        </button>
                      )}
                    </span>
                  )}
                </div>
              )}

              <div className="space-y-[2px]">
                {visible.map((channel) => {
                  const isActive = activeChannelId === channel.id;
                  const state = readStates[channel.id] ?? {};
                  const muted = Boolean(channelSettings[channel.id]?.muted);
                  const hasUnread = Boolean(state.unread) && !isActive && !muted;
                  const mentions = muted ? 0 : (state.mention_count ?? 0);
                  const Icon = CHANNEL_ICONS[channel.type] ?? Hash;
                  const isConnectedVoice = currentVoiceChannel?.id === channel.id;
                  const isPrivate = Boolean(channel.is_private);
                  const draggable = canManageChannels && !group.pinned;

                  return (
                    <div
                      key={channel.id}
                      className={`relative group/channel rounded ${dropHint === channel.id ? 'ring-2 ring-d-brand' : ''}`}
                      onDragOver={draggable && drag?.kind === 'channel' ? (e) => { e.preventDefault(); setDropHint(channel.id); } : undefined}
                      onDrop={draggable ? (e) => { e.preventDefault(); onDropOnChannel(channel); } : undefined}
                    >
                      {hasUnread && (
                        <span aria-hidden="true" className="absolute -left-2 top-1/2 -translate-y-1/2 w-1 h-2 bg-d-strong rounded-r-full" />
                      )}

                      <button
                        id={`channel-row-${channel.id}`}
                        onClick={() => onSelectChannel(channel.id)}
                        // Warm the history cache on intent (hover / keyboard
                        // focus), so opening the channel paints at once.
                        onPointerEnter={channel.type === 'voice' || channel.type === 'stage' ? undefined : () => onPrefetchChannel?.(channel.id)}
                        onFocus={channel.type === 'voice' || channel.type === 'stage' ? undefined : () => onPrefetchChannel?.(channel.id)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setChannelMenu({ channel, x: e.clientX, y: e.clientY });
                        }}
                        onKeyDown={draggable ? (e) => {
                          if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
                            e.preventDefault();
                            nudgeChannel(channel, e.key === 'ArrowUp' ? -1 : 1);
                          } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
                            e.preventDefault();
                            const rect = e.currentTarget.getBoundingClientRect();
                            setChannelMenu({ channel, x: rect.left + 16, y: rect.bottom });
                          }
                        } : undefined}
                        draggable={draggable}
                        onDragStart={draggable ? () => setDrag({ id: channel.id, kind: 'channel' }) : undefined}
                        onDragEnd={() => { setDrag(null); setDropHint(null); }}
                        aria-current={isActive ? 'page' : undefined}
                        aria-label={channelRowLabel(channel, { hasUnread, mentions, muted, isPrivate })}
                        aria-keyshortcuts={draggable ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
                        className={`w-full min-h-[32px] flex items-center justify-between gap-2 px-2 py-1.5 rounded text-sm transition-colors ${
                          isActive || isConnectedVoice
                            ? 'bg-d-active text-d-strong font-medium'
                            : hasUnread
                            ? 'text-d-strong font-semibold hover:bg-d-hover/60'
                            : `text-d-text3 font-medium hover:bg-d-hover/60 hover:text-d-text ${muted ? 'opacity-50' : ''}`
                        } ${drag?.id === channel.id ? 'opacity-40' : ''}`}
                      >
                        <span className="flex items-center gap-2 min-w-0">
                          <span className="relative shrink-0" aria-hidden="true">
                            <Icon className={`w-5 h-5 ${isConnectedVoice ? 'text-d-online' : 'text-d-text4'}`} />
                            {isPrivate && <Lock className="w-2.5 h-2.5 absolute -bottom-0.5 -right-0.5 text-d-text3" />}
                          </span>
                          <span className="truncate">{channel.name}</span>
                        </span>

                        <span className="flex items-center gap-1 shrink-0" aria-hidden="true">
                          {muted && <BellOff className="w-3 h-3 text-d-text4" />}
                          {mentions > 0 ? (
                            <span className="bg-d-danger text-white text-[10px] font-bold min-w-[16px] h-4 px-1 rounded-full flex items-center justify-center">
                              {mentions > 99 ? '99+' : mentions}
                            </span>
                          ) : isConnectedVoice ? (
                            <span className="text-[10px] bg-d-online text-black px-1.5 py-0.5 rounded font-semibold">
                              {t('sidebar.connected')}
                            </span>
                          ) : null}
                          {/* Room for the hover actions so they never cover the badge. */}
                          {(canManageChannels || can('CREATE_INSTANT_INVITE')) && mentions === 0 && !isConnectedVoice && (
                            <span className="w-0 group-hover/channel:w-[44px] group-focus-within/channel:w-[44px] max-md:w-[44px] transition-[width]" />
                          )}
                        </span>
                      </button>

                      {/* Discord's hover actions: invite, and settings for staff. */}
                      {mentions === 0 && !isConnectedVoice && (
                        <span className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center opacity-0 group-hover/channel:opacity-100 group-focus-within/channel:opacity-100 max-md:opacity-100">
                          {can('CREATE_INSTANT_INVITE') && (
                            <button
                              type="button"
                              onClick={() => onCreateInviteFor?.(channel)}
                              aria-label={t('adm.inviteTo', { name: channel.name })}
                              title={t('adm.inviteTo', { name: channel.name })}
                              className="w-6 h-6 flex items-center justify-center rounded text-d-text3 hover:text-d-strong"
                            >
                              <UserPlus className="w-3.5 h-3.5" />
                            </button>
                          )}
                          {canManageChannels && (
                            <button
                              type="button"
                              onClick={() => onEditChannel?.(channel)}
                              aria-label={t('adm.editChannelNamed', { name: channel.name })}
                              title={t('channel.editChannel')}
                              className="w-6 h-6 flex items-center justify-center rounded text-d-text3 hover:text-d-strong"
                            >
                              <Settings className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </span>
                      )}

                      {(threadsByParent.get(channel.id) ?? []).map((thread) => {
                        const threadState = readStates[thread.id] ?? {};
                        return (
                          <button
                            key={thread.id}
                            onClick={() => onSelectChannel(thread.id)}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              setChannelMenu({ channel: thread, x: e.clientX, y: e.clientY });
                            }}
                            className={`w-full flex items-center gap-1.5 pl-7 pr-2 py-1 rounded text-xs transition-colors ${
                              activeChannelId === thread.id
                                ? 'bg-d-active text-d-strong'
                                : threadState.unread
                                ? 'text-d-strong font-semibold hover:bg-d-hover/60'
                                : 'text-d-text3 hover:bg-d-hover/60 hover:text-d-text'
                            }`}
                          >
                            <MessagesSquare className="w-3.5 h-3.5 shrink-0 text-d-text4" aria-hidden="true" />
                            <span className="truncate">{thread.name}</span>
                            {threadState.mention_count > 0 && (
                              <span className="ml-auto bg-d-danger text-white text-[9px] font-bold px-1 rounded-full shrink-0">
                                {threadState.mention_count}
                              </span>
                            )}
                          </button>
                        );
                      })}

                      {(() => {
                        // Occupants of every voice channel (Discord lists them
                        // under each one): your own room from the live voice
                        // roster, the others from the guild-wide one.
                        if (channel.type !== 'voice' && channel.type !== 'stage') return null;
                        const occupants = isConnectedVoice && activeVoiceParticipants?.length
                          ? activeVoiceParticipants
                          : (voiceRosters[channel.id] ?? []);
                        if (!occupants.length) return null;
                        return (
                        <ul className="pl-6 pr-1 py-1 space-y-0.5" aria-label={t('adm.inVoice', { name: channel.name })}>
                          {occupants.map((p) => {
                            const pid = p.userId ?? p.user_id ?? p.id;
                            const moderatable = canModerateVoice && pid !== currentUser?.id;
                            return (
                              <li
                                key={pid}
                                className="group/vm flex items-center gap-2 py-0.5 px-1 rounded text-xs text-d-text hover:bg-d-hover/40"
                                onContextMenu={moderatable ? (e) => { e.preventDefault(); setChannelMenu({ voiceMember: { ...p, channelId: channel.id }, x: e.clientX, y: e.clientY }); } : undefined}
                              >
                                <img
                                  src={proxiedImageUrl(p.avatar_url || defaultAvatar(pid))}
                                  alt=""
                                  className={`w-5 h-5 rounded-full ${p.isSpeaking ? 'ring-2 ring-d-online' : ''}`}
                                />
                                <span className="truncate flex-1">{p.username}</span>
                                {(Boolean(p.isMuted) || Boolean(p.isServerMuted)) && (
                                  <MicOff className={`w-3 h-3 ${p.isServerMuted ? 'text-d-danger' : 'text-d-text3'}`} aria-label={p.isServerMuted ? t('adm.serverMuted') : t('sidebar.mute')} />
                                )}
                                {(Boolean(p.isDeafened) || Boolean(p.isServerDeafened)) && (
                                  <Headphones className={`w-3 h-3 ${p.isServerDeafened ? 'text-d-danger' : 'text-d-text3'}`} aria-label={p.isServerDeafened ? t('adm.serverDeafened') : t('sidebar.deafen')} />
                                )}
                                {moderatable && (
                                  <button
                                    type="button"
                                    aria-haspopup="menu"
                                    aria-label={t('adm.voiceActionsFor', { name: p.username })}
                                    title={t('adm.voiceActionsFor', { name: p.username })}
                                    onClick={(e) => {
                                      const rect = e.currentTarget.getBoundingClientRect();
                                      setChannelMenu({ voiceMember: { ...p, channelId: channel.id }, x: rect.left, y: rect.bottom + 4 });
                                    }}
                                    className="w-6 h-6 flex items-center justify-center rounded text-d-text3 hover:text-d-strong opacity-0 group-hover/vm:opacity-100 focus:opacity-100 max-md:opacity-100"
                                  >
                                    <MoreHorizontal className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                        );
                      })()}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
        {canManageChannels && layout.groups.length === 0 && layout.top.length === 0 && (
          <button
            type="button"
            onClick={() => openCreateChannel('text')}
            className="w-full flex items-center gap-2 px-2 py-2 rounded text-sm text-d-text3 hover:bg-d-hover/60 hover:text-d-strong"
          >
            <Plus className="w-4 h-4" aria-hidden="true" /> {t('server.createChannel')}
          </button>
        )}
      </div>
      <p className="sr-only" role="status" aria-live="polite">{announcement}</p>

      {/* Voice status bar */}
      {currentVoiceChannel && (
        <div className="bg-d-sunken px-3 py-2 border-b border-d-edge flex items-center justify-between">
          <div className="flex flex-col min-w-0">
            <div className="flex items-center gap-1 text-d-online text-xs font-bold">
              <span className="w-2 h-2 rounded-full bg-d-online animate-pulse inline-block" aria-hidden="true" />
              {t('sidebar.voiceConnected')}
            </div>
            <span className="text-[11px] text-d-text3 truncate max-w-[130px]">{currentVoiceChannel.name}</span>
          </div>
          <button aria-label={t('sidebar.disconnect')}
            onClick={onLeaveVoice}
            className="p-1.5 bg-d-danger/20 hover:bg-d-danger text-d-danger hover:text-white rounded-full transition-colors shrink-0"
            title={t('sidebar.disconnect')}
          >
            <PhoneOff className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* User bar */}
      <div className="h-14 bg-d-panel px-2 flex items-center justify-between shrink-0 relative">
        <button
          onClick={() => setShowStatusMenu((v) => !v)}
          aria-haspopup="dialog"
          aria-expanded={showStatusMenu}
          className="flex items-center gap-2 px-1 py-1 hover:bg-d-hover/60 rounded-md flex-1 min-w-0 transition-colors text-left"
        >
          <div className="relative shrink-0">
            <img
              src={proxiedImageUrl(currentUser?.avatar_url || defaultAvatar(currentUser?.id)) || FALLBACK_AVATAR}
              alt=""
              className="w-8 h-8 rounded-full object-cover"
            />
            <span className="absolute -bottom-0.5 -right-0.5">
              <StatusIndicator status={currentUser?.status} size={10} ring="var(--color-d-panel)" />
            </span>
          </div>
          <div className="flex flex-col min-w-0">
            <span className="text-sm font-semibold text-d-strong truncate leading-tight">
              {currentUser?.display_name || currentUser?.username}
            </span>
            <span className="text-[11px] text-d-text3 truncate leading-tight">
              {currentUser?.custom_status || `@${currentUser?.username}`}
            </span>
          </div>
        </button>

        {showStatusMenu && (
          <UserStatusMenu
            currentUser={currentUser}
            onSetStatus={onSetStatus}
            onOpenSettings={onOpenUserSettingsModal}
            onClose={() => setShowStatusMenu(false)}
          />
        )}

        <div className="flex items-center gap-0.5 text-d-text2">
          <button
            onClick={onToggleMute}
            aria-pressed={isMuted}
            aria-label={isMuted ? t('sidebar.unmute') : t('sidebar.mute')}
            className={`p-1.5 hover:bg-d-hover hover:text-d-strong rounded transition-colors ${isMuted ? 'text-d-danger' : ''}`}
            title={isMuted ? t('sidebar.unmute') : t('sidebar.mute')}
          >
            {isMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
          </button>
          <button aria-label={isDeafened ? t('sidebar.undeafen') : t('sidebar.deafen')}
            onClick={onToggleDeafen}
            aria-pressed={isDeafened}
            className={`p-1.5 hover:bg-d-hover hover:text-d-strong rounded transition-colors ${isDeafened ? 'text-d-danger' : ''}`}
            title={isDeafened ? t('sidebar.undeafen') : t('sidebar.deafen')}
          >
            <Headphones className="w-5 h-5" />
          </button>
          <button aria-label={t('sidebar.userSettings')}
            onClick={onOpenUserSettingsModal}
            className="p-1.5 hover:bg-d-hover hover:text-d-strong rounded transition-colors"
            title={t('sidebar.userSettings')}
          >
            <Settings className="w-5 h-5" />
          </button>
        </div>
      </div>

      {channelMenu && (
        <ContextMenu
          x={channelMenu.x}
          y={channelMenu.y}
          items={channelMenu.category
            ? categoryMenuItems(channelMenu.category)
            : channelMenu.voiceMember
            ? voiceMemberMenuItems(channelMenu.voiceMember)
            : channelMenuItems(channelMenu.channel)}
          onClose={() => setChannelMenu(null)}
        />
      )}
      </div>

      {dialog?.kind === 'createCategory' && (
        <InputModal
          title={t('adm.createCategory')}
          label={t('adm.categoryName')}
          placeholder={t('adm.categoryPlaceholder')}
          hint={t('adm.createCategoryHint')}
          submitLabel={t('adm.createCategory')}
          onSubmit={async (name) => {
            await post('/api/channels', { server_id: serverId, name, type: 'category' });
            setAnnouncement(t('adm.categoryCreated', { name }));
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'renameCategory' && (
        <InputModal
          title={t('adm.renameCategory')}
          label={t('adm.categoryName')}
          initialValue={dialog.category.name}
          onSubmit={async (name) => {
            await patch(`/api/channels/${dialog.category.id}`, { name });
            setFetchedCategories((prev) => prev.map((c) => (c.id === dialog.category.id ? { ...c, name } : c)));
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'deleteCategory' && (
        <ConfirmModal
          title={t('adm.deleteCategoryTitle', { name: dialog.category.name })}
          body={t('adm.deleteCategoryBody')}
          confirmLabel={t('adm.deleteCategory')}
          onConfirm={async () => {
            await del(`/api/channels/${dialog.category.id}`);
            setFetchedCategories((prev) => prev.filter((c) => c.id !== dialog.category.id));
          }}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'deleteServer' && (
        <TypeToConfirmDialog
          title={t('server.deleteTitle', { name: currentServer.name })}
          body={t('adm.deleteServerBody')}
          expected={currentServer.name}
          confirmLabel={t('server.delete')}
          onConfirm={async () => {
            await del(`/api/servers/${currentServer.id}`);
            onToast?.(t('server.deleted'), { type: 'success', ttl: 3000 });
          }}
          onClose={() => setDialog(null)}
        />
      )}
    </>
  );
}
