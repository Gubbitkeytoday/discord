import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Mic, MicOff, Headphones, HeadphoneOff, Monitor, MonitorOff, PhoneOff, Video,
  VideoOff, Volume2, Volume1, VolumeX, Radio, AlertTriangle, X, Settings,
  Maximize2, Minimize2, Grid2X2, User, Music, Hand, ArrowUpFromLine, ArrowDownToLine,
  SignalHigh, SignalMedium, SignalLow, SignalZero, Lock, PictureInPicture2, RefreshCw,
  UserX, ArrowRightLeft, AudioLines, Shield
} from 'lucide-react';
import {
  playJoinVoiceSound, playLeaveVoiceSound, playMuteSound, playUnmuteSound,
  playSoundboardClip
} from '../utils/soundEffects';
import SoundboardPanel from './SoundboardPanel';
import { useVoiceMedia, useStreamVideo } from '../hooks/useVoiceMedia';
import { useVoiceBackend } from '../voice/useVoiceBackend';
import { isPipSupported, openPipWindow } from '../voice/pip';
import { get, post, del } from '../api';
import { useVoiceSettings } from '../hooks/useVoiceSettings';
import { t } from '../i18n/index.jsx';
import { DEFAULT_AVATAR, defaultAvatar } from '../utils/avatar';
import { proxiedImageUrl } from '../utils/media';

const FALLBACK_AVATAR = DEFAULT_AVATAR;
const VOLUME_KEY = 'antigravity.userVolumes';
const MUTE_KEY = 'antigravity.userMutes';

function loadJson(key) {
  try { return JSON.parse(localStorage.getItem(key) ?? '{}'); }
  catch { return {}; }
}

function saveJson(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
}

