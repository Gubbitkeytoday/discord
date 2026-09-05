import React, { useEffect, useMemo, useState } from 'react';
import {
  Mic, MicOff, Headphones, HeadphoneOff, Monitor, MonitorOff, PhoneOff, Video,
  VideoOff, Volume2, Volume1, VolumeX, Radio, AlertTriangle, X, Settings,
  Maximize2, Minimize2, Grid2X2, User, Music, Hand, ArrowUpFromLine, ArrowDownToLine
} from 'lucide-react';
import {
  playJoinVoiceSound, playLeaveVoiceSound, playMuteSound, playUnmuteSound,
  playSoundboardClip
} from '../utils/soundEffects';
import SoundboardPanel from './SoundboardPanel';
import { useVoiceMedia, useStreamVideo } from '../hooks/useVoiceMedia';
import { useVoicePeers } from '../hooks/useVoicePeers';
import { useVoiceSettings } from '../hooks/useVoiceSettings';
import { t } from '../i18n/index.jsx';
import { DEFAULT_AVATAR } from '../utils/avatar';

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

export default function VoiceRoom({
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
  onToast
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

  const media = useVoiceMedia({ enabled: true, isMuted: isMuted || suppressed, onSpeakingChange });

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

  // The peer mesh: one RTCPeerConnection per other participant, carrying our
  // microphone, camera and screen directly to them.
  const mesh = useVoicePeers({
    socket,
    tracks: media.outgoingTracks,
    participants,
    selfUserId: currentUser?.id,
    enabled: true,
    volumes,
    localMutes,
    isDeafened,
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
      if (isDeafened) return;
      playSoundboardClip(sound.url, {
        volume: sound.volume ?? 100,
        userVolume: voiceSettings.soundboardVolume ?? 100
      }).catch(() => { /* a missing clip should not break the call */ });
    };
    socket.on('sound_played', onSound);
    return () => socket.off('sound_played', onSound);
  }, [socket, channel?.id, isDeafened, voiceSettings.soundboardVolume]);

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
          {mesh.peerCount > 0 && (
            <span
              className={mesh.connectedCount === mesh.peerCount ? 'text-d-online' : 'text-d-idle'}
              title={t('voice.p2pStatus')}
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
        </div>
      </div>

      {media.error && (
        <div className="mx-4 mt-3 px-3 py-2 bg-d-danger/10 border border-d-danger/40 rounded flex items-start gap-2 text-xs text-d-danger">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span className="flex-1">{media.error}</span>
          <button onClick={media.clearError} aria-label={t('common.close')}><X className="w-3.5 h-3.5" /></button>
        </div>
      )}

      {/* Silence warning: transmitting but nothing is coming through. */}
      {voiceSettings.silenceWarning && media.transmitting && media.micLevel === 0 && (
        <div className="mx-4 mt-3 px-3 py-2 bg-d-idle/10 border border-d-idle/40 rounded text-xs text-d-idle">
          {t('voice.silenceWarning')}
        </div>
      )}

      {/* The stage: a screen share, or whichever video is pinned. */}
      {stage && (
        <div className="mx-4 mt-3 rounded-xl overflow-hidden bg-black relative shrink-0 group">
          <VideoTile
            stream={stage.stream}
            mirror={stage.isSelf && stage.kind === 'camera' && voiceSettings.mirrorCamera}
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
            {stage.isSelf && stage.kind === 'screen' && (
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
                      src={p.avatar_url || FALLBACK_AVATAR}
                      alt=""
                      className={`w-24 h-24 rounded-full object-cover transition-transform ${
                        speaking ? 'scale-105 ring-4 ring-d-online' : ''
                      }`}
                    />
                    {p.isMuted && (
                      <div className="absolute bottom-0 right-0 bg-d-danger p-1.5 rounded-full text-white shadow-md">
                        <MicOff className="w-4 h-4" />
                      </div>
                    )}
                  </div>
                )}

                {!isSelf && mesh.peerStates[p.socketId] && mesh.peerStates[p.socketId] !== 'connected' && (
                  <span className="absolute top-2 left-2 text-[10px] bg-d-idle/20 text-d-idle px-1.5 py-0.5 rounded font-semibold">
                    {mesh.peerStates[p.socketId] === 'connecting' ? t('voice.connecting') : mesh.peerStates[p.socketId]}
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
                  {p.isMuted && <MicOff className="w-3.5 h-3.5 text-d-danger" />}
                  {p.isDeafened && <HeadphoneOff className="w-3.5 h-3.5 text-d-danger" />}
                  {p.isVideo && <Video className="w-3.5 h-3.5 text-d-online" />}
                  {p.isStreaming && <Monitor className="w-3.5 h-3.5 text-d-brand" />}
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
                  <img src={p.avatar_url || FALLBACK_AVATAR} alt="" className="w-6 h-6 rounded-full object-cover" />
                  <span className="text-xs text-d-strong max-w-[8rem] truncate">{p.username}{p.userId === selfId && t('voice.you')}</span>
                  {p.requestedToSpeakAt && <Hand className="w-3.5 h-3.5 text-d-brand" aria-label={t('stage.wantsToSpeak')} />}
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
            onToast={undefined}
          />
        )}

        {lastSound && (
          <div
            role="status"
            className="absolute -top-9 left-1/2 -translate-x-1/2 rounded-full bg-d-base3/90 px-3 py-1
              text-[11px] text-d-text2 shadow-lg"
          >
            {t('soundboard.played', {
              name: participants.find((p) => p.userId === lastSound.userId)?.displayName
                ?? t('voice.youLabel'),
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
          aria-pressed={isMuted}
        >
          {isMuted ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
        </button>

        <button
          onClick={onToggleDeafen}
          className={`p-3.5 rounded-full transition-all ${
            isDeafened ? 'bg-d-danger text-white' : 'bg-d-control2 text-d-strong hover:bg-d-control'
          }`}
          title={isDeafened ? t('sidebar.undeafen') : t('sidebar.deafen')}
          aria-pressed={isDeafened}
        >
          {isDeafened ? <HeadphoneOff className="w-6 h-6" /> : <Headphones className="w-6 h-6" />}
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

        {channel?.server_id && (
          <button
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
        >
          <PhoneOff className="w-6 h-6" />
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
