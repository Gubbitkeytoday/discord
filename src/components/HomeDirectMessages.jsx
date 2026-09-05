import React, { useMemo, useState } from 'react';
import { t } from '../i18n/index.jsx';
import { DEFAULT_AVATAR } from '../utils/avatar';
import {
  Users, MessageSquare, X, UserPlus, Check, ShieldOff, ShieldAlert, UserMinus,
  Mic, MicOff, Headphones, Settings, PhoneOff, Plus, Inbox
} from 'lucide-react';
import UserStatusMenu from './UserStatusMenu';

const FALLBACK_AVATAR = DEFAULT_AVATAR;

const STATUS_COLORS = {
  online: 'bg-d-online',
  idle: 'bg-d-idle',
  dnd: 'bg-d-danger',
  offline: 'bg-d-text4',
  invisible: 'bg-d-text4'
};

const statusLabels = () => ({
  online: t('status.online'), idle: t('status.idle'), dnd: t('status.dnd'),
  offline: t('status.offline'), invisible: t('status.invisible')
});

const tabs = () => [
  { key: 'online', label: t('status.online') },
  { key: 'all', label: t('dm.all') },
  { key: 'pending', label: t('dm.pending') },
  { key: 'blocked', label: t('dm.blocked') }
];

/**
 * The Home surface: a DM sidebar plus either the friends dashboard or an open
 * conversation. The conversation itself is the real <ChatArea>, passed in as
 * `children` — DMs are ordinary channels server-side, so they get the same
 * grouping, reactions, editing and history as guild channels.
 */
