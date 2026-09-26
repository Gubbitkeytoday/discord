// ============================================================================
//  LiveKit backend for a voice channel.
//
//  Same contract as the mesh hook (useVoicePeers): it takes the local tracks
//  useVoiceMedia captured and the playback settings, and returns remoteMedia
//  (userId -> { camera, screen }) plus connection state. The UI does not know
//  which backend is running.
//
//  What LiveKit adds over the mesh:
//    * one upstream per track whatever the room size (SFU), so no mesh cap;
//    * simulcast + dynacast: the SFU forwards the layer each viewer needs and
//      tells us to stop encoding layers nobody watches;
//    * adaptiveStream: remote video is paused when its <video> is hidden and
//      sized to the element (tracks are attached via track.attach());
//    * RED (redundant audio) + DTX on the microphone;
//    * AV1 / VP9 where the browser can encode them, with a VP8 backup layer for
//      subscribers that cannot decode them;
//    * optional E2EE (per-room key from the server, see services/livekit.js);
//    * connection quality per participant, and automatic reconnection.
//
//  The livekit-client SDK is imported lazily, so the ~200 kB chunk is only
//  downloaded by someone who actually joins voice on a LiveKit server.
//
//  Media capture stays in useVoiceMedia (device choice, gain, VAD, push-to-
//  talk gate, camera blur). Its tracks are published as user-provided tracks
//  and are never stopped by LiveKit (stopLocalTrackOnUnpublish: false) — a
//  server mute that unpublishes the microphone must not kill the capture.
// ============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { createAudioPlayback } from './playback';
import { fetchLivekitToken } from './config';

// Local role -> LiveKit track source, and the protocol enum the server uses
// in ParticipantPermission.canPublishSources.
const ROLES = {
  audio: { source: 'microphone', proto: 2 },
  camera: { source: 'camera', proto: 1 },
  screen: { source: 'screen_share', proto: 3 },
  screenAudio: { source: 'screen_share_audio', proto: 4 }
};

const MAX_RETRIES = 5;

/** Is this source allowed by the participant's current (server-set) permission? */
function allowed(permissions, role) {
  if (!permissions) return true;               // not known yet: let the SFU decide
  if (permissions.canPublish === false) return false;
  const sources = permissions.canPublishSources ?? [];
  if (!sources.length) return permissions.canPublish !== false;
  return sources.some((s) => s === ROLES[role].proto || s === ROLES[role].source
    || String(s).toLowerCase() === ROLES[role].source);
}

function pickCodec(lk, preferred, e2ee) {
  // Encrypted frames work everywhere with VP8; SVC codecs + E2EE are still
  // uneven across browsers.
  if (e2ee) return 'vp8';
  if (preferred && preferred !== 'auto') return preferred;
  try {
    if (lk.supportsAV1?.()) return 'av1';
    if (lk.supportsVP9?.()) return 'vp9';
  } catch { /* capability probe failed: fall through */ }
  return 'vp8';
}