/** A translation, or English when the key has not been added yet. */
function tr(key, fallback, values) {
  const text = t(key, values);
  return text === key ? fallback : text;
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
  const [lastSound, setLastSound] = useState(null);
  const { settings: voiceSettings, update: updateVoiceSettings } = useVoiceSettings();
  const pushToTalk = voiceSettings.inputMode === 'ptt';
  const [volumes, setVolumes] = useState(() => loadJson(VOLUME_KEY));
  const [localMutes, setLocalMutes] = useState(() => loadJson(MUTE_KEY));
  const [volumePanelFor, setVolumePanelFor] = useState(null);
  const [stageId, setStageId] = useState(null);   // `${userId}:${kind}` pinned to the stage
  const [layout, setLayout] = useState('grid');   // grid | focus

  // Stage channels: the audience is "suppressed" — they hear but cannot speak
  // until a moderator promotes them. The mic track is disabled locally as well
  // as refused by the server, so nothing leaks while a promotion is in flight.
  const isStage = channel?.type === 'stage';
  const selfState = participants.find((p) => p.userId === currentUser?.id);
  const suppressed = isStage && Boolean(selfState?.isSuppressed);
  const canModerateStage = isStage && (isOwner || viewerPermissions.includes('MUTE_MEMBERS') || viewerPermissions.includes('ADMINISTRATOR'));
  const handRaised = Boolean(selfState?.requestedToSpeakAt);
  const speakers = isStage ? participants.filter((p) => !p.isSuppressed) : participants;
  const audience = isStage ? participants.filter((p) => p.isSuppressed) : [];

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

  const media = useVoiceMedia({ enabled: true, isMuted: isMuted || suppressed || serverMuted || serverDeafened, onSpeakingChange });

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
      onToast?.(speaker ? t('stage.youAreSpeaker') : t('stage.movedToAudience'), { type: speaker ? 'success' : 'info' });
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

  useEffect(() => { if (voiceSettings.voiceJoinSound) playJoinVoiceSound(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps

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
      if (serverMute !== undefined) {
        onToast?.(serverMute ? tr('voice.serverMutedYou', 'A moderator muted you in this server.') : tr('voice.serverUnmutedYou', 'A moderator unmuted you.'), { type: 'info' });
      }
      if (serverDeaf !== undefined) {
        onToast?.(serverDeaf ? tr('voice.serverDeafenedYou', 'A moderator deafened you in this server.') : tr('voice.serverUndeafenedYou', 'A moderator undeafened you.'), { type: 'info' });
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
    if (isMuted) playUnmuteSound(); else playMuteSound();
    onToggleMute();
  };

  const handleLeaveClick = () => {
    if (voiceSettings.voiceJoinSound) playLeaveVoiceSound();
    onLeaveVoice();
  };

  const isSharing = Boolean(media.screenStream);
  const selfId = currentUser?.id;

  /**
   * Every video the room currently has: our own camera and screen, plus each
   * peer's. One flat list keeps the stage and the grid in step.
   */
  const videos = useMemo(() => {
    const list = [];
    if (media.cameraStream) list.push({ id: `${selfId}:camera`, userId: selfId, kind: 'camera', stream: media.cameraStream, isSelf: true });
    if (media.screenStream) list.push({ id: `${selfId}:screen`, userId: selfId, kind: 'screen', stream: media.screenStream, isSelf: true });
    for (const [userId, media_] of Object.entries(mesh.remoteMedia)) {
      if (media_.camera) list.push({ id: `${userId}:camera`, userId, kind: 'camera', stream: media_.camera, isSelf: false });
      if (media_.screen) list.push({ id: `${userId}:screen`, userId, kind: 'screen', stream: media_.screen, isSelf: false });
    }
    return list;
  }, [media.cameraStream, media.screenStream, mesh.remoteMedia, selfId]);

  // A screen share takes the stage automatically, exactly as in Discord.
  const autoStage = videos.find((v) => v.kind === 'screen') ?? null;
  const stage = videos.find((v) => v.id === stageId) ?? (layout === 'focus' ? videos[0] : autoStage);

  const nameFor = (userId) =>
    participants.find((p) => p.userId === userId)?.username ?? t('dm.unknownUser');

  const toggleNoiseSuppression = () => updateVoiceSettings({ noiseSuppression: !voiceSettings.noiseSuppression });

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
      onToggleDeafen={onToggleDeafen}
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
    if (state === 'failed') return tr('voice.connectionFailed', 'Can\u2019t connect');
    return state;
  };

  return (
    <div className="flex-1 bg-d-sunken flex flex-col h-full min-w-0 select-none z-10">
      {/* Header */}
      <div className="h-12 px-4 border-b border-d-edge flex items-center justify-between bg-d-surface shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <Volume2 className="w-5 h-5 text-d-online shrink-0" />
          <span className="font-bold text-d-strong truncate">{channel.name}</span>
          <span className="text-xs text-d-online bg-d-online/10 px-2 py-0.5 rounded font-semibold ml-2 hidden sm:inline">
            {t('voice.inRoom', { count: participants.length })}
          </span>
        </div>
        <div className="flex items-center gap-3 text-xs text-d-text3">
          {mesh.backend === 'livekit' ? (
            <span
              className={`flex items-center gap-1 ${mesh.connectionState === 'connected' ? 'text-d-online' : 'text-d-idle'}`}
              title={tr('voice.sfuStatus', 'Connected through the voice server (SFU)')}
              data-testid="voice-backend"
              data-backend="livekit"
              data-state={mesh.connectionState}
            >
              <QualityIcon quality={mesh.connectionState === 'connected' ? (mesh.selfQuality ?? 'good') : 'lost'} />
              SFU
              {mesh.e2ee && <Lock className="w-3 h-3" aria-label={tr('voice.e2ee', 'End-to-end encrypted')} />}
            </span>
          ) : mesh.peerCount > 0 && (
            <span
              className={mesh.connectedCount === mesh.peerCount ? 'text-d-online' : 'text-d-idle'}
              title={t('voice.p2pStatus')}
              data-testid="voice-backend"
              data-backend="mesh"
            >
              P2P {mesh.connectedCount}/{mesh.peerCount}
            </span>
          )}
          {media.transmitting ? (
            <span className="flex items-center gap-1 text-d-online">
              <Radio className="w-3.5 h-3.5" /> {t('voice.transmitting')}
            </span>
          ) : (
            <span className="flex items-center gap-1">
              <MicOff className="w-3.5 h-3.5" /> {t('voice.notTransmitting')}
            </span>
          )}
          {videos.length > 0 && (
            <button
              onClick={() => { setLayout(layout === 'grid' ? 'focus' : 'grid'); setStageId(null); }}
              className="hover:text-d-strong transition-colors"
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

      {Boolean(media.error) && (
        <div className="mx-4 mt-3 px-3 py-2 bg-d-danger/10 border border-d-danger/40 rounded flex items-start gap-2 text-xs text-d-danger">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span className="flex-1">
            {media.error}
            {!media.hasMic && (
              <span className="block text-d-text2 mt-0.5">
                {tr('voice.noMicHint', 'You are connected, but nobody can hear you until a microphone works.')}
              </span>
            )}
          </span>
          {onOpenVoiceSettings && (
            <button onClick={onOpenVoiceSettings} className="underline font-semibold shrink-0">
              {t('settings.voiceTitle')}
            </button>
          )}
          <button onClick={media.clearError} aria-label={t('common.close')}><X className="w-3.5 h-3.5" /></button>
        </div>
      )}

      {(mesh.connectionState === 'reconnecting' || mesh.connectionState === 'disconnected' || mesh.connectionState === 'failed') && (
        <div
          role="status"
          className="mx-4 mt-3 px-3 py-2 bg-d-idle/10 border border-d-idle/40 rounded flex items-center gap-2 text-xs text-d-idle"
        >
          <RefreshCw className={`w-3.5 h-3.5 shrink-0 ${mesh.connectionState === 'reconnecting' ? 'animate-spin' : ''}`} aria-hidden="true" />
          <span className="flex-1">
            {mesh.connectionState === 'reconnecting'
              ? tr('voice.reconnecting', 'Reconnecting…')
              : tr('voice.voiceServerLost', 'Lost the connection to the voice server.')}
          </span>
          {mesh.connectionState !== 'reconnecting' && mesh.backend === 'livekit' && (
            <button onClick={mesh.retry} className="underline font-semibold shrink-0">
              {tr('voice.retry', 'Retry')}
            </button>
          )}
        </div>
      )}

      {(serverMuted || serverDeafened) && (
        <div className="mx-4 mt-3 px-3 py-2 bg-d-danger/10 border border-d-danger/40 rounded flex items-center gap-2 text-xs text-d-danger">
          <Shield className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
          {serverDeafened
            ? tr('voice.serverDeafenedBanner', 'A moderator has deafened you in this server.')
            : tr('voice.serverMutedBanner', 'A moderator has muted you in this server.')}
        </div>
      )}

      {/* Silence warning: transmitting but nothing is coming through. */}
      {Boolean(voiceSettings.silenceWarning) && media.transmitting && media.micLevel === 0 && (
        <div className="mx-4 mt-3 px-3 py-2 bg-d-idle/10 border border-d-idle/40 rounded text-xs text-d-idle">
          {t('voice.silenceWarning')}
        </div>
      )}

      {/* The stage: a screen share, or whichever video is pinned. */}
      {stage && (
        <div className="mx-4 mt-3 rounded-xl overflow-hidden bg-black relative shrink-0 group">
          <VideoTile
            stream={stage.stream}
            mirror={Boolean(stage.isSelf) && stage.kind === 'camera' && voiceSettings.mirrorCamera}
            className="w-full max-h-[45vh] object-contain"
          />
          <div className="absolute top-2 left-2 bg-d-brand text-white text-[10px] font-bold px-2 py-0.5 rounded">
            {stage.kind === 'screen'
              ? t('voice.sharingScreenBy', { name: stage.isSelf ? t('voice.youLabel') : nameFor(stage.userId) })
              : stage.isSelf ? t('voice.youLabel') : nameFor(stage.userId)}
          </div>
          <div className="absolute top-2 right-2 flex gap-2 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
            {stageId === stage.id ? (
              <button
                onClick={() => setStageId(null)}
                className="bg-d-base/90 text-d-text2 hover:text-d-strong text-[10px] font-semibold px-2 py-1 rounded flex items-center gap-1"
              >
                <Minimize2 className="w-3 h-3" /> {t('voice.unpin')}
              </button>
            ) : null}
            {Boolean(stage.isSelf) && stage.kind === 'screen' && (
              <button
                onClick={media.toggleScreenShare}
                className="bg-d-danger text-white text-[10px] font-semibold px-2 py-1 rounded"
              >
                {t('voice.stopSharing')}
              </button>
            )}
          </div>
        </div>
      )}

      {/* Participant tiles */}
      <div className="flex-1 p-4 sm:p-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 overflow-y-auto content-start">
        {participants.length === 0 ? (
          <div className="col-span-full flex flex-col items-center justify-center text-d-text3 py-12">
            <Volume2 className="w-16 h-16 mb-4 text-d-active animate-pulse" />
            <p className="text-lg font-semibold text-d-strong">{t('voice.nobodyHere')}</p>
            <p className="text-sm">{t('voice.testHint')}</p>
          </div>
        ) : (
          speakers.map((p) => {
            const isSelf = p.userId === selfId;
            const speaking = (isSelf ? media.isSpeaking : p.isSpeaking) && voiceSettings.showSpeakingIndicator;
            const volume = volumes[p.userId] ?? 100;
            const locallyMuted = Boolean(localMutes[p.userId]);
            const camera = isSelf ? media.cameraStream : mesh.remoteMedia[p.userId]?.camera;
            const screen = isSelf ? media.screenStream : mesh.remoteMedia[p.userId]?.screen;
            const onStage = stage?.userId === p.userId;

            return (
              <div
                key={p.userId}
                className={`relative bg-d-surface rounded-2xl h-56 flex flex-col items-center justify-center p-4 transition-all duration-150 overflow-hidden group ${
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
                  <div className="relative mb-3 flex flex-col items-center">
                    <img
                      src={proxiedImageUrl(p.avatar_url) || defaultAvatar(p.userId ?? p.user_id ?? p.id)}
                      alt=""
                      className={`w-24 h-24 rounded-full object-cover transition-transform ${
                        speaking ? 'scale-105 ring-4 ring-d-online' : ''
                      }`}
                    />
                    {Boolean(p.isMuted) && (
                      <div className="absolute bottom-0 right-0 bg-d-danger p-1.5 rounded-full text-white shadow-md">
                        <MicOff className="w-4 h-4" />
                      </div>
                    )}
                  </div>
                )}

                {!isSelf && mesh.peerStates[p.socketId] && mesh.peerStates[p.socketId] !== 'connected' && (
                  <span
                    className={`absolute top-2 left-2 text-[10px] px-1.5 py-0.5 rounded font-semibold ${
                      mesh.peerStates[p.socketId] === 'failed' ? 'bg-d-danger/20 text-d-danger' : 'bg-d-idle/20 text-d-idle'
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
                    className="absolute top-2 left-2 bg-d-base/90 p-1.5 rounded text-d-text2 hover:text-d-strong opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
                    title={isSelf ? t('stage.stepDown') : t('stage.moveToAudience')}
                    aria-label={isSelf ? t('stage.stepDown') : t('stage.moveToAudience')}
                  >
                    <ArrowDownToLine className="w-3.5 h-3.5" />
                  </button>
                )}

                {/* Pin this person's video to the stage. */}
                {(camera || screen) && (
                  <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity">
                    {camera && (
                      <button
                        onClick={() => setStageId(stageId === `${p.userId}:camera` ? null : `${p.userId}:camera`)}
                        className="bg-d-base/90 p-1.5 rounded text-d-text2 hover:text-d-strong"
                        title={t('voice.pinVideo')}
                        aria-label={t('voice.pinVideo')}
                      >
                        <User className="w-3.5 h-3.5" />
                      </button>
                    )}
                    {screen && (
                      <button
                        onClick={() => setStageId(stageId === `${p.userId}:screen` ? null : `${p.userId}:screen`)}
                        className="bg-d-base/90 p-1.5 rounded text-d-text2 hover:text-d-strong"
                        title={t('voice.pinScreen')}
                        aria-label={t('voice.pinScreen')}
                      >
                        <Monitor className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                )}

                <div className="bg-d-base/90 backdrop-blur px-3 py-1 rounded-md flex items-center gap-2 absolute bottom-3 left-3 max-w-[70%]">
                  <span className="text-sm font-bold text-d-strong truncate">
                    {p.username}{isSelf && t('voice.you')}
                  </span>
                  {Boolean(p.isMuted) && <MicOff className="w-3.5 h-3.5 text-d-danger" />}
                  {Boolean(p.isServerMuted) && <Shield className="w-3.5 h-3.5 text-d-danger" aria-label={tr('voice.serverMuted', 'Server muted')} />}
                  {Boolean(p.isDeafened || p.isServerDeafened) && <HeadphoneOff className="w-3.5 h-3.5 text-d-danger" />}
                  {Boolean(mesh.quality?.[p.userId]) && <QualityIcon quality={mesh.quality[p.userId]} />}
                  {Boolean(p.isVideo) && <Video className="w-3.5 h-3.5 text-d-online" />}
                  {Boolean(p.isStreaming) && <Monitor className="w-3.5 h-3.5 text-d-brand" />}
                  {locallyMuted && <VolumeX className="w-3.5 h-3.5 text-d-idle" title={t('voice.mutedLocally')} />}
                </div>

                {/* Self: live mic meter. Others: per-user volume and local mute. */}
                {isSelf ? (
                  media.transmitting && (
                    <div className="absolute bottom-3 right-3 w-16 h-1.5 bg-d-sunken rounded-full overflow-hidden">
                      <div
                        className="h-full bg-d-online transition-all duration-75"
                        style={{ width: `${Math.min(100, media.micLevel * 2.5)}%` }}
                      />
                    </div>
                  )
                ) : (
                  <div className="absolute bottom-2 right-2">
                    <button
                      onClick={() => setVolumePanelFor(volumePanelFor === p.userId ? null : p.userId)}
                      className="p-1.5 rounded-full bg-d-base/90 text-d-text2 hover:text-d-strong transition-colors"
                      title={t('voice.volumeForPercent', { name: p.username, percent: volume })}
                      aria-label={t('voice.adjustVolumeFor', { name: p.username })}
                    >
                      {locallyMuted || volume === 0 ? <VolumeX className="w-4 h-4" />
                        : volume < 60 ? <Volume1 className="w-4 h-4" />
                        : <Volume2 className="w-4 h-4" />}
                    </button>

                    {volumePanelFor === p.userId && (
                      <div className="absolute bottom-10 right-0 bg-d-sunken border border-d-surface rounded-lg p-3 w-44 shadow-2xl">
                        <p className="text-[10px] font-bold text-d-text3 uppercase mb-1.5">
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
                          className={`mt-2 w-full text-[11px] font-semibold py-1.5 rounded transition-colors ${
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
                                className="text-[11px] text-left px-2 py-1 rounded hover:bg-d-surface text-d-text2 flex items-center gap-1.5"
                              >
                                <MicOff className="w-3 h-3" />
                                {p.isServerMuted ? tr('voice.serverUnmute', 'Server unmute') : tr('voice.serverMute', 'Server mute')}
                              </button>
                            )}
                            {canModerate('DEAFEN_MEMBERS') && (
                              <button
                                onClick={() => moderate('deafen', p.userId, { deaf: !p.isServerDeafened })}
                                className="text-[11px] text-left px-2 py-1 rounded hover:bg-d-surface text-d-text2 flex items-center gap-1.5"
                              >
                                <HeadphoneOff className="w-3 h-3" />
                                {p.isServerDeafened ? tr('voice.serverUndeafen', 'Server undeafen') : tr('voice.serverDeafen', 'Server deafen')}
                              </button>
                            )}
                            {canModerate('MOVE_MEMBERS') && (
                              <>
                                <label className="text-[10px] text-d-text3 flex items-center gap-1.5 px-2">
                                  <ArrowRightLeft className="w-3 h-3" />
                                  <select
                                    className="flex-1 bg-d-surface text-d-text2 text-[11px] rounded px-1 py-0.5"
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
                                  className="text-[11px] text-left px-2 py-1 rounded hover:bg-d-danger/20 text-d-danger flex items-center gap-1.5"
                                >
                                  <UserX className="w-3 h-3" />
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
          <div className="col-span-full flex flex-col items-center justify-center text-d-text3 py-12">
            <Radio className="w-16 h-16 mb-4 text-d-active" />
            <p className="text-lg font-semibold text-d-strong">{t('stage.noSpeakers')}</p>
            <p className="text-sm">{canModerateStage ? t('stage.noSpeakersModHint') : t('stage.noSpeakersHint')}</p>
          </div>
        )}
      </div>

      {/* Stage audience: compact strip, hands first. */}
      {isStage && (
        <div className="px-4 sm:px-6 py-3 border-t border-d-edge bg-d-surface/40 shrink-0">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-[11px] font-bold uppercase tracking-wide text-d-text3">
              {t('stage.audience', { count: audience.length })}
            </h3>
            {audience.some((p) => p.requestedToSpeakAt) && (
              <span className="text-[11px] text-d-brand font-semibold inline-flex items-center gap-1">
                <Hand className="w-3 h-3" aria-hidden="true" />
                {t('stage.handsRaised', { count: audience.filter((p) => p.requestedToSpeakAt).length })}
              </span>
            )}
          </div>
          {audience.length === 0 ? (
            <p className="text-xs text-d-text3">{t('stage.noAudience')}</p>
          ) : (
            <ul className="flex flex-wrap gap-2">
              {[...audience].sort((a, b) => (a.requestedToSpeakAt ? 0 : 1) - (b.requestedToSpeakAt ? 0 : 1)).map((p) => (
                <li key={p.userId} className={`flex items-center gap-2 rounded-full pl-1 pr-2 py-1 border ${p.requestedToSpeakAt ? 'border-d-brand bg-d-brand/10' : 'border-d-edge bg-d-surface'}`}>
                  <img src={proxiedImageUrl(p.avatar_url) || defaultAvatar(p.userId ?? p.user_id ?? p.id)} alt="" className="w-6 h-6 rounded-full object-cover" />
                  <span className="text-xs text-d-strong max-w-[8rem] truncate">{p.username}{p.userId === selfId && t('voice.you')}</span>
                  {Boolean(p.requestedToSpeakAt) && <Hand className="w-3.5 h-3.5 text-d-brand" aria-label={t('stage.wantsToSpeak')} />}
                  {canModerateStage && (
                    <button
                      onClick={() => setSpeaker(p.userId, true)}
                      className="text-d-text3 hover:text-d-strong p-0.5"
                      title={t('stage.inviteToSpeak')}
                      aria-label={t('stage.inviteToSpeak', { name: p.username })}
                    >
                      <ArrowUpFromLine className="w-3.5 h-3.5" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {/* Controls */}
      <div className="relative min-h-20 py-3 bg-d-surface border-t border-d-edge flex flex-wrap items-center justify-center gap-3 shrink-0">
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
              text-[11px] text-d-text2 shadow-lg"
          >
            {t('soundboard.played', {
              name: lastSound.userId === selfId ? t('voice.youLabel') : nameFor(lastSound.userId),
              sound: lastSound.name
            })}
          </div>
        )}

        <button
          onClick={handleMuteClick}
          className={`p-3.5 rounded-full transition-all ${
            isMuted ? 'bg-d-danger text-white' : 'bg-d-control2 text-d-strong hover:bg-d-control'
          }`}
          title={isMuted ? t('sidebar.unmute') : t('sidebar.mute')}
          aria-label={t('sidebar.mute')}
          aria-pressed={isMuted}
        >
          {isMuted ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
        </button>

        <button
          onClick={onToggleDeafen}
          className={`p-3.5 rounded-full transition-all ${
            effectiveDeafened ? 'bg-d-danger text-white' : 'bg-d-control2 text-d-strong hover:bg-d-control'
          }`}
          title={effectiveDeafened ? t('sidebar.undeafen') : t('sidebar.deafen')}
          aria-label={t('sidebar.deafen')}
          aria-pressed={effectiveDeafened}
        >
          {effectiveDeafened ? <HeadphoneOff className="w-6 h-6" /> : <Headphones className="w-6 h-6" />}
        </button>

        <button
          onClick={media.toggleCamera}
          className={`p-3.5 rounded-full transition-all ${
            media.cameraStream ? 'bg-d-online text-white' : 'bg-d-control2 text-d-strong hover:bg-d-control'
          }`}
          title={media.cameraStream ? t('voice.stopCamera') : t('voice.toggleCamera')}
          aria-pressed={Boolean(media.cameraStream)}
        >
          {media.cameraStream ? <Video className="w-6 h-6" /> : <VideoOff className="w-6 h-6" />}
        </button>

        <button
          onClick={media.toggleScreenShare}
          className={`p-3.5 rounded-full transition-all ${
            isSharing ? 'bg-d-brand text-white' : 'bg-d-control2 text-d-strong hover:bg-d-control'
          }`}
          title={isSharing ? t('voice.stopSharing') : t('voice.shareScreen')}
          aria-pressed={isSharing}
        >
          {isSharing ? <MonitorOff className="w-6 h-6" /> : <Monitor className="w-6 h-6" />}
        </button>

        {/* Input mode */}
        <button
          onClick={() => updateVoiceSettings({
            inputMode: pushToTalk ? 'voice' : 'ptt',
            pushToTalk: !pushToTalk
          })}
          className={`px-3 h-11 rounded-full text-xs font-semibold transition-all flex items-center gap-1.5 ${
            pushToTalk
              ? media.pttHeld ? 'bg-d-online text-white' : 'bg-d-brand text-white'
              : 'bg-d-control2 text-d-text2 hover:bg-d-control'
          }`}
          title={t('voice.pushToTalk')}
          aria-pressed={pushToTalk}
        >
          <Radio className="w-4 h-4" />
          {pushToTalk
            ? (media.pttHeld ? t('voice.talking') : t('voice.holdKeyToTalk', { key: voiceSettings.pushToTalkKey }))
            : t('voice.pushToTalk')}
        </button>

        {suppressed && (
          <button
            onClick={() => requestSpeak(!handRaised)}
            className={`px-3 h-11 rounded-full text-xs font-semibold transition-all flex items-center gap-1.5 ${
              handRaised ? 'bg-d-brand text-white' : 'bg-d-control2 text-d-strong hover:bg-d-control'
            }`}
            title={handRaised ? t('stage.lowerHand') : t('stage.raiseHand')}
            aria-pressed={handRaised}
          >
            <Hand className="w-4 h-4" />
            {handRaised ? t('stage.lowerHand') : t('stage.raiseHand')}
          </button>
        )}

        {Boolean(channel?.server_id) && (
          <button aria-label={t('soundboard.title')}
            onClick={() => setShowSoundboard((v) => !v)}
            className={`p-3.5 rounded-full transition-all ${
              showSoundboard ? 'bg-d-brand text-white' : 'bg-d-control2 text-d-strong hover:bg-d-control'
            }`}
            title={t('soundboard.title')}
            aria-pressed={showSoundboard}
          >
            <Music className="w-6 h-6" />
          </button>
        )}

        <button
          onClick={toggleNoiseSuppression}
          className={`p-3.5 rounded-full transition-all ${
            voiceSettings.noiseSuppression ? 'bg-d-brand text-white' : 'bg-d-control2 text-d-strong hover:bg-d-control'
          }`}
          title={t('voice.noiseSuppression')}
          aria-label={t('voice.noiseSuppression')}
          aria-pressed={Boolean(voiceSettings.noiseSuppression)}
        >
          <AudioLines className="w-6 h-6" />
        </button>

        {isPipSupported() && (
          <button
            onClick={pipWindow ? () => pipWindow.close() : openPip}
            className={`p-3.5 rounded-full transition-all ${
              pipWindow ? 'bg-d-brand text-white' : 'bg-d-control2 text-d-strong hover:bg-d-control'
            }`}
            title={tr('voice.popOut', 'Pop out call')}
            aria-label={tr('voice.popOut', 'Pop out call')}
            aria-pressed={Boolean(pipWindow)}
          >
            <PictureInPicture2 className="w-6 h-6" />
          </button>
        )}

        {onOpenVoiceSettings && (
          <button
            onClick={onOpenVoiceSettings}
            className="p-3.5 rounded-full bg-d-control2 text-d-strong hover:bg-d-control transition-all"
            title={t('settings.voiceTitle')}
            aria-label={t('settings.voiceTitle')}
          >
            <Settings className="w-6 h-6" />
          </button>
        )}

        <button
          onClick={handleLeaveClick}
          className="p-3.5 bg-d-danger hover:bg-d-dangerhover text-white rounded-full transition-all shadow-lg hover:scale-105"
          title={t('sidebar.disconnect')}
          aria-label={t('sidebar.disconnect')}
        >
          <PhoneOff className="w-6 h-6" />
        </button>
      </div>
      {pipPortal}
    </div>
  );
}

/** Four-step signal glyph for a LiveKit/mesh connection quality grade. */
function QualityIcon({ quality }) {
  const label = {
    excellent: tr('voice.qualityExcellent', 'Excellent connection'),
    good: tr('voice.qualityGood', 'Good connection'),
    poor: tr('voice.qualityPoor', 'Poor connection'),
    lost: tr('voice.qualityLost', 'Connection lost')
  }[quality] ?? null;
  if (!label) return null;
  const Icon = quality === 'excellent' ? SignalHigh : quality === 'good' ? SignalMedium : quality === 'poor' ? SignalLow : SignalZero;
  const color = quality === 'excellent' || quality === 'good' ? 'text-d-online' : quality === 'poor' ? 'text-d-idle' : 'text-d-danger';
  return (
    <span role="img" aria-label={label} title={label} data-quality={quality} className="inline-flex">
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
        <Volume2 className="w-4 h-4 text-d-online shrink-0" />
        <span className="truncate flex-1">{channel?.name}</span>
        {connectionState === 'reconnecting' && <span className="text-[10px] text-d-idle">{tr('voice.reconnecting', 'Reconnecting…')}</span>}
      </div>
      <ul className="flex-1 flex flex-wrap content-start gap-2 overflow-y-auto">
        {participants.map((p) => {
          const speaking = p.userId === selfId ? localSpeaking : p.isSpeaking;
          return (
            <li key={p.userId} className="flex flex-col items-center w-16" title={p.username}>
              <img
                src={proxiedImageUrl(p.avatar_url) || defaultAvatar(p.userId)}
                alt=""
                className={`w-11 h-11 rounded-full object-cover ${speaking ? 'ring-2 ring-d-online' : ''}`}
              />
              <span className="text-[10px] truncate w-full text-center flex items-center justify-center gap-0.5">
                {Boolean(p.isMuted) && <MicOff className="w-2.5 h-2.5 text-d-danger shrink-0" />}
                <span className="truncate">{p.username}</span>
                {Boolean(quality?.[p.userId]) && <QualityIcon quality={quality[p.userId]} />}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="flex items-center justify-center gap-2">
        <button onClick={onToggleMute} className={btn(isMuted, true)} aria-pressed={isMuted} aria-label={t('sidebar.mute')}>
          {isMuted ? <MicOff className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
        </button>
        <button onClick={onToggleDeafen} className={btn(isDeafened, true)} aria-pressed={isDeafened} aria-label={t('sidebar.deafen')}>
          {isDeafened ? <HeadphoneOff className="w-5 h-5" /> : <Headphones className="w-5 h-5" />}
        </button>
        <button onClick={onToggleCamera} className={btn(camera)} aria-pressed={camera} aria-label={t('voice.toggleCamera')}>
          {camera ? <Video className="w-5 h-5" /> : <VideoOff className="w-5 h-5" />}
        </button>
        <button onClick={onToggleScreen} className={btn(sharing)} aria-pressed={sharing} aria-label={t('voice.shareScreen')}>
          {sharing ? <MonitorOff className="w-5 h-5" /> : <Monitor className="w-5 h-5" />}
        </button>
        <button onClick={onLeave} className="p-2.5 rounded-full bg-d-danger text-white" aria-label={t('sidebar.disconnect')}>
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