export default function HomeDirectMessages({
  friends = [],
  dms = [],
  blocked = [],
  activeChannelId,
  readStates = {},
  currentUser,
  onSelectDm,
  onStartDm,
  onCloseDm,
  onAcceptFriend,
  onDeclineFriend,
  onAddFriend,
  onRemoveFriend,
  onBlockUser,
  onUnblockUser,
  onOpenProfile,
  onUserContextMenu,
  onCreateGroupDm,
  onOpenUserSettingsModal,
  onSetStatus,
  isMuted,
  onToggleMute,
  isDeafened,
  onToggleDeafen,
  currentVoiceChannel,
  onLeaveVoice,
  children
}) {
  const [activeTab, setActiveTab] = useState('online');
  const [addFriendInput, setAddFriendInput] = useState('');
  const [addFriendNote, setAddFriendNote] = useState('');
  const [addFriendResult, setAddFriendResult] = useState(null);
  const [filter, setFilter] = useState('');
  const [showStatusMenu, setShowStatusMenu] = useState(false);

  const acceptedFriends = useMemo(
    () => friends.filter((f) => f.friend_status === 'accepted'),
    [friends]
  );

  const pendingIncoming = useMemo(
    () => friends.filter((f) => f.friend_status === 'pending' && f.direction === 'incoming'),
    [friends]
  );

  const visibleFriends = useMemo(() => {
    const base =
      activeTab === 'online' ? acceptedFriends.filter((f) => f.status && f.status !== 'offline' && f.status !== 'invisible')
      : activeTab === 'pending' ? friends.filter((f) => f.friend_status === 'pending')
      : activeTab === 'blocked' ? blocked
      : acceptedFriends;

    if (!filter.trim()) return base;
    const needle = filter.toLowerCase();
    return base.filter((f) =>
      (f.display_name ?? '').toLowerCase().includes(needle) ||
      (f.username ?? '').toLowerCase().includes(needle)
    );
  }, [activeTab, acceptedFriends, friends, blocked, filter]);

  const visibleDms = useMemo(() => {
    if (!filter.trim()) return dms;
    const needle = filter.toLowerCase();
    return dms.filter((d) => (d.display_name ?? '').toLowerCase().includes(needle));
  }, [dms, filter]);

  const submitAddFriend = async (e) => {
    e.preventDefault();
    if (!addFriendInput.trim()) return;
    const result = await onAddFriend?.(addFriendInput.trim(), addFriendNote.trim() || null);
    setAddFriendResult(result);
    if (result?.ok) { setAddFriendInput(''); setAddFriendNote(''); }
  };

  const isConversationOpen = Boolean(activeChannelId && dms.some((d) => d.id === activeChannelId));

  return (
    <div className="flex-1 bg-d-canvas flex shrink-0 min-w-0 h-full">
      {/* DM sidebar */}
      <div className="w-60 max-md:w-48 bg-d-surface flex flex-col shrink-0 border-r border-d-edge/40">
        <div className="h-12 px-3 border-b border-d-edge flex items-center">
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t('dm.findConversation')}
            aria-label={t('dm.findConversation')}
            className="w-full bg-d-base text-xs text-d-strong placeholder-d-text3 px-2 py-1.5 rounded focus:outline-none"
          />
        </div>

        <div className="p-2 space-y-0.5">
          <button
            onClick={() => onSelectDm?.(null)}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded text-sm font-medium transition-colors ${
              !isConversationOpen ? 'bg-d-active text-d-strong' : 'text-d-text3 hover:bg-d-hover/60 hover:text-d-text'
            }`}
          >
            <Users className="w-5 h-5 text-d-text4" />
            <span>{t('dm.friends')}</span>
            {pendingIncoming.length > 0 && (
              <span className="ml-auto bg-d-danger text-white text-[10px] font-bold px-1.5 rounded-full">
                {pendingIncoming.length}
              </span>
            )}
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-2 pb-3 space-y-0.5">
          <div className="px-2 flex items-center justify-between text-xs font-bold text-d-text3 tracking-wider mb-1 mt-2">
            <span>{t('dm.directMessages')}</span>
            <button
              onClick={onCreateGroupDm}
              className="hover:text-d-strong transition-colors"
              title={t('dm.createGroup')}
              aria-label={t('dm.createGroup')}
            >
              <Plus className="w-4 h-4" />
            </button>
          </div>

          {visibleDms.length === 0 && (
            <p className="px-2 text-[11px] text-d-text4 leading-relaxed">{t('dm.noConversations')}</p>
          )}

          {visibleDms.map((dm) => {
            const isActive = dm.id === activeChannelId;
            const state = readStates[dm.id] ?? {};
            const hasUnread = Boolean(state.unread) && !isActive;
            const recipient = dm.recipients?.[0];

            return (
              <div key={dm.id} className="relative group">
                {hasUnread && (
                  <span aria-hidden="true" className="absolute -left-2 top-1/2 -translate-y-1/2 w-1 h-2 bg-white rounded-r-full" />
                )}
                <button
                  onClick={() => onSelectDm?.(dm.id)}
                  onContextMenu={(e) => {
                    if (dm.type !== 'dm' || !recipient || !onUserContextMenu) return;
                    e.preventDefault();
                    onUserContextMenu(recipient, e.clientX, e.clientY);
                  }}
                  className={`w-full flex items-center gap-3 px-2 py-2 rounded-md transition-colors ${
                    isActive ? 'bg-d-active text-d-strong'
                      : hasUnread ? 'text-d-strong hover:bg-d-hover/60'
                      : 'text-d-text3 hover:bg-d-hover/60 hover:text-d-text'
                  }`}
                >
                  <div className="relative shrink-0">
                    <img src={dm.avatar_url || FALLBACK_AVATAR} alt="" className="w-8 h-8 rounded-full object-cover" />
                    {dm.type === 'dm' && (
                      <span className={`absolute bottom-0 right-0 w-2.5 h-2.5 rounded-full border-2 border-d-surface ${
                        STATUS_COLORS[recipient?.status] ?? STATUS_COLORS.offline
                      }`} />
                    )}
                  </div>

                  <div className="flex flex-col min-w-0 text-left flex-1">
                    <span className={`text-sm truncate leading-tight ${hasUnread ? 'font-bold' : 'font-semibold'}`}>
                      {dm.display_name}
                    </span>
                    {dm.type === 'group_dm' && (
                      <span className="text-[11px] text-d-text3 leading-tight">
                        {t('dm.members', { count: (dm.recipients?.length ?? 0) + 1 })}
                      </span>
                    )}
                  </div>

                  {state.mention_count > 0 && (
                    <span className="bg-d-danger text-white text-[10px] font-bold min-w-[16px] h-4 px-1 rounded-full flex items-center justify-center">
                      {state.mention_count}
                    </span>
                  )}
                </button>

                <button
                  onClick={(e) => { e.stopPropagation(); onCloseDm?.(dm.id); }}
                  className="absolute right-1 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 focus:opacity-100 text-d-text3 hover:text-d-strong p-1 transition-opacity"
                  title={t('dm.closeConversation')}
                  aria-label={t('dm.closeConversation')}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })}
        </div>

        {currentVoiceChannel && (
          <div className="bg-d-sunken px-3 py-2 border-t border-d-edge flex items-center justify-between">
            <div className="flex flex-col min-w-0">
              <span className="flex items-center gap-1 text-d-online text-xs font-bold">
                <span className="w-2 h-2 rounded-full bg-d-online animate-pulse inline-block" />
                {t('sidebar.voiceConnected')}
              </span>
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

        {/* User bar — the same control strip as in a server */}
        <div className="h-14 bg-d-panel px-2 flex items-center justify-between shrink-0 relative">
          <button
            onClick={() => setShowStatusMenu((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={showStatusMenu}
            className="flex items-center gap-2 px-1 py-1 hover:bg-d-hover/60 rounded-md flex-1 min-w-0 transition-colors text-left"
          >
            <div className="relative shrink-0">
              <img src={currentUser?.avatar_url || FALLBACK_AVATAR} alt="" className="w-8 h-8 rounded-full object-cover" />
              <span className={`absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-d-panel ${
                STATUS_COLORS[currentUser?.status] ?? STATUS_COLORS.offline
              }`} />
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
      </div>

      {/* Conversation, or the friends dashboard */}
      {isConversationOpen ? (
        children
      ) : (
        <div className="flex-1 flex flex-col h-full bg-d-canvas min-w-0">
          <div className="h-12 px-4 shadow-sm border-b border-d-edge flex items-center gap-4 bg-d-canvas shrink-0">
            <div className="flex items-center gap-2 pr-4 border-r border-d-divider">
              <Users className="w-5 h-5 text-d-text4" />
              <span className="font-bold text-d-strong">{t('dm.friends')}</span>
            </div>

            <div className="flex items-center gap-2 text-sm font-semibold">
              {tabs().map((tab) => (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  aria-pressed={activeTab === tab.key}
                  className={`px-2 py-1 rounded transition-colors ${
                    activeTab === tab.key ? 'bg-d-active text-d-strong' : 'text-d-text2 hover:bg-d-hover/60'
                  }`}
                >
                  {tab.label}
                  {tab.key === 'pending' && pendingIncoming.length > 0 && (
                    <span className="ml-1.5 bg-d-danger text-white text-[10px] font-bold px-1.5 rounded-full">
                      {pendingIncoming.length}
                    </span>
                  )}
                </button>
              ))}
              <button
                onClick={() => setActiveTab('add')}
                className={`px-2 py-1 rounded transition-colors ${
                  activeTab === 'add' ? 'bg-d-successhover text-white' : 'bg-d-success text-white hover:bg-d-successhover'
                }`}
              >
                {t('dm.addFriend')}
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-y-auto p-6">
            {activeTab === 'add' ? (
              <div className="max-w-xl">
                <h2 className="text-base font-bold text-d-strong mb-1">{t('dm.addFriend')}</h2>
                <p className="text-xs text-d-text2 mb-3">{t('dm.addFriendHint')}</p>
                <form onSubmit={submitAddFriend} className="space-y-2">
                  <div className="flex gap-2">
                  <input
                    value={addFriendInput}
                    onChange={(e) => { setAddFriendInput(e.target.value); setAddFriendResult(null); }}
                    placeholder={t('dm.usernamePlaceholder')}
                    aria-label={t('dm.usernamePlaceholder')}
                    className="flex-1 bg-d-base text-sm text-d-strong placeholder-d-text4 px-3 py-2.5 rounded-lg border border-d-edge focus:outline-none focus:border-d-brand"
                  />
                  <button
                    type="submit"
                    disabled={!addFriendInput.trim()}
                    className="bg-d-brand hover:bg-d-brandhover disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold px-4 rounded-lg transition-colors flex items-center gap-2"
                  >
                    <UserPlus className="w-4 h-4" /> {t('dm.sendRequest')}
                  </button>
                  </div>
                  {/* Discord (Aug 2026): a note so the other side knows who you are. */}
                  <input
                    value={addFriendNote}
                    onChange={(e) => setAddFriendNote(e.target.value)}
                    maxLength={200}
                    placeholder={t('dm.requestNotePlaceholder')}
                    aria-label={t('dm.requestNote')}
                    className="w-full bg-d-base text-xs text-d-strong placeholder-d-text4 px-3 py-2 rounded-lg border border-d-edge focus:outline-none focus:border-d-brand"
                  />
                </form>

                {addFriendResult && (
                  <p className={`text-xs mt-2 ${addFriendResult.ok ? 'text-d-online' : 'text-d-danger'}`} role="status">
                    {addFriendResult.message}
                  </p>
                )}
              </div>
            ) : (
              <>
                <h2 className="text-xs font-bold text-d-text3 tracking-wider mb-4 uppercase">
                  {tabs().find((tab) => tab.key === activeTab)?.label} — {visibleFriends.length}
                </h2>

                {visibleFriends.length === 0 && (
                  <div className="text-center py-16 text-d-text3">
                    <Inbox className="w-10 h-10 mx-auto mb-3 opacity-40" />
                    <p className="text-sm">{t('dm.nobodyHere')}</p>
                  </div>
                )}

                <div className="space-y-1">
                  {visibleFriends.map((friend) => {
                    const isIncoming = friend.friend_status === 'pending' && friend.direction === 'incoming';
                    const isOutgoing = friend.friend_status === 'pending' && friend.direction === 'outgoing';
                    const isBlockedTab = activeTab === 'blocked';
                    return (
                      <div
                        key={friend.id}
                        onContextMenu={(e) => {
                          if (!onUserContextMenu) return;
                          e.preventDefault();
                          onUserContextMenu(friend, e.clientX, e.clientY);
                        }}
                        className="flex items-center justify-between p-2.5 rounded-lg hover:bg-d-hover/50 transition-colors border-t border-d-divider/30"
                      >
                        <button
                          onClick={() => onOpenProfile?.(friend.id)}
                          className="flex items-center gap-3 min-w-0 text-left flex-1"
                        >
                          <div className="relative shrink-0">
                            <img src={friend.avatar_url || FALLBACK_AVATAR} alt="" className="w-10 h-10 rounded-full object-cover" />
                            {!isBlockedTab && (
                              <span className={`absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-d-canvas ${
                                STATUS_COLORS[friend.status] ?? STATUS_COLORS.offline
                              }`} />
                            )}
                          </div>
                          <div className="min-w-0">
                            <div className="font-bold text-d-strong text-sm truncate">
                              {friend.display_name || friend.username}
                              <span className="text-d-text3 font-normal ml-1.5">@{friend.username}</span>
                            </div>
                            <div className="text-xs text-d-text3 truncate">
                              {isIncoming ? t('dm.sentYouRequest')
                                : isOutgoing ? t('dm.awaitingReply')
                                : isBlockedTab ? t('dm.blockedHint')
                                : (friend.custom_status || statusLabels()[friend.status] || '')}
                            </div>
                            {isIncoming && friend.request_note && (
                              <div className="mt-0.5 truncate text-xs italic text-d-text2">
                                “{friend.request_note}”
                              </div>
                            )}
                          </div>
                        </button>

                        <div className="flex items-center gap-2 shrink-0">
                          {isIncoming && (
                            <>
                              <button
                                onClick={() => onAcceptFriend?.(friend)}
                                className="p-2 bg-d-surface hover:bg-d-success text-d-online hover:text-white rounded-full transition-colors"
                                title={t('dm.accept')}
                                aria-label={t('dm.accept')}
                              >
                                <Check className="w-5 h-5" />
                              </button>
                              <button
                                onClick={() => onDeclineFriend?.(friend)}
                                className="p-2 bg-d-surface hover:bg-d-danger text-d-text2 hover:text-white rounded-full transition-colors"
                                title={t('dm.decline')}
                                aria-label={t('dm.decline')}
                              >
                                <X className="w-5 h-5" />
                              </button>
                            </>
                          )}
                          {isOutgoing && (
                            <button
                              onClick={() => onDeclineFriend?.(friend)}
                              className="p-2 bg-d-surface hover:bg-d-danger text-d-text2 hover:text-white rounded-full transition-colors"
                              title={t('dm.cancelRequest')}
                              aria-label={t('dm.cancelRequest')}
                            >
                              <X className="w-5 h-5" />
                            </button>
                          )}

                          {isBlockedTab ? (
                            <button
                              onClick={() => onUnblockUser?.(friend)}
                              className="p-2 bg-d-surface hover:bg-d-base text-d-text2 hover:text-d-strong rounded-full transition-colors"
                              title={t('dm.unblock')}
                              aria-label={t('dm.unblock')}
                            >
                              <ShieldOff className="w-5 h-5" />
                            </button>
                          ) : friend.friend_status === 'accepted' ? (
                            <>
                              <button
                                onClick={() => onStartDm?.(friend.id)}
                                className="p-2 bg-d-surface hover:bg-d-base text-d-text2 hover:text-d-strong rounded-full transition-colors"
                                title={t('dm.message')}
                                aria-label={t('dm.message')}
                              >
                                <MessageSquare className="w-5 h-5" />
                              </button>
                              <button
                                onClick={() => onRemoveFriend?.(friend)}
                                className="p-2 bg-d-surface hover:bg-d-base text-d-text2 hover:text-d-danger rounded-full transition-colors"
                                title={t('dm.removeFriend')}
                                aria-label={t('dm.removeFriend')}
                              >
                                <UserMinus className="w-5 h-5" />
                              </button>
                              <button
                                onClick={() => onBlockUser?.(friend)}
                                className="p-2 bg-d-surface hover:bg-d-danger text-d-text2 hover:text-white rounded-full transition-colors"
                                title={t('dm.block')}
                                aria-label={t('dm.block')}
                              >
                                <ShieldAlert className="w-5 h-5" />
                              </button>
                            </>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
