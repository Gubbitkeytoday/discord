import React, { useMemo, useState } from 'react';
import {
  Hash, Volume2, Plus, ChevronDown, ChevronRight, Mic, MicOff, Headphones,
  Settings, PhoneOff, Megaphone, X, MessagesSquare, Bell, BellOff, Check,
  Pencil, Trash2, Copy, UserPlus, Link2, Lock, Radio
} from 'lucide-react';
import ServerDropdown from './ServerDropdown';
import ContextMenu from './ContextMenu';
import UserStatusMenu from './UserStatusMenu';
import { t } from '../i18n/index.jsx';
import { getPreferences } from '../hooks/useUserSettings';
import { DEFAULT_AVATAR } from '../utils/avatar';

const FALLBACK_AVATAR = DEFAULT_AVATAR;

const STATUS_COLORS = {
  online: 'bg-d-online',
  idle: 'bg-d-idle',
  dnd: 'bg-d-danger',
  offline: 'bg-d-text4',
  invisible: 'bg-d-text4'
};

const CHANNEL_ICONS = {
  text: Hash,
  announcement: Megaphone,
  voice: Volume2,
  forum: MessagesSquare,
  stage: Radio
};

export default function ChannelSidebar({
  currentServer,
  channels,
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
  const [collapsed, setCollapsed] = useState({});
  const [showServerMenu, setShowServerMenu] = useState(false);
  const [channelMenu, setChannelMenu] = useState(null);
  const [showStatusMenu, setShowStatusMenu] = useState(false);

  const can = (name) => viewerPermissions.includes(name) || viewerPermissions.includes('ADMINISTRATOR') || isOwner;

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

  const grouped = useMemo(() => {
    const groups = new Map();
    for (const channel of channels) {
      if (channel.type === 'thread' || channel.type === 'category') continue;
      const key = channel.category || 'CHANNELS';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(channel);
    }
    for (const list of groups.values()) {
      list.sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
    }
    return [...groups.entries()];
  }, [channels]);

  if (!currentServer) return null;

  const toggle = (category) => setCollapsed((prev) => ({ ...prev, [category]: !prev[category] }));

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
      can('MANAGE_CHANNELS') && { separator: true },
      can('MANAGE_CHANNELS') && {
        icon: Pencil, label: t('channel.editChannel'), action: () => onEditChannel?.(channel)
      },
      can('MANAGE_CHANNELS') && {
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

  return (
    <div className="w-60 bg-d-surface flex flex-col shrink-0 select-none z-10 border-r border-d-edge/40 max-md:absolute max-md:inset-y-0 max-md:left-[72px] max-md:shadow-2xl">
      {/* Server header */}
      <div className="relative shrink-0">
        <button
          onClick={() => setShowServerMenu((v) => !v)}
          aria-haspopup="menu"
          aria-expanded={showServerMenu}
          className="w-full h-12 px-4 shadow-sm border-b border-d-edge flex items-center justify-between font-bold text-d-strong hover:bg-d-hover/50 transition-colors"
        >
          <span className="truncate text-[15px] flex items-center gap-1.5">
            {currentServer.name}
            {serverSettings?.muted && <BellOff className="w-3.5 h-3.5 text-d-text4 shrink-0" />}
          </span>
          {showServerMenu ? <X className="w-4 h-4 text-d-text3" /> : <ChevronDown className="w-5 h-5 text-d-text3" />}
        </button>

        {showServerMenu && (
          <ServerDropdown
            server={currentServer}
            permissions={viewerPermissions}
            isOwner={isOwner}
            muted={Boolean(serverSettings?.muted)}
            onClose={() => setShowServerMenu(false)}
            onOpenSettings={onOpenServerSettings}
            onCreateChannel={onOpenCreateChannelModal}
            onCreateInvite={onCreateInvite}
            onOpenNotifications={onOpenServerNotifications}
            onOpenEvents={onOpenEvents}
            onLeave={onLeaveServer}
            onDelete={onDeleteServer}
            onToast={onToast}
          />
        )}
      </div>

      {/* Channels */}
      <div className="flex-1 overflow-y-auto px-2 py-3 space-y-4">
        {grouped.map(([category, list]) => {
          const isCollapsed = collapsed[category];
          const visible = isCollapsed
            ? list.filter((c) => c.id === activeChannelId || readStates[c.id]?.unread)
            : list;
          const isVoiceCategory = list.every((c) => c.type === 'voice');

          return (
            <div key={category}>
              <div className="flex items-center justify-between px-2 mb-1 text-xs font-bold text-d-text3 tracking-wider group">
                <button
                  onClick={() => toggle(category)}
                  aria-expanded={!isCollapsed}
                  className="flex items-center gap-1 hover:text-d-strong transition-colors min-w-0"
                >
                  {isCollapsed ? <ChevronRight className="w-3 h-3 shrink-0" /> : <ChevronDown className="w-3 h-3 shrink-0" />}
                  <span className="truncate">{category}</span>
                </button>
                {can('MANAGE_CHANNELS') && (
                  <button
                    onClick={() => onOpenCreateChannelModal(isVoiceCategory ? 'voice' : 'text')}
                    className="opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-d-strong transition-opacity shrink-0"
                    title={isVoiceCategory ? t('sidebar.createVoiceChannel') : t('sidebar.createTextChannel')}
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                )}
              </div>

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

                  return (
                    <div key={channel.id} className="relative group/channel">
                      {hasUnread && (
                        <span aria-hidden="true" className="absolute -left-2 top-1/2 -translate-y-1/2 w-1 h-2 bg-white rounded-r-full" />
                      )}

                      <button
                        onClick={() => onSelectChannel(channel.id)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          setChannelMenu({ channel, x: e.clientX, y: e.clientY });
                        }}
                        aria-current={isActive ? 'page' : undefined}
                        className={`w-full flex items-center justify-between gap-2 px-2 py-1.5 rounded text-sm transition-colors ${
                          isActive || isConnectedVoice
                            ? 'bg-d-active text-d-strong font-medium'
                            : hasUnread
                            ? 'text-d-strong font-semibold hover:bg-d-hover/60'
                            : `text-d-text3 font-medium hover:bg-d-hover/60 hover:text-d-text ${muted ? 'opacity-50' : ''}`
                        }`}
                      >
                        <span className="flex items-center gap-2 min-w-0">
                          <span className="relative shrink-0">
                            <Icon className={`w-5 h-5 ${isConnectedVoice ? 'text-d-online' : 'text-d-text4'}`} />
                            {isPrivate && <Lock className="w-2.5 h-2.5 absolute -bottom-0.5 -right-0.5 text-d-text3" />}
                          </span>
                          <span className="truncate">{channel.name}</span>
                        </span>

                        <span className="flex items-center gap-1 shrink-0">
                          {muted && <BellOff className="w-3 h-3 text-d-text4" />}
                          {mentions > 0 ? (
                            <span className="bg-d-danger text-white text-[10px] font-bold min-w-[16px] h-4 px-1 rounded-full flex items-center justify-center">
                              {mentions > 99 ? '99+' : mentions}
                            </span>
                          ) : isConnectedVoice ? (
                            <span className="text-[10px] bg-d-online/20 text-d-online px-1.5 py-0.5 rounded font-semibold">
                              {t('sidebar.connected')}
                            </span>
                          ) : null}
                        </span>
                      </button>

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
                            <MessagesSquare className="w-3.5 h-3.5 shrink-0 text-d-text4" />
                            <span className="truncate">{thread.name}</span>
                            {threadState.mention_count > 0 && (
                              <span className="ml-auto bg-d-danger text-white text-[9px] font-bold px-1 rounded-full shrink-0">
                                {threadState.mention_count}
                              </span>
                            )}
                          </button>
                        );
                      })}

                      {isConnectedVoice && activeVoiceParticipants.length > 0 && (
                        <div className="pl-6 pr-2 py-1 space-y-1">
                          {activeVoiceParticipants.map((p) => (
                            <div key={p.userId} className="flex items-center gap-2 py-0.5 px-1 rounded text-xs text-d-text">
                              <img
                                src={p.avatar_url || FALLBACK_AVATAR}
                                alt=""
                                className={`w-5 h-5 rounded-full ${p.isSpeaking ? 'ring-2 ring-d-online' : ''}`}
                              />
                              <span className="truncate flex-1">{p.username}</span>
                              {p.isMuted && <MicOff className="w-3 h-3 text-d-danger" />}
                              {p.isDeafened && <Headphones className="w-3 h-3 text-d-danger" />}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>

      {/* Voice status bar */}
      {currentVoiceChannel && (
        <div className="bg-d-sunken px-3 py-2 border-b border-d-edge flex items-center justify-between">
          <div className="flex flex-col min-w-0">
            <div className="flex items-center gap-1 text-d-online text-xs font-bold">
              <span className="w-2 h-2 rounded-full bg-d-online animate-pulse inline-block" />
              {t('sidebar.voiceConnected')}
            </div>
            <span className="text-[11px] text-d-text3 truncate max-w-[130px]">{currentVoiceChannel.name}</span>
          </div>
          <button
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
          aria-haspopup="menu"
          aria-expanded={showStatusMenu}
          className="flex items-center gap-2 px-1 py-1 hover:bg-d-hover/60 rounded-md flex-1 min-w-0 transition-colors text-left"
        >
          <div className="relative shrink-0">
            <img
              src={currentUser?.avatar_url || FALLBACK_AVATAR}
              alt=""
              className="w-8 h-8 rounded-full object-cover"
            />
            <span
              className={`absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-d-panel ${
                STATUS_COLORS[currentUser?.status] ?? STATUS_COLORS.offline
              }`}
            />
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
            className={`p-1.5 hover:bg-d-hover hover:text-white rounded transition-colors ${isMuted ? 'text-d-danger' : ''}`}
            title={isMuted ? t('sidebar.unmute') : t('sidebar.mute')}
          >
            {isMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
          </button>
          <button
            onClick={onToggleDeafen}
            aria-pressed={isDeafened}
            className={`p-1.5 hover:bg-d-hover hover:text-white rounded transition-colors ${isDeafened ? 'text-d-danger' : ''}`}
            title={isDeafened ? t('sidebar.undeafen') : t('sidebar.deafen')}
          >
            <Headphones className="w-5 h-5" />
          </button>
          <button
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
          items={channelMenuItems(channelMenu.channel)}
          onClose={() => setChannelMenu(null)}
        />
      )}
    </div>
  );
}
