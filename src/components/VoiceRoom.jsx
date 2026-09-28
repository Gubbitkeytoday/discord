import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Mic, MicOff, Headphones, HeadphoneOff, Monitor, MonitorOff, PhoneOff, Video,
  VideoOff, Volume2, Volume1, VolumeX, Radio, AlertTriangle, X, Settings,
  Maximize2, Minimize2, Grid2X2, User, Music, Hand, ArrowUpFromLine, ArrowDownToLine,
  SignalHigh, SignalMedium, SignalLow, SignalZero, Lock, PictureInPicture2, RefreshCw,
  UserX, ArrowRightLeft, AudioLines, Shield, MoreHorizontal, Tags, WifiOff
} from 'lucide-react';
import { playSoundboardClip } from '../utils/soundEffects';
import SoundboardPanel from './SoundboardPanel';
import { useVoiceMedia, useStreamVideo } from '../hooks/useVoiceMedia';
import { useVoiceBackend } from '../voice/useVoiceBackend';
import { isPipSupported, openPipWindow } from '../voice/pip';
import { announce } from '../voice/announce';
import { playCallSound } from '../voice/sounds';
import { get, post, del, patch } from '../api';
import { useVoiceSettings } from '../hooks/useVoiceSettings';
import { useUserSettings } from '../hooks/useUserSettings';
import { t } from '../i18n/index.jsx';
import { defaultAvatar } from '../utils/avatar';
import { proxiedImageUrl } from '../utils/media';

const VOLUME_KEY = 'antigravity.userVolumes';
const MUTE_KEY = 'antigravity.userMutes';
// The transport label ("P2P 2/3", "SFU") is for whoever is debugging a call,
// not for the people in it.
const DEBUG_KEY = 'antigravity.voiceDebug';
// "X is speaking" at most this often per person, so a lively call does not
// turn the screen reader into a ticker.
const SPEAKING_ANNOUNCE_GAP_MS = 8000;

function loadJson(key) {
  try { return JSON.parse(localStorage.getItem(key) ?? '{}'); }
  catch { return {}; }
}

function saveJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}

function voiceDebug() {
  try { return localStorage.getItem(DEBUG_KEY) === '1'; } catch { return false; }
}

/** A translation, or English when the key has not been added yet. */
function tr(key, fallback, values) {
  const text = t(key, values);
  return text === key ? fallback : text;
}

/** 'Ctrl+Shift+M' → 'Control+Shift+M', the spelling aria-keyshortcuts wants. */
function ariaKeys(combo) {
  if (!combo) return undefined;
  return combo.split('+').map((k) => (k === 'Ctrl' ? 'Control' : k === 'Cmd' ? 'Meta' : k)).join('+');
}

/** A tooltip that says what the button does and how to do it from the keyboard. */
function withShortcut(label, combo) {
  return combo ? `${label} (${combo})` : label;
}