export function useLiveKitRoom({
  enabled,
  channelId,
  selfUserId,
  tracks = {},
  config = null,             // /api/voice/config response (mode === 'livekit')
  onUnavailable,             // server says LiveKit is off: caller falls back to mesh
  ...playbackSettings        // volumes, localMutes, isDeafened, outputVolume, …
}) {
  const playbackRef = useRef({});
  playbackRef.current = playbackSettings;
  const playbackHolder = useRef(null);
  if (!playbackHolder.current) playbackHolder.current = createAudioPlayback(() => playbackRef.current);
  const playback = playbackHolder.current;

  const [room, setRoom] = useState(null);
  const [connectionState, setConnectionState] = useState('idle');
  const [remoteMedia, setRemoteMedia] = useState({});
  const [quality, setQuality] = useState({});
  const [error, setError] = useState(null);
  const [disconnectReason, setDisconnectReason] = useState(null);
  const [permEpoch, setPermEpoch] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const [e2eeActive, setE2eeActive] = useState(false);
  const [remoteCount, setRemoteCount] = useState(0);

  const lkRef = useRef(null);
  const publishedRef = useRef({});         // role -> { mst, pub }
  const publishChainRef = useRef(Promise.resolve());
  const codecRef = useRef('vp8');
  const e2eeRef = useRef(false);
  const failuresRef = useRef(0);          // consecutive failed (re)connects
  const onUnavailableRef = useRef(onUnavailable);
  onUnavailableRef.current = onUnavailable;

  const setRemoteVideo = useCallback((userId, role, stream) => {
    setRemoteMedia((prev) => {
      const current = prev[userId] ?? {};
      if (current[role] === stream) return prev;
      return { ...prev, [userId]: { ...current, [role]: stream } };
    });
  }, []);

  // --- connect / disconnect -------------------------------------------------
  useEffect(() => {
    if (!enabled || !channelId || !config?.livekit?.url) {
      setConnectionState('idle');
      return undefined;
    }
    let cancelled = false;
    let current = null;
    let retryTimer = null;
    const scheduleRetry = () => {
      if (failuresRef.current >= MAX_RETRIES) return;
      const delay = Math.min(15000, 1000 * 2 ** failuresRef.current);
      failuresRef.current += 1;
      retryTimer = setTimeout(() => setAttempt((n) => n + 1), delay);
    };

    (async () => {
      setConnectionState(attempt ? 'reconnecting' : 'connecting');
      setError(null);
      try {
        const lk = await import('livekit-client');
        lkRef.current = lk;
        let grant;
        try {
          grant = await fetchLivekitToken(channelId);
        } catch (err) {
          if (err?.status === 503 || err?.code === 'LIVEKIT_DISABLED') {
            onUnavailableRef.current?.();
            return;
          }
          throw err;
        }
        if (cancelled) return;

        let e2ee;
        if (grant.e2ee?.key && lk.isE2EESupported?.()) {
          const keyProvider = new lk.ExternalE2EEKeyProvider();
          await keyProvider.setKey(grant.e2ee.key);
          const { default: E2EEWorker } = await import('livekit-client/e2ee-worker?worker');
          e2ee = { keyProvider, worker: new E2EEWorker() };
        }
        e2eeRef.current = Boolean(e2ee);
        codecRef.current = pickCodec(lk, config.livekit.videoCodec, Boolean(e2ee));

        const r = new lk.Room({
          adaptiveStream: true,
          dynacast: true,
          // We own capture; LiveKit must never stop our tracks.
          stopLocalTrackOnUnpublish: false,
          disconnectOnPageLeave: true,
          publishDefaults: {
            simulcast: true,
            red: !e2ee,
            dtx: true,
            videoCodec: codecRef.current,
            backupCodec: codecRef.current === 'vp8' ? false : { codec: 'vp8' }
          },
          ...(e2ee ? { e2ee } : {})
        });
        current = r;
        const E = lk.RoomEvent;

        const keyFor = (participant, pub) => `${participant.identity}:${pub.source}`;
        const videoRole = (pub) => (pub.source === lk.Track.Source.ScreenShare ? 'screen' : 'camera');
        const wrap = (track) => {
          const stream = new MediaStream([track.mediaStreamTrack]);
          // useStreamVideo attaches through the SDK so adaptiveStream can see
          // the element's size and visibility.
          Object.defineProperty(stream, 'lkTrack', { value: track });
          return stream;
        };
        const refreshCount = () => setRemoteCount(r.remoteParticipants.size);

        r.on(E.TrackSubscribed, (track, pub, participant) => {
          if (track.kind === 'audio') {
            playback.attach(keyFor(participant, pub), participant.identity, new MediaStream([track.mediaStreamTrack]));
          } else if (track.kind === 'video') {
            setRemoteVideo(participant.identity, videoRole(pub), track.isMuted ? null : wrap(track));
          }
        });
        r.on(E.TrackUnsubscribed, (track, pub, participant) => {
          if (track.kind === 'audio') playback.detach(keyFor(participant, pub));
          else setRemoteVideo(participant.identity, videoRole(pub), null);
        });
        r.on(E.TrackMuted, (pub, participant) => {
          if (participant.isLocal || pub.kind !== 'video') return;
          setRemoteVideo(participant.identity, videoRole(pub), null);
        });
        r.on(E.TrackUnmuted, (pub, participant) => {
          if (participant.isLocal || pub.kind !== 'video' || !pub.track) return;
          setRemoteVideo(participant.identity, videoRole(pub), wrap(pub.track));
        });
        r.on(E.ParticipantConnected, refreshCount);
        r.on(E.ParticipantDisconnected, (participant) => {
          refreshCount();
          setRemoteMedia((prev) => {
            if (!(participant.identity in prev)) return prev;
            const next = { ...prev };
            delete next[participant.identity];
            return next;
          });
          setQuality((prev) => {
            if (!(participant.identity in prev)) return prev;
            const next = { ...prev };
            delete next[participant.identity];
            return next;
          });
        });
        r.on(E.ConnectionQualityChanged, (q, participant) => {
          setQuality((prev) => (prev[participant.identity] === q ? prev : { ...prev, [participant.identity]: q }));
        });
        r.on(E.Reconnecting, () => setConnectionState('reconnecting'));
        r.on(E.SignalReconnecting, () => setConnectionState('reconnecting'));
        r.on(E.Reconnected, () => setConnectionState('connected'));
        r.on(E.ParticipantPermissionsChanged, (_prev, participant) => {
          if (!participant || participant.isLocal) setPermEpoch((n) => n + 1);
        });
        r.on(E.LocalTrackUnpublished, (pub) => {
          // Also fires when the server revokes a source (server mute, stage
          // demotion): forget it so the next permission change republishes.
          for (const [role, entry] of Object.entries(publishedRef.current)) {
            if (entry.pub === pub || entry.pub?.trackSid === pub.trackSid) delete publishedRef.current[role];
          }
        });
        r.on(E.EncryptionError, () => setError('e2ee'));
        r.on(E.Disconnected, (reason) => {
          if (cancelled) return;
          setConnectionState('disconnected');
          setDisconnectReason(reason ?? null);
          publishedRef.current = {};
          const R = lk.DisconnectReason ?? {};
          const final = [R.CLIENT_INITIATED, R.DUPLICATE_IDENTITY, R.PARTICIPANT_REMOVED, R.ROOM_DELETED]
            .filter((v) => v !== undefined).includes(reason);
          // The SDK already retried a resume and a full reconnect; one more
          // round with a fresh token covers an expired one and a restarted SFU.
          if (!final) scheduleRetry();
        });

        await r.connect(grant.url || config.livekit.url, grant.token, { autoSubscribe: true });
        if (cancelled) { r.disconnect(false); return; }
        if (e2ee) {
          await r.setE2EEEnabled(true);
          setE2eeActive(true);
        }
        refreshCount();
        failuresRef.current = 0;
        setConnectionState('connected');
        setDisconnectReason(null);
        setRoom(r);
      } catch (err) {
        if (cancelled) return;
        setConnectionState('failed');
        setError(err?.message || String(err));
        scheduleRetry();
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(retryTimer);
      publishedRef.current = {};
      setRoom(null);
      current?.disconnect(false).catch?.(() => {});
      playback.closeAll();
      setRemoteMedia({});
      setQuality({});
      setRemoteCount(0);
      setE2eeActive(false);
    };
  }, [enabled, channelId, config?.livekit?.url, config?.livekit?.videoCodec, attempt, playback, setRemoteVideo]);

  // --- publish what we capture ----------------------------------------------
  useEffect(() => {
    if (!room) return;
    const lk = lkRef.current;
    const lp = room.localParticipant;
    const run = async () => {
      for (const role of Object.keys(ROLES)) {
        const wanted = tracks[role] ?? null;
        const entry = publishedRef.current[role];
        const may = allowed(lp.permissions, role);
        if (entry && (entry.mst !== wanted || !may)) {
          delete publishedRef.current[role];
          try { await lp.unpublishTrack(entry.pub.track ?? entry.mst, false); } catch { /* already gone */ }
        }
        if (!wanted || !may || publishedRef.current[role] || wanted.readyState === 'ended') continue;
        const Source = lk.Track.Source;
        const options = {
          audio: { source: Source.Microphone, dtx: true, red: !e2eeRef.current },
          camera: {
            source: Source.Camera, simulcast: true, videoCodec: codecRef.current,
            backupCodec: codecRef.current === 'vp8' ? false : { codec: 'vp8' }
          },
          screen: {
            source: Source.ScreenShare, simulcast: true, videoCodec: codecRef.current,
            backupCodec: codecRef.current === 'vp8' ? false : { codec: 'vp8' }
          },
          // Music and game audio: no DTX (it clips quiet passages), stereo.
          screenAudio: {
            source: Source.ScreenShareAudio, dtx: false, red: false,
            audioPreset: lk.AudioPresets?.musicHighQualityStereo, forceStereo: true
          }
        }[role];
        try {
          const pub = await lp.publishTrack(wanted, options);
          if (room.state === 'disconnected') return;
          publishedRef.current[role] = { mst: wanted, pub };
        } catch (err) {
          console.warn(`livekit: publishing ${role} failed:`, err?.message);
        }
      }
    };
    // Serialised: a camera toggle mid-publish must not race the previous one.
    publishChainRef.current = publishChainRef.current.then(run, run);
  }, [room, tracks.audio, tracks.camera, tracks.screen, tracks.screenAudio, permEpoch]); // eslint-disable-line react-hooks/exhaustive-deps

  // Apply playback changes without touching the room.
  const positionsKey = JSON.stringify(playbackSettings.positions ?? {});
  useEffect(() => {
    playback.applyAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    playbackSettings.volumes, playbackSettings.localMutes, playbackSettings.isDeafened,
    playbackSettings.outputVolume, playbackSettings.outputDeviceId, playbackSettings.attenuation,
    playbackSettings.attenuateWhileSpeaking, playbackSettings.selfSpeaking, playbackSettings.spatialAudio, positionsKey
  ]);

  useEffect(() => () => playback.closeAll(), [playback]);

  const retry = useCallback(() => { failuresRef.current = 0; setAttempt((n) => n + 1); }, []);

  return {
    backend: 'livekit',
    peerStates: {},
    remoteMedia,
    quality,
    connectionState,
    disconnectReason,
    error,
    e2ee: e2eeActive,
    codec: room ? codecRef.current : null,
    peerCount: remoteCount,
    connectedCount: connectionState === 'connected' ? remoteCount : 0,
    selfQuality: selfUserId ? quality[selfUserId] ?? null : null,
    resumeAudio: () => playback.resume(),
    retry
  };
}
