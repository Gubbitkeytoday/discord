import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { io } from 'socket.io-client';
import ServerRail from './components/ServerRail';
import ChannelSidebar from './components/ChannelSidebar';
import ChatArea from './components/ChatArea';
import VoiceRoom from './components/VoiceRoom';
import ForumView from './components/ForumView';
import OnboardingModal from './components/OnboardingModal';
import FollowChannelModal from './components/FollowChannelModal';
import MemberList from './components/MemberList';
import HomeDirectMessages from './components/HomeDirectMessages';
import UserSettingsModal from './components/UserSettingsModal';
import EventsPanel from './components/EventsPanel';
import CreateServerModal from './components/CreateServerModal';
import CreateChannelModal from './components/CreateChannelModal';
import UserProfileModal from './components/UserProfileModal';
import SearchResultsPanel from './components/SearchResultsPanel';
import QuickSwitcher from './components/QuickSwitcher';
import ToastStack, { useToasts } from './components/ToastStack';
import ServerSettingsModal from './components/ServerSettingsModal';
import LoginScreen from './components/LoginScreen';
import ConfirmModal from './components/ConfirmModal';
import InputModal from './components/InputModal';
import InviteJoinScreen from './components/InviteJoinScreen';
import ChannelSettingsModal from './components/ChannelSettingsModal';
import NotificationSettingsPopover from './components/NotificationSettingsPopover';
import MemberContextMenu from './components/MemberContextMenu';
import ForwardMessageModal from './components/ForwardMessageModal';
import CreateGroupDmModal from './components/CreateGroupDmModal';
import NotificationsInbox from './components/NotificationsInbox';
import { api, get, post, put, patch, del, upload, setApiIdentity } from './api';
import { maskOf } from './utils/permissionCatalog';
import {
  useUserSettings, loadPreferences, hydratePreferences, applyCategoryFromServer,
  updatePreferences
} from './hooks/useUserSettings';
import { useKeybinds } from './hooks/useKeybinds';
import { playSound, notifyMessage, speakMessage, applyUnreadBadge } from './utils/notifier';
import { t } from './i18n/index.jsx';

// Same origin in production (the API serves the SPA); the Vite dev server
// proxies /socket.io to :3001, so a relative connection works in both.
const socket = io({ withCredentials: true, autoConnect: true });

const PAGE_SIZE = 50;
const LAST_SERVER_KEY = 'antigravity.lastServer';

// Bumped with every db.js migration. The client compares it to the running
// server's own number (GET /api/health) so a stale backend is loud, not silent.
const EXPECTED_SCHEMA_VERSION = 14;

/** Parse a Discord-style path: /channels/@me/:dm, /channels/:server/:channel, /invite/:code */
function parseLocation() {
  const parts = window.location.pathname.split('/').filter(Boolean);
  if (parts[0] === 'invite' && parts[1]) return { invite: parts[1] };
  if (parts[0] === 'template' && parts[1]) return { template: parts[1] };
  if (parts[0] === 'channels') {
    return {
      serverId: parts[1] === '@me' ? 'home' : parts[1] ?? null,
      channelId: parts[2] ?? null,
      messageId: parts[3] ?? null
    };
  }
  return {};
}