export default function VoiceRoom({
  headerActions = null,
  channel,
  participants,
  currentUser,
  isMuted,
  onToggleMute,
  isDeafened,
  onToggleDeafen,
  onLeaveVoice,
  onSpeakingChange,
  onVideoStateChange,
  onOpenVoiceSettings,
  socket,
  viewerPermissions = [],
  isOwner = false,
  onToast,
  // Keep the call running without drawing it. The media and peer hooks live in
  // this component, so unmounting it hangs up the audio; a parent that lets the
  // user browse other channels mid-call renders it with `hidden` instead.
  hidden = false
}) {
  const [showSoundboard, setShowSoundboard] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [lastSound, setLastSound] = useState(null);
  const { settings: voiceSettings, update: updateVoiceSettings } = useVoiceSettings();
  const { prefs } = useUserSettings();
  const keybinds = prefs?.keybinds ?? {};
  const [volumes, setVolumes] = useState(() => loadJson(VOLUME_KEY));
  const [localMutes, setLocalMutes] = useState(() => loadJson(MUTE_KEY));
  const [volumePanelFor, setVolumePanelFor] = useState(null);
  const [stageId, setStageId] = useState(null);   // `${userId}:${kind}` pinned to the stage
  const [layout, setLayout] = useState('grid');   // grid | focus
  const [socketDown, setSocketDown] = useState(() => Boolean(socket && socket.connected === false));
  const [offline, setOffline] = useState(() => typeof navigator !== 'undefined' && navigator.onLine === false);
  const showLabels = voiceSettings.callControlLabels !== false;

  // Stage channels: the audience is "suppressed" — they hear but cannot speak
  // until a moderator promotes them. The mic track is disabled locally as well
  // as refused by the server, so nothing leaks while a promotion is in flight.
  // Until the roster has told us which we are, we are audience.
  const isStage = channel?.type === 'stage';
  const selfState = participants.find((p) => p.userId === currentUser?.id);
  const suppressed = isStage && (!selfState || Boolean(selfState.isSuppressed));
  const canModerateStage = isStage && (isOwner || viewerPermissions.includes('MUTE_MEMBERS') || viewerPermissions.includes('ADMINISTRATOR'));
  const canManageChannel = isOwner || viewerPermissions.includes('MANAGE_CHANNELS') || viewerPermissions.includes('ADMINISTRATOR');
  const handRaised = Boolean(selfState?.requestedToSpeakAt);
  const speakers = isStage ? participants.filter((p) => !p.isSuppressed) : participants;
  const audience = isStage ? participants.filter((p) => p.isSuppressed) : [];

  // A stage never goes live by accident: whoever arrives as a speaker (a stage
  // moderator, or someone just invited up) starts muted and unmutes on
  // purpose. `stageArmed` holds the mic shut until that first mute has landed.
  const [stageArmed, setStageArmed] = useState(!isStage);
  const [stageTopic, setStageTopic] = useState(channel?.topic ?? '');
  const [stageStartDismissed, setStageStartDismissed] = useState(false);
  const wasSuppressedRef = useRef(true);
  useEffect(() => {
    if (!isStage || !selfState) return;
    const nowSpeaker = !selfState.isSuppressed;
    if (nowSpeaker && wasSuppressedRef.current && !isMuted) onToggleMute();
    wasSuppressedRef.current = !nowSpeaker;
    if (!stageArmed) setStageArmed(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStage, selfState?.isSuppressed, Boolean(selfState)]);

  // Spatial audio places each participant where their tile is: the row of
  // tiles is mapped onto -1 … 1, so the person on the left sounds left. It is
  // derived from the roster, so it stays right as people come and go.
  const spatialPositions = useMemo(() => {
    const others = participants.filter((p) => p.userId !== currentUser?.id);
    const map = {};
    others.forEach((p, index) => {
      map[p.userId] = others.length === 1 ? 0 : (index / (others.length - 1)) * 2 - 1;
    });
    return map;
  }, [participants, currentUser?.id]);

  // A server mute/deafen (moderator) overrides the user's own toggles. The
  // server enforces it too (and with LiveKit, the SFU does); this keeps the
  // local capture and playback honest while it is in effect.
  const serverMuted = Boolean(selfState?.isServerMuted);
  const serverDeafened = Boolean(selfState?.isServerDeafened);
  const effectiveDeafened = isDeafened || serverDeafened;
  const canModerate = (perm) => Boolean(channel?.server_id) && (isOwner || viewerPermissions.includes(perm) || viewerPermissions.includes('ADMINISTRATOR'));
  const [pipWindow, setPipWindow] = useState(null);
  const [moveTargets, setMoveTargets] = useState(null);

  const media = useVoiceMedia({
    enabled: true,
    isMuted: isMuted || suppressed || serverMuted || serverDeafened || (isStage && !stageArmed),
    onSpeakingChange
  });
  const pushToTalk = media.pushToTalk;

  const requestSpeak = (requesting) => socket?.emit('stage_request_speak', { channelId: channel.id, requesting }, (ack) => {
    if (!ack?.ok) onToast?.(t('stage.requestFailed'), { type: 'error' });
  });
  const setSpeaker = (userId, speaker) => socket?.emit('stage_set_speaker', { channelId: channel.id, userId, speaker }, (ack) => {
    if (!ack?.ok) onToast?.(t('stage.actionFailed'), { type: 'error' });
  });

  // Tell the promoted person what just happened.
  useEffect(() => {
    if (!socket || !isStage) return undefined;
    const onChanged = ({ channelId, speaker }) => {
      if (channelId !== channel?.id) return;
      const message = speaker
        ? tr('stage.youAreSpeakerMuted', 'You are a speaker now. You are muted — unmute when you are ready.')
        : t('stage.movedToAudience');
      onToast?.(message, { type: speaker ? 'success' : 'info' });
      announce(message);
    };
    socket.on('stage_speaker_changed', onChanged);
    return () => socket.off('stage_speaker_changed', onChanged);
  }, [socket, isStage, channel?.id, onToast]);

  // The media backend: the peer mesh (one RTCPeerConnection per other
  // participant) or, when the server runs one, the LiveKit SFU. Same inputs,
  // same outputs — the rest of this component does not care which.
  const mesh = useVoiceBackend({
    socket,
    channelId: channel?.id,
    tracks: media.outgoingTracks,
    participants,
    selfUserId: currentUser?.id,
    volumes,
    localMutes,
    isDeafened: effectiveDeafened,
    outputVolume: voiceSettings.outputVolume,
    outputDeviceId: voiceSettings.outputDeviceId,
    attenuation: voiceSettings.attenuation,
    attenuateWhileSpeaking: voiceSettings.attenuateWhileSpeaking,
    selfSpeaking: media.isSpeaking,
    spatialAudio: voiceSettings.spatialAudio,
    positions: spatialPositions
  });

  // Joining: a sound (if wanted) and a line for screen readers.
  useEffect(() => {
    playCallSound('join');
    announce(tr('voice.announceConnected', 'Connected to {channel}', { channel: channel?.name ?? '' }));
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  // Mute and deafen changes are announced whichever way they happened — the
  // button, the user panel or a keyboard shortcut all end up here.
  const previousMuteRef = useRef({ isMuted, deafened: effectiveDeafened });
  useEffect(() => {
    const prev = previousMuteRef.current;
    if (prev.deafened !== effectiveDeafened) {
      announce(effectiveDeafened
        ? tr('voice.announceDeafened', 'Deafened. You cannot hear the call.')
        : tr('voice.announceUndeafened', 'Undeafened.'));
    } else if (prev.isMuted !== isMuted) {
      announce(isMuted ? tr('voice.announceMuted', 'Microphone muted.') : tr('voice.announceUnmuted', 'Microphone on.'));
    }
    previousMuteRef.current = { isMuted, deafened: effectiveDeafened };
  }, [isMuted, effectiveDeafened]);

  // Others arriving and leaving: a sound and an announcement, like Discord.
  const rosterRef = useRef(null);
  useEffect(() => {
    // Until the roster includes us it is the room we are arriving in, not
    // people arriving — nobody "joined" then.
    if (!participants.some((p) => p.userId === currentUser?.id)) return;
    const ids = new Map(participants.map((p) => [p.userId, p.username]));
    const previous = rosterRef.current;
    rosterRef.current = ids;
    if (!previous) return;
    for (const [id, name] of ids) {
      if (id !== currentUser?.id && !previous.has(id)) {
        playCallSound('join');
        announce(tr('voice.announceUserJoined', '{name} joined the call', { name }));
      }
    }
    for (const [id, name] of previous) {
      if (id !== currentUser?.id && !ids.has(id)) {
        playCallSound('leave');
        announce(tr('voice.announceUserLeft', '{name} left the call', { name }));
      }
    }
  }, [participants, currentUser?.id]);

  // Optional: "X is speaking" for screen-reader users (off by default).
  const spokeAtRef = useRef(new Map());
  const speakingIds = participants.filter((p) => p.isSpeaking && p.userId !== currentUser?.id).map((p) => p.userId).join(',');
  useEffect(() => {
    if (!voiceSettings.announceSpeaking || !speakingIds) return;
    const now = Date.now();
    for (const id of speakingIds.split(',')) {
      if (now - (spokeAtRef.current.get(id) ?? 0) < SPEAKING_ANNOUNCE_GAP_MS) continue;
      spokeAtRef.current.set(id, now);
      const name = participants.find((p) => p.userId === id)?.username;
      if (name) announce(tr('voice.isSpeaking', '{name} is speaking', { name }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speakingIds, voiceSettings.announceSpeaking]);

  // Losing the gateway (or the network) freezes the roster; say so, and say
  // when it is back, rather than showing a call that looks fine but is not.
  useEffect(() => {
    if (!socket) return undefined;
    const down = () => { setSocketDown(true); announce(tr('voice.serverConnectionLost', 'Connection lost. Reconnecting…'), 'assertive'); };
    const up = () => {
      setSocketDown((was) => {
        if (was) announce(tr('voice.announceReconnected', 'Reconnected.'));
        return false;
      });
    };
    socket.on('disconnect', down);
    socket.on('connect', up);
    return () => { socket.off('disconnect', down); socket.off('connect', up); };
  }, [socket]);
  useEffect(() => {
    const goOffline = () => setOffline(true);
    const goOnline = () => setOffline(false);
    window.addEventListener('offline', goOffline);
    window.addEventListener('online', goOnline);
    return () => { window.removeEventListener('offline', goOffline); window.removeEventListener('online', goOnline); };
  }, []);

  /**
   * Play a soundboard clip the gateway broadcast.
   *
   * This fires for our own clips too — the broadcast comes back to the sender
   * like everyone else — which is what makes the button feel immediate without
   * a separate local-playback path that could drift out of sync with the room.
   *
   * Deafened means deafened: it silences the room, and a sound effect is part
   * of the room.
   */
  useEffect(() => {
    if (!socket) return undefined;
    const onSound = ({ channelId, userId, sound }) => {
      if (channelId !== channel?.id) return;
      setLastSound({ userId, name: sound.name, at: Date.now() });
      if (effectiveDeafened) return;
      playSoundboardClip(sound.url, {
        volume: sound.volume ?? 100,
        userVolume: voiceSettings.soundboardVolume ?? 100
      }).catch(() => { /* a missing clip should not break the call */ });
    };
    socket.on('sound_played', onSound);
    return () => socket.off('sound_played', onSound);
  }, [socket, channel?.id, effectiveDeafened, voiceSettings.soundboardVolume]);

  // A server mute/deafen aimed at us is announced (the roster carries the
  // state itself). A moderator disconnect arrives as voice_disconnected, which
  // App already handles by dropping the voice session.
  useEffect(() => {
    if (!socket) return undefined;
    const onServerState = ({ serverMute, serverDeaf } = {}) => {
      const say = (message) => { onToast?.(message, { type: 'info' }); announce(message); };
      if (serverMute !== undefined) {
        say(serverMute ? tr('voice.serverMutedYou', 'A moderator muted you in this server.') : tr('voice.serverUnmutedYou', 'A moderator unmuted you.'));
      }
      if (serverDeaf !== undefined) {
        say(serverDeaf ? tr('voice.serverDeafenedYou', 'A moderator deafened you in this server.') : tr('voice.serverUndeafenedYou', 'A moderator undeafened you.'));
      }
    };
    socket.on('voice_server_state', onServerState);
    return () => socket.off('voice_server_state', onServerState);
  }, [socket, onToast]);

  // Close the pop-out with the call.
  useEffect(() => () => { try { pipWindow?.close(); } catch { /* already closed */ } }, [pipWindow]);

  const openPip = async () => {
    const win = await openPipWindow();
    if (!win) return;
    win.addEventListener('pagehide', () => setPipWindow(null), { once: true });
    setPipWindow(win);
  };

  const moderate = async (action, userId, body) => {
    const url = `/api/voice/channels/${channel.id}/members/${userId}`;
    try {
      if (action === 'disconnect') await del(url);
      else await post(`${url}/${action}`, body);
    } catch (err) {
      onToast?.(err?.message || t('stage.actionFailed'), { type: 'error' });
    }
  };

  const muteEveryone = async (mute) => {
    try {
      const result = await post(`/api/voice/channels/${channel.id}/mute-all`, { mute });
      const count = result?.affected?.length ?? 0;
      const message = count === 0
        ? tr('voice.nobodyToMute', 'Nobody needed changing.')
        : mute
          ? tr('voice.mutedEveryone', 'Muted {count} people.', { count })
          : tr('voice.unmutedEveryone', 'Unmuted {count} people.', { count });
      onToast?.(message, { type: count ? 'success' : 'info' });
      announce(message);
    } catch (err) {
      onToast?.(err?.message || t('stage.actionFailed'), { type: 'error' });
    }
  };

  const loadMoveTargets = async () => {
    if (moveTargets || !channel?.server_id) return;
    try {
      const detail = await get(`/api/servers/${channel.server_id}`);
      setMoveTargets((detail?.channels ?? []).filter((c) => (c.type === 'voice' || c.type === 'stage') && c.id !== channel.id));
    } catch { setMoveTargets([]); }
  };

  // Clear the "X played Y" line after a moment.
  useEffect(() => {
    if (!lastSound) return undefined;
    const timer = setTimeout(() => setLastSound(null), 2500);
    return () => clearTimeout(timer);
  }, [lastSound]);

  // Tell the room when the camera or a screen share starts, so everyone's
  // roster shows it even before the media track lands.
  useEffect(() => {
    onVideoStateChange?.({
      isVideo: Boolean(media.cameraStream),
      isStreaming: Boolean(media.screenStream)
    });
  }, [media.cameraStream, media.screenStream, onVideoStateChange]);

  // A dropped "More" menu closes on Escape, like every other menu.
  useEffect(() => {
    if (!showMore) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setShowMore(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [showMore]);

  const setVolume = (userId, value) => {
    const next = { ...volumes, [userId]: value };
    setVolumes(next);
    saveJson(VOLUME_KEY, next);
  };

  const toggleLocalMute = (userId) => {
    const next = { ...localMutes, [userId]: !localMutes[userId] };
    if (!next[userId]) delete next[userId];
    setLocalMutes(next);
    saveJson(MUTE_KEY, next);
  };

  const handleMuteClick = () => {
    if (suppressed) { onToast?.(t('stage.audienceCannotUnmute'), { type: 'info' }); return; }
    if (serverMuted && isMuted) { onToast?.(tr('voice.serverMutedHint', 'A moderator muted you; you cannot unmute yourself.'), { type: 'info' }); return; }
    playCallSound(isMuted ? 'unmute' : 'mute');
    onToggleMute();
  };

  const handleDeafenClick = () => {
    playCallSound(effectiveDeafened ? 'unmute' : 'mute');
    onToggleDeafen();
  };

  const handleLeaveClick = () => {
    playCallSound('leave');
    announce(tr('voice.announceLeft', 'You left the call.'));
    onLeaveVoice();
  };

  const startStage = async () => {
    const topic = stageTopic.trim();
    if (canManageChannel && topic !== (channel?.topic ?? '')) {
      try { await patch(`/api/channels/${channel.id}`, { topic }); }
      catch (err) { onToast?.(err?.message || t('stage.actionFailed'), { type: 'error' }); }
    }
    setStageStartDismissed(true);
    if (isMuted) handleMuteClick();
    announce(tr('stage.liveNow', 'The stage is live. You are unmuted.'));
  };

  const isSharing = Boolean(media.screenStream);
  const selfId = currentUser?.id;
  const rosterFor = (userId) => participants.find((p) => p.userId === userId);

  /**
   * Every video the room currently has: our own camera and screen, plus each
   * peer's. One flat list keeps the stage and the grid in step.
   *
   * A remote video only counts when the roster agrees it exists (isVideo /
   * isStreaming). An idle transceiver can surface an empty track — on some
   * browsers it starts unmuted — and that used to paint a black "X is sharing
   * their screen" tile when nobody was sharing anything.
   */
  const videos = useMemo(() => {
    const list = [];
    if (media.cameraStream) list.push({ id: `${selfId}:camera`, userId: selfId, kind: 'camera', stream: media.cameraStream, isSelf: true });
    if (media.screenStream) list.push({ id: `${selfId}:screen`, userId: selfId, kind: 'screen', stream: media.screenStream, isSelf: true });
    for (const [userId, media_] of Object.entries(mesh.remoteMedia)) {
      const roster = participants.find((p) => p.userId === userId);
      if (media_.camera && roster?.isVideo) list.push({ id: `${userId}:camera`, userId, kind: 'camera', stream: media_.camera, isSelf: false });
      if (media_.screen && roster?.isStreaming) list.push({ id: `${userId}:screen`, userId, kind: 'screen', stream: media_.screen, isSelf: false });
    }
    return list;
  }, [media.cameraStream, media.screenStream, mesh.remoteMedia, selfId, participants]);

  // A screen share takes the stage automatically, exactly as in Discord.
  const autoStage = videos.find((v) => v.kind === 'screen') ?? null;
  const stage = videos.find((v) => v.id === stageId) ?? (layout === 'focus' ? videos[0] : autoStage);

  const nameFor = (userId) => rosterFor(userId)?.username ?? t('dm.unknownUser');

  const toggleNoiseSuppression = () => {
    const next = !voiceSettings.noiseSuppression;
    updateVoiceSettings({ noiseSuppression: next });
    const message = next
      ? tr('voice.noiseOn', 'Noise filter on: background noise is removed from your mic.')
      : tr('voice.noiseOff', 'Noise filter off: your mic sends everything it hears.');
    onToast?.(message, { type: 'info', ttl: 3000 });
    announce(message);
  };

  // The pop-out survives browsing other channels: it renders even when the
  // room itself is hidden.
  const pipPortal = pipWindow ? createPortal(
    <PipCallPanel
      channel={channel}
      participants={participants}
      selfId={currentUser?.id}
      localSpeaking={media.isSpeaking}
      quality={mesh.quality}
      connectionState={mesh.connectionState}
      isMuted={isMuted || serverMuted}
      isDeafened={effectiveDeafened}
      camera={Boolean(media.cameraStream)}
      sharing={Boolean(media.screenStream)}
      onToggleMute={handleMuteClick}
      onToggleDeafen={handleDeafenClick}
      onToggleCamera={media.toggleCamera}
      onToggleScreen={media.toggleScreenShare}
      onLeave={handleLeaveClick}
    />,
    pipWindow.document.body
  ) : null;

  if (hidden) return pipPortal;

  const peerStateLabel = (state) => {
    if (state === 'new' || state === 'connecting') return t('voice.connecting');
    if (state === 'disconnected') return tr('voice.reconnecting', 'Reconnecting…');
    if (state === 'failed') return tr('voice.connectionFailed', 'Can’t connect');
    return state;
  };

  const debug = voiceDebug();
  const connected = mesh.connectionState === 'connected' || (mesh.backend !== 'livekit' && mesh.peerCount === 0);
  const selfQuality = mesh.backend === 'livekit'
    ? (mesh.connectionState === 'connected' ? (mesh.selfQuality ?? 'good') : 'lost')
    : null;

  // What each person in the audience/speaker roles may do.
  const audienceMember = isStage && suppressed;
  const screenShareSupported = typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getDisplayMedia);
  const othersHere = participants.filter((p) => p.userId !== selfId);
  const anyServerMuted = othersHere.some((p) => p.isServerMuted);
  const showStageStart = isStage && canModerateStage && !suppressed && isMuted && !stageStartDismissed
    && !speakers.some((p) => p.userId !== selfId && !p.isMuted);

  const muteKeys = keybinds.toggleMute;
  const deafenKeys = keybinds.toggleDeafen;
  const leaveKeys = keybinds.disconnectVoice;

  // Secondary controls: inline from `sm` up, behind "More" on phones.
  const secondary = [
    !audienceMember && screenShareSupported && {
      key: 'share', icon: isSharing ? MonitorOff : Monitor,
      label: tr('voice.ctlShare', 'Share screen'),
      title: isSharing ? t('voice.stopSharing') : t('voice.shareScreen'),
      onClick: media.toggleScreenShare, pressed: isSharing, active: isSharing
    },
    Boolean(channel?.server_id) && {
      key: 'soundboard', icon: Music,
      label: tr('voice.ctlSoundboard', 'Soundboard'),
      title: t('soundboard.title'),
      onClick: () => setShowSoundboard((v) => !v), pressed: showSoundboard, active: showSoundboard
    },
    !audienceMember && {
      key: 'noise', icon: AudioLines,
      label: tr('voice.ctlNoise', 'Noise filter'),
      title: voiceSettings.noiseSuppression
        ? tr('voice.noiseOnShort', 'Noise filter is on')
        : tr('voice.noiseOffShort', 'Noise filter is off'),
      onClick: toggleNoiseSuppression, pressed: Boolean(voiceSettings.noiseSuppression), active: Boolean(voiceSettings.noiseSuppression),
      state: voiceSettings.noiseSuppression ? tr('voice.stateOn', 'On') : tr('voice.stateOff', 'Off')
    },
    isPipSupported() && {
      key: 'pip', icon: PictureInPicture2,
      label: tr('voice.ctlPopOut', 'Pop out'),
      title: tr('voice.popOut', 'Pop out call'),
      onClick: pipWindow ? () => pipWindow.close() : openPip, pressed: Boolean(pipWindow), active: Boolean(pipWindow)
    },
    Boolean(onOpenVoiceSettings) && {
      key: 'settings', icon: Settings,
      label: tr('voice.ctlSettings', 'Settings'),
      title: t('settings.voiceTitle'),
      onClick: onOpenVoiceSettings
    }
  ].filter(Boolean);

  const debugLabel = mesh.backend === 'livekit' ? 'SFU' : `P2P ${mesh.connectedCount}/${mesh.peerCount}`;
  const connectionText = mesh.backend === 'livekit'
    ? (mesh.connectionState === 'connected' ? qualityLabel(selfQuality) : mesh.connectionState === 'reconnecting' ? tr('voice.reconnecting', 'Reconnecting…') : t('voice.connecting'))
    : connected ? tr('voice.voiceConnected', 'Voice connected') : mesh.connectionState === 'reconnecting' ? tr('voice.reconnecting', 'Reconnecting…') : t('voice.connecting');

  return (
    <div className="flex-1 bg-d-sunken flex flex-col h-full min-w-0 min-h-0 select-none z-10" data-testid="voice-room">
      {/* Header */}
      <div className="min-h-12 px-4 py-1.5 border-b border-d-edge flex items-center justify-between gap-2 bg-d-surface shrink-0 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          {isStage ? <Radio className="w-5 h-5 text-d-online shrink-0" aria-hidden="true" /> : <Volume2 className="w-5 h-5 text-d-online shrink-0" aria-hidden="true" />}
          <h2 className="font-bold text-d-strong truncate text-base">{channel.name}</h2>
          <span className="text-xs text-d-text2 bg-d-control2/60 px-2 py-0.5 rounded font-semibold hidden sm:inline">
            {t('voice.inRoom', { count: participants.length })}
          </span>
          {isStage && (channel?.topic || stageStartDismissed) && stageTopic && (
            <span className="text-xs text-d-text2 truncate hidden md:inline" title={stageTopic}>· {stageTopic}</span>
          )}
        </div>
        <div className="flex items-center gap-3 text-xs text-d-text2">
          <span
            className="flex items-center gap-1"
            title={debug ? t('voice.p2pStatus') : undefined}
            data-testid="voice-backend"
            data-backend={mesh.backend === 'livekit' ? 'livekit' : 'mesh'}
            data-state={mesh.connectionState}
          >
            {mesh.backend === 'livekit'
              ? <QualityIcon quality={selfQuality} decorative />
              : connected ? <SignalHigh className="w-3.5 h-3.5 text-d-online" aria-hidden="true" /> : <SignalLow className="w-3.5 h-3.5 text-d-idle" aria-hidden="true" />}
            <span>{connectionText}</span>
            {debug && <span className="font-mono text-[10px] text-d-text3">{debugLabel}</span>}
            {mesh.e2ee && <Lock className="w-3 h-3" aria-label={tr('voice.e2ee', 'End-to-end encrypted')} />}
          </span>
          {!audienceMember && (media.transmitting ? (
            <span className="hidden sm:flex items-center gap-1 text-d-strong">
              <Radio className="w-3.5 h-3.5 text-d-online" aria-hidden="true" /> {t('voice.transmitting')}
            </span>
          ) : (
            <span className="hidden sm:flex items-center gap-1">
              <MicOff className="w-3.5 h-3.5" aria-hidden="true" /> {t('voice.notTransmitting')}
            </span>
          ))}
          {videos.length > 0 && (
            <button
              onClick={() => { setLayout(layout === 'grid' ? 'focus' : 'grid'); setStageId(null); }}
              className="min-w-6 min-h-6 pointer-coarse:min-w-11 pointer-coarse:min-h-11 inline-flex items-center justify-center hover:text-d-strong transition-colors"
              title={layout === 'grid' ? t('voice.focusView') : t('voice.gridView')}
              aria-label={layout === 'grid' ? t('voice.focusView') : t('voice.gridView')}
            >
              {layout === 'grid' ? <Maximize2 className="w-4 h-4" /> : <Grid2X2 className="w-4 h-4" />}
            </button>
          )}
          {/* The channel-level controls. They live here because the chat pane
              below runs with its own header hidden — one header per channel,
              not two. */}
          {headerActions}
        </div>
      </div>

      {(socketDown || offline) && (
        <div
          role="status"
          className="mx-4 mt-3 px-3 py-2 bg-d-idle/10 border border-d-idle/40 rounded flex items-center gap-2 text-xs text-d-strong"
          data-testid="voice-reconnecting"
        >
          {offline ? <WifiOff className="w-3.5 h-3.5 shrink-0" aria-hidden="true" /> : <RefreshCw className="w-3.5 h-3.5 shrink-0 animate-spin" aria-hidden="true" />}
          <span className="flex-1">
            {offline
              ? tr('voice.offline', 'You are offline. The call resumes when your connection is back.')
              : tr('voice.serverConnectionLost', 'Connection lost. Reconnecting…')}
          </span>
        </div>
      )}

      {Boolean(media.error) && (
        <div className="mx-4 mt-3 px-3 py-2 bg-d-danger/10 border border-d-danger/40 rounded flex items-start gap-2 text-xs text-d-strong" role="alert">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-d-danger" aria-hidden="true" />
          <span className="flex-1">
            {media.error}
            {!media.hasMic && (
              <span className="block text-d-text2 mt-0.5">
                {tr('voice.noMicHint', 'You are connected, but nobody can hear you until a microphone works.')}
              </span>
            )}
          </span>
          {onOpenVoiceSettings && (
            <button onClick={onOpenVoiceSettings} className="underline font-semibold shrink-0 min-h-6">
              {t('settings.voiceTitle')}
            </button>
          )}
          <button onClick={media.clearError} aria-label={t('common.close')} className="min-w-6 min-h-6 inline-flex items-center justify-center"><X className="w-3.5 h-3.5" /></button>
        </div>
      )}

      {!socketDown && !offline && (mesh.connectionState === 'reconnecting' || mesh.connectionState === 'disconnected' || mesh.connectionState === 'failed') && (
        <div
          role="status"
          className="mx-4 mt-3 px-3 py-2 bg-d-idle/10 border border-d-idle/40 rounded flex items-center gap-2 text-xs text-d-strong"
        >
          <RefreshCw className={`w-3.5 h-3.5 shrink-0 ${mesh.connectionState === 'reconnecting' ? 'animate-spin' : ''}`} aria-hidden="true" />
          <span className="flex-1">
            {mesh.connectionState === 'reconnecting'
              ? tr('voice.reconnecting', 'Reconnecting…')
              : tr('voice.voiceServerLost', 'Lost the connection to the voice server.')}
          </span>
          {mesh.connectionState !== 'reconnecting' && mesh.backend === 'livekit' && (
            <button onClick={mesh.retry} className="underline font-semibold shrink-0 min-h-6">
              {tr('voice.retry', 'Retry')}
            </button>
          )}
        </div>
      )}

      {(serverMuted || serverDeafened) && (
        <div className="mx-4 mt-3 px-3 py-2 bg-d-danger/10 border border-d-danger/40 rounded flex items-center gap-2 text-xs text-d-strong" data-testid="voice-server-muted">
          <Shield className="w-3.5 h-3.5 shrink-0 text-d-danger" aria-hidden="true" />
          {serverDeafened
            ? tr('voice.serverDeafenedBanner', 'A moderator has deafened you in this server.')
            : tr('voice.serverMutedBanner', 'A moderator has muted you in this server.')}
        </div>
      )}

      {/* Silence warning: transmitting but nothing is coming through. */}
      {Boolean(voiceSettings.silenceWarning) && media.transmitting && media.micLevel === 0 && (
        <div className="mx-4 mt-3 px-3 py-2 bg-d-idle/10 border border-d-idle/40 rounded text-xs text-d-strong">
          {t('voice.silenceWarning')}
        </div>
      )}

      {/* Moderators: the teacher's "quiet, please" for the whole room. */}
      {canModerate('MUTE_MEMBERS') && othersHere.length > 0 && (
        <div className="mx-4 mt-3 flex items-center gap-2 flex-wrap text-xs" role="group" aria-label={tr('voice.moderatorTools', 'Moderator tools')} data-testid="voice-mod-strip">
          <Shield className="w-3.5 h-3.5 text-d-text3" aria-hidden="true" />
          <span className="text-d-text2 font-semibold">{tr('voice.moderatorTools', 'Moderator tools')}</span>
          <button
            type="button"
            onClick={() => muteEveryone(true)}
            className="min-h-8 pointer-coarse:min-h-11 px-3 rounded-md bg-d-control2 hover:bg-d-control text-d-strong font-semibold inline-flex items-center gap-1.5"
            title={tr('voice.muteAllHint', 'Server-mutes everyone here except you, the owner and other moderators.')}
          >
            <MicOff className="w-3.5 h-3.5" aria-hidden="true" />
            {tr('voice.muteAll', 'Mute everyone')}
          </button>
          {anyServerMuted && (
            <button
              type="button"
              onClick={() => muteEveryone(false)}
              className="min-h-8 pointer-coarse:min-h-11 px-3 rounded-md bg-d-control2 hover:bg-d-control text-d-strong font-semibold inline-flex items-center gap-1.5"
            >
              <Mic className="w-3.5 h-3.5" aria-hidden="true" />
              {tr('voice.unmuteAll', 'Unmute everyone')}
            </button>
          )}
        </div>
      )}

      {/* Stage moderators arrive muted and go live on purpose. */}
      {showStageStart && (
        <section
          className="mx-4 mt-3 p-4 rounded-lg border border-d-brand/50 bg-d-brand/10 flex flex-col gap-3"
          aria-labelledby="stage-start-title"
          data-testid="stage-start"
        >
          <div className="flex items-start gap-2">
            <Radio className="w-5 h-5 text-d-brand shrink-0 mt-0.5" aria-hidden="true" />
            <div className="flex-1 min-w-0">
              <h3 id="stage-start-title" className="font-bold text-d-strong">{tr('stage.startTitle', 'Start the stage')}</h3>
              <p className="text-sm text-d-text2">{tr('stage.startHint', 'You are on stage but muted. Nobody hears you until you start.')}</p>
            </div>
            <button
              type="button"
              onClick={() => setStageStartDismissed(true)}
              className="min-w-8 min-h-8 pointer-coarse:min-w-11 pointer-coarse:min-h-11 inline-flex items-center justify-center rounded text-d-text2 hover:text-d-strong"
              aria-label={t('common.close')}
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          {canManageChannel && (
            <label className="flex flex-col gap-1 text-xs font-semibold text-d-text2">
              {tr('stage.topicLabel', 'Topic')}
              <input
                type="text"
                value={stageTopic}
                maxLength={120}
                onChange={(e) => setStageTopic(e.target.value)}
                placeholder={tr('stage.topicPlaceholder', 'What is this stage about?')}
                className="min-h-10 rounded-md bg-d-base border border-d-edge px-3 text-sm font-normal text-d-strong select-text"
              />
            </label>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={startStage}
              className="min-h-11 px-4 rounded-md bg-d-brand hover:bg-d-brandhover text-white text-sm font-semibold inline-flex items-center gap-2"
            >
              <Mic className="w-4 h-4" aria-hidden="true" />
              {tr('stage.start', 'Start stage')}
            </button>
            <button
              type="button"
              onClick={() => { setStageStartDismissed(true); setSpeaker(selfId, false); }}
              className="min-h-11 px-4 rounded-md bg-d-control2 hover:bg-d-control text-d-strong text-sm font-semibold"
            >
              {tr('stage.joinAudience', 'Listen from the audience')}
            </button>
          </div>
        </section>
      )}

      {/* The stage: a screen share, or whichever video is pinned. */}
      {stage && (
        <div className="mx-4 mt-3 rounded-xl overflow-hidden bg-black relative shrink-0 group">
          <VideoTile
            stream={stage.stream}
            mirror={Boolean(stage.isSelf) && stage.kind === 'camera' && voiceSettings.mirrorCamera}
            className="w-full max-h-[45vh] object-contain"
          />
          <div className="absolute top-2 left-2 bg-d-brand text-white text-xs font-bold px-2 py-0.5 rounded">
            {stage.kind === 'screen'
              ? (stage.isSelf
                ? tr('voice.youAreSharing', 'You are sharing your screen')
                : t('voice.sharingScreenBy', { name: nameFor(stage.userId) }))
              : stage.isSelf ? t('voice.youLabel') : nameFor(stage.userId)}
          </div>
          <div className="absolute top-2 right-2 flex gap-2 opacity-0 group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100 transition-opacity">
            {stageId === stage.id ? (
              <button
                onClick={() => setStageId(null)}
                className="bg-d-base/90 text-d-text2 hover:text-d-strong text-xs font-semibold px-2 min-h-7 pointer-coarse:min-h-11 rounded flex items-center gap-1"
              >
                <Minimize2 className="w-3 h-3" aria-hidden="true" /> {t('voice.unpin')}
              </button>
            ) : null}
            {Boolean(stage.isSelf) && stage.kind === 'screen' && (
              <button
                onClick={media.toggleScreenShare}
                className="bg-d-danger text-white text-xs font-semibold px-2 min-h-7 pointer-coarse:min-h-11 rounded"
              >
                {t('voice.stopSharing')}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Participant tiles. Smaller on phones and in short (landscape) windows,
          so two people fit above the controls without scrolling. */}
      <div className="flex-1 min-h-0 p-3 sm:p-6 grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4 overflow-y-auto content-start">
        {participants.length === 0 ? (
          <div className="col-span-full flex flex-col items-center justify-center text-d-text3 py-12">
            <Volume2 className="w-16 h-16 mb-4 text-d-active animate-pulse" aria-hidden="true" />
            <p className="text-lg font-semibold text-d-strong">{t('voice.nobodyHere')}</p>
            <p className="text-sm">{t('voice.testHint')}</p>
          </div>
        ) : (
          speakers.map((p) => {
            const isSelf = p.userId === selfId;
            const speaking = (isSelf ? media.isSpeaking : p.isSpeaking) && voiceSettings.showSpeakingIndicator;
            const volume = volumes[p.userId] ?? 100;
            const locallyMuted = Boolean(localMutes[p.userId]);
            const camera = isSelf ? media.cameraStream : (p.isVideo ? mesh.remoteMedia[p.userId]?.camera : null);
            const screen = isSelf ? media.screenStream : (p.isStreaming ? mesh.remoteMedia[p.userId]?.screen : null);
            const onStage = stage?.userId === p.userId;
            const displayName = isSelf ? `${p.username} ${t('voice.you')}` : p.username;

            return (
              <div
                key={p.userId}
                data-testid="voice-tile"
                data-speaking={speaking ? 'true' : 'false'}
                className={`relative bg-d-surface rounded-2xl h-32 sm:h-44 lg:h-56 [@media(max-height:520px)]:h-24 flex flex-col items-center justify-center p-3 transition-all duration-150 overflow-hidden group ${
                  speaking ? 'ring-4 ring-d-online' : 'border border-d-divider'
                }`}
              >
                {camera && !(onStage && stage.kind === 'camera') ? (
                  <VideoTile
                    stream={camera}
                    mirror={isSelf && voiceSettings.mirrorCamera}
                    className="absolute inset-0 w-full h-full object-cover"
                  />
                ) : (
                  <div className="relative mb-6 sm:mb-3 flex flex-col items-center">
                    <img
                      src={proxiedImageUrl(p.avatar_url) || defaultAvatar(p.userId ?? p.user_id ?? p.id)}
                      alt=""
                      className={`w-14 h-14 sm:w-20 sm:h-20 lg:w-24 lg:h-24 [@media(max-height:520px)]:w-10 [@media(max-height:520px)]:h-10 rounded-full object-cover transition-transform ${
                        speaking ? 'scale-105 ring-4 ring-d-online' : ''
                      }`}
                    />
                    {Boolean(p.isMuted) && (
                      <div className="absolute bottom-0 right-0 bg-d-danger p-1 sm:p-1.5 rounded-full text-white shadow-md">
                        <MicOff className="w-3 h-3 sm:w-4 sm:h-4" aria-hidden="true" />
                      </div>
                    )}
                  </div>
                )}

                {/* Speaking is shown three ways — ring, icon and words — so it
                    never depends on telling green from grey. */}
                {speaking && (
                  <span className="absolute top-2 right-2 inline-flex items-center gap-1 rounded-full bg-d-online px-2 py-0.5 text-[11px] font-bold text-black">
                    <AudioLines className="w-3 h-3" aria-hidden="true" />
                    <span className="hidden sm:inline">{tr('voice.speaking', 'Speaking')}</span>
                  </span>
                )}

                {!isSelf && mesh.peerStates[p.socketId] && mesh.peerStates[p.socketId] !== 'connected' && (
                  <span
                    className={`absolute top-2 left-2 text-[11px] px-1.5 py-0.5 rounded font-semibold ${
                      mesh.peerStates[p.socketId] === 'failed' ? 'bg-d-danger text-white' : 'bg-d-base/90 text-d-strong'
                    }`}
                    title={mesh.peerStates[p.socketId] === 'failed'
                      ? tr('voice.connectionFailedHint', 'No network route to this person. The server needs a TURN relay for some networks.')
                      : undefined}
                  >
                    {peerStateLabel(mesh.peerStates[p.socketId])}
                  </span>
                )}

                {/* Stage: a speaker can step down; a moderator can send anyone to the audience. */}
                {isStage && (isSelf || canModerateStage) && (
                  <button
                    onClick={() => setSpeaker(p.userId, false)}
                    className="absolute top-2 left-2 bg-d-base/90 min-w-7 min-h-7 pointer-coarse:min-w-11 pointer-coarse:min-h-11 inline-flex items-center justify-center rounded text-d-text2 hover:text-d-strong opacity-0 group-hover:opacity-100 focus:opacity-100 pointer-coarse:opacity-100 transition-opacity"
                    title={isSelf ? t('stage.stepDown') : t('stage.moveToAudience')}
                    aria-label={isSelf ? t('stage.stepDown') : t('stage.moveToAudience')}
                  >
                    <ArrowDownToLine className="w-3.5 h-3.5" />
                  </button>
                )}

                {/* Pin this person's video to the stage. */}
                {(camera || screen) && !speaking && (
                  <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100 transition-opacity">
                    {camera && (
                      <button
                        onClick={() => setStageId(stageId === `${p.userId}:camera` ? null : `${p.userId}:camera`)}
                        className="bg-d-base/90 min-w-7 min-h-7 pointer-coarse:min-w-11 pointer-coarse:min-h-11 inline-flex items-center justify-center rounded text-d-text2 hover:text-d-strong"
                        title={t('voice.pinVideo')}
                        aria-label={t('voice.pinVideo')}
                      >
                        <User className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {screen && (
                      <button
                        onClick={() => setStageId(stageId === `${p.userId}:screen` ? null : `${p.userId}:screen`)}
                        className="bg-d-base/90 min-w-7 min-h-7 pointer-coarse:min-w-11 pointer-coarse:min-h-11 inline-flex items-center justify-center rounded text-d-text2 hover:text-d-strong"
                        title={t('voice.pinScreen')}
                        aria-label={t('voice.pinScreen')}
                      >
                        <Monitor className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                )}

                <div className="bg-d-base/90 backdrop-blur px-2 sm:px-3 py-1 rounded-md flex items-center gap-1.5 absolute bottom-2 left-2 sm:bottom-3 sm:left-3 max-w-[calc(100%-3.5rem)]">
                  <span className="text-xs sm:text-sm font-bold text-d-strong truncate">
                    {displayName}
                  </span>
                  {speaking && <span className="sr-only">{tr('voice.speaking', 'Speaking')}</span>}
                  {Boolean(p.isMuted) && <MicOff className="w-3.5 h-3.5 text-d-danger shrink-0" aria-label={t('voice.mute')} />}
                  {Boolean(p.isServerMuted) && <Shield className="w-3.5 h-3.5 text-d-danger shrink-0" aria-label={tr('voice.serverMuted', 'Server muted')} />}
                  {Boolean(p.isDeafened || p.isServerDeafened) && <HeadphoneOff className="w-3.5 h-3.5 text-d-danger shrink-0" aria-label={t('sidebar.deafen')} />}
                  {Boolean(mesh.quality?.[p.userId]) && <QualityIcon quality={mesh.quality[p.userId]} />}
                  {Boolean(p.isVideo) && <Video className="w-3.5 h-3.5 text-d-online shrink-0 hidden sm:block" aria-hidden="true" />}
                  {Boolean(p.isStreaming) && <Monitor className="w-3.5 h-3.5 text-d-brand shrink-0 hidden sm:block" aria-hidden="true" />}
                  {locallyMuted && <VolumeX className="w-3.5 h-3.5 text-d-idle shrink-0" aria-label={t('voice.mutedLocally')} />}
                </div>

                {/* Self: live mic meter. Others: per-user volume and local mute. */}
                {isSelf ? (
                  media.transmitting && (
                    <div className="absolute bottom-3 right-3 w-10 sm:w-16 h-1.5 bg-d-sunken rounded-full overflow-hidden" aria-hidden="true">
                      <div
                        className="h-full bg-d-online transition-all duration-75"
                        style={{ width: `${Math.min(100, media.micLevel * 2.5)}%` }}
                      />
                    </div>
                  )
                ) : (
                  <div className="absolute bottom-1 right-1 sm:bottom-2 sm:right-2">
                    <button
                      onClick={() => setVolumePanelFor(volumePanelFor === p.userId ? null : p.userId)}
                      className="min-w-8 min-h-8 pointer-coarse:min-w-11 pointer-coarse:min-h-11 inline-flex items-center justify-center rounded-full bg-d-base/90 text-d-text2 hover:text-d-strong transition-colors"
                      title={t('voice.volumeForPercent', { name: p.username, percent: volume })}
                      aria-label={t('voice.adjustVolumeFor', { name: p.username })}
                      aria-expanded={volumePanelFor === p.userId}
                    >
                      {locallyMuted || volume === 0 ? <VolumeX className="w-4 h-4" />
                        : volume < 60 ? <Volume1 className="w-4 h-4" />
                        : <Volume2 className="w-4 h-4" />}
                    </button>

                    {volumePanelFor === p.userId && (
                      <div className="absolute bottom-10 right-0 z-20 bg-d-sunken border border-d-surface rounded-lg p-3 w-48 shadow-2xl">
                        <p className="text-[11px] font-bold text-d-text2 uppercase mb-1.5">
                          {t('voice.volumeLevel', { percent: volume })}
                        </p>
                        <input
                          type="range" min={0} max={200} value={volume}
                          onChange={(e) => setVolume(p.userId, Number(e.target.value))}
                          className="w-full accent-d-brand"
                          aria-label={t('voice.volumeFor', { name: p.username })}
                        />
                        <button
                          onClick={() => toggleLocalMute(p.userId)}
                          className={`mt-2 w-full text-xs font-semibold min-h-8 rounded transition-colors ${
                            locallyMuted ? 'bg-d-danger text-white' : 'bg-d-surface text-d-text2 hover:text-d-strong'
                          }`}
                        >
                          {locallyMuted ? t('voice.unmuteUser') : t('voice.muteUser')}
                        </button>
                        {(canModerate('MUTE_MEMBERS') || canModerate('DEAFEN_MEMBERS') || canModerate('MOVE_MEMBERS')) && (
                          <div className="mt-2 pt-2 border-t border-d-surface flex flex-col gap-1" role="group" aria-label={tr('voice.moderation', 'Moderation')}>
                            {canModerate('MUTE_MEMBERS') && (
                              <button
                                onClick={() => moderate('mute', p.userId, { mute: !p.isServerMuted })}
                                className="text-xs text-left px-2 min-h-8 rounded hover:bg-d-surface text-d-text2 flex items-center gap-1.5"
                              >
                                <MicOff className="w-3 h-3" aria-hidden="true" />
                                {p.isServerMuted ? tr('voice.serverUnmute', 'Server unmute') : tr('voice.serverMute', 'Server mute')}
                              </button>
                            )}
                            {canModerate('DEAFEN_MEMBERS') && (
                              <button
                                onClick={() => moderate('deafen', p.userId, { deaf: !p.isServerDeafened })}
                                className="text-xs text-left px-2 min-h-8 rounded hover:bg-d-surface text-d-text2 flex items-center gap-1.5"
                              >
                                <HeadphoneOff className="w-3 h-3" aria-hidden="true" />
                                {p.isServerDeafened ? tr('voice.serverUndeafen', 'Server undeafen') : tr('voice.serverDeafen', 'Server deafen')}
                              </button>
                            )}
                            {canModerate('MOVE_MEMBERS') && (
                              <>
                                <label className="text-[11px] text-d-text2 flex items-center gap-1.5 px-2">
                                  <ArrowRightLeft className="w-3 h-3" aria-hidden="true" />
                                  <select
                                    className="flex-1 bg-d-surface text-d-text2 text-xs rounded px-1 min-h-8"
                                    aria-label={tr('voice.moveTo', 'Move to…')}
                                    value=""
                                    onFocus={loadMoveTargets}
                                    onMouseDown={loadMoveTargets}
                                    onChange={(e) => { if (e.target.value) moderate('move', p.userId, { channelId: e.target.value }); }}
                                  >
                                    <option value="">{tr('voice.moveTo', 'Move to…')}</option>
                                    {(moveTargets ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                                  </select>
                                </label>
                                <button
                                  onClick={() => moderate('disconnect', p.userId)}
                                  className="text-xs text-left px-2 min-h-8 rounded hover:bg-d-danger/20 text-d-danger flex items-center gap-1.5"
                                >
                                  <UserX className="w-3 h-3" aria-hidden="true" />
                                  {tr('voice.disconnectMember', 'Disconnect')}
                                </button>
                              </>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
        {isStage && speakers.length === 0 && participants.length > 0 && (
          <div className="col-span-full flex flex-col items-center justify-center text-d-text3 py-8">
            <Radio className="w-12 h-12 mb-3 text-d-active" aria-hidden="true" />
            <p className="text-lg font-semibold text-d-strong">{t('stage.noSpeakers')}</p>
            <p className="text-sm text-d-text2">{canModerateStage ? t('stage.noSpeakersModHint') : t('stage.noSpeakersHint')}</p>
          </div>
        )}
      </div>

      {/* Stage audience: compact strip, hands first. */}
      {isStage && (
        <div className="px-4 sm:px-6 py-3 border-t border-d-edge bg-d-surface/40 shrink-0 max-h-40 overflow-y-auto">
          <div className="flex items-center justify-between mb-2 gap-2">
            <h3 className="text-xs font-bold uppercase tracking-wide text-d-text2">
              {t('stage.audience', { count: audience.length })}
            </h3>
            {audience.some((p) => p.requestedToSpeakAt) && (
              <span className="text-xs text-d-strong font-semibold inline-flex items-center gap-1">
                <Hand className="w-3.5 h-3.5 text-d-brand" aria-hidden="true" />
                {t('stage.handsRaised', { count: audience.filter((p) => p.requestedToSpeakAt).length })}
              </span>
            )}
          </div>
          {audienceMember && (
            <p className="text-xs text-d-text2 mb-2" data-testid="stage-audience-hint">
              {handRaised
                ? tr('stage.handRaisedHint', 'Your hand is up. A moderator can invite you to speak.')
                : tr('stage.audienceHint', 'You are in the audience. Raise your hand to ask to speak.')}
            </p>
          )}
          {audience.length === 0 ? (
            <p className="text-xs text-d-text2">{t('stage.noAudience')}</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {[...audience].sort((a, b) => (a.requestedToSpeakAt ? 0 : 1) - (b.requestedToSpeakAt ? 0 : 1)).map((p) => (
                <li key={p.userId} className={`flex items-center gap-2 rounded-full pl-1 pr-1 py-1 border ${p.requestedToSpeakAt ? 'border-d-brand bg-d-brand/10' : 'border-d-edge bg-d-surface'}`}>
                  <img src={proxiedImageUrl(p.avatar_url) || defaultAvatar(p.userId ?? p.user_id ?? p.id)} alt="" className="w-6 h-6 rounded-full object-cover" />
                  <span className="text-xs text-d-strong max-w-[8rem] truncate pr-1">{p.username}{p.userId === selfId && ` ${t('voice.you')}`}</span>
                  {Boolean(p.requestedToSpeakAt) && (
                    <span className="inline-flex items-center gap-0.5 text-[11px] text-d-strong pr-1">
                      <Hand className="w-3.5 h-3.5 text-d-brand" aria-hidden="true" />
                      <span className="hidden sm:inline">{t('stage.wantsToSpeak')}</span>
                      <span className="sr-only sm:hidden">{t('stage.wantsToSpeak')}</span>
                    </span>
                  )}
                  {canModerateStage && (
                    <button
                      onClick={() => setSpeaker(p.userId, true)}
                      className="min-h-7 pointer-coarse:min-h-11 px-2 rounded-full bg-d-brand hover:bg-d-brandhover text-white text-[11px] font-semibold inline-flex items-center gap-1"
                      title={t('stage.inviteToSpeak', { name: p.username })}
                      aria-label={t('stage.inviteToSpeak', { name: p.username })}
                    >
                      <ArrowUpFromLine className="w-3 h-3" aria-hidden="true" />
                      {tr('stage.invite', 'Invite to speak')}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Controls. They sit below the tiles (never over them), wrap into
          centred rows on narrow screens, and every button carries a word as
          well as an icon. */}
      <div
        className="relative py-2 sm:py-3 px-2 bg-d-surface border-t border-d-edge flex flex-wrap items-start justify-center gap-x-1 gap-y-2 sm:gap-x-2 shrink-0"
        role="toolbar"
        aria-label={tr('voice.callControls', 'Call controls')}
        data-testid="voice-controls"
        data-labels={showLabels ? 'on' : 'off'}
      >
        {showSoundboard && (
          <SoundboardPanel
            serverId={channel?.server_id}
            channelId={channel?.id}
            socket={socket}
            onClose={() => setShowSoundboard(false)}
            onToast={onToast}
          />
        )}

        {lastSound && (
          <div
            role="status"
            className="absolute -top-9 left-1/2 -translate-x-1/2 rounded-full bg-d-base3/90 px-3 py-1
              text-xs text-d-text2 shadow-lg"
          >
            {t('soundboard.played', {
              name: lastSound.userId === selfId ? t('voice.youLabel') : nameFor(lastSound.userId),
              sound: lastSound.name
            })}
          </div>
        )}

        {audienceMember && (
          <CallControl
            icon={Hand}
            label={handRaised ? t('stage.lowerHand') : t('stage.raiseHand')}
            onClick={() => requestSpeak(!handRaised)}
            pressed={handRaised}
            active={handRaised}
            showLabel
            wide
            testId="stage-raise-hand"
          />
        )}

        {!audienceMember && (
          <CallControl
            icon={isMuted || serverMuted ? MicOff : Mic}
            label={tr('voice.ctlMute', 'Mute')}
            title={withShortcut(serverMuted ? tr('voice.serverMuted', 'Server muted') : isMuted ? t('sidebar.unmute') : t('sidebar.mute'), muteKeys)}
            keys={muteKeys}
            onClick={handleMuteClick}
            pressed={isMuted || serverMuted}
            danger={isMuted || serverMuted}
            showLabel={showLabels}
            testId="voice-mute"
          />
        )}

        <CallControl
          icon={effectiveDeafened ? HeadphoneOff : Headphones}
          label={tr('voice.ctlDeafen', 'Deafen')}
          title={withShortcut(effectiveDeafened ? t('sidebar.undeafen') : t('sidebar.deafen'), deafenKeys)}
          keys={deafenKeys}
          onClick={handleDeafenClick}
          pressed={effectiveDeafened}
          danger={effectiveDeafened}
          showLabel={showLabels}
          testId="voice-deafen"
        />

        {!audienceMember && (
          <CallControl
            icon={media.cameraStream ? Video : VideoOff}
            label={tr('voice.ctlCamera', 'Camera')}
            title={media.cameraStream ? t('voice.stopCamera') : t('voice.toggleCamera')}
            onClick={media.toggleCamera}
            pressed={Boolean(media.cameraStream)}
            active={Boolean(media.cameraStream)}
            showLabel={showLabels}
            testId="voice-camera"
          />
        )}

        {/* Push-to-talk: a real hold-to-talk button that works with a finger,
            a mouse or the keyboard. Choosing the mode lives in Voice settings;
            tapping here never switches it off. */}
        {pushToTalk && !audienceMember && (
          <button
            type="button"
            data-testid="voice-ptt"
            aria-pressed={media.pttHeld}
            aria-label={tr('voice.holdToTalk', 'Hold to talk')}
            title={tr('voice.holdToTalkTitle', 'Hold to talk. You can also hold {key}.', { key: voiceSettings.pushToTalkKey || 'Space' })}
            onPointerDown={(e) => {
              if (e.button !== undefined && e.button > 0) return;
              try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
              media.holdToTalk(true);
            }}
            onPointerUp={() => media.holdToTalk(false)}
            onPointerCancel={() => media.holdToTalk(false)}
            onLostPointerCapture={() => media.holdToTalk(false)}
            onKeyDown={(e) => {
              if ((e.key === ' ' || e.key === 'Enter') && !e.repeat) { e.preventDefault(); media.holdToTalk(true); }
            }}
            onKeyUp={(e) => { if (e.key === ' ' || e.key === 'Enter') media.holdToTalk(false); }}
            onBlur={() => media.holdToTalk(false)}
            onContextMenu={(e) => e.preventDefault()}
            style={{ touchAction: 'none', WebkitTouchCallout: 'none' }}
            className={`order-first basis-full sm:basis-auto sm:order-none min-h-14 pointer-coarse:min-h-[72px] [@media(max-height:520px)]:order-none [@media(max-height:520px)]:basis-auto pointer-coarse:[@media(max-height:520px)]:min-h-12 [@media(max-height:520px)]:min-h-12 px-6 rounded-full font-bold text-sm inline-flex items-center justify-center gap-2 transition-colors select-none ${
              media.pttHeld ? 'bg-d-online text-black' : 'bg-d-brand hover:bg-d-brandhover text-white'
            }`}
          >
            <Radio className="w-5 h-5" aria-hidden="true" />
            <span>{media.pttHeld ? t('voice.talking') : tr('voice.holdToTalk', 'Hold to talk')}</span>
            <span className="text-xs font-semibold opacity-90 pointer-coarse:hidden">
              {tr('voice.orHoldKey', 'or hold {key}', { key: voiceSettings.pushToTalkKey || 'Space' })}
            </span>
          </button>
        )}

        {/* Secondary controls: inline from small tablets up … */}
        <div className="hidden sm:[@media(min-height:521px)]:contents">
          {secondary.map((c) => (
            <CallControl
              key={c.key}
              icon={c.icon}
              label={c.label}
              title={c.title}
              onClick={c.onClick}
              pressed={c.pressed}
              active={c.active}
              state={c.state}
              showLabel={showLabels}
              testId={`voice-${c.key}`}
            />
          ))}
        </div>

        {/* … and behind "More" on phones. */}
        {secondary.length > 0 && (
          <div className="relative sm:[@media(min-height:521px)]:hidden">
            <CallControl
              icon={MoreHorizontal}
              label={tr('voice.ctlMore', 'More')}
              onClick={() => setShowMore((v) => !v)}
              expanded={showMore}
              active={showMore}
              showLabel
              testId="voice-more"
            />
            {showMore && (
              <div
                className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 z-30 w-60 max-w-[calc(100vw-2rem)] rounded-lg border border-d-edge bg-d-canvas shadow-2xl p-1"
                role="group"
                aria-label={tr('voice.ctlMore', 'More')}
              >
                {secondary.map((c) => {
                  const Icon = c.icon;
                  return (
                    <button
                      key={c.key}
                      type="button"
                      onClick={() => { setShowMore(false); c.onClick(); }}
                      aria-pressed={c.pressed === undefined ? undefined : Boolean(c.pressed)}
                      className="w-full min-h-11 px-3 rounded-md flex items-center gap-3 text-sm text-d-strong hover:bg-d-control2 text-left"
                    >
                      <Icon className="w-5 h-5 shrink-0" aria-hidden="true" />
                      <span className="flex-1">{c.label}</span>
                      {c.state && <span className="text-xs text-d-text2">{c.state}</span>}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Leave: a labelled red pill on phones, a red circle with a word
            under it elsewhere. */}
        <CallControl
          icon={PhoneOff}
          label={tr('voice.ctlLeave', 'Leave')}
          title={withShortcut(t('sidebar.disconnect'), leaveKeys)}
          keys={leaveKeys}
          onClick={handleLeaveClick}
          leave
          showLabel={showLabels}
          testId="voice-leave"
        />

        {/* Wide screens: fold the words away once you know the buttons. */}
        <button
          type="button"
          onClick={() => updateVoiceSettings({ callControlLabels: !showLabels })}
          className="hidden lg:inline-flex absolute right-3 top-1/2 -translate-y-1/2 min-w-8 min-h-8 items-center justify-center rounded-md text-d-text2 hover:text-d-strong hover:bg-d-control2"
          title={showLabels ? tr('voice.hideLabels', 'Hide button labels') : tr('voice.showLabels', 'Show button labels')}
          aria-label={showLabels ? tr('voice.hideLabels', 'Hide button labels') : tr('voice.showLabels', 'Show button labels')}
          aria-pressed={!showLabels}
          data-testid="voice-labels-toggle"
        >
          <Tags className="w-4 h-4" />
        </button>
      </div>
      {pipPortal}
    </div>
  );
}

/**
 * One call button: a 48px circle with the icon and, underneath, the word for
 * it. With labels folded away (wide screens only) the word stays in the
 * accessibility tree. Short windows (a phone on its side) fold them too, so
 * the tiles keep their room.
 */
function CallControl({
  icon: Icon, label, title, onClick, pressed, expanded, active = false, danger = false,
  leave = false, wide = false, showLabel = true, keys, state, testId
}) {
  const circle = leave
    ? 'bg-d-danger hover:bg-d-dangerhover text-white'
    : danger
      ? 'bg-d-danger text-white'
      : active
        ? 'bg-d-brand text-white'
        : 'bg-d-control2 text-d-strong hover:bg-d-control';
  const labelClass = showLabel
    ? '[@media(max-height:480px)]:sr-only'
    : 'lg:sr-only [@media(max-height:480px)]:sr-only';
  return (
    <button
      type="button"
      onClick={onClick}
      title={title ?? label}
      aria-label={label}
      aria-pressed={pressed === undefined ? undefined : Boolean(pressed)}
      aria-expanded={expanded === undefined ? undefined : Boolean(expanded)}
      aria-keyshortcuts={ariaKeys(keys)}
      data-testid={testId}
      className={`group/ctl flex flex-col items-center gap-1 rounded-xl px-1 min-w-14 ${wide ? 'sm:min-w-24' : ''} ${
        leave ? 'max-sm:flex-row max-sm:gap-2 max-sm:px-5 max-sm:min-h-12 max-sm:rounded-full max-sm:bg-d-danger max-sm:text-white max-sm:ml-1' : ''
      } focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-d-brand`}
    >
      <span
        className={`relative w-12 h-12 [@media(max-height:480px)]:w-11 [@media(max-height:480px)]:h-11 rounded-full inline-flex items-center justify-center transition-colors ${circle} ${
          leave ? 'max-sm:w-auto max-sm:h-auto max-sm:bg-transparent max-sm:hover:bg-transparent' : ''
        } ${wide ? 'sm:w-auto sm:px-4' : ''}`}
        aria-hidden="true"
      >
        <Icon className="w-6 h-6 [@media(max-height:480px)]:w-5 [@media(max-height:480px)]:h-5" />
        {state && (
          <span className={`absolute -bottom-0.5 -right-0.5 w-3 h-3 rounded-full border-2 border-d-surface ${active ? 'bg-d-online' : 'bg-d-text3'}`} />
        )}
      </span>
      <span
        className={`text-xs leading-tight font-semibold text-center max-w-[6rem] ${leave ? 'max-sm:text-sm max-sm:font-bold max-sm:not-sr-only' : 'text-d-text2 group-hover/ctl:text-d-strong'} ${labelClass}`}
        aria-hidden="true"
      >
        {label}{state ? `: ${state}` : ''}
      </span>
    </button>
  );
}

/** Words for a LiveKit/mesh connection quality grade. */
function qualityLabel(quality) {
  return {
    excellent: tr('voice.qualityExcellent', 'Excellent connection'),
    good: tr('voice.qualityGood', 'Good connection'),
    poor: tr('voice.qualityPoor', 'Poor connection'),
    lost: tr('voice.qualityLost', 'Connection lost')
  }[quality] ?? tr('voice.voiceConnected', 'Voice connected');
}

/** Four-step signal glyph for a LiveKit/mesh connection quality grade. */
function QualityIcon({ quality, decorative = false }) {
  if (!['excellent', 'good', 'poor', 'lost'].includes(quality)) return null;
  const label = qualityLabel(quality);
  const Icon = quality === 'excellent' ? SignalHigh : quality === 'good' ? SignalMedium : quality === 'poor' ? SignalLow : SignalZero;
  const color = quality === 'excellent' || quality === 'good' ? 'text-d-online' : quality === 'poor' ? 'text-d-idle' : 'text-d-danger';
  if (decorative) return <Icon className={`w-3.5 h-3.5 ${color}`} aria-hidden="true" data-quality={quality} />;
  return (
    <span role="img" aria-label={label} title={label} data-quality={quality} className="inline-flex shrink-0">
      <Icon className={`w-3.5 h-3.5 ${color}`} aria-hidden="true" />
    </span>
  );
}

/**
 * The pop-out window's content: who is here (speaking ring), and the controls
 * people reach for without switching back to the tab.
 */
function PipCallPanel({
  channel, participants, selfId, localSpeaking, quality, connectionState,
  isMuted, isDeafened, camera, sharing,
  onToggleMute, onToggleDeafen, onToggleCamera, onToggleScreen, onLeave
}) {
  const btn = (active, danger) => `p-2.5 rounded-full transition-all ${
    active ? (danger ? 'bg-d-danger text-white' : 'bg-d-brand text-white') : 'bg-d-control2 text-d-strong hover:bg-d-control'
  }`;
  return (
    <div className="h-screen w-screen bg-d-sunken text-d-text flex flex-col p-3 gap-3 select-none">
      <div className="flex items-center gap-2 text-sm font-bold text-d-strong min-w-0">
        <Volume2 className="w-4 h-4 text-d-online shrink-0" aria-hidden="true" />
        <span className="truncate flex-1">{channel?.name}</span>
        {connectionState === 'reconnecting' && <span className="text-xs text-d-strong">{tr('voice.reconnecting', 'Reconnecting…')}</span>}
      </div>
      <ul className="flex-1 flex flex-wrap content-start gap-2 overflow-y-auto">
        {participants.map((p) => {
          const speaking = p.userId === selfId ? localSpeaking : p.isSpeaking;
          return (
            <li key={p.userId} className="flex flex-col items-center w-16" title={p.username}>
              <span className="relative">
                <img
                  src={proxiedImageUrl(p.avatar_url) || defaultAvatar(p.userId)}
                  alt=""
                  className={`w-11 h-11 rounded-full object-cover ${speaking ? 'ring-2 ring-d-online' : ''}`}
                />
                {speaking && (
                  <span className="absolute -top-1 -right-1 rounded-full bg-d-online p-0.5 text-black">
                    <AudioLines className="w-3 h-3" aria-label={tr('voice.speaking', 'Speaking')} />
                  </span>
                )}
              </span>
              <span className="text-[11px] truncate w-full text-center flex items-center justify-center gap-0.5">
                {Boolean(p.isMuted) && <MicOff className="w-2.5 h-2.5 text-d-danger shrink-0" aria-label={t('voice.mute')} />}
                <span className="truncate">{p.username}</span>
                {Boolean(quality?.[p.userId]) && <QualityIcon quality={quality[p.userId]} />}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="flex items-center justify-center gap-2">
        <button onClick={onToggleMute} className={btn(isMuted, true)} aria-pressed={isMuted} aria-label={t('sidebar.mute')} title={t('sidebar.mute')}>
          {isMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
        </button>
        <button onClick={onToggleDeafen} className={btn(isDeafened, true)} aria-pressed={isDeafened} aria-label={t('sidebar.deafen')} title={t('sidebar.deafen')}>
          {isDeafened ? <HeadphoneOff className="w-5 h-5" /> : <Headphones className="w-5 h-5" />}
        </button>
        <button onClick={onToggleCamera} className={btn(camera)} aria-pressed={camera} aria-label={t('voice.toggleCamera')} title={t('voice.toggleCamera')}>
          {camera ? <Video className="w-5 h-5" /> : <VideoOff className="w-5 h-5" />}
        </button>
        <button onClick={onToggleScreen} className={btn(sharing)} aria-pressed={sharing} aria-label={t('voice.shareScreen')} title={t('voice.shareScreen')}>
          {sharing ? <MonitorOff className="w-5 h-5" /> : <Monitor className="w-5 h-5" />}
        </button>
        <button onClick={onLeave} className="p-2.5 rounded-full bg-d-danger text-white" aria-label={t('sidebar.disconnect')} title={t('sidebar.disconnect')}>
          <PhoneOff className="w-5 h-5" />
        </button>
      </div>
    </div>
  );
}

/** A <video> bound to a MediaStream, since srcObject cannot be set in JSX. */
function VideoTile({ stream, mirror, className }) {
  const ref = useStreamVideo(stream);
  return (
    <video
      ref={ref}
      muted
      playsInline
      autoPlay
      className={className}
      style={mirror ? { transform: 'scaleX(-1)' } : undefined}
    />
  );
}