export default function App() {
  const [currentUser, setCurrentUser] = useState(null);
  const [currentUserId, setCurrentUserId] = useState(null);
  // null = still checking, false = not signed in, true = signed in
  const [authState, setAuthState] = useState(null);
  const [authToken, setAuthToken] = useState(null);
  const [devAccounts, setDevAccounts] = useState([]);

  const [servers, setServers] = useState([]);
  const [activeServerId, setActiveServerId] = useState(() => {
    const loc = parseLocation();
    if (loc.serverId) return loc.serverId;
    try { return localStorage.getItem(LAST_SERVER_KEY) || 'home'; } catch { return 'home'; }
  });
  const [channels, setChannels] = useState([]);
  const [activeChannelId, setActiveChannelId] = useState(() => parseLocation().channelId ?? null);
  const [pendingJumpMessageId, setPendingJumpMessageId] = useState(() => parseLocation().messageId ?? null);
  const [inviteCode, setInviteCode] = useState(() => parseLocation().invite ?? null);
  const [messages, setMessages] = useState([]);
  const [members, setMembers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [serverEmojis, setServerEmojis] = useState([]);
  const [externalEmojiGroups, setExternalEmojiGroups] = useState([]);   // emoji from every server I am in
  const [serverStickers, setServerStickers] = useState([]);
  const [friends, setFriends] = useState([]);
  const [dmChannels, setDmChannels] = useState([]);
  const [blocked, setBlocked] = useState([]);
  const [pins, setPins] = useState([]);

  // Per-user notification settings, keyed by channel / server id.
  const [channelSettings, setChannelSettings] = useState({});
  const [serverSettings, setServerSettings] = useState({});
  const [notifications, setNotifications] = useState([]);

  // Read state & history paging
  const [readStates, setReadStates] = useState({});
  const [channelReadMarker, setChannelReadMarker] = useState(null);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);

  // Typing: channelId -> { userId -> { displayName, at } }
  const [typingByChannel, setTypingByChannel] = useState({});

  // Search
  const [searchResults, setSearchResults] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');

  // Voice
  const [currentVoiceChannel, setCurrentVoiceChannel] = useState(null);
  const [activeVoiceParticipants, setActiveVoiceParticipants] = useState([]);
  const [isMuted, setIsMuted] = useState(false);
  const [isDeafened, setIsDeafened] = useState(false);

  // Modals & UI
  const [showMemberList, setShowMemberList] = useState(true);
  // A /template/:code link opens the "use template" flow with the code filled in.
  const [showCreateServerModal, setShowCreateServerModal] = useState(() => (parseLocation().template ? { templateCode: parseLocation().template } : false));
  const [showCreateChannelModal, setShowCreateChannelModal] = useState(false);
  const [createChannelDefaultType, setCreateChannelDefaultType] = useState('text');
  const [showUserSettingsModal, setShowUserSettingsModal] = useState(false);
  const [showEvents, setShowEvents] = useState(false);
  const [selectedProfileUser, setSelectedProfileUser] = useState(null);
  const [showQuickSwitcher, setShowQuickSwitcher] = useState(false);
  const [serverSettingsTab, setServerSettingsTab] = useState(null);
  const [viewerPermissions, setViewerPermissions] = useState([]);
  const [onboardingFor, setOnboardingFor] = useState(null);   // serverId whose onboarding flow is open
  const [confirm, setConfirm] = useState(null);           // ConfirmModal props
  const [inputModal, setInputModal] = useState(null);     // InputModal props
  const [channelSettingsFor, setChannelSettingsFor] = useState(null);
  const [notifPopover, setNotifPopover] = useState(null); // { kind:'channel'|'server', id, x, y }
  const [memberMenu, setMemberMenu] = useState(null);     // { user, x, y }
  const [forwardMessage, setForwardMessage] = useState(null);
  const [followSource, setFollowSource] = useState(null);   // announcement channel being followed
  const [showGroupDmModal, setShowGroupDmModal] = useState(false);
  const [showInbox, setShowInbox] = useState(false);
  const { toasts, push: pushToast, dismiss: dismissToast } = useToasts();
  const { prefs } = useUserSettings();

  // The gateway will not let an unidentified socket join a room, and `identify`
  // is async server-side — so joins must wait for the `identified` reply rather
  // than being emitted in the same tick. These remember what to (re)join.
  const identifiedRef = useRef(false);
  const wantedServerRef = useRef(null);
  const wantedChannelRef = useRef(null);

  const activeChannelIdRef = useRef(null);
  activeChannelIdRef.current = activeChannelId;
  const allChannelsRef = useRef([]);
  const activeServerIdRef = useRef(null);
  activeServerIdRef.current = activeServerId;
  const currentUserRef = useRef(null);
  currentUserRef.current = currentUser;
  const channelSettingsRef = useRef({});
  channelSettingsRef.current = channelSettings;
  const serverSettingsRef = useRef({});
  serverSettingsRef.current = serverSettings;

  const toastError = useCallback((err) => pushToast(err?.message ?? String(err), { type: 'error' }), [pushToast]);

  // --- session -----------------------------------------------------------------

  useEffect(() => {
    get('/api/auth/me')
      .then((data) => {
        if (data?.user) {
          setApiIdentity({ userId: data.user.id });
          setCurrentUser(data.user);
          setCurrentUserId(data.user.id);
          setAuthState(true);
        } else {
          setAuthState(false);
        }
      })
      .catch(() => setAuthState(false));

    // Seed accounts for one-click sign-in exist only while the dev identity
    // shortcut is enabled server-side; production returns an empty list.
    if (import.meta.env.DEV) {
      get('/api/auth/dev-accounts').then((rows) => setDevAccounts(Array.isArray(rows) ? rows : [])).catch(() => {});
    }
  }, []);

  /** Join the rooms we want, but only once the gateway knows who we are. */
  const joinWantedRooms = useCallback(() => {
    if (!identifiedRef.current) return;
    if (wantedServerRef.current && wantedServerRef.current !== 'home') {
      socket.emit('join_server', wantedServerRef.current);
    }
    if (wantedChannelRef.current) socket.emit('join_channel', wantedChannelRef.current);
  }, []);

  const handleAuthenticated = useCallback((user, token) => {
    setApiIdentity({ userId: user.id, token });
    setCurrentUser(user);
    setCurrentUserId(user.id);
    setAuthToken(token);
    setAuthState(true);
    socket.emit('identify', { userId: user.id, token });
  }, []);

  const handleSignOut = useCallback(async () => {
    try { await post('/api/auth/logout'); } catch { /* offline */ }
    setApiIdentity({});
    setAuthState(false);
    setCurrentUser(null);
    setCurrentUserId(null);
    setAuthToken(null);
    setServers([]); setChannels([]); setMessages([]); setDmChannels([]); setFriends([]);
    setActiveServerId('home'); setActiveChannelId(null);
    window.history.replaceState(null, '', '/');
  }, []);

  // --- data loading --------------------------------------------------------------

  const loadReadStates = useCallback((userId) => {
    get(`/api/read-states/${userId}`)
      .then((rows) => {
        const map = {};
        for (const row of rows || []) map[row.channel_id] = row;
        setReadStates(map);
      })
      .catch((err) => console.error('Failed to load read states:', err));
  }, []);

  const loadInitialData = useCallback(async (userId) => {
    try {
      const data = await get(`/api/initial-data/${userId}`);
      setCurrentUser(data.currentUser);
      setServers(data.servers || []);
      setFriends(data.friends || []);
      setDmChannels(data.dms || []);
    } catch (err) {
      console.error('Failed to load initial data:', err);
    }
    get('/api/blocks').then((rows) => setBlocked(Array.isArray(rows) ? rows : [])).catch(() => setBlocked([]));

    // Dev sanity check: Vite hot-reloads the client, but a Node server started
    // before the code changed keeps serving the old routes — every new feature
    // then 404s with no clue why. Say so out loud instead.
    get('/api/health').then((health) => {
      if (!health) return;
      // A server built before this check has no code_schema_version at all —
      // which is itself proof that it predates the client, so fall back to the
      // database version it does report.
      const running = Number(health.code_schema_version ?? health.schema_version ?? 0);
      if (running < EXPECTED_SCHEMA_VERSION) {
        pushToast(t('app.serverOutdated', { running, expected: EXPECTED_SCHEMA_VERSION }), { type: 'error', ttl: 15000 });
      }
    }).catch(() => {});
    get('/api/users/@me/emojis').then((rows) => setExternalEmojiGroups(Array.isArray(rows) ? rows : [])).catch(() => setExternalEmojiGroups([]));
    get('/api/settings/me').then((data) => {
      const c = {}; for (const row of data?.channels ?? []) c[row.channel_id] = row;
      const s = {}; for (const row of data?.servers ?? []) s[row.server_id] = row;
      setChannelSettings(c); setServerSettings(s);
      // Appearance, accessibility, voice, keybinds… all arrive with this call,
      // so there is no second round trip before the app looks right.
      if (data?.preferences) hydratePreferences(data.preferences);
      else loadPreferences();
    }).catch(() => {});
    get(`/api/notifications/${userId}?limit=50`).then((rows) => setNotifications(Array.isArray(rows) ? rows : [])).catch(() => {});
  }, []);

  useEffect(() => {
    if (!currentUserId) return;
    loadInitialData(currentUserId);
    identifiedRef.current = false;
    socket.emit('identify', { userId: currentUserId, token: authToken });
    loadReadStates(currentUserId);
  }, [currentUserId, authToken, loadInitialData, loadReadStates]);

  // The gateway confirms identity before it will accept a room join.
  useEffect(() => {
    const onIdentified = () => {
      identifiedRef.current = true;
      joinWantedRooms();
    };
    socket.on('identified', onIdentified);
    return () => socket.off('identified', onIdentified);
  }, [joinWantedRooms]);

  // Re-identify after a reconnect so presence and rooms are restored.
  useEffect(() => {
    const onConnect = () => {
      if (!currentUserRef.current) return;
      // A reconnect starts from an anonymous socket; identify again and let the
      // `identified` reply re-join the rooms.
      identifiedRef.current = false;
      socket.emit('identify', { userId: currentUserRef.current.id, token: authToken });
    };
    socket.on('connect', onConnect);
    return () => socket.off('connect', onConnect);
  }, [authToken]);

  /** (Re)load a guild's channels, members, roles, emojis and stickers. */
  const loadServer = useCallback(async (serverId, { keepChannel = false } = {}) => {
    if (!serverId || serverId === 'home') return;
    try {
      const [data, perms, stickers] = await Promise.all([
        get(`/api/servers/${serverId}`),
        get(`/api/servers/${serverId}/permissions/${currentUserId}`).catch(() => ({ permission_names: [] })),
        get(`/api/servers/${serverId}/stickers`).catch(() => [])
      ]);
      // Threads for every channel are loaded lazily per channel; keep the ones we know.
      setChannels((prev) => {
        const threads = keepChannel ? prev.filter((c) => c.type === 'thread' && c.server_id === serverId) : [];
        return [...(data.channels || []), ...threads];
      });
      setMembers(data.members || []);
      setRoles(data.roles || []);
      setServerEmojis(data.emojis || []);
      setServerStickers(Array.isArray(stickers) ? stickers : []);
      setViewerPermissions(perms.permission_names ?? []);
      // Newcomers: a pending member must pass screening; anyone else sees the
      // welcome/onboarding flow once per server (remembered locally).
      if (data.viewer_pending) {
        setOnboardingFor(serverId);
      } else if (data.has_onboarding) {
        let seen = false;
        try { seen = localStorage.getItem(`onboarding-seen:${serverId}:${currentUserId}`) === '1'; } catch { /* storage unavailable */ }
        if (!seen) setOnboardingFor(serverId);
      }
      if (data.server) {
        setServers((prev) => prev.map((s) => (s.id === serverId ? { ...s, ...data.server } : s)));
      }
      if (!keepChannel) {
        const wanted = activeChannelIdRef.current;
        const stillThere = wanted && data.channels?.some((c) => c.id === wanted);
        if (!stillThere) {
          const firstText = data.channels?.find((c) => c.type === 'text' || c.type === 'announcement');
          setActiveChannelId(firstText?.id ?? data.channels?.[0]?.id ?? null);
        }
      }
    } catch (err) {
      if (err.status === 403 || err.status === 404) {
        // Not a member any more (kicked, banned, server deleted) — go home.
        setServers((prev) => prev.filter((s) => s.id !== serverId));
        setActiveServerId('home');
        pushToast(err.message, { type: 'error' });
      } else {
        console.error('Failed to load server details:', err);
      }
    }
  }, [currentUserId, pushToast]);

  useEffect(() => {
    if (!currentUserId || !activeServerId) return;
    try { localStorage.setItem(LAST_SERVER_KEY, activeServerId); } catch { /* ignore */ }
    if (activeServerId === 'home') {
      setViewerPermissions([]);
      setMembers([]);
      return;
    }
    loadServer(activeServerId);
    wantedServerRef.current = activeServerId;
    joinWantedRooms();
  }, [activeServerId, currentUserId, loadServer, joinWantedRooms]);

  // Guild channels and DM channels are the same thing server-side.
  const allChannels = useMemo(() => [...channels, ...dmChannels], [channels, dmChannels]);
  allChannelsRef.current = allChannels;

  const markChannelRead = useCallback((channelId, messageId) => {
    socket.emit('mark_read', { channelId, messageId });
    setReadStates((prev) => ({
      ...prev,
      [channelId]: { ...prev[channelId], channel_id: channelId, unread: 0, mention_count: 0, last_read_message_id: messageId }
    }));
  }, []);

  const loadPins = useCallback((channelId) => {
    get(`/api/messages/${channelId}/pins`)
      .then((rows) => { if (activeChannelIdRef.current === channelId) setPins(Array.isArray(rows) ? rows : []); })
      .catch(() => setPins([]));
  }, []);

  // Whether the open channel is known yet — the effect below waits for it, but
  // must not re-run for every other channel that arrives.
  const channelExists = allChannels.some((c) => c.id === activeChannelId);

  // Load a channel's most recent page.
  useEffect(() => {
    if (!activeChannelId) { setPins([]); return; }
    const activeChan = allChannelsRef.current.find((c) => c.id === activeChannelId);
    if (!activeChan) return;

    // Keep the address bar Discord-shaped so links can be shared.
    const path = activeServerId === 'home'
      ? `/channels/@me/${activeChannelId}`
      : `/channels/${activeServerId}/${activeChannelId}`;
    if (window.location.pathname !== path && !pendingJumpMessageId) window.history.replaceState(null, '', path);

    if (activeChan.type === 'voice' || activeChan.type === 'stage') {
      handleJoinVoice(activeChan);
      return;
    }

    setChannelReadMarker(readStates[activeChannelId]?.last_read_message_id ?? null);
    setSearchResults(null);
    setPins([]);

    const query = pendingJumpMessageId
      ? `around=${pendingJumpMessageId}&limit=${PAGE_SIZE}`
      : `limit=${PAGE_SIZE}`;
    get(`/api/messages/${activeChannelId}?${query}`)
      .then((list) => {
        list = Array.isArray(list) ? list : [];
        setMessages(list);
        setHasMoreHistory(list.length >= PAGE_SIZE || Boolean(pendingJumpMessageId));
        if (list.length && !pendingJumpMessageId) markChannelRead(activeChannelId, list[list.length - 1].id);
        if (pendingJumpMessageId) {
          const id = pendingJumpMessageId;
          setPendingJumpMessageId(null);
          setTimeout(() => flashMessage(id), 150);
        }
      })
      .catch((err) => {
        setMessages([]);
        if (err.status === 403) pushToast(err.message, { type: 'error' });
      });

    loadPins(activeChannelId);

    if (activeChan.type !== 'thread' && activeChan.server_id) {
      get(`/api/channels/${activeChannelId}/threads`)
        .then((threads) => {
          if (!Array.isArray(threads) || threads.length === 0) return;
          setChannels((prev) => {
            const known = new Set(prev.map((c) => c.id));
            return [...prev, ...threads.filter((th) => !known.has(th.id))];
          });
        })
        .catch(() => {});
    }

    wantedChannelRef.current = activeChannelId;
    joinWantedRooms();
    return () => {
      socket.emit('leave_channel', activeChannelId);
      if (wantedChannelRef.current === activeChannelId) wantedChannelRef.current = null;
    };
    // Deliberately narrow. `readStates` would reset the frozen unread marker on
    // every update, and depending on the channel list would refetch this
    // channel's history every time any channel or thread appears anywhere.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeChannelId, channelExists, currentUserId]);

  const handleLoadMore = useCallback(() => {
    if (!activeChannelId || !messages.length || isLoadingHistory) return;
    setIsLoadingHistory(true);
    get(`/api/messages/${activeChannelId}?limit=${PAGE_SIZE}&before=${messages[0].id}`)
      .then((older) => {
        setMessages((prev) => [...(older || []), ...prev]);
        setHasMoreHistory((older || []).length >= PAGE_SIZE);
      })
      .catch((err) => console.error('Failed to load history:', err))
      .finally(() => setIsLoadingHistory(false));
  }, [activeChannelId, messages, isLoadingHistory]);

  const flashMessage = (messageId) => {
    requestAnimationFrame(() => {
      const node = document.getElementById(`message-${messageId}`);
      if (!node) return;
      node.scrollIntoView({ behavior: 'smooth', block: 'center' });
      node.classList.add('ring-2', 'ring-d-brand');
      setTimeout(() => node.classList.remove('ring-2', 'ring-d-brand'), 1800);
    });
  };

  // --- socket listeners ----------------------------------------------------------

  useEffect(() => {
    const bumpUnread = (channelId, messageId, { mention = false } = {}) =>
      setReadStates((prev) => ({
        ...prev,
        [channelId]: {
          ...prev[channelId],
          channel_id: channelId,
          unread: 1,
          last_message_id: messageId ?? prev[channelId]?.last_message_id,
          mention_count: (prev[channelId]?.mention_count ?? 0) + (mention ? 1 : 0)
        }
      }));

    const onNewMessage = (msg) => {
      if (msg.channel_id === activeChannelIdRef.current) {
        setMessages((prev) => {
          const pendingIdx = msg.nonce ? prev.findIndex((m) => m.pending && m.nonce === msg.nonce) : -1;
          if (pendingIdx !== -1) {
            const next = [...prev];
            next[pendingIdx] = msg;
            return next;
          }
          if (prev.some((m) => m.id === msg.id)) return prev;
          return [...prev, msg];
        });
        if (document.visibilityState === 'visible') markChannelRead(msg.channel_id, msg.id);
        else bumpUnread(msg.channel_id, msg.id);
      } else {
        bumpUnread(msg.channel_id, msg.id);
        const muted = Boolean(
          channelSettingsRef.current[msg.channel_id]?.muted
          || (msg.server_id && serverSettingsRef.current[msg.server_id]?.muted)
        );
        // A DM is a direct ping; a guild message is ambient unless it mentions
        // you, and that arrives separately as a notification.
        if (!muted && !msg.server_id && msg.user_id !== currentUserRef.current?.id
            && currentUserRef.current?.status !== 'dnd') {
          playSound('message');
          notifyMessage({
            title: msg.display_name ?? msg.username,
            body: msg.content,
            icon: msg.avatar_url,
            tag: `channel-${msg.channel_id}`,
            muted,
            status: currentUserRef.current?.status,
            onClick: () => { setActiveServerId('home'); setActiveChannelId(msg.channel_id); }
          });
        }
      }
      // A DM that was closed re-appears when the other person writes.
      if (!msg.server_id) {
        setDmChannels((prev) => {
          if (prev.some((d) => d.id === msg.channel_id)) {
            return [...prev].sort((a, b) => (a.id === msg.channel_id ? -1 : b.id === msg.channel_id ? 1 : 0));
          }
          get(`/api/dms/${currentUserRef.current?.id}`).then((rows) => setDmChannels(Array.isArray(rows) ? rows : [])).catch(() => {});
          return prev;
        });
      }
    };

    // Lightweight ping for channels we are not looking at.
    const onChannelActivity = ({ channel_id, message_id, author_id }) => {
      if (channel_id === activeChannelIdRef.current) return;
      if (author_id === currentUserRef.current?.id) return;
      bumpUnread(channel_id, message_id);
    };

    const onMessageDeleted = (id) => {
      setMessages((prev) => prev.filter((m) => m.id !== id));
      setPins((prev) => prev.filter((m) => m.id !== id));
    };
    const onMessageUpdated = (msg) => {
      setMessages((prev) => prev.map((m) => (m.id === msg.id ? msg : m)));
      setPins((prev) => prev.map((m) => (m.id === msg.id ? msg : m)));
    };
    const onReactionUpdated = ({ messageId, reactions, reaction_details }) =>
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, reactions, reaction_details } : m)));

    // A poll's numbers change far more often than the message around it, so the
    // server sends just the poll. `my_votes` is deliberately absent from the
    // broadcast — it is per-viewer — so keep whatever this client already knows.
    const onPollUpdated = (poll) =>
      setMessages((prev) => prev.map((m) => (
        m.id === poll.message_id
          ? { ...m, poll: { ...poll, my_votes: m.poll?.my_votes ?? [] } }
          : m
      )));

    // Fifteen minutes before an event you marked interest in.
    const onEventReminder = ({ name }) =>
      pushToast(t('events.reminder', { name }), { type: 'info', ttl: 8000 });

    const onPinsUpdated = ({ channelId }) => {
      if (channelId === activeChannelIdRef.current) loadPins(channelId);
    };

    const onTyping = ({ channelId, userId, displayName }) =>
      setTypingByChannel((prev) => ({
        ...prev, [channelId]: { ...prev[channelId], [userId]: { displayName, at: Date.now() } }
      }));
    const onTypingStop = ({ channelId, userId }) =>
      setTypingByChannel((prev) => {
        const channel = { ...(prev[channelId] ?? {}) };
        delete channel[userId];
        return { ...prev, [channelId]: channel };
      });

    const onPresence = ({ userId, status, custom_status }) => {
      const apply = (u) => (u.id === userId ? { ...u, status, ...(custom_status !== undefined ? { custom_status } : {}) } : u);
      setMembers((prev) => prev.map(apply));
      setFriends((prev) => prev.map(apply));
      setDmChannels((prev) => prev.map((d) => ({ ...d, recipients: (d.recipients ?? []).map(apply) })));
      setCurrentUser((prev) => (prev?.id === userId ? { ...prev, status } : prev));
    };

    const onNotification = (notification) => {
      const { channel_id } = notification;
      setNotifications((prev) => [notification, ...prev].slice(0, 100));
      const isCurrent = channel_id === activeChannelIdRef.current && document.visibilityState === 'visible';
      const muted = Boolean(
        channelSettingsRef.current[channel_id]?.muted
        || (notification.message?.server_id && serverSettingsRef.current[notification.message.server_id]?.muted)
      );

      if (!isCurrent) {
        if (!muted && currentUserRef.current?.status !== 'dnd') playSound('mention');
        notifyMessage({
          title: notification.actor_name ?? notification.message?.display_name ?? t('notif.newMessage'),
          body: notification.preview ?? notification.body ?? notification.message?.content ?? '',
          icon: notification.actor_avatar ?? notification.message?.avatar_url,
          tag: `channel-${channel_id}`,
          muted,
          status: currentUserRef.current?.status,
          onClick: () => setActiveChannelId(channel_id)
        });
        bumpUnread(channel_id, notification.message?.id, { mention: true });
      }

      speakMessage({
        author: notification.actor_name ?? notification.message?.display_name ?? '',
        content: notification.preview ?? notification.message?.content ?? '',
        isCurrentChannel: channel_id === activeChannelIdRef.current
      });
    };

    const onReadStateUpdated = (state) =>
      setReadStates((prev) => ({
        ...prev,
        [state.channel_id]: { ...prev[state.channel_id], ...state, unread: 0 }
      }));

    const onVoiceParticipants = ({ participants }) => setActiveVoiceParticipants(participants || []);

    // The server moved us (AFK sweep). Point the client at the new channel so the
    // mesh re-forms there; the server has already updated the rosters.
    const onVoiceMoved = ({ to, reason }) => {
      const target = allChannelsRef.current?.find((c) => c.id === to);
      if (target) setCurrentVoiceChannel(target);
      if (reason === 'afk') pushToast(t('voice.movedToAfk'), { type: 'info', ttl: 4000 });
    };
    const onVoiceError = ({ error }) => {
      setCurrentVoiceChannel(null);
      setActiveVoiceParticipants([]);
      pushToast(error, { type: 'error' });
    };
    const onVoiceSpeaking = ({ userId, isSpeaking }) =>
      setActiveVoiceParticipants((prev) => prev.map((p) => (p.userId === userId ? { ...p, isSpeaking } : p)));

    const onUserUpdated = (updatedUser) => {
      setCurrentUser((prev) => (prev?.id === updatedUser.id ? { ...prev, ...updatedUser } : prev));
      setMembers((prev) => prev.map((m) => (m.id === updatedUser.id ? { ...m, ...updatedUser, display_name: m.nickname || updatedUser.display_name } : m)));
      setFriends((prev) => prev.map((f) => (f.id === updatedUser.id ? { ...f, ...updatedUser } : f)));
    };

    // --- guild structure -----------------------------------------------------
    const onChannelCreated = (channel) =>
      setChannels((prev) => (prev.some((c) => c.id === channel.id) ? prev : [...prev, channel]));
    const onChannelUpdated = (channel) => {
      setChannels((prev) => prev.map((c) => (c.id === channel.id ? { ...c, ...channel } : c)));
    };
    const onChannelDeleted = ({ id }) => {
      setChannels((prev) => prev.filter((c) => c.id !== id && c.parent_id !== id));
      if (activeChannelIdRef.current === id) setActiveChannelId(null);
    };
    const refreshServer = () => {
      if (activeServerIdRef.current && activeServerIdRef.current !== 'home') {
        loadServer(activeServerIdRef.current, { keepChannel: true });
      }
    };
    const forActiveServer = (fn) => (payload) => {
      const sid = payload?.serverId ?? payload?.server_id ?? payload?.id;
      if (!sid || sid === activeServerIdRef.current) fn(payload);
    };
    const onMemberJoined = forActiveServer(({ member }) => {
      if (!member?.id) return refreshServer();
      setMembers((prev) => (prev.some((m) => m.id === member.id) ? prev : [...prev, member]));
      setServers((prev) => prev.map((s) => (s.id === activeServerIdRef.current ? { ...s, member_count: (s.member_count ?? 0) + 1 } : s)));
    });
    const onMemberRemoved = ({ serverId, userId, reason }) => {
      if (userId === currentUserRef.current?.id && reason !== 'leave') {
        setServers((prev) => prev.filter((s) => s.id !== serverId));
        if (activeServerIdRef.current === serverId) setActiveServerId('home');
        pushToast(reason === 'ban' ? t('server.youWereBanned') : t('server.youWereKicked'), { type: 'error' });
        return;
      }
      if (serverId === activeServerIdRef.current) {
        setMembers((prev) => prev.filter((m) => m.id !== userId));
        setServers((prev) => prev.map((s) => (s.id === serverId ? { ...s, member_count: Math.max(0, (s.member_count ?? 1) - 1) } : s)));
      }
    };
    const onServerUpdated = (server) =>
      setServers((prev) => prev.map((s) => (s.id === server.id ? { ...s, ...server } : s)));
    const onServerDeleted = ({ id }) => {
      setServers((prev) => prev.filter((s) => s.id !== id));
      if (activeServerIdRef.current === id) {
        setActiveServerId('home');
        pushToast(t('server.deletedByOwner'), { type: 'info' });
      }
    };
    const onEmojiCreated = forActiveServer((emoji) => setServerEmojis((prev) => [...prev.filter((e) => e.id !== emoji.id), emoji]));
    const onEmojiDeleted = ({ emojiId }) => setServerEmojis((prev) => prev.filter((e) => e.id !== emojiId));
    // The cross-server picker is a cheap aggregate; refetch on any emoji change.
    const refreshExternalEmoji = () => get('/api/users/@me/emojis').then((rows) => setExternalEmojiGroups(Array.isArray(rows) ? rows : [])).catch(() => {});
    const onStickerCreated = forActiveServer((sticker) => setServerStickers((prev) => [...prev.filter((s) => s.id !== sticker.id), sticker]));
    const onStickerDeleted = ({ stickerId }) => setServerStickers((prev) => prev.filter((s) => s.id !== stickerId));

    // --- friends & DMs -------------------------------------------------------
    const upsertFriend = (payload) => setFriends((prev) => {
      const rest = prev.filter((f) => f.id !== payload.id);
      return [...rest, payload];
    });
    const onFriendRequest = (payload) => {
      upsertFriend(payload);
      if (payload.direction === 'incoming') {
        pushToast(t('dm.incomingRequest', { name: payload.display_name || payload.username }), { type: 'info' });
      }
    };
    const onFriendAdded = (payload) => upsertFriend({ ...payload, friend_status: 'accepted' });
    const onFriendRemoved = ({ user_id }) => setFriends((prev) => prev.filter((f) => f.id !== user_id));
    const onDmCreated = (channel) => setDmChannels((prev) => (prev.some((d) => d.id === channel.id) ? prev.map((d) => (d.id === channel.id ? channel : d)) : [channel, ...prev]));
    const onDmRemoved = ({ id }) => {
      setDmChannels((prev) => prev.filter((d) => d.id !== id));
      if (activeChannelIdRef.current === id) setActiveChannelId(null);
    };

    const onActionError = ({ error }) => pushToast(error, { type: 'error' });
    const onIdentifyError = () => {
      // The session is gone server-side; the only honest answer is the login screen.
      handleSignOut();
    };

    const handlers = {
      new_message: onNewMessage,
      channel_activity: onChannelActivity,
      message_deleted: onMessageDeleted,
      message_updated: onMessageUpdated,
      reaction_updated: onReactionUpdated,
      poll_updated: onPollUpdated,
      event_reminder: onEventReminder,
      pins_updated: onPinsUpdated,
      typing: onTyping,
      typing_stop: onTypingStop,
      presence_updated: onPresence,
      notification: onNotification,
      read_state_updated: onReadStateUpdated,
      voice_participants: onVoiceParticipants,
      voice_moved: onVoiceMoved,
      voice_speaking: onVoiceSpeaking,
      voice_error: onVoiceError,
      user_updated: onUserUpdated,
      channel_created: onChannelCreated,
      channel_updated: onChannelUpdated,
      channel_deleted: onChannelDeleted,
      thread_created: onChannelCreated,
      role_created: refreshServer,
      role_updated: refreshServer,
      role_deleted: refreshServer,
      roles_reordered: refreshServer,
      member_joined: onMemberJoined,
      member_removed: onMemberRemoved,
      member_updated: forActiveServer(refreshServer),
      server_updated: onServerUpdated,
      server_deleted: onServerDeleted,
      emoji_created: (e) => { onEmojiCreated(e); refreshExternalEmoji(); },
      emoji_deleted: (e) => { onEmojiDeleted(e); refreshExternalEmoji(); },
      sticker_created: onStickerCreated,
      sticker_deleted: onStickerDeleted,
      friend_request: onFriendRequest,
      friend_added: onFriendAdded,
      friend_removed: onFriendRemoved,
      dm_channel_created: onDmCreated,
      dm_channel_updated: onDmCreated,
      dm_channel_removed: onDmRemoved,
      user_settings_updated: ({ category, value }) => applyCategoryFromServer(category, value),
      action_error: onActionError,
      message_error: onActionError,
      identify_error: onIdentifyError
    };
    for (const [event, fn] of Object.entries(handlers)) socket.on(event, fn);
    return () => { for (const [event, fn] of Object.entries(handlers)) socket.off(event, fn); };
  }, [markChannelRead, pushToast, loadServer, loadPins, handleSignOut]);

  // Escape is not user-configurable — it always dismisses whatever is open.
  useEffect(() => {
    const onKeyDown = (e) => {
      const inField = ['INPUT', 'TEXTAREA'].includes(e.target.tagName) || e.target.isContentEditable;
      if (e.key === 'Escape' && !inField && !e.shiftKey) {
        setSearchResults(null);
        setSelectedProfileUser(null);
        setShowInbox(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  /** Walk the channel list, the way Alt+↑/↓ does in Discord. */
  const stepChannel = useCallback((direction) => {
    const list = activeServerId === 'home'
      ? dmChannels
      : channels.filter((c) => c.type !== 'thread' && c.type !== 'voice' && c.type !== 'category');
    if (list.length === 0) return;
    const index = list.findIndex((c) => c.id === activeChannelId);
    const next = list[(index + direction + list.length) % list.length];
    if (next) setActiveChannelId(next.id);
  }, [activeServerId, dmChannels, channels, activeChannelId]);

  const markEverythingRead = useCallback(() => {
    for (const channelId of Object.keys(readStates)) {
      const state = readStates[channelId];
      if (state?.unread || state?.mention_count) {
        markChannelRead(channelId, state.last_message_id ?? state.last_read_message_id);
      }
    }
    pushToast(t('switcher.markedAllRead'), { type: 'success', ttl: 3000 });
  }, [readStates, markChannelRead, pushToast]);

  // Everything else comes from the user's own keybinds.
  useKeybinds({
    quickSwitcher: () => setShowQuickSwitcher((v) => !v),
    markServerRead: markEverythingRead,
    navigateChannelUp: () => stepChannel(-1),
    navigateChannelDown: () => stepChannel(1),
    toggleMute: () => handleToggleMute(),
    toggleDeafen: () => handleToggleDeafen(),
    disconnectVoice: () => { if (currentVoiceChannel) handleLeaveVoice(); },
    toggleStreamerMode: () => {
      const next = !prefs.streamerMode.enabled;
      updatePreferences('streamerMode', { enabled: next });
      pushToast(next ? t('streamer.turnedOn') : t('streamer.turnedOff'), { type: 'info', ttl: 2500 });
    }
  });

  // Mark the open channel read when the tab regains focus.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      const id = activeChannelIdRef.current;
      const state = readStates[id];
      if (id && (state?.unread || state?.mention_count)) {
        markChannelRead(id, state.last_message_id ?? messages[messages.length - 1]?.id);
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [readStates, markChannelRead, messages]);

  // Typing entries expire client-side too, in case a stop event is missed.
  useEffect(() => {
    const timer = setInterval(() => {
      setTypingByChannel((prev) => {
        const now = Date.now();
        let changed = false;
        const next = {};
        for (const [channelId, users] of Object.entries(prev)) {
          const kept = Object.fromEntries(Object.entries(users).filter(([, v]) => now - v.at < 9000));
          if (Object.keys(kept).length !== Object.keys(users).length) changed = true;
          next[channelId] = kept;
        }
        return changed ? next : prev;
      });
    }, 3000);
    return () => clearInterval(timer);
  }, []);

  // Unread total in the tab title, like the desktop badge.
  useEffect(() => {
    const mentions = Object.values(readStates).reduce((n, s) => n + (s?.mention_count ?? 0), 0);
    applyUnreadBadge(mentions);
  }, [readStates, prefs.notifications.unreadBadge]);

  // --- message actions -------------------------------------------------------

  /**
   * Create a poll. It is posted as a message, so the gateway's `new_message`
   * puts it in the list — no optimistic placeholder here, because a poll has
   * server-assigned answer ids that a guess could not produce.
   */
  const handleCreatePoll = async (poll) => {
    if (!activeChannelId) return;
    await post('/api/messages', { channel_id: activeChannelId, poll });
  };

  /**
   * Send a voice note.
   *
   * Two steps, deliberately not optimistic: the recording has to reach storage
   * before the message can reference it, and a placeholder that pointed at a
   * blob URL would break the moment the page reloaded.
   */
  const handleSendVoiceNote = async ({ blob, waveform, durationSecs, mimeType }, reply_to_id) => {
    if (!activeChannelId) return;
    const extension = mimeType?.includes('mp4') ? 'm4a' : mimeType?.includes('ogg') ? 'ogg' : 'webm';
    const file = new File([blob], `voice-note.${extension}`, { type: blob.type || mimeType });

    const uploaded = await upload('/api/upload/attachments', 'files', file);
    const descriptor = uploaded?.attachments?.[0];
    if (!descriptor) throw new Error(t('voiceNote.uploadFailed'));

    await post('/api/messages', {
      channel_id: activeChannelId,
      reply_to_id: reply_to_id ?? null,
      // The waveform rides with the descriptor; the server clamps it and takes
      // duration from its own probe rather than trusting ours.
      attachments: [{ ...descriptor, waveform, duration_secs: durationSecs }]
    });
  };

  /**
   * Route a slash command that does something rather than sending text.
   *
   * Each of these already has a working path in the app — the command is a
   * shortcut to it, not a second implementation, so there is nothing new to
   * authorise and no behaviour that can drift from the button that does the
   * same thing.
   */
  const handleSlashAction = async (action, value) => {
    try {
      if (action === 'poll') {
        // Handled inside ChatArea, which owns the composer modal.
        return;
      }
      if (action === 'search') { handleSearch(value); return; }
      if (action === 'thread') {
        if (!activeChannelId) return;
        const thread = await post(`/api/channels/${activeChannelId}/threads`, { name: value });
        if (thread?.id) setActiveChannelId(thread.id);
        return;
      }
      if (action === 'nick') {
        if (!activeServerId || !currentUser) {
          pushToast(t('slash.nickNeedsServer'), { type: 'error' });
          return;
        }
        await patch(`/api/servers/${activeServerId}/members/${currentUser.id}`,
          { nickname: value || null });
        loadServer(activeServerId, { keepChannel: true });
        pushToast(value ? t('slash.nickSet', { name: value }) : t('slash.nickCleared'),
          { type: 'success', ttl: 2500 });
      }
    } catch (err) {
      pushToast(err.message, { type: 'error' });
    }
  };

  const handleSendMessage = (content, attachments, reply_to_id, extra = {}) => {
    if (!activeChannelId || !currentUser) return;
    const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const sticker = extra.sticker ?? null;

    setMessages((prev) => [...prev, {
      id: `pending-${nonce}`,
      nonce,
      pending: true,
      channel_id: activeChannelId,
      user_id: currentUser.id,
      content,
      type: reply_to_id ? 'reply' : 'default',
      attachments: attachments ?? [],
      sticker,
      reactions: {},
      reaction_details: [],
      reply_to_id: reply_to_id ?? null,
      username: currentUser.username,
      display_name: currentUser.display_name,
      avatar_url: currentUser.avatar_url,
      created_at: new Date().toISOString()
    }]);

    socket.emit('send_message', {
      channel_id: activeChannelId, content, attachments, reply_to_id, nonce, sticker_id: sticker?.id ?? null
    }, (ack) => {
      if (ack && !ack.ok) {
        setMessages((prev) => prev.map((m) =>
          m.nonce === nonce ? { ...m, pending: false, failed: true, error: ack.error } : m
        ));
      }
    });
  };

  const handleRetryMessage = (msg) => {
    setMessages((prev) => prev.filter((m) => m.id !== msg.id));
    handleSendMessage(msg.content, msg.attachments, msg.reply_to_id, { sticker: msg.sticker });
  };

  const handleDeleteMessage = (messageId) => {
    socket.emit('delete_message', { messageId }, (ack) => {
      if (ack && !ack.ok) pushToast(ack.error, { type: 'error' });
    });
  };

  const handleEditMessage = (messageId, content) => {
    socket.emit('edit_message', { messageId, content }, (ack) => {
      if (ack && !ack.ok) pushToast(ack.error, { type: 'error' });
    });
  };

  const handleJumpToMessage = async (message) => {
    if (message.channel_id !== activeChannelId) {
      setPendingJumpMessageId(message.id);
      const target = allChannels.find((c) => c.id === message.channel_id);
      if (target && !target.server_id && activeServerId !== 'home') setActiveServerId('home');
      if (target?.server_id && target.server_id !== activeServerId) setActiveServerId(target.server_id);
      setActiveChannelId(message.channel_id);
      setSearchResults(null);
      return;
    }
    try {
      const page = await get(`/api/messages/${message.channel_id}?around=${message.id}&limit=${PAGE_SIZE}`);
      if (Array.isArray(page)) {
        setMessages(page);
        setHasMoreHistory(true);
      }
      setSearchResults(null);
      setTimeout(() => flashMessage(message.id), 120);
    } catch (err) {
      pushToast(t('search.jumpFailed', { error: err.message }), { type: 'error' });
    }
  };

  const handleCreateThread = (message) => {
    setInputModal({
      title: t('chat.createThread'),
      label: t('chat.threadName'),
      initialValue: (message.content ?? '').slice(0, 60) || t('chat.newThread'),
      maxLength: 100,
      submitLabel: t('common.create'),
      onSubmit: async (name) => {
        const thread = await post(`/api/channels/${message.channel_id}/threads`, { messageId: message.id, name });
        setChannels((prev) => (prev.some((c) => c.id === thread.id) ? prev : [...prev, { ...thread, category: null }]));
        setActiveChannelId(thread.id);
        pushToast(t('chat.threadCreated', { name: thread.name }), { type: 'success', ttl: 3000 });
      }
    });
  };

  const handleTogglePin = async (message, pinned) => {
    try {
      const updated = await put(`/api/messages/${message.id}/pin`, { channelId: message.channel_id, pinned });
      setMessages((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
      loadPins(message.channel_id);
    } catch (err) {
      pushToast(t('files.pinFailed', { error: err.message }), { type: 'error' });
    }
  };

  const handleToggleReaction = (messageId, emoji) => {
    if (!activeChannelId || !currentUser) return;
    socket.emit('toggle_reaction', { messageId, channelId: activeChannelId, emoji });
  };

  const handleMarkUnread = (message) => {
    // Everything from this message on becomes unread: move the marker to the one before it.
    const idx = messages.findIndex((m) => m.id === message.id);
    const previous = idx > 0 ? messages[idx - 1].id : null;
    post(`/api/read-states/${message.channel_id}/unread`, { beforeMessageId: previous }).catch(toastError);
    setReadStates((prev) => ({
      ...prev,
      [message.channel_id]: { ...prev[message.channel_id], channel_id: message.channel_id, unread: 1, last_read_message_id: previous, last_message_id: messages[messages.length - 1]?.id }
    }));
    setChannelReadMarker(previous);
  };

  const handleReportMessage = (message) => {
    setConfirm({
      title: t('chat.reportMessage'),
      body: t('chat.reportBody'),
      confirmLabel: t('chat.report'),
      withReason: true,
      reasonLabel: t('chat.reportReason'),
      onConfirm: async (reason) => {
        await post('/api/reports', {
          target_type: 'message', target_id: message.id, reason: 'other', details: reason
        });
        pushToast(t('chat.reported'), { type: 'success', ttl: 3000 });
      }
    });
  };

  const handleSearch = async (query, filters = {}) => {
    if (!query?.trim() && !filters.authorId && !filters.hasAttachment) { setSearchResults(null); return; }
    setSearchQuery(query);
    try {
      const params = new URLSearchParams({ q: query, limit: '50' });
      if (activeServerId !== 'home') params.set('serverId', activeServerId);
      else if (activeChannelId) params.set('channelId', activeChannelId);
      if (filters.channelId) params.set('channelId', filters.channelId);
      if (filters.authorId) params.set('authorId', filters.authorId);
      if (filters.hasAttachment) params.set('hasAttachment', 'true');
      const rows = await get(`/api/search/messages?${params}`);
      setSearchResults(Array.isArray(rows) ? rows : []);
    } catch (err) {
      pushToast(err.message, { type: 'error' });
      setSearchResults([]);
    }
  };

  // --- direct messages -------------------------------------------------------

  const openDmWith = async (recipientId) => {
    const channel = await post('/api/dms', { recipientId });
    setDmChannels((prev) => (prev.some((d) => d.id === channel.id) ? prev : [channel, ...prev]));
    setActiveServerId('home');
    setActiveChannelId(channel.id);
    return channel;
  };
  const handleStartDm = (recipientId) => openDmWith(recipientId).catch((err) => pushToast(t('dm.openFailed', { error: err.message }), { type: 'error' }));

  const handleCreateGroupDm = async (recipientIds, name) => {
    const channel = await post('/api/dms', { recipientIds, name: name || null });
    setDmChannels((prev) => (prev.some((d) => d.id === channel.id) ? prev : [channel, ...prev]));
    setActiveServerId('home');
    setActiveChannelId(channel.id);
  };

  const handleCloseDm = async (channelId) => {
    setDmChannels((prev) => prev.filter((d) => d.id !== channelId));
    if (activeChannelId === channelId) setActiveChannelId(null);
    try { await del(`/api/dms/${channelId}`); } catch (err) { toastError(err); }
  };

  const handleAddFriend = async (username, note = null) => {
    try {
      const data = await post('/api/friends/requests', { username, note });
      setFriends((prev) => [...prev.filter((f) => f.id !== data.id), data]);
      return { ok: true, message: data.friend_status === 'accepted' ? t('dm.nowFriends', { username }) : t('dm.requestSent', { username }) };
    } catch (err) {
      return { ok: false, message: err.message ?? t('dm.requestFailed') };
    }
  };
  const handleSendFriendRequestTo = async (user) => {
    const result = await handleAddFriend(user.username);
    pushToast(result.message, { type: result.ok ? 'success' : 'error', ttl: 3000 });
  };

  const handleAcceptFriend = async (friend) => {
    try {
      const data = friend.request_id
        ? await post(`/api/friends/requests/${friend.request_id}/accept`)
        : await post('/api/friends/requests', { targetId: friend.id });
      setFriends((prev) => prev.map((f) => (f.id === friend.id ? { ...f, ...data, friend_status: 'accepted' } : f)));
    } catch (err) { toastError(err); }
  };

  const handleRemoveFriend = async (friend) => {
    try {
      await del(`/api/friends/${friend.id}`);
      setFriends((prev) => prev.filter((f) => f.id !== friend.id));
    } catch (err) { toastError(err); }
  };

  const handleBlockUser = (user) => {
    setConfirm({
      title: t('dm.blockTitle', { name: user.display_name || user.username }),
      body: t('dm.blockBody'),
      confirmLabel: t('dm.block'),
      onConfirm: async () => {
        const result = await post('/api/blocks', { targetId: user.id });
        setBlocked((prev) => [...prev.filter((b) => b.id !== user.id), result.user ?? { id: user.id, username: user.username, display_name: user.display_name, avatar_url: user.avatar_url }]);
        setFriends((prev) => prev.filter((f) => f.id !== user.id));
        setSelectedProfileUser(null);
      }
    });
  };
  const handleUnblockUser = async (user) => {
    try {
      await del(`/api/blocks/${user.id}`);
      setBlocked((prev) => prev.filter((b) => b.id !== user.id));
    } catch (err) { toastError(err); }
  };

  // --- voice -------------------------------------------------------------------

  // Streamer Mode › turn on automatically when a screen share begins.
  useEffect(() => {
    if (!prefs.streamerMode.autoEnable) return;
    const sharing = activeVoiceParticipants.some(
      (p) => p.userId === currentUserId && p.self_stream
    );
    if (sharing && !prefs.streamerMode.enabled) {
      updatePreferences('streamerMode', { enabled: true });
    }
  }, [activeVoiceParticipants, currentUserId, prefs.streamerMode.autoEnable, prefs.streamerMode.enabled]);

  const handleJoinVoice = (voiceChan) => {
    setCurrentVoiceChannel(voiceChan);
    socket.emit('join_voice', { channelId: voiceChan.id }, (ack) => {
      if (ack && !ack.ok) { setCurrentVoiceChannel(null); pushToast(ack.error, { type: 'error' }); }
    });
  };
  const handleLeaveVoice = () => {
    if (!currentVoiceChannel) return;
    socket.emit('leave_voice', { channelId: currentVoiceChannel.id });
    setCurrentVoiceChannel(null);
    setActiveVoiceParticipants([]);
    if (activeChannel?.type === 'voice' || activeChannel?.type === 'stage') {
      const firstText = channels.find((c) => c.type === 'text' || c.type === 'announcement');
      setActiveChannelId(firstText?.id ?? null);
    }
  };
  const handleVideoStateChange = useCallback(({ isVideo, isStreaming }) => {
    if (!currentVoiceChannel) return;
    socket.emit('voice_state_change', { channelId: currentVoiceChannel.id, isVideo, isStreaming });
  }, [currentVoiceChannel]);

  const handleSpeakingChange = useCallback((isSpeaking) => {
    if (!currentVoiceChannel) return;
    socket.emit('voice_state_change', { channelId: currentVoiceChannel.id, isSpeaking });
  }, [currentVoiceChannel]);
  const handleToggleMute = () => {
    const newMute = !isMuted;
    setIsMuted(newMute);
    if (newMute === false && isDeafened) setIsDeafened(false);
    if (currentVoiceChannel) {
      socket.emit('voice_state_change', { channelId: currentVoiceChannel.id, isMuted: newMute, isDeafened: newMute ? isDeafened : false });
    }
  };
  const handleToggleDeafen = () => {
    const newDeafen = !isDeafened;
    setIsDeafened(newDeafen);
    // Discord: deafening also mutes; undeafening restores the previous mute.
    if (newDeafen) setIsMuted(true);
    if (currentVoiceChannel) {
      socket.emit('voice_state_change', { channelId: currentVoiceChannel.id, isDeafened: newDeafen, isMuted: newDeafen ? true : isMuted });
    }
  };

  // --- guild actions -------------------------------------------------------------

  const handleCreateServer = async (name, icon_url) => {
    try {
      const newServer = await post('/api/servers', { name, icon_url });
      setServers((prev) => [...prev, newServer]);
      setActiveServerId(newServer.id);
    } catch (err) { toastError(err); }
  };

  const handleCreateChannel = async ({ name, type, isPrivate, category }) => {
    if (!activeServerId || activeServerId === 'home') return;
    try {
      const newChannel = await post('/api/channels', {
        server_id: activeServerId, name, type,
        category: category ?? (type === 'voice' ? 'VOICE CHANNELS' : 'TEXT CHANNELS')
      });
      if (isPrivate) {
        // Private channel = deny VIEW_CHANNEL to @everyone, allow it back to the
        // creator. Overwrites are bitfield strings, not permission names.
        const viewChannel = maskOf('VIEW_CHANNEL');
        await put(`/api/channels/${newChannel.id}/permissions/role/${activeServerId}`, { allow: '0', deny: viewChannel });
        await put(`/api/channels/${newChannel.id}/permissions/member/${currentUserId}`, { allow: viewChannel, deny: '0' });
        newChannel.is_private = true;
      }
      setChannels((prev) => (prev.some((c) => c.id === newChannel.id) ? prev : [...prev, newChannel]));
      if (newChannel.type !== 'voice') setActiveChannelId(newChannel.id);
    } catch (err) { toastError(err); }
  };

  const handleCreateInvite = async () => {
    try {
      const invite = await post(`/api/servers/${activeServerId}/invites`, { channelId: activeChannelId, maxAge: 86400 });
      const link = `${window.location.origin}/invite/${invite.code}`;
      await navigator.clipboard?.writeText(link).catch(() => {});
      // Streamer Mode hides the code itself — it is still on the clipboard.
      const hide = prefs.streamerMode.enabled && prefs.streamerMode.hideInviteLinks;
      pushToast(
        hide ? t('server.inviteCopiedHidden') : t('server.inviteCopied', { code: invite.code }),
        { type: 'success' }
      );
    } catch (err) {
      pushToast(t('server.inviteFailed', { error: err.message }), { type: 'error' });
    }
  };

  const handleLeaveServer = () => {
    const server = servers.find((s) => s.id === activeServerId);
    setConfirm({
      title: t('server.leaveTitle', { name: server?.name ?? '' }),
      body: t('server.leaveBody'),
      confirmLabel: t('server.leave'),
      onConfirm: async () => {
        await post(`/api/servers/${activeServerId}/leave`);
        setServers((prev) => prev.filter((s) => s.id !== activeServerId));
        setActiveServerId('home');
        pushToast(t('server.left'), { type: 'success', ttl: 3000 });
      }
    });
  };

  const handleDeleteServer = () => {
    const server = servers.find((s) => s.id === activeServerId);
    setConfirm({
      title: t('server.deleteTitle', { name: server?.name ?? '' }),
      body: t('server.deleteConfirm'),
      confirmLabel: t('server.delete'),
      onConfirm: async () => {
        await del(`/api/servers/${activeServerId}`);
        setServers((prev) => prev.filter((s) => s.id !== activeServerId));
        setActiveServerId('home');
        pushToast(t('server.deleted'), { type: 'success', ttl: 3000 });
      }
    });
  };

  const handleDeleteChannel = (channel) => {
    setConfirm({
      title: t('channel.deleteTitle', { name: channel.name }),
      body: t('channel.deleteBody'),
      confirmLabel: t('common.delete'),
      onConfirm: async () => {
        await del(`/api/channels/${channel.id}`);
        setChannels((prev) => prev.filter((c) => c.id !== channel.id && c.parent_id !== channel.id));
        if (activeChannelId === channel.id) setActiveChannelId(null);
      }
    });
  };

  const handleSaveChannel = async (channelId, patchBody) => {
    const updated = await patch(`/api/channels/${channelId}`, patchBody);
    setChannels((prev) => prev.map((c) => (c.id === channelId ? { ...c, ...updated } : c)));
    return updated;
  };

  const handleUpdateChannelSettings = async (channelId, patchBody) => {
    const merged = { ...channelSettings[channelId], ...patchBody };
    setChannelSettings((prev) => ({ ...prev, [channelId]: merged }));
    try {
      const saved = await put(`/api/settings/channels/${channelId}`, {
        muted: Boolean(merged.muted),
        mutedUntil: merged.muted_until ?? null,
        notificationLevel: merged.notification_level ?? 'inherit',
        collapsed: Boolean(merged.collapsed)
      });
      setChannelSettings((prev) => ({ ...prev, [channelId]: saved }));
    } catch (err) { toastError(err); }
  };
  const handleUpdateServerSettings = async (serverId, patchBody) => {
    const merged = { ...serverSettings[serverId], ...patchBody };
    setServerSettings((prev) => ({ ...prev, [serverId]: merged }));
    try {
      const saved = await put(`/api/settings/servers/${serverId}`, {
        muted: Boolean(merged.muted),
        notificationLevel: merged.notification_level ?? 'all_messages',
        position: merged.position ?? 0,
        hidden: Boolean(merged.hidden)
      });
      setServerSettings((prev) => ({ ...prev, [serverId]: saved }));
    } catch (err) { toastError(err); }
  };

  const handleMarkChannelRead = (channelId) => {
    const state = readStates[channelId];
    markChannelRead(channelId, state?.last_message_id ?? state?.last_read_message_id ?? null);
  };

  const handleSaveProfile = async (updatedData) => {
    if (!currentUser) return;
    const updated = await put(`/api/users/${currentUser.id}`, updatedData);
    setCurrentUser((prev) => ({ ...prev, ...updated }));
    return updated;
  };

  const handleSetStatus = (status, customStatus) => {
    socket.emit('update_presence', { status, customStatus });
    setCurrentUser((prev) => (prev ? { ...prev, status, ...(customStatus !== undefined ? { custom_status: customStatus } : {}) } : prev));
  };

  // --- member moderation ---------------------------------------------------------

  const can = useCallback((name) =>
    viewerPermissions.includes(name) || viewerPermissions.includes('ADMINISTRATOR')
    || servers.find((s) => s.id === activeServerId)?.owner_id === currentUserId,
  [viewerPermissions, servers, activeServerId, currentUserId]);

  const handleKick = (user) => setConfirm({
    title: t('members.kickTitle', { name: user.display_name || user.username }),
    body: t('members.kickBody'),
    confirmLabel: t('members.kick'),
    withReason: true,
    onConfirm: async (reason) => {
      await post(`/api/servers/${activeServerId}/kicks/${user.id}`, { reason });
      setMembers((prev) => prev.filter((m) => m.id !== user.id));
      pushToast(t('members.kicked', { name: user.display_name || user.username }), { type: 'success', ttl: 3000 });
    }
  });
  const handleBan = (user) => setConfirm({
    title: t('members.banTitle', { name: user.display_name || user.username }),
    body: t('members.banBody'),
    confirmLabel: t('members.ban'),
    withReason: true,
    onConfirm: async (reason) => {
      await post(`/api/servers/${activeServerId}/bans/${user.id}`, { reason, deleteMessageSeconds: 0 });
      setMembers((prev) => prev.filter((m) => m.id !== user.id));
      pushToast(t('members.banned', { name: user.display_name || user.username }), { type: 'success', ttl: 3000 });
    }
  });
  const handleTimeout = async (user, minutes) => {
    try {
      const until = new Date(Date.now() + minutes * 60_000).toISOString();
      await post(`/api/servers/${activeServerId}/timeouts/${user.id}`, { until });
      setMembers((prev) => prev.map((m) => (m.id === user.id ? { ...m, timeout_until: until } : m)));
      pushToast(t('members.timedOut', { name: user.display_name || user.username, minutes }), { type: 'success', ttl: 3000 });
    } catch (err) { toastError(err); }
  };
  const handleRemoveTimeout = async (user) => {
    try {
      await post(`/api/servers/${activeServerId}/timeouts/${user.id}`, { until: new Date(0).toISOString() });
      setMembers((prev) => prev.map((m) => (m.id === user.id ? { ...m, timeout_until: null } : m)));
    } catch (err) { toastError(err); }
  };
  const handleChangeNickname = (user) => setInputModal({
    title: t('members.changeNickname'),
    label: t('members.nickname'),
    initialValue: user.nickname ?? '',
    placeholder: user.username,
    maxLength: 32,
    allowEmpty: true,
    hint: t('members.nicknameHint'),
    onSubmit: async (nickname) => {
      await patch(`/api/servers/${activeServerId}/members/${user.id}`, { nickname: nickname || null });
      loadServer(activeServerId, { keepChannel: true });
    }
  });
  const handleToggleRole = async (user, role, assign) => {
    try {
      if (assign) await put(`/api/servers/${activeServerId}/members/${user.id}/roles/${role.id}`);
      else await del(`/api/servers/${activeServerId}/members/${user.id}/roles/${role.id}`);
      loadServer(activeServerId, { keepChannel: true });
    } catch (err) { toastError(err); }
  };

  // --- invites -------------------------------------------------------------------

  const handleInviteAccepted = (detail) => {
    setInviteCode(null);
    const server = detail?.server;
    if (server) {
      setServers((prev) => (prev.some((s) => s.id === server.id) ? prev : [...prev, server]));
      setActiveServerId(server.id);
    }
    window.history.replaceState(null, '', '/');
  };

  // --- derived -------------------------------------------------------------------

  const currentServer = servers.find((s) => s.id === activeServerId);
  const activeChannel = allChannels.find((c) => c.id === activeChannelId);
  const isVoiceChannel = activeChannel?.type === 'voice' || activeChannel?.type === 'stage';
  const isForumChannel = activeChannel?.type === 'forum';
  const isOwner = currentServer?.owner_id === currentUserId;

  const memberColors = useMemo(() => {
    const map = new Map();
    for (const m of members) map.set(m.id, m.role_color);
    return map;
  }, [members]);

  const decoratedMessages = useMemo(
    () => messages.map((m) => ({ ...m, role_color: m.role_color ?? memberColors.get(m.user_id) ?? null })),
    [messages, memberColors]
  );

  const typingUsers = useMemo(() => {
    const users = typingByChannel[activeChannelId] ?? {};
    return Object.entries(users)
      .filter(([userId]) => userId !== currentUserId)
      .map(([userId, v]) => ({ userId, displayName: v.displayName }));
  }, [typingByChannel, activeChannelId, currentUserId]);

  const blockedIds = useMemo(() => new Set(blocked.map((b) => b.id)), [blocked]);

  // Mention autocomplete in a DM draws on friends, the people in this
  // conversation and yourself — de-duplicated, since those sets overlap.
  const homeMembers = useMemo(() => {
    const byId = new Map();
    for (const person of [...friends, ...(activeChannel?.recipients ?? []), ...(currentUser ? [currentUser] : [])]) {
      if (person?.id) byId.set(person.id, person);
    }
    return [...byId.values()];
  }, [friends, activeChannel, currentUser]);

  const resolveUser = (userId) =>
    members.find((m) => m.id === userId)
    ?? friends.find((f) => f.id === userId)
    ?? dmChannels.flatMap((d) => d.recipients ?? []).find((u) => u.id === userId)
    ?? (currentUser?.id === userId ? currentUser : null);

  const openProfile = async (userId) => {
    const local = resolveUser(userId);
    if (local) setSelectedProfileUser(local);
    try {
      const full = await get(`/api/users/${userId}`);
      setSelectedProfileUser((prev) => (prev?.id === userId || !local ? { ...local, ...full } : prev));
    } catch { /* keep local */ }
  };

  const openMemberMenu = (user, x, y) => setMemberMenu({ user, x, y });

  const forumView = isForumChannel ? (
    <ForumView
      channel={activeChannel}
      currentUser={currentUser}
      viewerPermissions={viewerPermissions}
      isOwner={isOwner}
      socket={socket}
      onToast={pushToast}
      onOpenPost={(threadId) => setActiveChannelId(threadId)}
      onOpenNotificationSettings={(x, y) => activeChannel && setNotifPopover({ kind: 'channel', id: activeChannel.id, x, y })}
      channelSettings={channelSettings[activeChannelId]}
      onToggleMemberList={() => setShowMemberList(!showMemberList)}
      showMemberList={showMemberList}
    />
  ) : null;

  const chatArea = forumView ?? (
    <ChatArea
      channel={activeChannel}
      messages={decoratedMessages}
      pins={pins}
      onSendMessage={handleSendMessage}
      onCreatePoll={handleCreatePoll}
      onSendVoiceNote={handleSendVoiceNote}
      onSlashAction={handleSlashAction}
      onToast={pushToast}
      onRetryMessage={handleRetryMessage}
      onToggleReaction={handleToggleReaction}
      onDeleteMessage={handleDeleteMessage}
      onEditMessage={handleEditMessage}
      onToggleMemberList={() => setShowMemberList(!showMemberList)}
      showMemberList={showMemberList}
      currentUser={currentUser}
      viewerPermissions={viewerPermissions}
      isOwner={isOwner}
      onSelectUser={openProfile}
      onUserContextMenu={(userId, x, y) => { const u = resolveUser(userId); if (u) openMemberMenu(u, x, y); }}
      onTypingStart={() => socket.emit('typing_start', { channelId: activeChannelId, displayName: currentUser?.display_name })}
      onTypingStop={() => socket.emit('typing_stop', { channelId: activeChannelId })}
      typingUsers={typingUsers}
      lastReadMessageId={channelReadMarker}
      onLoadMore={handleLoadMore}
      hasMoreHistory={hasMoreHistory}
      isLoadingHistory={isLoadingHistory}
      onSearch={handleSearch}
      onTogglePin={handleTogglePin}
      members={activeServerId === 'home' ? homeMembers : members}
      channels={channels}
      customEmojis={serverEmojis}
      externalEmojiGroups={externalEmojiGroups}
      stickers={serverStickers}
      onSelectChannel={(id) => setActiveChannelId(id)}
      onCreateThread={activeChannel?.server_id && activeChannel.type !== 'thread' ? handleCreateThread : null}
      onForward={(msg) => setForwardMessage(msg)}
      onPublish={async (msg) => {
        try {
          const result = await post(`/api/messages/${msg.id}/crosspost`, {});
          pushToast(t('chat.publishedTo', { count: result.followers ?? 0 }), { type: 'success' });
        } catch (err) { toastError(err); }
      }}
      onFollowChannel={(channel) => setFollowSource(channel)}
      onMarkUnread={handleMarkUnread}
      onReport={handleReportMessage}
      onToast={pushToast}
      onOpenNotificationSettings={(x, y) => activeChannel && setNotifPopover({ kind: 'channel', id: activeChannel.id, x, y })}
      isUnknownSender={(userId) => !friends.some((f) => f.id === userId && f.friend_status === 'accepted')}
      channelSettings={channelSettings[activeChannelId]}
      blockedIds={blockedIds}
      onOpenInbox={(x, y) => setShowInbox({ x, y })}
      inboxCount={notifications.filter((n) => !n.read_at).length}
      onAddGroupRecipients={activeChannel?.type === 'dm' || activeChannel?.type === 'group_dm' ? () => setShowGroupDmModal({ channel: activeChannel }) : null}
      onArchiveThread={activeChannel?.type === 'thread' ? async (archived) => {
        try {
          const updated = await patch(`/api/threads/${activeChannel.id}`, { archived });
          setChannels((prev) => prev.map((c) => (c.id === updated.id ? { ...c, ...updated } : c)));
        } catch (err) { toastError(err); }
      } : null}
    />
  );

  if (authState === null) {
    return (
      <div className="fixed inset-0 bg-d-base flex items-center justify-center text-d-text3 text-sm">
        {t('auth.checkingSession')}
      </div>
    );
  }

  if (authState === false) {
    return <LoginScreen onAuthenticated={handleAuthenticated} devAccounts={devAccounts} inviteCode={inviteCode} />;
  }

  if (inviteCode) {
    return (
      <InviteJoinScreen
        code={inviteCode}
        onJoined={handleInviteAccepted}
        onCancel={() => { setInviteCode(null); window.history.replaceState(null, '', '/'); }}
      />
    );
  }

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-d-base text-d-text font-sans antialiased">
      <ServerRail
        servers={servers}
        serverSettings={serverSettings}
        readStates={readStates}
        channels={channels}
        activeServerId={activeServerId}
        onSelectServer={(id) => setActiveServerId(id)}
        onOpenCreateServerModal={() => setShowCreateServerModal(true)}
        onSelectHome={() => setActiveServerId('home')}
        onJoinWithInvite={() => setInputModal({
          title: t('server.joinTitle'),
          label: t('server.inviteLink'),
          placeholder: `${window.location.origin}/invite/abc123`,
          submitLabel: t('server.join'),
          hint: t('server.joinHint'),
          onSubmit: async (value) => {
            const code = value.trim().split('/').filter(Boolean).pop();
            if (!code) throw new Error(t('server.invalidInvite'));
            setInviteCode(code);
          }
        })}
        onServerContextMenu={(server, x, y) => setNotifPopover({ kind: 'server', id: server.id, x, y })}
        pendingFriendCount={friends.filter((f) => f.friend_status === 'pending' && f.direction === 'incoming').length}
      />

      {activeServerId === 'home' ? (
        <HomeDirectMessages
          friends={friends}
          dms={dmChannels}
          blocked={blocked}
          activeChannelId={activeChannelId}
          readStates={readStates}
          currentUser={currentUser}
          onSelectDm={(id) => setActiveChannelId(id)}
          onStartDm={handleStartDm}
          onCloseDm={handleCloseDm}
          onAddFriend={handleAddFriend}
          onAcceptFriend={handleAcceptFriend}
          onDeclineFriend={handleRemoveFriend}
          onRemoveFriend={handleRemoveFriend}
          onBlockUser={handleBlockUser}
          onUnblockUser={handleUnblockUser}
          onOpenProfile={openProfile}
          onUserContextMenu={(user, x, y) => openMemberMenu(user, x, y)}
          onCreateGroupDm={() => setShowGroupDmModal(true)}
          onOpenUserSettingsModal={() => setShowUserSettingsModal(true)}
          onSetStatus={handleSetStatus}
          isMuted={isMuted}
          onToggleMute={handleToggleMute}
          isDeafened={isDeafened}
          onToggleDeafen={handleToggleDeafen}
          currentVoiceChannel={currentVoiceChannel}
          onLeaveVoice={handleLeaveVoice}
        >
          <>
            {chatArea}
            {searchResults !== null && (
              <SearchResultsPanel
                query={searchQuery}
                results={searchResults}
                channels={allChannels}
                onJumpToMessage={handleJumpToMessage}
                onClose={() => setSearchResults(null)}
              />
            )}
          </>
        </HomeDirectMessages>
      ) : (
        <div className="flex-1 flex overflow-hidden min-w-0">
          <ChannelSidebar
            currentServer={currentServer}
            channels={channels}
            activeChannelId={activeChannelId}
            onSelectChannel={(id) => setActiveChannelId(id)}
            onOpenCreateChannelModal={(type) => {
              setCreateChannelDefaultType(type);
              setShowCreateChannelModal(true);
            }}
            readStates={readStates}
            channelSettings={channelSettings}
            serverSettings={serverSettings[activeServerId]}
            viewerPermissions={viewerPermissions}
            isOwner={isOwner}
            onOpenServerSettings={(tab) => setServerSettingsTab(typeof tab === 'string' ? tab : 'overview')}
            onOpenEvents={() => setShowEvents(true)}
            onCreateInvite={handleCreateInvite}
            onLeaveServer={handleLeaveServer}
            onDeleteServer={handleDeleteServer}
            onOpenServerNotifications={(x, y) => setNotifPopover({ kind: 'server', id: activeServerId, x, y })}
            onOpenChannelNotifications={(channel, x, y) => setNotifPopover({ kind: 'channel', id: channel.id, x, y })}
            onEditChannel={(channel) => setChannelSettingsFor(channel)}
            onDeleteChannel={handleDeleteChannel}
            onMarkChannelRead={handleMarkChannelRead}
            onMuteChannel={(channel, muted, until) => handleUpdateChannelSettings(channel.id, { muted, muted_until: until ?? null })}
            onToast={pushToast}
            currentUser={currentUser}
            onOpenUserSettingsModal={() => setShowUserSettingsModal(true)}
            onSetStatus={handleSetStatus}
            currentVoiceChannel={currentVoiceChannel}
            activeVoiceParticipants={activeVoiceParticipants}
            onLeaveVoice={handleLeaveVoice}
            isMuted={isMuted}
            onToggleMute={handleToggleMute}
            isDeafened={isDeafened}
            onToggleDeafen={handleToggleDeafen}
            onCreateInviteFor={async (channel) => {
              try {
                const invite = await post(`/api/servers/${activeServerId}/invites`, { channelId: channel.id, maxAge: 86400 });
                await navigator.clipboard?.writeText(`${window.location.origin}/invite/${invite.code}`).catch(() => {});
                pushToast(t('server.inviteCopied', { code: invite.code }), { type: 'success' });
              } catch (err) { toastError(err); }
            }}
          />

          {isVoiceChannel ? (
            <VoiceRoom
              channel={activeChannel}
              participants={activeVoiceParticipants}
              currentUser={currentUser}
              viewerPermissions={viewerPermissions}
              isOwner={isOwner}
              onToast={pushToast}
              isMuted={isMuted}
              onToggleMute={handleToggleMute}
              isDeafened={isDeafened}
              onToggleDeafen={handleToggleDeafen}
              onLeaveVoice={handleLeaveVoice}
              onSpeakingChange={handleSpeakingChange}
              onOpenVoiceSettings={() => setShowUserSettingsModal('voice')}
              onVideoStateChange={handleVideoStateChange}
              socket={socket}
            />
          ) : (
            chatArea
          )}

          {searchResults !== null && (
            <SearchResultsPanel
              query={searchQuery}
              results={searchResults}
              channels={allChannels}
              onJumpToMessage={handleJumpToMessage}
              onClose={() => setSearchResults(null)}
            />
          )}

          {!isVoiceChannel && searchResults === null && showMemberList && (
            <MemberList
              members={members}
              onSelectMember={openProfile}
              onMemberContextMenu={(member, x, y) => openMemberMenu(member, x, y)}
            />
          )}
        </div>
      )}

      {showCreateServerModal && (
        <CreateServerModal
          initialTemplateCode={showCreateServerModal?.templateCode ?? null}
          onClose={() => setShowCreateServerModal(false)}
          onCreateServer={handleCreateServer}
          onCreateFromTemplate={async (code, name, icon_url) => {
            try {
              const detail = await post(`/api/templates/${encodeURIComponent(code)}/servers`, { name, icon_url: icon_url || null });
              setServers((prev) => [...prev, detail.server]);
              setShowCreateServerModal(false);
              setActiveServerId(detail.server.id);
              pushToast(t('server.createdFromTemplate', { name: detail.server.name }), { type: 'success' });
            } catch (err) { toastError(err); }
          }}
          onJoinWithInvite={(code) => { setShowCreateServerModal(false); setInviteCode(code); }}
        />
      )}

      {showCreateChannelModal && (
        <CreateChannelModal
          defaultType={createChannelDefaultType}
          categories={[...new Set(channels.filter((c) => c.category).map((c) => c.category))]}
          onClose={() => setShowCreateChannelModal(false)}
          onCreateChannel={handleCreateChannel}
        />
      )}

      {showEvents && activeServerId && (
        <EventsPanel
          server={servers.find((s) => s.id === activeServerId)}
          channels={channels}
          canManage={can('MANAGE_GUILD')}
          socket={socket}
          onClose={() => setShowEvents(false)}
          onJoinVoice={(channelId) => {
            const voiceChannel = channels.find((c) => c.id === channelId);
            setShowEvents(false);
            if (voiceChannel) handleJoinVoice(voiceChannel);
          }}
          onToast={pushToast}
        />
      )}

      {showUserSettingsModal && (
        <UserSettingsModal
          currentUser={currentUser}
          initialTab={typeof showUserSettingsModal === 'string' ? showUserSettingsModal : 'profile'}
          onClose={() => setShowUserSettingsModal(false)}
          onSaveProfile={handleSaveProfile}
          onSetStatus={handleSetStatus}
          onSignOut={handleSignOut}
          onToast={pushToast}
        />
      )}

      {showQuickSwitcher && (
        <QuickSwitcher
          channels={channels}
          dms={dmChannels}
          servers={servers}
          onClose={() => setShowQuickSwitcher(false)}
          onPick={(entry) => {
            setShowQuickSwitcher(false);
            if (entry.kind === 'server') { setActiveServerId(entry.id); return; }
            if (entry.kind === 'dm') { setActiveServerId('home'); }
            setActiveChannelId(entry.id);
          }}
        />
      )}

      {onboardingFor && currentServer && onboardingFor === currentServer.id && (
        <OnboardingModal
          server={currentServer}
          onToast={pushToast}
          onSelectChannel={(id) => setActiveChannelId(id)}
          onClose={() => {
            try { localStorage.setItem(`onboarding-seen:${onboardingFor}:${currentUserId}`, '1'); } catch { /* ignore */ }
            setOnboardingFor(null);
          }}
          onComplete={(result) => {
            if (Array.isArray(result?.channels)) setChannels((prev) => [...result.channels, ...prev.filter((c) => c.type === 'thread')]);
            if (Array.isArray(result?.members)) setMembers(result.members);
            if (Array.isArray(result?.roles)) setRoles(result.roles);
            loadServer(onboardingFor, { keepChannel: true });
            const first = result?.picked_channel_ids?.[0];
            if (first) setActiveChannelId(first);
            pushToast(t('onboarding.done'), { type: 'success', ttl: 3000 });
          }}
        />
      )}

      {serverSettingsTab && currentServer && (
        <ServerSettingsModal
          server={currentServer}
          currentUserId={currentUserId}
          channels={channels}
          initialTab={serverSettingsTab}
          viewerPermissions={viewerPermissions}
          onClose={() => setServerSettingsTab(null)}
          onServerUpdated={(updated) => {
            setServers((prev) => prev.map((s) => (s.id === updated.id ? { ...s, ...updated } : s)));
          }}
          onServerDeleted={() => {
            setServerSettingsTab(null);
            setServers((prev) => prev.filter((s) => s.id !== activeServerId));
            setActiveServerId('home');
          }}
          onRefreshServer={() => loadServer(activeServerId, { keepChannel: true })}
          onToast={pushToast}
        />
      )}

      {channelSettingsFor && (
        <ChannelSettingsModal
          channel={channels.find((c) => c.id === channelSettingsFor.id) ?? channelSettingsFor}
          canManage={can('MANAGE_CHANNELS')}
          onSave={(patchBody) => handleSaveChannel(channelSettingsFor.id, patchBody)}
          onDelete={() => { setChannelSettingsFor(null); handleDeleteChannel(channelSettingsFor); }}
          onClose={() => setChannelSettingsFor(null)}
          onToast={pushToast}
        />
      )}

      {notifPopover && (
        <NotificationSettingsPopover
          kind={notifPopover.kind}
          x={notifPopover.x}
          y={notifPopover.y}
          target={notifPopover.kind === 'channel' ? allChannels.find((c) => c.id === notifPopover.id) : servers.find((s) => s.id === notifPopover.id)}
          settings={notifPopover.kind === 'channel' ? channelSettings[notifPopover.id] : serverSettings[notifPopover.id]}
          onChange={(patchBody) => (notifPopover.kind === 'channel'
            ? handleUpdateChannelSettings(notifPopover.id, patchBody)
            : handleUpdateServerSettings(notifPopover.id, patchBody))}
          onMarkRead={() => {
            if (notifPopover.kind === 'channel') handleMarkChannelRead(notifPopover.id);
            else for (const c of channels) if (readStates[c.id]?.unread || readStates[c.id]?.mention_count) handleMarkChannelRead(c.id);
          }}
          onClose={() => setNotifPopover(null)}
        />
      )}

      {memberMenu && (
        <MemberContextMenu
          user={memberMenu.user}
          x={memberMenu.x}
          y={memberMenu.y}
          currentUser={currentUser}
          isGuild={activeServerId !== 'home'}
          server={currentServer}
          roles={roles}
          members={members}
          friends={friends}
          blocked={blocked}
          can={can}
          onClose={() => setMemberMenu(null)}
          onProfile={(u) => openProfile(u.id)}
          onMessage={(u) => handleStartDm(u.id)}
          onAddFriend={handleSendFriendRequestTo}
          onRemoveFriend={handleRemoveFriend}
          onBlock={handleBlockUser}
          onUnblock={handleUnblockUser}
          onChangeNickname={handleChangeNickname}
          onToggleRole={handleToggleRole}
          onTimeout={handleTimeout}
          onRemoveTimeout={handleRemoveTimeout}
          onKick={handleKick}
          onBan={handleBan}
          onToast={pushToast}
        />
      )}

      {followSource && (
        <FollowChannelModal
          source={followSource}
          servers={servers.filter((sv) => sv.id !== 'home')}
          onClose={() => setFollowSource(null)}
          onToast={pushToast}
        />
      )}

      {forwardMessage && (
        <ForwardMessageModal
          message={forwardMessage}
          channels={channels.filter((c) => ['text', 'announcement', 'thread'].includes(c.type))}
          dms={dmChannels}
          servers={servers}
          onClose={() => setForwardMessage(null)}
          onForward={async (targetChannelId) => {
            const body = forwardMessage.content ?? '';
            await post('/api/messages', {
              channel_id: targetChannelId,
              content: body,
              attachments: forwardMessage.attachments ?? [],
              sticker_id: forwardMessage.sticker?.id ?? null
            });
            pushToast(t('chat.forwarded'), { type: 'success', ttl: 3000 });
          }}
        />
      )}

      {showGroupDmModal && (
        <CreateGroupDmModal
          friends={friends.filter((f) => f.friend_status === 'accepted')}
          existing={showGroupDmModal?.channel ?? null}
          onClose={() => setShowGroupDmModal(false)}
          onCreate={async (recipientIds, name) => {
            if (showGroupDmModal?.channel) {
              const updated = await put(`/api/dms/${showGroupDmModal.channel.id}/recipients`, { recipientIds });
              setDmChannels((prev) => (prev.some((d) => d.id === updated.id) ? prev.map((d) => (d.id === updated.id ? updated : d)) : [updated, ...prev]));
              setActiveChannelId(updated.id);
            } else {
              await handleCreateGroupDm(recipientIds, name);
            }
          }}
        />
      )}

      {showInbox && (
        <NotificationsInbox
          x={showInbox.x}
          y={showInbox.y}
          notifications={notifications}
          channels={allChannels}
          onJump={(n) => {
            setShowInbox(false);
            const messageId = n.message_id ?? n.message?.id;
            if (messageId && n.channel_id) handleJumpToMessage({ id: messageId, channel_id: n.channel_id });
          }}
          onMarkAllRead={async () => {
            const now = new Date().toISOString();
            setNotifications((prev) => prev.map((n) => ({ ...n, read_at: n.read_at ?? now })));
            try { await post('/api/notifications/read'); } catch (err) { toastError(err); }
          }}
          onClose={() => setShowInbox(false)}
        />
      )}

      {confirm && <ConfirmModal {...confirm} onClose={() => setConfirm(null)} />}
      {inputModal && <InputModal {...inputModal} onClose={() => setInputModal(null)} />}

      <ToastStack toasts={toasts} onDismiss={dismissToast} />

      {selectedProfileUser && (
        <UserProfileModal
          user={selectedProfileUser}
          currentUser={currentUser}
          member={members.find((m) => m.id === selectedProfileUser.id)}
          roles={roles}
          friend={friends.find((f) => f.id === selectedProfileUser.id)}
          isBlocked={blockedIds.has(selectedProfileUser.id)}
          onClose={() => setSelectedProfileUser(null)}
          onSendDM={(u) => { setSelectedProfileUser(null); handleStartDm(u.id); }}
          onAddFriend={handleSendFriendRequestTo}
          onAcceptFriend={handleAcceptFriend}
          onRemoveFriend={handleRemoveFriend}
          onBlock={handleBlockUser}
          onUnblock={handleUnblockUser}
          onEditProfile={() => { setSelectedProfileUser(null); setShowUserSettingsModal(true); }}
        />
      )}
    </div>
  );
}
